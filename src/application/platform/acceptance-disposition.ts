/**
 * AcceptanceDisposition 专属 Platform 动作：协调者在验收时写下「这一条验收口径
 * 这次怎么处置」。
 *
 * 为什么单独一个模块而不是并进 contract-history 那一侧：留档是平台自动留的原文，
 * 处置是协调者主动作出的结论。合成一个动作之后，「契约改了」和「结论改了」就会
 * 变成同一件事，事后分不清「因为口径换了才重验」和「口径没动却重验了一遍」。
 *
 * 为什么全部核对都写在平台里：处置是要拿去挡下一轮工单的机器事实。平台不核，
 * 就等于「reuse」这句话由调用方一句话决定——它说没改过，就得信它没改过。所以
 * 复用必须自己去找：契约原文那条、报告那条、报告当时跑的命令与范围。
 *
 * 身份纪律：missionId / contractRevision / coordinatorAttemptId / at 全部来自调用
 * 参数、当前 Mission 与平台时钟。body 里只允许 dispositionId / index / decision /
 * workItemIds / basis，身份字段一律不从 body 取。
 *
 * 零第三方依赖：第三方只允许出现在 src/application/pg-store.ts。
 */

import type { Mission, MissionContract, WorkOrder } from '../../kernel/index.ts';
import {
  acceptanceDispositionsEqual,
  validateAcceptanceDisposition,
  type AcceptanceDecision,
  type AcceptanceDispositionBasis,
  type AcceptanceDispositionRecord,
} from '../acceptance-disposition.ts';
import type { ChangeImpact } from '../change-impact.ts';
import { CHANGE_IMPACT_DECIDED_KIND } from './change-impact.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import { reportReuseSpecMatches } from './validation-report-views.ts';
import type { QueueClaimIdentity } from './types.ts';

/** 缺仓储备时的统一拒绝：不退化成「跳过核对直接写」。 */
export const ACCEPTANCE_DISPOSITION_UNSUPPORTED = 'ACCEPTANCE_DISPOSITION_UNSUPPORTED';

/** 处置事件名。叙事与事件覆盖都按这一个名字归类。 */
export const ACCEPTANCE_DISPOSITION_RECORDED_KIND = 'acceptance.disposition_recorded';

/** 机器验收报告事件名：复用只能认这一条，不能按验收原文相似度去猜。 */
const VALIDATION_REPORTED_KIND = 'validation.reported';

/** 交卷事件名：revalidate / new_requirement 必须在失效之后重新交过卷。 */
const EXECUTION_RESULT_SUBMITTED_KIND = 'execution_result.submitted';

/** body 只允许这五个键；多一个（含任何身份字段）就拒。 */
const BODY_KEYS: readonly string[] = ['dispositionId', 'index', 'decision', 'workItemIds', 'basis'];

/** basis 允许出现的键。多一个是自造理由，少一个只是理由不完整——都按原文处理。 */
export const BASIS_KNOWN_KEYS: readonly string[] = [
  'submittedAttemptId',
  'reviewAttemptId',
  'reportId',
  'snapshotHash',
  'priorContractRevision',
  'note',
];

/** 契约改了判断要重做的两类结论。 */
const REPLACEMENT_DECISIONS = new Set<string>(['replan', 'cancel_replace']);

interface DispositionBody {
  readonly dispositionId: string;
  readonly index: number;
  readonly decision: AcceptanceDecision;
  readonly workItemIds: readonly string[];
  readonly basis: AcceptanceDispositionBasis;
}

interface ReportEvent {
  readonly event: { readonly at: string; readonly data: unknown };
  readonly reportId: string;
  readonly submittedAttemptId: string;
}

function reject(code: string, message: string): never {
  throw new PlatformRuleError(code, message);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    reject('ACCEPTANCE_DISPOSITION_REJECTED', `${label} 必须是非空字符串。`);
  }
  return value;
}

/**
 * 读 body。
 *
 * 只收形状，**不改原文**（basis.note 保存原样）：改写 caller 写的理由等于篡改理由。
 * 身份字段一律不收：允许调用方自己签自己的来源，处置就不再是事实。
 */
