/**
 * 执行器触发链路的队列核心(executor-task 拆分):入队 / 组调度(pump)/
 * 运行(runOne)/ 停止 / 超时处理(认领/静默/无进展/detached)/ 失败重试 /
 * 执行历史。导出接口与拆分前 @server/lib/executor-task 完全兼容
 * (barrel index.ts 汇总)。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import { runA2AExecutor } from "@server/lib/a2a-runner";
import type { DataBase } from "@server/lib/database";
import { resolveExecutorCliSpawn } from "@server/lib/executor-config-fields";
import {
  createCheckpoint,
  type ExecutorRunHandle,
  findRepoRoot,
  readTimeoutMs,
  runExecutor,
} from "@server/lib/executor-runner";
import {
  type ExecutorConfig,
  findExecutorByParticipant,
  listPeerExecutorNames,
  parseRateLimitRecoveryMs,
  renderExecutorArgs,
} from "@server/lib/executors";
import { wsHub } from "@server/lib/ws-hub";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { recordExecutorOutput } from "../executor-availability";
import { adapterFor } from "./adapters/registry";
import { createAnsiStripper } from "./ansi";
import {
  backfillDetachedClosedTokenFields,
  beginAttempt,
  collectAttemptTokenUsage,
  endAttempt,
  markAttemptTokenUnavailable,
} from "./attempt-accounting";
import { hasDuplicateActiveRun } from "./cancel";
import { verifyReportedCommit } from "./claim-verification";
import {
  clearPersistedExecutorCooldown,
  EXECUTOR_COOLDOWN_END_MS_FIELD,
  listPersistedExecutorCooldowns,
} from "./cooldown-store";
import { appendTaskDetail } from "./detail-store";
import { applyDiffSummaryPatch } from "./diff-summary";
import {
  buildDispatchTargetAudit,
  countConsecutiveFailedChildren,
  createTaskDispatchWarnings,
  isCoordinatorTask,
  isReviewerNotDispatchableTarget,
  recordRedispatchStopped,
  resolveRoleTarget,
} from "./dispatch-target";
import {
  ensureGroupQueue,
  isRunDispatchable,
  runningForWorkspace,
  workspaceCap,
} from "./dispatchability";
import { failTask, handleFailure, isTransientQuota } from "./failure";
import {
  markTaskCancelled,
  notifyTaskStatusChanged,
  postStatus,
} from "./notify";
import {
  appendLiveTaskOutput,
  appendTaskOutput,
  liveTaskOutputTail,
  releaseTaskOutput,
} from "./output-buffer";
import { createExecutorOutputParser } from "./output-parser";
import { registerPump, requestPump } from "./pump-signal";
import {
  extractGenericJsonlText,
  findCommitHash,
  findProviderError,
  hasStructuredTaskReport,
  hasZeroTokenUsage,
  lastLinesOf,
  parseTaskReport,
  renderTaskCard,
  type TaskReport,
  taskOutputTailLines,
} from "./report";
import { registerTaskOwnerServer } from "./restart-recovery";
import { groupHasReviewerMember } from "./review-request-policy";
import {
  isConcurrencyConflict,
  spawnFailureReason,
  spawnFailureStatus,
} from "./spawn-failure";
import {
  activeRuns,
  classifyQuotaFailure,
  clearRunTimers,
  clearStaleTestRepoIndexLock,
  cooldownEndMs,
  cooldownTimers,
  type ExecutorCooldownSource,
  executorCooldownRecords,
  executorCooldowns,
  formatEta,
  getA2ASilenceTimeoutMs,
  getClaimTimeoutMs,
  getDetachedTimeoutMs,
  getMaxParallelGroups,
  getRateLimitCooldownMs,
  getRedispatchFailureLimit,
  getStallAlertMs,
  getStallTimeoutMs,
  getTransientQuotaPolicy,
  groupQueues,
  isInCooldown,
  pumping,
  type QuotaFailureVerdict,
  registerCoordinatorProcess,
  releaseCoordinatorProcess,
  runningExecutorCount,
  runningGroupCount,
  setPumping,
} from "./state";
import { liveStreamText, summaryStreamText } from "./stream-text";
import { resolveTaskRepo } from "./task-repo";
import {
  buildSpecSection,
  buildTicket,
  resolveTestExecutor,
} from "./ticket-builder";
import { loadTicketTemplate } from "./ticket-template";
import {
  handleA2ASilence,
  handleClaimTimeout,
  handleDetachedTimeout,
  handleStall,
  handleStallAlert,
  handleUnconfirmed,
  hasRecentA2AProgress,
} from "./timeout-handlers";
import {
  DEFAULT_GROUP_KEY,
  DISPATCH_ALLOWED_ROLES,
  type DispatchExecutorInput,
  type DispatchOutcome,
  type GroupPromptInfo,
  type GroupQueue,
  type QueuedRun,
  sumAttemptTokenUsage,
  sumAttemptTokenUsageReason,
} from "./types";

/* ---------------- 额度感知调度(票7) ---------------- */

/**
 * 执行器进入额度冷却:记录冷却结束时间并调度到期泵送(冷却结束后 pumpQueue
 * 自动把等待中的任务派发出去,无需人工干预)。重复进入只重置结束时间与定时器
 * (定时器防堆积)。返回冷却结束时间(epoch ms)。
 *
 * endMs 为绝对到期时刻(冷却动态化):调用方先尝试从失败输出解析恢复时间
 * (parseRateLimitRecoveryMs),解析失败才回退 now + 固定冷却时长。
 *
 * R7:解析出的时刻不在未来或过于接近当前时,回退到固定冷却兜底,避免产出
 * 形同虚设的冷却(如 1ms / 15s)。
 */
export const MIN_EFFECTIVE_COOLDOWN_MS = 60_000;

export function normalizeCooldownEnd(
  endMs: number,
  nowMs = Date.now(),
): number {
  if (endMs <= nowMs + MIN_EFFECTIVE_COOLDOWN_MS) {
    return nowMs + getRateLimitCooldownMs();
  }
  return endMs;
}

