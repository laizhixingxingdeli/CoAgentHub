// 独立票级门禁：费用上限与工作项检查点。
//
// 本模块是纯费用求值（evaluateMissionCost）之上的「持久、可答复」门禁层：把费用
// 与 15 倍数的工作项检查点转成 Mission 上的 waitReason + 平台升级，并给后续
// escalations 答复接线提供解析/apply/清理辅助。
//
// 不碰内核、不迁移数据、不引入反向 import（escalations 不得 import 本模块）；
// 后续答复由 Platform 注入回调。所有写动作都落在调用方已开的事务里，本模块
// 不再开 ctx.tx —— 这样它能被已有 attemptWrite / tx 中的调用方复用。

import { PlatformRuleError } from './context.ts';
import { recordEscalationAndDeliver } from './escalations.ts';
import { evaluateMissionCost, type MissionCostInput } from '../ticket-budget.ts';
import type { Mission, WaitReason, EscalationBody } from '../../kernel/index.ts';
import type { PlatformContext } from './context.ts';

/** 检查点间隔：Standard 工作项总数（含退役）达到尚未批准的 15 倍数即停等。 */
export const WORK_ITEM_CHECKPOINT_INTERVAL = 15;

export interface TicketGateResult {
  readonly stopped: boolean;
  readonly reason?: WaitReason;
  readonly detail?: string;
}

/** 把 Mission 上的 attempt 转成 evaluateMissionCost 需要的纯输入形状。 */
function missionToCostInput(mission: Mission): MissionCostInput {
  const attemptOf = (a: { kind: string; usage: unknown; profile?: unknown }) => ({
    kind: a.kind,
    usage: (a.usage ?? {}) as { cost?: number },
    profile: a.profile as { id?: string; profileId?: string; resolved?: readonly { key: string; value: string }[] } | undefined,
  });
  return {
    id: mission.id,
    origin: mission.origin?.rerunOf ? { rerunOf: mission.origin.rerunOf } : undefined,
    coordinatorAttempts: mission.coordinatorAttempts.map(attemptOf),
    independentReviewerAttempts: mission.independentReviewerAttempts.map(attemptOf),
    workItems: mission.workItems.map((item) => ({ attempts: item.attempts.map(attemptOf) })),
  };
}

/** 最近一条失败事实：reject review / 失败 Attempt / blocked / result notes。找不到写「无」。 */
function recentFailureFact(mission: Mission): string {
  for (const item of [...mission.workItems].reverse()) {
    const reject = [...item.reviews].reverse().find((r) => r.verdict === 'reject');
    if (reject) return `工作项 ${item.id} 验收被拒：${reject.reasons.join('；')}`;
    const failed = [...item.attempts].reverse().find((a) => a.status === 'failed');
    if (failed) return `工作项 ${item.id} 的尝试 ${failed.id} 失败：${failed.failReason ?? '无原因'}`;
    if (item.blocked) return `工作项 ${item.id} 受阻：${item.blocked.reason}`;
  }
  const result = mission.result;
  if (result && typeof result === 'object' && 'notes' in result && typeof (result as { notes?: unknown }).notes === 'string' && (result as { notes: string }).notes.length > 0) {
    return `最近交卷备注：${(result as { notes: string }).notes}`;
  }
  return '无（未找到明确的失败事实）';
}

/**
 * 历史上是否已为同 kind/threshold 投递过平台门禁（含已答复的）。
 *
 * 只看未答复升级会重复投递：检视者答复「不要继续」后阈值仍未批准，下一轮检查
 * 又发一张同样的卡。已投递过就保持阻断、不再打扰，等阈值变化（增额/批准）再说。
 */
function hasOpenGate(mission: Mission, kind: 'cost_cap' | 'work_item_checkpoint', threshold: number): boolean {
  return mission.escalations.some(
    (e) => e.platformGate?.kind === kind && e.platformGate.threshold === threshold,
  );
}

