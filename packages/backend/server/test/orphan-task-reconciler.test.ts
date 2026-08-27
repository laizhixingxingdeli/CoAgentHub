import { spawnSync } from "node:child_process";
import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";
import type { DataBase } from "../src/lib/database";
import {
  reconcileOrphanTasks,
  startOrphanReconciler,
} from "../src/lib/orphan-task-reconciler";
import { createTestApp } from "./app";
import { testDb } from "./db";

// PGlite 与 node-postgres 的 drizzle 实例驱动类型不兼容(与 executor-trigger /
// executor-queue 同款 cast);纯函数只走共享的 query API。
const orphanDb = testDb as unknown as DataBase;

type Task = typeof taskTable.$inferSelect;

/** 生成一个已退出进程的 pid(process.kill(pid,0) → ESRCH = 已退出)。 */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    timeout: 5_000,
  });
  return child.pid;
}

/**
 * 孤儿任务周期收敛(specs/orphan-tasks-only-reconcile-on-restart.md R1-R7):
 * 运行期扫描 running 任务,pid 确已退出(ESRCH)才收敛为 failed 并留痕
 * (reconciledReason/reconciledAt);pid 存活(含静默超阈值)不收敛;条件更新
 * 不覆盖并发写入的 done;详情/列表 API 暴露 executorPid 与 pidAlive。
 */
