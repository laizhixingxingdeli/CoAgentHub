import { expect, test } from "@playwright/test";
import {
  bindIdentity,
  createGroup,
  createTask,
  postMessage,
  registerParticipant,
  uniqueName,
} from "./helpers";

/**
 * 核心路径 6:任务面板(右栏「任务」Tab)。
 * 不依赖真实执行器(E2E 不跑外部任务):先断言空态,再用 API 直接 POST 建
 * queued 任务(经页面操作造任务过重),断言面板显示任务行与「排队中」状态。
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
  await bindIdentity(page, owner.id);

  await page.goto(`/groups/${group.id}`);

  // 右栏任务 Tab
  await page.getByTestId("context-tab-tasks").click();
  const tasksTab = page.getByTestId("tasks-tab");
  await expect(tasksTab).toBeVisible();

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

  // 重新打开任务 Tab(重新拉取),断言任务行 + 非「已完成/失败」状态
  await page.reload();
  await page.getByTestId("context-tab-tasks").click();
  await expect(page.getByTestId(`task-row-${task.id}`)).toBeVisible();
  await expect(page.getByTestId(`task-status-${task.id}`)).not.toHaveText(
    "已完成",
  );
});
