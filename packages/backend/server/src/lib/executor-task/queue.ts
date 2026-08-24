/**
 * 执行器触发链路的队列核心(executor-task 拆分):入队 / 组调度(pump)/
 * 运行(runOne)/ 停止 / 超时处理(认领/静默/无进展/detached)/ 失败重试 /
 * 执行历史。导出接口与拆分前 @server/lib/executor-task 完全兼容
 * (barrel index.ts 汇总)。
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  type DispatchTargetAudit,
  type TaskAttempt,
  taskDispatchWarning as taskDispatchWarningTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import { runA2AExecutor } from "@server/lib/a2a-runner";
import { serverPort } from "@server/lib/config";
import type { DataBase } from "@server/lib/database";
import {
  createCheckpoint,
  type ExecutorRunResult,
  findRepoRoot,
  readTimeoutMs,
  resetToCheckpoint,
  runExecutor,
} from "@server/lib/executor-runner";
import {
  type ExecutorConfig,
  findExecutorByParticipant,
  parseRateLimitRecoveryMs,
  renderExecutorArgs,
} from "@server/lib/executors";
import { wsHub } from "@server/lib/ws-hub";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { createAnsiStripper } from "./ansi";
import { verifyReportedCommit } from "./claim-verification";
import {
  markTaskCancelled,
  notifyTaskStatusChanged,
  postStatus,
} from "./notify";
import {
  appendTaskOutput,
  releaseTaskOutput,
  taskOutputTail,
} from "./output-buffer";
import {
  findCommitHash,
  lastLinesOf,
  parseTaskReport,
  renderTaskCard,
  type TaskReport,
} from "./report";
import {
  clearRunTimers,
  cooldownEndMs,
  cooldownTimers,
  executorCooldowns,
  formatEta,
  getA2ASilenceTimeoutMs,
  getClaimTimeoutMs,
  getDetachedTimeoutMs,
  getMaxConcurrentPerWorkspace,
  getMaxParallelGroups,
  getRateLimitCooldownMs,
  getRetryPolicy,
  getStallAlertMs,
  getStallTimeoutMs,
  groupQueues,
  isInCooldown,
  isQuotaFailure,
  pumping,
  runningExecutorCount,
  runningGroupCount,
  runningWorkspaceCount,
  setPumping,
} from "./state";
import {
  DEFAULT_GROUP_KEY,
  DISPATCH_ALLOWED_ROLES,
  type DispatchExecutorInput,
  type GroupPromptInfo,
  type GroupQueue,
  type QueuedRun,
  sumAttemptTokenUsage,
} from "./types";

/** 为执行器启动失败补充能直接指向排查方向的提示。 */
function executorStartupFailureHint(bin: string, msg: string): string {
  const lowerMsg = msg.toLowerCase();

  if (
    lowerMsg.includes("unexpected argument") ||
    lowerMsg.includes("unrecognized") ||
    lowerMsg.includes("cannot be used with") ||
    lowerMsg.includes("invalid value")
  ) {
    return "；执行器参数配置可能与当前 CLI 版本不匹配，请核对 executors.ts 中的 args 配置";
  } else if (
    lowerMsg.includes("enoent") ||
    lowerMsg.includes("command not found")
  ) {
    return `；${bin} 可能未安装或不在 PATH，请用 which ${bin} 确认或填写绝对路径`;
  } else if (
    lowerMsg.includes("eacces") ||
    lowerMsg.includes("permission denied")
  ) {
    return `；${bin} 没有可执行权限，请检查文件的可执行位`;
  }

  return "";
}

export function formatExecutorStartupFailure(bin: string, msg: string): string {
  return `无法启动 ${bin} (${msg})${executorStartupFailureHint(bin, msg)}`;
}

/* ---------------- 额度感知调度(票7) ---------------- */

/**
 * 执行器进入额度冷却:记录冷却结束时间并调度到期泵送(冷却结束后 pumpQueue
 * 自动把等待中的任务派发出去,无需人工干预)。重复进入只重置结束时间与定时器
 * (定时器防堆积)。返回冷却结束时间(epoch ms)。
 *
 * endMs 为绝对到期时刻(冷却动态化):调用方先尝试从失败输出解析恢复时间
 * (parseRateLimitRecoveryMs),解析失败才回退 now + 固定冷却时长。
 */
function enterCooldown(ex: ExecutorConfig, endMs: number): number {
  const end = Math.max(Date.now() + 1, endMs);
  executorCooldowns.set(ex.key, end);
  const prev = cooldownTimers.get(ex.key);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(
    () => {
      // 竞态保护:冷却可能已被更新的 enterCooldown 重置/延长;只有本定时器仍是
      // 当前登记项时才清理,避免陈旧回调误删新冷却条目(提前解除冷却)。
      if (cooldownTimers.get(ex.key) !== timer) return;
      cooldownTimers.delete(ex.key);
      executorCooldowns.delete(ex.key);
      console.log(`[executor] 执行器 ${ex.key} 额度冷却结束,恢复派发`);
      void pumpQueue();
    },
    Math.max(1, end - Date.now()),
  );
  cooldownTimers.set(ex.key, timer);
  console.log(
    `[executor] 执行器 ${ex.key} 触发额度冷却,预计 ${formatEta(end)} 恢复`,
  );
  return end;
}

/* ---------------- 执行器级并发(设计修正:按执行器实际并发能力排队) ---------------- */

/** 403 后重试最小退避(ms):无既有 running 任务(外部会话占用)时防空转热循环。 */
const CONCURRENCY_RETRY_BACKOFF_MS = 3_000;

/**
 * 执行器是否返回并发冲突(`403 atomgit_session_concurrency_conflict`):AtomCode
 * 等执行器同一时间只能跑一个会话,并发时 CLI 以该错误退出。命中 → 不判任务
 * 失败,转为 queued,等既有 running 任务终态后自动重试(反应式排队)。
 * 大小写不敏感;匹配带 403 前缀或独立 token 两种写法。
 */
export function isConcurrencyConflict(text: string): boolean {
  return /403\s*atomgit_session_concurrency_conflict|atomgit_session_concurrency_conflict/i.test(
    text ?? "",
  );
}

/**
 * 组队首任务当前是否可派发(泵送选组谓词):
 *  - 执行器额度冷却中 → 否(票7,冷却结束定时器会再泵送);
 *  - 目标执行器 running 数 >= maxConcurrency(声明式上限)→ 否(保持 queued,
 *    等既有任务终态后由完成路径的泵送自动出队);
 *  - 403 后重新排队(反应式排队)→ 既有同执行器 running 任务未清空 → 否;
 *    退避窗口未过(外部会话占用)→ 否。
 */
function isRunDispatchable(run: QueuedRun): boolean {
  if (isInCooldown(run.ex)) return false;
  const cap = run.ex.maxConcurrency ?? Number.POSITIVE_INFINITY;
  if (runningExecutorCount(run.ex.key) >= cap) return false;
  if (run.concurrencyBlocked) {
    if (runningExecutorCount(run.ex.key) > 0) return false;
    if (Date.now() < run.concurrencyRetryAt) return false;
  }
  return true;
}

/* ---------------- 队列 / 调度 ---------------- */

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

/**
 * 重启兜底(server 启动时调用):把 DB 里 status=queued/running 且属于本
 * server 的任务(executor_key 非空)恢复为 failed(附原因 server-restart),
 * 不自动重跑。返回受影响行数。
 *
 * 只回收本 server 直接 spawn 的任务:双跑期桥也会建 running 任务(executor_key
 * 为空),若一并置 failed,同消息再次投递会被当作 failed 重新执行 → 与桥并行
 * 双跑。executor_key 非空 = server 自己登记的任务,重启后确认是孤儿。
 */
export async function recoverInterruptedTasks(db: DataBase): Promise<number> {
  const rows = await db
    .update(taskTable)
    .set({ status: "failed", diffSummary: { error: "server-restart" } })
    .where(
      and(
        inArray(taskTable.status, ["queued", "running"]),
        isNotNull(taskTable.executorKey),
      ),
    )
    .returning();
  if (rows.length > 0) {
    console.log(
      `[executor] 重启兜底:${rows.length} 个 queued/running 任务置为 failed (server-restart)`,
    );
    for (const row of rows) {
      await notifyTaskStatusChanged(db, row.id, row.groupId, "failed", row);
    }
  }
  return rows.length;
}

/** 当前运行中的任务(停止指令回传用);并行时可能有多个,返回第一个;无则 null。
 *  groupId 缺省 = 跨全部组;指定 = 只看该群。 */
export function currentRunningTask(groupId?: string): {
  taskId: string;
  participantId: string;
  ex: ExecutorConfig;
  kill: () => void;
} | null {
  for (const g of groupQueues.values()) {
    const r = g.running.find(
      (rr) => rr?.kill && (!groupId || rr.groupId === groupId),
    );
    if (r?.kill) {
      return {
        taskId: r.taskId,
        participantId: r.participantId,
        ex: r.ex,
        kill: r.kill,
      };
    }
  }
  return null;
}

/**
 * 协调任务的职责跨越一次 CLI 进程生命周期:目标 participant 在本群持有
 * coordinator 角色时,进程退出只代表协调者 runtime 暂时离开,不代表 task
 * 完成。角色来自 group_members 的实时关系,因此无需新增 task 字段或模式配置。
 */
async function isCoordinatorTask(
  db: DataBase,
  groupId: string,
  participantId: string,
): Promise<boolean> {
  const membership = await db.query.groupMember.findFirst({
    where: (t, { and: andFn, eq: eqFn }) =>
      andFn(eqFn(t.groupId, groupId), eqFn(t.participantId, participantId)),
    columns: { roles: true },
  });
  return membership?.roles.includes("coordinator") ?? false;
}

/**
 * 取消排队中的任务(停止指令专用):taskId 缺省 → 取消本群全部排队任务;指定 →
 * 仅取消本群匹配项。只处理排队中的任务(未 spawn,直接移出队列 + 置 cancelled)
 * 以及「已出队未 spawn」的过渡窗口任务(kill 句柄尚未就绪,置 stopped 后由
 * runOne 的 spawn 前 guard 取消);已真正运行的进程不受影响——进程组 kill 机制
 * (spawn detached + process.kill(-pid))保留给服务端自身的静默超时 / 执行超时
 * 兜底,不再由用户指令触发。返回所有被取消的任务信息(未命中 → 空数组)。
 */
