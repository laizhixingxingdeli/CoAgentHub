/**
 * 执行器输出解析(实时输出动作行,spec: live-output-shows-narration-not-actions +
 * two-tier-output-summary-and-detail):在执行器输出进入 task 缓冲前按 executorKey
 * 把「动作」从噪音里解析出来,让实时输出显示 agent 实际调用的工具/命令/汇报,
 * 而不是被 JSONL 噪音埋住。
 *
 * 两层级输出(spec: two-tier-output-summary-and-detail,R1-R7):
 *  - 解析器产出**结构化条目**(OutputEntry:id/kind/summary/detail),不再是纯字符串;
 *  - summary 一行,进摘要流(环形缓冲,上限 1000 行 / 256KB 不变);既有渲染口径
 *    ([工具]/[命令]/[汇报])保持不变,只是多带 #id(如 `[工具 #t3]`),供展开 API 引用;
 *  - detail 可选完整原文,进明细存储(磁盘 JSONL,R4)——不驻留内存、不进 diffSummary;
 *  - R2:thinking 摘要取首句要旨,绝不取字数统计;
 *  - R3:thinking / 工具结果全文 / 命令输出全文 / 超长参数值 → 折叠(summary 一行 +
 *    detail 全文);工具名 + 参数键名 / 命令行本身 / 简短汇报 → 仅摘要;
 *    ⚠️ 错误信息永不折叠 —— 全文留在摘要流;
 *  - R7:解析失败 / 结构不认识的行仍逐字保留(raw 条目,不带 #id,字节不变);
 *    未知 executorKey 仍走通用解析器并只记一次观测日志。
 *
 *  - codex(exec --json):行缓冲拼接跨 chunk 的 JSONL 行,只渲染
 *    type == "item.completed" 事件为 [工具]/[命令]/[汇报] 动作行;不渲染
 *    arguments/result 全文(那正是 65% 噪音的来源),全文进明细(detail)。
 *    其余 JSONL 事件、非法 JSON、未知 item type 值一律逐字保留(raw)。
 *  - atomcode(-v):动作行本身已紧凑([tool→ name] {args} 等),摘要逐字保留 +
 *    #id;只把粘连在中行内的已知前缀(如 `…read the file.[tokens] prompt=…`)
 *    拆到行首,治「多句粘成一段」;[thinking] 行折叠为 [思考 #id] 要旨 +
 *    明细全文;[tokens] 账目行与裸叙述行(无前缀正文)结构化识别后摘要抑制
 *    (走 thinking 通道:摘要不进流、全文进明细,按 #tN/detail 可取回);
 *    [done]/[headless]/未知结构逐字保留(raw)。
 *  - codebuddy(--output-format stream-json):Claude Code 风格 JSONL。assistant
 *    内容块 tool_use → [工具](input 只取键名,全文进明细)、text → [汇报]、
 *    thinking → [思考] 要旨 + 明细全文;user tool_result → [工具] 名 ok/error
 *    (按 tool_use_id 关联工具名,全文进明细,error 不折叠);system.task_started
 *    → [命令];result → [汇报]。uuid/session_id/_requestId 等信封一律不进缓冲;
 *    同 chunk 内重复动作行折叠只留首条(R5,按来源区分工具调用与工具结果,
 *    调用与匹配结果互不折叠);解析失败/未知 type/未知块逐字保留(raw)。
 *  - 其他执行器(default):通用语义解析器(spec: generic-executor-output-parsing)。
 *    逐行判定:能 JSON.parse → 按字段语义递归「丢信封、留动作/正文/错误」并截断
 *    长值(全文整行进明细);匹配 [前缀] 形式 → 前缀作为动作类型保留,正文部分可
 *    解析则同样压缩;都不是 → 逐字保留(raw)。usage/cost/price/pricing/billing/
 *    tokens 大小写不敏感视为信封,文本族键仅字符串渲染,数字/布尔等账目标量不再
 *    刷屏;同 chunk 重复动作行折叠只留首条(R5,按来源区分调用/结果,错误永不
 *    折叠);未知 executorKey 仍记一次观测日志。
 *
 * R3 是硬要求:任何一行解析失败/前缀不认识/格式变了 → 原样进缓冲,不丢弃。
 * 宁可多显示,不可静默吞掉。
 */

/** 单参数键名列表的最大字符数。 */
const MAX_ARGS_CHARS = 240;
/** command_execution 命令的最大字符数(折行命令压成单行后截断)。 */
const MAX_COMMAND_CHARS = 400;
/** 通用解析器正文/工具/错误值的截断长度(R2:超阈值只保留前 N 字符 + 省略号)。 */
const MAX_GENERIC_TEXT_CHARS = 200;
/** 通用解析器递归深度上限:防畸形/恶意嵌套把栈打穿。 */
const MAX_GENERIC_DEPTH = 8;
/** R2:thinking 摘要取首句要旨的最大字符数(截断加省略号)。 */
const MAX_THINKING_SUMMARY_CHARS = 120;
/** R3:工具结果摘要的最大字符数(全文进明细)。 */
const MAX_TOOL_RESULT_SUMMARY_CHARS = 160;
/** R3:atomcode 超长工具行(超长参数值)折叠阈值,超过则摘要截断 + 全文进明细。 */
const MAX_FOLDED_LINE_CHARS = 400;

/** AtomCode stderr 的已知前缀(实跑 2026-08-26 确认,含尾随空格)。 */
const ATOMCODE_PREFIX_MARKERS = [
  "[tool→ ",
  "[tool← ",
  "[done] ",
  "[tokens] ",
  "[thinking] ",
  "[headless] ",
] as const;

/** 结构化条目的类别(spec two-tier-output-summary-and-detail R1)。 */
export type OutputEntryKind =
  | "thinking"
  | "tool"
  | "command"
  | "result"
  | "report"
  | "error"
  | "raw";

