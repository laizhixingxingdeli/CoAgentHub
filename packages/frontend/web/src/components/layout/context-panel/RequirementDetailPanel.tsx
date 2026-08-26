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

import { ChevronDown, ChevronUp } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useLiveNow } from "@/pages/app/groups/messages/lib";
import type { Member, MessageItem } from "@/pages/app/groups/messages/types";
import {
  coordinationTasksForRequirement,
  executionTasksForRequirement,
  type Requirement,
  type StepStatus,
} from "./group-tasks-by-spec";
import {
  mergeRequirementTimeline,
  partitionRequirementTimeline,
} from "./merge-requirement-timeline";
import RequirementStepper from "./RequirementStepper";
import RequirementTimeline, {
  roleFromMemberRoles,
} from "./RequirementTimeline";
import {
  deriveRequirementLayerState,
  type RequirementLayerState,
} from "./requirement-layer-state";
import { LAYER_STATUS_CLASS } from "./status-classes";

export type LayerStatus = StepStatus;

type RequirementDetailPanelProps = {
  /** 当前选中的需求(null = 未选中)。 */
  requirement: Requirement | null;
  /** 工作区为列表与详情共享的单次派生结果。 */
  layerState?: RequirementLayerState | null;
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
  summary,
  expanded,
  onToggle,
  children,
}: {
  testId: string;
  title: string;
  status: LayerStatus;
  summary: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      className="rounded-xl border bg-card px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-xs font-medium">{title}</span>
        <LayerBadge status={status}>{LAYER_STATUS_LABEL[status]}</LayerBadge>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {summary}
        </span>
        <button
          type="button"
          data-testid={`${testId}-toggle`}
          aria-expanded={expanded}
          aria-controls={`${testId}-content`}
          onClick={onToggle}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? (
            <ChevronUp className="size-4" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-4" aria-hidden="true" />
          )}
          <span>{expanded ? "收起" : "展开"}</span>
        </button>
      </div>
      {expanded && (
        <div
          id={`${testId}-content`}
          data-testid={`${testId}-content`}
          className="mt-1.5 space-y-1 text-sm"
        >
          {children}
        </div>
      )}
    </section>
  );
}

