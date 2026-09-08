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
 * 控制指令只走控制通道(fix 票):「停止/stop/回滚 [taskId]」定向 coordinator
 * (role 或 participant)时,messages 派发入口不再重复建任务,响应头留下
 * CONTROL_COMMAND_SKIPPED_DISPATCH 警告;控制通道照常处理;broadcast 行为逐字
 * 不变(无警告头、不建任务);定向执行器 participant 的任务创建不受影响。
 *
 * ADR-0009:派发入口与控制通道共用 control.ts 导出的唯一判定
 * isControlCommand(同一 STOP_RE/ROLLBACK_RE 语义,不复制第二份正则)。该判据
 * 以语法匹配代替「消息是否属于控制通道」;正文恰好以停止开头但语义并非停止任
 * 务(如「停止讨论,开始实现 X」)时不成立——既有歧义,本票明确保持(仍按控
 * 制指令处理)。
 *
 * 回归:coordinator participant 为可被平台拉起同时绑定执行器 key 时,定向
 * 控制指令仍归控制通道执行、派发入口跳过不建任务(旧判据「绑定执行器 key =
 * 执行器任务目标」在该场景不成立,曾误建 detached task 并回 SPEC_HASH_MISSING)。
 *
 * 集成部分与 executor-task-role-dispatch.test.ts 同款 fake bin:coordinator 绑
 * 定执行器 key(重复建任务的缺陷只有在目标可派发时才显形),派发会真实 spawn。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-ctl-skip-bin-"));
