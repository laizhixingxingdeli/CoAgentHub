import type { AcceptanceResult, ReviewAuthority, ReviewRecord } from '../../kernel/index.ts';
import { PlatformRuleError, type PlatformContext } from './context.ts';
import { redactSecrets } from '../redact.ts';

/**
 * 一张工单的验收历史（只读投影）。
 *
 * `reviewId` 由 (missionId, workItemId, index) 拼出来：reviews 是 append-only 的
 * 数组，index 本身稳定；但单给一个数字，前端拿到别的工单的 index 就分不清是哪条，
 * 所以 id 里带全路径。用它当 cursor 或前端 key 都不会歧义。
 */
export interface WorkItemReviewHistoryEntry {
  readonly reviewId: string;
  /** 在 item.reviews 里的下标，从 0 开始。 */
  readonly reviewIndex: number;
  readonly review: ReviewRecord;
}

export interface WorkItemReviewHistory {
  readonly items: readonly WorkItemReviewHistoryEntry[];
  /** 下一页起点；到底了给 null。 */
  readonly nextCursor: number | null;
  readonly total: number;
}

export const REVIEW_HISTORY_DEFAULT_LIMIT = 50;
export const REVIEW_HISTORY_MAX_LIMIT = 100;

/** 验收记录里的文本字段：证据/原因可能带着执行者跑过的命令输出，一律脱敏。 */
function copyAcceptanceResult(result: AcceptanceResult): AcceptanceResult {
  return {
    criterion: redactSecrets(result.criterion),
    status: result.status,
    ...(result.evidence !== undefined ? { evidence: redactSecrets(result.evidence) } : {}),
    ...(result.note !== undefined ? { note: redactSecrets(result.note) } : {}),
  };
}

/**
 * 复制 authority 的两种已知形状（照 kernel/work-item.ts 的 copyAuthority）。
 *
 * 不复用 kernel 那个：它是写入路径的私有函数；这里直接返回新对象，
 * 免得把 domain 里 deep freeze 过的引用交出去——调用方一改就撞上只读对象，
 * 而「返回深拷贝」的承诺就破了。判别联合只有两种形状，逐形状抄比展开更稳：
 * 展开会把将来多出来的字段一并带出去。
 */
function copyAuthority(authority: ReviewAuthority): ReviewAuthority {
  if (authority.kind === 'validator') {
    return {
      kind: 'validator',
      reportId: authority.reportId,
      policyRevision: authority.policyRevision,
    };
  }
  return {
    kind: 'coordinator',
    attemptId: authority.attemptId,
  };
}

/**
 * 深复制一条 ReviewRecord 并脱敏。
 *
 * 为什么逐字段抄而不是 JSON 往返：`submittedAttemptId` / `acceptanceResults` 缺省
 * 时要保持「没有」而不是变成 null/空数组——读取方靠这个区分「机器评审没给」和
 * 「给了但是空的」。
 */
function copyReview(review: ReviewRecord): ReviewRecord {
  return {
    ...(review.attemptId !== undefined ? { attemptId: review.attemptId } : {}),
    ...(review.submittedAttemptId !== undefined
      ? { submittedAttemptId: review.submittedAttemptId }
      : {}),
    ...(review.authority !== undefined ? { authority: copyAuthority(review.authority) } : {}),
    verdict: review.verdict,
    reasons: review.reasons.map((reason) => redactSecrets(reason)),
    requiredChanges: review.requiredChanges.map((change) => redactSecrets(change)),
    ...(review.acceptanceResults !== undefined
      ? { acceptanceResults: review.acceptanceResults.map(copyAcceptanceResult) }
      : {}),
  };
}

function checkCursor(cursor: number): number {
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new PlatformRuleError('INVALID_CURSOR', 'cursor 必须是 >= 0 的整数。');
  }
  return cursor;
}

function checkLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > REVIEW_HISTORY_MAX_LIMIT) {
    throw new PlatformRuleError(
      'INVALID_LIMIT',
      `limit 必须是 1..${REVIEW_HISTORY_MAX_LIMIT} 的整数。`,
    );
  }
  return limit;
}

/**
 * 读一张工单的全部验收记录（分页）。
 *
 * 只读：不记事件、不碰 `lastReview`、不改 `item.reviews`——视图里的 `lastReview`
 * 是「当前这一条」，这里给的是历史，两者不能互相污染。
 *
 * 未知工单沿用 `UNKNOWN_WORK_ITEM`：与其它工单级读口同一句错误，前端不必为这个
 * 接口单独分支。
 */
export async function getWorkItemReviewHistory(
  ctx: PlatformContext,
  missionId: string,
  workItemId: string,
  options: { readonly cursor?: number; readonly limit?: number } = {},
): Promise<WorkItemReviewHistory> {
  const cursor = checkCursor(options.cursor ?? 0);
  const limit = checkLimit(options.limit ?? REVIEW_HISTORY_DEFAULT_LIMIT);
  const { mission } = await ctx.locate(missionId);
  const item = mission.workItem(workItemId);
  if (!item) {
    throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${workItemId} 不存在`);
  }
  const reviews = item.reviews;
  // cursor 越界不给 400：历史只会变长，拿旧 cursor 重放是正常调用，回空页即可。
  const start = Math.min(cursor, reviews.length);
  const end = Math.min(start + limit, reviews.length);
  const items: WorkItemReviewHistoryEntry[] = [];
  for (let index = start; index < end; index += 1) {
    const review = reviews[index];
    if (review === undefined) break;
    items.push({
      reviewId: JSON.stringify([missionId, workItemId, index]),
      reviewIndex: index,
      review: copyReview(review),
    });
  }
  return {
    items,
    nextCursor: end < reviews.length ? end : null,
    total: reviews.length,
  };
}
