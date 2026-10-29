import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { run } from "../../packages/runner/src/index";
import { createApp } from "../../apps/server/src/app";
import { Store } from "../../packages/storage/src/index";
import { MockAIProvider } from "../../packages/planner/src/index";
import { intentFixture } from "../fixtures/intent";
import { compileCallIntent } from "../../packages/planner/src/intent-compiler";
import type { Report } from "../../packages/contracts/src/index";

it("retries only the selected read with the same browser session and upstream variables, preserving the original report", async () => {
  vi.stubEnv("RUN_KEEP_BROWSER_OPEN", "true");
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  let logins = 0,
    creates = 0,
    reads = 0;
  const urls: string[] = [];
  const requestTimes: number[] = [];
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === "/") {
      logins++;
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "session=same-session; Path=/; HttpOnly",
      });
      res.end("<div>Ready</div>");
      return;
    }
    requestTimes.push(Date.now());
    expect(req.headers.cookie).toContain("session=same-session");
    const creating = req.method === "POST";
    if (creating) creates++;
    else {
      reads++;
      urls.push(req.url!);
    }
    res.writeHead(creating ? 201 : reads === 1 ? 500 : 200, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify({ id: "runtime-order", name: "captured" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const store = new Store("file::memory:");
  const app = await createApp(store, new MockAIProvider());
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
    const original = await run(
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
    expect(original.status).toBe("FAILED");
    await store.put("report", original.id, 1, original);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/reports/${original.id}/steps/create/retry`,
        })
      ).statusCode,
    ).toBe(409);
    const stepId = original.steps.find((step) => step.retryable)!.stepId;
    const response = await app.inject({
      method: "POST",
      url: `/api/reports/${original.id}/steps/${stepId}/retry`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const retry = response.json() as Report;
    expect(retry.status).toBe("PASSED");
    expect(retry.steps).toHaveLength(1);
    expect(retry.steps[0].attempts).toBe(1);
    expect(retry.retryOf).toMatchObject({ reportId: original.id, stepId });
    expect(logins).toBe(1);
    expect(creates).toBe(1);
    expect(reads).toBe(2);
    expect(urls).toEqual([
      "/api/orders/runtime-order",
      "/api/orders/runtime-order",
    ]);
    expect(await store.get("report", original.id, 1)).toEqual(original);
    expect(await store.get("report", retry.id, 1)).toMatchObject({
      status: "PASSED",
    });
    const repeated = await app.inject({
      method: "POST",
      url: `/api/reports/${retry.id}/steps/${stepId}/retry`,
    });
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(logins).toBe(1);
    expect(creates).toBe(1);
    const { closeRetainedBrowsers } =
      await import("../../packages/runner/src/retained-browsers");
    await closeRetainedBrowsers();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/reports/${original.id}/steps/${stepId}/retry`,
        })
      ).statusCode,
    ).toBe(410);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    log.mockRestore();
    vi.unstubAllEnvs();
  }
});
