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
 *
 * ⚠️ 已 skip —— 群页面已经没有消息输入框和消息流了,不是选择器过期。
 *
 * /groups/:id 现在渲染的是「标题栏 + 只读横幅 + RequirementWorkspace
 * (需求列表/详情两栏)」(messages/index.tsx:163-169)。原来的聊天流组件
 * MessageList.tsx(带 data-testid="message-stream")全仓无人 import,已是
 * 死代码;i18n 的 messages.send.aria(「消息内容」)同样不再被任何组件渲染。
 *
 * 当前 UI 里唯一会 POST /groups/:id/messages 的路径是任务上的「停止」/
 * 「回滚」按钮(requirement-workspace.tsx:642 的 sendCommand,发的是
 * broadcast 命令消息),**没有自由文本输入框**。也就是说「输入 body → 发送」
 * 这个能力在产品里已不存在,无从断言。
 *
 * 身份侧还有第二重失效:本用例靠 bindIdentity 扮演自己注册的 participant,
 * 而身份模型已在 2026-08-24 改为固定的「Local User」——详见 register.spec.ts
 * 头部那段说明。
 *
 * 恢复覆盖需要重新决定「发消息」在新形态下测什么,属产品决策 —— 留债待议。
 */
test.skip("群内发消息:输入 body → 发送 → 消息出现在列表", async ({
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
 *
 * ⚠️ 已 skip —— 同上一条:消息流 UI(message-stream / 消息行 hover / 回复
 * 引用条 reply-quote-bar / 「N 条回复」计数)随 MessageList.tsx 一起成了
 * 无人挂载的死代码。parentId 的服务端行为仍由单测覆盖,这里缺的是 UI 侧。
 */
test.skip("回复树:回复 → parentId 挂载 → 树形渲染", async ({
  page,
  request,
}) => {
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
