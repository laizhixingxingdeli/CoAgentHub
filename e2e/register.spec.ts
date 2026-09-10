import { expect, test } from "@playwright/test";
import { uniqueName } from "./helpers";

/**
 * 核心路径 1:注册 participant。
 * 纯 UI 流程:展开「注册新参与方」→ 填名称/设备 → 提交 → 身份绑定
 * (localStorage 写入)→ 已有 Participant 名册出现该身份。
 *
 * ⚠️ 已 skip —— 这条测的流程在产品里整个不存在了,不是选择器过期。
 *
 * 本套件建于 2026-08-14(caad8282),身份模型在 2026-08-24(f6dc7b22)换掉:
 * 前端不再把身份存 localStorage,改为经 GET /api/participants 找服务端建的
 * 「Local User」(见 web/src/lib/local-user.ts,注释原文 "without persisting
 * an identity locally")。连带后果:
 *
 * - localStorage 键 "coagenthub.agentId" 在前端全仓已无任何读写方,
 *   helpers.ts 的 bindIdentity 因此是空操作(它写的键没人读);
 * - 浏览器侧再也无法扮演任意 participant,只能是 Local User;
 * - i18n 里已无「注册新参与方」「注册并绑定」文案;/participants 页现在是
 *   **执行器管理**页(提交 POST /api/executors,由 server 自动注册对应
 *   participant),不再有独立的「注册参与方 → 绑定身份」表单。
 *
 * 恢复覆盖需要重新设计这条测什么(例如改测「加执行器 → 后端自动注册参与方
 * → 名册出现」),属产品决策,不是改选择器能解决的 —— 留债待议。
 */
test.skip("注册 participant:表单提交 → 身份绑定 → localStorage 写入 → 列表出现", async ({
  page,
}) => {
  const name = uniqueName("e2e-user");

  await page.goto("/groups");

  // 展开注册区
  await page.getByRole("button", { name: /注册新参与方/ }).click();
  await page.getByLabel("注册参与方名称").fill(name);
  await page.getByLabel("注册参与方设备").fill("e2e-device");
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
