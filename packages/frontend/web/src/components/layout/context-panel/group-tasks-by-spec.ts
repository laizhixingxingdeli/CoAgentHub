/**
 * 把 GET /groups/:id/tasks 返回的扁平任务列表按 specRef 聚合成「需求」
 * (Requirement)。本文件只做「数据分组 + 基础展示字段」,不做最终布局/图标
 * (属于 UI-04b 的范围)。
 *
 * 分组规则:
 *  - 同 `specRef`(非 null)的多个任务 → 聚合为一条 Requirement。
 *  - `specRef` 为 null 的任务 → 各自独立成一条(旧数据 / 未走 spec 驱动流程,
 *    不能强行归并),分组键用任务自身 id。
 *  - 有 `parentTaskId` 的执行任务 → 沿父链归到它的协调任务(父)之下:父任务
 *    的分组键即整条需求的分组键。协调任务因此**不单独成行** —— 它是该需求
 *    的 L2 层,同一条协调任务下的多个执行任务(拆票/打回/收尾)都归在同一
 *    条需求里。
 *  - 历史数据 `parentTaskId` 为 null → 保持现状各自成行,**不猜测父子关系**;
 *    parentTaskId 指向列表外的悬空父同样按无父处理(不猜)。
 *
 * 分组结果按「最新任务的 createdAt」正序排列 —— 最新的需求排在数组最后。
 * 这是给上层 UI 用的顺序约定:UI-04b 会按此顺序渲染,并把最新的放视觉底部。
 */

import type {
  DispatchKind,
  TaskItem,
  TaskStatus,
} from "@/pages/app/groups/messages/TaskPanel";
import type { Member } from "@/pages/app/groups/messages/types";
import { roleFromMemberRoles } from "./member-role";

/** 阶梯每层的状态。中性状态与 pending 区分「不适用」和「未开始」。 */
/**
 * v4.1(spec §3.14.6):「na-fix / 不适用·修复」状态删除——fix 票在三方在场时
 * 走 L3 精简档,与 requirement 票共用 running/pending/done/failed/
 * na-no-reviewer 状态;档位(完整/精简)由 review_request 载荷的 `lite`
 * 表达,见 L3State.depth。
 */
export type StepStatus =
  | "done"
  | "failed"
  | "running"
  | "pending"
  | "na-declared"
  | "na-no-reviewer";