function readBody(body: unknown): DispositionBody {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    reject('ACCEPTANCE_DISPOSITION_REJECTED', '处置必须是对象。');
  }
  const raw = body as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length !== BODY_KEYS.length || keys.some((key) => !BODY_KEYS.includes(key))) {
    reject('ACCEPTANCE_DISPOSITION_REJECTED', 'body 只允许 dispositionId / index / decision / workItemIds / basis。');
  }
  const dispositionId = requireText(raw.dispositionId, 'body.dispositionId');
  const index = raw.index;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 1) {
    reject('ACCEPTANCE_DISPOSITION_REJECTED', 'body.index 必须是 >= 1 的整数。');
  }
  const decision = raw.decision;
  if (decision !== 'reuse' && decision !== 'revalidate' && decision !== 'new_requirement') {
    reject('ACCEPTANCE_DISPOSITION_REJECTED', 'body.decision 必须是 reuse | revalidate | new_requirement。');
  }
  const ids = raw.workItemIds;
  if (!Array.isArray(ids)) {
    reject('ACCEPTANCE_DISPOSITION_REJECTED', 'body.workItemIds 必须是数组。');
  }
  for (const id of ids) requireText(id, 'body.workItemIds 元素');
  const basisRaw = raw.basis;
  if (basisRaw === null || typeof basisRaw !== 'object' || Array.isArray(basisRaw)) {
    reject('ACCEPTANCE_DISPOSITION_REJECTED', 'body.basis 必须是对象。');
  }
  const basisKeys = Object.keys(basisRaw as Record<string, unknown>);
  if (basisKeys.some((key) => !BASIS_KNOWN_KEYS.includes(key))) {
    reject('ACCEPTANCE_DISPOSITION_REJECTED', 'body.basis 只允许 acceptance-disposition 已知的键。');
  }
  return {
    dispositionId,
    index,
    decision,
    workItemIds: ids as string[],
    // 内容校验交给 validateAcceptanceDisposition：形状规则写在那边一份就够，
    // 这里自己算一遍只会多出一处会和那边走偏的副本。
    basis: basisRaw as AcceptanceDispositionBasis,
  };
}

/**
 * 装配齐备才有资格写处置。
 *
 * 四个一样都不能少：少了处置仓储无处写，少了契约历史就问不出「上一版口径原文是
 * 什么」（缺历史按未知处理，不能当空数组放行 reuse），少了影响判断就看不出有没
 * 有改动打在这条口径上，少了报告仓储就取不到报告本身。
 */
function requireAssembled(ctx: PlatformContext): void {
  const ready =
    ctx.acceptanceDispositions &&
    ctx.contractHistories &&
    ctx.changeImpacts &&
    ctx.validation?.reports;
  if (!ready) {
    reject(
      ACCEPTANCE_DISPOSITION_UNSUPPORTED,
      '当前平台没有装配处置所需的处置 / 契约原文 / 影响 / 报告仓储。',
    );
  }
}

/**
 * index 必须落在当前契约的验收口径范围内。
 *
 * 超界的处置指向一条不存在的口径，之后「这条验过了」就谁也核对不上。
 */
function requireIndex(contract: MissionContract | undefined, index: number, missionId: string): void {
  const size = contract?.acceptance.length ?? 0;
  if (index > size || index < 1) {
    reject(
      'ACCEPTANCE_DISPOSITION_REJECTED',
      `mission ${missionId} 当前契约只有 ${size} 条验收口径，index ${index} 不在范围内。`,
    );
  }
}

/**
 * 每个工作项都得是本 Mission 的，且它的工单 order.criteria 显式含这条口径。
 *
 * criteria 缺省或空数组不算证明：老工单没有这个字段不是「自愿放弃关联」，按无关联
 * 处理才对；按「都算」处理就是让任何工单都能认领任何一条口径。
 */
