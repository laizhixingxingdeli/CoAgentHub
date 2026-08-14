/**
 * Server 内嵌执行器触发链路(阶段2-票1/票2):POST /groups/:id/messages 出现
 * audience=participant 且 audienceRef 命中执行器配置(participant.name ===
 * agentName)时,server 直接建 task + spawn CLI 执行器,桥不再需要代为调度。
 *
 * 调度并行化(票4):队列按 project_path 分组——同一 project_path 的任务组内
 * 串行(一条组内队列),不同 project_path 的组并行执行,并行组数受
 * maxParallelGroups(scripts/dispatch-policy.json,默认 2)限制;project_path
 * 为空的群任务归入默认组(独立组,组内串行、可与有项目的组并行)。
 * 触发链路:消息命中执行器 → 建 task(status=queued)→ 入该组的队;组槽位空闲
 * 时取组内队首 → PATCH task running → spawn → 完成 PATCH done/failed → 泵下一个。
 *
 * 双跑期(桥保持现状并行运行)防重复:
 *  - 建 task 用 message_id 唯一约束幂等(与 POST /tasks 同一逻辑,ON CONFLICT
 *    DO NOTHING + 重读既有行)——桥与 server 谁先建谁拿到 created,另一个
 *    读到既有行。
 *  - 既有 task 且状态 running/done 时跳过 spawn:桥已登记并正在执行/已执行完,
 *    不重复跑。queued 也跳过:是本 server 自己入过队的(桥只会建 running)。
 *    failed/cancelled 视为可重新执行。
 *
 * 重启兜底:server 启动时调用 recoverInterruptedTasks,把 DB 里 status 为
 * queued/running 的任务自动恢复为 failed(附原因 server-restart),不自动重跑
 * (保持简单,队列是内存态,持久化只做失败兜底)。
 *
 * 可靠性保障(票5):两道超时兜底,全部 server 内实现(执行器是外部 CLI 不改)。
 *  - 认领超时:任务入队后超过 claimTimeoutMinutes(默认 30)仍未进入 running
 *    → 标 failed(「任务未被认领」)+ ❌ 回传(注明发布时间)。认领起点用入队
 *    时刻(内存记录),不依赖 DB created_at(重新执行的任务以本次入队为准)。
 *  - 静默超时:running 任务连续无 stdout/stderr 输出超过 stallTimeoutMinutes
 *    (默认 30)→ 标 failed(「执行器静默超时」)+ ❌ 回传。onOutput 每次输出
 *    刷新时间戳并重排定时器;仅 CLI 路径(本地进程才有输出可观察),a2a 不设。
 *  - 进程层:执行器进程死亡由 runExecutor 的 promise 完成路径统一处理(进程
 *    退出 → close 事件 → promise resolve → 非零 code 走 failed),无需额外逻辑。
 *  - 停止指令优先:run.stopped 的任务不受静默/认领超时影响(超时处理函数直接
 *    跳过,完成路径 stopped → cancelled)。
 * 阈值并入 scripts/dispatch-policy.json,server 启动时读取(缺省兜底 30)。
 *
 * 状态回传保持桥现有 emoji 状态条格式:📋 排队 / 🚀 开始执行 / ✅ 完成 /
 * ❌ 失败 / 🛑 停止,contentType=task_status 由前缀判定,与桥的
 * contentTypeFor 一致。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import { runA2AExecutor } from "@server/lib/a2a-runner";
import type { DataBase } from "@server/lib/database";
import {
  createCheckpoint,
  type ExecutorRunResult,
  findRepoRoot,
  readTimeoutMs,
  runExecutor,
} from "@server/lib/executor-runner";
import {
  type ExecutorConfig,
  findExecutorByParticipantName,
  readDispatchPolicy,
} from "@server/lib/executors";
import { insertGroupMessage } from "@server/lib/group-message";
import { wsHub } from "@server/lib/ws-hub";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

/** 与桥 EXEC_ALLOWED_ROLES 一致:只有 coordinator / human 能发布任务。 */
const EXEC_ALLOWED_ROLES = ["coordinator", "human"] as const;

