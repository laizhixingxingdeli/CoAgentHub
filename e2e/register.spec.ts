import { expect, test } from "@playwright/test";
import { listParticipants, uniqueName } from "./helpers";

/**
 * 核心路径 1:接入参与方(/participants 加执行器 → 后端自动注册 participant
 * → 名册出现)。
 *
 * 本用例是原「注册 participant:表单提交 → 身份绑定 → localStorage 写入 →
 * 列表出现」的重建(2026-09-10)。原流程整个不存在了:
 * - 身份不再本地持久化 —— 2026-08-24(f6dc7b22)起前端只认服务端建的
 *   「Local User」(web/src/lib/local-user.ts),localStorage 键
 *   "coagenthub.agentId" 已无读写方,浏览器侧也无法再扮演任意 participant,
 *   于是「注册并绑定 / 名册标记使用中」这段没有对应 UI 了;
 * - /participants 页现在是**执行器管理**页:提交 POST /api/executors,server
 *   在同一请求里自动注册同名 participant(routes/executor/index.ts 调
 *   registerExecutorParticipant),名册也只列执行器行 —— 单独注册 participant
 *   (POST /api/participants)不会出现在这个页面上。
 *
 * 所以这条改测「加执行器 → 后端自动注册参与方 → 名册出现」这条真实入口。
 */
test("接入参与方:执行器表单提交 → 后端自动注册 participant → 名册出现", async ({
  page,
  request,
}) => {
  const name = uniqueName("e2e-executor");

  await page.goto("/participants");
  // 先等页面渲染完(列表标题出现),再断言名册里还没有这个名字 ——
  // 否则「count 0」在加载态下恒真,等于没断。
  await expect(page.getByText("执行器列表")).toBeVisible();
  await expect(page.getByText(name)).toHaveCount(0);

  // 表单:名字 + 命令(调用方式默认 cli)。按 id 定位而不是 getByLabel ——
  // 「编辑执行器」对话框里有同文案的 label(与 groups.spec.ts 的
  // #group-title-input 同款做法)。
  await page.locator("#ex-name").fill(name);
  await page.locator("#ex-bin").fill("node");
  await page.getByRole("button", { name: "提交" }).click();

  // 成功提示(i18n participants.connected)。
  await expect(page.getByText(`已接入参与方「${name}」`)).toBeVisible();

  // 名册出现该行。行 testid 是 executor-row-<key>,key 由 server 按名字生成
  // slug(冲突时追加序号),这里按行内文本定位,不在测试里复算 slug 规则。
  const row = page.locator('[data-testid^="executor-row-"]', { hasText: name });
  await expect(row).toBeVisible();
  // 「从未在线」只在该执行器匹配到 participant 注册信息时才渲染
  // (participants/index.tsx 的 {participant && …}),是后端自动注册的可见证据;
  // 且这一行来自提交后重新 GET /api/executors + /api/participants,
  // 不是本地表单状态的回显。
  await expect(row).toContainText("从未在线");

  // API 侧复核:participant 名册里确实多了这个名字。
  const participants = await listParticipants(request);
  expect(participants.some((p) => p.name === name)).toBe(true);
});
