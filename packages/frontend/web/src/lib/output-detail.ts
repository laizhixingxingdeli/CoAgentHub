/**
 * 摘要行解析(frontend-expand-output-detail R1):识别形如
 * `[思考 #t7] 先确认守卫在哪个文件` 的行,提取行首 [标签] 前缀内的 #id,
 * 供展开控件按单条明细 API 取回完整原文。
 *
 * 只认行首 `[..]` 前缀内的 #id(与后端 output-parser 注入格式一致),
 * 避免把正文里的 `#42`、`# 标题`、`src/a.ts#L42` 误判为展开入口;
 * 不含 #id 的行 entryId 为 null,沿用现有纯文本渲染。
 */

export type ParsedOutputLine = {
  /** 摘要行里的条目 id(如 `t7`);无 #id 时为 null。 */
  entryId: string | null;
  /** 原始行文本,原样保留。 */
  line: string;
};

const ENTRY_ID_PREFIX = /^\[[^\]]*#([A-Za-z0-9][A-Za-z0-9_-]*)[^\]]*\]/;

export function parseOutputLine(line: string): ParsedOutputLine {
  const match = ENTRY_ID_PREFIX.exec(line);
  return { entryId: match?.[1] ?? null, line };
}
