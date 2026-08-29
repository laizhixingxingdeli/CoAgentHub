import { spawnSync } from "node:child_process";
import {
  groupMember as groupMemberTable,
  groups as groupsTable,
  participant as participantTable,
  taskCompletionEvent as taskCompletionEventTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataBase } from "../src/lib/database";
import {
  __resetExecutorQueueForTests,
  consumePendingCompletionEvents,
} from "../src/lib/executor-task";
import { appendTaskOutput } from "../src/lib/executor-task/output-buffer";
import { cooldownEndMs, isInCooldown } from "../src/lib/executor-task/state";
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

/** 每个用例独立数据集,避免前面用例遗留的 running+dead-pid 任务污染计数。 */
beforeEach(async () => {
  // 先清模块级输出缓冲与冷却登记(额度用例会 appendTaskOutput / enterCooldown),
  // 再清库 —— 避免上一用例的缓冲/冷却泄漏到本用例。
  __resetExecutorQueueForTests();
  await testDb.delete(taskCompletionEventTable);
  await testDb.delete(taskTable);
  await testDb.delete(groupMemberTable);
  await testDb.delete(groupsTable);
  await testDb.delete(participantTable);
});

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
    parentTaskId?: string | null;
    executorPid?: number | null;
    executorKey?: string | null;
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
        parentTaskId: row.parentTaskId ?? null,
        messageId: uuidv4(),
        executorPid: row.executorPid ?? null,
        executorKey: row.executorKey ?? null,
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

  it("收敛写回合并 diffSummary:保留 platform.resumeOf、tokenUsage 与执行器字段,仅新增/覆盖收敛三键(R2)", async () => {
    const participant = await registerParticipant({ name: "orc-merge-a" });
    const group = await createGroup(participant.id, "孤儿收敛-合并diffSummary");
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorPid: deadPid(),
      // 收敛前已有 platform 标记、平台采集的 token 字段与执行器自定义字段,
      // 且 error/reconciledReason/reconciledAt 已有旧值(模拟第二次收敛)。
      diffSummary: {
        platform: { resumeOf: "parent-task-id" },
        tokenUsage: { totalTokens: 12345 },
        tokenUsageReason: "executor reported",
        custom: { note: "executor wrote this" },
        error: "old error",
        reconciledReason: "old reason",
        reconciledAt: "2026-01-01T00:00:00.000Z",
      },
    });

    const before = (await findTask(task.id))?.diffSummary as Record<
      string,
      unknown
    >;
    expect(await reconcileOrphanTasks(orphanDb)).toBe(1);
    const row = await findTask(task.id);
    expect(row?.status).toBe("failed");
    const summary = row?.diffSummary as Record<string, unknown>;
    // 原有字段全部保留(收敛前后对照)。
    expect(summary.platform).toEqual(before.platform);
    expect(summary.tokenUsage).toEqual(before.tokenUsage);
    expect(summary.tokenUsageReason).toBe("executor reported");
    expect(summary.custom).toEqual(before.custom);
    // 三键以本次收敛值覆盖旧值。
    expect(summary.error).toBe(
      `executor pid ${task.executorPid} no longer exists`,
    );
    expect(summary.reconciledReason).toBe(
      `executor pid ${task.executorPid} no longer exists`,
    );
    expect(summary.reconciledAt).not.toBe(before.reconciledAt);
    expect(Number.isNaN(Date.parse(String(summary.reconciledAt)))).toBe(false);
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

  it("startOrphanReconciler:一个周期内收敛孤儿,stop 后停止(缺省开关 = 生产默认路径自动启动)", async () => {
    const participant = await registerParticipant({ name: "orc-exec-g" });
    const group = await createGroup(participant.id, "孤儿收敛-周期");
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorPid: deadPid(),
    });

    // 生产创建 server/app 的默认路径(index.ts)不传 options → enabled 缺省 true,
    // 本用例证明该默认调用确实注册定时器并在一个周期内收敛。驱动用 fake timers,
    // 测试环境不注册真实 OS 定时器,避免泄漏的在途收敛抢跑后续用例(回归修复)。
    vi.useFakeTimers();
    try {
      const stop = startOrphanReconciler(orphanDb, 50);
      // 推进一步(50ms):一个周期内应完成收敛。
      await vi.advanceTimersByTimeAsync(50);
      expect((await findTask(task.id))?.status).toBe("failed");
      const summary = (await findTask(task.id))?.diffSummary as Record<
        string,
        unknown
      >;
      expect(summary.reconciledReason).toContain("no longer exists");

      // stop 后不再收敛新孤儿:插一条新的 dead-pid 任务,再推进一步周期仍保持 running。
      const second = await insertTaskRow({
        groupId: group.id,
        executorParticipantId: participant.id,
        executorPid: deadPid(),
      });
      stop();
      await vi.advanceTimersByTimeAsync(50);
      expect((await findTask(second.id))?.status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("startOrphanReconciler 显式开关 enabled:false → 不注册定时器(测试环境不自动启动),显式调用仍收敛", async () => {
    const participant = await registerParticipant({ name: "orc-disabled-a" });
    const group = await createGroup(participant.id, "孤儿收敛-开关关闭");
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorPid: deadPid(),
    });

    // 测试环境注入 enabled:false:不注册任何定时器,孤儿保持 running,不被后台误判 failed。
    vi.useFakeTimers();
    try {
      const stop = startOrphanReconciler(orphanDb, 50, { enabled: false });
      await vi.advanceTimersByTimeAsync(200); // 跨多个周期,仍无任何收敛动作
      expect((await findTask(task.id))?.status).toBe("running");
      expect(stop()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }

    // 纯函数路径不受开关影响:显式调用 reconcileOrphanTasks 仍照常收敛。
    expect(await reconcileOrphanTasks(orphanDb)).toBe(1);
    expect((await findTask(task.id))?.status).toBe("failed");
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

  // ---- 本 spec R1-R3:等待续跑的协调者任务不收敛,其余照常收敛 ----

  it("协调者任务名下存在非终态子任务 → 豁免收敛(等待续跑,pid 消失仍保持 running)", async () => {
    const coordinator = await registerParticipant({ name: "orc-wait-a" });
    const group = await createGroup(coordinator.id, "孤儿收敛-待续跑豁免");
    // 建群者默认持有 coordinator 角色 → isCoordinatorTask 命中。
    const parent = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: coordinator.id,
      executorPid: deadPid(),
    });
    const executor = await registerParticipant({ name: "orc-wait-b" });
    const child = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: executor.id,
      parentTaskId: parent.id,
      status: "running",
      executorPid: process.pid,
    });

    expect(await reconcileOrphanTasks(orphanDb)).toBe(0);
    expect((await findTask(parent.id))?.status).toBe("running");
    expect((await findTask(child.id))?.status).toBe("running");
  });

  it("协调者任务名下子任务处于 queued → 同样豁免收敛", async () => {
    const coordinator = await registerParticipant({ name: "orc-wait-c" });
    const group = await createGroup(coordinator.id, "孤儿收敛-待续跑queued");
    const parent = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: coordinator.id,
      executorPid: deadPid(),
    });
    const executor = await registerParticipant({ name: "orc-wait-d" });
    await insertTaskRow({
      groupId: group.id,
      executorParticipantId: executor.id,
      parentTaskId: parent.id,
      status: "queued",
      executorPid: null,
    });

    expect(await reconcileOrphanTasks(orphanDb)).toBe(0);
    expect((await findTask(parent.id))?.status).toBe("running");
  });

  it("协调者任务无任何子任务 + pid 消失 → 照常收敛为 failed(R2 防回归死锁)", async () => {
    const coordinator = await registerParticipant({ name: "orc-nokid-a" });
    const group = await createGroup(coordinator.id, "孤儿收敛-无子任务");
    const parent = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: coordinator.id,
      executorPid: deadPid(),
    });

    expect(await reconcileOrphanTasks(orphanDb)).toBe(1);
    expect((await findTask(parent.id))?.status).toBe("failed");
  });

  it("协调者任务子任务全部终态 + pid 消失 → 照常收敛为 failed(R2)", async () => {
    const coordinator = await registerParticipant({ name: "orc-alldone-a" });
    const group = await createGroup(coordinator.id, "孤儿收敛-子任务终态");
    const parent = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: coordinator.id,
      executorPid: deadPid(),
    });
    const executor = await registerParticipant({ name: "orc-alldone-b" });
    await insertTaskRow({
      groupId: group.id,
      executorParticipantId: executor.id,
      parentTaskId: parent.id,
      status: "done",
      diffSummary: { summary: "子任务完成" },
    });
    await insertTaskRow({
      groupId: group.id,
      executorParticipantId: executor.id,
      parentTaskId: parent.id,
      status: "cancelled",
    });

    expect(await reconcileOrphanTasks(orphanDb)).toBe(1);
    expect((await findTask(parent.id))?.status).toBe("failed");
  });

  it("续跑任务边界:无非终态子任务且无待建续跑事件 + pid 消失 → 仍收敛为 failed(R1 防永远不收敛)", async () => {
    const coordinator = await registerParticipant({ name: "orc-resume-a" });
    const group = await createGroup(coordinator.id, "孤儿收敛-续跑无事可做");
    // R1 边界:续跑任务与协调根任务同条件豁免 —— 仅当名下还有非终态子任务或
    // 待建续跑事件时才不收敛;自己也无事可做时仍照常收敛,防止「反复被续跑的
    // 任务永远不被收敛」(specs/resume-task-killed-and-summary-clobbered.md R1)。
    const resume = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: coordinator.id,
      executorPid: deadPid(),
      diffSummary: { platform: { resumeOf: "parent-task-id" } },
    });

    expect(await reconcileOrphanTasks(orphanDb)).toBe(1);
    expect((await findTask(resume.id))?.status).toBe("failed");
  });

  // ---- 本 spec 必经竞态窗口:子任务刚转终态、续跑尚未创建 ----

  it("竞态窗口:子任务刚转终态(done)+ 完成事件 pending + 续跑尚未创建 → 父任务不被收敛", async () => {
    const coordinator = await registerParticipant({ name: "orc-race-a" });
    const group = await createGroup(coordinator.id, "孤儿收敛-竞态窗口");
    const parent = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: coordinator.id,
      executorPid: deadPid(),
    });
    const executor = await registerParticipant({ name: "orc-race-b" });
    const child = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: executor.id,
      parentTaskId: parent.id,
      status: "done",
      diffSummary: { summary: "子任务完成" },
    });
    // 子任务首次进入终态 → DB trigger 同事务落 pending 完成事件(dispatcher =
    // 协调者);此刻消费方尚未创建续跑,resumeOf 续跑任务还不存在。
    await testDb.insert(taskCompletionEventTable).values({
      taskId: child.id,
      groupId: group.id,
      dispatcherParticipantId: coordinator.id,
      state: "pending",
    });

    // 续跑尚未创建:hasNonTerminalChildTask 已失效(done 是终态),但 pending
    // 完成事件说明续跑创建在途(消费方下一周期即创建)→ 父任务不得被判死。
    expect(await reconcileOrphanTasks(orphanDb)).toBe(0);
    expect((await findTask(parent.id))?.status).toBe("running");
  });

  it("续跑任务自身的 pending 完成事件 → 不计入等待续跑,父任务仍照常收敛(终止性)", async () => {
    const coordinator = await registerParticipant({ name: "orc-resume-ev-a" });
    const group = await createGroup(coordinator.id, "孤儿收敛-续跑事件不豁免");
    const parent = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: coordinator.id,
      executorPid: deadPid(),
    });
    const resume = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: coordinator.id,
      parentTaskId: parent.id,
      status: "done",
      diffSummary: { platform: { resumeOf: parent.id } },
    });
    // 续跑任务终态 → trigger 落 pending 事件,但 R4 防环使消费方永远跳过它,
    // 事件不会产生任何新续跑 → 不得凭它豁免父任务(R2/R3 防回归死锁)。
    await testDb.insert(taskCompletionEventTable).values({
      taskId: resume.id,
      groupId: group.id,
      dispatcherParticipantId: coordinator.id,
      state: "pending",
    });

    expect(await reconcileOrphanTasks(orphanDb)).toBe(1);
    expect((await findTask(parent.id))?.status).toBe("failed");
  });

  it("完整链路:父任务不被收敛 → 子任务终态事件消费 → resumeOf 续跑创建 → 父任务结案 done", async () => {
    const coordinator = await registerParticipant({ name: "orc-chain-a" });
    const group = await createGroup(coordinator.id, "孤儿收敛-完整链路");
    const parent = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: coordinator.id,
      executorPid: deadPid(),
    });
    const executor = await registerParticipant({ name: "orc-chain-b" });
    const child = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: executor.id,
      parentTaskId: parent.id,
      status: "done",
      diffSummary: { summary: "子任务完成" },
    });
    // 竞态窗口:子任务已终态、完成事件 pending、resumeOf 续跑尚未创建。
    await testDb.insert(taskCompletionEventTable).values({
      taskId: child.id,
      groupId: group.id,
      dispatcherParticipantId: coordinator.id,
      state: "pending",
    });

    // 1) 孤儿收敛先跑:等待续跑的父任务不得被判死。
    expect(await reconcileOrphanTasks(orphanDb)).toBe(0);
    expect((await findTask(parent.id))?.status).toBe("running");

    // 2) 消费完成事件 → 创建带 diffSummary.platform.resumeOf 的续跑任务。
    expect(await consumePendingCompletionEvents(orphanDb)).toBe(1);
    const resumes = await testDb.query.task.findMany({
      where: and(
        eq(taskTable.parentTaskId, parent.id),
        eq(taskTable.executorParticipantId, coordinator.id),
      ),
    });
    expect(resumes.length).toBe(1);
    expect(
      (resumes[0].diffSummary as Record<string, unknown>).platform,
    ).toMatchObject({ resumeOf: parent.id });

    // 3) 续跑期间父任务仍非终态,再收敛一轮也不误杀(续跑为非终态子任务)。
    expect(await reconcileOrphanTasks(orphanDb)).toBe(0);
    expect((await findTask(parent.id))?.status).toBe("running");

    // 4) 续跑完成(模拟协调者做完 L2 后 PATCH 续跑任务 done),协调者 PATCH
    //    父任务结案 → 全部子任务终态,结案守卫放行 → done。
    await testDb
      .update(taskTable)
      .set({ status: "done" })
      .where(eq(taskTable.id, resumes[0].id));
    const patchRes = await app.request(
      `/api/groups/${group.id}/tasks/${parent.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": coordinator.id,
        },
        body: JSON.stringify({
          status: "done",
          diffSummary: { summary: "L2 通过" },
        }),
      },
    );
    const patchBody = await patchRes.text();
    expect(patchRes.status, patchBody).toBe(200);
    expect((await findTask(parent.id))?.status).toBe("done");
  });

  it("核心场景:续跑任务派出子任务后 pid 消失 → 不收敛;子任务终态后产生新续跑,父任务最终 done", async () => {
    const coordinator = await registerParticipant({
      name: "orc-resume-chain-a",
    });
    const group = await createGroup(coordinator.id, "孤儿收敛-续跑派完即退");
    // 原协调任务(已 done,仅作 resumeOf 指向)。
    const root = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: coordinator.id,
      status: "done",
    });
    // 续跑任务:派完即退 → pid 消失,名下仍有非终态子任务。
    const resume = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: coordinator.id,
      executorPid: deadPid(),
      diffSummary: { platform: { resumeOf: root.id } },
    });
    const executor = await registerParticipant({ name: "orc-resume-chain-b" });
    const childRunning = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: executor.id,
      parentTaskId: resume.id,
      status: "running",
      executorPid: process.pid,
    });
    const childQueued = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: executor.id,
      parentTaskId: resume.id,
      status: "queued",
      executorPid: null,
    });

    // 1) 核心回归:续跑任务 pid 消失但名下存在非终态子任务 → 不收敛。
    expect(await reconcileOrphanTasks(orphanDb)).toBe(0);
    expect((await findTask(resume.id))?.status).toBe("running");

    // 2) 子任务全部终态 → 完成事件 pending(trigger 同事务落库,续跑尚未创建)。
    await testDb
      .update(taskTable)
      .set({ status: "done", diffSummary: { summary: "子任务完成" } })
      .where(eq(taskTable.id, childRunning.id));
    await testDb
      .update(taskTable)
      .set({ status: "done", diffSummary: { summary: "子任务完成" } })
      .where(eq(taskTable.id, childQueued.id));
    await testDb.insert(taskCompletionEventTable).values({
      taskId: childRunning.id,
      groupId: group.id,
      dispatcherParticipantId: coordinator.id,
      state: "pending",
    });
    await testDb.insert(taskCompletionEventTable).values({
      taskId: childQueued.id,
      groupId: group.id,
      dispatcherParticipantId: coordinator.id,
      state: "pending",
    });

    // 竞态窗口:子任务已终态、续跑尚未创建 → hasPendingResumeEvent 兜住,仍不收敛。
    expect(await reconcileOrphanTasks(orphanDb)).toBe(0);
    expect((await findTask(resume.id))?.status).toBe("running");

    // 3) 消费完成事件 → 为续跑任务派出的子任务创建新续跑。
    expect(await consumePendingCompletionEvents(orphanDb)).toBe(1);
    const resumes = await testDb.query.task.findMany({
      where: and(
        eq(taskTable.parentTaskId, resume.id),
        eq(taskTable.executorParticipantId, coordinator.id),
      ),
    });
    expect(resumes.length).toBe(1);
    expect(
      (resumes[0].diffSummary as Record<string, unknown>).platform,
    ).toMatchObject({ resumeOf: resume.id });

    // 4) 新续跑完成 → 协调者 PATCH 续跑任务结案 done(父任务最终 done)。
    await testDb
      .update(taskTable)
      .set({ status: "done" })
      .where(eq(taskTable.id, resumes[0].id));
    const patchRes = await app.request(
      `/api/groups/${group.id}/tasks/${resume.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": coordinator.id,
        },
        body: JSON.stringify({
          status: "done",
          diffSummary: { summary: "L2 通过" },
        }),
      },
    );
    const patchBody = await patchRes.text();
    expect(patchRes.status, patchBody).toBe(200);
    expect((await findTask(resume.id))?.status).toBe("done");
  });

  // ---- 本票(quota-failure-on-clean-exit 语义复用):判死前检查已捕获输出尾部 20 行 ----

  it("输出尾部 20 行含 usage limit + try again at 7:50 PM → 额度收敛:failed + executorCooldownEndMs + 冷却 + error 用既有额度文案含 ETA", async () => {
    const participant = await registerParticipant({ name: "orc-quota-a" });
    const group = await createGroup(participant.id, "孤儿收敛-额度尾部");
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorKey: "codebuddy",
      executorPid: deadPid(),
    });
    // 模拟 detached 执行器已捕获输出:额度关键词与恢复时刻都在尾部 20 行内。
    appendTaskOutput(
      task.id,
      "some work\nYou've hit your usage limit. try again at 7:50 PM\n",
    );
    // 固定基准时间(本地 10:00),冷却解析与冷却登记都以它为基准,断言确定性。
    const now = new Date(2026, 7, 29, 10, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      expect(await reconcileOrphanTasks(orphanDb, now)).toBe(1);
      const row = await findTask(task.id);
      expect(row?.status).toBe("failed");
      const summary = row?.diffSummary as Record<string, unknown>;
      // error 用既有额度失败文案并含 ETA。
      const err = String(summary.error);
      expect(err).toContain("执行器额度限制");
      expect(err).toMatch(/预计 .+ 恢复/);
      // 冷却至解析出的恢复时刻:7:50 PM(12 小时制)→ 当天 19:50。
      const expectedEnd = new Date(2026, 7, 29, 19, 50, 0, 0).getTime();
      expect(summary.executorCooldownEndMs).toBe(expectedEnd);
      // 执行器进入冷却(冷却登记与 diffSummary 同值)。
      expect(cooldownEndMs({ key: "codebuddy" })).toBe(expectedEnd);
      expect(isInCooldown({ key: "codebuddy" })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("输出尾部含 resets around 18:33 → 冷却解析至当天 18:33", async () => {
    const participant = await registerParticipant({ name: "orc-quota-b" });
    const group = await createGroup(participant.id, "孤儿收敛-额度resets");
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorKey: "codebuddy",
      executorPid: deadPid(),
    });
    appendTaskOutput(task.id, "usage limit reached — resets around 18:33\n");
    const now = new Date(2026, 7, 29, 10, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      await reconcileOrphanTasks(orphanDb, now);
      const summary = (await findTask(task.id))?.diffSummary as Record<
        string,
        unknown
      >;
      expect(summary.executorCooldownEndMs).toBe(
        new Date(2026, 7, 29, 18, 33, 0, 0).getTime(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("输出不含额度关键词 → error/reconciledReason/reconciledAt 三键行为不变(回归)", async () => {
    const participant = await registerParticipant({ name: "orc-quota-c" });
    const group = await createGroup(participant.id, "孤儿收敛-非额度");
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorKey: "codebuddy",
      executorPid: deadPid(),
    });
    // 有已捕获输出但不含额度关键词 → 普通收敛路径逐字不变。
    appendTaskOutput(task.id, "ordinary crash\nsome stack trace\n");

    expect(await reconcileOrphanTasks(orphanDb)).toBe(1);
    const row = await findTask(task.id);
    expect(row?.status).toBe("failed");
    const summary = row?.diffSummary as Record<string, unknown>;
    expect(summary.error).toBe(
      `executor pid ${task.executorPid} no longer exists`,
    );
    expect(summary.reconciledReason).toBe(
      `executor pid ${task.executorPid} no longer exists`,
    );
    expect(typeof summary.reconciledAt).toBe("string");
    expect(Number.isNaN(Date.parse(String(summary.reconciledAt)))).toBe(false);
    // 非额度路径不写冷却字段、不进入冷却。
    expect(summary.executorCooldownEndMs).toBeUndefined();
    expect(isInCooldown({ key: "codebuddy" })).toBe(false);
  });

  it("额度关键词在输出前部但不在尾部 20 行 → 不命中(R2 防误判)", async () => {
    const participant = await registerParticipant({ name: "orc-quota-d" });
    const group = await createGroup(participant.id, "孤儿收敛-额度前部");
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorKey: "codebuddy",
      executorPid: deadPid(),
    });
    // 关键词只在最前面,尾部 20 行全部是普通输出。
    const lines = [
      "You've hit your usage limit",
      ...Array.from({ length: 25 }, (_, i) => `line ${i}`),
    ];
    appendTaskOutput(task.id, `${lines.join("\n")}\n`);

    expect(await reconcileOrphanTasks(orphanDb)).toBe(1);
    const summary = (await findTask(task.id))?.diffSummary as Record<
      string,
      unknown
    >;
    expect(summary.error).toBe(
      `executor pid ${task.executorPid} no longer exists`,
    );
    expect(summary.executorCooldownEndMs).toBeUndefined();
    expect(isInCooldown({ key: "codebuddy" })).toBe(false);
  });

  it("额度收敛后该执行器冷却中不可用,其他执行器不受影响(可改派前提)", async () => {
    const participant = await registerParticipant({ name: "orc-quota-e" });
    const group = await createGroup(participant.id, "孤儿收敛-冷却改派");
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: participant.id,
      executorKey: "codebuddy",
      executorPid: deadPid(),
    });
    appendTaskOutput(
      task.id,
      "You've hit your usage limit. try again at 7:50 PM\n",
    );
    const now = new Date(2026, 7, 29, 10, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      await reconcileOrphanTasks(orphanDb, now);
      // 冷却中的执行器不可用(isInCooldown true → 调度层跳过它)。
      expect(isInCooldown({ key: "codebuddy" })).toBe(true);
      // 其他健康执行器不在冷却 → 存在可改派对象(与 executor-quota-redispatch
      // 的「角色定向改派」用例衔接:调度层只跳过冷却执行器)。
      expect(isInCooldown({ key: "codex" })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
