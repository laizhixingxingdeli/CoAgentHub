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
 *  - codebuddy(--output-format stream-json):Claude Code 风格 JSONL。assistant
 *    内容块 tool_use → [工具](input 只取键名)、text → [汇报];user tool_result
 *    → [工具] 名 ok/error(按 tool_use_id 关联工具名);system.task_started →
 *    [命令];result → [汇报]。uuid/session_id/_requestId 等信封一律不进缓冲;
 *    同 chunk 内重复动作行折叠只留首条(R5,按来源区分工具调用与工具结果,
 *    调用与匹配结果互不折叠);解析失败/未知 type/未知块逐字保留。
 *  - 其他执行器(default):通用语义解析器(spec: generic-executor-output-parsing)。
 *    逐行判定:能 JSON.parse → 按字段语义递归「丢信封、留动作/正文/错误」并截断
 *    长值;匹配 [前缀] 形式 → 前缀作为动作类型保留,正文部分可解析则同样压缩;
 *    都不是 → 逐字保留。未知 executorKey 仍记一次观测日志(R5)。
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
 * 未知 executorKey 观测日志去重:只记一次,避免高吞吐时逐 chunk 刷屏。
 * 下一个新执行器接入即可立刻被发现,而不是等缓冲顶满才察觉(R4)。
 */
const observedUnknownExecutorKeys = new Set<string>();
function observeUnknownExecutorKey(executorKey: string): void {
  if (observedUnknownExecutorKeys.has(executorKey)) return;
  observedUnknownExecutorKeys.add(executorKey);
  console.warn(
    `[executor-output-parser] unknown executorKey=${executorKey}; falling back to generic heuristic parser (JSONL envelope fields dropped, rest kept verbatim).`,
  );
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

/** 通用解析器正文/工具/错误值的截断长度(R2:超阈值只保留前 N 字符 + 省略号)。 */
const MAX_GENERIC_TEXT_CHARS = 200;
/** 通用解析器递归深度上限:防畸形/恶意嵌套把栈打穿。 */
const MAX_GENERIC_DEPTH = 8;

/** 信封字段名(uuid/session_id/_requestId 等纯标识与遥测字段,逐字不进缓冲)。 */
const GENERIC_ENVELOPE_KEYS = new Set([
  "uuid",
  "session_id",
  "request_id",
  "_requestId",
  "parent_tool_use_id",
  "model",
  "usage",
  "stop_reason",
  "stop_sequence",
  "timestamp",
  "created_at",
  "updated_at",
]);

/**
 * 信封判定(R2):键名以 `_` 开头、或为纯 id 类(名为 id / *_id / *Id)、或为时间戳
 * 类(含 time/date)。必须**先于**动作/正文判定——tool_use_id 同时含 tool,不能
 * 误判成动作。通用启发,不见过的 agent 的 id/遥测字段同样被丢弃。
 */
function isEnvelopeKey(key: string): boolean {
  if (key.startsWith("_")) return true;
  if (GENERIC_ENVELOPE_KEYS.has(key)) return true;
  if (/id$/i.test(key)) return true;
  return /time|date/i.test(key);
}

/**
 * 动作/正文值的摘要(R2 保留清单):
 *  - 字符串 → 截断长值;
 *  - 数组 → 逐元素摘要后拼接;
 *  - 对象 → 参数键名(优先 name/tool 名,否则只取非信封键名,不渲染值——防
 *    任务书回显这类多层转义全文泄漏)。
 */
function genericValueSummary(value: unknown): string {
  if (typeof value === "string") return truncate(value, MAX_GENERIC_TEXT_CHARS);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((el) => genericValueSummary(el))
      .filter((s) => s.length > 0);
    return truncate(parts.join(" "), MAX_GENERIC_TEXT_CHARS);
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const name = record.name ?? record.tool ?? record.function;
    if (typeof name === "string" && name.length > 0) {
      return truncate(name, MAX_GENERIC_TEXT_CHARS);
    }
    const keys = Object.keys(record).filter((k) => !isEnvelopeKey(k));
    return truncate(keys.join(" "), MAX_GENERIC_TEXT_CHARS);
  }
  return "";
}

