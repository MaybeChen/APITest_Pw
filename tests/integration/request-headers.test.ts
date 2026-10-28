import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { intentFixture } from "../fixtures/intent";
import { compileCallIntent } from "../../packages/planner/src/intent-compiler";
import { run } from "../../packages/runner/src/index";
import type { AuthProfile } from "../../packages/contracts/src/index";

it.each([true, false])(
  "logs actual unredacted wire headers only when enabled (%s)",
  async (enabled) => {
    const received: { method: string; headers: string[] }[] = [];
    const logs: string[] = [];
    const logger = vi
      .spyOn(console, "info")
      .mockImplementation((message) => logs.push(String(message)));
    vi.stubEnv("RUN_LOG_RAW_HEADERS", enabled ? "true" : "false");
    const server = createServer((req, res) => {
      if (req.url === "/") {
        const body =
          '<span id="ready">Ready</span><script>localStorage.setItem("csrf", "raw-csrf-value");localStorage.setItem("access", "raw-access-value")</script>';
        res.writeHead(200, {
          "content-type": "text/html",
          "content-length": Buffer.byteLength(body),
          "set-cookie":
            "session=raw-session-value; HttpOnly; Path=/; SameSite=Lax",
        });
        res.end(body);
      } else if (req.url?.startsWith("/api/orders")) {
        req.resume();
        received.push({ method: req.method!, headers: req.rawHeaders });
        const body = JSON.stringify({ id: "fresh-order", name: "captured" });
        res.writeHead(req.method === "POST" ? 201 : 200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
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
      expect(report.status).toBe("PASSED");
      expect(received).toHaveLength(2);
      const headersLogs = logs.filter((line) =>
        line.startsWith("[API_REQUEST_HEADERS]"),
      );
      expect(headersLogs).toHaveLength(enabled ? 2 : 0);
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
      expect(JSON.stringify(report)).not.toContain("raw-session-value");
      expect(JSON.stringify(report)).not.toContain("raw-csrf-value");
      expect(JSON.stringify(report)).not.toContain("raw-access-value");
    } finally {
      logger.mockRestore();
      vi.unstubAllEnvs();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
