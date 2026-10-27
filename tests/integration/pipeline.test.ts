import { expect, it } from "vitest";
import { Store } from "../../packages/storage/src/index";
import { createApp } from "../../apps/server/src/app";
import { MockAIProvider } from "../../packages/planner/src/index";
import { demoEnv } from "../../apps/server/src/demo";
import { recordingSchema } from "../../packages/contracts/src/index";
import type { Generation } from "../../packages/planner/src/workflow";
const recording = recordingSchema.parse({
  id: "api-pipeline",
  workspaceId: "pipeline-workspace",
  caseName: "查询订单",
  scenario: "查看订单列表",
  target: demoEnv.baseURL,
  state: "STOPPED",
  startedAt: 1,
  operations: [],
  requests: [
    {
      id: "list",
      url: demoEnv.baseURL + "/api/orders",
      method: "GET",
      resourceType: "fetch",
      startedAt: 1,
      status: 200,
      headers: {},
      query: {},
      response: [],
      keep: true,
    },
  ],
});
it("persists both confirmation gates, rejects stale edits, and reuses interface organization when the scene changes", async () => {
  const store = new Store("file::memory:");
  const provider = new MockAIProvider();
  const calls: string[] = [];
  const original = provider.runTask.bind(provider);
  provider.runTask = async (...args) => {
    calls.push(args[0]);
    return original(...args);
  };
  const app = await createApp(store, provider);
  const jobFor = async (id: string) =>
    (await app.inject(`/api/generations/${id}`)).json() as Generation;
  const wait = async (id: string, state: Generation["state"]) => {
    for (let n = 0; n < 150; n++) {
      const job = await jobFor(id);
      if (job.state === state) return job;
      if (job.state === "FAILED") throw new Error(job.error);
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`did not reach ${state}`);
  };
  try {
    const started = await app.inject({
      method: "POST",
      url: "/api/generations",
      payload: { recording, environmentRef: "demo" },
    });
    expect(started.statusCode).toBe(200);
    const id = started.json().id;
    let job = await wait(id, "WAITING_INTERFACE_REVIEW");
    expect(job.pipelineVersion).toBe(2);
    expect(calls).toEqual(["API_ORGANIZATION", "API_SELECTION"]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/generations/${id}/case`,
          payload: {
            revision: job.revision,
            testCase: {},
            authProfileRef: "demo-auth",
            confirmed: true,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/generations/${id}/interfaces`,
          payload: {
            revision: job.revision - 1,
            selectedApiIds: [job.catalog![0].apiId],
            scenario: "订单",
            confirmed: true,
          },
        })
      ).statusCode,
    ).toBe(409);
    await app.inject({ method: "POST", url: `/api/generations/${id}/resume` });
    expect(calls).toHaveLength(2);
    expect((await jobFor(id)).state).toBe("WAITING_INTERFACE_REVIEW");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/generations/${id}/scenario`,
          payload: { revision: job.revision, scenario: "查询全部订单" },
        })
      ).statusCode,
    ).toBe(200);
    job = await wait(id, "WAITING_INTERFACE_REVIEW");
    expect(calls.filter((c) => c === "API_ORGANIZATION")).toHaveLength(1);
    expect(calls.filter((c) => c === "API_SELECTION")).toHaveLength(2);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/generations/${id}/interfaces`,
          payload: {
            revision: job.revision,
            selectedApiIds: [job.catalog![0].apiId],
            scenario: "查询全部订单",
            confirmed: true,
          },
        })
      ).statusCode,
    ).toBe(200);
    job = await wait(id, "WAITING_CASE_REVIEW");
    expect(job.plan).toBeUndefined();
    expect((await store.get<Generation>("generation", id))?.state).toBe(
      "WAITING_CASE_REVIEW",
    );
    await app.inject({ method: "POST", url: `/api/generations/${id}/resume` });
    expect(calls.filter((c) => c === "PLAN_DESIGN")).toHaveLength(0);
    const edited = structuredClone(job.testCase!);
    edited.steps[0].expected = "用户确认列表结果";
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/generations/${id}/case`,
          payload: {
            revision: job.revision,
            testCase: { ...edited, caseId: "other" },
            authProfileRef: "demo-auth",
            confirmed: true,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/generations/${id}/case`,
          payload: {
            revision: job.revision,
            testCase: edited,
            authProfileRef: "missing-profile",
            confirmed: true,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/generations/${id}/case`,
          payload: {
            revision: job.revision,
            testCase: edited,
            authProfileRef: "demo-auth",
            confirmed: true,
          },
        })
      ).statusCode,
    ).toBe(200);
    job = await wait(id, "NEEDS_REVIEW");
    expect(job.testCase!.steps[0].expected).toBe("用户确认列表结果");
    expect(job.testCase!.workspaceId).toBe("pipeline-workspace");
    expect(job.caseConfirmed).toBe(true);
    expect(job.authContract).toEqual({ availableContexts: [], headers: {} });
    expect(job.datasetCandidate?.planId).toBe(job.plan!.planId);
    expect(calls.filter((c) => c === "PLAN_DESIGN")).toHaveLength(1);
    expect(job.validation?.blockingErrors).toEqual([]);
    const confirmedCase = structuredClone(job.testCase);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/generations/${id}/regenerate-plan`,
          payload: { revision: job.revision - 1 },
        })
      ).statusCode,
    ).toBe(409);
    const regenerated = await app.inject({
      method: "POST",
      url: `/api/generations/${id}/regenerate-plan`,
      payload: { revision: job.revision },
    });
    expect(regenerated.statusCode, regenerated.body).toBe(200);
    job = await wait(id, "NEEDS_REVIEW");
    expect(job.testCase).toEqual(confirmedCase);
    expect(calls.filter((c) => c === "PLAN_DESIGN")).toHaveLength(2);
    expect(calls.filter((c) => c === "CASE_DESIGN")).toHaveLength(1);
    expect(calls.filter((c) => c === "API_ORGANIZATION")).toHaveLength(1);
    expect(job.stages.find((s) => s.id === "VALIDATION")?.state).toBe(
      "SUCCEEDED",
    );
    expect(["SUCCEEDED", "SKIPPED"]).toContain(
      job.stages.find((s) => s.id === "FINAL_VALIDATION")?.state,
    );
    expect(job.datasetCandidate?.planId).toBe(job.plan!.planId);
    const response = await app.inject({
      method: "POST",
      url: "/api/approve",
      payload: {
        testCase: job.testCase,
        plan: {
          ...job.plan!,
          steps: job.plan!.steps.map((s) => ({
            ...s,
            assertions: s.assertions.map((a) => ({ ...a, confirmed: true })),
          })),
        },
        assets: job.catalog!.map((item) => ({
          ...item.asset,
          validated: true,
        })),
        confirmed: true,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/datasets",
          payload: job.datasetCandidate,
        })
      ).statusCode,
    ).toBe(200);
    const forked = await app.inject({
      method: "POST",
      url: `/api/generations/${id}/fork-scenario`,
      payload: { revision: job.revision, scenario: "再次查询订单" },
    });
    expect(forked.statusCode, forked.body).toBe(200);
    const next = await wait(forked.json().id, "WAITING_INTERFACE_REVIEW");
    expect(next.catalogSourceGenerationId).toBe(id);
    expect(next.input.caseId).not.toBe(job.input.caseId);
    expect(calls.filter((c) => c === "API_ORGANIZATION")).toHaveLength(1);
    expect((await jobFor(id)).state).toBe("NEEDS_REVIEW");
  } finally {
    await app.close();
  }
});
