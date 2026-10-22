import type {
  TestCase,
  Plan,
  Asset,
  AuthProfile,
  Environment,
} from "../../../packages/contracts/src/index.js";
export const demoEnv: Environment = {
  id: "demo",
  baseURL: "http://127.0.0.1:3100",
  allowedOrigins: ["http://127.0.0.1:3100"],
  allowWrites: true,
  allowHighRisk: true,
};
export const demoAuth: AuthProfile = {
  id: "demo-auth",
  actions: [
    { type: "navigate", target: "/" },
    { type: "fill", target: "#username", value: "tester" },
    { type: "fill", target: "#password", secretRef: "DEMO_PASSWORD" },
    { type: "click", target: "#login button" },
  ],
  readySelector: "#home:visible",
  headers: {},
  tokenSources: {},
  reauthenticateReads: false,
};
export function demoArtifacts(caseId = "demo-delete", version = 1) {
  const assets: Asset[] = [
    ["create", "POST", "/api/orders", "CREATE", "WRITE"],
    ["detail", "GET", "/api/orders/{id}", "READ", "READ"],
    ["delete", "DELETE", "/api/orders/{id}", "DELETE", "HIGH"],
  ].map<Asset>(([apiId, method, pathTemplate, operationType, risk]) => ({
    apiId,
    version: 1,
    method: method as Asset["method"],
    pathTemplate,
    parameters: (pathTemplate.includes("{id}")
      ? { id: "string" }
      : {}) as Asset["parameters"],
    requestSchema: {},
    responseSchema: {},
    headers: {},
    authRequired: true,
    operationType: operationType as Asset["operationType"],
    risk: risk as Asset["risk"],
    sources: ["demo-contract"],
    evidence: {
      source: "CONTRACT",
      confidence: 1,
      reason: "Bundled demo application contract",
      confirmed: true,
    },
    validated: true,
  }));
  const testCase: TestCase = {
    caseId,
    name: "删除本次运行创建的订单",
    objective: "验证创建、查询、删除以及删除后的状态",
    version,
    preconditions: ["通过浏览器 UI 登录演示应用", "只操作本次运行创建的订单"],
    steps: [
      ["prepare", "创建专属测试订单", "返回新订单标识"],
      ["inspect", "确认订单已创建", "查询到本次创建的订单"],
      ["remove", "删除测试订单", "删除成功"],
      ["verify", "验证订单已删除", "查询返回不存在"],
    ].map(([id, title, expected], i, all) => ({
      id,
      title,
      expected,
      dependsOn: i ? [all[i - 1][0]] : [],
      review: "NEEDS_REVIEW",
    })),
    expected: "订单完成创建和删除，运行结束无残留资源",
    planVersions: [version],
    status: "DRAFT",
  };
  const base = {
    path: {},
    query: {},
    headers: {},
    extract: {},
    timeoutMs: 10000,
    retries: 0,
    failurePolicy: "STOP" as const,
    ownsResource: false,
    requiresOwnership: false,
    bodyType: "json" as const,
  };
  const path = {
    id: { source: "RESPONSE_VARIABLE" as const, name: "orderId" },
  };
  const status = (value: number) => ({
    kind: "status" as const,
    operator: "eq" as const,
    value,
    basis: "CONTRACT" as const,
    confirmed: false,
  });
  const plan: Plan = {
    planId: `${caseId}-plan`,
    caseId,
    caseVersion: version,
    version,
    status: "DRAFT",
    environmentRef: "demo",
    policyRef: "environment-policy",
    authProfileRef: "demo-auth",
    uiActions: [],
    cleanupPolicy: "ALWAYS",
    model: { provider: "DemoContractFixture", version: "1" },
    generatedAt: Date.now(),
    steps: [
      {
        ...base,
        id: "setup",
        semanticStepRef: "prepare",
        apiId: "create",
        phase: "SETUP",
        dependsOn: [],
        body: { source: "STATIC", value: { name: "本次运行专属订单" } },
        extract: { orderId: "$.id" },
        ownsResource: true,
        resourceVariable: "orderId",
        assertions: [status(201)],
      },
      {
        ...base,
        id: "inspect",
        semanticStepRef: "inspect",
        apiId: "detail",
        phase: "API",
        dependsOn: ["setup"],
        path,
        assertions: [
          status(200),
          {
            kind: "json",
            path: "$.id",
            operator: "exists",
            basis: "CONTRACT",
            confirmed: false,
          },
        ],
      },
      {
        ...base,
        id: "remove",
        semanticStepRef: "remove",
        apiId: "delete",
        phase: "API",
        dependsOn: ["inspect"],
        path,
        requiresOwnership: true,
        resourceVariable: "orderId",
        assertions: [status(204)],
      },
      {
        ...base,
        id: "verify",
        semanticStepRef: "verify",
        apiId: "detail",
        phase: "API",
        dependsOn: ["remove"],
        path,
        assertions: [status(404)],
      },
      {
        ...base,
        id: "cleanup",
        semanticStepRef: "remove",
        apiId: "delete",
        phase: "CLEANUP",
        dependsOn: ["setup"],
        path,
        requiresOwnership: true,
        resourceVariable: "orderId",
        assertions: [status(204)],
      },
    ],
  };
  return { testCase, plan, assets };
}
