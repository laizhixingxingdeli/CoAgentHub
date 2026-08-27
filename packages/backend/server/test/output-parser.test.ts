import { createExecutorOutputParser } from "@server/lib/executor-task";
import { describe, expect, it, vi } from "vitest";

/**
 * 执行器输出解析器(output-parser.ts,spec: live-output-shows-narration-not-actions):
 *  - codex(exec --json):只渲染 type == "item.completed" 的三类 item 为
 *    [工具]/[命令]/[汇报] 动作行,不输出 arguments/result 全文;非法 JSON、
 *    非 completed 事件、未知 item_type 逐字保留;跨 chunk 半截行拼接;
 *    进程结束时 flush 吐出未成行残留。
 *  - atomcode(-v):动作前缀行与未知行逐字保留;中行内已知前缀拆到行首
 *    (治多句粘成一段,内容不丢)。
 *  - codebuddy(--output-format stream-json):有状态 JSONL 解析,形状取自任务
 *    01a03eb9 实跑(2026-08-26)。assistant 内容块 tool_use/text/thinking →
 *    [工具](input 只取键名)/[汇报]/[思考];user 内容块 tool_result → [工具]
 *    名 ok|error(按 tool_use_id 关联工具名);system.task_started(Bash) →
 *    [命令];result → [汇报]。uuid/session_id/完整 input/result/_meta 一律
 *    不进缓冲;已知噪音(file-history-snapshot、task_updated/task_notification)
 *    不渲染;非法/非 JSON/未知 type/未知 content block 逐字保留(R3);
 *    跨 chunk 拼接 + 结束时 flush。
 *  - 其他执行器(default):通用语义解析器(spec: generic-executor-output-parsing)。
 *    逐行判定 JSON 语义提取 → [前缀] 动作渲染 → 逐字保留;按字段语义递归丢
 *    信封、留动作/正文/错误并截断长值;解析失败/结构不认识逐字保留(R3);
 *    未知 executorKey 创建时只记一次观测日志(R5)。
 *  - R5:262143 字节基线夹具压缩超过一个数量级,且不含多层转义 brief 回显。
 */

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

  it("mcp_tool_call → [工具] 工具名 + 参数键名,不带 arguments/result 全文", () => {
    const parse = createExecutorOutputParser("codex");
    const line = completed({
      item_type: "mcp_tool_call",
      tool: "coagenthub_get_task",
      status: "success",
      arguments: {
        taskId: "01a03d87",
        groupId: "01a03be2",
      },
      result: "result-full-text-should-not-appear-anywhere".repeat(20),
    });
    const out = parse(`${line}\n`);
    expect(out).toContain("[工具] coagenthub_get_task");
    expect(out).toContain("taskId groupId");
    expect(out).not.toContain("result-full-text-should-not-appear-anywhere");
  });

  it("mcp_tool_call 失败状态与 error 可见,成功 status 不刷屏", () => {
    const parse = createExecutorOutputParser("codex");
    const ok = completed({
      item_type: "mcp_tool_call",
      tool: "curl",
      status: "success",
      arguments: { url: "http://localhost:3001/api" },
    });
    const failed = completed({
      item_type: "mcp_tool_call",
      tool: "curl",
      status: "error",
      error: "connection refused",
      arguments: { url: "http://localhost:3001/api" },
    });
    expect(parse(`${ok}\n${failed}\n`)).toBe(
      "[工具] curl url\n[工具] curl url status=error error=connection refused\n",
    );
  });

  it("command_execution → [命令] 命令 + exit 码", () => {
    const parse = createExecutorOutputParser("codex");
    const line = completed({
      item_type: "command_execution",
      command: "git status --short",
      exit_code: 0,
    });
    const failLine = completed({
      item_type: "command_execution",
      command: "curl -sS http://localhost:3001/api",
      exit_code: 5,
    });
    const out = parse(`${line}\n${failLine}\n`);
    expect(out).toContain("[命令] git status --short exit 0");
    expect(out).toContain("[命令] curl -sS http://localhost:3001/api exit 5");
  });

  it("command_execution 折行命令压成单行,超长截断", () => {
    const parse = createExecutorOutputParser("codex");
    const line = completed({
      item_type: "command_execution",
      command: `printf "a\nb\nc" && ${"x".repeat(600)}`,
      exit_code: 0,
    });
    const rendered = parse(`${line}\n`).trim(); // 去掉行终止符
    expect(rendered).not.toContain("\n");
    expect(rendered).toContain("a b c"); // 折行已压成空格
    expect(rendered).toContain("exit 0");
  });

  it("agent_message → [汇报] 正文", () => {
    const parse = createExecutorOutputParser("codex");
    const line = completed({
      item_type: "agent_message",
      text: "Dispatch succeeded: child task 01a03d88 is running under AtomCode",
    });
    expect(parse(`${line}\n`)).toBe(
      "[汇报] Dispatch succeeded: child task 01a03d88 is running under AtomCode\n",
    );
  });
});