export function cancelQueuedTasks(
  groupId: string,
  taskId?: string,
): Array<{
  taskId: string;
  participantId: string;
  ex: ExecutorConfig;
}> {
  const stopped: Array<{
    taskId: string;
    participantId: string;
    ex: ExecutorConfig;
  }> = [];

  for (const g of groupQueues.values()) {
    const remaining: QueuedRun[] = [];
    for (const q of g.queue) {
      if (q.groupId !== groupId) {
        remaining.push(q);
        continue;
      }
      if (taskId && q.taskId !== taskId) {
        remaining.push(q);
        continue;
      }
      stopped.push({
        taskId: q.taskId,
        participantId: q.participantId,
        ex: q.ex,
      });
      clearRunTimers(q);
      void markTaskCancelled(q.db, q.taskId, q.groupId, q.attempts);
    }
    g.queue.length = 0;
    g.queue.push(...remaining);

    // 已出队未 spawn 的过渡窗口(pump 已置 running、kill 句柄未就绪):
    // 置 stopped 标记,runOne 的 spawn 前 guard 会在真正启动前取消该任务——
    // 保证「停止指令已执行但任务照跑」不会发生在 spawn 前窗口。
    const r = g.running.find(
      (rr) =>
        !rr.kill && rr.groupId === groupId && (!taskId || rr.taskId === taskId),
    );
    if (r) {
      r.stopped = true;
      clearRunTimers(r);
      stopped.push({
        taskId: r.taskId,
        participantId: r.participantId,
        ex: r.ex,
      });
    }
  }
  return stopped;
}

/**
 * 触发入口(路由 fire-and-forget 调用,不 await):命中执行器配置则
 * 幂等建 task + 入队;不命中/无权限/桥已执行则静默返回。
 */
export async function maybeDispatchExecutorTask(
  db: DataBase,
  input: DispatchExecutorInput,
): Promise<void> {
  const {
    groupId,
    messageId,
    senderRoles,
    audienceRef,
    body,
    dispatcherParticipantId,
    dispatcherSessionId,
    selectionReason,
    specRef,
    specHash,
    dispatchKind,
    supersedesTaskId,
    callbackRef,
  } = input;

  // 与桥相同的角色门槛(下发门):非 coordinator/human/reviewer 不执行(桥侧也会拒绝)。
  if (
    !senderRoles.some((r) =>
      (DISPATCH_ALLOWED_ROLES as readonly string[]).includes(r),
    )
  ) {
    console.log(
      `[executor] 跳过:发送者角色 [${senderRoles.join(",")}] 无权限发布任务`,
    );
    return;
  }

  // audienceRef → participant → executor 配置(按 participant.executorKey 稳定绑定)。
  const participant = await db.query.participant.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.id, audienceRef),
  });
  if (!participant) {
    console.log(
      `[executor] 跳过:audienceRef ${audienceRef} 无对应 participant`,
    );
    return;
  }
  const ex = await findExecutorByParticipant(db, participant);
  if (!ex) {
    console.log(
      `[executor] 跳过:participant ${participant.name} 不在执行器配置中`,
    );
    return;
  }

  // 角色解绑后:查目标成员在本群的分工。角色必须无条件传入任务书模板;
  // prompt 仅是可选的展示信息,不能决定任务书采用哪份 skill。
  const membership = await db.query.groupMember.findFirst({
    where: (t, { and: andFn, eq: eqFn }) =>
      andFn(eqFn(t.groupId, groupId), eqFn(t.participantId, participant.id)),
  });
  const groupPrompt: GroupPromptInfo | null = membership
    ? { roles: membership.roles, prompt: membership.prompt }
    : null;

  await dispatchTask(db, {
    groupId,
    messageId,
    participantId: participant.id,
    ex,
    body,
    groupPrompt,
    dispatcherParticipantId,
    dispatcherSessionId,
    selectionReason: selectionReason ?? null,
    specRef,
    specHash,
    dispatchKind,
    supersedesTaskId,
    callbackRef,
  });
}

/** 幂等建 task(复用 POST /tasks 的 message_id 唯一逻辑)后入队。 */
async function dispatchTask(
  db: DataBase,
  opts: {
    groupId: string;
    messageId: string;
    participantId: string;
    ex: ExecutorConfig;
    body: string;
    groupPrompt: GroupPromptInfo | null;
    /** 任务下发者(Part A):见 DispatchExecutorInput。 */
    dispatcherParticipantId: string;
    /** 任务下发会话(Part A):见 DispatchExecutorInput。 */
    dispatcherSessionId: string | null;
    /** 调用方主动提供的目标选择理由;未提供时持久化为 null。 */
    selectionReason: string | null;
    /** 规范驱动下发:规范文档路径(任务书「关联规范」段用);null = 指令驱动。 */
    specRef: string | null;
    /** 规范文档版本哈希(任务书「关联规范」段用);无版本哈希为 null。 */
    specHash: string | null;
    /** 规范驱动下发类型:需求票或修复票;null = 指令驱动任务。 */
    dispatchKind: "requirement" | "fix" | null;
    /** 替代关系(R2):本任务替代 supersedesTaskId 所指的那次尝试;null = 无。 */
    supersedesTaskId: string | null;
    /** callback 路由信息(Part B):见 DispatchExecutorInput。 */
    callbackRef: {
      platform?: string;
      endpointRef?: string;
      sessionRef?: string;
    } | null;
  },
): Promise<void> {
  const {
    groupId,
    messageId,
    participantId,
    ex,
    body,
    groupPrompt,
    dispatcherParticipantId,
    dispatcherSessionId,
    selectionReason,
    specRef,
    specHash,
    dispatchKind,
    supersedesTaskId,
    callbackRef,
  } = opts;

  // A coordinator's detached task is the parent of the executor task it
  // dispatches. Pick the most recently updated running task in this group;
  // normal single-scheduler operation means there is at most one, while an
  // ambiguous state remains deterministic and never blocks dispatch.
  const parent = await db.query.task.findFirst({
    where: (t, { and: andFn, eq: eqFn }) =>
      andFn(
        eqFn(t.groupId, groupId),
        eqFn(t.executorParticipantId, dispatcherParticipantId),
        eqFn(t.status, "running"),
      ),
    orderBy: (t, { desc }) => [desc(t.updatedAt)],
    columns: { id: true },
  });

  const dispatchAudit = await buildDispatchTargetAudit(
    db,
    groupId,
    dispatcherParticipantId,
    { id: participantId, name: ex.agentName },
    selectionReason ?? null,
  );

  const [created] = await db
    .insert(taskTable)
    .values({
      groupId,
      messageId,
      parentTaskId: parent?.id ?? null,
      executorParticipantId: participantId,
      executorKey: ex.key,
      status: "queued",
      // 任务书快照:触发消息 body 的完整复制,消息后续编辑/删除不影响已触发任务。
      brief: body,
      // 规范驱动下发:task 行落库 specRef/specHash(任务书「关联规范」段 +
      // 详情/WS 事件透传的数据源;null = 指令驱动任务)。
      specRef,
      specHash,
      dispatchKind,
      // 替代关系(R2):本任务替代 supersedesTaskId 所指的那次尝试(null = 无)。
      supersedesTaskId,
      // 任务下发者信息(Part A):sender + 会话 id(仅 coordinator/human 非执行器
      // 发送者的 metadata;否则 null)。body 绝不注入任何 session 元数据。
      dispatcherParticipantId,
      dispatcherSessionId,
      dispatchAudit,
      // callback 路由信息(Part B):仅允许 { platform?, endpointRef?, sessionRef? }
      // 三个短字符串(≤200 字符),不得存 URL/token/命令/secret。null = 无 callback。
      callbackRef,
    })
    .onConflictDoNothing({ target: taskTable.messageId })
    .returning();

  const task = created ?? (await findTaskByMessage(db, messageId));
  if (!task) {
    console.error(`[executor] task 登记失败(messageId=${messageId})`);
    return;
  }
  if (!created) {
    // 桥(或本 server 先前一次触发)已登记该消息:running/done 跳过(避免
    // 双跑);queued 是本 server 自己入过队的,同样跳过;failed/cancelled
    // 视为可重新执行。
    if (
      task.status === "running" ||
      task.status === "done" ||
      task.status === "queued"
    ) {
      console.log(
        `[executor] 跳过 spawn:task ${task.id} 已存在且状态 ${task.status}(桥可能已在执行)`,
      );
      return;
    }
    console.log(`[executor] 既有 task ${task.id} 状态 ${task.status},重新执行`);
  } else {
    // 任务创建(queued)→ WS 推送:插件/前端免轮询感知任务入队。
    await notifyTaskStatusChanged(db, task.id, groupId, "queued", created);
    if (dispatchAudit.selfDispatch) {
      await createTaskDispatchWarnings(
        db,
        groupId,
        task.id,
        dispatcherParticipantId,
      );
    }
  }

  const summary = summaryOf(body);

  // 任务 → 组:查群 project_path 作为组键;project_path 为空(null)的群任务归
  // 默认组(独立组,组内串行、可与有项目的组并行)。
  const groupRow = await db.query.groups.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.id, groupId),
  });
  const projectPath = groupRow?.projectPath?.trim() || null;
  const groupKey = projectPath ?? DEFAULT_GROUP_KEY;
  const group = ensureGroupQueue(groupKey);

  // 排队位置:同工作树 running(1)+ 同工作树排队数(工作树闸:同一 projectPath
  // 并行上限 maxConcurrentPerWorkspace,缺省 1 = 与改动前一致的组内串行);
  // 组未运行但槽位已被其他组占满时,还要等当前运行中的组先释放槽位。执行器级
  // 并发上限(设计修正):目标执行器 running 数已达 maxConcurrency 时,本任务即使
  // 组槽位空闲也会排队 → 📋 排队提示照常回传(「前面还有」计入执行器级先行任务
  // 数,避免插件/前端误以为已下发)。
  const running = runningGroupCount();
  const freeSlots = getMaxParallelGroups() - running;
  const exCap = ex.maxConcurrency;
  // exAhead 只统计目标执行器「在其他组」里正在跑的任务:runningExecutorCount
  // 会累加所有组,但本组正在跑的任务已被上面的工作树先行数计入,需在此排除,
  // 否则同项目+同执行器场景下该任务被重复计数(算出 2 而非 1)。
  const exSelfRunning = group.running.filter((r) => r.ex.key === ex.key).length;
  const exAhead =
    exCap !== undefined && runningExecutorCount(ex.key) >= exCap
      ? Math.max(0, runningExecutorCount(ex.key) - exSelfRunning)
      : 0;
  // 工作树先行数:本组(工作树)running + 已排队,超出并行上限的部分才算真正
  // 排在前面;缺省 1 时与改动前一致(running 1 + queue N → 前面还有 N+1)。
  const wsCap = workspaceCap(groupKey);
  const wsAhead = Math.max(
    0,
    group.running.length + group.queue.length - (wsCap - 1),
  );
  const ahead =
    wsAhead +
    (group.running.length > 0 || freeSlots > 0 ? 0 : running) +
    exAhead;
  if (ahead > 0) {
    // 只有真正排队才回传 📋(与桥一致)。
    await postStatus(
      db,
      groupId,
      participantId,
      ex,
      `📋 [${ex.label}] 任务已排队(前面还有 ${ahead} 个): ${summary}`,
    );
  }

  const run: QueuedRun = {
    db,
    groupId,
    messageId,
    taskId: task.id,
    participantId,
    ex,
    body,
    summary,
    groupPrompt,
    groupKey,
    projectPath,
    kill: null,
    stopped: false,
    // 认领超时起点:入队时刻(重新执行的任务也以本次入队为准,与 DB
    // created_at 解耦——DB 时间是首次发布,重试场景会误判超时)。
    createdAt: Date.now(),
    runningAt: null,
    lastOutputAt: 0,
    lastActivityAt: 0,
    claimTimer: null,
    stallTimer: null,
    stallAlertTimer: null,
    a2aSilenceTimer: null,
    detachedTimer: null,
    stalled: false,
    stallAlerted: false,
    a2aSilenced: false,
    detached: false,
    detachedTimedOut: false,
    retryCount: 0,
    checkpointRef: null,
    // 规范驱动下发:随任务书「关联规范」段写入 ticket;null = 指令驱动任务。
    specRef,
    specHash,
    // 403 反应式排队标记:默认未阻塞(显式 maxConcurrency 由 pump 直接排队,
    // 不会置位本标记;收到执行器 403 并发冲突后才置位)。
    concurrencyBlocked: false,
    concurrencyRetryAt: 0,
    // 执行历史:沿用 DB 既有 attempts(重新执行的任务保留旧尝试,新 attempt 续接)。
    attempts: Array.isArray(task.attempts) ? task.attempts : [],
  };
  group.queue.push(run);

  // 额度冷却中入队的任务(票7):标记「等待执行器额度恢复」+ ⏳ 回传,不 spawn
  // (泵送跳过冷却执行器,冷却结束定时器会自动派发,任务保持 queued 等待)。
  if (isInCooldown(ex)) {
    const eta = formatEta(cooldownEndMs(ex));
    try {
      await db
        .update(taskTable)
        .set({ diffSummary: { waiting: `等待执行器额度恢复(预计 ${eta})` } })
        .where(and(eq(taskTable.id, task.id), eq(taskTable.groupId, groupId)));
    } catch (e) {
      console.warn(`[executor] 写等待恢复标记失败(${task.id}): ${e}`);
    }
    await postStatus(
      db,
      groupId,
      participantId,
      ex,
      `⏳ [${ex.label}] 任务等待执行器额度恢复(预计 ${eta}): ${summary}`,
    );
  }

  // 认领超时定时器:超过 claimTimeoutMs 仍未进入 running → 标 failed。
  // 进入 running 时(runOne)取消;任务出队/停止时同步清理。
  run.claimTimer = setTimeout(
    () => handleClaimTimeout(run),
    getClaimTimeoutMs(),
  );
  void pumpQueue();
}

