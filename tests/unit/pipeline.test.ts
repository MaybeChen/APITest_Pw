import { expect, it } from "vitest";
import {
  recordingSchema,
  planSchema,
} from "../../packages/contracts/src/index";
import {
  MockAIProvider,
  ModelAIProvider,
} from "../../packages/planner/src/index";
import {
  createPipeline,
  executePipeline,
  confirmInterfaces,
  confirmCase,
  regeneratePlan,
} from "../../packages/planner/src/pipeline";
import { demoEnv, demoArtifacts } from "../../apps/server/src/demo";
import {
  dataCandidates,
  validatePlanData,
  defaultLimits,
} from "../../packages/planner/src/evidence";
import { validate } from "../../packages/core/src/index";
const recording = recordingSchema.parse({
  id: "pipeline-record",
  workspaceId: "workspace-a",
  caseName: "主题创建",
  scenario: "创建主题",
  target: demoEnv.baseURL,
  state: "STOPPED",
  startedAt: 1,
  operations: [
    {
      id: "click-create",
      type: "click",
      at: 1,
      url: demoEnv.baseURL,
      context: { text: "创建主题" },
    },
    {
      id: "unrelated-click",
      type: "click",
      at: 1,
      url: demoEnv.baseURL,
      context: { text: "UNRELATED_DOM" },
    },
  ],
  contextSnapshots: [
    {
      id: "candidate",
      operationId: "click-create",
      phase: "BEFORE",
      at: 1,
      url: demoEnv.baseURL,
      title: "创建主题",
      headings: [],
      region: { tag: "FORM" },
      elements: [],
    },
    {
      id: "unrelated",
      operationId: "unrelated-click",
      phase: "AFTER",
      at: 1,
      url: demoEnv.baseURL,
      title: "UNRELATED_DOM",
      headings: [],
      region: { tag: "BODY" },
      elements: [],
    },
  ],
  requests: [
    {
      id: "create-request",
      method: "POST",
      url: demoEnv.baseURL + "/api/topics",
      resourceType: "fetch",
      startedAt: 1,
      headers: {
        "x-tenant": "tenant-a",
        authorization: "[REDACTED]",
        "content-type": "application/json",
      },
      body: { name: "recorded-topic" },
      response: { id: "recorded-id", name: "recorded-topic" },
      status: 201,
      contextSnapshotRefs: ["candidate"],
      keep: true,
    },
    {
      id: "list-request",
      method: "GET",
      url: demoEnv.baseURL + "/api/list",
      resourceType: "fetch",
      startedAt: 2,
      headers: {},
      response: [],
      status: 200,
      keep: true,
    },
  ],
});
function provider() {
  const model = new MockAIProvider() as MockAIProvider & {
    planningLimits: typeof defaultLimits;
  };
  model.planningLimits = { ...defaultLimits, maxInterfacesPerBatch: 1 };
  const original = model.runTask.bind(model),
    calls: { task: string; input: any }[] = [];
  model.runTask = async (...args) => {
    calls.push({ task: args[0], input: structuredClone(args[1]) });
    return original(...args);
  };
  return { model, calls };
}
it("batches interface facts, includes only candidate context, and enforces both human checkpoints", async () => {
  const { model, calls } = provider();
  const repeated = structuredClone(recording);
  for (let i = 0; i < 50; i++)
    repeated.requests.push({
      ...structuredClone(recording.requests[0]),
      id: `duplicate-${i}`,
    });
  const job = createPipeline(
    { recording: repeated, assets: [], environment: demoEnv },
    model,
  );
  await executePipeline(job, model);
  expect(job.state).toBe("WAITING_INTERFACE_REVIEW");
  expect(
    job.organizationBatches!.every(
      (batch) => batch.inputEstimate <= job.modelLimits!.inputBudget,
    ),
  ).toBe(true);
  expect(calls.map((c) => c.task)).toEqual([
    "API_ORGANIZATION",
    "API_ORGANIZATION",
    "API_SELECTION",
  ]);
  const org = calls.find((c) => c.task === "API_ORGANIZATION")!;
  expect(JSON.stringify(org.input)).toContain("创建主题");
  expect(JSON.stringify(org.input)).not.toContain("UNRELATED_DOM");
  expect(org.input.interfaces[0].customHeaders["x-tenant"].sample).toBe(
    "tenant-a",
  );
  expect(
    org.input.interfaces[0].customHeaders.authorization.sample,
  ).toBeUndefined();
  expect(org.input.interfaces[0].customHeaders["content-type"]).toBeUndefined();
  const selection = calls.find((c) => c.task === "API_SELECTION")!;
  expect(Object.keys(selection.input).sort()).toEqual([
    "interfaces",
    "scenario",
  ]);
  expect(JSON.stringify(selection.input)).not.toContain("recorded-id");
  expect(JSON.stringify(selection.input)).not.toContain("requestSchema");
  await executePipeline(job, model);
  expect(calls).toHaveLength(3);
  expect(() => confirmCase(job, {})).toThrow("请先确认接口");
  confirmInterfaces(job, [job.catalog![0].apiId], "只创建主题");
  await executePipeline(job, model);
  expect(job.state).toBe("WAITING_CASE_REVIEW");
  expect(job.plan).toBeUndefined();
  expect(calls.at(-1)?.task).toBe("CASE_DESIGN");
  expect(calls.at(-1)?.input.interfaces).toHaveLength(1);
  expect(JSON.stringify(calls.at(-1)?.input)).not.toContain("recorded-id");
  job.testCase!.steps[0].expected = "用户确认的业务预期";
  confirmCase(job, job.testCase);
  await executePipeline(job, model);
  expect(job.state, job.error).toBe("NEEDS_REVIEW");
  const planCall = calls.find((c) => c.task === "PLAN_DESIGN")!;
  expect(planCall.input.testCase.steps[0].expected).toBe("用户确认的业务预期");
  expect(planCall.input.interfaces).toHaveLength(1);
  expect(planCall.input.interfaces[0].asset.sources.length).toBeLessThanOrEqual(
    3,
  );
  expect(job.catalog![0].asset.sources).toHaveLength(51);
  expect(planCall.input.recording).toBeUndefined();
  expect(job.testCase!.steps[0].review).toBe("CONFIRMED");
  expect(job.plan?.authProfileRef).toBe("demo-auth");
  expect(job.datasetCandidate?.rows[0].values).toEqual({
    data_1: { name: "recorded-topic" },
    data_3: "tenant-a",
  });
  expect(job.plan?.steps[0].body).toEqual({
    source: "TEST_DATA",
    name: "data_1",
  });
});
it("resumes a failed batch without redoing completed interface batches", async () => {
  const { model, calls } = provider();
  const original = model.runTask.bind(model);
  let failing = true;
  model.runTask = async (...args) => {
    if (
      args[0] === "API_ORGANIZATION" &&
      (args[1] as any).interfaces[0].apiId === "GET:/api/list" &&
      failing
    )
      throw new Error("temporary model failure");
    return original(...args);
  };
  const job = createPipeline(
    { recording, assets: [], environment: demoEnv },
    model,
  );
  await executePipeline(job, model);
  expect(job.state).toBe("FAILED");
  expect(job.organizationBatches![0].state).toBe("SUCCEEDED");
  failing = false;
  await executePipeline(job, model);
  expect(job.state).toBe("WAITING_INTERFACE_REVIEW");
  expect(
    calls.filter(
      (c) =>
        c.task === "API_ORGANIZATION" &&
        c.input.interfaces[0].apiId === "POST:/api/topics",
    ),
  ).toHaveLength(1);
});
it("rejects invented interface IDs, duplicate selections, and accidental dependency removal", async () => {
  const { model } = provider();
  const job = createPipeline(
    { recording, assets: [], environment: demoEnv },
    model,
  );
  await executePipeline(job, model);
  expect(() => confirmInterfaces(job, ["invented"], "scene")).toThrow(
    "本次录制目录",
  );
  expect(() =>
    confirmInterfaces(
      job,
      [job.catalog![0].apiId, job.catalog![0].apiId],
      "scene",
    ),
  ).toThrow("唯一");
  job.input.recording.dependencies = [
    {
      from: "create-request",
      to: "list-request",
      path: "$.id",
      source: "EXACT_VALUE_MATCH",
      reason: "candidate",
      confidence: 0.6,
      confirmed: false,
    },
  ];
  expect(() => confirmInterfaces(job, ["GET:/api/list"], "scene")).toThrow(
    "候选依赖",
  );
  expect(() =>
    confirmInterfaces(job, ["GET:/api/list"], "scene", true),
  ).not.toThrow();
});
it("fails before sending an oversized planning input and never silently truncates a confirmed case", async () => {
  const { model, calls } = provider();
  const job = createPipeline(
    { recording, assets: [], environment: demoEnv },
    model,
  );
  await executePipeline(job, model);
  confirmInterfaces(job, [job.catalog![0].apiId], "scene");
  await executePipeline(job, model);
  job.testCase!.steps[0].expected = "x".repeat(70000);
  confirmCase(job, job.testCase);
  const count = calls.length;
  await executePipeline(job, model);
  expect(job.state).toBe("FAILED");
  expect(job.error).toContain("超过预算");
  expect(calls).toHaveLength(count);
});
it("extracts exact independent data values and refuses unknown data sources", () => {
  const { model } = provider();
  const job = createPipeline(
    { recording, assets: [], environment: demoEnv },
    model,
  );
  const candidates = dataCandidates(job.input.recording, job.catalog!);
  const b = demoArtifacts();
  const plan = planSchema.parse(b.plan);
  plan.parameters = { data_1: "object" };
  plan.steps[0].body = { source: "TEST_DATA", name: "data_1" };
  expect(validatePlanData(plan, candidates)).toEqual({
    data_1: { name: "recorded-topic" },
  });
  plan.parameters = { fake: "string" };
  expect(() => validatePlanData(plan, candidates)).toThrow("没有匹配");
});
it("allows explicitly confirmed UI/manual preconditions without forcing fake API execution nodes", () => {
  const b = demoArtifacts();
  b.testCase.steps.unshift({
    id: "ui-prepare",
    title: "打开页面",
    executionKind: "UI_PRECONDITION",
    expected: "页面已准备",
    dependsOn: [],
    review: "CONFIRMED",
  });
  b.testCase.steps[1].dependsOn = ["ui-prepare"];
  expect(validate(b.testCase, b.plan, b.assets, demoEnv)).not.toContain(
    "Semantic dependency not enforced: setup -> ui-prepare",
  );
});
it("uses the configured output limit and rejects length-truncated JSON responses", async () => {
  let sent: any;
  const model = new ModelAIProvider({
    endpoint: "https://model.invalid",
    model: "fixture",
    planningLimits: defaultLimits,
    requester: async (_url, options) => {
      sent = JSON.parse(options.body as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ finish_reason: "length", message: { content: "{}" } }],
        }),
      } as any;
    },
  });
  await expect(
    model.runTask(
      "API_SELECTION",
      { interfaces: [], scenario: "scene" },
      { generationId: "test", attempt: 1 },
    ),
  ).rejects.toThrow("截断");
  expect(sent.max_tokens).toBe(8192);
});

