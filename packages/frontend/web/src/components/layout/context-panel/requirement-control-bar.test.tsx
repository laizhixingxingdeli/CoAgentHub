import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";
import { groupTasksBySpec } from "./group-tasks-by-spec";
import { RequirementControlBar } from "./requirement-control-bar";

function makeTask(overrides: Partial<TaskItem> & { id: string }): TaskItem {
  return {
    groupId: "group-1",
    messageId: "msg-1",
    executorParticipantId: "participant-1",
    executorKey: "codex",
    status: "running",
    checkpointRef: null,
    specRef: "specs/title-readability.md",
    specHash: null,
    diffSummary: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("RequirementControlBar", () => {
  it("保留控制区标识，但不重复详情标题", () => {
    const [requirement] = groupTasksBySpec([
      makeTask({
        id: "task-1",
        brief: "# 修复任务标题可读性",
      }),
    ]);
    render(
      <RequirementControlBar
        requirement={requirement}
        canControl
        readOnly={false}
        commandSending={null}
        rollbackStates={{}}
        onStop={vi.fn()}
        onRollback={vi.fn()}
      />,
    );

    expect(screen.getByTestId("requirement-control-bar")).toHaveTextContent(
      "控制",
    );
    expect(
      screen.queryByText("修复任务标题可读性 · 控制"),
    ).not.toBeInTheDocument();
  });
});
