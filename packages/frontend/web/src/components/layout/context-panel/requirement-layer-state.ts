import {
  type CoordinationPayload,
  parseKnownCoordinationPayload,
} from "@laizhixingxingdeli/database/schema";
import type { Member, MessageItem } from "@/pages/app/groups/messages/types";
import type { Requirement, StepStatus } from "./group-tasks-by-spec";
import {
  aggregateTaskStatuses,
  coordinationTaskForTasks,
  executionTasksForRequirement,
  noExecutionReasonForTask,
  taskStatusToStepStatus,
} from "./group-tasks-by-spec";

export type L2State = {
  task: Requirement["tasks"][number] | null;
  status: StepStatus;
  conclusion: string | null;
};

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

function deriveL1(requirement: Requirement): L1State {
  const coordinationTask = coordinationTaskForTasks(requirement.tasks);
  const reason = noExecutionReasonForTask(coordinationTask);
  const executionTasks = executionTasksForRequirement(requirement.tasks);
  return {
    status: reason
      ? "na-declared"
      : aggregateTaskStatuses(executionTasks.map((task) => task.status)),
    noExecutionReason: reason,
    childCount: coordinationTask?.l1?.childCount ?? executionTasks.length,
    supersededCount: coordinationTask?.l1?.supersededCount ?? 0,
  };
}

function deriveL2(requirement: Requirement): L2State {
  const task = coordinationTaskForTasks(requirement.tasks);
  return {
    task,
    status: task ? taskStatusToStepStatus(task.status) : "pending",
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
  if (requirement.dispatchKind === "fix") {
    return {
      status: "na-fix",
      verdict: null,
      findings: null,
      note: null,
      specRef: anchor?.specRef ?? null,
      specHash: anchor?.specHash ?? null,
      answered: null,
      awaitingSince: null,
      overdue: false,
    };
  }
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
  };
}

export function deriveRequirementLayerState(
  requirement: Requirement,
  messages: MessageItem[],
  members: Member[],
): RequirementLayerState {
  const l1 = deriveL1(requirement);
  const l2 = deriveL2(requirement);
  const l3 = deriveL3(requirement, messages, layerModeFromMembers(members), l2);
  return {
    l1,
    l2,
    l3,
    steps: [l1.status, l2.status, l3.status],
  };
}
