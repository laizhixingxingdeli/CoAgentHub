/**
 * 结构化汇报解析与渲染(executor-task 拆分,票7):执行器 stdout 按
 * 「提交/测试/汇报/遗留」四段输出后的解析(parseTaskReport)与群消息成功卡片
 * 渲染(renderTaskCard)。纯函数,独立可单测。
 */

/** ANSI 颜色码清理(解析前剥掉控制序列)。 */
const ANSI_RE =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/** 结构化汇报(票7):执行器 stdout 按「提交/测试/汇报/遗留」四段输出后的解析结果。 */
export interface TaskReport {
  /** 做了什么(汇报段);老格式自由文本时为旧关键词摘要。 */
  summary?: string;
  /** commit hash(提交段);缺段时省略(不误报"无提交")。 */
  hash?: string;
  /** 测试结果摘要(测试段)。 */
  tests?: string;
  /** 遗留事项(遗留段)。 */
  todo?: string;
}

/** 段落头匹配:支持中文与英文(Commit:/commit: 等大小写变体),必须行首。 */
const REPORT_SECTION_RE: ReadonlyArray<{
  key: keyof TaskReport;
  re: RegExp;
}> = [
  { key: "hash", re: /^\s*(?:提交|commit|hash)\s*[:：]/i },
  { key: "tests", re: /^\s*(?:测试|test|tests)\s*[:：]/i },
  { key: "summary", re: /^\s*(?:汇报|report|summary)\s*[:：]/i },
  { key: "todo", re: /^\s*(?:遗留|todo|remaining)\s*[:：]/i },
];

/** 从输出取 commit hash(40 位 hex 或 "commit/hash: xxx" 短格式)。 */
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

/**
 * 汇报段落解析(票7):从 stdout 提取「提交:」「测试:」「汇报:」「遗留:」四段
 * (支持大小写变体),返回结构化字段;缺段时对应字段省略。stdout 不含任何段落
 * (老格式自由文本)→ 保持旧行为:摘要取「汇报/做了什么/测试结果/commit」关键词
 * 段或末尾 15 行,hash 用 findCommitHash。
 */
export function parseTaskReport(text: string): TaskReport {
  const clean = (text ?? "").replace(ANSI_RE, "");
  const lines = clean.split("\n");

  // 段落头定位:每段从段头行取内容,直到下一个段头(或输出末尾)。
  const found: Array<{ key: keyof TaskReport; start: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    for (const { key, re } of REPORT_SECTION_RE) {
      if (re.test(lines[i])) {
        found.push({ key, start: i });
        break;
      }
    }
  }
  if (found.length > 0) {
    const report: TaskReport = {};
    for (let f = 0; f < found.length; f++) {
      const { key, start } = found[f];
      const end = f + 1 < found.length ? found[f + 1].start : lines.length;
      const value = lines
        .slice(start, end)
        .join("\n")
        .replace(/^[^:：]*[:：]\s*/, "")
        .trim();
      if (value.length === 0) continue;
      if (key === "hash") {
        // 提交段只取首个 token:形如 7~40 位 hex 才算 hash,否则省略(避免把
        // 描述性文字当 hash 落库)。
        const token = value.split("\n")[0].trim().split(/\s+/)[0];
        if (/^[0-9a-f]{7,40}$/i.test(token)) {
          report.hash = token.length === 40 ? token.slice(0, 12) : token;
        }
      } else {
        report[key] = value;
      }
    }
    // 提交段缺失/无 hex 时回退全量输出提取(兼容「commit <hex>」裸行 + 段落
    // 混排的旧输出,hash 不因缺段丢失)。
    if (!report.hash) {
      const h = findCommitHash(clean);
      if (h) report.hash = h;
    }
    return report;
  }

  // 老格式自由文本:保持旧行为(关键词段或末尾 15 行 + findCommitHash)。
  const summary = legacyExtractSummary(clean);
  const hash = findCommitHash(clean);
  return hash ? { summary, hash } : { summary };
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

/** 与桥 extractSummary 一致:取「汇报/做了什么/测试结果/commit」段或末尾 15 行。 */
function legacyExtractSummary(clean: string): string {
  const lines = clean.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/汇报|做了什么|测试结果|commit/.test(lines[i])) {
      start = i;
      break;
    }
  }
  const slice = start >= 0 ? lines.slice(start) : lines.slice(-15);
  let out = slice.join("\n").trim();
  if (out.length > 20000) out = out.slice(0, 20000) + "\n…(截断)";
  return out;
}