/** 解析器产出的结构化条目:一行摘要进摘要流,#id 供展开 API 引用;detail 进明细存储。 */
export interface OutputEntry {
  /** 任务内单调递增的短标识(如 t7),供展开 API 引用。 */
  id: string;
  /** 类别:thinking / tool / command / result / report / error / raw。 */
  kind: OutputEntryKind;
  /** 一行摘要,进摘要流;既有渲染口径([工具]/[命令]/[汇报])+ #id。 */
  summary: string;
  /** 可选完整原文,进明细存储(磁盘 JSONL,R4);raw 条目无明细不落盘。 */
  detail?: string;
}

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
 * R4:codex 已知冗余事件的跳过观测 —— 计数 + 去重日志(spec:
 * codex-known-events-leak-as-raw)。签名如 `item.started/mcp_tool_call`、
 * `thread.started`;计数按签名累加,日志只对每种签名记一次(去重),避免高吞吐
 * 下逐 chunk 刷屏;便于确认跳过的是预期的那些,而不是悄悄吞掉了别的东西。
 */
const codexSkippedEventCounts = new Map<string, number>();
const observedCodexSkippedSignatures = new Set<string>();
function observeCodexSkippedEvent(signature: string): void {
  const count = (codexSkippedEventCounts.get(signature) ?? 0) + 1;
  codexSkippedEventCounts.set(signature, count);
  if (observedCodexSkippedSignatures.has(signature)) return;
  observedCodexSkippedSignatures.add(signature);
  console.warn(
    `[executor-output-parser] codex known redundant event skipped: ${signature} (count so far: ${count}); info is covered by a later item.completed, dropped from summary (R1).`,
  );
}

/** R4 可观测性:当前 codex 跳过计数快照(按事件签名),供采样统计与测试断言。 */
export function getCodexSkippedEventCounts(): Readonly<Record<string, number>> {
  return Object.fromEntries(codexSkippedEventCounts);
}

/** R4 可观测性:重置 codex 跳过计数(测试隔离用,生产无需调用)。 */
export function resetCodexSkippedEventCounts(): void {
  codexSkippedEventCounts.clear();
  observedCodexSkippedSignatures.clear();
}

/**
 * L2:通用解析器跳过观测 —— 可解析但无语义的 JSON(全信封/分类/增量字段)显式
 * 跳过,计数按签名累加、日志只对每种签名记一次,避免高吞吐下逐 chunk 刷屏;
 * 便于确认跳过的是预期的噪音(message_update/tool_call_delta…),而不是悄悄吞掉
 * 了别的内容。签名取 `type` 字段值,无 type 时按顶层键排序拼接。
 */
const genericSkippedEventCounts = new Map<string, number>();
const observedGenericSkippedSignatures = new Set<string>();
/** 通用跳过观测(供 queue.ts 共享摘要边界调用,如空摘要过滤)。 */
export function observeGenericSkippedEvent(signature: string): void {
  const count = (genericSkippedEventCounts.get(signature) ?? 0) + 1;
  genericSkippedEventCounts.set(signature, count);
  if (observedGenericSkippedSignatures.has(signature)) return;
  observedGenericSkippedSignatures.add(signature);
  console.warn(
    `[executor-output-parser] generic no-info JSON skipped: ${signature} (count so far: ${count}); parseable but semantically empty, dropped from summary (L2).`,
  );
}

/** L2 可观测性:通用跳过计数快照(按签名),供采样统计与测试断言。 */
export function getGenericSkippedEventCounts(): Readonly<
  Record<string, number>
> {
  return Object.fromEntries(genericSkippedEventCounts);
}

/** L2 可观测性:重置通用跳过计数(测试隔离用,生产无需调用)。 */
export function resetGenericSkippedEventCounts(): void {
  genericSkippedEventCounts.clear();
  observedGenericSkippedSignatures.clear();
}

/**
 * 结构化条目工厂(每次执行一个):分配任务内单调递增的短 id(t1, t2, …),
 * 把 #id 注入行首 [标签] 形式(如 `[工具] x` → `[工具 #t3] x`);raw 透传条目
 * 不加 #id,保证 R7 逐字保留。
 */
function createEntryMaker() {
  let seq = 0;
  const withId = (summary: string, id: string): string => {
    const m = /^(\[[^\]]*\])(.*)$/s.exec(summary);
    if (!m) return summary;
    return `${m[1].slice(0, -1)} #${id}]${m[2]}`;
  };
  return {
    entry(
      kind: OutputEntryKind,
      summary: string,
      detail?: string,
    ): OutputEntry {
      const id = `t${(seq += 1)}`;
      return {
        id,
        kind,
        summary: withId(summary, id),
        ...(detail ? { detail } : {}),
      };
    },
    raw(line: string): OutputEntry {
      return { id: `t${(seq += 1)}`, kind: "raw", summary: line };
    },
  };
}

/** 明细原文提取:字符串直接取;对象/数组 JSON 序列化(完整原文);其余为空。 */
function detailText(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (value !== null && typeof value === "object") {
    const s = JSON.stringify(value);
    return s ? s : undefined;
  }
  return undefined;
}

/**
 * R2:thinking 摘要取要旨 —— 取首句(。.!?;… 截止)或前 N 字并截断,
 * 绝不输出「N 段,共 M 字」这类字数统计。
 */
function thinkingSummary(text: string): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length === 0) return "";
  const firstSentence = /^.*?[。.!?;…]/.exec(clean)?.[0] ?? clean;
  return truncate(firstSentence.trim(), MAX_THINKING_SUMMARY_CHARS);
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
    // R3:错误信息永不折叠,全文留在摘要流(不截断)。
    parts.push(`error=${String(error)}`);
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

/** R2:错误信息提取 —— 字符串直取;对象取 message/error 字段;其余序列化兜底。 */
function codexErrorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.message === "string" && rec.message.length > 0) {
      return rec.message;
    }
    if (typeof rec.error === "string" && rec.error.length > 0) {
      return rec.error;
    }
    const s = JSON.stringify(value);
    return s ? s : "";
  }
  return value === undefined || value === null ? "" : String(value);
}

