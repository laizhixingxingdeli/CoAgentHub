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
 *  - 两层模式:reviewer 与 coordinator **同时在场** = 三层,否则两层
 *    (spec v3.9 §3.14.5;不用 v3.8 的「有无 reviewer」旧判据)。两层模式下
 *    L3 显式显示为「不适用」,不静默省略。
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
import {
  deriveBriefTitle,
  type Requirement,
  type StepStatus,
  stepStatusFromTask,
} from "./group-tasks-by-spec";
import RequirementStepper from "./RequirementStepper";
import RequirementTimeline, {
  roleFromMemberRoles,
} from "./RequirementTimeline";

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
};

/** 层状态:阶梯四态之外,两层模式下的 L3 用「不适用」。 */
export type LayerStatus = StepStatus | "na";

/** L2 层状态:协调任务 + L2 结论文本(diffSummary.review_request.diffSummary)。 */
export type L2State = {
  task: Requirement["tasks"][number] | null;
  conclusion: string | null;
};

/** L3 层状态:review_result 载荷 + 显式缺层状态。 */
export type L3State = {
  status: LayerStatus;
  verdict: string | null;
  findings: string | null;
  note: string | null;
  specRef: string | null;
  specHash: string | null;
};

function containsReviewRequest(task: Requirement["tasks"][number]): boolean {
  return JSON.stringify(task.diffSummary ?? {}).includes("review_request");
}

/** diffSummary 是否整体就是 review_request 载荷({type:"review_request",…})。 */
function isReviewRequestPayload(
  diffSummary: Record<string, unknown> | null,
): boolean {
  return (
    typeof diffSummary === "object" &&
    diffSummary !== null &&
    diffSummary.type === "review_request"
  );
}

/** 从 diffSummary 里取 review_request 的结论文本(rr.diffSummary 字段)。 */
function reviewRequestConclusion(
  task: Requirement["tasks"][number] | null,
): string | null {
  if (!task?.diffSummary || typeof task.diffSummary !== "object") {
    return null;
  }
  const payload = isReviewRequestPayload(task.diffSummary)
    ? task.diffSummary
    : task.diffSummary.review_request;
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const conclusion = (payload as Record<string, unknown>).diffSummary;
  return typeof conclusion === "string" && conclusion.trim().length > 0
    ? conclusion
    : null;
}

/** 层判定:reviewer 与 coordinator 同时在场 = 三层,否则两层(v3.9 §3.14.5)。 */
export function layerModeFromMembers(members: Member[]): "three" | "two" {
  const roles = new Set(members.flatMap((member) => member.roles ?? []));
  return roles.has("reviewer") && roles.has("coordinator") ? "three" : "two";
}

/**
 * L2 层:协调任务 = ① 组内是其他任务 parentTaskId 的父(父子归并的根,
 * 可能尚无 review_request,任务状态即 L2 进行度);② 带 review_request
 * 载荷的遗留协调任务(同 specRef 组内,无孩子)。
 */
function deriveL2(requirement: Requirement): L2State {
  const parentIds = new Set(
    requirement.tasks
      .map((task) => task.parentTaskId)
      .filter((id): id is string => Boolean(id)),
  );
  const byParent = requirement.tasks.find((task) => parentIds.has(task.id));
  const byPayload = requirement.tasks.find(
    (task) =>
      containsReviewRequest(task) || isReviewRequestPayload(task.diffSummary),
  );
  const task = byParent ?? byPayload ?? null;
  return { task, conclusion: reviewRequestConclusion(task) };
}

/** 解析一条消息体里的 review_result 载荷(容错:找不到 JSON 就跳过)。 */
function parseReviewResult(body: string): {
  verdict: string;
  findings: string | null;
  note: string | null;
  taskId: string | null;
} | null {
  if (!body.includes("review_result")) {
    return null;
  }
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const payload = JSON.parse(body.slice(start, end + 1)) as {
      type?: string;
      taskId?: string;
      verdict?: string;
      findings?: string;
      note?: string;
    };
    if (payload.type !== "review_result") {
      return null;
    }
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

/** 从消息体解析 spec_published 载荷(规范发布公告,作为需求的规范锚点)。 */
function parseSpecPublished(
  body: string,
): { specRef: string; specHash: string | null } | null {
  if (!body.includes("spec_published")) {
    return null;
  }
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const payload = JSON.parse(body.slice(start, end + 1)) as {
      type?: string;
      specRef?: string;
      specHash?: string;
    };
    if (payload.type !== "spec_published" || !payload.specRef) {
      return null;
    }
    return {
      specRef: payload.specRef,
      specHash: typeof payload.specHash === "string" ? payload.specHash : null,
    };
  } catch {
    return null;
  }
}

/** 需求对应的规范锚点:优先 spec_published 消息(specRef 精确匹配),兜底
 * 需求自身 specRef。spec_published 是发布者(协调者)发出的「本需求按这份
 * 规范执行」公告,比 specRef 字段更权威。 */
