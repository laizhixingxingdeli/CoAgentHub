/**
 * 结构化汇报解析与渲染(executor-task 拆分,票7):执行器 stdout 按
 * 「提交/测试/汇报/遗留」四段输出后的解析(parseTaskReport)与群消息成功卡片
 * 渲染(renderTaskCard)。纯函数,独立可单测。
 */

import { ANSI_RE } from "./ansi";
import { taskOutputTail } from "./output-buffer";

/** 结构化汇报(票7):执行器 stdout 按「提交/测试/汇报/遗留」四段输出后的解析结果。 */
export interface TaskReport {
  /** 做了什么(汇报段);无汇报段时留空,原因见 reportMissingReason。 */
  summary?: string;
  /** commit hash(提交段);缺段时省略(不误报"无提交")。 */
  hash?: string;
  /** 测试结果摘要(测试段)。 */
  tests?: string;
  /** 遗留事项(遗留段)。 */
  todo?: string;
  /** 执行器自报值仅作解析参考,平台终态不再据此落库。 */
  tokenUsage?: string;
  /** 未采集到结构化汇报段时的原因标注(R2):summary 留空,原因写在这里。 */
  reportMissingReason?: string;
}

/** 段落头匹配:支持中文与英文(Commit:/commit: 等大小写变体),必须行首。
 * 也接受报告格式中的双空格分隔(如「提交  <hash>」)。 */
const REPORT_SECTION_RE: ReadonlyArray<{
  key: keyof TaskReport;
  re: RegExp;
}> = [
  {
    key: "hash",
    re: /^\s*(?:提交|commit|hash)(?:\s*[:：]\s*|\s{2,})/i,
  },
  {
    key: "tests",
    re: /^\s*(?:测试|test|tests)(?:\s*[:：]\s*|\s{2,})/i,
  },
  {
    key: "summary",
    re: /^\s*(?:汇报|report|summary)(?:\s*[:：]\s*|\s{2,})/i,
  },
  {
    key: "todo",
    re: /^\s*(?:遗留|todo|remaining)(?:\s*[:：]\s*|\s{2,})/i,
  },
  {
    key: "tokenUsage",
    re: /^\s*(?:token|tokens|消耗)(?:\s*[:：]\s*|\s{2,})/i,
  },
];

/** 单个汇报段的最大字符数,避免无结束标题时吞入完整执行转录。 */
const REPORT_SECTION_MAX_LENGTH = 4_000;

/** 提交段 token 剥除的成对 Markdown 包裹(反引号/星号/尖括号/方括号)。 */
const HASH_WRAP_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["`", "`"],
  ["*", "*"],
  ["<", ">"],
  ["[", "]"],
];

/**
 * 裸「commit/hash <hex>」声明行(旧自由文本格式的提交行):整行只有声明 + hash,
 * 行首行尾锚定。汇报块回退向前吸收与 hash 提取共用同一判据 —— 位置(声明行),
 * 不是内容形态(spec R1:不得在整个 stdout 里做 `[0-9a-f]{7,40}` 扫描)。
 */
const DECLARED_COMMIT_LINE_RE =
  /^(?:commit|hash)\s*[:：]?\s*([0-9a-f]{7,40})$/i;

/** 未采集到结构化汇报段时的原因标注文案(汇报提取 spec R2)。 */
const REPORT_MISSING_REASON =
  "未采集到结构化汇报段(stdout 无「提交/测试/汇报/遗留」段头),按位置判据不回退取输出尾部";

/** 取声明行里的 hash(40 位按既有规则缩为 12 位);非声明行返回 undefined。 */
function declaredCommitHash(line: string): string | undefined {
  const match = DECLARED_COMMIT_LINE_RE.exec(line.trim());
  if (!match) return undefined;
  const token = match[1];
  return token.length === 40 ? token.slice(0, 12) : token;
}