/** R1:item.started 的跳过签名取 item.type(无 item 时为 ?)。 */
function codexItemTypeOf(item: unknown): string {
  if (typeof item === "object" && item !== null) {
    const t = (item as Record<string, unknown>).type;
    if (typeof t === "string" && t.length > 0) return t;
  }
  return "?";
}

/**
 * R1:codex 已知冗余事件类型 —— 显式识别后跳过,不产出任何条目。
 * item.started(信息被随后的 item.completed 完全覆盖)、会话生命周期事件。
 * ⚠️ 必须是显式识别后跳过,不得靠「匹配不上就丢弃」——那会把真正的未知
 * 格式也一起吞掉(spec: codex-known-events-leak-as-raw R1)。
 */
const CODEX_REDUNDANT_EVENT_TYPES = new Set([
  "item.started",
  "thread.started",
  "turn.started",
  "turn.completed",
]);

/**
 * 渲染一条 codex JSONL 行:
 *  - R1:已知冗余事件(item.started / thread.started / turn.started /
 *    turn.completed)显式识别后跳过,不产出条目,并计数 + 去重日志(R4);
 *  - R2:顶层 error 与 item.completed/error 渲染为不折叠的 [错误] <message>;
 *  - R3:非法 JSON、未知顶层 type、未知 item type 值逐字保留(raw 透传)。
 */
