import { demoArtifacts, demoEnv } from "../../apps/server/src/demo";
import { recordingSchema } from "../../packages/contracts/src/index";
import { interfaceFacts } from "../../packages/planner/src/evidence";
import { callIntentSchema } from "../../packages/planner/src/call-intent";
export function intentFixture() {
  const bundle = demoArtifacts("intent-case");
  bundle.testCase.steps.forEach((step) => {
    step.review = "CONFIRMED";
    step.executionKind = "API";
  });
  bundle.assets[0].sources = ["created"];
  bundle.assets[1].sources = ["inspected", "verified"];
  bundle.assets[2].sources = ["deleted"];
  const recording = recordingSchema.parse({
    id: "intent-recording",
    caseName: "create-query-delete",
    scenario: "创建、查询、删除并确认不存在",
    target: demoEnv.baseURL,
    state: "STOPPED",
    startedAt: 1,
    operations: [],
    requests: [
      {
        id: "created",
        url: demoEnv.baseURL + "/api/orders",
        method: "POST",
        resourceType: "fetch",
        startedAt: 1,
        headers: { "content-type": "application/json" },
        body: { name: "captured" },
        status: 201,
        response: { id: "recorded-id", name: "captured" },
        keep: true,
      },
      {
        id: "inspected",
        url: demoEnv.baseURL + "/api/orders/recorded-id",
        method: "GET",
        resourceType: "fetch",
        startedAt: 2,
        headers: {},
        status: 200,
        response: { id: "recorded-id", name: "captured" },
        keep: true,
      },
      {
        id: "deleted",
        url: demoEnv.baseURL + "/api/orders/recorded-id",
        method: "DELETE",
        resourceType: "fetch",
        startedAt: 3,
        headers: {},
        status: 204,
        keep: true,
      },
      {
        id: "verified",
        url: demoEnv.baseURL + "/api/orders/recorded-id",
        method: "GET",
        resourceType: "fetch",
        startedAt: 4,
        headers: {},
        status: 404,
        response: { error: "not found" },
        keep: true,
      },
    ],
  });
  const intent = callIntentSchema.parse({
    calls: [
      {
        id: "create",
        semanticStepRef: "prepare",
        apiId: "create",
        requestId: "created",
        dependsOn: [],
        inputs: [],
        checks: [],
      },
      {
        id: "get",
        semanticStepRef: "inspect",
        apiId: "detail",
        requestId: "inspected",
        dependsOn: [],
        inputs: [
          {
            location: "PATH",
            path: "id",
            source: { kind: "RESPONSE", fromCall: "create", path: "$.id" },
          },
        ],
        checks: [],
      },
      {
        id: "delete",
        semanticStepRef: "remove",
        apiId: "delete",
        requestId: "deleted",
        dependsOn: [],
        inputs: [
          {
            location: "PATH",
            path: "id",
            source: { kind: "RESPONSE", fromCall: "create", path: "$.id" },
          },
        ],
        checks: [],
      },
      {
        id: "verify",
        semanticStepRef: "verify",
        apiId: "detail",
        requestId: "verified",
        dependsOn: [],
        inputs: [
          {
            location: "PATH",
            path: "id",
            source: { kind: "RESPONSE", fromCall: "create", path: "$.id" },
          },
        ],
        checks: [],
      },
    ],
  });
  const catalog = bundle.assets.map((asset) =>
    interfaceFacts(recording, asset),
  );
  const context = {
    recording,
    catalog,
    testCase: bundle.testCase,
    environment: demoEnv,
    authProfileRef: "demo-auth",
    planId: "compiled-plan",
    version: 1,
    provider: { name: "test", version: "1" },
    generatedAt: 1234567890000,
  };
  return { ...bundle, recording, catalog, intent, context };
}
