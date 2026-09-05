/**
 * queued 任务周期兜底(specs/queued-task-never-picked-up-after-chain-failure.md
 * R1/R2/R3)。
 *
 * 背景:协调链条中途失败(或进程重启)后,子任务停在 `queued` 且**不在任何
 * 进程的内存队列里** —— 队列泵只看内存队列,于是它长时间静默滞留(实测
 * 5 小时)。`queue.ts` 里「queued 是本 server 自己入过队的」这个假设,在链条
 * 断掉或进程重启后不成立。
 *
 * 本模块周期性扫描 DB 的 queued 行:
 *  - R1 补回队列:本进程内存里没有对应 run 的 queued 任务,按既有入队路径
 *    (enqueueTaskRun)补回去 —— 拾起时延有界(一个扫描周期),不再依赖
 *    「是否由当前进程入过内存队列」。
 *  - R2 原因可见:每个 queued 任务记录「现在为什么不会被拾起」(槽位/冷却/
 *    执行方缺失)到 diffSummary.queuedBlocked,任务 API 原样透出。
 *  - R3 兜底回收:入队停留超过 stallAlertMinutes 仍未 spawn → 按 stall 处置
 *    (复用 stallAlerted 警示标记 + ⚠️ 群公告),并定向交回本群协调者。
 *
 * 不涉及(spec §5):不改 maxConcurrentPerWorkspace 与工作树互斥语义,不改
 * 冷却/限流处置 —— 补回队列的任务与普通派发走同一条 pump / 派发判定口径,
 * 只多了「补进队列」这一步。
 */

import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { findExecutorByKey } from "@server/lib/executors";
import { insertGroupMessage } from "@server/lib/services/message-service";
import { wsHub } from "@server/lib/ws-hub";
import { and, eq } from "drizzle-orm";
import { postStatus } from "./notify";
import { enqueueTaskRun, queuedBlockReason } from "./queue";
import { activeRuns, getStallAlertMs, groupQueues } from "./state";
import {
  asDiffSummaryRecord,
  preserveDispatchKindNote,
  preserveRollbackSkipped,
  type QueuedRun,
} from "./types";

/** 回收周期(默认 10s,与孤儿收敛同量级;测试可注入更短间隔)。 */
export const QUEUED_RECLAIM_INTERVAL_MS = 10_000;

/**
 * 补建宽限期(ms):发布不足这么久的 queued 任务不补建(R1 的重复登记守卫)。
 *
 * 为什么需要它:正常派发是「先插 task 行(status=queued)→ 再推入内存队列」
 * 两步,窗口里的任务在 DB 上已经是 queued 但内存里还没有 run —— 回收扫描若
 * 正好落在这两步之间,会为同一个任务再建一个 run,于是它被**执行两次**。
 *
 * ADR-0009:本判据拿「发布距今已超过宽限期」代替「这个进程不会再为它建 run」;
 * 前提是派发登记(insert → push,几个 DB 往返)远快于宽限期。不成立的情形是
 * DB 抖动让登记卡在窗口内超过 30s —— 那时派发链路本身已经不可用,而落到窗口
 * 外的重复登记由 runOne 的同 taskId 守卫拦下并发的那一种(两个 run 同时被泵
 * 送出队),串行落到窗口外时该任务会被执行两次,这是本机制已记录的边界。
 */
export const QUEUED_RECLAIM_GRACE_MS = 30_000;

/** startQueuedTaskReclaim 的显式开关:enabled=false 时不注册定时器(测试环境
 *  注入,避免后台扫描在测试运行期间抢跑排队任务);缺省 = 生产默认路径自动启动。 */
export interface StartQueuedReclaimOptions {
  enabled?: boolean;
}

/** 单轮回收结果。 */
export interface QueuedReclaimResult {
  /** 本轮补回内存队列的任务数(R1)。 */
  reclaimed: number;
  /** 本轮新发出的滞留告警数(R3;同一个任务只告警一次)。 */
  stalled: number;
}

type TaskRow = typeof taskTable.$inferSelect;

