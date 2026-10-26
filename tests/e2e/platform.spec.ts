import { test, expect } from "@playwright/test";
test("review, approve and replay a semantic case from the UI", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "用例流程", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await page.getByRole("button", { name: "载入订单演示模板" }).click();
  await expect(
    page.getByRole("heading", { name: "删除本次运行创建的订单" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "定位执行步骤 →" }).first().click();
  await expect(page.getByText("setup · SETUP", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "我已审查预期、断言与资产" }).click();
  await page.getByRole("button", { name: "批准并保存版本" }).click();
  await expect(
    page.getByText("该版本已批准并以不可覆盖记录保存。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "执行回放" }).click();
  await expect(
    page.getByRole("heading", { name: "运行结果 PASSED" }),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    page.getByText("UI 登录：READY", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("运行级资源台账 · 残留 0")).toBeVisible();
});

test("persists a draft and restores it after a page reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await page.getByRole("button", { name: "载入订单演示模板" }).click();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByText("草稿已保存，可从历史记录重新打开。"),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "新建录制会话" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await page.getByText("未关联录制的模板与旧用例", { exact: true }).click();
  await page
    .getByRole("button", { name: "删除本次运行创建的订单 · 草稿" })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "删除本次运行创建的订单" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "创建新版本", exact: true }).click();
  await expect(
    page.getByText("Case v2 / Plan v2", { exact: false }),
  ).toBeVisible();
});

test("restores saved environment configuration and recording selection after reload", async ({
  page,
}) => {
  const id = "saved-env-" + Date.now();
  await page.goto("/");
  await page.getByRole("button", { name: "配置", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "环境配置 JSON" });
  await expect(editor).toHaveValue(/"baseURL"/);
  await editor.fill(
    JSON.stringify({
      id,
      baseURL: "https://7.238.3.92:38443",
      allowedOrigins: ["https://7.238.3.92:38443"],
      allowWrites: true,
      allowHighRisk: false,
      ignoreHTTPSErrors: true,
    }),
  );
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(
    page.getByText("配置已保存；后续验证和回放使用最新配置。"),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "已保存配置" })).toHaveValue(
    id,
  );
  await page.reload();
  await page.getByRole("button", { name: "配置", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "已保存配置" })).toHaveValue(
    id,
  );
  await expect(editor).toHaveValue(/"ignoreHTTPSErrors": true/);
  await page.getByRole("button", { name: "用例流程", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "执行环境" })).toHaveValue(
    id,
  );
});

test("deletes a workspace after confirmation and keeps it deleted after reload", async ({
  page,
}) => {
  const name = "删除验证-" + Date.now();
  await page.goto("/");
  await page.getByRole("button", { name: "配置", exact: true }).click();
  await page.getByPlaceholder("工作区名称").fill(name);
  await page.getByRole("button", { name: "创建工作区", exact: true }).click();
  const remove = page.getByRole("button", {
    name: "删除工作区 " + name,
    exact: true,
  });
  await expect(remove).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await remove.click();
  await expect(remove).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(remove).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "配置", exact: true }).click();
  await expect(remove).toHaveCount(0);
});

