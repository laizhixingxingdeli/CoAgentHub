import { existsSync, readFileSync, rmSync } from "node:fs";
import type { OutputEntry } from "@server/lib/executor-task";
import {
  appendTaskDetail,
  createExecutorOutputParser,
  getCodexSkippedEventCounts,
  getGenericSkippedEventCounts,
  readTaskDetail,
  resetCodexSkippedEventCounts,
  resetGenericSkippedEventCounts,
  summaryStreamText,
  taskDetailFilePath,
} from "@server/lib/executor-task";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 执行器输出解析器(output-parser.ts,spec: live-output-shows-narration-not-actions +
 * two-tier-output-summary-and-detail):
 *  - 解析器产出**结构化条目**(OutputEntry:id/kind/summary/detail),不再是纯字符串;
 *    summary 带 #id(如 `[工具 #t3]`)进摘要流,detail 进明细存储(R4)。
 *  - codex(exec --json):只渲染 type == "item.completed" 的三类 item 与两类
 *    error 事件为动作行([工具]/[命令]/[汇报]/[错误],错误不折叠),不输出
 *    arguments/result 全文(result 进 detail);已知冗余事件(item.started /
 *    thread.started / turn.started / turn.completed)显式跳过并计数 + 去重日志
 *    (R1/R4);非法 JSON、未知顶层 type、未知 item type 值逐字保留;跨 chunk
 *    半截行拼接;进程结束时 flush 吐出未成行残留。
 *  - atomcode(-v):[thinking] 行折叠为 [思考 #id] 首句要旨 + detail 全文;
 *    [tool→/[tool← 动作行摘要逐字 + #id,超长行折叠;未知行逐字保留;
 *    中行内已知前缀拆到行首(治多句粘成一段,内容不丢);跨 chunk 半截行拼接,
 *    进程结束时 flush 吐出未成行残留。
 *  - codebuddy(--output-format stream-json):有状态 JSONL 解析,形状取自任务
 *    01a03eb9 实跑(2026-08-26)。assistant 内容块 tool_use/text/thinking →
 *    [工具](input 只取键名,值进 detail)/[汇报]/[思考](要旨 + detail);user 内容块
 *    tool_result → [工具] 名 ok|error(按 tool_use_id 关联工具名,全文进 detail,
 *    error 不折叠);system.task_started(Bash) → [命令];result → [汇报]。
 *    uuid/session_id/完整 input/result/_meta 一律不进缓冲;已知噪音
 *    (file-history-snapshot、task_updated/task_notification)不渲染;非法/非
 *    JSON/未知 type/未知 content block 逐字保留(R3);跨 chunk 拼接 + 结束时 flush。
 *  - 其他执行器(default):通用语义解析器(spec: generic-executor-output-parsing)。
 *    逐行判定 JSON 语义提取 → [前缀] 动作渲染 → 逐字保留;按字段语义递归丢
 *    信封、留动作/正文/错误并截断长值(原文整行进 detail);解析失败/结构不认识
 *    逐字保留(R3);未知 executorKey 创建时只记一次观测日志。
 *  - R5:262143 字节基线夹具压缩超过一个数量级,且不含多层转义 brief 回显。
 *  - R7:透传行逐字保留且不带 #id(字节不变)。
 */

/** 摘要流文本:与 queue 装配一致(每条摘要一行 + 行尾换行)。 */
const summaryText = (entries: OutputEntry[]): string =>
  entries.length === 0 ? "" : `${entries.map((e) => e.summary).join("\n")}\n`;

/** 摘要中形如 `[汇报 #tN] 0` 的账目标量渲染条数(修复后应为 0)。 */
const zeroReportCount = (entries: OutputEntry[]): number =>
  entries.filter((e) => /^\[汇报 #[^\]]+\] 0$/.test(e.summary)).length;

/** codebuddy assistant 事件夹具:形状与 01a03eb9 实跑一致(uuid/session_id 噪音)。 */
const codeBuddyAssistant = (blocks: unknown[]): string =>
  JSON.stringify({
    type: "assistant",
    uuid: "6d8bda2d755d43829ed17aec797bbc23",
    session_id: "65d329c3-7f28-4266-8515-7e58b3b03b07",
    message: { id: "msg-1", content: blocks },
  });

describe("codex:item.completed 渲染为动作行", () => {
  const completed = (item: Record<string, unknown>): string =>
    JSON.stringify({ type: "item.completed", item });

  it("mcp_tool_call → [工具] 工具名 + 参数键名,result 全文进明细", () => {
    const parse = createExecutorOutputParser("codex");
    const resultText = "result-full-text-should-not-appear-anywhere".repeat(20);
    const line = completed({
      type: "mcp_tool_call",
      tool: "coagenthub_get_task",
      status: "success",
      arguments: {
        taskId: "01a03d87",
        groupId: "01a03be2",
      },
      result: resultText,
    });
    const entries = parse(`${line}\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("t1");
    expect(entries[0].kind).toBe("tool");
    expect(entries[0].summary).toContain("[工具 #t1] coagenthub_get_task");
    expect(entries[0].summary).toContain("taskId groupId");
    // R3:工具结果全文折叠 —— 摘要不含,明细含完整原文。
    expect(entries[0].summary).not.toContain(
      "result-full-text-should-not-appear-anywhere",
    );
    expect(entries[0].detail).toBe(resultText);
  });

  it("mcp_tool_call 失败:error 全文在摘要(status/error 可见,不折叠)", () => {
    const parse = createExecutorOutputParser("codex");
    const ok = completed({
      type: "mcp_tool_call",
      tool: "curl",
      status: "success",
      arguments: { url: "http://localhost:3001/api" },
    });
    const failed = completed({
      type: "mcp_tool_call",
      tool: "curl",
      status: "error",
      error: "connection refused",
      arguments: { url: "http://localhost:3001/api" },
    });
    const entries = parse(`${ok}\n${failed}\n`);
    expect(summaryText(entries)).toBe(
      "[工具 #t1] curl url\n[工具 #t2] curl url status=error error=connection refused\n",
    );
    // R3:错误条目类别为 error,error 全文在摘要。
    expect(entries[1].kind).toBe("error");
    expect(entries[1].summary).toContain("error=connection refused");
  });

  it("command_execution → [命令] 命令 + exit 码", () => {
    const parse = createExecutorOutputParser("codex");
    const line = completed({
      type: "command_execution",
      command: "git status --short",
      exit_code: 0,
    });
    const failLine = completed({
      type: "command_execution",
      command: "curl -sS http://localhost:3001/api",
      exit_code: 5,
    });
    const entries = parse(`${line}\n${failLine}\n`);
    expect(summaryText(entries)).toBe(
      "[命令 #t1] git status --short exit 0\n[命令 #t2] curl -sS http://localhost:3001/api exit 5\n",
    );
  });

  it("command_execution 折行命令压成单行,超长截断", () => {
    const parse = createExecutorOutputParser("codex");
    const line = completed({
      type: "command_execution",
      command: `printf "a\nb\nc" && ${"x".repeat(600)}`,
      exit_code: 0,
    });
    const entries = parse(`${line}\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).not.toContain("\n");
    expect(entries[0].summary).toContain("a b c"); // 折行已压成空格
    expect(entries[0].summary).toContain("exit 0");
  });

  it("agent_message → [汇报] 正文", () => {
    const parse = createExecutorOutputParser("codex");
    const line = completed({
      type: "agent_message",
      text: "Dispatch succeeded: child task 01a03d88 is running under AtomCode",
    });
    const entries = parse(`${line}\n`);
    expect(entries[0].kind).toBe("report");
    expect(entries[0].summary).toBe(
      "[汇报 #t1] Dispatch succeeded: child task 01a03d88 is running under AtomCode",
    );
  });
});

describe("codex:真实 item.completed JSONL 回归(item.type 协议字段)", () => {
  it("真实运行固化的 command_execution 行 → [命令] 动作行 + 明细全文,不退化为 raw", () => {
    const parse = createExecutorOutputParser("codex");
    // 取自 2026-08-27 生产日志的真实 codex(exec --json)行,完整 JSONL 原样固化:
    // item 类型字段是 type(非 item_type),命令输出字段是 aggregated_output。
    const realLine =
      '{"type":"item.completed","item":{"id":"item_13","type":"command_execution","command":"/bin/zsh -lc \'git diff 44c58590\'\'^ 44c58590 --name-only && git status --short\'","aggregated_output":"scripts/coagenthub-watchdog.sh\\nscripts/coagenthub-watchdog.test.mjs\\n","exit_code":0,"status":"completed"}}';
    const entries = parse(`${realLine}\n`);
    expect(entries).toHaveLength(1);
    // 修复前读 item_type 落空,该行退化为 raw;现在按 item.type 解析为 [命令] 动作行。
    expect(entries[0].kind).toBe("command");
    expect(entries[0].summary).toBe(
      "[命令 #t1] /bin/zsh -lc 'git diff 44c58590''^ 44c58590 --name-only && git status --short' exit 0",
    );
    // R3:命令输出全文进明细(aggregated_output),摘要只含命令行。
    expect(entries[0].detail).toBe(
      "scripts/coagenthub-watchdog.sh\nscripts/coagenthub-watchdog.test.mjs\n",
    );
  });
});

describe("codex:R3 解析不出的行逐字保留", () => {
  it("非法 JSON 原样保留", () => {
    const parse = createExecutorOutputParser("codex");
    const garbage = '{ "unterminated": tru';
    const entries = parse(`${garbage}\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("raw");
    expect(entries[0].summary).toBe(garbage);
  });

  it("未知顶层 type 原样保留(R3)", () => {
    const parse = createExecutorOutputParser("codex");
    const weird = JSON.stringify({ type: "some_future_event", payload: 1 });
    const entries = parse(`${weird}\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("raw");
    expect(entries[0].summary).toBe(weird);
  });

  it("未知 item type 值原样保留", () => {
    const parse = createExecutorOutputParser("codex");
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "brand_new_item_kind", data: { a: 1 } },
    });
    const entries = parse(`${line}\n`);
    expect(entries[0].summary).toBe(line);
  });

  it("item.completed 但 item 缺失 → 原样保留", () => {
    const parse = createExecutorOutputParser("codex");
    const line = JSON.stringify({ type: "item.completed" });
    const entries = parse(`${line}\n`);
    expect(entries[0].summary).toBe(line);
  });

  it("跨 chunk 拼接后半截非法 JSON 原样保留(R3 回归)", () => {
    const parse = createExecutorOutputParser("codex");
    const garbage =
      '{"type":"item.completed","item":{"type":"mcp_tool_call","tool":"read_file","arguments":}}';
    const cut = 17; // 在词中间切开,与真实流式 chunk 一致
    expect(parse(garbage.slice(0, cut))).toEqual([]);
    const entries = parse(`${garbage.slice(cut)}\n`);
    expect(entries[0].summary).toBe(garbage);
  });
});

describe("codex:流式跨 chunk", () => {
  it("JSONL 行被切成两半 → 拼接后渲染一次", () => {
    const parse = createExecutorOutputParser("codex");
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "half and half" },
    });
    const cut = Math.floor(line.length / 2);
    expect(parse(line.slice(0, cut))).toEqual([]);
    expect(summaryText(parse(`${line.slice(cut)}\n`))).toBe(
      "[汇报 #t1] half and half\n",
    );
  });

  it("进程结束 flush 吐出未成行残留(逐字,R3)", () => {
    const parse = createExecutorOutputParser("codex");
    const partial = '{"type":"item.started"'; // 半截 JSONL 行(无结尾换行)
    expect(parse(partial)).toEqual([]);
    const flushed = parse.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].kind).toBe("raw");
    expect(flushed[0].summary).toBe(partial);
    expect(parse.flush()).toEqual([]);
  });
});

