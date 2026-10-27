import { expect, it } from "vitest";
import {
  compileCallIntent,
  preflightHeaders,
} from "../../packages/planner/src/intent-compiler";
import { callIntentSchema } from "../../packages/planner/src/call-intent";
import { taskMessages } from "../../packages/planner/src/pipeline-contracts";
import { validate } from "../../packages/core/src/index";
import { intentFixture } from "../fixtures/intent";

it("compiles recorded defaults, semantic dependencies and proven response ownership locally", () => {
  const f = intentFixture();
  const { plan, issues } = compileCallIntent(f.intent, f.context);
  expect(issues).toEqual([]);
  expect(plan.generatedAt).toBe(f.context.generatedAt);
  expect(plan.authProfileRef).toBe("demo-auth");
  expect(plan.steps[0].body).toEqual({
    source: "STATIC",
    value: { name: "captured" },
  });
  expect(plan.steps[1].dependsOn).toContain("create");
  expect(plan.steps[3].dependsOn).toContain("delete");
  expect(plan.steps[0].phase).toBe("API");
  expect(plan.steps[0].parallelSafe).toBe(false);
  expect(plan.steps[0].ownsResource).toBe(true);
  expect(plan.steps.at(-1)).toMatchObject({
    id: "cleanup_delete",
    phase: "CLEANUP",
    onlyIfOwned: true,
    requiresOwnership: true,
    semanticStepRef: "remove",
  });
  expect(validate(f.testCase, plan, f.assets, f.context.environment)).toEqual(
    [],
  );
});
it("never manufactures a delete action or ownership for a recorded historical ID", () => {
  const f = intentFixture();
  f.intent.calls[2].inputs = [];
  const { plan, issues } = compileCallIntent(f.intent, f.context);
  expect(
    issues.some((issue) => issue.message.includes("缺少已验证的资源所有权")),
  ).toBe(true);
  expect(plan.steps.some((step) => step.phase === "CLEANUP")).toBe(false);
  expect(plan.steps[2].requiresOwnership).toBe(true);
});
it("rejects invented calls, semantic IDs, response fields and unsupported assertions", () => {
  const f = intentFixture();
  const extra = { ...f.intent.calls[0], phase: "SETUP" };
  expect(() => callIntentSchema.parse({ calls: [extra] })).toThrow();
  f.intent.calls[0].semanticStepRef = "invented";
  expect(() => compileCallIntent(f.intent, f.context)).toThrow("未确认");
  f.intent.calls[0].semanticStepRef = "prepare";
  f.intent.calls[1].inputs[0].source = {
    kind: "RESPONSE",
    fromCall: "create",
    path: "$.invented",
  };
  f.intent.calls[0].checks = [
    { kind: "json", path: "$.list[*].name", operator: "exists" },
  ];
  const result = compileCallIntent(f.intent, f.context);
  expect(
    result.issues.some((issue) => issue.message.includes("没有录制依据")),
  ).toBe(true);
  expect(
    result.issues.some((issue) => issue.message.includes("不受执行器支持")),
  ).toBe(true);
});
it("does not expose Plan or authentication controls in the model output schema", () => {
  const messages = taskMessages("PLAN_DESIGN", {
    planProtocol: "CALL_INTENT_V2",
  });
  const schema = JSON.parse(messages[0].content.split("输出 Schema：")[1]);
  expect(Object.keys(schema.properties)).toEqual(["calls", "uncertainties"]);
  expect(schema.properties.calls.items.properties).not.toHaveProperty("phase");
  expect(schema.properties.calls.items.properties).not.toHaveProperty(
    "headers",
  );
  expect(schema.properties.calls.items.properties).not.toHaveProperty(
    "resourceVariable",
  );
});
it("preflights missing authentication sources before asking the model for a plan", () => {
  const f = intentFixture();
  f.catalog[0].asset.headers["x-page-token"] = { source: "MANUAL_REVIEW" };
  expect(preflightHeaders(f.catalog, {}, []).length).toBe(1);
  expect(
    preflightHeaders(
      f.catalog,
      { "x-page-token": { source: "AUTH_CONTEXT", name: "page" } },
      ["page"],
    ),
  ).toEqual([]);
});

it("compiles observed array field matching instead of unsupported JSONPath filters", () => {
  const f = intentFixture();
  f.recording.requests[1].response = {
    items: [{ placeholder_key: "old", placeholder_default: "old-value" }],
  };
  f.intent.calls[1].checks = [
    {
      kind: "json",
      path: "$.items",
      operator: "contains",
      value: { placeholder_key: "new", placeholder_default: "new-value" },
    },
  ];
  const output = compileCallIntent(f.intent, f.context);
  expect(output.issues).toEqual([]);
  expect(output.plan.steps[1].assertions).toContainEqual(
    expect.objectContaining({
      path: "$.items",
      operator: "contains",
      value: { placeholder_key: "new", placeholder_default: "new-value" },
      basis: "INFERRED",
    }),
  );
  f.intent.calls[1].checks[0].value = { invented_key: "new" };
  expect(
    compileCallIntent(f.intent, f.context).issues.some((issue) =>
      issue.message.includes("字段录制依据"),
    ),
  ).toBe(true);
});

it("blocks invented save/delete inputs and preserves compiler blockers through public validation", () => {
  const f = intentFixture();
  f.intent.calls[0].inputs = [
    {
      location: "BODY",
      path: "$.action",
      source: { kind: "VALUE", value: "delete" },
    },
  ];
  const output = compileCallIntent(f.intent, f.context);
  expect(
    output.plan.compilation!.blockers.some((message) =>
      message.includes("action=delete"),
    ),
  ).toBe(true);
  expect(
    validate(f.testCase, output.plan, f.assets, f.context.environment).some(
      (message) => message.startsWith("编译阻塞："),
    ),
  ).toBe(true);
  f.intent.calls[0].inputs = [
    {
      location: "BODY",
      path: "$.name",
      source: { kind: "VALUE", value: "scenario-name" },
    },
  ];
  expect(compileCallIntent(f.intent, f.context).issues).toEqual([]);
});

it("requires authentication headers only when they have actual request evidence", async () => {
  const { interfaceFacts } =
    await import("../../packages/planner/src/evidence");
  const f = intentFixture();
  f.assets[0].headers["x-gde-csrf-token"] = {
    source: "AUTH_CONTEXT",
    name: "invented-from-old-catalog",
  };
  const refreshed = interfaceFacts(f.recording, f.assets[0]);
  expect(refreshed.asset.headers).not.toHaveProperty("x-gde-csrf-token");
  expect(preflightHeaders([refreshed], {}, [])).toEqual([]);
  f.recording.requests[0].headers["x-gde-csrf-token"] = "[REDACTED]";
  const observed = interfaceFacts(f.recording, f.assets[0]);
  expect(preflightHeaders([observed], {}, [])[0].message).toContain(
    "x-gde-csrf-token",
  );
});