test("creates a custom environment using the form without overwriting an existing name", async ({
  page,
  request,
}) => {
  const id = "manual-env-" + Date.now();
  await page.goto("/");
  await page.getByRole("button", { name: "配置", exact: true }).click();
  await page.getByRole("button", { name: "新增环境", exact: true }).click();
  const form = page.getByRole("form", { name: "新增环境表单" });
  await form.getByLabel("环境名称 / 标识").fill(id);
  await form
    .getByLabel("站点基础地址")
    .fill("https://custom.example.test:38443");
  await form
    .getByLabel("额外允许访问的地址")
    .fill("https://login.example.test/path");
  await form.getByRole("button", { name: "保存新环境" }).click();
  await expect(form.getByRole("alert")).toContainText("不能包含路径");
  await form
    .getByLabel("额外允许访问的地址")
    .fill("https://login.example.test\nhttps://api.example.test");
  await form.getByLabel("允许访问的域名正则（HTTPS）").fill("[");
  await form.getByRole("button", { name: "保存新环境" }).click();
  await expect(form.getByRole("alert")).toContainText("Invalid hostname regex");
  await form
    .getByLabel("允许访问的域名正则（HTTPS）")
    .fill(
      String.raw`(^|\.)huawei\.com$` +
        "\n" +
        String.raw`^internal\.example\.test$`,
    );
  await form.getByLabel("保留请求的域名白名单").fill("api.example.test");
  await form
    .getByLabel("保留请求的域名正则")
    .fill(String.raw`(^|\.)huawei\.com$`);
  await form.getByLabel("忽略此环境的 HTTPS 证书错误").check();
  await form.getByRole("button", { name: "保存新环境" }).click();
  await expect(
    page.getByText(`环境“${id}”已创建并保存，可在录制页选择。`),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "已保存配置" })).toHaveValue(
    id,
  );
  await page.reload();
  await page.getByRole("button", { name: "配置", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "已保存配置" })).toHaveValue(
    id,
  );
  const saved = (await (await request.get("/api/environments")).json()).find(
    (e: { id: string }) => e.id === id,
  );
  expect(saved.allowedOrigins).toEqual([
    "https://custom.example.test:38443",
    "https://login.example.test",
    "https://api.example.test",
    { hostnameRegex: String.raw`(^|\.)huawei\.com$`, protocol: "https:" },
    {
      hostnameRegex: String.raw`^internal\.example\.test$`,
      protocol: "https:",
    },
  ]);
  expect(saved.recordingRequestDomains).toEqual([
    "api.example.test",
    { hostnameRegex: String.raw`(^|\.)huawei\.com$` },
  ]);
  expect(saved.allowWrites).toBe(false);
  expect(saved.allowHighRisk).toBe(false);
  expect(saved.ignoreHTTPSErrors).toBe(true);
  await page.getByRole("button", { name: "新增环境", exact: true }).click();
  await form.getByLabel("环境名称 / 标识").fill(id);
  await form.getByLabel("站点基础地址").fill("https://different.example.test");
  await form.getByRole("button", { name: "保存新环境" }).click();
  await expect(form.getByRole("alert")).toContainText("已存在");
  expect(
    (await (await request.get("/api/environments")).json()).find(
      (e: { id: string }) => e.id === id,
    ),
  ).toEqual(saved);
  await form.getByRole("button", { name: "取消新增" }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole("button", { name: "用例流程", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "执行环境" })).toHaveValue(
    id,
  );
});