/** 清洗 token 段值:去空格与千分位逗号,取首个数字组(去 token/tokens 等后缀词)。 */
function cleanTokenValue(raw: string): string | undefined {
  const compact = raw.replace(/\s+/g, "");
  const match = compact.match(/\d[\d,]*/);
  if (!match) return undefined;
  const cleaned = match[0].replace(/,/g, "");
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * 从整段文本按**形态**取 commit hash(40 位 hex 或 "commit/hash: xxx" 短格式)。
 * 只用于 a2a 分支:远端 participant 的回复本身就是交付正文,没有汇报段协议。
 * CLI 汇报提取走 parseTaskReport 的位置判据(spec R1),不用这里。
 */
export function findCommitHash(text: string): string | null {
  const clean = (text ?? "").replace(ANSI_RE, "");
  const full = clean.match(/[0-9a-f]{40}/);
  if (full) return full[0].slice(0, 12);
  const short = clean.match(/(?:commit|hash)\s*[:：]?\s*([0-9a-f]{7,12})/i);
  return short ? short[1] : null;
}

/** 取文本尾部最近 N 行(清理 ANSI + 空行,非空行计数)。 */
export function lastLinesOf(text: string, lines: number): string {
  const clean = (text ?? "").replace(ANSI_RE, "").trim();
  const arr = clean.split("\n").filter((l) => l.trim());
  return arr.slice(-lines).join("\n");
}

/** 从任务输出缓冲取尾部最近 N 行(清理 ANSI + 空行,非空行计数)。 */
export function taskOutputTailLines(taskId: string, maxLines = 500): string {
  return lastLinesOf(taskOutputTail(taskId) ?? "", maxLines);
}

/** 提交段 token 剥除成对的 Markdown 包裹(支持嵌套,如 **bold**),剥到无可剥为止。 */
function stripHashWrappers(token: string): string {
  let t = token.trim();
  let changed = true;
  while (changed && t.length > 1) {
    changed = false;
    for (const [open, close] of HASH_WRAP_PAIRS) {
      if (t.startsWith(open) && t.endsWith(close)) {
        t = t.slice(open.length, t.length - close.length).trim();
        changed = true;
        break;
      }
    }
  }
  return t;
}

/** 段是否为任务书回显占位符:段内容首行形如 <...>(模板占位符)。 */
function isPlaceholderSection(
  lines: string[],
  section: { re: RegExp; start: number },
): boolean {
  const firstLine = lines[section.start].replace(section.re, "").trim();
  return /^<[^>\n]+>/.test(firstLine);
}

/**
 * 汇报块起点:最后一个段头行起,向前吸收紧邻的真实段头行与裸 commit/hash 行;
 * 占位符段头(任务书回显)不吸收;首个非汇报行即停。结构化汇报存在时,回退扫描
 * 只限该块,不扫任意前文工具输出(避免误取前文旧 hash / 任务书里的 specHash)。
 */
function reportBlockStart(
  lines: string[],
  found: ReadonlyArray<{ key: keyof TaskReport; start: number; re: RegExp }>,
): number {
  const last = found[found.length - 1];
  let start = last.start;
  for (let i = last.start - 1; i >= 0; i--) {
    const section = found.find((f) => f.start === i);
    if (section) {
      if (isPlaceholderSection(lines, section)) break;
      start = i;
      continue;
    }
    if (declaredCommitHash(lines[i])) {
      start = i;
      continue;
    }
    break;
  }
  return start;
}

/**
 * 汇报段落解析(票7):从 stdout 提取「提交:」「测试:」「汇报:」「遗留:」四段
 * (支持大小写变体),返回结构化字段;缺段时对应字段省略。
 *
 * 判据用**位置**不用内容(spec: report-extraction-ingests-test-fixtures R1/R2):
 *  - hash 只采信汇报段的结构化字段,缺段时在汇报块内认「commit/hash <hex>」声明行;
 *    stdout 其余位置的十六进制串(测试夹具、任务书 specHash、工具回显)一律不取。
 *  - stdout 不含任何段落 → summary 留空并给 reportMissingReason 标注原因,
 *    **不**回退「取输出尾部若干行」(那是源码混进汇报的来路)。
 */
export function parseTaskReport(text: string): TaskReport {
  const clean = (text ?? "").replace(ANSI_RE, "");
  const lines = clean.split("\n");

  // 段落头定位:每段从段头行取内容,直到下一个段头(或输出末尾)。
  const found: Array<{
    key: keyof TaskReport;
    start: number;
    re: RegExp;
  }> = [];
  for (let i = 0; i < lines.length; i++) {
    for (const section of REPORT_SECTION_RE) {
      const { key, re } = section;
      if (re.test(lines[i])) {
        found.push({ key, start: i, re });
        break;
      }
    }
  }
  if (found.length > 0) {
    const report: TaskReport = {};
    for (let f = 0; f < found.length; f++) {
      const { key, start, re } = found[f];
      const end = f + 1 < found.length ? found[f + 1].start : lines.length;
      const value = [
        lines[start].replace(re, ""),
        ...lines.slice(start + 1, end),
      ]
        .join("\n")
        .trim()
        .slice(0, REPORT_SECTION_MAX_LENGTH)
        .trim();
      if (value.length === 0) continue;
      if (key === "hash") {
        // 提交段只取首个 token:剥除成对的 Markdown 包裹(反引号/星号/尖括号/
        // 方括号)后校验,形如 7~40 位 hex 才算 hash,否则省略(避免把描述性
        // 文字当 hash 落库;包裹内容非 hex 的占位符自然落空)。
        const token = stripHashWrappers(
          value.split("\n")[0].trim().split(/\s+/)[0],
        );
        if (/^[0-9a-f]{7,40}$/i.test(token)) {
          report.hash = token.length === 40 ? token.slice(0, 12) : token;
        }
      } else {
        // 执行器可能先回显完整任务书,其中的结构化汇报段是模板占位符。
        // 忽略整个占位符段,否则例如模板「遗留」段会把回显后续内容吞进结果;
        // 真实汇报若随后出现,仍会按正常段落解析。
        const firstLine = value.split("\n", 1)[0].trim();
        if (/^<[^>\n]+>/.test(firstLine)) continue;
        if (key === "tokenUsage") {
          // token 段只取清洗后的纯数字,非法/空值省略(不影响既有四段)。
          const cleaned = cleanTokenValue(value);
          if (cleaned) report.tokenUsage = cleaned;
        } else {
          report[key] = value;
        }
      }
    }
    // 提交段缺失/无 hex 时在汇报块内回退提取(兼容「commit <hex>」裸行 + 段落
    // 混排的旧输出,hash 不因缺段丢失)。回退只认块内的声明行(R1:位置判据),
    // 块内的其他十六进制串(测试夹具、回显的 specHash)与块外前文的旧 hash 一律不取。
    if (!report.hash) {
      for (const line of lines.slice(reportBlockStart(lines, found))) {
        const declared = declaredCommitHash(line);
        if (declared) {
          report.hash = declared;
          break;
        }
      }
    }
    return report;
  }

  // 无结构化汇报段(R2):summary 留空 + 原因标注。此前这里回退「关键词段 / 末尾
  // 15 行」并用 findCommitHash 扫全量输出,把测试夹具的假 hash 与源码片段当成
  // 提交与汇报上报(任务 01a0516a / 01a052c3 实证);准确的空优于假内容。
  return { reportMissingReason: REPORT_MISSING_REASON };
}

/** 群消息成功卡片(票7):固定四行渲染,独立可测;超过 8000 截断。 */
const TASK_CARD_MAX_LENGTH = 8000;
export function renderTaskCard(label: string, report: TaskReport): string {
  const card = [
    `✅ 任务完成 ${label}`,
    `────────────────`,
    `提交  ${report.hash ?? "无"}`,
    `测试  ${report.tests ?? "-"}`,
    `汇报  ${report.summary ?? "-"}`,
    `遗留  ${report.todo ?? "-"}`,
  ].join("\n");
  return card.length > TASK_CARD_MAX_LENGTH
    ? card.slice(0, TASK_CARD_MAX_LENGTH)
    : card;
}

/**
 * 从 codebuddy --output-format stream-json 的 stdout 提取最终正文(供汇报段落
 * 解析):取最后一个 {"type":"result",...} 事件的 result 字段;无 result 事件时
 * 回退最后一条 assistant 文本消息。R1 打开该开关后 stdout 变 JSONL,不提取则
 * parseTaskReport 只能把整条转义 JSON 当 summary(实跑 2026-08-26 验证)。
 */
export function extractCodeBuddyStreamResult(text: string): string | undefined {
  let resultText: string | undefined;
  let lastAssistantText: string | undefined;
  for (const line of (text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue; // 非 JSONL 行(告警等)跳过,与 token-usage parseJsonLines 同界。
    }
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    if (record.type === "result" && typeof record.result === "string") {
      resultText = record.result;
    }
    if (record.type === "assistant") {
      const message = record.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      const texts = content
        .filter((part): part is Record<string, unknown> =>
          Boolean(part && typeof part === "object"),
        )
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string);
      if (texts.length > 0) lastAssistantText = texts.join("\n");
    }
  }
  return resultText ?? lastAssistantText;
}