function findSpecAnchor(
  requirement: Requirement,
  messages: MessageItem[],
): { specRef: string; specHash: string | null } | null {
  if (requirement.specRef) {
    for (const message of messages) {
      const published = parseSpecPublished(message.body);
      if (published && published.specRef === requirement.specRef) {
        return published;
      }
    }
  }
  return requirement.specRef
    ? { specRef: requirement.specRef, specHash: null }
    : null;
}

/**
 * L3 层:review_result 载荷(v3.9 判据先行)。
 *  - 两层模式 → 「不适用」(显式,不静默省略)。
 *  - 三层模式且有 review_result → verdict pass=通过(done)/其余=未通过(failed)。
 *  - 三层模式尚无结果 → L2 已完成则「进行中」(running),否则「未开始」(pending)。
 */
function deriveL3(
  requirement: Requirement,
  messages: MessageItem[],
  mode: "three" | "two",
  l2: L2State,
): L3State {
  if (mode === "two") {
    return {
      status: "na",
      verdict: null,
      findings: null,
      note: null,
      specRef: null,
      specHash: null,
    };
  }
  const taskIds = new Set(requirement.tasks.map((task) => task.id));
  const anchor = findSpecAnchor(requirement, messages);
  for (const message of messages) {
    const result = parseReviewResult(message.body);
    if (
      result &&
      (!result.taskId || taskIds.has(result.taskId)) &&
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
    status: l2.task?.status === "done" ? "running" : "pending",
    verdict: null,
    findings: null,
    note: null,
    specRef: anchor?.specRef ?? null,
    specHash: anchor?.specHash ?? null,
  };
}

/** 层状态徽标配色(done/failed/running/pending 走 --status-* token;na 用中性灰)。 */
const LAYER_STATUS_CLASS: Record<LayerStatus, string> = {
  done: "border-status-done bg-status-done/10 text-status-done",
  failed: "border-status-failed bg-status-failed/10 text-status-failed",
  running: "border-status-running bg-status-running/10 text-status-running",
  pending: "border-muted-foreground/30 bg-muted/50 text-muted-foreground",
  na: "border-border bg-muted text-muted-foreground",
};

const LAYER_STATUS_LABEL: Record<LayerStatus, string> = {
  done: "通过",
  failed: "未通过",
  running: "进行中",
  pending: "未开始",
  na: "不适用",
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
        <button
          type="button"
          data-testid={`${testId}-toggle`}
          aria-expanded={expanded}
          onClick={onToggle}
          className="mt-1 text-xs font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          {expanded ? "收起" : "展开"}
        </button>
      )}
    </div>
  );
}

export default function RequirementDetailPanel({
  requirement,
  messages,
  members,
  liveOutputs = {},
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

  const mode = layerModeFromMembers(members);
  const l2 = deriveL2(requirement);
  const l3 = deriveL3(requirement, messages, mode, l2);

  // 阶梯:每步 = 一条任务(含协调任务 L2),末尾追加 L3 虚拟格(三层=检视状态,
  // 两层=「不适用」)。与详情区表达同一件事(requirement-three-layer-view R4)。
  const stepLabels = requirement.tasks.map((task) => {
    const executor =
      members.find(
        (member) => member.participantId === task.executorParticipantId,
      )?.name ??
      task.executorKey ??
      "执行者";
    return `${executor} · ${deriveBriefTitle(task.brief) || requirement.label}`;
  });
  const stepRoles = requirement.tasks.map((task) =>
    roleFromMemberRoles(
      members.find(
        (member) => member.participantId === task.executorParticipantId,
      )?.roles,
    ),
  );
  const stepStatuses = requirement.tasks.map((task) =>
    stepStatusFromTask(task.status),
  );
  stepStatuses.push(l3.status === "na" ? "pending" : l3.status);
  stepLabels.push(l3.status === "na" ? "L3 不适用" : "L3 检视");
  stepRoles.push(null);

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

      {/* L3 检视:review_result 载荷;两层模式显式「不适用」。 */}
      <LayerCard
        testId="requirement-layer-l3"
        title="L3 检视"
        status={l3.status}
      >
        {mode === "two" ? (
          <p
            data-testid="requirement-l3-na"
            className="text-xs text-muted-foreground"
          >
            检视者与协调者未同时在场,本群按两层模式运行,L3 不适用。
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

      {/* L2 协调:协调任务的 review_request(L2 结论文本);无协调任务 → 未开始。 */}
      <LayerCard
        testId="requirement-layer-l2"
        title="L2 协调"
        status={l2.task ? stepStatusFromTask(l2.task.status) : "pending"}
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
        <span className="text-xs font-medium text-muted-foreground">
          L1 执行与沟通记录
        </span>
        <RequirementTimeline
          tasks={requirement.tasks}
          messages={messages}
          members={members}
          liveOutputs={liveOutputs}
        />
      </section>
    </div>
  );
}
