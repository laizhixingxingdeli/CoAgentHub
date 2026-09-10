import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executorConfig as executorConfigTable } from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedBuiltinExecutorConfigs, testDb } from "./db";
import { resolveFakeExecutor, withFakeExecutorArgs } from "./fake-executor-bin";

/**
 * 明细存储 + 展开 API(spec two-tier-output-summary-and-detail R4/R5):
 *  - R4:执行器输出经解析器产出结构化条目后,完整原文按任务落盘
 *    /tmp/coagenthub-task-detail-<taskId>.jsonl;任务进入终态后明细文件仍可读。
 *  - R5:GET /groups/:gid/tasks/:tid/output?detail=1(整份)与
 *    /output/:entryId(单条)按 #id 展开;权限与任务详情路由一致(includeOutput
 *    同口径,不放宽);单条找不到返回 404 并说明原因(明细文件不存在 / id 不存在)。
 *  - R2/R3:thinking 摘要为首句要旨;错误信息永不折叠,全文留在摘要流。
 *  - spec live-output-hide-thinking-and-autoscroll R1/R2:摘要流不再出现
 *    thinking 行(只按解析出的 kind 过滤),但明细照常落盘 —— 运行中采样与
 *    ?detail=1 必须仍能取回 thinking 全文。
 *
 * fake codebuddy bin 与 executor-progress.test.ts 同款集成方式:
 * EXECUTOR_BIN_CODEBUDDY 指向可配置临时脚本,COAGENTHUB_REPO_ROOT 指向临时 git
 * 仓库(执行前快照/弱验收需要)。JSONL 夹具写入独立文件,bin 逐行 cat,规避
 * shell 引号转义。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-detail-bin-"));
const fakeScript = path.join(fakeDir, "fake-codebuddy.sh");
/** thinking 正文长度:模拟真实任务思考占缓冲 84-95% 的形态,验证 10x 压缩。 */
const THINKING_BODY = "x".repeat(2_000);
const jsonlFixture = path.join(fakeDir, "fixture.jsonl");
writeFileSync(
  jsonlFixture,
  [
    JSON.stringify({
      type: "assistant",
      uuid: "u1",
      session_id: "s1",
      message: {
        content: [
          {
            type: "thinking",
            thinking: `Let me check the guard file location. It must be in src/routes. ${THINKING_BODY}`,
            signature: "",
          },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "u2",
      session_id: "s2",
      message: {
        content: [
          {
            type: "thinking",
            thinking: `Now read the guard file to confirm the check. ${THINKING_BODY}`,
            signature: "",
          },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "u3",
      session_id: "s3",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "read_file",
            input: { file_path: "src/routes/guard.ts" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      uuid: "u4",
      session_id: "s4",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: [
              {
                type: "text",
                text: "ENOENT: no such file or directory, open guard.ts",
              },
            ],
            is_error: true,
          },
        ],
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "报告: 完成,详见明细",
    }),
  ].join("\n") + "\n",
);
writeFileSync(
  fakeScript,
  [
    "#!/bin/sh",
    // 明细 JSONL 模式:逐行输出 + 行间停顿,保证「运行中」状态可采样。
    'if [ -n "$FAKE_JSONL" ]; then',
    `  sed -n '1p' "${jsonlFixture}"`,
    "  sleep 0.8",
    `  sed -n '2p' "${jsonlFixture}"`,
    "  sleep 0.8",
    `  sed -n '3p' "${jsonlFixture}"`,
    "  sleep 0.8",
    `  sed -n '4p' "${jsonlFixture}"`,
    "  sleep 0.8",
    `  sed -n '5p' "${jsonlFixture}"`,
    "fi",
    // 纯文本模式:无 JSONL → 无明细文件(R5 明细文件不存在的 404 用例)。
    'if [ -n "$FAKE_PLAIN" ]; then',
    '  echo "plain narration line 1"',
    '  echo "plain narration line 2"',
    "fi",
    // 弱验收要求工作树干净 + HEAD 有新提交:默认真正提交一次。
    'git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake bin detail change"',
    'echo "提交: 0123456789abcdef0123456789abcdef01234567"',
    'echo "测试: 全部通过 (42 tests)"',
    'echo "汇报: 明细存储与展开 API"',
    'echo "遗留: 无"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeScript, 0o755);
const { bin: fakeBin, argsPrefix: fakeArgsPrefix } =
  resolveFakeExecutor(fakeScript);
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;

// 执行前快照/弱验收需要真实 git 仓库;COAGENTHUB_REPO_ROOT 覆盖 findRepoRoot。
const repoDir = mkdtempSync(path.join(tmpdir(), "coagenthub-detail-repo-"));
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
  appendTaskDetail,
  readTaskDetail,
  taskDetailFilePath,
} = await import("@server/lib/executor-task");

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

describe("任务明细落盘与展开 API(R4/R5)", () => {
  const app = createTestApp();

  beforeEach(() => {
    __resetExecutorQueueForTests();
    for (const key of ["FAKE_JSONL", "FAKE_PLAIN"]) delete process.env[key];
  });

  afterEach(() => {
    __resetExecutorQueueForTests();
    for (const key of ["FAKE_JSONL", "FAKE_PLAIN"]) delete process.env[key];
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
      diffSummary: Record<string, unknown> | null;
      outputTail?: string;
    }>;
  }

  async function waitForTaskStatus(
    participantId: string,
    groupId: string,
    messageId: string,
    status: string,
    timeoutMs = 20_000,
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

  /** 轮询任务详情,直到 outputTail 包含预期子串(运行中采样用)。 */
  async function waitForOutputTail(
    participantId: string,
    groupId: string,
    taskId: string,
    substring: string,
    timeoutMs = 10_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await app.request(
        `/api/groups/${groupId}/tasks/${taskId}?includeOutput=1`,
        { headers: { "X-Participant-Id": participantId } },
      );
      const tail = ((await res.json()) as { outputTail?: string }).outputTail;
      if (tail && tail.includes(substring)) return tail;
      if (Date.now() > deadline) {
        throw new Error(
          `outputTail 未在 ${timeoutMs}ms 内出现「${substring}」`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * 摘要流中以前缀开头的行(R1 采样用:thinking 行的行首标签是 `[思考`)。
   * 判据用行首标签而非整行包含,避免正文里出现同名词被误判。
   */
  function tailLinesStartingWith(tail: string, prefix: string): string[] {
    return tail
      .split("\n")
      .filter((line) => line.trimStart().startsWith(prefix));
  }

  async function setupGroup() {
    const coordinator = await registerParticipant({ name: "coord-detail" });
    const codebuddy = await registerParticipant({ name: "CodeBuddy" });
    const group = await createGroup(coordinator.id, "明细测试");
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  it("R2/R3/R4:thinking 折叠为要旨、错误不折叠、明细落盘、运行中与终态后都可展开", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    process.env.FAKE_JSONL = "1";
    const msg = await postMessage(coordinator.id, group.id, {
      body: "明细 JSONL 输出",
      audience: "participant",
      audienceRef: codebuddy.id,
    });

    // 运行中:摘要流含工具/错误等动作行(错误未折叠),且不含 thinking 行。
    const running = await waitForTaskStatus(
      coordinator.id,
      group.id,
      msg.id,
      "running",
    );
    // live-only: running live tail only contains report, wait for report arrival then check full via diff later
    const runningTail = await waitForOutputTail(
      coordinator.id,
      group.id,
      running.id,
      "报告: 完成",
    );
    // R1: thinking filtered from both live and summary
    expect(tailLinesStartingWith(runningTail, "[思考")).toEqual([]);
    // live-only: tool/error not in live tail, only report
    expect(runningTail).not.toContain("[工具 #t3] read_file");
    expect(runningTail).toContain("报告: 完成");
    console.log(`[detail] 运行中live采样:\n${runningTail}`);
    // 运行中即可按 #id 展开明细(明细随输出逐条落盘)。
    const runningExpand = await app.request(
      `/api/groups/${group.id}/tasks/${running.id}/output/t1`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    expect(runningExpand.status).toBe(200);
    expect(((await runningExpand.json()) as { text: string }).text).toContain(
      THINKING_BODY,
    );

    // 终态:内存缓冲释放,但明细文件保留,展开仍可用(R4 必测)。
    const done = await waitForTaskStatus(
      coordinator.id,
      group.id,
      msg.id,
      "done",
    );
    // 终态 full outputTail (persisted) still contains tool/error, thinking filtered
    expect(
      tailLinesStartingWith(
        String(done.diffSummary?.outputTail ?? ""),
        "[思考",
      ),
    ).toEqual([]);
    expect(done.diffSummary?.outputTail).toContain("[工具 #t3] read_file");
    expect(String(done.diffSummary?.outputTail ?? "")).toContain(
      "ENOENT: no such file or directory, open guard.ts",
    );
    // live tail via includeOutput should be report only
    const doneLiveRes = await app.request(
      `/api/groups/${group.id}/tasks/${done.id}?includeOutput=1`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    const doneLive =
      ((await doneLiveRes.json()) as { outputTail?: string }).outputTail ?? "";
    expect(doneLive).toContain("报告: 完成");
    expect(doneLive).not.toContain("[工具 #t3]");
    // 摘要流字节数对比:thinking 原文 2×2000 字进明细,摘要只留一行要旨
    // (改造前同形态任务摘要≈全文,现下降超一个数量级)。
    const summaryBytes = (
      (done.diffSummary as { outputTail?: string } | null)?.outputTail ?? ""
    ).length;
    const inputBytes =
      readTaskDetail(done.id)?.reduce((sum, row) => sum + row.text.length, 0) ??
      0;
    expect(inputBytes).toBeGreaterThan(3_000); // 明细承载了 thinking 全文
    expect(summaryBytes).toBeLessThan(inputBytes / 10);
    console.log(
      `[detail] full-chain codebuddy task: summaryStream=${summaryBytes}B detailStore=${inputBytes}B (${((summaryBytes / inputBytes) * 100).toFixed(2)}% of detail)`,
    );

    // 终态后单条展开:完整原文(脱离内存缓冲)。
    const entryRes = await app.request(
      `/api/groups/${group.id}/tasks/${done.id}/output/t1`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    expect(entryRes.status).toBe(200);
    const entry = (await entryRes.json()) as {
      id: string;
      kind: string;
      text: string;
    };
    expect(entry.id).toBe("t1");
    expect(entry.kind).toBe("thinking");
    expect(entry.text).toContain("Let me check the guard file location.");
    expect(entry.text).toContain(THINKING_BODY);

    // R5:整份明细。
    const allRes = await app.request(
      `/api/groups/${group.id}/tasks/${done.id}/output?detail=1`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    expect(allRes.status).toBe(200);
    const all = (await allRes.json()) as { taskId: string; entries: unknown[] };
    expect(all.taskId).toBe(done.id);
    expect(all.entries.map((e) => (e as { id: string }).id)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
    ]);
  });

  it("R5:单条 404 说明原因(id 不存在 / 明细文件不存在);detail=1 必须显式携带;授权口径与详情路由一致", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    // JSONL 任务:明细文件存在,但 t999 从未产出 → 「条目不存在」。
    process.env.FAKE_JSONL = "1";
    const msg = await postMessage(coordinator.id, group.id, {
      body: "明细 JSONL 输出",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const done = await waitForTaskStatus(
      coordinator.id,
      group.id,
      msg.id,
      "done",
    );
    const missingId = await app.request(
      `/api/groups/${group.id}/tasks/${done.id}/output/t999`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    expect(missingId.status).toBe(404);
    expect(((await missingId.json()) as { message: string }).message).toContain(
      "条目 t999 不存在",
    );

    // 纯文本任务:无明细文件 → 「明细文件不存在/已被清理」。
    process.env.FAKE_JSONL = "";
    process.env.FAKE_PLAIN = "1";
    const msg2 = await postMessage(coordinator.id, group.id, {
      body: "纯文本输出",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const done2 = await waitForTaskStatus(
      coordinator.id,
      group.id,
      msg2.id,
      "done",
    );
    const noFile = await app.request(
      `/api/groups/${group.id}/tasks/${done2.id}/output/t1`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    expect(noFile.status).toBe(404);
    expect(((await noFile.json()) as { message: string }).message).toContain(
      "明细文件不存在",
    );

    // 整份明细必须显式带 detail=1。
    const noDetailFlag = await app.request(
      `/api/groups/${group.id}/tasks/${done.id}/output`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    expect(noDetailFlag.status).toBe(400);
    expect(
      ((await noDetailFlag.json()) as { message: string }).message,
    ).toContain("detail=1");

    // 授权口径与任务详情路由一致(includeOutput 同界):未知任务 → TASK_NOT_FOUND;
    // 未知群 → GROUP_NOT_FOUND。
    const bogusTask = await app.request(
      `/api/groups/${group.id}/tasks/00000000-0000-4000-8000-0000000000ff/output/t1`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    expect(bogusTask.status).toBe(404);
    expect(((await bogusTask.json()) as { code: string }).code).toBe(
      "TASK_NOT_FOUND",
    );
    const bogusGroup = await app.request(
      `/api/groups/00000000-0000-4000-8000-0000000000aa/tasks/${done.id}/output/t1`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    expect(bogusGroup.status).toBe(404);
    expect(((await bogusGroup.json()) as { code: string }).code).toBe(
      "GROUP_NOT_FOUND",
    );
  });

  it("R4/R5:明细由执行器输出路径自动落盘(不经手工 append)", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    process.env.FAKE_JSONL = "1";
    const msg = await postMessage(coordinator.id, group.id, {
      body: "明细自动落盘",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const done = await waitForTaskStatus(
      coordinator.id,
      group.id,
      msg.id,
      "done",
    );
    // 文件真实存在且含 thinking 明细(输出路径 onOutput → appendTaskDetail 自动写入)。
    const rows = readTaskDetail(done.id);
    expect(rows).not.toBeNull();
    expect(
      rows?.some(
        (r) => r.kind === "thinking" && r.text.includes(THINKING_BODY),
      ),
    ).toBe(true);
    // 展开 API 直接可读。
    const res = await app.request(
      `/api/groups/${group.id}/tasks/${done.id}/output/t2`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text).toContain(
      "Now read the guard file to confirm the check.",
    );
    // 手工追加条目同样可展开(同一条目空间)。
    appendTaskDetail(done.id, {
      id: "t99",
      kind: "report",
      summary: "[汇报 #t99] 事后补充",
    });
    const manual = await app.request(
      `/api/groups/${group.id}/tasks/${done.id}/output/t99`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    expect(manual.status).toBe(200);
    expect(taskDetailFilePath(done.id)).toContain(done.id);
  });

  it("R1/R2:运行中摘要流无 [思考] 行,同一时刻 ?detail=1 仍取回 thinking 全文", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    process.env.FAKE_JSONL = "1";
    const msg = await postMessage(coordinator.id, group.id, {
      body: "摘要流过滤 thinking",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const running = await waitForTaskStatus(
      coordinator.id,
      group.id,
      msg.id,
      "running",
    );
    // 采样点:report已到达 —— 两条 thinking 之后故此刻若含thinking则过滤失败
    const tail = await waitForOutputTail(
      coordinator.id,
      group.id,
      running.id,
      "报告: 完成",
    );
    expect(tailLinesStartingWith(tail, "[思考")).toEqual([]);
    // live-only: tool not in live, only report
    expect(tail).not.toContain("[工具 #t3] read_file");
    expect(tail).toContain("报告: 完成");

    // R2:同一时刻整份明细仍包含两条 thinking 全文。
    const allRes = await app.request(
      `/api/groups/${group.id}/tasks/${running.id}/output?detail=1`,
      { headers: { "X-Participant-Id": coordinator.id } },
    );
    expect(allRes.status).toBe(200);
    const all = (await allRes.json()) as {
      entries: Array<{ id: string; kind: string; text: string }>;
    };
    const thinkings = all.entries.filter((e) => e.kind === "thinking");
    expect(thinkings.map((e) => e.id)).toEqual(["t1", "t2"]);
    expect(thinkings[0].text).toContain(
      "Let me check the guard file location.",
    );
    expect(thinkings[0].text).toContain(THINKING_BODY);
    expect(thinkings[1].text).toContain("Now read the guard file to confirm");
    console.log(
      `[detail] 运行中 detail=1 采样: entries=${all.entries.map((e) => `${e.id}:${e.kind}`).join(", ")}; thinking 全文=${thinkings.reduce((n, e) => n + e.text.length, 0)}B; 摘要流=${tail.length}B`,
    );

    await waitForTaskStatus(coordinator.id, group.id, msg.id, "done");
  });
});
