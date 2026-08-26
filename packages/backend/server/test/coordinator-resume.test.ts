import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  groupMember as groupMemberTable,
  groupMessageClosure as groupMessageClosureTable,
  groupMessage as groupMessageTable,
  groups as groupsTable,
  participant as participantTable,
  taskCompletionEvent as taskCompletionEventTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DataBase } from "../src/lib/database";
import { testDb } from "./db";

/**
 * 子任务终态时把协调者重新拉起(specs/wake-the-coordinator-on-child-completion.md
 * R1-R6):
 * - R1:子任务终态 + 父协调任务非终态 + 父进程已退出 → 创建续跑任务;
 * - brief 含父任务 id / 终态子任务 id+状态+diffSummary / specRef+specHash /
 *   全部子任务 id 与状态;
 * - R2:父进程仍存活 → 不创建(回归,必测);
 * - R3:已有非终态续跑任务 → 不重复创建(必测);
 * - R4:续跑任务自身终态 → 不触发新的续跑(防环,必测);
 * - 父任务已终态 → 不创建;
 * - R6:协调者退出后父任务保持 running,不被判失败(回归,必测);
 * - R5:协调者任务书含「派发后可退出」那行(必测);
 * - 端到端:下发需求票 → 协调者派子任务后退出 → 子任务完成 → 协调者被重新拉起
 *   → PATCH 父任务结案(本票唯一真验收信号)。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-resume-bin-"));
const fakeBin = path.join(fakeDir, "fake-executor.sh");
writeFileSync(
  fakeBin,
  [
    "#!/bin/sh",
    'if [ -n "$FAKE_TICKET_COPY" ]; then cp "$3" "$FAKE_TICKET_COPY"; fi',
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:修改完成"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeBin, 0o755);
process.env.EXECUTOR_BIN_EXECUTOR = fakeBin;
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;

// 顶层 await 动态 import:env 设置先于模块求值。
const { createTestApp } = await import("./app");
const {
  __resetExecutorQueueForTests,
  consumePendingCompletionEvents,
  maybeCreateCoordinatorResumeTask,
} = await import("../src/lib/executor-task");

const runtimeDb = testDb as unknown as DataBase;

/** 生成一个已退出进程的 pid(process.kill(pid,0) → ESRCH = 已退出)。 */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    timeout: 5_000,
  });
  return child.pid;
}

async function insertParticipant(name: string) {
  const [row] = await testDb
    .insert(participantTable)
    .values({ name, tokenHash: "", executorKey: null })
    .returning();
  return row;
}

async function insertGroup(createdBy: string) {
  const [row] = await testDb
    .insert(groupsTable)
    .values({ title: `resume-g-${crypto.randomUUID().slice(0, 8)}`, createdBy })
    .returning();
  return row;
}

async function insertMember(
  groupId: string,
  participantId: string,
  roles: string[],
) {
  await testDb
    .insert(groupMemberTable)
    .values({ groupId, participantId, roles });
}

async function insertTask(opts: {
  groupId: string;
  executorParticipantId: string;
  status?: "queued" | "running" | "done" | "failed" | "cancelled";
  parentTaskId?: string | null;
  dispatcherParticipantId?: string | null;
  executorPid?: number | null;
  specRef?: string | null;
  specHash?: string | null;
  diffSummary?: unknown;
}) {
  const [row] = await testDb
    .insert(taskTable)
    .values({
      groupId: opts.groupId,
      messageId: crypto.randomUUID(),
      executorParticipantId: opts.executorParticipantId,
      executorKey: "executor",
      status: opts.status ?? "queued",
      parentTaskId: opts.parentTaskId ?? null,
      dispatcherParticipantId: opts.dispatcherParticipantId ?? null,
      executorPid: opts.executorPid ?? null,
      specRef: opts.specRef ?? null,
      specHash: opts.specHash ?? null,
      diffSummary: opts.diffSummary ?? null,
    })
    .returning();
  return row;
}

