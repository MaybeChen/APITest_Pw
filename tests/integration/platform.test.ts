import { it, expect } from "vitest";
import { Store } from "../../packages/storage/src/index";
import { createApp } from "../../apps/server/src/app";
import { demoArtifacts, demoEnv, demoAuth } from "../../apps/server/src/demo";
import { demoApp } from "../../apps/demo-app/src/app";
import { run } from "../../packages/runner/src/index";
import { Recorder, analyze } from "../../packages/recorder/src/index";
it("persists approval, refuses overwrite, rejects unapproved execution and cross-origin calls", async () => {
  const store = new Store("file::memory:");
  const app = await createApp(store);
  try {
    const b = demoArtifacts();
    let r = await app.inject({
      method: "POST",
      url: "/api/approve",
      payload: { ...b, confirmed: true },
    });
    expect(r.statusCode).toBe(400);
    b.testCase.steps.forEach((s) => (s.review = "CONFIRMED"));
    b.plan.steps.forEach((s) =>
      s.assertions.forEach((a) => (a.confirmed = true)),
    );
    r = await app.inject({
      method: "POST",
      url: "/api/approve",
      payload: { ...b, confirmed: true },
    });
    expect(r.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/approve",
          payload: { ...b, confirmed: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      ((await store.get("case", b.testCase.caseId, 1)) as { status: string })
        .status,
    ).toBe("APPROVED");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/demo",
          headers: { origin: "https://evil.test" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});
it("records real DOM and network evidence, logs in via UI and replays with shared cookies", async () => {
  const demo = demoApp();
  await demo.listen({ host: "127.0.0.1", port: 3100 });
  process.env.DEMO_PASSWORD = "demo-only";
  const rec = new Recorder(
    {
      caseName: "创建并删除订单",
      scenario: "创建订单后删除",
      target: demoEnv.baseURL,
    },
    demoEnv,
  );
  try {
    const page = await rec.start(true);
    await page.locator("#username").fill("tester");
    await page.locator("#password").fill("demo-only");
    await page.locator("#login button").click();
    await page.locator("#home").waitFor({ state: "visible" });
    await page.locator("#create").click();
    await page.locator("#orders button").waitFor();
    await page.locator("#orders button").click();
    await page.locator("#orders button").waitFor({ state: "detached" });
    const recording = await rec.stop();
    expect(recording.operations.some((o) => o.type === "click")).toBe(true);
    expect(recording.operations.some((o) => o.type === "navigation")).toBe(
      true,
    );
    expect(recording.requests.length).toBeGreaterThan(0);
    expect(
      recording.requests.every(
        (r) =>
          ["fetch", "xhr"].includes(r.resourceType) &&
          /^https?:\/\//i.test(r.url),
      ),
    ).toBe(true);
    expect(
      recording.requests.some((r) => new URL(r.url).pathname === "/login"),
    ).toBe(true);
    expect(
      recording.requests.some((r) => r.method === "DELETE" && r.status === 204),
    ).toBe(true);
    expect(JSON.stringify(recording)).not.toContain("demo-only");
    expect(analyze(recording).assets.length).toBeGreaterThan(1);
    const b = demoArtifacts();
    b.testCase.status = "APPROVED";
    b.testCase.steps.forEach((s) => (s.review = "CONFIRMED"));
    b.plan.status = "APPROVED";
    b.plan.steps.forEach((s) =>
      s.assertions.forEach((a) => (a.confirmed = true)),
    );
    const report = await run(b.testCase, b.plan, b.assets, demoEnv, demoAuth);
    expect(report.auth.status).toBe("READY");
    expect(report.steps).toHaveLength(5);
    expect(report.status).toBe("PASSED");
    expect(report.resources[0].cleaned).toBe(true);
    expect(report.residualResources).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("demo-only");
    // A failed assertion must still run cleanup and report the failure.
    b.plan.steps[1].assertions[0].value = 418;
    const failed = await run(b.testCase, b.plan, b.assets, demoEnv, demoAuth);
    expect(failed.status).toBe("FAILED");
    expect(failed.steps.find((s) => s.stepId === "remove")?.status).toBe(
      "SKIPPED",
    );
    expect(failed.steps.find((s) => s.stepId === "cleanup")?.status).toBe(
      "PASSED",
    );
    expect(failed.residualResources).toEqual([]);
  } finally {
    await rec.stop();
    await demo.close();
  }
});

it("saves versioned drafts and supports multiple plans linked to an immutable Case version", async () => {
  const store = new Store("file::memory:");
  const app = await createApp(store);
  try {
    const b = demoArtifacts("versions");
    b.testCase.planVersions = [1, 2];
    let r = await app.inject({
      method: "POST",
      url: "/api/drafts",
      payload: b,
    });
    expect(r.statusCode).toBe(200);
    r = await app.inject({ method: "POST", url: "/api/drafts", payload: b });
    expect(r.json().draftRevision).toBe(2);
    expect((await app.inject({ url: "/api/drafts" })).json()).toHaveLength(2);
    b.testCase.steps.forEach((s) => (s.review = "CONFIRMED"));
    b.plan.steps.forEach((s) =>
      s.assertions.forEach((a) => (a.confirmed = true)),
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/approve",
          payload: { ...b, confirmed: true },
        })
      ).statusCode,
    ).toBe(200);
    b.plan.version = 2;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/approve",
          payload: { ...b, confirmed: true },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: "/api/plans" })).json()).toHaveLength(2);
    b.plan.version = 3;
    b.testCase.planVersions.push(3);
    b.testCase.steps[0].expected = "Changed without Case version bump";
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/approve",
          payload: { ...b, confirmed: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        (await store.get("case", "versions", 1)) as {
          steps: { expected: string }[];
        }
      ).steps[0].expected,
    ).toBe("返回新订单标识");
  } finally {
    await app.close();
  }
});
it("classifies 401 as auth error and reports cleanup failure explicitly", async () => {
  const demo = demoApp();
  await demo.listen({ host: "127.0.0.1", port: 3100 });
  try {
    const b = demoArtifacts("auth-fail");
    b.testCase.status = "APPROVED";
    b.plan.status = "APPROVED";
    b.testCase.steps.forEach((s) => (s.review = "CONFIRMED"));
    b.plan.steps.forEach((s) =>
      s.assertions.forEach((a) => (a.confirmed = true)),
    );
    const authFailure = await run(b.testCase, b.plan, b.assets, demoEnv, {
      ...demoAuth,
      actions: [{ type: "navigate", target: "/" }],
      readySelector: "#login",
    });
    expect(authFailure.steps[0].status).toBe("AUTH_ERROR");
    expect(authFailure.status).toBe("FAILED");
    process.env.DEMO_PASSWORD = "demo-only";
    b.plan.steps.find((s) => s.phase === "CLEANUP")!.assertions[0].value = 500;
    const cleanupFailure = await run(
      b.testCase,
      b.plan,
      b.assets,
      demoEnv,
      demoAuth,
    );
    expect(cleanupFailure.cleanupStatus).toBe("FAILED");
    expect(cleanupFailure.status).toBe("FAILED");
  } finally {
    await demo.close();
  }
});

