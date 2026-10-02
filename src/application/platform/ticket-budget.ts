// 独立票级门禁：费用上限与工作项检查点。
//
// 本模块是 W-426/W-427 纯费用求值（evaluateMissionCost）之上的「持久、可答复」
// 门禁层：把费用与 15 倍数的工作项检查点转成 Mission 上的 waitReason + 平台
// 升级，并给后续 escalations 答复接线提供解析/apply/清理辅助。
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

/** 是否已存在同 kind/threshold 的未答复平台门禁升级；不重复投递。 */
function hasOpenGate(mission: Mission, kind: 'cost_cap' | 'work_item_checkpoint', threshold: number): boolean {
  return mission.openEscalations.some(
    (e) => e.platformGate?.kind === kind && e.platformGate.threshold === threshold,
  );
}

/** 升级 question/why 的事实归因：总费用/上限、按 role 与 candidate 费用、工作项数、最近失败。 */
function gateQuestionWhy(
  mission: Mission,
  kind: 'cost_cap' | 'work_item_checkpoint',
  cost: { total: number; costCap?: number; byRole: readonly { role: string; cost: number }[]; byCandidate: readonly { candidateId: string; cost: number }[] },
  workItemCount: number,
): { question: string; why: string } {
  const failure = recentFailureFact(mission);
  const cap = cost.costCap === undefined ? '（未设）' : `$${cost.costCap}`;
  const byRole = cost.byRole.map((r) => `${r.role} $${r.cost.toFixed(2)}`).join('、') || '无';
  const byCandidate = cost.byCandidate.map((c) => `${c.candidateId} $${c.cost.toFixed(2)}`).join('、') || '无';
  if (kind === 'cost_cap') {
    const question = `票级费用已到 $${cost.total.toFixed(2)} / 上限 ${cap}，是否批准追加预算？`;
    const why = `总费用 $${cost.total.toFixed(2)}（上限 ${cap}）；按角色：${byRole}；按候选：${byCandidate}；当前工作项 ${workItemCount} 个；最近失败事实：${failure}`;
    return { question, why };
  }
  const question = `工作项已达 ${workItemCount} 个（检查点 ${cap} 未批准），是否拆票继续？`;
  const why = `工作项总数 ${workItemCount}（含退役）；总费用 $${cost.total.toFixed(2)}（上限 ${cap}）；按角色：${byRole}；按候选：${byCandidate}；最近失败事实：${failure}`;
  return { question, why };
}

/** 取答复用的 attemptId：显式值优先，否则最近 coordinator 尝试 id，都没有用空串。 */
function attemptIdFor(ctx: PlatformContext, mission: Mission, attemptId?: string): string {
  if (attemptId) return attemptId;
  const latest = [...mission.coordinatorAttempts].reverse()[0];
  return latest ? latest.id : '';
}

