/**
 * 实时输出缓冲(前端侧):WS task_output 每块 chunk 都推过来,若不加限,
 * 前端会攒出「有史以来全部输出」撑爆内存(state 里整个字符串每 chunk 重建)。
 * 这里在追加时就按与后端相同的上限截断,超限只留尾部(滚动窗口)。
 *
 * 上限数值与后端 `packages/backend/server/src/lib/executor-task/output-buffer.ts`
 * 保持一致(1000 行 / 256KB);改后端上限时须同步这里。
 */

/** 与后端 output-buffer.ts 一致:最大行数 / 最大字节数,超限保留尾部。 */
export const OUTPUT_TAIL_MAX_LINES = 1000;
export const OUTPUT_TAIL_MAX_BYTES = 256 * 1024;

/**
 * 追加输出块:按字节数/行数双上限截断,超限只留尾部。
 * 与后端 appendTaskOutput 同款算法,保证前端缓冲与 includeOutput 拉取的
 * 输出尾行为一致。
 */
export function appendOutputTail(prev: string, chunk: string): string {
  let next = prev + chunk;
  if (next.length > OUTPUT_TAIL_MAX_BYTES) {
    next = next.slice(-OUTPUT_TAIL_MAX_BYTES);
  }
  const lines = next.split("\n");
  if (lines.length > OUTPUT_TAIL_MAX_LINES) {
    next = lines.slice(-OUTPUT_TAIL_MAX_LINES).join("\n");
  }
  return next;
}

/**
 * 取最后一非空行(trim 后非空;执行器输出常有空行/纯空白行)。
 * 折叠态单行预览用;无任何非空行返回 null(调用方不显示该行)。
 */
export function lastNonEmptyLine(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) {
      return lines[i];
    }
  }
  return null;
}