it("rejects model-invented evidence IDs before progressing to scenario selection", async () => {
  const { model, calls } = provider();
  const original = model.runTask.bind(model);
  model.runTask = async (...args) =>
    args[0] === "API_ORGANIZATION"
      ? {
          interfaces: [
            {
              apiId: "invented",
              name: "invented",
              description: "invented",
              uncertainties: [],
            },
          ],
        }
      : original(...args);
  const job = createPipeline(
    { recording, assets: [], environment: demoEnv },
    model,
  );
  await executePipeline(job, model);
  expect(job.state).toBe("FAILED");
  expect(job.error).toContain("接口整理引用错误");
  expect(calls.filter((c) => c.task === "API_SELECTION")).toHaveLength(0);
});
it("keeps an invalid draft available for manual review if optional local repair fails", async () => {
  const { model, calls } = provider();
  const original = model.runTask.bind(model);
  model.runTask = async (...args) => {
    if (args[0] === "PLAN_REPAIR")
      throw new Error("repair service temporarily unavailable");
    const output = (await original(...args)) as any;
    if (args[0] === "PLAN_DESIGN")
      output.steps[0].semanticStepRef = "unknown-semantic-step";
    return output;
  };
  const job = createPipeline(
    { recording, assets: [], environment: demoEnv },
    model,
  );
  await executePipeline(job, model);
  confirmInterfaces(job, [job.catalog![0].apiId], "scene");
  await executePipeline(job, model);
  confirmCase(job, job.testCase);
  await executePipeline(job, model);
  expect(job.state).toBe("NEEDS_REVIEW");
  expect(
    job.validation!.blockingErrors.some((e) =>
      e.includes("Invalid semanticStepRef"),
    ),
  ).toBe(true);
  expect(job.stages.find((s) => s.id === "PLAN_REPAIR")!.state).toBe("FAILED");
  expect(job.testCase!.steps[0].review).toBe("CONFIRMED");
  expect(calls.filter((c) => c.task === "PLAN_DESIGN")).toHaveLength(1);
});

