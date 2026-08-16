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
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "./db";

/**
 * 调度改造批次收尾(票7):任务书模板化 + 汇报结构化 + 额度感知调度。
 *
 * 任务书:buildTicket 输出固定模板(执行器/项目/发布时间 + 任务内容 + 汇报格式
 * 要求);fake bin 通过 FAKE_TICKET_COPY 把任务书全文拷出供断言。
 *
 * 汇报结构化:executor stdout 按「提交/测试/汇报/遗留」四段解析 → diffSummary
 * {summary, hash, tests, todo};缺段省略;老格式自由文本保持旧行为。
 *
 * 额度感知:失败原因命中 rate limit 关键词 → 归类「额度失败」(failed + 原因含
 * 「额度」+ 不重试 + ❌ 注明预计恢复时间),该执行器进入冷却;冷却期内新任务
 * 保持 queued 不 spawn(⏳ 回传 + diffSummary 标记等待),冷却结束自动派发。
 *
 * fake bin 与 executor-queue.test.ts 同款集成方式:EXECUTOR_BIN_CODEBUDDY 指向
 * 可配置临时脚本,COAGENTHUB_REPO_ROOT 指向临时 git 仓库(快照/弱验收需要)。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-report-bin-"));
const fakeBin = path.join(fakeDir, "fake-codebuddy.sh");
writeFileSync(
  fakeBin,
  [
    "#!/bin/sh",
    // 捕获任务书全文供断言($3 = {ticket} 路径)。
    'if [ -n "$FAKE_TICKET_COPY" ]; then cp "$3" "$FAKE_TICKET_COPY"; fi',
    // 尝试计数(额度失败不重试 / 冷却后自动派发测试用):先读后写。
    'if [ -n "$FAKE_COUNTER_FILE" ]; then',
    "  n=0",
    '  if [ -f "$FAKE_COUNTER_FILE" ]; then n=$(cat "$FAKE_COUNTER_FILE"); fi',
    "  n=$((n + 1))",
    '  echo "$n" > "$FAKE_COUNTER_FILE"',
    "fi",
    // 额度失败模式:输出 rate limit 文案后 exit 1(无工作区改动,不走验收)。
    'if [ -n "$FAKE_RATE_LIMIT" ]; then',
    '  echo "error: rate limit exceeded (429 too many requests)"',
    "  exit 1",
    "fi",
    // 弱验收要求工作树干净 + HEAD 有新提交:真正提交一次(显式身份,CI 无全局
    // git config 也能跑)。
    'git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake bin change"',
    // 结构化四段汇报模式。
    'if [ -n "$FAKE_STRUCTURED" ]; then',
    '  echo "提交: 0123456789abcdef0123456789abcdef01234567"',
    '  echo "测试: 全部通过 (42 tests)"',
    '  echo "汇报: 完成了模板化与结构化改造"',
    '  echo "遗留: 无"',
    "  exit 0",
    "fi",
    // 默认:老格式自由文本(commit 裸行 + 汇报行)。
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:修改完成"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeBin, 0o755);
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;

// 执行前快照/弱验收需要真实 git 仓库;COAGENTHUB_REPO_ROOT 覆盖 findRepoRoot。
const repoDir = mkdtempSync(path.join(tmpdir(), "coagenthub-report-repo-"));
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
const {
  __resetExecutorQueueForTests,
  parseTaskReport,
  renderTaskCard,
  resolveTestExecutor,
} = await import("@server/lib/executor-task");

// PGlite 与 node-postgres 的 drizzle 实例驱动类型不兼容(与 executor-trigger /
// executor-queue 同款 cast);resolveTestExecutor 只走共享的 query API。
const teDb = testDb as unknown as Parameters<typeof resolveTestExecutor>[0];

describe("任务书模板 + 汇报结构化 + 额度感知调度(票7)", () => {
  const app = createTestApp();

  beforeEach(() => {
    // 清理内存队列/冷却(模块级状态跨用例共享)。
    __resetExecutorQueueForTests();
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
      if (existing) return { id: existing.id, name: existing.name };
    }
    expect(res.status).toBe(200);
    const { id, name } = (await res.json()) as { id: string; name: string };
    return { id, name };
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
      await new Promise((r) => setTimeout(r, 50));
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
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** 群主的 coordinator + CodeBuddy 执行器成员就绪。 */
  async function setupGroup() {
    const coordinator = await registerParticipant({ name: "coord-report" });
    const codebuddy = await registerParticipant({ name: "CodeBuddy 执行器" });
    const group = await createGroup(coordinator.id, "汇报与额度测试");
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  afterAll(() => {
    rmSync(fakeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe("任务书模板(票7)", () => {
    it("固定模板含执行器/项目/任务内容/汇报格式要求段", async () => {
      const capture = path.join(fakeDir, "ticket.md");
      process.env.FAKE_TICKET_COPY = capture;
      try {
        const { coordinator, codebuddy, group } = await setupGroup();
        const msg = await postMessage(coordinator.id, group.id, {
          body: "建一个文件 hello.txt",
          audience: "participant",
          audienceRef: codebuddy.id,
        });
        await waitForTaskStatus(coordinator.id, group.id, msg.id, "done");
        const ticket = readFileSync(capture, "utf8");
        expect(ticket).toContain("# CoAgentHub 任务");
        expect(ticket).toContain("执行器: codebuddy");
        expect(ticket).toContain(`项目: ${repoDir}`);
        expect(ticket).toMatch(/发布时间: \d{4}-\d{2}-\d{2}T/);
        expect(ticket).toContain("## 任务内容");
        expect(ticket).toContain("建一个文件 hello.txt");
        expect(ticket).toContain("## 汇报格式要求(stdout 请按此输出)");
        expect(ticket).toContain("提交: <commit hash>");
        expect(ticket).toContain("测试: <测试结果摘要>");
        expect(ticket).toContain("汇报: <做了什么,3-5 句>");
        expect(ticket).toContain('遗留: <未完成事项,无则写"无">');
      } finally {
        delete process.env.FAKE_TICKET_COPY;
      }
    }, 30_000);
  });

  describe("汇报段落解析 + 卡片渲染(票7)", () => {
    it("stdout 含四段 → diffSummary={summary,hash,tests,todo} + 卡片回传", async () => {
      process.env.FAKE_STRUCTURED = "1";
      try {
        const { coordinator, codebuddy, group } = await setupGroup();
        const msg = await postMessage(coordinator.id, group.id, {
          body: "结构化任务",
          audience: "participant",
          audienceRef: codebuddy.id,
        });
        const t = await waitForTaskStatus(
          coordinator.id,
          group.id,
          msg.id,
          "done",
        );
        // 完成回填(实时进度 feature):diffSummary 还会带最近输出 outputTail,
        // 断言核心四段用 toMatchObject,回填字段单独验证。
        expect(t.diffSummary).toMatchObject({
          summary: "完成了模板化与结构化改造",
          hash: "0123456789ab",
          tests: "全部通过 (42 tests)",
          todo: "无",
        });
        expect(
          typeof (t.diffSummary as Record<string, unknown> | null)?.outputTail,
        ).toBe("string");
        // 成功回传为卡片:✅ 标题 + 分隔线 + 四行。
        const done = await waitForMessage(
          coordinator.id,
          group.id,
          (m) => m.contentType === "task_status" && m.body.startsWith("✅"),
        );
        expect(done.body).toBe(
          [
            "✅ 任务完成 codebuddy",
            "────────────────",
            "提交  0123456789ab",
            "测试  全部通过 (42 tests)",
            "汇报  完成了模板化与结构化改造",
            "遗留  无",
          ].join("\n"),
        );
      } finally {
        delete process.env.FAKE_STRUCTURED;
      }
    }, 30_000);

    it("老格式自由文本(无段落)→ 旧行为:关键词摘要 + hash,无 tests/todo", async () => {
      // 默认 fake bin 输出「commit <hex>」裸行 + 「汇报:修改完成」,无段落头。
      const { coordinator, codebuddy, group } = await setupGroup();
      const msg = await postMessage(coordinator.id, group.id, {
        body: "自由文本任务",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const t = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "done",
      );
      const diff = t.diffSummary as Record<string, unknown> | null;
      expect(diff?.hash).toBe("0123456789ab");
      expect(String(diff?.summary)).toContain("修改完成");
      expect(diff?.tests).toBeUndefined();
      expect(diff?.todo).toBeUndefined();
    }, 30_000);

    it("parseTaskReport:大小写变体/缺段省略/提交段无 hex", () => {
      // 英文大小写变体。
      expect(
        parseTaskReport(
          "COMMIT: 0123456789abcdef0123456789abcdef01234567\nTEST: pass\nReport: done\nTODO: none",
        ),
      ).toEqual({
        hash: "0123456789ab",
        tests: "pass",
        summary: "done",
        todo: "none",
      });
      // 缺段省略:只有提交段 + 测试段。
      expect(
        parseTaskReport(
          "提交: 0123456789abcdef0123456789abcdef01234567\n测试: ok",
        ),
      ).toEqual({ hash: "0123456789ab", tests: "ok" });
      // 提交段值不是 hex → hash 省略(不误报)。
      expect(parseTaskReport("提交: 已完成\n汇报: 好了")).toEqual({
        summary: "好了",
      });
    });

    it("renderTaskCard:缺段占位(hash→无,其余→-)与超长截断", () => {
      expect(renderTaskCard("codebuddy", {})).toBe(
        [
          "✅ 任务完成 codebuddy",
          "────────────────",
          "提交  无",
          "测试  -",
          "汇报  -",
          "遗留  -",
        ].join("\n"),
      );
      const long = renderTaskCard("codebuddy", {
        summary: "x".repeat(9000),
      });
      expect(long.length).toBe(8000);
    });
  });

  describe("额度感知调度(票7)", () => {
    it("rate limit 退出 → failed + 原因含「额度」+ 不重试 + ❌ 注明恢复时间", async () => {
      const counterDir = mkdtempSync(
        path.join(tmpdir(), "coagenthub-quota-cnt-"),
      );
      const counterFile = path.join(counterDir, "n.txt");
      process.env.FAKE_RATE_LIMIT = "1";
      process.env.FAKE_COUNTER_FILE = counterFile;
      try {
        const { __setRateLimitForTests } = await import(
          "@server/lib/executor-task"
        );
        __setRateLimitForTests(60_000, ["rate limit", "429"]);
        const { coordinator, codebuddy, group } = await setupGroup();
        const msg = await postMessage(coordinator.id, group.id, {
          body: "额度受限任务",
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
        expect(String(diff?.error)).toContain("额度");
        expect(t.retryCount).toBe(0);
        // 额度失败不自动重试:只 spawn 一次(计数文件 = 1),群里无 ↻ 提示。
        expect(readFileSync(counterFile, "utf8").trim()).toBe("1");
        const messages = await listMessages(coordinator.id, group.id);
        expect(messages.some((m) => m.body.startsWith("↻"))).toBe(false);
        // ❌ 注明「执行器额度限制,预计 <时间> 恢复」。
        await waitForMessage(
          coordinator.id,
          group.id,
          (m) =>
            m.body.includes("执行器额度限制") &&
            m.body.includes("预计") &&
            m.body.includes("恢复"),
        );
      } finally {
        delete process.env.FAKE_RATE_LIMIT;
        delete process.env.FAKE_COUNTER_FILE;
        rmSync(counterDir, { recursive: true, force: true });
      }
    }, 30_000);

    it("冷却中:新任务保持 queued 不 spawn(⏳ 回传);冷却结束自动派发", async () => {
      const counterDir = mkdtempSync(
        path.join(tmpdir(), "coagenthub-cool-cnt-"),
      );
      const counterFile = path.join(counterDir, "n.txt");
      const { __setRateLimitForTests } = await import(
        "@server/lib/executor-task"
      );
      // 短冷却(800ms):足够断言「冷却中不 spawn」,又能在测试时限内验证自动恢复
      // (票面建议 100ms 级;此处放宽以提高轮询稳定性)。
      __setRateLimitForTests(800, ["rate limit", "429"]);
      try {
        const { coordinator, codebuddy, group } = await setupGroup();

        // 任务1:rate limit 失败 → 执行器进入冷却。
        process.env.FAKE_RATE_LIMIT = "1";
        process.env.FAKE_COUNTER_FILE = counterFile;
        const m1 = await postMessage(coordinator.id, group.id, {
          body: "触发额度冷却",
          audience: "participant",
          audienceRef: codebuddy.id,
        });
        await waitForTaskStatus(coordinator.id, group.id, m1.id, "failed");
        expect(readFileSync(counterFile, "utf8").trim()).toBe("1");

        // 任务2:冷却期内入队 → 保持 queued,不 spawn(计数仍为 1)。
        delete process.env.FAKE_RATE_LIMIT;
        const m2 = await postMessage(coordinator.id, group.id, {
          body: "冷却中排队任务",
          audience: "participant",
          audienceRef: codebuddy.id,
        });
        const t2 = await waitForTaskStatus(
          coordinator.id,
          group.id,
          m2.id,
          "queued",
        );
        expect(readFileSync(counterFile, "utf8").trim()).toBe("1"); // 未 spawn
        // diffSummary.waiting 与 ⏳ 回传在同一 cooldown 分支写入,标记先落库、
        // 消息后发出:先等 ⏳ 消息到达,再读任务即可保证 waiting 标记已写入。
        await waitForMessage(
          coordinator.id,
          group.id,
          (m) =>
            m.body.startsWith("⏳") && m.body.includes("等待执行器额度恢复"),
        );
        const t2After = (await listTasks(coordinator.id, group.id)).find(
          (x) => x.messageId === m2.id,
        );
        const waiting = (t2After?.diffSummary as Record<string, unknown> | null)
          ?.waiting;
        expect(String(waiting)).toContain("等待执行器额度恢复");

        // 冷却结束(800ms)→ 泵送自动派发 → spawn(计数 2)→ done。
        const done = await waitForTaskStatus(
          coordinator.id,
          group.id,
          m2.id,
          "done",
          10_000,
        );
        expect(done.status).toBe("done");
        expect(readFileSync(counterFile, "utf8").trim()).toBe("2");
      } finally {
        delete process.env.FAKE_RATE_LIMIT;
        delete process.env.FAKE_COUNTER_FILE;
        rmSync(counterDir, { recursive: true, force: true });
      }
    }, 30_000);
  });

  describe("测试执行器选择 + 任务书「执行与测试要求」段(分工固化)", () => {
    async function setMemberPrompt(
      participantId: string,
      groupId: string,
      memberParticipantId: string,
      prompt: string,
    ) {
      const res = await app.request(
        `/api/groups/${groupId}/members/${memberParticipantId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": participantId,
          },
          body: JSON.stringify({ prompt }),
        },
      );
      expect(res.status).toBe(200);
    }

    it("resolveTestExecutor:匹配分工提示词 → 返回该执行器;目标执行器本身不入选", async () => {
      const coordinator = await registerParticipant({ name: "coord-te-1" });
      const implementer = await registerParticipant({ name: "Impl 执行器" });
      const tester = await registerParticipant({ name: "Tester 执行器" });
      const group = await createGroup(coordinator.id, "选择测试1");
      await addMember(coordinator.id, group.id, implementer.id, ["executor"]);
      await addMember(coordinator.id, group.id, tester.id, ["executor"]);
      // 实现执行器自身也有测试关键词,但作为目标被排除;Tester 入选。
      await setMemberPrompt(
        coordinator.id,
        group.id,
        implementer.id,
        "负责实现与测试",
      );
      await setMemberPrompt(
        coordinator.id,
        group.id,
        tester.id,
        "负责测试与验证改动",
      );
      expect(await resolveTestExecutor(teDb, group.id, implementer.name)).toBe(
        tester.name,
      );
    });

    it("resolveTestExecutor:多个匹配 → 取测试关键词出现次数最多的;并列稳定选一", async () => {
      const coordinator = await registerParticipant({ name: "coord-te-2" });
      const implementer = await registerParticipant({ name: "Impl 执行器2" });
      const testerA = await registerParticipant({ name: "ATester 执行器" });
      const testerB = await registerParticipant({ name: "BTester 执行器" });
      const group = await createGroup(coordinator.id, "选择测试2");
      await addMember(coordinator.id, group.id, implementer.id, ["executor"]);
      await addMember(coordinator.id, group.id, testerA.id, ["executor"]);
      await addMember(coordinator.id, group.id, testerB.id, ["executor"]);
      // A:1 次关键词; B:3 次 → 取 B。
      await setMemberPrompt(coordinator.id, group.id, testerA.id, "负责测试");
      await setMemberPrompt(
        coordinator.id,
        group.id,
        testerB.id,
        "负责测试与验证与检验",
      );
      expect(await resolveTestExecutor(teDb, group.id, implementer.name)).toBe(
        testerB.name,
      );

      // 并列(各 1 次)→ 稳定选一(名字字典序,ATester 在前)。
      await setMemberPrompt(coordinator.id, group.id, testerB.id, "负责测试");
      expect(await resolveTestExecutor(teDb, group.id, implementer.name)).toBe(
        testerA.name,
      );
    });

    it("resolveTestExecutor:大小写不敏感(Test/Verify 大写也匹配)", async () => {
      const coordinator = await registerParticipant({ name: "coord-te-3" });
      const implementer = await registerParticipant({ name: "Impl 执行器3" });
      const tester = await registerParticipant({ name: "Tester 执行器3" });
      const group = await createGroup(coordinator.id, "选择测试3");
      await addMember(coordinator.id, group.id, implementer.id, ["executor"]);
      await addMember(coordinator.id, group.id, tester.id, ["executor"]);
      await setMemberPrompt(
        coordinator.id,
        group.id,
        tester.id,
        "responsible for TEST and Verify",
      );
      expect(await resolveTestExecutor(teDb, group.id, implementer.name)).toBe(
        tester.name,
      );
    });

    it("resolveTestExecutor:无匹配(无提示词/角色不符)→ null", async () => {
      const coordinator = await registerParticipant({ name: "coord-te-4" });
      const implementer = await registerParticipant({ name: "Impl 执行器4" });
      const plain = await registerParticipant({ name: "普通执行器" });
      const group = await createGroup(coordinator.id, "选择测试4");
      await addMember(coordinator.id, group.id, implementer.id, ["executor"]);
      await addMember(coordinator.id, group.id, plain.id, ["executor"]);
      // 有 executor 角色但提示词不含测试职责 → 无匹配。
      await setMemberPrompt(
        coordinator.id,
        group.id,
        plain.id,
        "负责前端开发与接口联调",
      );
      expect(
        await resolveTestExecutor(teDb, group.id, implementer.name),
      ).toBeNull();
      // 提示词含测试职责但角色不含 executor/specialist → 无匹配。
      const reviewer = await registerParticipant({ name: "评审员" });
      await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
      await setMemberPrompt(
        coordinator.id,
        group.id,
        reviewer.id,
        "负责测试与评审",
      );
      expect(
        await resolveTestExecutor(teDb, group.id, implementer.name),
      ).toBeNull();
    });

    it("buildTicket:无匹配成员 → 任务书默认由实现执行器完成测试", async () => {
      const capture = path.join(fakeDir, "ticket-default-te.md");
      process.env.FAKE_TICKET_COPY = capture;
      try {
        const { coordinator, codebuddy, group } = await setupGroup();
        const msg = await postMessage(coordinator.id, group.id, {
          body: "建文件默认测试",
          audience: "participant",
          audienceRef: codebuddy.id,
        });
        await waitForTaskStatus(coordinator.id, group.id, msg.id, "done");
        const ticket = readFileSync(capture, "utf8");
        expect(ticket).toContain("## 执行与测试要求");
        expect(ticket).toContain("- 实现执行器:codebuddy(必选,由发布者定向)");
        expect(ticket).toContain("- 测试执行器:默认由实现执行器完成测试");
        expect(ticket).toContain(
          "- 完成后必须运行测试并验证改动(新增/相关用例),汇报需包含测试结果。",
        );
      } finally {
        delete process.env.FAKE_TICKET_COPY;
      }
    }, 30_000);

    it("buildTicket:群内有匹配成员 → 测试执行器 = 解析结果", async () => {
      const capture = path.join(fakeDir, "ticket-matched-te.md");
      process.env.FAKE_TICKET_COPY = capture;
      try {
        const { coordinator, codebuddy, group } = await setupGroup();
        const tester = await registerParticipant({ name: "Tester 执行器5" });
        await addMember(coordinator.id, group.id, tester.id, ["executor"]);
        await setMemberPrompt(
          coordinator.id,
          group.id,
          tester.id,
          "负责测试与验证改动",
        );
        const msg = await postMessage(coordinator.id, group.id, {
          body: "建文件匹配测试",
          audience: "participant",
          audienceRef: codebuddy.id,
        });
        await waitForTaskStatus(coordinator.id, group.id, msg.id, "done");
        const ticket = readFileSync(capture, "utf8");
        expect(ticket).toContain("- 测试执行器:Tester 执行器5");
      } finally {
        delete process.env.FAKE_TICKET_COPY;
      }
    }, 30_000);

    it("buildTicket:body 显式「**测试执行器:**」行原样保留", async () => {
      const capture = path.join(fakeDir, "ticket-explicit-te.md");
      process.env.FAKE_TICKET_COPY = capture;
      try {
        const { coordinator, codebuddy, group } = await setupGroup();
        const msg = await postMessage(coordinator.id, group.id, {
          body: "建文件显式测试\n\n**测试执行器:手工指定执行器**",
          audience: "participant",
          audienceRef: codebuddy.id,
        });
        await waitForTaskStatus(coordinator.id, group.id, msg.id, "done");
        const ticket = readFileSync(capture, "utf8");
        // 显式行原样保留在任务内容中(执行器读任务书即可)。
        expect(ticket).toContain("**测试执行器:手工指定执行器**");
        // 无匹配成员时,自动段仍写默认(显式行不覆盖自动规则,二者并存)。
        expect(ticket).toContain("- 测试执行器:默认由实现执行器完成测试");
      } finally {
        delete process.env.FAKE_TICKET_COPY;
      }
    }, 30_000);
  });
});
