import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
 * 角色定向下发(specs/dispatch-to-role.md R1-R5):audience=role 时派发层按角色
 * 解析本群目标成员并复用既有可用性判定(findExecutorByParticipant / isInCooldown
 * / runningExecutorCount vs maxConcurrency)选取,participant 定向行为逐字不变。
 *
 * fake bin 与 executor-trigger.test.ts 同款集成方式:EXECUTOR_BIN_<KEY 大写>
 * 指向可配置临时脚本,COAGENTHUB_REPO_ROOT 由 test/setup.ts 统一指向临时 git
 * 仓库。executors.ts 在模块加载时读 env,故 env 必须先于 import app 设置
 * (本文件用顶层 await 动态 import)。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-role-bin-"));
// detached 任务完成 git 提交的标记目录(用例等 marker 出现才结束,避免
// afterEach kill 打断 git 提交留下 index.lock)。
const markerDir = mkdtempSync(path.join(tmpdir(), "coagenthub-role-done-"));
const fakeScript = path.join(fakeDir, "fake-executor.sh");
writeFileSync(
  fakeScript,
  [
    "#!/bin/sh",
    // 可选:FAKE_SLEEP_MS(毫秒)让任务保持 running(并发闸测试用);sh 的
    // sleep 以秒为单位,macOS 支持小数,用 awk 做毫秒→秒换算。
    'if [ -n "$FAKE_SLEEP_MS" ]; then sleep "$(awk "BEGIN { print $FAKE_SLEEP_MS / 1000 }")"; fi',
    // 弱验收要求工作树干净 + HEAD 有新提交:真正提交一次(显式身份,CI 无全局
    // git config 也能跑)。
    'git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake bin change"',
    // 标记 git 已提交完成:测试等到该文件出现才结束用例,避免 afterEach 在
    // git 提交中途 kill 本进程留下 .git/index.lock 卡死下一个用例的快照。
    'if [ -n "$FAKE_BIN_DONE_FILE" ]; then touch "$FAKE_BIN_DONE_FILE"; fi',
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:角色定向测试"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeScript, 0o755);
const { bin: fakeBin, argsPrefix: fakeArgsPrefix } =
  resolveFakeExecutor(fakeScript);
process.env.EXECUTOR_BIN_EXECUTOR = fakeBin;
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;

// 顶层 await 动态 import:env 设置先于模块求值。
const { createTestApp } = await import("./app");
const { __resetExecutorQueueForTests, executorCooldowns } = await import(
  "../src/lib/executor-task/state"
);

beforeAll(async () => {
  await seedBuiltinExecutorConfigs();
  // win32: EXECUTOR_BIN 只覆盖 bin;把脚本路径拼进 args 最前面,原占位参数顺序不变。
  if (fakeArgsPrefix.length > 0) {
    for (const key of ["executor", "codebuddy"] as const) {
      const [row] = await testDb
        .select()
        .from(executorConfigTable)
        .where(eq(executorConfigTable.key, key));
      if (!row) continue;
      await testDb
        .update(executorConfigTable)
        .set({ args: withFakeExecutorArgs(fakeArgsPrefix, row.args ?? []) })
        .where(eq(executorConfigTable.key, key));
    }
  }
});

describe("角色定向下发(specs/dispatch-to-role.md)", () => {
  const app = createTestApp();

  beforeEach(() => {
    // 前一用例被 afterEach kill 的假 bin 可能被打断在 git 提交中途,留下
    // .git/index.lock —— 下一个用例的服务端执行前快照(git add -A)会被它
    // 卡死而瞬间失败(并发闸用例的 running 窗口因此被轮询错过)。每个用例
    // 开始前清掉残留锁,避免跨用例竞态。
    const repoRoot = process.env.COAGENTHUB_REPO_ROOT;
    if (repoRoot) {
      rmSync(path.join(repoRoot, ".git", "index.lock"), { force: true });
    }
  });

  afterEach(() => {
    // 清理内存队列/冷却(模块级状态跨用例共享)。
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
    // executor_key 有唯一约束:先把旧绑定释放,再绑到新 participant(测试内
    // 每个用例新建 participant,避免跨用例撞唯一约束)。
    await testDb
      .update(participantTable)
      .set({ executorKey: null })
      .where(eq(participantTable.executorKey, key));
    await testDb
      .update(participantTable)
      .set({ executorKey: key })
      .where(eq(participantTable.id, id));
  }

  /** 建群:创建者自动成为 coordinator 成员(角色定向的目标候选之一)。 */
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
    ownerId: string,
    groupId: string,
    participantId: string,
    roles: string[],
  ) {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": ownerId,
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
    return app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": senderId,
      },
      body: JSON.stringify(body),
    });
  }

  async function taskByMessage(messageId: string) {
    const rows = await testDb
      .select()
      .from(taskTable)
      .where(eq(taskTable.messageId, messageId));
    return rows[0];
  }

  async function waitForTaskByMessage(
    messageId: string,
    timeoutMs = 8_000,
  ): Promise<typeof taskTable.$inferSelect> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await taskByMessage(messageId);
      if (row) return row;
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for task of message ${messageId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** 等待某执行器出现 status=running 的任务(并发闸测试用)。 */
  async function waitForRunningTask(
    groupId: string,
    executorKey: string,
    timeoutMs = 8_000,
  ): Promise<typeof taskTable.$inferSelect> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await testDb
        .select()
        .from(taskTable)
        .where(eq(taskTable.groupId, groupId));
      const hit = rows.find(
        (r) => r.status === "running" && r.executorKey === executorKey,
      );
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for running task of ${executorKey}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** 等待某执行器的全部任务进入终态(避免假 bin 进程残留)。 */
  async function waitForExecutorIdle(
    groupId: string,
    executorKey: string,
    timeoutMs = 10_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await testDb
        .select()
        .from(taskTable)
        .where(eq(taskTable.groupId, groupId));
      const pending = rows.filter(
        (r) =>
          r.executorKey === executorKey &&
          !["done", "failed", "cancelled"].includes(r.status),
      );
      if (pending.length === 0) return;
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for ${executorKey} idle`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** 等待假 bin 完成 git 提交(marker 文件出现);detached 任务用例在结束前
   *  必须等到它,避免 afterEach kill 打断 git 提交留下 .git/index.lock。 */
  async function waitForMarker(file: string, timeoutMs = 4_000) {
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(file)) {
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for bin done marker ${file}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("R1:audience=role + coordinator → 任务创建,目标是本群 coordinator 成员", async () => {
    const coordinator = await registerParticipant(`role-coord-${randomUUID()}`);
    await bindExecutorKey(coordinator.id, "executor");
    const reviewer = await registerParticipant(`role-reviewer-${randomUUID()}`);
    const group = await createGroup(coordinator.id, "角色定向-基础");
    await addMember(group.id, group.id, reviewer.id, ["reviewer"]);

    const res = await postMessage(reviewer.id, group.id, {
      body: "请协调者处理",
      audience: "role",
      audienceRef: "coordinator",
    });
    expect(res.status).toBe(200);
    // 目标成员存在且可用 → 无 ROLE_UNRESOLVED 信号。
    expect(res.headers.get("X-CoAgentHub-Warning")).toBeNull();
    const msg = (await res.json()) as { id: string };

    // 目标是 coordinator 成员 → 按既有 detached 语义发送后保持 running、等
    // 执行器 PATCH 回写终态(与 participant 定向同规则,spec R1「其余流程完全
    // 不变」),故只断言任务行创建与目标,不等待终态;但结束前等假 bin 完成
    // git 提交(marker),避免 afterEach kill 打断提交留下 index.lock。
    const marker = path.join(markerDir, randomUUID());
    process.env.FAKE_BIN_DONE_FILE = marker;
    try {
      const task = await waitForTaskByMessage(msg.id);
      expect(task.executorParticipantId).toBe(coordinator.id);
      expect(task.executorKey).toBe("executor");
      await waitForMarker(marker);
    } finally {
      delete process.env.FAKE_BIN_DONE_FILE;
    }
  });

  it("L3 findings 定向 coordinator → 创建 fix 任务且任务书逐条包含发现项", async () => {
    const coordinator = await registerParticipant(
      `findings-coord-${randomUUID()}`,
    );
    await bindExecutorKey(coordinator.id, "executor");
    const reviewer = await registerParticipant(
      `findings-reviewer-${randomUUID()}`,
    );
    const group = await createGroup(coordinator.id, "L3 findings 定向协调者");
    await addMember(group.id, group.id, reviewer.id, ["reviewer"]);

    const anchorResponse = await postMessage(coordinator.id, group.id, {
      body: "已有实现任务",
    });
    const anchorMessage = (await anchorResponse.json()) as { id: string };
    const [anchorTask] = await testDb
      .insert(taskTable)
      .values({
        groupId: group.id,
        messageId: anchorMessage.id,
        executorParticipantId: coordinator.id,
        status: "queued",
      })
      .returning({ id: taskTable.id });

    const res = await postMessage(reviewer.id, group.id, {
      body: JSON.stringify({
        type: "review_result",
        layer: 3,
        taskId: anchorTask.id,
        verdict: "findings",
        findings: [
          { severity: "high", note: "缺少事务边界" },
          { severity: "low", note: "测试名称未使用领域词汇" },
        ],
      }),
      audience: "role",
      audienceRef: "coordinator",
      specRef: "specs/findings-must-reach-coordinator.md",
      specHash: "68446529c8031236ddbad2173837749be3d37cc8",
      dispatchKind: "requirement",
    });
    expect(res.status).toBe(200);
    const message = (await res.json()) as { id: string };
    const task = await waitForTaskByMessage(message.id);

    expect(task.parentTaskId).toBeNull();
    expect(task.dispatchKind).toBe("requirement");
    expect(task.specRef).toBe("specs/findings-must-reach-coordinator.md");
    expect(task.specHash).toBe("68446529c8031236ddbad2173837749be3d37cc8");
    expect(task.brief).toContain("severity: high");
    expect(task.brief).toContain("note: 缺少事务边界");
    expect(task.brief).toContain("severity: low");
    expect(task.brief).toContain("note: 测试名称未使用领域词汇");
  });

  it("L3 findings 广播或非 coordinator 定向 → 400 且说明正确发法", async () => {
    const coordinator = await registerParticipant(
      `findings-reject-coord-${randomUUID()}`,
    );
    const reviewer = await registerParticipant(
      `findings-reject-reviewer-${randomUUID()}`,
    );
    const executor = await registerParticipant(
      `findings-reject-executor-${randomUUID()}`,
    );
    await bindExecutorKey(executor.id, "codebuddy");
    const group = await createGroup(coordinator.id, "L3 findings 拒绝错误投递");
    await addMember(group.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(group.id, group.id, executor.id, ["executor"]);

    const anchorResponse = await postMessage(coordinator.id, group.id, {
      body: "已有实现任务",
    });
    const anchorMessage = (await anchorResponse.json()) as { id: string };
    const [anchorTask] = await testDb
      .insert(taskTable)
      .values({
        groupId: group.id,
        messageId: anchorMessage.id,
        executorParticipantId: coordinator.id,
        status: "queued",
      })
      .returning({ id: taskTable.id });

    const payload = JSON.stringify({
      type: "review_result",
      layer: 3,
      taskId: anchorTask.id,
      verdict: "findings",
      findings: [{ severity: "medium", note: "需要补充回归测试" }],
    });
    const common = {
      body: payload,
      specRef: "specs/findings-must-reach-coordinator.md",
      specHash: "68446529c8031236ddbad2173837749be3d37cc8",
    };

    const broadcast = await postMessage(reviewer.id, group.id, common);
    expect(broadcast.status).toBe(400);
    expect(((await broadcast.json()) as { message: string }).message).toContain(
      "定向到 coordinator",
    );

    const executorTarget = await postMessage(reviewer.id, group.id, {
      ...common,
      audience: "participant",
      audienceRef: executor.id,
    });
    expect(executorTarget.status).toBe(400);
    expect(
      ((await executorTarget.json()) as { message: string }).message,
    ).toContain("定向到 coordinator");
  });

  it("R1 回归:audience=participant 行为不变(定向成员建任务)", async () => {
    const owner = await registerParticipant(`role-owner-${randomUUID()}`);
    const executor = await registerParticipant(`role-exec-${randomUUID()}`);
    await bindExecutorKey(executor.id, "codebuddy");
    const reviewer = await registerParticipant(`role-reviewer-${randomUUID()}`);
    const group = await createGroup(owner.id, "角色定向-participant 回归");
    await addMember(group.id, group.id, executor.id, ["executor"]);
    await addMember(group.id, group.id, reviewer.id, ["reviewer"]);

    const res = await postMessage(reviewer.id, group.id, {
      body: "定向执行",
      audience: "participant",
      audienceRef: executor.id,
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { id: string };

    const task = await waitForTaskByMessage(msg.id);
    expect(task.executorParticipantId).toBe(executor.id);
    expect(task.executorKey).toBe("codebuddy");
    await waitForExecutorIdle(group.id, "codebuddy");
  });

  it("R2:多个成员持角色时跳过不在执行器配置中的成员", async () => {
    const owner = await registerParticipant(`role-owner-${randomUUID()}`);
    const bound = await registerParticipant(`role-bound-${randomUUID()}`);
    await bindExecutorKey(bound.id, "executor");
    const unbound = await registerParticipant(`role-unbound-${randomUUID()}`);
    const reviewer = await registerParticipant(`role-reviewer-${randomUUID()}`);
    const group = await createGroup(owner.id, "角色定向-跳过非执行器");
    // 三名 coordinator 成员:owner(未绑定)、unbound(未绑定)、bound(执行器)。
    await addMember(group.id, group.id, unbound.id, ["coordinator"]);
    await addMember(group.id, group.id, bound.id, ["coordinator"]);
    await addMember(group.id, group.id, reviewer.id, ["reviewer"]);

    const res = await postMessage(reviewer.id, group.id, {
      body: "请协调者处理",
      audience: "role",
      audienceRef: "coordinator",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-CoAgentHub-Warning")).toBeNull();
    const msg = (await res.json()) as { id: string };

    const marker = path.join(markerDir, randomUUID());
    process.env.FAKE_BIN_DONE_FILE = marker;
    try {
      const task = await waitForTaskByMessage(msg.id);
      expect(task.executorParticipantId).toBe(bound.id);
      expect(task.executorKey).toBe("executor");
      await waitForMarker(marker);
    } finally {
      delete process.env.FAKE_BIN_DONE_FILE;
    }
  });

  it("R2:跳过处于限额冷却的成员", async () => {
    const owner = await registerParticipant(`role-owner-${randomUUID()}`);
    await bindExecutorKey(owner.id, "executor");
    const free = await registerParticipant(`role-free-${randomUUID()}`);
    await bindExecutorKey(free.id, "codebuddy");
    const reviewer = await registerParticipant(`role-reviewer-${randomUUID()}`);
    const group = await createGroup(owner.id, "角色定向-跳过冷却");
    await addMember(group.id, group.id, free.id, ["coordinator"]);
    await addMember(group.id, group.id, reviewer.id, ["reviewer"]);
    // 冷却先于角色消息:owner(atomcode)进入冷却 → 选取应落到 free(codebuddy)。
    executorCooldowns.set("executor", Date.now() + 60_000);

    const res = await postMessage(reviewer.id, group.id, {
      body: "请协调者处理",
      audience: "role",
      audienceRef: "coordinator",
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { id: string };

    const marker = path.join(markerDir, randomUUID());
    process.env.FAKE_BIN_DONE_FILE = marker;
    try {
      const task = await waitForTaskByMessage(msg.id);
      expect(task.executorParticipantId).toBe(free.id);
      expect(task.executorKey).toBe("codebuddy");
      await waitForMarker(marker);
    } finally {
      delete process.env.FAKE_BIN_DONE_FILE;
    }
  });

  it("R2:跳过已达并发上限的成员(既有任务 running 时)", async () => {
    const owner = await registerParticipant(`role-owner-${randomUUID()}`);
    await bindExecutorKey(owner.id, "executor");
    // 占槽者:与 owner 同 key("executor",maxConcurrency=1)但**不是**
    // coordinator 成员 —— 非 detached,任务正常 running 并占住并发槽位
    // (detached 任务派发后即释放槽位,不能用于占槽)。
    const busy = await registerParticipant(`role-busy-${randomUUID()}`);
    await bindExecutorKey(busy.id, "executor");
    const free = await registerParticipant(`role-free-${randomUUID()}`);
    await bindExecutorKey(free.id, "codebuddy");
    const reviewer = await registerParticipant(`role-reviewer-${randomUUID()}`);
    const group = await createGroup(owner.id, "角色定向-跳过并发");
    await addMember(group.id, group.id, busy.id, ["executor"]);
    await addMember(group.id, group.id, free.id, ["coordinator"]);
    await addMember(group.id, group.id, reviewer.id, ["reviewer"]);

    // 先给 busy 跑一个慢任务占住 "executor" 的并发槽位。
    process.env.FAKE_SLEEP_MS = "2500";
    try {
      const busyRes = await postMessage(reviewer.id, group.id, {
        body: "占住 executor",
        audience: "participant",
        audienceRef: busy.id,
      });
      expect(busyRes.status).toBe(200);
      await waitForRunningTask(group.id, "executor");
      // 给入队/状态落库留出余量,再发角色消息。
      await new Promise((resolve) => setTimeout(resolve, 150));

      const res = await postMessage(reviewer.id, group.id, {
        body: "请协调者处理",
        audience: "role",
        audienceRef: "coordinator",
      });
      expect(res.status).toBe(200);
      const msg = (await res.json()) as { id: string };

      // runningExecutorCount("executor")=1 ≥ maxConcurrency 1 → owner 被跳过,
      // 角色消息落到 free(codebuddy)。目标是 coordinator 成员 → detached,
      // 只断言任务行,不等待终态(afterEach 清理内存队列)。
      const task = await waitForTaskByMessage(msg.id);
      expect(task.executorParticipantId).toBe(free.id);
      expect(task.executorKey).toBe("codebuddy");
    } finally {
      delete process.env.FAKE_SLEEP_MS;
    }
    // 不等待 busy 终态:busy 还在 sleep 中由 afterEach kill(kill 落在 sleep
    // 段,无 git 提交进行中,不会留下 index.lock);角色任务 detached 不等待。
  }, 20_000);

  it("R2:全部不可用时排队(不报错、不跳过)", async () => {
    const owner = await registerParticipant(`role-owner-${randomUUID()}`);
    await bindExecutorKey(owner.id, "executor");
    const other = await registerParticipant(`role-other-${randomUUID()}`);
    await bindExecutorKey(other.id, "codebuddy");
    const reviewer = await registerParticipant(`role-reviewer-${randomUUID()}`);
    const group = await createGroup(owner.id, "角色定向-全部不可用");
    await addMember(group.id, group.id, other.id, ["coordinator"]);
    await addMember(group.id, group.id, reviewer.id, ["reviewer"]);
    // 两名候选都在冷却 → 无可用候选 → 回退第一个持有执行器配置的成员,任务排队。
    executorCooldowns.set("executor", Date.now() + 60_000);
    executorCooldowns.set("codebuddy", Date.now() + 60_000);

    const res = await postMessage(reviewer.id, group.id, {
      body: "请协调者处理",
      audience: "role",
      audienceRef: "coordinator",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-CoAgentHub-Warning")).toBeNull();
    const msg = (await res.json()) as { id: string };

    const task = await waitForTaskByMessage(msg.id);
    expect(task.status).toBe("queued");
    expect([owner.id, other.id]).toContain(task.executorParticipantId);
  });

  it("R3 直调:角色名非法 → 明确失败,不创建任务", async () => {
    const reviewer = await registerParticipant(`role-reviewer-${randomUUID()}`);
    const group = await createGroup(reviewer.id, "角色定向-非法角色");
    const msgRes = await postMessage(reviewer.id, group.id, {
      body: "占位消息",
      audience: "broadcast",
    });
    const msg = (await msgRes.json()) as { id: string };

    const { maybeDispatchExecutorTask } = await import(
      "@server/lib/executor-task"
    );
    const outcome = await maybeDispatchExecutorTask(
      testDb as unknown as Parameters<typeof maybeDispatchExecutorTask>[0],
      {
        groupId: group.id,
        messageId: msg.id,
        senderRoles: ["reviewer"],
        audience: "role",
        audienceRef: "bogus-role",
        body: "角色非法",
        dispatcherParticipantId: reviewer.id,
        dispatcherSessionId: null,
        specRef: null,
        specHash: null,
        dispatchKind: null,
        supersedesTaskId: null,
        callbackRef: null,
      },
    );
    expect(outcome).toEqual({
      status: "role-unresolved",
      reason: "role-not-legal",
      role: "bogus-role",
    });
    expect(await taskByMessage(msg.id)).toBeUndefined();
  });

  it("R4 回归:API 层非法角色名仍 400(消息层校验未动)", async () => {
    const owner = await registerParticipant(`role-owner-${randomUUID()}`);
    const reviewer = await registerParticipant(`role-reviewer-${randomUUID()}`);
    const group = await createGroup(owner.id, "角色定向-API 非法角色");
    await addMember(group.id, group.id, reviewer.id, ["reviewer"]);

    const res = await postMessage(reviewer.id, group.id, {
      body: "非法角色",
      audience: "role",
      audienceRef: "bogus-role",
    });
    expect(res.status).toBe(400);
  });

  it("R3:本群无成员持有该角色 → 明确失败(响应头信号),不创建任务", async () => {
    const owner = await registerParticipant(`role-owner-${randomUUID()}`);
    const reviewer = await registerParticipant(`role-reviewer-${randomUUID()}`);
    const group = await createGroup(owner.id, "角色定向-无匹配成员");
    await addMember(group.id, group.id, reviewer.id, ["reviewer"]);

    const res = await postMessage(reviewer.id, group.id, {
      body: "请执行器处理",
      audience: "role",
      audienceRef: "executor",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-CoAgentHub-Warning")).toBe(
      "ROLE_UNRESOLVED:executor:role-no-member",
    );
    const msg = (await res.json()) as { id: string };
    expect(await taskByMessage(msg.id)).toBeUndefined();
  });

  it("R3:角色成员都不在执行器配置中 → 明确失败(响应头信号),不创建任务", async () => {
    const owner = await registerParticipant(`role-owner-${randomUUID()}`);
    const reviewer = await registerParticipant(`role-reviewer-${randomUUID()}`);
    const group = await createGroup(owner.id, "角色定向-无执行器成员");
    await addMember(group.id, group.id, reviewer.id, ["reviewer"]);

    const res = await postMessage(reviewer.id, group.id, {
      body: "请协调者处理",
      audience: "role",
      audienceRef: "coordinator",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-CoAgentHub-Warning")).toBe(
      "ROLE_UNRESOLVED:coordinator:role-no-executor",
    );
    const msg = (await res.json()) as { id: string };
    expect(await taskByMessage(msg.id)).toBeUndefined();
  });
});
