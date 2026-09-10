import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executorConfig as executorConfigTable } from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedBuiltinExecutorConfigs, testDb } from "./db";
import { resolveFakeExecutor, withFakeExecutorArgs } from "./fake-executor-bin";

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-r9-bin-"));
const fakeScript = path.join(fakeDir, "fake-codebuddy.sh");
writeFileSync(
  fakeScript,
  [
    "#!/bin/sh",
    'if [ -n "$FAKE_COUNTER_FILE" ]; then n=0; if [ -f "$FAKE_COUNTER_FILE" ]; then n=$(cat "$FAKE_COUNTER_FILE"); fi; n=$((n + 1)); echo "$n" > "$FAKE_COUNTER_FILE"; fi',
    'if [ -n "$FAKE_R9_THIRD_PARTY" ]; then echo "[rate-limited] usage limit exceeded — quota exhausted"; sleep 2; exit 0; fi',
    'if [ -n "$FAKE_R9_VERIFIED" ]; then echo "[rate-limited] usage limit exceeded — quota exhausted"; git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "r9 verified commit"; HASH=$(git rev-parse --short=12 HEAD); echo "提交: $HASH"; echo "测试: ok"; echo "汇报: 有产出"; echo "遗留: 无"; exit 0; fi',
    'if [ -n "$FAKE_R9_TRANSIENT" ]; then echo "[rate-limited] auto-continuing in 3s…"; exit 0; fi',
    'if [ -n "$FAKE_R9_EXHAUSTED" ]; then echo "usage limit reached — resets around $FAKE_RESETS_AT"; exit 0; fi',
    'if [ -n "$FAKE_R9_NONZERO" ]; then echo "error: rate limit exceeded (429)"; exit 2; fi',
    'git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake"',
    'echo "提交: 0123456789abcdef0123456789abcdef01234567"',
    'echo "测试: ok"',
    'echo "汇报: done"',
    'echo "遗留: 无"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeScript, 0o755);
const { bin: fakeBin, argsPrefix: fakeArgsPrefix } =
  resolveFakeExecutor(fakeScript);

const repoDir = mkdtempSync(path.join(tmpdir(), "coagenthub-r9-repo-"));
execFileSync("git", ["init", "-q"], { cwd: repoDir });
execFileSync("git", ["config", "user.email", "test@coagenthub.local"], {
  cwd: repoDir,
});
execFileSync("git", ["config", "user.name", "coagenthub-test"], {
  cwd: repoDir,
});
writeFileSync(path.join(repoDir, "hello.txt"), "init\n");
execFileSync("git", ["add", "-A"], { cwd: repoDir });
execFileSync("git", ["commit", "-qm", "seed"], { cwd: repoDir });
const origBin = process.env.EXECUTOR_BIN_CODEBUDDY;
const origRepo = process.env.COAGENTHUB_REPO_ROOT;

const { createTestApp } = await import("./app");
const { __resetExecutorQueueForTests, __setRateLimitForTests } = await import(
  "@server/lib/executor-task"
);
import { classifyQuotaFailure } from "@server/lib/executor-task/state";

const QUOTA_PATTERNS = [
  "rate limit",
  "quota",
  "429",
  "额度",
  "window exhausted",
  "usage limit",
];

describe("R9 quota-failure-on-clean-exit", () => {
  const app = createTestApp();
  beforeAll(async () => {
    process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;
    process.env.COAGENTHUB_REPO_ROOT = repoDir;
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
  beforeEach(() => {
    __resetExecutorQueueForTests();
  });
  afterAll(() => {
    if (origBin === undefined) delete process.env.EXECUTOR_BIN_CODEBUDDY;
    else process.env.EXECUTOR_BIN_CODEBUDDY = origBin;
    if (origRepo === undefined) delete process.env.COAGENTHUB_REPO_ROOT;
    else process.env.COAGENTHUB_REPO_ROOT = origRepo;
    try {
      rmSync(fakeDir, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch {}
  });

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
      if (existing) return existing;
    }
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; name: string };
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
    return (await res.json()) as { id: string };
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
      diffSummary: any;
    }>;
  }
  async function waitForTaskStatus(
    pid: string,
    gid: string,
    mid: string,
    status: string,
    timeoutMs = 15000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tasks = await listTasks(pid, gid);
      const t = tasks.find((x) => x.messageId === mid);
      if (t && t.status === status) return t;
      if (Date.now() > deadline)
        throw new Error(
          `timeout waiting ${status} got ${tasks.find((x) => x.messageId === mid)?.status}`,
        );
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  async function setupGroup() {
    const coord = await registerParticipant({ name: "coord-r9" });
    const buddy = await registerParticipant({ name: "CodeBuddy" });
    const group = await createGroup(coord.id, "r9");
    await addMember(coord.id, group.id, buddy.id, ["executor"]);
    return { coord, buddy, group };
  }

  it("验收1: exit0 + 额度行 + 窗口内第三方提交 + 无声明 => 判额度并冷却", async () => {
    __setRateLimitForTests(300_000, QUOTA_PATTERNS);
    process.env.FAKE_R9_THIRD_PARTY = "1";
    try {
      const { coord, buddy, group } = await setupGroup();
      const msg = await postMessage(coord.id, group.id, {
        body: "r9验收1",
        audience: "participant",
        audienceRef: buddy.id,
      });
      setTimeout(() => {
        try {
          execFileSync(
            "git",
            ["commit", "--allow-empty", "-qm", "third party spec"],
            { cwd: repoDir },
          );
        } catch {}
      }, 500);
      const t = await waitForTaskStatus(
        coord.id,
        group.id,
        msg.id,
        "failed",
        15000,
      );
      expect(String(t.diffSummary?.error)).toContain("额度");
      const { isInCooldown } = await import("@server/lib/executor-task/state");
      expect(isInCooldown({ key: "codebuddy" })).toBe(true);
      expect(t.diffSummary?.quotaMatchedButCommitFound).toBeUndefined();
    } finally {
      delete process.env.FAKE_R9_THIRD_PARTY;
    }
  }, 30000);

  it("验收2: exit0 + 额度行 + 汇报声明提交且核实 => 不判额度、不冷却,保留 quotaMatchedButCommitFound", async () => {
    __setRateLimitForTests(300_000, QUOTA_PATTERNS);
    process.env.FAKE_R9_VERIFIED = "1";
    try {
      const { coord, buddy, group } = await setupGroup();
      const msg = await postMessage(coord.id, group.id, {
        body: "r9验收2",
        audience: "participant",
        audienceRef: buddy.id,
      });
      const t = await waitForTaskStatus(
        coord.id,
        group.id,
        msg.id,
        "done",
        15000,
      );
      expect(t.status).toBe("done");
      const { isInCooldown } = await import("@server/lib/executor-task/state");
      expect(isInCooldown({ key: "codebuddy" })).toBe(false);
      expect(t.diffSummary?.quotaMatchedButCommitFound).toBeTruthy();
      expect(
        String((t.diffSummary?.quotaMatchedButCommitFound as any)?.matchedLine),
      ).toMatch(/quota|rate limit/i);
    } finally {
      delete process.env.FAKE_R9_VERIFIED;
    }
  }, 30000);

  it("验收3: [rate-limited] auto-continuing in 3s + 零提交/无声明 => isQuota false (次闸)", async () => {
    const verdict = classifyQuotaFailure(
      ["[rate-limited] auto-continuing in 3s…"],
      { exitCode: 0 },
    );
    expect(verdict.isQuota).toBe(true);
    expect(verdict.kind).toBe("transient");
    __setRateLimitForTests(300_000, QUOTA_PATTERNS);
    process.env.FAKE_R9_TRANSIENT = "1";
    try {
      const { coord, buddy, group } = await setupGroup();
      const msg = await postMessage(coord.id, group.id, {
        body: "r9验收3",
        audience: "participant",
        audienceRef: buddy.id,
      });
      const t = await waitForTaskStatus(
        coord.id,
        group.id,
        msg.id,
        "done",
        15000,
      );
      expect(t.status).toBe("done");
      const { isInCooldown } = await import("@server/lib/executor-task/state");
      expect(isInCooldown({ key: "codebuddy" })).toBe(false);
      expect(t.diffSummary?.quotaMatchedButTransient).toBeTruthy();
      expect(
        String((t.diffSummary?.quotaMatchedButTransient as any)?.matchedLine),
      ).toContain("auto-continuing");
      expect(t.diffSummary?.quotaMatchedLine).toBeUndefined();
    } finally {
      delete process.env.FAKE_R9_TRANSIENT;
    }
  }, 30000);

  it("验收4: window exhausted — resets around HH:MM + 零产出 + exit0 => 判额度并冷却", async () => {
    __setRateLimitForTests(300_000, QUOTA_PATTERNS);
    const target = new Date(Date.now() + 25 * 60_000);
    const resetsAt = `${target.getHours()}:${String(target.getMinutes()).padStart(2, "0")}`;
    process.env.FAKE_R9_EXHAUSTED = "1";
    process.env.FAKE_RESETS_AT = resetsAt;
    try {
      const { coord, buddy, group } = await setupGroup();
      const msg = await postMessage(coord.id, group.id, {
        body: "r9验收4",
        audience: "participant",
        audienceRef: buddy.id,
      });
      const t = await waitForTaskStatus(
        coord.id,
        group.id,
        msg.id,
        "failed",
        15000,
      );
      expect(String(t.diffSummary?.error)).toContain("额度");
      const { isInCooldown } = await import("@server/lib/executor-task/state");
      expect(isInCooldown({ key: "codebuddy" })).toBe(true);
      expect(String(t.diffSummary?.quotaMatchedLine)).toContain(
        "resets around",
      );
    } finally {
      delete process.env.FAKE_R9_EXHAUSTED;
      delete process.env.FAKE_RESETS_AT;
    }
  }, 30000);

  it("验收5: 非零退出路径逐字不变 (exit2 + 额度行 => 仍判额度)", async () => {
    __setRateLimitForTests(300_000, QUOTA_PATTERNS);
    process.env.FAKE_R9_NONZERO = "1";
    try {
      const { coord, buddy, group } = await setupGroup();
      const msg = await postMessage(coord.id, group.id, {
        body: "r9验收5",
        audience: "participant",
        audienceRef: buddy.id,
      });
      const t = await waitForTaskStatus(
        coord.id,
        group.id,
        msg.id,
        "failed",
        15000,
      );
      expect(String(t.diffSummary?.error)).toContain("额度");
      const { isInCooldown } = await import("@server/lib/executor-task/state");
      expect(isInCooldown({ key: "codebuddy" })).toBe(true);
    } finally {
      delete process.env.FAKE_R9_NONZERO;
    }
  }, 30000);

  it("验收6: 留痕区分三种结局", async () => {
    __setRateLimitForTests(300_000, QUOTA_PATTERNS);
    const { coord, buddy, group } = await setupGroup();
    const msg = await postMessage(coord.id, group.id, {
      body: "r9验收6-未命中",
      audience: "participant",
      audienceRef: buddy.id,
    });
    const t = await waitForTaskStatus(
      coord.id,
      group.id,
      msg.id,
      "done",
      15000,
    );
    expect(t.diffSummary?.quotaMatchedLine).toBeUndefined();
    expect(t.diffSummary?.quotaMatchedButCommitFound).toBeUndefined();
    expect(t.diffSummary?.quotaMatchedButTransient).toBeUndefined();
  }, 30000);
});