export function enterCooldown(
  ex: Pick<ExecutorConfig, "key" | "label">,
  endMs: number,
  sourceOrPersisted:
    | ExecutorCooldownSource
    | { db: DataBase; taskId: string } = "fallback",
  persisted?: { db: DataBase; taskId: string },
): number {
  // Keep the pre-source call shape usable by existing internal/test callers;
  // production call sites pass the source explicitly.
  const source: ExecutorCooldownSource =
    typeof sourceOrPersisted === "string" ? sourceOrPersisted : "fallback";
  const effectivePersisted =
    typeof sourceOrPersisted === "string" ? persisted : sourceOrPersisted;
  const previous = executorCooldownRecords.get(ex.key);
  const isActive = previous !== undefined && previous.endMs > Date.now();
  const discarded =
    source === "fallback" && previous?.source === "parsed" && isActive
      ? endMs
      : undefined;
  const end =
    discarded !== undefined
      ? (previous?.endMs ?? endMs)
      : previous === undefined ||
          previous.endMs <= Date.now() ||
          (source === "parsed" && previous.source === "fallback")
        ? endMs
        : Math.max(previous.endMs, endMs);
  const record = {
    endMs: end,
    source: discarded === undefined ? source : (previous?.source ?? source),
    taskId: effectivePersisted?.taskId ?? previous?.taskId,
  } satisfies import("./state").ExecutorCooldownRecord;
  executorCooldownRecords.set(ex.key, record);
  executorCooldowns.set(ex.key, end);
  if (discarded !== undefined) {
    console.log(
      `[executor] 丢弃 ${ex.key} fallback 冷却 ${endMs},已有 parsed 冷却 ${end}:仍未到期`,
    );
    if (effectivePersisted)
      void appendCooldownAudit(
        effectivePersisted.db,
        effectivePersisted.taskId,
        end,
        source,
        discarded,
      );
  }
  const prev = cooldownTimers.get(ex.key);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(
    () => {
      // 竞态保护:冷却可能已被更新的 enterCooldown 重置/延长;只有本定时器仍是
      // 当前登记项时才清理,避免陈旧回调误删新冷却条目(提前解除冷却)。
      if (cooldownTimers.get(ex.key) !== timer) return;
      cooldownTimers.delete(ex.key);
      executorCooldowns.delete(ex.key);
      executorCooldownRecords.delete(ex.key);
      console.log(`[executor] 执行器 ${ex.key} 额度冷却结束,恢复派发`);
      if (effectivePersisted) {
        void clearPersistedExecutorCooldown(
          effectivePersisted.db,
          effectivePersisted.taskId,
        ).catch((error) => {
          console.warn(
            `[executor] 清理持久化额度冷却失败(${ex.key}): ${error}`,
          );
        });
      }
      requestPump();
    },
    Math.max(1, end - Date.now()),
  );
  cooldownTimers.set(ex.key, timer);
  console.log(
    `[executor] 执行器 ${ex.key} 触发额度冷却,预计 ${formatEta(end)} 恢复`,
  );
  return end;
}

async function appendCooldownAudit(
  db: DataBase,
  taskId: string,
  endMs: number,
  source: ExecutorCooldownSource,
  discardedEndMs: number,
): Promise<void> {
  const row = await db.query.task.findFirst({
    where: (task, { eq }) => eq(task.id, taskId),
    columns: { diffSummary: true },
  });
  const next = applyDiffSummaryPatch(row?.diffSummary, {
    executorCooldownSource: source,
    executorCooldownEndMs: endMs,
    discardedCooldownEndMs: discardedEndMs,
    cooldownDiscardReason: "已有未到期 parsed 冷却,拒绝 fallback 覆盖",
  });
  await db
    .update(taskTable)
    .set({ diffSummary: next })
    .where(eq(taskTable.id, taskId));
}

/**
 * 服务启动恢复额度冷却:每个 executorKey 采用最新一条未过期的 task 记录,
 * 重建内存判定状态与到期定时器;过期或被更新记录立即清理,不得复活。
 */
export async function restoreExecutorCooldowns(
  db: DataBase,
  nowMs = Date.now(),
): Promise<number> {
  const records = await listPersistedExecutorCooldowns(db);
  const seenKeys = new Set<string>();
  const restoredKeys = new Set<string>();

  for (const record of records) {
    // 最新记录决定该执行器的重启前最终状态。即使最新记录已过期,也不能继续
    // 向后寻找更老但到期更晚的记录,否则会把已结束的旧冷却复活。
    if (seenKeys.has(record.executorKey)) {
      await clearPersistedExecutorCooldown(db, record.taskId);
      continue;
    }
    seenKeys.add(record.executorKey);
    if (record.endMs <= nowMs) {
      await clearPersistedExecutorCooldown(db, record.taskId);
      continue;
    }
    restoredKeys.add(record.executorKey);
    enterCooldown(
      { key: record.executorKey, label: record.executorKey },
      record.endMs,
      record.source ?? "fallback",
      { db, taskId: record.taskId },
    );
  }

  if (restoredKeys.size > 0) {
    console.log(
      `[executor] 启动恢复:${restoredKeys.size} 个执行器仍处于额度冷却`,
    );
  }
  return restoredKeys.size;
}

/**
 * R4(specs/quota-misclassified-from-coordinator-narration.md):手动清除执行器
 * 额度冷却 —— 内存登记 + 到期定时器 + 持久化标记(task.diffSummary 的
 * executorCooldownEndMs/executorCooldownSource)一并清掉;否则重启时会被
 * restoreExecutorCooldowns 复活。清完后泵队列,让被冷却挡住的 queued 任务
 * 立即重试。幂等:本就无冷却时返回 cleared=false,不泵队列。
 *
 * ADR-0009:拿「读到的最新未过期标记」代替「逐条历史记录」判定要不要清;
 * 不成立的情形是有人手工改库回填更老记录 —— 老记录本就应被清除,顺带清掉
 * 无害(下一次真冷却会写入新标记)。
 */
export async function clearExecutorCooldown(
  db: DataBase,
  key: string,
): Promise<{ cleared: boolean; taskIds: string[] }> {
  const hadInMemory =
    executorCooldowns.has(key) || executorCooldownRecords.has(key);
  const timer = cooldownTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    cooldownTimers.delete(key);
  }
  executorCooldowns.delete(key);
  executorCooldownRecords.delete(key);

  // 持久化标记:该执行器最新一条未过期记录即判定状态;清掉它,重启不会复活。
  const taskIds: string[] = [];
  const persisted = await listPersistedExecutorCooldowns(db);
  for (const record of persisted) {
    if (record.executorKey !== key) continue;
    if (record.endMs <= Date.now()) continue;
    await clearPersistedExecutorCooldown(db, record.taskId);
    taskIds.push(record.taskId);
  }

  const cleared = hadInMemory || taskIds.length > 0;
  if (cleared) {
    console.log(
      `[executor] 手动清除执行器 ${key} 的额度冷却(内存=${hadInMemory},持久化任务=${taskIds.length}),立即恢复派发`,
    );
    requestPump();
  }
  return { cleared, taskIds };
}

/* ---------------- 执行器级并发(设计修正:按执行器实际并发能力排队) ---------------- */

/** 403 后重试最小退避(ms):无既有 running 任务(外部会话占用)时防空转热循环。 */
const CONCURRENCY_RETRY_BACKOFF_MS = 3_000;

/**
 * 组队首任务当前是否可派发(泵送选组谓词):
 *  - 执行器额度冷却中 → 否(票7,冷却结束定时器会再泵送);
 *  - 目标执行器 running 数 >= maxConcurrency(声明式上限)→ 否(保持 queued,
 *    等既有任务终态后由完成路径的泵送自动出队);
 *  - 403 后重新排队(反应式排队)→ 既有同执行器 running 任务未清空 → 否;
 *    退避窗口未过(外部会话占用)→ 否;
 *  - per-run 退避窗口(concurrencyRetryAt)未过 → 否(403 退避与瞬时限流退避
 *    同字段,后者不置 concurrencyBlocked —— 那是并发冲突语义,瞬时限流无需
 *    等其他 running 任务清空)。
 */

/* ---------------- 队列 / 调度 ---------------- */

/** 进程存活判定随其余共享状态收在 state.ts;此处转出保持既有导入路径可用。 */
export { isExecutorProcessAlive } from "./state";

/**
 * 触发入口(路由 fire-and-forget 调用,不 await):命中执行器配置则
 * 幂等建 task + 入队;不命中/无权限/桥已执行则静默返回。
 * audience=role(角色定向)时按 R1 解析本群目标成员后走同一流程,失败返回
 * DispatchOutcome 供调用方发出可见信号(R3,不静默跳过)。
 */
