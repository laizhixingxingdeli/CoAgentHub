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
  renderExecutorArgs,
} from "@server/lib/executors";
import { wsHub } from "@server/lib/ws-hub";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { adapterFor } from "./adapters/registry";
import { createAnsiStripper } from "./ansi";
import {
  backfillDetachedClosedTokenFields,
  beginAttempt,
  collectAttemptTokenUsage,
  endAttempt,
  markAttemptTokenUnavailable,
} from "./attempt-accounting";
import { trackBackgroundWork } from "./background-work";
import { hasDuplicateActiveRun } from "./cancel";
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
import { failTask } from "./failure";
import {
  markTaskCancelled,
  notifyTaskStatusChanged,
  postStatus,
} from "./notify";
import {
  handleA2aMemoryOutcome,
  handleA2aSilencedOutcome,
  handleDetachedOutcome,
  handleNonZeroExitOutcome,
  handleStalledOutcome,
  handleStoppedOutcome,
  handleTimedOutOutcome,
} from "./outcome-handlers";
import { handleSuccessOutcome } from "./outcome-success";
import {
  appendLiveTaskOutput,
  appendTaskOutput,
  releaseTaskOutput,
} from "./output-buffer";
import { createExecutorOutputParser } from "./output-parser";
import { registerPump, requestPump } from "./pump-signal";
import { extractGenericJsonlText } from "./report";
import { registerTaskOwnerServer } from "./restart-recovery";
import { groupHasReviewerMember } from "./review-request-policy";
import { spawnFailureReason, spawnFailureStatus } from "./spawn-failure";
import {
  activeRuns,
  clearRunTimers,
  clearStaleTestRepoIndexLock,
  cooldownEndMs,
  formatEta,
  getA2ASilenceTimeoutMs,
  getDetachedTimeoutMs,
  getMaxParallelGroups,
  getRedispatchFailureLimit,
  getStallAlertMs,
  getStallTimeoutMs,
  groupQueues,
  isInCooldown,
  pumping,
  pumpPending,
  registerCoordinatorProcess,
  releaseCoordinatorProcess,
  runningExecutorCount,
  runningGroupCount,
  setPumping,
  setPumpPending,
} from "./state";
import { liveStreamText, summaryStreamText } from "./stream-text";
import { resolveTaskRepo } from "./task-repo";
import { writeTaskStatus } from "./task-transitions";
import {
  buildSpecSection,
  buildTicket,
  resolveTestExecutor,
} from "./ticket-builder";
import { loadTicketTemplate } from "./ticket-template";
import {
  armClaimTimer,
  handleA2ASilence,
  handleDetachedTimeout,
  handleStall,
  handleStallAlert,
} from "./timeout-handlers";
import {
  DEFAULT_GROUP_KEY,
  DISPATCH_ALLOWED_ROLES,
  type DispatchExecutorInput,
  type DispatchOutcome,
  type GroupPromptInfo,
  type GroupQueue,
  type QueuedRun,
} from "./types";

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

  armClaimTimer(run);
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
  // 与重排队路径共用 armClaimTimer(见 transient-requeue-lost-wakeup §6.2)。
  armClaimTimer(run);
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
  // 合并信号(coalescing):忙时记下 pending,本轮结束后再跑 —— 直接 `return`
  // 会把唤醒丢掉,重排队任务可永久静默挂在 queued
  // (specs/transient-requeue-lost-wakeup.md §6.1)。不是轮询/定时重试。
  if (pumping) {
    setPumpPending(true);
    return;
  }
  setPumping(true);
  try {
    do {
      setPumpPending(false);
      // 测试钩子:本轮 drain 开始时回调一次,便于验证「忙时信号 → 再跑一轮」。
      pumpCycleHookForTests?.();
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
        // T3:登记 runOne 全生命周期(含离队后的终态写入)。runOne finally 里的
        // requestPump 在 track 的 finally 解除之前同步跑完,子 runOne 先登记
        // 再解除父项 —— 父子交接无空计数窗口。
        void trackBackgroundWork(`runOne:${run.taskId}`, () =>
          runOne(run, group),
        );
      }
      // 有界:本轮结束时 pending 未置位就退出,不空转。
    } while (pumpPending);
  } finally {
    setPumping(false);
  }
  // 尾窗竞态:do-while 判定 pending=false 之后、setPumping(false) 之前又来了
  // 信号 → pending 为 true 但无人再进泵。这里补一次(若已有人进入会再合并)。
  if (pumpPending) {
    void pumpQueue();
  }
}

