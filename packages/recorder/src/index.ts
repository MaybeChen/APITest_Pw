import {
  recordingSchema,
  contextSnapshotSchema,
} from "../../contracts/src/index.js";
import { fileURLToPath } from "node:url";
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
  private stopping = false;
  private snapshotBytes = 0;
  recording: Recording;
  constructor(
    input: {
      caseName: string;
      scenario: string;
      target: string;
      notes?: string;
      workspaceId?: string;
      environmentRef?: string;
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
      contextSnapshots: [],
      contextCapture: {
        omittedSnapshots: 0,
        initializedFrames: 0,
        rejectedEvents: 0,
      },
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
    await this.context.exposeBinding("__record", (_source, event: unknown) => {
      if (this.stopping) return;
      if (
        event &&
        typeof event === "object" &&
        "recorderReady" in event &&
        event.recorderReady === true
      ) {
        this.recording.contextCapture!.initializedFrames!++;
        return;
      }
      if (event && typeof event === "object" && "snapshot" in event) {
        const parsed = contextSnapshotSchema.safeParse(
          (event as { snapshot: unknown }).snapshot,
        );
        if (!parsed.success) {
          this.recording.contextCapture!.rejectedEvents!++;
          return;
        }
        const safe = redact(parsed.data);
        const size = Buffer.byteLength(JSON.stringify(safe));
        if (
          (this.recording.contextSnapshots?.length ?? 0) >= 1000 ||
          this.snapshotBytes + size > 2097152
        ) {
          this.recording.contextCapture!.omittedSnapshots++;
          return;
        }
        this.snapshotBytes += size;
        this.recording.contextSnapshots!.push(safe);
        return;
      }
      const parsed = recordingSchema.shape.operations.element.safeParse(event);
      if (!parsed.success) this.recording.contextCapture!.rejectedEvents!++;
      if (parsed.success && this.recording.operations.length < 10000)
        this.recording.operations.push(redact(parsed.data));
    });
    // Load browser JavaScript directly: serializing a tsx-transformed callback
    // can introduce references to Node-side helpers such as __name.
    await this.context.addInitScript({
      path: fileURLToPath(new URL("./browser-recorder.js", import.meta.url)),
    });
    const ids = new Map<Request, string>();
    this.context.on("request", (req) => {
      if (this.stopping) return;
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
            .filter(
              (o) =>
                ["click", "input", "change", "submit", "navigation"].includes(
                  o.type,
                ) &&
                at - o.at >= 0 &&
                at - o.at < 1500,
            )
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
          const headerLength = res.headers()["content-length"];
          const length =
            headerLength === undefined ? NaN : Number(headerLength);
          if (
            [204, 304].includes(res.status()) ||
            res.request().method() === "HEAD" ||
            length === 0
          ) {
            row.responseBodyCapture = {
              state: "EMPTY",
              reason: "此响应没有正文",
              bytes: 0,
            };
          } else if (!/json|text/i.test(type)) {
            row.responseBodyCapture = {
              state: "OMITTED",
              reason: "不采集此内容类型的响应正文",
            };
          } else if (!Number.isFinite(length) || length < 0) {
            row.responseBodyCapture = {
              state: "OMITTED",
              reason:
                "响应没有有效 Content-Length（可能为 chunked 或流式响应），为避免无界采集未读取正文",
            };
          } else if (length > 262144) {
            row.responseBodyCapture = {
              state: "OMITTED",
              reason: "响应超过单体 256 KiB 采集上限",
            };
          } else if (this.capturedBytes + length > 2097152) {
            row.responseBodyCapture = {
              state: "OMITTED",
              reason: "已达到单会话 2 MiB 响应采集预算",
            };
          } else {
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
            // Content-Length can describe compressed bytes; enforce the limit on decoded bytes too.
            this.capturedBytes += Math.max(0, data.length - length);
            if (data.length > 262144)
              row.responseBodyCapture = {
                state: "OMITTED",
                reason: "解压后的响应超过单体 256 KiB 采集上限",
                bytes: data.length,
              };
            else if (this.capturedBytes > 2097152)
              row.responseBodyCapture = {
                state: "OMITTED",
                reason: "已达到单会话 2 MiB 响应采集预算",
                bytes: data.length,
              };
            else if (!data.length)
              row.responseBodyCapture = {
                state: "EMPTY",
                reason: "此响应没有正文",
                bytes: 0,
              };
            else {
              try {
                row.response = redact(JSON.parse(data.toString()));
                row.responseBodyCapture = {
                  state: "CAPTURED",
                  bytes: data.length,
                };
              } catch {
                row.responseBodyCapture = {
                  state: "OMITTED",
                  reason: "非 JSON 文本正文按隐私策略不保存",
                  bytes: data.length,
                };
              }
            }
          }
        } catch {
          row.responseBodyCapture = {
            state: "FAILED",
            reason: "响应正文读取超时或不可用；请求状态与响应头仍保留",
          };
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
    this.stopping = true;
    // Finish body reads already in progress before closing their browser context.
    await Promise.allSettled([...this.pending]);
    await this.context?.close();
    await Promise.allSettled([...this.pending]);
    await this.browser?.close();
    this.recording.state = "STOPPED";
    this.recording.endedAt = Date.now();
    for (const request of this.recording.requests) {
      request.operationCandidates = this.recording.operations
        .filter(
          (op) =>
            ["click", "input", "change", "submit", "navigation"].includes(
              op.type,
            ) &&
            request.startedAt - op.at >= 0 &&
            request.startedAt - op.at < 1500,
        )
        .slice(-3)
        .map((op) => ({
          operationId: op.id,
          source: "TIME_WINDOW",
          confidence: 0.4,
          reason: "Temporal proximity only; causality unconfirmed",
          confirmed: false,
        }));
      const candidates = new Set(
        request.operationCandidates.map((candidate) => candidate.operationId),
      );
      request.contextSnapshotRefs = (this.recording.contextSnapshots ?? [])
        .filter((snapshot) => candidates.has(snapshot.operationId))
        .map((snapshot) => snapshot.id);
    }
    for (const op of this.recording.operations) {
      op.requestIds = this.recording.requests
        .filter((request) =>
          request.operationCandidates.some(
            (candidate) => candidate.operationId === op.id,
          ),
        )
        .map((request) => request.id);
      op.context.snapshotRefs = (this.recording.contextSnapshots ?? [])
        .filter((snapshot) => snapshot.operationId === op.id)
        .map((snapshot) => snapshot.id);
    }
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
        /^(cookie|host|content-length|user-agent|accept(?:-.*)?|sec-.*|connection)$/i.test(
          h,
        )
          ? { source: "CLIENT_MANAGED" }
          : /authorization|csrf|token|secret|password|signature|api.?key/i.test(
                h,
              ) ||
              redact(req.headers[h], h) !== req.headers[h] ||
              /\[REDACTED\]/.test(req.headers[h])
            ? { source: "MANUAL_REVIEW" }
            : { source: "STATIC", value: req.headers[h] };
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
  const leaves = (
    value: unknown,
    path = "$",
    depth = 0,
  ): { path: string; key: string; value: string | number }[] => {
    if (depth > 6 || !value || typeof value !== "object") return [];
    return Object.entries(value)
      .slice(0, 100)
      .flatMap(([key, item]) => {
        const next = Array.isArray(value)
          ? `${path}[${key}]`
          : `${path}.${key}`;
        return item && typeof item === "object"
          ? leaves(item, next, depth + 1)
          : ["string", "number"].includes(typeof item) && item !== "[REDACTED]"
            ? [{ path: next, key, value: item as string | number }]
            : [];
      });
  };
  for (let index = 0; index < r.requests.length; index++) {
    const from = r.requests[index];
    for (const source of leaves(from.response).filter((leaf) =>
      /id$/i.test(leaf.key),
    )) {
      for (const to of r.requests.slice(index + 1)) {
        if (from.endedAt !== undefined && from.endedAt > to.startedAt) continue;
        const url = new URL(to.url);
        const matches: { location: "PATH" | "QUERY" | "BODY"; key: string }[] =
          [];
        url.pathname
          .split("/")
          .filter(Boolean)
          .forEach((segment, i) => {
            try {
              if (decodeURIComponent(segment) === String(source.value))
                matches.push({ location: "PATH", key: String(i) });
            } catch {
              /* Malformed escaped path is not a dependency. */
            }
          });
        url.searchParams.forEach((value, key) => {
          if (value === String(source.value))
            matches.push({ location: "QUERY", key });
        });
        leaves(to.body).forEach((leaf) => {
          if (String(leaf.value) === String(source.value))
            matches.push({ location: "BODY", key: leaf.path });
        });
        for (const target of matches)
          r.dependencies.push({
            from: from.id,
            to: to.id,
            path: source.path,
            targetLocation: target.location,
            targetKey: target.key,
            valueType: typeof source.value === "number" ? "number" : "string",
            source: "EXACT_VALUE_MATCH",
            confidence: 0.6,
            reason:
              "Exact scalar match in an earlier response; business dependency still needs confirmation",
            confirmed: false,
          });
      }
    }
  }
  return { recording: r, assets };
}
