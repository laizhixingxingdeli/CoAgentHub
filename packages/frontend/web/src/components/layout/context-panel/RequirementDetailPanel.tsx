/**
 * 需求详情面板(UI-04b-1):选中的需求 = 顶部精细阶梯状态条 + 下方沟通记录
 * 时间线。未选中(requirement === null)时显示空态提示。
 *
 * 时间线从 UI-04b-1 升级起消费「消息 + 任务」合并流:父级(TasksTab)把群
 * 消息与成员传进来,RequirementTimeline 据此渲染消息卡片(谁发给谁)与任务
 * 汇报卡片(归属规则见 merge-requirement-timeline.ts 的启发式注释)。
 *
 * 文案沿用同目录组件的现状(RequirementList 亦未接 i18n),不为这一票单独
 * 引入词典条目。
 */

import type { Member, MessageItem } from "@/pages/app/groups/messages/types";
import {
  deriveBriefTitle,
  type Requirement,
  type StepStatus,
  stepStatusFromTask,
} from "./group-tasks-by-spec";
import RequirementStepper from "./RequirementStepper";
import RequirementTimeline from "./RequirementTimeline";

type RequirementDetailPanelProps = {
  /** 当前选中的需求(null = 未选中)。 */
  requirement: Requirement | null;
  /** 该群全部消息(时间线消息卡片数据源)。 */
  messages: MessageItem[];
  /** 该群成员(真实角色数据源)。 */
  members: Member[];
  /** 实时输出缓冲(taskId → 已接收的 WS chunk 拼接),透传给时间线;
   * running 任务折叠态预览最后非空行、展开态显示全量输出。 */
  liveOutputs?: Record<string, string>;
};

type L3State = { status: StepStatus; taskId: string } | null;

function containsReviewRequest(task: Requirement["tasks"][number]): boolean {
  return JSON.stringify(task.diffSummary ?? {}).includes("review_request");
}

function findReviewResult(
  messages: MessageItem[],
  taskIds: Set<string>,
): "done" | "failed" | null {
  for (const message of messages) {
    if (!message.body.includes("review_result")) {
      continue;
    }
    const start = message.body.indexOf("{");
    const end = message.body.lastIndexOf("}");
    if (start < 0 || end <= start) {
      continue;
    }
    try {
      const payload = JSON.parse(message.body.slice(start, end + 1)) as {
        type?: string;
        taskId?: string;
        verdict?: string;
      };
      if (
        payload.type === "review_result" &&
        (!payload.taskId || taskIds.has(payload.taskId))
      ) {
        return payload.verdict === "pass" ? "done" : "failed";
      }
    } catch {
      // A human-readable wrapper around malformed JSON is not a conclusion.
    }
  }
  return null;
}

function deriveL3State(
  requirement: Requirement,
  messages: MessageItem[],
  members: Member[],
): L3State {
  if (!members.some((member) => member.roles.includes("reviewer"))) {
    return null;
  }
  const detached = requirement.tasks.find(
    (task) =>
      members.some(
        (member) =>
          member.participantId === task.executorParticipantId &&
          member.roles.includes("coordinator"),
      ) && containsReviewRequest(task),
  );
  if (!detached) {
    return null;
  }
  const result = findReviewResult(
    messages,
    new Set(requirement.tasks.map((task) => task.id)),
  );
  if (result) {
    return { status: result, taskId: detached.id };
  }
  if (detached.status === "done") {
    return { status: "running", taskId: detached.id };
  }
  if (detached.status === "failed" || detached.status === "cancelled") {
    return { status: "failed", taskId: detached.id };
  }
  return { status: "pending", taskId: detached.id };
}

export default function RequirementDetailPanel({
  requirement,
  messages,
  members,
  liveOutputs = {},
}: RequirementDetailPanelProps) {
  if (!requirement) {
    return (
      <div
        data-testid="requirement-detail-empty"
        className="px-4 py-8 text-center text-sm text-muted-foreground"
      >
        选择左侧一个需求查看详情
      </div>
    );
  }
  const l3 = deriveL3State(requirement, messages, members);
  const l3TaskId = l3?.taskId;
  const stepTasks = requirement.tasks.filter((task) => task.id !== l3TaskId);
  const stepLabels = stepTasks.map((task) => {
    const executor =
      members.find(
        (member) => member.participantId === task.executorParticipantId,
      )?.name ??
      task.executorKey ??
      "执行者";
    return `${executor} · ${deriveBriefTitle(task.brief) || requirement.label}`;
  });
  const stepStatuses = stepTasks.map((task) => stepStatusFromTask(task.status));
  if (l3) {
    stepStatuses.push(l3.status);
    stepLabels.push("L3 检视");
  }
  return (
    <div
      data-testid="requirement-detail-panel"
      className="flex flex-col gap-2 px-4 py-3"
    >
      <p className="truncate text-sm font-medium">{requirement.label}</p>
      <RequirementStepper steps={stepStatuses} labels={stepLabels} />
      <RequirementTimeline
        tasks={requirement.tasks}
        messages={messages}
        members={members}
        liveOutputs={liveOutputs}
      />
    </div>
  );
}
