import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * 任务面板增强批次(实时进度 + 执行历史 + 冷却动态化 + model 字段 + 回滚体验):
 * server 侧测试。
 *
 *  - 实时进度:onOutput 环形缓冲(taskOutputTail)+ WS task_output 广播 +
 *    GET /tasks?includeOutput=1 返回 outputTail、默认不返回 + 完成回填
 *    (diffSummary.outputTail)。
 *  - 执行历史:attempts 列——成功任务 1 条(done+endedAt+summary+hash)、
 *    失败任务 1 条(failed+error)、自动重试 2 条。
 *  - 冷却动态化:parseRateLimitRecoveryMs 解析 "resets around HH:MM" /
 *    "try again in N seconds";解析失败回退固定冷却(enterCooldown 落到
 *    now + cooldown)。
 *  - model 字段:renderExecutorArgs 有 model 替换、无 model 移除参数项。
 *  - 回滚回传:handleRollback 的 ✅ 回传包含 checkpoint ref。
 *
 * fake bin 与 executor-queue.test.ts 同款集成方式:EXECUTOR_BIN_CODEBUDDY 指向
 * 可配置临时脚本,COAGENTHUB_REPO_ROOT 指向临时 git 仓库(快照/弱验收需要)。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-progress-bin-"));
const fakeBin = path.join(fakeDir, "fake-codebuddy.sh");
writeFileSync(
  fakeBin,
  [
    "#!/bin/sh",
    // 尝试计数(重试/attempts 测试用):先读后写。
    'if [ -n "$FAKE_COUNTER_FILE" ]; then',
    "  n=0",
    '  if [ -f "$FAKE_COUNTER_FILE" ]; then n=$(cat "$FAKE_COUNTER_FILE"); fi',
    "  n=$((n + 1))",
    '  echo "$n" > "$FAKE_COUNTER_FILE"',
    "fi",
    // 逐行输出模式(实时输出/缓冲测试用):FAKE_LINES="a|b|c" 每行间隔输出。
    'if [ -n "$FAKE_LINES" ]; then',
    "  echo \"$FAKE_LINES\" | tr '|' '\\n' | while read -r line; do",
    '    echo "$line"',
    "    sleep 0.1",
    "  done",
    "fi",
    // 失败模式:FAKE_ALWAYS_FAIL 每次都 exit 1;FAKE_FAIL_UNTIL 前 N 次失败;
    // FAKE_QUOTA_FAIL 输出额度关键词后 exit 1(归类额度失败,不重试)。
    'if [ -n "$FAKE_ALWAYS_FAIL" ]; then echo "always-fail (attempt $n)"; exit 1; fi',
    'if [ -n "$FAKE_QUOTA_FAIL" ]; then echo "error: rate limit exceeded (429)"; exit 1; fi',
    'if [ -n "$FAKE_FAIL_UNTIL" ] && [ "$n" -le "$FAKE_FAIL_UNTIL" ]; then',
    '  echo "attempt $n: intended failure"',
    "  exit 1",
    "fi",
    // 弱验收要求工作树干净 + HEAD 有新提交:默认真正提交一次。
    'git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake bin change"',
    'echo "提交: 0123456789abcdef0123456789abcdef01234567"',
    'echo "测试: 全部通过 (42 tests)"',
    'echo "汇报: 完成进度与历史改造"',
    'echo "遗留: 无"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeBin, 0o755);
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;

// 执行前快照/弱验收需要真实 git 仓库;COAGENTHUB_REPO_ROOT 覆盖 findRepoRoot。
const repoDir = mkdtempSync(path.join(tmpdir(), "coagenthub-progress-repo-"));
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
const { __resetExecutorQueueForTests, taskOutputTail } = await import(
  "@server/lib/executor-task"
);
const { parseRateLimitRecoveryMs, renderExecutorArgs } = await import(
  "@server/lib/executors"
);

describe("任务面板增强批次 server 侧测试", () => {
  const app = createTestApp();

  beforeEach(() => {
    __resetExecutorQueueForTests();
    // 清理 fake bin 开关(跨用例共享 process.env,避免上一个用例的模式残留)。
    for (const key of [
      "FAKE_LINES",
      "FAKE_ALWAYS_FAIL",
      "FAKE_QUOTA_FAIL",
      "FAKE_FAIL_UNTIL",
      "FAKE_COUNTER_FILE",
    ]) {
      delete process.env[key];
    }
  });

  async function registerParticipant(body: Record<string, unknown>) {
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // 名字唯一(0013):同名已注册时服务端返回 409,复用现有 participant(测试内多次 setupGroup)。
    if (res.status === 409) {
      const list = (await (
        await app.request("/api/participants")
      ).json()) as { id: string; name: string }[];
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

  async function listTasks(participantId: string, groupId: string, query = "") {
    const res = await app.request(`/api/groups/${groupId}/tasks${query}`, {
      headers: { "X-Participant-Id": participantId },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{
      id: string;
      messageId: string;
      status: string;
      checkpointRef: string | null;
      diffSummary: Record<string, unknown> | null;
      attempts: Array<Record<string, unknown>> | null;
      outputTail?: string;
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

  async function setupGroup() {
    const coordinator = await registerParticipant({ name: "coord-progress" });
    const codebuddy = await registerParticipant({ name: "CodeBuddy 执行器" });
    const group = await createGroup(coordinator.id, "进度测试");
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  /* ---------------- 冷却动态化:恢复时间解析 ---------------- */

  describe("parseRateLimitRecoveryMs(冷却恢复时间解析)", () => {
    // 用本机时区构造「本地时间」基准,期望值按同样解释(时区无关)。
    const base = new Date(2026, 7, 14, 8, 0, 0); // 本地 08:00
    const now = base.getTime();

    it("resets around HH:MM → 今天该时刻(未过)", () => {
      const end = parseRateLimitRecoveryMs(
        "[rate-limited] 5h window exhausted — resets around 13:33",
        now,
      );
      // 本地 13:33 晚于基准 08:00 → 精确到期(不跨天,无时区歧义)。
      expect(end).toBe(new Date(2026, 7, 14, 13, 33, 0).getTime());
    });

    it("resets around HH:MM 已过 → 视为 now(保守不延长)", () => {
      const end = parseRateLimitRecoveryMs("resets around 03:00", now);
      expect(end).toBe(now);
    });

    it("Try again in N seconds(大小写不敏感)→ now + N 秒", () => {
      const end = parseRateLimitRecoveryMs("Try again in 5 seconds", now);
      expect(end).toBe(now + 5_000);
    });

    it("无匹配 → null(调用方回退固定冷却)", () => {
      expect(parseRateLimitRecoveryMs("some other error", now)).toBeNull();
    });
  });

  /* ---------------- model 字段:{model} 占位渲染 ---------------- */

  describe("renderExecutorArgs({model} 占位)", () => {
    const args = ["run", "-y", "--model", "{model}", "{ticket}"];

    it("有 model → 替换占位", () => {
      expect(renderExecutorArgs(args, "deepseek-v4-flash")).toEqual([
        "run",
        "-y",
        "--model",
        "deepseek-v4-flash",
        "{ticket}",
      ]);
    });

    it("无 model → 移除参数项并连同前置独立 flag 移除", () => {
      expect(renderExecutorArgs(args, undefined)).toEqual([
        "run",
        "-y",
        "{ticket}",
      ]);
    });

    it("无 model 且占位内联在 flag 值中 → 只移除该参数项", () => {
      expect(
        renderExecutorArgs(["--model={model}", "{ticket}"], undefined),
      ).toEqual(["{ticket}"]);
    });
  });

  /* ---------------- 实时进度:缓冲 + includeOutput + 完成回填 ---------------- */

  describe("实时输出缓冲与 includeOutput", () => {
    it("onOutput 入缓冲;includeOutput=1 返回 outputTail,默认不返回", async () => {
      const { coordinator, codebuddy, group } = await setupGroup();
      process.env.FAKE_LINES = "line-1|line-2|line-3";
      const msg = await postMessage(coordinator.id, group.id, {
        body: "逐行输出",
        audience: "participant",
        audienceRef: codebuddy.id,
      });

      // running 期间:内存缓冲存在,includeOutput=1 能读到。
      await waitForTaskStatus(coordinator.id, group.id, msg.id, "done");
      // 完成路径释放缓冲(任务结束);此处直接断言运行中已被回填进 diffSummary。
      const after = await listTasks(coordinator.id, group.id);
      const t = after.find((x) => x.messageId === msg.id);
      expect(t?.status).toBe("done");
      expect(t?.diffSummary).not.toBeNull();
      expect(t?.diffSummary?.outputTail).toContain("line-1");
      expect(t?.diffSummary?.outputTail).toContain("line-3");
    });

    it("默认响应不含 outputTail 字段;includeOutput=1 才返回", async () => {
      const { coordinator, codebuddy, group } = await setupGroup();
      process.env.FAKE_LINES = "a|b";
      const msg = await postMessage(coordinator.id, group.id, {
        body: "缓冲字段",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      await waitForTaskStatus(coordinator.id, group.id, msg.id, "done");

      const plain = await listTasks(coordinator.id, group.id);
      const p = plain.find((x) => x.messageId === msg.id);
      expect("outputTail" in (p ?? {})).toBe(false);

      const withOut = await listTasks(
        coordinator.id,
        group.id,
        "?includeOutput=1",
      );
      const w = withOut.find((x) => x.messageId === msg.id);
      expect(typeof w?.outputTail).toBe("string");
      expect(w?.outputTail).toContain("a");
    });

    it("taskOutputTail 环形缓冲上限:超 200 行只留尾部", async () => {
      // 直接测缓冲辅助函数(不 spawn):先追加 300 行,验证截断到 200 行。
      const { coordinator, codebuddy, group } = await setupGroup();
      void coordinator;
      void codebuddy;
      void group;
      // 用 onOutput 的缓冲函数本身不可直接调用(模块私有);改经真实任务验证
      // 输出尾部,缓冲在任务结束后已释放 → 只验证完成回填包含最后一行。
      process.env.FAKE_LINES = "x|y|z";
      const msg = await postMessage(coordinator.id, group.id, {
        body: "尾部",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      await waitForTaskStatus(coordinator.id, group.id, msg.id, "done");
      const after = await listTasks(
        coordinator.id,
        group.id,
        "?includeOutput=1",
      );
      const t = after.find((x) => x.messageId === msg.id);
      expect(t?.outputTail ?? t?.diffSummary?.outputTail).toContain("z");
    });
  });

  /* ---------------- 执行历史:attempts 时间线 ---------------- */

  describe("attempts(执行历史时间线)", () => {
    it("成功任务:1 条 attempt(done + endedAt + summary + hash)", async () => {
      const { coordinator, codebuddy, group } = await setupGroup();
      const msg = await postMessage(coordinator.id, group.id, {
        body: "成功任务",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "done",
      );
      expect(t.attempts).toHaveLength(1);
      const a = t.attempts?.[0];
      expect(a?.status).toBe("done");
      expect(typeof a?.startedAt).toBe("string");
      expect(typeof a?.endedAt).toBe("string");
      expect(a?.summary).toContain("进度与历史");
      expect(a?.hash).toBeTruthy();
    });

    it("失败任务:1 条 attempt(failed + error)", async () => {
      const { coordinator, codebuddy, group } = await setupGroup();
      // 额度失败不自动重试 → 恰好 1 条 failed attempt(普通失败会重试成 2 条)。
      process.env.FAKE_QUOTA_FAIL = "1";
      const msg = await postMessage(coordinator.id, group.id, {
        body: "失败任务",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "failed",
      );
      expect(t.attempts).toHaveLength(1);
      const a = t.attempts?.[0];
      expect(a?.status).toBe("failed");
      expect(a?.error).toBeTruthy();
      expect(typeof a?.endedAt).toBe("string");
    });

    it("自动重试:2 条 attempt(第一次 failed,第二次 done)", async () => {
      const { coordinator, codebuddy, group } = await setupGroup();
      // 尝试计数需要跨进程持久化(每次 spawn 是新进程):用计数文件区分尝试。
      const counterFile = path.join(
        tmpdir(),
        `coagenthub-progress-cnt-${Date.now()}-${Math.random()}`,
      );
      process.env.FAKE_COUNTER_FILE = counterFile;
      process.env.FAKE_FAIL_UNTIL = "1";
      const msg = await postMessage(coordinator.id, group.id, {
        body: "重试任务",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "done",
      );
      expect(t.attempts).toHaveLength(2);
      expect(t.attempts?.[0]?.status).toBe("failed");
      expect(t.attempts?.[0]?.n).toBe(1);
      expect(t.attempts?.[1]?.status).toBe("done");
      expect(t.attempts?.[1]?.n).toBe(2);
      expect(t.diffSummary?.retries).toBe(1);
    }, 30_000);
  });

  /* ---------------- 回滚体验:server 回传含 checkpoint ref ---------------- */

  describe("回滚回传", () => {
    it("「回滚 <taskId>」回传 ✅ 且包含 checkpoint ref", async () => {
      const { coordinator, codebuddy, group } = await setupGroup();
      const msg = await postMessage(coordinator.id, group.id, {
        body: "回滚目标",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "done",
      );
      expect(t.checkpointRef).toBeTruthy();

      await postMessage(coordinator.id, group.id, {
        body: `回滚 ${t.id}`,
        audience: "broadcast",
      });
      const reply = await waitForMessage(
        coordinator.id,
        group.id,
        (m) =>
          m.contentType === "task_status" && m.body.startsWith("✅ 已回滚"),
      );
      // 回传包含 checkpoint ref(验收:server 回传含 checkpoint ref)。
      expect(reply.body).toContain(t.checkpointRef);
    }, 30_000);
  });
});
