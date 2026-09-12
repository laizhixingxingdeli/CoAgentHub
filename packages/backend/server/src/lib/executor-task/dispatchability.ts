import {
  cooldownEndMs,
  formatEta,
  getMaxConcurrentPerWorkspace,
  getMaxParallelGroups,
  groupQueues,
  isInCooldown,
  runningExecutorCount,
  runningGroupCount,
  runningWorkspaceCount,
} from "./state";
import {
  DEFAULT_GROUP_KEY,
  type GroupQueue,
  type QueuedBlockReason,
  type QueuedRun,
} from "./types";

/**
 * 执行器侧不派发的原因(null = 可派发)。与拆分前的 isRunDispatchable 判定
 * 逐条同序、同条件:冷却 → 声明式并发上限 → 403 退避 → 403 反应式排队。
 *
 * 只覆盖 run 自身携带的门槛;组槽位/工作树闸/队列位次在 queuedBlockReason
 * 里按泵的选组谓词同源补齐(泵的选组谓词不在这里调用本函数之外的判定)。
 */
function runBlockReason(run: QueuedRun): QueuedBlockReason | null {
  if (isInCooldown(run.ex)) {
    return {
      code: "executor-cooldown",
      reason: `执行器 ${run.ex.label} 处于额度冷却,预计 ${formatEta(cooldownEndMs(run.ex))} 恢复`,
    };
  }
  const cap = run.ex.maxConcurrency;
  if (cap !== undefined && runningExecutorCount(run.ex.key) >= cap) {
    return {
      code: "executor-concurrency",
      reason: `执行器 ${run.ex.label} running 数已达并发上限 ${cap}`,
    };
  }
  const retryInMs = run.concurrencyRetryAt - Date.now();
  if (retryInMs > 0) {
    return {
      code: "concurrency-retry",
      reason: `执行器 ${run.ex.label} 并发冲突退避中,${Math.ceil(retryInMs / 1000)} 秒后重试`,
    };
  }
  if (run.concurrencyBlocked && runningExecutorCount(run.ex.key) > 0) {
    return {
      code: "concurrency-conflict",
      reason: `执行器 ${run.ex.label} 返回并发冲突,等待既有 running 任务终态后重试`,
    };
  }
  return null;
}

export function isRunDispatchable(run: QueuedRun): boolean {
  return runBlockReason(run) === null;
}

/**
 * queued 任务「当前为什么不会被拾起」的判定(R2 可见性的唯一出处,
 * specs/queued-task-never-picked-up-after-chain-failure.md R2)。
 *
 * ADR-0009:本函数**不新增**任何判定,三条门槛全部复用泵的同一组计数 ——
 * 泵选组谓词里的 `runningForWorkspace(g) < workspaceCap(g.key)`、泵循环的
 * `runningGroupCount() >= getMaxParallelGroups()` 退出条件,以及
 * isRunDispatchable 的判定本体(runBlockReason)。「另写一套是否被阻塞」必然
 * 在某个输入上与泵分叉,而分叉时没人在看。
 *
 * 与认领超时豁免(workspaceGateBlocked)的口径差异是**故意**的:豁免只豁免
 * 「工作树闸」这一个事实,默认组的组内单槽是另一套既有机制;而可见性要回答
 * 的是「它现在为什么没在跑」,默认组队首被本组 running 占住同样是答案 ——
 * 所以这里直接用泵的谓词(对默认组与非默认组同式),不复用豁免函数。
 *
 * 顺序:执行器侧(最具体、最可操作)→ 组槽位 → 本组槽位 → 队列位次。
 */
export function queuedBlockReason(run: QueuedRun): QueuedBlockReason | null {
  const executorSide = runBlockReason(run);
  if (executorSide) return executorSide;
  const group = groupQueues.get(run.groupKey);
  if (!group) return null;
  const maxGroups = getMaxParallelGroups();
  if (runningGroupCount() >= maxGroups) {
    return {
      code: "group-slot",
      reason: `并行组数已达上限 ${maxGroups},等既有组释放槽位`,
    };
  }
  if (runningForWorkspace(group) >= workspaceCap(group.key)) {
    return group.key === DEFAULT_GROUP_KEY
      ? {
          code: "workspace-gate",
          reason: "默认组单槽:本组有任务正在执行",
        }
      : {
          code: "workspace-gate",
          reason: `工作树 ${group.key} running 数已达上限 ${workspaceCap(group.key)}`,
        };
  }
  const ahead = group.queue.indexOf(run);
  if (ahead > 0) {
    return {
      code: "queue-ahead",
      reason: `本组队列中它前面还有 ${ahead} 个任务`,
    };
  }
  return null;
}

/** 排队中(未开始)任务数;回滚指令前置校验用。groupId 缺省 = 跨全部组。 */
export function queuedExecutorTaskCount(groupId?: string): number {
  let n = 0;
  for (const g of groupQueues.values()) {
    for (const q of g.queue) {
      if (groupId && q.groupId !== groupId) continue;
      n += 1;
    }
  }
  return n;
}

/** 进程存活判定随其余共享状态收在 state.ts;此处转出保持既有导入路径可用。 */
export { isExecutorProcessAlive } from "./state";

/** 取(或建)指定组键的组队列;组键插入顺序即组触达顺序(公平轮转)。 */
export function ensureGroupQueue(key: string): GroupQueue {
  let g = groupQueues.get(key);
  if (!g) {
    g = { key, queue: [], running: [] };
    groupQueues.set(key, g);
  }
  return g;
}

/** 组(工作树)可同时运行的任务数上限:空 projectPath 的默认组不参与工作树闸,
 *  维持单槽(改动前行为);绑定 projectPath 的组按 maxConcurrentPerWorkspace。 */
export function workspaceCap(key: string): number {
  return key === DEFAULT_GROUP_KEY ? 1 : getMaxConcurrentPerWorkspace();
}

/** 工作树闸计数:未绑定 projectPath 的默认组沿用组内单槽,绑定项目按路径聚合。 */
export function runningForWorkspace(group: GroupQueue): number {
  return group.key === DEFAULT_GROUP_KEY
    ? group.running.length
    : runningWorkspaceCount(group.key);
}

/**
 * 任务是否被工作树闸合法阻塞(R1.1 豁免的唯一判定出处,ADR-0009 第 2 条):
 * 占用计数复用泵的同一组口径(runningForWorkspace / workspaceCap),不另写
 * 第二套「队列是否阻塞」判定。
 *
 * 被本判定命中的任务是被泵**合法**跳过的,不是被遗弃 —— 认领超时不得把它
 * 标 failed(spec multiple-coordinators-with-global-serialization R1.1)。
 * 反过来说,因其它原因排队的任务(并行组数上限、执行器冷却、403 退避)不受
 * 该豁免。
 *
 * ⚠️ 默认组(未绑 projectPath)的「组内单槽」不是工作树闸(spec R1:默认组不
 * 参与工作树闸,沿用 serial-dispatch-guard 既有口径)—— 它的排队任务被单槽
 * 阻塞**同样**走认领超时,不享受 R1.1 豁免:豁免只豁免「工作树闸」这一个
 * 事实,单槽是另一套既有机制,混入豁免会悄悄放宽默认组 30 分钟未认领的
 * 既有语义。
 */
export function workspaceGateBlocked(group: GroupQueue): boolean {
  if (group.key === DEFAULT_GROUP_KEY) return false;
  return runningForWorkspace(group) >= workspaceCap(group.key);
}
