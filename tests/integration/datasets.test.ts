import { expect, it } from "vitest";
import { Store } from "../../packages/storage/src/index";
import { createApp } from "../../apps/server/src/app";
import { demoArtifacts, demoEnv, demoAuth } from "../../apps/server/src/demo";
import { MockAIProvider } from "../../packages/planner/src/index";
import { demoApp } from "../../apps/demo-app/src/app";
import { runDataset } from "../../packages/runner/src/index";
import type { Dataset } from "../../packages/contracts/src/index";
function fixture() {
  const b = demoArtifacts();
  b.testCase.status = b.plan.status = "APPROVED";
  b.testCase.steps.forEach((s) => (s.review = "CONFIRMED"));
  b.plan.steps.forEach((s) =>
    s.assertions.forEach((a) => (a.confirmed = true)),
  );
  b.plan.parameters = { order: "object", name: "string" };
  b.plan.steps[0].body = { source: "TEST_DATA", name: "order" };
  b.plan.steps[1].assertions.push({
    kind: "json",
    path: "$.name",
    operator: "eq",
    dataRef: "name",
    basis: "USER",
    confirmed: true,
  });
  const dataset: Dataset = {
    id: "orders",
    name: "orders",
    planId: b.plan.planId,
    planVersion: 1,
    version: 1,
    rows: [
      {
        id: "a",
        name: "first fails",
        values: { order: { name: "A" }, name: "wrong" },
      },
      {
        id: "b",
        name: "second passes",
        values: { order: { name: "B" }, name: "B" },
      },
    ],
  };
  return { ...b, dataset };
}
it("stores datasets independently, preserves versions and checks all rows before execution", async () => {
  const b = fixture();
  const app = await createApp(new Store("file::memory:"), new MockAIProvider());
  try {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/approve",
          payload: { ...b, confirmed: true },
        })
      ).statusCode,
    ).toBe(200);
    const save = (dataset: Dataset) =>
      app.inject({ method: "POST", url: "/api/datasets", payload: dataset });
    expect((await save(b.dataset)).statusCode).toBe(200);
    expect((await save(b.dataset)).statusCode).toBe(400);
    expect((await save({ ...b.dataset, version: 2 })).statusCode).toBe(200);
    expect(
      (await save({ ...b.dataset, version: 3, planVersion: 2 })).statusCode,
    ).toBe(400);
    expect(
      (
        await save({
          ...b.dataset,
          version: 3,
          rows: [{ id: "bad", name: "bad", values: {} }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/datasets" })).json(),
    ).toHaveLength(2);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/run",
          payload: { planId: b.plan.planId, version: 1 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/reports" })).json(),
    ).toHaveLength(0);
  } finally {
    await app.close();
  }
});
it("runs all rows with isolated resources, persists each report, and continues after a failed assertion", async () => {
  const b = fixture();
  b.plan.dataPolicy = "REVIEW_REQUIRED";
  b.dataset.review = {
    confirmed: true,
    sources: { order: "MODEL_SUGGESTED", name: "USER" },
  };
  const demo = demoApp();
  await demo.listen({ host: "127.0.0.1", port: 3100 });
  const old = process.env.DEMO_PASSWORD;
  process.env.DEMO_PASSWORD = "demo-only";
  try {
    const saved: string[] = [];
    const reports = await runDataset(
      b.testCase,
      b.plan,
      b.assets,
      demoEnv,
      demoAuth,
      b.dataset,
      async (r) => {
        saved.push(r.id);
      },
    );
    expect(reports.map((r) => r.status)).toEqual(["FAILED", "PASSED"]);
    expect(reports.map((r) => r.dataset?.rowId)).toEqual(["a", "b"]);
    expect(saved).toEqual(reports.map((r) => r.id));
    expect(reports[0].batchId).toBe(reports[1].batchId);
    expect(reports[0].resources[0].id).not.toBe(reports[1].resources[0].id);
    for (const report of reports) {
      expect(report.residualResources).toEqual([]);
      expect(
        report.resources.every((r) => r.owner === report.id && r.cleaned),
      ).toBe(true);
    }
  } finally {
    if (old === undefined) delete process.env.DEMO_PASSWORD;
    else process.env.DEMO_PASSWORD = old;
    await demo.close();
  }
});

it("blocks unreviewed generated data through both dataset and single-run APIs", async () => {
  const b = fixture();
  b.plan.dataPolicy = "REVIEW_REQUIRED";
  const app = await createApp(new Store("file::memory:"), new MockAIProvider());
  try {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/approve",
          payload: { ...b, confirmed: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/datasets",
          payload: b.dataset,
        })
      ).statusCode,
    ).toBe(200);
    const datasetRun = await app.inject({
      method: "POST",
      url: "/api/run",
      payload: {
        planId: b.plan.planId,
        version: 1,
        dataset: { id: b.dataset.id, version: 1 },
      },
    });
    expect(datasetRun.statusCode).toBe(400);
    expect(datasetRun.body).toContain("尚未审核确认");
    const singleRun = await app.inject({
      method: "POST",
      url: "/api/run",
      payload: { planId: b.plan.planId, version: 1 },
    });
    expect(singleRun.statusCode).toBe(400);
    expect(singleRun.body).toContain("尚未审核确认");
    expect((await app.inject("/api/reports")).json()).toHaveLength(0);
  } finally {
    await app.close();
  }
});

it("generates dataset IDs on the server and preserves dataset validation when no ID is provided", async () => {
  const b = fixture();
  const store = new Store("file::memory:");
  const app = await createApp(store, new MockAIProvider());
  try {
    const approved = await app.inject({
      method: "POST",
      url: "/api/approve",
      payload: { ...b, confirmed: true },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const { id: _id, ...draft } = b.dataset;
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({
        method: "POST",
        url: "/api/datasets",
        payload: draft,
      });
      expect(response.statusCode, response.body).toBe(200);
      const saved = response.json();
      expect(saved.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(saved.rows).toEqual(draft.rows);
      expect(await store.get("dataset", saved.id, 1)).toEqual(saved);
      ids.push(saved.id);
    }
    expect(new Set(ids).size).toBe(2);
    const duplicateRows = await app.inject({
      method: "POST",
      url: "/api/datasets",
      payload: { ...draft, rows: [draft.rows[0], draft.rows[0]] },
    });
    expect(duplicateRows.statusCode).toBe(400);
    expect(duplicateRows.body).toContain("Duplicate dataset row ID");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/datasets",
          payload: { ...draft, id: "" },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject("/api/datasets")).json()).toHaveLength(2);
  } finally {
    await app.close();
  }
});