export async function maybeDispatchExecutorTask(
  db: DataBase,
  input: DispatchExecutorInput,
): Promise<DispatchOutcome | undefined> {
  const {
    groupId,
    messageId,
    senderRoles,
    audience,
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
    initialDiffSummary,
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
    return { status: "skipped", reason: "sender-not-authorized" };
  }

  // 检视者不可被派发(dispatch-must-not-spawn-the-reviewer):无论是否有执行器
  // 配置、无论 audience 是 participant 还是 role。消息路由层也会拦,这里是
  // 派发层第二道闸,避免其它入口漏过。
  const dispatchAudience = audience ?? "participant";
  if (
    await isReviewerNotDispatchableTarget(
      db,
      groupId,
      dispatchAudience,
      audienceRef,
    )
  ) {
    console.log(
      `[executor] 跳过:目标为 reviewer(audience=${dispatchAudience},ref=${audienceRef}),不可派发`,
    );
    return { status: "reviewer-not-dispatchable" };
  }

  // R1:audience=role → 按角色解析本群目标成员,其余流程(建任务、任务书、
  // spawn)与 participant 定向完全一致。
  // R5:平台按角色选出的是**接收这张协调任务的协调者**,不是 L1 执行器 ——
  // 协调者收到后仍应按协调者 skill §2.2 自行挑选执行器下发 L1,平台不代劳。
  if (dispatchAudience === "role") {
    const resolved = await resolveRoleTarget(db, groupId, audienceRef);
    if (resolved.status !== "ok") {
      console.error(
        `[executor] 角色定向失败:role=${resolved.role} reason=${resolved.reason},不创建任务`,
      );
      return {
        status: "role-unresolved",
        reason: resolved.reason,
        role: resolved.role,
      };
    }
    const groupPrompt: GroupPromptInfo = {
      roles: resolved.membership.roles,
      prompt: resolved.membership.prompt,
    };
    const outcome = await dispatchTask(db, {
      groupId,
      messageId,
      participantId: resolved.participant.id,
      ex: resolved.ex,
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
      initialDiffSummary: initialDiffSummary ?? null,
    });
    return (
      outcome ?? {
        status: "dispatched",
        participantId: resolved.participant.id,
      }
    );
  }

  // audienceRef → participant → executor 配置(按 participant.executorKey 稳定绑定)。
  const participant = await db.query.participant.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.id, audienceRef),
  });
  if (!participant) {
    console.log(
      `[executor] 跳过:audienceRef ${audienceRef} 无对应 participant`,
    );
    return { status: "skipped", reason: "participant-not-found" };
  }
  const ex = await findExecutorByParticipant(db, participant);
  if (!ex) {
    console.log(
      `[executor] 跳过:participant ${participant.name} 不在执行器配置中`,
    );
    return { status: "skipped", reason: "executor-not-configured" };
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

  const outcome = await dispatchTask(db, {
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
    initialDiffSummary: initialDiffSummary ?? null,
  });
  return (
    outcome ?? {
      status: "dispatched",
      participantId: participant.id,
    }
  );
}

/**
 * 将已经持久化的 task 放入现有队列并启动 pump。
 *
 * Coordinator resume tasks are created by the durable completion-event
 * consumer, so they cannot go through the message route a second time. This
 * helper is the same queue admission path used by normal dispatch, without
 * creating another task row or another spawn mechanism.
 */
export async function enqueueTaskRun(
  db: DataBase,
  task: typeof taskTable.$inferSelect,
  opts: {
    groupId: string;
    messageId: string;
    participantId: string;
    ex: ExecutorConfig;
    body: string;
    groupPrompt: GroupPromptInfo | null;
    specRef: string | null;
    specHash: string | null;
  },
): Promise<void> {
  const {
    groupId,
    messageId,
    participantId,
    ex,
    body,
    groupPrompt,
    specRef,
    specHash,
  } = opts;
  const summary = summaryOf(body);
  const groupRow = await db.query.groups.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.id, groupId),
  });
  const projectPath = groupRow?.projectPath?.trim() || null;
  const groupKey = projectPath ?? DEFAULT_GROUP_KEY;
  const group = ensureGroupQueue(groupKey);
  const running = runningGroupCount();
  const freeSlots = getMaxParallelGroups() - running;
  const exCap = ex.maxConcurrency;
  const exSelfRunning = group.running.filter((r) => r.ex.key === ex.key).length;
  const exAhead =
    exCap !== undefined && runningExecutorCount(ex.key) >= exCap
      ? Math.max(0, runningExecutorCount(ex.key) - exSelfRunning)
      : 0;
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
    specRef,
    specHash,
    // 规范驱动下发类型(任务书「汇报格式要求」段裁定 review_request 用)。
    dispatchKind: task.dispatchKind,
    concurrencyBlocked: false,
    concurrencyRetryAt: 0,
    transientQuotaCount: 0,
    attempts: Array.isArray(task.attempts) ? task.attempts : [],
  };
  group.queue.push(run);

  if (isInCooldown(ex)) {
    const eta = formatEta(cooldownEndMs(ex));
    const nextWaiting = applyDiffSummaryPatch(task.diffSummary, {
      waiting: `等待执行器额度恢复(预计 ${eta})`,
    });
    await db
      .update(taskTable)
      .set({ diffSummary: nextWaiting })
      .where(and(eq(taskTable.id, task.id), eq(taskTable.groupId, groupId)))
      .catch((error) =>
        console.warn(`[executor] 写等待恢复标记失败(${task.id}): ${error}`),
      );
    await postStatus(
      db,
      groupId,
      participantId,
      ex,
      `⏳ [${ex.label}] 任务等待执行器额度恢复(预计 ${eta}): ${summary}`,
    );
  }

  run.claimTimer = setTimeout(
    () => handleClaimTimeout(run),
    getClaimTimeoutMs(),
  );
  requestPump();
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
    /** R2 缺省审计:findings 未显式指定 dispatchKind 而缺省为 fix 时的 diffSummary 留痕 */
    initialDiffSummary?: Record<string, unknown> | null;
  },
): Promise<DispatchOutcome | undefined> {
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
    initialDiffSummary,
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
    columns: {
      id: true,
      groupId: true,
      executorKey: true,
      executorParticipantId: true,
      diffSummary: true,
    },
  });

  // 重派熔断(R4,specs/quota-exhaustion-triggers-infinite-retry):同一父任务名下
  // 连续失败子任务数达阈值(默认 5)后停止重派 —— 兜底防线,与原因识别无关
  // (即使原因识别失败,只要连续失败达阈值也必须熔断,否则 72 连派事故还会发生)。
  // 命中 → 不创建任务,父任务 diffSummary + 群消息各留一条可读记录(等待人工介入)。
  if (parent) {
    const consecutive = await countConsecutiveFailedChildren(db, parent.id);
    if (consecutive >= getRedispatchFailureLimit()) {
      await recordRedispatchStopped(db, parent, consecutive);
      return { status: "redispatch-stopped", parentTaskId: parent.id };
    }
  }

  // 审计记录服务端观察到的派发目标:名字取该 participant 在库中的真实 name,
  // 而不是执行器配置的 agentName —— 角色词(「执行器」等)与群无关,烙进审计
  // 名会误导协调者按名字推断角色(见 spec agent-name-says-executor-regardless-of-role)。
  const targetParticipant = await db.query.participant.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.id, participantId),
    columns: { name: true },
  });
  const dispatchAudit = await buildDispatchTargetAudit(
    db,
    groupId,
    dispatcherParticipantId,
    { id: participantId, name: targetParticipant?.name ?? ex.agentName },
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
      // R2 缺省审计:findings 未显式指定 dispatchKind 而缺省为 fix 时的留痕
      diffSummary: initialDiffSummary ?? null,
      // 任务下发者信息(Part A):sender + 会话 id(仅群内角色命中
      // DISPATCH_ALLOWED_ROLES 的发送者 metadata;否则 null)。body 绝不注入
      // 任何 session 元数据。
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
    // 规范驱动下发类型(任务书「汇报格式要求」段裁定 review_request 用)。
    dispatchKind: task.dispatchKind,
    // 403 反应式排队标记:默认未阻塞(显式 maxConcurrency 由 pump 直接排队,
    // 不会置位本标记;收到执行器 403 并发冲突后才置位)。
    concurrencyBlocked: false,
    concurrencyRetryAt: 0,
    // 连续瞬时限流计数(spec transient-ratelimit-… R2):新 run 从 0 起算。
    transientQuotaCount: 0,
    // 执行历史:沿用 DB 既有 attempts(重新执行的任务保留旧尝试,新 attempt 续接)。
    attempts: Array.isArray(task.attempts) ? task.attempts : [],
  };
  group.queue.push(run);

  // 额度冷却中入队的任务(票7):标记「等待执行器额度恢复」+ ⏳ 回传,不 spawn
  // (泵送跳过冷却执行器,冷却结束定时器会自动派发,任务保持 queued 等待)。
  if (isInCooldown(ex)) {
    const eta = formatEta(cooldownEndMs(ex));
    const nextWaiting = applyDiffSummaryPatch(task.diffSummary, {
      waiting: `等待执行器额度恢复(预计 ${eta})`,
    });
    try {
      await db
        .update(taskTable)
        .set({ diffSummary: nextWaiting })
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
  requestPump();
}

/* ---------------- 重派熔断(R4,specs/quota-exhaustion-triggers-infinite-retry) ---------------- */

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
      activeRuns.add(run);
      void runOne(run, group);
    }
  } finally {
    setPumping(false);
  }
}