describe("codex:R3 解析不出的行逐字保留", () => {
  it("非法 JSON 原样保留", () => {
    const parse = createExecutorOutputParser("codex");
    const garbage = '{ "unterminated": tru';
    expect(parse(`${garbage}\n`)).toBe(`${garbage}\n`);
  });

  it("非 completed 事件(item.started / 其他 type)原样保留", () => {
    const parse = createExecutorOutputParser("codex");
    const started = JSON.stringify({
      type: "item.started",
      item: { item_type: "mcp_tool_call", tool: "read_file" },
    });
    const weird = JSON.stringify({ type: "some_future_event", payload: 1 });
    expect(parse(`${started}\n${weird}\n`)).toBe(`${started}\n${weird}\n`);
  });

  it("未知 item_type 原样保留", () => {
    const parse = createExecutorOutputParser("codex");
    const line = JSON.stringify({
      type: "item.completed",
      item: { item_type: "brand_new_item_kind", data: { a: 1 } },
    });
    expect(parse(`${line}\n`)).toBe(`${line}\n`);
  });

  it("item.completed 但 item 缺失 → 原样保留", () => {
    const parse = createExecutorOutputParser("codex");
    const line = JSON.stringify({ type: "item.completed" });
    expect(parse(`${line}\n`)).toBe(`${line}\n`);
  });

  it("跨 chunk 拼接后半截非法 JSON 原样保留(R3 回归)", () => {
    const parse = createExecutorOutputParser("codex");
    const garbage =
      '{"type":"item.completed","item":{"item_type":"mcp_tool_call","tool":"read_file","arguments":}}';
    const cut = 17; // 在词中间切开,与真实流式 chunk 一致
    expect(parse(garbage.slice(0, cut))).toBe("");
    expect(parse(`${garbage.slice(cut)}\n`)).toBe(`${garbage}\n`);
  });
});

describe("codex:流式跨 chunk", () => {
  it("JSONL 行被切成两半 → 拼接后渲染一次", () => {
    const parse = createExecutorOutputParser("codex");
    const line = JSON.stringify({
      type: "item.completed",
      item: { item_type: "agent_message", text: "half and half" },
    });
    const cut = Math.floor(line.length / 2);
    expect(parse(line.slice(0, cut))).toBe("");
    expect(parse(`${line.slice(cut)}\n`)).toBe("[汇报] half and half\n");
  });

  it("进程结束 flush 吐出未成行残留(逐字,R3)", () => {
    const parse = createExecutorOutputParser("codex");
    const partial = '{"type":"item.started"'; // 半截 JSONL 行(无结尾换行)
    expect(parse(partial)).toBe("");
    expect(parse.flush()).toBe(partial);
    expect(parse.flush()).toBe("");
  });
});