/** 与桥 contentTypeFor 一致:状态类 emoji 前缀 → task_status。 */
const STATUS_EMOJI_RE = /^[📋🚀✅❌🛑]/u;

const ANSI_RE =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export interface DispatchExecutorInput {
  groupId: string;
  messageId: string;
  senderRoles: string[];
  /** audienceRef = 被 @ 的 participant id(即执行器 participant 身份)。 */
  audienceRef: string;
  body: string;
}

/** 群内分工信息(角色解绑后):成员在本群的角色集 + 分工提示词,拼进任务书。 */
export interface GroupPromptInfo {
  roles: string[];
  prompt: string;
}

/** 队列条目:一次待执行/执行中的运行。 */
interface QueuedRun {
  db: DataBase;
  groupId: string;
  messageId: string;
  taskId: string;
  participantId: string;
  ex: ExecutorConfig;
  body: string;
  summary: string;
  /** 群内分工(角色解绑后);成员在本群无 prompt 时为 null,任务书不含该段。 */
  groupPrompt: GroupPromptInfo | null;
  /** 组键:群 project_path(空 → DEFAULT_GROUP_KEY),分组串行/并行用。 */
  groupKey: string;
  /** 群绑定的项目路径(spawn cwd/快照仓库用);未绑定为 null。 */
  projectPath: string | null;
  /** 运行中句柄的 kill(停止指令用);spawn 前为 null。 */
  kill: (() => void) | null;
  /** 停止指令已终止本任务(完成回调不再回传 ❌,改置 cancelled)。 */
  stopped: boolean;
  /** 入队时间(ms,认领超时起点;重新执行的任务以本次入队时间为准)。 */
  createdAt: number;
  /** 进入 running 的时间(ms);尚未开始为 null。 */
  runningAt: number | null;
  /** 最近一次 stdout/stderr 输出的时间(ms);静默检测用。 */
  lastOutputAt: number;
  /** 认领超时定时器(入队时调度,进入 running 时取消)。 */
  claimTimer: NodeJS.Timeout | null;
  /** 静默超时定时器(spawn 时调度,每次输出重排);a2a 无本地进程不调度。 */
  stallTimer: NodeJS.Timeout | null;
  /** 静默超时已触发(完成回调不再重复回传 ❌)。 */
  stalled: boolean;
}

/** 未绑定项目路径(project_path 为空)的群任务归入默认组。 */
const DEFAULT_GROUP_KEY = "__default__";

/** 单个 project_path 的组队列:组内串行 FIFO,不同组并行(受组槽位数限制)。 */
interface GroupQueue {
  key: string;
  queue: QueuedRun[];
  running: QueuedRun | null;
}

/**
 * 按 project_path 分组的执行队列(模块级,票4):同一组键(project_path)的任务
 * 组内串行;不同组并行执行,并行组数上限 maxParallelGroups(dispatch-policy.json,
 * 默认 2;=1 时退化为全局串行)。组槽位空闲时 pumpQueue 取组内队首运行。
 */
const groupQueues = new Map<string, GroupQueue>();

/** 最大并行组数:server 启动时从 scripts/dispatch-policy.json 读取。 */
let maxParallelGroups = readDispatchPolicy().maxParallelGroups;

/** 静默超时阈值(ms):running 连续无输出超过即失败;启动时读配置,缺省 30min。 */
let stallTimeoutMs = readDispatchPolicy().stallTimeoutMinutes * 60_000;

/** 认领超时阈值(ms):queued 超过即失败;启动时读配置,缺省 30min。 */
let claimTimeoutMs = readDispatchPolicy().claimTimeoutMinutes * 60_000;

/** pumpQueue 重入保护:并行启动多个组时,同一时刻只允许一个泵循环。 */
let pumping = false;