function renderCodexLine(
  line: string,
  entry: ReturnType<typeof createEntryMaker>["entry"],
  raw: ReturnType<typeof createEntryMaker>["raw"],
): OutputEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [raw(line)]; // R3:非法 JSON 逐字保留
  }
  if (typeof parsed !== "object" || parsed === null) return [raw(line)];
  const record = parsed as Record<string, unknown>;
  const type = record.type;
  // R1:显式识别已知冗余事件后跳过(不是「匹配不上就丢弃」)。
  if (typeof type === "string" && CODEX_REDUNDANT_EVENT_TYPES.has(type)) {
    const signature =
      type === "item.started"
        ? `item.started/${codexItemTypeOf(record.item)}`
        : type;
    observeCodexSkippedEvent(signature);
    return [];
  }
  // R2:顶层错误事件 → [错误] <message>,错误永不折叠(全文在摘要,不进明细)。
  if (type === "error") {
    const message = codexErrorMessage(record.message ?? record.error);
    if (message.length > 0) return [entry("error", `[错误] ${message}`)];
    return [raw(line)]; // R3:无 message/error 的 error 形状不认识 → 逐字保留
  }
  if (type !== "item.completed") return [raw(line)]; // R3:未知顶层 type 逐字保留
  const item = record.item;
  if (typeof item !== "object" || item === null) return [raw(line)];
  const it = item as Record<string, unknown>;
  // codex 真实协议:item 的类型字段是 type(实测 item.completed 的
  // command_execution/mcp_tool_call/agent_message 均带 item.type),不是 item_type。
  switch (it.type) {
    case "error": {
      // R2:item.completed/error → [错误] <message>,错误永不折叠。
      const message = codexErrorMessage(it.error ?? it.message);
      if (message.length > 0) return [entry("error", `[错误] ${message}`)];
      return [raw(line)]; // R3:无错误信息的 error item → 逐字保留
    }
    case "mcp_tool_call": {
      const hasError =
        it.status === "error" ||
        (it.error !== undefined &&
          it.error !== null &&
          String(it.error) !== "");
      return [
        entry(
          hasError ? "error" : "tool",
          renderToolCall(it),
          detailText(it.result), // R3:工具结果全文进明细
        ),
      ];
    }
    case "command_execution":
      return [
        entry(
          "command",
          renderCommand(it),
          // R3:命令输出全文进明细;codex 真实协议输出字段是 aggregated_output
          // (实测 item.completed 行),output/result 仅为旧格式兜底。
          detailText(it.aggregated_output ?? it.output ?? it.result),
        ),
      ];
    case "agent_message":
      return [entry("report", renderAgentMessage(it))];
    default:
      return [raw(line)]; // R3:未知 item type 值逐字保留
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

/** 流式解析器:可调用(喂 chunk,来源可选)+ flush(进程结束时吐出残留,逐字)。 */
export interface ExecutorOutputParser {
  (chunk: string, source?: "stdout" | "stderr"): OutputEntry[];
  /** 进程结束时吐出尚未成行的残留(逐字),保证 R3 不丢任何一行。 */
  flush(source?: "stdout" | "stderr"): OutputEntry[];
}

/** codex:行缓冲 + 渲染 item.completed / 显式跳过已知冗余事件 / 逐字兜底。 */
function createCodexParser(): ExecutorOutputParser {
  let pending = "";
  const { entry, raw } = createEntryMaker();
  const parser = ((chunk: string): OutputEntry[] => {
    const lines = `${pending}${chunk ?? ""}`.split("\n");
    pending = lines.pop() ?? "";
    if (lines.length === 0) return [];
    return lines.flatMap((l) => renderCodexLine(l, entry, raw));
  }) as ExecutorOutputParser;
  parser.flush = () => {
    const tail = pending;
    pending = "";
    return tail.length > 0 ? renderCodexLine(tail, entry, raw) : [];
  };
  return parser;
}

/**
 * 渲染一条 atomcode 输出行(两层级 + R2 来源):来自 stdout 的非空行判为 report
 * (进界面);来自 stderr 的行维持现有判定。判据来源是执行器免费给出的事实
 * (stdout/stderr),代替首字符猜测;stderr 侧的首字符判据在 stdout 场景下
 * 不成立(反引号开头被误判为 thinking)。
 */
function renderAtomCodeLine(
  line: string,
  entry: ReturnType<typeof createEntryMaker>["entry"],
  raw: ReturnType<typeof createEntryMaker>["raw"],
  source?: "stdout" | "stderr",
): OutputEntry {
  // R2.2:来自 stdout 的非空行判为 report(进界面),来源可代替结构猜测。
  if (source === "stdout") {
    const trimmed = line.trim();
    if (trimmed.length === 0) return raw(line);
    return entry("report", `[汇报] ${trimmed}`, line);
  }
  const thinking = /^\[thinking\]\s*(.*)$/.exec(line);
  if (thinking) {
    const full = thinking[1].trim();
    const gist = thinkingSummary(full);
    // 空内容行按 raw 逐字保留(无要旨可折叠)。
    return full.length > 0
      ? entry("thinking", `[思考] ${gist}`, full)
      : raw(line);
  }
  const tool = /^\[(tool→|tool←)\s*/.exec(line);
  if (tool) {
    const kind: OutputEntryKind = tool[1] === "tool→" ? "tool" : "result";
    // R3:超长工具行(超长参数值)折叠 —— 摘要截断,全文进明细。
    if (line.length > MAX_FOLDED_LINE_CHARS) {
      return entry(kind, truncate(line, MAX_FOLDED_LINE_CHARS), line);
    }
    return entry(kind, line);
  }
  // [tokens] 账目行:结构化识别 → 摘要抑制(thinking 通道),全文进明细。
  if (/^\[tokens\]\s*/.test(line)) {
    const body = line.replace(/^\[tokens\]\s*/, "");
    // 空内容行按 raw 逐字保留(与 [thinking] 空行同界)。
    return body.length > 0 ? entry("thinking", line, line) : raw(line);
  }
  // 裸叙述行(无 [ 前缀、非 JSON 形态、非空)→ 来自 stderr 的按原有 suppressed
  // 处理;stdout 已在上方分支接入 report,不再落此。
  if (isBareNarrativeLine(line)) {
    return entry("thinking", line, line);
  }
  return raw(line); // R7:[done]/[headless]/未知 [前缀]/JSON 形态逐字保留
}

/** 裸叙述行判定(纯结构):首字符非 `[` 非 `{` 的非空行视为 agent 旁白正文。 */
function isBareNarrativeLine(line: string): boolean {
  const first = line.trimStart()[0] ?? "";
  return first !== "" && first !== "[" && first !== "{";
}

/**
 * atomcode:行缓冲(与 codex/通用解析器同构)——未成行的尾段留在 pending,
 * 与下一 chunk 拼接后再按真实换行分帧,消除流式词中间碎片;进程结束时
 * flush 逐字吐出残留。中行前缀拆行(splitMidLinePrefixes)在重组与分帧
 * 之后、渲染之前执行:跨 chunk 被切开的已知前缀先重组再拆分,二者不互相破坏。
 * 未知行逐字保留。
 */
function createAtomCodeParser(): ExecutorOutputParser {
  const pendingBySource = new Map<"stdout" | "stderr", string>();
  const { entry, raw } = createEntryMaker();
  const parser = ((
    chunk: string,
    source?: "stdout" | "stderr",
  ): OutputEntry[] => {
    // stdout/stderr are independent streams; interleaving must not join
    // fragments from different streams before source-based classification.
    const stream = source ?? "stderr";
    const lines = `${pendingBySource.get(stream) ?? ""}${chunk ?? ""}`.split(
      "\n",
    );
    pendingBySource.set(stream, lines.pop() ?? "");
    if (lines.length === 0) return [];
    const out: OutputEntry[] = [];
    for (const line of lines) {
      for (const piece of splitMidLinePrefixes(line).split("\n")) {
        out.push(renderAtomCodeLine(piece, entry, raw, source));
      }
    }
    return out;
  }) as ExecutorOutputParser;
  parser.flush = (source?: "stdout" | "stderr") => {
    const streams: Array<"stdout" | "stderr"> = source
      ? [source]
      : ["stderr", "stdout"];
    const flushed: OutputEntry[] = [];
    for (const stream of streams) {
      const tail = pendingBySource.get(stream) ?? "";
      pendingBySource.set(stream, "");
      if (tail.length === 0) continue;
      flushed.push(
        ...splitMidLinePrefixes(tail)
          .split("\n")
          .map((l) => renderAtomCodeLine(l, entry, raw, stream)),
      );
    }
    return flushed;
  };
  return parser;
}

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
 * 账目/用量信封字段(R2 + Pi 修复):usage/cost/price/pricing/billing/tokens
 * 大小写不敏感地视为信封——正文提取跳过,避免嵌套的 output_tokens 等被文本族
 * 键误渲染成 [汇报] 0。token 收集职责在 token-usage.ts,与解析器相互独立。
 */
const GENERIC_ACCOUNT_KEYS = new Set([
  "usage",
  "cost",
  "price",
  "pricing",
  "billing",
  "tokens",
]);

/**
 * L2:分类/生命周期字段名(大小写不敏感)—— 单值标记,不是正文。可解析但只含
 * 信封 + 分类 + 增量碎片的 JSON 视为「可解析但无语义」,显式跳过(计数 + 去重
 * 日志),不再整行 raw 刷屏(Pi message_update / tool_call_delta 实测噪音)。
 */
const GENERIC_CLASSIFICATION_KEYS = new Set([
  "type",
  "event",
  "status",
  "subtype",
  "role",
  "kind",
  "level",
  "state",
  "phase",
  "step",
  "stage",
  "version",
  "index",
]);

/**
 * 信封判定(R2):键名以 `_` 开头、或为纯 id 类(名为 id / *_id / *Id)、或为时间戳
 * 类(含 time/date),或为账目/用量键(usage/cost/price/pricing/billing/tokens,
 * 大小写不敏感)。必须**先于**动作/正文判定——tool_use_id 同时含 tool,不能
 * 误判成动作。通用启发,不见过的 agent 的 id/遥测字段同样被丢弃。
 */
function isEnvelopeKey(key: string): boolean {
  if (key.startsWith("_")) return true;
  if (GENERIC_ENVELOPE_KEYS.has(key)) return true;
  if (GENERIC_ACCOUNT_KEYS.has(key.toLowerCase())) return true;
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
 * 内容族键名判定(R2 保留清单,大小写不敏感):动作族(tool/function →
 * [工具]、command/cmd → [命令])+ 错误族(err)+ 文本族(text/content/message/
 * output/result → [汇报])。提取通用解析器与无语义判定共用,避免两份清单漂移。
 */
function isGenericContentKey(lk: string): boolean {
  return (
    lk.includes("tool") ||
    lk.includes("function") ||
    lk.includes("command") ||
    lk.includes("cmd") ||
    lk.includes("err") ||
    lk.includes("text") ||
    lk.includes("content") ||
    lk.includes("message") ||
    lk.includes("output") ||
    lk.includes("result")
  );
}

/**
 * 按字段语义递归提取动作/正文片段(R2,spec: generic-executor-output-parsing):
 *  - 动作:键名含 tool/function → [工具];含 command/cmd → [命令];
 *  - 错误:键名含 err 且值为字符串 → [汇报] error=…(R3:错误永不折叠,全文);
 *  - 正文:键名含 text/content/message/output/result → [汇报];对象/数组值
 *    (如 content 块数组)继续递归找正文,不把键名当正文渲染;
 *  - 信封:跳过(含 usage/cost/price/pricing/billing/tokens 大小写不敏感变体);
 *    未分类对象/数组继续递归(动作可能藏在更深层);
 *  - 标量:跳过(不渲染,防噪音)——文本族键同样只渲染字符串值(Pi 修复:
 *    result:0 / output_tokens:0 不再渲染成 [汇报] 0)。
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
    if (!isGenericContentKey(lk)) {
      // 非内容族:对象/数组继续递归(动作可能藏在更深层),标量跳过。
      if (typeof value === "object" && value !== null) {
        fragments.push(...extractGenericFragments(value, depth + 1));
      }
      continue;
    }
    if (lk.includes("tool") || lk.includes("function")) {
      fragments.push(`[工具] ${genericValueSummary(value)}`);
    } else if (lk.includes("command") || lk.includes("cmd")) {
      fragments.push(`[命令] ${genericValueSummary(value)}`);
    } else if (lk.includes("err")) {
      // 布尔/对象错误标记不刷屏,只渲染字符串错误;错误永不折叠(R3),全文可见。
      if (typeof value === "string") {
        fragments.push(`[汇报] error=${value}`);
      }
    } else {
      // 文本族键仅在值为字符串时渲染;数字/布尔等标量跳过(Pi 修复:result:0、
      // output_tokens:0 不再渲染成 [汇报] 0);对象/数组继续递归找正文。
      if (typeof value === "string") {
        fragments.push(`[汇报] ${genericValueSummary(value)}`);
      } else if (typeof value === "object" && value !== null) {
        fragments.push(...extractGenericFragments(value, depth + 1));
      }
    }
  }
  return fragments;
}

/** [前缀] 形式:行首的方括号标记(如 [tool→ read_file])作为动作类型保留。 */
const GENERIC_PREFIX_RE = /^\[([^\]]+)\](.*)$/;

/**
 * L2:可解析但无语义判定 —— 递归检查对象树,所有键都落在噪音集合(信封/账目/
 * 分类/增量碎片)内,或落在内容族但值不可渲染(标量/空对象,Pi 修复同源:result:0
 * 不渲染),返回 true → 显式跳过;只要出现不认识的键(非任何已知族)→ false,
 * 保持 R3 逐字保留(未知结构)。增量键(含 delta)视为噪音:tool_call_delta /
 * input_json_delta 是流式碎片,全文在后续完整事件里,不该进摘要。
 */
function isGenericNoInfo(node: unknown, depth: number): boolean {
  if (depth > MAX_GENERIC_DEPTH) return false;
  if (Array.isArray(node)) {
    return node.every((el) => isGenericNoInfo(el, depth + 1));
  }
  if (typeof node !== "object" || node === null) return true;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const lk = key.toLowerCase();
    if (isEnvelopeKey(key)) continue;
    if (GENERIC_ACCOUNT_KEYS.has(lk)) continue;
    if (GENERIC_CLASSIFICATION_KEYS.has(lk)) continue;
    if (lk.includes("delta")) continue;
    if (isGenericContentKey(lk)) {
      if (typeof value === "string") return false; // 有正文 → 有语义
      if (value !== null && typeof value === "object") {
        if (!isGenericNoInfo(value, depth + 1)) return false;
      }
      continue; // 内容族标量(如 result:0)→ 噪音
    }
    return false; // 不认识的键 → 未知结构 → R3 逐字
  }
  return true;
}

/** L2:跳过签名 —— type 字段值优先,否则按顶层键排序拼接,便于观测聚合。 */
function genericSkipSignature(parsed: Record<string, unknown>): string {
  if (typeof parsed.type === "string" && parsed.type.length > 0) {
    return parsed.type;
  }
  return `json:${Object.keys(parsed).sort().join(",")}`;
}

/**
 * L2 修复:增量事件判定 —— 顶层 type 或键名含 delta(tool_call_delta /
 * input_json_delta / tool_result_delta 等)视为携带工具参数/结果源码的流式碎片:
 * 摘要抑制但仍须落盘 detail store,不得静默丢弃、不依赖后续完整 tool_use。
 * message_update 等纯无信息事件(type 与顶层键均无 delta)不落入,保持仅计数跳过。
 */
function isGenericDeltaEvent(record: Record<string, unknown>): boolean {
  const sig = genericSkipSignature(record).toLowerCase();
  if (sig.includes("delta")) return true;
  return Object.keys(record).some((k) => k.toLowerCase().includes("delta"));
}

/** 通用片段 → 结构化条目:类别按片段标签判定,明细 = 原始整行(完整原文)。 */
function genericFragmentEntry(
  fragment: string,
  original: string,
  entry: ReturnType<typeof createEntryMaker>["entry"],
): OutputEntry {
  const kind: OutputEntryKind = fragment.startsWith("[工具]")
    ? "tool"
    : fragment.startsWith("[命令]")
      ? "command"
      : fragment.startsWith("[汇报] error=")
        ? "error"
        : "report";
  return entry(kind, fragment, original);
}

/**
 * 渲染一条通用解析行(R1 三序判定):
 * 1. 能 JSON.parse → R2 通用提取,提取出片段则逐片段渲染动作条目(明细 = 整行
 *    原文);可解析但无语义(全信封/分类/增量)显式跳过 + 计数(L2),其余逐字保留;
 * 2. 匹配 [前缀] 形式 → 前缀作为动作类型渲染(正文部分可解析则同样压缩);
 * 3. 都不是 → 逐字保留。
 * R3 硬要求:解析失败 / 未知结构 / 标量 / 顶层数组逐字保留,绝不丢弃。
 */
function renderGenericLine(
  line: string,
  entry: ReturnType<typeof createEntryMaker>["entry"],
  raw: ReturnType<typeof createEntryMaker>["raw"],
): OutputEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    const m = GENERIC_PREFIX_RE.exec(line);
    if (m) return renderGenericPrefixLine(m[1], m[2], line, entry, raw);
    return [raw(line)];
  }
  if (typeof parsed !== "object" || parsed === null) return [raw(line)]; // R3:标量 JSON
  if (Array.isArray(parsed)) return [raw(line)]; // R3:顶层数组视为未知结构
  const record = parsed as Record<string, unknown>;
  const fragments = extractGenericFragments(record, 0);
  if (fragments.length > 0) {
    return fragments.map((f) => genericFragmentEntry(f, line, entry));
  }
  // L2:可解析但无语义(全信封/分类/增量字段)→ 摘要抑制 + 签名计数;增量事件
  // (tool_call_delta/input_json_delta 携带工具参数/结果源码)仍产生 detail-bearing
  // 条目落盘,不得静默丢弃(不依赖后续完整 tool_use);纯无信息(usage/message_update)
  // 只计数跳过。不认识的键保持 R3 逐字(字节不变)。
  if (isGenericNoInfo(record, 0)) {
    observeGenericSkippedEvent(genericSkipSignature(record));
    if (isGenericDeltaEvent(record)) {
      // 空摘要 → 不进摘要流;detail = 原始整行,经 appendTaskDetail 落盘后
      // 可按 entry id 完整取回(字节不变)。
      return [entry("report", "", line)];
    }
    return [];
  }
  return [raw(line)]; // R3:提取不出正文且非纯噪音 → 逐字保留
}

