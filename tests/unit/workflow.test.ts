import { expect, it } from "vitest";
import { schedule } from "../../packages/runner/src/scheduler";
import { demoArtifacts, demoEnv } from "../../apps/server/src/demo";
import { setAtPath, resolve, validate } from "../../packages/core/src/index";
import {
  createGeneration,
  executeGeneration,
} from "../../packages/planner/src/workflow";
import { MockAIProvider } from "../../packages/planner/src/index";
import { recordingSchema } from "../../packages/contracts/src/index";
const recording = recordingSchema.parse({
  id: "record",
  caseName: "workflow",
  scenario: "query orders",
  target: demoEnv.baseURL,
  state: "STOPPED",
  workspaceId: "workspace",
  startedAt: 1,
  operations: [],
  dependencies: [],
  requests: [
    {
      id: "request",
      method: "GET",
      url: "http://127.0.0.1:3100/api/orders",
      resourceType: "fetch",
      startedAt: 1,
      headers: {},
      query: {},
      category: "BUSINESS",
      keep: true,
    },
  ],
});
it("overlaps independent safe reads, then joins after both complete", async () => {
  const b = demoArtifacts();
  const asset = {
    ...b.assets[0],
    method: "GET" as const,
    risk: "READ" as const,
    operationType: "READ" as const,
  };
  const make = (id: string, dependsOn: string[] = []) => ({
    ...b.plan.steps[0],
    id,
    apiId: asset.apiId,
    phase: "API" as const,
    dependsOn,
    parallelSafe: true,
  });
  const active = new Set<string>();
  const events: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((r) => (release = r));
  await schedule(
    [make("a"), make("b"), make("join", ["a", "b"])],
    [asset],
    2,
    async (s) => {
      active.add(s.id);
      events.push(s.id);
      if (s.id === "b") {
        expect(active.has("a")).toBe(true);
        release();
      }
      if (s.id === "a") await barrier;
      if (s.id === "join") expect(active.size).toBe(1);
      active.delete(s.id);
    },
  );
  expect(events).toEqual(["a", "b", "join"]);
});
it("serializes unmarked steps and conflicting locks", async () => {
  const b = demoArtifacts();
  const asset = {
    ...b.assets[0],
    method: "GET" as const,
    risk: "READ" as const,
    operationType: "READ" as const,
  };
  for (const marked of [false, true]) {
    let active = 0;
    let peak = 0;
    await schedule(
      ["a", "b"].map((id) => ({
        ...b.plan.steps[0],
        id,
        apiId: asset.apiId,
        phase: "API" as const,
        dependsOn: [],
        parallelSafe: marked,
        resourceLocks: ["same"],
      })),
      [asset],
      4,
      async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      },
    );
    expect(peak).toBe(1);
  }
});
it("binds nested typed values without mutating templates and rejects prototype writes", () => {
  const template = { items: [{ id: 0 }] };
  expect(setAtPath(template, "$.items[0].id", 42)).toEqual({
    items: [{ id: 42 }],
  });
  expect(template.items[0].id).toBe(0);
  expect(setAtPath(undefined, "$[0].id", 42)).toEqual([{ id: 42 }]);
  expect(() => setAtPath({}, "$.__proto__.bad", 1)).toThrow();
  expect(() =>
    resolve(
      { source: "RESPONSE_VARIABLE", name: "id", expectedType: "number" },
      { id: "42" },
    ),
  ).toThrow();
  const b = demoArtifacts();
  b.plan.steps[0].parallelSafe = true;
  expect(
    validate(b.testCase, b.plan, b.assets, demoEnv).some((e) =>
      /parallel/i.test(e),
    ),
  ).toBe(true);
});
it("persists stage checkpoints and resumes without repeating successful model stages", async () => {
  const provider = new MockAIProvider();
  const original = provider.runStage.bind(provider);
  const calls: string[] = [];
  let failing = true;
  provider.runStage = async (...args) => {
    calls.push(args[0]);
    if (args[0] === "SEMANTIC_CASE" && failing)
      throw new Error("temporary model failure");
    return original(...args);
  };
  const job = createGeneration(
    { recording, assets: [], environment: demoEnv },
    provider,
  );
  const checkpoints: number[] = [];
  await executeGeneration(job, provider, async (j) => {
    checkpoints.push(j.revision);
  });
  expect(job.state).toBe("FAILED");
  expect(calls.filter((s) => s === "BUSINESS_FLOW")).toHaveLength(1);
  failing = false;
  const restored = structuredClone(job);
  await executeGeneration(restored, provider);
  expect(restored.state).toBe("NEEDS_REVIEW");
  expect(calls.filter((s) => s === "BUSINESS_FLOW")).toHaveLength(1);
  expect(restored.testCase?.caseId).toBe(job.input.caseId);
  expect(new Set(checkpoints).size).toBe(checkpoints.length);
});
