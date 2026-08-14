import { expect, test } from "@playwright/test";
import {
  bindIdentity,
  createGroup,
  listMessages,
  postMessage,
  registerParticipant,
  uniqueName,
} from "./helpers";

/**
 * 核心路径 3:群内发消息(输入 body → 发送 → 消息出现在列表)。
 */
test("群内发消息:输入 body → 发送 → 消息出现在列表", async ({
  page,
  request,
}) => {
  const participant = await registerParticipant(
    request,
    uniqueName("e2e-sender"),
  );
  const group = await createGroup(
    request,
    uniqueName("e2e-msg-group"),
    participant.id,
  );
  await bindIdentity(page, participant.id);

  const body = uniqueName("e2e-body");
  await page.goto(`/groups/${group.id}`);

  await page.getByLabel("消息内容").fill(body);
  await page.getByRole("button", { name: "发送" }).click();

  // 消息出现在列表(消息流内可见该 body)
  await expect(page.locator('[data-testid="message-stream"]')).toContainText(
    body,
  );
});

/**
 * 核心路径 4:回复树(回复 → parentId 挂载 → 树形渲染)。
 * 根消息经 API 注入,回复动作走真实 UI(消息行 hover → 回复 → 引用条 →
 * 发送),最后用 API 侧断言 parentId 确实挂载、UI 显示回复计数。
 */
test("回复树:回复 → parentId 挂载 → 树形渲染", async ({ page, request }) => {
  const participant = await registerParticipant(
    request,
    uniqueName("e2e-replier"),
  );
  const group = await createGroup(
    request,
    uniqueName("e2e-reply-group"),
    participant.id,
  );
  const rootBody = uniqueName("e2e-root");
  await postMessage(request, group.id, rootBody, participant.id);
  await bindIdentity(page, participant.id);

  await page.goto(`/groups/${group.id}`);

  // 根消息出现
  const stream = page.locator('[data-testid="message-stream"]');
  await expect(stream).toContainText(rootBody);

  // hover 消息行 → 点「回复」→ 引用条出现
  const rootRow = page.locator("li", { hasText: rootBody }).first();
  await rootRow.hover();
  await rootRow.getByRole("button", { name: "回复" }).click();
  await expect(page.getByTestId("reply-quote-bar")).toBeVisible();

  // 发送回复
  const replyBody = uniqueName("e2e-reply");
  await page.getByLabel("消息内容").fill(replyBody);
  await page.getByRole("button", { name: "发送" }).click();
  await expect(stream).toContainText(replyBody);

  // 树形渲染:根消息出现「1 条回复」计数
  await expect(page.getByText("1 条回复")).toBeVisible();

  // parentId 挂载(API 侧验证:回复的 parentId = 根消息 id)
  const messages = await listMessages(request, group.id);
  const root = messages.find((m) => m.body === rootBody);
  const reply = messages.find((m) => m.body === replyBody);
  expect(root).toBeTruthy();
  expect(reply).toBeTruthy();
  expect(reply!.parentId).toBe(root!.id);
});