// 模块顶层注册:加载本文件即挂上真正的泵,调用方只发 requestPump 信号。
registerPump(() => void pumpQueue());

/** 运行单个组任务:queued → running → spawn → done/failed → 清槽位 → 泵下一个。 */
async function runOne(run: QueuedRun, group: GroupQueue): Promise<void> {
  const { db, groupId, taskId, participantId, ex, body, summary, groupPrompt } =
    run;

  try {
    // R2 转述排除:分类需知「除本执行器外的全部执行器标识」。
    // ⚠️ 必须**惰性**取:放在 runOne 开头 await 会在「置 running」与「spawn 占位」
    // 之间插入一个额外的事件循环让点,工作树占位守卫因此出现可观察的空窗
    // (executor-coordinator-workspace-gate 验收 1 实测 occupancy 读到 0)。
    // 只有走到额度分类那几条失败路径才需要它,那时再取,TTL 缓存开销可忽略。
    let peerExecutorNamesCache: string[] | undefined;
    const getPeerExecutorNames = async (): Promise<string[]> => {
      peerExecutorNamesCache ??= await listPeerExecutorNames(db, ex.key);
      return peerExecutorNamesCache;
    };
    // 重复入队(回收扫描与派发竞态):丢弃本次,任务状态不写 —— 先到的那个
    // run 正在(或已经)执行它。直接 return,finally 照常释放槽位并泵下一个。
    if (hasDuplicateActiveRun(run)) {
      clearRunTimers(run);
      console.warn(
        `[executor] 任务 ${taskId} 已有活跃 run,丢弃本次重复入队(不重复 spawn)`,
      );
      return;
    }

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

    // 🚀 开始执行(与桥的 emoji 状态条一致;spec live-output-hide-thinking-…
    // R6 恢复 —— 状态条承载排队位次/失败原因等信息,问题在于前端把它渲染成
    // 一条普通发言,修复在渲染侧:task_status 按轻量状态提示渲染)。
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
    const isCoordinator = await isCoordinatorTask(db, groupId, participantId);
    const detached = detachedByReplyMode || isCoordinator;
    run.detached = detached;
    // 记忆开关:仅 memory="per-group" 的协调器启用 contextId 延续(查/回写);
    // 纯粹执行器(无 memory 标记,含普通 a2a)无记忆——任务书自包含。
    // 声明在分支外:完成路径(回写)同样需要判断,不能只在 a2a 分支内定义。
    const memoryPerGroup = isA2a && ex.memory === "per-group";
    let handle: ExecutorRunHandle;
    // 执行器输出解析器:每次执行一个,按 executorKey 把 codex JSONL / AtomCode
    // 前缀行解析成动作行后再进缓冲(压缩噪音);解析不出的行逐字保留。
    // 声明在分支外:完成路径(进程退出后 flush 残留)同样需要引用,不能只在
    // CLI 分支内定义;a2a 分支的解析器是透传空实现,不会被 flush 到。
    const parseOutput = createExecutorOutputParser(ex.key);
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
        ? `${buildSpecSection(
            run.specRef,
            run.specHash,
            loadTicketTemplate(run.dispatchKind).specInstruction,
          ).join("\n")}\n\n${body}`
        : body;
      // spawn 紧邻前再查一次 stopped(开头守卫在 pump→runOne 同步段不可达;
      // 停止指令常落在中间多个 await 窗口)。命中则不再调用 gateway。
      // 检查本身同步;仅命中分支 await —— 未命中路径不引入新让点。
      if (run.stopped) {
        console.log(`[executor] 任务已在 spawn 前被停止: ${taskId}`);
        clearRunTimers(run);
        await markTaskCancelled(db, taskId, groupId, run.attempts);
        return;
      }
      handle = {
        pid: undefined,
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
      // R2:拿到 handle 后第一时间登记 kill,消除「请求已发出但 cancel 空操作」窗口。
      run.kill = handle.kill;
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
        // R3 反向守卫共用判定:任务书「汇报格式要求」段按 dispatchKind + 群内
        // reviewer 编制裁定 review_request 是否可携带(与 tasks.ts PATCH 终态
        // 守卫共用同一判定,避免任务书教协调者携带会被 400 拒收的载荷)。
        const groupHasReviewer = await groupHasReviewerMember(db, run.groupId);
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
            groupHasReviewer,
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

      // ⚠️ 快照**前**再清一次陈旧锁(仅测试进程内生效)。测试重置里的
      // `r.kill?.()` 不等待:被杀的 git 可能在重置**之后**才写出 index.lock,
      // 只在重置时清会漏(实测 10 轮仍复现 1 次)。在用之前清才盖得住这个竞态。
      clearStaleTestRepoIndexLock();
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
      // inputMode/env 的解读**只**走 resolveExecutorCliSpawn(单一消费入口,R3);
      // {model} 占位由 renderExecutorArgs 处理(无 model 时移除该参数项)。
      const ticketContent = readFileSync(ticketPath, "utf8");
      const spawnPlan = resolveExecutorCliSpawn({
        argsTemplate: ex.args,
        model: ex.model,
        inputMode: ex.inputMode,
        env: ex.env,
        ticketPath,
        ticketContent,
        renderArgs: renderExecutorArgs,
      });
      console.log(
        `[executor] server 侧 spawn: ${ex.bin} ${spawnPlan.args.join(" ")} (cwd=${repoRoot}, group=${run.groupKey}, task=${taskId})`,
      );
      // R1:登记属主实例(本 server pid)——启动兜底据此区分「本实例的任务」与
      // 「另一个活实例的任务」,不再把同库异端口的实例启动当成生产重启。
      await registerTaskOwnerServer(db, taskId, groupId);
      // spawn 紧邻前再查一次 stopped(开头守卫在 pump→runOne 同步段不可达;
      // 停止指令常落在中间多个 await 窗口)。命中则不再 spawn。
      // 检查本身同步;仅命中分支 await —— 未命中路径不引入新让点。
      if (run.stopped) {
        console.log(`[executor] 任务已在 spawn 前被停止: ${taskId}`);
        clearRunTimers(run);
        await markTaskCancelled(db, taskId, groupId, run.attempts);
        return;
      }
      // ANSI 剥离器:每次执行一个(跨 chunk 转义序列扣尾拼接),输出路径共用。
      const stripAnsiChunk = createAnsiStripper();
      handle = runExecutor({
        bin: ex.bin,
        args: spawnPlan.args,
        cwd: repoRoot,
        ...(spawnPlan.envOverlay ? { env: spawnPlan.envOverlay } : {}),
        ...(spawnPlan.stdin != null ? { stdin: spawnPlan.stdin } : {}),
        onOutput: (chunk, source) => {
          // 流式日志 + 实时进度:server 控制台保留原样(带色便于排查);入环形
          // 缓冲(includeOutput 拉取/断线重连用)与 WS 广播(task_output 事件)
          // 走剥离后的文本——剥在唯一源头,前端/插件/兜底拉取一次性受益。
          process.stdout.write(chunk);
          const clean = stripAnsiChunk(chunk);
          // 两层级输出(spec two-tier-output-summary-and-detail + live-output-only-agent-narration):
          // 解析器产出结构化条目,持久化摘要进全量环形缓冲(保留 tool/command/error/raw),
          // 界面流仅 report 进 live 缓冲 + WS 广播;完整原文逐条落盘明细 JSONL(R4)。
          const entries = parseOutput(clean, source);
          if (entries.length > 0) {
            // R3:持久化口径逐字不变——全量摘要流(仅 thinking/空行过滤)进 appendTaskOutput/DB。
            const summaryText = summaryStreamText(entries);
            if (summaryText.length > 0) {
              appendTaskOutput(taskId, summaryText);
            }
            // R1:界面只渲染 kind=report —— WS 与 includeOutput 同界过滤。
            const liveText = liveStreamText(entries);
            if (liveText.length > 0) {
              appendLiveTaskOutput(taskId, liveText);
              void wsHub.broadcastTaskOutput(groupId, taskId, liveText);
            }
            for (const entry of entries) appendTaskDetail(taskId, entry);
          }
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
      // R2:拿到 handle 后第一时间登记 kill(在 stall 定时器与 pid 落库 await 之前),
      // 消除「进程已跑但 cancelRunningTasks 空操作」窗口。
      run.kill = handle.kill;
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
    if (handle.pid !== undefined) {
      await db
        .update(taskTable)
        .set({ executorPid: handle.pid })
        .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)));
    }
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
      // R1(spec multiple-coordinators-with-global-serialization):协调进程同样
      // 写这棵工作树(L2 测试代跑),但 detached 任务 spawn 后队列槽位立即释放
      // —— 既有工作树闸看不见它。这里按「进程存活」把它计入占用,与执行器任务
      // 合并计数:协调进程的存活期间,同工作树的执行器任务与新协调票都排队。
      if (isCoordinator)
        registerCoordinatorProcess(run.projectPath, handle.pid);
      console.log(
        `[executor] detached 任务已派发(cli),等待执行器回写终态: ${taskId}`,
      );
      if (!run.detachedTimer && !run.detachedTimedOut && !run.stopped) {
        run.detachedTimer = setTimeout(
          () => handleDetachedTimeout(run),
          getDetachedTimeoutMs(),
        );
      }
      // 进程退出 = 工作树占用释放:撤销登记后泵一次,让被闸挡住的任务由既有
      // 排队/泵机制拉起(不新建调度器)。登记表的存活判定本身已足以让占用在
      // 退出即消失,这里只是把「释放」这个已知出口显式化,避免依赖僵尸进程回收
      // 的时序。成功与启动失败两条出口同一处置。
      const releaseCoordinatorGate = () => {
        releaseCoordinatorProcess(handle.pid);
        requestPump();
      };
      // 进程句柄保留在 run 上(handleDetachedTimeout 复查 DB 状态用)。正常退出
      // 不决定 detached 任务终态,但仍在这里读取该进程的原生 token 账本并写入
      // attempt;之后由执行器 runtime PATCH 任务终态。reject 只在 spawn 失败
      // (bin 不存在等)或进程 error 事件时发生——启动失败不能让任务静默挂
      // running 直到 detached 超时,立即失败并 ❌ 回传。
      void handle.promise
        .then(
          async (result) => {
            releaseCoordinatorGate();
            await collectAttemptTokenUsage(run, handle.pid, repoRoot, result);
            // 续跑任务(及任何由协调者自己在进程内 PATCH 结案的 detached 任务):
            // 结案那一刻 attempts 尚无 tokenUsage(采集只在进程退出后发生),
            // PATCH 路由的 R1 回填因此落空。进程退出、采集落库后,若任务已被
            // PATCH 落终态且 diffSummary 缺这两个键 → 在此补写(与 PATCH R1
            // 同口径:sumAttemptToken* + undefined 不写,调用方显式键优先)。
            await backfillDetachedClosedTokenFields(
              run.db,
              run.taskId,
              run.groupId,
              run.attempts,
            );
          },
          (e) => {
            releaseCoordinatorGate();
            const msg = e instanceof Error ? e.message : String(e);
            console.error(
              `[executor] detached 任务启动失败(${taskId}): ${msg}`,
            );
            void (async () => {
              try {
                const cur = await db.query.task.findFirst({
                  where: (t, { and: andFn, eq: eqFn }) =>
                    andFn(eqFn(t.id, taskId), eqFn(t.groupId, groupId)),
                  columns: { status: true },
                });
                // 已回写终态(如 detached 超时先行)→ 不覆盖。
                if (cur?.status !== "running") return;
                markAttemptTokenUnavailable(run);
                await failTask(
                  db,
                  taskId,
                  `执行器启动失败: ${spawnFailureReason(msg)}`,
                  0,
                  undefined,
                  run.attempts,
                );
                await postStatus(
                  db,
                  groupId,
                  participantId,
                  ex,
                  spawnFailureStatus(ex, msg),
                );
              } catch (err) {
                console.warn(
                  `[executor] detached 启动失败处理异常(${taskId}): ${err}`,
                );
              }
            })();
          },
        )
        .catch((e) => {
          console.warn(
            `[executor] detached token usage 采集失败(${taskId}): ${e}`,
          );
        });
      return;
    }

    try {
      const result = await handle.promise;
      await collectAttemptTokenUsage(run, handle.pid, repoRoot, result);
      // 进程已退出:吐出解析器残留的未成行尾部(逐字),保证 R3 不丢任何一行。
      // flush 按来源分别吐出 stdout/stderr 两侧残留:stdout 尾段按 report 进界面,
      // stderr 尾段维持 stderr 判定口径,与流内已成行的行一致。
      const flushed = parseOutput.flush();
      if (flushed.length > 0) {
        const summaryText = summaryStreamText(flushed);
        if (summaryText.length > 0) {
          appendTaskOutput(taskId, summaryText);
        }
        const liveText = liveStreamText(flushed);
        if (liveText.length > 0) {
          appendLiveTaskOutput(taskId, liveText);
          void wsHub.broadcastTaskOutput(groupId, taskId, liveText);
        }
        for (const entry of flushed) appendTaskDetail(taskId, entry);
      }
      // 停止指令已 kill 进程组:完成回调置 cancelled,不再回传 ❌/✅(停止
      // 指令自己已回传 🛑)。
      if (run.stopped) {
        console.log(`[executor] 任务已停止: ${taskId}`);
        await endAttempt(run, { status: "cancelled" });
        const liveTail = liveTaskOutputTail(taskId);
        releaseTaskOutput(taskId);
        const tokenUsage = sumAttemptTokenUsage(run.attempts);
        const tokenUsageReason = sumAttemptTokenUsageReason(run.attempts);
        {
          const cur = await db.query.task.findFirst({
            where: and(
              eq(taskTable.id, taskId),
              eq(taskTable.groupId, groupId),
            ),
            columns: { diffSummary: true },
          });
          const nextCancelled = applyDiffSummaryPatch(cur?.diffSummary, {
            error: "stopped",
            ...(tokenUsage !== undefined ? { tokenUsage } : {}),
            ...(tokenUsageReason ? { tokenUsageReason } : {}),
            ...(liveTail ? { liveOutputTail: liveTail } : {}),
          });
          const [cancelled] = await db
            .update(taskTable)
            .set({
              status: "cancelled",
              diffSummary: nextCancelled,
            })
            .where(
              and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)),
            )
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
        // 超时且已捕获输出(尾部,与失败回传同界)含额度关键词且带正面结构证据
        // (恢复时刻/错误行形状;R1:退出码不是证据)→ 额度失败;R2:点名其它
        // 执行器/引用平台 id 或字段的转述行不算证据。
        const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
        const timeoutQuota = classifyQuotaFailure([lastLinesOf(out, 20)], {
          taskBook: run.body,
          peerExecutorNames: await getPeerExecutorNames(),
        });
        if (timeoutQuota.isQuota) {
          // 瞬时限流(短相对恢复提示):per-run 退避重试,不进执行器级冷却。
          if (isTransientQuota(timeoutQuota)) {
            await handleTransientQuotaBackoff(
              run,
              "执行超时",
              out,
              timeoutQuota.matchedLine,
            );
            return;
          }
          // 冷却动态化:优先从失败输出解析恢复时间,解析失败回退固定冷却。
          // R7:解析出的时刻不在未来或过于接近当前时,回退到固定冷却兜底。
          const parsedMs = parseRateLimitRecoveryMs(out);
          const cooldownEnd = normalizeCooldownEnd(
            parsedMs ?? Date.now() + getRateLimitCooldownMs(),
          );
          const eta = formatEta(cooldownEnd);
          const extra: Record<string, unknown> = {
            [EXECUTOR_COOLDOWN_END_MS_FIELD]: cooldownEnd,
            executorCooldownSource:
              parsedMs !== null &&
              parsedMs > Date.now() + MIN_EFFECTIVE_COOLDOWN_MS
                ? "parsed"
                : "fallback",
            // 与 handleQuotaFailure 出口同口径的额度分级留痕(R4/验收 7)。
            quotaKind: "exhausted",
            quotaMatchedLine: timeoutQuota.matchedLine,
          };
          if (
            parsedMs !== null &&
            parsedMs <= Date.now() + MIN_EFFECTIVE_COOLDOWN_MS
          ) {
            extra.cooldownFallbackReason = "解析所得时刻不可用,已回退固定冷却";
            extra.discardedCooldownEndMs = parsedMs;
          }
          await handleFailure(
            run,
            `执行超时(执行器额度限制,预计 ${eta} 恢复)`,
            {
              retryable: false,
              message: `❌ [${ex.label}] 任务失败 (执行器额度限制,预计 ${eta} 恢复)`,
              extra,
              afterPersisted: () =>
                enterCooldown(
                  ex,
                  cooldownEnd,
                  parsedMs !== null &&
                    parsedMs > Date.now() + MIN_EFFECTIVE_COOLDOWN_MS
                    ? "parsed"
                    : "fallback",
                  { db, taskId },
                ),
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
      const executorText =
        adapterFor(ex.key).extractFinalText?.(result.stdout ?? "") ??
        // 无专用提取器的执行器(如 Pi):通用 JSONL 兜底,从最后一条
        // assistant 消息/事件取文本正文;非 JSONL / 无 assistant 文本时
        // 返回 undefined,保持 legacy 路径逐字一致。
        extractGenericJsonlText(result.stdout ?? "");
      const output = executorText
        ? `${executorText}\n${result.stderr ?? ""}`
        : `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      if (result.code === 0) {
        // 成功路径也要过额度检测(quota-failure-on-clean-exit 规范):执行器
        // 礼貌地打印额度耗尽说明后正常退出(如 `[rate-limited] 5h window
        // exhausted`),走的是 exit 0 路径,若只在超时/失败分支检测会漏判为
        // done。与失败分支(1365)同界(尾部 20 行)命中 → 按额度失败处理(逐条
        // 一致:failed / 冷却 / 不重试 / 回传预计恢复时间);前部命中尾部不命中
        // 则不判(避免误判停派)。不含额度关键词时行为完全不变(继续 done 路径)。
        const successTail = lastLinesOf(output, 20).slice(0, 1500);
        const successQuota = classifyQuotaFailure([successTail], {
          exitCode: 0,
          taskBook: run.body,
          peerExecutorNames: await getPeerExecutorNames(),
        });
        // R6 主闸(quota-failure-on-clean-exit v1.1):exit 0 时先以「本次任务
        // 窗口内是否产生提交」为闸 —— 有提交 → 一律不判额度、不进入冷却(运行
        // 中途出现瞬时限流退避行不代表耗尽,实证 01a05103-db4c:提交 1862e03f
        // 真实存在却因 [rate-limited] auto-continuing in 3s… 被误判停派 5 小时);
        // 无提交 → 保留既有额度语义。只收紧干净退出这一条路径,非零退出/超时
        // 分支逐字不变。
        // R9:为可归因产出判据先解析汇报(与正式汇报同口径),供主闸核实
        const prelimReport: TaskReport = isA2a
          ? (() => {
              const h = findCommitHash(output);
              return {
                summary: (result.stdout ?? "").trim(),
                ...(h ? { hash: h } : {}),
              };
            })()
          : parseTaskReport(output);
        const providerError = findProviderError(output);
        const platformTokenUsage = sumAttemptTokenUsage(run.attempts);
        // 判据收紧到「**执行器根本没输出**」:2026-09-06 事故里 Pi 被 provider
        // 拒绝时 stdout 是**零字节**。「跑了但没给结构化汇报」是另一回事 ——
        // 限流退避、R9 次闸等既有路径本来就以 exit 0 + 无汇报 + 无 token 落 done。
        const zeroOutput =
          output.trim().length === 0 &&
          !hasStructuredTaskReport(prelimReport) &&
          hasZeroTokenUsage(platformTokenUsage);
        // ⚠️ 顺序与优先级(2026-09-07 回归实测):
        // 1) **额度判定优先**。额度失败常常就是 exit 0 + 零提交 + 零 token,
        //    零产出抢在前面会把它整类吞掉(实测 11 条既有用例转红)。
        // 2) **单凭 providerError 不判失败**。`[rate-limited] auto-continuing…`
        //    也命中提供方错误形状,而那类运行确实在干活、既有语义是落 done;
        //    拿它判死会吞掉 R6 主闸/R9 次闸整条路径。providerError 只作证据附注。
        if (zeroOutput && !successQuota.isQuota) {
          const zeroOutputCount = recordExecutorOutput(run.ex.key, zeroOutput);
          const reason = providerError
            ? `执行器服务商错误: ${providerError}`
            : "executor-no-output: 执行器零产出(无结构化汇报且 token 用量为零或不可得)";
          await handleFailure(run, reason, {
            retryable: false,
            message: `❌ [${ex.label}] 任务失败 (${reason})`,
            extra: {
              ...(zeroOutput ? { zeroOutput: true } : {}),
              ...(providerError ? { providerError } : {}),
            },
          });
          if (zeroOutputCount === 2) {
            await postStatus(
              db,
              groupId,
              participantId,
              ex,
              `⚠️ [${ex.label}] 连续零产出 2 次,疑似 provider 拒绝;请介入`,
            );
          }
          return;
        }
        recordExecutorOutput(run.ex.key, false);
        let quotaMatchedButCommitFound:
          | { matchedLine: string | null; note: string }
          | undefined;
        let quotaMatchedButTransient:
          | { matchedLine: string | null; note: string }
          | undefined;
        if (successQuota.isQuota) {
          // R9-a 次闸(必须):复用 classifyQuotaFailure 单点产出的 kind —— 瞬时限流(自愈退避)
          // 不单独构成结构证据,不判额度、不冷却、不退避,留痕区分「命中但被次闸掉」(验收 6)。
          if (successQuota.kind === "transient") {
            quotaMatchedButTransient = {
              matchedLine: successQuota.matchedLine,
              note: "输出尾部命中额度关键词,但为瞬时限流退避(短间隔自愈),按 quota-failure-on-clean-exit v1.2 R9-a 不判额度、不进入冷却",
            };
          } else {
            // R9-b 主闸(必须):可归因产出 = 汇报声明且经 verifyReportedCommit 核实的提交(可归因),
            // 不再以 checkpointRef..HEAD 全局计数作为产出(不可归因,共享工作树下与第三方提交无法区分)。
            const verification = await verifyReportedCommit(
              prelimReport.hash,
              repoRoot,
              run.attempts,
              isA2a ? "a2a" : "cli",
            );
            if (verification?.status === "verified") {
              quotaMatchedButCommitFound = {
                matchedLine: successQuota.matchedLine,
                note: "输出尾部命中额度关键词,但汇报声明提交且经核实(本次运行有可归因产出),按 quota-failure-on-clean-exit v1.2 R9-b 不判额度、不进入冷却",
              };
            } else {
              await routeQuotaFailure(run, "exit 0", successTail, successQuota);
              return;
            }
          }
        }
        // a2a 执行器(远端 participant)的回复就是最终交付内容,直接作为 summary,
        // 不做段落解析;hash 仍从输出提取。CLI 路径走结构化段落解析(票7)。
        // 复用 prelimReport,避免二次解析漂移
        const report: TaskReport = prelimReport;
        const diffSummary: Record<string, unknown> = Object.fromEntries(
          Object.entries(report).filter(([key]) => key !== "tokenUsage"),
        );
        // R6/R9 留痕:区分「未命中」/「命中但被次闸掉」/「命中但有可归因产出」(验收 6)
        if (quotaMatchedButCommitFound) {
          diffSummary.quotaMatchedButCommitFound = quotaMatchedButCommitFound;
        }
        if (quotaMatchedButTransient) {
          diffSummary.quotaMatchedButTransient = quotaMatchedButTransient;
        }
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
        const doneTail = taskOutputTailLines(taskId);
        if (doneTail) diffSummary.outputTail = doneTail;
        const liveTail = liveTaskOutputTail(taskId);
        if (liveTail) diffSummary.liveOutputTail = liveTail;
        await endAttempt(run, {
          status: "done",
          summary: report.summary,
          hash: report.hash,
        });
        const tokenUsage = sumAttemptTokenUsage(run.attempts);
        if (tokenUsage !== undefined) diffSummary.tokenUsage = tokenUsage;
        const tokenUsageReason = sumAttemptTokenUsageReason(run.attempts);
        if (tokenUsageReason) diffSummary.tokenUsageReason = tokenUsageReason;
        // 经单一合并入口写入:以既有为底,result/metrics/scheduling 分所有者合并,
        // audit / relation 等他有键自动保留(spec diffsummary-ownership W2)。
        const curDone = await db.query.task.findFirst({
          where: and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)),
          columns: { diffSummary: true },
        });
        const doneSummary = applyDiffSummaryPatch(
          curDone?.diffSummary,
          diffSummary,
        );
        releaseTaskOutput(taskId);
        const [done] = await db
          .update(taskTable)
          .set({ status: "done", diffSummary: doneSummary })
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
        // 且带正面结构证据(R1:恢复时刻/错误行形状,退出码一律不算)→ 归类
        // 「额度失败」,冷却该执行器、不自动重试、❌ 注明预计恢复时间;其余失败
        // 保持原重试行为。限定尾部避免全量输出里的无关 "429/quota" 字样造成误判
        // (误判会停派该执行器整段冷却期);结构证据排除仅回显源码/任务书的伪命中,
        // R2 进一步排除点名其它执行器/平台字段的转述行。
        const failureQuota = classifyQuotaFailure([tail], {
          exitCode: result.code,
          taskBook: run.body,
          peerExecutorNames: await getPeerExecutorNames(),
        });
        if (failureQuota.isQuota) {
          await routeQuotaFailure(
            run,
            `exit ${result.code}`,
            tail,
            failureQuota,
          );
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
      markAttemptTokenUnavailable(run);
      await endAttempt(run, { status: "failed", error: msg });
      await failTask(
        db,
        taskId,
        spawnFailureReason(msg),
        0,
        undefined,
        run.attempts,
      );
      releaseTaskOutput(taskId);
      await postStatus(
        db,
        groupId,
        participantId,
        ex,
        spawnFailureStatus(ex, msg),
      );
    }
  } finally {
    clearRunTimers(run);
    activeRuns.delete(run);
    group.running = group.running.filter((r) => r !== run);
    requestPump();
  }
}

async function findTaskByMessage(db: DataBase, messageId: string) {
  return db.query.task.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.messageId, messageId),
  });
}