describe("atomcode:前缀行与未知行", () => {
  it("动作前缀行([tool→ / [tool← / [done])逐字保留,工具名与参数可见", () => {
    const parse = createExecutorOutputParser("executor");
    const input =
      '[tool→ read_file] {"file_path": "a.txt"}\n' +
      "[tool← ok] 19 chars\n" +
      "[done] 6.1s tokens=35.90K turns=2 tool_calls=1\n";
    expect(parse(input)).toBe(input);
  });

  it("中行内已知前缀([tokens] 等)拆到行首,内容逐字保留", () => {
    const parse = createExecutorOutputParser("atomcode");
    const out = parse(
      "[thinking] The user asks to read the file.[tokens] prompt=17916 completion=81 cached=6656\n",
    );
    expect(out).toBe(
      "[thinking] The user asks to read the file.\n[tokens] prompt=17916 completion=81 cached=6656\n",
    );
  });

  it("已知前缀与未知行原样保留(不过滤旁白)", () => {
    const parse = createExecutorOutputParser("executor");
    const input =
      "[headless] --dangerously-skip-permissions\n" +
      "[thinking] plain thinking line\n" +
      "任意一行没有前缀的旁白,原样保留\n" +
      '{ "not": "an action" }\n';
    expect(parse(input)).toBe(input);
  });

  it("行首已知前缀不重复拆行", () => {
    const parse = createExecutorOutputParser("executor");
    const line = "[tokens] prompt=1 cached=2\n";
    expect(parse(line)).toBe(line);
  });

  it("flush 无残留", () => {
    const parse = createExecutorOutputParser("executor");
    expect(parse('[tool→ read_file] {"file_path": "a.txt"}')).toBe(
      '[tool→ read_file] {"file_path": "a.txt"}',
    );
    expect(parse.flush()).toBe("");
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

  it("tool_use 块 → [工具] 工具名 + input 键名,不带 uuid/session_id/input 值", () => {
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
    const out = parse(`${line}\n`);
    expect(out).toBe("[工具] TaskCreate subject description activeForm\n");
    // input 的值(uuid 等)绝不进缓冲
    expect(out).not.toContain("6d8bda2d755d43829ed17aec797bbc23");
    expect(out).not.toContain("session_id");
    expect(out).not.toContain("Rewrite watchdog R4 to fail-closed");
  });

  it("text 块 → [汇报] 正文", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const line = codeBuddyAssistant([
      { type: "text", text: "I now have a clear picture. Key findings:" },
    ]);
    expect(parse(`${line}\n`)).toBe("[汇报] I now have a clear picture. Key findings:\n");
  });

  it("thinking 块 → 原样保留(已知块不丢)", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const line = codeBuddyAssistant([
      { type: "thinking", thinking: "Let me write the full new watchdog script.", signature: "" },
    ]);
    // thinking 是已知块:逐字保留(不压缩、不丢弃),与 R3 一致
    expect(parse(`${line}\n`)).toBe(`${line}\n`);
  });

  it("tool_result 块 → [工具] 工具名(按 tool_use_id 关联) + ok/error", () => {
    const parse = createExecutorOutputParser("codebuddy");
    // 先来一条 tool_use 记住 id → name 关联
    const use = codeBuddyAssistant([
      { type: "tool_use", id: "chatcmpl-tool-9e36eff5be9b5698", name: "TaskCreate", input: { subject: "x" } },
    ]);
    expect(parse(`${use}\n`)).toBe("[工具] TaskCreate subject\n");
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
    expect(parse(`${result}\n`)).toBe("[工具] TaskCreate ok Task #4 created successfully\n");
    // is_error → error 标记
    const failed = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "chatcmpl-tool-9e36eff5be9b5698", content: [{ type: "text", text: "connection refused" }], is_error: true },
        ],
      },
    });
    expect(parse(`${failed}\n`)).toBe("[工具] TaskCreate error connection refused\n");
  });

  it("system task_started(Bash) → [命令] description(命令可见)", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const line = JSON.stringify({
      type: "system",
      subtype: "task_started",
      task_id: "S7snnN",
      tool_use_id: "chatcmpl-tool-8a3aecdfdc9d5cbf",
      description: "cd /Users/apple/Projects/CoAgentHub && bash scripts/coagenthub-prod.sh cron-install 2>&1",
      task_type: "Bash",
      uuid: "66f9cfe2-b077-43da-8dd2-c99fb1ddfc26",
      session_id: "65d329c3-7f28-4266-8515-7e58b3b03b07",
      __timestamp: "2026-08-26T15:49:22.441Z",
      _requestId: "012f8f1c8fbc4916a45b43ab5fc731b2",
    });
    const out = parse(`${line}\n`);
    expect(out).toBe(
      "[命令] cd /Users/apple/Projects/CoAgentHub && bash scripts/coagenthub-prod.sh cron-install 2>&1\n",
    );
    expect(out).not.toContain("S7snnN");
    expect(out).not.toContain("66f9cfe2");
    expect(out).not.toContain("session_id");
  });

  it("result 事件 → [汇报] 最终正文", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Committed as `f333ad8f`. All tasks done. Here is my report.",
    });
    expect(parse(`${line}\n`)).toBe(
      "[汇报] Committed as `f333ad8f`. All tasks done. Here is my report.\n",
    );
  });
});

describe("codebuddy:R3 解析不出的行逐字保留", () => {
  it("非法 JSON 原样保留", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const garbage = '{ "unterminated": tru';
    expect(parse(`${garbage}\n`)).toBe(`${garbage}\n`);
  });

  it("非 JSON 行(旁白/告警)原样保留", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const plain = "plain text warning line\n";
    expect(parse(plain)).toBe(plain);
  });

  it("未知顶层 type 原样保留", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const line = JSON.stringify({ type: "brand_new_event", payload: { a: 1 } });
    expect(parse(`${line}\n`)).toBe(`${line}\n`);
  });

  it("未知 content block 原样保留", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const block = { type: "mystery_block", data: { x: 1 } };
    const line = codeBuddyAssistant([block]);
    expect(parse(`${line}\n`)).toBe(`${line}\n`);
  });

  it("file-history-snapshot 事件原样保留(不属于已知动作块)", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const line = JSON.stringify({
      type: "file-history-snapshot",
      id: "589ff847-97ca-49fb-98ab-0b070422e7e7",
      isSnapshotUpdate: true,
      snapshot: { messageId: "185fc335" },
    });
    expect(parse(`${line}\n`)).toBe(`${line}\n`);
  });
});

