import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  dispatchIntent as dispatchIntentTable,
  executorConfig as executorConfigTable,
  groupMember as groupMemberTable,
  groupMessage as groupMessageTable,
  groups as groupsTable,
  participant as participantTable,
  taskCompletionEvent as taskCompletionEventTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import {
  __resetExecutorQueueForTests,
  __setMaxConcurrentPerWorkspaceForTests,
  __setReliabilityTimeoutsForTests,
  reclaimQueuedTasks,
  startQueuedTaskReclaim,
} from "@server/lib/executor-task";
import { findExecutorByKey } from "@server/lib/executors";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { DataBase } from "../src/lib/database";
import { enqueueTaskRun, enterCooldown } from "../src/lib/executor-task/queue";
import {
  executorCooldownRecords,
  executorCooldowns,
} from "../src/lib/executor-task/state";
import { seedBuiltinExecutorConfigs, testDb } from "./db";
import { resolveFakeExecutor, withFakeExecutorArgs } from "./fake-executor-bin";

/**
 * queued 任务周期兜底(specs/queued-task-never-picked-up-after-chain-failure.md
 * R1/R2/R3)。
 *
 * 用 fake bin 做集成测试(与 executor-queue.test.ts 同款):
 * EXECUTOR_BIN_CODEBUDDY 指向临时脚本,FAKE_SLEEP_SECS 让执行器进程保持存活
 * 3 秒 —— 「槽位被占用」这类判定因此在测试里可稳定观察,而不是靠 sleep 猜。
 *
 * 覆盖:
 *  - 验收1(R1):协调链条中断遗留的 queued 子任务(直接建行、从未进过内存队列)
 *    在 stallAlert 阈值内被拾起并执行 —— **断言带时限**,「最终跑了」不算通过;
 *  - 验收2(R2):执行方不可用 / 查无执行器配置 / 槽位被占 → diffSummary 记录
 *    原因与时刻,且任务 API(详情 + 列表)原样透出;
 *  - 验收3(R3):滞留超过 stallAlert 阈值 → ⚠️ 群公告 + 定向交回协调者,
 *    每个任务只告警一次;
 *  - 周期驱动与开关;同一任务被登记两次时只 spawn 一次。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-queued-reclaim-"));
const fakeScript = path.join(fakeDir, "fake-exec.sh");
writeFileSync(
  fakeScript,
  [
    "#!/bin/sh",
    'if [ -n "$FAKE_SLEEP_SECS" ]; then sleep "$FAKE_SLEEP_SECS"; fi',
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:子任务完成"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeScript, 0o755);
const { bin: fakeBin, argsPrefix: fakeArgsPrefix } =
  resolveFakeExecutor(fakeScript);
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;
// 执行器进程保持存活 3s:槽位占用/并发判定在测试内可稳定观察。
process.env.FAKE_SLEEP_SECS = "3";

// env 覆盖先于 app 动态 import(与 executor-a2a-reliability.test.ts 同款)。
const { createTestApp } = await import("./app");

/** R1/R3 的判定阈值(测试用 3s,远小于生产 15 分钟)。 */
const STALL_ALERT_MS = 3_000;

/** 回收宽限期 30s;测试里的「遗留任务」一律发布时间远早于它。 */
const LEGACY_AGE_MS = 40 * 60_000;

// PGlite 与 node-postgres 的 drizzle 实例驱动类型不兼容(与 orphan-task-
// reconciler.test.ts 同款 cast)。
const reclaimDb = testDb as unknown as DataBase;

type Task = typeof taskTable.$inferSelect;

beforeAll(async () => {
  await seedBuiltinExecutorConfigs();
  // win32: EXECUTOR_BIN 只覆盖 bin;把脚本路径拼进 args 最前面,原占位参数顺序不变。
  if (fakeArgsPrefix.length > 0) {
    const [row] = await testDb
      .select()
      .from(executorConfigTable)
      .where(eq(executorConfigTable.key, "codebuddy"));
    if (row) {
      await testDb
        .update(executorConfigTable)
        .set({ args: withFakeExecutorArgs(fakeArgsPrefix, row.args ?? []) })
        .where(eq(executorConfigTable.key, "codebuddy"));
    }
  }
});