/**
 * 额度失败分流(spec transient-ratelimit-escalated-to-long-cooldown R2):
 *  - `transient` → per-run 退避重排队(不进执行器级冷却,任务不判 failed);
 *  - `exhausted`(或未启用瞬时处置)→ 既有额度失败出口(逐字不变)。
 *
 * 进程退出(exit≠0)与成功尾部(exit 0)两处共用本出口;超时分支单独保留
 * 全量输出解析(历史行为,不在本 spec 改动范围),但共享 isTransientQuota 判定,
 * 三处口径一致(验收 7)。
 */
async function routeQuotaFailure(
  run: QueuedRun,
  reasonLabel: string,
  tail: string,
  verdict: QuotaFailureVerdict,
): Promise<void> {
  if (isTransientQuota(verdict)) {
    await handleTransientQuotaBackoff(
      run,
      reasonLabel,
      tail,
      verdict.matchedLine,
    );
    return;
  }
  await handleQuotaFailure(run, reasonLabel, tail, verdict.matchedLine);
}

/**
 * 瞬时限流的 per-run 退避处置(spec R2):供应方只要求短暂退避,执行器没坏,
 * 因此**不调 enterCooldown**(`isInCooldown` 保持「额度耗尽」单一语义,R2 豁免
 * 判据 mayQueuedChildExecutorStart 因此不必改动),任务也不判 failed ——
 * 回写 queued 并重新入队,退避窗口过后由定时器泵送自动重试(不消耗重试次数)。
 *
 * 连续瞬时限流达上限 → 升级为 exhausted 处理(防退避死循环);配置不可用
 * (fail-safe)→ 同样走 exhausted。
 */
