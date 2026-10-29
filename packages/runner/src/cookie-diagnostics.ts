import type { BrowserContext } from "playwright";

export async function snapshotCookies(
  context: BrowserContext,
  url: string,
  attempt: number,
  headers: Record<string, string>,
) {
  const [allCookies, matchedCookies] = await Promise.all([
    context.cookies(),
    context.cookies(url),
  ]);
  return {
    attempt,
    capturedAt: Date.now(),
    targetURL: url,
    explicitCookieHeader: Object.keys(headers).some(
      (name) => name.toLowerCase() === "cookie",
    ),
    allCookies,
    matchedCookies,
    // Includes scope metadata so same-name cookies remain distinguishable.
    unmatchedCookies: allCookies.filter(
      (cookie) =>
        !matchedCookies.some(
          (matched) =>
            matched.name === cookie.name &&
            matched.domain === cookie.domain &&
            matched.path === cookie.path &&
            matched.value === cookie.value,
        ),
    ),
    wireCaptured: false,
  };
}

export function compareSentCookies(
  snapshot: Awaited<ReturnType<typeof snapshotCookies>>,
  headers: Record<string, string | string[]>,
) {
  const sentCookies = Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === "cookie")
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .flatMap((value) => value.split(";"))
    .map((part) => {
      const index = part.indexOf("=");
      return {
        name: part.slice(0, index).trim(),
        value: part.slice(index + 1).trim(),
      };
    });
  const remaining = [...sentCookies];
  const missingMatchedCookies = snapshot.matchedCookies.filter((cookie) => {
    const index = remaining.findIndex(
      (sent) => sent.name === cookie.name && sent.value === cookie.value,
    );
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
  return {
    wireCaptured: true,
    sentCookies,
    missingMatchedCookies,
    additionalSentCookies: remaining,
  };
}
