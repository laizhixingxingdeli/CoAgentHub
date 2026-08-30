import type { TaskStatus } from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { seedBuiltinExecutorConfigs, testDb } from "./db";

/**
 * Durable Task Completion Events — 数据库 trigger 行为(specs/
 * durable-task-completion-events.md 数据模型节):
 * - task 首次从非终态进入 done/failed/cancelled 且存在 dispatcherParticipantId
 *   时,由 `trg_task_completion_event` trigger 在同一事务内创建 completion event;
 * - task_id UNIQUE 约束保证同一 task 最多一个 event(重复/并发终态写幂等);
 * - 无 dispatcher 不创建;已终态的历史 task 不因后续更新回填 event(无回溯)。
 *
 * 直接驱动真实 SQL(与生产同构的 PGlite),不经过消息/调度管线。
 */

const {
  task: taskTable,
  groups: groupsTable,
  participant: participantTable,
} = await import("@laizhixingxingdeli/database/schema");

async function seedIdentity() {
  const [participant] = await testDb
    .insert(participantTable)
    .values({
      name: `trig-p-${crypto.randomUUID().slice(0, 8)}`,
      tokenHash: "",
    })
    .returning();
  const [group] = await testDb
    .insert(groupsTable)
    .values({
      title: `trig-g-${crypto.randomUUID().slice(0, 8)}`,
      createdBy: participant.id,
    })
    .returning();
  return { participant, group };
}

async function insertTask(opts: {
  groupId: string;
  executorParticipantId: string;
  status?: TaskStatus;
  dispatcherParticipantId?: string | null;
  dispatcherSessionId?: string | null;
  callbackRef?: Record<string, unknown> | null;
}) {
  const [row] = await testDb
    .insert(taskTable)
    .values({
      groupId: opts.groupId,
      messageId: crypto.randomUUID(),
      executorParticipantId: opts.executorParticipantId,
      executorKey: "codebuddy",
      status: opts.status ?? "queued",
      dispatcherParticipantId: opts.dispatcherParticipantId ?? null,
      dispatcherSessionId: opts.dispatcherSessionId ?? null,
      callbackRef: opts.callbackRef ?? null,
    })
    .returning();
  return row;
}

async function countEvents(taskId: string): Promise<number> {
  const { taskCompletionEvent } = await import(
    "@laizhixingxingdeli/database/schema"
  );
  const rows = await testDb
    .select({ id: taskCompletionEvent.id })
    .from(taskCompletionEvent)
    .where(eq(taskCompletionEvent.taskId, taskId));
  return rows.length;
}

/** 事件的收件人 / 下发者两列(trigger 只搬运收件人,不改写下发者)。 */
async function recipientsOf(
  taskId: string,
): Promise<{ recipient: string | null; dispatcher: string | null }[]> {
  const { taskCompletionEvent } = await import(
    "@laizhixingxingdeli/database/schema"
  );
  const rows = await testDb
    .select({
      recipient: taskCompletionEvent.recipientParticipantId,
      dispatcher: taskCompletionEvent.dispatcherParticipantId,
    })
    .from(taskCompletionEvent)
    .where(eq(taskCompletionEvent.taskId, taskId));
  return rows;
}

beforeAll(async () => {
  await seedBuiltinExecutorConfigs();
});