/** 排队中(未开始)任务数;回滚指令前置校验用。 */
export function queuedExecutorTaskCount(): number {
  let n = 0;
  for (const g of groupQueues.values()) n += g.queue.length;
  return n;
}

/** 取消单个 run 的认领/静默定时器(幂等;停止/完成/重置时调用)。 */
function clearRunTimers(run: QueuedRun): void {
  if (run.claimTimer) {
    clearTimeout(run.claimTimer);
    run.claimTimer = null;
  }
  if (run.stallTimer) {
    clearTimeout(run.stallTimer);
    run.stallTimer = null;
  }
}

/**
 * 测试专用:终止全部运行中任务并清空所有组队列(模块级状态跨测试文件/用例
 * 共享,避免前一个用例残留的 running/queued 影响后续断言)。仅测试调用。
 */
export function __resetExecutorQueueForTests(): void {
  for (const g of groupQueues.values()) {
    if (g.running) {
      g.running.stopped = true;
      g.running.kill?.();
      clearRunTimers(g.running);
    }
    for (const q of g.queue) clearRunTimers(q);
    g.queue.length = 0;
  }
  groupQueues.clear();
  const policy = readDispatchPolicy();
  maxParallelGroups = policy.maxParallelGroups;
  stallTimeoutMs = policy.stallTimeoutMinutes * 60_000;
  claimTimeoutMs = policy.claimTimeoutMinutes * 60_000;
}

/** 测试专用:覆盖最大并行组数(默认读 scripts/dispatch-policy.json)。 */
export function __setMaxParallelGroupsForTests(n: number): void {
  maxParallelGroups = Math.max(1, Math.floor(n));
}

/**
 * 测试专用:覆盖静默/认领超时阈值(默认读 scripts/dispatch-policy.json,
 * 单位 ms)。测试用 100ms 级小阈值避免拖慢测试,与配置单位(分钟)无关。
 */
export function __setReliabilityTimeoutsForTests(
  stallMs: number,
  claimMs: number,
): void {
  stallTimeoutMs = Math.max(1, Math.floor(stallMs));
  claimTimeoutMs = Math.max(1, Math.floor(claimMs));
}

/** 当前运行中的组数(组槽位占用数)。 */
function runningGroupCount(): number {
  let n = 0;
  for (const g of groupQueues.values()) if (g.running) n += 1;
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
    .returning({ id: taskTable.id });
  if (rows.length > 0) {
    console.log(
      `[executor] 重启兜底:${rows.length} 个 queued/running 任务置为 failed (server-restart)`,
    );
  }
  return rows.length;
}

