import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  dispatchIntent as dispatchIntentTable,
  executorConfig as executorConfigTable,
  groupMember as groupMemberTable,
  groupMessageClosure as groupMessageClosureTable,
  groupMessage as groupMessageTable,
  groups as groupsTable,
  participant as participantTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DataBase } from "../src/lib/database";
import { seedBuiltinExecutorConfigs, testDb } from "./db";
import { resolveFakeExecutor, withFakeExecutorArgs } from "./fake-executor-bin";

/**
 * 多协调者并存与工作树级协调串行
 * (specs/multiple-coordinators-with-global-serialization.md v1.3)的定向回归。
 *
 * 覆盖 spec §4 的 9 条验收:
 *  1 存活协调进程 → 同群另一协调票排队,进程退出后被拉起
 *  2 父任务 running ≠ 占用(死锁修正的核心断言)
 *  3 协调进程与执行器任务双向互斥
 *  4 等待任务按创建顺序拉起,不丢不重
 *  5 单协调者 role 定向 + 「派完即退 → 续跑 → L2 → 关父」全链路回归
 *  6 participant 显式定向落到目标协调者
 *  7 跨 projectPath 的两个群并行
 *  8 全协调者冷却 → fallback 排队不变
 *  9 认领超时:工作树闸满豁免 / 冷却豁免(现状)/ 非闸阻塞仍失败(现状)
 *
 * 判据口径都取自被测代码本身:工作树占用数读 `runningWorkspaceCount`
 * (统一占用源),任务状态读 DB 行,不靠读源码文本断言。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-wsgate-bin-"));
const fakeScript = path.join(fakeDir, "fake-agent.sh");
writeFileSync(
  fakeScript,
  [
    "#!/bin/sh",
    'if [ -n "$FAKE_GATE_SLEEP_SECS" ]; then sleep "$FAKE_GATE_SLEEP_SECS"; fi',
    // 弱验收要求工作树干净 + HEAD 有新提交;并发访问 git index 时用原子 mkdir
    // 保护临界区(fixture 自身不制造 .git/index.lock 竞态)。
    'git_lock="$PWD/.coagenthub-wsgate-git-lock"',
    'while ! mkdir "$git_lock" 2>/dev/null; do sleep 0.01; done',
    "trap 'rmdir \"$git_lock\" 2>/dev/null || true' EXIT",
    'if ! git add -A || ! git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake agent change"; then exit 1; fi',
    'rmdir "$git_lock"',
    "trap - EXIT",
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:修改完成"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeScript, 0o755);
const { bin: fakeBin, argsPrefix: fakeArgsPrefix } =
  resolveFakeExecutor(fakeScript);
// 三个内置 key 都指向同一个假 bin:协调者 A / 协调者 B / 执行器各用不同 key,
// 互不干扰(执行器级并发上限按 key 聚合)。
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;
process.env.EXECUTOR_BIN_CODEX = fakeBin;
process.env.EXECUTOR_BIN_EXECUTOR = fakeBin;

// 顶层 await 动态 import:env 设置先于模块求值。
const { createTestApp } = await import("./app");
const {
  __resetExecutorQueueForTests,
  __setMaxParallelGroupsForTests,
  __setReliabilityTimeoutsForTests,
  consumePendingCompletionEvents,
  isExecutorProcessAlive,
} = await import("../src/lib/executor-task");
const { coordinatorOccupancyCount, runningWorkspaceCount } = await import(
  "../src/lib/executor-task/state"
);
const { enterCooldown } = await import("../src/lib/executor-task/queue");
const { findExecutorByKey } = await import("@server/lib/executors");

const runtimeDb = testDb as unknown as DataBase;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.sequential("工作树级协调串行(spec multiple-coordinators v1.3)", () => {
  const app = createTestApp();

  async function registerParticipant(name: string) {
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  /** 显式绑定 executorKey(同一 key 同时只绑一个 participant,避免干扰并发上限)。 */
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

  async function bindProject(actorId: string, groupId: string, dir: string) {
    const res = await app.request(`/api/groups/${groupId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": actorId,
      },
      body: JSON.stringify({ projectPath: dir }),
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
    if (res.status !== 200) {
      throw new Error(`发消息失败 ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as { id: string };
  }

  async function findTask(messageId: string) {
    const rows = await testDb
      .select()
      .from(taskTable)
      .where(eq(taskTable.messageId, messageId));
    return rows[0];
  }

  /** 建临时 git 仓库(project_path 绑定用;执行前快照需要真实仓库)。 */
  function makeGitRepo(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@coagenthub.local"], {
      cwd: dir,
    });
    execFileSync("git", ["config", "user.name", "coagenthub-test"], {
      cwd: dir,
    });
    writeFileSync(path.join(dir, "hello.txt"), "original\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "seed"], { cwd: dir });
    return dir;
  }

  /** 轮询直到任务行出现并达到指定状态。 */
  async function waitForTask(
    messageId: string,
    status: string,
    timeoutMs = 20_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const t = await findTask(messageId);
      if (t?.status === status) return t;
      if (Date.now() > deadline) {
        throw new Error(
          `task(${messageId}) 未在 ${timeoutMs}ms 内达到 ${status}(当前=${t?.status ?? "无"})`,
        );
      }
      await sleep(50);
    }
  }

  /** 断言任务在 ms 内**保持**指定状态(用于「不该被派发」的反向断言)。 */
  async function expectStaysInStatus(
    messageId: string,
    status: string,
    ms: number,
  ) {
    const deadline = Date.now() + ms;
    for (;;) {
      const t = await findTask(messageId);
      if (t && t.status !== status) {
        throw new Error(
          `task(${messageId}) 不应离开 ${status},实际=${t.status}`,
        );
      }
      if (Date.now() > deadline) return;
      await sleep(50);
    }
  }

  /**
   * 轮询直到 coordinatorOccupancyCount 达到期望值。
   * 必须等被断言的量本身 —— runningWorkspaceCount 在 status=running 时就已 +1,
   * 而 coordinatorOccupancyCount 要到 spawn 后 registerCoordinatorProcess 才变 1,
   * 两者之间隔着 createCheckpoint 等,等错量会必然抢跑。
   */
  async function waitForCoordinatorOccupancy(
    projectPath: string,
    expected: number,
    timeoutMs = 20_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const cur = coordinatorOccupancyCount(projectPath);
      if (cur === expected) return;
      if (Date.now() > deadline) {
        throw new Error(
          `coordinatorOccupancyCount 未在 ${timeoutMs}ms 内达到 ${expected}(当前=${cur})`,
        );
      }
      await sleep(50);
    }
  }

  /** 轮询直到协调任务的进程已退出(占用判据:进程存活,不是 status=running)。 */
  async function waitForProcessExit(messageId: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const t = await findTask(messageId);
      if (t?.executorPid && !isExecutorProcessAlive(t.executorPid)) return;
      if (Date.now() > deadline) {
        throw new Error(`task(${messageId}) 的进程未在 ${timeoutMs}ms 内退出`);
      }
      await sleep(50);
    }
  }

  /**
   * 群 fixture:协调者 A 建群(自动 coordinator 成员)+ 下发者 + 执行器,群绑一棵
   * 临时工作树。默认再加一个协调者 B,用于「同树两个协调者」的用例。
   *
   * 下发者角色决定编制:reviewer 在场 = 三方(父任务结案需 review_request 交接
   * 载荷);human = 两方(无 L3,结案不受该守卫约束)。
   */
  async function setupGroup(
    opts: {
      dispatcherRole?: "reviewer" | "human";
      secondCoordinator?: boolean;
    } = {},
  ) {
    const role = opts.dispatcherRole ?? "reviewer";
    const dispatcher = await registerParticipant(
      `${role}-${crypto.randomUUID()}`,
    );
    const coordA = await registerParticipant(`coordA-${crypto.randomUUID()}`);
    const coordB = await registerParticipant(`coordB-${crypto.randomUUID()}`);
    const execX = await registerParticipant(`exec-${crypto.randomUUID()}`);
    await bindExecutorKey(coordA.id, "codebuddy");
    await bindExecutorKey(coordB.id, "codex");
    await bindExecutorKey(execX.id, "executor");

    // coordA 是建群者 → 自动成员(coordinator 角色)。
    const group = await createGroup(coordA.id, `gate-${crypto.randomUUID()}`);
    await addMember(coordA.id, group.id, dispatcher.id, [role]);
    if (opts.secondCoordinator ?? true) {
      await addMember(coordA.id, group.id, coordB.id, ["coordinator"]);
    }
    await addMember(coordA.id, group.id, execX.id, ["executor"]);
    const projectPath = makeGitRepo("coagenthub-wsgate-repo-");
    await bindProject(dispatcher.id, group.id, projectPath);
    return { dispatcher, coordA, coordB, execX, group, projectPath };
  }

  beforeEach(async () => {
    __resetExecutorQueueForTests();
    // dispatch_intent 外键指向 group_message(0031),必须先删,否则
    // 下面这条 delete 会被外键约束挡住,整个 beforeEach 连带失败。
    await testDb.delete(dispatchIntentTable);
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

  beforeAll(async () => {
    await seedBuiltinExecutorConfigs();
    // win32: EXECUTOR_BIN 只覆盖 bin;把脚本路径拼进 args 最前面,原占位参数顺序不变。
    if (fakeArgsPrefix.length > 0) {
      for (const key of ["codebuddy", "codex", "executor"] as const) {
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

  it("验收 1:协调者 A 进程存活期间 B 的协调票排队;A 进程退出后 B 被拉起", async () => {
    process.env.FAKE_GATE_SLEEP_SECS = "3";
    const { dispatcher, coordA, coordB, group, projectPath } =
      await setupGroup();

    // A 的协调票:spawn 后进程存活 3s(detached,任务保持 running)。
    const msgA = await postMessage(dispatcher.id, group.id, {
      body: "协调票 A",
      audience: "participant",
      audienceRef: coordA.id,
    });
    await waitForTask(msgA.id, "running");
    // 等被断言的量本身:spawn 后 registerCoordinatorProcess 才登记占用。
    await waitForCoordinatorOccupancy(projectPath, 1);
    expect(coordinatorOccupancyCount(projectPath)).toBe(1);

    // 给 B 的协调票:不同 executor key,但同一棵工作树 → 必须排队,不 spawn。
    const msgB = await postMessage(dispatcher.id, group.id, {
      body: "协调票 B",
      audience: "participant",
      audienceRef: coordB.id,
    });
    await waitForTask(msgB.id, "queued");
    await expectStaysInStatus(msgB.id, "queued", 1_000);

    // A 进程退出 → 占用释放 → B 被既有泵机制拉起。
    await waitForProcessExit(msgA.id);
    expect(coordinatorOccupancyCount(projectPath)).toBe(0);
    const tB = await waitForTask(msgB.id, "running");
    expect(tB.executorParticipantId).toBe(coordB.id);
  }, 60_000);

  it("验收 2:父任务 running ≠ 占用 —— 进程退出后续跑与新协调票都能 spawn", async () => {
    process.env.FAKE_GATE_SLEEP_SECS = "0";
    const { dispatcher, coordA, coordB, group, projectPath } =
      await setupGroup();

    // 父协调任务:进程已退出,但 detached 任务在 DB 里恒为 running(等 PATCH)。
    const msgParent = await postMessage(dispatcher.id, group.id, {
      body: "父协调票",
      audience: "participant",
      audienceRef: coordA.id,
    });
    await waitForTask(msgParent.id, "running");
    await waitForProcessExit(msgParent.id);
    const parent = await findTask(msgParent.id);
    expect(parent.status).toBe("running"); // 父任务仍 running
    // 死锁修正的核心断言:status=running 不产生占用 —— 按 status 计数会让
    // 续跑永远 spawn 不出来(wake-the-coordinator 整体死锁)。
    expect(runningWorkspaceCount(projectPath)).toBe(0);

    // (b) 给 B 的新协调票:父任务仍 running,但闸是空的 → 必须能 spawn。
    const msgB = await postMessage(dispatcher.id, group.id, {
      body: "父任务仍 running 时的新协调票",
      audience: "participant",
      audienceRef: coordB.id,
    });
    const tB = await waitForTask(msgB.id, "running");
    expect(tB.executorParticipantId).toBe(coordB.id);
    // (a) 续跑任务的 spawn 走同一判定,由「验收 5 全链路」端到端覆盖。
  }, 60_000);

  it("验收 3a:协调进程存活期间同工作树的执行器任务排队;协调进程退出后被泵出", async () => {
    process.env.FAKE_GATE_SLEEP_SECS = "3";
    const { dispatcher, coordA, execX, group } = await setupGroup();

    const msgCoord = await postMessage(dispatcher.id, group.id, {
      body: "协调票(进程存活 3s)",
      audience: "participant",
      audienceRef: coordA.id,
    });
    await waitForTask(msgCoord.id, "running");

    // 协调者的 L2 测试代跑同样写这棵工作树 → 执行器任务必须排队。
    const msgExec = await postMessage(dispatcher.id, group.id, {
      body: "执行器任务",
      audience: "participant",
      audienceRef: execX.id,
    });
    await waitForTask(msgExec.id, "queued");
    await expectStaysInStatus(msgExec.id, "queued", 1_000);

    // 协调进程退出 → 闸释放 → 执行器任务被泵出并跑完。
    await waitForProcessExit(msgCoord.id);
    await waitForTask(msgExec.id, "running");
    await waitForTask(msgExec.id, "done");
  }, 60_000);

  it("验收 3b:执行器任务 running 时协调任务(新票)排队,执行器终态后被拉起", async () => {
    process.env.FAKE_GATE_SLEEP_SECS = "3";
    const { dispatcher, coordA, execX, group } = await setupGroup();

    const msgExec = await postMessage(dispatcher.id, group.id, {
      body: "执行器任务(慢)",
      audience: "participant",
      audienceRef: execX.id,
    });
    await waitForTask(msgExec.id, "running");

    const msgCoord = await postMessage(dispatcher.id, group.id, {
      body: "协调票",
      audience: "participant",
      audienceRef: coordA.id,
    });
    await waitForTask(msgCoord.id, "queued");
    await expectStaysInStatus(msgCoord.id, "queued", 1_000);

    await waitForTask(msgExec.id, "done");
    await waitForTask(msgCoord.id, "running");
  }, 60_000);

  it("验收 4:等待任务按创建顺序拉起,不丢任务、不重复 spawn", async () => {
    process.env.FAKE_GATE_SLEEP_SECS = "1";
    const { dispatcher, coordA, execX, group } = await setupGroup();

    // 协调进程先占住闸,让三条执行器任务排队(顺序 = 创建顺序)。
    const msgCoord = await postMessage(dispatcher.id, group.id, {
      body: "协调票(占闸)",
      audience: "participant",
      audienceRef: coordA.id,
    });
    await waitForTask(msgCoord.id, "running");

    const msgs: string[] = [];
    for (const label of ["任务一", "任务二", "任务三"]) {
      const m = await postMessage(dispatcher.id, group.id, {
        body: label,
        audience: "participant",
        audienceRef: execX.id,
      });
      msgs.push(m.id);
      await waitForTask(m.id, "queued");
    }

    await waitForProcessExit(msgCoord.id);
    const done: Array<{ startedAt: string; attempts: unknown }> = [];
    for (const id of msgs) {
      const t = await waitForTask(id, "done");
      const attempts = t.attempts as Array<{ startedAt?: string }>;
      // 不重复 spawn:每条任务只有一次执行尝试。
      expect(attempts.length).toBe(1);
      done.push({ startedAt: attempts[0]?.startedAt ?? "", attempts });
    }
    // 不丢任务 + 按创建顺序拉起:spawn 时刻严格递增。
    const started = done.map((d) => d.startedAt);
    expect(started).toEqual([...started].sort());
  }, 60_000);

  it("验收 5:单协调者 role 定向 + 派完即退 → 续跑 → L2 → 关父全链路回归", async () => {
    process.env.FAKE_GATE_SLEEP_SECS = "0";
    // 单协调者 + 两方编制(无 reviewer 成员):复刻现行 wake-the-coordinator
    // 全链路,确认本票未改变「派完即退 → 续跑 → L2 → 关父」的逐字行为。
    const { dispatcher, coordA, execX, group } = await setupGroup({
      dispatcherRole: "human",
      secondCoordinator: false,
    });

    // role 定向:票应落在持有 coordinator 角色且绑了执行器配置的协调者身上。
    // human 下发者只能作为外部触发方带规范下发(specRef + specHash 缺一不可)。
    const msgParent = await postMessage(dispatcher.id, group.id, {
      body: "父协调票(role 定向)",
      audience: "role",
      audienceRef: "coordinator",
      specRef: "specs/coordinator-workspace-gate.md",
      specHash: "80b0336bd794dfffd55ff5e0844ae31fc194a331",
    });
    const parentTask = await waitForTask(msgParent.id, "running");
    expect(parentTask.executorParticipantId).toBe(coordA.id);

    // 协调者「派完即退」:进程退出后父任务保持 running(detached,不判失败)。
    await waitForProcessExit(msgParent.id);
    expect((await findTask(msgParent.id)).status).toBe("running");

    // 子任务:父进程已退出、父任务仍 running —— 闸是空的,子任务必须能 spawn。
    const msgChild = await postMessage(coordA.id, group.id, {
      body: "子任务",
      audience: "participant",
      audienceRef: execX.id,
    });
    const childTask = await waitForTask(msgChild.id, "done");

    // 子任务终态 → 平台创建续跑任务并拉起协调者(验收 2a:续跑不被父任务阻塞)。
    await consumePendingCompletionEvents(runtimeDb);
    const resume = await waitForResumeTask(parentTask.id);
    expect(resume.executorParticipantId).toBe(coordA.id);
    expect(resume.status).toBe("running");

    // 协调者在续跑任务里做 L2 并 PATCH 父任务结案。
    const patchRes = await app.request(
      `/api/groups/${group.id}/tasks/${parentTask.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": coordA.id,
        },
        body: JSON.stringify({
          status: "done",
          diffSummary: {
            summary: "L2 通过",
            claimAdjudication: {
              [childTask.id]: { accepted: true, reason: "假执行器仅验证链路" },
            },
          },
        }),
      },
    );
    expect(patchRes.status, await patchRes.text()).toBe(200);
    expect((await findTask(msgParent.id)).status).toBe("done");
  }, 60_000);

  it("验收 6:participant 显式定向到协调者 → 任务落在该协调者", async () => {
    process.env.FAKE_GATE_SLEEP_SECS = "0";
    const { dispatcher, coordB, group } = await setupGroup();

    // 群内有两个 coordinator 成员;显式定向必须绕开 role 解析直落 B。
    const msg = await postMessage(dispatcher.id, group.id, {
      body: "显式定向到 B",
      audience: "participant",
      audienceRef: coordB.id,
    });
    const task = await waitForTask(msg.id, "running");
    expect(task.executorParticipantId).toBe(coordB.id);
    expect(task.executorKey).toBe("codex");
  }, 60_000);

  it("验收 7:两个群绑不同 projectPath → 各自协调任务互不阻塞", async () => {
    process.env.FAKE_GATE_SLEEP_SECS = "3";
    const { dispatcher, coordA, coordB, group } = await setupGroup();
    const group2 = await createGroup(coordB.id, `gate2-${crypto.randomUUID()}`);
    await addMember(coordB.id, group2.id, dispatcher.id, ["reviewer"]);
    await addMember(coordB.id, group2.id, coordA.id, ["coordinator"]);
    const projectPath2 = makeGitRepo("coagenthub-wsgate-repo2-");
    await bindProject(dispatcher.id, group2.id, projectPath2);

    const msg1 = await postMessage(dispatcher.id, group.id, {
      body: "群1 协调票(进程存活 3s)",
      audience: "participant",
      audienceRef: coordA.id,
    });
    await waitForTask(msg1.id, "running");

    // 不设全局闸:另一棵工作树上的协调任务必须立即并行,不排队。
    const msg2 = await postMessage(dispatcher.id, group2.id, {
      body: "群2 协调票",
      audience: "participant",
      audienceRef: coordA.id,
    });
    const t2 = await waitForTask(msg2.id, "running");
    expect((await findTask(msg1.id)).status).toBe("running");
    expect(t2.status).toBe("running");
  }, 60_000);

  it("验收 8:全协调者冷却/不可用 → fallback 排队(现状)且冷却结束后自动派发", async () => {
    process.env.FAKE_GATE_SLEEP_SECS = "0";
    const { dispatcher, group } = await setupGroup();

    const exA = await findExecutorByKey(runtimeDb, "codebuddy");
    const exB = await findExecutorByKey(runtimeDb, "codex");
    expect(exA).toBeDefined();
    expect(exB).toBeDefined();
    // 两个协调者的执行器都进冷却(600ms)→ resolveRoleTarget 全部排除,
    // 回退到第一个持有执行器配置的成员,由既有排队机制等其可用。
    enterCooldown(exA as never, Date.now() + 600);
    enterCooldown(exB as never, Date.now() + 600);

    const msg = await postMessage(dispatcher.id, group.id, {
      body: "全冷却时的 role 定向票",
      audience: "role",
      audienceRef: "coordinator",
    });
    const queued = await waitForTask(msg.id, "queued");
    expect(queued.status).toBe("queued");
    await expectStaysInStatus(msg.id, "queued", 200);

    // 冷却结束定时器自动泵送 → 任务被派发(与现状 fallback 语义一致)。
    await waitForTask(msg.id, "running");
  }, 60_000);

  describe.sequential("验收 9:认领超时对「调度闸阻塞」豁免", () => {
    const CLAIM_MS = 300;

    function useShortClaimTimeout() {
      // stall 取大值避免静默超时干扰;claim 取小值让豁免分支在测试内触发。
      __setReliabilityTimeoutsForTests(60_000, CLAIM_MS);
    }

    it("正例:工作树闸满(同树任务 running)→ queued 超过认领阈值不标 failed,闸释放后被泵出", async () => {
      useShortClaimTimeout();
      process.env.FAKE_GATE_SLEEP_SECS = "2";
      const { dispatcher, execX, group } = await setupGroup();

      const msg1 = await postMessage(dispatcher.id, group.id, {
        body: "占闸任务(慢)",
        audience: "participant",
        audienceRef: execX.id,
      });
      await waitForTask(msg1.id, "running");

      const msg2 = await postMessage(dispatcher.id, group.id, {
        body: "被闸挡住的任务",
        audience: "participant",
        audienceRef: execX.id,
      });
      await waitForTask(msg2.id, "queued");
      // 远超认领阈值:任务是被泵**合法**跳过的,不是被遗弃 → 不得标 failed。
      await expectStaysInStatus(msg2.id, "queued", CLAIM_MS * 3);

      await waitForTask(msg1.id, "done");
      await waitForTask(msg2.id, "running");
      const done = await waitForTask(msg2.id, "done");
      expect(done.status).toBe("done");
    }, 60_000);

    it("反例回归 A:执行器冷却中同样豁免(现状语义不变)", async () => {
      useShortClaimTimeout();
      process.env.FAKE_GATE_SLEEP_SECS = "0";
      const { dispatcher, execX, group } = await setupGroup();

      const ex = await findExecutorByKey(runtimeDb, "executor");
      enterCooldown(ex as never, Date.now() + 1_500);

      const msg = await postMessage(dispatcher.id, group.id, {
        body: "冷却期间入队的任务",
        audience: "participant",
        audienceRef: execX.id,
      });
      await waitForTask(msg.id, "queued");
      await expectStaysInStatus(msg.id, "queued", CLAIM_MS * 3);

      await waitForTask(msg.id, "running");
    }, 60_000);

    it("反例回归 B:非工作树闸阻塞(并行组数上限)→ 超过认领阈值仍标 failed", async () => {
      useShortClaimTimeout();
      process.env.FAKE_GATE_SLEEP_SECS = "3";
      const { dispatcher, execX, group } = await setupGroup();
      // maxParallelGroups=1 → 退化为全局串行:另一棵工作树的任务因**组槽位**
      // 排队,不是工作树闸 → 认领超时照旧生效。
      __setMaxParallelGroupsForTests(1);
      try {
        const group2 = await createGroup(
          dispatcher.id,
          `gate3-${crypto.randomUUID()}`,
        );
        await addMember(dispatcher.id, group2.id, execX.id, ["executor"]);
        const projectPath2 = makeGitRepo("coagenthub-wsgate-repo3-");
        await bindProject(dispatcher.id, group2.id, projectPath2);

        const msg1 = await postMessage(dispatcher.id, group.id, {
          body: "占住唯一组槽位(慢)",
          audience: "participant",
          audienceRef: execX.id,
        });
        await waitForTask(msg1.id, "running");

        const msg2 = await postMessage(dispatcher.id, group2.id, {
          body: "另一棵工作树、被组槽位挡住的任务",
          audience: "participant",
          audienceRef: execX.id,
        });
        await waitForTask(msg2.id, "queued");

        const failed = await waitForTask(msg2.id, "failed");
        expect((failed.diffSummary as { error?: string } | null)?.error).toBe(
          "任务未认领",
        );
      } finally {
        __setMaxParallelGroupsForTests(2);
      }
    }, 60_000);

    it("反例回归 C:默认组(未绑 projectPath)组内单槽阻塞 → 超过认领阈值仍标 failed", async () => {
      useShortClaimTimeout();
      process.env.FAKE_GATE_SLEEP_SECS = "2";
      // 默认组不绑 projectPath:它不参与工作树闸(spec R1:沿用 serial-dispatch-guard
      // 既有口径,组内单槽),组内单槽是另一套既有机制——R1.1 豁免只豁免「工作树闸」
      // 这一个事实,不得悄悄放宽默认组 30 分钟未认领的既有语义。
      const dispatcher = await registerParticipant(
        `defgroup-${crypto.randomUUID()}`,
      );
      const coordA = await registerParticipant(`coordA-${crypto.randomUUID()}`);
      const execX = await registerParticipant(`exec-${crypto.randomUUID()}`);
      await bindExecutorKey(execX.id, "executor");
      const group = await createGroup(
        coordA.id,
        `defgate-${crypto.randomUUID()}`,
      );
      await addMember(coordA.id, group.id, dispatcher.id, ["reviewer"]);
      await addMember(coordA.id, group.id, execX.id, ["executor"]);

      const msg1 = await postMessage(dispatcher.id, group.id, {
        body: "占住默认组单槽(慢)",
        audience: "participant",
        audienceRef: execX.id,
      });
      await waitForTask(msg1.id, "running");

      const msg2 = await postMessage(dispatcher.id, group.id, {
        body: "被单槽挡住的任务",
        audience: "participant",
        audienceRef: execX.id,
      });
      await waitForTask(msg2.id, "queued");

      const failed = await waitForTask(msg2.id, "failed");
      expect((failed.diffSummary as { error?: string } | null)?.error).toBe(
        "任务未认领",
      );
    }, 60_000);
  });
});

/** 轮询父任务名下被平台创建的续跑任务(由完成事件消费路径生成)。 */
async function waitForResumeTask(parentTaskId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await testDb
      .select()
      .from(taskTable)
      .where(eq(taskTable.parentTaskId, parentTaskId));
    const hit = rows.find((r) => {
      const summary = r.diffSummary;
      return (
        typeof summary === "object" &&
        summary !== null &&
        !Array.isArray(summary) &&
        typeof (summary as Record<string, unknown>).platform === "object"
      );
    });
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(
        `续跑任务(parent=${parentTaskId}) 未在 ${timeoutMs}ms 内出现`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