it("retains different observed response shapes for the same normalized endpoint", () => {
  const r = structuredClone(recording);
  r.requests.push({
    ...structuredClone(r.requests[0]),
    id: "create-other-shape",
    response: [{ id: "other" }],
  });
  const { model } = provider();
  const job = createPipeline(
    { recording: r, assets: [], environment: demoEnv },
    model,
  );
  const item = job.catalog!.find(
    (entry) => entry.apiId === "POST:/api/topics",
  )!;
  expect(item.samples).toHaveLength(2);
  expect(item.samples.map((sample) => Array.isArray(sample.response))).toEqual([
    false,
    true,
  ]);
});

it("passes configured authentication context names and bindings without credential values", async () => {
  let payload: any;
  const model = new ModelAIProvider({
    endpoint: "https://model.invalid",
    model: "fixture",
    planningLimits: defaultLimits,
    requester: async (_url, options) => {
      payload = JSON.parse(options.body as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(demoArtifacts().plan) },
            },
          ],
        }),
      } as any;
    },
  });
  const contract = {
    availableContexts: ["custom-access-context"],
    headers: {
      authorization: { source: "AUTH_CONTEXT", name: "custom-access-context" },
    },
  };
  await model.runTask(
    "PLAN_DESIGN",
    { authContract: contract },
    { generationId: "auth-contract", attempt: 1 },
  );
  expect(JSON.parse(payload.messages[1].content).authContract).toEqual(
    contract,
  );
});

