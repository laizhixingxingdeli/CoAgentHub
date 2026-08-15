/**
 * 任务书 / 执行结果结构化卡片(网页体验批次):
 *  - TaskBriefCard:消息正文是任务书(matt 格式,含 **Category:** / **Summary:** /
 *    **Acceptance criteria:** 等标记行)时渲染为结构化卡片 —— Category/Summary
 *    高亮分栏、验收标准列表化;识别失败时保持普通文本(由调用方回退)。
 *  - TaskResultCard:✅/❌ 执行结果精简显示 —— 第一行状态+执行器+提交(有则),
 *    「测试/汇报/遗留」每项一行摘要(超长截断+展开),不再整段贴 summary。
 * 两者都是纯展示组件:折叠/展开状态自持,不依赖父级消息流状态。
 */
import { useMemo, useState } from "react";
import { t } from "@/lib/i18n";

/** 任务书标记行(识别用):Category / Summary / Acceptance criteria 等,支持
 *  `**Label:**` 与 `**Label**` 两种变体(大小写不敏感)。 */

/** 字段标签 i18n:识别出的英文标记 → 词典 key(zh 显示中文,en 保持英文)。 */
function briefFieldLabel(raw: string): string {
  const key = raw.toLowerCase().replace(/[^a-z]+/g, "");
  const map: Record<string, string> = {
    category: "cards.field.category",
    summary: "cards.field.summary",
    currentbehavior: "cards.field.currentBehavior",
    desiredbehavior: "cards.field.desiredBehavior",
    keyinterfaces: "cards.field.keyInterfaces",
    outofscope: "cards.field.outOfScope",
    acceptancecriteria: "cards.field.acceptanceCriteria",
  };
  const k = map[key];
  return k ? t(k as import("@/lib/i18n").DictKey) : raw;
}
const BRIEF_MARKER_RE =
  /^\*\*\s*(category|summary|acceptance\s*criteria|desired\s*behavior|验收标准|类别|概要)\s*\*{0,2}\s*[:：]/i;

/** 验收标准列表项(- [ ] / - [x] 开头)。 */
const CRITERIA_ITEM_RE = /^\s*[-*]\s*\[[ xX]\]\s+/;

/** 单行摘要截断长度:超过显示省略号 + 展开按钮。 */
const RESULT_ROW_TRUNCATE = 60;

/* ---------------- 任务书卡片 ---------------- */

export function isTaskBrief(body: string): boolean {
  if (!body) {
    return false;
  }
  return body
    .split("\n")
    .some(
      (line) => BRIEF_MARKER_RE.test(line) || line.includes("**Category:**"),
    );
}

export interface BriefField {
  /** 原始标记文本,如 "Category" / "Summary" / "Acceptance criteria"。 */
  label: string;
  value: string;
}

export interface BriefSection {
  label: string;
  /** 验收标准列表项(去掉 - [ ] 前缀后的文本);空 = 该段无列表项。 */
  items: string[];
}

/** 解析任务书正文 → { fields, criteria }。fields 按出现顺序收集所有标记行的
 *  键值(类别/概要 高亮用);criteria 取验收标准段后的列表项。识别失败返回
 *  null(调用方回退普通文本)。 */
export function parseTaskBrief(body: string): {
  fields: BriefField[];
  criteria: string[];
} | null {
  const lines = (body ?? "").split("\n");
  const fields: BriefField[] = [];
  const criteria: string[] = [];
  let inCriteria = false;
  for (const line of lines) {
    // 支持 `**Category:** value` 与 `**Category** : value` 变体:标签后的闭合
    // 星号、冒号都可能缺失/在冒号后,统一用宽松匹配 + 剥离尾部星号。
    const marker = line.match(
      /^\*\*\s*([^*:：]+?)\s*\*{0,2}\s*[:：]\s*\*{0,2}\s*(.*)$/i,
    );
    if (marker) {
      const label = marker[1].trim();
      if (/acceptance\s*criteria|验收标准/i.test(label)) {
        inCriteria = true;
        if (marker[2].trim()) {
          criteria.push(marker[2].trim());
        }
        continue;
      }
      inCriteria = false;
      if (/category|summary|desired\s*behavior|类别|概要/i.test(label)) {
        fields.push({ label, value: marker[2].trim() });
      }
      continue;
    }
    if (inCriteria && CRITERIA_ITEM_RE.test(line)) {
      criteria.push(line.replace(CRITERIA_ITEM_RE, "").trim());
    }
  }
  if (fields.length === 0 && criteria.length === 0) {
    return null;
  }
  return { fields, criteria: criteria.filter(Boolean) };
}