/** 标准场景:协调者(父, running, 进程已退出) + 执行器(子, done)。 */
async function seedParentChild(opts: {
  parentStatus?: "queued" | "running" | "done" | "failed" | "cancelled";
  parentPid?: number | null;
  childStatus?: "queued" | "running" | "done" | "failed" | "cancelled";
  childDiffSummary?: unknown;
  parentSpecRef?: string | null;
  parentSpecHash?: string | null;
  parentDispatchKind?: "requirement" | "fix" | null;
}) {
  const coordinator = await insertParticipant(`coord-${crypto.randomUUID()}`);
  const executor = await insertParticipant(`exec-${crypto.randomUUID()}`);
  const group = await insertGroup(coordinator.id);
  await insertMember(group.id, coordinator.id, ["coordinator"]);
  await insertMember(group.id, executor.id, ["executor"]);
  const parent = await insertTask({
    groupId: group.id,
    executorParticipantId: coordinator.id,
    status: opts.parentStatus ?? "running",
    executorPid: opts.parentPid ?? deadPid(),
    specRef:
      opts.parentSpecRef ?? "specs/wake-the-coordinator-on-child-completion.md",
    specHash: opts.parentSpecHash ?? "698657844210f681252848fc5974dd1123a6264c",
    diffSummary: opts.parentDispatchKind !== undefined ? {} : null,
  });
  const child = await insertTask({
    groupId: group.id,
    executorParticipantId: executor.id,
    status: opts.childStatus ?? "done",
    parentTaskId: parent.id,
    dispatcherParticipantId: coordinator.id,
    diffSummary: opts.childDiffSummary ?? { summary: "子任务完成" },
  });
  return { coordinator, executor, group, parent, child };
}

async function findTask(id: string) {
  const rows = await testDb
    .select()
    .from(taskTable)
    .where(eq(taskTable.id, id));
  return rows[0];
}

async function resumeTasksFor(parentId: string) {
  const rows = await testDb
    .select()
    .from(taskTable)
    .where(and(eq(taskTable.parentTaskId, parentId)));
  return rows.filter((row) => {
    const summary = row.diffSummary;
    return (
      typeof summary === "object" &&
      summary !== null &&
      !Array.isArray(summary) &&
      typeof (summary as Record<string, unknown>).platform === "object"
    );
  });
}

async function countPendingEvents(): Promise<number> {
  const rows = await testDb
    .select({ id: taskCompletionEventTable.id })
    .from(taskCompletionEventTable)
    .where(eq(taskCompletionEventTable.state, "pending"));
  return rows.length;
}

async function insertPendingCompletionEvent(
  child: typeof taskTable.$inferSelect,
  dispatcherParticipantId: string,
) {
  await testDb.insert(taskCompletionEventTable).values({
    taskId: child.id,
    groupId: child.groupId,
    dispatcherParticipantId,
    state: "pending",
  });
}

beforeEach(async () => {
  __resetExecutorQueueForTests();
  await testDb.delete(taskCompletionEventTable);
  await testDb.delete(groupMessageClosureTable);
  await testDb.delete(groupMessageTable);
  await testDb.delete(taskTable);
  await testDb.delete(groupMemberTable);
  await testDb.delete(groupsTable);
  await testDb.delete(participantTable);
});

afterAll(() => {
  rmSync(fakeDir, { recursive: true, force: true });
});

