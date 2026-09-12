/**
 * specs/stop-before-spawn-guard-never-fires.md:
 * R1 — 两条 spawn 分支紧邻前重查 run.stopped,命中则不 spawn;
 * R2 — 拿到 handle 后第一时间登记 run.kill。
 *
 * 判据必须是可观察事实(假 bin 哨兵文件 / gateway 调用次数),
 * 不接受「任务状态 cancelled」作为唯一证据(缺陷态下结果路径也会写 cancelled)。
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  executorConfig as executorConfigTable,
  participant as participantTable,
} from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { seedBuiltinExecutorConfigs, testDb } from "./db";
import { resolveFakeExecutor, withFakeExecutorArgs } from "./fake-executor-bin";

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-stop-guard-bin-"));
const fakeScript = path.join(fakeDir, "fake-stop-guard.sh");
writeFileSync(
  fakeScript,
  [
    "#!/bin/sh",
    // 一被 spawn 就写哨兵 —— 证明执行器真的跑了(R1 的可观察判据)。
    'if [ -n "$FAKE_SPAWN_SENTINEL" ]; then touch "$FAKE_SPAWN_SENTINEL"; fi',
    'if [ -n "$FAKE_SLEEP_SECS" ]; then sleep "$FAKE_SLEEP_SECS"; fi',
    'if [ -z "$FAKE_NO_COMMIT" ]; then',
    '  git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake bin change" || true',
    "fi",
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:stop-guard"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeScript, 0o755);
const { bin: fakeBin, argsPrefix: fakeArgsPrefix } =
  resolveFakeExecutor(fakeScript);
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;

const repoDir = mkdtempSync(path.join(tmpdir(), "coagenthub-stop-guard-repo-"));
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

process.env.COAGENTHUB_WIN_A2A_URL = "http://127.0.0.1:9912/";
process.env.COAGENTHUB_WIN_A2A_TOKEN = "test-a2a-token-stop-guard";

const { createTestApp } = await import("./app");
const { __resetExecutorQueueForTests, cancelQueuedTasks } = await import(
  "@server/lib/executor-task"
);
const { activeRuns } = await import("@server/lib/executor-task/state");
const runner = await import("@server/lib/executor-runner");
const a2aRunner = await import("@server/lib/a2a-runner");
const attemptAccounting = await import(
  "@server/lib/executor-task/attempt-accounting"
);

beforeAll(async () => {
  await seedBuiltinExecutorConfigs();
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

describe("stop-before-spawn-guard (R1/R2)", () => {
  const app = createTestApp();

  async function registerParticipant(body: Record<string, unknown>) {
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 409) {
      const list = (await (await app.request("/api/participants")).json()) as {
        id: string;
        name: string;
      }[];
      const existing = list.find((p) => p.name === body.name);
      if (existing) {
        if (body.name === "CodeBuddy") {
          await testDb
            .update(participantTable)
            .set({ executorKey: "codebuddy" })
            .where(eq(participantTable.id, existing.id));
        }
        return { id: existing.id };
      }
    }
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    if (body.name === "CodeBuddy") {
      await testDb
        .update(participantTable)
        .set({ executorKey: "codebuddy" })
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
    }>;
  }

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
          `task(message=${messageId}) 未在 ${timeoutMs}ms 内达到 ${status}(当前=${t?.status ?? "无"})`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  beforeEach(() => {
    __resetExecutorQueueForTests();
    delete process.env.FAKE_SPAWN_SENTINEL;
    delete process.env.FAKE_SLEEP_SECS;
    delete process.env.FAKE_NO_COMMIT;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetExecutorQueueForTests();
    vi.restoreAllMocks();
  });

  it("R1 CLI: pre-spawn 窗口停止 → 假 bin 哨兵文件不存在(未 spawn)", async () => {
    const sentinel = path.join(
      fakeDir,
      `cli-sentinel-${Date.now()}-${Math.random().toString(36).slice(2)}.flag`,
    );
    process.env.FAKE_SPAWN_SENTINEL = sentinel;
    process.env.FAKE_NO_COMMIT = "1";

    const origCp = runner.createCheckpoint;
    vi.spyOn(runner, "createCheckpoint").mockImplementation(
      async (taskId, repoRoot) => {
        // 模拟停止指令落在「已出队、未 spawn」窗口:cancelQueuedTasks 置 stopped。
        cancelQueuedTasks(
          [...activeRuns].find((r) => r.taskId === taskId)?.groupId ?? "",
          taskId,
        );
        return origCp(taskId, repoRoot);
      },
    );

    const coordinator = await registerParticipant({
      name: `coord-stop-cli-${Math.random().toString(36).slice(2, 8)}`,
    });
    const codebuddy = await registerParticipant({ name: "CodeBuddy" });
    const group = await createGroup(coordinator.id, "stop-guard-cli");
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);

    const msg = await postMessage(coordinator.id, group.id, {
      body: "pre-spawn stop CLI",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    await waitForTaskStatus(coordinator.id, group.id, msg.id, "cancelled");

    // 可观察事实:假 bin 从未被调用。
    expect(existsSync(sentinel)).toBe(false);
  }, 30_000);

  it("R1 A2A: pre-spawn 窗口停止 → runA2AExecutor 未被调用", async () => {
    const a2aSpy = vi.spyOn(a2aRunner, "runA2AExecutor");
    const origBegin = attemptAccounting.beginAttempt;
    vi.spyOn(attemptAccounting, "beginAttempt").mockImplementation(
      async (run) => {
        await origBegin(run);
        // beginAttempt 之后、spawn 之前的 await 窗口:置 stopped。
        cancelQueuedTasks(run.groupId, run.taskId);
      },
    );

    // 即使守卫失效,gateway 也不该被真实打到;仍 stub 以便对照。
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "1.0",
        id: "1",
        result: {
          message: {
            role: "participant",
            parts: [{ kind: "text", text: "should-not-run" }],
          },
          state: { state: "completed" },
        },
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const coordinator = await registerParticipant({
      name: `coord-stop-a2a-${Math.random().toString(36).slice(2, 8)}`,
    });
    const winHermes = await registerParticipant({ name: "Win Hermes" });
    const group = await createGroup(coordinator.id, "stop-guard-a2a");
    await addMember(coordinator.id, group.id, winHermes.id, ["executor"]);

    const msg = await postMessage(coordinator.id, group.id, {
      body: "pre-spawn stop A2A",
      audience: "participant",
      audienceRef: winHermes.id,
    });
    await waitForTaskStatus(coordinator.id, group.id, msg.id, "cancelled");

    // 可观察事实:A2A gateway 调用入口从未触发。
    expect(a2aSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  }, 30_000);

  it("R2: run.kill 在 spawn 返回后的同一同步段即可用(早于 pid 落库 await)", async () => {
    let killReadyInFirstMicrotask: boolean | null = null;
    let observedKill: (() => void) | null | undefined;

    vi.spyOn(runner, "runExecutor").mockImplementation(() => {
      let resolvePromise: (v: {
        code: number;
        stdout: string;
        stderr: string;
        timedOut: boolean;
      }) => void = () => {};
      const promise = new Promise<{
        code: number;
        stdout: string;
        stderr: string;
        timedOut: boolean;
      }>((resolve) => {
        resolvePromise = resolve;
      });
      const kill = () => {
        resolvePromise({
          code: 1,
          stdout: "",
          stderr: "killed",
          timedOut: false,
        });
      };
      const handle = {
        // 强制走 pid 落库 await 路径 —— 旧代码把 kill 赋在该 await 之后。
        pid: 424242,
        promise,
        kill,
      };
      // runExecutor 返回后,runOne 若在同一同步段赋值 run.kill,则本 microtask
      // 触发时(第一个 await yield)kill 已就绪;旧代码此时仍是 undefined。
      void Promise.resolve().then(() => {
        const hit = [...activeRuns].find((r) => r.kill === kill);
        killReadyInFirstMicrotask = Boolean(hit);
        observedKill = hit?.kill;
      });
      return handle;
    });

    const coordinator = await registerParticipant({
      name: `coord-kill-r2-${Math.random().toString(36).slice(2, 8)}`,
    });
    const codebuddy = await registerParticipant({ name: "CodeBuddy" });
    const group = await createGroup(coordinator.id, "stop-guard-r2");
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);

    await postMessage(coordinator.id, group.id, {
      body: "kill handle immediacy",
      audience: "participant",
      audienceRef: codebuddy.id,
    });

    const deadline = Date.now() + 10_000;
    while (killReadyInFirstMicrotask === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(killReadyInFirstMicrotask).toBe(true);
    expect(typeof observedKill).toBe("function");

    // 收尾:走停止,避免 hang promise 泄漏到其它用例。
    for (const run of activeRuns) {
      run.stopped = true;
      run.kill?.();
    }
    __resetExecutorQueueForTests();
  }, 30_000);
});