/** 升级 question/why 的事实归因：总费用/上限、按 role 与 candidate 费用、工作项数、最近失败。 */
function gateQuestionWhy(
  mission: Mission,
  kind: 'cost_cap' | 'work_item_checkpoint',
  cost: { total: number; costCap?: number; byRole: readonly { role: string; cost: number }[]; byCandidate: readonly { candidateId: string; cost: number }[] },
  facts: { workItemCount: number; threshold: number },
): { question: string; why: string } {
  const failure = recentFailureFact(mission);
  const cap = cost.costCap === undefined ? '（未设）' : `$${cost.costCap}`;
  const byRole = cost.byRole.map((r) => `${r.role} $${r.cost.toFixed(2)}`).join('、') || '无';
  const byCandidate = cost.byCandidate.map((c) => `${c.candidateId} $${c.cost.toFixed(2)}`).join('、') || '无';
  if (kind === 'cost_cap') {
    const question = `票级费用已到 $${cost.total.toFixed(2)} / 上限 ${cap}，是否批准追加预算？`;
    const why = `总费用 $${cost.total.toFixed(2)}（上限 ${cap}）；按角色：${byRole}；按候选：${byCandidate}；当前工作项 ${facts.workItemCount} 个；最近失败事实：${failure}`;
    return { question, why };
  }
  // 问句用检查点阈值本身：费用上限跟「要不要拆票」无关，写上限会让检视者误读。
  const question = `工作项已达 ${facts.workItemCount} 个（检查点 ${facts.threshold} 未批准），是否拆票继续？`;
  const why = `工作项总数 ${facts.workItemCount}（含退役）；总费用 $${cost.total.toFixed(2)}（上限 ${cap}）；按角色：${byRole}；按候选：${byCandidate}；最近失败事实：${failure}`;
  return { question, why };
}

/** 取答复用的 attemptId：显式值优先，否则最近 coordinator 尝试 id，都没有用空串。 */
function attemptIdFor(mission: Mission, attemptId?: string): string {
  if (attemptId) return attemptId;
  const latest = [...mission.coordinatorAttempts].reverse()[0];
  return latest ? latest.id : '';
}

/** 已批准的检查点水位：activity 里 mission.work_item_checkpoint.approved 的最大 threshold。 */
async function approvedCheckpointThresholdAsync(ctx: PlatformContext, missionId: string): Promise<number> {
  const events = await ctx.activity.list(missionId);
  let threshold = 0;
  for (const e of events) {
    if (e.kind === 'mission.work_item_checkpoint.approved' && e.data && typeof e.data === 'object' && typeof (e.data as { threshold?: unknown }).threshold === 'number') {
      // 取最大而不是最后一次：事件顺序不该让「批准过 30」被后写的 15 覆盖掉。
      threshold = Math.max(threshold, (e.data as { threshold: number }).threshold);
    }
  }
  return threshold;
}

/** 当前未批准的最近检查点阈值：大于已批准水位的下一个 15 倍数。 */
async function nextCheckpointThreshold(ctx: PlatformContext, mission: Mission): Promise<number> {
  const approved = await approvedCheckpointThresholdAsync(ctx, mission.id);
  return Math.floor(approved / WORK_ITEM_CHECKPOINT_INTERVAL) * WORK_ITEM_CHECKPOINT_INTERVAL + WORK_ITEM_CHECKPOINT_INTERVAL;
}

export async function enforceMissionTicketGates(
  ctx: PlatformContext,
  missionId: string,
  attemptId?: string,
): Promise<TicketGateResult> {
  const { mission } = await ctx.locate(missionId);
  const all = (await ctx.projects.list()).flatMap((p) => p.missions);
  const me = all.find((m) => m.id === missionId);
  if (!me) return { stopped: false };
  const cost = evaluateMissionCost(missionToCostInput(me), all.map(missionToCostInput), me.costCap);
  // 费用优先于检查点：先让用户决定要不要加钱，再谈拆票。
  if (cost.reached) return stopOnCostCap(ctx, mission, cost, attemptId);
  // 只有 Standard 停工作项检查点：轻量票没有协调者可拆票，停等只会把它挂死。
  if (mission.executionMode !== 'standard') return { stopped: false };
  const threshold = await nextCheckpointThreshold(ctx, me);
  if (threshold > 0 && mission.workItems.length >= threshold) {
    return stopOnCheckpoint(ctx, mission, cost, { threshold, attemptId });
  }
  return { stopped: false };
}

/** 费用到 cap：升级 + 停等 mission_cost_cap_reached（不解除其它等待）。 */
async function stopOnCostCap(
  ctx: PlatformContext,
  mission: Mission,
  cost: ReturnType<typeof evaluateMissionCost>,
  attemptId?: string,
): Promise<TicketGateResult> {
  const aid = attemptIdFor(mission, attemptId);
  const thr = cost.costCap ?? cost.total;
  if (!hasOpenGate(mission, 'cost_cap', thr)) {
    const { question, why } = gateQuestionWhy(mission, 'cost_cap', cost, { workItemCount: mission.workItems.length, threshold: thr });
    await recordEscalationAndDeliver(ctx, mission, {
      attemptId: aid, question, why, optionsConsidered: [],
      platformGate: { kind: 'cost_cap', threshold: thr },
    });
  }
  if (mission.waitReason !== 'mission_cost_cap_reached') {
    mission.setWaitReason('mission_cost_cap_reached', `票级费用 $${cost.total.toFixed(2)} 已达上限 $${thr}`);
    await ctx.event(mission, 'mission.waiting', { reason: 'mission_cost_cap_reached', detail: `票级费用 $${cost.total.toFixed(2)} 已达上限` }, undefined, aid);
  }
  return { stopped: true, reason: 'mission_cost_cap_reached', detail: `票级费用 $${cost.total.toFixed(2)} 已达上限 $${thr}` };
}