/** 判定 JSONL 的非空行 JSON.parse 成功占比阈值(通用兜底):过半行可解析才
 * 视为 JSONL——纯文本 legacy 输出几乎全部解析失败,直接回落旧路径。 */
const JSONL_PARSE_RATIO_THRESHOLD = 0.5;

/**
 * 通用 JSONL 兜底提取(无专用提取器的执行器,如 Pi):从后往前扫描,取最后一
 * 条 role=assistant 的文本块(消息的 content[] type=text,或等价 text/content
 * 字符串字段),返回正文供 parseTaskReport 段落解析。判定为 JSONL(非空行
 * JSON.parse 成功占比 ≥ JSONL_PARSE_RATIO_THRESHOLD)才提取;找不到 assistant
 * 文本块返回 undefined(不猜,保持 legacy 路径逐字一致)。
 */
export function extractGenericJsonlText(text: string): string | undefined {
  const lines = (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return undefined;

  const rows: Array<unknown> = [];
  let parsedCount = 0;
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
      parsedCount += 1;
    } catch {
      rows.push(undefined); // 非 JSON 行(告警等)跳过,与既有提取器同界。
    }
  }
  if (parsedCount / lines.length < JSONL_PARSE_RATIO_THRESHOLD) {
    return undefined; // 非 JSONL(纯文本 legacy)→ 不提取,保持旧路径。
  }

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;

    // 事件级 messages 数组(真实 Pi agent_end 形状):从尾部逆序扫,取最后一条
    // role=assistant 的文本块;找不到不猜,继续扫前一行。
    if (Array.isArray(record.messages)) {
      const messages = record.messages as Array<unknown>;
      for (let j = messages.length - 1; j >= 0; j--) {
        const msg = messages[j];
        if (typeof msg !== "object" || msg === null) continue;
        const m = msg as Record<string, unknown>;
        if (m.role !== "assistant") continue;
        const block = extractAssistantTextBlock(m);
        if (block !== undefined) return block;
      }
      continue;
    }

    const message =
      typeof record.message === "object" && record.message !== null
        ? (record.message as Record<string, unknown>)
        : record;
    const role = message.role ?? record.role;
    if (role !== "assistant") continue;
    const block = extractAssistantTextBlock(message);
    if (block !== undefined) return block;
  }
  return undefined;
}

/** 从 assistant 消息取文本块:content[] type=text 各段拼接;content/text 为
 * 非空字符串时直接采用;无文本块返回 undefined(不猜)。 */
function extractAssistantTextBlock(
  message: Record<string, unknown>,
): string | undefined {
  const content = message.content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((part): part is Record<string, unknown> =>
        Boolean(part && typeof part === "object"),
      )
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string);
    return texts.length > 0 ? texts.join("\n") : undefined;
  }
  if (typeof content === "string" && content.trim().length > 0) return content;
  if (typeof message.text === "string" && message.text.trim().length > 0) {
    return message.text;
  }
  return undefined;
}