/** [前缀] 行的渲染:前缀作为动作类型保留,正文若能解析出语义则压缩,否则整行逐字保留。 */
function renderGenericPrefixLine(
  prefix: string,
  rest: string,
  original: string,
  entry: ReturnType<typeof createEntryMaker>["entry"],
  raw: ReturnType<typeof createEntryMaker>["raw"],
): OutputEntry[] {
  const trimmed = rest.trim();
  if (trimmed.length === 0) return [raw(original)];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [raw(original)]; // R3:前缀行正文不是 JSON → 逐字保留
  }
  if (typeof parsed !== "object" || parsed === null) return [raw(original)];
  const fragments = extractGenericFragments(parsed, 0);
  return fragments.length > 0
    ? fragments.map((f) =>
        entry(genericFragmentKind(f), `[${prefix}] ${f}`, original),
      )
    : [raw(original)]; // R3:提取不出语义 → 逐字保留
}

/** 从通用片段标签推导类别(前缀行条目共用)。 */
function genericFragmentKind(fragment: string): OutputEntryKind {
  if (fragment.startsWith("[工具]")) return "tool";
  if (fragment.startsWith("[命令]")) return "command";
  if (fragment.startsWith("[汇报] error=")) return "error";
  return "report";
}

/**
 * 通用行动作来源判定(与 codebuddy lineActionKind 同思路,供 R5 折叠区分):按
 * 行内 type/event 字段把动作行归为「调用/过程」(call)或「结果」(result),使
 * 同一工具/命令的调用与结果在折叠时互不吞并;取不到语义返回 undefined(仅按
 * 整行文本去重)。非 JSON 行返回 undefined。
 */
