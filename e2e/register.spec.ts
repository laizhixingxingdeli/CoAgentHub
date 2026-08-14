import { expect, test } from "@playwright/test";
import { uniqueName } from "./helpers";

/**
 * 核心路径 1:注册 participant。
 * 纯 UI 流程:展开「注册新 Participant」→ 填名称/设备 → 提交 → 身份绑定
 * (localStorage 写入)→ 已有 Participant 名册出现该身份。
 */
test("注册 participant:表单提交 → 身份绑定 → localStorage 写入 → 列表出现", async ({
  page,
}) => {
  const name = uniqueName("e2e-user");

  await page.goto("/groups");

  // 展开注册区
  await page.getByRole("button", { name: "注册新 Participant" }).click();
  await page.getByLabel("注册 Participant 名称").fill(name);
  await page.getByLabel("注册 Participant 设备").fill("e2e-device");
  await page.getByRole("button", { name: "注册并绑定" }).click();

  // 成功提示
  await expect(page.getByText(`已注册并绑定 ${name}`)).toBeVisible();

  // 身份绑定:localStorage 写入(identity store 同一 key)
  const stored = await page.evaluate(() =>
    localStorage.getItem("coagenthub.agentId"),
  );
  expect(stored).toBeTruthy();

  // 名册出现该身份,并标记「使用中」
  const rosterItem = page.locator("li", { hasText: name }).first();
  await expect(rosterItem).toBeVisible();
  await expect(rosterItem.getByText("使用中")).toBeVisible();
});