/** 取尚未批准的工作项检查点水位（async：读 activity 中最近一次 approved 的 threshold）。 */
async function approvedCheckpointThresholdAsync(ctx: PlatformContext, missionId: string): Promise<number> {
  const events = await ctx.activity.list(missionId);
  let threshold = 0;
  for (const e of events) {
    if (e.kind === 'mission.work_item_checkpoint.approved' && e.data && typeof e.data === 'object' && typeof (e.data as { threshold?: unknown }).threshold === 'number') {
      threshold = (e.data as { threshold: number }).threshold;
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
  // 费用优先于检查点。
  if (cost.reached) return stopOnCostCap(ctx, mission, me, cost, attemptId);
  const threshold = await nextCheckpointThreshold(ctx, me);
  if (mission.workItems.length >= threshold && threshold > 0) {
    return stopOnCheckpoint(ctx, mission, cost, threshold, attemptId);
  }
  return { stopped: false };
}

/** 费用到 cap：升级 + 停等 mission_cost_cap_reached（不解除其它等待）。 */
async function stopOnCostCap(
  ctx: PlatformContext,
  mission: Mission,
  me: Mission,
  cost: ReturnType<typeof evaluateMissionCost>,
  attemptId?: string,
): Promise<TicketGateResult> {
  const aid = attemptIdFor(ctx, mission, attemptId);
  const thr = cost.costCap ?? cost.total;
  if (!hasOpenGate(mission, 'cost_cap', thr)) {
    const { question, why } = gateQuestionWhy(mission, 'cost_cap', cost, mission.workItems.length);
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
  threshold: number,
  attemptId?: string,
): Promise<TicketGateResult> {
  const aid = attemptIdFor(ctx, mission, attemptId);
  if (!hasOpenGate(mission, 'work_item_checkpoint', threshold)) {
    const { question, why } = gateQuestionWhy(mission, 'work_item_checkpoint', cost, mission.workItems.length);
    await recordEscalationAndDeliver(ctx, mission, {
      attemptId: aid, question, why, optionsConsidered: [],
      platformGate: { kind: 'work_item_checkpoint', threshold },
    });
  }
  if (mission.waitReason !== 'work_item_checkpoint') {
    mission.setWaitReason('work_item_checkpoint', `工作项已达 ${mission.workItems.length} 个（检查点 ${threshold} 未批准）`);
    await ctx.event(mission, 'mission.waiting', { reason: 'work_item_checkpoint', detail: `工作项已达 ${mission.workItems.length} 个` }, undefined, aid);
  }
  return { stopped: true, reason: 'work_item_checkpoint', detail: `工作项已达 ${mission.workItems.length} 个（检查点 ${threshold} 未批准）` };
}

/** 提升票级费用上限：默认 +10，支持显式有限正数；写增额事件。只解除已解决的费用门禁靠 cleanup。 */
export async function raiseMissionCostCap(
  ctx: PlatformContext,
  missionId: string,
  by: number = 10,
): Promise<{ costCap: number }> {
  if (!Number.isFinite(by) || by <= 0) {
    throw new PlatformRuleError('INVALID_COST_CAP_DELTA', `raiseMissionCostCap 收到非有限正数增量: ${by}`);
  }
  const { mission } = await ctx.locate(missionId);
  const costCap = mission.raiseCostCap(by);
  await ctx.event(mission, 'mission.cost_cap.raised', { missionId, by, costCap }, undefined, attemptIdFor(ctx, mission));
  // 只解除「费用等待且当前费用已低于新上限」的旧 cost 门禁；其它等待不动。
  const all = (await ctx.projects.list()).flatMap((p) => p.missions);
  const me = all.find((m) => m.id === missionId);
  if (me) {
    const cost = evaluateMissionCost(missionToCostInput(me), all.map(missionToCostInput), costCap);
    if (cost.reached === false && mission.waitReason === 'mission_cost_cap_reached') {
      mission.setWaitReason(undefined);
      await ctx.event(mission, 'mission.resumed', {}, undefined, attemptIdFor(ctx, mission));
    }
  }
  return { costCap };
}

/** 仅清连续队首的费用门禁：只有当 total < cap 时关闭队首 cost 升级；不消费后续、不误答普通升级。 */
export async function cleanupResolvedCostGate(
  ctx: PlatformContext,
  mission: Mission,
): Promise<void> {
  const open = mission.openEscalations;
  if (open.length === 0) return;
  const head = open[0]!;
  if (head.platformGate?.kind !== 'cost_cap') return; // 队首不是费用门禁：不动，保留它。
  const all = (await ctx.projects.list()).flatMap((p) => p.missions);
  const me = all.find((m) => m.id === mission.id);
  if (!me) return;
  const cost = evaluateMissionCost(missionToCostInput(me), all.map(missionToCostInput), mission.costCap);
  if (cost.total < (mission.costCap ?? Infinity)) {
    // 通过普通 answerEscalation 关闭队首费用门禁（记 escalation.answered）；不解除其它等待。
    mission.answerEscalation('平台已增额，费用门禁解除', ctx.clock.now().toISOString());
    await ctx.event(mission, 'escalation.answered', { question: head.question, answer: '平台已增额，费用门禁解除', gate: 'cost_cap' }, undefined, head.attemptId);
  }
}

export type TicketGateDecision = 'continue' | 'reject' | 'unknown';

/** 纯解析答复：仅 platformGate 才处理；明确继续/continue 且无否定才放行。 */
export function parseTicketGateAnswer(
  body: EscalationBody,
  answer: string,
): { decision: TicketGateDecision; by: number } {
  if (!body.platformGate) return { decision: 'unknown', by: 10 };
  const text = answer.toLowerCase();
  const negative = /\b(no|not|停|否|拒绝|不)\b/.test(text) && !/\b(继续|continue)\b/.test(text);
  const isContinue = /\b(continue|继续)\b/.test(text) && !negative;
  if (!isContinue) return { decision: 'reject', by: 10 };
  // 解析增量：'继续，加20美元' / 'continue --by 20'；默认 10。
  const byMatch = answer.match(/(?:加|by|add|\+)\s*\$?\s*(\d+(?:\.\d+)?)/i);
  const by = byMatch ? Number(byMatch[1]) : 10;
  if (!Number.isFinite(by) || by <= 0) {
    throw new PlatformRuleError('INVALID_COST_CAP_DELTA', `非法费用增量: ${by}`);
  }
  return { decision: 'continue', by };
}

/** apply 在普通 mission.answerEscalation 之后调用：费用继续调增额内部逻辑；检查点继续写 approved。 */
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
    // 费用继续：调用增额内部逻辑（不能答下一条升级）。
    const { costCap } = await raiseCostCapInternal(ctx, mission, decision.by);
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

/** 增额内部逻辑：仅更新 Mission（不另发 deliver，不消费其它升级）。 */
async function raiseCostCapInternal(ctx: PlatformContext, mission: Mission, by: number): Promise<{ costCap: number }> {
  if (!Number.isFinite(by) || by <= 0) {
    throw new PlatformRuleError('INVALID_COST_CAP_DELTA', `非法费用增量: ${by}`);
  }
  const costCap = mission.raiseCostCap(by);
  await ctx.event(mission, 'mission.cost_cap.raised', { missionId: mission.id, by, costCap }, undefined, attemptIdFor(ctx, mission));
  // 只解除已解决的费用等待；其它等待不动。
  if (mission.waitReason === 'mission_cost_cap_reached') {
    const all = (await ctx.projects.list()).flatMap((p) => p.missions);
    const me = all.find((m) => m.id === mission.id);
    if (me) {
      const cost = evaluateMissionCost(missionToCostInput(me), all.map(missionToCostInput), costCap);
      if (cost.reached === false) {
        mission.setWaitReason(undefined);
        await ctx.event(mission, 'mission.resumed', {}, undefined, attemptIdFor(ctx, mission));
      }
    }
  }
  return { costCap };
}