/** 一条「需求」:同 specRef 任务的聚合结果。 */
export type Requirement = {
  /** 分组键:同 specRef 任务用 specRef 本身;null 任务用各自任务 id。 */
  id: string;
  /** 该需求对应的 specRef(null 表示未走 spec 驱动)。 */
  specRef: string | null;
  /** 组内所有任务,已按 createdAt 升序排列(最早在前)。 */
  tasks: TaskItem[];
  /** 组内最新任务(tasks 最后一个);需求的 status/updatedAt 取它。 */
  latestTask: TaskItem;
  /** 需求状态 = 最新任务的状态。 */
  status: TaskStatus;
  /** 需求工作类型,取组内最新任务;历史任务为 null。 */
  dispatchKind: DispatchKind | null;
  /** 需求下执行任务的累计重试次数,用于 L1 标签附属信息。 */
  retryCount: number;
  /** 需求更新时间 = 最新任务的 updatedAt(可能为 null)。 */
  updatedAt: string | null;
  /** 展示用标题(见 deriveLabel)。 */
  label: string;
  /** 固定三步: L1 执行、L2 协调、L3 检视。 */
  steps: StepStatus[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 从任务 diffSummary 取规范化的 review_request 载荷。导出供
 * requirement-layer-state 推导 L3 档位(`lite` 布尔,spec §3.14.6)。
 */
export function reviewRequestForTask(
  task: TaskItem,
): Record<string, unknown> | null {
  const summary = task.diffSummary;
  if (!isRecord(summary)) return null;
  if (summary.type === "review_request") return summary;
  return isRecord(summary.review_request) ? summary.review_request : null;
}

/** 协调任务的 review_request 载荷识别。 */
function isReviewRequestTask(task: TaskItem): boolean {
  const reason = noExecutionReasonForTask(task);
  return reviewRequestForTask(task) !== null || reason !== null;
}

/** 取协调任务声明的 L1 豁免理由;空串/纯空白不算声明。 */
export function noExecutionReasonForTask(task: TaskItem | null): string | null {
  const reason = task?.diffSummary?.noExecutionReason;
  return typeof reason === "string" && reason.trim().length > 0 ? reason : null;
}

/** 需求中的协调任务:父任务优先,兼容无子任务的历史 review_request。 */
export function coordinationTaskForTasks(tasks: TaskItem[]): TaskItem | null {
  const parentIds = new Set(
    tasks
      .map((task) => task.parentTaskId)
      .filter((id): id is string => Boolean(id)),
  );
  return (
    tasks.find((task) => parentIds.has(task.id)) ??
    tasks.find(isReviewRequestTask) ??
    null
  );
}

/** 需求内协调任务的判定:执行者在本群的角色含 `coordinator` → 协调任务(R1,
 * 与它有没有子任务无关);成员查不到/角色未知时回退到现有反推 ——
 * 被别的任务当作父(parentTaskId)或带 review_request 载荷(旧
 * coordinationTaskForTasks 的兜底),行为与改动前逐字一致(R2)。
 * 角色是权威,反推是兜底 —— 不取并集。
 * 返回协调任务 id 集合,供分层与标题提取共用(R3,不两处各写一份)。 */
function coordinationTaskIds(
  tasks: TaskItem[],
  members: Member[],
): ReadonlySet<string> {
  const parentIds = new Set(
    tasks
      .map((task) => task.parentTaskId)
      .filter((id): id is string => Boolean(id)),
  );
  const result = new Set<string>();
  for (const task of tasks) {
    const member = members.find(
      (m) => m.participantId === task.executorParticipantId,
    );
    const role = roleFromMemberRoles(member?.roles);
    if (role === "coordinator") {
      result.add(task.id);
    } else if (
      role === null &&
      (parentIds.has(task.id) || isReviewRequestTask(task))
    ) {
      result.add(task.id);
    }
  }
  return result;
}

/** 需求中真正代表 L1 的执行任务,排除协调任务与检视请求任务。 */
export function executionTasksForRequirement(
  tasks: TaskItem[],
  members: Member[] = [],
): TaskItem[] {
  const coordinationIds = coordinationTaskIds(tasks, members);
  return tasks.filter(
    (task) => !coordinationIds.has(task.id) && !isReviewRequestTask(task),
  );
}

/** 需求中全部协调者任务,按 createdAt 升序(R6,供 L2 聚合展示)。 */
export function coordinationTasksForRequirement(
  tasks: TaskItem[],
  members: Member[] = [],
): TaskItem[] {
  const coordinationIds = coordinationTaskIds(tasks, members);
  return tasks
    .filter((task) => coordinationIds.has(task.id))
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
}

/** 聚合一个层的任务状态:running 优先,随后全 done,再判定未被成功重试的失败。 */
export function aggregateTaskStatuses(statuses: TaskStatus[]): StepStatus {
  if (statuses.length === 0) return "pending";
  if (statuses.some((status) => status === "running")) return "running";
  if (statuses.every((status) => status === "done")) return "done";

  let lastFailed = -1;
  let lastDone = -1;
  for (let index = 0; index < statuses.length; index += 1) {
    if (statuses[index] === "failed") lastFailed = index;
    if (statuses[index] === "done") lastDone = index;
  }
  if (lastFailed >= 0 && lastDone <= lastFailed) return "failed";
  return "pending";
}

function retriesForTask(task: TaskItem): number {
  const retryCount = task.retryCount ?? 0;
  const attemptRetries = Math.max((task.attempts?.length ?? 0) - 1, 0);
  return Math.max(retryCount, attemptRetries);
}

/** 计算需求 L1 的附属重试次数,兼容旧 API 缺少 retryCount/attempts 的数据。 */
function retryCountForTasks(tasks: TaskItem[]): number {
  const recorded = tasks.reduce((sum, task) => sum + retriesForTask(task), 0);
  return recorded > 0 ? recorded : Math.max(tasks.length - 1, 0);
}

/** 从任务聚合出固定的 L1/L2/L3 三步;L3 需由消息与群成员补全。 */
function requirementSteps(tasks: TaskItem[], members: Member[]): StepStatus[] {
  const executionTasks = executionTasksForRequirement(tasks, members);
  const coordinationTask = coordinationTaskForTasks(tasks);
  const coordinationTasks = coordinationTasksForRequirement(tasks, members);
  return [
    noExecutionReasonForTask(coordinationTask)
      ? "na-declared"
      : aggregateTaskStatuses(executionTasks.map((task) => task.status)),
    aggregateTaskStatuses(coordinationTasks.map((task) => task.status)),
    "pending",
  ];
}

/**
 * 计算一条需求的展示标题:
 * - 有 specRef → 从 specRef 提取文件名去掉扩展名(更稳定的可读标题,例如
 *   "specs/auth/login.md" → "login")。specRef 可能是完整路径、带或不带扩展名。
 * - specRef 为 null(旧任务)→ 用最早那条任务的 id 兜底。
 *
 * 协调任务(组内是其他任务 parentTaskId 的父)不参与标题提取:它的 brief 是
 * 「协调请求(检视者 → 协调者)」样板,不是需求标题。归并组里优先取执行任务
 * (子)的标题。
 */
const TEMPLATE_TITLES = new Set(["coagenthub task", "coagenthub 任务"]);
const GOAL_SECTION_HEADING = /^#{2,6}\s*(?:goal|目标|任务内容)\s*$/i;
const MAX_TITLE_LENGTH = 64;

function formatTitle(value: string): string | null {
  const title = value.replace(/\s+/g, " ").trim();
  if (!title || title.startsWith("```")) return null;
  return title.length > MAX_TITLE_LENGTH
    ? `${title.slice(0, MAX_TITLE_LENGTH)}…`
    : title;
}

function titleFromFirstLine(line: string): string | null {
  const title = line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^(?:任务|task)\s*[:：]\s*/i, "")
    .trim();
  if (TEMPLATE_TITLES.has(title.toLocaleLowerCase())) return null;
  return formatTitle(title);
}

function titleFromGoalSection(lines: string[]): string | null {
  const goalIndex = lines.findIndex((line) => GOAL_SECTION_HEADING.test(line));
  if (goalIndex === -1) return null;
  let goalLine: string | null = null;
  for (const line of lines.slice(goalIndex + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) break;
    if (trimmed) {
      goalLine = trimmed;
      break;
    }
  }
  if (!goalLine) return null;
  const firstSentenceEnd = goalLine.search(/[。！？.!?]/);
  return formatTitle(
    firstSentenceEnd === -1
      ? goalLine
      : goalLine.slice(0, firstSentenceEnd + 1),
  );
}

export function deriveBriefTitle(
  brief: string | null | undefined,
): string | null {
  const lines = brief?.split(/\r?\n/) ?? [];
  const firstLine = lines.map((line) => line.trim()).find(Boolean);
  if (firstLine && !firstLine.startsWith("##")) {
    const title = titleFromFirstLine(firstLine);
    if (title) return title;
  }
  return titleFromGoalSection(lines);
}

export function deriveLabel(tasks: TaskItem[], members: Member[] = []): string {
  const first = tasks[0];
  if (!first) return "";
  // 跳过协调任务的 brief(样板标题);协调任务自身也不参与 specRef/id 兜底。
  const coordIds = coordinationTaskIds(tasks, members);
  const candidates = tasks.filter((task) => !coordIds.has(task.id));
  const titleSource = candidates.length > 0 ? candidates : tasks;
  const specRef = titleSource.find((task) => task.specRef)?.specRef;
  if (specRef) {
    const base = specRef.split("/").pop() ?? specRef;
    const withoutExt = base.replace(/\.[^./\\]+$/, "");
    return withoutExt || specRef;
  }
  const briefTitle = titleSource
    .map((task) => deriveBriefTitle(task.brief))
    .find((title): title is string => title !== null);
  if (briefTitle) {
    return briefTitle;
  }
  const anchor = titleSource[0];
  return anchor.id;
}

/**
 * 把任务列表按 specRef 聚合成需求,并在其上叠加 parentTaskId 父子归并。
 *
 * 归并规则:
 *  - 先按「根任务」分组:沿 parentTaskId 链上溯到最顶层(父必须在列表内;
 *    为 null / 悬空父 → 自身即根,不猜)。根任务的分组键 = 根.specRef ?? 根.id。
 *  - 有父的任务(执行任务)随其根(协调任务)入桶 —— 协调任务不单独成行,
 *    它的 specRef 为 null 时桶键是它自己的 id(稳定,不随子任务变化)。
 *  - 组内 tasks 按 createdAt 升序;latestTask / status / updatedAt 仍取最新任务。
 *
 * @param tasks 扁平任务列表(通常来自 GET /groups/:id/tasks)。
 * @param members 该群成员(协调任务按角色判定;缺省为空 → 回退反推)。
 * @returns 已按最新任务 createdAt 正序排列的 Requirement[]。
 */
export function groupTasksBySpec(
  tasks: TaskItem[],
  members: Member[] = [],
): Requirement[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));

  // 每个任务沿 parentTaskId 上溯到根(带 visited 防环;父不在列表即停)。
  const rootOf = new Map<string, TaskItem>();
  const resolveRoot = (task: TaskItem): TaskItem => {
    const cached = rootOf.get(task.id);
    if (cached) {
      return cached;
    }
    let root = task;
    const visited = new Set<string>([task.id]);
    let cursor: TaskItem | null = task;
    while (cursor.parentTaskId && !visited.has(cursor.parentTaskId)) {
      visited.add(cursor.parentTaskId);
      const parent = byId.get(cursor.parentTaskId);
      if (!parent) {
        break;
      }
      cursor = parent;
      root = parent;
    }
    rootOf.set(task.id, root);
    return root;
  };

  // 第一遍:按「根任务」的分组键(根.specRef ?? 根.id)分桶。
  const buckets = new Map<string, TaskItem[]>();
  for (const task of tasks) {
    const root = resolveRoot(task);
    const key = root.specRef ?? root.id;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(task);
    } else {
      buckets.set(key, [task]);
    }
  }

  // 第二遍:每个桶 → 一条 Requirement。
  const requirements: Requirement[] = [];
  for (const [key, groupTasks] of buckets) {
    // 组内按 createdAt 升序(最早的在前,最新的在最后)。
    const sorted = [...groupTasks].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const latest = sorted[sorted.length - 1];
    requirements.push({
      id: key,
      specRef: latest.specRef,
      tasks: sorted,
      latestTask: latest,
      status: latest.status,
      dispatchKind: latest.dispatchKind ?? null,
      retryCount: retryCountForTasks(
        executionTasksForRequirement(sorted, members),
      ),
      updatedAt: latest.updatedAt,
      label: deriveLabel(sorted, members),
      steps: requirementSteps(sorted, members),
    });
  }

  // 按「最新任务的 createdAt」正序排列:最新的需求在数组最后。
  requirements.sort(
    (a, b) =>
      new Date(a.latestTask.createdAt).getTime() -
      new Date(b.latestTask.createdAt).getTime(),
  );
  return requirements;
}
