import type { Browser, BrowserContext } from "playwright";

const retained = new Map<
  string,
  { browser: Browser; context: BrowserContext }
>();

export function retainBrowser(
  reportId: string,
  browser: Browser,
  context: BrowserContext,
) {
  retained.set(reportId, { browser, context });
  const closeWhenEmpty = () => {
    if (
      !retained.has(reportId) ||
      context.pages().some((page) => !page.isClosed())
    )
      return;
    retained.delete(reportId);
    void context
      .close()
      .catch(() => {})
      .finally(() => browser.close().catch(() => {}));
  };
  for (const page of context.pages()) page.once("close", closeWhenEmpty);
  context.on("page", (page) => page.once("close", closeWhenEmpty));
  browser.once("disconnected", () => retained.delete(reportId));
}

export function getRetainedBrowser(reportId: string) {
  return retained.get(reportId);
}

export async function closeRetainedBrowsers() {
  const sessions = [...retained.values()];
  retained.clear();
  await Promise.allSettled(
    sessions.map(async ({ browser, context }) => {
      try {
        await context.close();
      } finally {
        await browser.close();
      }
    }),
  );
}