/** 测试专用:直接跑一轮(含合并)泵,不经过 requestPump。 */
export async function __pumpQueueForTests(): Promise<void> {
  await pumpQueue();
}

/** 测试专用:每一轮 drain 开始时回调(验证合并信号会再跑一轮)。 */
let pumpCycleHookForTests: (() => void) | null = null;
export function __setPumpCycleHookForTests(fn: (() => void) | null): void {
  pumpCycleHookForTests = fn;
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

    // queued → running(尽力而为;DB 异常不阻塞执行,终态仍会回写)。
    // 原路径 where 含 groupId;notify 默认 true。
    // 合法前置 queued|running(S1 第 2 阶段):防的是终态被覆盖,不是 pin 成
    // 恰好 queued —— 重试/回收重入可能已是 running。停止/超时/孤儿若已先落
    // cancelled/failed,不得把终态拉成 running 再 spawn。
    // startRaceLost:writeTaskStatus 返回 null(竞态)与 catch 异常分开处理。
    let startRaceLost = false;
    try {
      const started = await writeTaskStatus(db, {
        taskId,
        groupId,
        status: "running",
        expectedStatuses: ["queued", "running"],
      });
      if (!started) {
        startRaceLost = true;
      }
    } catch (e) {
      // DB 异常 ≠ 竞态 null:异常保持既有 warn 后继续执行;null 走下方跳过。
      console.warn(`[executor] 置 running 失败(${taskId}): ${e}`);
    }
    if (startRaceLost) {
      console.log(`[executor] 任务 ${taskId} 已是终态,跳过执行`);
      clearRunTimers(run);
      return;
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
        const failed = await failTask(db, taskId, `任务书写入失败: ${e}`);
        if (!failed) return;
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
        const failed = await failTask(db, taskId, `执行前快照失败: ${msg}`);
        if (!failed) return;
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
                const failed = await failTask(
                  db,
                  taskId,
                  `执行器启动失败: ${spawnFailureReason(msg)}`,
                  0,
                  undefined,
                  run.attempts,
                );
                if (!failed) return;
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
        await handleStoppedOutcome(run);
        return;
      }
      // A2A 上下文延续:gateway 返回的新 contextId 落库(done/failed 都写;
      // 超时/网络错误无 contextId 自然不写),供该执行器**本群**的下一任务
      // 携带。仅 memory="per-group" 的协调器回写;纯粹执行器不回写(任务书
      // 自包含,无记忆)。
      if (memoryPerGroup && result.contextId) {
        await handleA2aMemoryOutcome(run, { result });
      }
      // 第3层(detached 可脱离执行):A2A 发送完成即算「已派发」,不按最终回复
      // 定终态——任务保持 running,等执行器恢复后 PATCH /groups/:id/tasks/:taskId
      // 主动回写 done/failed;超过 detachedTimeoutMinutes 仍未回写 → 结果未确认
      // (handleDetachedTimeout)。队列槽位照常释放(24h 等待不该占住组队列)。
      if (run.detached) {
        await handleDetachedOutcome(run);
        return;
      }
      // 静默超时已由 handleStall 置 stalled + kill 进程组;失败落库 / ❌ 回传 /
      // 重试判定统一在完成路径处理,避免定时器回调与完成路径并发写状态。
      if (run.stalled) {
        await handleStalledOutcome(run);
        return;
      }
      // A2A 无进展超时已由 handleA2ASilence 置 a2aSilenced + 中止请求:按「无进展
      // 失败」处理(不重试——执行器已失联,重试无意义;不设无进展提醒,与静默
      // 检测同界,仅 a2a 无本地进程输出可观察,不走 stallAlert 提醒)。
      if (run.a2aSilenced) {
        await handleA2aSilencedOutcome(run);
        return;
      }
      if (result.timedOut) {
        await handleTimedOutOutcome(run, {
          result,
          isA2a,
          getPeerExecutorNames,
        });
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
        await handleSuccessOutcome(run, {
          result,
          output,
          isA2a,
          repoRoot,
          getPeerExecutorNames,
        });
        return;
      } else {
        await handleNonZeroExitOutcome(run, {
          result,
          output,
          isA2a,
          getPeerExecutorNames,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[executor] 执行器启动失败: ${msg}`);
      markAttemptTokenUnavailable(run);
      await endAttempt(run, { status: "failed", error: msg });
      const failed = await failTask(
        db,
        taskId,
        spawnFailureReason(msg),
        0,
        undefined,
        run.attempts,
      );
      releaseTaskOutput(taskId);
      if (!failed) return;
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

function summaryOf(body: string): string {
  return body.replace(/\s+/g, " ").slice(0, 40);
}
