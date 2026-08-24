/**
 * 需求详情面板(UI-04b-1 + requirement-three-layer-view):选中的需求 = 顶部精细
 * 阶梯状态条 + L3/L2/L1 三层关卡 + 下方沟通记录时间线。未选中
 * (requirement === null)时显示空态提示。
 *
 * 三层语义(requirement-three-layer-view):
 *  - L3 检视:读群消息里的 `review_result` 载荷(verdict / findings / note),
 *    另以 `spec_published` / specRef 作为该需求的规范锚点。
 *  - L2 协调:协调任务(`diffSummary.review_request`,含 L2 结论文本);
 *    任务状态即 L2 是否完成。
 *  - L1 执行:执行任务的 `diffSummary`(summary/tests/todo/hash/tokenUsage/
 *    claimVerification)与耗时,由下方 RequirementTimeline 呈现。
 *  - 三层模式要求 reviewer 与 coordinator **同时在场**
 *    (spec v3.9 §3.14.5;不用 v3.8 的「有无 reviewer」旧判据)。缺层时
 *    L3 显式显示「未检视·无检视者」,修复票则显示「不适用·修复」。
 *
 * 时间线从 UI-04b-1 升级起消费「消息 + 任务」合并流:父级(TasksTab)把群
 * 消息与成员传进来,RequirementTimeline 据此渲染消息卡片(谁发给谁)与任务
 * 汇报卡片(归属规则见 merge-requirement-timeline.ts 的启发式注释)。
 *
 * 文案沿用同目录组件的现状(RequirementList 亦未接 i18n),不为这一票单独
 * 引入词典条目。
 */

import { type ReactNode, useState } from "react";
import type { Member, MessageItem } from "@/pages/app/groups/messages/types";
import { FoldableContent } from "./FoldableContent";
import {
  executionTasksForRequirement,
  type Requirement,
  type StepStatus,
} from "./group-tasks-by-spec";
import RequirementStepper from "./RequirementStepper";
import RequirementTimeline, {
  roleFromMemberRoles,
} from "./RequirementTimeline";
import { deriveRequirementLayerState } from "./requirement-layer-state";
import { LAYER_STATUS_CLASS } from "./status-classes";

export type LayerStatus = StepStatus;

type RequirementDetailPanelProps = {
  /** 当前选中的需求(null = 未选中)。 */
  requirement: Requirement | null;
  /** 该群全部消息(时间线消息卡片数据源 + review_result / spec_published)。 */
  messages: MessageItem[];
  /** 该群成员(真实角色数据源;三层/两层判据)。 */
  members: Member[];
  /** 实时输出缓冲(taskId → 已接收的 WS chunk 拼接),透传给时间线;
   * running 任务折叠态预览最后非空行、展开态显示全量输出。 */
  liveOutputs?: Record<string, string>;
  canControl?: boolean;
  readOnly?: boolean;
  commandSending?: string | null;
  rollbackStates?: Record<string, "rolling" | "done">;
  onStop?: (task: Requirement["tasks"][number]) => void;
  onRollback?: (task: Requirement["tasks"][number]) => void;
};

export { layerModeFromMembers } from "./requirement-layer-state";
/** 需求阶梯的固定三步状态,供左侧需求列表与详情阶梯共用。 */
export function stepStatusesForRequirement(
  requirement: Requirement,
  messages: MessageItem[],
  members: Member[],
): StepStatus[] {
  return deriveRequirementLayerState(requirement, messages, members).steps;
}

/** 层状态徽标配色(done/failed/running/pending 与中性状态均保留可区分样式)。 */
const LAYER_STATUS_LABEL: Record<StepStatus, string> = {
  done: "通过",
  failed: "未通过",
  running: "进行中",
  pending: "未开始",
  "na-declared": "不适用 · 已声明理由",
  "na-fix": "不适用·修复",
  "na-no-reviewer": "未检视·无检视者",
};

/** 长内容折叠阈值/按钮文案:与 RequirementTimeline 同款规则,不另起一套。 */
const LAYER_FOLD_THRESHOLD = 80;

