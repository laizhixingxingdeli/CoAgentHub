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
  TaskItem,
  TaskStatus,
} from "@/pages/app/groups/messages/TaskPanel";

/**
 * 阶梯每步的状态(占位类型)。UI-04b 会做精细的「检视 / 协调 / 执行」三层
 * 语义判定;本票只留这个承载字段,具体算法见 stepStatusFromTask 的占位实现。
 *
 * UI-04b-1 补充 "running":精细阶梯要把「正在跑」画成呼吸青环,与「还没开始」
 * 的空心灰圈区分,笼统归进 pending 会丢掉这个视觉信息。
 */
export type StepStatus = "done" | "failed" | "running" | "pending";

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
  /** 需求更新时间 = 最新任务的 updatedAt(可能为 null)。 */
  updatedAt: string | null;
  /** 展示用标题(见 deriveLabel)。 */
  label: string;
  /**
   * 阶梯每一步的状态。⚠️ 占位算法 —— 每步对应一个任务,状态直接套用该任务
   * 的状态(done→done / failed→failed / 其余→pending)。精确的「三层还是两层」
   * 层级判定(需读检视/协调/执行的语义)留给 UI-04b 或更后面的票,不要假装这是
   * 最终实现。
   */
  steps: StepStatus[];
};

/** 是否应当显示为「完成」:done 视为完成。 */
function isDone(status: TaskStatus): boolean {
  return status === "done";
}
/** 是否应当显示为「失败」:failed 视为失败。 */
function isFailed(status: TaskStatus): boolean {
  return status === "failed";
}
/** 是否应当显示为「进行中」:running 视为进行中(UI-04b-1 起单独成一档)。 */
function isRunning(status: TaskStatus): boolean {
  return status === "running";
}

/**
 * ⚠️ 占位算法(非最终实现):把单个任务的状态映射到阶梯的一步。
 * - done 任务 → "done"
 * - failed 任务 → "failed"
 * - running 任务 → "running"(UI-04b-1:呼吸青环,与未开始区分)
 * - 其余(queued/cancelled) → "pending"
 * 后续票会基于检视/协调/执行的语义替换为精确层级判定。
 */
export function stepStatusFromTask(status: TaskStatus): StepStatus {
  if (isDone(status)) return "done";
  if (isFailed(status)) return "failed";
  if (isRunning(status)) return "running";
  return "pending";
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

/** 组内「协调任务」id 集合:是其他任务 parentTaskId 的父 → 不参与标题提取。 */
function coordinationTaskIds(tasks: TaskItem[]): ReadonlySet<string> {
  const parents = new Set<string>();
  for (const task of tasks) {
    if (task.parentTaskId) {
      parents.add(task.parentTaskId);
    }
  }
  return parents;
}

export function deriveLabel(tasks: TaskItem[]): string {
  const first = tasks[0];
  if (!first) return "";
  // 跳过协调任务的 brief(样板标题);协调任务自身也不参与 specRef/id 兜底。
  const coordIds = coordinationTaskIds(tasks);
  const candidates = tasks.filter((task) => !coordIds.has(task.id));
  const titleSource = candidates.length > 0 ? candidates : tasks;
  const briefTitle = titleSource
    .map((task) => deriveBriefTitle(task.brief))
    .find((title): title is string => title !== null);
  if (briefTitle) {
    return briefTitle;
  }
  const anchor = titleSource[0];
  if (anchor.specRef) {
    const base = anchor.specRef.split("/").pop() ?? anchor.specRef;
    const withoutExt = base.replace(/\.[^./\\]+$/, "");
    return withoutExt || anchor.specRef;
  }
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
 * @returns 已按最新任务 createdAt 正序排列的 Requirement[]。
 */
export function groupTasksBySpec(tasks: TaskItem[]): Requirement[] {
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
      updatedAt: latest.updatedAt,
      label: deriveLabel(sorted),
      // ⚠️ 占位:阶梯步数 = 组内任务数,每步状态直接套用对应任务的状态。
      steps: sorted.map((t) => stepStatusFromTask(t.status)),
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
