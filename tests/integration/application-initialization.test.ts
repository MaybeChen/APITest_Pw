import { createServer } from "node:http";
import { expect, it } from "vitest";
import { run } from "../../packages/runner/src/index";
import { compileCallIntent } from "../../packages/planner/src/intent-compiler";
import { intentFixture } from "../fixtures/intent";

it.each([
  { enabled: false, appOnly: false },
  { enabled: true, appOnly: false },
  { enabled: true, appOnly: true },
])(
  "uses common login then initializes the application in a new page before API calls (enabled=$enabled, appOnly=$appOnly)",
  async ({ enabled, appOnly }) => {
    let pageLoads = 0,
      apiCalls = 0;
    const server = createServer((req, res) => {
      req.resume();
      if (req.url === "/") {
        res.writeHead(200, {
          "content-type": "text/html",
          "set-cookie": "portal=logged-in; Path=/; HttpOnly",
        });
        res.end(
          `<div>Portal</div><script>sessionStorage.setItem('common-state','shared-state');fetch('/config');</script>`,
        );
      } else if (req.url === "/app") {
        pageLoads++;
        expect(req.headers.cookie).toContain("portal=logged-in");
        res.writeHead(200, {
          "content-type": "text/html",
          "set-cookie": "application=initialized; Path=/; HttpOnly",
        });
        res.end(
          `<div>Application</div><script>fetch('${appOnly ? "/app-config" : "/config"}')</script>`,
        );
      } else if (req.url === "/config" || req.url === "/app-config") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            csrf: req.headers.cookie?.includes("application=initialized")
              ? "application-csrf"
              : "portal-csrf",
          }),
        );
      } else {
        apiCalls++;
        const authenticated =
          req.headers.cookie?.includes("application=initialized") &&
          req.headers["x-csrf-token"] === "application-csrf" &&
          req.headers["x-state"] === "shared-state";
        res.writeHead(
          authenticated ? (req.method === "POST" ? 201 : 200) : 401,
          { "content-type": "application/json" },
        );
        res.end(JSON.stringify({ id: "runtime-order", name: "captured" }));
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
      };
      f.testCase.steps = f.testCase.steps.slice(0, 2);
      f.intent.calls = f.intent.calls.slice(0, 2);
      const { plan, issues } = compileCallIntent(f.intent, f.context);
      expect(issues).toEqual([]);
      f.testCase.status = plan.status = "APPROVED";
      plan.steps.forEach((step) =>
        step.assertions.forEach((assertion) => {
          assertion.confirmed = true;
        }),
      );
      if (enabled)
        plan.applicationInitializations = [
          {
            navigationId: "app-navigation",
            url: baseURL + "/app#/studio",
            newWindow: true,
            beforeStepId: plan.steps[0].id,
          },
        ];
      const report = await run(
        f.testCase,
        plan,
        f.assets,
        f.context.environment,
        {
          id: plan.authProfileRef,
          actions: [{ type: "navigate", target: "/" }],
          headers: {
            "x-csrf-token": { source: "AUTH_CONTEXT", name: "csrf" },
            "x-state": { source: "AUTH_CONTEXT", name: "state" },
          },
          tokenSources: {
            csrf: {
              source: "response",
              url: baseURL + (appOnly ? "/app-config" : "/config"),
              storageKey: "$.csrf",
              prefix: "",
            },
            state: {
              source: "sessionStorage",
              storageKey: "common-state",
              prefix: "",
            },
          },
          reauthenticateReads: false,
        },
      );
      expect(
        report.status,
        JSON.stringify(report.steps.map((step) => step.error)),
      ).toBe(enabled ? "PASSED" : "FAILED");
      expect(pageLoads).toBe(enabled ? 1 : 0);
      expect(apiCalls).toBe(enabled ? 2 : 1);
      if (enabled)
        expect(report.applicationInitializations).toEqual([
          expect.objectContaining({
            navigationId: "app-navigation",
            status: "PASSED",
            beforeStepId: "create",
          }),
        ]);
      else expect(report.steps[0].status).toBe("AUTH_ERROR");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it("executes recorded tail cleanup even when the business assertion fails", async () => {
  let deleted = false;
  const methods: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<div>Ready</div>");
      return;
    }
    methods.push(req.method!);
    if (req.method === "DELETE") {
      deleted = true;
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(req.method === "POST" ? 201 : deleted ? 404 : 500, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify({ id: "runtime-order", name: "captured" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const f = intentFixture();
    const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    f.context.environment = {
      ...f.context.environment,
      baseURL,
      allowedOrigins: [baseURL],
    };
    for (const step of f.testCase.steps.filter((step) =>
      ["remove", "verify"].includes(step.id),
    ))
      step.purpose = "CLEANUP";
    const { plan, issues } = compileCallIntent(f.intent, f.context);
    expect(issues).toEqual([]);
    f.testCase.status = plan.status = "APPROVED";
    plan.steps.forEach((step) =>
      step.assertions.forEach((assertion) => {
        assertion.confirmed = true;
      }),
    );
    const report = await run(
      f.testCase,
      plan,
      f.assets,
      f.context.environment,
      {
        id: plan.authProfileRef,
        actions: [{ type: "navigate", target: "/" }],
        headers: {},
        tokenSources: {},
        reauthenticateReads: false,
      },
    );
    expect(report.status).toBe("FAILED");
    expect(report.cleanupStatus).toBe("PASSED");
    expect(report.residualResources).toEqual([]);
    expect(methods).toEqual(["POST", "GET", "DELETE", "GET"]);
    expect(report.steps.find((step) => step.stepId === "delete")).toMatchObject(
      { phase: "CLEANUP", status: "PASSED" },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
