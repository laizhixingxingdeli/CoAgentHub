import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * 阶段2-票2 + 调度并行化(票4):server 按 project_path 分组的执行队列(同组
 * 串行、跨组并行,并行组数 ≤ maxParallelGroups)+ 停止/回滚控制指令 + 重启兜底。
 *
 * 用 fake bin 做集成测试(票面允许):把 EXECUTOR_BIN_CODEBUDDY 指到一个
 * 可配置的临时 shell 脚本(FAKE_SLEEP_SECS 控制时长、FAKE_APPEND 控制是否
 * 修改工作区文件),COAGENTHUB_REPO_ROOT 指到临时 git 仓库(执行前快照/回滚需要)。
 *
 * 覆盖:同组(默认组)两条定向消息只有一条 running、另一条 queued 且完成后
 * 才轮到;不同 project_path 的两个任务可同时 running;同一 project_path 的
 * 两个群任务严格串行;maxParallelGroups=1 时退化为全局串行;默认组(无
 * project_path)任务可与项目组并行;「停止」kill 进程组(task → cancelled +
 * 🛑 回传);「回滚 <taskId>」恢复工作区(task → failed + ✅ 回传);重启兜底
 * queued/running → failed。
 *
 * 可靠性保障(票5):静默超时(无输出假 bin → failed + ❌ 含「静默」;持续输出
 * 不误杀)、认领超时(占满槽位后排队任务 → failed + ❌ 含「未认领」;已 running
 * 不受认领阈值影响)、停止任务不被超时误伤。阈值经 __setReliabilityTimeoutsForTests
 * 调小到 100ms 级,避免拖慢测试。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-queue-bin-"));