beforeEach(async () => {
  // 先清模块级状态(队列/冷却/阈值),再置本文件统一的时间阈值,最后清库。
  __resetExecutorQueueForTests();
  // stall/claim 放宽到 60s(不干扰本票断言),stallAlert 取 3s 作为滞留阈值。
  __setReliabilityTimeoutsForTests(60_000, 60_000, STALL_ALERT_MS);
  // dispatch_intent(0031)对 task / group_message / participant / groups 都有外键,
  // 必须先清,否则下面的 delete 会被约束挡住,整个 beforeEach 连带失败。
  await testDb.delete(dispatchIntentTable);
  await testDb.delete(taskCompletionEventTable);
  await testDb.delete(groupMessageTable);
  await testDb.delete(taskTable);
  await testDb.delete(groupMemberTable);
  await testDb.delete(groupsTable);
  await testDb.delete(participantTable);
});

afterAll(() => {
  rmSync(fakeDir, { recursive: true, force: true });
});

describe("queued 任务周期兜底(链条失败遗留)", () => {
  const app = createTestApp();

  async function registerParticipant(name: string, executorKey?: string) {
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    if (executorKey) {
      await testDb
        .update(participantTable)
        .set({ executorKey })
        .where(eq(participantTable.id, id));
    }
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

  /** 生成一个已退出进程的 pid(process.kill(pid,0) → ESRCH)。 */
  function deadPid(): number {
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
      timeout: 5_000,
    });
    return child.pid;
  }

  /** 协调链条中断的形态:父协调任务进程已退出,子任务停在 queued。 */
  async function insertCoordinatorTask(
    groupId: string,
    executorParticipantId: string,
  ) {
    const [inserted] = await testDb
      .insert(taskTable)
      .values({
        groupId,
        executorParticipantId,
        messageId: uuidv4(),
        executorPid: deadPid(),
        executorKey: null,
        status: "running",
        createdAt: new Date(Date.now() - LEGACY_AGE_MS),
      })
      .returning();
    return inserted as Task;
  }

  /**
   * 直接构造 queued 子任务行 —— **不经过任何入队路径**,即链条中途失败后遗留
   * 的形态(本进程内存队列里没有它)。这是验收1 要求复现的场景,不能用「新建
   * 一条 queued 任务再走派发」来替代。
   */
  async function insertLeftoverQueuedTask(row: {
    groupId: string;
    executorParticipantId: string;
    executorKey?: string | null;
    parentTaskId?: string | null;
    brief?: string;
    createdAt?: Date;
  }) {
    const [inserted] = await testDb
      .insert(taskTable)
      .values({
        groupId: row.groupId,
        executorParticipantId: row.executorParticipantId,
        parentTaskId: row.parentTaskId ?? null,
        messageId: uuidv4(),
        executorKey: row.executorKey ?? "codebuddy",
        status: "queued",
        brief: row.brief ?? "链条中断遗留的子任务:补上缺失的回归测试",
        createdAt: row.createdAt ?? new Date(Date.now() - LEGACY_AGE_MS),
      })
      .returning();
    return inserted as Task;
  }

  async function findTask(id: string) {
    return testDb.query.task.findFirst({
      where: (t, { eq: eqFn }) => eqFn(t.id, id),
    });
  }

  async function groupMessages(groupId: string) {
    return testDb.query.groupMessage.findMany({
      where: (t, { eq: eqFn }) => eqFn(t.groupId, groupId),
    });
  }

  /** 轮询等待条件成立;返回命中值,超时返回 undefined。 */
  async function waitUntil<T>(
    probe: () => Promise<T | undefined>,
    timeoutMs: number,
    stepMs = 25,
  ): Promise<T | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value !== undefined) return value;
      if (Date.now() >= deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  }

  function blockedOf(row: Task | undefined) {
    const summary = row?.diffSummary as Record<string, unknown> | null;
    return summary?.queuedBlocked as
      | { code: string; reason: string; at: string }
      | undefined;
  }

  // ---- 验收1(R1):遗留 queued 子任务在阈值内被拾起并执行 ----

  it("链条中断遗留的 queued 子任务 → 在 stallAlert 阈值内被拾起并执行(带时限断言)", async () => {
    const coordinator = await registerParticipant("qr-chain-coord");
    const group = await createGroup(coordinator.id, "queued兜底-链条中断");
    const executor = await registerParticipant("qr-chain-exec", "codebuddy");
    const parent = await insertCoordinatorTask(group.id, coordinator.id);
    // 子任务从未进入本进程内存队列(直接建行):正是协调链条中途失败后遗留的
    // 形态 —— 队列泵看不到它,只有回收扫描能补回。
    const child = await insertLeftoverQueuedTask({
      groupId: group.id,
      executorParticipantId: executor.id,
      parentTaskId: parent.id,
    });
    expect((await findTask(child.id))?.status).toBe("queued");

    const stop = startQueuedTaskReclaim(reclaimDb, 50);
    try {
      const startedAt = Date.now();
      const picked = await waitUntil(async () => {
        const row = await findTask(child.id);
        // attempts 由 runOne 在 spawn 前落库:非空 = 已被拾起并真正开始执行。
        return Array.isArray(row?.attempts) && row.attempts.length > 0
          ? row
          : undefined;
      }, STALL_ALERT_MS);
      expect(
        picked,
        `queued 任务须在 ${STALL_ALERT_MS}ms 内被拾起`,
      ).toBeDefined();
      expect(Date.now() - startedAt).toBeLessThan(STALL_ALERT_MS);
      expect(picked?.status).not.toBe("queued");
    } finally {
      stop();
    }
  });

  it("已在内存队列中的 queued 任务不被重复补回(回收只补内存里没有的)", async () => {
    const coordinator = await registerParticipant("qr-nodup-coord");
    const group = await createGroup(coordinator.id, "queued兜底-不重复补回");
    const executor = await registerParticipant("qr-nodup-exec", "codebuddy");
    const child = await insertLeftoverQueuedTask({
      groupId: group.id,
      executorParticipantId: executor.id,
    });

    expect((await reclaimQueuedTasks(reclaimDb)).reclaimed).toBe(1);
    // 已在内存队列 → 第二轮不再补回(否则同一个任务会排队两次)。
    expect((await reclaimQueuedTasks(reclaimDb)).reclaimed).toBe(0);
    expect((await findTask(child.id))?.status).not.toBe("queued");
  });

  // ---- 验收2(R2):不可拾起的原因可见,且任务 API 透出 ----

  it("执行方处于额度冷却 → diffSummary 记录原因与时刻,任务 API(详情+列表)原样透出", async () => {
    const coordinator = await registerParticipant("qr-cd-coord");
    const group = await createGroup(coordinator.id, "queued兜底-冷却");
    const executor = await registerParticipant("qr-cd-exec", "codebuddy");
    const child = await insertLeftoverQueuedTask({
      groupId: group.id,
      executorParticipantId: executor.id,
    });
    // 人为让执行方不可用:进入额度冷却(与既有调度判定同源)。
    enterCooldown(
      { key: "codebuddy", label: "codebuddy" },
      Date.now() + 600_000,
    );

    const result = await reclaimQueuedTasks(reclaimDb);
    expect(result.reclaimed).toBe(1);

    const row = await findTask(child.id);
    const blocked = blockedOf(row);
    expect(blocked?.code).toBe("executor-cooldown");
    expect(blocked?.reason).toContain("额度冷却");
    expect(Number.isNaN(Date.parse(String(blocked?.at)))).toBe(false);
    // 冷却中的任务没有被拾起:仍停在 queued,但不再是无声的排队。
    expect(row?.status).toBe("queued");

    // 任务 API 透出(详情 + 列表同一口径)。
    const detailRes = await app.request(
      `/api/groups/${group.id}/tasks/${child.id}`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as Record<string, unknown>;
    expect(
      (detail.diffSummary as Record<string, unknown>).queuedBlocked,
    ).toMatchObject({ code: "executor-cooldown" });

    const listRes = await app.request(`/api/groups/${group.id}/tasks`, {
      headers: { "X-Participant-Id": coordinator.id },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Record<string, unknown>[];
    const listed = list.find((item) => item.id === child.id);
    const listedSummary = (listed?.diffSummary ?? {}) as Record<
      string,
      unknown
    >;
    expect(listedSummary.queuedBlocked).toMatchObject({
      code: "executor-cooldown",
    });

    // 同因未变 → 不刷写(周期扫描每轮都会跑,首次观察时刻必须保住)。
    await reclaimQueuedTasks(reclaimDb);
    expect(blockedOf(await findTask(child.id))?.at).toBe(blocked?.at);
  });

  it("查无执行器配置(执行方缺失)→ 不补回,diffSummary 记录 executor-missing 与时刻", async () => {
    const coordinator = await registerParticipant("qr-missing-coord");
    const group = await createGroup(coordinator.id, "queued兜底-执行方缺失");
    const executor = await registerParticipant("qr-missing-exec");
    const child = await insertLeftoverQueuedTask({
      groupId: group.id,
      executorParticipantId: executor.id,
      executorKey: "no-such-executor",
    });

    const result = await reclaimQueuedTasks(reclaimDb);
    expect(result.reclaimed).toBe(0);
    const row = await findTask(child.id);
    const blocked = blockedOf(row);
    expect(blocked?.code).toBe("executor-missing");
    expect(blocked?.reason).toContain("不在执行器配置中");
    expect(Number.isNaN(Date.parse(String(blocked?.at)))).toBe(false);
    expect(row?.status).toBe("queued");
  });

  it("同组两个遗留 queued 任务 → 队首被拾起,队二记录槽位原因(R2 槽位)", async () => {
    const coordinator = await registerParticipant("qr-slot-coord");
    const group = await createGroup(coordinator.id, "queued兜底-槽位");
    const executor = await registerParticipant("qr-slot-exec", "codebuddy");
    const first = await insertLeftoverQueuedTask({
      groupId: group.id,
      executorParticipantId: executor.id,
      brief: "子任务一",
      createdAt: new Date(Date.now() - LEGACY_AGE_MS - 1_000),
    });
    const second = await insertLeftoverQueuedTask({
      groupId: group.id,
      executorParticipantId: executor.id,
      brief: "子任务二",
      createdAt: new Date(Date.now() - LEGACY_AGE_MS),
    });

    expect((await reclaimQueuedTasks(reclaimDb)).reclaimed).toBe(2);

    // 队首:被拾起并开始执行(默认组单槽 → 第二个只能等)。
    const firstRow = await findTask(first.id);
    expect(Array.isArray(firstRow?.attempts)).toBe(true);
    expect((firstRow?.attempts ?? []).length).toBeGreaterThan(0);

    // 队二:槽位被占 → 原因可见,不是无声排队。
    const secondRow = await findTask(second.id);
    expect(secondRow?.status).toBe("queued");
    const blocked = blockedOf(secondRow);
    expect(blocked?.code).toBe("workspace-gate");
    expect(blocked?.reason).toContain("默认组单槽");
  });

  it("阻塞原因消失(冷却到期)→ 清掉 queuedBlocked 旧标记,不留过期原因", async () => {
    const coordinator = await registerParticipant("qr-clear-coord");
    const group = await createGroup(coordinator.id, "queued兜底-原因清除");
    const executor = await registerParticipant("qr-clear-exec", "codebuddy");
    const child = await insertLeftoverQueuedTask({
      groupId: group.id,
      executorParticipantId: executor.id,
      brief: "冷却阻塞,到期后原因应被清除",
    });
    // 人为让执行方不可用 → 补回队列但不可拾起,原因记录进 diffSummary。
    enterCooldown(
      { key: "codebuddy", label: "codebuddy" },
      Date.now() + 600_000,
    );
    expect((await reclaimQueuedTasks(reclaimDb)).reclaimed).toBe(1);
    expect(blockedOf(await findTask(child.id))?.code).toBe("executor-cooldown");

    // 冷却到期(与到期定时器同义:清掉冷却记录)→ 该任务变为可派发,
    // 旧原因不再是事实,必须清掉,否则界面继续显示一个已不存在的阻塞。
    // 泵只在入队/终态事件触发,回收扫描不泵送 → 任务此时仍停在 queued,
    // 清除路径恰好在这个窗口可见。
    executorCooldowns.delete("codebuddy");
    executorCooldownRecords.delete("codebuddy");
    await reclaimQueuedTasks(reclaimDb);
    const row = await findTask(child.id);
    expect(row?.status).toBe("queued");
    expect(blockedOf(row)).toBeUndefined();
  });

  // ---- 验收3(R3):超阈值按 stall 处置,不静默 ----

  it("滞留超过 stallAlert 阈值 → ⚠️ 群公告 + 定向交回协调者,且只告警一次", async () => {
    const coordinator = await registerParticipant("qr-stall-coord");
    const group = await createGroup(coordinator.id, "queued兜底-滞留告警");
    const executor = await registerParticipant("qr-stall-exec", "codebuddy");
    const child = await insertLeftoverQueuedTask({
      groupId: group.id,
      executorParticipantId: executor.id,
    });
    // 执行方冷却 → 补回队列后仍无法拾起,构成真正的滞留。
    enterCooldown(
      { key: "codebuddy", label: "codebuddy" },
      Date.now() + 600_000,
    );

    const result = await reclaimQueuedTasks(reclaimDb);
    expect(result.reclaimed).toBe(1);
    expect(result.stalled).toBe(1);

    const row = await findTask(child.id);
    const summary = row?.diffSummary as Record<string, unknown>;
    // 复用既有 stallAlerted 警示标记(任务面板黄标同款呈现)。
    expect(summary.stallAlerted).toBe(true);
    expect(summary.queuedStallAlerted).toBe(true);
    expect(typeof summary.queuedStallAlertAt).toBe("string");
    expect(Number.isNaN(Date.parse(String(summary.queuedStallAlertAt)))).toBe(
      false,
    );
    expect(summary.queuedStallAlertMinutes).toBe(1);

    const messages = await groupMessages(group.id);
    // 不静默之一:群公告(broadcast)。
    const broadcast = messages.filter(
      (m) => m.audience === "broadcast" && m.body.includes(child.id),
    );
    expect(broadcast.length).toBeGreaterThan(0);
    expect(broadcast.some((m) => m.body.startsWith("⚠️"))).toBe(true);
    // 不静默之二:定向交回协调者(角色定向投递)。
    const handoff = messages.filter(
      (m) => m.audience === "role" && m.audienceRef === "coordinator",
    );
    expect(handoff.length).toBe(1);
    expect(handoff[0].body).toContain(child.id);
    expect(handoff[0].body).toContain("额度冷却");

    // 只告警一次:后续扫描不再重复发消息、不再重复置标记。
    const again = await reclaimQueuedTasks(reclaimDb);
    expect(again.stalled).toBe(0);
    const after = await groupMessages(group.id);
    expect(after.filter((m) => m.audience === "role").length).toBe(1);
    expect(after.length).toBe(messages.length);
  });

  // ---- 周期驱动与开关 ----

  it("startQueuedTaskReclaim:一个周期内完成回收,stop 后停止", async () => {
    const coordinator = await registerParticipant("qr-timer-coord");
    const group = await createGroup(coordinator.id, "queued兜底-周期");
    const executor = await registerParticipant("qr-timer-exec", "codebuddy");
    const child = await insertLeftoverQueuedTask({
      groupId: group.id,
      executorParticipantId: executor.id,
    });
    // 冷却态:可被补回但不会被 spawn,断言不与时延/进程退出竞态。
    enterCooldown(
      { key: "codebuddy", label: "codebuddy" },
      Date.now() + 600_000,
    );

    vi.useFakeTimers();
    let stop: () => void = () => {};
    try {
      stop = startQueuedTaskReclaim(reclaimDb, 50);
      await vi.advanceTimersByTimeAsync(50);
      expect(blockedOf(await findTask(child.id))?.code).toBe(
        "executor-cooldown",
      );

      const second = await insertLeftoverQueuedTask({
        groupId: group.id,
        executorParticipantId: executor.id,
        brief: "stop 之后插入的任务",
      });
      stop();
      await vi.advanceTimersByTimeAsync(200);
      expect(blockedOf(await findTask(second.id))).toBeUndefined();
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("startQueuedTaskReclaim 显式开关 enabled:false → 不注册定时器;显式调用仍回收", async () => {
    const coordinator = await registerParticipant("qr-off-coord");
    const group = await createGroup(coordinator.id, "queued兜底-开关关闭");
    const executor = await registerParticipant("qr-off-exec", "codebuddy");
    const child = await insertLeftoverQueuedTask({
      groupId: group.id,
      executorParticipantId: executor.id,
    });

    vi.useFakeTimers();
    try {
      const stop = startQueuedTaskReclaim(reclaimDb, 50, { enabled: false });
      await vi.advanceTimersByTimeAsync(200);
      expect(blockedOf(await findTask(child.id))).toBeUndefined();
      expect(stop()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }

    // 纯函数路径不受开关影响。
    expect((await reclaimQueuedTasks(reclaimDb)).reclaimed).toBe(1);
  });

  // ---- 重复登记守卫:同一任务只 spawn 一次 ----

  it("同一任务被登记两个 run(回收与派发竞态)→ 只 spawn 一次", async () => {
    const coordinator = await registerParticipant("qr-race-coord");
    const group = await createGroup(coordinator.id, "queued兜底-重复登记");
    const executor = await registerParticipant("qr-race-exec", "codebuddy");
    const child = await insertLeftoverQueuedTask({
      groupId: group.id,
      executorParticipantId: executor.id,
    });
    // 让同一工作树容纳两个并发 run,两个 run 会在同一轮泵送里一起出队。
    await testDb
      .update(groupsTable)
      .set({ projectPath: process.env.COAGENTHUB_REPO_ROOT ?? null })
      .where(eq(groupsTable.id, group.id));
    __setMaxConcurrentPerWorkspaceForTests(2);
    const config = await findExecutorByKey(reclaimDb, "codebuddy");
    const row = await findTask(child.id);
    expect(config).toBeDefined();
    expect(row).toBeDefined();
    if (!row || !config) return;
    const opts = {
      groupId: group.id,
      messageId: child.messageId,
      participantId: executor.id,
      ex: config,
      body: child.brief ?? "",
      groupPrompt: null,
      specRef: null,
      specHash: null,
    };
    // 同一任务入队两次(模拟回收扫描与派发落在同一窗口)。
    await enqueueTaskRun(reclaimDb, row, opts);
    await enqueueTaskRun(reclaimDb, row, opts);

    // 两个 run 一起出队 → 第二个被守卫丢弃:只落一条 attempt(只 spawn 一次)。
    const started = await waitUntil(async () => {
      const current = await findTask(child.id);
      return Array.isArray(current?.attempts) && current.attempts.length > 0
        ? current
        : undefined;
    }, 2_000);
    expect(started).toBeDefined();
    // 给第二个 run 足够时间(它也已出队)证明它没有再 spawn 一次。
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(((await findTask(child.id))?.attempts ?? []).length).toBe(1);
  });
});