async function requireCriteria(
  ctx: PlatformContext,
  mission: Mission,
  index: number,
  workItemIds: readonly string[],
): Promise<readonly WorkOrder[]> {
  if (workItemIds.length === 0) {
    reject('ACCEPTANCE_DISPOSITION_REJECTED', 'workItemIds 不得为空：处置必须点名哪些工作项证明这条口径。');
  }
  const orders: WorkOrder[] = [];
  for (const workItemId of workItemIds) {
    const item = mission.workItem(workItemId);
    if (item === undefined) {
      reject('ACCEPTANCE_DISPOSITION_REJECTED', `工作项 ${workItemId} 不属于 mission ${mission.id}。`);
    }
    const order = item.order;
    const criteria = order?.criteria;
    if (order === undefined || !Array.isArray(criteria) || !criteria.includes(index)) {
      reject(
        'ACCEPTANCE_DISPOSITION_REJECTED',
        `工作项 ${workItemId} 的工单没有显式声明覆盖第 ${index} 条验收口径。`,
      );
    }
    orders.push(order);
  }
  return orders;
}

/**
 * 一条机器验收报告事件：workItemId、报告 id、提交 attempt 三项都对上才算。
 *
 * validationReportKey 只是归属的名字，查找就是扫这些事件——不按键去查，是因为
 * 键里没有报告 id，同一次提交可能报过多份报告。
 */
function reportEventFor(
  events: readonly { readonly at: string; readonly workItemId?: string; readonly kind: string; readonly data: unknown }[],
  workItemId: string,
  reportId: string,
  submittedAttemptId: string,
): ReportEvent | undefined {
  for (const event of events) {
    if (event.kind !== VALIDATION_REPORTED_KIND) continue;
    if (event.workItemId !== workItemId) continue;
    const data = event.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
    const row = data as Record<string, unknown>;
    if (row.reportId !== reportId) continue;
    if (row.submittedAttemptId !== submittedAttemptId) continue;
    return { event: { at: event.at, data }, reportId, submittedAttemptId };
  }
  return undefined;
}