// detached/普通任务完成 git 提交的标记目录(用例等 marker 出现才结束,避免
// afterEach kill 打断 git 提交留下 index.lock)。
const markerDir = mkdtempSync(path.join(tmpdir(), "coagenthub-ctl-skip-done-"));
const fakeScript = path.join(fakeDir, "fake-executor.sh");
writeFileSync(
  fakeScript,
  [
    "#!/bin/sh",
    // 弱验收要求工作树干净 + HEAD 有新提交:真正提交一次(显式身份,CI 无全局
    // git config 也能跑)。
    'git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake bin change"',
    // 标记 git 已提交完成。
    'if [ -n "$FAKE_BIN_DONE_FILE" ]; then touch "$FAKE_BIN_DONE_FILE"; fi',
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:控制指令跳过派发测试"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeScript, 0o755);
const { bin: fakeBin, argsPrefix: fakeArgsPrefix } =
  resolveFakeExecutor(fakeScript);
process.env.EXECUTOR_BIN_EXECUTOR = fakeBin;
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;

// 顶层 await 动态 import:env 设置先于模块求值(executors.ts 在模块加载时读
// env;control.ts 的静态导入会连带加载 executors,故同样走动态 import)。
const { createTestApp } = await import("./app");
const { __resetExecutorQueueForTests } = await import(
  "../src/lib/executor-task/state"
);
const { isControlCommand, isExecutorTaskTarget } = await import(
  "../src/lib/control"
);

beforeAll(async () => {
  await seedBuiltinExecutorConfigs();
  // win32: EXECUTOR_BIN 只覆盖 bin;把脚本路径拼进 args 最前面,原占位参数顺序不变。
  if (fakeArgsPrefix.length > 0) {
    for (const key of ["codebuddy", "executor"] as const) {
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

describe("control 导出:isControlCommand 与控制通道共用唯一判定", () => {
  it.each([
    ["停止 abc-123", true],
    ["stop abc-123", true],
    ["STOP abc-123", true],
    ["停止", true],
    ["取消 abc-123", true],
    ["停一下", true],
    ["回滚 abc-123", true],
    ["回滚", true],
    // 既有歧义(本票保持):语法上仍是停止指令 → 按控制指令判定。
    ["停止讨论,开始实现 X", true],
    ["请实现功能 X", false],
    ["开始实现 X", false],
    ["功能 X 已完成", false],
    ["", false],
  ])("isControlCommand(%j) → %s", (body, expected) => {
    expect(isControlCommand(body)).toBe(expected);
  });
});

/**
 * 派发入口与控制通道共用的唯一目标分类事实 isExecutorTaskTarget(ADR-0009):
 * 以「本群唯一角色 = executor」代替「participant 是否绑定执行器 key」。该替代
 * 仅在 coordinator participant 为可被平台拉起而同时绑定执行器 key 时不成立
 * (本票回归的触发条件);此时按群角色归类为 coordinator,控制指令仍归控制
 * 通道执行,而非当作 participant 定向执行器的任务。
 */
describe("control 导出:isExecutorTaskTarget 目标分类(按本群唯一角色)", () => {
  const app = createTestApp();
  // PGlite 与 node-postgres 的 drizzle 实例驱动类型不兼容(与
  // executor-task-role-dispatch / l3-verdict-observability 同款 cast);
  // isExecutorTaskTarget 只走共享的 query API。
  const targetDb = testDb as unknown as Parameters<
    typeof isExecutorTaskTarget
  >[0];

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

  async function bindKey(id: string, key: string) {
    await testDb
      .update(participantTable)
      .set({ executorKey: null })
      .where(eq(participantTable.executorKey, key));
    await testDb
      .update(participantTable)
      .set({ executorKey: key })
      .where(eq(participantTable.id, id));
  }

  /** 建一个 owner 群并把 participant 以指定角色加为成员,返回群 id。 */
  async function makeMember(participantId: string, roles: string[]) {
    const owner = await register(`own-${randomUUID()}`);
    const group = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": owner.id,
      },
      body: JSON.stringify({ title: `t-${randomUUID()}` }),
    });
    expect(group.status).toBe(200);
    const gid = (await group.json()) as { id: string };
    const add = await app.request(`/api/groups/${gid.id}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": owner.id,
      },
      body: JSON.stringify({ participantId, roles }),
    });
    expect(add.status).toBe(200);
    return gid.id;
  }

  it("绑定执行器 key 且本群角色 = executor → 是执行器任务目标", async () => {
    const ex = await register(`ex-${randomUUID()}`);
    await bindKey(ex.id, "executor");
    const groupId = await makeMember(ex.id, ["executor"]);
    expect(await isExecutorTaskTarget(targetDb, ex.id, groupId)).toBe(true);
  });

  it("绑定执行器 key 但本群角色 = coordinator → 不是执行器任务目标(本票回归)", async () => {
    const coord = await register(`coord-${randomUUID()}`);
    await bindKey(coord.id, "executor");
    const groupId = await makeMember(coord.id, ["coordinator"]);
    expect(await isExecutorTaskTarget(targetDb, coord.id, groupId)).toBe(false);
  });

  it("未绑定执行器 key 且本群角色 = executor → 不是执行器任务目标(无法派发)", async () => {
    const ex = await register(`ex2-${randomUUID()}`);
    const groupId = await makeMember(ex.id, ["executor"]);
    expect(await isExecutorTaskTarget(targetDb, ex.id, groupId)).toBe(false);
  });
});

describe("定向 coordinator 的控制指令不再重复建任务(派发入口跳过)", () => {
  const app = createTestApp();

  beforeEach(() => {
    // 前一用例被 afterEach kill 的假 bin 可能被打断在 git 提交中途,留下
    // .git/index.lock —— 清掉残留锁,避免跨用例竞态。
    const repoRoot = process.env.COAGENTHUB_REPO_ROOT;
    if (repoRoot) {
      rmSync(path.join(repoRoot, ".git", "index.lock"), { force: true });
    }
  });

  afterEach(() => {
    // 清理内存队列(模块级状态跨用例共享)。
    __resetExecutorQueueForTests();
    delete process.env.FAKE_BIN_DONE_FILE;
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

  async function registerCodeBuddy() {
    // 名字必须与内置执行器 agentName 一致(控制指令 ⛔ 回传按名字找执行器
    // 身份);跨用例复用同名 participant(名字唯一约束)。
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "CodeBuddy" }),
    });
    if (res.status === 409) {
      const list = (await (await app.request("/api/participants")).json()) as {
        id: string;
        name: string;
      }[];
      const existing = list.find((p) => p.name === "CodeBuddy");
      if (existing) return { id: existing.id };
    }
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  async function bindExecutorKey(id: string, key: string) {
    // executor_key 有唯一约束:先把旧绑定释放,再绑到新 participant。
    await testDb
      .update(participantTable)
      .set({ executorKey: null })
      .where(eq(participantTable.executorKey, key));
    await testDb
      .update(participantTable)
      .set({ executorKey: key })
      .where(eq(participantTable.id, id));
  }

  /** 建群:创建者自动成为 coordinator 成员(定向的目标)。 */
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

  async function waitForMarker(file: string, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(file)) {
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for bin done marker ${file}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function groupMessages(memberId: string, groupId: string) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      headers: { "X-Participant-Id": memberId },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{ id: string; body: string }>;
  }

  /** 轮询直到群里出现满足谓词的消息(控制通道 fire-and-forget 回传);超时抛错。 */
  async function waitForGroupMessage(
    memberId: string,
    groupId: string,
    predicate: (m: { body: string }) => boolean,
    timeoutMs = 10_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const messages = await groupMessages(memberId, groupId);
      const hit = messages.find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(`群里未在 ${timeoutMs}ms 内出现预期消息`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** 派发是 fire-and-forget:短暂等待后断言该消息没有任务行。 */
  async function assertNoTaskForMessage(messageId: string) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await taskByMessage(messageId)).toBeUndefined();
  }

  /** 群主 = coordinator(CodeBuddy 成员在场保证控制回传身份)。
   *  bindCoordinator=false 时 coordinator 不绑执行器 key:participant 定向
   *  执行器的消息在控制通道按既有语义视为任务(任务照常创建,不受本票影响),
   *  该子场景的验收需用非执行器 coordinator 才能观察「控制照常执行」。 */
  async function setupGroup(bindCoordinator = true) {
    const coordinator = await registerParticipant(
      `ctl-skip-coord-${randomUUID()}`,
    );
    if (bindCoordinator) {
      await bindExecutorKey(coordinator.id, "executor");
    }
    const codebuddy = await registerCodeBuddy();
    await bindExecutorKey(codebuddy.id, "codebuddy");
    const group = await createGroup(coordinator.id, "控制指令跳过派发");
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  it("验收1:「停止/stop/回滚 <id>」定向 role:coordinator → 控制照常执行、不建任务、响应头带跳过警告", async () => {
    const { coordinator, group } = await setupGroup();
    for (const body of [
      `停止 ${randomUUID()}`,
      `stop ${randomUUID()}`,
      `回滚 ${randomUUID()}`,
    ]) {
      const res = await postMessage(coordinator.id, group.id, {
        body,
        audience: "role",
        audienceRef: "coordinator",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("X-CoAgentHub-Warning")).toBe(
        "CONTROL_COMMAND_SKIPPED_DISPATCH",
      );
      const msg = (await res.json()) as { id: string };
      await assertNoTaskForMessage(msg.id);
    }
    // 控制照常执行:群里有执行器身份 ⛔ 回传(role 定向不被「执行器即任务」跳过)。
    await waitForGroupMessage(coordinator.id, group.id, (m) =>
      m.body.startsWith("⛔"),
    );
  }, 30_000);

  /**
   * 群主 = coordinator 且绑定执行器 key(为可被平台拉起而同时持有 key):
   * 验收 1 的「已绑定 coordinator participant」路径。
   */
  async function setupGroupWithBoundCoordinator() {
    const coordinator = await registerParticipant(
      `ctl-skip-coord-${randomUUID()}`,
    );
    const codebuddy = await registerCodeBuddy();
    await bindExecutorKey(codebuddy.id, "codebuddy");
    const group = await createGroup(coordinator.id, "控制指令跳过派发");
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    // 关键场景:coordinator 本群角色是 coordinator(群主),同时绑定执行器
    // key(平台可拉起)。目标分类必须按本群角色,不能只看 key 绑定。
    await bindExecutorKey(coordinator.id, "executor");
    return { coordinator, codebuddy, group };
  }

  it("验收1:「停止 <id>」定向 coordinator participant → 不建任务、响应头带跳过警告、控制照常回传", async () => {
    // coordinator 不绑执行器:participant 定向它的消息在控制通道不走
    // 「执行器即任务」分支,控制照常执行(⛔ 回传),派发入口跳过不建任务。
    const { coordinator, group } = await setupGroup(false);
    const res = await postMessage(coordinator.id, group.id, {
      body: `停止 ${randomUUID()}`,
      audience: "participant",
      audienceRef: coordinator.id,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-CoAgentHub-Warning")).toBe(
      "CONTROL_COMMAND_SKIPPED_DISPATCH",
    );
    const msg = (await res.json()) as { id: string };
    await assertNoTaskForMessage(msg.id);
    await waitForGroupMessage(coordinator.id, group.id, (m) =>
      m.body.startsWith("⛔"),
    );
  }, 30_000);

  it("验收1(回归):「停止/回滚 <id>」定向绑定执行器 key 的 coordinator participant → 不建任务、跳过警告、控制照常执行", async () => {
    // coordinator 本群角色是 coordinator,但为可被平台拉起同时绑定执行器
    // key。旧判据「participant 是否绑定执行器 key = 是否执行器任务目标」在此
    // 不成立:它曾让控制通道把停止指令当作任务、派发入口建出 detached task 并
    // 回 SPEC_HASH_MISSING。目标分类按本群唯一角色:coordinator → 控制通道。
    const { coordinator, group } = await setupGroupWithBoundCoordinator();
    for (const body of [`停止 ${randomUUID()}`, `回滚 ${randomUUID()}`]) {
      const res = await postMessage(coordinator.id, group.id, {
        body,
        audience: "participant",
        audienceRef: coordinator.id,
      });
      expect(res.status).toBe(200);
      // 控制指令归控制通道 → 派发入口跳过(跳过警告),而非误建任务。
      expect(res.headers.get("X-CoAgentHub-Warning")).toBe(
        "CONTROL_COMMAND_SKIPPED_DISPATCH",
      );
      const msg = (await res.json()) as { id: string };
      await assertNoTaskForMessage(msg.id);
    }
    // 控制照常执行:停止/回滚都由控制通道回传(⛔/❌),证明未被当作任务。
    await waitForGroupMessage(
      coordinator.id,
      group.id,
      (m) => m.body.startsWith("⛔") || m.body.startsWith("❌"),
    );
  }, 30_000);

  it("验收2:普通任务票定向 coordinator(participant)照常建任务,无跳过警告", async () => {
    const { coordinator, group } = await setupGroup();
    const marker = path.join(markerDir, randomUUID());
    process.env.FAKE_BIN_DONE_FILE = marker;
    const res = await postMessage(coordinator.id, group.id, {
      body: "请实现功能 X",
      audience: "participant",
      audienceRef: coordinator.id,
    });
    expect(res.status).toBe(200);
    // 执行器绑定目标缺 specHash → 只有既有 SPEC_HASH_MISSING,无跳过信号。
    expect(res.headers.get("X-CoAgentHub-Warning")).toBe("SPEC_HASH_MISSING");
    const msg = (await res.json()) as { id: string };
    const task = await waitForTaskByMessage(msg.id);
    expect(task.executorParticipantId).toBe(coordinator.id);
    await waitForMarker(marker);
  }, 30_000);

  it("验收3:广播控制指令逐字不变——控制照常回传、不建任务、无任何警告头", async () => {
    const { coordinator, group } = await setupGroup();
    const res = await postMessage(coordinator.id, group.id, {
      body: `停止 ${randomUUID()}`,
      audience: "broadcast",
    });
    expect(res.status).toBe(200);
    // broadcast 不走派发入口 → 无警告头(与现状逐字一致)。
    expect(res.headers.get("X-CoAgentHub-Warning")).toBeNull();
    const msg = (await res.json()) as { id: string };
    await assertNoTaskForMessage(msg.id);
    await waitForGroupMessage(coordinator.id, group.id, (m) =>
      m.body.startsWith("⛔"),
    );
  }, 30_000);

  it("验收4:「停止讨论,开始实现 X」既有歧义不变——仍按控制指令处理", async () => {
    const { coordinator, group } = await setupGroup();
    const res = await postMessage(coordinator.id, group.id, {
      body: "停止讨论,开始实现 X",
      audience: "role",
      audienceRef: "coordinator",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-CoAgentHub-Warning")).toBe(
      "CONTROL_COMMAND_SKIPPED_DISPATCH",
    );
    const msg = (await res.json()) as { id: string };
    await assertNoTaskForMessage(msg.id);
    // 歧义行为不变:语法命中停止前缀 → 控制通道执行(⛔ 回传),不按任务处理。
    await waitForGroupMessage(coordinator.id, group.id, (m) =>
      m.body.startsWith("⛔"),
    );
  }, 30_000);

  it("红线:「停止」定向执行器 participant 照常建任务(控制通道视为任务),无跳过警告", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    const marker = path.join(markerDir, randomUUID());
    process.env.FAKE_BIN_DONE_FILE = marker;
    const res = await postMessage(coordinator.id, group.id, {
      body: "停止",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    expect(res.status).toBe(200);
    // 控制通道跳过「定向执行器 participant」(既有语义)→ 派发入口不得跳过:
    // 任务照常创建,只有既有 SPEC_HASH_MISSING。
    expect(res.headers.get("X-CoAgentHub-Warning")).toBe("SPEC_HASH_MISSING");
    const msg = (await res.json()) as { id: string };
    const task = await waitForTaskByMessage(msg.id);
    expect(task.executorParticipantId).toBe(codebuddy.id);
    await waitForMarker(marker);
  }, 30_000);
});