/**
 * Capture the server-observable target choice at dispatch time. Candidate
 * means a different group member with executor role and a configured executor;
 * the caller's reasoning is intentionally never inferred from message text.
 */
async function buildDispatchTargetAudit(
  db: DataBase,
  groupId: string,
  dispatcherParticipantId: string,
  target: { id: string; name: string },
  selectionReason: string | null,
): Promise<DispatchTargetAudit> {
  const members = await db.query.groupMember.findMany({
    where: (t, { eq: eqFn }) => eqFn(t.groupId, groupId),
  });
  const candidateMemberIds = members
    .filter(
      (member) =>
        member.participantId !== dispatcherParticipantId &&
        member.roles.includes("executor"),
    )
    .map((member) => member.participantId);
  const participants = candidateMemberIds.length
    ? await db.query.participant.findMany({
        where: (t, { inArray: inArrayFn }) =>
          inArrayFn(t.id, candidateMemberIds),
      })
    : [];
  const configuredCandidates = (
    await Promise.all(
      participants.map(async (participant) => ({
        participant,
        executor: await findExecutorByParticipant(db, participant),
      })),
    )
  )
    .filter(
      (
        entry,
      ): entry is {
        participant: (typeof participants)[number];
        executor: ExecutorConfig;
      } => entry.executor !== undefined,
    )
    .map((entry) => entry.participant)
    .sort((a, b) => a.name.localeCompare(b.name));
  const candidateIds = configuredCandidates.map(
    (participant) => participant.id,
  );
  const candidateTasks = candidateIds.length
    ? await db.query.task.findMany({
        where: (t, { and: andFn, eq: eqFn, inArray: inArrayFn }) =>
          andFn(
            eqFn(t.groupId, groupId),
            inArrayFn(t.executorParticipantId, candidateIds),
          ),
        columns: {
          executorParticipantId: true,
          status: true,
          updatedAt: true,
        },
        orderBy: (t, { desc: descFn }) => [descFn(t.updatedAt)],
      })
    : [];
  const tasksByCandidate = new Map<string, typeof candidateTasks>();
  for (const task of candidateTasks) {
    const tasks = tasksByCandidate.get(task.executorParticipantId) ?? [];
    tasks.push(task);
    tasksByCandidate.set(task.executorParticipantId, tasks);
  }

  return {
    dispatcherParticipantId,
    targetParticipantId: target.id,
    targetParticipantName: target.name,
    selfDispatch: dispatcherParticipantId === target.id,
    candidates: configuredCandidates.map((participant) => {
      const tasks = tasksByCandidate.get(participant.id) ?? [];
      const latest = tasks[0];
      return {
        participantId: participant.id,
        participantName: participant.name,
        status: tasks.some((task) => task.status === "running")
          ? "running"
          : latest?.status === "failed"
            ? "recently_failed"
            : "available",
      };
    }),
    selectionReason,
  };
}

/** Persist and announce a dispatch audit warning without changing dispatch. */
export async function createTaskDispatchWarnings(
  db: DataBase,
  groupId: string,
  taskId: string,
  dispatcherParticipantId: string,
): Promise<void> {
  const members = await db.query.groupMember.findMany({
    where: (t, { eq: eqFn }) => eqFn(t.groupId, groupId),
    columns: { participantId: true, roles: true },
  });
  const reviewers = members
    .filter((member) => member.roles.includes("reviewer"))
    .map((member) => member.participantId);
  // Two-layer groups have no reviewer; retain a warning in the dispatcher’s
  // own inbox so the audit remains visible instead of silently disappearing.
  const recipients =
    reviewers.length > 0 ? reviewers : [dispatcherParticipantId];
  await db
    .insert(taskDispatchWarningTable)
    .values(
      recipients.map((recipientParticipantId) => ({
        taskId,
        groupId,
        recipientParticipantId,
      })),
    )
    .onConflictDoNothing();
  await wsHub.broadcastTaskDispatchWarningAvailable(
    groupId,
    taskId,
    recipients,
  );
}

/** 取(或建)指定组键的组队列;组键插入顺序即组触达顺序(公平轮转)。 */
function ensureGroupQueue(key: string): GroupQueue {
  let g = groupQueues.get(key);
  if (!g) {
    g = { key, queue: [], running: [] };
    groupQueues.set(key, g);
  }
  return g;
}

/**
 * 泵调度:组槽位有空闲时,按组触达顺序取「running 未达工作树上限且未运行满
 * 组内配额」的组,运行其队首(工作树闸:同一 projectPath 并行数 ≤
 * maxConcurrentPerWorkspace,缺省 1 = 组内串行;projectPath 为空的默认组始终
 * 单槽;执行器级并发上限与 403 反应式排队由 isRunDispatchable 在选组时统一
 * 判定,不满足条件的组队首保持 queued)。并行组数 ≤ maxParallelGroups,=1 时
 * 退化为全局串行(原行为)。完成回调在 finally 里再泵,无需在此 await。
 */
async function pumpQueue(): Promise<void> {
  if (pumping) return;
  setPumping(true);
  try {
    for (;;) {
      if (runningGroupCount() >= getMaxParallelGroups()) break;
      // 额度冷却 / 执行器并发上限 / 403 反应式排队中的执行器不派发:组队首
      // 任务不满足派发条件 → 跳过该组(任务保持 queued;既有 running 任务终态
      // 或退避定时器会再次泵送自动派发)。
      const group = [...groupQueues.values()].find(
        (g) =>
          runningForWorkspace(g) < workspaceCap(g.key) &&
          g.queue.length > 0 &&
          isRunDispatchable(g.queue[0]),
      );
      if (!group) break;
      const run = group.queue.shift();
      // find 谓词保证 queue 非空,此处不可能为 undefined(防御性判空)。
      if (!run) break;
      group.running.push(run);
      void runOne(run, group);
    }
  } finally {
    setPumping(false);
  }
}

/** 组(工作树)可同时运行的任务数上限:空 projectPath 的默认组不参与工作树闸,
 *  维持单槽(改动前行为);绑定 projectPath 的组按 maxConcurrentPerWorkspace。 */
function workspaceCap(key: string): number {
  return key === DEFAULT_GROUP_KEY ? 1 : getMaxConcurrentPerWorkspace();
}

/** 工作树闸计数:未绑定 projectPath 的默认组沿用组内单槽,绑定项目按路径聚合。 */
function runningForWorkspace(group: GroupQueue): number {
  return group.key === DEFAULT_GROUP_KEY
    ? group.running.length
    : runningWorkspaceCount(group.key);
}

