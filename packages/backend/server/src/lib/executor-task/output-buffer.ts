/**
 * 实时输出缓冲(executor-task 拆分,实时进度 feature):running 任务最近输出的
 * 环形缓冲(taskId → 最近输出全文,任务结束释放),供 includeOutput 拉取 /
 * 断线重连用。
 */

/** running 任务最近输出的环形缓冲上限:1000 行 / 256KB,超限保留尾部。 */
const OUTPUT_TAIL_MAX_LINES = 1000;
const OUTPUT_TAIL_MAX_BYTES = 256 * 1024;

/** running 任务的输出缓冲(taskId → 最近输出全文,任务结束释放)。 */
const runningOutputs = new Map<string, string>();
const outputUpdatedAt = new Map<string, number>();

/**
 * 追加输出块到任务缓冲:按行数/字节数双上限截断,超限只留尾部(环形)。
 * 任务结束(releaseTaskOutput)时从 Map 移除,避免内存泄漏。
 */
export function appendTaskOutput(taskId: string, chunk: string): void {
  const prev = runningOutputs.get(taskId) ?? "";
  let next = prev + chunk;
  if (next.length > OUTPUT_TAIL_MAX_BYTES) {
    next = next.slice(-OUTPUT_TAIL_MAX_BYTES);
  }
  const lines = next.split("\n");
  if (lines.length > OUTPUT_TAIL_MAX_LINES) {
    next = lines.slice(-OUTPUT_TAIL_MAX_LINES).join("\n");
  }
  runningOutputs.set(taskId, next);
  if (chunk.length > 0) outputUpdatedAt.set(taskId, Date.now());
}

/** 取任务缓冲全文(running 任务有缓冲;无/已释放返回 null)。 */
export function taskOutputTail(taskId: string): string | null {
  return runningOutputs.get(taskId) ?? null;
}

/** Timestamp of the latest in-process outputTail update, if any. */
export function taskOutputUpdatedAt(taskId: string): number | null {
  return outputUpdatedAt.get(taskId) ?? null;
}

/** 释放任务缓冲(任务进入终态 done/failed/cancelled 时调用)。 */
export function releaseTaskOutput(taskId: string): void {
  runningOutputs.delete(taskId);
  outputUpdatedAt.delete(taskId);
}

/** 清空全部输出缓冲(测试重置 __resetExecutorQueueForTests 用)。 */
export function clearAllTaskOutputs(): void {
  runningOutputs.clear();
  outputUpdatedAt.clear();
}