describe("task_completion_event trigger", () => {
  it("queued → done(有 dispatcher)时创建且仅创建一个 event,路由字段透传", async () => {
    const { participant, group } = await seedIdentity();
    const task = await insertTask({
      groupId: group.id,
      executorParticipantId: participant.id,
      dispatcherParticipantId: participant.id,
      dispatcherSessionId: "sess-1",
      callbackRef: { platform: "codex", sessionRef: "sess-1" },
    });
    expect(await countEvents(task.id)).toBe(0);
    await testDb
      .update(taskTable)
      .set({ status: "done" })
      .where(eq(taskTable.id, task.id));
    expect(await countEvents(task.id)).toBe(1);
    // 再次更新(仍终态)不产生第二个 event。
    await testDb
      .update(taskTable)
      .set({ diffSummary: { extra: 1 } })
      .where(eq(taskTable.id, task.id));
    await testDb
      .update(taskTable)
      .set({ status: "failed" })
      .where(eq(taskTable.id, task.id));
    expect(await countEvents(task.id)).toBe(1);
  });

  it("无 dispatcherParticipantId 时不创建 event", async () => {
    const { participant, group } = await seedIdentity();
    const task = await insertTask({
      groupId: group.id,
      executorParticipantId: participant.id,
      dispatcherParticipantId: null,
    });
    await testDb
      .update(taskTable)
      .set({ status: "done" })
      .where(eq(taskTable.id, task.id));
    expect(await countEvents(task.id)).toBe(0);
  });

  it("failed / cancelled 同样创建 event(触发条件覆盖全部终态)", async () => {
    for (const terminal of ["failed", "cancelled"] as const) {
      const { participant, group } = await seedIdentity();
      const task = await insertTask({
        groupId: group.id,
        executorParticipantId: participant.id,
        dispatcherParticipantId: participant.id,
      });
      await testDb
        .update(taskTable)
        .set({ status: terminal })
        .where(eq(taskTable.id, task.id));
      expect(await countEvents(task.id)).toBe(1);
    }
  });

  it("收件人列由 trigger 逐字搬运:多收件人各一条,未裁定时回落下发者", async () => {
    const { participant, group } = await seedIdentity();
    // 1) 未裁定(recipient_participant_ids 为 null)→ 收件人 = 下发者(既有行为)。
    const plain = await insertTask({
      groupId: group.id,
      executorParticipantId: participant.id,
      dispatcherParticipantId: participant.id,
    });
    await testDb
      .update(taskTable)
      .set({ status: "done" })
      .where(eq(taskTable.id, plain.id));
    const plainRows = await recipientsOf(plain.id);
    expect(plainRows.length).toBe(1);
    expect(plainRows[0]?.recipient).toBe(participant.id);
    expect(plainRows[0]?.dispatcher).toBe(participant.id);

    // 2) 应用层裁定两个收件人(带 review_request 时的群内 reviewer)→ 每人一条;
    //    下发者列仍是下发者(审计事实不被裁定改写)。
    const [[reviewerA], [reviewerB]] = await Promise.all(
      ["trig-r-a", "trig-r-b"].map((prefix) =>
        testDb
          .insert(participantTable)
          .values({
            name: `${prefix}-${crypto.randomUUID().slice(0, 8)}`,
            tokenHash: "",
          })
          .returning(),
      ),
    );
    const multi = await insertTask({
      groupId: group.id,
      executorParticipantId: participant.id,
      dispatcherParticipantId: participant.id,
    });
    await testDb
      .update(taskTable)
      .set({
        status: "done",
        recipientParticipantIds: [reviewerA.id, reviewerB.id],
      })
      .where(eq(taskTable.id, multi.id));
    const multiRows = await recipientsOf(multi.id);
    expect(multiRows.length).toBe(2);
    expect(multiRows.map((r) => r.recipient).sort()).toEqual(
      [reviewerA.id, reviewerB.id].sort(),
    );
    expect(multiRows.every((r) => r.dispatcher === participant.id)).toBe(true);

    // 3) 裁定为空数组 → 同样回落下发者(不得产生无收件人的事件)。
    const empty = await insertTask({
      groupId: group.id,
      executorParticipantId: participant.id,
      dispatcherParticipantId: participant.id,
    });
    await testDb
      .update(taskTable)
      .set({ status: "done", recipientParticipantIds: [] })
      .where(eq(taskTable.id, empty.id));
    const emptyRows = await recipientsOf(empty.id);
    expect(emptyRows.length).toBe(1);
    expect(emptyRows[0]?.recipient).toBe(participant.id);
  });

  it("历史终态 task 不因后续更新回填 event(无回溯)", async () => {
    const { participant, group } = await seedIdentity();
    // 直接以终态插入(等价于迁移上线前的历史 done 任务):trigger 只响应 UPDATE
    // 且迁移不做回填,故不产生 event。
    const task = await insertTask({
      groupId: group.id,
      executorParticipantId: participant.id,
      status: "done",
      dispatcherParticipantId: participant.id,
    });
    expect(await countEvents(task.id)).toBe(0);
    // 终态 → 终态再更新(如 diffSummary 回填)同样不产生 event(OLD 已终态,
    // 不是「首次从非终态进入终态」)。
    await testDb
      .update(taskTable)
      .set({ status: "failed" })
      .where(eq(taskTable.id, task.id));
    expect(await countEvents(task.id)).toBe(0);
  });
});
