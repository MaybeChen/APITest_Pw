import {
  getRetainedBrowser,
  closeRetainedBrowsers,
} from "../../packages/runner/src/retained-browsers";
import { createApp } from "../../apps/server/src/app";
import { Store } from "../../packages/storage/src/index";
import { MockAIProvider } from "../../packages/planner/src/index";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { intentFixture } from "../fixtures/intent";
import { compileCallIntent } from "../../packages/planner/src/intent-compiler";
import { run } from "../../packages/runner/src/index";
import type { AuthProfile } from "../../packages/contracts/src/index";

it.each([
  { enabled: true, redirect: false, keep: false },
  { enabled: false, redirect: false, keep: false },
  { enabled: true, redirect: true, keep: true },
  { enabled: true, redirect: false, keep: true },
  { enabled: true, redirect: false, keep: false, chunked: true },
  {
    enabled: true,
    redirect: false,
    keep: false,
    chunked: true,
    oversized: true,
  },
])(
  "logs and persists actual request headers (enabled=$enabled, redirect=$redirect, keep=$keep)",
  async ({ enabled, redirect, keep, chunked, oversized }) => {
    const received: { method: string; headers: string[] }[] = [];
    const logs: string[] = [];
    const logger = vi
      .spyOn(console, "info")
      .mockImplementation((message) => logs.push(String(message)));
    vi.stubEnv("RUN_LOG_RAW_HEADERS", enabled ? "true" : "false");
    vi.stubEnv("RUN_KEEP_BROWSER_OPEN", keep ? "true" : "false");
    const server = createServer((req, res) => {
      if (req.url === "/") {
        const body =
          '<span id="ready">Ready</span><script>localStorage.setItem("csrf", "raw-csrf-value");localStorage.setItem("access", "raw-access-value")</script>';
        res.writeHead(200, {
          "content-type": "text/html",
          "content-length": Buffer.byteLength(body),
          "set-cookie": [
            "session=raw-session-value; HttpOnly; Path=/; SameSite=Lax",
            "session=other-path-session; HttpOnly; Path=/other; SameSite=Lax",
          ],
        });
        res.end(body);
      } else if (req.url?.startsWith("/api/orders")) {
        req.resume();
        received.push({ method: req.method!, headers: req.rawHeaders });
        if (redirect) {
          res.writeHead(302, {
            location: "/dspcas/login",
            "content-length": "0",
          });
          res.end();
          return;
        }
        const body = JSON.stringify({
          id: "fresh-order",
          name: oversized ? "x".repeat(1048576) : "captured",
        });
        res.writeHead(req.method === "POST" ? 201 : 200, {
          "content-type": "application/json",
          ...(chunked ? {} : { "content-length": Buffer.byteLength(body) }),
        });
        if (chunked) {
          res.write(body.slice(0, 5));
          res.end(body.slice(5));
        } else res.end(body);
      } else {
        res.writeHead(404, { "content-length": "0" });
        res.end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const f = intentFixture();
      f.context.environment = {
        ...f.context.environment,
        baseURL,
        allowedOrigins: [baseURL],
      };
      f.testCase.steps = f.testCase.steps.slice(0, 2);
      f.intent.calls = f.intent.calls.slice(0, 2);
      const { plan, issues } = compileCallIntent(f.intent, f.context);
      expect(issues).toEqual([]);
      f.testCase.status = plan.status = "APPROVED";
      plan.steps.forEach((step) =>
        step.assertions.forEach((assertion) => (assertion.confirmed = true)),
      );
      const profile: AuthProfile = {
        id: plan.authProfileRef,
        environmentRef: f.context.environment.id,
        actions: [{ type: "navigate", target: "/" }],
        readySelector: "#ready",
        headers: {
          "x-gde-csrf-token": { source: "AUTH_CONTEXT", name: "csrf" },
          authorization: { source: "AUTH_CONTEXT", name: "access" },
        },
        tokenSources: {
          csrf: { source: "localStorage", storageKey: "csrf", prefix: "" },
          access: {
            source: "localStorage",
            storageKey: "access",
            prefix: "Bearer ",
          },
        },
        reauthenticateReads: false,
      };
      const report = await run(
        f.testCase,
        plan,
        f.assets,
        f.context.environment,
        profile,
      );
      expect(report.status).toBe(redirect || oversized ? "FAILED" : "PASSED");
      if (redirect) expect(report.steps[0].status).toBe("AUTH_ERROR");
      if (oversized)
        expect(report.steps[0].error).toContain(
          "Runner response limit exceeded",
        );
      expect(received).toHaveLength(redirect || oversized ? 1 : 2);
      const headersLogs = logs.filter((line) =>
        line.startsWith("[API_REQUEST_HEADERS]"),
      );
      expect(headersLogs).toHaveLength(enabled ? received.length : 0);
      for (const [index, log] of headersLogs.entries()) {
        const [metadataLine, ...headerLines] = log.trim().split("\n");
        const metadata = JSON.parse(
          metadataLine.slice("[API_REQUEST_HEADERS] ".length),
        );
        expect(metadata).toMatchObject({
          reportId: report.id,
          stepId: plan.steps[index].id,
          attempt: 1,
          method: received[index].method,
        });
        const logged = headerLines.filter(Boolean).flatMap((line) => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon), line.slice(colon + 1).trim()];
        });
        expect(logged).toEqual(received[index].headers);
        expect(log).toContain("cookie: session=raw-session-value");
        expect(log).toContain("x-gde-csrf-token: raw-csrf-value");
        expect(log).toContain("authorization: Bearer raw-access-value");
        expect(log).toMatch(/user-agent:/i);
        expect(log).toMatch(/host:/i);
        if (index === 0) expect(log).toMatch(/content-length:/i);
      }
      const retained = getRetainedBrowser(report.id);
      expect(!!retained).toBe(keep);
      if (keep) {
        expect(report.debug?.browserRetained).toBe(true);
        expect(retained!.browser.isConnected()).toBe(true);
        expect(
          (await retained!.context.cookies(baseURL)).find(
            (entry) => entry.name === "session",
          )?.value,
        ).toBe("raw-session-value");
        expect(
          await retained!.context.pages()[0].locator("#ready").isVisible(),
        ).toBe(true);
        if (!redirect) {
          await Promise.all(
            retained!.context.pages().map((page) => page.close()),
          );
          await expect
            .poll(() => getRetainedBrowser(report.id))
            .toBeUndefined();
          await expect.poll(() => retained!.browser.isConnected()).toBe(false);
        }
      }
      const store = new Store("file::memory:");
      const app = await createApp(store, new MockAIProvider());
      try {
        // Verify the persisted history endpoint as well as the immediate result.
        await store.put("report", report.id, 1, report);
        const stored = await store.get<typeof report>("report", report.id);
        const history = (await app.inject("/api/reports")).json();
        expect(history).toEqual([stored]);
        if (enabled) {
          const diagnostic = (
            stored?.steps[0].request as {
              cookieDiagnostics: Record<string, unknown>[];
            }
          ).cookieDiagnostics[0];
          expect(diagnostic).toMatchObject({
            attempt: 1,
            explicitCookieHeader: false,
            wireCaptured: true,
            missingMatchedCookies: [],
            additionalSentCookies: [],
            sentCookies: [{ name: "session", value: "raw-session-value" }],
            matchedCookies: [
              { name: "session", value: "raw-session-value", path: "/" },
            ],
            unmatchedCookies: [
              { name: "session", value: "other-path-session", path: "/other" },
            ],
          });
          expect(diagnostic.allCookies).toHaveLength(2);
          expect(
            logs.some((line) => line.startsWith("[API_COOKIE_DIAGNOSTICS]")),
          ).toBe(true);
          expect(stored?.debug?.rawRequestHeaders).toBe(true);
          expect(stored?.steps[0].request).toMatchObject({
            headersSource: "ACTUAL_REQUEST",
            headers: {
              cookie: "session=raw-session-value",
              "x-gde-csrf-token": "raw-csrf-value",
              authorization: "Bearer raw-access-value",
            },
          });
          expect(
            (stored?.steps[0].request as { rawHeaders: string }).rawHeaders,
          ).toContain("cookie: session=raw-session-value");
          expect(report.steps[0].request).toEqual(stored?.steps[0].request);
        } else {
          expect(stored?.steps[0].request).not.toHaveProperty(
            "cookieDiagnostics",
          );
          expect(
            logs.some((line) => line.startsWith("[API_COOKIE_DIAGNOSTICS]")),
          ).toBe(false);
          for (const value of [
            "raw-session-value",
            "raw-csrf-value",
            "raw-access-value",
          ])
            expect(JSON.stringify(stored)).not.toContain(value);
        }
      } finally {
        await app.close();
      }
      expect(getRetainedBrowser(report.id)).toBeUndefined();
      if (retained) expect(retained.browser.isConnected()).toBe(false);
    } finally {
      await closeRetainedBrowsers();
      logger.mockRestore();
      vi.unstubAllEnvs();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
