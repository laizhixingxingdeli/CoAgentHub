/**
 * 回写被拒连续计数与熔断(协调任务结案守卫拒绝路径)。
 *
 * 背景:2026-09-11 执行器回写被拒后重试约 3600 轮 / 1h41m,平台无上限。
 * 本模块按**任务**计**连续**被拒次数,触顶后由调用方把任务判 failed;
 * 一次成功回写清零。
 *
 * 计数放进程内 Map 而非 DB:
 * - 「连续」本就是会话态,成功即清零,持久化收益小;
 * - 不改 schema / 不碰 state.ts·queue.ts(票面约束);
 * - server 重启计数丢失可接受:最坏再被拒 writebackRejectionLimit 次才熔断,
 *   仍远小于无上限自旋。
 *
 * 阈值读自 dispatch-policy.json(与 maxRetries 同源);缺失/非法 → 缺省 5。
 */

import {
  DEFAULT_WRITEBACK_REJECTION_LIMIT,
  readDispatchPolicy,
} from "@server/lib/executors";

interface RejectionStreak {
  count: number;
  lastMessage: string;
}

/** taskId → 当前连续被拒 streak。 */
const streaks = new Map<string, RejectionStreak>();

/**
 * 生效阈值。模块加载时读一次策略;测试可覆盖。
 * 不把该值塞进 state.ts:票面要求不动 state/queue,本模块自洽即可。
 */
let writebackRejectionLimit = readLimitFromPolicy();

function readLimitFromPolicy(): number {
  try {
    return readDispatchPolicy().writebackRejectionLimit;
  } catch {
    return DEFAULT_WRITEBACK_REJECTION_LIMIT;
  }
}

/** 当前回写被拒熔断阈值。 */
export function getWritebackRejectionLimit(): number {
  return writebackRejectionLimit;
}

/**
 * 记一次被拒,返回更新后的连续次数与最后原文。
 * 调用方在 count >= limit 时负责把任务判终态。
 */
export function recordWritebackRejection(
  taskId: string,
  message: string,
): RejectionStreak {
  const prev = streaks.get(taskId);
  const next: RejectionStreak = {
    count: (prev?.count ?? 0) + 1,
    lastMessage: message,
  };
  streaks.set(taskId, next);
  return next;
}

/** 一次成功回写:清零该任务的连续被拒计数。 */
export function clearWritebackRejections(taskId: string): void {
  streaks.delete(taskId);
}

/** 读当前连续被拒次数(无记录 → 0)。 */
export function getWritebackRejectionCount(taskId: string): number {
  return streaks.get(taskId)?.count ?? 0;
}

/** 测试专用:覆盖熔断阈值(小值 1~3 避免连打 API)。 */
export function __setWritebackRejectionLimitForTests(n: number): void {
  writebackRejectionLimit = Math.max(1, Math.floor(n));
}

/** 测试专用:清空全部计数并从策略文件重读阈值。 */
export function __resetWritebackRejectionsForTests(): void {
  streaks.clear();
  writebackRejectionLimit = readLimitFromPolicy();
}

/**
 * 终态 diffSummary.error 文案:必须含被拒次数与最后一次拒绝原文
 * (排障不靠重走执行器弯路)。
 */
export function formatWritebackRejectionTripError(
  count: number,
  limit: number,
  lastMessage: string,
): string {
  return `回写连续被拒 ${count} 次(阈值 ${limit}),平台判 failed。最后一次拒绝: ${lastMessage}`;
}
