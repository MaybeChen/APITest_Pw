import { expect, it } from "vitest";
import {
  compareSentCookies,
  snapshotCookies,
} from "../../packages/runner/src/cookie-diagnostics";
import type { BrowserContext } from "playwright";

it("compares values and duplicate names without collapsing cookie scopes", async () => {
  const cookies = [
    {
      name: "JSESSIONID",
      value: "root=value",
      domain: "example.com",
      path: "/",
    },
    { name: "JSESSIONID", value: "app", domain: "example.com", path: "/app" },
  ];
  const context = { cookies: async () => cookies } as unknown as BrowserContext;
  const snapshot = await snapshotCookies(
    context,
    "https://example.com/app/api",
    2,
    { Cookie: "JSESSIONID=wrong" },
  );
  expect(snapshot.explicitCookieHeader).toBe(true);
  expect(
    compareSentCookies(snapshot, { Cookie: "JSESSIONID=app; other=value" }),
  ).toEqual({
    wireCaptured: true,
    sentCookies: [
      { name: "JSESSIONID", value: "app" },
      { name: "other", value: "value" },
    ],
    missingMatchedCookies: [cookies[0]],
    additionalSentCookies: [{ name: "other", value: "value" }],
  });
  expect(
    compareSentCookies(snapshot, {
      cookie: "JSESSIONID=root=value; JSESSIONID=app",
    }).missingMatchedCookies,
  ).toEqual([]);
  expect(compareSentCookies(snapshot, {}).missingMatchedCookies).toEqual(
    cookies,
  );
});
