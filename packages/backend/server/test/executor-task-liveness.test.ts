import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";
import type { DataBase } from "../src/lib/database";
import {
  appendTaskOutput,
  releaseTaskOutput,
} from "../src/lib/executor-task/output-buffer";
import {
  clearRunTimers,
  getStallAlertMs,
  getStallTimeoutMs,
} from "../src/lib/executor-task/state";
import type { QueuedRun } from "../src/lib/executor-task/types";
// 读时求值纯函数(specs/executor-task-liveness.md R1/R2):running 非协调任务
// 由 createdAt/updatedAt/taskOutputUpdatedAt 的最大值派生 lastSignalAt,
// 阈值直接取 stallTimeoutMinutes(getStallTimeoutMs),不新增配置。
import { getExecutorTaskLiveness } from "../src/lib/executor-task-liveness";
import { createTestApp } from "./app";
import { testDb } from "./db";

// PGlite 与 node-postgres 的 drizzle 实例驱动类型不兼容(与 executor-trigger /
// executor-queue 同款 cast);纯函数只走共享的 query API。
const livenessDb = testDb as unknown as DataBase;

type Task = typeof taskTable.$inferSelect;

/**
 * 执行器任务存活探测(specs/executor-task-liveness.md):对 status=running 且
 * 非协调任务(isDetachedTask 为假)读详情时派生 liveness 字段;阈值复用
 * stallTimeoutMinutes;只报不拦(不改 status);内存计时器机制原样保留。
 * 重启无关性直接构造数据验证纯函数(不依赖真实重启,见 spec 执行环境提示)。
 */