/** 当前运行中的任务(停止指令用);并行时可能有多个,返回第一个;无则 null。 */
export function currentRunningTask(): {
  taskId: string;
  participantId: string;
  ex: ExecutorConfig;
  kill: () => void;
} | null {
  for (const g of groupQueues.values()) {
    const r = g.running;
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
 * 停止指定任务:taskId 缺省时取消全部排队 + 终止全部运行中任务(跨所有组);
 * 携带 taskId 时仅终止该任务(排队中则移出队列置 cancelled,运行中则 kill
 * 进程组)。返回所有被停止的任务信息(未命中 → 空数组)。
 *
 * 运行中任务即使 kill 句柄尚未就绪(spawn 前窗口)也会标记 stopped,
 * pumpQueue 会在 spawn 前中止,不会出现「停止指令已执行但任务照跑」。
 */
export function stopRunningTask(taskId?: string): Array<{
  taskId: string;
  participantId: string;
  ex: ExecutorConfig;
}> {
  const stopped: Array<{
    taskId: string;
    participantId: string;
    ex: ExecutorConfig;
  }> = [];

  // 排队中的任务:taskId 缺省 → 全部取消(与桥 handleCancel 一致);指定 →
  // 仅取消匹配项(跨组查找)。排队任务未 spawn,直接移出队列 + 置 cancelled。
  for (const g of groupQueues.values()) {
    const remaining: QueuedRun[] = [];
    for (const q of g.queue) {
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
      void markTaskCancelled(q.db, q.taskId, q.groupId);
    }
    g.queue.length = 0;
    g.queue.push(...remaining);
  }

  // 运行中任务:taskId 缺省 → 全部终止;指定 → 仅当其 running 才终止(跨组)。
  // 停止优先于超时:清理定时器后,静默/认领超时不会再对已停止任务生效。
  for (const g of groupQueues.values()) {
    const r = g.running;
    if (r && (!taskId || r.taskId === taskId)) {
      r.stopped = true;
      r.kill?.();
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

/** 直接落库置 cancelled(停止指令取消排队/已运行任务用)。 */
function markTaskCancelled(
  db: DataBase,
  taskId: string,
  groupId: string,
): Promise<unknown> {
  return db
    .update(taskTable)
    .set({ status: "cancelled", diffSummary: { error: "stopped" } })
    .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)));
}

/**
 * 触发入口(路由 fire-and-forget 调用,不 await):命中执行器配置则
 * 幂等建 task + 入队;不命中/无权限/桥已执行则静默返回。
 */
export async function maybeDispatchExecutorTask(
  db: DataBase,
  input: DispatchExecutorInput,
): Promise<void> {
  const { groupId, messageId, senderRoles, audienceRef, body } = input;

  // 与桥相同的角色门槛:非 coordinator/human 不执行(桥侧也会拒绝)。
  if (
    !senderRoles.some((r) =>
      (EXEC_ALLOWED_ROLES as readonly string[]).includes(r),
    )
  ) {
    console.log(
      `[executor] 跳过:发送者角色 [${senderRoles.join(",")}] 无权限发布任务`,
    );
    return;
  }

  // audienceRef → participant → executor 配置(按 name 匹配,与桥注册的 participant 名一致)。
  const participant = await db.query.participant.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.id, audienceRef),
  });
  if (!participant) {
    console.log(
      `[executor] 跳过:audienceRef ${audienceRef} 无对应 participant`,
    );
    return;
  }
  const ex = await findExecutorByParticipantName(db, participant.name);
  if (!ex) {
    console.log(
      `[executor] 跳过:participant ${participant.name} 不在执行器配置中`,
    );
    return;
  }

  // 角色解绑后:查目标成员在本群的分工(roles + prompt);prompt 非空才拼进任务书。
  const membership = await db.query.groupMember.findFirst({
    where: (t, { and: andFn, eq: eqFn }) =>
      andFn(eqFn(t.groupId, groupId), eqFn(t.participantId, participant.id)),
  });
  const groupPrompt: GroupPromptInfo | null =
    membership && membership.prompt
      ? { roles: membership.roles, prompt: membership.prompt }
      : null;

  await dispatchTask(db, {
    groupId,
    messageId,
    participantId: participant.id,
    ex,
    body,
    groupPrompt,
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
  },
): Promise<void> {
  const { groupId, messageId, participantId, ex, body, groupPrompt } = opts;

  const [created] = await db
    .insert(taskTable)
    .values({
      groupId,
      messageId,
      executorParticipantId: participantId,
      executorKey: ex.key,
      status: "queued",
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

  // 排队位置:同组 running(1)+ 同组排队数;组未运行但槽位已被其他组占满时,
  // 还要等当前运行中的组先释放槽位。
  const running = runningGroupCount();
  const freeSlots = maxParallelGroups - running;
  const ahead =
    (group.running ? 1 : 0) +
    group.queue.length +
    (group.running || freeSlots > 0 ? 0 : running);
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
    claimTimer: null,
    stallTimer: null,
    stalled: false,
  };
  group.queue.push(run);

  // 认领超时定时器:超过 claimTimeoutMs 仍未进入 running → 标 failed。
  // 进入 running 时(runOne)取消;任务出队/停止时同步清理。
  run.claimTimer = setTimeout(() => handleClaimTimeout(run), claimTimeoutMs);
  void pumpQueue();
}

/** 取(或建)指定组键的组队列;组键插入顺序即组触达顺序(公平轮转)。 */
function ensureGroupQueue(key: string): GroupQueue {
  let g = groupQueues.get(key);
  if (!g) {
    g = { key, queue: [], running: null };
    groupQueues.set(key, g);
  }
  return g;
}

/**
 * 泵调度:组槽位有空闲时,按组触达顺序取「有排队且未运行」的组,运行其队首
 * (组内串行:同组只有一条 running)。并行组数 ≤ maxParallelGroups,=1 时
 * 退化为全局串行(原行为)。完成回调在 finally 里再泵,无需在此 await。
 */
async function pumpQueue(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      if (runningGroupCount() >= maxParallelGroups) break;
      const group = [...groupQueues.values()].find(
        (g) => !g.running && g.queue.length > 0,
      );
      if (!group) break;
      const run = group.queue.shift();
      // find 谓词保证 queue 非空,此处不可能为 undefined(防御性判空)。
      if (!run) break;
      group.running = run;
      void runOne(run, group);
    }
  } finally {
    pumping = false;
  }
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
      await markTaskCancelled(db, taskId, groupId);
      return;
    }

    // 进入 running = 任务被认领:取消认领超时定时器,记录认领时刻。
    if (run.claimTimer) {
      clearTimeout(run.claimTimer);
      run.claimTimer = null;
    }
    run.runningAt = Date.now();

    // queued → running(尽力而为;失败不阻塞执行,终态仍会回写)。
    try {
      await db
        .update(taskTable)
        .set({ status: "running" })
        .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)));
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

    // spawn cwd = 群绑定的 project_path(并行时不同项目操作各自仓库,互不干扰);
    // 未绑定则回退 findRepoRoot()(兼容既有测试/无项目群)。
    const repoRoot =
      run.projectPath && existsSync(run.projectPath)
        ? run.projectPath
        : findRepoRoot();
    // 按 kind 分流:cli 写 ticket + 打本地 git 快照后 spawn;a2a 不发 ticket、
    // 不打快照(远端设备执行,本地快照无意义),body 直接当 prompt 发 gateway。
    // 二者都走同一 handle 形状,后续 done/failed/超时回传逻辑共用。
    const isA2a = ex.kind === "a2a";
    let handle: { promise: Promise<ExecutorRunResult>; kill: () => void };
    if (isA2a) {
      const a2aUrl = ex.a2a?.url ?? "";
      console.log(
        `[executor] a2a 调用: ${a2aUrl} (participant=${ex.agentName}, group=${run.groupKey}, task=${taskId})`,
      );
      handle = {
        promise: runA2AExecutor({
          url: a2aUrl,
          token: ex.a2a?.token ?? "",
          prompt: body,
          timeoutMs: readTimeoutMs(),
        }),
        // 远端调用无本地进程可杀:停止指令靠完成后 run.stopped 检查置 cancelled。
        kill: () => {},
      };
    } else {
      // 并行任务可能同毫秒触发,ticket 路径用 taskId 保证唯一(避免互相覆盖)。
      const ticketPath = `/tmp/coagenthub-ticket-${taskId}.md`;
      try {
        writeFileSync(
          ticketPath,
          buildTicket(body, ex.label, repoRoot, groupPrompt),
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
        const cp = createCheckpoint(taskId, repoRoot);
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
      // 把刚写好的任务书全文内联进参数。
      const ticketContent = readFileSync(ticketPath, "utf8");
      const args = ex.args.map((a) =>
        a
          .replaceAll("{ticket}", ticketPath)
          .replaceAll("{ticketContent}", ticketContent),
      );
      console.log(
        `[executor] server 侧 spawn: ${ex.bin} ${args.join(" ")} (cwd=${repoRoot}, group=${run.groupKey}, task=${taskId})`,
      );
      handle = runExecutor({
        bin: ex.bin,
        args,
        cwd: repoRoot,
        onOutput: (chunk) => {
          // 流式日志:便于后续回传群(本轮先落 server 日志)。
          process.stdout.write(chunk);
          // 静默检测:每次输出刷新「最近活跃」时间戳并重排静默定时器。
          run.lastOutputAt = Date.now();
          if (run.stallTimer) {
            clearTimeout(run.stallTimer);
            run.stallTimer = setTimeout(() => handleStall(run), stallTimeoutMs);
          }
        },
      });
      // 静默超时起点:进程刚 spawn(输出可观察);之后每次输出重排定时器。
      // a2a 无本地进程/增量输出,不设静默检测(完成路径由任务级超时兜底)。
      run.lastOutputAt = Date.now();
      run.stallTimer = setTimeout(() => handleStall(run), stallTimeoutMs);
    }
    run.kill = handle.kill;

    try {
      const result = await handle.promise;
      // 停止指令已 kill 进程组:完成回调置 cancelled,不再回传 ❌/✅(停止
      // 指令自己已回传 🛑)。
      if (run.stopped) {
        console.log(`[executor] 任务已停止: ${taskId}`);
        await db
          .update(taskTable)
          .set({ status: "cancelled", diffSummary: { error: "stopped" } })
          .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)));
        return;
      }
      // 静默超时已在 handleStall 里置 failed + 回传 ❌(并 kill 进程组):
      // 进程被终止后的 promise 完成路径不再重复回传/覆写终态。
      if (run.stalled) {
        console.log(`[executor] 任务已因静默超时失败: ${taskId}`);
        return;
      }
      if (result.timedOut) {
        console.error(`[executor] 任务超时: ${taskId}`);
        await failTask(db, taskId, "执行超时");
        await postStatus(
          db,
          groupId,
          participantId,
          ex,
          `❌ [${ex.label}] 任务失败 (超时)`,
        );
        return;
      }
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      if (result.code === 0) {
        const hash = findCommitHash(output);
        // a2a 执行器(远端 participant)的回复就是最终交付内容,直接作为 summary,
        // 不过 extractSummary 的关键词截取(汇报/做了什么/commit 段)。
        const summaryText = isA2a
          ? (result.stdout ?? "").trim()
          : extractSummary(output);
        const diffSummary: Record<string, unknown> = { summary: summaryText };
        if (hash) diffSummary.hash = hash;
        await db
          .update(taskTable)
          .set({ status: "done", diffSummary })
          .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)));
        console.log(
          `[executor] 任务完成: ${taskId}${hash ? ` hash=${hash}` : ""}`,
        );
        const body = `✅ [${ex.label}] 任务完成${hash ? ` (commit ${hash})` : ""}\n${summaryText}`;
        await postStatus(db, groupId, participantId, ex, body.slice(0, 2000));
      } else {
        const tail = lastLinesOf(output, 20).slice(0, 1500);
        console.error(`[executor] 任务失败 exit=${result.code}: ${taskId}`);
        await failTask(db, taskId, `exit ${result.code}`);
        await postStatus(
          db,
          groupId,
          participantId,
          ex,
          `❌ [${ex.label}] 任务失败 (exit ${result.code})\n${tail}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[executor] 执行器启动失败: ${msg}`);
      await failTask(db, taskId, msg);
      await postStatus(
        db,
        groupId,
        participantId,
        ex,
        `❌ [${ex.label}] 任务失败: 无法启动 ${ex.bin} (${msg})`,
      );
    }
  } finally {
    clearRunTimers(run);
    group.running = null;
    void pumpQueue();
  }
}

