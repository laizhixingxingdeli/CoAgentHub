import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  executorConfig as executorConfigTable,
  participant as participantTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedBuiltinExecutorConfigs, testDb } from "./db";
import { resolveFakeExecutor, withFakeExecutorArgs } from "./fake-executor-bin";

/**
 * 瞬时限流走 per-run 退避、不进执行器级冷却
 * (specs/transient-ratelimit-escalated-to-long-cooldown.md):
 *  - 验收 1:`try again in 5 seconds` 这类短相对恢复提示 → transient,
 *    isInCooldown 为 false,该 run 退避短暂时间后重试(不判 failed);
 *  - 验收 2:`usage limit reached, resets around HH:MM` → exhausted,
 *    既有冷却行为不变(回归);
 *  - 验收 4:同一 run 连续 3 次 transient → 第 3 次按 exhausted 处理;
 *  - 验收 7:三处调用点(进程退出 / 成功尾部 / 执行超时)分流口径一致;
 *  - 验收 9:瞬时退避配置不可读 → fail-safe 回落 exhausted。
 *
 * fake bin 与 executor-quota-redispatch.test.ts 同款集成方式:
 * EXECUTOR_BIN_CODEBUDDY 指向可配置临时脚本,COAGENTHUB_REPO_ROOT 由
 * test/setup.ts 统一指向临时 git 仓库。
 *
 * 注意:测试 cwd 下无 scripts/dispatch-policy.json,readDispatchPolicy 回退默认
 * 策略(两个瞬时配置键为 null = 未启用)。每个用例按需显式调用
 * __setTransientQuotaForTests 启用,未启用即走 fail-safe 路径(验收 9 的现状)。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-transient-bin-"));
const fakeScript = path.join(fakeDir, "fake-codebuddy.sh");
writeFileSync(
  fakeScript,
  [
    "#!/bin/sh",
    // 瞬时限流(分级应判 transient):短相对恢复提示 + 提供方限流行形状。
    // 退出码由 FAKE_TRANSIENT_EXIT 控制(默认 1,验证「成功尾部」时传 0)。
    'if [ -n "$FAKE_TRANSIENT" ]; then',
    '  echo "[rate-limited] try again in 5 seconds"',
    '  exit ${FAKE_TRANSIENT_EXIT:-1}',
    "fi",
    // 额度耗尽(分级应判 exhausted):绝对恢复时刻。
    'if [ -n "$FAKE_EXHAUSTED" ]; then echo "usage limit reached — resets around 23:59"; exit 1; fi',
    // 执行超时分支:额度行写 stderr 后睡过超时阈值(管道 stdout 在 SIGKILL
    // 前可能未刷出,导致超时瞬间捕获不到关键词)。
    'if [ -n "$FAKE_TRANSIENT_TIMEOUT" ]; then echo "[rate-limited] try again in 5 seconds" >&2; sleep 5; exit 0; fi',
    // 默认:正常提交后退出 0(done 路径)。
    'git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake bin change"',
    'echo "提交: 0123456789abcdef0123456789abcdef01234567"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeScript, 0o755);
const { bin: fakeBin, argsPrefix: fakeArgsPrefix } =
  resolveFakeExecutor(fakeScript);
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;
// 执行超时分支的阈值(EXECUTOR_TIMEOUT_MS 在 spawn 时读取)。
process.env.EXECUTOR_TIMEOUT_MS = "2000";

// 顶层 await 动态 import:env 设置先于模块求值。
const { createTestApp } = await import("./app");
const {
  __resetExecutorQueueForTests,
  __setRateLimitForTests,
  __setTransientQuotaForTests,
  cooldownEndMs,
  executorCooldowns,
  groupQueues,
  isInCooldown,
} = await import("../src/lib/executor-task/state");

/** 与真实 scripts/dispatch-policy.json 的 detectPatterns 一致(默认关键词并集)。 */
const QUOTA_PATTERNS = [
  "rate limit",
  "rate-lim",
  "quota",
  "429",
  "额度",
  "次数限制",
  "limit reached",
  "too many requests",
  "window exhausted",
];

/** 固定冷却时长(ms)与瞬时退避(ms)/升级上限:测试用小值避免拖慢。 */
const COOLDOWN_MS = 300_000;
const BACKOFF_MS = 2_000;
const ESCALATION_LIMIT = 3;

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

