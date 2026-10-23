import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Store, defaultDatabaseURL } from "../../packages/storage/src/index";
import { createApp } from "../../apps/server/src/app";
import { demoArtifacts, demoEnv, demoAuth } from "../../apps/server/src/demo";

it("keeps the default database location stable when the launch directory changes", () => {
  const original = process.cwd();
  const previous = process.env.TRACEPILOT_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), "tracepilot-cwd-"));
  delete process.env.TRACEPILOT_DATA_DIR;
  try {
    const first = defaultDatabaseURL();
    process.chdir(dir);
    expect(defaultDatabaseURL()).toBe(first);
    expect(first).toMatch(/\/\.data\/platform\.db$/);
    process.env.TRACEPILOT_DATA_DIR = dir;
    expect(defaultDatabaseURL()).toBe(
      pathToFileURL(join(dir, "platform.db")).href,
    );
  } finally {
    process.chdir(original);
    if (previous === undefined) delete process.env.TRACEPILOT_DATA_DIR;
    else process.env.TRACEPILOT_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

it("restores latest environment and auth configurations after reopening the database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tracepilot-persistence-"));
  const url = pathToFileURL(join(dir, "nested", "platform.db")).href;
  let app = await createApp(new Store(url));
  try {
    const environment = {
      ...demoEnv,
      id: "saved-test",
      ignoreHTTPSErrors: true,
    };
    for (const allowWrites of [false, true]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/environments",
            payload: { ...environment, allowWrites },
          })
        ).statusCode,
      ).toBe(200);
    }
    const profile = { ...demoAuth, id: "saved-auth" };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth-profiles",
          payload: profile,
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
    app = await createApp(new Store(url));
    const environments = (
      await app.inject({ url: "/api/environments" })
    ).json();
    expect(
      environments.filter((e: { id: string }) => e.id === "saved-test"),
    ).toEqual([environment]);
    expect(
      (await app.inject({ url: "/api/auth-profiles" })).json(),
    ).toContainEqual(profile);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("removes a workspace persistently and preserves approved cases and drafts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tracepilot-workspace-"));
  const url = pathToFileURL(join(dir, "platform.db")).href;
  let app = await createApp(new Store(url));
  try {
    const workspace = (
      await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "可删除工作区" },
      })
    ).json();
    const bundle = demoArtifacts("retained-case");
    bundle.testCase.workspaceId = workspace.id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/drafts",
          payload: bundle,
        })
      ).statusCode,
    ).toBe(200);
    bundle.testCase.steps.forEach((s) => (s.review = "CONFIRMED"));
    bundle.plan.steps.forEach((s) =>
      s.assertions.forEach((a) => (a.confirmed = true)),
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/approve",
          payload: { ...bundle, confirmed: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/workspaces/missing" }))
        .statusCode,
    ).toBe(404);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: "/api/workspaces/" + workspace.id,
          })
        ).statusCode,
      ).toBe(204);
    await app.close();
    app = await createApp(new Store(url));
    expect((await app.inject({ url: "/api/workspaces" })).json()).toEqual([]);
    expect(
      (await app.inject({ url: "/api/cases" })).json()[0].workspaceId,
    ).toBe(workspace.id);
    expect(
      (await app.inject({ url: "/api/drafts" })).json()[0].testCase.caseId,
    ).toBe("retained-case");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("creates arbitrary environments and rejects duplicate create requests without changing saved configuration", async () => {
  const store = new Store("file::memory:");
  const app = await createApp(store);
  try {
    const environment = {
      ...demoEnv,
      id: "a-custom-environment",
      baseURL: "https://custom.example.test",
      allowedOrigins: ["https://custom.example.test"],
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/environments",
          payload: { ...environment, createOnly: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/environments",
          payload: {
            ...environment,
            baseURL: "https://different.example.test",
            createOnly: true,
          },
        })
      ).statusCode,
    ).toBe(409);
    expect(await store.get("environment", environment.id)).toEqual(environment);
    expect((await store.list("environment")).length).toBe(2);
  } finally {
    await app.close();
  }
});

it("persists validated hostname rules and rejects invalid patterns without changing the environment", async () => {
  const store = new Store("file::memory:");
  const app = await createApp(store);
  try {
    const environment = {
      ...demoEnv,
      id: "regex-domain",
      baseURL: "https://astr-lab.gts.huawei.com",
      allowedOrigins: [{ hostnameRegex: String.raw`(^|\.)huawei\.com$` }],
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/environments",
      payload: environment,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().allowedOrigins[0].protocol).toBe("https:");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/environments",
          payload: { ...environment, allowedOrigins: [{ hostnameRegex: "[" }] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: "/api/environments" }))
        .json()
        .find((e: { id: string }) => e.id === "regex-domain").allowedOrigins,
    ).toEqual([
      { hostnameRegex: String.raw`(^|\.)huawei\.com$`, protocol: "https:" },
    ]);
  } finally {
    await app.close();
  }
});
