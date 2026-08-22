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

function reviewResult(verdict: "pass" | "findings"): MessageItem {
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
      taskId: "l3",
      verdict,
    }),
    contentType: "text/plain",
    fileRef: null,
    depth: 0,
    createdAt: "2026-08-01T12:00:00.000Z",
  };
}

describe("RequirementDetailPanel 需求详情面板 (UI-04b-1)", () => {
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

  it("有需求:顶部阶梯 + 下方时间线,阶梯步数与任务数一致", () => {
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
    expect(screen.getByTestId("requirement-stepper-step-0")).toHaveAttribute(
      "data-status",
      "done",
    );
    // running 任务 → running 步骤(呼吸环),不再归进 pending。
    expect(screen.getByTestId("requirement-stepper-step-1")).toHaveAttribute(
      "data-status",
      "running",
    );
    expect(screen.getByTestId("requirement-timeline")).toBeInTheDocument();
    expect(
      screen.getByTestId("requirement-timeline-item-t-1"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("requirement-timeline-item-t-2"),
    ).toBeInTheDocument();
    expect(screen.getByText("第一步做完了")).toBeInTheDocument();
  });

  it("三层模式追加 L3 虚拟格,并随 detached 任务/检视结论变化", () => {
    const base = groupTasksBySpec([
      makeTask({ id: "l2", executorParticipantId: "participant-1" }),
      makeTask({
        id: "l3",
        executorParticipantId: COORDINATOR.participantId,
        status: "queued",
        diffSummary: { review_request: { type: "review_request", layer: 3 } },
        createdAt: "2026-08-01T11:00:00.000Z",
      }),
    ])[0];
    const { rerender } = render(
      <RequirementDetailPanel
        requirement={base}
        messages={[]}
        members={[COORDINATOR, REVIEWER]}
      />,
    );
    expect(screen.getByText("L3 检视")).toBeInTheDocument();
    expect(screen.getByTestId("requirement-stepper-step-1")).toHaveAttribute(
      "data-status",
      "pending",
    );

    const running = {
      ...base,
      tasks: base.tasks.map((task) =>
        task.id === "l3" ? { ...task, status: "done" as const } : task,
      ),
    };
    rerender(
      <RequirementDetailPanel
        requirement={running}
        messages={[]}
        members={[COORDINATOR, REVIEWER]}
      />,
    );
    expect(screen.getByTestId("requirement-stepper-step-1")).toHaveAttribute(
      "data-status",
      "running",
    );

    rerender(
      <RequirementDetailPanel
        requirement={running}
        messages={[reviewResult("findings")]}
        members={[COORDINATOR, REVIEWER]}
      />,
    );
    expect(screen.getByTestId("requirement-stepper-step-1")).toHaveAttribute(
      "data-status",
      "failed",
    );
  });

  it("两层模式不渲染 L3 虚拟格", () => {
    const [requirement] = groupTasksBySpec([
      makeTask({
        id: "l3",
        executorParticipantId: COORDINATOR.participantId,
        diffSummary: { review_request: { type: "review_request", layer: 3 } },
      }),
    ]);
    render(
      <RequirementDetailPanel
        requirement={requirement}
        messages={[]}
        members={[COORDINATOR]}
      />,
    );
    expect(screen.queryByText("L3 检视")).not.toBeInTheDocument();
  });
});