/** 运行单个组任务:queued → running → spawn → done/failed → 清槽位 → 泵下一个。 */
async function runOne(run: QueuedRun, group: GroupQueue): Promise<void> {
  const { db, groupId, taskId, participantId, ex, body, summary, groupPrompt } =
    run;

  try {
    // 停止指令可能在 spawn 前到达(kill 句柄尚未就绪):标记 stopped 后
    // 在此中止,不再 spawn,直接置 cancelled。
    if (run.stopped) {
      console.log(`[executor] 任务已在 spawn 前被停止: ${taskId}`);
      clearRunTimers(run);
      await markTaskCancelled(db, taskId, groupId, run.attempts);
      return;
    }

    // 进入 running = 任务被认领:取消认领超时定时器,记录认领时刻。
    if (run.claimTimer) {
      clearTimeout(run.claimTimer);
      run.claimTimer = null;
    }
    // 新一轮执行:清除 403 反应式排队标记(pump 在退避/既有任务终态后重新派发
    // 了本任务,本次若再次收到 403 会由 handleConcurrencyConflict 重新置位)。
    run.concurrencyBlocked = false;
    run.concurrencyRetryAt = 0;
    run.runningAt = Date.now();

    // queued → running(尽力而为;失败不阻塞执行,终态仍会回写)。
    try {
      const [updated] = await db
        .update(taskTable)
        .set({ status: "running" })
        .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)))
        .returning();
      if (updated) {
        await notifyTaskStatusChanged(db, taskId, groupId, "running", updated);
      }
    } catch (e) {
      console.warn(`[executor] 置 running 失败(${taskId}): ${e}`);
    }

    // 🚀 开始执行(与桥的 emoji 状态条一致)。
    await postStatus(
      db,
      groupId,
      participantId,
      ex,
      `🚀 [${ex.label}] 开始执行:${summary}`,
    );

    // 执行历史:每次 spawn 前 append 一条 running attempt(重试 = 多条)。
    await beginAttempt(run);

    // spawn cwd = 任务书声明的仓库(行内 `仓库:`/`仓库路径:`/`Repository:`/
    // `Repo:` 显式声明时优先,使执行前快照/重试前回滚落在正确的仓库上);未声明则
    // 回退群绑定 project_path(仍不存在再回退 findRepoRoot(),兼容既有测试/无
    // 项目群)。repoRoot 同时传给 buildTicket 的「项目:」行,保证任务书展示与
    // 实际执行一致。
    const declaredRoot = resolveTaskRepo(body, run.projectPath);
    const repoRoot =
      declaredRoot && existsSync(declaredRoot) ? declaredRoot : findRepoRoot();
    // 按 kind 分流:cli 写 ticket + 打本地 git 快照后 spawn;a2a 不发 ticket、
    // 不打快照(远端设备执行,本地快照无意义),body 直接当 prompt 发 gateway。
    // 二者都走同一 handle 形状,后续 done/failed/超时回传逻辑共用。
    const isA2a = ex.kind === "a2a";
    // 第3层:任务书标记「## ReplyMode: detached」(大小写不敏感、允许前后空白)
    // 或目标 participant 在本群持有 coordinator 角色 → 发送(spawn / a2a 调用)
    // 后保持 running,由执行器恢复后 PATCH 回写终态。前者适用于断线型 ops
    // 任务,后者覆盖协调者进程生命周期短于其协调职责的场景。
    const detachedByReplyMode = /^\s*##\s*replymode\s*:\s*detached\s*$/im.test(
      body,
    );
    const detached =
      detachedByReplyMode ||
      (await isCoordinatorTask(db, groupId, participantId));
    run.detached = detached;
    // 记忆开关:仅 memory="per-group" 的协调器启用 contextId 延续(查/回写);
    // 纯粹执行器(无 memory 标记,含普通 a2a)无记忆——任务书自包含。
    // 声明在分支外:完成路径(回写)同样需要判断,不能只在 a2a 分支内定义。
    const memoryPerGroup = isA2a && ex.memory === "per-group";
    let handle: { promise: Promise<ExecutorRunResult>; kill: () => void };
    if (isA2a) {
      const a2aUrl = ex.a2a?.url ?? "";
      console.log(
        `[executor] a2a 调用: ${a2aUrl} (participant=${ex.agentName}, group=${run.groupKey}, task=${taskId})`,
      );
      // A2A 上下文延续:按 (executorKey, groupId) 查——该执行器在**本群**
      // 最近一个非 cancelled 任务返回的 a2a_context_id(按 updated_at desc),
      // 作为本次入参;无则不携带。按群隔离:同一执行器在不同群各自延续,
      // 跨群不串。记忆只是加速器,验收不依赖记忆(任务书自包含)。
      let prevContextId: string | undefined;
      if (memoryPerGroup) {
        try {
          const prevTask = await db.query.task.findFirst({
            where: and(
              eq(taskTable.executorKey, ex.key),
              eq(taskTable.groupId, groupId),
              ne(taskTable.status, "cancelled"),
              isNotNull(taskTable.a2aContextId),
            ),
            orderBy: (t, { desc }) => [desc(t.updatedAt)],
            columns: { a2aContextId: true },
          });
          prevContextId = prevTask?.a2aContextId ?? undefined;
        } catch (e) {
          // 上下文查询失败只影响延续,不影响本次执行:告警后不带 contextId 继续
          // (与下方回写同样容错,避免 DB 抖动把任务永久置 failed)。
          console.warn(
            `[executor] 查 a2a_context_id 失败(${taskId}),本次不带上下文: ${e}`,
          );
        }
      }
      // 超时/中止共用同一 AbortController:kill 中止在途请求(停止指令、A2A
      // 无进展超时共用),与 CLI 的进程组 SIGKILL 语义一致。
      const a2aController = new AbortController();
      // 规范驱动下发:a2a 不发 ticket,specRef 非空时把「关联规范」段前置进
      // prompt(与 CLI ticket 同一模板,避免两路漂移——执行器严格按 Spec
      // 实现,冲突以 Spec 为准);无 specRef 时 prompt 与旧版完全一致。
      const prompt = run.specRef
        ? `${buildSpecSection(run.specRef, run.specHash).join("\n")}\n\n${body}`
        : body;
      handle = {
        promise: runA2AExecutor({
          url: a2aUrl,
          token: ex.a2a?.token ?? "",
          prompt,
          ...(prevContextId ? { contextId: prevContextId } : {}),
          timeoutMs: readTimeoutMs(),
          signal: a2aController.signal,
        }),
        kill: () => a2aController.abort(),
      };
    } else {
      // 并行任务可能同毫秒触发,ticket 路径用 taskId 保证唯一(避免互相覆盖)。
      const ticketPath = `/tmp/coagenthub-ticket-${taskId}.md`;
      // 测试执行器按群分工提示词自动选择(无匹配 → null → 任务书默认由实现执行器
      // 完成测试);body 里显式「**测试执行器:**」行由 buildTicket 原样保留。
      // 解析失败不影响任务执行:容错为 null(按默认处理)。
      let testExecutor: string | null = null;
      try {
        testExecutor = await resolveTestExecutor(db, groupId, ex.agentName);
      } catch (e) {
        console.warn(
          `[executor] 测试执行器解析失败(${taskId}),按默认处理: ${e}`,
        );
      }
      try {
        writeFileSync(
          ticketPath,
          buildTicket(
            body,
            ex.label,
            repoRoot,
            run,
            groupPrompt,
            testExecutor,
            run.specRef,
            run.specHash,
          ),
        );
      } catch (e) {
        await failTask(db, taskId, `任务书写入失败: ${e}`);
        await postStatus(
          db,
          groupId,
          participantId,
          ex,
          `❌ [${ex.label}] 任务失败: 任务书写入失败 (${e})`,
        );
        return;
      }

      // 执行前 git 快照(回滚指令用;与桥 createCheckpoint 一致):失败则中止
      // 任务,不做无回滚保护的执行。快照 ref 写回 task.checkpoint_ref。
      try {
        const cp = await createCheckpoint(taskId, repoRoot);
        run.checkpointRef = cp.ref;
        await db
          .update(taskTable)
          .set({ checkpointRef: cp.ref })
          .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[executor] 执行前快照失败(${taskId}): ${msg}`);
        await failTask(db, taskId, `执行前快照失败: ${msg}`);
        await postStatus(
          db,
          groupId,
          participantId,
          ex,
          `❌ [${ex.label}] 任务失败: 执行前快照失败 (${msg})`,
        );
        return;
      }

      // hermes 之类的 participant 需要提示词文本而不是文件路径:{ticketContent}
      // 把刚写好的任务书全文内联进参数;{model} 占位由 renderExecutorArgs 处理
      // (无 model 时移除该参数项,避免 CLI 收到空参数)。
      const ticketContent = readFileSync(ticketPath, "utf8");
      const args = renderExecutorArgs(
        ex.args.map((a) =>
          a
            .replaceAll("{ticket}", ticketPath)
            .replaceAll("{ticketContent}", ticketContent),
        ),
        ex.model,
      );
      console.log(
        `[executor] server 侧 spawn: ${ex.bin} ${args.join(" ")} (cwd=${repoRoot}, group=${run.groupKey}, task=${taskId})`,
      );
      // ANSI 剥离器:每次执行一个(跨 chunk 转义序列扣尾拼接),输出路径共用。
      const stripAnsiChunk = createAnsiStripper();
      handle = runExecutor({
        bin: ex.bin,
        args,
        cwd: repoRoot,
        onOutput: (chunk) => {
          // 流式日志 + 实时进度:server 控制台保留原样(带色便于排查);入环形
          // 缓冲(includeOutput 拉取/断线重连用)与 WS 广播(task_output 事件)
          // 走剥离后的文本——剥在唯一源头,前端/插件/兜底拉取一次性受益。
          process.stdout.write(chunk);
          const clean = stripAnsiChunk(chunk);
          appendTaskOutput(taskId, clean);
          void wsHub.broadcastTaskOutput(groupId, taskId, clean);
          // 静默检测:每次输出刷新「最近活跃」时间戳并重排静默定时器。
          run.lastOutputAt = Date.now();
          if (run.stallTimer) {
            clearTimeout(run.stallTimer);
            run.stallTimer = setTimeout(
              () => handleStall(run),
              getStallTimeoutMs(),
            );
          }
          // 无进展提醒同界重排:有输出说明没静默,提醒计时顺延。
          if (run.stallAlertTimer) {
            clearTimeout(run.stallAlertTimer);
            run.stallAlertTimer = setTimeout(
              () => handleStallAlert(run),
              getStallAlertMs(),
            );
          }
        },
      });
      // 静默超时起点:进程刚 spawn(输出可观察);之后每次输出重排定时器。
      // a2a 无本地进程/增量输出,不设静默检测(完成路径由任务级超时兜底)。
      // detached 任务不设静默/无进展提醒:发送后静默等待 PATCH 是正常态,
      // 超时由 detachedTimeoutMinutes 兜底(handleDetachedTimeout)。
      if (!run.detached) {
        run.lastOutputAt = Date.now();
        run.stallTimer = setTimeout(
          () => handleStall(run),
          getStallTimeoutMs(),
        );
        // 无进展提醒起点与静默检测一致:先于静默阈值触发提醒,静默继续到
        // stallTimeoutMs 才标 failed。
        run.stallAlertTimer = setTimeout(
          () => handleStallAlert(run),
          getStallAlertMs(),
        );
      }
    }
    run.kill = handle.kill;
    // 第1层:A2A 无进展超时起点——running 起点即置最近活跃时间(进度消息只会
    // 刷新它),随后连续无进展信号超过 a2aSilenceTimeoutMs → 无进展失败。有进度
    // 消息时由 refreshA2AActivity 顺延。detached 任务不设:发送后静默等待执行器
    // 事后 PATCH 是正常态,超时由 detachedTimeoutMinutes 兜底。
    if (isA2a && !detached) {
      run.lastActivityAt = run.runningAt ?? Date.now();
      run.a2aSilenceTimer = setTimeout(
        () => handleA2ASilence(run),
        getA2ASilenceTimeoutMs(),
      );
    }

    // 第3层(detached, CLI):spawn 后立即视为「已派发」——不等待进程退出决定
    // 终态,任务保持 running,由执行器(协调者/检视者 runtime)恢复后 PATCH
    // 回写终态。不解析 stdout 汇报;队列槽位由 finally 照常释放
    // (group.running 移除本任务);超时兜底复用 detachedTimer / handleDetachedTimeout
    // (超时按「结果未确认」处理)。spawn 的进程继续在后台跑,其退出不再决定
    // 终态,承诺结果由收件方显式回写。
    if (!isA2a && run.detached) {
      console.log(
        `[executor] detached 任务已派发(cli),等待执行器回写终态: ${taskId}`,
      );
      if (!run.detachedTimer && !run.detachedTimedOut && !run.stopped) {
        run.detachedTimer = setTimeout(
          () => handleDetachedTimeout(run),
          getDetachedTimeoutMs(),
        );
      }
      // 进程句柄保留在 run 上(handleDetachedTimeout 复查 DB 状态用)。悬挂的
      // 进程 promise:正常退出 resolve(不决定终态,忽略);reject 只在 spawn
      // 失败(bin 不存在等)或进程 error 事件时发生——启动失败不能让任务静默
      // 挂 running 直到 detached 超时,立即失败并 ❌ 回传。
      handle.promise.catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[executor] detached 任务启动失败(${taskId}): ${msg}`);
        void (async () => {
          try {
            const cur = await db.query.task.findFirst({
              where: (t, { and: andFn, eq: eqFn }) =>
                andFn(eqFn(t.id, taskId), eqFn(t.groupId, groupId)),
              columns: { status: true },
            });
            // 已回写终态(如 detached 超时先行)→ 不覆盖。
            if (cur?.status !== "running") return;
            const hint = executorStartupFailureHint(ex.bin, msg);
            await failTask(
              db,
              taskId,
              `执行器启动失败: ${msg}${hint}`,
              0,
              undefined,
              run.attempts,
            );
            await postStatus(
              db,
              groupId,
              participantId,
              ex,
              `❌ [${ex.label}] 任务失败: ${formatExecutorStartupFailure(
                ex.bin,
                msg,
              )}`,
            );
          } catch (err) {
            console.warn(
              `[executor] detached 启动失败处理异常(${taskId}): ${err}`,
            );
          }
        })();
      });
      return;
    }

    try {
      const result = await handle.promise;
      // 停止指令已 kill 进程组:完成回调置 cancelled,不再回传 ❌/✅(停止
      // 指令自己已回传 🛑)。
      if (run.stopped) {
        console.log(`[executor] 任务已停止: ${taskId}`);
        await endAttempt(run, { status: "cancelled" });
        releaseTaskOutput(taskId);
        const tokenUsage = sumAttemptTokenUsage(run.attempts);
        const [cancelled] = await db
          .update(taskTable)
          .set({
            status: "cancelled",
            diffSummary: {
              error: "stopped",
              ...(tokenUsage !== undefined ? { tokenUsage } : {}),
            },
          })
          .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)))
          .returning();
        if (cancelled) {
          await notifyTaskStatusChanged(
            db,
            taskId,
            groupId,
            "cancelled",
            cancelled,
          );
        }
        return;
      }
      // A2A 上下文延续:gateway 返回的新 contextId 落库(done/failed 都写;
      // 超时/网络错误无 contextId 自然不写),供该执行器**本群**的下一任务
      // 携带。仅 memory="per-group" 的协调器回写;纯粹执行器不回写(任务书
      // 自包含,无记忆)。
      if (memoryPerGroup && result.contextId) {
        try {
          await db
            .update(taskTable)
            .set({ a2aContextId: result.contextId })
            .where(
              and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)),
            );
        } catch (e) {
          console.warn(`[executor] 写 a2a_context_id 失败(${taskId}): ${e}`);
        }
      }
      // 第3层(detached 可脱离执行):A2A 发送完成即算「已派发」,不按最终回复
      // 定终态——任务保持 running,等执行器恢复后 PATCH /groups/:id/tasks/:taskId
      // 主动回写 done/failed;超过 detachedTimeoutMinutes 仍未回写 → 结果未确认
      // (handleDetachedTimeout)。队列槽位照常释放(24h 等待不该占住组队列)。
      if (run.detached) {
        console.log(
          `[executor] detached 任务已发送,等待执行器回写终态: ${taskId}`,
        );
        if (!run.detachedTimer && !run.detachedTimedOut && !run.stopped) {
          run.detachedTimer = setTimeout(
            () => handleDetachedTimeout(run),
            getDetachedTimeoutMs(),
          );
        }
        return;
      }
      // 静默超时已由 handleStall 置 stalled + kill 进程组;失败落库 / ❌ 回传 /
      // 重试判定统一在完成路径处理,避免定时器回调与完成路径并发写状态。
      if (run.stalled) {
        console.log(`[executor] 任务已因静默超时失败: ${taskId}`);
        await handleFailure(run, "执行器静默超时", {
          retryable: true,
          message: `❌ [${ex.label}] 任务失败 (执行器静默超时)`,
        });
        return;
      }
      // A2A 无进展超时已由 handleA2ASilence 置 a2aSilenced + 中止请求:按「无进展
      // 失败」处理(不重试——执行器已失联,重试无意义;不设无进展提醒,与静默
      // 检测同界,仅 a2a 无本地进程输出可观察,不走 stallAlert 提醒)。
      if (run.a2aSilenced) {
        console.log(`[executor] 任务已因 A2A 无进展超时失败: ${taskId}`);
        await handleFailure(run, "执行器无进展", {
          retryable: false,
          message: `❌ [${ex.label}] 任务失败 (执行器无进展)`,
        });
        return;
      }
      if (result.timedOut) {
        console.error(`[executor] 任务超时: ${taskId}`);
        // 第2层:A2A 请求超时但最近有进展信号 → 执行器可能仍在执行/已完成,
        // 结果无法确认 → 按「结果未确认」处理(不重试,避免重复执行)。
        if (isA2a && hasRecentA2AProgress(run)) {
          await handleUnconfirmed(run);
          return;
        }
        // 超时且已捕获输出(尾部,与失败回传同界)含额度关键词 → 额度失败。
        const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
        if (isQuotaFailure(["执行超时", lastLinesOf(out, 20)])) {
          // 冷却动态化:优先从失败输出解析恢复时间,解析失败回退固定冷却。
          const eta = formatEta(
            enterCooldown(
              ex,
              parseRateLimitRecoveryMs(out) ??
                Date.now() + getRateLimitCooldownMs(),
            ),
          );
          await handleFailure(
            run,
            `执行超时(执行器额度限制,预计 ${eta} 恢复)`,
            {
              retryable: false,
              message: `❌ [${ex.label}] 任务失败 (执行器额度限制,预计 ${eta} 恢复)`,
            },
          );
        } else {
          await handleFailure(run, "执行超时", {
            retryable: true,
            message: `❌ [${ex.label}] 任务失败 (超时)`,
          });
        }
        return;
      }
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      if (result.code === 0) {
        // 成功路径也要过额度检测(quota-failure-on-clean-exit 规范):执行器
        // 礼貌地打印额度耗尽说明后正常退出(如 `[rate-limited] 5h window
        // exhausted`),走的是 exit 0 路径,若只在超时/失败分支检测会漏判为
        // done。与失败分支(1365)同界(尾部 20 行)命中 → 按额度失败处理(逐条
        // 一致:failed / 冷却 / 不重试 / 回传预计恢复时间);前部命中尾部不命中
        // 则不判(避免误判停派)。不含额度关键词时行为完全不变(继续 done 路径)。
        const successTail = lastLinesOf(output, 20).slice(0, 1500);
        if (isQuotaFailure([`exit 0`, successTail])) {
          await handleQuotaFailure(run, "exit 0", successTail);
          return;
        }
        // a2a 执行器(远端 participant)的回复就是最终交付内容,直接作为 summary,
        // 不做段落解析;hash 仍从输出提取。CLI 路径走结构化段落解析(票7)。
        const a2aHash = findCommitHash(output);
        const report: TaskReport = isA2a
          ? {
              summary: (result.stdout ?? "").trim(),
              ...(a2aHash ? { hash: a2aHash } : {}),
            }
          : parseTaskReport(output);
        const diffSummary: Record<string, unknown> = { ...report };
        // 汇报 commit 核实(spec verify-agent-claims v1.1):CLI 完成与 a2a 完成
        // 共用同一套 claim-verification 逻辑;cli 在任务实际仓库核实,a2a 本地
        // 无仓库 → 留下 status=skipped 的「未核实」痕迹(不再静默跳过)。
        const claimVerification = await verifyReportedCommit(
          report.hash,
          repoRoot,
          run.attempts,
          isA2a ? "a2a" : "cli",
        );
        if (claimVerification) {
          diffSummary.claimVerification = claimVerification;
        }
        if (run.retryCount > 0) diffSummary.retries = run.retryCount;
        // 完成回填:最近 500 行输出写进 diffSummary.outputTail(之后不依赖内存)。
        const doneTail = lastLinesOf(taskOutputTail(taskId) ?? "", 500);
        if (doneTail) diffSummary.outputTail = doneTail;
        await endAttempt(run, {
          status: "done",
          summary: report.summary,
          hash: report.hash,
          tokenUsage: report.tokenUsage,
        });
        const tokenUsage = sumAttemptTokenUsage(run.attempts);
        if (tokenUsage !== undefined) diffSummary.tokenUsage = tokenUsage;
        releaseTaskOutput(taskId);
        const [done] = await db
          .update(taskTable)
          .set({ status: "done", diffSummary })
          .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)))
          .returning();
        if (done) {
          await notifyTaskStatusChanged(db, taskId, groupId, "done", done);
        }
        console.log(
          `[executor] 任务完成: ${taskId}${
            report.hash ? ` hash=${report.hash}` : ""
          }${run.retryCount > 0 ? `(重试 ${run.retryCount} 次)` : ""}`,
        );
        await postStatus(
          db,
          groupId,
          participantId,
          ex,
          renderTaskCard(ex.label, report),
        );
      } else {
        // 第2层:无法确认执行结果(gateway「did not reply in time」/ 网络错误 /
        // HTTP 5xx)→ 执行器可能已实际执行,按「结果未确认」处理(不重试、不
        // 回传 ❌)。其余失败保持原重试行为。
        if (result.unconfirmed) {
          console.error(`[executor] 任务结果未确认: ${taskId}`);
          await handleUnconfirmed(run);
          return;
        }
        const tail = lastLinesOf(output, 20).slice(0, 1500);
        console.error(`[executor] 任务失败 exit=${result.code}: ${taskId}`);
        // 执行器并发冲突(设计修正,反应式排队):CLI 返回 `403
        // atomgit_session_concurrency_conflict`(如 AtomCode 的 atomgit session
        // 被其他会话占用)→ 不判失败:任务保持 queued 并重新入队,等既有
        // running 任务终态后自动重试(不消耗重试次数、不回滚工作区)。
        if (!isA2a && isConcurrencyConflict(output)) {
          console.warn(
            `[executor] 执行器并发冲突(403),任务重新排队等待空闲: ${taskId}`,
          );
          await handleConcurrencyConflict(run);
          return;
        }
        // 额度/速率限制失败(票7):失败输出尾部(与失败回传同界)命中额度关键词
        // → 归类「额度失败」,冷却该执行器、不自动重试、❌ 注明预计恢复时间;
        // 其余失败保持原重试行为。限定尾部避免全量输出里的无关 "429/quota"
        // 字样造成误判(误判会停派该执行器整段冷却期)。
        if (isQuotaFailure([`exit ${result.code}`, tail])) {
          await handleQuotaFailure(run, `exit ${result.code}`, tail);
        } else {
          await handleFailure(run, `exit ${result.code}`, {
            retryable: true,
            message: `❌ [${ex.label}] 任务失败 (exit ${result.code})\n${tail}`,
          });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[executor] 执行器启动失败: ${msg}`);
      await endAttempt(run, { status: "failed", error: msg });
      releaseTaskOutput(taskId);
      const hint = executorStartupFailureHint(ex.bin, msg);
      await failTask(db, taskId, `${msg}${hint}`, 0, undefined, run.attempts);
      await postStatus(
        db,
        groupId,
        participantId,
        ex,
        `❌ [${ex.label}] 任务失败: ${formatExecutorStartupFailure(
          ex.bin,
          msg,
        )}`,
      );
    }
  } finally {
    clearRunTimers(run);
    group.running = group.running.filter((r) => r !== run);
    void pumpQueue();
  }
}

async function findTaskByMessage(db: DataBase, messageId: string) {
  return db.query.task.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.messageId, messageId),
  });
}

/* ---------------- 超时 / 进度处理 ---------------- */

/**
 * 无进展提醒处理(网页体验批次):running 任务连续无输出超过 stallAlertMs
 * (默认 15min,先于 stallTimeoutMs)→ 发一条群消息提醒协调者 + 任务面板行
 * 警示标记(黄色,非失败);静默继续到 stallTimeoutMs 才由 handleStall 标
 * failed。停止指令优先:run.stopped 的任务直接跳过。仅 CLI 路径调度(与静默
 * 检测同界,a2a 无本地进程输出可观察)。
 */
function handleStallAlert(run: QueuedRun): void {
  if (run.stopped || run.stalled || run.stallAlerted) return;
  run.stallAlerted = true;
  if (run.stallAlertTimer) {
    clearTimeout(run.stallAlertTimer);
    run.stallAlertTimer = null;
  }
  const minutes = Math.max(1, Math.round(getStallAlertMs() / 60_000));
  console.warn(
    `[executor] 无进展提醒: ${run.taskId} 已 ${minutes} 分钟无输出,执行器:${run.ex.label}`,
  );
  void (async () => {
    await postStatus(
      run.db,
      run.groupId,
      run.participantId,
      run.ex,
      `⚠️ 任务 ${run.taskId} 已 ${minutes} 分钟无进展,执行器:${run.ex.label},请介入`,
    );
    // 警示标记落库(diffSummary.stallAlerted),任务面板行加黄色警示样式。
    try {
      await run.db
        .update(taskTable)
        .set({ diffSummary: { stallAlerted: true } })
        .where(
          and(eq(taskTable.id, run.taskId), eq(taskTable.groupId, run.groupId)),
        );
    } catch (e) {
      console.warn(`[executor] 写无进展警示标记失败(${run.taskId}): ${e}`);
    }
    void wsHub.broadcastTaskStallAlert(run.groupId, run.taskId);
  })();
}

/**
 * 静默超时处理:running 任务连续无输出超过 stallTimeoutMs → kill 进程组 +
 * 置 stalled。失败落库 / ❌ 回传 / 重试判定由 promise 完成路径(runOne 看到
 * run.stalled)统一处理,避免定时器回调与完成路径并发写状态。
 * 停止指令优先:run.stopped 的任务直接跳过(停止走 cancelled 路径)。
 */
function handleStall(run: QueuedRun): void {
  if (run.stopped || run.stalled) return;
  run.stalled = true;
  if (run.stallTimer) {
    clearTimeout(run.stallTimer);
    run.stallTimer = null;
  }
  run.kill?.();
  console.error(`[executor] 执行器静默超时: ${run.taskId}`);
}

/**
 * A2A 无进展超时处理(第1层):running 的 A2A 任务连续无任何进展信号(执行器
 * participant 在群里的消息,refreshA2AActivity 顺延)超过 a2aSilenceTimeoutMs
 * → 置 a2aSilenced + 中止在途请求,失败落库 / ❌ 回传由完成路径统一处理
 * (与静默超时同一模式,避免定时器回调与完成路径并发写状态)。
 * 停止指令优先:run.stopped 的任务直接跳过(停止走 cancelled 路径);
 * detached 任务不设此定时器(发送后静默等待执行器 PATCH 是正常态)。
 */
function handleA2ASilence(run: QueuedRun): void {
  if (run.stopped || run.a2aSilenced || run.detached) return;
  run.a2aSilenced = true;
  if (run.a2aSilenceTimer) {
    clearTimeout(run.a2aSilenceTimer);
    run.a2aSilenceTimer = null;
  }
  run.kill?.();
  console.error(`[executor] A2A 无进展超时: ${run.taskId}`);
}

/**
 * A2A 进度信号(第1层):执行器 participant 在群里发的消息 → 刷新该执行器在本群
 * running 的 A2A 任务最近活跃时间(lastActivityAt),顺延无进展超时定时器。
 * 由 POST /groups/:id/messages 成功写入消息后调用(fire-and-forget,纯内存
 * 同步操作)。消息可以是普通广播消息,无需新协议。不命中(非 A2A / 非 running /
 * 非本执行器消息 / 已停止或已触发无进展)返回 false,不影响消息响应。
 */
export function refreshA2AActivity(
  groupId: string,
  participantId: string,
): boolean {
  for (const g of groupQueues.values()) {
    const run = g.running.find(
      (rr) =>
        !rr.stopped &&
        !rr.a2aSilenced &&
        rr.groupId === groupId &&
        rr.participantId === participantId &&
        rr.ex.kind === "a2a",
    );
    if (!run) continue;
    run.lastActivityAt = Date.now();
    if (run.a2aSilenceTimer) {
      clearTimeout(run.a2aSilenceTimer);
      run.a2aSilenceTimer = setTimeout(
        () => handleA2ASilence(run),
        getA2ASilenceTimeoutMs(),
      );
    }
    return true;
  }
  return false;
}

/**
 * A2A 请求超时时的「最近有进展」判定(第2层):running 起点后有进展信号
 * (lastActivityAt 被进度消息刷新过,即 > runningAt)且距上次进展未超过无进展
 * 窗口 → 视为执行器可能仍在执行/已完成,结果未确认。无进展起点(lastActivityAt
 * === runningAt)或静默已超窗口(此时 a2aSilenceTimer 已先触发)不算。
 */
function hasRecentA2AProgress(run: QueuedRun): boolean {
  if (!run.runningAt) return false;
  if (run.lastActivityAt <= run.runningAt) return false;
  return Date.now() - run.lastActivityAt < getA2ASilenceTimeoutMs();
}

/**
 * 结果未确认统一出口(第2层):执行器可能已完成但结果无法确认(gateway「did not
 * reply in time」/ 请求超时但有进展 / 网络错误 / HTTP 5xx / detached 超时未回写)。
 * 落库保持 status=failed(不新增状态,避免迁移/兼容问题),diffSummary 加
 * unconfirmed: true + 协议文案;群消息回传 ⚠️ 而非 ❌。不重试(重试有重复执行
 * 风险)。detached 超时触发前会复查 DB 状态(已回写终态则跳过),见 handleDetachedTimeout。
 */
async function handleUnconfirmed(run: QueuedRun): Promise<void> {
  const { db, taskId } = run;
  await endAttempt(run, {
    status: "failed",
    error: "执行器未按协议回复，结果未确认",
  });
  releaseTaskOutput(taskId);
  await failTask(
    db,
    taskId,
    "执行器未按协议回复，结果未确认",
    run.retryCount,
    { unconfirmed: true },
    run.attempts,
  );
  await postStatus(
    db,
    run.groupId,
    run.participantId,
    run.ex,
    "⚠️ 任务结果未确认：执行器可能已完成，请人工核实",
  );
}

/**
 * detached 超时处理(第3层):任务发送后超过 detachedTimeoutMs 执行器仍未 PATCH
 * 回写终态 → 按「结果未确认」处理(第2层)。触发前复查 DB:状态已非 running
 * (执行器已回写 done/failed 或已被停止置 cancelled)→ 跳过,避免覆盖终态。
 */
function handleDetachedTimeout(run: QueuedRun): void {
  if (run.stopped || run.detachedTimedOut) return;
  run.detachedTimedOut = true;
  if (run.detachedTimer) {
    clearTimeout(run.detachedTimer);
    run.detachedTimer = null;
  }
  console.error(`[executor] detached 任务超时未回写终态: ${run.taskId}`);
  void (async () => {
    try {
      const cur = await run.db.query.task.findFirst({
        where: (t, { and: andFn, eq: eqFn }) =>
          andFn(eqFn(t.id, run.taskId), eqFn(t.groupId, run.groupId)),
        columns: { status: true },
      });
      if (cur?.status !== "running") {
        // 执行器已 PATCH 回写终态(或已停止):结果已确认/已取消,不再覆盖。
        return;
      }
      await handleUnconfirmed(run);
    } catch (e) {
      console.warn(`[executor] detached 超时处理失败(${run.taskId}): ${e}`);
    }
  })();
}

/**
 * 认领超时处理:queued 任务超过 claimTimeoutMs 仍未进入 running → 移出队列 +
 * 置 failed(「任务未被认领」)+ ❌ 回传(注明发布时间)。若任务已被 pump 取走
 * 开始运行(认领完成),从队列找不到即放弃(定时器取消前已入队的回调兜底)。
 * 停止指令优先:run.stopped 的任务直接跳过(停止走 cancelled 路径)。
 */
function handleClaimTimeout(run: QueuedRun): void {
  if (run.stopped) return;
  // 执行器额度冷却中:不按认领超时处理(任务应保持 queued,等冷却结束由
  // enterCooldown 的定时器泵送自动派发,而非被误标「未认领」)。
  if (isInCooldown(run.ex)) return;
  const g = groupQueues.get(run.groupKey);
  if (g) {
    const idx = g.queue.indexOf(run);
    if (idx < 0) return; // 已被取走开始运行 → 认领完成,放弃。
    g.queue.splice(idx, 1);
  }
  clearRunTimers(run);
  const publishedAt = new Date(run.createdAt).toLocaleString("zh-CN");
  console.error(`[executor] 任务未认领: ${run.taskId}`);
  void (async () => {
    await failTask(run.db, run.taskId, "任务未认领");
    await postStatus(
      run.db,
      run.groupId,
      run.participantId,
      run.ex,
      `❌ [${run.ex.label}] 任务失败 (未认领,发布于 ${publishedAt})`,
    );
  })();
}

/** 直接落库置 failed(server 是状态源;PATCH 端点是给外部执行器客户端的)。
 *  retries > 0 时把重试次数写进 diffSummary(审计/汇报用);extra 合并进
 *  diffSummary(结果未确认等附加标记,如 { unconfirmed: true })。running 任务
 *  存在输出缓冲时,把最近 50 行写进 diffSummary.outputTail(完成回填,之后
 *  不依赖内存也能看;无缓冲(未 spawn 的失败)则不加)。 */
async function failTask(
  db: DataBase,
  taskId: string,
  reason: string,
  retries = 0,
  extra?: Record<string, unknown>,
  attempts?: TaskAttempt[],
): Promise<void> {
  const diffSummary: Record<string, unknown> = { error: reason, ...extra };
  if (retries > 0) diffSummary.retries = retries;
  const tokenUsage = attempts ? sumAttemptTokenUsage(attempts) : undefined;
  if (tokenUsage !== undefined) diffSummary.tokenUsage = tokenUsage;
  const tail = lastLinesOf(taskOutputTail(taskId) ?? "", 500);
  if (tail) diffSummary.outputTail = tail;
  const [failed] = await db
    .update(taskTable)
    .set({ status: "failed", diffSummary })
    .where(eq(taskTable.id, taskId))
    .returning();
  if (failed) {
    await notifyTaskStatusChanged(db, taskId, failed.groupId, "failed", failed);
  }
}

/* ---------------- 执行历史(attempt 时间线) ---------------- */

/** spawn 执行器前 append 一条 running attempt 并落库(重试 = 多条;不重试也
 *  有一条)。attempts 数组同时保留在 run 上,后续 endAttempt 就地更新。 */
async function beginAttempt(run: QueuedRun): Promise<void> {
  const attempt: TaskAttempt = {
    n: run.attempts.length + 1,
    startedAt: new Date().toISOString(),
    status: "running",
  };
  run.attempts.push(attempt);
  try {
    await run.db
      .update(taskTable)
      .set({ attempts: run.attempts })
      .where(eq(taskTable.id, run.taskId));
  } catch (e) {
    console.warn(`[executor] 写 attempts 失败(${run.taskId}): ${e}`);
  }
}

/** 任务终态时更新最后一条 attempt(endedAt/status/error/summary/hash/tokenUsage)并落库。 */
async function endAttempt(
  run: QueuedRun,
  patch: Partial<
    Pick<TaskAttempt, "status" | "error" | "summary" | "hash" | "tokenUsage">
  >,
): Promise<void> {
  const last = run.attempts[run.attempts.length - 1];
  if (!last) return;
  Object.assign(last, patch, { endedAt: new Date().toISOString() });
  try {
    await run.db
      .update(taskTable)
      .set({ attempts: run.attempts })
      .where(eq(taskTable.id, run.taskId));
  } catch (e) {
    console.warn(`[executor] 写 attempts 失败(${run.taskId}): ${e}`);
  }
}

/**
 * 额度/速率限制失败统一出口(票7 + quota-failure-on-clean-exit 规范):冷却该
 * 执行器、不自动重试、❌ 回传注明预计恢复时间。tail 为命中检测与恢复时间解析
 * 所用的输出尾部(与失败回传同界:`lastLinesOf(out, 20)`),reasonLabel 为失败
 * 原因前缀(如 "exit 0" / "exit 2" / "执行超时")。
 *
 * 失败分支(1365)/ 成功路径(本规范)共用本出口,保证额度处理逐条一致;超时分支
 * (1261)单独保留全量输出解析(历史行为,不在本规范改动范围)。
 */
async function handleQuotaFailure(
  run: QueuedRun,
  reasonLabel: string,
  tail: string,
): Promise<void> {
  // 冷却动态化:优先从失败输出解析恢复时间,解析失败回退固定冷却。
  const eta = formatEta(
    enterCooldown(
      run.ex,
      parseRateLimitRecoveryMs(tail) ?? Date.now() + getRateLimitCooldownMs(),
    ),
  );
  await handleFailure(
    run,
    `${reasonLabel}(执行器额度限制,预计 ${eta} 恢复)`,
    {
      retryable: false,
      message: `❌ [${run.ex.label}] 任务失败 (执行器额度限制,预计 ${eta} 恢复)\n${tail}`,
    },
  );
}

/**
 * 失败统一出口(重试判定):任务失败(exit≠0 / 超时 / 静默)且 retryCount <
 * maxRetries 且可重试时 → 回滚 checkpoint(resetWorkspace)→ retry_count+1 →
 * 回传 ❌(首次失败)+ ↻ 重试提示 → 重新入队重跑;否则按最终失败处理(标
 * failed + ❌ 回传)。认领超时 / 手动停止 / 验收失败不重试(调用方传
 * retryable=false 或直接走各自分支)。
 */
async function handleFailure(
  run: QueuedRun,
  reason: string,
  opts: { retryable: boolean; message: string },
): Promise<void> {
  const { db, taskId } = run;
  // 本次 attempt 结束(重试会由下一次 spawn 的 beginAttempt 续新条)。
  await endAttempt(run, { status: "failed", error: reason });
  const canRetry =
    opts.retryable &&
    !run.stopped &&
    run.retryCount < getRetryPolicy().maxRetries;

  if (!canRetry) {
    // 注意顺序:failTask 会回填 outputTail(最近 50 行),必须先取后释放。
    await failTask(db, taskId, reason, run.retryCount, undefined, run.attempts);
    releaseTaskOutput(taskId);
    await postStatus(db, run.groupId, run.participantId, run.ex, opts.message);
    return;
  }

  // 重试前回滚 checkpoint(resetWorkspace=true 且存在快照):恢复工作树到任务前
  // 状态,避免重试带着首次失败留下的脏改动重跑。a2a 无本地快照直接跳过。回滚
  // 必须在执行前快照所用的仓库(任务书声明的仓库)上进行,与原执行一致。
  if (getRetryPolicy().resetWorkspace && run.checkpointRef) {
    const declaredRoot = resolveTaskRepo(run.body, run.projectPath);
    const repoRoot =
      declaredRoot && existsSync(declaredRoot) ? declaredRoot : findRepoRoot();
    const res = await resetToCheckpoint(run.checkpointRef, repoRoot);
    if (!res.ok) {
      // 快照回滚失败 → 终止重试,按最终失败处理(保留原始失败原因)。
      const msg = `${reason};回滚失败,终止重试: ${res.message}`;
      console.error(`[executor] 重试前回滚失败(${taskId}): ${res.message}`);
      await failTask(db, taskId, msg, run.retryCount, undefined, run.attempts);
      await postStatus(
        db,
        run.groupId,
        run.participantId,
        run.ex,
        `❌ [${run.ex.label}] 任务失败: ${msg}`,
      );
      return;
    }
    console.log(
      `[executor] 重试前已回滚工作区到 ${run.checkpointRef}(${taskId})`,
    );
  }

  // retry_count+1 并持久化(最终结果仍由重试后的完成路径回传)。
  run.retryCount += 1;
  try {
    await db
      .update(taskTable)
      .set({ retryCount: run.retryCount })
      .where(eq(taskTable.id, taskId));
  } catch (e) {
    console.warn(`[executor] 写 retry_count 失败(${taskId}): ${e}`);
  }

  // 首次失败 ❌ + 补发 ↻ 重试提示;最终 ✅/❌ 由重试的完成路径照常回传。
  await postStatus(db, run.groupId, run.participantId, run.ex, opts.message);
  await postStatus(
    db,
    run.groupId,
    run.participantId,
    run.ex,
    `↻ [${run.ex.label}] 自动重试 (第 ${run.retryCount} 次)`,
  );

  // 重置运行态并重新入队(同组串行,槽位由 runOne 的 finally 释放后 pump 取走;
  // 任务已被认领过,不再设认领超时)。
  run.stalled = false;
  run.runningAt = null;
  run.lastOutputAt = 0;
  run.kill = null;
  const group = groupQueues.get(run.groupKey);
  if (!group) {
    // 组已被清空(测试重置等异常)→ 无法重试,按最终失败处理。
    await failTask(db, taskId, reason, run.retryCount, undefined, run.attempts);
    await postStatus(db, run.groupId, run.participantId, run.ex, opts.message);
    return;
  }
  group.queue.push(run);
}

/**
 * 反应式排队(403 后排队,设计修正):执行器返回 `403
 * atomgit_session_concurrency_conflict` → 不判任务失败:
 *  - 本次 attempt 结束(原因记 concurrency-conflict,不计入 retry_count,
 *    不触发失败重试的回滚/❌/↻ 流程);
 *  - DB 状态回写 queued(运行中曾置 running)+ WS 推送;
 *  - 重置运行态并重新入队(队尾,FIFO 不变),置 concurrencyBlocked:泵送在
 *    既有同执行器 running 任务终态前不再派发本任务;
 *  - 无既有 running 任务(外部会话占用)→ 退避窗口(concurrencyRetryAt)后由
 *    定时器泵送重试,防空转热循环。
 * 可并发执行器(无 maxConcurrency)首次尝试即可能触发本路径;显式 maxConcurrency
 * 的执行器由 isRunDispatchable 直接排队,正常情况下不会收到 403。
 */
async function handleConcurrencyConflict(run: QueuedRun): Promise<void> {
  const { db, groupId, taskId, ex } = run;
  // 本次 attempt 结束(重试会由下一次 spawn 的 beginAttempt 续新条)。
  await endAttempt(run, { status: "failed", error: "concurrency-conflict" });

  // 保持 queued:回写 DB 状态(运行中曾置 running),并 WS 推送状态变化。
  try {
    const [updated] = await db
      .update(taskTable)
      .set({ status: "queued" })
      .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)))
      .returning();
    if (updated) {
      await notifyTaskStatusChanged(db, taskId, groupId, "queued", updated);
    }
  } catch (e) {
    console.warn(`[executor] 403 后回写 queued 失败(${taskId}): ${e}`);
  }

  // 重置运行态并重新入队(队尾);不释放输出缓冲(保留冲突现场供排查)。
  run.concurrencyBlocked = true;
  run.concurrencyRetryAt = Date.now() + CONCURRENCY_RETRY_BACKOFF_MS;
  run.stalled = false;
  run.a2aSilenced = false;
  run.runningAt = null;
  run.lastOutputAt = 0;
  run.lastActivityAt = 0;
  run.kill = null;
  clearRunTimers(run);
  const group = groupQueues.get(run.groupKey);
  if (!group) {
    // 组已被清空(测试重置等异常)→ 无法重排,按最终失败处理(尽力而为)。
    await failTask(
      db,
      taskId,
      "执行器并发冲突(403),且组队列已不可用",
      0,
      undefined,
      run.attempts,
    );
    return;
  }
  group.queue.push(run);
  await postStatus(
    db,
    groupId,
    run.participantId,
    ex,
    `📋 [${ex.label}] 执行器忙(403 并发冲突),任务保持排队,空闲后自动重试: ${run.summary}`,
  );
  // 退避定时器:无既有 running 任务(外部会话占用)时,退避到期主动泵送重试;
  // 有既有任务时由它们的完成路径(finally → pumpQueue)触发,本定时器仅兜底。
  setTimeout(() => void pumpQueue(), CONCURRENCY_RETRY_BACKOFF_MS);
}

/**
 * 任务书声明仓库解析:任务书 body 显式声明目标仓库路径时(行级
 * `仓库:` / `仓库路径:` / `Repository:` / `Repo:` 大小写不敏感、允许前后空白),
 * 返回该行第一个路径 token(绝对路径且 existsSync 为目录才采用);否则回退群绑定
 * projectPath(保持现行为,允许为空 → 后续由 findRepoRoot() 兜底)。用于 spawn cwd
 * / 执行前快照 / 重试前回滚统一落在任务书声明的仓库上。
 */
export function resolveTaskRepo(
  body: string,
  groupProjectPath: string | null,
): string | null {
  const declared = parseRepoPathFromBody(body);
  if (
    declared &&
    isAbsolute(declared) &&
    existsSync(declared) &&
    statSync(declared).isDirectory()
  ) {
    return declared;
  }
  return groupProjectPath ?? null;
}

/**
 * 从任务书 body 解析显式声明的仓库路径:命中 `仓库:` / `仓库路径:` /
 * `Repository:` / `Repo:` 行(大小写不敏感、允许前后空白,行首即关键字)取行内
 * 第一个路径 token;无声明 → null。关键字严格从行首(仅允许前导空白)开始,避免
 * 正文偶然出现「仓库:」字样误命中。
 */
function parseRepoPathFromBody(body: string): string | null {
  const re = /^\s*(?:仓库路径|仓库|repository|repo)\s*[:：]\s*(.+?)\s*$/i;
  for (const raw of body.split("\n")) {
    const m = re.exec(raw);
    if (m) {
      const token = m[1].trim().split(/\s+/)[0];
      if (token) return token;
    }
  }
  return null;
}

/* ---------------- 测试执行器选择 / 任务书模板 ---------------- */

/** 测试职责关键词(分工提示词匹配用,大小写不敏感)。 */
const TEST_KEYWORDS = [
  "测试",
  "验证",
  "检验",
  "test",
  "verify",
  "review",
] as const;

/** 统计 needle 在 haystack 中的出现次数(调用方保证同为小写)。 */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * 测试执行器选择(任务书「执行与测试要求」段):群成员中 roles 含
 * executor/specialist 且分工提示词(prompt)匹配测试职责(关键词:测试/验证/
 * 检验/test/verify/review,大小写不敏感)的执行器。
 * - 匹配多个 → 取 prompt 中测试关键词出现次数最多的(并列按名字字典序,稳定);
 * - 无匹配 → null(任务书写「默认由实现执行器完成测试」)。
 * targetExecutorName = 实现执行器的 participant 名,候选排除其本身(避免自测
 * 自验);与 buildTicket 解耦、独立可单测。
 */
export async function resolveTestExecutor(
  db: DataBase,
  groupId: string,
  targetExecutorName: string,
): Promise<string | null> {
  const members = await db.query.groupMember.findMany({
    where: (t, { eq: eqFn }) => eqFn(t.groupId, groupId),
  });
  const executorMembers = members.filter((m) =>
    m.roles.some((r) => r === "executor" || r === "specialist"),
  );
  if (executorMembers.length === 0) return null;
  const participants = await db.query.participant.findMany({
    where: (t, { inArray: inFn }) =>
      inFn(
        t.id,
        executorMembers.map((m) => m.participantId),
      ),
    columns: { id: true, name: true },
  });
  const nameById = new Map(participants.map((p) => [p.id, p.name]));
  const target = targetExecutorName.trim().toLowerCase();
  const scored: Array<{ name: string; score: number }> = [];
  for (const m of executorMembers) {
    const name = nameById.get(m.participantId);
    if (!name || !m.prompt) continue;
    if (name.trim().toLowerCase() === target) continue; // 排除实现执行器本身
    const lower = m.prompt.toLowerCase();
    const score = TEST_KEYWORDS.reduce(
      (acc, kw) => acc + countOccurrences(lower, kw),
      0,
    );
    if (score > 0) scored.push({ name, score });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored[0].name;
}

/**
 * 执行器任务书固定模板(票7):标题 + 执行器/项目/发布时间 + 任务内容 + 汇报
 * 格式要求(执行器 stdout 按「提交/测试/汇报/遗留」四段输出,server 按段落
 * 解析成结构化 diffSummary)。模板只影响任务书文本,不改任务触发逻辑。
 * 角色解绑后的「本群分工」段与「默认约束」作为尾部附加说明保留(前序票的
 * 既有行为,删除会回归)。「执行与测试要求」段(任务书模板固化):实现执行器 =
 * 定向目标 label;测试执行器 = resolveTestExecutor 解析结果或默认由实现执行器
 * 完成测试;body 中的显式「**测试执行器:**」行原样保留(执行器读任务书即可)。
 */
/** 规范驱动下发:「关联规范」段模板行(CLI ticket 与 a2a prompt 共用,
 *  避免两路漂移)。specRef 为空时应由调用方自行跳过,本函数不做判断。 */
function buildSpecSection(specRef: string, specHash: string | null): string[] {
  return [
    `## 📜 关联规范 (Spec Reference)`,
    `- **文档路径**: ${specRef}`,
    ...(specHash ? [`- **版本哈希**: ${specHash}`] : []),
    `- **指令**: 请严格遵循上述文档中的定义进行开发。如有冲突，以 Spec 为准。`,
  ];
}

