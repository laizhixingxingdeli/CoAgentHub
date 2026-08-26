import { createExecutorOutputParser } from "@server/lib/executor-task";
import { describe, expect, it } from "vitest";

/**
 * 执行器输出解析器(output-parser.ts,spec: live-output-shows-narration-not-actions):
 *  - codex(exec --json):只渲染 type == "item.completed" 的三类 item 为
 *    [工具]/[命令]/[汇报] 动作行,不输出 arguments/result 全文;非法 JSON、
 *    非 completed 事件、未知 item_type 逐字保留;跨 chunk 半截行拼接;
 *    进程结束时 flush 吐出未成行残留。
 *  - atomcode(-v):动作前缀行与未知行逐字保留;中行内已知前缀拆到行首
 *    (治多句粘成一段,内容不丢)。
 *  - 其他执行器:原样透传。
 *  - R5:262143 字节基线夹具压缩超过一个数量级,且不含多层转义 brief 回显。
 */

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

describe("其他执行器:原样透传", () => {
  it("reasonix / codebuddy / 未知 key 不解析", () => {
    for (const key of ["reasonix", "codebuddy", "win-hermes", "whatever"]) {
      const parse = createExecutorOutputParser(key);
      const input = 'plain line\n{"json": true}\n';
      expect(parse(input)).toBe(input);
      expect(parse.flush()).toBe("");
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