describe("codebuddy:流式跨 chunk", () => {
  it("JSONL 行被切成两半 → 拼接后渲染一次", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const line = codeBuddyAssistant([{ type: "text", text: "half and half" }]);
    const cut = Math.floor(line.length / 2);
    expect(parse(line.slice(0, cut))).toBe("");
    expect(parse(`${line.slice(cut)}\n`)).toBe("[汇报] half and half\n");
  });

  it("进程结束 flush 吐出未成行残留(逐字,R3)", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const partial = '{"type":"assistant"'; // 半截 JSONL 行(无结尾换行)
    expect(parse(partial)).toBe("");
    expect(parse.flush()).toBe(partial);
    expect(parse.flush()).toBe("");
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
          { type: "tool_use", id: `tool-${n}`, name: "coagenthub_get_task", input: { taskId: `01a03d8${n % 10}`, groupId: "01a03be2" } },
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
    const out = parse(`${input}\n`);
    expect(out).toContain("[工具] coagenthub_get_task taskId groupId");
    expect(out).toContain("[命令] coagenthub_get_task --task 1 --group 01a03be2");
    expect(out).toContain("[汇报] 提交: abc123");
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
      { type: "tool_use", id: "tool-1", name: "read_file", input: { file_path: "a.txt" } },
    ]);
    const b = codeBuddyAssistant([
      { type: "tool_use", id: "tool-2", name: "read_file", input: { file_path: "b.txt" } },
    ]);
    const c = codeBuddyAssistant([
      { type: "tool_use", id: "tool-3", name: "TaskCreate", input: { subject: "x" } },
    ]);
    expect(parse(`${a}\n${b}\n${c}\n`)).toBe(
      "[工具] read_file file_path\n[工具] TaskCreate subject\n",
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
    expect(parse(`${use}\n${result}\n`)).toBe(
      "[工具] Read file_path\n[工具] Read ok done\n",
    );
  });

  it("R3 透传行不被折叠:两条相同旁白都保留", () => {
    const parse = createExecutorOutputParser("codebuddy");
    const plain = "plain warning line\n";
    expect(parse(`${plain}${plain}`)).toBe(`${plain}${plain}`);
  });
});

describe("其他执行器:原样透传", () => {
  it("reasonix / win-hermes / 未知 key 不解析,创建时只记一次观测日志", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const key of ["reasonix", "win-hermes", "whatever"]) {
        const parse = createExecutorOutputParser(key);
        const input = 'plain line\n{"json": true}\n';
        expect(parse(input)).toBe(input);
        expect(parse.flush()).toBe("");
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
                item_type: "command_execution",
                command: `coagenthub_get_task --task ${n} --group 01a03be2`,
                exit_code: n % 8 === 0 ? 5 : 0,
              }
            : {
                item_type: "mcp_tool_call",
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

    const out = parse(`${input}\n`);
    // 压缩超过一个数量级(实测 262143 → 4909,1.9%)。
    expect(out.length).toBeLessThan(input.length / 10);
    // 动作行可见:工具调用、命令与 exit 码、汇报。
    expect(out).toContain("[工具] coagenthub_get_task");
    expect(out).toContain("exit 0");
    expect(out).toContain("exit 5");
    // 结果不含多层转义的任务书回显(brief 只存在于键名外的原始噪音中)。
    expect(out).not.toContain("brief");
    expect(out).not.toContain('\\"');
  });
});

/* ======================================================================
 * default 分支:通用语义解析器(spec: generic-executor-output-parsing)
 * ====================================================================== */