/** HTTP coordinates embedded in every task book/prompt; no plugin env is needed. */
export function executionApiBase(): string {
  const configured = process.env.COAGENTHUB_API_BASE?.trim();
  const base = configured || `http://localhost:${serverPort()}/api`;
  return base.replace(/\/+$/, "");
}

function buildExecutionContextSection(run: QueuedRun): string[] {
  const lines = [
    "## 执行上下文 (用于直接调用 CoAgentHub HTTP API)",
    `- apiBase: ${executionApiBase()}`,
    `- participantId: ${run.participantId} (这是接收者自己的 participant id)`,
    `- groupId: ${run.groupId}`,
    `- taskId: ${run.taskId} (这是你自己的 task id)`,
    `- 认证:全信模型,请求带 HTTP 头 X-Participant-Id: ${run.participantId}`,
  ];
  if (run.detached) {
    lines.push(
      `- 这是 detached 任务。完成后必须 PATCH ${executionApiBase()}/groups/${run.groupId}/tasks/${run.taskId}，带 status 与 diffSummary 回写终态。`,
      "- 不回写会使任务保持 running，直到 detachedTimeoutMinutes(默认 1440 分钟)兜底超时，检视者会一直等不到结果。",
    );
  }
  return lines;
}

type TicketRole = "coordinator" | "executor" | "fallback";