function genericLineActionKind(line: string): "call" | "result" | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const marker = [record.type, record.event]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
  if (marker.includes("result")) return "result";
  if (
    marker.includes("call") ||
    marker.includes("update") ||
    marker.includes("execution") ||
    marker.includes("start")
  ) {
    return "call";
  }
  return undefined;
}

/** 通用解析器:行缓冲 + R1 三序判定 + R5 重复动作行折叠(L2:seen 提升到闭包,跨 chunk 生效);跨 chunk 半截行拼接,flush 吐残留。 */
function createGenericParser(): ExecutorOutputParser {
  let pending = "";
  // L2:seen 提升到解析器闭包 —— 原实现每次 parse(chunk) 重建,同动作行落在不同
  // chunk 时折叠失效(同一工具跨 chunk 反复调用仍逐行刷屏)。raw 透传行/error
  // 条目不进 seen,永不折叠(R3),与 codebuddy 同 chunk 折叠同口径。
  const seen = new Set<string>();
  const { entry, raw } = createEntryMaker();
  const renderLine = (line: string): OutputEntry[] =>
    renderGenericLine(line, entry, raw);
  const parser = ((chunk: string): OutputEntry[] => {
    const lines = `${pending}${chunk ?? ""}`.split("\n");
    pending = lines.pop() ?? "";
    if (lines.length === 0) return [];
    const out: OutputEntry[] = [];
    for (const l of lines) {
      const rendered = renderLine(l);
      for (const e of rendered) {
        // R5:折叠同 chunk 内重复动作行只留首条;raw 透传行与 error 条目永不
        // 折叠(R3:错误信息永不折叠)。折叠键按来源区分调用/结果,同 chunk 的
        // 工具调用与工具结果互不吞并。
        // L2 修复:空摘要条目(detail-only,如 tool_call_delta/input_json_delta
        // 增量碎片)不参与折叠 —— 每条增量都是独立的参数/结果源码,必须逐条
        // 落盘,按 entry id 可完整取回;折叠只针对进摘要流的动作行。
        if (e.kind !== "raw" && e.kind !== "error" && e.summary.length > 0) {
          const key = actionDedupKey(e.summary, genericLineActionKind(l));
          if (seen.has(key)) continue;
          seen.add(key);
        }
        out.push(e);
      }
    }
    return out;
  }) as ExecutorOutputParser;
  parser.flush = () => {
    const tail = pending;
    pending = "";
    return tail.length > 0 ? renderLine(tail) : [];
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
 *  - tool_use    → [工具] 工具名 + 参数键名(input 值全文进明细,治 55.6% 噪音)
 *  - text        → [汇报] 正文
 *  - thinking    → [思考] 首句要旨(R2)+ 明细全文
 *  - tool_result → [工具] 工具名(按 tool_use_id 关联)+ ok/error + 短摘要
 *    (全文进明细;is_error 时错误不折叠,全文留在摘要)
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
  entry: ReturnType<typeof createEntryMaker>["entry"],
  raw: ReturnType<typeof createEntryMaker>["raw"],
): OutputEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [raw(line)]; // R3:非法/非 JSON 逐字保留
  }
  if (typeof parsed !== "object" || parsed === null) return [raw(line)];
  const record = parsed as Record<string, unknown>;

  switch (record.type) {
    case "assistant": {
      const message = record.message;
      const content =
        message && typeof message === "object"
          ? (message as Record<string, unknown>).content
          : undefined;
      if (!Array.isArray(content)) return [raw(line)]; // R3:结构不认识 → 原样保留
      const out: OutputEntry[] = [];
      for (const blockRaw of content) {
        if (typeof blockRaw !== "object" || blockRaw === null) {
          return [raw(line)];
        }
        const block = blockRaw as Record<string, unknown>;
        if (block.type === "tool_use") {
          const name = typeof block.name === "string" ? block.name : "?";
          const useId = typeof block.id === "string" ? block.id : undefined;
          if (useId) state.toolNameByUseId.set(useId, name);
          const argKeys = compactArgKeys(block.input);
          out.push(
            entry(
              "tool",
              argKeys ? `[工具] ${name} ${argKeys}` : `[工具] ${name}`,
              detailText(block.input), // R3:超长参数值全文进明细
            ),
          );
        } else if (block.type === "text") {
          const text = typeof block.text === "string" ? block.text : "";
          out.push(entry("report", `[汇报] ${text}`));
        } else if (block.type === "thinking") {
          const thinking =
            typeof block.thinking === "string" ? block.thinking : "";
          // R2/R3:thinking 折叠 —— 摘要取首句要旨,全文进明细。
          out.push(
            entry("thinking", `[思考] ${thinkingSummary(thinking)}`, thinking),
          );
        } else {
          // 未知块:逐字保留整行(R3)
          return [raw(line)];
        }
      }
      return out;
    }
    case "user": {
      const message = record.message;
      const content =
        message && typeof message === "object"
          ? (message as Record<string, unknown>).content
          : undefined;
      if (!Array.isArray(content)) return [raw(line)]; // R3:无 content → 原样保留
      const out: OutputEntry[] = [];
      for (const blockRaw of content) {
        if (typeof blockRaw !== "object" || blockRaw === null)
          return [raw(line)];
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
          // R3:is_error 时错误永不折叠(全文在摘要);正常结果折叠,全文进明细。
          const summary = isError
            ? `[工具] ${name} error${text ? ` ${text}` : ""}`
            : `[工具] ${name} ok${text ? ` ${truncate(text, MAX_TOOL_RESULT_SUMMARY_CHARS)}` : ""}`;
          out.push(
            entry(isError ? "error" : "result", summary, text || undefined),
          );
        } else {
          // 非 tool_result 块(如人类消息正文)→ 整行逐字保留(R3)
          return [raw(line)];
        }
      }
      return out;
    }
    case "system": {
      if (
        record.subtype === "task_started" &&
        typeof record.description === "string"
      ) {
        return [entry("command", `[命令] ${record.description}`)];
      }
      return [raw(line)]; // R3:其他 system 子类型(已知噪音)逐字保留
    }
    case "result": {
      if (typeof record.result === "string") {
        return [entry("report", `[汇报] ${record.result}`)];
      }
      return [raw(line)]; // R3:result 无正文 → 原样保留
    }
    default:
      return [raw(line)]; // R3:未知顶层 type 逐字保留
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
 * 文本也参与去重(如 [汇报] 完全相同的正文)。去重前剥离摘要内的 #id(否则
 * 每个条目 id 唯一导致去重失效);raw 透传行(R7)不进本函数、永不折叠。
 */
