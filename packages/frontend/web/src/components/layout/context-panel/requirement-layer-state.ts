import {
  type CoordinationPayload,
  parseKnownCoordinationPayload,
} from "@laizhixingxingdeli/database/schema";
import type { Member, MessageItem } from "@/pages/app/groups/messages/types";
import type { Requirement, StepStatus } from "./group-tasks-by-spec";
import {
  aggregateTaskStatuses,
  coordinationTaskForTasks,
  coordinationTasksForRequirement,
  deriveL1Status,
  executionTasksForRequirement,
  noExecutionReasonForTask,
  reviewRequestForTask,
} from "./group-tasks-by-spec";

export type L2State = {
  task: Requirement["tasks"][number] | null;
  status: StepStatus;
  conclusion: string | null;
};

/**
 * L3 档位(spec §3.14.6 v4.1):requirement 票 = "full"(完整档,强断言);
 * fix 票 = "lite"(精简档,弱一档的断言,免 spec 对照);
 * "na-no-reviewer" 时 = null(没有 L3 可言)。
 */
export type L3Depth = "full" | "lite" | null;

export type L3State = {
  status: StepStatus;
  verdict: string | null;
  findings: string | null;
  note: string | null;
  specRef: string | null;
  specHash: string | null;
  /** API observability; null means this older task has no l3 detail yet. */
  answered: boolean | null;
  awaitingSince: string | null;
  overdue: boolean;
  /** 本票 L3 档位(v4.1 三态:已检视·完整 / 已检视·精简 / 未检视·无检视者)。 */
  depth: L3Depth;
};

export type L1State = {
  status: StepStatus;
  noExecutionReason: string | null;
  /** API effective-attempt counts; fallback is derived from list rows. */
  childCount: number;
  supersededCount: number;
};

export type RequirementLayerState = {
  l1: L1State;
  l2: L2State;
  l3: L3State;
  /** The exact statuses rendered by both the stepper and layer cards. */
  steps: [StepStatus, StepStatus, StepStatus];
};

function isReviewRequestPayload(
  diffSummary: Record<string, unknown> | null,
): boolean {
  return diffSummary?.type === "review_request";
}

function reviewRequestConclusion(
  task: Requirement["tasks"][number] | null,
): string | null {
  if (!task?.diffSummary || typeof task.diffSummary !== "object") {
    return null;
  }
  const payload = isReviewRequestPayload(task.diffSummary)
    ? task.diffSummary
    : task.diffSummary.review_request;
  if (typeof payload !== "object" || payload === null) return null;
  const conclusion = (payload as Record<string, unknown>).diffSummary;
  return typeof conclusion === "string" && conclusion.trim().length > 0
    ? conclusion
    : null;
}

export function layerModeFromMembers(members: Member[]): "three" | "two" {
  const roles = new Set(members.flatMap((member) => member.roles ?? []));
  return roles.has("reviewer") && roles.has("coordinator") ? "three" : "two";
}

function parseCoordinationPayload(body: string): CoordinationPayload | null {
  try {
    return parseKnownCoordinationPayload(body.trim()) ?? null;
  } catch {
    return null;
  }
}

function parseReviewResult(body: string): {
  verdict: string;
  findings: string | null;
  note: string | null;
  taskId: string | null;
} | null {
  const payload = parseCoordinationPayload(body);
  if (payload?.type !== "review_result") return null;
  return {
    verdict: payload.verdict,
    findings:
      payload.findings.length > 0
        ? payload.findings
            .map(({ severity, note }) => `${severity}: ${note}`)
            .join("\n")
        : null,
    note: payload.note ?? null,
    taskId: payload.taskId,
  };
}

function parseSpecPublished(
  body: string,
): { specRef: string; specHash: string | null } | null {
  const payload = parseCoordinationPayload(body);
  if (payload?.type !== "spec_published") return null;
  return { specRef: payload.specRef, specHash: payload.specHash };
}

function findSpecAnchor(
  requirement: Requirement,
  messages: MessageItem[],
): { specRef: string; specHash: string | null } | null {
  if (requirement.specRef) {
    for (const message of messages) {
      const published = parseSpecPublished(message.body);
      if (published?.specRef === requirement.specRef) return published;
    }
  }
  return requirement.specRef
    ? { specRef: requirement.specRef, specHash: null }
    : null;
}