/**
 * 按字段语义递归提取动作/正文片段(R2,spec: generic-executor-output-parsing):
 *  - 动作:键名含 tool/function → [工具];含 command/cmd → [命令];
 *  - 错误:键名含 err 且值为字符串 → [汇报] error=…;
 *  - 正文:键名含 text/content/message/output/result → [汇报];对象/数组值
 *    (如 content 块数组)继续递归找正文,不把键名当正文渲染;
 *  - 信封:跳过;未分类对象/数组继续递归(动作可能藏在更深层);
 *  - 标量:跳过(不渲染,防噪音)。
 * 不做 agent 格式白名单——按字段语义即可让未见过的 agent 降级可用(R4)。
 */
function extractGenericFragments(node: unknown, depth: number): string[] {
  if (depth > MAX_GENERIC_DEPTH) return [];
  if (Array.isArray(node)) {
    const out: string[] = [];
    for (const el of node) out.push(...extractGenericFragments(el, depth + 1));
    return out;
  }
  if (typeof node !== "object" || node === null) return [];
  const fragments: string[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (isEnvelopeKey(key)) continue;
    const lk = key.toLowerCase();
    if (lk.includes("tool") || lk.includes("function")) {
      fragments.push(`[工具] ${genericValueSummary(value)}`);
    } else if (lk.includes("command") || lk.includes("cmd")) {
      fragments.push(`[命令] ${genericValueSummary(value)}`);
    } else if (lk.includes("err")) {
      // 布尔/对象错误标记不刷屏,只渲染字符串错误。
      if (typeof value === "string") {
        fragments.push(
          `[汇报] error=${truncate(value, MAX_GENERIC_TEXT_CHARS)}`,
        );
      }
    } else if (
      lk.includes("text") ||
      lk.includes("content") ||
      lk.includes("message") ||
      lk.includes("output") ||
      lk.includes("result")
    ) {
      if (typeof value === "object" && value !== null) {
        fragments.push(...extractGenericFragments(value, depth + 1));
      } else {
        fragments.push(`[汇报] ${genericValueSummary(value)}`);
      }
    } else if (typeof value === "object" && value !== null) {
      fragments.push(...extractGenericFragments(value, depth + 1));
    }
  }
  return fragments;
}

/** [前缀] 形式:行首的方括号标记(如 [tool→ read_file])作为动作类型保留。 */
const GENERIC_PREFIX_RE = /^\[([^\]]+)\](.*)$/;

/**
 * 渲染一条通用解析行(R1 三序判定):
 * 1. 能 JSON.parse → R2 通用提取,提取出片段则渲染动作行,否则逐字保留;
 * 2. 匹配 [前缀] 形式 → 前缀作为动作类型渲染(正文部分可解析则同样压缩);
 * 3. 都不是 → 逐字保留。
 * R3 硬要求:任何路径提取不出正文都逐字保留,绝不丢弃。
 */
function renderGenericLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    const m = GENERIC_PREFIX_RE.exec(line);
    if (m) return renderGenericPrefixLine(m[1], m[2], line);
    return line;
  }
  if (typeof parsed !== "object" || parsed === null) return line; // R3:标量 JSON
  const fragments = extractGenericFragments(parsed, 0);
  return fragments.length > 0 ? fragments.join("\n") : line; // R3:提取不出正文
}

/** [前缀] 行的渲染:前缀作为动作类型保留,正文若能解析出语义则压缩,否则整行逐字保留。 */
function renderGenericPrefixLine(
  prefix: string,
  rest: string,
  original: string,
): string {
  const trimmed = rest.trim();
  if (trimmed.length === 0) return original;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return original; // R3:前缀行正文不是 JSON → 逐字保留
  }
  if (typeof parsed !== "object" || parsed === null) return original;
  const fragments = extractGenericFragments(parsed, 0);
  return fragments.length > 0 ? `[${prefix}] ${fragments.join(" ")}` : original; // R3:提取不出语义 → 逐字保留
}

