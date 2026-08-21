import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";
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

describe("RequirementDetailPanel 需求详情面板 (UI-04b-1)", () => {
  it("requirement 为 null:显示空态提示,不渲染阶梯/时间线", () => {
    render(<RequirementDetailPanel requirement={null} />);
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
    render(<RequirementDetailPanel requirement={requirement} />);
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
});