/** 工作项达未批准检查点：升级 + 停等 work_item_checkpoint（不解除其它等待）。 */
async function stopOnCheckpoint(
  ctx: PlatformContext,
  mission: Mission,
  cost: ReturnType<typeof evaluateMissionCost>,
  gate: { threshold: number; attemptId?: string },
): Promise<TicketGateResult> {
  const aid = attemptIdFor(mission, gate.attemptId);
  if (!hasOpenGate(mission, 'work_item_checkpoint', gate.threshold)) {
    const { question, why } = gateQuestionWhy(mission, 'work_item_checkpoint', cost, { workItemCount: mission.workItems.length, threshold: gate.threshold });
    await recordEscalationAndDeliver(ctx, mission, {
      attemptId: aid, question, why, optionsConsidered: [],
      platformGate: { kind: 'work_item_checkpoint', threshold: gate.threshold },
    });
  }
  if (mission.waitReason !== 'work_item_checkpoint') {
    mission.setWaitReason('work_item_checkpoint', `工作项已达 ${mission.workItems.length} 个（检查点 ${gate.threshold} 未批准）`);
    await ctx.event(mission, 'mission.waiting', { reason: 'work_item_checkpoint', detail: `工作项已达 ${mission.workItems.length} 个` }, undefined, aid);
  }
  return { stopped: true, reason: 'work_item_checkpoint', detail: `工作项已达 ${mission.workItems.length} 个（检查点 ${gate.threshold} 未批准）` };
}

/** 提升票级费用上限并写增额事件；cleanupGates 时顺带清掉队首已解除的费用门禁。 */
async function raiseCostCap(
  ctx: PlatformContext,
  mission: Mission,
  by: number,
  cleanupGates: boolean,
): Promise<{ costCap: number }> {
  if (!Number.isFinite(by) || by <= 0) {
    throw new PlatformRuleError('INVALID_COST_CAP_DELTA', `raiseMissionCostCap 收到非有限正数增量: ${by}`);
  }
  const base = mission.costCap ?? 10;
  // kernel.raiseCostCap 只校验增量本身；加完可能溢出成 Infinity，那等于把上限抹掉，
  // 必须在写状态之前挡住——写完之后再发现就已经污染了 Mission。
  if (!Number.isFinite(base + by)) {
    throw new PlatformRuleError('INVALID_COST_CAP_DELTA', `费用上限 ${base} 加 ${by} 后不是有限值`);
  }
  const costCap = mission.raiseCostCap(by);
  await ctx.event(mission, 'mission.cost_cap.raised', { missionId: mission.id, by, costCap }, undefined, attemptIdFor(mission));
  await releaseCostWaitIfResolved(ctx, mission, costCap);
  if (cleanupGates) await cleanupResolvedCostGate(ctx, mission);
  return { costCap };
}

/** 只解除「费用等待且当前费用已低于新上限」的旧 cost 门禁；paused/parked/其它等待不动。 */
async function releaseCostWaitIfResolved(ctx: PlatformContext, mission: Mission, costCap: number): Promise<void> {
  if (mission.waitReason !== 'mission_cost_cap_reached') return;
  const all = (await ctx.projects.list()).flatMap((p) => p.missions);
  const me = all.find((m) => m.id === mission.id);
  if (!me) return;
  const cost = evaluateMissionCost(missionToCostInput(me), all.map(missionToCostInput), costCap);
  if (cost.reached) return;
  mission.setWaitReason(undefined);
  await ctx.event(mission, 'mission.resumed', {}, undefined, attemptIdFor(mission));
}

/** 公开入口：默认 +10，支持显式有限正数；同事务里清掉队首已解决的费用门禁。 */
export async function raiseMissionCostCap(
  ctx: PlatformContext,
  missionId: string,
  by: number = 10,
): Promise<{ costCap: number }> {
  const { mission } = await ctx.locate(missionId);
  return raiseCostCap(ctx, mission, by, true);
}

