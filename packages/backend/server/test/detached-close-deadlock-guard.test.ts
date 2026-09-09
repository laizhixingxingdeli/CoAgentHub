import { spawnSync } from "node:child_process";
import {
  dispatchIntent as dispatchIntentTable,
  groupMember as groupMemberTable,
  groups as groupsTable,
  participant as participantTable,
  taskCompletionEvent as taskCompletionEventTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DataBase } from "../src/lib/database";
import {
  __resetExecutorQueueForTests,
  maybeCreateCoordinatorResumeTask,
} from "../src/lib/executor-task";
import { reconcileOrphanTasks } from "../src/lib/orphan-task-reconciler";
import { createTestApp } from "./app";
import { seedBuiltinExecutorConfigs, testDb } from "./db";

const db = testDb as unknown as DataBase;
const app = createTestApp();

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    timeout: 5_000,
  });
  return child.pid;
}

async function participant(name: string) {
  const [row] = await testDb
    .insert(participantTable)
    .values({ name, tokenHash: "", executorKey: null })
    .returning();
  return row;
}

async function fixture() {
  const coordinator = await participant(
    `close-coordinator-${crypto.randomUUID()}`,
  );
  const executor = await participant(`close-executor-${crypto.randomUUID()}`);
  const [group] = await testDb
    .insert(groupsTable)
    .values({ title: "detached close guard", createdBy: coordinator.id })
    .returning();
  await testDb.insert(groupMemberTable).values([
    {
      groupId: group.id,
      participantId: coordinator.id,
      roles: ["coordinator"],
    },
    { groupId: group.id, participantId: executor.id, roles: ["executor"] },
  ]);
  const [parent] = await testDb
    .insert(taskTable)
    .values({
      groupId: group.id,
      messageId: crypto.randomUUID(),
      executorParticipantId: coordinator.id,
      executorKey: "executor",
      executorPid: deadPid(),
      status: "running",
      brief: "## ReplyMode: detached",
    })
    .returning();
  const [child] = await testDb
    .insert(taskTable)
    .values({
      groupId: group.id,
      messageId: crypto.randomUUID(),
      parentTaskId: parent.id,
      dispatcherParticipantId: coordinator.id,
      executorParticipantId: executor.id,
      executorKey: "executor",
      status: "queued",
    })
    .returning();
  return { coordinator, group, parent, child };
}

beforeAll(async () => {
  await seedBuiltinExecutorConfigs();
});

beforeEach(async () => {
  __resetExecutorQueueForTests();
  // dispatch_intent(0031)对 task / group_message / participant / groups 都有外键,
  // 必须先清,否则下面的 delete 会被约束挡住,整个 beforeEach 连带失败。
  await testDb.delete(dispatchIntentTable);
  await testDb.delete(taskCompletionEventTable);
  await testDb.delete(taskTable);
  await testDb.delete(groupMemberTable);
  await testDb.delete(groupsTable);
  await testDb.delete(participantTable);
});

describe.sequential("detached 结案守卫交接", () => {
  it("守卫拒绝时登记续跑、保持 running，并让孤儿收敛豁免该协调任务", async () => {
    const { coordinator, group, parent, child } = await fixture();
    const response = await app.request(
      `/api/groups/${group.id}/tasks/${parent.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": coordinator.id,
        },
        body: JSON.stringify({
          status: "done",
          diffSummary: { l2: { verdict: "pass" } },
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(child.id);
    const stored = await testDb.query.task.findFirst({
      where: (task, { eq: eqFn }) => eqFn(task.id, parent.id),
    });
    expect(stored?.status).toBe("running");
    expect(stored?.diffSummary).toMatchObject({
      platform: {
        closeGuardResume: {
          resumeRegistered: true,
          blockedBy: [{ id: child.id, status: "queued" }],
        },
      },
    });
    expect(await reconcileOrphanTasks(db)).toBe(0);
  });

  it("任务列表和详情区分守卫等待续跑与普通排队", async () => {
    const { group, parent } = await fixture();
    await testDb
      .update(taskTable)
      .set({
        diffSummary: {
          platform: {
            closeGuardResume: {
              registeredAt: new Date().toISOString(),
              blockedBy: [{ id: crypto.randomUUID(), status: "queued" }],
              resumeRegistered: true,
              registrationError: null,
            },
          },
        },
      })
      .where(eq(taskTable.id, parent.id));

    const list = await app.request(`/api/groups/${group.id}/tasks`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as Array<Record<string, unknown>>;
    const waiting = body.find((task) => task.id === parent.id);
    const queued = body.find(
      (task) => task.status === "queued" && task.id !== parent.id,
    );
    expect(waiting?.closeGuardResume).toMatchObject({ awaitingResume: false });
    expect(queued?.closeGuardResume).toBeUndefined();

    const detail = await app.request(
      `/api/groups/${group.id}/tasks/${parent.id}`,
    );
    expect(detail.status).toBe(200);
    expect((await detail.json()).closeGuardResume).toMatchObject({
      awaitingResume: false,
    });
  });

  it("子任务终态后创建续跑，续跑完成后协调任务可带 l2 结案", async () => {
    const { coordinator, group, parent, child } = await fixture();
    await testDb
      .update(taskTable)
      .set({ status: "done" })
      .where(eq(taskTable.id, child.id));
    const result = await maybeCreateCoordinatorResumeTask(db, child);
    expect(result).toEqual({ kind: "created" });
    const resume = await testDb.query.task.findFirst({
      where: (task, { and: andFn, eq: eqFn }) =>
        andFn(
          eqFn(task.parentTaskId, parent.id),
          eqFn(task.executorParticipantId, coordinator.id),
        ),
    });
    expect(resume).toBeDefined();
    if (!resume) throw new Error("续跑任务未创建");
    await testDb
      .update(taskTable)
      .set({ status: "done" })
      .where(eq(taskTable.id, resume.id));

    const response = await app.request(
      `/api/groups/${group.id}/tasks/${parent.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": coordinator.id,
        },
        body: JSON.stringify({
          status: "done",
          diffSummary: { l2: { verdict: "pass" } },
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(
      (
        await testDb.query.task.findFirst({
          where: (task, { eq: eqFn }) => eqFn(task.id, parent.id),
        })
      )?.diffSummary,
    ).toMatchObject({ l2: { verdict: "pass" } });
  });
});