function LayerBadge({
  status,
  children,
}: {
  status: LayerStatus;
  children: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${LAYER_STATUS_CLASS[status]}`}
    >
      <span
        data-testid={`requirement-layer-status-${status}`}
        className="inline-block size-1.5 rounded-full bg-current"
        aria-hidden="true"
      />
      {children}
    </span>
  );
}

function LayerCard({
  testId,
  title,
  status,
  children,
}: {
  testId: string;
  title: string;
  status: LayerStatus;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      className="rounded-xl border bg-card px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">{title}</span>
        <LayerBadge status={status}>{LAYER_STATUS_LABEL[status]}</LayerBadge>
      </div>
      <div className="mt-1.5 space-y-1 text-sm">{children}</div>
    </section>
  );
}

/** 长文本:超过阈值收进「展开/收起」(与时间线折叠同一规则)。 */
function FoldableText({
  testId,
  text,
  expanded,
  onToggle,
}: {
  testId: string;
  text: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const long = text.length > LAYER_FOLD_THRESHOLD;
  return (
    <div>
      <p
        data-testid={testId}
        className="whitespace-pre-wrap break-words text-sm text-muted-foreground"
      >
        {long && !expanded ? `${text.slice(0, LAYER_FOLD_THRESHOLD)}…` : text}
      </p>
      {long && (
        <FoldableContent
          toggleTestId={`${testId}-toggle`}
          detailTestId={`${testId}-detail`}
          textForMeasurement={text}
          expanded={expanded}
          onToggle={onToggle}
        >
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {text}
          </p>
        </FoldableContent>
      )}
    </div>
  );
}

export default function RequirementDetailPanel({
  requirement,
  messages,
  members,
  liveOutputs = {},
  canControl = true,
  readOnly = false,
  commandSending = null,
  rollbackStates = {},
  onStop,
  onRollback,
}: RequirementDetailPanelProps) {
  const [expandedLayers, setExpandedLayers] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleLayer = (key: string) => {
    setExpandedLayers((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

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

  const layerState = deriveRequirementLayerState(
    requirement,
    messages,
    members,
  );
  const { l1, l2, l3 } = layerState;

  // 阶梯固定三步:重试只作为 L1 标签的附属信息,不增加步骤。
  const l1Tasks = executionTasksForRequirement(requirement.tasks);
  const l1Status = l1.status;
  const l2Status = l2.status;
  const retrySuffix =
    requirement.retryCount > 0 ? ` · 重试 ${requirement.retryCount} 次` : "";
  const l1Executor = l1Tasks[0];
  const l1Role = l1Executor
    ? roleFromMemberRoles(
        members.find(
          (member) => member.participantId === l1Executor.executorParticipantId,
        )?.roles,
      )
    : null;
  const l2Role = l2.task
    ? roleFromMemberRoles(
        members.find(
          (member) => member.participantId === l2.task?.executorParticipantId,
        )?.roles,
      )
    : null;
  const stepStatuses = layerState.steps;
  const stepLabels = [
    l1.status === "na-declared"
      ? "L1 不适用 · 已声明理由"
      : `L1 执行${retrySuffix}`,
    "L2 协调",
    l3.status === "na-fix"
      ? "L3 不适用·修复"
      : l3.status === "na-no-reviewer"
        ? "L3 未检视·无检视者"
        : "L3 检视",
  ];
  const stepRoles = [l1Role, l2Role, null];

  return (
    <div
      data-testid="requirement-detail-panel"
      className="flex flex-col gap-2 px-4 py-3"
    >
      <p className="truncate text-sm font-medium">{requirement.label}</p>
      <RequirementStepper
        steps={stepStatuses}
        labels={stepLabels}
        stepRoles={stepRoles}
      />

      {/* L3 检视:review_result 载荷与两个独立的中性缺层状态。 */}
      <LayerCard
        testId="requirement-layer-l3"
        title="L3 检视"
        status={l3.status}
      >
        {l3.status === "na-fix" ? (
          <p
            data-testid="requirement-l3-na-fix"
            className="text-xs text-muted-foreground"
          >
            本票是修复票,按设计不运行 L3 检视(不适用·修复)。
          </p>
        ) : l3.status === "na-no-reviewer" ? (
          <p
            data-testid="requirement-l3-no-reviewer"
            className="text-xs text-muted-foreground"
          >
            检视者与协调者未同时在场,本群按两层模式运行(未检视·无检视者)。
          </p>
        ) : l3.verdict ? (
          <>
            <p className="text-sm">
              {l3.verdict === "pass" ? "检视通过" : "检视发现"}
              {l3.specRef && (
                <span
                  data-testid="requirement-l3-anchor"
                  className="ml-1 font-mono text-xs text-muted-foreground"
                >
                  {l3.specRef}
                  {l3.specHash ? ` @${l3.specHash}` : ""}
                </span>
              )}
            </p>
            {l3.note && (
              <FoldableText
                testId="requirement-l3-note"
                text={l3.note}
                expanded={expandedLayers.has("l3-note")}
                onToggle={() => toggleLayer("l3-note")}
              />
            )}
            {l3.findings && (
              <FoldableText
                testId="requirement-l3-findings"
                text={l3.findings}
                expanded={expandedLayers.has("l3-findings")}
                onToggle={() => toggleLayer("l3-findings")}
              />
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {l3.status === "running"
              ? "L2 已完成,等待检视结论…"
              : "检视尚未开始"}
          </p>
        )}
      </LayerCard>

      {/* L2 协调:状态来自协调任务自身,子任务只参与 L1。 */}
      <LayerCard
        testId="requirement-layer-l2"
        title="L2 协调"
        status={l2Status}
      >
        {l2.task ? (
          <>
            <p className="text-xs text-muted-foreground">
              协调者{" "}
              {members.find(
                (member) =>
                  member.participantId === l2.task?.executorParticipantId,
              )?.name ?? l2.task.executorKey}
            </p>
            {l2.conclusion ? (
              <FoldableText
                testId="requirement-l2-conclusion"
                text={l2.conclusion}
                expanded={expandedLayers.has("l2-conclusion")}
                onToggle={() => toggleLayer("l2-conclusion")}
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                协调任务进行中,尚无 L2 结论
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            该需求还没有协调任务(L2 未开始)
          </p>
        )}
      </LayerCard>

      {/* L1 执行 + 沟通记录:任务汇报卡片与群消息时间线(既有实现)。 */}
      <section
        data-testid="requirement-layer-l1"
        className="flex flex-col gap-2"
      >
        <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          {l1.status === "na-declared"
            ? "L1 不适用 · 已声明理由"
            : "L1 执行与沟通记录"}
          <LayerBadge status={l1Status}>
            {`L1 ${LAYER_STATUS_LABEL[l1Status]}`}
          </LayerBadge>
        </span>
        {l1.noExecutionReason && (
          <FoldableText
            testId="requirement-l1-no-execution-reason"
            text={l1.noExecutionReason}
            expanded={expandedLayers.has("l1-no-execution-reason")}
            onToggle={() => toggleLayer("l1-no-execution-reason")}
          />
        )}
        <RequirementTimeline
          tasks={requirement.tasks}
          messages={messages}
          members={members}
          liveOutputs={liveOutputs}
          canControl={canControl}
          readOnly={readOnly}
          commandSending={commandSending}
          rollbackStates={rollbackStates}
          onStop={onStop}
          onRollback={onRollback}
        />
      </section>
    </div>
  );
}