/** 任务书卡片:Category/Summary 高亮分栏 + 验收标准列表;「展开全文」看原文。 */
export function TaskBriefCard({ body }: { body: string }) {
  const parsed = useMemo(() => parseTaskBrief(body), [body]);
  const [expanded, setExpanded] = useState(false);
  if (!parsed) {
    return null;
  }
  const { fields, criteria } = parsed;
  return (
    <div
      data-testid="task-brief-card"
      className="w-full rounded-xl border border-primary/20 bg-background/40 px-3 py-2.5 shadow-sm"
    >
      <div className="flex flex-col gap-1.5">
        {fields.map((f) => (
          <div key={f.label} className="flex flex-col gap-0.5">
            <span className="text-[11px] font-semibold tracking-wide text-primary">
              {briefFieldLabel(f.label)}
            </span>
            <p className="whitespace-pre-wrap break-words text-sm">{f.value}</p>
          </div>
        ))}
        {criteria.length > 0 && (
          <div className="mt-1 flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-primary">
              {t("cards.acceptanceCriteria")}
            </span>
            <ul className="list-disc space-y-0.5 pl-4 text-sm">
              {criteria.map((item) => (
                <li key={item} className="break-words">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <button
        type="button"
        data-testid="task-brief-toggle"
        onClick={() => setExpanded((v) => !v)}
        className="mt-1.5 inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-muted"
      >
        {expanded ? t("messages.item.fold") : t("messages.item.expandFull")}
      </button>
      {expanded && (
        <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 px-2 py-1.5 font-mono text-xs leading-relaxed">
          {body}
        </pre>
      )}
    </div>
  );
}

/* ---------------- 执行结果卡片 ---------------- */

export interface ResultRow {
  label: string;
  value: string;
}

export interface ParsedResultCard {
  /** 状态头第一行(如 "✅ 任务完成 atomcode" / "❌ [atomcode] 任务失败 (exit 1)")。 */
  header: string;
  commit: string | null;
  /** 「测试/汇报/遗留」逐行摘要(按出现顺序)。 */
  rows: ResultRow[];
  /** 其余行(分隔线、无法归类的内容;超长时整段折叠展示)。 */
  rest: string;
}

/** 执行结果精简解析:第一行 = 状态头(状态+执行器),「提交」段提取 commit hash,
 *  「测试/汇报/遗留」段各取一行摘要;其余内容(分隔线/未知行)归入 rest。
 *  无法归类的旧格式(如 "总结:xxx")也进 rest,由展示端截断 + 展开兜底。 */
export function parseResultCard(body: string): ParsedResultCard {
  const lines = (body ?? "").split("\n");
  const header = lines[0]?.trim() || body;
  const rows: ResultRow[] = [];
  const restLines: string[] = [];
  let commit: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || /^─+$/.test(line)) {
      continue; // 分隔线跳过
    }
    const commitMatch = line.match(
      /^(?:提交|commit|hash)\s*[:：]?\s*([0-9a-f]{7,40})/i,
    );
    if (commitMatch) {
      const h = commitMatch[1];
      commit = h.length === 40 ? h.slice(0, 12) : h;
      continue;
    }
    const section = line.match(
      /^(测试|test|tests|汇报|report|summary|遗留|todo|remaining)\s*[:：]?\s+(.+)/i,
    );
    if (section) {
      const label = /测试|^tests?$/i.test(section[1])
        ? "测试"
        : /遗留|^todo$|^remaining$/i.test(section[1])
          ? "遗留"
          : "汇报";
      rows.push({ label, value: section[2].trim() });
      continue;
    }
    restLines.push(line);
  }
  return { header, commit, rows, rest: restLines.join("\n") };
}

/** 结果行标签 i18n:「提交/测试/汇报/遗留」→ 词典 key(en 显示 Commit/Tests/Report/Remaining)。 */
function resultRowLabel(raw: string): string {
  const map: Record<string, string> = {
    提交: "cards.result.commit",
    测试: "cards.result.tests",
    汇报: "cards.result.report",
    遗留: "cards.result.remaining",
  };
  const k = map[raw];
  return k ? t(k as import("@/lib/i18n").DictKey) : raw;
}

/** 单行截断:超过 RESULT_ROW_TRUNCATE 字显示省略号,点击展开/收起。 */
function TruncatedRow({ text, testId }: { text: string; testId: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = Array.from(text).length > RESULT_ROW_TRUNCATE;
  const display =
    long && !expanded
      ? `${Array.from(text).slice(0, RESULT_ROW_TRUNCATE).join("")}…`
      : text;
  return (
    <div className="flex flex-col gap-0.5">
      <p
        data-testid={testId}
        className="whitespace-pre-wrap break-words text-xs leading-relaxed"
      >
        {display}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-0.5 self-start rounded px-1 text-xs font-medium text-primary transition-colors hover:bg-muted"
        >
          {expanded ? t("messages.item.fold") : t("messages.item.expandFull")}
        </button>
      )}
    </div>
  );
}

/** 执行结果卡片(✅/❌):第一行状态+执行器+提交,「测试/汇报/遗留」逐行摘要;
 *  超长截断 + 展开;旧格式整段摘要也截断展示,不再撑满气泡。 */
export function TaskResultCard({ body }: { body: string }) {
  const parsed = useMemo(() => parseResultCard(body), [body]);
  const hasRows = parsed.rows.length > 0;
  return (
    <div
      data-testid="task-result-card"
      className="flex w-full flex-col gap-1.5"
    >
      <p
        data-testid="task-result-header"
        className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed"
      >
        {parsed.header}
        {parsed.commit && (
          <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px]">
            {t("cards.result.commit")} {parsed.commit}
          </span>
        )}
      </p>
      {hasRows ? (
        <div className="flex flex-col gap-1">
          {parsed.rows.map((row) => (
            <div key={row.label} className="flex flex-col gap-0.5">
              <span className="text-[10px] font-semibold tracking-wide text-muted-foreground">
                {resultRowLabel(row.label)}
              </span>
              <TruncatedRow
                text={row.value}
                testId={`task-result-row-${row.label}`}
              />
            </div>
          ))}
          {parsed.rest && (
            <div className="mt-1 border-t border-muted pt-1">
              <TruncatedRow text={parsed.rest} testId="task-result-rest" />
            </div>
          )}
        </div>
      ) : (
        parsed.rest && (
          <TruncatedRow text={parsed.rest} testId="task-result-rest" />
        )
      )}
    </div>
  );
}
