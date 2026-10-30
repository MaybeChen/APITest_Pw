import type { BrowserContext, Response, Request } from "playwright";
import type { AuthProfile, Environment } from "../../contracts/src/index.js";
import { allowedURL, atPath } from "../../core/src/index.js";

// Observe requests made by the approved UI flow; never replay bootstrap writes.
export function observeAuthResponses(
  context: BrowserContext,
  profile: AuthProfile,
  env: Environment,
) {
  const sources = Object.entries(profile.tokenSources).filter(
    ([, source]) =>
      source.source === "response" || source.source === "responseHeader",
  );
  for (const [name, source] of sources) {
    if (!source.url) throw new Error(`前置接口来源 ${name} 缺少 URL`);
    allowedURL(source.url, env);
    if (source.source === "response") atPath({}, source.storageKey);
  }
  const values = new Map<string, { sequence: number; value: string }>();
  const seen = new Set<string>();
  const requested = new Map<string, number>();
  const requestOrder = new WeakMap<Request, number>();
  let requestSequence = 0;
  const requestListener = (request: Request) => {
    const order = ++requestSequence;
    requestOrder.set(request, order);
    for (const [name, source] of sources)
      if (
        source.url === request.url() &&
        request.method() === (source.method ?? "GET")
      ) {
        seen.add(name);
        requested.set(name, order);
      }
  };
  const waiters = new Map<
    string,
    {
      resolve: (value: string) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let closed = false;
  const listener = (response: Response) => {
    const current = requestOrder.get(response.request()) ?? ++requestSequence;
    const matching = sources.filter(
      ([, source]) =>
        source.url === response.url() &&
        response.request().method() === (source.method ?? "GET") &&
        response.status() >= 200 &&
        response.status() < 300,
    );
    if (!matching.length) return;
    void (async () => {
      const length = Number(response.headers()["content-length"] ?? 0);
      let data: unknown;
      if (
        length <= 262144 &&
        matching.some(([, source]) => source.source === "response")
      ) {
        try {
          const body = await response.body();
          if (!closed && body.length <= 262144)
            data = JSON.parse(body.toString());
        } catch {
          /* Header extraction remains available even if JSON is unavailable. */
        }
      }
      if (closed) return;
      for (const [name, source] of matching) {
        const found =
          source.source === "responseHeader"
            ? response.headers()[source.storageKey.toLowerCase()]
            : atPath(data, source.storageKey);
        if (
          (typeof found !== "string" && typeof found !== "number") ||
          !String(found)
        )
          continue;
        if (current < (values.get(name)?.sequence ?? 0)) continue;
        const value = String(found);
        values.set(name, { sequence: current, value });
        const waiting = waiters.get(name);
        if (waiting && current >= (requested.get(name) ?? 0)) {
          clearTimeout(waiting.timer);
          waiters.delete(name);
          waiting.resolve(value);
        }
      }
    })().catch(() => {});
  };
  if (sources.length) {
    context.on("request", requestListener);
    context.on("response", listener);
  }
  return {
    observed(name: string) {
      return seen.has(name);
    },
    read(name: string, fallback?: string): Promise<string> {
      const value = values.get(name);
      if (value && value.sequence >= (requested.get(name) ?? 0))
        return Promise.resolve(value.value);
      if (fallback !== undefined && !seen.has(name))
        return Promise.resolve(fallback);
      const source = profile.tokenSources[name];
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(name);
          reject(
            new Error(
              `前置 UI 未取得认证来源 ${name}：未观察到 ${source.method ?? "GET"} ${source.url} 的字段 ${source.storageKey}`,
            ),
          );
        }, 15000);
        waiters.set(name, { resolve, reject, timer });
      });
    },
    close() {
      closed = true;
      context.off("response", listener);
      context.off("request", requestListener);
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("认证来源监听已关闭"));
      }
      waiters.clear();
      values.clear();
    },
  };
}
