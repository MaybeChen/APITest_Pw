import { test, expect } from "@playwright/test";
test("review, approve and replay a semantic case from the UI", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "工作区", exact: true }).first(),
  ).toBeVisible();
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
  await page.getByRole("button", { name: "载入订单演示模板" }).click();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByText("草稿已保存，可从工作区重新打开。"),
  ).toBeVisible();
  await page.reload();
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
  await page.getByRole("button", { name: /环境配置/ }).click();
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
  await page.getByRole("button", { name: /环境配置/ }).click();
  await expect(page.getByRole("combobox", { name: "已保存配置" })).toHaveValue(
    id,
  );
  await expect(editor).toHaveValue(/"ignoreHTTPSErrors": true/);
  await page.getByRole("button", { name: /浏览器录制/ }).click();
  await expect(page.getByRole("combobox", { name: "执行环境" })).toHaveValue(
    id,
  );
});

test("deletes a workspace after confirmation and keeps it deleted after reload", async ({
  page,
}) => {
  const name = "删除验证-" + Date.now();
  await page.goto("/");
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
  await expect(remove).toHaveCount(0);
});

test("creates a custom environment using the form without overwriting an existing name", async ({
  page,
  request,
}) => {
  const id = "manual-env-" + Date.now();
  await page.goto("/");
  await page.getByRole("button", { name: /环境配置/ }).click();
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
  await page.getByRole("button", { name: /环境配置/ }).click();
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
  await page.getByRole("button", { name: /浏览器录制/ }).click();
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
  await page.getByRole("button", { name: "接口证据展示 · STOPPED" }).click();
  await page.getByRole("button", { name: "分析录制", exact: true }).click();
  await expect(
    page.getByText("当前展示的是规则分析，不是大模型分析。", { exact: false }),
  ).toBeVisible();
  const details = page
    .locator("details")
    .filter({
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
  const empty = page
    .locator("details")
    .filter({
      has: page.locator("summary").filter({ hasText: "DELETE /api/empty" }),
    });
  await empty.locator("summary").click();
  await expect(
    empty.getByText("此响应没有正文", { exact: true }),
  ).toBeVisible();
  const omitted = page
    .locator("details")
    .filter({
      has: page.locator("summary").filter({ hasText: "GET /api/stream" }),
    });
  await omitted.locator("summary").click();
  await expect(
    omitted.getByText("响应没有有效 Content-Length", { exact: false }),
  ).toBeVisible();
});
