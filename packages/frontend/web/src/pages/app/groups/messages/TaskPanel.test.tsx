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

describe("TaskPanel liveness meta (R1/R4)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("running 任务行显示已运行时长与最近活动", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T00:10:00.000Z"));
    render(
      <TaskPanel
        tasks={[
          makeTask({
            createdAt: "2026-08-23T00:00:00.000Z",
            liveness: {
              warning: false,
              lastSignalAt: "2026-08-23T00:07:00.000Z",
            },
          }),
        ]}
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
    expect(screen.getByTestId("task-running-duration-task-1")).toHaveTextContent(
      "已运行",
    );
    expect(screen.getByTestId("task-last-activity-task-1")).toHaveTextContent(
      "最近活动",
    );
    expect(screen.getByTestId("task-last-activity-task-1")).toHaveTextContent(
      "3 分钟前",
    );
  });

  it("拉取失败与无输出可区分", () => {
    render(
      <TaskPanel
        tasks={[makeTask()]}
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
        liveOutputFetchError="拉取实时输出失败: 500"
        rollbackStates={{}}
        onToggleExpand={() => undefined}
        onStop={() => undefined}
        onRollback={() => undefined}
      />,
    );
    expect(screen.getByTestId("task-output-error-task-1")).toHaveTextContent(
      "拉取实时输出失败",
    );
    expect(screen.queryByText("暂无输出")).not.toBeInTheDocument();
  });
});