describe("default:通用解析器 R1 判定顺序(JSON 语义 → [前缀] → 逐字)", () => {
  it("JSON 语义提取优先:工具/正文渲染为动作行,信封字段不进缓冲", () => {
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
    const out = parse(`${line}\n`);
    expect(out).toContain("[工具] coagenthub_get_task");
    expect(out).toContain("[汇报] ok");
    expect(out).not.toContain("6d8bda2d");
    expect(out).not.toContain("taskId");
    expect(out).not.toContain("groupId");
  });

  it("error 字段可见,信封字段不渲染", () => {
    const parse = createExecutorOutputParser("reasonix");
    const line = JSON.stringify({
      tool: "curl",
      arguments: { url: "http://localhost:3001/api" },
      error: "connection refused",
      session_id: "s-1",
    });
    expect(parse(`${line}\n`)).toBe(
      "[工具] curl\n[汇报] error=connection refused\n",
    );
  });

  it("长文本值截断到阈值 + 省略号(R2)", () => {
    const parse = createExecutorOutputParser("reasonix");
    const line = JSON.stringify({ text: "x".repeat(600) });
    const out = parse(`${line}\n`).trim();
    expect(out.startsWith("[汇报] ")).toBe(true);
    expect(out.length).toBeLessThan(300);
    expect(out.endsWith("…")).toBe(true);
  });

  it("[前缀] 形式:前缀作为动作类型保留,正文可解析则压缩", () => {
    const parse = createExecutorOutputParser("whatever");
    const out = parse('[tool← ok] {"result": "done","uuid":"u1"}\n');
    expect(out).toBe("[tool← ok] [汇报] done\n");
  });

  it("[前缀] 行正文不是 JSON → 整行逐字保留", () => {
    const parse = createExecutorOutputParser("whatever");
    const line = "[tool→ read_file] 这不是 JSON,原样保留\n";
    expect(parse(line)).toBe(line);
  });

  it("[done] 这类纯前缀行逐字保留", () => {
    const parse = createExecutorOutputParser("whatever");
    const line = "[done] 6.1s tokens=35.90K\n";
    expect(parse(line)).toBe(line);
  });

  it("非 JSON 行与提取不出正文的 JSON 逐字保留", () => {
    const parse = createExecutorOutputParser("whatever");
    const input = '任意旁白,原样保留\n{"json": true}\n';
    expect(parse(input)).toBe(input);
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
    const out = parse(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    expect(out).toContain("[工具] read_file");
    expect(out).toContain("[汇报] file read ok");
    expect(out).not.toContain("6d8bda2d");
    expect(out).not.toContain("session_id");
  });

  it("hermes:命令行 → [命令],无会话噪音", () => {
    const parse = createExecutorOutputParser("hermes");
    const line = JSON.stringify({
      type: "command",
      session_id: "sess-hermes",
      command: "pnpm test --filter server",
      exit_code: 0,
    });
    const out = parse(`${line}\n`);
    expect(out).toContain("[命令] pnpm test --filter server");
    expect(out).not.toContain("sess-hermes");
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
    const out = parse(`${line}\n`);
    expect(out).toBe("[汇报] All tasks done, see report\n");
    expect(out).not.toContain("req-123");
  });
});

describe("default:R3 解析失败/结构不认识逐字保留", () => {
  it("非法 JSON 原样保留", () => {
    const parse = createExecutorOutputParser("whatever");
    const garbage = '{ "unterminated": tru';
    expect(parse(`${garbage}\n`)).toBe(`${garbage}\n`);
  });

  it("标量 JSON(字符串/数字/数组)原样保留", () => {
    const parse = createExecutorOutputParser("whatever");
    const input = '"just a string"\n123\n[1,2,3]\n';
    expect(parse(input)).toBe(input);
  });

  it("结构不认识(提取不出正文)原样保留", () => {
    const parse = createExecutorOutputParser("whatever");
    const line = JSON.stringify({ type: "brand_new_event", payload: { a: 1 } });
    expect(parse(`${line}\n`)).toBe(`${line}\n`);
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
    const out = parse(`${input}\n`);
    // 兜底:缓冲不顶满、压缩超一个数量级、动作行可见
    expect(out.length).toBeLessThan(262_143);
    expect(out.length).toBeLessThan(input.length / 10);
    expect(out).toContain("[工具] coagenthub_get_task");
    expect(out).toContain("[汇报]");
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
    const out = parse(`${input}\n`);
    // 兜底:缓冲不顶满、正文可见(tool_result 的长文本被截断压缩)
    expect(out.length).toBeLessThan(262_143);
    expect(out.length).toBeLessThan(input.length / 2);
    expect(out).toContain("[汇报]");
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
    expect(parse(line.slice(0, cut))).toBe("");
    expect(parse(`${line.slice(cut)}\n`)).toBe(
      "[工具] read_file\n[汇报] half and half\n",
    );
  });

  it("进程结束 flush 吐出未成行残留(逐字,R3)", () => {
    const parse = createExecutorOutputParser("whatever");
    const partial = '{"tool": "read_';
    expect(parse(partial)).toBe("");
    expect(parse.flush()).toBe(partial);
    expect(parse.flush()).toBe("");
  });
});