describe("codex:已知冗余事件显式跳过(R1)", () => {
  it("item.started 各类 item 均显式跳过,不产出任何条目", () => {
    const parse = createExecutorOutputParser("codex");
    const startedCommand = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "git status" },
    });
    const startedTool = JSON.stringify({
      type: "item.started",
      item: { type: "mcp_tool_call", tool: "read_file" },
    });
    const startedAgent = JSON.stringify({
      type: "item.started",
      item: { type: "agent_message", text: "hi" },
    });
    const entries = parse(
      `${startedCommand}\n${startedTool}\n${startedAgent}\n`,
    );
    expect(entries).toEqual([]); // 显式识别后跳过,不得靠默认吞弃
  });

  it("thread.started / turn.started / turn.completed 不产出条目", () => {
    const parse = createExecutorOutputParser("codex");
    const lines = [
      { type: "thread.started", thread_id: "thr_1" },
      { type: "turn.started", turn_id: "trn_1" },
      { type: "turn.completed", turn_id: "trn_1" },
    ].map((e) => JSON.stringify(e));
    const entries = parse(`${lines.join("\n")}\n`);
    expect(entries).toEqual([]);
  });

  it("跳过计数按事件签名累加;去重日志每种签名只记一次(R4)", () => {
    resetCodexSkippedEventCounts();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const parse = createExecutorOutputParser("codex");
      const started = (itemType: string): string =>
        JSON.stringify({ type: "item.started", item: { type: itemType } });
      const lines = [
        started("mcp_tool_call"),
        started("mcp_tool_call"),
        started("command_execution"),
        JSON.stringify({ type: "thread.started" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "turn.completed" }),
      ];
      expect(parse(`${lines.join("\n")}\n`)).toEqual([]);
      expect(getCodexSkippedEventCounts()).toEqual({
        "item.started/mcp_tool_call": 2,
        "item.started/command_execution": 1,
        "thread.started": 1,
        "turn.started": 1,
        "turn.completed": 1,
      });
      // 去重:同签名多次跳过只记一次日志,不逐行刷屏(R4 限频)。
      expect(warn).toHaveBeenCalledTimes(5);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("item.started/mcp_tool_call"),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("codex:错误事件渲染为 [错误](R2,永不折叠)", () => {
  it("顶层 {type:error,message} → [错误] <message>,全文在摘要、不进明细", () => {
    const parse = createExecutorOutputParser("codex");
    const line = JSON.stringify({
      type: "error",
      message: "Reconnecting... 5/5 (request timed out)",
    });
    const entries = parse(`${line}\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("error");
    expect(entries[0].summary).toBe(
      "[错误 #t1] Reconnecting... 5/5 (request timed out)",
    );
    // 错误永不折叠:完整信息留在摘要流,不进明细。
    expect(entries[0].detail).toBeUndefined();
  });

  it("item.completed 且 item.type=error → [错误] <message>", () => {
    const parse = createExecutorOutputParser("codex");
    const line = JSON.stringify({
      type: "item.completed",
      item: { id: "item_9", type: "error", error: "Agent crashed: OOM" },
    });
    const entries = parse(`${line}\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("error");
    expect(entries[0].summary).toBe("[错误 #t1] Agent crashed: OOM");
    expect(entries[0].detail).toBeUndefined();
  });

  it("item.completed/error 的错误为对象时取 message/error 字段", () => {
    const parse = createExecutorOutputParser("codex");
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_10",
        type: "error",
        error: { message: "sandbox blocked network access" },
      },
    });
    const entries = parse(`${line}\n`);
    expect(entries[0].kind).toBe("error");
    expect(entries[0].summary).toBe(
      "[错误 #t1] sandbox blocked network access",
    );
  });
});

