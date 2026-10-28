import type { BrowserContext, Request } from "playwright";

// Observe before UI actions so requests already running at page readiness count.
export function observeUINetwork(context: BrowserContext) {
  const pending = new Set<Request>();
  let changedAt = Date.now();
  const started = (request: Request) => {
    if (!/^https?:/.test(request.url())) return;
    pending.add(request);
    changedAt = Date.now();
  };
  const finished = (request: Request) => {
    if (pending.delete(request)) changedAt = Date.now();
  };
  context.on("request", started);
  context.on("requestfinished", finished);
  context.on("requestfailed", finished);
  return {
    async wait(timeoutMs = 30_000) {
      const began = Date.now();
      changedAt = began;
      while (pending.size || Date.now() - changedAt < 1_000) {
        if (Date.now() - began >= timeoutMs)
          throw new Error(
            `前置 UI 网络未稳定：等待 ${timeoutMs / 1000} 秒后仍未达到连续 1 秒无请求（未完成请求 ${pending.size} 个）`,
          );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    close() {
      context.off("request", started);
      context.off("requestfinished", finished);
      context.off("requestfailed", finished);
    },
  };
}
