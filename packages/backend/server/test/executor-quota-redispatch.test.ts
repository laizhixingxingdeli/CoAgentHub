import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  participant as participantTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "./db";

/**
 * 额度耗尽触发无限重派修复(specs/quota-exhaustion-triggers-infinite-retry.md):
 *  - R1 识别:usage limit / try again at HH:MM(12h AM/PM 与 24h)命中额度失败;
 *  - R2 冷却:识别为额度失败 → 执行器冷却至恢复时刻,不自动重试;
 *  - R3 可用性:冷却执行器不可用,participant 定向落入等待恢复标记(不空转重派),
 *    角色定向改派到可用执行器;
 *  - R4 熔断:原因无法识别时,同一父任务连续失败子任务达 5 次后停止重派;
 *  - R5 留痕:冷却与熔断触发时,diffSummary 与群消息均有可读记录;
 *  - 回归:普通非配额进程崩溃重试行为不变。
 *
 * fake bin 与 executor-task-role-dispatch.test.ts 同款集成方式:
 * EXECUTOR_BIN_<KEY 大写> 指向可配置临时脚本,COAGENTHUB_REPO_ROOT 由
 * test/setup.ts 统一指向临时 git 仓库。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-quota-bin-"));
const fakeBin = path.join(fakeDir, "fake-executor.sh");
writeFileSync(
  fakeBin,
  [
    "#!/bin/sh",
    // 额度失败模式:打印 usage limit + 恢复时刻后 exit 1(quota-exhaustion R1)。
    'if [ -n "$FAKE_QUOTA_USAGE_LIMIT" ]; then',
    '  echo "You hit your usage limit. Upgrade to Pro or wait for the limit to reset."',
    '  echo "try again at $FAKE_TRY_AGAIN_AT"',
    "  exit 1",
    "fi",
    // 普通崩溃模式:非额度关键词,exit 1(回归:重试行为不变)。
    'if [ -n "$FAKE_ALWAYS_FAIL" ]; then echo "ordinary crash (attempt $n)"; exit 1; fi',
    // 成功路径:弱验收要求工作树干净 + HEAD 有新提交。
    'git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake bin change"',
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:quota 测试"',
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
  cooldownEndMs,
  executorCooldowns,
  getRedispatchFailureLimit,
  isInCooldown,
} = await import("../src/lib/executor-task/state");
const { restoreExecutorCooldowns } = await import(
  "../src/lib/executor-task/queue"
);
const { clearPersistedExecutorCooldown } = await import(
  "../src/lib/executor-task/cooldown-store"
);
const { parseRateLimitRecoveryMs } = await import("@server/lib/executors");

describe("额度耗尽触发无限重派修复(specs/quota-exhaustion-triggers-infinite-retry)", () => {
  const app = createTestApp();

  beforeEach(() => {
    __resetExecutorQueueForTests();
    for (const key of [
      "FAKE_QUOTA_USAGE_LIMIT",
      "FAKE_TRY_AGAIN_AT",
      "FAKE_ALWAYS_FAIL",
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

  async function listTasks(participantId: string, groupId: string) {
    const res = await app.request(`/api/groups/${groupId}/tasks`, {
      headers: { "X-Participant-Id": participantId },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{
      id: string;
      messageId: string;
      status: string;
      retryCount: number;
      diffSummary: Record<string, unknown> | null;
      attempts: Array<Record<string, unknown>> | null;
    }>;
  }

  async function listMessages(participantId: string, groupId: string) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      headers: { "X-Participant-Id": participantId },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{
      id: string;
      body: string;
      contentType: string;
    }>;
  }

  async function waitForTaskStatus(
    participantId: string,
    groupId: string,
    messageId: string,
    status: string,
    timeoutMs = 20_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tasks = await listTasks(participantId, groupId);
      const t = tasks.find((x) => x.messageId === messageId);
      if (t && t.status === status) return t;
      if (Date.now() > deadline) {
        throw new Error(
          `task(message=${messageId}) 未在 ${timeoutMs}ms 内达到 ${status}(当前=${
            tasks.find((x) => x.messageId === messageId)?.status ?? "无"
          })`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function waitForMessage(
    participantId: string,
    groupId: string,
    predicate: (m: { body: string }) => boolean,
    timeoutMs = 15_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const messages = await listMessages(participantId, groupId);
      const hit = messages.find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error("群里未在预期时间内出现消息");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** 造一个未来时刻的 "H:MM AM/PM" 文本(供 FAKE_TRY_AGAIN_AT)。保证解析后
   *  落在今天且在未来:跨午夜时逐步回缩,避免 setHours 把目标回落到过去。 */
  function futureTryAgainAt(minutesAhead: number): string {
    const base = new Date();
    let ahead = minutesAhead;
    while (ahead > 0) {
      const d = new Date(Date.now() + ahead * 60_000);
      if (d.getDate() === base.getDate()) break;
      ahead -= 5;
    }
    const d = new Date(Date.now() + Math.max(1, ahead) * 60_000);
    let h = d.getHours();
    const meridiem = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${meridiem}`;
  }

  /** 标准场景:协调者(群主)+ 执行器(codebuddy)成员就绪。 */
  async function setupGroup(title: string) {
    const coordinator = await registerParticipant(
      `quota-coord-${randomUUID()}`,
    );
    const codebuddy = await registerParticipant(`quota-exec-${randomUUID()}`);
    await bindExecutorKey(codebuddy.id, "codebuddy");
    const group = await createGroup(coordinator.id, title);
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  /* ---------------- R1 识别:parseRateLimitRecoveryMs ---------------- */

  describe("parseRateLimitRecoveryMs:try again at HH:MM(12h AM/PM / 24h)", () => {
    const base = new Date(2026, 7, 14, 8, 0, 0); // 本地 08:00
    const now = base.getTime();

    it("try again at 3:32 PM(12 小时制)→ 今天 15:32", () => {
      expect(
        parseRateLimitRecoveryMs(
          "You've hit your usage limit ... try again at 3:32 PM",
          now,
        ),
      ).toBe(new Date(2026, 7, 14, 15, 32, 0).getTime());
    });

    it("try again at 9:05 AM(12 小时制,上午)→ 今天 09:05", () => {
      expect(parseRateLimitRecoveryMs("try again at 9:05 AM", now)).toBe(
        new Date(2026, 7, 14, 9, 5, 0).getTime(),
      );
    });

    it("try again at 15:32(24 小时制)→ 今天 15:32", () => {
      expect(parseRateLimitRecoveryMs("try again at 15:32", now)).toBe(
        new Date(2026, 7, 14, 15, 32, 0).getTime(),
      );
    });

    it("try again at 3:32 AM 已过(08:00 后)→ 视为 now(保守不延长)", () => {
      expect(parseRateLimitRecoveryMs("try again at 3:32 AM", now)).toBe(now);
    });
  });

  /* ---------------- R1+R2:usage limit 识别 → 冷却至恢复时刻 → 不重试 ---------------- */

  describe("usage limit + try again at HH:MM 识别(验收点 1)", () => {
    it("识别为额度失败 → 冷却至恢复时刻 + 不自动重试 + 双通道留痕", async () => {
      const { coordinator, codebuddy, group } =
        await setupGroup("quota-usage-limit");
      // 不做关键词注入:全量 pnpm test(cwd=仓库根)读到 scripts/
      // dispatch-policy.json,其 detectPatterns 与代码默认关键词并集后已含
      // usage limit / try again at(见 dispatch-policy.test.ts)。这里必须跑
      // 真实运行时策略,否则配置路径上的漏判会被私有注入掩盖。
      process.env.FAKE_QUOTA_USAGE_LIMIT = "1";
      const tryAgain = futureTryAgainAt(30);
      process.env.FAKE_TRY_AGAIN_AT = tryAgain;

      const msg = await postMessage(coordinator.id, group.id, {
        body: "额度耗尽任务",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "failed",
      );

      // R2:冷却至解析出的恢复时刻(与解析结果一致,而不是固定冷却)。
      const expectedEnd = parseRateLimitRecoveryMs(
        `try again at ${tryAgain}`,
        Date.now(),
      );
      expect(
        Math.abs(cooldownEndMs({ key: "codebuddy" }) - (expectedEnd ?? 0)),
      ).toBeLessThan(2_000);
      // 常规(非午夜跨天)场景冷却仍在有效期内;跨天兜底仅断言冷却已登记。
      if ((expectedEnd ?? 0) > Date.now() + 10_000) {
        expect(isInCooldown({ key: "codebuddy" })).toBe(true);
      }

      // 不自动重试(attempts 仅 1 条,无 retries)。
      expect(t.attempts).toHaveLength(1);
      expect(t.diffSummary?.retries).toBeUndefined();

      // R5 留痕:任务 diffSummary 与群消息均含原因 + 预计恢复时刻。
      const err = String(t.diffSummary?.error ?? "");
      expect(err).toContain("执行器额度限制");
      expect(err).toMatch(/预计 .+ 恢复/);
      const persistedEnd = t.diffSummary?.executorCooldownEndMs;
      expect(typeof persistedEnd).toBe("number");

      // executor-cooldown-lost-on-restart R1/R2/R5:模拟进程内状态丢失后从
      // task.diffSummary 的绝对 epoch ms 恢复,到期时刻必须逐值不变。
      const beforeRestart = cooldownEndMs({ key: "codebuddy" });
      __resetExecutorQueueForTests();
      expect(isInCooldown({ key: "codebuddy" })).toBe(false);
      expect(
        await restoreExecutorCooldowns(
          testDb as unknown as Parameters<typeof restoreExecutorCooldowns>[0],
        ),
      ).toBe(1);
      const afterRestart = cooldownEndMs({ key: "codebuddy" });
      expect(afterRestart).toBe(beforeRestart);
      expect(afterRestart).toBe(persistedEnd);
      expect(isInCooldown({ key: "codebuddy" })).toBe(true);

      // R1 下游效果:恢复出的冷却继续被 executor-availability 读取;协调任务
      // 零执行子任务结案时,平台据此写入真实 degradedToTwoParty 留痕。
      const [coordinationTask] = await testDb
        .insert(taskTable)
        .values({
          groupId: group.id,
          messageId: randomUUID(),
          executorParticipantId: coordinator.id,
          executorKey: "codex",
          status: "running",
          brief: "协调者降级兼任",
        })
        .returning();
      const closeRes = await app.request(
        `/api/groups/${group.id}/tasks/${coordinationTask.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinator.id,
          },
          body: JSON.stringify({
            status: "failed",
            diffSummary: { error: "协调者降级兼任" },
          }),
        },
      );
      expect(closeRes.status).toBe(200);
      const closed = (await closeRes.json()) as {
        diffSummary: {
          degradedToTwoParty?: {
            executors: Array<{ name: string; reason: string }>;
          };
        };
      };
      expect(closed.diffSummary.degradedToTwoParty?.executors).toEqual([
        expect.objectContaining({
          reason: expect.stringContaining("额度冷却"),
        }),
      ]);

      const msgText = await waitForMessage(
        coordinator.id,
        group.id,
        (m) => m.body.includes("执行器额度限制") && m.body.includes("恢复"),
      );
      expect(msgText.body).toMatch(/❌/);
      await clearPersistedExecutorCooldown(
        testDb as unknown as Parameters<
          typeof clearPersistedExecutorCooldown
        >[0],
        t.id,
      );
    }, 30_000);

    it("启动时清理已过期冷却记录,不得复活", async () => {
      const { codebuddy, group } = await setupGroup("quota-expired-cooldown");
      const [olderLiveTask] = await testDb
        .insert(taskTable)
        .values({
          groupId: group.id,
          messageId: randomUUID(),
          executorParticipantId: codebuddy.id,
          executorKey: "codebuddy",
          status: "failed",
          diffSummary: {
            error: "更早的执行器额度限制",
            executorCooldownEndMs: Date.now() + 60_000,
          },
          createdAt: new Date(Date.now() - 120_000),
        })
        .returning();
      const expiredEnd = Date.now() - 60_000;
      const [failedTask] = await testDb
        .insert(taskTable)
        .values({
          groupId: group.id,
          messageId: randomUUID(),
          executorParticipantId: codebuddy.id,
          executorKey: "codebuddy",
          status: "failed",
          diffSummary: {
            error: "执行器额度限制",
            executorCooldownEndMs: expiredEnd,
          },
        })
        .returning();

      expect(
        await restoreExecutorCooldowns(
          testDb as unknown as Parameters<typeof restoreExecutorCooldowns>[0],
        ),
      ).toBe(0);
      expect(isInCooldown({ key: "codebuddy" })).toBe(false);

      const cleaned = await testDb.query.task.findFirst({
        where: (row, { eq: eqFn }) => eqFn(row.id, failedTask.id),
        columns: { diffSummary: true },
      });
      expect(cleaned?.diffSummary).toEqual({ error: "执行器额度限制" });
      const olderCleaned = await testDb.query.task.findFirst({
        where: (row, { eq: eqFn }) => eqFn(row.id, olderLiveTask.id),
        columns: { diffSummary: true },
      });
      expect(olderCleaned?.diffSummary).toEqual({
        error: "更早的执行器额度限制",
      });
    });

    it("无额度关键词的普通崩溃不进入冷却(回归:不误判停派)", async () => {
      const { coordinator, codebuddy, group } =
        await setupGroup("quota-plain-crash");
      // 同上:真实运行时策略下,普通崩溃文本不含任何额度关键词,不应命中冷却。
      process.env.FAKE_ALWAYS_FAIL = "1";
      const msg = await postMessage(coordinator.id, group.id, {
        body: "普通崩溃任务",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "failed",
      );
      expect(isInCooldown({ key: "codebuddy" })).toBe(false);
      expect(String(t.diffSummary?.error ?? "")).not.toContain(
        "执行器额度限制",
      );
      // 重试行为不变(验收点 4):普通非配额崩溃仍按既有策略自动重试一次
      // (maxRetries=1),attempts 2 条 + diffSummary.retries=1。
      expect(t.attempts).toHaveLength(2);
      expect(t.diffSummary?.retries).toBe(1);
    }, 30_000);
  });

  /* ---------------- R3:冷却执行器不可用 ---------------- */

  describe("冷却执行器不可用(验收点 2)", () => {
    it("participant 定向到冷却执行器 → 如实标记等待恢复,不空转重派", async () => {
      const { coordinator, codebuddy, group } =
        await setupGroup("quota-waiting");
      executorCooldowns.set("codebuddy", Date.now() + 60_000);

      const msg = await postMessage(coordinator.id, group.id, {
        body: "冷却中的任务",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      // 先等 ⏳ 群消息(enqueueTaskRun 先写 waiting 标记再回传消息,
      // 等消息出现即可保证标记已落库),再断言任务行。
      const waiting = await waitForMessage(coordinator.id, group.id, (m) =>
        m.body.includes("等待执行器额度恢复"),
      );
      expect(waiting.body).toMatch(/⏳/);
      const tasks = await listTasks(coordinator.id, group.id);
      const t = tasks.find((x) => x.messageId === msg.id);
      expect(t?.status).toBe("queued");
      // 等待恢复标记(不 spawn、不失败、不空转重派)。
      expect(String(t?.diffSummary?.waiting ?? "")).toContain(
        "等待执行器额度恢复",
      );
    }, 15_000);

    it("角色定向:冷却执行器不可用 → 改派到其他可用执行器", async () => {
      const owner = await registerParticipant(`quota-owner-${randomUUID()}`);
      await bindExecutorKey(owner.id, "executor");
      const free = await registerParticipant(`quota-free-${randomUUID()}`);
      await bindExecutorKey(free.id, "codebuddy");
      const reviewer = await registerParticipant(
        `quota-reviewer-${randomUUID()}`,
      );
      const group = await createGroup(owner.id, "quota-role-redispatch");
      await addMember(owner.id, group.id, free.id, ["coordinator"]);
      await addMember(owner.id, group.id, reviewer.id, ["reviewer"]);
      // executor(codebuddy 以外的第二个执行器)进入冷却 → 角色定向落到 free。
      executorCooldowns.set("executor", Date.now() + 60_000);

      const res = await app.request(`/api/groups/${group.id}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": reviewer.id,
        },
        body: JSON.stringify({
          body: "请协调者处理",
          audience: "role",
          audienceRef: "coordinator",
        }),
      });
      expect(res.status).toBe(200);
      const msg = (await res.json()) as { id: string };
      const tasks = await listTasks(reviewer.id, group.id);
      const task = tasks.find((x) => x.messageId === msg.id);
      expect(task).toBeDefined();
      // 改派到 free(冷却中的 executor 被跳过);free 可用,任务正常进入运行。
      const rows = await testDb
        .select()
        .from(taskTable)
        .where(eq(taskTable.messageId, msg.id));
      expect(rows[0]?.executorKey).toBe("codebuddy");
      expect(rows[0]?.executorParticipantId).toBe(free.id);
    }, 15_000);
  });

  /* ---------------- R4:同一父任务连续失败 5 次 → 停止重派 ---------------- */

  describe("未知原因连续失败熔断(验收点 3)", () => {
    it("连续失败达阈值(默认 5)→ 第 6 次派发被拒 + diffSummary/群消息留痕", async () => {
      const { coordinator, codebuddy, group } = await setupGroup(
        "quota-redispatch-cap",
      );
      // 父任务 = 协调者名下的 running 任务(重派上下文,直插 DB 构造)。
      const [parent] = await testDb
        .insert(taskTable)
        .values({
          groupId: group.id,
          messageId: randomUUID(),
          executorParticipantId: coordinator.id,
          executorKey: "executor",
          status: "running",
          executorPid: null,
          brief: "父协调任务",
        })
        .returning();

      process.env.FAKE_ALWAYS_FAIL = "1";
      // 前 5 个子任务全部失败(原因无法识别,普通崩溃)。
      for (let i = 1; i <= 5; i++) {
        const msg = await postMessage(coordinator.id, group.id, {
          body: `子任务 ${i}`,
          audience: "participant",
          audienceRef: codebuddy.id,
        });
        await waitForTaskStatus(coordinator.id, group.id, msg.id, "failed");
      }
      // 5 次内重派不受限(子任务都真实创建了)。
      const tasks = await listTasks(coordinator.id, group.id);
      expect(
        tasks.filter((x) => x.status === "failed").length,
      ).toBeGreaterThanOrEqual(5);

      // 第 6 次:同一父任务连续失败已达阈值 → 不创建任务。
      const msg6 = await postMessage(coordinator.id, group.id, {
        body: "子任务 6(应被熔断)",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      await new Promise((r) => setTimeout(r, 800)); // fire-and-forget 派发窗口
      const tasksAfter = await listTasks(coordinator.id, group.id);
      expect(tasksAfter.some((x) => x.messageId === msg6.id)).toBe(false);

      // R5:父任务 diffSummary 记录熔断原因,群消息有可读记录。
      const parentRow = await testDb
        .select()
        .from(taskTable)
        .where(eq(taskTable.id, parent.id));
      const parentSummary = parentRow[0]?.diffSummary as Record<
        string,
        unknown
      > | null;
      const stopped = parentSummary?.redispatchStopped as
        | Record<string, unknown>
        | undefined;
      expect(stopped).toBeDefined();
      expect(stopped?.consecutiveFailures).toBe(5);
      expect(stopped?.limit).toBe(getRedispatchFailureLimit());
      expect(String(stopped?.reason ?? "")).toContain("停止重派");

      const capMsg = await waitForMessage(coordinator.id, group.id, (m) =>
        m.body.includes("已停止重派"),
      );
      expect(capMsg.body).toMatch(/🛑/);
      expect(capMsg.body).toContain("等待人工介入");
    }, 60_000);
  });
});