async function handleTransientQuotaBackoff(
  run: QueuedRun,
  reasonLabel: string,
  tail: string,
  matchedLine: string | null,
): Promise<void> {
  const policy = getTransientQuotaPolicy();
  if (!policy) {
    await handleQuotaFailure(run, reasonLabel, tail, matchedLine);
    return;
  }
  run.transientQuotaCount += 1;
  if (run.transientQuotaCount >= policy.escalationLimit) {
    console.warn(
      `[executor] 连续瞬时限流达 ${run.transientQuotaCount} 次(上限 ${policy.escalationLimit}),升级为额度耗尽处理: ${run.taskId}`,
    );
    await handleQuotaFailure(
      run,
      `${reasonLabel}(连续瞬时限流 ${run.transientQuotaCount} 次,按额度耗尽处理)`,
      tail,
      matchedLine,
    );
    return;
  }
  const seconds = Math.max(1, Math.round(policy.backoffMs / 1_000));
  // 先落退避窗口:退避从「判定那一刻」起算,不被随后的 DB 回写延迟吞掉。
  const retryAt = Date.now() + policy.backoffMs;
  run.concurrencyRetryAt = retryAt;
  await endAttempt(run, {
    status: "failed",
    error: `瞬时限流,${seconds}s 后退避重试`,
  });

  // 运行状态回到 queued(运行中曾置 running):任务不判 failed,退避后重试。
  try {
    const curTransient = await run.db.query.task.findFirst({
      where: and(
        eq(taskTable.id, run.taskId),
        eq(taskTable.groupId, run.groupId),
      ),
      columns: { diffSummary: true },
    });
    const transientNext = applyDiffSummaryPatch(curTransient?.diffSummary, {
      waiting: `执行器瞬时限流,${seconds}s 后退避重试`,
      // R4 留痕:与 quotaMatchedLine 并列,事后可审计分级准确性。
      quotaKind: "transient",
      ...(matchedLine !== null ? { quotaMatchedLine: matchedLine } : {}),
    });
    const [updated] = await run.db
      .update(taskTable)
      .set({
        status: "queued",
        diffSummary: transientNext,
      })
      .where(
        and(eq(taskTable.id, run.taskId), eq(taskTable.groupId, run.groupId)),
      )
      .returning();
    if (updated) {
      await notifyTaskStatusChanged(
        run.db,
        run.taskId,
        run.groupId,
        "queued",
        updated,
      );
    }
  } catch (e) {
    console.warn(`[executor] 瞬时限流回写 queued 失败(${run.taskId}): ${e}`);
  }

  // 不置 concurrencyBlocked —— 那是 403 并发冲突标记,会额外等待同执行器的
  // 其他 running 任务清空,与「退避到点即重试」的语义不同。
  run.stalled = false;
  run.a2aSilenced = false;
  run.runningAt = null;
  run.lastOutputAt = 0;
  run.lastActivityAt = 0;
  run.kill = null;
  clearRunTimers(run);
  const group = groupQueues.get(run.groupKey);
  if (!group) {
    // 组已被清空(测试重置等异常)→ 无法退避重试,按最终失败处理。
    await failTask(
      run.db,
      run.taskId,
      "执行器瞬时限流,但组队列已不可用",
      0,
      { quotaKind: "transient" },
      run.attempts,
    );
    return;
  }
  group.queue.push(run);
  await postStatus(
    run.db,
    run.groupId,
    run.participantId,
    run.ex,
    `⏳ [${run.ex.label}] 执行器瞬时限流,任务保持排队,${seconds}s 后自动重试: ${run.summary}`,
  );
  // 退避到期主动泵送(与 403 反应式排队同款兜底):此时 run 已在队首等待。
  setTimeout(() => requestPump(), Math.max(1, retryAt - Date.now()));
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
  matchedLine: string | null,
): Promise<void> {
  // 冷却动态化:优先从失败输出解析恢复时间,解析失败回退固定冷却。
  // R7:解析出的时刻不在未来或过于接近当前时,回退到固定冷却兜底。
  const parsedMs = parseRateLimitRecoveryMs(tail);
  const cooldownEnd = normalizeCooldownEnd(
    parsedMs ?? Date.now() + getRateLimitCooldownMs(),
  );
  const eta = formatEta(cooldownEnd);
  const extra: Record<string, unknown> = {
    [EXECUTOR_COOLDOWN_END_MS_FIELD]: cooldownEnd,
    executorCooldownSource:
      parsedMs !== null && parsedMs > Date.now() + MIN_EFFECTIVE_COOLDOWN_MS
        ? "parsed"
        : "fallback",
    // 额度分级留痕(spec transient-ratelimit-… R4):本出口只处理 exhausted,
    // 与 transient 的 per-run 退避留痕并列,事后可审计分级准确性。
    quotaKind: "exhausted",
    // 伪额度回显修复 R5:记录命中的原始行(截断),便于人判断是真实额度还是
    // 源码/任务书回显造成的伪命中。
    ...(matchedLine !== null ? { quotaMatchedLine: matchedLine } : {}),
  };
  if (parsedMs !== null && parsedMs <= Date.now() + MIN_EFFECTIVE_COOLDOWN_MS) {
    extra.cooldownFallbackReason = "解析所得时刻不可用,已回退固定冷却";
    extra.discardedCooldownEndMs = parsedMs;
  }
  await handleFailure(run, `${reasonLabel}(执行器额度限制,预计 ${eta} 恢复)`, {
    retryable: false,
    message: `❌ [${run.ex.label}] 任务失败 (执行器额度限制,预计 ${eta} 恢复)\n${tail}`,
    extra,
    afterPersisted: () =>
      enterCooldown(
        run.ex,
        cooldownEnd,
        parsedMs !== null && parsedMs > Date.now() + MIN_EFFECTIVE_COOLDOWN_MS
          ? "parsed"
          : "fallback",
        { db: run.db, taskId: run.taskId },
      ),
  });
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
  // 有既有任务时由它们的完成路径(finally → 泵送信号)触发,本定时器仅兜底。
  setTimeout(() => requestPump(), CONCURRENCY_RETRY_BACKOFF_MS);
}

function summaryOf(body: string): string {
  return body.replace(/\s+/g, " ").slice(0, 40);
}
