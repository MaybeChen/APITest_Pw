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