describe("atomcode:前缀行与未知行(两层级)", () => {
  it("动作前缀行([tool→ / [tool←)摘要逐字 + #id;未知行逐字不带 #id", () => {
    const parse = createExecutorOutputParser("executor");
    const input =
      '[tool→ read_file] {"file_path": "a.txt"}\n' +
      "[tool← ok] 19 chars\n" +
      "[done] 6.1s tokens=35.90K turns=2 tool_calls=1\n";
    const entries = parse(input);
    expect(entries).toHaveLength(3);
    expect(entries[0].kind).toBe("tool");
    expect(entries[1].kind).toBe("result");
    expect(summaryText(entries)).toBe(
      '[tool→ read_file #t1] {"file_path": "a.txt"}\n' +
        "[tool← ok #t2] 19 chars\n" +
        "[done] 6.1s tokens=35.90K turns=2 tool_calls=1\n",
    );
    // R7:未知行逐字保留且不带 #id。
    expect(entries[2].summary).not.toContain("#t");
  });

  it("中行内已知前缀([tokens] 等)拆到行首,thinking 折叠为要旨", () => {
    const parse = createExecutorOutputParser("atomcode");
    const entries = parse(
      "[thinking] The user asks to read the file.[tokens] prompt=17916 completion=81 cached=6656\n",
    );
    expect(summaryText(entries)).toBe(
      "[思考 #t1] The user asks to read the file.\n" +
        "[tokens] prompt=17916 completion=81 cached=6656\n",
    );
    // R2:[thinking] 行折叠,明细 = 完整原文。
    expect(entries[0].kind).toBe("thinking");
    expect(entries[0].detail).toBe("The user asks to read the file.");
  });

  it("已知前缀与未知行:thinking 折叠,其余原样保留(不过滤旁白)", () => {
    const parse = createExecutorOutputParser("executor");
    const input =
      "[headless] --dangerously-skip-permissions\n" +
      "[thinking] plain thinking line\n" +
      "任意一行没有前缀的旁白,原样保留\n" +
      '{ "not": "an action" }\n';
    const entries = parse(input);
    expect(entries).toHaveLength(4);
    expect(entries[0].kind).toBe("raw"); // [headless]
    expect(entries[1].kind).toBe("thinking");
    expect(entries[2].kind).toBe("raw");
    expect(entries[3].kind).toBe("raw");
    expect(entries[0].summary).toBe(
      "[headless] --dangerously-skip-permissions",
    );
    expect(entries[1].summary).toBe("[思考 #t2] plain thinking line");
    expect(entries[2].summary).toBe("任意一行没有前缀的旁白,原样保留");
    expect(entries[3].summary).toBe('{ "not": "an action" }');
  });

  it("行首已知前缀不重复拆行", () => {
    const parse = createExecutorOutputParser("executor");
    const line = "[tokens] prompt=1 cached=2\n";
    const entries = parse(line);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("raw");
    expect(entries[0].summary).toBe("[tokens] prompt=1 cached=2");
  });

  it("超长工具行(超长参数值)折叠:摘要截断,全文进明细", () => {
    const parse = createExecutorOutputParser("executor");
    const longArgs = "x".repeat(1000);
    const entries = parse(
      `[tool→ write_file] {"path":"a.txt","content":"${longArgs}"}\n`,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("tool");
    expect(entries[0].summary.length).toBeLessThan(500);
    expect(entries[0].summary.endsWith("…")).toBe(true);
    expect(entries[0].detail).toContain(longArgs);
  });

  it("完整行(以换行结尾)立即渲染,flush 无残留", () => {
    const parse = createExecutorOutputParser("executor");
    const entries = parse('[tool→ read_file] {"file_path": "a.txt"}\n');
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toBe(
      '[tool→ read_file #t1] {"file_path": "a.txt"}',
    );
    expect(parse.flush()).toEqual([]);
  });
});

describe("atomcode:流式跨 chunk(行缓冲)", () => {
  it("跨 chunk 半截行拼接后只在真实换行处渲染一次", () => {
    const parse = createExecutorOutputParser("atomcode");
    const line = '[tool→ read_file] {"file_path": "a.txt"}';
    const cut = Math.floor(line.length / 2);
    // 半截行未遇到真实换行:不渲染,留在 pending。
    expect(parse(line.slice(0, cut))).toEqual([]);
    const entries = parse(`${line.slice(cut)}\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("tool");
    expect(entries[0].summary).toBe(
      '[tool→ read_file #t1] {"file_path": "a.txt"}',
    );
  });

  it("进程结束 flush 吐出未成行残留(逐字,R3)", () => {
    const parse = createExecutorOutputParser("atomcode");
    const partial = "半截行 And"; // 无结尾换行的残留
    expect(parse(partial)).toEqual([]);
    const flushed = parse.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].kind).toBe("raw");
    expect(flushed[0].summary).toBe(partial);
    expect(parse.flush()).toEqual([]);
  });

  it("已知前缀被 chunk 边界切开 → pending 重组后再拆到行首(R5)", () => {
    const parse = createExecutorOutputParser("atomcode");
    // [tokens] 前缀在 chunk 边界被切成两半:前一 chunk 以 "[t" 结尾。
    const first = "The user asks to read the file.[t";
    const second = "okens] prompt=17916 completion=81 cached=6656\n";
    expect(parse(first)).toEqual([]);
    const entries = parse(second);
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("raw");
    expect(entries[0].summary).toBe("The user asks to read the file.");
    expect(entries[1].summary).toBe(
      "[tokens] prompt=17916 completion=81 cached=6656",
    );
  });
});

describe("codebuddy:stream-json 动作行(形状取自 01a03eb9 实跑)", () => {
  const assistant = (blocks: unknown[]): string =>
    JSON.stringify({
      type: "assistant",
      uuid: "6d8bda2d755d43829ed17aec797bbc23",
      session_id: "65d329c3-7f28-4266-8515-7e58b3b03b07",
      message: { id: "msg-1", content: blocks },
    });

  it("tool_use 块 → [工具] 工具名 + input 键名,input 值全文进明细", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const line = codeBuddyAssistant([
      {
        type: "tool_use",
        id: "chatcmpl-tool-9e36eff5be9b5698",
        name: "TaskCreate",
        input: {
          subject: "Rewrite watchdog R4 to fail-closed",
          description: "Flip tasks_in_flight to fail-closed",
          activeForm: "Rewriting watchdog R4 fail-closed",
        },
      },
    ]);
    const entries = parse(`${line}\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("tool");
    expect(entries[0].summary).toBe(
      "[工具 #t1] TaskCreate subject description activeForm",
    );
    // input 的值不进摘要流(uuid 等噪音也不进),全文进明细(R3 超长参数值折叠)。
    expect(entries[0].summary).not.toContain(
      "6d8bda2d755d43829ed17aec797bbc23",
    );
    expect(entries[0].summary).not.toContain("session_id");
    expect(entries[0].summary).not.toContain(
      "Rewrite watchdog R4 to fail-closed",
    );
    expect(entries[0].detail).toContain("Rewrite watchdog R4 to fail-closed");
  });

  it("text 块 → [汇报] 正文", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const line = codeBuddyAssistant([
      { type: "text", text: "I now have a clear picture. Key findings:" },
    ]);
    const entries = parse(`${line}\n`);
    expect(entries[0].kind).toBe("report");
    expect(entries[0].summary).toBe(
      "[汇报 #t1] I now have a clear picture. Key findings:",
    );
  });

  it("thinking 块 → [思考] 首句要旨 + 明细全文(R2 折叠)", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const thinkingText =
      "Let me write the full new watchdog script. It must fail closed on any ambiguity.";
    const line = codeBuddyAssistant([
      { type: "thinking", thinking: thinkingText, signature: "" },
    ]);
    const entries = parse(`${line}\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("thinking");
    // 摘要 = 首句要旨,绝不是字数统计。
    expect(entries[0].summary).toBe(
      "[思考 #t1] Let me write the full new watchdog script.",
    );
    expect(entries[0].detail).toBe(thinkingText);
  });

  it("tool_result 块 → [工具] 工具名(按 tool_use_id 关联) + ok/error", () => {
    const parse = createExecutorOutputParser("codebuddy");
    // 先来一条 tool_use 记住 id → name 关联
    const use = codeBuddyAssistant([
      {
        type: "tool_use",
        id: "chatcmpl-tool-9e36eff5be9b5698",
        name: "TaskCreate",
        input: { subject: "x" },
      },
    ]);
    expect(summaryText(parse(`${use}\n`))).toBe(
      "[工具 #t1] TaskCreate subject\n",
    );
    const result = JSON.stringify({
      type: "user",
      uuid: "f30e9bd6-5f4e-4f07-9bba-ad5d8132f042",
      session_id: "65d329c3-7f28-4266-8515-7e58b3b03b07",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "chatcmpl-tool-9e36eff5be9b5698",
            content: [{ type: "text", text: "Task #4 created successfully" }],
            is_error: false,
          },
        ],
      },
    });
    const okEntries = parse(`${result}\n`);
    expect(okEntries[0].kind).toBe("result");
    expect(okEntries[0].summary).toBe(
      "[工具 #t2] TaskCreate ok Task #4 created successfully",
    );
    // R3:工具结果全文折叠 —— 明细含完整原文。
    expect(okEntries[0].detail).toBe("Task #4 created successfully");
    // is_error → error 全文留在摘要(永不折叠)
    const failed = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "chatcmpl-tool-9e36eff5be9b5698",
            content: [{ type: "text", text: "connection refused" }],
            is_error: true,
          },
        ],
      },
    });
    const errEntries = parse(`${failed}\n`);
    expect(errEntries[0].kind).toBe("error");
    expect(errEntries[0].summary).toBe(
      "[工具 #t3] TaskCreate error connection refused",
    );
  });

  it("system task_started(Bash) → [命令] description(命令可见)", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const line = JSON.stringify({
      type: "system",
      subtype: "task_started",
      task_id: "S7snnN",
      tool_use_id: "chatcmpl-tool-8a3aecdfdc9d5cbf",
      description:
        "cd /Users/apple/Projects/CoAgentHub && bash scripts/coagenthub-prod.sh cron-install 2>&1",
      task_type: "Bash",
      uuid: "66f9cfe2-b077-43da-8dd2-c99fb1ddfc26",
      session_id: "65d329c3-7f28-4266-8515-7e58b3b03b07",
      __timestamp: "2026-08-26T15:49:22.441Z",
      _requestId: "012f8f1c8fbc4916a45b43ab5fc731b2",
    });
    const entries = parse(`${line}\n`);
    expect(entries[0].kind).toBe("command");
    expect(entries[0].summary).toBe(
      "[命令 #t1] cd /Users/apple/Projects/CoAgentHub && bash scripts/coagenthub-prod.sh cron-install 2>&1",
    );
    expect(entries[0].summary).not.toContain("S7snnN");
    expect(entries[0].summary).not.toContain("66f9cfe2");
    expect(entries[0].summary).not.toContain("session_id");
  });

  it("result 事件 → [汇报] 最终正文", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Committed as `f333ad8f`. All tasks done. Here is my report.",
    });
    const entries = parse(`${line}\n`);
    expect(entries[0].kind).toBe("report");
    expect(entries[0].summary).toBe(
      "[汇报 #t1] Committed as `f333ad8f`. All tasks done. Here is my report.",
    );
  });
});

describe("codebuddy:R3 解析不出的行逐字保留", () => {
  it("非法 JSON 原样保留", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const garbage = '{ "unterminated": tru';
    const entries = parse(`${garbage}\n`);
    expect(entries[0].kind).toBe("raw");
    expect(entries[0].summary).toBe(garbage);
  });

  it("非 JSON 行(旁白/告警)原样保留", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const plain = "plain text warning line\n";
    const entries = parse(plain);
    expect(entries[0].kind).toBe("raw");
    expect(entries[0].summary).toBe("plain text warning line");
  });

  it("未知顶层 type 原样保留", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const line = JSON.stringify({ type: "brand_new_event", payload: { a: 1 } });
    const entries = parse(`${line}\n`);
    expect(entries[0].summary).toBe(line);
  });

  it("未知 content block 原样保留", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const block = { type: "mystery_block", data: { x: 1 } };
    const line = codeBuddyAssistant([block]);
    const entries = parse(`${line}\n`);
    expect(entries[0].summary).toBe(line);
  });

  it("file-history-snapshot 事件原样保留(不属于已知动作块)", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const line = JSON.stringify({
      type: "file-history-snapshot",
      id: "589ff847-97ca-49fb-98ab-0b070422e7e7",
      isSnapshotUpdate: true,
      snapshot: { messageId: "185fc335" },
    });
    const entries = parse(`${line}\n`);
    expect(entries[0].summary).toBe(line);
  });
});

describe("codebuddy:流式跨 chunk", () => {
  it("JSONL 行被切成两半 → 拼接后渲染一次", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const line = codeBuddyAssistant([{ type: "text", text: "half and half" }]);
    const cut = Math.floor(line.length / 2);
    expect(parse(line.slice(0, cut))).toEqual([]);
    expect(summaryText(parse(`${line.slice(cut)}\n`))).toBe(
      "[汇报 #t1] half and half\n",
    );
  });

  it("进程结束 flush 吐出未成行残留(逐字,R3)", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const partial = '{"type":"assistant"'; // 半截 JSONL 行(无结尾换行)
    expect(parse(partial)).toEqual([]);
    const flushed = parse.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].kind).toBe("raw");
    expect(flushed[0].summary).toBe(partial);
    expect(parse.flush()).toEqual([]);
  });
});

describe("codebuddy:R5 压缩比(真实形状基线)", () => {
  it("工具调用/命令/汇报动作行可见,且不含 uuid/session_id 噪音", () => {
    const parse = createExecutorOutputParser("codebuddy");
    // 与 01a03eb9 同构:assistant(tool_use) + system(task_started) + user(tool_result) + result
    const rows: string[] = [];
    for (let n = 1; n <= 40; n += 1) {
      rows.push(
        codeBuddyAssistant([
          {
            type: "tool_use",
            id: `tool-${n}`,
            name: "coagenthub_get_task",
            input: { taskId: `01a03d8${n % 10}`, groupId: "01a03be2" },
          },
        ]),
      );
      rows.push(
        JSON.stringify({
          type: "system",
          subtype: "task_started",
          task_id: `S${n}`,
          tool_use_id: `tool-${n}`,
          description: `coagenthub_get_task --task ${n} --group 01a03be2`,
          task_type: "Bash",
          uuid: `uuid-${n}`,
          session_id: `session-${n}`,
        }),
      );
    }
    rows.push(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "提交: abc123\n测试: 全绿\n汇报: 完成了\n",
      }),
    );
    const input = rows.join("\n");
    const out = summaryText(parse(`${input}\n`));
    expect(out).toContain("[工具 #t1] coagenthub_get_task taskId groupId");
    expect(out).toContain(
      "[命令 #t2] coagenthub_get_task --task 1 --group 01a03be2",
    );
    expect(out).toContain("提交: abc123");
    // 噪音字段绝不进缓冲
    expect(out).not.toContain("uuid-");
    expect(out).not.toContain("session_id");
    expect(out).not.toContain("S1");
    // 压缩超过一个数量级(整段 JSONL 噪音被压成动作行)
    expect(out.length).toBeLessThan(input.length / 10);
  });
});

describe("codebuddy:同 chunk 重复动作行折叠(R5 支撑)", () => {
  it("同一工具反复调用只渲染首条,不同工具仍各自渲染", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const a = codeBuddyAssistant([
      {
        type: "tool_use",
        id: "tool-1",
        name: "read_file",
        input: { file_path: "a.txt" },
      },
    ]);
    const b = codeBuddyAssistant([
      {
        type: "tool_use",
        id: "tool-2",
        name: "read_file",
        input: { file_path: "b.txt" },
      },
    ]);
    const c = codeBuddyAssistant([
      {
        type: "tool_use",
        id: "tool-3",
        name: "TaskCreate",
        input: { subject: "x" },
      },
    ]);
    expect(summaryText(parse(`${a}\n${b}\n${c}\n`))).toBe(
      "[工具 #t1] read_file file_path\n[工具 #t3] TaskCreate subject\n",
    );
  });

  it("同 chunk 的 tool_use 与其匹配 tool_result 都可见,折叠键不按同名吞掉结果(ticket 01a03f35 回归)", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const use = codeBuddyAssistant([
      {
        type: "tool_use",
        id: "tool-1",
        name: "Read",
        input: { file_path: "a.txt" },
      },
    ]);
    const result = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: [{ type: "text", text: "done" }],
            is_error: false,
          },
        ],
      },
    });
    // 调用与结果在同一个 chunk,两行都按序可见;tool_result 不得被折叠键静默吞掉
    expect(summaryText(parse(`${use}\n${result}\n`))).toBe(
      "[工具 #t1] Read file_path\n[工具 #t2] Read ok done\n",
    );
  });

  it("R3 透传行不被折叠:两条相同旁白都保留", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const plain = "plain warning line\n";
    const entries = parse(`${plain}${plain}`);
    expect(entries).toHaveLength(2);
    expect(entries[0].summary).toBe("plain warning line");
    expect(entries[1].summary).toBe("plain warning line");
  });
});

describe("其他执行器:原样透传", () => {
  it("reasonix / win-hermes / 未知 key 不解析,创建时只记一次观测日志", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const key of ["reasonix", "win-hermes", "whatever"]) {
        const parse = createExecutorOutputParser(key);
        const input = 'plain line\n{"json": true}\n';
        const entries = parse(input);
        expect(entries).toHaveLength(2);
        expect(entries[0].summary).toBe("plain line");
        expect(entries[1].summary).toBe('{"json": true}');
        expect(parse.flush()).toEqual([]);
      }
      // 每个未知 key 创建时恰好记一次(不逐 chunk 刷屏)
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("codex:R5 压缩比(基线 262143 字节)", () => {
  /** 多层转义的任务书回显片段(与实测噪音同构:\\\\\\\"brief\\\\\\\":\\\\\\\"# 任务…)。 */
  function escapedBriefBlock(length: number): string {
    const unit =
      '\\\\\\"brief\\\\\\":\\\\\\"# 任务:技能从未说过「不要自己实现」\\\\\\"';
    return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
  }

  it("压缩超过一个数量级,且不含多层转义 brief 回显", () => {
    const parse = createExecutorOutputParser("codex");
    const rows: string[] = [];
    let total = 0;
    for (let n = 1; total < 262_143; n += 1) {
      const blob = escapedBriefBlock(12_000);
      const row = JSON.stringify({
        type: "item.completed",
        item:
          n % 4 === 0
            ? {
                type: "command_execution",
                command: `coagenthub_get_task --task ${n} --group 01a03be2`,
                exit_code: n % 8 === 0 ? 5 : 0,
              }
            : {
                type: "mcp_tool_call",
                tool: "coagenthub_get_task",
                status: "success",
                // 键名用 taskbook(避开断言关键词):多层转义回显只藏在值里。
                arguments: { taskbook: blob, taskId: `01a03d8${n % 10}` },
                result: blob,
              },
      });
      rows.push(row);
      total += row.length + 1;
    }
    const input = rows.join("\n");
    // 基线达标:与实测 01a03d87 同量级(262143 字节)。
    expect(input.length).toBeGreaterThanOrEqual(262_143);

    const out = summaryText(parse(`${input}\n`));
    // 压缩超过一个数量级(实测 262143 → 4909,1.9%)。
    expect(out.length).toBeLessThan(input.length / 10);
    // 动作行可见:工具调用、命令与 exit 码、汇报。
    expect(out).toContain("[工具 #t1] coagenthub_get_task");
    expect(out).toContain("exit 0");
    expect(out).toContain("exit 5");
    // 结果不含多层转义的任务书回显(brief 只存在于键名外的原始噪音中)。
    expect(out).not.toContain("brief");
    expect(out).not.toContain('\\"');
    // R3/R4:result 全文折叠进明细,摘要不承载。
    const entries = parse(`${input}\n`);
    expect(entries.some((e) => (e.detail ?? "").includes("brief"))).toBe(true);
  });
});

/* ======================================================================
 * default 分支:通用语义解析器(spec: generic-executor-output-parsing)
 * ====================================================================== */

describe("default:通用解析器 R1 判定顺序(JSON 语义 → [前缀] → 逐字)", () => {
  it("JSON 语义提取优先:工具/正文渲染为动作行,信封字段不进缓冲,原文进明细", () => {
    const parse = createExecutorOutputParser("reasonix");
    const line = JSON.stringify({
      type: "item.completed",
      uuid: "6d8bda2d755d43829ed17aec797bbc23",
      item: {
        item_type: "mcp_tool_call",
        tool: "coagenthub_get_task",
        arguments: { taskId: "01a03d87", groupId: "01a03be2" },
        result: "ok",
      },
    });
    const entries = parse(`${line}\n`);
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("tool");
    expect(entries[0].summary).toBe("[工具 #t1] coagenthub_get_task");
    expect(entries[1].kind).toBe("report");
    expect(entries[1].summary).toBe("[汇报 #t2] ok");
    // 信封/参数值不进摘要流
    expect(entries[0].summary).not.toContain("6d8bda2d");
    expect(entries[0].summary).not.toContain("taskId");
    expect(entries[0].summary).not.toContain("groupId");
    // 明细 = 原始整行(完整原文)。
    expect(entries[0].detail).toBe(line);
  });

  it("error 字段可见且全文在摘要(不折叠),信封字段不渲染", () => {
    const parse = createExecutorOutputParser("reasonix");
    const line = JSON.stringify({
      tool: "curl",
      arguments: { url: "http://localhost:3001/api" },
      error: "connection refused",
      session_id: "s-1",
    });
    const entries = parse(`${line}\n`);
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("tool");
    expect(entries[1].kind).toBe("error");
    expect(summaryText(entries)).toBe(
      "[工具 #t1] curl\n[汇报 #t2] error=connection refused\n",
    );
  });

  it("长文本值截断到阈值 + 省略号(R2)", () => {
    const parse = createExecutorOutputParser("reasonix");
    const line = JSON.stringify({ text: "x".repeat(600) });
    const out = summaryText(parse(`${line}\n`)).trim();
    expect(out.startsWith("[汇报 #t1] ")).toBe(true);
    expect(out.length).toBeLessThan(300);
    expect(out.endsWith("…")).toBe(true);
  });

  it("[前缀] 形式:前缀作为动作类型保留,正文可解析则压缩,原文进明细", () => {
    const parse = createExecutorOutputParser("whatever");
    const line = '[tool← ok] {"result": "done","uuid":"u1"}\n';
    const entries = parse(line);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("report");
    expect(entries[0].summary).toBe("[tool← ok #t1] [汇报] done");
    expect(entries[0].detail).toBe('[tool← ok] {"result": "done","uuid":"u1"}');
  });

  it("[前缀] 行正文不是 JSON → 整行逐字保留", () => {
    const parse = createExecutorOutputParser("whatever");
    const line = "[tool→ read_file] 这不是 JSON,原样保留\n";
    const entries = parse(line);
    expect(entries[0].kind).toBe("raw");
    expect(entries[0].summary).toBe("[tool→ read_file] 这不是 JSON,原样保留");
  });

  it("[done] 这类纯前缀行逐字保留", () => {
    const parse = createExecutorOutputParser("whatever");
    const line = "[done] 6.1s tokens=35.90K\n";
    const entries = parse(line);
    expect(entries[0].kind).toBe("raw");
    expect(entries[0].summary).toBe("[done] 6.1s tokens=35.90K");
  });

  it("非 JSON 行与提取不出正文的 JSON 逐字保留", () => {
    const parse = createExecutorOutputParser("whatever");
    const input = '任意旁白,原样保留\n{"json": true}\n';
    const entries = parse(input);
    expect(entries).toHaveLength(2);
    expect(entries[0].summary).toBe("任意旁白,原样保留");
    expect(entries[1].summary).toBe('{"json": true}');
  });
});

describe("default:reasonix/hermes/win-hermes 代表性输入(验收 R2/R4)", () => {
  it("reasonix:JSONL 工具行 → [工具] + [汇报],无信封字段", () => {
    const parse = createExecutorOutputParser("reasonix");
    const rows = [
      {
        type: "tool_call",
        uuid: "6d8bda2d755d43829ed17aec797bbc23",
        tool: "read_file",
        arguments: { file_path: "a.txt" },
      },
      {
        type: "text",
        session_id: "65d329c3-7f28-4266-8515-7e58b3b03b07",
        text: "file read ok",
      },
    ];
    const entries = parse(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    expect(summaryText(entries)).toContain("[工具 #t1] read_file");
    expect(summaryText(entries)).toContain("[汇报 #t2] file read ok");
    expect(summaryText(entries)).not.toContain("6d8bda2d");
    expect(summaryText(entries)).not.toContain("session_id");
  });

  it("hermes:命令行 → [命令],无会话噪音", () => {
    const parse = createExecutorOutputParser("hermes");
    const line = JSON.stringify({
      type: "command",
      session_id: "sess-hermes",
      command: "pnpm test --filter server",
      exit_code: 0,
    });
    const entries = parse(`${line}\n`);
    expect(entries[0].kind).toBe("command");
    expect(entries[0].summary).toBe("[命令 #t1] pnpm test --filter server");
    expect(entries[0].summary).not.toContain("sess-hermes");
  });

  it("win-hermes:嵌套 message/content → [汇报],request_id 不出现", () => {
    const parse = createExecutorOutputParser("win-hermes");
    const line = JSON.stringify({
      type: "assistant",
      request_id: "req-123",
      message: {
        id: "msg-1",
        content: [{ type: "text", text: "All tasks done, see report" }],
      },
    });
    const entries = parse(`${line}\n`);
    expect(entries[0].kind).toBe("report");
    expect(entries[0].summary).toBe("[汇报 #t1] All tasks done, see report");
    expect(entries[0].summary).not.toContain("req-123");
  });
});

describe("default:R3 解析失败/结构不认识逐字保留", () => {
  it("非法 JSON 原样保留", () => {
    const parse = createExecutorOutputParser("whatever");
    const garbage = '{ "unterminated": tru';
    const entries = parse(`${garbage}\n`);
    expect(entries[0].kind).toBe("raw");
    expect(entries[0].summary).toBe(garbage);
  });

  it("标量 JSON(字符串/数字/数组)原样保留", () => {
    const parse = createExecutorOutputParser("whatever");
    const input = '"just a string"\n123\n[1,2,3]\n';
    const entries = parse(input);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.summary).join("\n")).toBe(
      '"just a string"\n123\n[1,2,3]',
    );
  });

  it("结构不认识(提取不出正文)原样保留", () => {
    const parse = createExecutorOutputParser("whatever");
    const line = JSON.stringify({ type: "brand_new_event", payload: { a: 1 } });
    const entries = parse(`${line}\n`);
    expect(entries[0].kind).toBe("raw");
    expect(entries[0].summary).toBe(line);
  });
});

describe("default:未知 key 重放 codex/codebuddy 实跑输出(兜底真实性,验收 R5)", () => {
  /** 与既有 codex R5 夹具同构的多层转义任务书回显片段。 */
  function escapedBriefBlock(length: number): string {
    const unit =
      '\\\\\\"brief\\\\\\":\\\\\\"# 任务:技能从未说过「不要自己实现」\\\\\\"';
    return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
  }

  it("codex 实跑输出走 default:缓冲不顶满且有动作行(贴前后字节数)", () => {
    const parse = createExecutorOutputParser("codex-replay");
    const rows: string[] = [];
    let total = 0;
    for (let n = 1; total < 262_143; n += 1) {
      const blob = escapedBriefBlock(12_000);
      const row = JSON.stringify({
        type: "item.completed",
        item:
          n % 4 === 0
            ? {
                item_type: "command_execution",
                command: `coagenthub_get_task --task ${n} --group 01a03be2`,
                exit_code: n % 8 === 0 ? 5 : 0,
              }
            : {
                item_type: "mcp_tool_call",
                tool: "coagenthub_get_task",
                status: "success",
                arguments: { taskbook: blob, taskId: `01a03d8${n % 10}` },
                result: blob,
              },
      });
      rows.push(row);
      total += row.length + 1;
    }
    const input = rows.join("\n");
    expect(input.length).toBeGreaterThanOrEqual(262_143);
    const out = summaryText(parse(`${input}\n`));
    // 兜底:缓冲不顶满、压缩超一个数量级、动作行可见
    expect(out.length).toBeLessThan(262_143);
    expect(out.length).toBeLessThan(input.length / 10);
    expect(out).toContain("[工具 #t1] coagenthub_get_task");
    expect(out).toContain("[汇报 #t");
    console.log(
      `[replay] codex default: input=${input.length}B output=${out.length}B (${((out.length / input.length) * 100).toFixed(2)}%)`,
    );
  });

  it("codebuddy 实跑输出走 default:缓冲不顶满且有动作行(贴前后字节数)", () => {
    const parse = createExecutorOutputParser("codebuddy-replay");
    const rows: string[] = [];
    for (let n = 1; n <= 40; n += 1) {
      rows.push(
        JSON.stringify({
          type: "assistant",
          uuid: `uuid-${n}`,
          session_id: `session-${n}`,
          message: {
            id: `msg-${n}`,
            content: [
              {
                type: "tool_use",
                id: `tool-${n}`,
                name: "coagenthub_get_task",
                input: { taskId: `01a03d8${n % 10}`, groupId: "01a03be2" },
              },
            ],
          },
        }),
      );
      rows.push(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: `tool-${n}`,
                content: [{ type: "text", text: escapedBriefBlock(3_000) }],
                is_error: false,
              },
            ],
          },
        }),
      );
    }
    rows.push(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "提交: abc123\n测试: 全绿\n汇报: 完成了\n",
      }),
    );
    const input = rows.join("\n");
    const out = summaryText(parse(`${input}\n`));
    // 兜底:缓冲不顶满、正文可见(tool_result 的长文本被截断压缩)
    expect(out.length).toBeLessThan(262_143);
    expect(out.length).toBeLessThan(input.length / 2);
    expect(out).toContain("[汇报 #t");
    console.log(
      `[replay] codebuddy default: input=${input.length}B output=${out.length}B (${((out.length / input.length) * 100).toFixed(2)}%)`,
    );
  });
});

describe("default:R5 未知 key 观测日志只记一次", () => {
  it("同一未知 key 创建多次只 warn 一次", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const key = "brand-new-executor-01";
      createExecutorOutputParser(key);
      createExecutorOutputParser(key);
      createExecutorOutputParser(key);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("default:流式跨 chunk", () => {
  it("JSONL 行被切成两半 → 拼接后渲染一次", () => {
    const parse = createExecutorOutputParser("whatever");
    const line = JSON.stringify({ tool: "read_file", text: "half and half" });
    const cut = Math.floor(line.length / 2);
    expect(parse(line.slice(0, cut))).toEqual([]);
    expect(summaryText(parse(`${line.slice(cut)}\n`))).toBe(
      "[工具 #t1] read_file\n[汇报 #t2] half and half\n",
    );
  });

  it("进程结束 flush 吐出未成行残留(逐字,R3)", () => {
    const parse = createExecutorOutputParser("whatever");
    const partial = '{"tool": "read_';
    expect(parse(partial)).toEqual([]);
    const flushed = parse.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].kind).toBe("raw");
    expect(flushed[0].summary).toBe(partial);
    expect(parse.flush()).toEqual([]);
  });
});

describe("default:账目字段不渲染(Pi 修复回归)", () => {
  it("result 为数字 0 不再渲染 [汇报] 0,字符串正文照常渲染", () => {
    const parse = createExecutorOutputParser("pi");
    const line = JSON.stringify({
      type: "tool_execution_result",
      tool: "bash",
      status: "success",
      result: 0,
      cost: 0.0,
      text: "ok",
    });
    const entries = parse(`${line}\n`);
    expect(entries).toHaveLength(2);
    expect(entries[0].summary).toBe("[工具 #t1] bash");
    expect(entries[1].summary).toBe("[汇报 #t2] ok");
    expect(zeroReportCount(entries)).toBe(0);
  });

  it("Usage/Cost/Tokens 大小写变体视为信封,嵌套 output_tokens 不渲染", () => {
    const parse = createExecutorOutputParser("pi");
    const line = JSON.stringify({
      Type: "report",
      Usage: { output_tokens: 0, total_tokens: 0 },
      Cost: { amount: 0.5, currency: "USD" },
      Tokens: { output_tokens: 0 },
      Text: "done",
    });
    const entries = parse(`${line}\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toBe("[汇报 #t1] done");
    expect(zeroReportCount(entries)).toBe(0);
  });

  it("仅有 usage/cost 的可解析但无语义 JSON → 显式跳过 + 计数(L2,不再 raw 刷屏)", () => {
    const parse = createExecutorOutputParser("pi");
    const line = JSON.stringify({
      type: "report",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      cost: 0.0,
    });
    resetGenericSkippedEventCounts();
    const entries = parse(`${line}\n`);
    expect(entries).toHaveLength(0);
    expect(getGenericSkippedEventCounts()).toEqual({ report: 1 });
  });
});

describe("default:同 chunk 重复动作行折叠(R5,Pi 修复回归)", () => {
  /** Pi 代表性 JSONL:同一 command 的 60 条 tool_execution_update + 结果/汇报行。 */
  const updateLine = (): string =>
    JSON.stringify({
      type: "tool_execution_update",
      tool: "bash",
      command: "git status --short",
      status: "running",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      cost: 0.0,
    });
  const countKind = (entries: OutputEntry[], prefix: string): number =>
    entries.filter((e) => e.summary.startsWith(prefix)).length;

  it("重复 update 只留首条,调用与结果互不折叠,无 [汇报] 0", () => {
    const parse = createExecutorOutputParser("pi");
    const input = [
      ...Array.from({ length: 60 }, updateLine),
      JSON.stringify({
        type: "tool_execution_result",
        tool: "bash",
        status: "success",
        result: 0,
        cost: 0.0,
      }),
      JSON.stringify({
        type: "agent_message",
        content: "All changes committed",
      }),
      JSON.stringify({ type: "report", text: "提交: abc123", cost: 0.0 }),
    ].join("\n");
    const entries = parse(`${input}\n`);
    // 修复前基线:60 条 update 各渲染 [工具]+[命令] 两条(120),result 行渲染
    // [工具]+[汇报 0] 两条,message/report 各一条 → 124 行;修复后 5 行。
    const baseline = 60 * 2 + 2 + 1 + 1;
    expect(entries.length).toBe(5);
    expect(entries.length).toBeLessThanOrEqual(baseline / 10);
    expect(countKind(entries, "[命令")).toBe(1); // 同一 command 只渲染一次
    expect(countKind(entries, "[工具")).toBe(2); // 调用(call)与结果(result)并存
    expect(zeroReportCount(entries)).toBe(0);
    expect(summaryText(entries)).toContain("[汇报 #t");
    console.log(
      `[pi-replay] baseline=${baseline} lines, fixed=${entries.length} lines (${((entries.length / baseline) * 100).toFixed(1)}%)`,
    );
  });

  it("错误条目永不折叠:同 chunk 相同错误行逐条保留", () => {
    const parse = createExecutorOutputParser("pi");
    const errLine = JSON.stringify({
      type: "tool_execution_update",
      tool: "bash",
      command: "git status",
      error: "connection reset",
    });
    const input = `${errLine}\n${errLine}\n`;
    const entries = parse(input);
    expect(entries).toHaveLength(4); // [工具]×1 + [命令]×1 + error×2
    expect(entries.filter((e) => e.kind === "error")).toHaveLength(2);
  });
});

describe("default:可解析但无语义 JSON 显式跳过(L2,计数 + 去重日志)", () => {
  it("message_update 全信封/增量字段 → 跳过并计数,每签名只记一次日志", () => {
    const parse = createExecutorOutputParser("pi");
    const line = JSON.stringify({
      type: "message_update",
      usage: { input: 0, output: 0, totalTokens: 0 },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "500",
      },
    });
    resetGenericSkippedEventCounts();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(parse(`${line}\n${line}\n${line}\n`)).toEqual([]);
      expect(getGenericSkippedEventCounts()).toEqual({ message_update: 3 });
      // 去重日志:同签名多次跳过只记一次,不逐行刷屏。
      expect(
        warn.mock.calls.filter((c) => c[0]?.includes("message_update")).length,
      ).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("agent_settled 仅分类字段 → 跳过并计数", () => {
    const parse = createExecutorOutputParser("pi");
    resetGenericSkippedEventCounts();
    expect(parse('{"type":"agent_settled"}\n')).toEqual([]);
    expect(getGenericSkippedEventCounts()).toEqual({ agent_settled: 1 });
  });

  it("未知键(payload 等)仍是未知结构 → R3 逐字保留,字节不变", () => {
    const parse = createExecutorOutputParser("pi");
    const line = JSON.stringify({
      type: "brand_new_event",
      payload: { a: 1 },
    });
    const entries = parse(`${line}\n`);
    expect(entries[0].kind).toBe("raw");
    expect(entries[0].summary).toBe(line);
  });
});

describe("default:toolcall_delta 参数源码不进摘要但落盘明细(L2 修复,验收 1/2)", () => {
  // 明细落盘用独立任务 id,避免与 detail-store 测试互踩;afterEach 只清理本文件。
  const DETAIL_TASK_ID = "00000000-0000-4000-8000-00000000d1e1";

  afterEach(() => {
    const p = taskDetailFilePath(DETAIL_TASK_ID);
    if (existsSync(p)) rmSync(p);
  });

  it("input_json_delta 增量碎片 → 摘要抑制(空摘要),detail 携带原始整行", () => {
    const parse = createExecutorOutputParser("pi");
    const line = JSON.stringify({
      type: "tool_call_delta",
      tool_call_id: "call-1",
      input_json_delta: '{"command":"echo source-code-here"}',
    });
    resetGenericSkippedEventCounts();
    const entries = parse(`${line}\n`);
    // 不再静默丢弃:摘要为空(不进摘要流),原始整行经 detail 保留。
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toBe("");
    expect(entries[0].detail).toBe(line);
    expect(getGenericSkippedEventCounts()).toEqual({ tool_call_delta: 1 });
    expect(summaryStreamText(entries)).toBe("");
  });

  it("集成:detail 条目经 appendTaskDetail/readTaskDetail 按 id 完整取回,字节不变", () => {
    const parse = createExecutorOutputParser("pi");
    const line = JSON.stringify({
      type: "tool_call_delta",
      tool_call_id: "call-1",
      input_json_delta: '{"command":"echo source-code-here"}',
    });
    const entries = parse(`${line}\n`);
    expect(entries).toHaveLength(1);
    // queue.ts 同款装配:对 parser 返回的 entries 逐条 appendTaskDetail。
    appendTaskDetail(DETAIL_TASK_ID, entries[0]);
    const rows = readTaskDetail(DETAIL_TASK_ID);
    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows?.[0].id).toBe(entries[0].id);
    expect(rows?.[0].text).toBe(line);
  });

  it("完整 tool_use 事件 → 摘要截断(不出现成片源码),原文整行进 detail", () => {
    const parse = createExecutorOutputParser("pi");
    const longSource = "full source body ".repeat(60); // 远超 200 字符截断阈值
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "read_file",
            input: { file_path: "/src/a.ts", content: longSource },
          },
        ],
      },
    });
    const entries = parse(`${line}\n`);
    expect(entries.length).toBeGreaterThan(0);
    // 验收 6:工具参数/结果全文可从 detail 取回;摘要不出现成片源码。
    expect(entries[0].detail).toBe(line);
    expect(entries[0].summary).not.toContain(longSource);
    expect(entries[0].summary.length).toBeLessThan(longSource.length);
  });
});