describe("瞬时限流走 per-run 退避,不进执行器级冷却", () => {
  const app = createTestApp();

  beforeEach(async () => {
    __resetExecutorQueueForTests();
    __setRateLimitForTests(COOLDOWN_MS, QUOTA_PATTERNS);
    for (const key of [
      "FAKE_TRANSIENT",
      "FAKE_TRANSIENT_EXIT",
      "FAKE_TRANSIENT_TIMEOUT",
      "FAKE_EXHAUSTED",
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    __resetExecutorQueueForTests();
  });

  async function registerParticipant(name: string) {
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
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

  async function addMember(
    participantId: string,
    groupId: string,
    memberParticipantId: string,
    roles: string[],
  ) {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify({ participantId: memberParticipantId, roles }),
    });
    expect(res.status).toBe(200);
  }

  async function postMessage(
    participantId: string,
    groupId: string,
    body: Record<string, unknown>,
  ) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  /** 标准场景:协调者(群主)+ codebuddy 执行器成员就绪。 */
  async function setupGroup(title: string) {
    const coordinator = await registerParticipant(
      `transient-coord-${randomUUID()}`,
    );
    const codebuddy = await registerParticipant(
      `transient-exec-${randomUUID()}`,
    );
    await bindExecutorKey(codebuddy.id, "codebuddy");
    const group = await createGroup(coordinator.id, title);
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  async function dispatchTask(
    coordinator: { id: string },
    codebuddy: { id: string },
    group: { id: string },
  ) {
    const msg = await postMessage(coordinator.id, group.id, {
      body: "瞬时限流退避任务",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
      const rows = await testDb
        .select()
        .from(taskTable)
        .where(eq(taskTable.messageId, msg.id));
      if (rows.length > 0) return rows[0];
      if (Date.now() > deadline) throw new Error("任务未登记");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** 轮询任务行直到谓词成立(瞬时限流处置是异步的 fire-and-forget)。 */
  async function waitForTask(
    taskId: string,
    predicate: (t: typeof taskTable.$inferSelect) => boolean,
    timeoutMs = 20_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await testDb
        .select()
        .from(taskTable)
        .where(eq(taskTable.id, taskId));
      const t = rows[0];
      if (t && predicate(t)) return t;
      if (Date.now() > deadline) {
        throw new Error(
          `任务 ${taskId} 在 ${timeoutMs}ms 内未满足断言(当前状态=${
            t?.status ?? "无"
          })`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** 排队中 run 的 per-run 重试时刻(concurrencyRetryAt);不在队列中返回 null。 */
  function queuedRetryAt(taskId: string): number | null {
    for (const g of groupQueues.values()) {
      const run = g.queue.find((r) => r.taskId === taskId);
      if (run) return run.concurrencyRetryAt;
    }
    return null;
  }

  it("验收 1:进程退出(exit≠0)+ 短相对恢复提示 → transient,不进执行器级冷却,run 退避后重试", async () => {
    const { coordinator, codebuddy, group } = await setupGroup(
      "transient-exit-nonzero",
    );
    __setTransientQuotaForTests(BACKOFF_MS, ESCALATION_LIMIT);
    process.env.FAKE_TRANSIENT = "1";

    const created = await dispatchTask(coordinator, codebuddy, group);
    const t = await waitForTask(
      created.id,
      (row) => (row.attempts?.length ?? 0) >= 1 && row.status === "queued",
    );

    // 未进执行器级冷却:isInCooldown 保持「额度耗尽」单一语义。
    expect(isInCooldown({ key: "codebuddy" })).toBe(false);
    expect(executorCooldowns.has("codebuddy")).toBe(false);
    expect(cooldownEndMs({ key: "codebuddy" })).toBe(0);
    // 任务不判 failed:回写 queued,退避窗口后自动重试。
    expect(t.status).toBe("queued");
    const diff = t.diffSummary as Record<string, unknown> | null;
    expect(diff?.error).toBeUndefined();
    // per-run 退避时刻 ≈ 判定时刻 + transientBackoffSeconds。
    const retryAt = queuedRetryAt(t.id);
    expect(retryAt).not.toBeNull();
    const remaining = (retryAt ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(500);
    expect(remaining).toBeLessThanOrEqual(BACKOFF_MS);
    // R4 留痕:quotaKind 与命中行并列落库。
    expect(diff?.quotaKind).toBe("transient");
    expect(String(diff?.quotaMatchedLine)).toContain("try again in 5 seconds");
    // 本次 attempt 留痕(不是静默重试)。
    expect(String(t.attempts?.[0]?.error ?? "")).toContain("瞬时限流");
  }, 30_000);

  it("验收 2(回归):usage limit + resets around HH:MM → exhausted,冷却行为逐字不变", async () => {
    const { coordinator, codebuddy, group } = await setupGroup(
      "transient-exhausted-regression",
    );
    // 即便启用瞬时处置,耗尽行仍按 exhausted 走既有路径。
    __setTransientQuotaForTests(BACKOFF_MS, ESCALATION_LIMIT);
    process.env.FAKE_EXHAUSTED = "1";

    const created = await dispatchTask(coordinator, codebuddy, group);
    const t = await waitForTask(created.id, (row) => row.status === "failed");

    expect(t.status).toBe("failed");
    expect(isInCooldown({ key: "codebuddy" })).toBe(true);
    expect(t.attempts).toHaveLength(1);
    const diff = t.diffSummary as Record<string, unknown> | null;
    expect(diff?.retries).toBeUndefined();
    const err = String(diff?.error ?? "");
    expect(err).toContain("执行器额度限制");
    expect(err).toMatch(/预计 .+ 恢复/);
    expect(diff?.quotaKind).toBe("exhausted");
    expect(String(diff?.quotaMatchedLine)).toContain("usage limit reached");
    // 未走 per-run 退避:任务不在队列里。
    expect(queuedRetryAt(t.id)).toBeNull();
  }, 30_000);

  it("验收 7a:执行超时分支 → 与进程退出同口径(transient,不冷却)", async () => {
    const { coordinator, codebuddy, group } = await setupGroup(
      "transient-timeout",
    );
    __setTransientQuotaForTests(BACKOFF_MS, ESCALATION_LIMIT);
    process.env.FAKE_TRANSIENT_TIMEOUT = "1";

    const created = await dispatchTask(coordinator, codebuddy, group);
    const t = await waitForTask(
      created.id,
      (row) => (row.attempts?.length ?? 0) >= 1 && row.status === "queued",
    );

    expect(t.status).toBe("queued");
    expect(isInCooldown({ key: "codebuddy" })).toBe(false);
    const diff = t.diffSummary as Record<string, unknown> | null;
    expect(diff?.quotaKind).toBe("transient");
    const retryAt = queuedRetryAt(t.id);
    expect(retryAt).not.toBeNull();
    expect((retryAt ?? 0) - Date.now()).toBeGreaterThan(500);
  }, 30_000);

  it("验收 7b:成功尾部(exit 0 且无提交)→ R9 次闸抑制 transient,不冷却且落 done", async () => {
    const { coordinator, codebuddy, group } = await setupGroup(
      "transient-clean-exit",
    );
    __setTransientQuotaForTests(BACKOFF_MS, ESCALATION_LIMIT);
    process.env.FAKE_TRANSIENT = "1";
    process.env.FAKE_TRANSIENT_EXIT = "0";

    const created = await dispatchTask(coordinator, codebuddy, group);
    // R9-a: 瞬时退避行不单独构成结构证据,干净退出直接 done,不走 per-run 退避
    const t = await waitForTask(created.id, (row) => row.status === "done");

    expect(t.status).toBe("done");
    expect(isInCooldown({ key: "codebuddy" })).toBe(false);
    const diff = t.diffSummary as Record<string, unknown> | null;
    expect(diff?.quotaMatchedButTransient).toBeTruthy();
    expect(diff?.quotaKind).toBeUndefined();
    expect(queuedRetryAt(t.id)).toBeNull();
  }, 30_000);

  it("验收 4:同一 run 连续 3 次 transient → 第 3 次升级为 exhausted(防退避死循环)", async () => {
    const { coordinator, codebuddy, group } = await setupGroup(
      "transient-escalation",
    );
    // 小退避 + 上限 3:每次都命中瞬时限流,第 3 次必须升级。
    __setTransientQuotaForTests(200, ESCALATION_LIMIT);
    process.env.FAKE_TRANSIENT = "1";

    const created = await dispatchTask(coordinator, codebuddy, group);
    const t = await waitForTask(created.id, (row) => row.status === "failed");

    // 前两次退避重排队(共 3 次 attempt),第 3 次按额度耗尽处理。
    expect(t.attempts).toHaveLength(ESCALATION_LIMIT);
    expect(isInCooldown({ key: "codebuddy" })).toBe(true);
    const diff = t.diffSummary as Record<string, unknown> | null;
    expect(diff?.quotaKind).toBe("exhausted");
    expect(String(diff?.error ?? "")).toContain("连续瞬时限流 3 次");
    expect(String(diff?.error ?? "")).toContain("执行器额度限制");
    // 升级后不再退避重排队。
    expect(queuedRetryAt(t.id)).toBeNull();
  }, 30_000);

  it("验收 9:瞬时退避配置不可读 → fail-safe 回落 exhausted(冷却 + 不重试)", async () => {
    const { coordinator, codebuddy, group } = await setupGroup(
      "transient-fail-safe",
    );
    // 未配置(缺失/非法)→ getTransientQuotaPolicy() 返回 null。
    __setTransientQuotaForTests(null, null);
    process.env.FAKE_TRANSIENT = "1";

    const created = await dispatchTask(coordinator, codebuddy, group);
    const t = await waitForTask(created.id, (row) => row.status === "failed");

    expect(t.status).toBe("failed");
    expect(isInCooldown({ key: "codebuddy" })).toBe(true);
    expect(t.attempts).toHaveLength(1);
    const diff = t.diffSummary as Record<string, unknown> | null;
    expect(diff?.quotaKind).toBe("exhausted");
    expect(String(diff?.error ?? "")).toContain("执行器额度限制");
    expect(queuedRetryAt(t.id)).toBeNull();
  }, 30_000);
});