export default function RequirementDetailPanel({
  requirement,
  layerState: providedLayerState = null,
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
  const [hasExplicitLayerState, setHasExplicitLayerState] = useState(false);
  const [expandedRequirementId, setExpandedRequirementId] = useState<
    string | null
  >(null);
  const now = useLiveNow(
    Boolean(
      requirement?.tasks.some(
        (task) => task.l3?.answered === false && task.l3.awaitingSince,
      ),
    ),
  );

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

  const layerState =
    providedLayerState ??
    deriveRequirementLayerState(requirement, messages, members);
  const { l1, l2, l3 } = layerState;

  // 阶梯固定三步:重试只作为 L1 标签的附属信息,不增加步骤。
  const l1Tasks = executionTasksForRequirement(requirement.tasks, members);
  const coordinationTaskIds = new Set(
    coordinationTasksForRequirement(requirement.tasks, members).map(
      (task) => task.id,
    ),
  );
  const mergedTimeline = mergeRequirementTimeline(
    requirement.tasks,
    messages,
    members,
  );
  const timelineLayers = partitionRequirementTimeline(
    mergedTimeline,
    new Set(l1Tasks.map((task) => task.id)),
    coordinationTaskIds,
  );
  const explicitStateActive =
    hasExplicitLayerState && expandedRequirementId === requirement.id;
  const defaultExpanded = (status: LayerStatus) => status !== "done";
  const isLayerExpanded = (key: string, status: LayerStatus) =>
    explicitStateActive ? expandedLayers.has(key) : defaultExpanded(status);
  const toggleLayer = (key: string) => {
    setExpandedRequirementId(requirement.id);
    setHasExplicitLayerState(true);
    setExpandedLayers((prev) => {
      const next = new Set(
        explicitStateActive
          ? prev
          : (["l1", "l2", "l3"] as const).filter((layer) =>
              defaultExpanded(
                layer === "l1"
                  ? l1.status
                  : layer === "l2"
                    ? l2.status
                    : l3.status,
              ),
            ),
      );
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };
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
  const firstLine = (text: string | null) => {
    if (!text) return "";
    const line =
      text
        .split(/\r?\n/)
        .find((part) => part.trim())
        ?.trim() ?? "";
    return line.length > 72 ? `${line.slice(0, 72)}…` : line;
  };
  const l3Summary = l3.verdict
    ? l3.findings
      ? firstLine(l3.findings)
      : firstLine(l3.note) || "检视通过"
    : l3.status === "na-fix"
      ? "修复票不运行 L3"
      : l3.status === "na-no-reviewer"
        ? "本群未同时配置检视者与协调者"
        : l3.status === "running"
          ? "等待检视结论"
          : "检视尚未开始";
  const l2Summary = l2.conclusion
    ? firstLine(l2.conclusion)
    : l2.task
      ? "协调任务暂无结论"
      : "该需求还没有协调任务";
  const firstTaskSummary = l1Tasks
    .map((task) => task.diffSummary?.summary)
    .find((summary): summary is string => typeof summary === "string");
  const l1Summary =
    l1.childCount > 0
      ? `${l1.childCount} 次执行${l1.supersededCount > 0 ? ` · 换过 ${l1.supersededCount} 次执行器` : ""}${firstTaskSummary ? ` · ${firstLine(firstTaskSummary)}` : ""}`
      : l1.noExecutionReason
        ? firstLine(l1.noExecutionReason)
        : "暂无执行记录";
  const waitingMinutes = l3.awaitingSince
    ? Math.max(0, Math.floor((now - Date.parse(l3.awaitingSince)) / 60_000))
    : 0;
  const waitingHours = Math.max(1, Math.floor(waitingMinutes / 60));
  const l3WaitingSummary =
    l3.answered === false && l3.awaitingSince
      ? l3.overdue
        ? `等待检视超时 · 已等待 ${waitingHours} 小时`
        : `等待检视 · 已等待 ${waitingMinutes} 分钟`
      : null;
  const l3Expanded = isLayerExpanded("l3", l3.status);
  const l2Expanded = isLayerExpanded("l2", l2.status);
  const l1Expanded = isLayerExpanded("l1", l1.status);

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
        summary={
          <>
            {l3WaitingSummary ? (
              <span
                data-testid="requirement-l3-waiting"
                className={
                  l3.overdue
                    ? "font-medium text-status-unconfirmed"
                    : "text-muted-foreground"
                }
              >
                {l3WaitingSummary}
              </span>
            ) : (
              <>
                {l3.verdict === "pass" && "检视通过"}
                {l3.verdict === "findings" && <span>检视发现</span>}
              </>
            )}
            {!l3WaitingSummary && l3.verdict && (l3.findings || l3.note) && (
              <span className="ml-1">
                {l3.findings ? (
                  <span
                    data-testid={
                      !l3Expanded ? "requirement-l3-findings" : undefined
                    }
                  >
                    {l3Summary}
                  </span>
                ) : (
                  <span
                    data-testid={
                      !l3Expanded ? "requirement-l3-note" : undefined
                    }
                  >
                    {l3Summary}
                  </span>
                )}
              </span>
            )}
            {!l3WaitingSummary && !l3.verdict && l3Summary}
            {l3.specRef && (
              <span
                data-testid="requirement-l3-anchor"
                className="ml-1 font-mono text-[10px]"
              >
                {l3.specRef}
                {l3.specHash ? ` @${l3.specHash}` : ""}
              </span>
            )}
          </>
        }
        expanded={l3Expanded}
        onToggle={() => toggleLayer("l3")}
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
        ) : (
          <>
            {l3.verdict && (l3.note || l3.findings) && (
              <div className="max-h-[60vh] space-y-1 overflow-y-auto border-b pb-1.5">
                {l3.note && (
                  <p
                    data-testid={l3Expanded ? "requirement-l3-note" : undefined}
                    className="whitespace-pre-wrap break-words text-sm text-muted-foreground"
                  >
                    {l3.note}
                  </p>
                )}
                {l3.findings && (
                  <p
                    data-testid={
                      l3Expanded ? "requirement-l3-findings" : undefined
                    }
                    className="whitespace-pre-wrap break-words text-sm text-muted-foreground"
                  >
                    {l3.findings}
                  </p>
                )}
              </div>
            )}
            {!l3.verdict && l3.status === "running" && (
              <p className="text-xs text-muted-foreground">
                L2 已完成,等待检视结论…
              </p>
            )}
            <RequirementTimeline
              tasks={[]}
              events={timelineLayers.l3}
              members={members}
            />
          </>
        )}
      </LayerCard>

      {/* L2 协调:状态来自协调任务自身,子任务只参与 L1。 */}
      <LayerCard
        testId="requirement-layer-l2"
        title="L2 协调"
        status={l2Status}
        summary={
          l2.conclusion ? (
            <span data-testid="requirement-l2-conclusion">{l2Summary}</span>
          ) : (
            l2Summary
          )
        }
        expanded={l2Expanded}
        onToggle={() => toggleLayer("l2")}
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
            {!l2.conclusion && (
              <p className="text-xs text-muted-foreground">
                协调任务进行中,尚无 L2 结论
              </p>
            )}
            <RequirementTimeline
              tasks={[]}
              events={timelineLayers.l2}
              members={members}
            />
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            该需求还没有协调任务(L2 未开始)
          </p>
        )}
      </LayerCard>

      {/* L1 执行 + 沟通记录:任务汇报卡片与群消息时间线(既有实现)。 */}
      <LayerCard
        testId="requirement-layer-l1"
        title={
          l1.status === "na-declared"
            ? "L1 不适用 · 已声明理由"
            : l1.status === "pending" && l1Tasks.length === 0
              ? "L1 未开始"
              : "L1 执行"
        }
        status={l1Status}
        summary={l1Summary}
        expanded={l1Expanded}
        onToggle={() => toggleLayer("l1")}
      >
        {l1.noExecutionReason && (
          <div className="max-h-[60vh] overflow-y-auto">
            <p
              data-testid="requirement-l1-no-execution-reason"
              className="whitespace-pre-wrap break-words text-sm text-muted-foreground"
            >
              {l1.noExecutionReason}
            </p>
          </div>
        )}
        <RequirementTimeline
          tasks={l1Tasks}
          members={members}
          events={timelineLayers.l1}
          liveOutputs={liveOutputs}
          canControl={canControl}
          readOnly={readOnly}
          commandSending={commandSending}
          rollbackStates={rollbackStates}
          onStop={onStop}
          onRollback={onRollback}
        />
      </LayerCard>
    </div>
  );
}