/**
 * 单轮兜底扫描。三个动作按 R1 → R2 → R3 顺序执行:先补回队列,紧接着就能
 * 为补回来的任务判定「为什么不被拾起」(否则要等下一轮才可见)。
 */
export async function reclaimQueuedTasks(
  db: DataBase,
  now = new Date(),
): Promise<QueuedReclaimResult> {
  // 老任务优先:滞留最久的先补回,避免新任务持续插队把老孤儿挤到最后。
  const rows = await db.query.task.findMany({
    where: (t, { eq: eqFn }) => eqFn(t.status, "queued"),
    orderBy: (t, { asc: ascFn }) => [ascFn(t.createdAt)],
  });

  let reclaimed = 0;
  for (const row of rows) {
    if (findInMemoryRun(row.id)) continue;
    // 宽限期内不补建:避开派发「插行 → 入内存队列」的窗口(见
    // QUEUED_RECLAIM_GRACE_MS),否则同一个任务会有两个 run、被执行两次。
    if (now.getTime() - row.createdAt.getTime() < QUEUED_RECLAIM_GRACE_MS) {
      continue;
    }
    if (await admitQueuedTask(db, row, now)) reclaimed += 1;
  }

  for (const group of groupQueues.values()) {
    for (const run of group.queue) await recordQueuedBlocked(run, now);
  }

  let stalled = 0;
  for (const row of rows) {
    // 派发条件已经满足的任务不算滞留:泵随后(或已经)把它取走,告警只是噪音。
    // 判定复用 queuedBlockReason —— 阻塞中的(冷却/槽位/队列位次)才告警。
    const run = findInMemoryRun(row.id);
    if (run && queuedBlockReason(run) === null) continue;
    if (await alertQueuedStall(db, row, now)) stalled += 1;
  }
  return { reclaimed, stalled };
}

