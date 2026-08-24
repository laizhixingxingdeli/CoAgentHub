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
};

export type L1State = {
  status: StepStatus;
  noExecutionReason: string | null;
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

function parseReviewResult(body: string): {
  verdict: string;
  findings: string | null;
  note: string | null;
  taskId: string | null;
} | null {
  if (!body.includes("review_result")) return null;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const payload = JSON.parse(body.slice(start, end + 1)) as {
      type?: string;
      taskId?: string;
      verdict?: string;
      findings?: string;
      note?: string;
    };
    if (payload.type !== "review_result") return null;
    return {
      verdict: payload.verdict ?? "",
      findings: payload.findings ?? null,
      note: payload.note ?? null,
      taskId: payload.taskId ?? null,
    };
  } catch {
    return null;
  }
}

function parseSpecPublished(
  body: string,
): { specRef: string; specHash: string | null } | null {
  if (!body.includes("spec_published")) return null;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const payload = JSON.parse(body.slice(start, end + 1)) as {
      type?: string;
      specRef?: string;
      specHash?: string;
    };
    if (payload.type !== "spec_published" || !payload.specRef) return null;
    return {
      specRef: payload.specRef,
      specHash: typeof payload.specHash === "string" ? payload.specHash : null,
    };
  } catch {
    return null;
  }
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
  return {
    status: reason
      ? "na-declared"
      : aggregateTaskStatuses(
          executionTasksForRequirement(requirement.tasks).map(
            (task) => task.status,
          ),
        ),
    noExecutionReason: reason,
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
  if (requirement.dispatchKind === "fix") {
    return {
      status: "na-fix",
      verdict: null,
      findings: null,
      note: null,
      specRef: anchor?.specRef ?? null,
      specHash: anchor?.specHash ?? null,
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
      };
    }
  }
  return {
    status: l2.status === "done" ? "running" : "pending",
    verdict: null,
    findings: null,
    note: null,
    specRef: anchor?.specRef ?? null,
    specHash: anchor?.specHash ?? null,
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