function asMillis(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * 取某条口径最近的失效时刻；没有则 undefined。
 *
 * 三个来源：契约原文换代时这条口径被改写（含新增）、改动判断打在这条口径上、
 * 结论是重排 / 取消替换且该工作项当前工单显式含这条口径。缺一条就会让「契约已经
 * 换了但报告还是旧的」通过复用。
 */
async function invalidationAt(
  ctx: PlatformContext,
  mission: Mission,
  index: number,
  orders: readonly WorkOrder[],
): Promise<string | undefined> {
  const history = (await ctx.contractHistories!.listByMission(mission.id)).slice().sort(
    (a, b) => a.contractRevision - b.contractRevision,
  );
  let latest: number | undefined;
  const bump = (iso: string | undefined): void => {
    if (iso === undefined) return;
    const ms = asMillis(iso);
    if (latest === undefined || ms > latest) latest = ms;
  };
  // 相邻两版里这条口径的字符串变了，就说明这一版之后旧证据不再证明它。
  for (let i = 1; i < history.length; i += 1) {
    const prev = history[i - 1]!;
    const curr = history[i]!;
    if (prev.acceptance[index - 1] !== curr.acceptance[index - 1]) bump(curr.at);
  }
  const current = mission.contract?.acceptance[index - 1];
  const last = history[history.length - 1];
  if (last !== undefined && current !== undefined && last.contractRevision === mission.contractRevision) {
    // 上一版根本没有这一条（新增）也算「原文变了」：新增的口径没有旧证据可用。
    if (last.acceptance[index - 1] !== current) bump(last.at);
  }

  const impacts = await ctx.changeImpacts!.listByMission(mission.id);
  const events = await ctx.activity.list(mission.id);
  const impactEvents = events.filter(
    (event) => event.kind === CHANGE_IMPACT_DECIDED_KIND,
  ) as readonly { readonly at: string; readonly kind: string; readonly data: unknown }[];
  for (const event of impactEvents) {
    const data = event.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
    const affected = (data as Record<string, unknown>).affectedAcceptance;
    if (!Array.isArray(affected) || !affected.includes(index)) continue;
    bump(event.at);
  }
  // 有判断记录却没有对应事件：判断已经成立但事件不在台账里，无从知道它是什么
  // 时候成立的。按「刚刚失效」处理——宁可要求重验，也不能把没记时刻的判断当成
  // 从未发生。
  for (const impact of impacts) {
    if (!impact.affectedAcceptance.includes(index)) continue;
    const changeId = (impact as ChangeImpact).changeId;
    const hasEvent = impactEvents.some((event) => {
      const data = event.data;
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return false;
      return (data as Record<string, unknown>).changeId === changeId;
    });
    if (!hasEvent) bump(ctx.clock.now().toISOString());
  }

  for (const event of events as readonly { readonly at: string; readonly kind: string; readonly data: unknown; readonly workItemId?: string }[]) {
    if (event.kind !== CHANGE_IMPACT_DECIDED_KIND) continue;
    const data = event.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
    const row = data as Record<string, unknown>;
    if (row.decision !== 'replan' && row.decision !== 'cancel_replace') continue;
    const workItemId = typeof row.workItemId === 'string' ? row.workItemId : event.workItemId;
    if (workItemId === undefined) continue;
    const item = mission.workItem(workItemId);
    const criteria = item?.order?.criteria;
    if (!Array.isArray(criteria) || !criteria.includes(index)) continue;
    bump(event.at);
  }
  for (let i = 0; i < orders.length; i += 1) {
    void orders[i];
  }
  return latest === undefined ? undefined : new Date(latest).toISOString();
}

/**
 * reuse 的复用核对。
 *
 * 三件事都成立才叫「没变」：上一版契约原文里这条口径一字不差（没有历史就是原文
 * 未知，不能 reuse）、这份报告确实是按当前工单这套命令与范围跑出来的、报告之后
 * 没有改动打在这条口径上。任一不成立就拒绝。
 */
async function requireReuse(
  ctx: PlatformContext,
  mission: Mission,
  index: number,
  basis: AcceptanceDispositionBasis,
  workItemIds: readonly string[],
  orders: readonly WorkOrder[],
): Promise<void> {
  const priorRevision = basis.priorContractRevision;
  const submittedAttemptId = basis.submittedAttemptId;
  const reportId = basis.reportId;
  if (priorRevision === undefined || submittedAttemptId === undefined || reportId === undefined) {
    reject(
      'ACCEPTANCE_DISPOSITION_REJECTED',
      'reuse 必须给出 basis.priorContractRevision / submittedAttemptId / reportId。',
    );
  }
  const prior = await ctx.contractHistories!.get(mission.id, priorRevision);
  if (prior === undefined) {
    reject(
      'ACCEPTANCE_DISPOSITION_REJECTED',
      `没有第 ${priorRevision} 版契约原文的留档，第 ${index} 条口径的原文无从比对，不能复用。`,
    );
  }
  const currentText = mission.contract?.acceptance[index - 1];
  if (prior.acceptance[index - 1] !== currentText) {
    reject(
      'ACCEPTANCE_DISPOSITION_REJECTED',
      `第 ${index} 条验收口径在第 ${priorRevision} 版与当前原文不一致，不能复用旧证据。`,
    );
  }
  const events = await ctx.activity.list(mission.id);
  const reports = ctx.validation!.reports;
  let evidenceAt: number | undefined;
  for (let i = 0; i < workItemIds.length; i += 1) {
    const workItemId = workItemIds[i]!;
    const found = reportEventFor(events, workItemId, reportId, submittedAttemptId);
    if (found === undefined) {
      reject(
        'ACCEPTANCE_DISPOSITION_REJECTED',
        `工作项 ${workItemId} 没有报告 ${reportId} / 提交 ${submittedAttemptId} 对应的 validation.reported。`,
      );
    }
    const report = await reports.get(reportId);
    if (report === undefined) {
      reject('ACCEPTANCE_DISPOSITION_REJECTED', `报告 ${reportId} 不存在。`);
    }
    if (report.missionId !== mission.id) {
      reject('ACCEPTANCE_DISPOSITION_REJECTED', `报告 ${reportId} 不属于 mission ${mission.id}。`);
    }
    if (report.workItemId !== undefined && report.workItemId !== workItemId) {
      reject('ACCEPTANCE_DISPOSITION_REJECTED', `报告 ${reportId} 的工作项与 ${workItemId} 不符。`);
    }
    if (report.attemptId !== undefined && report.attemptId !== submittedAttemptId) {
      reject('ACCEPTANCE_DISPOSITION_REJECTED', `报告 ${reportId} 的 attempt 与 ${submittedAttemptId} 不符。`);
    }
    const order = orders[i]!;
    // 命令或范围不等、事件缺 commands，都是 false：不明确相等就是换了另一件事。
    const matches = reportReuseSpecMatches({
      eventData: found.event.data,
      report,
      orderAllowedScope: order.allowedScope,
      orderCommands: order.validation?.commands ?? [],
    });
    if (!matches) {
      reject(
        'ACCEPTANCE_DISPOSITION_REJECTED',
        `报告 ${reportId} 的命令 / 范围与工作项 ${workItemId} 当前工单不等，不能复用。`,
      );
    }
    const ms = asMillis(found.event.at);
    if (evidenceAt === undefined || ms < evidenceAt) evidenceAt = ms;
  }
  // 证据之后的改动打在这条口径上：报告是在改动之前跑的，证不到改动之后。
  const impacts = await ctx.changeImpacts!.listByMission(mission.id);
  const impactEvents = (await ctx.activity.list(mission.id)) as readonly {
    readonly at: string;
    readonly kind: string;
    readonly data: unknown;
  }[];
  for (const event of impactEvents) {
    if (event.kind !== CHANGE_IMPACT_DECIDED_KIND) continue;
    const data = event.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
    const affected = (data as Record<string, unknown>).affectedAcceptance;
    if (!Array.isArray(affected) || !affected.includes(index)) continue;
    if (asMillis(event.at) >= (evidenceAt ?? Number.NEGATIVE_INFINITY)) {
      reject(
        'ACCEPTANCE_DISPOSITION_REJECTED',
        `第 ${index} 条口径在证据之后有改动判断（${event.at}），不能复用旧证据。`,
      );
    }
  }
  // 有判断记录却没有对应事件：判断已经成立，时刻却无从知道，按「刚刚」处理。
  for (const impact of impacts) {
    if (!impact.affectedAcceptance.includes(index)) continue;
    const hasEvent = impactEvents.some((event) => {
      if (event.kind !== CHANGE_IMPACT_DECIDED_KIND) return false;
      const data = event.data;
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return false;
      return (data as Record<string, unknown>).changeId === impact.changeId;
    });
    if (!hasEvent) {
      reject(
        'ACCEPTANCE_DISPOSITION_REJECTED',
        `changeId ${impact.changeId} 的影响判断没有对应的 ${CHANGE_IMPACT_DECIDED_KIND} 事件，无从判断证据先后，不能复用。`,
      );
    }
  }
}

/**
 * revalidate / new_requirement 的核对：失效之后重新跑过、重新交过卷。
 *
 * 不要求命令全等——这两类处置的含义就是「按新的做一遍」，命令变了才是正常的。
 * 但证据必须严格晚于失效时刻：等于也不行，同一时刻区分不出先后。
 */
async function requireFreshEvidence(
  ctx: PlatformContext,
  mission: Mission,
  index: number,
  basis: AcceptanceDispositionBasis,
  workItemIds: readonly string[],
  orders: readonly WorkOrder[],
  decision: AcceptanceDecision,
): Promise<void> {
  const submittedAttemptId = basis.submittedAttemptId;
  const reportId = basis.reportId;
  if (submittedAttemptId === undefined || reportId === undefined) {
    reject(
      'ACCEPTANCE_DISPOSITION_REJECTED',
      `${decision} 必须给出 basis.submittedAttemptId 与 reportId。`,
    );
  }
  const invalidated = await invalidationAt(ctx, mission, index, orders);
  const events = await ctx.activity.list(mission.id);
  const reports = ctx.validation!.reports;
  for (const workItemId of workItemIds) {
    const found = reportEventFor(events, workItemId, reportId, submittedAttemptId);
    if (found === undefined) {
      reject(
        'ACCEPTANCE_DISPOSITION_REJECTED',
        `工作项 ${workItemId} 没有报告 ${reportId} / 提交 ${submittedAttemptId} 对应的 validation.reported。`,
      );
    }
    const submitted = events.some((event) => {
      if (event.kind !== EXECUTION_RESULT_SUBMITTED_KIND) return false;
      if (event.attemptId !== submittedAttemptId) return false;
      if (event.workItemId !== workItemId) return false;
      return true;
    });
    if (!submitted) {
      reject(
        'ACCEPTANCE_DISPOSITION_REJECTED',
        `工作项 ${workItemId} 没有提交 ${submittedAttemptId} 的 execution_result.submitted。`,
      );
    }
    const report = await reports.get(reportId);
    if (report === undefined) {
      reject('ACCEPTANCE_DISPOSITION_REJECTED', `报告 ${reportId} 不存在。`);
    }
    if (report.missionId !== mission.id) {
      reject('ACCEPTANCE_DISPOSITION_REJECTED', `报告 ${reportId} 不属于 mission ${mission.id}。`);
    }
    if (invalidated === undefined) continue;
    // 严格大于：同一时刻分不出先后，等于只能算「可能是改动之前跑的」。
    const bar = asMillis(invalidated);
    if (asMillis(found.event.at) <= bar) {
      reject(
        'ACCEPTANCE_DISPOSITION_REJECTED',
        `报告 ${reportId} 的 validation.reported 不晚于第 ${index} 条口径的失效时刻 ${invalidated}。`,
      );
    }
    if (!submitted || !events.some((event) => {
      if (event.kind !== EXECUTION_RESULT_SUBMITTED_KIND) return false;
      if (event.attemptId !== submittedAttemptId) return false;
      if (event.workItemId !== workItemId) return false;
      return asMillis(event.at) > bar;
    })) {
      reject(
        'ACCEPTANCE_DISPOSITION_REJECTED',
        `提交 ${submittedAttemptId} 的 execution_result.submitted 不晚于第 ${index} 条口径的失效时刻 ${invalidated}。`,
      );
    }
  }
}

/**
 * 记下一条处置。
 *
 * 核对顺序即拒绝顺序：装配 → 身份 → 形状 → 范围与 criteria → 证据 → 落库。任一条
 * 不符就抛，事务回滚，盘上一个字节都不变。
 */
export async function recordAcceptanceDisposition(
  ctx: PlatformContext,
  missionId: string,
  coordinatorAttemptId: string,
  body: unknown,
  claim?: QueueClaimIdentity,
): Promise<AcceptanceDispositionRecord> {
  requireAssembled(ctx);
  const dispositions = ctx.acceptanceDispositions!;
  return ctx.attemptWrite(missionId, coordinatorAttemptId, claim, async () => {
    // 执行者 attempt 会得到已有的 WRONG_ROLE：不要包一层，让错误码保持统一。
    const { mission } = await ctx.requireAttempt(missionId, coordinatorAttemptId, 'coordinator');
    const business = readBody(body);
    requireIndex(mission.contract, business.index, missionId);
    const orders = await requireCriteria(ctx, mission, business.index, business.workItemIds);
    // 身份字段只从参数与时钟取：body 里的身份一律不信。basis 原样带上，
    // 出现与否本身就是依据的一部分。
    const record: AcceptanceDispositionRecord = {
      dispositionId: business.dispositionId,
      missionId,
      contractRevision: mission.contractRevision,
      index: business.index,
      decision: business.decision,
      workItemIds: business.workItemIds,
      basis: business.basis,
      coordinatorAttemptId,
      at: ctx.clock.now().toISOString(),
    };
    if (business.decision === 'reuse') {
      await requireReuse(ctx, mission, business.index, business.basis, business.workItemIds, orders);
    } else {
      await requireFreshEvidence(
        ctx,
        mission,
        business.index,
        business.basis,
        business.workItemIds,
        orders,
        business.decision,
      );
    }
    const validated = validateAcceptanceDisposition(record);
    const existing = await dispositions.get(business.dispositionId);
    // 同键异内容由仓储抛 AcceptanceDispositionConflictError——不接住、不覆盖：
    // 处置是 append-only 事实，静默覆盖会让追溯时看到一条却说不清它是第几次判断。
    if (existing !== undefined && acceptanceDispositionsEqual(existing, validated)) {
      return existing;
    }
    await dispositions.append(validated);
    await ctx.event(
      mission,
      ACCEPTANCE_DISPOSITION_RECORDED_KIND,
      {
        dispositionId: business.dispositionId,
        index: business.index,
        decision: business.decision,
        contractRevision: mission.contractRevision,
        workItemIds: [...business.workItemIds],
      },
      business.workItemIds[0],
      coordinatorAttemptId,
    );
    return (await dispositions.get(business.dispositionId)) ?? validated;
  });
}