async function findTaskByMessage(db: DataBase, messageId: string) {
  return db.query.task.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.messageId, messageId),
  });
}

/**
 * 静默超时处理:running 任务连续无输出超过 stallTimeoutMs → kill 进程组 +
 * 置 failed(「执行器静默超时」)+ ❌ 回传。同步置 stalled 后再 kill,保证进程
 * 被终止后的 promise 完成路径能看到 stalled 并跳过(不重复回传)。
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
  void (async () => {
    await failTask(run.db, run.taskId, "执行器静默超时");
    await postStatus(
      run.db,
      run.groupId,
      run.participantId,
      run.ex,
      `❌ [${run.ex.label}] 任务失败 (执行器静默超时)`,
    );
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

/** 直接落库置 failed(server 是状态源;PATCH 端点是给外部执行器客户端的)。 */
async function failTask(
  db: DataBase,
  taskId: string,
  reason: string,
): Promise<void> {
  await db
    .update(taskTable)
    .set({ status: "failed", diffSummary: { error: reason } })
    .where(eq(taskTable.id, taskId));
}

/** 以执行器 participant 身份回传群消息(broadcast + 前缀判定 contentType)。 */
export async function postStatus(
  db: DataBase,
  groupId: string,
  senderId: string,
  ex: ExecutorConfig,
  body: string,
): Promise<void> {
  try {
    const full = await insertGroupMessage(db, {
      groupId,
      senderId,
      parentId: null,
      audience: "broadcast",
      audienceRef: null,
      body,
      contentType: STATUS_EMOJI_RE.test(body) ? "task_status" : "text/plain",
      fileRef: null,
    });
    // 与 POST /messages 一致的火力外扇出:WS,让群里实时可见。
    void wsHub.broadcastGroupMessage(full);
  } catch (e) {
    console.warn(`[executor] 状态回传失败(${ex.label}):`, e);
  }
}