/** 通用解析器:行缓冲 + R1 三序判定;跨 chunk 半截行拼接,flush 吐残留。 */
function createGenericParser(): ExecutorOutputParser {
  let pending = "";
  const parser = ((chunk: string): string => {
    const lines = `${pending}${chunk ?? ""}`.split("\n");
    pending = lines.pop() ?? "";
    if (lines.length === 0) return "";
    return `${lines.map(renderGenericLine).join("\n")}\n`;
  }) as ExecutorOutputParser;
  parser.flush = () => {
    const tail = pending;
    pending = "";
    return tail.length > 0 ? renderGenericLine(tail) : "";
  };
  return parser;
}

/**
 * 从 user tool_result 的 content 抽取可见文本:content 为文本块数组时取 text
 * 字段拼接;为裸字符串时直接用。其余形态返回空串(不渲染全文,治 39.7% 噪音)。
 */
function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "object" && block !== null) {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") return text;
      }
      return "";
    })
    .filter((t) => t.length > 0)
    .join(" ");
}

/**
 * 渲染一条 codebuddy(--output-format stream-json)的 Claude Code 风格 JSONL 行。
 * 形状取自任务 01a03eb9 实跑:assistant 内容块(tool_use/text/thinking)、
 * user 内容块(tool_result)、system.task_started、result。
 *
 *  - tool_use    → [工具] 工具名 + 参数键名(不渲染 input 值,治 55.6% 噪音)
 *  - text        → [汇报] 正文
 *  - tool_result → [工具] 工具名(按 tool_use_id 关联)+ ok/error + 文本摘要
 *  - system.task_started(Bash) → [命令] description(命令可见)
 *  - result      → [汇报] 最终正文
 *
 * R3 硬要求:解析失败 / 非法 JSON / 未知顶层 type / 未知 content 块 / 非
 * tool_result 的用户块 → 整行逐字保留,绝不丢弃(宁可多显示)。
 * state 持有 tool_use_id → 工具名的跨行关联,由闭包持有。
 */
function renderCodeBuddyLine(
  line: string,
  state: { toolNameByUseId: Map<string, string> },
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line; // R3:非法/非 JSON 逐字保留
  }
  if (typeof parsed !== "object" || parsed === null) return line;
  const record = parsed as Record<string, unknown>;

  switch (record.type) {
    case "assistant": {
      const message = record.message;
      const content =
        message && typeof message === "object"
          ? (message as Record<string, unknown>).content
          : undefined;
      if (!Array.isArray(content)) return line; // R3:结构不认识 → 原样保留
      const parts: string[] = [];
      for (const blockRaw of content) {
        if (typeof blockRaw !== "object" || blockRaw === null) return line;
        const block = blockRaw as Record<string, unknown>;
        if (block.type === "tool_use") {
          const name = typeof block.name === "string" ? block.name : "?";
          const useId = typeof block.id === "string" ? block.id : undefined;
          if (useId) state.toolNameByUseId.set(useId, name);
          const argKeys = compactArgKeys(block.input);
          parts.push(argKeys ? `[工具] ${name} ${argKeys}` : `[工具] ${name}`);
        } else if (block.type === "text") {
          const text = typeof block.text === "string" ? block.text : "";
          parts.push(`[汇报] ${text}`);
        } else {
          // thinking / 未知块:逐字保留整行(R3)
          return line;
        }
      }
      return parts.join("\n");
    }
    case "user": {
      const message = record.message;
      const content =
        message && typeof message === "object"
          ? (message as Record<string, unknown>).content
          : undefined;
      if (!Array.isArray(content)) return line; // R3:无 content → 原样保留
      const parts: string[] = [];
      for (const blockRaw of content) {
        if (typeof blockRaw !== "object" || blockRaw === null) return line;
        const block = blockRaw as Record<string, unknown>;
        if (block.type === "tool_result") {
          const useId =
            typeof block.tool_use_id === "string"
              ? block.tool_use_id
              : undefined;
          const name =
            (useId && state.toolNameByUseId.get(useId)) || useId || "?";
          const isError = block.is_error === true;
          const text = extractToolResultText(block.content);
          parts.push(
            `[工具] ${name} ${isError ? "error" : "ok"}${text ? ` ${text}` : ""}`,
          );
        } else {
          // 非 tool_result 块(如人类消息正文)→ 整行逐字保留(R3)
          return line;
        }
      }
      return parts.join("\n");
    }
    case "system": {
      if (
        record.subtype === "task_started" &&
        typeof record.description === "string"
      ) {
        return `[命令] ${record.description}`;
      }
      return line; // R3:其他 system 子类型(已知噪音)逐字保留
    }
    case "result": {
      if (typeof record.result === "string") return `[汇报] ${record.result}`;
      return line; // R3:result 无正文 → 原样保留
    }
    default:
      return line; // R3:未知顶层 type 逐字保留
  }
}

