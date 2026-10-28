import { createServer } from "node:http";
import { expect, it } from "vitest";
import { intentFixture } from "../fixtures/intent";
import { compileCallIntent } from "../../packages/planner/src/intent-compiler";
import { run } from "../../packages/runner/src/index";
import type { AuthProfile } from "../../packages/contracts/src/index";

it.each([
  {
    status: 302,
    location: "/dspcas/login?service=business",
    authentication: true,
  },
  { status: 307, location: "/login.html", authentication: true },
  { status: 401, location: undefined, authentication: true },
  { status: 302, location: "/api/moved", authentication: false },
])(
  "classifies HTTP $status ($location) without following redirects or leaking session values",
  async ({ status, location, authentication }) => {
    let loginRequests = 0;
    const businessRequests: { hasCookie: boolean; hasCSRF: boolean }[] = [];
    const server = createServer((req, res) => {
      if (req.url === "/") {
        const body =
          '<span id="ready">评测集管理</span><script>localStorage.setItem("csrf", "private-runtime-csrf")</script>';
        res.writeHead(200, {
          "content-type": "text/html",
          "content-length": Buffer.byteLength(body),
          "set-cookie":
            "session=private-rejected-session; HttpOnly; Path=/; SameSite=Lax",
        });
        res.end(body);
      } else if (req.url === "/api/orders") {
        req.resume();
        businessRequests.push({
          hasCookie:
            req.headers.cookie?.includes("session=private-rejected-session") ??
            false,
          hasCSRF: req.headers["x-gde-csrf-token"] === "private-runtime-csrf",
        });
        res.writeHead(status, {
          "content-length": "0",
          ...(location ? { location } : {}),
        });
        res.end();
      } else {
        loginRequests++;
        res.writeHead(200, { "content-length": "0" });
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
      const output = compileCallIntent(f.intent, f.context);
      expect(output.issues).toEqual([]);
      f.testCase.status = output.plan.status = "APPROVED";
      output.plan.steps.forEach((step) =>
        step.assertions.forEach((assertion) => (assertion.confirmed = true)),
      );
      const profile: AuthProfile = {
        id: output.plan.authProfileRef,
        environmentRef: f.context.environment.id,
        actions: [{ type: "navigate", target: "/" }],
        readySelector: "#ready",
        headers: {
          "x-gde-csrf-token": { source: "AUTH_CONTEXT", name: "csrf" },
        },
        tokenSources: {
          csrf: { source: "localStorage", storageKey: "csrf", prefix: "" },
        },
        reauthenticateReads: false,
      };
      const report = await run(
        f.testCase,
        output.plan,
        f.assets,
        f.context.environment,
        profile,
      );
      expect(report.status).toBe("FAILED");
      expect(report.steps[0].status).toBe(
        authentication ? "AUTH_ERROR" : "FAILED",
      );
      expect(report.auth.status).toBe(authentication ? "FAILED" : "READY");
      expect(report.steps[1].status).toBe("SKIPPED");
      expect(businessRequests).toEqual([{ hasCookie: true, hasCSRF: true }]);
      expect(loginRequests).toBe(0);
      if (authentication) {
        expect(report.steps[0].assertions).toEqual([]);
        expect(report.steps[0].response).toMatchObject({
          status,
          authDiagnostics: {
            finalUIPage: baseURL + "/",
            sessionEntries: [{ name: "session", path: "/", httpOnly: true }],
          },
        });
        expect(report.steps[0].error).not.toContain("Assertion failed");
      }
      expect(JSON.stringify(report)).not.toContain("private-rejected-session");
      expect(JSON.stringify(report)).not.toContain("private-runtime-csrf");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