describe.sequential("协调者续跑完整验收", () => {
  describe.sequential("maybeCreateCoordinatorResumeTask (R1-R4 / 父终态 / R6)", () => {
    it("R1:子任务 done + 父协调任务 running + 父进程已退出 → 创建续跑任务", async () => {
      const { coordinator, group, parent, child } = await seedParentChild({});
      const result = await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      expect(result).toBe("created");

      const resumes = await resumeTasksFor(parent.id);
      expect(resumes.length).toBe(1);
      const resume = resumes[0];
      expect(resume.parentTaskId).toBe(parent.id);
      expect(resume.executorParticipantId).toBe(coordinator.id);
      expect(resume.groupId).toBe(group.id);
      expect(["queued", "running"]).toContain(resume.status);
      // R4 平台标记:diffSummary.platform.resumeOf = 父任务 id。
      expect(
        (resume.diffSummary as Record<string, unknown>).platform,
      ).toMatchObject({ resumeOf: parent.id });
    });

    it("R1:brief 含父任务 id / 终态子任务 id+状态+diffSummary / specRef+specHash / 全部子任务", async () => {
      const { parent, child } = await seedParentChild({});
      // 再加一个未终态子任务,验证「全部子任务」列出所有。
      const executor2 = await insertParticipant(`exec2-${crypto.randomUUID()}`);
      const sibling = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: executor2.id,
        status: "running",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
      });

      await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      const resumes = await resumeTasksFor(parent.id);
      const brief = resumes[0].brief ?? "";
      expect(brief).toContain(parent.id);
      expect(brief).toContain(child.id);
      expect(brief).toContain(child.status);
      expect(brief).toContain("子任务完成");
      expect(brief).toContain(parent.specRef ?? "");
      expect(brief).toContain(parent.specHash ?? "");
      expect(brief).toContain(sibling.id);
      expect(brief).toContain(sibling.status);
    });

    it("R2:父进程仍存活 → 不创建续跑任务(回归,必测)", async () => {
      const { parent, child } = await seedParentChild({
        parentPid: process.pid, // 本测试进程存活
      });
      const result = await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      expect(result).toBe("skipped");
      expect(await resumeTasksFor(parent.id)).toHaveLength(0);
    });

    it("R3:已有非终态续跑任务 → 不重复创建(必测)", async () => {
      const { parent, child } = await seedParentChild({});
      // 先创建一条续跑任务(queued)。
      await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      expect(await resumeTasksFor(parent.id)).toHaveLength(1);
      // 再消费一次 → R3 命中,不重复创建。
      const result = await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      expect(result).toBe("skipped");
      expect(await resumeTasksFor(parent.id)).toHaveLength(1);
    });

    it("R4:续跑任务自身终态 → 不触发新的续跑(防环,必测)", async () => {
      const { parent } = await seedParentChild({});
      // 构造一条「续跑任务」:parentTaskId = 父任务 + 平台标记 resumeOf。
      const resume = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: parent.executorParticipantId,
        status: "done",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
        diffSummary: { platform: { resumeOf: parent.id } },
      });
      const result = await maybeCreateCoordinatorResumeTask(runtimeDb, resume);
      expect(result).toBe("skipped");
      expect(await resumeTasksFor(parent.id)).toHaveLength(1); // 只有这条 resume 本身
    });

    it("父任务已终态 → 不创建续跑任务", async () => {
      const { parent, child } = await seedParentChild({ parentStatus: "done" });
      const result = await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      expect(result).toBe("skipped");
      expect(await resumeTasksFor(parent.id)).toHaveLength(0);
    });

    it("父任务执行方不是协调者 → 不创建续跑任务", async () => {
      const { parent, child } = await seedParentChild({});
      // 把父任务执行方改成非 coordinator 角色成员(executor 本人)。
      await testDb
        .update(taskTable)
        .set({ executorParticipantId: child.executorParticipantId })
        .where(eq(taskTable.id, parent.id));
      const result = await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      expect(result).toBe("skipped");
      expect(await resumeTasksFor(parent.id)).toHaveLength(0);
    });

    it("R6:协调者退出后父任务保持 running,不被判失败(回归,必测)", async () => {
      const { parent, child } = await seedParentChild({});
      await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      const after = await findTask(parent.id);
      expect(after.status).toBe("running");
      expect(after.status).not.toBe("failed");
    });
  });

  describe.sequential("consumePendingCompletionEvents (事件消费 → 续跑任务)", () => {
    it("子任务终态事件被消费 → 创建续跑任务并把事件置 delivered", async () => {
      const { coordinator, parent, child } = await seedParentChild({});
      await insertPendingCompletionEvent(child, coordinator.id);
      const created = await consumePendingCompletionEvents(runtimeDb);
      expect(created).toBe(1);
      expect(await resumeTasksFor(parent.id)).toHaveLength(1);
      expect(await countPendingEvents()).toBe(0);
    });

    it("重复消费不重复创建(事件已 delivered + R3 双保险)", async () => {
      const { coordinator, parent, child } = await seedParentChild({});
      await insertPendingCompletionEvent(child, coordinator.id);
      expect(await consumePendingCompletionEvents(runtimeDb)).toBe(1);
      expect(await consumePendingCompletionEvents(runtimeDb)).toBe(0);
      expect(await resumeTasksFor(parent.id)).toHaveLength(1);
    });
  });

  describe.sequential("R5:协调者任务书强制「派发成功后立即退出本轮、不得轮询子任务终态」(必测)", () => {
    it("协调者任务书强制退出本轮且明确禁止轮询子任务终态", async () => {
      // 这里直接锁定 coordinator 分支的任务书模板源码,避免该纯模板验收
      // 启动真实 CLI,与端到端测试共享临时 git 仓库造成竞态。
      const source = readFileSync(
        path.resolve(import.meta.dirname, "../src/lib/executor-task/queue.ts"),
        "utf8",
      );
      expect(source).toContain("### 派发成功后立即退出本轮（强制）");
      expect(source).toContain(
        "严禁在派发成功后用 `coagenthub_get_task` 轮询自身任务或子任务状态来等待其终态",
      );
      expect(source).toContain("coagenthub-coordinator` skill");
    }, 30_000);
  });

  describe.sequential("端到端:协调者派子任务后退出 → 子任务完成 → 协调者被重新拉起 → 结案", () => {
    const app = createTestApp();

    async function registerParticipant(name: string) {
      const res = await app.request("/api/participants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.status === 409) {
        const list = (await (
          await app.request("/api/participants")
        ).json()) as {
          id: string;
          name: string;
        }[];
        const existing = list.find((p) => p.name === name);
        if (existing) return { id: existing.id };
      }
      expect(res.status).toBe(200);
      return (await res.json()) as { id: string };
    }

    async function bindExecutorKey(id: string, key: string) {
      await testDb
        .update(participantTable)
        .set({ executorKey: null })
        .where(eq(participantTable.executorKey, key));
      await testDb
        .update(participantTable)
        .set({ executorKey: key })
        .where(eq(participantTable.id, id));
    }

    async function createGroup(creatorId: string, title: string) {
      const res = await app.request("/api/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": creatorId,
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

    async function postMessage(
      senderId: string,
      groupId: string,
      body: Record<string, unknown>,
    ) {
      const res = await app.request(`/api/groups/${groupId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": senderId,
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { id: string };
    }

    async function listTasks(groupId: string) {
      const res = await app.request(`/api/groups/${groupId}/tasks`);
      expect(res.status).toBe(200);
      return (await res.json()) as Array<{
        id: string;
        messageId: string;
        status: string;
      }>;
    }

    async function waitForTask(
      groupId: string,
      messageId: string,
      status: string,
      timeoutMs = 15_000,
    ) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const tasks = await listTasks(groupId);
        const hit = tasks.find((t) => t.messageId === messageId);
        if (hit && hit.status === status) return hit;
        if (Date.now() > deadline) {
          throw new Error(
            `task(${messageId}) 未在 ${timeoutMs}ms 内达到 ${status}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    async function waitForResumeTask(
      parentId: string,
      status: string,
      timeoutMs = 15_000,
    ) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const rows = await testDb
          .select()
          .from(taskTable)
          .where(and(eq(taskTable.parentTaskId, parentId)));
        const hit = rows.find((r) => r.id !== parentId && r.status === status);
        if (hit) return hit;
        if (Date.now() > deadline) {
          throw new Error(
            `续跑任务(parent=${parentId}) 未在 ${timeoutMs}ms 内达到 ${status}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    it("下发需求票 → 协调者派子任务后退出 → 子任务完成 → 协调者被重新拉起 → PATCH 父任务结案", async () => {
      const coordinator = await registerParticipant(
        `coord-e2e-${crypto.randomUUID()}`,
      );
      const executor = await registerParticipant(
        `exec-e2e-${crypto.randomUUID()}`,
      );
      await bindExecutorKey(coordinator.id, "codebuddy");
      await bindExecutorKey(executor.id, "executor");
      const group = await createGroup(coordinator.id, "端到端续跑");
      await addMember(coordinator.id, group.id, executor.id, ["executor"]);

      // 1) 协调者给自己派发一张「需求票」→ 父协调任务(coordinator 角色 → detached)。
      const parentMsg = await postMessage(coordinator.id, group.id, {
        body: "需求票:实现 X",
        audience: "participant",
        audienceRef: coordinator.id,
      });
      const parentTask = await waitForTask(group.id, parentMsg.id, "running");
      // 协调者进程(假 bin)已退出 → 父任务 detached 保持 running(不判失败)。
      const parentRow = await findTask(parentTask.id);
      expect(parentRow.status).toBe("running");
      // 模拟协调者退出:把 executorPid 指向一个已退出进程(真实场景假 bin 已退出)。
      const dead = deadPid();
      await testDb
        .update(taskTable)
        .set({ executorPid: dead })
        .where(eq(taskTable.id, parentTask.id));

      // 2) 协调者派发子任务给执行器。
      const childMsg = await postMessage(coordinator.id, group.id, {
        body: "执行 X",
        audience: "participant",
        audienceRef: executor.id,
      });
      const childTask = await waitForTask(group.id, childMsg.id, "done");

      // 3) 平台消费完成事件 → 创建续跑任务并被现有队列拉起(协调者被重新拉起)。
      const created = await consumePendingCompletionEvents(runtimeDb);
      expect(created).toBe(1);
      const resume = await waitForResumeTask(parentTask.id, "running");
      expect(resume.executorParticipantId).toBe(coordinator.id);
      expect(resume.brief).toContain(parentTask.id);
      expect(resume.brief).toContain(childTask.id);

      // 4) 协调者在续跑任务中 PATCH 父任务结案。
      const patchRes = await app.request(
        `/api/groups/${group.id}/tasks/${parentTask.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinator.id,
          },
          body: JSON.stringify({
            status: "done",
            diffSummary: {
              summary: "L2 通过",
              claimAdjudication: {
                [childTask.id]: {
                  accepted: true,
                  reason:
                    "fake executor 仅验证续跑链路并回报结果;不产生真实提交。",
                },
              },
            },
          }),
        },
      );
      const patchBody = await patchRes.text();
      expect(patchRes.status, patchBody).toBe(200);
      const closed = await findTask(parentTask.id);
      expect(closed.status).toBe("done");
    }, 60_000);
  });
});