describe("执行器任务存活探测(读时求值)", () => {
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

  async function postMessage(
    participantId: string,
    groupId: string,
    body: string,
  ) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  async function createTask(
    participantId: string,
    groupId: string,
    messageId: string,
    executorParticipantId: string,
  ) {
    return app.request(`/api/groups/${groupId}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify({ messageId, executorParticipantId }),
    });
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

  /** 群 + 协调者 + 两名执行器参与者(执行器参与者不加入群成员 → 非协调任务)。 */
  async function setupGroup() {
    const coordinator = await registerParticipant({ name: "el-coord-mac" });
    const execA = await registerParticipant({ name: "el-executor-a" });
    const group = await createGroup(coordinator.id, "执行器存活探测测试");
    return { coordinator, execA, group };
  }

  /** 直接构造 running 任务行(不经过队列/计时器),供纯函数验证重启无关性。 */
  async function insertTaskRow(row: {
    groupId: string;
    executorParticipantId: string;
    status?: Task["status"];
    createdAt?: Date;
    updatedAt?: Date | null;
    brief?: string | null;
  }) {
    const base = new Date("2026-08-24T10:00:00.000Z");
    const [inserted] = await testDb
      .insert(taskTable)
      .values({
        groupId: row.groupId,
        executorParticipantId: row.executorParticipantId,
        messageId: uuidv4(),
        status: row.status ?? "running",
        brief: row.brief ?? null,
        createdAt: row.createdAt ?? base,
        updatedAt: row.updatedAt ?? base,
      })
      .returning();
    return inserted as Task;
  }

  // ---- 纯函数:重启无关,直接构造数据验证(核心价值,必测) ----

  it("纯函数:running 非协调任务超阈值 → warning:true,lastSignalAt 取信号最大值", async () => {
    const { execA, group } = await setupGroup();
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: execA.id,
      status: "running",
    });
    // 信号时间回拨 31 分钟(阈值 30min) → 应判定为失联。
    const stale = new Date("2026-08-24T09:30:00.000Z");
    await testDb
      .update(taskTable)
      .set({ createdAt: stale, updatedAt: stale })
      .where(eq(taskTable.id, task.id));
    const freshRow = await testDb.query.task.findFirst({
      where: (t, { eq: eqFn }) => eqFn(t.id, task.id),
    });
    const now = new Date("2026-08-24T10:01:00.000Z");

    const result = await getExecutorTaskLiveness(
      livenessDb,
      freshRow as Task,
      now,
    );
    expect(result).toEqual({
      warning: true,
      lastSignalAt: stale.toISOString(),
    });
  });

  it("纯函数:updatedAt 在阈值内 → warning:false", async () => {
    const { execA, group } = await setupGroup();
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: execA.id,
      status: "running",
    });
    // createdAt 很早,但 updatedAt 在阈值内 → 不应误报。
    await testDb
      .update(taskTable)
      .set({
        createdAt: new Date("2026-08-24T08:00:00.000Z"),
        updatedAt: new Date("2026-08-24T10:00:30.000Z"),
      })
      .where(eq(taskTable.id, task.id));
    const freshRow = await testDb.query.task.findFirst({
      where: (t, { eq: eqFn }) => eqFn(t.id, task.id),
    });
    const now = new Date("2026-08-24T10:10:00.000Z");

    const result = await getExecutorTaskLiveness(
      livenessDb,
      freshRow as Task,
      now,
    );
    expect(result?.warning).toBe(false);
    expect(result?.lastSignalAt).toBe("2026-08-24T10:00:30.000Z");
  });

  it("纯函数:outputTail 更新时间晚于 createdAt/updatedAt → lastSignalAt 取输出时间", async () => {
    const { execA, group } = await setupGroup();
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: execA.id,
      status: "running",
    });
    await testDb
      .update(taskTable)
      .set({
        createdAt: new Date("2026-08-24T08:00:00.000Z"),
        updatedAt: new Date("2026-08-24T08:30:00.000Z"),
      })
      .where(eq(taskTable.id, task.id));
    // 进程本地输出时间晚于两个 db 时间戳 → 应作为存活信号取最大值。
    appendTaskOutput(task.id, "仍在工作");
    try {
      const freshRow = await testDb.query.task.findFirst({
        where: (t, { eq: eqFn }) => eqFn(t.id, task.id),
      });
      const now = new Date();
      const result = await getExecutorTaskLiveness(
        livenessDb,
        freshRow as Task,
        now,
      );
      expect(result?.warning).toBe(false);
      expect(result?.lastSignalAt).not.toBe("2026-08-24T08:30:00.000Z");
    } finally {
      releaseTaskOutput(task.id);
    }
  });

  it("纯函数:协调任务(brief 含 ReplyMode: detached)不派生 → null", async () => {
    const { coordinator, group } = await setupGroup();
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: coordinator.id,
      status: "running",
      brief: "协调任务\n## ReplyMode: detached\n等执行器回写",
    });
    const now = new Date("2026-08-24T11:00:00.000Z");
    const result = await getExecutorTaskLiveness(livenessDb, task, now);
    expect(result).toBeNull();
  });

  it("纯函数:非 running(queued/done)→ 不派生 → null", async () => {
    const { execA, group } = await setupGroup();
    const queued = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: execA.id,
      status: "queued",
    });
    const done = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: execA.id,
      status: "done",
    });
    const now = new Date("2026-08-24T11:00:00.000Z");
    expect(await getExecutorTaskLiveness(livenessDb, queued, now)).toBeNull();
    expect(await getExecutorTaskLiveness(livenessDb, done, now)).toBeNull();
  });

  it("纯函数:同一输入 + 同一 now 结果恒定(不依赖内存态,重启后判定不变)", async () => {
    const { execA, group } = await setupGroup();
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: execA.id,
      status: "running",
    });
    const stale = new Date("2026-08-24T09:20:00.000Z");
    await testDb
      .update(taskTable)
      .set({ createdAt: stale, updatedAt: stale })
      .where(eq(taskTable.id, task.id));
    const rowA = await testDb.query.task.findFirst({
      where: (t, { eq: eqFn }) => eqFn(t.id, task.id),
    });
    // 模拟重启:重新从 db 取同一行(内存计时器若存在也已全部消失)。
    const rowB = await testDb.query.task.findFirst({
      where: (t, { eq: eqFn }) => eqFn(t.id, task.id),
    });
    const now = new Date("2026-08-24T10:05:00.000Z");

    const resultA = await getExecutorTaskLiveness(
      livenessDb,
      rowA as Task,
      now,
    );
    const resultB = await getExecutorTaskLiveness(
      livenessDb,
      rowB as Task,
      now,
    );
    expect(resultA).toEqual(resultB);
    expect(resultB).toEqual({
      warning: true,
      lastSignalAt: stale.toISOString(),
    });
  });

  it("纯函数:阈值边界 —— lastSignal 恰在阈值内 false、刚超阈值 true", async () => {
    const { execA, group } = await setupGroup();
    const task = await insertTaskRow({
      groupId: group.id,
      executorParticipantId: execA.id,
      status: "running",
    });
    const base = new Date("2026-08-24T10:00:00.000Z");
    await testDb
      .update(taskTable)
      .set({ createdAt: base, updatedAt: base })
      .where(eq(taskTable.id, task.id));
    const row = await testDb.query.task.findFirst({
      where: (t, { eq: eqFn }) => eqFn(t.id, task.id),
    });
    const threshold = getStallTimeoutMs();
    // 恰在阈值上 → 未超过 → false;超 1ms → true。
    const atThreshold = new Date(base.getTime() + threshold);
    const justOver = new Date(base.getTime() + threshold + 1);
    expect(
      (await getExecutorTaskLiveness(livenessDb, row as Task, atThreshold))
        ?.warning,
    ).toBe(false);
    expect(
      (await getExecutorTaskLiveness(livenessDb, row as Task, justOver))
        ?.warning,
    ).toBe(true);
  });

  // ---- 路由:GET 任务详情派生 liveness 字段 ----

  it("GET 单任务:running 执行器任务超阈值 → liveness.warning:true,status 不变", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const message = await postMessage(coordinator.id, group.id, "执行器任务");
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      execA.id,
    );
    const task = (await created.json()) as Task;
    expect(
      (
        await patchTask(execA.id, group.id, task.id, {
          status: "running",
        })
      ).status,
    ).toBe(200);

    const stale = new Date(Date.now() - getStallTimeoutMs() - 1000);
    await testDb
      .update(taskTable)
      .set({ createdAt: stale, updatedAt: stale })
      .where(eq(taskTable.id, task.id));

    const response = await app.request(
      `/api/groups/${group.id}/tasks/${task.id}`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    const detail = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(detail.status).toBe("running");
    expect(detail.liveness).toEqual({
      warning: true,
      lastSignalAt: stale.toISOString(),
    });
    // R4:判定不修改 task.status —— db 行仍是 running。
    const row = await testDb.query.task.findFirst({
      where: (t, { eq: eqFn }) => eqFn(t.id, task.id),
    });
    expect(row?.status).toBe("running");
    // 执行器任务不占用协调任务的 livenessWarning/lastSignalAt(保持原值 false/null)。
    expect(detail.livenessWarning).toBe(false);
    expect(detail.lastSignalAt).toBeNull();
  });

  it("GET 单任务:outputTail 更新在阈值内 → liveness.warning:false", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const message = await postMessage(coordinator.id, group.id, "输出中的任务");
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      execA.id,
    );
    const task = (await created.json()) as Task;
    await patchTask(execA.id, group.id, task.id, { status: "running" });
    const stale = new Date(Date.now() - getStallTimeoutMs() - 1000);
    await testDb
      .update(taskTable)
      .set({ createdAt: stale, updatedAt: stale })
      .where(eq(taskTable.id, task.id));
    appendTaskOutput(task.id, "仍在工作");

    try {
      const response = await app.request(
        `/api/groups/${group.id}/tasks/${task.id}`,
        { headers: { "X-Participant-Id": coordinator.id } },
      );
      const detail = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect((detail.liveness as { warning: boolean }).warning).toBe(false);
      expect(
        new Date(
          String((detail.liveness as { lastSignalAt: string }).lastSignalAt),
        ).getTime(),
      ).toBeGreaterThan(stale.getTime());
    } finally {
      releaseTaskOutput(task.id);
    }
  });

  it("GET 单任务:协调任务不输出 liveness 字段,保留既有 livenessWarning(回归)", async () => {
    const { coordinator, group } = await setupGroup();
    const message = await postMessage(coordinator.id, group.id, "悬空协调任务");
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      coordinator.id,
    );
    const task = (await created.json()) as Task;
    expect(
      (
        await patchTask(coordinator.id, group.id, task.id, {
          status: "running",
        })
      ).status,
    ).toBe(200);
    const stale = new Date(Date.now() - getStallTimeoutMs() - 1000);
    await testDb
      .update(taskTable)
      .set({ createdAt: stale, updatedAt: stale })
      .where(eq(taskTable.id, task.id));

    const response = await app.request(
      `/api/groups/${group.id}/tasks/${task.id}`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    const detail = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    // 协调任务:不输出 liveness(它走既有 livenessWarning/lastSignalAt)。
    expect("liveness" in detail).toBe(false);
    expect(detail.livenessWarning).toBe(true);
    expect(detail.lastSignalAt).toBe(stale.toISOString());
  });

  it("GET 单任务:非 running(queued)不输出 liveness 字段", async () => {
    const { coordinator, execA, group } = await setupGroup();
    const message = await postMessage(coordinator.id, group.id, "排队中任务");
    const created = await createTask(
      coordinator.id,
      group.id,
      message.id,
      execA.id,
    );
    const task = (await created.json()) as Task;
    expect(task.status).toBe("queued");

    const response = await app.request(
      `/api/groups/${group.id}/tasks/${task.id}`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    const detail = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect("liveness" in detail).toBe(false);
  });

  // ---- 内存计时器机制契约(R3 回归:未删除未改动) ----

  it("clearRunTimers 仍清空 stallTimer/stallAlertTimer(内存计时器机制保留)", () => {
    const run = {
      claimTimer: setTimeout(() => undefined, 1000),
      stallTimer: setTimeout(() => undefined, 1000),
      stallAlertTimer: setTimeout(() => undefined, 1000),
      a2aSilenceTimer: setTimeout(() => undefined, 1000),
    } as unknown as QueuedRun;
    clearRunTimers(run);
    expect(run.stallTimer).toBeNull();
    expect(run.stallAlertTimer).toBeNull();
    expect(run.claimTimer).toBeNull();
    expect(run.a2aSilenceTimer).toBeNull();
  });

  it("阈值仍取默认 stallTimeoutMinutes=30 / stallAlertMinutes=15(未新增配置项)", () => {
    // 测试环境无 dispatch-policy.json/env 覆盖 → 走默认值;若新增了配置项,
    // 本断言会同 R2「阈值取自 stallTimeoutMinutes」一起暴露。
    expect(getStallTimeoutMs()).toBe(30 * 60_000);
    expect(getStallAlertMs()).toBe(15 * 60_000);
  });
});
