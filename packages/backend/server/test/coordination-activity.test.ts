import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";
import { testDb } from "./db";

const app = createTestApp();

async function register(name: string) {
  const response = await app.request("/api/participants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string };
}

async function createGroup(coordinatorId: string, title: string) {
  const response = await app.request("/api/groups", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": coordinatorId,
    },
    body: JSON.stringify({ title }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string };
}

async function addMember(
  actorId: string,
  groupId: string,
  participantId: string,
  roles: string[],
) {
  const response = await app.request(`/api/groups/${groupId}/members`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": actorId,
    },
    body: JSON.stringify({ participantId, roles }),
  });
  expect(response.status).toBe(200);
}

async function postGroupMessage(actorId: string, groupId: string) {
  const response = await app.request(`/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": actorId,
    },
    body: JSON.stringify({ body: "协调者进度", audience: "broadcast" }),
  });
  expect(response.status).toBe(200);
}

async function finishTask(actorId: string, groupId: string, taskId: string) {
  const response = await app.request(`/api/groups/${groupId}/tasks/${taskId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": actorId,
    },
    body: JSON.stringify({ status: "done", diffSummary: { ok: true } }),
  });
  expect(response.status).toBe(200);
}

async function listWarnings(reviewerId: string) {
  const response = await app.request(
    `/api/participants/${reviewerId}/task-dispatch-warnings`,
    { headers: { "X-Participant-Id": reviewerId } },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    warnings: Array<Record<string, unknown>>;
  };
}

describe("coordination activity visibility", () => {
  it("records child targets and messages without warning when children exist", async () => {
    const coordinator = await register("activity-coordinator-with-child");
    const reviewer = await register("activity-reviewer-with-child");
    const worker = await register("activity-worker-with-child");
    const group = await createGroup(coordinator.id, "activity with child");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, worker.id, ["executor"]);

    const parentId = uuidv7();
    await testDb.insert(taskTable).values({
      id: parentId,
      groupId: group.id,
      messageId: uuidv7(),
      executorParticipantId: coordinator.id,
      executorKey: "coordinator-runtime",
      status: "running",
    });
    const childId = uuidv7();
    await testDb.insert(taskTable).values({
      id: childId,
      groupId: group.id,
      parentTaskId: parentId,
      messageId: uuidv7(),
      executorParticipantId: worker.id,
      executorKey: "worker",
      status: "done",
    });
    await postGroupMessage(coordinator.id, group.id);
    await finishTask(coordinator.id, group.id, parentId);

    const detail = await app.request(
      `/api/groups/${group.id}/tasks/${parentId}`,
    );
    const task = (await detail.json()) as {
      dispatchAudit: {
        coordinationActivity: {
          childTaskCount: number;
          childTaskTargets: Array<{ taskId: string; participantId: string }>;
          messageCount: number;
          startedAt: string;
          endedAt: string;
        };
      };
    };
    const activity = task.dispatchAudit.coordinationActivity;
    expect(activity.childTaskCount).toBe(1);
    expect(activity.childTaskTargets).toEqual([
      expect.objectContaining({ taskId: childId, participantId: worker.id }),
    ]);
    expect(activity.messageCount).toBe(1);
    expect(new Date(activity.endedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(activity.startedAt).getTime(),
    );
    expect((await listWarnings(reviewer.id)).warnings).toEqual([]);
  });

  it("persists a clear reviewer warning when no child task exists", async () => {
    const coordinator = await register("activity-coordinator-zero-child");
    const reviewer = await register("activity-reviewer-zero-child");
    const group = await createGroup(coordinator.id, "activity zero child");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);

    const taskId = uuidv7();
    await testDb.insert(taskTable).values({
      id: taskId,
      groupId: group.id,
      messageId: uuidv7(),
      executorParticipantId: coordinator.id,
      executorKey: "coordinator-runtime",
      status: "running",
    });
    await finishTask(coordinator.id, group.id, taskId);

    const warnings = await listWarnings(reviewer.id);
    expect(warnings.warnings).toEqual([
      expect.objectContaining({
        taskId,
        warningType: "zero-child-tasks",
        message: "该协调任务没有派发过任何子任务",
      }),
    ]);
  });

  it("does not record activity or warn for a non-coordinator task", async () => {
    const coordinator = await register("activity-coordinator-non-coordinator");
    const reviewer = await register("activity-reviewer-non-coordinator");
    const worker = await register("activity-worker-non-coordinator");
    const group = await createGroup(coordinator.id, "activity non coordinator");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, worker.id, ["executor"]);

    const taskId = uuidv7();
    await testDb.insert(taskTable).values({
      id: taskId,
      groupId: group.id,
      messageId: uuidv7(),
      executorParticipantId: worker.id,
      executorKey: "worker",
      status: "running",
    });
    await finishTask(worker.id, group.id, taskId);

    const detail = await app.request(`/api/groups/${group.id}/tasks/${taskId}`);
    expect(
      ((await detail.json()) as { dispatchAudit: unknown }).dispatchAudit,
    ).toBeNull();
    expect((await listWarnings(reviewer.id)).warnings).toEqual([]);
  });
});