const fakeBin = path.join(fakeDir, "fake-codebuddy.sh");
writeFileSync(
  fakeBin,
  [
    "#!/bin/sh",
    'if [ -n "$FAKE_SLEEP_SECS" ]; then sleep "$FAKE_SLEEP_SECS"; fi',
    // 持续输出模式(静默检测测试用):每 FAKE_OUTPUT_INTERVAL_MS 秒输出一行,
    // 共 FAKE_OUTPUT_LOOPS 行;总时长超过 stall 阈值但输出间隔小于阈值 → 不误杀。
    'if [ -n "$FAKE_OUTPUT_LOOPS" ]; then',
    "  i=0",
    '  while [ "$i" -lt "$FAKE_OUTPUT_LOOPS" ]; do',
    '    echo "tick $i"',
    '    sleep "$FAKE_OUTPUT_INTERVAL_MS"',
    "    i=$((i + 1))",
    "  done",
    "fi",
    // 尝试计数(重试测试用):FAKE_COUNTER_FILE 累计尝试次数,先写后读。
    'if [ -n "$FAKE_COUNTER_FILE" ]; then',
    "  n=0",
    '  if [ -f "$FAKE_COUNTER_FILE" ]; then n=$(cat "$FAKE_COUNTER_FILE"); fi',
    "  n=$((n + 1))",
    '  echo "$n" > "$FAKE_COUNTER_FILE"',
    "fi",
    // 工作区改动(重试测试:首次失败也带改动,验证重试前回滚把首次改动还原)。
    // 相对 cwd 追加:绑定 project_path 的群 spawn cwd 就是项目仓库。
    'if [ -n "$FAKE_APPEND" ]; then',
    '  if [ -n "$FAKE_COUNTER_FILE" ]; then',
    '    echo "attempt-$n-dirty" >> hello.txt',
    "  else",
    '    echo "task-modified" >> hello.txt',
    "  fi",
    "fi",
    // 失败模式:FAKE_ALWAYS_FAIL 每次都 exit 1;FAKE_FAIL_UNTIL 前 N 次 exit 1
    // (第 N+1 次起正常完成,重试测试用)。
    'if [ -n "$FAKE_ALWAYS_FAIL" ]; then echo "always-fail (attempt $n)"; exit 1; fi',
    'if [ -n "$FAKE_FAIL_UNTIL" ] && [ "$n" -le "$FAKE_FAIL_UNTIL" ]; then',
    '  echo "attempt $n: intended failure"',
    "  exit 1",
    "fi",
    // 403 并发冲突模式(反应式排队测试用):FAKE_CONFLICT_FILE 指向的标记文件
    // 存在 → 模拟执行器返回 403 atomgit_session_concurrency_conflict 并退出
    // (不提交改动);文件不存在 → 正常执行。
    'if [ -n "$FAKE_CONFLICT_FILE" ] && [ -f "$FAKE_CONFLICT_FILE" ]; then',
    '  echo "403 atomgit_session_concurrency_conflict: 另一个会话正在使用执行器"',
    "  exit 1",
    "fi",
    // 弱验收要求工作树干净 + HEAD 有新提交:默认真正提交一次(显式身份,CI 无
    // 全局 git config 也能跑);FAKE_NO_COMMIT 跳过提交(验收失败测试用)。
    'if [ -z "$FAKE_NO_COMMIT" ]; then',
    '  git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake bin change"',
    "fi",
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:修改完成"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeBin, 0o755);
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;
// AtomCode 执行器(内置 maxConcurrency=1)的 bin 同样指向 fake bin:声明式并发
// 上限测试用同一脚本驱动(该脚本忽略 args,仅按 FAKE_* 环境变量行为)。
process.env.EXECUTOR_BIN_EXECUTOR = fakeBin;

// 执行前快照/回滚需要真实 git 仓库;CoAgentHub_REPO_ROOT 覆盖 findRepoRoot。
const repoDir = mkdtempSync(path.join(tmpdir(), "coagenthub-queue-repo-"));
execFileSync("git", ["init", "-q"], { cwd: repoDir });
execFileSync("git", ["config", "user.email", "test@coagenthub.local"], {
  cwd: repoDir,
});
execFileSync("git", ["config", "user.name", "coagenthub-test"], {
  cwd: repoDir,
});
writeFileSync(path.join(repoDir, "hello.txt"), "original\n");
execFileSync("git", ["add", "-A"], { cwd: repoDir });
execFileSync("git", ["commit", "-qm", "seed"], { cwd: repoDir });
process.env.COAGENTHUB_REPO_ROOT = repoDir;

// 顶层 await 动态 import:env 设置先于模块求值。
const { createTestApp } = await import("./app");

describe("执行器队列(按项目分组并行)+ 停止/回滚控制指令 + 重启兜底", () => {
  const app = createTestApp();

  async function registerParticipant(body: Record<string, unknown>) {
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // 名字唯一(0013):同名已注册时服务端返回 409,复用现有 participant(测试内多次 setupGroup)。
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
    return (await res.json()) as {
      id: string;
      groupId: string;
      senderId: string;
    };
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
      checkpointRef: string | null;
      retryCount: number;
      diffSummary: unknown;
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
      senderId: string;
    }>;
  }

  /** 轮询直到 task 达到指定状态;超时抛错。 */
  async function waitForTaskStatus(
    participantId: string,
    groupId: string,
    messageId: string,
    status: string,
    timeoutMs = 15_000,
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

  /** 轮询直到群里出现满足谓词的消息;超时抛错。 */
  async function waitForMessage(
    participantId: string,
    groupId: string,
    predicate: (m: { body: string; contentType: string }) => boolean,
    timeoutMs = 15_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const messages = await listMessages(participantId, groupId);
      const hit = messages.find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(`群里未在 ${timeoutMs}ms 内出现预期消息`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** 轮询直到任务 diffSummary 满足谓词(警示标记等);超时抛错。 */
  async function waitForTaskDiff(
    participantId: string,
    groupId: string,
    messageId: string,
    predicate: (diff: Record<string, unknown> | null) => boolean,
    timeoutMs = 15_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tasks = await listTasks(participantId, groupId);
      const t = tasks.find((x) => x.messageId === messageId);
      const diff = t ? (t.diffSummary as Record<string, unknown> | null) : null;
      if (t && predicate(diff)) return diff;
      if (Date.now() > deadline) {
        throw new Error(
          `task(message=${messageId}) 的 diffSummary 未在 ${timeoutMs}ms 内满足谓词`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** 群主的 coordinator + CodeBuddy 执行器成员就绪。 */
  async function setupGroup() {
    const coordinator = await registerParticipant({
      name: "coord-queue",
    });
    const codebuddy = await registerParticipant({
      name: "CodeBuddy 执行器",
    });
    const group = await createGroup(coordinator.id, "队列控制测试");
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  /** 建临时 git 仓库(project_path 绑定用;快照/回滚需要真实仓库)。 */
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

  /** PATCH /groups/:id 绑定 project_path(必须是存在的绝对目录)。 */
  async function bindProject(
    participantId: string,
    groupId: string,
    dir: string,
  ) {
    const res = await app.request(`/api/groups/${groupId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify({ projectPath: dir }),
    });
    expect(res.status).toBe(200);
  }

  afterAll(() => {
    rmSync(fakeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("组内串行(默认组):同群两条任务只有一条 running,另一条 queued,完成后才轮到", async () => {
    // 默认单测超时 5s,本测试需要跑完真实 sleep + 轮询,显式放宽到 30s。
    // 长 sleep 给并行负载留足余量,避免轮询滞后导致断言误判。
    process.env.FAKE_SLEEP_SECS = "5";
    const { coordinator, codebuddy, group } = await setupGroup();

    const m1 = await postMessage(coordinator.id, group.id, {
      body: "任务一(慢)",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    // 等第一条真正进入 running(保证第二条一定排到它后面)。
    const t1 = await waitForTaskStatus(
      coordinator.id,
      group.id,
      m1.id,
      "running",
    );
    expect(t1.status).toBe("running");

    const m2 = await postMessage(coordinator.id, group.id, {
      body: "任务二",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    // 第一条还在跑(2s),第二条应稳定停留在 queued。
    const t2 = await waitForTaskStatus(
      coordinator.id,
      group.id,
      m2.id,
      "queued",
    );
    expect(t2.status).toBe("queued");
    // 核心不变量:绝不同时存在两个 running 任务。若第一条尚未结束,唯一在跑的
    // 必须是 m1;即使它在轮询间隙恰好完成,m2 也必须是 queued(排队而非并发)。
    const again = await listTasks(coordinator.id, group.id);
    const running = again.filter((t) => t.status === "running");
    expect(running.some((t) => t.messageId === m2.id)).toBe(false);
    if (running.length > 0) {
      expect(running.map((t) => t.messageId)).toEqual([m1.id]);
    }

    // 第一条 done 后,第二条才轮到并完成。
    await waitForTaskStatus(coordinator.id, group.id, m1.id, "done");
    await waitForTaskStatus(coordinator.id, group.id, m2.id, "done");

    // 状态回传:第一条 🚀 先到,第二条 📋 排队 + 🚀 随后。
    const messages = await listMessages(coordinator.id, group.id);
    const taskStatus = messages.filter((m) => m.contentType === "task_status");
    expect(taskStatus.some((m) => m.body.startsWith("🚀"))).toBe(true);
    expect(taskStatus.some((m) => m.body.startsWith("📋"))).toBe(true);
  }, 30_000);

  it("并行:两个不同 project_path 的任务可同时 running", async () => {
    process.env.FAKE_SLEEP_SECS = "5";
    const { coordinator, codebuddy } = await setupGroup();
    // 两个不同项目的群,分别绑定各自的临时 git 仓库。
    const projA = makeGitRepo("coagenthub-par-a-");
    const projB = makeGitRepo("coagenthub-par-b-");
    const groupA = await createGroup(coordinator.id, "并行群 A");
    await addMember(coordinator.id, groupA.id, codebuddy.id, ["executor"]);
    await bindProject(coordinator.id, groupA.id, projA);
    const groupB = await createGroup(coordinator.id, "并行群 B");
    await addMember(coordinator.id, groupB.id, codebuddy.id, ["executor"]);
    await bindProject(coordinator.id, groupB.id, projB);

    const m1 = await postMessage(coordinator.id, groupA.id, {
      body: "任务一(慢)",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const t1 = await waitForTaskStatus(
      coordinator.id,
      groupA.id,
      m1.id,
      "running",
    );
    expect(t1.status).toBe("running");

    const m2 = await postMessage(coordinator.id, groupB.id, {
      body: "任务二(慢)",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    // 不同 project_path → 不同组 → 不排队,直接 running(与第一条并行)。
    const t2 = await waitForTaskStatus(
      coordinator.id,
      groupB.id,
      m2.id,
      "running",
    );
    expect(t2.status).toBe("running");

    // 核心不变量:两条任务同时 running(轮询间隙第一条未结束)。
    const againA = await listTasks(coordinator.id, groupA.id);
    const againB = await listTasks(coordinator.id, groupB.id);
    expect(againA.find((x) => x.id === t1.id)?.status).toBe("running");
    expect(againB.find((x) => x.id === t2.id)?.status).toBe("running");

    await waitForTaskStatus(coordinator.id, groupA.id, m1.id, "done");
    await waitForTaskStatus(coordinator.id, groupB.id, m2.id, "done");
  }, 30_000);

  it("串行:同一 project_path 的两个群任务只有一条 running", async () => {
    process.env.FAKE_SLEEP_SECS = "5";
    const { coordinator, codebuddy } = await setupGroup();
    // 两个群绑定同一个 project_path → 归入同一组,组内串行。
    const proj = makeGitRepo("coagenthub-sameproj-");
    const groupA = await createGroup(coordinator.id, "同项目群 A");
    await addMember(coordinator.id, groupA.id, codebuddy.id, ["executor"]);
    await bindProject(coordinator.id, groupA.id, proj);
    const groupB = await createGroup(coordinator.id, "同项目群 B");
    await addMember(coordinator.id, groupB.id, codebuddy.id, ["executor"]);
    await bindProject(coordinator.id, groupB.id, proj);

    const m1 = await postMessage(coordinator.id, groupA.id, {
      body: "任务一(慢)",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const t1 = await waitForTaskStatus(
      coordinator.id,
      groupA.id,
      m1.id,
      "running",
    );
    expect(t1.status).toBe("running");

    // 同一 project_path → 同组,第二条必须排队,不能并行。
    const m2 = await postMessage(coordinator.id, groupB.id, {
      body: "任务二",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const t2 = await waitForTaskStatus(
      coordinator.id,
      groupB.id,
      m2.id,
      "queued",
    );
    expect(t2.status).toBe("queued");
    const againB = await listTasks(coordinator.id, groupB.id);
    expect(
      againB
        .filter((x) => x.status === "running")
        .some((x) => x.messageId === m2.id),
    ).toBe(false);

    await waitForTaskStatus(coordinator.id, groupA.id, m1.id, "done");
    await waitForTaskStatus(coordinator.id, groupB.id, m2.id, "done");
  }, 30_000);

  it("退化:maxParallelGroups=1 时不同 project_path 也严格串行(全局串行)", async () => {
    process.env.FAKE_SLEEP_SECS = "5";
    const { __setMaxParallelGroupsForTests } = await import(
      "@server/lib/executor-task"
    );
    __setMaxParallelGroupsForTests(1);
    try {
      const { coordinator, codebuddy } = await setupGroup();
      const projA = makeGitRepo("coagenthub-deg-a-");
      const projB = makeGitRepo("coagenthub-deg-b-");
      const groupA = await createGroup(coordinator.id, "退化群 A");
      await addMember(coordinator.id, groupA.id, codebuddy.id, ["executor"]);
      await bindProject(coordinator.id, groupA.id, projA);
      const groupB = await createGroup(coordinator.id, "退化群 B");
      await addMember(coordinator.id, groupB.id, codebuddy.id, ["executor"]);
      await bindProject(coordinator.id, groupB.id, projB);

      const m1 = await postMessage(coordinator.id, groupA.id, {
        body: "任务一(慢)",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t1 = await waitForTaskStatus(
        coordinator.id,
        groupA.id,
        m1.id,
        "running",
      );
      expect(t1.status).toBe("running");

      // 组槽位只剩 0:不同项目也必须排队,退化为全局串行。
      const m2 = await postMessage(coordinator.id, groupB.id, {
        body: "任务二",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t2 = await waitForTaskStatus(
        coordinator.id,
        groupB.id,
        m2.id,
        "queued",
      );
      expect(t2.status).toBe("queued");

      await waitForTaskStatus(coordinator.id, groupA.id, m1.id, "done");
      await waitForTaskStatus(coordinator.id, groupB.id, m2.id, "done");
    } finally {
      // 恢复默认并行组数,避免影响后续用例。
      const { __setMaxParallelGroupsForTests: restore } = await import(
        "@server/lib/executor-task"
      );
      restore(2);
    }
  }, 30_000);

  it("默认组:无 project_path 的群任务与项目组任务可并行执行", async () => {
    process.env.FAKE_SLEEP_SECS = "5";
    const { coordinator, codebuddy } = await setupGroup();
    // 群 A 不绑项目(默认组),群 B 绑定项目。
    const groupDefault = await createGroup(coordinator.id, "默认组群");
    await addMember(coordinator.id, groupDefault.id, codebuddy.id, [
      "executor",
    ]);
    const proj = makeGitRepo("coagenthub-default-par-");
    const groupProj = await createGroup(coordinator.id, "项目组群");
    await addMember(coordinator.id, groupProj.id, codebuddy.id, ["executor"]);
    await bindProject(coordinator.id, groupProj.id, proj);

    const m1 = await postMessage(coordinator.id, groupDefault.id, {
      body: "默认组任务(慢)",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const t1 = await waitForTaskStatus(
      coordinator.id,
      groupDefault.id,
      m1.id,
      "running",
    );
    expect(t1.status).toBe("running");

    // 默认组是独立组:项目组任务不受默认组阻塞,直接 running。
    const m2 = await postMessage(coordinator.id, groupProj.id, {
      body: "项目组任务(慢)",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const t2 = await waitForTaskStatus(
      coordinator.id,
      groupProj.id,
      m2.id,
      "running",
    );
    expect(t2.status).toBe("running");

    const again = await listTasks(coordinator.id, groupDefault.id);
    const againProj = await listTasks(coordinator.id, groupProj.id);
    expect(again.find((x) => x.id === t1.id)?.status).toBe("running");
    expect(againProj.find((x) => x.id === t2.id)?.status).toBe("running");

    await waitForTaskStatus(coordinator.id, groupDefault.id, m1.id, "done");
    await waitForTaskStatus(coordinator.id, groupProj.id, m2.id, "done");
  }, 30_000);

  it("「停止」kill 运行中任务的进程组:task → cancelled + 🛑 回传", async () => {
    // 默认单测超时 5s,本测试需要跑完真实 sleep + 轮询,显式放宽到 30s。
    process.env.FAKE_SLEEP_SECS = "60";
    const { coordinator, codebuddy, group } = await setupGroup();

    const msg = await postMessage(coordinator.id, group.id, {
      body: "长跑任务",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const t = await waitForTaskStatus(
      coordinator.id,
      group.id,
      msg.id,
      "running",
    );

    // 广播「停止」→ server 终止运行中任务的进程组。
    await postMessage(coordinator.id, group.id, {
      body: "停止",
      audience: "broadcast",
    });

    // 任务被 kill → 完成回调置 cancelled(不再 ❌)。
    const stopped = await waitForTaskStatus(
      coordinator.id,
      group.id,
      msg.id,
      "cancelled",
    );
    expect(stopped.id).toBe(t.id);
    // 群里出现 🛑 回传(以执行器身份)。
    await waitForMessage(
      coordinator.id,
      group.id,
      (m) => m.contentType === "task_status" && m.body.startsWith("🛑"),
    );
  }, 30_000);

  it("定向给非执行器 participant 的「停止」仍识别(hermes 特判已移除)", async () => {
    // participant.type 移除后不再有 hermes 特判:定向给非执行器 participant
    // 的消息若匹配停止/回滚指令仍触发(与现状对 non-hermes 非执行器一致)。
    process.env.FAKE_SLEEP_SECS = "";
    const { coordinator, codebuddy, group } = await setupGroup();

    // 定向给 coordinator(非执行器 participant),消息体匹配「停止」。
    await postMessage(coordinator.id, group.id, {
      body: "停止",
      audience: "participant",
      audienceRef: coordinator.id,
    });

    // 无运行中任务 → 以执行器身份回传 ⛔(证明指令被识别而非按讨论跳过;
    // ⛔ 不在 STATUS_EMOJI_RE 内,回传为 text/plain,故只按 body 前缀匹配)。
    await waitForMessage(coordinator.id, group.id, (m) =>
      m.body.startsWith("⛔"),
    );
    // 定向给执行器 participant 的任务消息不触发控制指令(防误伤):消息体匹配
    // 「停止」但受众是执行器 → 走任务而非控制指令,不回传 ⛔。等任务跑完
    // (FAKE_SLEEP_SECS="" 立即结束)再断言,避免遗留进程污染后续测试。
    const msg2 = await postMessage(coordinator.id, group.id, {
      body: "停止",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    await waitForTaskStatus(coordinator.id, group.id, msg2.id, "done");
    const after = await listMessages(coordinator.id, group.id);
    expect(after.filter((m) => m.body.startsWith("⛔"))).toHaveLength(1);
  }, 30_000);

  it("「回滚 <taskId>」恢复工作区到执行前快照:task → failed + ✅ 回传", async () => {
    // 默认单测超时 5s,本测试需要跑完真实 sleep + 轮询,显式放宽到 30s。
    process.env.FAKE_SLEEP_SECS = "";
    process.env.FAKE_APPEND = "1";
    const { coordinator, codebuddy, group } = await setupGroup();

    const msg = await postMessage(coordinator.id, group.id, {
      body: "修改 hello.txt",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const t = await waitForTaskStatus(coordinator.id, group.id, msg.id, "done");
    // 任务执行前快照已写回 checkpoint_ref。
    expect(t.checkpointRef).toBeTruthy();
    // fake bin 修改了工作区。
    expect(readFileSync(path.join(repoDir, "hello.txt"), "utf8")).toContain(
      "task-modified",
    );

    // 广播「回滚 <taskId>」。
    await postMessage(coordinator.id, group.id, {
      body: `回滚 ${t.id}`,
      audience: "broadcast",
    });

    // 工作区恢复 + 群里 ✅ 回传。
    await waitForMessage(
      coordinator.id,
      group.id,
      (m) => m.contentType === "task_status" && m.body.startsWith("✅ 已回滚"),
    );
    expect(readFileSync(path.join(repoDir, "hello.txt"), "utf8")).not.toContain(
      "task-modified",
    );
    // 对应任务置 failed。
    const after = await listTasks(coordinator.id, group.id);
    const rolled = after.find((x) => x.id === t.id);
    expect(rolled?.status).toBe("failed");
  }, 30_000);

  it("重启兜底:queued/running 任务自动恢复为 failed(server-restart)", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    const { testDb } = await import("./db");
    const { task: taskTable } = await import(
      "@laizhixingxingdeli/database/schema"
    );
    const { recoverInterruptedTasks } = await import(
      "@server/lib/executor-task"
    );

    // 直接落库两条遗留任务:一条 queued、一条 running(模拟重启瞬间)。
    const mQueued = "00000000-0000-7000-8000-0000000000a1";
    const mRunning = "00000000-0000-7000-8000-0000000000a2";
    await testDb.insert(taskTable).values([
      {
        groupId: group.id,
        messageId: mQueued,
        executorParticipantId: codebuddy.id,
        executorKey: "codebuddy",
        status: "queued",
      },
      {
        groupId: group.id,
        messageId: mRunning,
        executorParticipantId: codebuddy.id,
        executorKey: "codebuddy",
        status: "running",
      },
    ]);

    const affected = await recoverInterruptedTasks(
      testDb as unknown as Parameters<typeof recoverInterruptedTasks>[0],
    );
    expect(affected).toBe(2);

    const tasks = await listTasks(coordinator.id, group.id);
    for (const m of [mQueued, mRunning]) {
      const t = tasks.find((x) => x.messageId === m);
      expect(t?.status).toBe("failed");
      const diff = t?.diffSummary as Record<string, unknown> | null;
      expect(diff?.error).toBe("server-restart");
    }
  }, 30_000);

  it("静默超时:无输出的假 bin 超过 stall 阈值 → failed + ❌ 回传(原因含「静默」)", async () => {
    // 阈值调小(100ms)避免拖慢测试;假 bin 长睡 60s 零输出 → 静默超时杀进程。
    process.env.FAKE_SLEEP_SECS = "60";
    const { __setReliabilityTimeoutsForTests } = await import(
      "@server/lib/executor-task"
    );
    __setReliabilityTimeoutsForTests(100, 100);
    try {
      const { coordinator, codebuddy, group } = await setupGroup();
      const msg = await postMessage(coordinator.id, group.id, {
        body: "静默任务(无输出)",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "failed",
      );
      const diff = t.diffSummary as Record<string, unknown> | null;
      expect(diff?.error).toContain("静默");
      // 群里出现 ❌ 静默超时回传(失败原因写进消息)。
      await waitForMessage(
        coordinator.id,
        group.id,
        (m) =>
          m.contentType === "task_status" && m.body.includes("执行器静默超时"),
      );
    } finally {
      process.env.FAKE_SLEEP_SECS = "";
    }
  }, 30_000);

  it("无进展提醒:静默超 alert 阈值 → ⚠️ 提醒消息 + diffSummary.stallAlerted 警示标记;继续静默到 stall 才 failed", async () => {
    // alert 阈值 100ms < stall 阈值 5s:先触发提醒(不失败),再静默超时失败。
    process.env.FAKE_SLEEP_SECS = "60";
    const { __setReliabilityTimeoutsForTests } = await import(
      "@server/lib/executor-task"
    );
    __setReliabilityTimeoutsForTests(5_000, 60_000, 100);
    try {
      const { coordinator, codebuddy, group } = await setupGroup();
      const msg = await postMessage(coordinator.id, group.id, {
        body: "静默提醒任务",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      // 1) ⚠️ 提醒消息出现(含「无进展」+ 执行器 label + 请介入)。
      const alertMsg = await waitForMessage(
        coordinator.id,
        group.id,
        (m) => m.contentType === "task_status" && m.body.includes("无进展"),
      );
      expect(alertMsg.body).toContain("codebuddy");
      expect(alertMsg.body).toContain("请介入");
      // 提醒消息里带的是任务 id(与消息 id 不同,单独取)。
      const tasks0 = await listTasks(coordinator.id, group.id);
      const t0 = tasks0.find((x) => x.messageId === msg.id);
      expect(t0).toBeDefined();
      expect(alertMsg.body).toContain(String(t0?.id));
      // 2) 警示标记落库(diffSummary.stallAlerted),任务仍未失败(非失败警示)。
      const alerted = await waitForTaskDiff(
        coordinator.id,
        group.id,
        msg.id,
        (diff) => diff?.stallAlerted === true,
      );
      expect(alerted).toBeDefined();
      const before = await listTasks(coordinator.id, group.id);
      const b = before.find((x) => x.messageId === msg.id);
      expect(b?.status).toBe("running");
      // 3) 静默继续到 stall 阈值 → failed(现有行为不被提醒打断)。
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "failed",
      );
      const diff = t.diffSummary as Record<string, unknown> | null;
      expect(diff?.error).toContain("静默");
    } finally {
      process.env.FAKE_SLEEP_SECS = "";
    }
  }, 30_000);

  it("持续输出的假 bin 总时长超过阈值但不误杀(输出间隔 < stall 阈值)→ done", async () => {
    // 每 50ms 一行、共 40 行(总 ~2s > 200ms 阈值),任意相邻输出间隔远小于阈值。
    process.env.FAKE_SLEEP_SECS = "";
    process.env.FAKE_OUTPUT_LOOPS = "40";
    process.env.FAKE_OUTPUT_INTERVAL_MS = "0.05";
    const { __setReliabilityTimeoutsForTests } = await import(
      "@server/lib/executor-task"
    );
    __setReliabilityTimeoutsForTests(200, 200);
    try {
      const { coordinator, codebuddy, group } = await setupGroup();
      const msg = await postMessage(coordinator.id, group.id, {
        body: "持续输出任务",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "done",
      );
      expect(t.status).toBe("done");
      // 未被误标失败:diffSummary 无 error 字段。
      const diff = t.diffSummary as Record<string, unknown> | null;
      expect(diff?.error).toBeUndefined();
    } finally {
      process.env.FAKE_OUTPUT_LOOPS = "";
      process.env.FAKE_OUTPUT_INTERVAL_MS = "";
    }
  }, 30_000);

  it("认领超时:queued 任务超过 claim 阈值未被 running → failed + ❌ 回传(含「未认领」)", async () => {
    process.env.FAKE_SLEEP_SECS = "";
    // 占位任务持续输出 ~2s,占住唯一组槽位;排队任务超阈值仍未被认领。
    process.env.FAKE_OUTPUT_LOOPS = "40";
    process.env.FAKE_OUTPUT_INTERVAL_MS = "0.05";
    const { __setMaxParallelGroupsForTests, __setReliabilityTimeoutsForTests } =
      await import("@server/lib/executor-task");
    __setMaxParallelGroupsForTests(1); // 只剩一个槽位 → 第二个任务必须排队
    __setReliabilityTimeoutsForTests(60_000, 100); // stall 放宽,claim 调小
    try {
      const { coordinator, codebuddy, group } = await setupGroup();
      const m1 = await postMessage(coordinator.id, group.id, {
        body: "占位任务(持续输出)",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      await waitForTaskStatus(coordinator.id, group.id, m1.id, "running");

      const m2 = await postMessage(coordinator.id, group.id, {
        body: "排队任务(无人认领)",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t2 = await waitForTaskStatus(
        coordinator.id,
        group.id,
        m2.id,
        "failed",
      );
      const diff = t2.diffSummary as Record<string, unknown> | null;
      expect(diff?.error).toContain("未认领");
      expect(t2.retryCount).toBe(0); // 认领超时不重试
      await waitForMessage(
        coordinator.id,
        group.id,
        (m) => m.contentType === "task_status" && m.body.includes("未认领"),
      );
      // 占位任务已 running,不受认领阈值影响,正常完成。
      await waitForTaskStatus(coordinator.id, group.id, m1.id, "done");
    } finally {
      process.env.FAKE_OUTPUT_LOOPS = "";
      process.env.FAKE_OUTPUT_INTERVAL_MS = "";
      // 恢复默认并行组数,避免影响后续用例。
      __setMaxParallelGroupsForTests(2);
    }
  }, 30_000);

  it("已 running 的任务不受认领阈值影响(认领成功后取消认领计时)", async () => {
    process.env.FAKE_SLEEP_SECS = "1"; // 跑 ~1s,远超 100ms 的 claim 阈值
    const { __setReliabilityTimeoutsForTests } = await import(
      "@server/lib/executor-task"
    );
    __setReliabilityTimeoutsForTests(60_000, 100); // claim 调小;stall 放宽避免误伤
    try {
      const { coordinator, codebuddy, group } = await setupGroup();
      const msg = await postMessage(coordinator.id, group.id, {
        body: "认领后长跑任务",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "running",
      );
      // 等超过 claim 阈值(100ms):任务仍应 running,不被「未被认领」误杀。
      await new Promise((r) => setTimeout(r, 300));
      const after = await listTasks(coordinator.id, group.id);
      expect(after.find((x) => x.id === t.id)?.status).toBe("running");
      await waitForTaskStatus(coordinator.id, group.id, msg.id, "done");
    } finally {
      process.env.FAKE_SLEEP_SECS = "";
    }
  }, 30_000);

  it("停止的任务不被静默/认领超时误伤(停止 → cancelled,而非 failed)", async () => {
    process.env.FAKE_SLEEP_SECS = "60";
    const { __setReliabilityTimeoutsForTests } = await import(
      "@server/lib/executor-task"
    );
    // 阈值放宽到 5s:停止指令在超时前生效,验证停止优先于超时。
    __setReliabilityTimeoutsForTests(5_000, 5_000);
    try {
      const { coordinator, codebuddy, group } = await setupGroup();
      const msg = await postMessage(coordinator.id, group.id, {
        body: "待停止任务(长睡)",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "running",
      );
      await postMessage(coordinator.id, group.id, {
        body: "停止",
        audience: "broadcast",
      });
      const stopped = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "cancelled",
      );
      expect(stopped.id).toBe(t.id);
      const after = await listTasks(coordinator.id, group.id);
      expect(after.find((x) => x.id === t.id)?.status).toBe("cancelled");
      // 手动停止不重试:群里无 ↻ 回传。
      const msgs = await listMessages(coordinator.id, group.id);
      expect(msgs.some((m) => m.body.startsWith("↻"))).toBe(false);
    } finally {
      process.env.FAKE_SLEEP_SECS = "";
    }
  }, 30_000);

  it("失败自动重试:第一次 exit 1,重试后成功 → done + retry_count=1 + ↻ 回传", async () => {
    process.env.FAKE_SLEEP_SECS = "";
    // 尝试计数文件:第 1 次 exit 1,第 2 次起正常(提交 → done)。
    const counterDir = mkdtempSync(
      path.join(tmpdir(), "coagenthub-retry-cnt-"),
    );
    const counterFile = path.join(counterDir, "n.txt");
    process.env.FAKE_COUNTER_FILE = counterFile;
    process.env.FAKE_FAIL_UNTIL = "1";
    try {
      const { coordinator, codebuddy, group } = await setupGroup();
      const msg = await postMessage(coordinator.id, group.id, {
        body: "重试任务(首次失败)",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "done",
      );
      expect(t.retryCount).toBe(1);
      const diff = t.diffSummary as Record<string, unknown> | null;
      expect(diff?.retries).toBe(1);
      // 首次失败 ❌ 后补发 ↻ 自动重试提示。
      await waitForMessage(
        coordinator.id,
        group.id,
        (m) => m.body.startsWith("↻") && m.body.includes("自动重试 (第 1 次)"),
      );
    } finally {
      process.env.FAKE_COUNTER_FILE = "";
      process.env.FAKE_FAIL_UNTIL = "";
      rmSync(counterDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("重试前回滚 checkpoint:首次改文件后失败,重试时工作区已还原", async () => {
    process.env.FAKE_SLEEP_SECS = "";
    const counterDir = mkdtempSync(
      path.join(tmpdir(), "coagenthub-rollback-cnt-"),
    );
    const counterFile = path.join(counterDir, "n.txt");
    process.env.FAKE_COUNTER_FILE = counterFile;
    process.env.FAKE_FAIL_UNTIL = "1";
    process.env.FAKE_APPEND = "1";
    try {
      const { coordinator, codebuddy } = await setupGroup();
      // 独立仓库:首次失败在 hello.txt 留下 attempt-1-dirty,回滚后应还原。
      const proj = makeGitRepo("coagenthub-retry-rollback-");
      const group = await createGroup(coordinator.id, "重试回滚群");
      await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
      await bindProject(coordinator.id, group.id, proj);

      const msg = await postMessage(coordinator.id, group.id, {
        body: "回滚重试任务",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "done",
      );
      expect(t.retryCount).toBe(1);
      const content = readFileSync(path.join(proj, "hello.txt"), "utf8");
      // 第二次尝试的改动在;首次尝试的改动被重试前回滚还原。
      expect(content).toContain("attempt-2-dirty");
      expect(content).not.toContain("attempt-1-dirty");
    } finally {
      process.env.FAKE_COUNTER_FILE = "";
      process.env.FAKE_FAIL_UNTIL = "";
      process.env.FAKE_APPEND = "";
      rmSync(counterDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("重试后仍失败 → 最终 failed + error 记录(含重试次数)", async () => {
    process.env.FAKE_SLEEP_SECS = "";
    const counterDir = mkdtempSync(
      path.join(tmpdir(), "coagenthub-alwaysfail-cnt-"),
    );
    const counterFile = path.join(counterDir, "n.txt");
    process.env.FAKE_COUNTER_FILE = counterFile;
    process.env.FAKE_ALWAYS_FAIL = "1";
    try {
      const { coordinator, codebuddy, group } = await setupGroup();
      const msg = await postMessage(coordinator.id, group.id, {
        body: "必败任务(重试也失败)",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "failed",
      );
      // 重试了一次(attempt 2 仍失败 → 最终 failed)。
      expect(t.retryCount).toBe(1);
      const diff = t.diffSummary as Record<string, unknown> | null;
      expect(diff?.error).toContain("exit 1");
      expect(diff?.retries).toBe(1);
      // ❌ + ↻ 都已回传(首次失败 ❌,补发 ↻,最终 ❌)。
      await waitForMessage(
        coordinator.id,
        group.id,
        (m) => m.body.startsWith("↻") && m.body.includes("自动重试 (第 1 次)"),
      );
    } finally {
      process.env.FAKE_COUNTER_FILE = "";
      process.env.FAKE_ALWAYS_FAIL = "";
      rmSync(counterDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("弱验收:执行器提交后退出 → done(工作树干净 + HEAD 有新提交)", async () => {
    process.env.FAKE_SLEEP_SECS = "";
    process.env.FAKE_APPEND = "1";
    try {
      const { coordinator, codebuddy } = await setupGroup();
      const proj = makeGitRepo("coagenthub-accept-ok-");
      const group = await createGroup(coordinator.id, "验收通过群");
      await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
      await bindProject(coordinator.id, group.id, proj);

      const msg = await postMessage(coordinator.id, group.id, {
        body: "提交后退出",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "done",
      );
      expect(t.retryCount).toBe(0);
      // 改动已提交进仓库。
      expect(readFileSync(path.join(proj, "hello.txt"), "utf8")).toContain(
        "task-modified",
      );
    } finally {
      process.env.FAKE_APPEND = "";
    }
  }, 30_000);

  it("弱验收:改文件不提交 → failed(原因含「未提交」)+ ❌ 回传,不重试", async () => {
    process.env.FAKE_SLEEP_SECS = "";
    process.env.FAKE_APPEND = "1";
    process.env.FAKE_NO_COMMIT = "1";
    try {
      const { coordinator, codebuddy } = await setupGroup();
      const proj = makeGitRepo("coagenthub-accept-dirty-");
      const group = await createGroup(coordinator.id, "验收失败群(脏树)");
      await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
      await bindProject(coordinator.id, group.id, proj);

      const msg = await postMessage(coordinator.id, group.id, {
        body: "改文件不提交",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "failed",
      );
      const diff = t.diffSummary as Record<string, unknown> | null;
      expect(diff?.error).toContain("未提交");
      expect(t.retryCount).toBe(0); // 验收失败不重试
      await waitForMessage(
        coordinator.id,
        group.id,
        (m) => m.body.includes("任务失败") && m.body.includes("未提交"),
      );
      const messages = await listMessages(coordinator.id, group.id);
      expect(messages.some((m) => m.body.startsWith("↻"))).toBe(false);
    } finally {
      process.env.FAKE_APPEND = "";
      process.env.FAKE_NO_COMMIT = "";
    }
  }, 30_000);

  it("弱验收:无改动退出 → failed(HEAD 无变化),不重试", async () => {
    process.env.FAKE_SLEEP_SECS = "";
    process.env.FAKE_NO_COMMIT = "1";
    try {
      const { coordinator, codebuddy } = await setupGroup();
      const proj = makeGitRepo("coagenthub-accept-noop-");
      const group = await createGroup(coordinator.id, "验收失败群(无改动)");
      await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
      await bindProject(coordinator.id, group.id, proj);

      const msg = await postMessage(coordinator.id, group.id, {
        body: "无改动退出",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "failed",
      );
      const diff = t.diffSummary as Record<string, unknown> | null;
      expect(diff?.error).toContain("未提交");
      expect(t.retryCount).toBe(0);
      const messages = await listMessages(coordinator.id, group.id);
      expect(messages.some((m) => m.body.startsWith("↻"))).toBe(false);
    } finally {
      process.env.FAKE_NO_COMMIT = "";
    }
  }, 30_000);

  it("弱验收:git 命令失败 → 跳过验收(视为通过,不误杀)", async () => {
    // 非 git 目录:git status 失败 → verifyTaskCommitted 应跳过返回 ok。
    const nonGitDir = mkdtempSync(path.join(tmpdir(), "coagenthub-nongit-"));
    try {
      const { verifyTaskCommitted } = await import("@server/lib/executor-task");
      const res = await verifyTaskCommitted(
        nonGitDir,
        "refs/coagenthub-cp/nonexistent-task",
      );
      expect(res.ok).toBe(true);
      expect(res.reason).toBeUndefined();
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("弱验收:任务书含 ## Acceptance: skip-verify → 改文件不提交也通过(done)", async () => {
    process.env.FAKE_SLEEP_SECS = "";
    process.env.FAKE_APPEND = "1"; // 改文件但 FAKE_NO_COMMIT 不提交(脏树)
    process.env.FAKE_NO_COMMIT = "1";
    try {
      const { coordinator, codebuddy } = await setupGroup();
      const proj = makeGitRepo("coagenthub-accept-skip-verify-");
      const group = await createGroup(
        coordinator.id,
        "验收跳过群(skip-verify)",
      );
      await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
      await bindProject(coordinator.id, group.id, proj);

      const msg = await postMessage(coordinator.id, group.id, {
        body: "只读排查任务,无代码提交\n## Acceptance: skip-verify\n完成后仅汇报结论",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "done",
      );
      expect(t.retryCount).toBe(0);
      // 任务按 done 回传,未因脏树误判失败。
      const messages = await listMessages(coordinator.id, group.id);
      expect(messages.some((m) => m.body.includes("任务失败"))).toBe(false);
    } finally {
      process.env.FAKE_APPEND = "";
      process.env.FAKE_NO_COMMIT = "";
    }
  }, 30_000);

  it("弱验收:任务书含 ## CommitMode: none → 无改动退出也通过(done)", async () => {
    process.env.FAKE_SLEEP_SECS = "";
    process.env.FAKE_NO_COMMIT = "1"; // 无提交 → HEAD 无变化
    try {
      const { coordinator, codebuddy } = await setupGroup();
      const proj = makeGitRepo("coagenthub-accept-commitmode-none-");
      const group = await createGroup(
        coordinator.id,
        "验收跳过群(commitmode none)",
      );
      await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
      await bindProject(coordinator.id, group.id, proj);

      const msg = await postMessage(coordinator.id, group.id, {
        body: "纯 API 操作,无本地提交\n## CommitMode: none",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "done",
      );
      expect(t.retryCount).toBe(0);
      // 任务按 done 回传,未因 HEAD 无变化误判失败。
      const messages = await listMessages(coordinator.id, group.id);
      expect(messages.some((m) => m.body.includes("任务失败"))).toBe(false);
    } finally {
      process.env.FAKE_NO_COMMIT = "";
    }
  }, 30_000);

  it("弱验收:hasSkipCommitMarker 按行识别标记(大小写/前后空白不敏感)", async () => {
    const { hasSkipCommitMarker } = await import("@server/lib/executor-task");
    // 两个标记都命中。
    expect(hasSkipCommitMarker("## Acceptance: skip-verify")).toBe(true);
    expect(hasSkipCommitMarker("## CommitMode: none")).toBe(true);
    // 大小写、前后空白、混在正文里都不影响命中。
    expect(
      hasSkipCommitMarker("任务书正文\n  ## acceptance: skip-verify  \n结尾"),
    ).toBe(true);
    expect(hasSkipCommitMarker("## COMMITMODE: NONE")).toBe(true);
    // 不带标记 / 近似标记不命中(保持原行为)。
    expect(hasSkipCommitMarker("无标记的普通任务书")).toBe(false);
    expect(hasSkipCommitMarker("## Acceptance: skip-verify-extra")).toBe(false);
    expect(hasSkipCommitMarker("## CommitMode: commit")).toBe(false);
    expect(hasSkipCommitMarker("正文提到 skip-verify 但非行首标记")).toBe(
      false,
    );
  });

  describe("按执行器并发能力排队(设计修正:maxConcurrency + 403 反应式排队)", () => {
    it("声明式上限:maxConcurrency=1 的执行器(AtomCode)跨群任务只有一条 running,另一条 queued,完成后才轮到", async () => {
      // 默认单测超时 5s,本测试需要跑完真实 sleep + 轮询,显式放宽到 30s。
      process.env.FAKE_SLEEP_SECS = "3";
      const { coordinator } = await setupGroup();
      // AtomCode 执行器(内置 maxConcurrency=1):与 codebuddy 共用同一 fake bin。
      const atomcode = await registerParticipant({ name: "AtomCode 执行器" });
      const projA = makeGitRepo("coagenthub-mc-a-");
      const projB = makeGitRepo("coagenthub-mc-b-");
      const groupA = await createGroup(coordinator.id, "并发上限群 A");
      await addMember(coordinator.id, groupA.id, atomcode.id, ["executor"]);
      await bindProject(coordinator.id, groupA.id, projA);
      const groupB = await createGroup(coordinator.id, "并发上限群 B");
      await addMember(coordinator.id, groupB.id, atomcode.id, ["executor"]);
      await bindProject(coordinator.id, groupB.id, projB);

      const m1 = await postMessage(coordinator.id, groupA.id, {
        body: "AtomCode 任务一(慢)",
        audience: "participant",
        audienceRef: atomcode.id,
      });
      const t1 = await waitForTaskStatus(
        coordinator.id,
        groupA.id,
        m1.id,
        "running",
      );
      expect(t1.status).toBe("running");

      // 不同 project_path → 组槽位空闲;但 AtomCode maxConcurrency=1:第二条
      // 必须排队(执行器级串行),不能与第一条并行 running。
      const m2 = await postMessage(coordinator.id, groupB.id, {
        body: "AtomCode 任务二",
        audience: "participant",
        audienceRef: atomcode.id,
      });
      const t2 = await waitForTaskStatus(
        coordinator.id,
        groupB.id,
        m2.id,
        "queued",
      );
      expect(t2.status).toBe("queued");
      const again = await listTasks(coordinator.id, groupB.id);
      expect(
        again
          .filter((x) => x.status === "running")
          .some((x) => x.messageId === m2.id),
      ).toBe(false);

      // 第一条 done 后,第二条才轮到并完成。
      await waitForTaskStatus(coordinator.id, groupA.id, m1.id, "done");
      await waitForTaskStatus(coordinator.id, groupB.id, m2.id, "done");
    }, 30_000);

    it("可并发执行器(无 maxConcurrency)允许同一执行器多个任务同时 running", async () => {
      process.env.FAKE_SLEEP_SECS = "3";
      const { coordinator, codebuddy } = await setupGroup();
      const projA = makeGitRepo("coagenthub-conc-a-");
      const projB = makeGitRepo("coagenthub-conc-b-");
      const groupA = await createGroup(coordinator.id, "可并发群 A");
      await addMember(coordinator.id, groupA.id, codebuddy.id, ["executor"]);
      await bindProject(coordinator.id, groupA.id, projA);
      const groupB = await createGroup(coordinator.id, "可并发群 B");
      await addMember(coordinator.id, groupB.id, codebuddy.id, ["executor"]);
      await bindProject(coordinator.id, groupB.id, projB);

      const m1 = await postMessage(coordinator.id, groupA.id, {
        body: "并发任务一(慢)",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t1 = await waitForTaskStatus(
        coordinator.id,
        groupA.id,
        m1.id,
        "running",
      );
      expect(t1.status).toBe("running");

      const m2 = await postMessage(coordinator.id, groupB.id, {
        body: "并发任务二(慢)",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      // 无 maxConcurrency 的可并发执行器:第二条不被无谓串行,直接 running。
      const t2 = await waitForTaskStatus(
        coordinator.id,
        groupB.id,
        m2.id,
        "running",
      );
      expect(t2.status).toBe("running");

      // 核心不变量:同一执行器两条任务同时 running。
      const againA = await listTasks(coordinator.id, groupA.id);
      const againB = await listTasks(coordinator.id, groupB.id);
      expect(againA.find((x) => x.id === t1.id)?.status).toBe("running");
      expect(againB.find((x) => x.id === t2.id)?.status).toBe("running");

      await waitForTaskStatus(coordinator.id, groupA.id, m1.id, "done");
      await waitForTaskStatus(coordinator.id, groupB.id, m2.id, "done");
    }, 30_000);

    it("反应式排队:执行器返回 403 atomgit_session_concurrency_conflict → 不判失败,转 queued,既有 running 终态后自动重试", async () => {
      process.env.FAKE_SLEEP_SECS = "3";
      // 冲突标记文件:存在 → fake bin 输出 403 并发冲突并退出;不存在 → 正常执行。
      const conflictDir = mkdtempSync(
        path.join(tmpdir(), "coagenthub-conflict-"),
      );
      const conflictFile = path.join(conflictDir, "conflict.txt");
      process.env.FAKE_CONFLICT_FILE = conflictFile;
      try {
        const { coordinator, codebuddy } = await setupGroup();
        const projA = makeGitRepo("coagenthub-403-a-");
        const projB = makeGitRepo("coagenthub-403-b-");
        const groupA = await createGroup(coordinator.id, "403 群 A");
        await addMember(coordinator.id, groupA.id, codebuddy.id, ["executor"]);
        await bindProject(coordinator.id, groupA.id, projA);
        const groupB = await createGroup(coordinator.id, "403 群 B");
        await addMember(coordinator.id, groupB.id, codebuddy.id, ["executor"]);
        await bindProject(coordinator.id, groupB.id, projB);

        // 占位任务 A 先 running(此时冲突文件不存在 → 正常执行)。
        const m1 = await postMessage(coordinator.id, groupA.id, {
          body: "占位任务(慢)",
          audience: "participant",
          audienceRef: codebuddy.id,
        });
        const t1 = await waitForTaskStatus(
          coordinator.id,
          groupA.id,
          m1.id,
          "running",
        );
        expect(t1.status).toBe("running");

        // 放置冲突标记 → 任务 B 首次 spawn 返回 403,转 queued 而非 failed。
        writeFileSync(conflictFile, "conflict\n");
        const m2 = await postMessage(coordinator.id, groupB.id, {
          body: "被 403 的任务",
          audience: "participant",
          audienceRef: codebuddy.id,
        });
        // B 先尝试下发(running)→ 403 → 回写 queued(不判失败)。
        const t2 = await waitForTaskStatus(
          coordinator.id,
          groupB.id,
          m2.id,
          "queued",
        );
        expect(t2.status).toBe("queued");
        const t2row = (await listTasks(coordinator.id, groupB.id)).find(
          (x) => x.messageId === m2.id,
        );
        const diff2 = t2row?.diffSummary as Record<string, unknown> | null;
        expect(diff2?.error).toBeUndefined();
        expect(t2row?.retryCount).toBe(0);
        // 群里出现 403 排队提示(非 ❌ 失败回传)。
        await waitForMessage(
          coordinator.id,
          groupB.id,
          (m) =>
            m.contentType === "task_status" && m.body.includes("403 并发冲突"),
        );

        // A 仍在 running 期间,B 保持 queued(不空转重试)。
        const during = await listTasks(coordinator.id, groupB.id);
        expect(during.find((x) => x.messageId === m2.id)?.status).toBe(
          "queued",
        );

        // 移除冲突标记(执行器恢复)→ A done 后 B 自动重试并完成。
        rmSync(conflictFile, { force: true });
        await waitForTaskStatus(coordinator.id, groupA.id, m1.id, "done");
        const t2final = await waitForTaskStatus(
          coordinator.id,
          groupB.id,
          m2.id,
          "done",
        );
        expect(t2final.retryCount).toBe(0); // 403 不算失败重试
        const diffFinal = t2final.diffSummary as Record<string, unknown> | null;
        expect(diffFinal?.error).toBeUndefined();
      } finally {
        process.env.FAKE_SLEEP_SECS = "";
        process.env.FAKE_CONFLICT_FILE = "";
        rmSync(conflictDir, { recursive: true, force: true });
      }
    }, 30_000);

    it("isConcurrencyConflict 识别 403 atomgit_session_concurrency_conflict 标记", async () => {
      const { isConcurrencyConflict } = await import(
        "@server/lib/executor-task"
      );
      // 带 403 前缀 / 独立 token / 大小写不敏感均命中。
      expect(
        isConcurrencyConflict("403 atomgit_session_concurrency_conflict"),
      ).toBe(true);
      expect(
        isConcurrencyConflict(
          "error: 403 atomgit_session_concurrency_conflict: session busy",
        ),
      ).toBe(true);
      expect(
        isConcurrencyConflict("atomgit_session_concurrency_conflict"),
      ).toBe(true);
      expect(
        isConcurrencyConflict("403 ATOMGIT_SESSION_CONCURRENCY_CONFLICT"),
      ).toBe(true);
      // 普通失败 / 空串不命中。
      expect(isConcurrencyConflict("普通失败输出 exit 1")).toBe(false);
      expect(isConcurrencyConflict("")).toBe(false);
    });
  });
});
