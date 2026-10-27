import { redact } from "../../core/src/index.js";
import type { BrowserContext, Request, Response } from "playwright";
import type { AuthSourceHint } from "../../contracts/src/index.js";

async function bounded<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Auth source inspection timed out")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
// Values exist only during this comparison. Return source declarations, never values.
export async function discoverAuthHints(
  context: BrowserContext,
  request: Request,
  requestId?: string,
): Promise<AuthSourceHint[]> {
  try {
    const headers = Object.entries(await bounded(request.allHeaders())).filter(
      ([name, value]) =>
        /authorization|token|csrf|secret|signature|api.?key/i.test(name) &&
        value.length >= 8,
    );
    if (!headers.length) return [];
    const candidates: {
      source: AuthSourceHint["source"];
      storageKey: string;
      value: string;
      origin?: string;
      url?: string;
    }[] = [];
    for (const cookie of await bounded(context.cookies(request.url()))) {
      let value = cookie.value;
      try {
        value = decodeURIComponent(value);
      } catch {
        /* Raw value is still comparable. */
      }
      candidates.push({
        source: "cookie",
        storageKey: cookie.name,
        value,
        url: new URL(cookie.path, new URL(request.url()).origin).href,
      });
    }
    try {
      const frame = request.frame();
      const origin = new URL(frame.url()).origin;
      if (origin !== "null") {
        const stored = await bounded(
          frame.evaluate<
            {
              source: "localStorage" | "sessionStorage";
              storageKey: string;
              value: string;
            }[]
          >(`(() => {
          const entries = [];
          for (const source of ["localStorage", "sessionStorage"]) {
            try { const storage = window[source]; for (let i = 0; i < Math.min(storage.length, 100); i++) {
              const key = storage.key(i); const value = storage.getItem(key);
              if (value && value.length <= 16384) entries.push({ source, storageKey: key, value });
            }} catch {}
          }
          return entries;
        })()`),
        );
        candidates.push(...stored.map((item) => ({ ...item, origin })));
      }
    } catch {
      /* Service workers or navigating frames may have no accessible storage. */
    }
    const hints: AuthSourceHint[] = [];
    for (const [header, raw] of headers)
      for (const candidate of candidates) {
        const prefix =
          raw === candidate.value
            ? ""
            : raw.startsWith("Bearer ") && raw.slice(7) === candidate.value
              ? "Bearer "
              : undefined;
        if (
          prefix === undefined ||
          candidate.storageKey.length > 512 ||
          JSON.stringify([
            header,
            candidate.storageKey,
            candidate.origin,
            candidate.url,
            prefix,
          ]).includes(candidate.value)
        )
          continue;
        hints.push({
          header,
          source: candidate.source,
          storageKey: candidate.storageKey,
          prefix,
          ...(candidate.origin ? { origin: candidate.origin } : {}),
          ...(candidate.url ? { url: candidate.url } : {}),
          requestIds: requestId ? [requestId] : [],
          evidence: "EXACT_VALUE_MATCH",
        });
      }
    return hints;
  } catch {
    return [];
  }
}
export function mergeAuthHints(
  target: AuthSourceHint[],
  hints: AuthSourceHint[],
) {
  for (const hint of hints) {
    const existing = target.find(
      (item) =>
        item.header === hint.header &&
        item.source === hint.source &&
        item.storageKey === hint.storageKey &&
        item.prefix === hint.prefix &&
        item.origin === hint.origin &&
        item.url === hint.url &&
        item.method === hint.method,
    );
    if (existing)
      existing.requestIds = [
        ...new Set([...existing.requestIds, ...hint.requestIds]),
      ];
    else if (target.length < 100) target.push(hint);
  }
}

export class AuthHintDiscovery {
  private headers: { header: string; value: string; requestId?: string }[] = [];
  private responses: {
    value: string;
    path: string;
    source: "response" | "responseHeader";
    url: string;
    method: NonNullable<AuthSourceHint["method"]>;
  }[] = [];
  private responseScans = 0;
  constructor(
    private context: BrowserContext,
    private target: AuthSourceHint[],
  ) {}
  async request(request: Request, requestId?: string) {
    try {
      const observed = Object.entries(
        await bounded(request.allHeaders()),
      ).filter(
        ([key, value]) =>
          /authorization|token|csrf|secret|signature|api.?key/i.test(key) &&
          value.length >= 8,
      );
      this.headers.push(
        ...observed.map(([header, value]) => ({ header, value, requestId })),
      );
      this.headers = this.headers.slice(-256);
      this.matchResponses();
      mergeAuthHints(
        this.target,
        await discoverAuthHints(this.context, request, requestId),
      );
    } catch {
      /* Unknown sources remain unknown. */
    }
  }
  async response(response: Response) {
    if (
      this.responseScans >= 128 ||
      response.status() < 200 ||
      response.status() >= 300
    )
      return;
    this.responseScans++;
    try {
      const url = response.url();
      if (redact(url) !== url) return;
      const method = response.request().method() as NonNullable<
        AuthSourceHint["method"]
      >;
      for (const [key, value] of Object.entries(response.headers()))
        if (
          value.length >= 8 &&
          value.length <= 16384 &&
          this.responses.length < 1000
        )
          this.responses.push({
            value,
            path: key,
            source: "responseHeader",
            url,
            method,
          });
      this.matchResponses();
      if (
        !/json/i.test(response.headers()["content-type"] ?? "") ||
        Number(response.headers()["content-length"] ?? 0) > 262144
      )
        return;
      const body = await bounded(response.body());
      if (body.length > 262144) return;
      const value: unknown = JSON.parse(body.toString());

      const visit = (value: unknown, path: string, depth: number) => {
        if (depth > 8 || this.responses.length >= 1000) return;
        if (typeof value === "string" || typeof value === "number") {
          const text = String(value);
          if (text.length >= 8 && text.length <= 16384)
            this.responses.push({
              value: text,
              path,
              source: "response",
              url,
              method,
            });
        } else if (Array.isArray(value))
          value
            .slice(0, 20)
            .forEach((item, index) =>
              visit(item, `${path}[${index}]`, depth + 1),
            );
        else if (value && typeof value === "object")
          for (const [key, child] of Object.entries(value))
            if (/^[A-Za-z_][\w-]*$/.test(key))
              visit(child, `${path}.${key}`, depth + 1);
      };
      visit(value, "$", 0);
      this.matchResponses();
    } catch {
      /* Non-JSON or unavailable bodies cannot provide evidence. */
    }
  }
  private matchResponses() {
    for (const header of this.headers)
      for (const response of this.responses) {
        const prefix =
          header.value === response.value
            ? ""
            : header.value.startsWith("Bearer ") &&
                header.value.slice(7) === response.value
              ? "Bearer "
              : undefined;
        if (
          prefix === undefined ||
          JSON.stringify([
            header.header,
            response.path,
            response.url,
            prefix,
          ]).includes(response.value)
        )
          continue;
        mergeAuthHints(this.target, [
          {
            header: header.header,
            source: response.source,
            storageKey: response.path,
            url: response.url,
            method: response.method,
            prefix,
            requestIds: header.requestId ? [header.requestId] : [],
            evidence: "EXACT_VALUE_MATCH",
          },
        ]);
      }
  }
  clear() {
    this.headers = [];
    this.responses = [];
  }
}
