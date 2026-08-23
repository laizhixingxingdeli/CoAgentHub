import { describe, expect, it } from "vitest";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";
import { groupTasksBySpec } from "./group-tasks-by-spec";
import { mergeTaskStatusChanged } from "./merge-task-status";

function makeTask(overrides: Partial<TaskItem> & { id: string }): TaskItem {
  return {
    groupId: "group-1",
    messageId: "message-1",
    executorParticipantId: "participant-1",
    executorKey: "codex",
    status: "queued",
    checkpointRef: null,
    specRef: "specs/live.md",
    specHash: null,
    diffSummary: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: null,
    ...overrides,
  };
}

function event(
  task: Partial<TaskItem> & { id: string },
  status: TaskItem["status"] = "running",
) {
  return {
    type: "task_status_changed" as const,
    groupId: "group-1",
    taskId: task.id,
    status,
    task: {
      id: task.id,
      status,
      executorParticipantId: task.executorParticipantId ?? "participant-1",
      executorKey: task.executorKey ?? "codex",
      brief: task.brief ?? null,
      diffSummary: task.diffSummary ?? null,
      specRef: task.specRef ?? null,
      specHash: task.specHash ?? null,
      createdAt: task.createdAt ?? "2026-08-01T00:00:00.000Z",
      updatedAt: task.updatedAt ?? null,
      retryCount: 0,
      messageId: task.messageId,
      checkpointRef: task.checkpointRef,
      parentTaskId: task.parentTaskId,
    },
  };
}

describe("mergeTaskStatusChanged", () => {
  it("appends a new task and de-dupes repeated events by taskId", () => {
    const initial = [makeTask({ id: "old" })];
    const update = event(
      makeTask({
        id: "new",
        createdAt: "2026-08-01T01:00:00.000Z",
      }),
    );

    const once = mergeTaskStatusChanged(initial, update);
    const twice = mergeTaskStatusChanged(once, update);

    expect(twice.map((task) => task.id)).toEqual(["old", "new"]);
    expect(twice).toHaveLength(2);
  });

  it("updates an existing task without changing its collection position", () => {
    const initial = [
      makeTask({ id: "first" }),
      makeTask({ id: "second", createdAt: "2026-08-01T01:00:00.000Z" }),
    ];
    const updated = event(
      makeTask({
        id: "first",
        updatedAt: "2026-08-01T02:00:00.000Z",
      }),
      "done",
    );

    const result = mergeTaskStatusChanged(initial, updated);

    expect(result.map((task) => task.id)).toEqual(["first", "second"]);
    expect(result[0].status).toBe("done");
    expect(result[0].updatedAt).toBe("2026-08-01T02:00:00.000Z");
  });

  it("leaves grouping order to groupTasksBySpec after an incremental merge", () => {
    const initial = [
      makeTask({
        id: "late",
        specRef: "specs/late.md",
        createdAt: "2026-08-01T03:00:00.000Z",
      }),
      makeTask({
        id: "early",
        specRef: "specs/early.md",
        createdAt: "2026-08-01T01:00:00.000Z",
      }),
    ];
    const merged = mergeTaskStatusChanged(
      initial,
      event(
        makeTask({
          id: "middle",
          specRef: "specs/middle.md",
          createdAt: "2026-08-01T02:00:00.000Z",
        }),
      ),
    );

    expect(
      groupTasksBySpec(merged).map((requirement) => requirement.id),
    ).toEqual(["specs/early.md", "specs/middle.md", "specs/late.md"]);
  });
});
