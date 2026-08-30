import { randomUUID } from "node:crypto";
import {
  groupMember as groupMemberTable,
  taskCompletionEvent as taskCompletionEventTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import { reviewRequestRecipients } from "@server/lib/executor-task/completion-recipient";
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";
import { testDb } from "./db";

/**
 * L3 请求的投递对象(specs/l3-request-delivery-and-scope.md R1/R2/R4):
 *
 * - R1:带 `review_request` 的完成事件投给**群内 reviewer**,其余完成事件仍投给
 *   下发者。缺陷 A 的直接回归:协调者自派 / 续跑 / detached 的属主任务,其下发者
 *   是协调者自己,而协调者从不读自己的收件箱 —— 按下发者投递时这类请求结构上
 *   永远送不到;
 * - R2:inbox 的列举 / claim / ack / fail 按 `recipient_participant_id` 归属;
 * - R4:并入不得降低可送达性 —— 候选属主收件人不同时不并入,各自独立成请求。
 */

interface InboxEvent {
  eventId: string;
  dispatcherParticipantId: string | null;
  task: { taskId: string; diffSummary: unknown };
}

describe("L3 请求投递对象 (R1/R2/R4)", () => {
  const app = createTestApp();

  async function register(name: string) {
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.status === 409) {
      const list = (await (await app.request("/api/participants")).json()) as {
        id: string;
        name: string;
      }[];
      const existing = list.find((p) => p.name === name);
      if (existing) return { id: existing.id };
    }
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
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
    actorId: string,
    groupId: string,
    participantId: string,
    roles: string[],
  ) {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": actorId,
      },
      body: JSON.stringify({ participantId, roles }),
    });
    expect(res.status).toBe(200);
  }

  function reviewRequest(
    taskId: string,
    specRef: string,
    specHash: string,
    conclusion: string,
  ) {
    return {
      review_request: {
        type: "review_request",
        layer: 3,
        taskId,
        specRef,
        specHash,
        diffSummary: conclusion,
      },
    };
  }

  /** 直接插入一条 done 的执行子任务,使协调任务可以合法落 done。 */
  async function addChild(
    groupId: string,
    parentTaskId: string,
    executorParticipantId: string,
  ) {
    await testDb.insert(taskTable).values({
      groupId,
      parentTaskId,
      messageId: uuidv4(),
      executorParticipantId,
      status: "done",
    });
  }

  /**
   * 直接插入协调任务(含 dispatcher):POST /tasks 不写下发者字段,而缺陷 A
   * 的前提正是「属主任务由协调者自派」—— 下发者 = 协调者本人。
   */
  async function insertCoordinationTask(opts: {
    groupId: string;
    coordinatorId: string;
    dispatchKind?: "requirement" | "fix";
    executorParticipantId?: string;
    diffSummary?: Record<string, unknown>;
  }) {
    const [row] = await testDb
      .insert(taskTable)
      .values({
        groupId: opts.groupId,
        messageId: uuidv4(),
        // 自派:执行人 = 协调者本人 → isDetachedTask 为真,L3 守卫生效。
        executorParticipantId: opts.executorParticipantId ?? opts.coordinatorId,
        dispatcherParticipantId: opts.coordinatorId,
        dispatchKind: opts.dispatchKind ?? "requirement",
        status: "queued",
        diffSummary: opts.diffSummary ?? null,
      })
      .returning();
    return row;
  }

  async function patchTask(
    participantId: string,
    groupId: string,
    taskId: string,
    body: Record<string, unknown>,
  ) {
    return app.request(`/api/groups/${groupId}/tasks/${taskId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify(body),
    });
  }

  /** 收件箱里属于某个 task 的事件(收件箱是唯一权威源)。 */
  async function inboxEventsForTask(participantId: string, taskId: string) {
    const res = await app.request(
      `/api/participants/${participantId}/task-completion-events`,
      { headers: { "X-Participant-Id": participantId } },
    );
    expect(res.status).toBe(200);
    const { events } = (await res.json()) as { events: InboxEvent[] };
    return events.filter((e) => e.task?.taskId === taskId);
  }

  /** 事件行本身(收件人列不在信封里,按 DB 断言)。 */
  async function eventRows(taskId: string) {
    return testDb
      .select({
        recipientParticipantId: taskCompletionEventTable.recipientParticipantId,
        dispatcherParticipantId:
          taskCompletionEventTable.dispatcherParticipantId,
      })
      .from(taskCompletionEventTable)
      .where(eq(taskCompletionEventTable.taskId, taskId));
  }

  async function taskRow(taskId: string) {
    return testDb.query.task.findFirst({ where: eq(taskTable.id, taskId) });
  }

  /** 三层在场(coordinator + reviewer + executor)的群。 */
  async function setupGroup(reviewerNames = ["reviewer"]) {
    const suffix = randomUUID();
    const coordinator = await register(`l3-recv-coord-${suffix}`);
    const group = await createGroup(coordinator.id, `l3-recv-${suffix}`);
    const reviewers = [];
    for (const name of reviewerNames) {
      const reviewer = await register(`${name}-${suffix}`);
      await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
      reviewers.push(reviewer);
    }
    const executor = await register(`l3-recv-exec-${suffix}`);
    await addMember(coordinator.id, group.id, executor.id, ["executor"]);
    return { coordinator, reviewers, executor, group };
  }

  /* ---------------- R1 验收 1/2:协调者自派(detached) ---------------- */

  it("R1(detached 自派):requirement 票落 done → review_request 事件只进 reviewer 收件箱,不进 coordinator 收件箱", async () => {
    const { coordinator, reviewers, executor, group } = await setupGroup();
    const reviewer = reviewers[0];
    const task = await insertCoordinationTask({
      groupId: group.id,
      coordinatorId: coordinator.id,
    });
    await addChild(group.id, task.id, executor.id);

    const patched = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: reviewRequest(
        task.id,
        "specs/l3-request-delivery-and-scope.md",
        "detached-hash",
        "detached L2 结论",
      ),
    });
    expect(patched.status, await patched.text()).toBe(200);

    // 缺陷 A 的前提:下发者就是协调者本人,而协调者从不读自己的收件箱。
    const rows = await eventRows(task.id);
    expect(rows.length).toBe(1);
    expect(rows[0]?.recipientParticipantId).toBe(reviewer.id);
    expect(rows[0]?.dispatcherParticipantId).toBe(coordinator.id);

    // 收件箱视角:reviewer 收到,coordinator 收不到。
    const reviewerEvents = await inboxEventsForTask(reviewer.id, task.id);
    expect(reviewerEvents.length).toBe(1);
    expect(
      (reviewerEvents[0]?.task.diffSummary as Record<string, unknown>)
        ?.review_request,
    ).toBeDefined();
    expect(await inboxEventsForTask(coordinator.id, task.id)).toEqual([]);
  });

  it("R1(续跑 resumeOf):续跑任务并入父请求,reviewer 收件箱仍只有父任务那一条", async () => {
    const { coordinator, reviewers, executor, group } = await setupGroup();
    const reviewer = reviewers[0];
    const specRef = "specs/l3-request-delivery-and-scope.md";
    const specHash = "resume-hash";

    const parent = await insertCoordinationTask({
      groupId: group.id,
      coordinatorId: coordinator.id,
    });
    await addChild(group.id, parent.id, executor.id);
    const parentPatched = await patchTask(coordinator.id, group.id, parent.id, {
      status: "done",
      diffSummary: reviewRequest(
        parent.id,
        specRef,
        specHash,
        "父任务 L2 结论",
      ),
    });
    expect(parentPatched.status, await parentPatched.text()).toBe(200);

    // 平台创建的续跑任务:同样由协调者自派,diffSummary.platform.resumeOf 指向父。
    const resume = await insertCoordinationTask({
      groupId: group.id,
      coordinatorId: coordinator.id,
      diffSummary: { platform: { resumeOf: parent.id } },
    });
    await addChild(group.id, resume.id, executor.id);
    const resumePatched = await patchTask(coordinator.id, group.id, resume.id, {
      status: "done",
      diffSummary: reviewRequest(resume.id, specRef, specHash, "续跑 L2 结论"),
    });
    expect(resumePatched.status, await resumePatched.text()).toBe(200);

    // 收件人相同 → 照旧并入父请求:reviewer 收件箱仍只挂父任务那一条。
    const resumeRow = await taskRow(resume.id);
    expect(resumeRow?.diffSummary).not.toHaveProperty("review_request");
    expect(resumeRow?.diffSummary).toMatchObject({
      platform: { l3MergedInto: parent.id },
    });
    const parentRequest = (
      (await taskRow(parent.id))?.diffSummary as Record<string, unknown>
    )?.review_request as { diffSummary: string };
    expect(parentRequest.diffSummary).toContain("父任务 L2 结论");
    expect(parentRequest.diffSummary).toContain("续跑 L2 结论");

    expect(await inboxEventsForTask(reviewer.id, parent.id)).toHaveLength(1);
    expect(await inboxEventsForTask(reviewer.id, resume.id)).toEqual([]);
    // 续跑任务自身已无 review_request → 其完成事件是普通事件,仍投给下发者。
    const resumeRows = await eventRows(resume.id);
    expect(resumeRows.map((r) => r.recipientParticipantId)).toEqual([
      coordinator.id,
    ]);
  });

  /* ---------------- 验收 3:普通完成事件仍投给下发者 ---------------- */

  it("普通完成事件(无 review_request)仍投给下发者,不进 reviewer 收件箱", async () => {
    const { coordinator, reviewers, executor, group } = await setupGroup();
    const reviewer = reviewers[0];
    const [task] = await testDb
      .insert(taskTable)
      .values({
        groupId: group.id,
        messageId: uuidv4(),
        executorParticipantId: executor.id,
        dispatcherParticipantId: coordinator.id,
        status: "queued",
      })
      .returning();

    const patched = await patchTask(executor.id, group.id, task.id, {
      status: "done",
      diffSummary: { summary: "普通执行任务", outputTail: "ok" },
    });
    expect(patched.status, await patched.text()).toBe(200);

    const rows = await eventRows(task.id);
    expect(rows.length).toBe(1);
    expect(rows[0]?.recipientParticipantId).toBe(coordinator.id);
    expect(await inboxEventsForTask(coordinator.id, task.id)).toHaveLength(1);
    expect(await inboxEventsForTask(reviewer.id, task.id)).toEqual([]);
  });

  /* ---------------- 验收 6:多 reviewer 各自一条 ---------------- */

  it("群内多个 reviewer → 各自产生一条事件,coordinator 收件箱为空", async () => {
    const { coordinator, reviewers, executor, group } = await setupGroup([
      "reviewer-a",
      "reviewer-b",
    ]);
    const task = await insertCoordinationTask({
      groupId: group.id,
      coordinatorId: coordinator.id,
    });
    await addChild(group.id, task.id, executor.id);
    const patched = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: reviewRequest(
        task.id,
        "specs/l3-request-delivery-and-scope.md",
        "multi-reviewer-hash",
        "多 reviewer L2 结论",
      ),
    });
    expect(patched.status, await patched.text()).toBe(200);

    const rows = await eventRows(task.id);
    expect(rows.map((r) => r.recipientParticipantId).sort()).toEqual(
      reviewers.map((r) => r.id).sort(),
    );
    for (const reviewer of reviewers) {
      expect(await inboxEventsForTask(reviewer.id, task.id)).toHaveLength(1);
    }
    expect(await inboxEventsForTask(coordinator.id, task.id)).toEqual([]);
  });

  /* ---------------- 验收 7(R4):收件人不同则不并入 ---------------- */

  it("R4:候选属主收件人不同时不并入,各自独立成请求", async () => {
    const { coordinator, reviewers, executor, group } = await setupGroup();
    const reviewerOne = reviewers[0];
    const specRef = "specs/l3-request-delivery-and-scope.md";
    const specHash = "r4-hash";

    const owner = await insertCoordinationTask({
      groupId: group.id,
      coordinatorId: coordinator.id,
    });
    await addChild(group.id, owner.id, executor.id);
    const ownerPatched = await patchTask(coordinator.id, group.id, owner.id, {
      status: "done",
      diffSummary: reviewRequest(owner.id, specRef, specHash, "属主 L2 结论"),
    });
    expect(ownerPatched.status, await ownerPatched.text()).toBe(200);
    expect((await eventRows(owner.id))[0]?.recipientParticipantId).toBe(
      reviewerOne.id,
    );

    // 群内 reviewer 换人:新请求的收件人不再是属主那条请求的收件人。
    // (收件人列的断言已在上面做过,这里把属主钉死在 reviewerOne 上。)
    const reviewerTwo = await register(`reviewer-two-${randomUUID()}`);
    await testDb
      .delete(groupMemberTable)
      .where(
        and(
          eq(groupMemberTable.groupId, group.id),
          eq(groupMemberTable.participantId, reviewerOne.id),
        ),
      );
    await addMember(coordinator.id, group.id, reviewerTwo.id, ["reviewer"]);

    const second = await insertCoordinationTask({
      groupId: group.id,
      coordinatorId: coordinator.id,
    });
    await addChild(group.id, second.id, executor.id);
    const secondPatched = await patchTask(coordinator.id, group.id, second.id, {
      status: "done",
      diffSummary: reviewRequest(
        second.id,
        specRef,
        specHash,
        "第二条 L2 结论",
      ),
    });
    expect(secondPatched.status, await secondPatched.text()).toBe(200);

    // 不并入:本任务仍自带 review_request,没有 l3MergedInto 标记。
    const secondRow = await taskRow(second.id);
    expect(secondRow?.diffSummary).toHaveProperty("review_request");
    expect(
      (secondRow?.diffSummary as Record<string, unknown>)?.platform,
    ).toBeUndefined();
    // 属主请求的结论里没有并入第二条。
    const ownerRequest = (
      (await taskRow(owner.id))?.diffSummary as Record<string, unknown>
    )?.review_request as { diffSummary: string };
    expect(ownerRequest.diffSummary).toContain("属主 L2 结论");
    expect(ownerRequest.diffSummary).not.toContain("第二条 L2 结论");

    // 各自独立成请求:新请求进新 reviewer 的收件箱。
    expect((await eventRows(second.id))[0]?.recipientParticipantId).toBe(
      reviewerTwo.id,
    );
    expect(await inboxEventsForTask(reviewerTwo.id, second.id)).toHaveLength(1);
  });

  /* ---------------- 验收 5:无 reviewer 时 R1 回落下发者 ---------------- */

  it("R1 回退:群内无 reviewer 时带 review_request 也回落下发者(普通事件不受影响)", async () => {
    const suffix = randomUUID();
    const coordinator = await register(`l3-recv-noreviewer-coord-${suffix}`);
    const group = await createGroup(coordinator.id, `l3-recv-nr-${suffix}`);
    const executor = await register(`l3-recv-nr-exec-${suffix}`);
    await addMember(coordinator.id, group.id, executor.id, ["executor"]);

    // 没有 reviewer 成员:裁定回落下发者(R3 反向守卫会先拦下 review_request,
    // 这里是裁定函数本身的防御性兜底)。
    // testDb 是 PGlite 实例(setup.ts 用 PGlite 替换了 node-postgres),与
    // DataBase 的 node-pg 类型不兼容 —— 裁定函数只用到 db.query.groupMember。
    const db = testDb as unknown as Parameters<
      typeof reviewRequestRecipients
    >[0];
    expect(await reviewRequestRecipients(db, group.id, coordinator.id)).toEqual(
      [coordinator.id],
    );
    expect(await reviewRequestRecipients(db, group.id, null)).toEqual([]);

    // 两层编制下的普通完成事件仍投给下发者。
    const [task] = await testDb
      .insert(taskTable)
      .values({
        groupId: group.id,
        messageId: uuidv4(),
        executorParticipantId: executor.id,
        dispatcherParticipantId: coordinator.id,
        status: "queued",
      })
      .returning();
    const patched = await patchTask(executor.id, group.id, task.id, {
      status: "done",
      diffSummary: { summary: "两层编制下的普通完成事件" },
    });
    expect(patched.status, await patched.text()).toBe(200);
    expect((await eventRows(task.id))[0]?.recipientParticipantId).toBe(
      coordinator.id,
    );
  });
});
