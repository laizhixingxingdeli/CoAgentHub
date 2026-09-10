import { expect, test } from "@playwright/test";
import {
  createGroup,
  createTask,
  postMessage,
  registerParticipant,
  uniqueName,
} from "./helpers";

/**
 * 核心路径 6:任务面板。
 * 不依赖真实执行器(E2E 不跑外部任务):先断言空态,再用 API 直接 POST 建
 * queued 任务(经页面操作造任务过重),断言面板显示该任务且非「已完成」。
 *
 * 身份:浏览器一律以服务端建的「Local User」身份访问(2026-08-24 起),
 * 用例里 registerParticipant 造的 participant 只用于 API 侧的群属主/执行者,
 * 不影响页面身份。
 */
test("任务面板:空态 + API 注入 queued 任务后显示", async ({
  page,
  request,
}) => {
  const owner = await registerParticipant(
    request,
    uniqueName("e2e-task-owner"),
  );
  const group = await createGroup(
    request,
    uniqueName("e2e-task-group"),
    owner.id,
  );

  await page.goto(`/groups/${group.id}`);

  // 任务面板不再是右栏的一个 Tab —— context-tab-tasks / tasks-tab 这两个
  // testid 全仓已不存在。现在群页面渲染 RequirementWorkspace,它在
  // requirements.length === 0 时直接回退渲染 TaskPanel
  // (requirement-workspace.tsx:894),而本用例经 API 建的任务不带 specRef,
  // 凑不成需求,所以 TaskPanel 一直是当前视图,无需任何 Tab 切换。
  // 空态:暂无任务
  await expect(page.getByText("暂无任务")).toBeVisible();

  // API 注入:一条触发消息 + 一个 queued 任务(执行者用另一个 participant)
  const executor = await registerParticipant(
    request,
    uniqueName("e2e-executor"),
  );
  const msg = await postMessage(
    request,
    group.id,
    uniqueName("e2e-task-msg"),
    owner.id,
  );
  const task = await createTask(
    request,
    group.id,
    msg.id,
    executor.id,
    owner.id,
  );
  // 真实 server 会立即调度(可能 queued 或已 running),两种都算任务面板可显示
  expect(["queued", "running"]).toContain(task.status);

  // 重新加载(重新拉取),断言面板出现该任务 + 非「已完成」状态。
  //
  // 注意断的是 requirement-row 而不是 task-row:任务一旦存在,
  // RequirementWorkspace 就不再走 TaskPanel 回退了 —— group-tasks-by-spec.ts
  // 把 specRef 为 null 的任务「各自独立成一条需求」(分组键 = 任务自身 id,
  // 见 :353 与 :372),于是 requirements.length 变成 1,视图切到需求列表。
  // 因为分组键就是 task.id,requirement-row 的 testid 与任务 id 一致。
  await page.reload();
  const row = page.getByTestId(`requirement-row-${task.id}`);
  await expect(row).toBeVisible();
  await expect(row).not.toContainText("已完成");
});