function ticketRole(groupPrompt: GroupPromptInfo | null): TicketRole {
  const roles = groupPrompt?.roles ?? [];
  if (roles.includes("coordinator")) return "coordinator";
  if (roles.includes("executor")) return "executor";
  return "fallback";
}

function buildExecutionModeSection(role: TicketRole): string[] {
  if (role === "coordinator") {
    return [
      "## 执行方式",
      "本任务按 `coagenthub-coordinator` skill 执行。",
      "- 已安装：直接按 skill 流程执行（获取冻结 spec→下发任务→L2 功能检视→按编制交回 L3→结案）。",
      "- 未安装：先 GET /api/skills/coordinator 获取 skill 内容，安装到 skills 目录后执行。",
    ];
  }

  const section = [
    "## 执行方式",
    "本任务按 `coagenthub-executor` skill 执行。",
    "- 已安装：直接按 skill 流程执行（读规范→写代码→测试→Code Review 自检→汇报）。",
    "- 未安装：先 GET /api/skills/executor 获取 skill 内容，安装到 skills 目录后执行。",
  ];
  if (role === "fallback") {
    section.push(
      "⚠️ 本群分工角色不含 coordinator 或 executor，按 executor skill 兜底执行；请确认角色是否匹配。",
    );
  }
  return section;
}