/** 与桥 buildTicket 一致的执行器任务书格式。 */
function buildTicket(
  body: string,
  label: string,
  repoRoot: string,
  groupPrompt: GroupPromptInfo | null = null,
): string {
  const lines = [
    `# CoAgentHub 任务(网页 @executor 发布)`,
    ``,
    `你是 ${label}。任务:${body}`,
  ];
  // 角色解绑后:成员在本群有分工提示词时,任务书插入「本群分工」段(先角色后
  // 提示词原文);无 prompt 时整段不输出,任务书与解绑前完全一致。
  if (groupPrompt && groupPrompt.prompt.trim().length > 0) {
    lines.push(
      `本群分工:角色=[${groupPrompt.roles.join(",")}];提示词=${groupPrompt.prompt}`,
    );
  }
  lines.push(
    `仓库:${repoRoot}(分支 main)`,
    `默认约束(除非消息里明确说明):不动 schema/迁移/scripts/ 下其他脚本、不删数据;测试全绿后提交,commit message 按功能写。`,
    `汇报:中文,做了什么/测试结果/commit hash。`,
  );
  return lines.join("\n");
}

function summaryOf(body: string): string {
  return body.replace(/\s+/g, " ").slice(0, 40);
}

function lastLinesOf(text: string, lines: number): string {
  const clean = (text ?? "").replace(ANSI_RE, "").trim();
  const arr = clean.split("\n").filter((l) => l.trim());
  return arr.slice(-lines).join("\n");
}

/** 从输出取 commit hash(40 位 hex 或 "commit/hash: xxx" 短格式)。 */
function findCommitHash(text: string): string | null {
  const clean = (text ?? "").replace(ANSI_RE, "");
  const full = clean.match(/[0-9a-f]{40}/);
  if (full) return full[0].slice(0, 12);
  const short = clean.match(/(?:commit|hash)\s*[:：]?\s*([0-9a-f]{7,12})/i);
  return short ? short[1] : null;
}

/** 与桥 extractSummary 一致:取「汇报/做了什么/测试结果/commit」段或末尾 15 行。 */
function extractSummary(text: string): string {
  const clean = (text ?? "").replace(ANSI_RE, "");
  const lines = clean.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/汇报|做了什么|测试结果|commit/.test(lines[i])) {
      start = i;
      break;
    }
  }
  const slice = start >= 0 ? lines.slice(start) : lines.slice(-15);
  let out = slice.join("\n").trim();
  if (out.length > 2000) out = out.slice(0, 2000) + "\n…(截断)";
  return out;
}