describe("default:跨 chunk seen 折叠(L2,seen 提升到闭包)", () => {
  it("同一动作行跨 chunk 只保留首条,不同工具仍各自渲染", () => {
    const parse = createExecutorOutputParser("pi");
    const call = JSON.stringify({
      type: "tool_execution_update",
      tool: "bash",
      command: "git status --short",
      status: "running",
      usage: { input_tokens: 0 },
    });
    // chunk1:动作行;chunk2:同一动作行(seen 不再按 chunk 重建 → 折叠)
    const first = parse(`${call}\n`);
    const second = parse(`${call}\n`);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual([]);
  });

  it("跨 chunk 的 raw 透传行永不折叠(逐字)", () => {
    const parse = createExecutorOutputParser("pi");
    expect(parse("plain text line\n").map((e) => e.summary)).toEqual([
      "plain text line",
    ]);
    expect(parse("plain text line\n").map((e) => e.summary)).toEqual([
      "plain text line",
    ]);
  });
});

describe("default:summaryStreamText 空摘要过滤(L2,空行治理)", () => {
  it('raw("") 空摘要不进摘要流,并计为 <empty> 跳过', () => {
    const entry = (summary: string): OutputEntry => ({
      id: "t1",
      kind: summary.length === 0 ? "raw" : "report",
      summary,
    });
    resetGenericSkippedEventCounts();
    expect(summaryStreamText([entry(""), entry("有内容")])).toBe("有内容\n");
    expect(getGenericSkippedEventCounts()).toEqual({ "<empty>": 1 });
  });

  it("全空批不产出空行(与既有 thinking 全过滤同界)", () => {
    const empty: OutputEntry = { id: "t1", kind: "raw", summary: "" };
    expect(summaryStreamText([empty])).toBe("");
  });
});

