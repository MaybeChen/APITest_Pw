import { existsSync } from "node:fs";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Request,
} from "playwright";
import { randomUUID } from "node:crypto";
import type {
  Recording,
  Environment,
  Asset,
} from "../../contracts/src/index.js";
import {
  allowedURL,
  redact,
  shouldCaptureRequest,
} from "../../core/src/index.js";
export class Recorder {
  browser?: Browser;
  context?: BrowserContext;
  pending = new Set<Promise<void>>();
  capturedBytes = 0;
  recording: Recording;
  constructor(
    input: {
      caseName: string;
      scenario: string;
      target: string;
      notes?: string;
      workspaceId?: string;
    },
    private env: Environment,
  ) {
    this.recording = {
      ...input,
      notes: input.notes ?? "",
      id: randomUUID(),
      startedAt: Date.now(),
      state: "RECORDING",
      operations: [],
      requests: [],
      dependencies: [],
      redactions: [
        "Credentials, sensitive fields and query parameters redacted before persistence.",
      ],
    };
  }
  async start(headless = false) {
    allowedURL(this.recording.target, this.env);
    this.browser = await chromium.launch({
      headless,
      executablePath:
        process.env.CHROMIUM_PATH ??
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    });
    this.context = await this.browser.newContext({
      ignoreHTTPSErrors: this.env.ignoreHTTPSErrors ?? false,
    });
    await this.context.route("**/*", async (route) => {
      try {
        allowedURL(route.request().url(), this.env);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    await this.context.exposeBinding(
      "__record",
      (_source, event: Recording["operations"][number]) => {
        if (this.recording.operations.length < 10000)
          this.recording.operations.push(redact(event));
      },
    );
    await this.context.addInitScript(() => {
      const emit = (type: string, target?: EventTarget | null) => {
        const el = target instanceof HTMLElement ? target : null;
        const sensitive =
          el instanceof HTMLInputElement &&
          (el.type === "password" ||
            /password|token|secret|card/i.test(el.name));
        const context = {
          tag: el?.tagName,
          role: el?.getAttribute("role"),
          accessibleName: el?.getAttribute("aria-label"),
          text: sensitive ? "[REDACTED]" : el?.textContent?.slice(0, 160),
          attributes: {
            id: el?.id,
            name: el?.getAttribute("name"),
            type: el?.getAttribute("type"),
          },
          value: "[OMITTED]",
          state: document.readyState,
        };
        void (
          window as unknown as { __record: (e: unknown) => Promise<void> }
        ).__record({
          id: crypto.randomUUID(),
          type,
          at: Date.now(),
          url: location.href,
          context,
          requestIds: [],
        });
      };
      for (const type of ["click", "input", "change", "submit"])
        document.addEventListener(type, (e) => emit(type, e.target), true);
      addEventListener("DOMContentLoaded", () => emit("navigation"));
      let timer: ReturnType<typeof setTimeout>;
      new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => emit("stateChange"), 300);
      }).observe(document, { subtree: true, childList: true });
    });
    const ids = new Map<Request, string>();
    this.context.on("request", (req) => {
      if (!shouldCaptureRequest(req.url(), req.resourceType(), this.env))
        return;
      if (this.recording.requests.length >= 5000) return;
      const rid = randomUUID();
      ids.set(req, rid);
      let body: unknown;
      try {
        body =
          (req.postData()?.length ?? 0) > 262144
            ? "[REQUEST BODY LIMIT]"
            : req.postDataJSON();
      } catch {
        body = req.postData() ? "[NON-JSON BODY OMITTED]" : undefined;
      }
      const u = new URL(req.url());
      const at = Date.now();
      this.recording.requests.push(
        redact({
          id: rid,
          url: u.toString(),
          method: req.method(),
          resourceType: req.resourceType(),
          startedAt: at,
          headers: req.headers(),
          query: Object.fromEntries(u.searchParams),
          body,
          redirectFrom: ids.get(req.redirectedFrom()!),
          initiator: "UNKNOWN",
          category: "UNKNOWN",
          operationCandidates: this.recording.operations
            .filter((o) => at - o.at >= 0 && at - o.at < 1500)
            .slice(-3)
            .map((o) => ({
              operationId: o.id,
              source: "TIME_WINDOW",
              confidence: 0.4,
              reason: "Temporal proximity only; causality unconfirmed",
              confirmed: false,
            })),
        }),
      );
    });
    this.context.on("requestfailed", (req) => {
      const row = this.recording.requests.find((r) => r.id === ids.get(req));
      if (row) {
        row.failure = req.failure()?.errorText;
        row.endedAt = Date.now();
        row.duration = row.endedAt - row.startedAt;
      }
    });
    this.context.on("response", (res) => {
      const task = (async () => {
        const row = this.recording.requests.find(
          (r) => r.id === ids.get(res.request()),
        );
        if (!row) return;
        row.status = res.status();
        row.responseHeaders = redact(res.headers());
        try {
          const type = res.headers()["content-type"] ?? "";
          const length = Number(res.headers()["content-length"] ?? 0);
          if (
            /json|text/.test(type) &&
            length > 0 &&
            length <= 262144 &&
            this.capturedBytes + length <= 2097152
          ) {
            this.capturedBytes += length;
            const data = await Promise.race([
              res.body(),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error("Capture timeout")),
                  3000,
                ).unref(),
              ),
            ]);
            if (
              data.length > 0 &&
              length <= 262144 &&
              this.capturedBytes + length <= 2097152
            ) {
              this.capturedBytes += length;
              try {
                row.response = redact(JSON.parse(data.toString()));
              } catch {
                row.response = "[TEXT BODY OMITTED FOR PRIVACY]";
              }
            }
          }
        } catch {
          row.failure = "Response body unavailable or exceeded capture limit";
        }
        row.endedAt = Date.now();
        row.duration = row.endedAt - row.startedAt;
      })();
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    });
    const page = await this.context.newPage();
    await page.goto(this.recording.target);
    return page;
  }
  async stop() {
    await this.context?.close();
    await Promise.allSettled([...this.pending]);
    await this.browser?.close();
    this.recording.state = "STOPPED";
    this.recording.endedAt = Date.now();
    for (const op of this.recording.operations)
      op.requestIds = this.recording.requests
        .filter((r) =>
          r.operationCandidates.some((c) => c.operationId === op.id),
        )
        .map((r) => r.id);
    return this.recording;
  }
}
export function observedSchema(value: unknown): Record<string, unknown> {
  if (value === null) return { type: "null" };
  if (Array.isArray(value))
    return {
      type: "array",
      items: value.length ? observedSchema(value[0]) : {},
    };
  if (typeof value === "object" && value)
    return {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, observedSchema(v)]),
      ),
    };
  return {
    type:
      typeof value === "number"
        ? "number"
        : typeof value === "boolean"
          ? "boolean"
          : "string",
  };
}
export interface Filter {
  domains?: string[];
  pathPattern?: string;
  methods?: string[];
  resourceTypes?: string[];
  categories?: string[];
  overrides?: Record<string, boolean>;
}
export function analyze(recording: Recording, filter: Filter = {}) {
  const r = structuredClone(recording);
  const assets: Asset[] = [];
  for (const req of r.requests) {
    const u = new URL(req.url);
    const path = u.pathname;
    const auth =
      /\/(?:login|logout|auth|sso|session|sessions|oauth2?|saml)(?:\/|$|\.(?:action|do|jsp)$)/i.test(
        path,
      );
    const telemetry = /telemetry|analytics|heartbeat|metrics/.test(path);
    const stat = ["image", "stylesheet", "script", "font", "media"].includes(
      req.resourceType,
    );
    req.category = auth
      ? "AUTH_BOOTSTRAP"
      : telemetry
        ? "TELEMETRY"
        : stat
          ? "STATIC_RESOURCE"
          : path.startsWith("/api/")
            ? "BUSINESS"
            : "UNKNOWN";
    req.classification = {
      source: "RULE",
      confidence: req.category === "UNKNOWN" ? 0.3 : 0.85,
      reason: auth
        ? "UI authentication bootstrap; excluded from business plan"
        : req.category === "UNKNOWN"
          ? "非标准接口路径：保留为待审核候选，不因缺少 /api/ 前缀而排除"
          : `Resource and path rule: ${req.category}`,
      confirmed: false,
    };
    const excluded =
      filter.domains?.includes(u.hostname) ||
      filter.methods?.includes(req.method) ||
      filter.resourceTypes?.includes(req.resourceType) ||
      filter.categories?.includes(req.category) ||
      (filter.pathPattern && path.includes(filter.pathPattern));
    req.keep =
      filter.overrides?.[req.id] ??
      (!excluded &&
        (req.category === "BUSINESS" ||
          (req.category === "UNKNOWN" &&
            ["fetch", "xhr"].includes(req.resourceType))));
    if (req.category === "AUTH_BOOTSTRAP") req.keep = false;
    if (!req.keep) continue;
    const pathTemplate = path.replace(
      /\/([0-9]+|[0-9a-f]{8}-[0-9a-f-]{27,})(?=\/|$)/g,
      "/{id}",
    );
    const apiId = `${req.method}:${pathTemplate}`;
    let asset = assets.find((a) => a.apiId === apiId);
    if (asset) {
      asset.sources.push(req.id);
      continue;
    }
    const headers: Asset["headers"] = {};
    for (const h of Object.keys(req.headers)) {
      headers[h] =
        /cookie|host|content-length|user-agent|accept|sec-|connection/i.test(h)
          ? { source: "CLIENT_MANAGED" }
          : /authorization|csrf|token/i.test(h)
            ? { source: "AUTH_CONTEXT", name: h }
            : /request-id|nonce|timestamp/i.test(h)
              ? { source: "RUNTIME_GENERATED", kind: "uuid" }
              : { source: "MANUAL_REVIEW" };
    }
    asset = {
      apiId,
      version: 1,
      method: req.method as Asset["method"],
      pathTemplate,
      parameters: pathTemplate.includes("{id}") ? { id: "string" } : {},
      requestSchema: req.body === undefined ? {} : observedSchema(req.body),
      responseSchema:
        req.response === undefined ? {} : observedSchema(req.response),
      headers,
      authRequired: true,
      operationType:
        req.method === "GET"
          ? "READ"
          : req.method === "POST"
            ? "CREATE"
            : req.method === "DELETE"
              ? "DELETE"
              : "UPDATE",
      risk:
        req.method === "GET"
          ? "READ"
          : req.method === "DELETE"
            ? "HIGH"
            : "WRITE",
      sources: [req.id],
      evidence: {
        source: "RECORDING",
        confidence: 0.7,
        reason:
          "Observed endpoint; contract and parameter template require review",
        confirmed: false,
      },
      validated: false,
    };
    assets.push(asset);
  }
  r.dependencies = [];
  for (let i = 0; i < r.requests.length; i++) {
    const from = r.requests[i];
    if (!from.response || typeof from.response !== "object") continue;
    for (const [key, value] of Object.entries(from.response)) {
      if (!/id$/i.test(key) || !["string", "number"].includes(typeof value))
        continue;
      for (const to of r.requests.slice(i + 1)) {
        if (
          decodeURIComponent(to.url).includes(String(value)) ||
          JSON.stringify(to.body ?? {}).includes(JSON.stringify(value))
        )
          r.dependencies.push({
            from: from.id,
            to: to.id,
            path: `$.${key}`,
            source: "VALUE_MATCH",
            confidence: 0.6,
            reason:
              "Matching scalar value; business dependency needs confirmation",
            confirmed: false,
          });
      }
    }
  }
  return { recording: r, assets };
}