test("shows pending classification and saved request and response evidence in analysis details", async ({
  page,
}) => {
  const request = {
    id: "evidence-1",
    url: "https://example.test/wiseoffice/insight/topic/list?date=2026-10-23",
    method: "POST",
    resourceType: "fetch",
    startedAt: 1,
    endedAt: 43,
    duration: 42,
    headers: {
      authorization: "[REDACTED]",
      "content-type": "application/json",
    },
    query: { date: "2026-10-23" },
    body: { topic: "all" },
    status: 200,
    responseHeaders: { "content-type": "application/json" },
    response: { items: [{ title: "业务主题" }] },
    responseBodyCapture: { state: "CAPTURED", bytes: 46 },
    category: "UNKNOWN",
    keep: true,
    operationCandidates: [],
    classification: {
      source: "RULE",
      reason: "待人工确认业务含义",
      confidence: 0.3,
      confirmed: false,
    },
  };
  const recording = {
    id: "ui-evidence",
    caseName: "接口证据展示",
    scenario: "查看请求和响应",
    target: "https://example.test",
    notes: "",
    startedAt: 1,
    state: "STOPPED",
    operations: [],
    dependencies: [],
    redactions: [],
    requests: [
      request,
      {
        ...request,
        id: "evidence-2",
        url: "https://example.test/api/empty",
        method: "DELETE",
        status: 204,
        body: undefined,
        response: undefined,
        responseBodyCapture: {
          state: "EMPTY",
          reason: "此响应没有正文",
          bytes: 0,
        },
      },
      {
        ...request,
        id: "evidence-3",
        url: "https://example.test/api/stream",
        method: "GET",
        body: undefined,
        response: undefined,
        responseBodyCapture: {
          state: "OMITTED",
          reason:
            "响应没有有效 Content-Length（可能为 chunked 或流式响应），为避免无界采集未读取正文",
        },
      },
    ],
  };
  await page.route("**/api/recordings", (route) =>
    route.fulfill({ json: [recording] }),
  );
  await page.route("**/api/recordings/ui-evidence/analyze", (route) =>
    route.fulfill({ json: { recording, assets: [] } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await page.getByRole("button", { name: "打开流程 接口证据展示" }).click();
  await page.getByRole("button", { name: "分析录制", exact: true }).click();
  await expect(
    page.getByText("当前展示的是规则分析，不是大模型分析。", { exact: false }),
  ).toBeVisible();
  const details = page.locator("details").filter({
    has: page
      .locator("summary")
      .filter({ hasText: "POST /wiseoffice/insight/topic/list" }),
  });
  await details.locator("summary").click();
  await expect(details.getByText("待确认接口", { exact: true })).toBeVisible();
  await expect(
    details.getByRole("heading", { name: "请求 Body", exact: true }),
  ).toBeVisible();
  await expect(
    details.locator("pre").filter({ hasText: '"topic": "all"' }),
  ).toBeVisible();
  await expect(
    details.locator("pre").filter({ hasText: "业务主题" }),
  ).toBeVisible();
  await expect(details.getByText("42 ms", { exact: true })).toBeVisible();
  await expect(
    details.locator("pre").filter({ hasText: "[REDACTED]" }),
  ).toBeVisible();
  const empty = page.locator("details").filter({
    has: page.locator("summary").filter({ hasText: "DELETE /api/empty" }),
  });
  await empty.locator("summary").click();
  await expect(
    empty.getByText("此响应没有正文", { exact: true }),
  ).toBeVisible();
  const omitted = page.locator("details").filter({
    has: page.locator("summary").filter({ hasText: "GET /api/stream" }),
  });
  await omitted.locator("summary").click();
  await expect(
    omitted.getByText("响应没有有效 Content-Length", { exact: false }),
  ).toBeVisible();
});

test("restores staged generation progress and opens its workflow draft", async ({
  page,
  request,
}) => {
  const bundle = await (
    await request.post("http://127.0.0.1:3000/api/demo")
  ).json();
  const recording = {
    id: "saved-record",
    caseName: bundle.testCase.name,
    scenario: "历史生成",
    target: "http://127.0.0.1:3100",
    startedAt: 1000,
    state: "STOPPED",
    requests: [],
    operations: [],
  };
  await page.route("**/api/recordings", (route) =>
    route.fulfill({ json: [recording] }),
  );
  await page.route("**/api/generations*", (route) =>
    route.fulfill({
      json: [
        {
          id: "saved-generation",
          provider: { name: "TestProvider", version: "1" },
          createdAt: 1000,
          updatedAt: 3000,
          state: "NEEDS_REVIEW",
          stages: [
            {
              id: "EVIDENCE",
              state: "SUCCEEDED",
              attempts: 1,
              output: { requestIds: ["saved-request"] },
            },
            { id: "EXECUTION_PLAN", state: "SUCCEEDED", attempts: 1 },
          ],
          testCase: bundle.testCase,
          plan: bundle.plan,
          input: {
            assets: bundle.assets,
            recording,
          },
        },
      ],
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await page
    .getByRole("button", { name: `打开流程 ${bundle.testCase.name}` })
    .click();
  await page.getByRole("button", { name: /生成草稿/ }).click();
  await expect(
    page.getByRole("heading", { name: "生成工作流", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("生成完成，等待审核")).toBeVisible();
  await page.getByRole("button", { name: "打开草稿", exact: true }).click();
  await page.getByRole("button", { name: "执行计划", exact: true }).click();
  await expect(page.getByRole("img", { name: "接口依赖工作流" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "参数传递", exact: true }),
  ).toBeVisible();
});

test("extracts test data and replays one approved workflow with two datasets rows", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await page.getByRole("button", { name: "载入订单演示模板" }).click();
  await page.getByRole("button", { name: "从流程提取测试数据" }).click();
  const editor = page.getByLabel("数据组（JSON 数组）");
  const original = JSON.parse(await editor.inputValue());
  const second = structuredClone(original[0]);
  second.id = "row-2";
  second.name = `第二组订单-${Date.now()}`;
  second.values.setup_body.name = "第二组订单";
  await editor.fill(JSON.stringify([...original, second]));
  // Switching editor views must preserve the extracted data.
  await page.getByRole("button", { name: "执行计划", exact: true }).click();
  expect(JSON.parse(await editor.inputValue())).toHaveLength(2);
  await page.getByRole("button", { name: "我已审查预期、断言与资产" }).click();
  await page.getByRole("button", { name: "批准并保存版本" }).click();
  await expect(
    page.getByText("该版本已批准并以不可覆盖记录保存。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "执行全部数据组" }).click();
  await expect(page.getByText("已执行 2 组数据，通过 2 组。")).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page.getByRole("button", { name: new RegExp(`${second.name} · PASSED`) }),
  ).toBeVisible();
  await expect(page.getByText("运行级资源台账 · 残留 0")).toBeVisible();
});

test("shows generation stage, elapsed time, artifacts and recoverable errors", async ({
  page,
}) => {
  const recording = {
    id: "failed-record",
    caseName: "生成界面测试",
    scenario: "失败恢复",
    target: "http://127.0.0.1:3100",
    startedAt: 1000,
    state: "STOPPED",
    requests: [],
    operations: [],
  };
  await page.route("**/api/recordings", (route) =>
    route.fulfill({ json: [recording] }),
  );
  await page.route("**/api/generations*", (route) =>
    route.fulfill({
      json: [
        {
          id: "failed-job",
          state: "FAILED",
          active: false,
          createdAt: Date.now() - 5000,
          updatedAt: Date.now(),
          provider: { name: "TestProvider", version: "1" },
          input: { recording },
          error: "模型连接失败，请重试",
          stages: [
            {
              id: "EVIDENCE",
              state: "SUCCEEDED",
              startedAt: 1000,
              endedAt: 2500,
              attempts: 1,
              output: { requestIds: ["req-1"] },
            },
            {
              id: "BUSINESS_FLOW",
              state: "FAILED",
              startedAt: 2500,
              endedAt: 3000,
              attempts: 2,
              error: "连接超时",
            },
            { id: "SEMANTIC_CASE", state: "PENDING", attempts: 0 },
          ],
        },
      ],
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await page.getByRole("button", { name: "打开流程 生成界面测试" }).click();
  await expect(page.getByText("当前阶段：识别业务流程")).toBeVisible();
  await expect(page.getByText("总耗时：5.0 秒")).toBeVisible();
  await expect(page.getByText("进度：1 / 3")).toBeVisible();
  await expect(page.getByText("连接超时", { exact: true })).toBeVisible();
  await page.getByText("查看阶段产物").click();
  await expect(page.getByText(/req-1/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "继续未完成阶段" }),
  ).toBeEnabled();
});

test("keeps recording, analysis, generation and review in one flow and groups history by recording", async ({
  page,
  request,
}) => {
  const bundle = await (await request.post("/api/demo")).json();
  const recording = {
    id: `flow-${Date.now()}`,
    caseName: "连续录制流程",
    scenario: "完成录制到审核",
    target: "http://127.0.0.1:3100",
    environmentRef: "demo",
    startedAt: Date.now(),
    state: "RECORDING",
    operations: [],
    requests: [
      {
        id: "flow-request",
        method: "GET",
        url: "http://127.0.0.1:3100/api/orders",
        resourceType: "fetch",
        startedAt: 1,
        query: {},
        headers: {},
        status: 200,
        category: "BUSINESS",
        keep: true,
        operationCandidates: [],
      },
    ],
    dependencies: [],
  };
  let created = false;
  let generated = false;
  const job = {
    id: "flow-generation",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    state: "NEEDS_REVIEW",
    provider: { name: "Fixture", version: "1" },
    stages: [
      {
        id: "EVIDENCE",
        state: "SUCCEEDED",
        attempts: 1,
        output: { requestIds: ["flow-request"] },
      },
    ],
    testCase: bundle.testCase,
    plan: bundle.plan,
    input: { recording, assets: bundle.assets },
  };
  await page.route("**/api/recordings", async (route) => {
    if (route.request().method() === "POST") {
      created = true;
      await route.fulfill({ json: recording });
    } else await route.fulfill({ json: created ? [recording] : [] });
  });
  await page.route(`**/api/recordings/${recording.id}/stop`, (route) => {
    recording.state = "STOPPED";
    return route.fulfill({ json: recording });
  });
  await page.route(`**/api/recordings/${recording.id}/analyze`, (route) =>
    route.fulfill({ json: { recording, assets: [] } }),
  );
  await page.route(`**/api/recordings/${recording.id}/analysis`, (route) =>
    route.fulfill({ json: { recording, assets: [] } }),
  );
  await page.route("**/api/generations*", (route) => {
    if (route.request().method() === "POST") {
      generated = true;
      return route.fulfill({ json: { id: job.id } });
    }
    return route.fulfill({ json: generated ? [job] : [] });
  });
  await page.goto("/");
  const nav = page.locator("aside nav");
  await expect(nav.getByRole("button")).toHaveCount(4);
  await expect(nav.getByRole("button", { name: /分析|录制|环境/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("heading", { name: "新建录制会话" }),
  ).toBeVisible();
  await page.getByLabel("用例名称", { exact: true }).fill(recording.caseName);
  await page.getByLabel("测试场景", { exact: true }).fill(recording.scenario);
  await page.getByRole("button", { name: "开始录制", exact: true }).click();
  const progress = page.getByRole("list", { name: "用例流程进度" });
  await expect(
    progress.getByRole("button", { name: /录制操作/ }),
  ).toHaveAttribute("aria-current", "step");
  await expect(page.getByLabel("当前工作区")).toBeDisabled();
  await page.getByRole("button", { name: "停止并保存" }).click();
  await expect(
    progress.getByRole("button", { name: /分析筛选/ }),
  ).toHaveAttribute("aria-current", "step");
  await expect(nav.getByRole("button", { name: /用例流程/ })).toHaveClass(
    "active",
  );
  await page.getByRole("button", { name: "启动生成工作流" }).click();
  await expect(
    progress.getByRole("button", { name: /生成草稿/ }),
  ).toHaveAttribute("aria-current", "step");
  await page.getByRole("button", { name: "打开草稿", exact: true }).click();
  await expect(
    progress.getByRole("button", { name: /审核与执行/ }),
  ).toHaveAttribute("aria-current", "step");
  await expect(nav.getByRole("button", { name: /用例流程/ })).toHaveClass(
    "active",
  );
  await nav.getByRole("button", { name: /历史记录/ }).click();
  const row = page.getByRole("row").filter({ hasText: recording.caseName });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("1 次生成");
  await row
    .getByRole("button", { name: `打开流程 ${recording.caseName}` })
    .click();
  await expect(
    progress.getByRole("button", { name: /审核与执行/ }),
  ).toHaveAttribute("aria-current", "step");
});

test("keeps workspace and recording history isolated and clears the previous flow when switching workspace", async ({
  page,
  request,
}) => {
  const bundle = await (await request.post("/api/demo")).json();
  const suffix = Date.now();
  const a = await (
    await request.post("/api/workspaces", {
      data: { name: `流程 A ${suffix}` },
    })
  ).json();
  const b = await (
    await request.post("/api/workspaces", {
      data: { name: `流程 B ${suffix}` },
    })
  ).json();
  const makeRecord = (id: string, workspaceId: string) => ({
    id,
    workspaceId,
    caseName: id,
    scenario: id,
    target: "http://127.0.0.1:3100",
    startedAt: Date.now(),
    state: "STOPPED",
    requests: [],
    operations: [],
  });
  const recA = makeRecord("workspace-a-record", a.id),
    recB = makeRecord("workspace-b-record", b.id),
    recA2 = makeRecord("workspace-a-other", a.id);
  const makeJob = (recording: typeof recA, state: string) => ({
    id: `${recording.id}-job`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    state,
    stages: [],
    provider: { name: "Fixture", version: "1" },
    error: `${recording.id}-error`,
    input: { recording, assets: [] },
    ...(state === "NEEDS_REVIEW"
      ? { testCase: bundle.testCase, plan: bundle.plan }
      : {}),
  });
  // Return every job even for scoped requests, to exercise the UI's own scope checks too.
  await page.route("**/api/generations*", (route) =>
    route.fulfill({
      json: [
        makeJob(recA, "NEEDS_REVIEW"),
        makeJob(recB, "FAILED"),
        makeJob(recA2, "FAILED"),
      ],
    }),
  );
  await page.route("**/api/recordings", (route) =>
    route.fulfill({ json: [recA, recB, recA2] }),
  );
  await page.goto("/");
  await page.getByLabel("当前工作区").selectOption(a.id);
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: `打开流程 ${recB.caseName}` }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: `打开流程 ${recA.caseName}`, exact: true })
    .click();
  const progress = page.getByRole("list", { name: "用例流程进度" });
  await expect(
    progress.getByRole("button", { name: /审核与执行/ }),
  ).toHaveAttribute("aria-current", "step");
  await page.getByLabel("当前工作区").selectOption(b.id);
  await expect(
    page.getByRole("heading", { name: bundle.testCase.name, exact: true }),
  ).toHaveCount(0);
  await expect(
    progress.getByRole("button", { name: /审核与执行/ }),
  ).toBeDisabled();
  await page
    .locator("aside nav")
    .getByRole("button", { name: /历史记录/ })
    .click();
  await expect(
    page.getByRole("button", {
      name: `打开流程 ${recA.caseName}`,
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: `打开流程 ${recB.caseName}` }).click();
  await expect(
    page.getByText(`${recB.id}-error`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(`${recA2.id}-error`, { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(`${recA.id}-error`, { exact: true })).toHaveCount(
    0,
  );
});

test("reviews recommended interfaces and edited semantic expectations before generating a plan with separate captured data", async ({
  page,
  request,
}) => {
  const bundle = await (await request.post("/api/demo")).json();
  const recording = {
    id: "review-pipeline-record",
    caseName: "四阶段确认流程",
    scenario: "创建订单",
    target: "http://127.0.0.1:3100",
    startedAt: Date.now(),
    state: "STOPPED",
    requests: [],
    operations: [],
  };
  const job: any = {
    id: "review-pipeline-job",
    revision: 10,
    pipelineVersion: 2,
    state: "WAITING_INTERFACE_REVIEW",
    scenario: "创建订单",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    provider: { name: "Fixture", version: "2" },
    modelLimits: {
      inputBudget: 64000,
      maxOutputTokens: 8192,
      maxInterfacesPerBatch: 6,
    },
    input: {
      recording,
      assets: bundle.assets,
      environment: { id: "demo" },
      caseId: bundle.testCase.caseId,
    },
    stages: [
      { id: "API_ORGANIZATION", state: "SUCCEEDED", attempts: 1 },
      { id: "API_SELECTION", state: "SUCCEEDED", attempts: 1 },
      { id: "CASE_DESIGN", state: "PENDING", attempts: 0 },
      { id: "PLAN_DESIGN", state: "PENDING", attempts: 0 },
    ],
    catalog: bundle.assets.slice(0, 2).map((asset: any, i: number) => ({
      apiId: asset.apiId,
      name: i === 0 ? "创建订单接口" : "查询订单接口",
      description: i === 0 ? "提交名称创建订单" : "查询指定订单",
      uncertainties: [],
      asset,
      customHeaders: {
        "x-team": {
          binding: { source: "STATIC", value: "team-a" },
          sample: "team-a",
        },
      },
      samples: [
        {
          requestId: `recorded-${i}`,
          query: {},
          body: { name: "采集的订单名称" },
          status: 201,
          response: { id: "captured-id" },
        },
      ],
      omittedSamples: 0,
    })),
    selectedApiIds: ["create", "detail"],
    recommendations: {
      selected: [
        { apiId: "create", role: "SCENARIO", reason: "用于创建订单" },
        { apiId: "detail", role: "DEPENDENCY", reason: "用于确认订单" },
      ],
      uncertainties: [],
    },
    authProfileRef: "demo-auth",
  };
  const submissions: any[] = [];
  await page.route("**/api/recordings", (route) =>
    route.fulfill({ json: [recording] }),
  );
  await page.route("**/api/generations*", (route) =>
    route.fulfill({ json: [job] }),
  );
  await page.route(
    "**/api/generations/review-pipeline-job/interfaces",
    async (route) => {
      const data = route.request().postDataJSON();
      submissions.push({ phase: "interfaces", data });
      job.selectedApiIds = data.selectedApiIds;
      job.selectionConfirmed = true;
      job.state = "WAITING_CASE_REVIEW";
      job.revision++;
      job.testCase = {
        ...bundle.testCase,
        inputRequirements: ["使用专属名称"],
        steps: [
          {
            ...bundle.testCase.steps[0],
            executionKind: "API",
            inputs: ["订单名称"],
          },
        ],
      };
      await route.fulfill({ json: { id: job.id } });
    },
  );
  await page.route(
    "**/api/generations/review-pipeline-job/case",
    async (route) => {
      const data = route.request().postDataJSON();
      submissions.push({ phase: "case", data });
      job.testCase = data.testCase;
      job.caseConfirmed = true;
      job.state = "NEEDS_REVIEW";
      job.revision++;
      job.plan = {
        ...bundle.plan,
        parameters: { order_body: "object" },
        steps: [
          {
            ...bundle.plan.steps[0],
            body: { source: "TEST_DATA", name: "order_body" },
          },
        ],
      };
      job.datasetCandidate = {
        id: "captured-data",
        name: "采集候选数据",
        planId: job.plan.planId,
        planVersion: job.plan.version,
        version: 1,
        rows: [
          {
            id: "recorded",
            name: "录制样例",
            values: { order_body: { name: "采集的订单名称" } },
          },
        ],
      };
      await route.fulfill({ json: { id: job.id } });
    },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await page.getByRole("button", { name: "打开流程 四阶段确认流程" }).click();
  await expect(
    page.getByRole("heading", { name: "确认场景接口" }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "选择接口 create", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "选择接口 detail", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("checkbox", { name: "选择接口 detail", exact: true })
    .uncheck();
  await expect(page.getByText("查询订单接口", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "打开草稿", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "确认接口，生成语义用例", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "确认语义测试用例" }),
  ).toBeVisible();
  expect(submissions[0].data.selectedApiIds).toEqual(["create"]);
  await page
    .getByRole("textbox", { name: "预期结果", exact: true })
    .fill("人工确认：订单创建成功");
  await expect(
    page.getByRole("button", { name: "确认用例，生成调用计划" }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "我已确认前置条件、输入步骤及预期结果" })
    .check();
  await page.getByRole("button", { name: "确认用例，生成调用计划" }).click();
  await page.getByRole("button", { name: "打开草稿", exact: true }).click();
  expect(submissions[1].data.testCase.steps[0].expected).toBe(
    "人工确认：订单创建成功",
  );
  await expect(page.getByLabel("数据组（JSON 数组）")).toHaveValue(
    /采集的订单名称/,
  );
});