/**
 * 来源行动作类别:assistant 行渲染工具调用(call)、user 行渲染工具结果
 * (result);其余类型(含无法解析的行)返回 undefined,折叠键不追加类别。
 * 折叠键必须按来源区分:同 chunk 内 tool_use 与其匹配的 tool_result 渲染
 * 文本前缀相同(如 [工具] Read file_path 与 [工具] Read ok done),只按
 * 工具名取键会把结果误判为重复调用而静默吞掉(ticket 01a03f35 回归)。
 */
function lineActionKind(line: string): "call" | "result" | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const type = (parsed as Record<string, unknown>).type;
  return type === "assistant" ? "call" : type === "user" ? "result" : undefined;
}

/**
 * 动作行折叠键(R5 压缩比):同 chunk 内同一(标记, 工具/命令名, 动作类别)的
 * 重复动作行只保留首条——同一工具被反复调用时实时输出不必刷屏 40 遍。整行
 * 文本也参与去重(如 [汇报] 完全相同的正文)。透传行(R3)不进本函数、永不折叠。
 */
function actionDedupKey(rendered: string, kind?: "call" | "result"): string {
  const m = /^\[(工具|命令)\] (\S+)/.exec(rendered);
  if (!m) return rendered;
  return kind ? `${m[1]}|${m[2]}|${kind}` : `${m[1]}|${m[2]}`;
}

/** codebuddy:行缓冲 + 渲染动作行;其余逐字保留(R3)。跨行状态由闭包持有。 */
function createCodeBuddyParser(): ExecutorOutputParser {
  let pending = "";
  const state: { toolNameByUseId: Map<string, string> } = {
    toolNameByUseId: new Map(),
  };
  const parser = ((chunk: string): string => {
    const lines = `${pending}${chunk ?? ""}`.split("\n");
    pending = lines.pop() ?? "";
    if (lines.length === 0) return "";
    const seen = new Set<string>();
    const out: string[] = [];
    for (const l of lines) {
      const rendered = renderCodeBuddyLine(l, state);
      if (rendered !== l) {
        // R5:折叠同 chunk 内的重复动作行;R3 透传行不参与、逐字保留。
        // 折叠键按来源区分调用/结果,同 chunk 的 tool_use + tool_result 不互吞。
        const key = actionDedupKey(rendered, lineActionKind(l));
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(rendered);
    }
    return `${out.join("\n")}\n`;
  }) as ExecutorOutputParser;
  parser.flush = () => {
    const tail = pending;
    pending = "";
    return tail.length > 0 ? renderCodeBuddyLine(tail, state) : "";
  };
  return parser;
}

/**
 * 按 executorKey 创建流式输出解析器(每次执行一个;跨 chunk 状态由闭包持有,
 * 与 createAnsiStripper 同款)。codex / codebuddy 解析 JSONL 动作行,atomcode
 * 拆粘连前缀,其余执行器(default)走通用语义解析器(spec:
 * generic-executor-output-parsing)——按字段语义丢信封、留动作/正文,保证新增
 * agent 的 JSONL 输出不会顶满缓冲;未知 key 仍记一次观测日志(R5)。
 */
export function createExecutorOutputParser(
  executorKey: string,
): ExecutorOutputParser {
  switch (executorKey) {
    case "codex":
      return createCodexParser();
    case "codebuddy":
      return createCodeBuddyParser();
    case "atomcode":
    case "executor":
      return createAtomCodeParser();
    default:
      observeUnknownExecutorKey(executorKey);
      return createGenericParser();
  }
}
