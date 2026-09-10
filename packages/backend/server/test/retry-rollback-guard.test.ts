import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  executorConfig as executorConfigTable,
  participant as participantTable,
} from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBuiltinExecutorConfigs, testDb } from "./db";
import { resolveFakeExecutor, withFakeExecutorArgs } from "./fake-executor-bin";

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-guard-bin-"));
const fakeScript = path.join(fakeDir, "fake-guard.sh");
writeFileSync(
  fakeScript,
  [
    "#!/bin/sh",
    'if [ -n "$FAKE_SLEEP_SECS" ]; then sleep "$FAKE_SLEEP_SECS"; fi',
    'if [ -n "$FAKE_COUNTER_FILE" ]; then',
    "  n=0",
    '  if [ -f "$FAKE_COUNTER_FILE" ]; then n=$(cat "$FAKE_COUNTER_FILE"); fi',
    "  n=$((n + 1))",
    '  echo "$n" > "$FAKE_COUNTER_FILE"',
    "fi",
    'if [ -n "$FAKE_APPEND" ]; then',
    '  if [ -n "$FAKE_COUNTER_FILE" ]; then',
    '    echo "attempt-$n-dirty" >> hello.txt',
    "  else",
    '    echo "task-modified" >> hello.txt',
    "  fi",
    "fi",
    'if [ -n "$FAKE_ALWAYS_FAIL" ]; then echo "always-fail (attempt $n)"; exit 1; fi',
    'if [ -n "$FAKE_FAIL_UNTIL" ] && [ "$n" -le "$FAKE_FAIL_UNTIL" ]; then',
    '  echo "attempt $n: intended failure"',
    "  exit 1",
    "fi",
    'if [ -z "$FAKE_NO_COMMIT" ]; then',
    '  git_lock="$COAGENTHUB_REPO_ROOT/.coagenthub-test-git-lock"',
    '  while ! mkdir "$git_lock" 2>/dev/null; do sleep 0.01; done',
    "  trap 'rmdir \"$git_lock\" 2>/dev/null || true' EXIT",
    '  if ! git add -A || ! git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake bin change"; then exit 1; fi',
    '  rmdir "$git_lock"',
    "  trap - EXIT",
    "fi",
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:修改完成"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeScript, 0o755);
const { bin: fakeBin, argsPrefix: fakeArgsPrefix } =
  resolveFakeExecutor(fakeScript);
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;
process.env.EXECUTOR_BIN_EXECUTOR = fakeBin;

const repoDir = mkdtempSync(path.join(tmpdir(), "coagenthub-guard-repo-"));
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

const { createTestApp } = await import("./app");

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
afterAll(() => {
  rmSync(fakeDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

describe("RB-GUARD 重试回滚外来提交防护", () => {
  const app = createTestApp();
  const executorKeyByName: Record<string, string> = {
    CodeBuddy: "codebuddy",
    AtomCode: "executor",
  };
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
        const ek = executorKeyByName[String(body.name)];
        if (ek)
          await testDb
            .update(participantTable)
            .set({ executorKey: ek })
            .where(eq(participantTable.id, existing.id));
        return { id: existing.id };
      }
    }
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const ek = executorKeyByName[String(body.name)];
    if (ek)
      await testDb
        .update(participantTable)
        .set({ executorKey: ek })
        .where(eq(participantTable.id, id));
    return { id };
  }
  async function createGroup(pid: string, title: string) {
    const res = await app.request("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Participant-Id": pid },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }
  async function addMember(
    pid: string,
    gid: string,
    mid: string,
    roles: string[],
  ) {
    const res = await app.request(`/api/groups/${gid}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Participant-Id": pid },
      body: JSON.stringify({ participantId: mid, roles }),
    });
    expect(res.status).toBe(200);
  }
  async function bindProject(pid: string, gid: string, dir: string) {
    const res = await app.request(`/api/groups/${gid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Participant-Id": pid },
      body: JSON.stringify({ projectPath: dir }),
    });
    expect(res.status).toBe(200);
  }
  async function postMessage(
    pid: string,
    gid: string,
    body: Record<string, unknown>,
  ) {
    const res = await app.request(`/api/groups/${gid}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Participant-Id": pid },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; groupId: string };
  }
  async function listTasks(pid: string, gid: string) {
    const res = await app.request(`/api/groups/${gid}/tasks`, {
      headers: { "X-Participant-Id": pid },
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
  async function listMessages(pid: string, gid: string) {
    const res = await app.request(`/api/groups/${gid}/messages`, {
      headers: { "X-Participant-Id": pid },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{
      id: string;
      body: string;
      contentType: string;
    }>;
  }
  async function waitForTaskStatus(
    pid: string,
    gid: string,
    mid: string,
    status: string,
    timeoutMs = 20000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tasks = await listTasks(pid, gid);
      const t = tasks.find((x) => x.messageId === mid);
      if (t && t.status === status) return t;
      if (Date.now() > deadline)
        throw new Error(`waitForTaskStatus timeout ${status} mid=${mid}`);
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  async function waitForMessage(
    pid: string,
    gid: string,
    pred: (m: { body: string }) => boolean,
    timeoutMs = 15000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const msgs = await listMessages(pid, gid);
      const hit = msgs.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error("waitForMessage timeout");
      await new Promise((r) => setTimeout(r, 120));
    }
  }
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
  /** 跑 git 并取 stdout(文本)。 */
  function gitOut(proj: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: proj }).toString();
  }
  /** 读工作树文件;本机 core.autocrlf=true,统一成 LF 再比对内容。 */
  function readText(file: string): string {
    return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  }
  /** 模拟执行器把当前工作树(含未跟踪文件)变成一次提交。 */
  function commitAll(proj: string, message: string): void {
    execFileSync("git", ["add", "-A"], { cwd: proj });
    execFileSync("git", ["commit", "-qm", message], { cwd: proj });
  }
  async function runner() {
    return import("@server/lib/executor-runner");
  }
  async function setupGroup() {
    const coordinator = await registerParticipant({ name: "coord-guard" });
    const codebuddy = await registerParticipant({ name: "CodeBuddy" });
    const group = await createGroup(coordinator.id, `guard-${Date.now()}`);
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  it("验收#1 外来提交存活且重试继续：checkpoint后第三方提交，重试跳过硬回滚，diffSummary含rollbackSkipped，群内有说明", async () => {
    process.env.FAKE_SLEEP_SECS = "1";
    const counterDir = mkdtempSync(
      path.join(tmpdir(), "coagenthub-guard-cnt-"),
    );
    const counterFile = path.join(counterDir, "n.txt");
    process.env.FAKE_COUNTER_FILE = counterFile;
    process.env.FAKE_FAIL_UNTIL = "1";
    process.env.FAKE_APPEND = "1";
    const proj = makeGitRepo("coagenthub-guard-foreign-");
    const { coordinator, codebuddy } = await setupGroup();
    const group = await createGroup(
      coordinator.id,
      `guard-foreign-${Date.now()}`,
    );
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    await bindProject(coordinator.id, group.id, proj);
    try {
      const msg = await postMessage(coordinator.id, group.id, {
        body: "guard外来提交防护任务",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      // 等任务进入 running（已打 checkpoint）
      await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "running",
        10000,
      );
      // 模拟检视者在任务运行期间提交一个外来 commit
      // 稍等确保 checkpoint 已落库
      await new Promise((r) => setTimeout(r, 300));
      writeFileSync(path.join(proj, "foreign.txt"), "inspector spec v1\n");
      execFileSync("git", ["add", "-A"], { cwd: proj });
      execFileSync("git", ["commit", "-qm", "foreign: inspector commit"], {
        cwd: proj,
      });
      const foreignHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: proj,
      })
        .toString()
        .trim();
      // 等待最终 done（重试后成功）
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "done",
        25000,
      );
      expect(t.retryCount).toBe(1);
      // 外来提交存活：HEAD 仍是 foreign 或其后代（fake bin 的第二次成功也会提交一次，但外来文件仍在）
      const headNow = execFileSync("git", ["rev-parse", "HEAD"], { cwd: proj })
        .toString()
        .trim();
      expect(headNow).not.toBe(t.checkpointRef);
      // 外来文件仍在（未被 reset --hard 抹掉）
      expect(() =>
        readFileSync(path.join(proj, "foreign.txt"), "utf8"),
      ).not.toThrow();
      const foreignAlive = execFileSync("git", ["log", "--oneline", "--all"], {
        cwd: proj,
      }).toString();
      expect(foreignAlive).toContain("foreign: inspector commit");
      // diffSummary 含 rollbackSkipped 留痕，形状精确
      const diff = t.diffSummary as Record<string, unknown>;
      expect(diff).toBeDefined();
      const skipped = diff.rollbackSkipped as
        | Record<string, unknown>
        | undefined;
      expect(skipped).toBeDefined();
      if (!skipped) throw new Error("rollbackSkipped missing");
      expect(skipped.reason).toBe(
        "checkpoint 之后存在外来提交,跳过回滚保护共享工作树",
      );
      expect(typeof skipped.headAtSkip).toBe("string");
      expect((skipped.headAtSkip as string).length).toBeGreaterThanOrEqual(7);
      expect(skipped.checkpoint).toBe(t.checkpointRef);
      // 外来 commit 仍为 HEAD 祖先（核心防护断言，foreignHead 参与真实断言）
      expect(() =>
        execFileSync(
          "git",
          ["merge-base", "--is-ancestor", foreignHead, headNow],
          { cwd: proj },
        ),
      ).not.toThrow();
      // headAtSkip 应对应当时的 foreign HEAD（或其后一次重试提交前的值，至少包含 foreign）
      // 群内回传含可读说明（⚠️ 且含“跳过回滚”）
      await waitForMessage(
        coordinator.id,
        group.id,
        (m) => m.body.includes("跳过回滚") && m.body.includes("外来提交"),
      );
      await waitForMessage(
        coordinator.id,
        group.id,
        (m) => m.body.startsWith("↻") && m.body.includes("自动重试 (第 1 次)"),
      );
    } finally {
      process.env.FAKE_COUNTER_FILE = "";
      process.env.FAKE_FAIL_UNTIL = "";
      process.env.FAKE_APPEND = "";
      process.env.FAKE_SLEEP_SECS = "";
      rmSync(counterDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("验收#2 HEAD==checkpoint 时硬 reset 照常执行（干净重试回归）", async () => {
    const counterDir = mkdtempSync(
      path.join(tmpdir(), "coagenthub-guard-clean-"),
    );
    const counterFile = path.join(counterDir, "n.txt");
    process.env.FAKE_COUNTER_FILE = counterFile;
    process.env.FAKE_FAIL_UNTIL = "1";
    process.env.FAKE_APPEND = "1";
    const proj = makeGitRepo("coagenthub-guard-clean-");
    const { coordinator, codebuddy } = await setupGroup();
    const group = await createGroup(
      coordinator.id,
      `guard-clean-${Date.now()}`,
    );
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    await bindProject(coordinator.id, group.id, proj);
    try {
      const msg = await postMessage(coordinator.id, group.id, {
        body: "guard干净重试任务",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "done",
        25000,
      );
      expect(t.retryCount).toBe(1);
      // 干净重试：首次的 attempt-1-dirty 应被回滚抹掉，只留 attempt-2
      const content = readFileSync(path.join(proj, "hello.txt"), "utf8");
      expect(content).toContain("attempt-2-dirty");
      expect(content).not.toContain("attempt-1-dirty");
      const diff = t.diffSummary as Record<string, unknown>;
      expect((diff as Record<string, unknown>).rollbackSkipped).toBeUndefined();
      // 回滚不得把 checkpoint 提交推上 HEAD(R1/R2):快照提交不是 HEAD 的祖先,
      // 日志里也不该出现机器生成的 checkpoint 提交。
      const cpSha = execFileSync("git", ["rev-parse", t.checkpointRef ?? ""], {
        cwd: proj,
      })
        .toString()
        .trim();
      expect(cpSha.length).toBeGreaterThan(0);
      expect(() =>
        execFileSync("git", ["merge-base", "--is-ancestor", cpSha, "HEAD"], {
          cwd: proj,
        }),
      ).toThrow();
      const log = execFileSync("git", ["log", "--oneline"], {
        cwd: proj,
      }).toString();
      expect(log).not.toContain("coagenthub checkpoint");
    } finally {
      process.env.FAKE_COUNTER_FILE = "";
      process.env.FAKE_FAIL_UNTIL = "";
      process.env.FAKE_APPEND = "";
      rmSync(counterDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("验收#3 快照不存在（ref无效）→ 终止重试，保留原失败原因（回归）", async () => {
    const counterDir = mkdtempSync(
      path.join(tmpdir(), "coagenthub-guard-invalid-"),
    );
    const counterFile = path.join(counterDir, "n.txt");
    process.env.FAKE_COUNTER_FILE = counterFile;
    process.env.FAKE_ALWAYS_FAIL = "1";
    process.env.FAKE_SLEEP_SECS = "2";
    const proj = makeGitRepo("coagenthub-guard-invalid-");
    const { coordinator, codebuddy } = await setupGroup();
    const group = await createGroup(
      coordinator.id,
      `guard-invalid-${Date.now()}`,
    );
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    await bindProject(coordinator.id, group.id, proj);
    try {
      const msg = await postMessage(coordinator.id, group.id, {
        body: "guard无效快照任务",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      // 等待 checkpoint 已创建且首次 attempt 尚未结束（sleep 窗口内）
      const running = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "running",
        10000,
      );
      const checkpointRef = running.checkpointRef;
      expect(checkpointRef).toBeTruthy();
      if (!checkpointRef) throw new Error("checkpointRef missing");
      // 删除真实 checkpoint ref，使任务落库 ref 无效（等价篡改）
      // polling 确保 ref 已写入 git 后再删除
      for (let i = 0; i < 20; i++) {
        const v = await (await import("@server/lib/executor-runner")).gitExec(
          ["rev-parse", "--verify", checkpointRef],
          proj,
        );
        if (v.status === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      execFileSync("git", ["update-ref", "-d", checkpointRef], { cwd: proj });
      const cntRes = await (
        await import("@server/lib/executor-runner")
      ).gitExec(["rev-list", "--count", `${checkpointRef}..HEAD`], proj);
      expect(cntRes.status).not.toBe(0);
      // 等待最终 failed（回滚失败 → 终止重试，不进入第二次 attempt）
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "failed",
        25000,
      );
      expect(t.checkpointRef).toBe(checkpointRef);
      expect(t.retryCount).toBe(0);
      // 无第二次 spawn/attempt：计数器仅 1，attempts 仅一条
      const counterVal = (() => {
        try {
          return readFileSync(counterFile, "utf8").trim();
        } catch {
          return "";
        }
      })();
      expect(counterVal).toBe("1");
      // attempts 可选校验：若落库则长度为 1
      const attempts = (t as unknown as { attempts?: unknown[] }).attempts;
      if (attempts) expect(attempts.length).toBe(1);
      const diff = t.diffSummary as Record<string, unknown>;
      expect(diff).toBeDefined();
      expect(String(diff.error)).toContain("exit 1");
      expect(String(diff.error)).toMatch(/回滚失败|快照不存在/);
      expect(String(diff.error)).toContain("终止重试");
      expect((diff as Record<string, unknown>).rollbackSkipped).toBeUndefined();
      // 未产生自动重试提示
      const msgs = await listMessages(coordinator.id, group.id);
      expect(msgs.some((m) => m.body.includes("自动重试"))).toBe(false);
    } finally {
      process.env.FAKE_COUNTER_FILE = "";
      process.env.FAKE_ALWAYS_FAIL = "";
      process.env.FAKE_SLEEP_SECS = "";
      rmSync(counterDir, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  }, 30_000);

  it("验收#5 手动回滚 control.ts 逐字不变：有外来提交时仍硬 reset（人在场）", async () => {
    // 手动回滚路径使用 COAGENTHUB_REPO_ROOT（全局 repoDir），不用绑项目，避免控制与队列的仓库解析分叉
    const repoRoot = process.env.COAGENTHUB_REPO_ROOT;
    expect(repoRoot).toBeTruthy();
    if (!repoRoot) throw new Error("COAGENTHUB_REPO_ROOT missing");
    const { coordinator, codebuddy } = await setupGroup();
    // 不绑项目：任务在默认 repo 上执行，手动回滚也在同一棵树
    const group = await createGroup(
      coordinator.id,
      `guard-manual-${Date.now()}`,
    );
    await addMember(coordinator.id, group.id, coordinator.id, ["coordinator"]);
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, {
      body: "manual前置任务",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const t = await waitForTaskStatus(
      coordinator.id,
      group.id,
      msg.id,
      "done",
      15000,
    );
    expect(t.checkpointRef).toBeTruthy();
    writeFileSync(path.join(repoRoot, "manual-foreign.txt"), "foreign\n");
    execFileSync("git", ["add", "-A"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-qm", "manual foreign"], { cwd: repoRoot });
    expect(() =>
      readFileSync(path.join(repoRoot, "manual-foreign.txt"), "utf8"),
    ).not.toThrow();
    await postMessage(coordinator.id, group.id, {
      body: `回滚 ${t.id}`,
      audience: "broadcast",
    } as Record<string, unknown>);
    await waitForMessage(
      coordinator.id,
      group.id,
      (m) => m.body.includes("已回滚到快照"),
      10000,
    );
    const gone = (() => {
      try {
        readFileSync(path.join(repoRoot, "manual-foreign.txt"), "utf8");
        return false;
      } catch {
        return true;
      }
    })();
    expect(gone).toBe(true);
    // 清理外来残留，避免污染全局 repo 后续测试
    try {
      execFileSync("git", ["reset", "--hard", "HEAD~1"], { cwd: repoRoot });
    } catch {}
    try {
      const cpRef = t.checkpointRef;
      if (!cpRef) throw new Error("checkpointRef missing");
      execFileSync("git", ["update-ref", "-d", cpRef], {
        cwd: repoRoot,
      });
    } catch {}
  }, 30_000);

  it("preserveRollbackSkipped 跨 diffSummary 覆盖不丢失", async () => {
    const { preserveRollbackSkipped } = await import(
      "@server/lib/executor-task"
    );
    const existing = {
      rollbackSkipped: {
        reason: "checkpoint 之后存在外来提交,跳过回滚保护共享工作树",
        headAtSkip: "abc",
        checkpoint: "refs/coagenthub-cp/x",
      },
      other: 1,
    };
    const next: Record<string, unknown> = { other: 2 };
    const res = preserveRollbackSkipped(existing, next);
    expect(res.rollbackSkipped).toEqual(existing.rollbackSkipped);
    // 已显式含该键时以新值为准
    const next2: Record<string, unknown> = { rollbackSkipped: null };
    const res2 = preserveRollbackSkipped(existing, next2);
    expect(res2.rollbackSkipped).toBeNull();
  });

  it("验收#1b 回滚后 HEAD 停在快照时刻的真实提交(C^)：checkpoint 提交不上 HEAD，未提交改动仍是未提交", async () => {
    const proj = makeGitRepo("coagenthub-guard-head-");
    try {
      // 快照时的工作树：①已跟踪已修改 ②未跟踪
      writeFileSync(path.join(proj, "hello.txt"), "snapshot-edit\n");
      writeFileSync(path.join(proj, "local-only.txt"), "snapshot-untracked\n");
      const { createCheckpoint, resetToCheckpoint } = await runner();
      const headAtSnapshot = gitOut(proj, "rev-parse", "HEAD").trim();
      const cp = await createCheckpoint("head-guard-task", proj);
      expect(cp.sha).not.toBe(headAtSnapshot);

      // 执行器在本次尝试里产生一个提交(把未跟踪文件也一起提交掉)
      commitAll(proj, "exec attempt change");
      expect(gitOut(proj, "rev-parse", "HEAD").trim()).not.toBe(headAtSnapshot);

      const res = await resetToCheckpoint(cp.ref, proj);
      expect(res.ok).toBe(true);

      // R2：HEAD == C^，不等于 checkpoint 提交
      const head = gitOut(proj, "rev-parse", "HEAD").trim();
      expect(head).toBe(headAtSnapshot);
      expect(head).not.toBe(cp.sha);
      // 日志里既没有 checkpoint 提交，也没有本次尝试的提交(验收#2)
      const log = gitOut(proj, "log", "--oneline");
      expect(log).not.toContain("coagenthub checkpoint");
      expect(log).not.toContain("exec attempt change");
      // 已跟踪已修改 → 仍是未提交的 M，内容=快照时
      const status = gitOut(proj, "status", "--porcelain");
      expect(status).toContain(" M hello.txt");
      expect(readText(path.join(proj, "hello.txt"))).toBe("snapshot-edit\n");
      // 未跟踪 → 仍是 ??(不是 A )
      expect(status).toContain("?? local-only.txt");
      expect(readText(path.join(proj, "local-only.txt"))).toBe(
        "snapshot-untracked\n",
      );
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }, 30_000);

  it("验收#3b 执行中删除的已跟踪文件，回滚后恢复(R3)", async () => {
    const proj = makeGitRepo("coagenthub-guard-deleted-");
    try {
      writeFileSync(path.join(proj, "kept.txt"), "kept-at-snapshot\n");
      execFileSync("git", ["add", "-A"], { cwd: proj });
      execFileSync("git", ["commit", "-qm", "add kept"], { cwd: proj });
      const { createCheckpoint, resetToCheckpoint } = await runner();
      const cp = await createCheckpoint("deleted-file-task", proj);

      // 执行器删掉已跟踪文件并提交
      rmSync(path.join(proj, "kept.txt"), { force: true });
      commitAll(proj, "exec removed kept");
      expect(existsSync(path.join(proj, "kept.txt"))).toBe(false);

      const res = await resetToCheckpoint(cp.ref, proj);
      expect(res.ok).toBe(true);
      expect(readText(path.join(proj, "kept.txt"))).toBe("kept-at-snapshot\n");
      expect(gitOut(proj, "status", "--porcelain")).not.toContain("kept.txt");
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }, 30_000);

  it("验收#4 执行中新建的文件：未提交的新建保留为 ??，已提交的新建被移除(与现状一致，不跑 git clean)", async () => {
    const proj = makeGitRepo("coagenthub-guard-newfile-");
    try {
      const { createCheckpoint, resetToCheckpoint } = await runner();
      const cp = await createCheckpoint("new-file-task", proj);

      // 执行器新建并提交了 committed-new.txt；随后又留下一个未提交的 leftover.txt
      writeFileSync(path.join(proj, "committed-new.txt"), "exec made\n");
      commitAll(proj, "exec added file");
      writeFileSync(path.join(proj, "leftover.txt"), "exec leftover\n");

      const res = await resetToCheckpoint(cp.ref, proj);
      expect(res.ok).toBe(true);
      // 已提交的新建文件：原本 `reset --hard` 就会移除(它不在快照树里)，行为不变
      expect(existsSync(path.join(proj, "committed-new.txt"))).toBe(false);
      // 未提交的新建文件：不跑 git clean，仍然留在工作树里且仍是未跟踪
      expect(existsSync(path.join(proj, "leftover.txt"))).toBe(true);
      expect(gitOut(proj, "status", "--porcelain")).toContain(
        "?? leftover.txt",
      );
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }, 30_000);

  it("空树快照:跳过 restore,回滚算成功且 HEAD 停在 C^", async () => {
    // 仓库只有空提交 → createCheckpoint 的树为空;旧实现 git restore -- . 会
    // pathspec 失败并返回 ok:false,重试被误终止。
    const proj = mkdtempSync(
      path.join(tmpdir(), "coagenthub-guard-empty-tree-"),
    );
    try {
      execFileSync("git", ["init", "-q"], { cwd: proj });
      execFileSync("git", ["config", "user.email", "test@coagenthub.local"], {
        cwd: proj,
      });
      execFileSync("git", ["config", "user.name", "coagenthub-test"], {
        cwd: proj,
      });
      execFileSync("git", ["commit", "--allow-empty", "-qm", "empty seed"], {
        cwd: proj,
      });
      const { createCheckpoint, resetToCheckpoint } = await runner();
      const headAtSnapshot = gitOut(proj, "rev-parse", "HEAD").trim();
      const cp = await createCheckpoint("empty-tree-task", proj);
      // 正面确认树为空(与实现判据一致)
      const treeNames = gitOut(
        proj,
        "ls-tree",
        "-r",
        "--name-only",
        cp.sha,
      ).trim();
      expect(treeNames).toBe("");

      // 执行器留下一次空提交(模拟 attempt)
      execFileSync("git", ["commit", "--allow-empty", "-qm", "exec attempt"], {
        cwd: proj,
      });
      expect(gitOut(proj, "rev-parse", "HEAD").trim()).not.toBe(headAtSnapshot);

      const res = await resetToCheckpoint(cp.ref, proj);
      expect(res.ok).toBe(true);
      expect(gitOut(proj, "rev-parse", "HEAD").trim()).toBe(headAtSnapshot);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }, 30_000);

  it("非空树但 restore 真实失败仍返回 ok:false(R2 不放宽过头)", async () => {
    // 构造非空快照树,但故意删掉树里引用的 blob,使 restore 读对象失败。
    // ls-tree 仍能列出文件名 → 实现必须走 restore 且把失败向上抛。
    const proj = makeGitRepo("coagenthub-guard-restore-fail-");
    try {
      const { resetToCheckpoint } = await runner();
      const base = gitOut(proj, "rev-parse", "HEAD").trim();
      const ghostPath = path.join(proj, "ghost.txt");
      writeFileSync(ghostPath, "ghost-content-unique-for-r2\n");
      const blob = execFileSync("git", ["hash-object", "-w", ghostPath], {
        cwd: proj,
      })
        .toString()
        .trim();
      const mktree = execFileSync("git", ["mktree"], {
        cwd: proj,
        input: `100644 blob ${blob}\tghost.txt\n`,
      })
        .toString()
        .trim();
      const cSha = execFileSync(
        "git",
        ["commit-tree", mktree, "-p", base, "-m", "coagenthub checkpoint r2"],
        { cwd: proj },
      )
        .toString()
        .trim();
      const ref = "refs/coagenthub-cp/restore-fail-task";
      execFileSync("git", ["update-ref", ref, cSha], { cwd: proj });
      // 树非空
      expect(gitOut(proj, "ls-tree", "-r", "--name-only", cSha).trim()).toBe(
        "ghost.txt",
      );
      // 删掉 blob 对象,restore 必败;Windows 上 git 对象常带只读属性
      const objPath = path.join(
        proj,
        ".git",
        "objects",
        blob.slice(0, 2),
        blob.slice(2),
      );
      try {
        execFileSync("powershell", [
          "-Command",
          `Remove-Item -Force -LiteralPath '${objPath.replace(/'/g, "''")}'`,
        ]);
      } catch {
        rmSync(objPath, { force: true });
      }
      expect(existsSync(objPath)).toBe(false);
      rmSync(ghostPath, { force: true });

      const res = await resetToCheckpoint(ref, proj);
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/git restore 失败/);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }, 30_000);
});
