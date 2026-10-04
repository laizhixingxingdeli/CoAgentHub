import type { WorkItem, ValidationReport } from '../../kernel/index.ts';
import type { ActivityEvent } from '../ports.ts';
import type { StandardAutoRedispatchHandoff } from './types.ts';
import { redactSecrets } from '../redact.ts';

/**
 * 自动接续事件（名字冻结）：机器把一次 partial / 验证失败退回执行者时写一条。
 *
 * 单独一种事件而不是复用 work_item.dispatched：这一条要能回答「谁把工单退回去的、
 * 依据是哪次提交的哪份报告、这是第几次」，而协调者的派发答不了这些。
 * 名字只在这里写一次，事件翻译表（web）按它对齐。
 */
export const STANDARD_AUTO_REDISPATCH_EVENT_KIND = 'work_item.auto_redispatched';

/**
 * 同一原因（partial / validation_failed）每工作项最多自动续派两次。
 *
 * 第三次把 submitted 原样留给 L2：机器能判的只有"还能再试"；试了两次还是不行，
 * 说明问题多半不在执行者手上，该看的是工单本身。
 */
export const STANDARD_AUTO_REDISPATCH_LIMIT = 2;

/**
 * 交接摘要保留长度（先脱敏再截尾）。
 *
 * 摘要是给下一跳执行者和（触顶时）L2 看的，会随事件进状态、进协调者简报。
 * 整份搬进去等于换个地方把测试输出重新灌回上下文。
 */
const AUTO_REDISPATCH_SUMMARY_MAX_CHARS = 500;

/** 自动续派的依据。 */
export type StandardAutoRedispatchReason = 'partial' | 'validation_failed';

/** 没有自动续派时的原因；编排器据此决定继续等 L2 还是就此收工。 */
export type StandardAutoRedispatchSkipReason =
  /** 当前不是 submitted：已续派过、已被评审、从未交卷。 */
  | 'not_submitted'
  /** 没有可自动续派的依据：非 partial、缺报告、报告不属于这次提交、报告跑绿。 */
  | 'no_auto_reason'
  /** 这一次提交已经自动续派过（编排器重启后重复调用必须无害）。 */
  | 'already_redispatched'
  /** 该原因已经用满两次，留给 L2。 */
  | 'limit_reached'
  /** 已有未答复的诊断卡：停派中，不绕过。 */
  | 'criteria_failure_stopped';






/** 已落盘的 auto 事件里认得出的那一份交接。 */
interface AutoRedispatchEventRow {
  readonly reason: StandardAutoRedispatchReason;
  readonly attemptId: string;
  readonly count: number;
  readonly summary: string;
  readonly reportId?: string;
}

/**
 * 事件 data → 交接。形状对不上的（老快照 / 别人手写的）一律当没有：
 * 认错一条事件等于把不相干的说明当成上一轮交接。
 */
function autoRedispatchEventRow(event: ActivityEvent): AutoRedispatchEventRow | undefined {
  if (event.kind !== STANDARD_AUTO_REDISPATCH_EVENT_KIND) return undefined;
  const data = event.data;
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const row = data as Record<string, unknown>;
  const reason = row.reason;
  if (reason !== 'partial' && reason !== 'validation_failed') return undefined;
  const attemptId = row.attemptId;
  if (typeof attemptId !== 'string' || attemptId.length === 0) return undefined;
  const count = row.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return undefined;
  const summary = row.summary;
  if (typeof summary !== 'string') return undefined;
  const reportId = row.reportId;
  return {
    reason,
    attemptId,
    count,
    summary,
    ...(typeof reportId === 'string' && reportId.length > 0 ? { reportId } : {}),
  };
}

/** 正序扫一遍事件流，取该工作项所有认得出的 auto 事件（计数按原因各自累加）。 */
export function autoRedispatchEventsFor(
  events: readonly ActivityEvent[],
  workItemId: string,
): AutoRedispatchEventRow[] {
  const rows: AutoRedispatchEventRow[] = [];
  for (const event of events) {
    if (event.workItemId !== workItemId) continue;
    const row = autoRedispatchEventRow(event);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * 这一次提交是不是交在 Mission 升级之前（Lightweight 那一跳的卷）。
 *
 * Lightweight 验证失败升级时，失败报告在升级**前**就落了盘，提交也发生在升级前。
 * 升级后恢复循环会拿同一条提交回来问自动续派——它不是「机器能判的还能再试」，
 * 而是一份正要交给 L2 的失败报告。放行它，两次自动续派会烧在这份交卷上，
 * 协调者反而永远等不到它该接手的那一票。
 *
 * 因此按事件流里的先后比位置，而不是看「Mission 是否升级过」：升级之后由新的
 * Standard attempt 交的卷排在 promoted 之后，仍该照常自动续派。匹配必须精确到
 * workItemId + attemptId，认错一条事件就等于把别人那一跳的卷判成升级前的。
 */
export function submissionPrecedesPromotion(
  events: readonly ActivityEvent[],
  workItemId: string,
  submittedAttemptId: string,
): boolean {
  const promotedIndex = events.findIndex((event) => event.kind === 'mission.promoted');
  if (promotedIndex < 0) return false;
  const submittedIndex = events.findIndex(
    (event) =>
      event.kind === 'execution_result.submitted' &&
      event.workItemId === workItemId &&
      event.attemptId === submittedAttemptId,
  );
  if (submittedIndex < 0) return false;
  return submittedIndex < promotedIndex;
}

/**
 * 交接摘要：**先脱敏、再截尾**。
 *
 * 顺序反了（先截尾）会把截断点切在一个 key 中间，剩下的半截对不上任何凭据形状，
 * 于是明文就这么漏出去——和报告简版是同一个坑。
 */
export function autoRedispatchSummary(text: string): string {
  const redacted = redactSecrets(text);
  return redacted.length <= AUTO_REDISPATCH_SUMMARY_MAX_CHARS
    ? redacted
    : redacted.slice(-AUTO_REDISPATCH_SUMMARY_MAX_CHARS);
}

/** 失败报告的交接摘要：哪条命令、退出码/超时、报告自己那句 summary。 */
export function failedValidationSummary(report: ValidationReport): string {
  const parts: string[] = [];
  for (const check of report.checks) {
    if (check.passed) continue;
    const command = check.command;
    parts.push(
      check.kind === 'command' && command
        ? `${command.argv.join(' ')}: ${check.summary}`
        : `${check.kind}: ${check.summary}`,
    );
  }
  const text = parts.join('; ');
  return autoRedispatchSummary(text.length > 0 ? text : `报告 ${report.id} 未通过`);
}

/** 事件行 + 工单 → 交接（partial 才从原提交 Attempt 上取续跑句柄）。 */
export function standardAutoRedispatchHandoff(
  item: WorkItem,
  row: AutoRedispatchEventRow,
): StandardAutoRedispatchHandoff {
  // 只有 partial 才带上上一跳的续跑句柄：那一跳是"做了一半"，接着它的会话往下做最省。
  // validation_failed 不给：那条会话产出的结果已经被机器判为不合格，续上它等于把
  // 同一份上下文原样再喂一遍。
  const resumeRef =
    row.reason === 'partial'
      ? item.attempts.find((attempt) => attempt.id === row.attemptId)?.resumeRef
      : undefined;
  return {
    workItemId: item.id,
    reason: row.reason,
    attemptId: row.attemptId,
    count: row.count,
    summary: row.summary,
    ...(row.reportId !== undefined ? { reportId: row.reportId } : {}),
    ...(resumeRef !== undefined ? { resumeRef } : {}),
  };
}