it("normalizes absent model assertion data references without weakening plan validation", async () => {
  const { normalizeTaskOutput, taskSchemas } =
    await import("../../packages/planner/src/pipeline-contracts");
  const raw = structuredClone(demoArtifacts().plan);
  const assertion = raw.steps[0].assertions[0];
  assertion.dataRef = "   ";
  const normalized = taskSchemas.PLAN_DESIGN.parse(
    normalizeTaskOutput("PLAN_DESIGN", raw),
  );
  expect(normalized.steps[0].assertions[0]).not.toHaveProperty("dataRef");
  expect(assertion.dataRef).toBe("   ");
  assertion.dataRef = "expected_status";
  expect(
    taskSchemas.PLAN_DESIGN.parse(normalizeTaskOutput("PLAN_DESIGN", raw))
      .steps[0].assertions[0].dataRef,
  ).toBe("expected_status");
  assertion.dataRef = "";
  expect(() => planSchema.parse(raw)).toThrow();
  const repair = taskSchemas.PLAN_REPAIR.parse(
    normalizeTaskOutput("PLAN_REPAIR", {
      replacements: [raw.steps[0]],
      reason: "修复",
    }),
  );
  expect(repair.replacements[0].assertions[0]).not.toHaveProperty("dataRef");
  (assertion as any).dataRef = 123;
  expect(() =>
    taskSchemas.PLAN_DESIGN.parse(normalizeTaskOutput("PLAN_DESIGN", raw)),
  ).toThrow();
});

it("normalizes null model bodies in plan and repair while preserving explicit body bindings", async () => {
  const { normalizeTaskOutput, taskSchemas } =
    await import("../../packages/planner/src/pipeline-contracts");
  const raw = structuredClone(demoArtifacts().plan);
  (raw.steps[0] as any).body = null;
  expect(() => planSchema.parse(raw)).toThrow();
  const normalized = taskSchemas.PLAN_DESIGN.parse(
    normalizeTaskOutput("PLAN_DESIGN", raw),
  );
  expect(normalized.steps[0]).not.toHaveProperty("body");
  expect(raw.steps[0].body).toBeNull();
  const repair = taskSchemas.PLAN_REPAIR.parse(
    normalizeTaskOutput("PLAN_REPAIR", {
      replacements: [raw.steps[0]],
      reason: "修复",
    }),
  );
  expect(repair.replacements[0]).not.toHaveProperty("body");
  for (const binding of [
    { source: "STATIC", value: null },
    { source: "TEST_DATA", name: "request_body" },
  ]) {
    (raw.steps[0] as any).body = binding;
    expect(
      taskSchemas.PLAN_DESIGN.parse(normalizeTaskOutput("PLAN_DESIGN", raw))
        .steps[0].body,
    ).toEqual(binding);
  }
  (raw.steps[0] as any).body = "invalid";
  expect(() =>
    taskSchemas.PLAN_DESIGN.parse(normalizeTaskOutput("PLAN_DESIGN", raw)),
  ).toThrow();
});