function actionDedupKey(rendered: string, kind?: "call" | "result"): string {
  const stable = rendered.replace(/ #t\d+\]/g, "]");
  const m = /^\[(工具|命令)\] (\S+)/.exec(stable);
  if (!m) return stable;
  return kind ? `${m[1]}|${m[2]}|${kind}` : `${m[1]}|${m[2]}`;
}

/** codebuddy:行缓冲 + 渲染动作行;其余逐字保留(R3)。跨行状态由闭包持有。 */
function createCodeBuddyParser(): ExecutorOutputParser {
  let pending = "";
  const state: { toolNameByUseId: Map<string, string> } = {
    toolNameByUseId: new Map(),
  };
  const { entry, raw } = createEntryMaker();
  const parser = ((chunk: string): OutputEntry[] => {
    const lines = `${pending}${chunk ?? ""}`.split("\n");
    pending = lines.pop() ?? "";
    if (lines.length === 0) return [];
    const seen = new Set<string>();
    const out: OutputEntry[] = [];
    for (const l of lines) {
      const rendered = renderCodeBuddyLine(l, state, entry, raw);
      for (const e of rendered) {
        // R5:折叠同 chunk 内的重复动作行;R7 透传行不参与、逐字保留。
        // 折叠键按来源区分调用/结果,同 chunk 的 tool_use + tool_result 不互吞。
        if (e.kind !== "raw") {
          const key = actionDedupKey(e.summary, lineActionKind(l));
          if (seen.has(key)) continue;
          seen.add(key);
        }
        out.push(e);
      }
    }
    return out;
  }) as ExecutorOutputParser;
  parser.flush = () => {
    const tail = pending;
    pending = "";
    return tail.length > 0 ? renderCodeBuddyLine(tail, state, entry, raw) : [];
  };
  return parser;
}

/**
 * Pi 事件流解析器(spec: live-output-pi-uncovered-shows-thinking-and-tool-results.md R1)。
 * Pi 输出 format 是 JSONL 事件流,每条 JSON 行带 `type` 字段标识事件类型。
 * 判据基于事件类型,不用文本特征:
 *  - `message_update.assistantMessageEvent.type === "text_end"` → `report`(进界面)
 *  - `thinking_end` → `thinking`(不进界面,全文进明细与持久化)
 *  - `toolcall_end` / `tool_execution_*` → `tool`(不进界面)
 *  - `*_start` / `*_delta` → 跳过或 detail-only
 *  - `session` / `turn_*` / `message_*` 骨架 → 跳过
 *  - 未知事件类型 → `raw`(R3 逐字保留)
 */
function createPiParser(): ExecutorOutputParser {
  let pending = "";
  const { entry, raw } = createEntryMaker();

  const renderLine = (line: string): OutputEntry[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [raw(line)]; // R3:非 JSON 逐字保留
    }
    if (typeof parsed !== "object" || parsed === null) return [raw(line)];
    const record = parsed as Record<string, unknown>;
    const type = record.type;
    if (typeof type !== "string") return [raw(line)];

    switch (type) {
      case "message_update": {
        const event = record.assistantMessageEvent;
        if (typeof event !== "object" || event === null) return [raw(line)];
        const ev = event as Record<string, unknown>;
        const evType = ev.type;
        if (typeof evType !== "string") return [raw(line)];

        // text_end → report(进界面)
        if (evType === "text_end") {
          const content = typeof ev.content === "string" ? ev.content : "";
          return [entry("report", content, line)];
        }

        // thinking_end → thinking(不进界面,全文进明细)
        if (evType === "thinking_end") {
          const content = typeof ev.content === "string" ? ev.content : "";
          return [entry("thinking", thinkingSummary(content), content)];
        }

        // toolcall_end → tool
        if (evType === "toolcall_end") {
          const toolCall = ev.toolCall;
          if (typeof toolCall === "object" && toolCall !== null) {
            const tc = toolCall as Record<string, unknown>;
            const name = typeof tc.name === "string" ? tc.name : "?";
            const argKeys = compactArgKeys(tc.arguments);
            return [
              entry(
                "tool",
                argKeys
                  ? `[工具] ${name} ${argKeys}`
                  : `[工具] ${name}`,
                line,
              ),
            ];
          }
          return [entry("tool", "[工具] ?", line)];
        }

        // _start 事件 → 跳过
        if (evType.endsWith("_start")) return [];

        // _delta 事件 → detail-only(空摘要,整行原文进明细)
        if (evType.endsWith("_delta")) {
          return [entry("report", "", line)];
        }

        // 未知 event type → raw
        return [raw(line)];
      }

      case "tool_execution_start": {
        const name = typeof record.toolName === "string" ? record.toolName : "?";
        return [entry("tool", `[工具] ${name}`, line)];
      }

      case "tool_execution_update": {
        // 部分结果 → detail-only
        return [entry("report", "", line)];
      }

      case "tool_execution_end": {
        const name = typeof record.toolName === "string" ? record.toolName : "?";
        const result = record.result;
        const resultText = extractToolResultText(result);
        return [
          entry("tool", `[工具] ${name}`, resultText || line),
        ];
      }

      // 信封/骨架事件 → 跳过
      case "session":
      case "agent_start":
      case "agent_settled":
      case "turn_start":
      case "turn_end":
      case "message_start":
      case "message_end":
        return [];

      default:
        return [raw(line)]; // 未知顶层 type → raw(R3)
    }
  };

  const parser = ((chunk: string): OutputEntry[] => {
    const lines = `${pending}${chunk ?? ""}`.split("\n");
    pending = lines.pop() ?? "";
    if (lines.length === 0) return [];
    const out: OutputEntry[] = [];
    for (const l of lines) {
      out.push(...renderLine(l));
    }
    return out;
  }) as ExecutorOutputParser;
  parser.flush = () => {
    const tail = pending;
    pending = "";
    return tail.length > 0 ? renderLine(tail) : [];
  };
  return parser;
}

/**
 * 按 executorKey 创建流式输出解析器(每次执行一个;跨 chunk 状态由闭包持有,
 * 与 createAnsiStripper 同款)。codex / codebuddy 解析 JSONL 动作行,atomcode
 * 拆粘连前缀 + 折叠 thinking,pi 按事件类型判据,其余执行器(default)走通用语义
 * 解析器(spec: generic-executor-output-parsing)——按字段语义丢信封、留动作/正文,
 * 保证新增 agent 的 JSONL 输出不会顶满缓冲;未知 key 仍记一次观测日志(R5)。
 */
export function createExecutorOutputParser(
  executorKey: string,
): ExecutorOutputParser {
  switch (executorKey) {
    case "codex":
      return createCodexParser();
    case "codebuddy":
      return createCodeBuddyParser();
    case "pi":
      return createPiParser();
    case "atomcode":
    case "executor":
      return createAtomCodeParser();
    default:
      observeUnknownExecutorKey(executorKey);
      return createGenericParser();
  }
}
