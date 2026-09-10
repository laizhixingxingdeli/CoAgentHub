import { expect, test } from "@playwright/test";
import {
  createGroup,
  createTask,
  listMessages,
  localUserParticipantId,
  postMessage,
  registerParticipant,
  uniqueName,
} from "./helpers";

/**
 * 核心路径 3:群内发消息 —— 现在只剩「任务停止命令」这一条路径。
 *
 * 本用例是原「群内发消息:输入 body → 发送 → 消息出现在列表」的重建
 * (2026-09-10):自由文本发消息在产品里已不存在 —— /groups/:id 现在渲染
 * 「标题栏 + 只读横幅 + RequirementWorkspace(需求列表/详情两栏)」,没有
 * 消息输入框;当前 UI 唯一会 POST /groups/:id/messages 的地方是任务卡片上的
 * 「停止」/「回滚」(requirement-workspace.tsx 的 sendCommand,发 broadcast
 * 命令消息)。所以这条改测那条真实路径,并顺带覆盖
 * specs/stop-button-needs-confirmation 的二次确认要求(R1/R2 取消则不发消息;
 * R3 文案指名任务标识 + 当前状态 + 后果)。
 *
 * 同批删掉的是原「回复树:回复 → parentId 挂载 → 树形渲染」:消息行 hover
 * 回复 / 引用条 / 「N 条回复」计数随 MessageList.tsx 一起下线(该组件已在本批
 * 删除),新 UI 的需求时间线是平铺渲染 —— parentId 只参与「消息归属到哪条
 * 需求」的启发式(merge-requirement-timeline.ts),且时间窗兜底会让消息即使
 * 没有 parentId 也照样归属,E2E 断不出 parentId 起了作用。该行为分别由 server
 * 端单测(parentId/depth 挂载)与 merge-requirement-timeline 单测(回复子树
 * 归属)覆盖,不在 E2E 重复。
 *
 * 身份:必须用 Local User 建群(见 helpers.localUserParticipantId)—— 浏览器
 * 一律以 Local User 访问,建群者自动成为 coordinator 成员,命令消息才发得出去。
 *
 * 不断言任务终态:E2E 不跑真实执行器,API 直接建的任务只在库里是 queued、
 * 不在 server 的内存队列里,而 control.ts 的 cancelQueuedTasks 只清内存队列
 * —— 「停止」不会把它翻成「已取消」。这里断的是命令消息真的发出去并落库,
 * 与 tasks.spec.ts「不依赖真实执行器」同口径。
 */
test("停止命令:二次确认 → 取消不发送 → 确认后广播命令消息落库", async ({
  page,
  request,
}) => {
  const localUser = await localUserParticipantId(request);
  const group = await createGroup(
    request,
    uniqueName("e2e-cmd-group"),
    localUser,
  );
  const executor = await registerParticipant(
    request,
    uniqueName("e2e-cmd-executor"),
  );
  // 触发消息 + queued 任务经 API 注入:UI 里造任务要靠真实执行器派发,过重。
  const trigger = await postMessage(
    request,
    group.id,
    uniqueName("e2e-cmd-brief"),
    localUser,
  );
  const task = await createTask(
    request,
    group.id,
    trigger.id,
    executor.id,
    localUser,
  );

  await page.goto(`/groups/${group.id}`);

  // 桌面视口(1280)两栏默认选中最新需求 → 详情区直接渲染该任务卡片和「停止」
  // 按钮,无需点选。任务不带 specRef 时自己独立成一条需求(分组键 = 任务 id,
  // 见 tasks.spec.ts 说明)。
  const stopButton = page.getByTestId(`task-stop-${task.id}`);
  await expect(stopButton).toBeVisible();

  // R3:确认文案指名任务(短号)、当前状态、后果。R1/R2:取消 → 不发消息。
  // 用 waitForEvent 而不是 page.once + 变量,避免「弹窗回调与 click 的先后」
  // 竞争;注册了监听器就必须自己 accept/dismiss(否则 click 永远不返回)。
  const cancelDialog = page.waitForEvent("dialog");
  const cancelClick = stopButton.click();
  const dialog = await cancelDialog;
  expect(dialog.message()).toContain(task.id.slice(0, 8));
  expect(dialog.message()).toContain("排队中");
  expect(dialog.message()).toContain("不会执行");
  await dialog.dismiss();
  await cancelClick;

  const afterCancel = await listMessages(request, group.id);
  expect(afterCancel.some((m) => m.body.startsWith("停止"))).toBe(false);

  // 确认 → 发出 broadcast 命令消息「停止 <taskId>」,发送者是 Local User。
  const acceptDialog = page.waitForEvent("dialog");
  const acceptClick = stopButton.click();
  await (await acceptDialog).accept();
  await acceptClick;

  await expect
    .poll(async () => {
      const messages = await listMessages(request, group.id);
      return messages.some(
        (m) => m.body === `停止 ${task.id}` && m.senderId === localUser,
      );
    })
    .toBe(true);

  // 请求已结算:按钮从「发送中…」回到「停止」(发送成功与否由上面的落库
  // 断言判定 —— 需求视图里 sendCommand 的错误态目前没有渲染出口)。
  await expect(stopButton).toHaveText("停止");
});
