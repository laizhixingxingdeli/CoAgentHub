import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";
import type { Member, MessageItem } from "@/pages/app/groups/messages/types";
import { groupTasksBySpec } from "./group-tasks-by-spec";
import RequirementDetailPanel from "./RequirementDetailPanel";

function makeTask(overrides: Partial<TaskItem> & { id: string }): TaskItem {
  return {
    groupId: "group-1",
    messageId: "msg-1",
    executorParticipantId: "participant-1",
    executorKey: "codebuddy",
    status: "done",
    checkpointRef: null,
    specRef: "specs/ui-04b.md",
    specHash: null,
    diffSummary: null,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

const REVIEWER: Member = {
  participantId: "participant-reviewer",
  name: "检视者",
  device: null,
  roles: ["reviewer"],
};
const COORDINATOR: Member = {
  participantId: "participant-coordinator",
  name: "协调者",
  device: null,
  roles: ["coordinator"],
};

function coordinationTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return makeTask({
    id: "l2",
    executorParticipantId: COORDINATOR.participantId,
    status: "done",
    brief: "协调请求(检视者 → 协调者)· 第 X 批",
    diffSummary: {
      review_request: {
        type: "review_request",
        layer: 3,
        specRef: "specs/ui-04b.md",
        specHash: "abc1234",
        diffSummary: "L2 通过:单聚焦提交,受影响测试全绿。",
      },
    },
    ...overrides,
  });
}

function executionTask(
  overrides: Partial<TaskItem> & { id: string },
): TaskItem {
  return makeTask({
    status: "done",
    brief: "# CoAgentHub Task\n\n## Goal\n实现三层链条展示。",
    diffSummary: {
      summary: "L1 完成,测试全绿。",
      tests: "1/1 passed",
      hash: "0123456789abcdef",
      tokenUsage: "123",
      claimVerification: { status: "verified", hash: "0123456789abcdef" },
    },
    ...overrides,
  });
}

function reviewResult(
  verdict: "pass" | "findings",
  note?: string,
  findings?: string,
): MessageItem {
  return {
    id: `review-${verdict}`,
    groupId: "group-1",
    senderId: REVIEWER.participantId,
    parentId: null,
    audience: "broadcast",
    audienceRef: null,
    body: JSON.stringify({
      type: "review_result",
      layer: 3,
      taskId: "l2",
      specRef: "specs/ui-04b.md",
      specHash: "abc1234",
      verdict,
      note,
      findings,
    }),
    contentType: "text/plain",
    fileRef: null,
    depth: 0,
    createdAt: "2026-08-01T12:00:00.000Z",
  };
}

function specPublished(): MessageItem {
  return {
    id: "spec-pub",
    groupId: "group-1",
    senderId: COORDINATOR.participantId,
    parentId: null,
    audience: "broadcast",
    audienceRef: null,
    body: JSON.stringify({
      type: "spec_published",
      specRef: "specs/ui-04b.md",
      specHash: "abc1234",
      summary: "规范发布",
    }),
    contentType: "application/json",
    fileRef: null,
    depth: 0,
    createdAt: "2026-08-01T08:00:00.000Z",
  };
}

describe("RequirementDetailPanel 需求详情面板 (UI-04b-1 + requirement-three-layer-view)", () => {
  it("requirement 为 null:显示空态提示,不渲染阶梯/时间线", () => {
    render(
      <RequirementDetailPanel requirement={null} messages={[]} members={[]} />,
    );
    expect(screen.getByTestId("requirement-detail-empty")).toHaveTextContent(
      "选择左侧一个需求查看详情",
    );
    expect(screen.queryByTestId("requirement-stepper")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("requirement-timeline"),
    ).not.toBeInTheDocument();
  });

  it("有需求:顶部阶梯固定三步 + 下方时间线", () => {
    const [requirement] = groupTasksBySpec([
      makeTask({
        id: "t-1",
        status: "done",
        createdAt: "2026-08-01T09:00:00.000Z",
        diffSummary: { summary: "第一步做完了" },
      }),
      makeTask({
        id: "t-2",
        status: "running",
        createdAt: "2026-08-01T11:00:00.000Z",
        diffSummary: null,
      }),
    ]);
    render(
      <RequirementDetailPanel
        requirement={requirement}
        messages={[]}
        members={[]}
      />,
    );
    expect(screen.getByTestId("requirement-detail-panel")).toBeInTheDocument();
    // 标题取 Requirement.label(specRef 文件名去扩展名)。
    expect(screen.getByText("ui-04b")).toBeInTheDocument();
    expect(screen.getByTestId("requirement-stepper")).toBeInTheDocument();
    // L1 聚合为 running;L2/L3 各占一个固定位置。
    expect(screen.getByTestId("requirement-stepper-step-0")).toHaveAttribute(
      "data-status",
      "running",
    );
    expect(screen.getByTestId("requirement-stepper-step-1")).toHaveAttribute(
      "data-status",
      "pending",
    );
    expect(screen.getByTestId("requirement-stepper-step-2")).toHaveAttribute(
      "data-status",
      "na-no-reviewer",
    );
    expect(screen.getAllByTestId(/requirement-stepper-step-/)).toHaveLength(3);
    // null dispatchKind 按 requirement 处理;两角色未同时在场时是可行动的未检视。
    expect(screen.getByText("L3 未检视·无检视者")).toBeInTheDocument();
    expect(
      screen.getByTestId("requirement-l3-no-reviewer"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("requirement-timeline")).toBeInTheDocument();
    expect(
      screen.getByTestId("requirement-timeline-item-t-1"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("requirement-timeline-item-t-2"),
    ).toBeInTheDocument();
    expect(screen.getByText("第一步做完了")).toBeInTheDocument();
  });

  it("三层齐全:L3/L2/L1 三层卡片 + 阶梯含协调任务与 L3 虚拟格", () => {
    // 协调任务 + 执行任务(经 groupTasksBySpec 归并为一条需求)。
    const [requirement] = groupTasksBySpec([
      coordinationTask({ createdAt: "2026-08-01T09:00:00.000Z" }),
      executionTask({
        id: "exec-1",
        parentTaskId: "l2",
        createdAt: "2026-08-01T10:00:00.000Z",
      }),
    ]);
    render(
      <RequirementDetailPanel
        requirement={requirement}
        messages={[specPublished(), reviewResult("pass", "架构无问题")]}
        members={[COORDINATOR, REVIEWER]}
      />,
    );
    // L3 层:review_result 载荷可见。
    expect(screen.getByTestId("requirement-layer-l3")).toBeInTheDocument();
    expect(screen.getByText("检视通过")).toBeInTheDocument();
    expect(screen.getByTestId("requirement-l3-anchor")).toHaveTextContent(
      "specs/ui-04b.md @abc1234",
    );
    expect(screen.getByTestId("requirement-l3-note")).toHaveTextContent(
      "架构无问题",
    );
    // L2 层:协调任务结论可见。
    expect(screen.getByTestId("requirement-layer-l2")).toBeInTheDocument();
    expect(screen.getByTestId("requirement-l2-conclusion")).toHaveTextContent(
      "L2 通过:单聚焦提交,受影响测试全绿。",
    );
    // L1 层:执行任务汇报 + claimVerification 可见。
    expect(screen.getByTestId("requirement-layer-l1")).toBeInTheDocument();
    expect(
      screen.getByTestId("requirement-timeline-claim-exec-1"),
    ).toHaveAttribute("data-status", "verified");
    // 阶梯固定为 L1 执行 + L2 协调 + L3 检视,末尾通过。
    expect(screen.getByTestId("requirement-stepper-step-0")).toHaveAttribute(
      "data-status",
      "done",
    );
    expect(screen.getByTestId("requirement-stepper-step-1")).toHaveAttribute(
      "data-status",
      "done",
    );
    expect(screen.getByTestId("requirement-stepper-step-2")).toHaveAttribute(
      "data-status",
      "done",
    );
    // 「L3 检视」出现两处:阶梯末尾虚拟格标签 + L3 层卡片标题。
    expect(screen.getAllByText("L3 检视")).toHaveLength(2);
  });

  it("三层模式无 review_result:L3 显式「未开始」/ L2 完成时「进行中」", () => {
    const [requirement] = groupTasksBySpec([
      coordinationTask({ createdAt: "2026-08-01T09:00:00.000Z" }),
    ]);
    const { rerender } = render(
      <RequirementDetailPanel
        requirement={requirement}
        messages={[specPublished()]}
        members={[COORDINATOR, REVIEWER]}
      />,
    );
    // L2 已完成但无检视结论 → L3 进行中(不是装作没有)。
    expect(screen.getByText("L2 已完成,等待检视结论…")).toBeInTheDocument();
    expect(screen.getByTestId("requirement-layer-l3")).toHaveTextContent(
      "进行中",
    );

    // L2 未完成(queued)→ L3 未开始。
    const [pending] = groupTasksBySpec([
      coordinationTask({
        status: "queued",
        createdAt: "2026-08-01T09:00:00.000Z",
      }),
    ]);
    rerender(
      <RequirementDetailPanel
        requirement={pending}
        messages={[specPublished()]}
        members={[COORDINATOR, REVIEWER]}
      />,
    );
    expect(screen.getByText("检视尚未开始")).toBeInTheDocument();
    expect(screen.getByTestId("requirement-layer-l3")).toHaveTextContent(
      "未开始",
    );
  });

  it("协调任务声明 noExecutionReason 时,L1 为不适用且理由与阶梯状态同源", () => {
    const reason =
      "上一轮执行任务已完成完整实现并留下暂存成果,本票仅做 L2 核对。";
    const [requirement] = groupTasksBySpec([
      coordinationTask({
        diffSummary: { noExecutionReason: reason },
        createdAt: "2026-08-01T09:00:00.000Z",
      }),
    ]);
    render(
      <RequirementDetailPanel
        requirement={requirement}
        messages={[]}
        members={[COORDINATOR, REVIEWER]}
      />,
    );

    expect(screen.getByTestId("requirement-layer-l1")).toHaveTextContent(
      "L1 不适用 · 已声明理由",
    );
    expect(
      screen.getByTestId("requirement-l1-no-execution-reason"),
    ).toHaveTextContent(reason);
    expect(
      screen.getByTestId("requirement-layer-status-na-declared"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("requirement-stepper-step-0")).toHaveAttribute(
      "data-status",
      "na-declared",
    );
    expect(screen.getByTestId("requirement-stepper-step-1")).toHaveAttribute(
      "data-status",
      "done",
    );
  });

  it("真实协调载荷同时含 review_request 与 noExecutionReason 时命中 L1/L2", () => {
    const reason = "本票由发布者直接定向 codex 完成实现,未创建下游执行子任务。";
    const [requirement] = groupTasksBySpec([
      coordinationTask({
        id: "project-onboarding-coordination",
        specRef: "specs/project-onboarding-interactive.md",
        diffSummary: {
          review_request: {
            type: "review_request",
            layer: 3,
            taskId: "project-onboarding-coordination",
            specRef: "specs/project-onboarding-interactive.md",
            specHash: "0b03bd37",
            diffSummary: "L2 功能验收通过。",
          },
          noExecutionReason: reason,
        },
      }),
    ]);

    render(
      <RequirementDetailPanel
        requirement={requirement}
        messages={[]}
        members={[]}
      />,
    );

    expect(screen.getByTestId("requirement-stepper-step-0")).toHaveAttribute(
      "data-status",
      "na-declared",
    );
    expect(screen.getByTestId("requirement-stepper-step-1")).toHaveAttribute(
      "data-status",
      "done",
    );
    expect(
      screen.getByTestId("requirement-l1-no-execution-reason"),
    ).toHaveTextContent(reason);
    expect(screen.getByTestId("requirement-layer-l2")).not.toHaveTextContent(
      "该需求还没有协调任务(L2 未开始)",
    );
    expect(screen.getByTestId("requirement-l2-conclusion")).toHaveTextContent(
      "L2 功能验收通过。",
    );
  });

  it("零子任务但没有 noExecutionReason 的历史协调任务仍是 L1 未开始", () => {
    const [requirement] = groupTasksBySpec([
      coordinationTask({ createdAt: "2026-08-01T09:00:00.000Z" }),
    ]);
    render(
      <RequirementDetailPanel
        requirement={requirement}
        messages={[]}
        members={[COORDINATOR, REVIEWER]}
      />,
    );
    expect(screen.getByTestId("requirement-stepper-step-0")).toHaveAttribute(
      "data-status",
      "pending",
    );
    expect(screen.getByTestId("requirement-layer-l1")).toHaveTextContent(
      "L1 未开始",
    );
  });

  it("三层模式 review_result=findings:L3 未通过 + findings 载荷可见", () => {
    const [requirement] = groupTasksBySpec([
      coordinationTask({ createdAt: "2026-08-01T09:00:00.000Z" }),
    ]);
    render(
      <RequirementDetailPanel
        requirement={requirement}
        messages={[reviewResult("findings", undefined, "L2 打回,需重做")]}
        members={[COORDINATOR, REVIEWER]}
      />,
    );
    expect(screen.getByText("检视发现")).toBeInTheDocument();
    expect(screen.getByTestId("requirement-layer-l3")).toHaveTextContent(
      "未通过",
    );
    expect(screen.getByTestId("requirement-l3-findings")).toHaveTextContent(
      "L2 打回,需重做",
    );
  });

  it("两层模式(无 reviewer):L3 显式「未检视·无检视者」,不渲染检视载荷", () => {
    const [requirement] = groupTasksBySpec([
      coordinationTask({ createdAt: "2026-08-01T09:00:00.000Z" }),
      executionTask({
        id: "exec-1",
        parentTaskId: "l2",
        createdAt: "2026-08-01T10:00:00.000Z",
      }),
    ]);
    render(
      <RequirementDetailPanel
        requirement={requirement}
        messages={[specPublished(), reviewResult("pass")]}
        members={[COORDINATOR]}
      />,
    );
    // v3.9 判据:只有 coordinator 没有 reviewer → 未检视·无检视者。
    expect(
      screen.getByTestId("requirement-l3-no-reviewer"),
    ).toBeInTheDocument();
    expect(screen.getByText("L3 未检视·无检视者")).toBeInTheDocument();
    expect(screen.queryByText("检视通过")).not.toBeInTheDocument();
    // L2 / L1 仍正常呈现。
    expect(screen.getByTestId("requirement-layer-l2")).toBeInTheDocument();
    expect(screen.getByTestId("requirement-layer-l1")).toBeInTheDocument();
  });

  it("只有 reviewer 没有 coordinator 也属于未检视·无检视者", () => {
    const [requirement] = groupTasksBySpec([
      coordinationTask({ createdAt: "2026-08-01T09:00:00.000Z" }),
    ]);
    render(
      <RequirementDetailPanel
        requirement={requirement}
        messages={[]}
        members={[REVIEWER]}
      />,
    );
    expect(
      screen.getByTestId("requirement-l3-no-reviewer"),
    ).toBeInTheDocument();
    expect(screen.getByText("L3 未检视·无检视者")).toBeInTheDocument();
  });

  it("修复票的 L3 与无检视者状态分开呈现", () => {
    const [requirement] = groupTasksBySpec([
      coordinationTask({
        dispatchKind: "fix",
        createdAt: "2026-08-01T09:00:00.000Z",
      }),
      executionTask({
        id: "exec-fix",
        dispatchKind: "fix",
        parentTaskId: "l2",
        createdAt: "2026-08-01T10:00:00.000Z",
      }),
    ]);
    render(
      <RequirementDetailPanel
        requirement={requirement}
        messages={[]}
        members={[COORDINATOR]}
      />,
    );
    expect(screen.getByTestId("requirement-l3-na-fix")).toBeInTheDocument();
    expect(screen.getByText("L3 不适用·修复")).toBeInTheDocument();
    expect(
      screen.queryByTestId("requirement-l3-no-reviewer"),
    ).not.toBeInTheDocument();
  });

  it("缺 L2(无协调任务):L2 层显式「未开始」", () => {
    const [requirement] = groupTasksBySpec([
      makeTask({
        id: "solo",
        createdAt: "2026-08-01T09:00:00.000Z",
        diffSummary: { summary: "历史任务" },
      }),
    ]);
    render(
      <RequirementDetailPanel
        requirement={requirement}
        messages={[]}
        members={[COORDINATOR, REVIEWER]}
      />,
    );
    expect(
      screen.getByText("该需求还没有协调任务(L2 未开始)"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("requirement-layer-l2")).toHaveTextContent(
      "未开始",
    );
  });

  it("claimVerification 缺失时 L1 不渲染核实行", () => {
    const [requirement] = groupTasksBySpec([
      makeTask({
        id: "no-claim",
        createdAt: "2026-08-01T09:00:00.000Z",
        diffSummary: { summary: "无核实字段" },
      }),
    ]);
    render(
      <RequirementDetailPanel
        requirement={requirement}
        messages={[]}
        members={[]}
      />,
    );
    expect(
      screen.queryByTestId("requirement-timeline-claim-no-claim"),
    ).not.toBeInTheDocument();
  });
});