describe("孤儿任务周期收敛", () => {
  const app = createTestApp();

  async function registerParticipant(body: Record<string, unknown>) {
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // 名字唯一(0013):同名已注册时服务端返回 409,复用现有 participant。
    if (res.status === 409) {
      const list = (await (await app.request("/api/participants")).json()) as {
        id: string;
        name: string;
      }[];
      const existing = list.find((p) => p.name === body.name);
      if (existing) return { id: existing.id };
    }
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    return { id };
  }

  async function createGroup(participantId: string, title: string) {
    const res = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  /** 直接构造任务行(不经过队列/计时器),供收敛纯函数与 API 字段验证。 */
  async function insertTaskRow(row: {
    groupId: string;
    executorParticipantId: string;
    executorPid?: number | null;
    status?: Task["status"];
    createdAt?: Date;
    updatedAt?: Date | null;
    diffSummary?: unknown;
  }) {
    const base = new Date("2026-08-24T10:00:00.000Z");
    const [inserted] = await testDb
      .insert(taskTable)
      .values({
        groupId: row.groupId,
        executorParticipantId: row.executorParticipantId,
        messageId: uuidv4(),
        executorPid: row.executorPid ?? null,
        status: row.status ?? "running",
        diffSummary: row.diffSummary ?? null,
        createdAt: row.createdAt ?? base,
        updatedAt: row.updatedAt ?? base,
      })
      .returning();
    return inserted as Task;
  }

  async function findTask(id: string) {
    return testDb.query.task.findFirst({
      where: (t, { eq: eqFn }) => eqFn(t.id, id),
    });
  }

  // ---- R2/R4:死亡 pid 收敛 + diffSummary 留痕 ----

  it("running 任务持有已退出 pid → 单轮收敛为 failed,diffSummary 含 reconciledReason 与收敛时刻", async () => {
    const participant = await registerParticipant({ name: "orc-exec-a" });
    const group = await createGroup(participant.id, "孤儿收敛-死亡pid");
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorPid: deadPid(),
    });

    const count = await reconcileOrphanTasks(orphanDb);

    expect(count).toBe(1);
    const row = await findTask(task.id);
    expect(row?.status).toBe("failed");
    const summary = row?.diffSummary as Record<string, unknown>;
    expect(summary.reconciledReason).toBe(
      `executor pid ${task.executorPid} no longer exists`,
    );
    expect(typeof summary.reconciledAt).toBe("string");
    expect(Number.isNaN(Date.parse(String(summary.reconciledAt)))).toBe(false);
    // 留痕可事后区分「平台收敛的孤儿」与「执行器自报的失败」。
  });

  it("再次扫描已收敛的任务 → 不再重复写(终态不在 running 扫描集内)", async () => {
    const participant = await registerParticipant({ name: "orc-exec-b" });
    const group = await createGroup(participant.id, "孤儿收敛-幂等");
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorPid: deadPid(),
    });

    await reconcileOrphanTasks(orphanDb);
    const second = await reconcileOrphanTasks(orphanDb);
    expect(second).toBe(0);
    expect((await findTask(task.id))?.status).toBe("failed");
  });

  it("无 executorPid 的 running 任务 → 不收敛(无法核验进程存活)", async () => {
    const participant = await registerParticipant({ name: "orc-exec-c" });
    const group = await createGroup(participant.id, "孤儿收敛-无pid");
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorPid: null,
    });

    expect(await reconcileOrphanTasks(orphanDb)).toBe(0);
    expect((await findTask(task.id))?.status).toBe("running");
  });

  // ---- R2:存活静默 pid 不收敛(防误杀) ----

  it("pid 仍存活但超过 30 分钟无输出 → 不收敛(status 保持 running)", async () => {
    const participant = await registerParticipant({ name: "orc-exec-d" });
    const group = await createGroup(participant.id, "孤儿收敛-存活静默");
    // 本测试进程的 pid 必然存活。
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorPid: process.pid,
    });
    // 信号时间回拨 31 分钟(livenessWarning 会告警,但收敛不得以此判死)。
    const stale = new Date("2026-08-24T09:29:00.000Z");
    await testDb
      .update(taskTable)
      .set({ createdAt: stale, updatedAt: stale })
      .where(eq(taskTable.id, task.id));

    expect(await reconcileOrphanTasks(orphanDb)).toBe(0);
    const row = await findTask(task.id);
    expect(row?.status).toBe("running");
    expect(row?.diffSummary).toBeNull();
  });

  // ---- R5:条件更新不覆盖并发 done ----

  it("执行器已写 done 的任务(带已退出 pid)→ 收敛不覆盖 done", async () => {
    const participant = await registerParticipant({ name: "orc-exec-e" });
    const group = await createGroup(participant.id, "孤儿收敛-并发done");
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorPid: deadPid(),
      diffSummary: { summary: "executor finished" },
    });
    // 模拟执行器在收敛扫描前并发写回终态。
    await testDb
      .update(taskTable)
      .set({ status: "done", diffSummary: { summary: "executor finished" } })
      .where(eq(taskTable.id, task.id));

    expect(await reconcileOrphanTasks(orphanDb)).toBe(0);
    const row = await findTask(task.id);
    expect(row?.status).toBe("done");
    expect(row?.diffSummary).toEqual({ summary: "executor finished" });
  });

  it("扫描与写回之间执行器并发写 done → 条件更新(仍为 running)不覆盖", async () => {
    const participant = await registerParticipant({ name: "orc-exec-f" });
    const group = await createGroup(participant.id, "孤儿收敛-竞态done");
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorPid: deadPid(),
    });

    // 不 await:让收敛的扫描先开始,随后执行器并发写 done。无论时序如何,
    // 条件更新(仅当仍为 running)保证 done 不被覆盖,终态必须仍是 done。
    const reconcilePromise = reconcileOrphanTasks(orphanDb);
    await testDb
      .update(taskTable)
      .set({ status: "done", diffSummary: { summary: "executor finished" } })
      .where(eq(taskTable.id, task.id));
    await reconcilePromise;

    const row = await findTask(task.id);
    expect(row?.status).toBe("done");
    expect(row?.diffSummary).toEqual({ summary: "executor finished" });
  });

  // ---- R1:周期任务驱动 ----

  it("startOrphanReconciler:一个周期内收敛孤儿,stop 后停止", async () => {
    const participant = await registerParticipant({ name: "orc-exec-g" });
    const group = await createGroup(participant.id, "孤儿收敛-周期");
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorPid: deadPid(),
    });

    const stop = startOrphanReconciler(orphanDb, 50);
    try {
      // 等最多 2s:一个周期(50ms)内应完成收敛。
      const deadline = Date.now() + 2_000;
      for (;;) {
        if ((await findTask(task.id))?.status !== "running") break;
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      stop();
    }
    expect((await findTask(task.id))?.status).toBe("failed");
    const summary = (await findTask(task.id))?.diffSummary as Record<
      string,
      unknown
    >;
    expect(summary.reconciledReason).toContain("no longer exists");
  });

  // ---- R6:详情/列表 API 暴露 executorPid 与 pidAlive ----

  it("GET 单任务:running + 存活 pid → executorPid/pidAlive:true;终态任务保留 pid 字段", async () => {
    const participant = await registerParticipant({ name: "orc-exec-h" });
    const group = await createGroup(participant.id, "孤儿收敛-详情存活");
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorPid: process.pid,
    });

    const response = await app.request(
      `/api/groups/${group.id}/tasks/${task.id}`,
      { headers: { "X-Participant-Id": participant.id } },
    );
    expect(response.status).toBe(200);
    const detail = (await response.json()) as Record<string, unknown>;
    expect(detail.executorPid).toBe(process.pid);
    expect(detail.pidAlive).toBe(true);
  });

  it("GET 单任务:已退出 pid → pidAlive:false;无 pid → executorPid:null + pidAlive:null", async () => {
    const participant = await registerParticipant({ name: "orc-exec-i" });
    const group = await createGroup(participant.id, "孤儿收敛-详情死亡");
    const dead = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorPid: deadPid(),
    });
    const none = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorPid: null,
    });

    const deadRes = await app.request(
      `/api/groups/${group.id}/tasks/${dead.id}`,
      { headers: { "X-Participant-Id": participant.id } },
    );
    const deadDetail = (await deadRes.json()) as Record<string, unknown>;
    expect(deadDetail.executorPid).toBe(dead.executorPid);
    expect(deadDetail.pidAlive).toBe(false);

    const noneRes = await app.request(
      `/api/groups/${group.id}/tasks/${none.id}`,
      { headers: { "X-Participant-Id": participant.id } },
    );
    const noneDetail = (await noneRes.json()) as Record<string, unknown>;
    expect(noneDetail.executorPid).toBeNull();
    expect(noneDetail.pidAlive).toBeNull();
  });

  it("GET 任务列表:每行返回 executorPid 与 pidAlive(含 includeOutput 路径)", async () => {
    const participant = await registerParticipant({ name: "orc-exec-j" });
    const group = await createGroup(participant.id, "孤儿收敛-列表存活");
    const alive = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorPid: process.pid,
    });
    const dead = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorPid: deadPid(),
    });
    const none = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorPid: null,
    });

    for (const query of ["", "?includeOutput=1"]) {
      const response = await app.request(
        `/api/groups/${group.id}/tasks${query}`,
        { headers: { "X-Participant-Id": participant.id } },
      );
      expect(response.status).toBe(200);
      const rows = (await response.json()) as Record<string, unknown>[];
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(alive.id)?.executorPid).toBe(process.pid);
      expect(byId.get(alive.id)?.pidAlive).toBe(true);
      expect(byId.get(dead.id)?.pidAlive).toBe(false);
      expect(byId.get(none.id)?.executorPid).toBeNull();
      expect(byId.get(none.id)?.pidAlive).toBeNull();
    }
  });
});