/** 清连续队首的费用门禁：total < cap 才逐条答复队首 cost 升级；遇普通/检查点升级立即停。 */
export async function cleanupResolvedCostGate(
  ctx: PlatformContext,
  mission: Mission,
): Promise<void> {
  let head = mission.openEscalations[0];
  if (!head || head.platformGate?.kind !== 'cost_cap') return;
  const all = (await ctx.projects.list()).flatMap((p) => p.missions);
  const me = all.find((m) => m.id === mission.id);
  if (!me) return;
  const cost = evaluateMissionCost(missionToCostInput(me), all.map(missionToCostInput), mission.costCap);
  while (head && head.platformGate?.kind === 'cost_cap' && cost.total < (mission.costCap ?? Infinity)) {
    mission.answerEscalation('平台已增额，费用门禁解除', ctx.clock.now().toISOString());
    await ctx.event(mission, 'escalation.answered', { question: head.question, answer: '平台已增额，费用门禁解除', gate: 'cost_cap' }, undefined, head.attemptId);
    head = mission.openEscalations[0];
  }
}

export type TicketGateDecision = 'continue' | 'reject' | 'unknown';

/** 明确拒绝：否定词紧贴「继续」，或整句就是叫停。中文没有词边界，不能靠 \b。 */
const REJECT_ANSWER = /(不|不要|不能|别|勿|无需)\s*(要?继续|continue|同意|批准)|(^|[^a-z])(no|not|never|do\s+not|don'?t)\s+(continue|proceed)|(停止|停下|拒绝|算了|暂停)|(^|[^a-z])(stop|reject|decline|deny|abort)\b/i;

/** 明确继续：只认说清楚要继续的话，含糊的一律当拒绝，不放行。 */
const CONTINUE_ANSWER = /(继续|continue|proceed|go\s*ahead|同意|批准)/i;

/** 显式增量：'继续，加20美元' / 'continue --by 20'。取紧跟的完整数字 token 再交给 Number。 */
const EXPLICIT_DELTA = /(?:加|增加|追加|by|add|\+)\s*\$?\s*([+-]?(?:\d+\.?\d*|\.\d+)|[+-]?infinity|nan)/i;

/** 纯解析答复：仅 platformGate 才处理；否定优先，明确继续/continue 才放行。 */
export function parseTicketGateAnswer(
  body: EscalationBody,
  answer: string,
): { decision: TicketGateDecision; by: number } {
  if (!body.platformGate) return { decision: 'unknown', by: 10 };
  const text = answer.trim();
  // 说了拒绝就拒绝（同一句里也可能有「继续」）；两种都没提到的同样不放行——
  // 放行了就等于替用户决定加钱，这个代价不可逆。
  if (REJECT_ANSWER.test(text) || !CONTINUE_ANSWER.test(text)) return { decision: 'reject', by: 10 };
  const matched = text.match(EXPLICIT_DELTA);
  const by = matched === null ? 10 : Number(matched[1]);
  // 显式写了却不是有限正数（0 / 负数 / Infinity / NaN）：在答复落库之前就报错，
  // 否则它会悄悄退化成默认 10，用户以为加的是自己说的数。
  if (matched !== null && (!Number.isFinite(by) || by <= 0)) {
    throw new PlatformRuleError('INVALID_COST_CAP_DELTA', `非法费用增量: ${matched[1]}`);
  }
  return { decision: 'continue', by };
}

/** apply 在普通 mission.answerEscalation 之后调用：费用继续只增额；检查点继续只写批准。 */
export async function applyTicketGateAnswer(
  ctx: PlatformContext,
  mission: Mission,
  answered: Readonly<EscalationBody>,
  decision: { decision: TicketGateDecision; by: number },
): Promise<{ released: boolean }> {
  if (!answered.platformGate) return { released: false };
  if (decision.decision !== 'continue') {
    // 非继续：保持阻断，不解除等待。
    return { released: false };
  }
  if (answered.platformGate.kind === 'cost_cap') {
    // 费用继续只增额：答下一条升级是公开 CLI 的事，这里代答会把别人的问题吃掉。
    const { costCap } = await raiseCostCap(ctx, mission, decision.by, false);
    void costCap;
    return { released: true };
  }
  // 检查点继续：写 mission.work_item_checkpoint.approved {threshold}，仅清匹配等待。
  await ctx.event(mission, 'mission.work_item_checkpoint.approved', { missionId: mission.id, threshold: answered.platformGate.threshold }, undefined, answered.attemptId);
  if (mission.waitReason === 'work_item_checkpoint') {
    mission.setWaitReason(undefined);
    await ctx.event(mission, 'mission.resumed', {}, undefined, answered.attemptId);
  }
  return { released: true };
}