function deriveL1(requirement: Requirement, members: Member[]): L1State {
  const coordinationTask = coordinationTaskForTasks(requirement.tasks);
  const executionTasks = executionTasksForRequirement(
    requirement.tasks,
    members,
  );
  const reason = noExecutionReasonForTask(coordinationTask);
  return {
    status: deriveL1Status(requirement.tasks, members),
    noExecutionReason: reason,
    childCount: coordinationTask?.l1?.childCount ?? executionTasks.length,
    supersededCount: coordinationTask?.l1?.supersededCount ?? 0,
  };
}

function deriveL2(requirement: Requirement, members: Member[]): L2State {
  const coordinationTasks = coordinationTasksForRequirement(
    requirement.tasks,
    members,
  );
  // 展示锚点取最新一条协调任务(续跑任务);状态由全部协调者任务聚合(R6)。
  const task = coordinationTasks[coordinationTasks.length - 1] ?? null;
  return {
    task,
    status: aggregateTaskStatuses(coordinationTasks.map((task) => task.status)),
    conclusion: reviewRequestConclusion(task),
  };
}

function deriveL3(
  requirement: Requirement,
  messages: MessageItem[],
  mode: "three" | "two",
  l2: L2State,
): L3State {
  const anchor = findSpecAnchor(requirement, messages);
  const coordinationTask = coordinationTaskForTasks(requirement.tasks);
  const apiL3 = coordinationTask?.l3;
  // v4.1(spec §3.14.6):「na-fix / 不适用·修复」状态删除——fix 票在三方在场时
  // 与 requirement 票共用 L3 状态推导(精简档);两方在场时所有票都是
  // na-no-reviewer(编制所致,与「因为是修复」不再混同)。
  // 档位按协调任务 review_request 载荷的 `lite` 布尔;载荷缺失(历史数据)
  // 时按 dispatchKind 兜底,缺省 = 完整档。
  const requestPayload = coordinationTask
    ? reviewRequestForTask(coordinationTask)
    : null;
  const depth: L3Depth =
    typeof requestPayload?.lite === "boolean"
      ? requestPayload.lite
        ? "lite"
        : "full"
      : requirement.dispatchKind === "fix"
        ? "lite"
        : "full";
  const taskIds = new Set(requirement.tasks.map((task) => task.id));
  if (mode === "two") {
    return {
      status: "na-no-reviewer",
      verdict: null,
      findings: null,
      note: null,
      specRef: anchor?.specRef ?? null,
      specHash: anchor?.specHash ?? null,
      answered: null,
      awaitingSince: null,
      overdue: false,
      depth: null,
    };
  }
  for (const message of messages) {
    const result = parseReviewResult(message.body);
    if (
      result &&
      result.taskId !== null &&
      taskIds.has(result.taskId) &&
      result.verdict
    ) {
      return {
        status: result.verdict === "pass" ? "done" : "failed",
        verdict: result.verdict,
        findings: result.findings,
        note: result.note,
        specRef: anchor?.specRef ?? null,
        specHash: anchor?.specHash ?? null,
        answered: true,
        awaitingSince: apiL3?.awaitingSince ?? null,
        overdue: false,
        depth,
      };
    }
  }
  if (apiL3?.answered && apiL3.verdict) {
    return {
      status: apiL3.verdict === "pass" ? "done" : "failed",
      verdict: apiL3.verdict,
      findings: null,
      note: null,
      specRef: anchor?.specRef ?? null,
      specHash: anchor?.specHash ?? null,
      answered: true,
      awaitingSince: apiL3.awaitingSince,
      overdue: false,
      depth,
    };
  }
  return {
    status: l2.status === "done" ? "running" : "pending",
    verdict: null,
    findings: null,
    note: null,
    specRef: anchor?.specRef ?? null,
    specHash: anchor?.specHash ?? null,
    answered: apiL3?.answered ?? null,
    awaitingSince: apiL3?.awaitingSince ?? null,
    overdue: apiL3?.overdue ?? false,
    depth,
  };
}

export function deriveRequirementLayerState(
  requirement: Requirement,
  messages: MessageItem[],
  members: Member[],
): RequirementLayerState {
  const l1 = deriveL1(requirement, members);
  const l2 = deriveL2(requirement, members);
  const l3 = deriveL3(requirement, messages, layerModeFromMembers(members), l2);
  return {
    l1,
    l2,
    l3,
    steps: [l1.status, l2.status, l3.status],
  };
}