it("clears only plan stages and derived artifacts when regenerating a confirmed case", async () => {
  const { model } = provider();
  const job = createPipeline(
    { recording, assets: [], environment: demoEnv },
    model,
  );
  expect(() => regeneratePlan(job)).toThrow("请先确认");
  await executePipeline(job, model);
  confirmInterfaces(job, [job.catalog![0].apiId], "scene");
  await executePipeline(job, model);
  confirmCase(job, job.testCase);
  await executePipeline(job, model);
  const upstream = structuredClone(job.stages.slice(0, 3));
  const testCase = structuredClone(job.testCase);
  regeneratePlan(job);
  expect(job.testCase).toEqual(testCase);
  expect(job.stages.slice(0, 3)).toEqual(upstream);
  expect(
    job.stages
      .slice(3)
      .every(
        (s) => s.state === "PENDING" && s.output === undefined && !s.error,
      ),
  ).toBe(true);
  expect(job.plan).toBeUndefined();
  expect(job.validation).toBeUndefined();
  expect(job.datasetCandidate).toBeUndefined();
  expect(job.caseConfirmed).toBe(true);
});

it("keeps captured custom header values instead of guessing UUIDs, timestamps or auth names", async () => {
  const { analyze } = await import("../../packages/recorder/src/index");
  const { interfaceFacts, applyRecordedHeaders } =
    await import("../../packages/planner/src/evidence");
  const { redact } = await import("../../packages/core/src/index");
  const captured = structuredClone(recording);
  captured.requests[0].headers = {
    "x-adc-page-timestamp": "1793059200000",
    "x-request-id": "original-request-id",
    "x-nonce": "original-nonce",
    "x-adc-page-token": "[REDACTED]",
  };
  expect(redact(captured.requests[0].headers)["x-adc-page-timestamp"]).toBe(
    "1793059200000",
  );
  const asset = analyze(captured).assets[0];
  expect(asset.headers["x-adc-page-timestamp"]).toEqual({
    source: "STATIC",
    value: "1793059200000",
  });
  expect(asset.headers["x-adc-page-token"]).toEqual({
    source: "MANUAL_REVIEW",
  });
  // Existing interface snapshots may still contain the old guessed binding.
  asset.headers["x-adc-page-timestamp"] = {
    source: "RUNTIME_GENERATED",
    kind: "uuid",
  };
  const catalog = [interfaceFacts(captured, asset)];
  const candidates = dataCandidates(captured, catalog);
  const plan = structuredClone(demoArtifacts().plan);
  plan.steps = [plan.steps[0]];
  plan.steps[0].apiId = asset.apiId;
  plan.steps[0].headers = {
    "x-adc-page-timestamp": { source: "RUNTIME_GENERATED", kind: "uuid" },
    "x-nonce": { source: "RUNTIME_GENERATED", kind: "timestamp" },
    "x-invented": { source: "STATIC", value: "invented" },
    "x-adc-page-token": { source: "AUTH_CONTEXT", name: "guessed" },
  };
  const normalized = applyRecordedHeaders(plan, catalog, candidates);
  for (const name of ["x-adc-page-timestamp", "x-request-id", "x-nonce"]) {
    const binding = normalized.steps[0].headers[name];
    expect(binding.source).toBe("TEST_DATA");
    if (binding.source === "TEST_DATA")
      expect(candidates.find((c) => c.name === binding.name)?.value).toBe(
        captured.requests[0].headers[name],
      );
  }
  expect(normalized.steps[0].headers["x-invented"]).toBeUndefined();
  expect(normalized.steps[0].headers["x-adc-page-token"]).toEqual({
    source: "MANUAL_REVIEW",
  });
  const dynamic = {
    source: "RESPONSE_VARIABLE",
    name: "nonce",
    fromStep: "previous",
  } as const;
  plan.steps[0].headers["x-nonce"] = dynamic;
  expect(
    applyRecordedHeaders(plan, catalog, candidates).steps[0].headers["x-nonce"],
  ).toEqual(dynamic);
  const configured = applyRecordedHeaders(plan, catalog, candidates, {
    "x-adc-page-token": { source: "AUTH_CONTEXT", name: "configured" },
  });
  expect(configured.steps[0].headers["x-adc-page-token"]).toBeUndefined();
});
