import { expect, it } from "vitest";
import { Store } from "../../packages/storage/src/index";
import { createApp } from "../../apps/server/src/app";
import { MockAIProvider } from "../../packages/planner/src/index";
import {
  createGeneration,
  executeGeneration,
} from "../../packages/planner/src/workflow";
import { recordingSchema } from "../../packages/contracts/src/index";
import { demoEnv } from "../../apps/server/src/demo";
function recording(id: string, workspaceId?: string) {
  return recordingSchema.parse({
    id,
    workspaceId,
    environmentRef: "demo",
    caseName: id,
    scenario: "query orders",
    target: demoEnv.baseURL,
    startedAt: 1,
    state: "STOPPED",
    operations: [],
    requests: [
      {
        id: `request-${id}`,
        method: "GET",
        url: `${demoEnv.baseURL}/api/orders`,
        resourceType: "fetch",
        startedAt: 1,
        headers: {},
        query: {},
        status: 200,
        keep: true,
        category: "BUSINESS",
      },
    ],
  });
}
it("scopes generation history to the exact workspace and recording, including legacy unassigned records", async () => {
  const store = new Store("file::memory:");
  const provider = new MockAIProvider();
  const app = await createApp(store, provider);
  try {
    const rows = [
      recording("a-1", "a"),
      recording("a-2", "a"),
      recording("b-1", "b"),
      recording("legacy"),
    ];
    for (const r of rows) {
      const job = createGeneration(
        { recording: r, assets: [], environment: demoEnv },
        provider,
      );
      await store.put("generation", job.id, job.revision, job);
      if (r.id === "a-1") {
        job.revision++;
        await store.put("generation", job.id, job.revision, job);
      }
    }
    const get = async (query: string) =>
      (await app.inject(`/api/generations${query}`)).json();
    expect(
      (await get("?workspaceId=a"))
        .map((j: any) => j.input.recording.id)
        .sort(),
    ).toEqual(["a-1", "a-2"]);
    expect(
      (await get("?workspaceId=b")).map((j: any) => j.input.recording.id),
    ).toEqual(["b-1"]);
    expect(await get("?workspaceId=a&recordingId=b-1")).toEqual([]);
    expect(await get("?workspaceId=a&recordingId=a-1")).toHaveLength(1);
    expect(await get("?recordingId=legacy")).toHaveLength(1);
    expect(await get("")).toHaveLength(4);
  } finally {
    await app.close();
  }
});
it("persists analysis without changing recording evidence and restores it with its environment", async () => {
  const store = new Store("file::memory:");
  const app = await createApp(store, new MockAIProvider());
  try {
    const r = recording("saved-analysis", "a");
    await store.put("recording", r.id, 1, r);
    expect(
      (await app.inject(`/api/recordings/${r.id}/analysis`)).json(),
    ).toBeNull();
    const analyze = await app.inject({
      method: "POST",
      url: `/api/recordings/${r.id}/analyze`,
      payload: { overrides: { [r.requests[0].id]: false } },
    });
    expect(analyze.statusCode).toBe(200);
    const saved = (await app.inject(`/api/recordings/${r.id}/analysis`)).json();
    expect(saved.recording.requests[0].keep).toBe(false);
    expect(saved.recording.environmentRef).toBe("demo");
    expect(saved.recording.workspaceId).toBe("a");
    expect(await store.get("recording", r.id)).toEqual(r);
    expect((await app.inject("/api/analyses")).json()).toHaveLength(1);
    await app.inject({
      method: "POST",
      url: `/api/recordings/${r.id}/analyze`,
      payload: { overrides: { [r.requests[0].id]: true } },
    });
    expect((await app.inject("/api/analyses")).json()).toHaveLength(1);
    expect(
      (await app.inject(`/api/recordings/${r.id}/analysis`)).json().recording
        .requests[0].keep,
    ).toBe(true);
  } finally {
    await app.close();
  }
});
it("uses the recording workspace for generated cases even when the model supplies a different workspace", async () => {
  const provider = new MockAIProvider();
  const original = provider.runStage.bind(provider);
  provider.runStage = async (...args) => {
    const output = (await original(...args)) as any;
    if (args[0] === "SEMANTIC_CASE") output.workspaceId = "unrelated-workspace";
    if (args[0] === "REPAIR")
      output.testCase.workspaceId = "unrelated-workspace";
    return output;
  };
  const job = createGeneration(
    { recording: recording("scoped", "a"), assets: [], environment: demoEnv },
    provider,
  );
  await executeGeneration(job, provider);
  expect(job.state).toBe("NEEDS_REVIEW");
  expect(job.testCase?.workspaceId).toBe("a");
});