function buildReportSection(role: TicketRole): string[] {
  if (role === "coordinator") {
    return [
      "## 汇报格式要求(stdout 请按此输出)",
      "PATCH 自身这条 detached 任务为终态。",
      "PATCH 时，`diffSummary` 必须带 `review_request` 结构化载荷（参见 spec §3.10 / coordinator skill §4.2）。",
    ];
  }
  return [
    "## 汇报格式要求(stdout 请按此输出)",
    "提交: <commit hash>",
    "测试: <测试结果摘要>",
    "Token: <本执行消耗的 token 数量>",
    "汇报: <做了什么,3-5 句>",
    '遗留: <未完成事项,无则写"无">',
  ];
}

function buildTicket(
  body: string,
  label: string,
  repoRoot: string,
  run: QueuedRun,
  groupPrompt: GroupPromptInfo | null = null,
  testExecutor: string | null = null,
  specRef: string | null = null,
  specHash: string | null = null,
): string {
  const lines = [
    `# CoAgentHub 任务`,
    `执行器: ${label}`,
    `项目: ${repoRoot}`,
    `发布时间: ${new Date().toISOString()}`,
  ];
  // 规范驱动下发:specRef 非空时,在「任务内容」之前插入「关联规范」段
  // (Spec 优先于任务内容——执行器严格按 Spec 实现,冲突以 Spec 为准)。
  if (specRef) {
    lines.push(...buildSpecSection(specRef, specHash));
  }
  const role = ticketRole(groupPrompt);
  lines.push(
    `## 任务内容`,
    body,
    ...buildExecutionModeSection(role),
    ...buildReportSection(role),
  );
  const context = buildExecutionContextSection(run);
  lines.splice(4, 0, ...context);
  // 角色解绑后:成员在本群有分工提示词时,任务书插入「本群分工」段(先角色后
  // 提示词原文);无 prompt 时整段不输出,任务书与解绑前完全一致。
  if (groupPrompt?.prompt?.trim()) {
    lines.push(
      `本群分工:角色=[${groupPrompt.roles.join(",")}];提示词=${groupPrompt.prompt}`,
    );
  }
  // 执行与测试要求段(任务书模板固化):实现执行器 = 定向目标 label;测试执行器 =
  // resolveTestExecutor 解析结果,无匹配 → 默认由实现执行器完成测试。
  lines.push(
    "## 执行与测试要求",
    `- 实现执行器:${label}(必选,由发布者定向)`,
    `- 测试执行器:${testExecutor ?? "默认由实现执行器完成测试"}`,
    "- 完成后必须运行测试并验证改动(新增/相关用例),汇报需包含测试结果。",
  );
  lines.push(
    `默认约束(除非消息里明确说明):不动 schema/迁移/scripts/ 下其他脚本、不删数据;测试全绿后提交,commit message 按功能写。`,
  );
  return lines.join("\n");
}

function summaryOf(body: string): string {
  return body.replace(/\s+/g, " ").slice(0, 40);
}
