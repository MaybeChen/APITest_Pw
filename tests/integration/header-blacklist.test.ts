import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { run } from "../../packages/runner/src/index";
import { intentFixture } from "../fixtures/intent";
import { compileCallIntent } from "../../packages/planner/src/intent-compiler";
import type { AuthProfile } from "../../packages/contracts/src/index";

it.each([false, true])(
  "excludes configured headers on the wire without changing UI cookies (debug=%s)",
  async (debug) => {
    vi.stubEnv("RUN_LOG_RAW_HEADERS", String(debug));
    const received: Record<string, string | string[] | undefined>[] = [];
    const logger = vi.spyOn(console, "info").mockImplementation(() => {});
    const server = createServer((req, res) => {
      req.resume();
      if (req.url === "/") {
        res.writeHead(200, {
          "content-type": "text/html",
          "set-cookie": "session=browser-session; HttpOnly; Path=/",
        });
        res.end("<div>Ready</div>");
      } else {
        received.push(req.headers);
        res.writeHead(req.method === "POST" ? 201 : 200, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ id: "new-order", name: "captured" }));
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const f = intentFixture();
      const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      f.context.environment = {
        ...f.context.environment,
        baseURL,
        allowedOrigins: [baseURL],
        headerBlacklist: [
          "X-GDE-SRC-PAGE",
          "USER-AGENT",
          "Cookie",
          "content-length",
        ],
      };
      f.testCase.steps = f.testCase.steps.slice(0, 2);
      f.intent.calls = f.intent.calls.slice(0, 2);
      const { plan, issues } = compileCallIntent(f.intent, f.context);
      expect(issues).toEqual([]);
      f.testCase.status = plan.status = "APPROVED";
      plan.steps.forEach((step) => {
        step.headers["X-Gde-Src-Page"] = {
          source: "STATIC",
          value: "recorded-page",
        };
        step.assertions.forEach((assertion) => {
          assertion.confirmed = true;
        });
      });
      const profile: AuthProfile = {
        id: plan.authProfileRef,
        actions: [{ type: "navigate", target: "/" }],
        headers: {
          "x-gde-src-page": { source: "STATIC", value: "profile-page" },
          "x-keep": { source: "STATIC", value: "kept" },
        },
        tokenSources: {},
        reauthenticateReads: false,
      };
      const report = await run(
        f.testCase,
        plan,
        f.assets,
        f.context.environment,
        profile,
      );
      expect(
        report.status,
        JSON.stringify(report.steps.map((step) => step.error)),
      ).toBe("PASSED");
      expect(received).toHaveLength(2);
      for (const headers of received) {
        expect(headers["x-gde-src-page"]).toBeUndefined();
        expect(headers["user-agent"]).toBeUndefined();
        expect(headers.cookie).toBeUndefined();
        expect(headers["content-length"]).toBeUndefined();
        expect(headers["x-keep"]).toBe("kept");
      }
      if (debug) {
        const diagnostic = (
          report.steps[0].request as {
            cookieDiagnostics: {
              matchedCookies: { name: string }[];
              missingMatchedCookies: { name: string }[];
            }[];
          }
        ).cookieDiagnostics[0];
        expect(
          diagnostic.matchedCookies.map((cookie) => cookie.name),
        ).toContain("session");
        expect(
          diagnostic.missingMatchedCookies.map((cookie) => cookie.name),
        ).toContain("session");
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      logger.mockRestore();
      vi.unstubAllEnvs();
    }
  },
);
