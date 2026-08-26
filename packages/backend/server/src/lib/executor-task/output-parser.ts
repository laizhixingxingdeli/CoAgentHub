/**
 * 执行器输出解析(实时输出动作行,spec: live-output-shows-narration-not-actions):
 * 在执行器输出进入 task 缓冲前按 executorKey 把「动作」从噪音里解析出来,让
 * 实时输出显示 agent 实际调用的工具/命令/汇报,而不是被 JSONL 噪音埋住。
 *
 *  - codex(exec --json):行缓冲拼接跨 chunk 的 JSONL 行,只渲染
 *    type == "item.completed" 事件为 [工具]/[命令]/[汇报] 动作行;不渲染
 *    arguments/result 全文(那正是 65% 噪音的来源)。其余 JSONL 事件、非法
 *    JSON、未知 item_type 一律逐字保留。
 *  - atomcode(-v):动作行本身已紧凑([tool→ name] {args} 等),逐字保留;
 *    只把粘连在中行内的已知前缀(如 `…read the file.[tokens] prompt=…`)
 *    拆到行首,治「多句粘成一段」。未知行逐字保留。
 *  - 其他执行器:原样透传。
 *
 * R3 是硬要求:任何一行解析失败/前缀不认识/格式变了 → 原样进缓冲,不丢弃。
 * 宁可多显示,不可静默吞掉。
 */

/** 单参数键名列表的最大字符数。 */
const MAX_ARGS_CHARS = 240;
/** mcp_tool_call error 字段的最大字符数。 */
const MAX_ERROR_CHARS = 200;
/** command_execution 命令的最大字符数(折行命令压成单行后截断)。 */
const MAX_COMMAND_CHARS = 400;

/** AtomCode stderr 的已知前缀(实跑 2026-08-26 确认,含尾随空格)。 */
const ATOMCODE_PREFIX_MARKERS = [
  "[tool→ ",
  "[tool← ",
  "[done] ",
  "[tokens] ",
  "[thinking] ",
  "[headless] ",
] as const;

/** 截断到 N 字符,超长加省略号。 */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * arguments 键名压缩:只取参数键名、不渲染值——从根上杜绝 arguments/result
 * 全文泄漏(65% 噪音来源就是值里多层转义的任务书回显);非对象 arguments
 * (纯字符串/数组/原始值)不渲染。
 */
function compactArgKeys(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return "";
  }
  return truncate(Object.keys(args).join(" "), MAX_ARGS_CHARS);
}

/** mcp_tool_call:只取 tool/status/error + arguments 键名,不带 result 全文。 */
function renderToolCall(item: Record<string, unknown>): string {
  const parts = [`[工具] ${String(item.tool ?? "?")}`];
  const argKeys = compactArgKeys(item.arguments);
  if (argKeys) parts.push(argKeys);
  const status = item.status;
  if (status !== undefined && status !== null && String(status) !== "success") {
    parts.push(`status=${String(status)}`);
  }
  const error = item.error;
  if (error !== undefined && error !== null && String(error) !== "") {
    parts.push(`error=${truncate(String(error), MAX_ERROR_CHARS)}`);
  }
  return parts.join(" ");
}

/** command_execution:命令(压单行截断)+ exit 码。 */
function renderCommand(item: Record<string, unknown>): string {
  const command = String(item.command ?? "?")
    .replace(/\s+/g, " ")
    .trim();
  const exit =
    item.exit_code === undefined || item.exit_code === null
      ? "?"
      : String(item.exit_code);
  return `[命令] ${truncate(command, MAX_COMMAND_CHARS)} exit ${exit}`;
}

/** agent_message:汇报正文(本身就是动作,保留全文)。 */
function renderAgentMessage(item: Record<string, unknown>): string {
  return `[汇报] ${String(item.text ?? "").trim()}`;
}

/**
 * 渲染一条 codex JSONL 行:只处理 type == "item.completed" 的三类 item;
 * 其余(非法 JSON、其他 type、未知 item_type)返回 null → 调用方逐字保留。
 */
function renderCodexLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line; // R3:非法 JSON 逐字保留
  }
  if (typeof parsed !== "object" || parsed === null) return line;
  const record = parsed as Record<string, unknown>;
  if (record.type !== "item.completed") return line; // R3:非 completed 事件逐字保留
  const item = record.item;
  if (typeof item !== "object" || item === null) return line;
  switch ((item as Record<string, unknown>).item_type) {
    case "mcp_tool_call":
      return renderToolCall(item as Record<string, unknown>);
    case "command_execution":
      return renderCommand(item as Record<string, unknown>);
    case "agent_message":
      return renderAgentMessage(item as Record<string, unknown>);
    default:
      return line; // R3:未知 item_type 逐字保留
  }
}

/**
 * 把出现在中行(前面不是换行)的 AtomCode 已知前缀拆到行首:治
 * `…read the file.[tokens] prompt=…` 这类句与句粘连。行首已有的前缀与
 * 未知行不受影响,内容逐字保留。
 */
function splitMidLinePrefixes(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const atLineStart = i === 0 || text[i - 1] === "\n";
    const marker = atLineStart
      ? undefined
      : ATOMCODE_PREFIX_MARKERS.find((m) => text.startsWith(m, i));
    if (marker) {
      out += `\n${marker}`;
      i += marker.length;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/** 流式解析器:可调用(喂 chunk)+ flush(进程结束时吐出残留,逐字)。 */
export interface ExecutorOutputParser {
  (chunk: string): string;
  /** 进程结束时吐出尚未成行的残留(逐字),保证 R3 不丢任何一行。 */
  flush(): string;
}

/** codex:行缓冲 + 渲染 item.completed;其余逐字保留。 */
function createCodexParser(): ExecutorOutputParser {
  let pending = "";
  const parser = ((chunk: string): string => {
    const lines = `${pending}${chunk ?? ""}`.split("\n");
    pending = lines.pop() ?? "";
    if (lines.length === 0) return "";
    const rendered = lines.map(renderCodexLine).join("\n");
    return `${rendered}\n`;
  }) as ExecutorOutputParser;
  parser.flush = () => {
    const tail = pending;
    pending = "";
    return tail.length > 0 ? renderCodexLine(tail) : "";
  };
  return parser;
}

/** atomcode:无缓冲,只做中行前缀拆行,内容逐字保留。 */
function createAtomCodeParser(): ExecutorOutputParser {
  const parser = ((chunk: string): string =>
    splitMidLinePrefixes(chunk ?? "")) as ExecutorOutputParser;
  parser.flush = () => "";
  return parser;
}

/** 其他执行器:原样透传。 */
function createIdentityParser(): ExecutorOutputParser {
  const parser = ((chunk: string): string =>
    chunk ?? "") as ExecutorOutputParser;
  parser.flush = () => "";
  return parser;
}

/**
 * 按 executorKey 创建流式输出解析器(每次执行一个;跨 chunk 状态由闭包持有,
 * 与 createAnsiStripper 同款)。codex 解析 JSONL 动作行,atomcode 拆粘连前缀,
 * 其余执行器原样透传。
 */
export function createExecutorOutputParser(
  executorKey: string,
): ExecutorOutputParser {
  switch (executorKey) {
    case "codex":
      return createCodexParser();
    case "atomcode":
    case "executor":
      return createAtomCodeParser();
    default:
      return createIdentityParser();
  }
}