/** 周期性 queued 兜底(server 启动时注册);返回停止函数(测试用)。 */
export function startQueuedTaskReclaim(
  db: DataBase,
  intervalMs = QUEUED_RECLAIM_INTERVAL_MS,
  options: StartQueuedReclaimOptions = {},
): () => void {
  if (options.enabled === false) {
    return () => {};
  }
  const timer = setInterval(() => {
    void reclaimQueuedTasks(db).catch((error) => {
      console.warn(`[queued-reclaim] 回收扫描失败: ${error}`);
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/* ---------------- R1:补回队列 ---------------- */

/** 本进程内存中是否已有该任务的 run(排队中 / 运行中 / 已出队未 spawn)。 */
function findInMemoryRun(taskId: string): QueuedRun | undefined {
  for (const group of groupQueues.values()) {
    const hit =
      group.queue.find((run) => run.taskId === taskId) ??
      group.running.find((run) => run.taskId === taskId);
    if (hit) return hit;
  }
  for (const run of activeRuns) {
    if (run.taskId === taskId) return run;
  }
  return undefined;
}

/**
 * 把一个「DB 里 queued 但本进程内存中没有」的任务补回队列(R1)。
 *
 * 结构性不可派发(查无执行器配置 / 任务没有执行方)时不补回,并按 R2 记录
 * 原因 —— 静默排队正是本票要消灭的状态,查不出执行方的任务必须留痕而不是
 * 悄悄跳过。返回是否补回成功。
 */
async function admitQueuedTask(
  db: DataBase,
  task: TaskRow,
  now: Date,
): Promise<boolean> {
  const executorKey = task.executorKey;
  const target = task.executorParticipantId;
  const ex = executorKey ? await findExecutorByKey(db, executorKey) : undefined;
  if (!ex || !target) {
    await writeQueuedDiffSummary(db, task.groupId, task.id, task.diffSummary, {
      queuedBlocked: {
        code: "executor-missing",
        reason: !target
          ? "任务没有执行方 participant,无法派发"
          : `执行方 ${executorKey} 不在执行器配置中,无法派发`,
        at: now.toISOString(),
      },
    });
    return false;
  }
  // 群内分工只影响任务书内容,缺失不影响派发(与 dispatchTask 同口径:
  // 成员行查不到 → groupPrompt = null)。
  const membership = await db.query.groupMember.findFirst({
    where: (t, { and: andFn, eq: eqFn }) =>
      andFn(eqFn(t.groupId, task.groupId), eqFn(t.participantId, target)),
    columns: { roles: true, prompt: true },
  });
  await enqueueTaskRun(db, task, {
    groupId: task.groupId,
    messageId: task.messageId,
    participantId: target,
    ex,
    body: task.brief ?? "",
    groupPrompt: membership
      ? { roles: membership.roles, prompt: membership.prompt }
      : null,
    specRef: task.specRef,
    specHash: task.specHash,
  });
  return true;
}

/* ---------------- R2:不可拾起的原因可见 ---------------- */

/**
 * 把 run 当前「为什么不会被拾起」写进 diffSummary.queuedBlocked(R2)。
 *
 * 判定来自 queue.queuedBlockReason(与泵同源),本函数只负责落库:
 *  - 原因码未变 → 不刷写(周期 10s,否则每轮一次写且首次观察时刻被冲掉);
 *  - 变为可派发 / 任务已不在队列 → 清掉旧标记,避免界面继续显示过期原因;
 *  - 条件更新(status 仍为 queued),不覆盖执行器并发写回的终态。
 */
async function recordQueuedBlocked(run: QueuedRun, now: Date): Promise<void> {
  const cur = await run.db.query.task.findFirst({
    where: and(
      eq(taskTable.id, run.taskId),
      eq(taskTable.groupId, run.groupId),
    ),
    columns: { diffSummary: true },
  });
  const prev = asDiffSummaryRecord(cur?.diffSummary) ?? {};
  const prevBlocked = asDiffSummaryRecord(prev.queuedBlocked);
  const reason = queuedBlockReason(run);
  if (reason === null) {
    if (prevBlocked === undefined) return;
    // 显式 undefined = 从合并底稿中删除该键(JSON.stringify 丢弃 undefined 键,
    // 落库后 queuedBlocked 消失)。不能只 delete —— writeQueuedDiffSummary 以
    // 既有摘要为底合并,缺键会被底稿原样补回,清空就永远不生效。
    const cleared: Record<string, unknown> = {
      ...prev,
      queuedBlocked: undefined,
    };
    await writeQueuedDiffSummary(
      run.db,
      run.groupId,
      run.taskId,
      cur?.diffSummary,
      cleared,
    );
    return;
  }
  if (prevBlocked?.code === reason.code) return;
  await writeQueuedDiffSummary(
    run.db,
    run.groupId,
    run.taskId,
    cur?.diffSummary,
    {
      ...prev,
      queuedBlocked: {
        code: reason.code,
        reason: reason.reason,
        // 首次观察到该原因的时刻;原因码变了才更新(同因期间保持首次值)。
        at: now.toISOString(),
      },
    },
  );
}

/* ---------------- R3:超阈值按 stall 处置 ---------------- */

/**
 * queued 停留超过 stallAlertMs 仍未 spawn → 告警并交回协调者(每个任务一次)。
 *
 * 滞留时长以**任务行 createdAt**(发布/入队时刻)为准,不能用内存 run 的
 * createdAt —— 后者是补回队列的时刻,补回来的老任务会因此永远算不出滞留。
 *
 * 落库复用既有的 stallAlerted 警示标记(任务面板黄标 + 群列表注意力),
 * 与 running 任务的无进展提醒同一套呈现:本票要的是「不静默」,不是新加一种
 * 告警样式。
 */
async function alertQueuedStall(
  db: DataBase,
  task: TaskRow,
  now: Date,
): Promise<boolean> {
  if (now.getTime() - task.createdAt.getTime() < getStallAlertMs()) {
    return false;
  }
  const cur = await db.query.task.findFirst({
    where: and(eq(taskTable.id, task.id), eq(taskTable.groupId, task.groupId)),
    columns: { status: true, diffSummary: true },
  });
  if (cur?.status !== "queued") return false;
  const summary = asDiffSummaryRecord(cur.diffSummary) ?? {};
  if (summary.queuedStallAlerted === true) return false;

  const minutes = Math.max(1, Math.round(getStallAlertMs() / 60_000));
  const blocked = asDiffSummaryRecord(summary.queuedBlocked)?.reason;
  const reasonText =
    typeof blocked === "string"
      ? blocked
      : "派发条件已满足但仍未启动(疑似调度遗漏)";
  await writeQueuedDiffSummary(db, task.groupId, task.id, cur.diffSummary, {
    stallAlerted: true,
    queuedStallAlerted: true,
    queuedStallAlertAt: now.toISOString(),
    queuedStallAlertMinutes: minutes,
  });
  void wsHub.broadcastTaskStallAlert(task.groupId, task.id);

  const sender = task.executorParticipantId;
  if (sender) {
    await postStatus(
      db,
      task.groupId,
      sender,
      { label: "平台队列兜底" },
      `⚠️ 任务 ${task.id} 入队已超过 ${minutes} 分钟仍未被拾起(${reasonText}),请协调者介入`,
    );
    await handBackToCoordinator(
      db,
      task.groupId,
      sender,
      task.id,
      minutes,
      reasonText,
    );
  }
  return true;
}

/**
 * R3「交回协调者」:按角色定向投递给本群 coordinator 成员。
 *
 * 为什么在 ⚠️ 群公告之外还要一条定向消息:群公告谁都看得见(不静默),但
 * 只有定向消息会进协调者的收件箱 —— 协调者才知道「这件事在等它决定」。
 *
 * 群内无 coordinator 成员时不投递:凭空造收件人等于让平台替协调者做决定,
 * 此时的兜底只有群公告(不静默这一条已经满足)。
 */
async function handBackToCoordinator(
  db: DataBase,
  groupId: string,
  senderId: string,
  taskId: string,
  minutes: number,
  reasonText: string,
): Promise<void> {
  const members = await db.query.groupMember.findMany({
    where: (t, { eq: eqFn }) => eqFn(t.groupId, groupId),
    columns: { roles: true },
  });
  if (!members.some((member) => member.roles.includes("coordinator"))) return;
  try {
    const full = await insertGroupMessage(db, {
      groupId,
      senderId,
      parentId: null,
      audience: "role",
      audienceRef: "coordinator",
      body: `⚠️ 队列兜底:任务 ${taskId} 入队已超过 ${minutes} 分钟仍未被拾起(${reasonText}),请协调者决定重派或取消。`,
      contentType: "task_status",
      fileRef: null,
    });
    void wsHub.broadcastGroupMessage(full);
  } catch (e) {
    console.warn(`[queued-reclaim] 交回协调者失败(${taskId}): ${e}`);
  }
}

/* ---------------- 落库 ---------------- */

/**
 * 合并写入 queued 任务的 diffSummary:以既有内容为底,保留 dispatchKindNote /
 * rollbackSkipped 留痕,并且只在任务仍是 queued 时写(不覆盖并发写回的终态)。
 */
async function writeQueuedDiffSummary(
  db: DataBase,
  groupId: string,
  taskId: string,
  existing: unknown,
  next: Record<string, unknown>,
): Promise<void> {
  // 以既有摘要为底合并 next:同一条 diffSummary 上 R2/R3 先后落笔(同一轮扫描
  // 里先写 queuedBlocked 再写 stallAlerted),任何一步以 next 整体覆盖都会把
  // 前一步(或更早写入方)留下的键冲掉 —— R2/R3 必须并存,不是二选一。
  // 显式 undefined 的键 = 从底稿中删除(JSON.stringify 丢弃 undefined 键)。
  const base = asDiffSummaryRecord(existing) ?? {};
  let merged: Record<string, unknown> = { ...base, ...next };
  merged = preserveDispatchKindNote(existing, merged);
  merged = preserveRollbackSkipped(existing, merged);
  await db
    .update(taskTable)
    .set({ diffSummary: merged })
    .where(
      and(
        eq(taskTable.id, taskId),
        eq(taskTable.groupId, groupId),
        eq(taskTable.status, "queued"),
      ),
    );
}