it("captures only whitelisted request hosts while allowing other browser requests to complete", async () => {
  const { createServer } = await import("node:http");
  const seen: string[] = [];
  let port = 0;
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    const body =
      req.url === "/"
        ? `<html><body><script>Promise.all([fetch('http://localhost:${port}/api/retained').then(r=>r.json()),fetch('/api/excluded').then(r=>r.json())]).then(()=>document.body.dataset.done='true')</script></body></html>`
        : '{"ok":true}';
    res.writeHead(200, {
      "content-type": req.url === "/" ? "text/html" : "application/json",
      "content-length": Buffer.byteLength(body),
      "access-control-allow-origin": "*",
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  const baseURL = `http://127.0.0.1:${port}`;
  const env = {
    ...demoEnv,
    baseURL,
    allowedOrigins: [baseURL, `http://localhost:${port}`],
    recordingRequestDomains: ["localhost"],
  };
  const recorder = new Recorder(
    {
      caseName: "请求域名过滤",
      scenario: "只保存 localhost 的请求",
      target: baseURL,
    },
    env,
  );
  try {
    const page = await recorder.start(true);
    await page.waitForFunction(() => document.body.dataset.done === "true");
    const recording = await recorder.stop();
    expect(seen).toContain("/api/excluded");
    expect(seen).toContain("/api/retained");
    expect(recording.requests).toHaveLength(1);
    expect(new URL(recording.requests[0].url).hostname).toBe("localhost");
    expect(recording.requests[0].status).toBe(200);
    expect(recording.operations.some((o) => o.type === "navigation")).toBe(
      true,
    );
  } finally {
    await recorder.stop();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
