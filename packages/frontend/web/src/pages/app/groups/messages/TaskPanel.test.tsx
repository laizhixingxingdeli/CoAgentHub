import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TaskPanel, { type TaskItem } from "./TaskPanel";

function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: "task-1",
    groupId: "group-1",
    messageId: "message-1",
    executorParticipantId: "participant-1",
    executorKey: "codebuddy",
    status: "running",
    checkpointRef: null,
    specRef: null,
    specHash: null,
    diffSummary: null,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: null,
    ...overrides,
  };
}

function renderPanel(task: TaskItem) {
  return render(
    <TaskPanel
      tasks={[task]}
      loading={false}
      error={null}
      commandSending={null}
      canControl={false}
      readOnly={false}
      messages={[]}
      members={[]}
      expandedTaskId={null}
      foldedTaskIds={new Set()}
      stallAlertedIds={new Set()}
      liveOutputs={{}}
      rollbackStates={{}}
      onToggleExpand={() => undefined}
      onStop={() => undefined}
      onRollback={() => undefined}
    />,
  );
}

describe("TaskPanel attempt duration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("running attempt duration updates with the clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T00:00:02.000Z"));
    renderPanel(
      makeTask({
        attempts: [
          {
            n: 1,
            startedAt: "2026-08-23T00:00:00.000Z",
            status: "running",
          },
        ],
      }),
    );

    fireEvent.click(screen.getByTestId("task-expand-task-1"));
    expect(screen.getByText(/耗时 2s/)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText(/耗时 3s/)).toBeInTheDocument();
  });
});
