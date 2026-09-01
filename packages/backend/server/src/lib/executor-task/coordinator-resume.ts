/**
 * 子任务终态时把协调者重新拉起(specs/wake-the-coordinator-on-child-completion.md
 * R1-R4):执行子任务进入终态(done/failed/cancelled)且其父协调任务仍非终态时,
 * 平台为父任务的执行方(协调者)创建一条续跑任务,并由现有队列(enqueueTaskRun)
 * 正常拉起。复用现有 task completion event 消费与任务队列拉起路径,不新写 spawn。
 *
 * 防环(R4):续跑任务由平台写入 `diffSummary.platform.resumeOf` 标记 —— 续跑任务
 * 自身终态时,消费方据此判定「这是续跑任务」而不再触发新的续跑,不依赖任务书文本。
 */

import {
  taskCompletionEvent as taskCompletionEventTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import {
  findExecutorByKey,
  findExecutorByParticipant,
} from "@server/lib/executors";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { isTerminalTaskStatus } from "../coordination-activity";
import { notifyTaskStatusChanged } from "./notify";
import {
  enqueueTaskRun,
  isCoordinatorTask,
  isExecutorProcessAlive,
} from "./queue";
import { isInCooldown, runningExecutorCount } from "./state";
import type { GroupPromptInfo } from "./types";

type Task = typeof taskTable.$inferSelect;

/** 续跑任务平台标记键:diffSummary.platform.resumeOf = 父协调任务 id。 */
const PLATFORM_MARKER_KEY = "resumeOf";
/** 续跑任务平台标记键:diffSummary.platform.resumeForChild = 触发续跑的子任务 id。 */
const RESUME_FOR_CHILD_KEY = "resumeForChild";

/**
 * 非终态任务状态集合:R3 去重查询与孤儿收敛豁免共用同一口径,
 * 不另写一套「非终态」定义(specs/orphan-reconciler-kills-pending-resume.md R1)。
 */
const NON_TERMINAL_TASK_STATUSES = ["queued", "running"] as const;

/**
 * 父任务名下是否存在「当前构成孤儿收敛豁免」的执行子任务(R2,
 * specs/executor-availability-visibility-and-queued-child-pinning.md):
 *  - running 子任务 → 豁免(子任务仍在干活,本机制存在的理由,逐字不变);
 *  - queued 且从未启动(executor_pid 必为空)的子任务 → 仅当其执行器当前可派发
 *    (不在额度冷却且未达并发上限,复用 isInCooldown / runningExecutorCount /
 *    maxConcurrency,与 pumpQueue 的 isRunDispatchable 前两条同口径)才豁免 ——
 *    否则排队子任务并不在干活,不构成豁免,父协调者按普通孤儿收敛处理。
 * 协调者根任务派完子任务退出后,只要还有「在跑或马上会启动」的子任务就不应被
 * 孤儿收敛判死,等子任务终态触发续跑。
 */
export async function hasExemptingChildTask(
  db: DataBase,
  parentTaskId: string,
): Promise<boolean> {
  const rows = await db.query.task.findMany({
    where: and(
      eq(taskTable.parentTaskId, parentTaskId),
      inArray(taskTable.status, [...NON_TERMINAL_TASK_STATUSES]),
    ),
    columns: { id: true, status: true, executorKey: true },
  });
  for (const child of rows) {
    if (child.status === "running") return true;
    if (await isQueuedChildExecutorDispatchable(db, child.executorKey)) {
      return true;
    }
  }
  return false;
}

/**
 * queued 子任务的执行器当前是否可派发:不在额度冷却且未达并发上限
 * (复用 isInCooldown / runningExecutorCount / 执行器声明的 maxConcurrency,
 * 与 pumpQueue 的 isRunDispatchable 前两条同口径,不另写一套可用性判定)。
 * executorKey 缺失或查无配置 → 不可派发(该子任务永远无法启动,不构成豁免)。
 */
async function isQueuedChildExecutorDispatchable(
  db: DataBase,
  executorKey: string | null,
): Promise<boolean> {
  if (!executorKey) return false;
  const ex = await findExecutorByKey(db, executorKey);
  if (!ex) return false;
  if (isInCooldown(ex)) return false;
  const cap = ex.maxConcurrency ?? Number.POSITIVE_INFINITY;
  if (runningExecutorCount(ex.key) >= cap) return false;
  return true;
}

/**
 * 父任务是否存在「应创建而尚未创建的续跑」(孤儿收敛豁免的另一半,
 * specs/orphan-reconciler-kills-pending-resume.md 的必经竞态窗口):
 * 存在一条 pending 的 task completion event,其所属子任务**不是续跑任务**。
 *
 * 完成事件由 DB trigger 在子任务首次进入终态时**同事务**创建,因此
 * 「子任务刚转终态而续跑任务尚未创建」的窗口恰等于该子任务的完成事件仍为
 * pending —— 这正是 consumePendingCompletionEvents 下一个周期会消费并创建
 * 续跑的窗口,期间父协调任务不得被孤儿收敛判死。事件被消费(续跑创建、事件置
 * delivered)后本判定自然失效,续跑任务作为新的非终态子任务由
 * hasExemptingChildTask 接续豁免。
 *
 * 终止性(R2/R3,防回归死锁):续跑任务自身的完成事件不计入等待续跑 —— 它的
 * 终态会被 R4 防环跳过、事件永久 pending,若计入会把「子任务(含续跑)全部
 * 终态、协调者仍未回来」的父任务永久豁免。其余不可能出现「pending 事件永不
 * 产生续跑」的组合:父任务终态/执行器存活/非协调者都不是孤儿收敛的候选,唯一
 * 的 R3 去重(已存在非终态续跑)由 hasExemptingChildTask 先行豁免,续跑终态
 * 后该 pending 事件重新可消费。
 */
export async function hasPendingResumeEvent(
  db: DataBase,
  parentTaskId: string,
): Promise<boolean> {
  const rows = await db
    .select({
      id: taskTable.id,
      diffSummary: taskTable.diffSummary,
    })
    .from(taskCompletionEventTable)
    .innerJoin(taskTable, eq(taskTable.id, taskCompletionEventTable.taskId))
    .where(
      and(
        eq(taskCompletionEventTable.state, "pending"),
        eq(taskTable.parentTaskId, parentTaskId),
      ),
    );
  return rows.some((row) => !isResumeTask(row));
}

/** 续跑任务是否带平台标记(判定「本任务是一条续跑任务」,R4 防环用)。 */
export function isResumeTask(task: { diffSummary: unknown }): boolean {
  const summary =
    task.diffSummary &&
    typeof task.diffSummary === "object" &&
    !Array.isArray(task.diffSummary)
      ? (task.diffSummary as Record<string, unknown>)
      : undefined;
  const platform =
    summary?.platform &&
    typeof summary.platform === "object" &&
    !Array.isArray(summary.platform)
      ? (summary.platform as Record<string, unknown>)
      : undefined;
  return typeof platform?.[PLATFORM_MARKER_KEY] === "string";
}

/**
 * 续跑判定结果(specs/completion-events-never-reach-terminal-state.md R1/R2):
 * - `created`:已创建续跑任务,消费方把事件置 delivered;
 * - `skipped` 且 permanence 为 `temporary`:不可处理的运行期条件可能变化,
 *   消费方**保持 pending**下轮重试;可选 reason 仅用于诊断,不写入 lastError;
 * - `skipped` 且 permanence 为 `permanent`:条件不会自行变化
 *   (事件属续跑任务自身 / 无父任务 / 父任务查不到 / 父任务已终态),消费方把
 *   事件置 dead 并以 reason 写 lastError。静默丢弃是被禁止的降级 —— 永久 skip
 *   必须留下可审计的原因。显式 permanence 防止未来新增带诊断文本的暂时 skip
 *   被误判为永久。
 */
export type ResumeDecision =
  | { kind: "created" }
  | { kind: "skipped"; permanence: "permanent"; reason: string }
  | { kind: "skipped"; permanence: "temporary"; reason?: string };

/**
 * R1-R4 判定 + 创建续跑任务。子任务进入终态后调用;返回创建/跳过决策
 * (跳过时区分永久/暂时,见 ResumeDecision)。
 *
 * - R1:子任务有父任务且父协调任务仍非终态;
 * - R2:父协调任务的 executor_pid 仍存活 → 不创建(协调者自己会消费完成事件);
 * - R3:同一父任务已存在非终态续跑任务 → 不重复创建;
 * - R4:本次终态的子任务本身是续跑任务 → 不触发续跑(防环)。
 */
export async function maybeCreateCoordinatorResumeTask(
  db: DataBase,
  childTask: Task,
): Promise<ResumeDecision> {
  // R4:续跑任务自身终态 → 不再触发续跑(防环)。
  if (isResumeTask(childTask)) {
    return {
      kind: "skipped",
      permanence: "permanent",
      reason: "事件属于续跑任务自身,按 R4 防环不产生续跑",
    };
  }

  // R1:必须是被派发的子任务(有父任务)。
  if (!childTask.parentTaskId) {
    return {
      kind: "skipped",
      permanence: "permanent",
      reason: "事件所属任务没有父任务(非被派发的子任务),无续跑对象",
    };
  }
  const parent = await db.query.task.findFirst({
    where: eq(taskTable.id, childTask.parentTaskId),
  });
  if (!parent) {
    return {
      kind: "skipped",
      permanence: "permanent",
      reason: "父任务记录不存在(可能被删除),无法创建续跑",
    };
  }
  if (isTerminalTaskStatus(parent.status)) {
    return {
      kind: "skipped",
      permanence: "permanent",
      reason: "父任务已处于终态,无续跑对象",
    };
  }

  // 父任务执行方必须是协调者(角色实时判定,与 isCoordinatorTask 同源)。
  // 角色运行期可变(可增删成员/改角色),故判为**暂时**:保留 pending,
  // 待该成员恢复 coordinator 角色后下轮重试(specs/completion-events-
  // never-reach-terminal-state.md §3.2)。
  if (
    !(await isCoordinatorTask(db, parent.groupId, parent.executorParticipantId))
  ) {
    return {
      kind: "skipped",
      permanence: "temporary",
      reason: "父任务执行方当前不是协调者,等待角色恢复后重试",
    };
  }

  // R2:父协调进程仍存活 → 不创建(协调者会自己消费完成事件)。暂时。
  if (
    parent.executorPid !== null &&
    isExecutorProcessAlive(parent.executorPid)
  ) {
    return {
      kind: "skipped",
      permanence: "temporary",
      reason: "父协调进程仍存活,等待其自行消费完成事件",
    };
  }

  // R3:只把平台标记的非终态续跑任务视为重复。父任务下可能同时存在
  // 协调者主动派给自己的普通子任务,它不应阻止平台创建恢复任务。暂时:
  // 续跑终态后本判定失效,事件重新可消费。
  const existing = await db.query.task.findMany({
    where: and(
      eq(taskTable.parentTaskId, parent.id),
      eq(taskTable.executorParticipantId, parent.executorParticipantId),
      inArray(taskTable.status, [...NON_TERMINAL_TASK_STATUSES]),
    ),
    columns: { id: true, diffSummary: true },
  });
  if (existing.some(isResumeTask)) {
    return {
      kind: "skipped",
      permanence: "temporary",
      reason: "父任务已有非终态续跑任务,等待该续跑任务终态",
    };
  }

  await createCoordinatorResumeTask(db, parent, childTask);
  return { kind: "created" };
}

/** 从任务书正文提取验收标准与红线段落(按 markdown 章节头匹配)。 */
function extractTaskSections(brief: string | null): {
  acceptance: string | null;
  redline: string | null;
} {
  if (!brief) return { acceptance: null, redline: null };
  const acceptanceRe =
    /(#{1,3}\s*(?:Acceptance|验收|验收标准)[^\n]*)\n([\s\S]*?)(?=\n#{1,3}\s|$)/i;
  const redlineRe =
    /(#{1,3}\s*(?:红线|Red[-\s]?line|红线\(重发不得触碰\))[^\n]*)\n([\s\S]*?)(?=\n#{1,3}\s|$)/i;
  const a = brief.match(acceptanceRe);
  const r = brief.match(redlineRe);
  return {
    acceptance: a ? a[0].trim() : null,
    redline: r ? r[0].trim() : null,
  };
}

/** 被替代任务回显长度上限,防止任务书体积失控。 */
const MAX_SUPERSEDED_ECHO_LENGTH = 4000;

/**
 * 子任务 diffSummary.outputTail 回显长度上限。取值小于
 * MAX_SUPERSEDED_ECHO_LENGTH:outputTail 全文在 DB 与明细 API 里都取得到,
 * 本处不是唯一信息源。
 *
 * 方向必须是**保尾**(`slice(-N)`):outputTail 是执行器输出的末尾若干行,
 * 而 L2 检视真正要的五段汇报(提交/测试/Token/汇报/遗留)、失败原因、额度报错
 * 全在末尾 —— 保头(`slice(0, N)`)会恰好切掉最值钱的部分。
 * (specs/resume-brief-echoes-unbounded-diffsummary.md R1/R2)
 */
const MAX_RESUME_DS_ECHO_LENGTH = 2000;

/**
 * 子任务 diffSummary 的任务书回显文本:除 `outputTail` 超限被保尾截断外,
 * 其余键原样保留(它们都是 KB 级以内,且正是 L2 检视的依据)。
 *
 * 非对象(含 null / undefined)→ 回退到与旧版一致的「无」;outputTail 缺失或
 * 非字符串 → 不截断。只影响任务书正文,不触碰 DB 中的 diff_summary 本体。
 */
export function buildDiffSummaryEcho(
  childTask: Pick<Task, "id" | "groupId" | "diffSummary">,
): string {
  const raw = childTask.diffSummary;
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return "无";
  }

  const summary = raw as Record<string, unknown>;
  const outputTail = summary.outputTail;
  if (
    typeof outputTail !== "string" ||
    outputTail.length <= MAX_RESUME_DS_ECHO_LENGTH
  ) {
    return JSON.stringify(raw);
  }

  // 静默截断是被禁止的降级:必须写明省略了多少字符 + 全文取回路径。
  const omitted = outputTail.length - MAX_RESUME_DS_ECHO_LENGTH;
  const notice = `…(前 ${omitted} 字符省略;完整明细:GET /api/groups/${childTask.groupId}/tasks/${childTask.id}/output?detail=1)`;
  return JSON.stringify({
    ...summary,
    outputTail: `${notice}\n${outputTail.slice(-MAX_RESUME_DS_ECHO_LENGTH)}`,
  });
}

/** 计算尝试链与当前尝试次数。 */
function computeAttemptChain(
  childTask: Task,
  children: Array<{
    id: string;
    status: string;
    supersedesTaskId: string | null;
  }>,
): { chain: string[]; attempt: number } {
  const byId = new Map(children.map((child) => [child.id, child]));
  const chain: string[] = [];
  let cursor: { id: string; supersedesTaskId: string | null } | null = {
    id: childTask.id,
    supersedesTaskId: childTask.supersedesTaskId,
  };
  while (cursor && chain.length <= 10) {
    chain.push(cursor.id);
    const nextId = cursor.supersedesTaskId;
    if (!nextId) break;
    const next = byId.get(nextId);
    if (!next) break; // 被替代任务不在本父任务名下(跨链)则停止回溯。
    cursor = { id: next.id, supersedesTaskId: next.supersedesTaskId };
  }
  return { chain, attempt: chain.length };
}

/** 构建被替代任务验收标准与红线回显段(导出供定向测试)。 */
export function buildSupersededEchoSection(
  supersededTask: Task | null | undefined,
  hasSupersededTask: boolean,
  supersededAttempt: number | null,
): string[] {
  if (!hasSupersededTask) return [];

  if (
    !supersededTask ||
    !supersededTask.brief ||
    supersededTask.brief.trim().length === 0
  ) {
    return ["## 被替代任务验收标准与红线", "- 无上次任务书可回显", ""];
  }

  const sections = extractTaskSections(supersededTask.brief);
  const lines: string[] = [
    "## 被替代任务验收标准与红线",
    `- 来源任务 id: ${supersededTask.id}`,
  ];
  if (supersededAttempt !== null) {
    lines.push(`- 哪一次尝试: 第 ${supersededAttempt} 次尝试`);
  }

  const contentLines: string[] = [];
  if (sections.acceptance) {
    contentLines.push("", sections.acceptance);
  } else {
    contentLines.push("- 无法取得该任务书的验收标准原文。");
  }
  if (sections.redline) {
    contentLines.push("", sections.redline);
  } else {
    contentLines.push("- 无法取得该任务书的红线原文。");
  }

  const content = contentLines.join("\n");
  if (content.length > MAX_SUPERSEDED_ECHO_LENGTH) {
    const truncated = content.slice(0, MAX_SUPERSEDED_ECHO_LENGTH);
    lines.push(
      truncated,
      "",
      `--- 【截断】以上内容已截断,原文共 ${content.length} 字符,此处保留前 ${MAX_SUPERSEDED_ECHO_LENGTH} 字符 ---`,
    );
  } else {
    for (const line of contentLines) {
      lines.push(line);
    }
  }

  lines.push("");
  return lines;
}

/** 构建续跑任务书(R1 要求的全部信息:父任务 id、终态子任务、spec、全部子任务)。 */
function buildResumeBrief(
  parent: Task,
  childTask: Task,
  children: Array<{
    id: string;
    status: string;
    supersedesTaskId: string | null;
  }>,
  supersededTask?: Task | null,
): string {
  const { chain, attempt } = computeAttemptChain(childTask, children);
  const diffSummary = buildDiffSummaryEcho(childTask);
  const childrenLines = children
    .map((child) => `- ${child.id}: ${child.status}`)
    .join("\n");
  return [
    "# CoAgentHub 续跑任务(协调者被重新拉起)",
    "",
    "你此前派发的子任务已进入终态,而你的协调进程已退出。平台为你创建了本条续跑任务,",
    "请完成 L2 检视并结案父任务。",
    "",
    "## 父协调任务(需要你 PATCH 结案)",
    `- 父任务 id: ${parent.id}`,
    `- 父任务 specRef: ${parent.specRef ?? "无"}`,
    `- 父任务 specHash: ${parent.specHash ?? "无"}`,
    "",
    "## 本次终态子任务",
    `- 子任务 id: ${childTask.id}`,
    `- 状态: ${childTask.status}`,
    `- diffSummary: ${diffSummary}`,
    "",
    "## 全部子任务(id 与当前状态)",
    childrenLines || "- (无)",
    "",
    ...buildSupersededEchoSection(
      supersededTask,
      !!childTask.supersedesTaskId,
      chain.length > 1 ? chain.length - 1 : null,
    ),
    ...buildRetryContextSection(childTask, chain, attempt),
    "## 操作",
    "1. 读取父任务详情与冻结 spec,对本次终态子任务做 L2 检视。",
    "2. 若可结案:PATCH 父任务为 done(附 diffSummary)。",
    "3. 若 L2 未通过:按协调 skill §4.1.1 重发协议生成两段式重试任务书并重下发,",
    "   supersedesTaskId 指向本次失败子任务;同一工作项连续三次重发仍失败 →",
    "   停止重试,在群内说明并交回检视者,不得无限重试。",
    "4. 完成后 PATCH 本条续跑任务为 done。",
  ].join("\n");
}

/**
 * 重试上下文(协议注入,协调者每轮必读):沿 supersedesTaskId 链回溯本次终态子任务
 * 是第几次尝试,并强制重发任务书的两段式要求、可见差异、三次上限。与 queue.ts
 * 的「派发后立即退出」同款上下文注入 —— 不依赖协调者是否主动读到 SKILL.md §4.1.1。
 */
function buildRetryContextSection(
  childTask: Task,
  chain: string[],
  attempt: number,
): string[] {
  return [
    "## 重试上下文",
    `- 本次终态子任务 ${childTask.id} 是第 ${attempt} 次尝试(替代链: ${chain.join(" → ")};无链 = 首次尝试)。`,
    "- 若为重发(L2 未通过后的重下发):重发任务书必须包含两段,缺任一段即不合格 ——",
    "  ① 上次失败的判定:是什么失败(零产出/测试不过/越界/超时/额度),依据是什么",
    "     (提交为空/哪条用例红/哪个文件越界),引用具体证据而非「上次失败了」;",
    "  ② 本次要避开什么:据此给出的具体约束或提示。",
    "- 重发任务书必须与上一次存在可见差异;逐字相同视为不合格重试。",
    "- 失败原因无法判定时,如实写「未能判定失败原因」并说明已查过什么;不得编造,也不得跳过该段。",
    "- 重发 `diffSummary.retries` 如实记录第几次尝试;同一工作项连续三次重发仍失败 →",
    "  停止重试,在群内说明并交回检视者,不得无限重试。",
    "- 验收标准与红线是检视者定的,重发时逐字保持,只允许增补失败判定与避坑提示;不得因重试放宽验收。",
  ];
}

/** 为父协调任务创建续跑任务并复用现有队列路径拉起。 */
async function createCoordinatorResumeTask(
  db: DataBase,
  parent: Task,
  childTask: Task,
): Promise<void> {
  const children = await db.query.task.findMany({
    where: eq(taskTable.parentTaskId, parent.id),
    columns: { id: true, status: true, supersedesTaskId: true },
    orderBy: (t, { asc: ascFn }) => ascFn(t.createdAt),
  });

  let supersededTask: Task | undefined;
  if (childTask.supersedesTaskId) {
    supersededTask =
      (await db.query.task.findFirst({
        where: eq(taskTable.id, childTask.supersedesTaskId),
      })) ?? undefined;
  }

  const brief = buildResumeBrief(parent, childTask, children, supersededTask);
  const messageId = uuidv7();

  const [created] = await db
    .insert(taskTable)
    .values({
      groupId: parent.groupId,
      parentTaskId: parent.id,
      messageId,
      executorParticipantId: parent.executorParticipantId,
      executorKey: parent.executorKey,
      status: "queued",
      brief,
      specRef: parent.specRef,
      specHash: parent.specHash,
      dispatchKind: parent.dispatchKind ?? null,
      // 平台标记(R4):续跑任务自身终态时消费方据此防环;不依赖任务书文本。
      // 同时记录 resumeForChild,供 L2 重发路径自动补齐 supersedesTaskId 使用。
      diffSummary: {
        platform: {
          [PLATFORM_MARKER_KEY]: parent.id,
          [RESUME_FOR_CHILD_KEY]: childTask.id,
        },
      },
      // 完成事件定向给协调者(与父任务同执行方),供其收件箱留存。
      dispatcherParticipantId: parent.executorParticipantId,
    })
    .returning();

  const ex = await findExecutorByParticipant(db, parent);
  if (!ex) {
    console.warn(
      `[executor] 续跑任务 ${created.id} 无法拉起:协调者 ${parent.executorParticipantId} 无执行器配置`,
    );
    return;
  }

  await notifyTaskStatusChanged(
    db,
    created.id,
    parent.groupId,
    "queued",
    created,
  );

  const membership = await db.query.groupMember.findFirst({
    where: (t, { and: andFn, eq: eqFn }) =>
      andFn(
        eqFn(t.groupId, parent.groupId),
        eqFn(t.participantId, parent.executorParticipantId),
      ),
  });
  const groupPrompt: GroupPromptInfo | null = membership
    ? { roles: membership.roles, prompt: membership.prompt }
    : null;

  await enqueueTaskRun(db, created, {
    groupId: parent.groupId,
    messageId,
    participantId: parent.executorParticipantId,
    ex,
    body: brief,
    groupPrompt,
    specRef: parent.specRef,
    specHash: parent.specHash,
  });
}

/**
 * 消费 pending 的 task completion event:对每条事件所属任务执行
 * maybeCreateCoordinatorResumeTask —— 创建了续跑任务的把事件置为 delivered,
 * 永久不可处理的置 dead 并把原因写入 lastError(静默丢弃是被禁止的降级),
 * 暂时不可处理的保持 pending 下轮重试(条件可能变化)。避免重复消费。
 * 返回创建的续跑任务数。
 *
 * 判据(specs/completion-events-never-reach-terminal-state.md R1/R2):
 * 「永久/暂时」由 maybeCreateCoordinatorResumeTask 的显式 permanence 判定 ——
 * 永久类是事件自身事实(无父任务/父已终态/父不存在/自身是续跑任务),不会自行
 * 变化;暂时类依赖运行期可变状态(进程存活、成员角色、在途续跑)。本消费循环
 * 不另建第二套判据,permanence 是同一事实的唯一判定出处;reason 仅是诊断文本。
 */
export async function consumePendingCompletionEvents(
  db: DataBase,
): Promise<number> {
  const now = new Date();
  const rows = await db
    .select()
    .from(taskCompletionEventTable)
    .where(
      and(
        eq(taskCompletionEventTable.state, "pending"),
        or(
          isNull(taskCompletionEventTable.nextAttemptAt),
          lte(taskCompletionEventTable.nextAttemptAt, now),
        ),
      ),
    )
    .orderBy(asc(taskCompletionEventTable.id));

  let created = 0;
  for (const event of rows) {
    const task = await db.query.task.findFirst({
      where: eq(taskTable.id, event.taskId),
    });
    if (!task) continue;
    const result = await maybeCreateCoordinatorResumeTask(db, task);
    if (result.kind === "created") {
      created += 1;
      await db
        .update(taskCompletionEventTable)
        .set({ state: "delivered", deliveredAt: now, updatedAt: now })
        .where(eq(taskCompletionEventTable.id, event.id));
    } else if (result.permanence === "permanent") {
      // 永久不可处理:条件不会自行变化,保持 pending 只会无限重扫。条件更新
      // 防止覆盖 inbox 并发路径(claim→ack/fail)的写回。
      await db
        .update(taskCompletionEventTable)
        .set({ state: "dead", lastError: result.reason, updatedAt: now })
        .where(
          and(
            eq(taskCompletionEventTable.id, event.id),
            eq(taskCompletionEventTable.state, "pending"),
          ),
        );
    }
  }
  return created;
}

/**
 * L2 重发路径安全网:调用方未显式传 supersedesTaskId 时,平台根据当前续跑上下文
 * 自动指向刚结束/被替代的子任务。规则:
 * - 首次派发(无续跑上下文)不补;
 * - 协调者自派(目标=自己)不补;
 * - 跨父任务不串链(只查当前 running 父任务下的续跑任务);
 * - 显式合法值保持兼容(本函数不被调用)。
 */
export async function inferSupersedesTaskId(
  db: DataBase,
  groupId: string,
  senderId: string,
  targetParticipantId: string,
): Promise<string | null> {
  // 首次派发/协调者自派时不自动补链。
  if (senderId === targetParticipantId) return null;

  // 查找发送者在本群的 running detached 父任务(协调任务)。
  // 必须取根任务(parentTaskId 为 null),排除续跑任务本身。
  const parent = await db.query.task.findFirst({
    where: and(
      eq(taskTable.groupId, groupId),
      eq(taskTable.executorParticipantId, senderId),
      eq(taskTable.status, "running"),
      isNull(taskTable.parentTaskId),
    ),
    orderBy: (t, { desc }) => [desc(t.updatedAt)],
    columns: { id: true },
  });
  if (!parent) return null;

  // 取该父任务下最新的续跑任务,读取其 resumeForChild 标记。
  const resumeTask = await db.query.task.findFirst({
    where: and(
      eq(taskTable.parentTaskId, parent.id),
      eq(taskTable.executorParticipantId, senderId),
    ),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    columns: { diffSummary: true },
  });
  if (!resumeTask) return null;

  const summary =
    resumeTask.diffSummary &&
    typeof resumeTask.diffSummary === "object" &&
    !Array.isArray(resumeTask.diffSummary)
      ? (resumeTask.diffSummary as Record<string, unknown>)
      : undefined;
  const platform =
    summary?.platform &&
    typeof summary.platform === "object" &&
    !Array.isArray(summary.platform)
      ? (summary.platform as Record<string, unknown>)
      : undefined;
  const resumeChildId =
    typeof platform?.[RESUME_FOR_CHILD_KEY] === "string"
      ? (platform[RESUME_FOR_CHILD_KEY] as string)
      : null;
  if (!resumeChildId) return null;

  // 校验 resumeForChild 指向的任务:已终态、非续跑任务、且未被替代。
  const child = await db.query.task.findFirst({
    where: and(
      eq(taskTable.id, resumeChildId),
      eq(taskTable.groupId, groupId),
      inArray(taskTable.status, ["done", "failed", "cancelled"]),
    ),
    columns: { id: true, diffSummary: true },
  });
  if (!child) return null;
  if (isResumeTask(child)) return null;

  const successor = await db.query.task.findFirst({
    where: eq(taskTable.supersedesTaskId, child.id),
    columns: { id: true },
  });
  if (successor) return null;

  return child.id;
}

/** 周期性消费完成事件(server 启动时注册);返回停止函数(测试用)。 */
export function startCoordinatorResumeConsumer(
  db: DataBase,
  intervalMs = 5_000,
): () => void {
  const timer = setInterval(() => {
    void consumePendingCompletionEvents(db).catch((error) => {
      console.warn(`[executor] 续跑任务消费失败: ${error}`);
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