describe("真实 outputTail 重放(验收 1-3:Pi / AtomCode fixture)", () => {
  const piFixture = readFileSync(
    new URL("./fixtures/pi-task-outputTail.txt", import.meta.url),
    "utf8",
  );
  const atomcodeFixture = readFileSync(
    new URL("./fixtures/atomcode-task-outputTail.txt", import.meta.url),
    "utf8",
  );

  it("Pi 重放:相对 177KB 基线降 ≥80%,裸 JSON 行占比 <5%,动作行不减少", () => {
    const parse = createExecutorOutputParser("pi");
    resetGenericSkippedEventCounts();
    // 分块喂入(每块以换行结尾),模拟真实流式;进程结束时 flush 残留。
    const chunks = piFixture.split("\n").map((l) => `${l}\n`);
    const entries = chunks.flatMap((c) => parse(c));
    const flushed = parse.flush();
    const output = summaryStreamText([...entries, ...flushed]);
    const outputBytes = Buffer.byteLength(output, "utf8");
    const baselineBytes = 177_000;
    // 验收 1:同一份 Pi 真实输出摘要相对 177KB 基线下降至少 80%。
    expect(outputBytes).toBeLessThanOrEqual(0.2 * baselineBytes);
    // 验收 2:裸 JSON 行占比 <5%(跳过后的输出不应再有裸 JSON)。
    const jsonLines = output
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .filter((l) => {
        try {
          JSON.parse(l);
          return true;
        } catch {
          return false;
        }
      });
    expect(jsonLines.length).toBeLessThan(0.05 * output.split("\n").length);
    // 验收 3:非 JSON 行全部逐字保留(动作行/正文不减少、字节不变)。
    const preserved = piFixture
      .split("\n")
      .filter((l) => {
        try {
          JSON.parse(l);
          return false;
        } catch {
          return true;
        }
      })
      .join("\n");
    expect(output).toBe(`${preserved}\n`);
    // 跳过观测:message_update 181 条 + agent_settled 1 条。
    expect(getGenericSkippedEventCounts()).toEqual({
      message_update: 181,
      agent_settled: 1,
    });
    console.log(
      `[replay-pi] fixture=${Buffer.byteLength(piFixture, "utf8")}B output=${outputBytes}B (${((outputBytes / baselineBytes) * 100).toFixed(2)}% of 177KB baseline)`,
    );
  });

  it("AtomCode 重放:空行占比 <2%,动作行数量不减少", () => {
    const parse = createExecutorOutputParser("executor");
    const chunks = atomcodeFixture.split("\n").map((l) => `${l}\n`);
    const entries = chunks.flatMap((c) => parse(c));
    const output = summaryStreamText(entries);
    const lines = output.split("\n").filter((l) => l.length > 0);
    const emptyShare =
      lines.length === 0
        ? 0
        : output.split("\n").filter((l) => l.length === 0).length /
          (lines.length + 1);
    expect(emptyShare).toBeLessThan(0.02);
    // 动作行([tool→/[tool←)数量不减少:每个输入动作行都保留为输出动作行。
    const inputActions = atomcodeFixture
      .split("\n")
      .filter((l) => /^\[(tool→|tool←)/.test(l)).length;
    const outputActions = output
      .split("\n")
      .filter((l) => /^\[(tool→|tool←)/.test(l)).length;
    expect(outputActions).toBeGreaterThanOrEqual(inputActions);
    console.log(
      `[replay-atomcode] fixture=${Buffer.byteLength(atomcodeFixture, "utf8")}B output=${Buffer.byteLength(output, "utf8")}B actions=${inputActions}→${outputActions}`,
    );
  });
});
