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
import { findExecutorByParticipant } from "@server/lib/executors";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { isTerminalTaskStatus } from "../coordination-activity";
import { notifyTaskStatusChanged } from "./notify";
import {
  enqueueTaskRun,
  isCoordinatorTask,
  isExecutorProcessAlive,
} from "./queue";
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
 * 父任务名下是否存在非终态执行子任务(孤儿收敛豁免的同源判定):
 * parentTaskId = 父任务 && status ∈ 非终态集合。协调者根任务派完子任务退出后,
 * 只要还有子任务在跑就不应被孤儿收敛判死,等子任务终态触发续跑。
 */
export async function hasNonTerminalChildTask(
  db: DataBase,
  parentTaskId: string,
): Promise<boolean> {
  const rows = await db.query.task.findMany({
    where: and(
      eq(taskTable.parentTaskId, parentTaskId),
      inArray(taskTable.status, [...NON_TERMINAL_TASK_STATUSES]),
    ),
    columns: { id: true },
    limit: 1,
  });
  return rows.length > 0;
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
 * hasNonTerminalChildTask 接续豁免。
 *
 * 终止性(R2/R3,防回归死锁):续跑任务自身的完成事件不计入等待续跑 —— 它的
 * 终态会被 R4 防环跳过、事件永久 pending,若计入会把「子任务(含续跑)全部
 * 终态、协调者仍未回来」的父任务永久豁免。其余不可能出现「pending 事件永不
 * 产生续跑」的组合:父任务终态/执行器存活/非协调者都不是孤儿收敛的候选,唯一
 * 的 R3 去重(已存在非终态续跑)由 hasNonTerminalChildTask 先行豁免,续跑终态
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
 * R1-R4 判定 + 创建续跑任务。子任务进入终态后调用;返回是否创建了续跑任务。
 *
 * - R1:子任务有父任务且父协调任务仍非终态;
 * - R2:父协调任务的 executor_pid 仍存活 → 不创建(协调者自己会消费完成事件);
 * - R3:同一父任务已存在非终态续跑任务 → 不重复创建;
 * - R4:本次终态的子任务本身是续跑任务 → 不触发续跑(防环)。
 */
export async function maybeCreateCoordinatorResumeTask(
  db: DataBase,
  childTask: Task,
): Promise<"created" | "skipped"> {
  // R4:续跑任务自身终态 → 不再触发续跑(防环)。
  if (isResumeTask(childTask)) return "skipped";

  // R1:必须是被派发的子任务(有父任务)。
  if (!childTask.parentTaskId) return "skipped";
  const parent = await db.query.task.findFirst({
    where: eq(taskTable.id, childTask.parentTaskId),
  });
  if (!parent) return "skipped";
  if (isTerminalTaskStatus(parent.status)) return "skipped";

  // 父任务执行方必须是协调者(角色实时判定,与 isCoordinatorTask 同源)。
  if (
    !(await isCoordinatorTask(db, parent.groupId, parent.executorParticipantId))
  ) {
    return "skipped";
  }

  // R2:父协调进程仍存活 → 不创建(协调者会自己消费完成事件)。
  if (
    parent.executorPid !== null &&
    isExecutorProcessAlive(parent.executorPid)
  ) {
    return "skipped";
  }

  // R3:只把平台标记的非终态续跑任务视为重复。父任务下可能同时存在
  // 协调者主动派给自己的普通子任务,它不应阻止平台创建恢复任务。
  const existing = await db.query.task.findMany({
    where: and(
      eq(taskTable.parentTaskId, parent.id),
      eq(taskTable.executorParticipantId, parent.executorParticipantId),
      inArray(taskTable.status, [...NON_TERMINAL_TASK_STATUSES]),
    ),
    columns: { id: true, diffSummary: true },
  });
  if (existing.some(isResumeTask)) return "skipped";

  await createCoordinatorResumeTask(db, parent, childTask);
  return "created";
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

/** 计算尝试链与当前尝试次数。 */
function computeAttemptChain(
  childTask: Task,
  children: Array<{ id: string; status: string; supersedesTaskId: string | null }>,
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
    return [
      "## 被替代任务验收标准与红线",
      "- 无上次任务书可回显",
      "",
    ];
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
  const diffSummary =
    childTask.diffSummary !== null &&
    childTask.diffSummary !== undefined &&
    typeof childTask.diffSummary === "object"
      ? JSON.stringify(childTask.diffSummary)
      : "无";
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
 * maybeCreateCoordinatorResumeTask,创建了续跑任务的把事件置为 delivered,
 * 避免重复消费。返回创建的续跑任务数。
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
    if (result === "created") {
      created += 1;
      await db
        .update(taskCompletionEventTable)
        .set({ state: "delivered", deliveredAt: now, updatedAt: now })
        .where(eq(taskCompletionEventTable.id, event.id));
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
