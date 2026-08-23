import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, describe, expect, it } from "vitest";

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-audit-bin-"));
const fakeBin = path.join(fakeDir, "fake-executor.sh");
writeFileSync(
  fakeBin,
  [
    "#!/bin/sh",
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:审计测试完成"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeBin, 0o755);
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;
process.env.EXECUTOR_BIN_EXECUTOR = fakeBin;

const { createTestApp } = await import("./app");
const { __resetExecutorQueueForTests } = await import(
  "@server/lib/executor-task"
);
const { testDb } = await import("./db");

const app = createTestApp();

afterAll(() => {
  __resetExecutorQueueForTests();
  rmSync(fakeDir, { recursive: true, force: true });
});

describe("自派警告与下发目标审计", () => {
  async function registerParticipant(name: string) {
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.status === 409) {
      const participants = (await (
        await app.request("/api/participants")
      ).json()) as Array<{
        id: string;
        name: string;
      }>;
      const participant = participants.find((entry) => entry.name === name);
      if (!participant) throw new Error(`participant ${name} was not found`);
      return participant;
    }
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; name: string };
  }

  async function createGroup(coordinatorId: string, title: string) {
    const res = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinatorId,
      },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  async function addMember(
    coordinatorId: string,
    groupId: string,
    participantId: string,
    roles: string[],
  ) {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinatorId,
      },
      body: JSON.stringify({ participantId, roles }),
    });
    expect(res.status).toBe(200);
  }

  async function postTask(
    senderId: string,
    groupId: string,
    audienceRef: string,
    metadata?: Record<string, string>,
  ) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": senderId,
      },
      body: JSON.stringify({
        body: "执行审计测试任务",
        audience: "participant",
        audienceRef,
        ...(metadata ? { metadata } : {}),
      }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  async function waitForTask(groupId: string, messageId: string) {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const res = await app.request(`/api/groups/${groupId}/tasks`);
      const tasks = (await res.json()) as Array<Record<string, unknown>>;
      const task = tasks.find((entry) => entry.messageId === messageId);
      if (task) return task;
      if (Date.now() > deadline) throw new Error("task was not created");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function waitForTerminalTask(groupId: string, taskId: string) {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const res = await app.request(`/api/groups/${groupId}/tasks/${taskId}`);
      const task = (await res.json()) as { status: string };
      if (["done", "failed", "cancelled"].includes(task.status)) return;
      if (Date.now() > deadline) throw new Error("task did not finish");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("自派仍创建任务,向检视者持久化警告并记录候选状态", async () => {
    const coordinator = await registerParticipant("audit-self-coordinator");
    const codebuddy = await registerParticipant("CodeBuddy 执行器");
    const atomcode = await registerParticipant("AtomCode 执行器");
    const reasonix = await registerParticipant("Reasoning 执行器");
    const reviewer = await registerParticipant("audit-self-reviewer");
    const group = await createGroup(coordinator.id, "自派审计");
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    await addMember(coordinator.id, group.id, atomcode.id, ["executor"]);
    await addMember(coordinator.id, group.id, reasonix.id, ["executor"]);
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    // CodeBuddy remains a configured executor but gains coordinator authority
    // as the sender, which exercises the permitted self-dispatch path.
    await addMember(coordinator.id, group.id, codebuddy.id, ["coordinator"]);
    await testDb.insert(taskTable).values([
      {
        groupId: group.id,
        messageId: uuidv7(),
        executorParticipantId: atomcode.id,
        executorKey: "executor",
        status: "failed",
      },
      {
        groupId: group.id,
        messageId: uuidv7(),
        executorParticipantId: reasonix.id,
        executorKey: "reasonix",
        status: "running",
      },
    ]);

    const message = await postTask(codebuddy.id, group.id, codebuddy.id);
    const task = await waitForTask(group.id, message.id);
    expect(["queued", "running"]).toContain(task.status);
    const audit = task.dispatchAudit as {
      selfDispatch: boolean;
      selectionReason: string | null;
      candidates: Array<{ participantId: string; status: string }>;
    };
    expect(audit.selfDispatch).toBe(true);
    expect(audit.selectionReason).toBeNull();
    expect(audit.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: atomcode.id,
          status: "recently_failed",
        }),
        expect.objectContaining({
          participantId: reasonix.id,
          status: "running",
        }),
      ]),
    );

    const warnings = await app.request(
      `/api/participants/${reviewer.id}/task-dispatch-warnings`,
      { headers: { "X-Participant-Id": reviewer.id } },
    );
    expect(warnings.status).toBe(200);
    expect(
      (await warnings.json()) as { warnings: Array<{ taskId: string }> },
    ).toEqual({
      warnings: [expect.objectContaining({ taskId: task.id })],
    });
    // A detached coordinator task normally awaits an external PATCH. This
    // fixture only needs creation-time behavior, so finish it before teardown.
    await testDb
      .update(taskTable)
      .set({ status: "done" })
      .where(eq(taskTable.id, task.id as string));
  });

  it("非自派不产生警告,调用方提供的理由原样写入审计", async () => {
    const coordinator = await registerParticipant("audit-direct-coordinator");
    const codebuddy = await registerParticipant("CodeBuddy 执行器");
    const reviewer = await registerParticipant("audit-direct-reviewer");
    const group = await createGroup(coordinator.id, "定向审计");
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);

    const message = await postTask(coordinator.id, group.id, codebuddy.id, {
      selectionReason: "按本群测试职责选择",
    });
    const task = await waitForTask(group.id, message.id);
    const audit = task.dispatchAudit as {
      selfDispatch: boolean;
      selectionReason: string | null;
    };
    expect(audit.selfDispatch).toBe(false);
    expect(audit.selectionReason).toBe("按本群测试职责选择");
    await waitForTerminalTask(group.id, task.id as string);

    const warnings = await app.request(
      `/api/participants/${reviewer.id}/task-dispatch-warnings`,
      { headers: { "X-Participant-Id": reviewer.id } },
    );
    expect((await warnings.json()) as { warnings: unknown[] }).toEqual({
      warnings: [],
    });
  });
});
