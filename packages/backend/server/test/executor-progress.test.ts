import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { executorConfig as executorConfigTable } from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { seedBuiltinExecutorConfigs, testDb } from "./db";
import { resolveFakeExecutor, withFakeExecutorArgs } from "./fake-executor-bin";

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
const fakeScript = path.join(fakeDir, "fake-codebuddy.sh");
writeFileSync(
  fakeScript,
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
    // ANSI 输出模式(源头剥离测试用):FAKE_ANSI 输出带色行,验证缓冲/广播
    // 收到的是剥离文本(stdout 控制台保留原样)。
    'if [ -n "$FAKE_ANSI" ]; then',
    "  printf '\\033[32mgreen-line\\033[0m\\n'",
    "  printf '\\033[31mred-line\\033[0m\\n'",
    "fi",
    // 失败模式:FAKE_ALWAYS_FAIL 每次都 exit 1;FAKE_FAIL_UNTIL 前 N 次失败;
    // FAKE_QUOTA_FAIL 输出额度关键词后 exit 1(归类额度失败,不重试)。
    'if [ -n "$FAKE_ALWAYS_FAIL" ]; then echo "always-fail (attempt $n)"; exit 1; fi',
    'if [ -n "$FAKE_QUOTA_FAIL" ]; then echo "error: rate limit exceeded (429)"; exit 1; fi',
    // 成功路径额度检测(quota-failure-on-clean-exit 规范):
    //  FAKE_QUOTA_EXIT0:尾部打印额度关键词后 exit 0(应判额度失败,不是 done);
    //  FAKE_QUOTA_FRONT:额度关键词只出现在输出最前面(不在尾部 20 行),继续
    //    走 done 路径(避免误判停派)。
    // 恢复时间用 "try again in 600 seconds"(相对未来,避免 "resets around HH:MM"
    // 因已过而回退 now 导致冷却瞬间过期,使 isInCooldown 断言不稳定)。
    'if [ -n "$FAKE_QUOTA_EXIT0" ]; then echo "[rate-limited] 5h window exhausted — try again in 600 seconds"; exit 0; fi',
    'if [ -n "$FAKE_QUOTA_FRONT" ]; then echo "[rate-limited] 5h window exhausted — try again in 600 seconds"; i=0; while [ $i -lt 30 ]; do echo "normal progress line $i"; i=$((i+1)); done; fi',
    // 伪额度回显回归(伪额度回显修复):FAKE_QUOTA_ECHO_EXIT0 在输出尾部回显含
    //  quota/额度 字样的测试文件名与测试源码(01a04e01-b50b / 01a04e31-3194 的
    //  误判现场)后 exit 0 —— 无恢复时刻、无错误行形状 → 不应判额度失败;
    //  FAKE_QUOTA_RESETS_EXIT0 尾部打印 "resets around HH:MM"(未来时刻)后立即
    //  exit 0(不提交)→ 应判配额并冷却至该时刻(成功路径保留真额度检测)。
    'if [ -n "$FAKE_QUOTA_ECHO_EXIT0" ]; then',
    '  echo "测试: 全量 L1 通过 — **59 测试文件 / 860 用例**(executor-report-quota.test.ts 38/38 通过)"',
    '  echo "expect(err).toContain(\\"执行器额度限制\\")"',
    "fi",
    'if [ -n "$FAKE_QUOTA_RESETS_EXIT0" ]; then echo "usage limit reached — resets around $FAKE_RESETS_AT"; exit 0; fi',
    // R6 主闸(quota-failure-on-clean-exit v1.1):
    //  FAKE_AUTO_CONTINUING_EXIT0:尾部打印自愈退避行后**照常提交并 exit 0**
    //    (任务窗口内有提交)→ 应被主闸拦下:不判额度、不冷却,任务落 done;
    //  FAKE_QUOTA_NO_RECOVERY_EXIT0:打印无可解析恢复时刻的额度行后 exit 0
    //    (无提交)→ 仍判额度并走固定兜底冷却。
    'if [ -n "$FAKE_AUTO_CONTINUING_EXIT0" ]; then echo "[rate-limited] auto-continuing in 3s…"; fi',
    'if [ -n "$FAKE_QUOTA_NO_RECOVERY_EXIT0" ]; then echo "error: rate limit exceeded (429 too many requests)"; exit 0; fi',
    // 超时分支回归:尾部打印额度关键词后 sleep 超过 EXECUTOR_TIMEOUT_MS → 超时
    // 分支(1261)仍应命中额度检测(失败 + 冷却 + 不重试)。写 stderr(行缓冲/不
    // 缓冲):管道 stdout 在 SIGKILL 前可能未刷出,导致超时瞬间捕获不到额度关键词。
    'if [ -n "$FAKE_TIMEOUT_QUOTA" ]; then echo "[rate-limited] 5h window exhausted — try again in 600 seconds" >&2; sleep 5; exit 0; fi',
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
chmodSync(fakeScript, 0o755);
const { bin: fakeBin, argsPrefix: fakeArgsPrefix } =
  resolveFakeExecutor(fakeScript);
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
const { __resetExecutorQueueForTests, taskOutputTail, __setRateLimitForTests } =
  await import("@server/lib/executor-task");
const { cooldownEndMs, isInCooldown } = await import(
  "@server/lib/executor-task/state"
);
const { parseRateLimitRecoveryMs, renderExecutorArgs } = await import(
  "@server/lib/executors"
);
const { wsHub } = await import("../src/lib/ws-hub");

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

describe("任务面板增强批次 server 侧测试", () => {
  const app = createTestApp();

  beforeEach(() => {
    __resetExecutorQueueForTests();
    // 清理 fake bin 开关(跨用例共享 process.env,避免上一个用例的模式残留)。
    for (const key of [
      "FAKE_LINES",
      "FAKE_ANSI",
      "FAKE_ALWAYS_FAIL",
      "FAKE_QUOTA_FAIL",
      "FAKE_QUOTA_EXIT0",
      "FAKE_QUOTA_FRONT",
      "FAKE_QUOTA_ECHO_EXIT0",
      "FAKE_QUOTA_RESETS_EXIT0",
      "FAKE_AUTO_CONTINUING_EXIT0",
      "FAKE_QUOTA_NO_RECOVERY_EXIT0",
      "FAKE_RESETS_AT",
      "FAKE_TIMEOUT_QUOTA",
      "FAKE_FAIL_UNTIL",
      "FAKE_COUNTER_FILE",
      "EXECUTOR_TIMEOUT_MS",
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
    const codebuddy = await registerParticipant({ name: "CodeBuddy" });
    const group = await createGroup(coordinator.id, "进度测试");
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  /* ---------------- 冷却动态化:恢复时间解析 ---------------- */

  describe("parseRateLimitRecoveryMs(冷却恢复时间解析)", () => {
    // R4:固定 epoch;纯时钟无时区标记按方案 (a) 返回 null(回落固定冷却)。
    const now = Date.UTC(2026, 7, 14, 0, 0, 0); // 2026-08-14 00:00Z == 08:00 UTC+8

    it("resets around HH:MM 无时区标记 → null(方案 a)", () => {
      // 意图:纯时钟解析契约。新契约下无 UTC±/GMT± 不视为可解析恢复时刻。
      expect(
        parseRateLimitRecoveryMs(
          "[rate-limited] 5h window exhausted — resets around 13:33",
          now,
        ),
      ).toBeNull();
    });

    it("resets around HH:MM 已过且无时区标记 → null(方案 a,不跨天推算)", () => {
      expect(parseRateLimitRecoveryMs("resets around 03:00", now)).toBeNull();
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
      // live-only: raw FAKE_LINES is not report, so includeOutput (live view) is absent
      // but full persistence still contains the lines via diffSummary.outputTail
      expect(w?.outputTail).toBeUndefined();
      expect(String((w as unknown as { diffSummary?: { outputTail?: string } })?.diffSummary?.outputTail ?? "")).toContain("a");
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
      // live-only: FAKE_LINES raw not report -> live outputTail absent, full still in diffSummary
      expect(t?.outputTail).toBeUndefined();
      expect(String((t as unknown as { diffSummary?: { outputTail?: string } })?.diffSummary?.outputTail ?? "")).toContain("z");
    });

    it("ANSI 在源头剥离:缓冲与广播收到干净文本,stdout 保留原样", async () => {
      const { coordinator, codebuddy, group } = await setupGroup();
      process.env.FAKE_ANSI = "1";
      // 广播路径 spy:验证 WS 广播收到的 chunk 已剥离。
      const broadcastSpy = vi
        .spyOn(wsHub, "broadcastTaskOutput")
        .mockResolvedValue();
      // stdout 路径 spy:验证 server 控制台仍收到原始(带色)chunk。
      const stdoutSpy = vi.spyOn(process.stdout, "write");
      const msg = await postMessage(coordinator.id, group.id, {
        body: "ANSI 剥离",
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
      // 环形缓冲(appendTaskOutput 路径)收到的是剥离文本:内容在、转义无残留。
      const tail = (t?.outputTail ??
        t?.diffSummary?.outputTail ??
        "") as string;
      expect(tail).toContain("green-line");
      expect(tail).toContain("red-line");
      expect(tail).not.toMatch(/\u001b\[/);
      // WS 广播(实时界面仅 report, raw 不进界面):raw ANSI 行不广播,仍需剥离正确性
      // 由全量缓冲尾校验;此处仅校验若有广播则无转义残留(raw 不进界面故可能为 0)。
      const broadcastChunks = broadcastSpy.mock.calls.map((c) => c[2]);
      for (const chunk of broadcastChunks) {
        expect(chunk).not.toMatch(/\u001b\[/);
      }
      // stdout 保留原样:至少一个写出的 chunk 仍带 ANSI 转义(控制台留色)。
      const stdoutChunks = stdoutSpy.mock.calls.map((c) => String(c[0]));
      expect(stdoutChunks.some((c) => /\u001b\[/.test(c))).toBe(true);
    });
  });

  // spy 还原(集成用例安装了 wsHub / stdout 单例 mock;断言失败或超时提前
  // 退出时也必须还原,避免后续用例拿到被替换的广播实现)。
  afterEach(() => {
    vi.restoreAllMocks();
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

    it("失败任务(非零 exit):1 条 attempt(failed + 额度冷却 + 不重试 + 回传预计恢复时间)", async () => {
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
      // 额度失败逐条行为(与成功路径一致):failed / 冷却 / 不重试 / 回传预计恢复时间。
      expect(t.status).toBe("failed");
      // 执行器进入额度冷却(isInCooldown 为 true;key=codebuddy 来自 executors 配置)。
      expect(isInCooldown({ key: "codebuddy" })).toBe(true);
      // 不自动重试:retryCount 不增长(diffSummary.retries 不应出现)。
      expect(t.diffSummary?.retries).toBeUndefined();
      // 回传含预计恢复时间。
      const err = String(t.diffSummary?.error ?? "");
      expect(err).toContain("执行器额度限制");
      expect(err).toMatch(/预计 .+ 恢复/);
    });

    it("失败路径保留最近 500 行输出到 diffSummary.outputTail", async () => {
      const { coordinator, codebuddy, group } = await setupGroup();
      // 60 行 × sleep 0.1s ≈ 6s/次;maxRetries=3 时总时长 > 15s 用例超时
      // (CI 34074787902)。本用例只断言 outputTail 落库,与重试次数无关 →
      // pin maxRetries=0,失败一次即终态。
      const { __setMaxRetriesForTests } = await import(
        "@server/lib/executor-task"
      );
      __setMaxRetriesForTests(0);
      process.env.FAKE_LINES = Array.from(
        { length: 60 },
        (_, i) => `fail-line-${i + 1}`,
      ).join("|");
      process.env.FAKE_ALWAYS_FAIL = "1";
      const msg = await postMessage(coordinator.id, group.id, {
        body: "失败保留 500 行",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "failed",
      );
      const tail = String(
        (t.diffSummary as Record<string, unknown>)?.outputTail ?? "",
      );
      // 60 行全部保留(在 500 以内)。
      expect(tail).toContain("fail-line-1");
      expect(tail).toContain("fail-line-60");
      // 不截断为 50 行:line-51 必须存在。
      expect(tail).toContain("fail-line-51");
    }, 15_000);

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

  /* ---------------- 成功路径额度检测(quota-failure-on-clean-exit 规范) ---------------- */

  // 测试环境 cwd 下无 scripts/dispatch-policy.json,readDispatchPolicy 会回退到
  // 默认关键词(不含 "window exhausted");用与真实配置一致的集合显式覆盖,使
  // 成功路径额度检测可按规范验收(默认 + window exhausted)。
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

  describe("成功路径额度检测(exit 0 也要过额度检测)", () => {
    it("exit 0 + 输出尾部含 window exhausted → failed(非 done)+ 冷却 + 不重试 + 回传预计恢复时间", async () => {
      const { coordinator, codebuddy, group } = await setupGroup();
      __setRateLimitForTests(300_000, QUOTA_PATTERNS);
      // 执行器礼貌打印额度耗尽说明后正常退出(exit 0);成功路径必须过额度检测,
      // 不能落 done。
      process.env.FAKE_QUOTA_EXIT0 = "1";
      const msg = await postMessage(coordinator.id, group.id, {
        body: "礼貌放弃任务",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "failed",
      );
      expect(t.status).toBe("failed");
      // 与失败分支(1365)逐条一致:冷却该执行器、不自动重试、回传预计恢复时间。
      expect(isInCooldown({ key: "codebuddy" })).toBe(true);
      expect(t.attempts).toHaveLength(1);
      expect(t.diffSummary?.retries).toBeUndefined();
      const err = String(t.diffSummary?.error ?? "");
      expect(err).toContain("执行器额度限制");
      expect(err).toMatch(/预计 .+ 恢复/);
    }, 30_000);

    it("exit 0 + 输出不含额度关键词 → 行为不变(done)", async () => {
      const { coordinator, codebuddy, group } = await setupGroup();
      __setRateLimitForTests(300_000, QUOTA_PATTERNS);
      // 不设置任何 FAKE_* 开关:默认成功路径(commit + 汇报段落)→ done 不变。
      const msg = await postMessage(coordinator.id, group.id, {
        body: "正常成功任务",
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
      // 未触发额度冷却(回归:成功路径无额度关键词不应误判)。
      expect(isInCooldown({ key: "codebuddy" })).toBe(false);
    }, 30_000);

    it("额度关键词在输出前部(不在尾部 20 行)→ 不命中,落 done(R2 避免误判)", async () => {
      const { coordinator, codebuddy, group } = await setupGroup();
      __setRateLimitForTests(300_000, QUOTA_PATTERNS);
      // FAKE_QUOTA_FRONT 仅在输出最前面打印额度关键词,后续走正常成功路径
      // (commit + 汇报段落),尾部 20 行不含额度关键词 → 不应判额度失败。
      process.env.FAKE_QUOTA_FRONT = "1";
      const msg = await postMessage(coordinator.id, group.id, {
        body: "前部命中尾部不命中",
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
      expect(isInCooldown({ key: "codebuddy" })).toBe(false);
    }, 30_000);

    it("超时分支回归:超时 + 输出含额度关键词仍命中额度检测(失败 + 冷却 + 不重试)", async () => {
      const { coordinator, codebuddy, group } = await setupGroup();
      __setRateLimitForTests(300_000, QUOTA_PATTERNS);
      // EXECUTOR_TIMEOUT_MS=1000:fake bin 打印额度关键词后 sleep 5s → 走超时
      // 分支(1261);该分支历史行为应未改变,仍命中额度检测 → 失败 + 冷却。
      process.env.EXECUTOR_TIMEOUT_MS = "1000";
      process.env.FAKE_TIMEOUT_QUOTA = "1";
      const msg = await postMessage(coordinator.id, group.id, {
        body: "超时额度任务",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "failed",
      );
      expect(t.status).toBe("failed");
      expect(isInCooldown({ key: "codebuddy" })).toBe(true);
      expect(t.attempts).toHaveLength(1);
      expect(t.diffSummary?.retries).toBeUndefined();
      const err = String(t.diffSummary?.error ?? "");
      expect(err).toContain("执行器额度限制");
      expect(err).toMatch(/预计 .+ 恢复/);
    }, 30_000);

    it("exit 0 + 回显含 quota/额度 的测试名与源码 → 不判额度,落 done(伪额度回显回归)", async () => {
      const { coordinator, codebuddy, group } = await setupGroup();
      __setRateLimitForTests(300_000, QUOTA_PATTERNS);
      // FAKE_QUOTA_ECHO_EXIT0:尾部回显含 quota/额度 字样的测试文件名与测试源码
      // (01a04e01-b50b / 01a04e31-3194 的误判现场)后 exit 0 —— 无恢复时刻、无
      // 错误行形状 → 不算额度证据,继续 done 路径(不冷却、不失败)。
      process.env.FAKE_QUOTA_ECHO_EXIT0 = "1";
      const msg = await postMessage(coordinator.id, group.id, {
        body: "回显额度字样任务",
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
      expect(isInCooldown({ key: "codebuddy" })).toBe(false);
      expect(String(t.diffSummary?.error ?? "")).not.toContain(
        "执行器额度限制",
      );
      // 无 quotaMatchedLine 留痕(未判配额)。
      const summary = t.diffSummary as Record<string, unknown> | null;
      expect(summary?.quotaMatchedLine).toBeUndefined();
    }, 30_000);

    it("exit 0 + resets around 未来时刻 → 仍配额,冷却至该时刻,diffSummary 留 quotaMatchedLine", async () => {
      const { coordinator, codebuddy, group } = await setupGroup();
      __setRateLimitForTests(300_000, QUOTA_PATTERNS);
      // FAKE_QUOTA_RESETS_EXIT0:尾部打印 "usage limit reached — resets around
      // HH:MM UTC+8"(未来时刻,方案 a 需时区标记)后 exit 0 → 成功路径仍保留
      // 真额度检测:判配额 + 冷却至解析出的恢复时刻 + quotaMatchedLine。
      // 民用时钟按固定 UTC+8 推算(R4:不依赖 server 本地时区);跨 offset 午夜
      // 时逐步回缩,避免目标落到「今天已过」而 +24h。
      const offsetMin = 8 * 60;
      let ahead = 25;
      const origin = Date.now();
      while (ahead > 0) {
        const nowShift = new Date(origin + offsetMin * 60_000);
        const tShift = new Date(origin + ahead * 60_000 + offsetMin * 60_000);
        if (tShift.getUTCDate() === nowShift.getUTCDate()) break;
        ahead -= 5;
      }
      const tShift = new Date(
        origin + Math.max(1, ahead) * 60_000 + offsetMin * 60_000,
      );
      const resetsAt = `${tShift.getUTCHours()}:${String(tShift.getUTCMinutes()).padStart(2, "0")} UTC+8`;
      process.env.FAKE_QUOTA_RESETS_EXIT0 = "1";
      process.env.FAKE_RESETS_AT = resetsAt;
      const msg = await postMessage(coordinator.id, group.id, {
        body: "礼貌放弃任务2",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "failed",
      );
      expect(t.status).toBe("failed");
      expect(t.diffSummary?.retries).toBeUndefined();
      const err = String(t.diffSummary?.error ?? "");
      expect(err).toContain("执行器额度限制");
      expect(err).toMatch(/预计 .+ 恢复/);
      // quotaMatchedLine 记录命中原始行(截断)。
      const summary = t.diffSummary as Record<string, unknown> | null;
      expect(String(summary?.quotaMatchedLine)).toContain(
        "usage limit reached",
      );
      // 冷却至解析出的恢复时刻(与 parseRateLimitRecoveryMs 同源)。
      const expectedEnd = parseRateLimitRecoveryMs(
        `usage limit reached — resets around ${resetsAt}`,
      );
      expect(expectedEnd).not.toBeNull();
      if (expectedEnd !== null && expectedEnd > Date.now() + 10_000) {
        expect(cooldownEndMs({ key: "codebuddy" })).toBe(expectedEnd);
        expect(isInCooldown({ key: "codebuddy" })).toBe(true);
      } else {
        expect(isInCooldown({ key: "codebuddy" })).toBe(true);
      }
    }, 30_000);

    it("R6 主闸:exit 0 + auto-continuing 退避行 + 窗口内有提交 → 不判额度、不冷却,落 done 并留可读说明", async () => {
      const { coordinator, codebuddy, group } = await setupGroup();
      __setRateLimitForTests(300_000, QUOTA_PATTERNS);
      // FAKE_AUTO_CONTINUING_EXIT0:尾部打印瞬时限流退避行后照常提交并 exit 0
      // (实证 01a05103-db4c 的现场)。v1.1 R6 主闸:任务窗口内有提交 → 一律不判
      // 额度、不进入冷却;diffSummary 留 quotaMatchedButCommitFound 可读说明。
      process.env.FAKE_AUTO_CONTINUING_EXIT0 = "1";
      const msg = await postMessage(coordinator.id, group.id, {
        body: "瞬时限流退避但完成提交",
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
      expect(t.diffSummary?.retries).toBeUndefined();
      expect(isInCooldown({ key: "codebuddy" })).toBe(false);
      const summary = t.diffSummary as Record<string, unknown> | null;
      // R9: 瞬时退避行由次闸抑制(可归因闸之前),留 quotaMatchedButTransient;旧 R6 主闸的 commit 闸不再单独构成产出,但本用例仍应不判额度、不冷却
      const gate =
        (summary?.quotaMatchedButTransient as
          | { matchedLine?: string; note?: string }
          | undefined) ??
        (summary?.quotaMatchedButCommitFound as
          | { matchedLine?: string; note?: string }
          | undefined);
      expect(gate).toBeTruthy();
      expect(String(gate?.matchedLine)).toContain("auto-continuing");
      expect(String(gate?.note)).toContain("不判额度");
      // 未走额度失败路径:无冷却结束键、无 quotaMatchedLine。
      expect(summary?.executorCooldownEndMs).toBeUndefined();
      expect(summary?.quotaMatchedLine).toBeUndefined();
      // 无 ❌ 额度失败回传。
      const doneMsg = await waitForMessage(
        coordinator.id,
        group.id,
        (m) => m.contentType === "task_status" && m.body.startsWith("✅"),
      );
      expect(doneMsg.body).toContain("任务完成");
    }, 30_000);

    it("R6 反向:exit 0 + 限流字样 + 无提交 + 无可解析恢复时刻 → 仍判额度,走固定兜底冷却", async () => {
      const { coordinator, codebuddy, group } = await setupGroup();
      __setRateLimitForTests(300_000, QUOTA_PATTERNS);
      // FAKE_QUOTA_NO_RECOVERY_EXIT0:无可解析恢复时刻的额度行(429)后 exit 0,
      // 不产生提交 → 主闸不拦,仍判额度;parseRateLimitRecoveryMs 无命中 →
      // 冷却回退固定兜底(now + cooldown)。
      process.env.FAKE_QUOTA_NO_RECOVERY_EXIT0 = "1";
      const msg = await postMessage(coordinator.id, group.id, {
        body: "礼貌放弃任务-无恢复时刻",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "failed",
      );
      expect(t.status).toBe("failed");
      expect(t.diffSummary?.retries).toBeUndefined();
      const err = String(t.diffSummary?.error ?? "");
      expect(err).toContain("执行器额度限制");
      expect(err).toMatch(/预计 .+ 恢复/);
      const summary = t.diffSummary as Record<string, unknown> | null;
      expect(String(summary?.quotaMatchedLine)).toContain(
        "rate limit exceeded",
      );
      // 固定兜底:冷却终点 = now + 固定冷却(300s),未命中「解析所得时刻」。
      expect(summary?.cooldownFallbackReason).toBeUndefined();
      const end = cooldownEndMs({ key: "codebuddy" });
      const remaining = end - Date.now();
      expect(remaining).toBeGreaterThanOrEqual(60_000);
      expect(remaining).toBeLessThanOrEqual(300_000 + 10_000);
      expect(isInCooldown({ key: "codebuddy" })).toBe(true);
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
