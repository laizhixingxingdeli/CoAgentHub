/**
 * ChangeImpact 专属 Platform 动作：为一次已确认变更开限权 coordinator Attempt、
 * 读原请求、提交影响判断。
 *
 * 为什么单独一个模块而不是塞进某个既有层：这三个动作同时碰三条不变量——
 * 队列租约（fence）、Mission 唯一 coordinator（不变量 B）、ChangeRequest 的事实目标。
 * 散在调用方里写，迟早有一处漏掉其中一条，而漏掉的那条表现为「判断的是旧的那一代」。
 *
 * 身份纪律：changeId 之外的身份全部来自可信来源（仓储里的请求记录 + 队列槽），
 * body 里带的任何 identity 字段一律拒绝——把身份放进业务体里，等于允许调用方
 * 自己签自己的来源。
 *
 * 时钟纪律：只信 ctx.clock。body 或外部预取的 clock 会让过期租约能把时间拨回去继续写。
 *
 * 零第三方依赖：第三方只允许出现在 src/application/pg-store.ts。
 */

import type { Attempt, Mission, UsedProfile } from '../../kernel/index.ts';
import {
  ChangeImpactConflictError,
  validateChangeImpactBody,
  type ChangeImpact,
  type ChangeImpactBody,
  type ChangeImpactClaim,
  type ChangeImpactRepository,
} from '../change-impact.ts';
import type { ChangeRequest, ChangeRequestRepository } from '../change-request.ts';
import type { QueuedHopRepository } from '../ports.ts';
import { holdsCurrentClaim, type ClaimFence, type QueuedHop } from '../durable-scheduler.ts';
import {
  PlatformContext,
  PlatformRuleError,
  ATTEMPT_STARTED_KIND,
} from './context.ts';
import type { QueueClaimIdentity } from './types.ts';

/** 缺仓储备或事务不带 fence 时的统一拒绝：不退化成「跳过校验直接写」。 */
export const CHANGE_IMPACT_UNSUPPORTED = 'CHANGE_IMPACT_UNSUPPORTED';

/** 决定事件名。叙事与事件覆盖都按这一个名字归类。 */
export const CHANGE_IMPACT_DECIDED_KIND = 'change.impact_decided';

/** impact hop / run token 的 purpose 取值。 */
export const CHANGE_IMPACT_PURPOSE = 'impact';

/** Mission 终态：这两格上没有出边，之后任何动作都是给既成事实补章。 */
const TERMINAL_MISSION = new Set(['completed', 'blocked']);

/**
 * attempt.started 的 data 里刻下的可信关联三件套。
 *
 * purpose / changeId 与 queue 一起写：少了 changeId 就分不清这个 Attempt 在判断
 * 哪一次变更，而含含糊糊的边界在读写面就是「我记得我是限权的」。
 */
function impactStartedData(changeId: string): Record<string, unknown> {
  return {
    kind: 'coordinator',
    queue: true,
    purpose: CHANGE_IMPACT_PURPOSE,
    changeId,
  };
}

/** 从 attempt.started 的 data 读回关联；缺任一条就不算 impact 专属 Attempt。 */
function readAssociation(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const row = data as Record<string, unknown>;
  if (row.queue !== true || row.purpose !== CHANGE_IMPACT_PURPOSE) return undefined;
  const changeId = row.changeId;
  if (typeof changeId !== 'string' || changeId.trim().length === 0) return undefined;
  return changeId;
}

/** 业务体只允许四字段；多一个（含任何 identity 字段）就拒。 */
function readImpactBody(body: unknown): ChangeImpactBody {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new PlatformRuleError('INVALID_CHANGE_IMPACT', '影响判断必须是对象。');
  }
  return validateChangeImpactBody(body as ChangeImpactBody);
}

function fenceOf(claim: QueueClaimIdentity, now: string): ClaimFence {
  return { id: claim.id, owner: claim.owner, claimGeneration: claim.claimGeneration, now };
}

/** 活租约：过期租约等价于没有租约，不能靠它读或写。 */
function isLiveClaim(hop: QueuedHop | undefined, claim: QueueClaimIdentity, now: string): boolean {
  return holdsCurrentClaim(hop, fenceOf(claim, now));
}

function requireRequest(request: ChangeRequest | undefined, changeId: string): ChangeRequest {
  if (!request) {
    throw new PlatformRuleError('UNKNOWN_CHANGE_REQUEST', `没有这条已确认变更：${changeId}`);
  }
  return request;
}

/** 请求必须属于这次运行的 Mission：否则就是拿 A 任务的变更去卡 B 任务。 */
function requireSameMission(request: ChangeRequest, missionId: string, changeId: string): void {
  if (request.missionId !== missionId) {
    throw new PlatformRuleError(
      'UNKNOWN_CHANGE_REQUEST',
      `changeId ${changeId} 不属于这次运行的 Mission。`,
    );
  }
}

/**
 * 目标 hop：同一 mission / 同一工作项、role=executor、代次与请求一致的**活**租约。
 *
 * generation 取自 request.claimGeneration——判断是**对那一代**领取权做出的；换代之后
 * 请求指向的那次执行已经不在了，接着判断等于给空气出结论。
 */
async function requireLiveExecutorHop(
  hops: QueuedHopRepository,
  request: ChangeRequest,
  claim: QueueClaimIdentity,
  now: string,
): Promise<void> {
  const hop = await hops.get(claim.id);
  const aligned =
    hop !== undefined &&
    hop.id === claim.id &&
    hop.missionId === request.missionId &&
    hop.workItemId === request.workItemId &&
    hop.role === 'executor';
  if (!aligned || !isLiveClaim(hop, claim, now)) {
    throw new PlatformRuleError(
      'CLAIM_FENCE_REJECTED',
      '这次影响判断的队列租约与目标执行不是同一条，或租约已失效 / 代次不匹配，拒绝。',
    );
  }
}

/**
 * 校核 impact Attempt 与它判断的那条变更确实是发牌那一刻配好的那一对。
 *
 * 不做这一步，任何普通 coordinator Attempt 都能拿自己的 attemptId 调专属动作，
 * 「限权」就只剩名字。
 */
async function requireImpactAttempt(
  ctx: PlatformContext,
  missionId: string,
  coordinatorAttemptId: string,
  request: ChangeRequest,
): Promise<{ mission: Mission; attempt: Attempt }> {
  const { mission, attempt } = await ctx.requireAttempt(
    missionId,
    coordinatorAttemptId,
    'coordinator',
  );
  const events = await ctx.activity.list(missionId);
  const started = events.find(
    (event) => event.kind === ATTEMPT_STARTED_KIND && event.attemptId === coordinatorAttemptId,
  );
  const associated = readAssociation(started?.data);
  if (associated !== request.changeId) {
    throw new PlatformRuleError(
      'WRONG_ROLE',
      `attempt ${coordinatorAttemptId} 不是这次变更的影响判断 Attempt。`,
    );
  }
  return { mission, attempt };
}

/** 同业务 + 同请求来源 = 重试：原记录就是答案。 */
function sameDecision(existing: ChangeImpact, next: ChangeImpact): boolean {
  if (existing.workItemId !== next.workItemId) return false;
  if (existing.attemptId !== next.attemptId) return false;
  if (existing.claimGeneration !== next.claimGeneration) return false;
  if (existing.decision !== next.decision) return false;
  if (existing.workOrderDiff !== next.workOrderDiff) return false;
  if (existing.reason !== next.reason) return false;
  const left = existing.affectedAcceptance;
  const right = next.affectedAcceptance;
  if (left.length !== right.length) return false;
  return left.every((index, at) => index === right[at]);
}

/**
 * 保存：等值返回原记录（created=false，不再发事件），异内容冲突。
 *
 * 冲突时不覆盖：影响判断是 append-only 事实，「重算结论」应当换新 id，
 * 静默覆盖会让追溯时看到一条结论却说不清它是第几版。
 */
async function appendImpact(
  impacts: ChangeImpactRepository,
  impact: ChangeImpact,
): Promise<{ impact: ChangeImpact; created: boolean }> {
  const existing = await impacts.get(impact.changeId);
  if (existing) {
    if (sameDecision(existing, impact)) return { impact: existing, created: false };
    throw new ChangeImpactConflictError(impact.changeId);
  }
  await impacts.append(impact);
  return { impact, created: true };
}

function claimIdentity(claim: QueueClaimIdentity, request: ChangeRequest): ChangeImpactClaim {
  return Object.freeze({
    id: claim.id,
    owner: claim.owner,
    claimGeneration: request.claimGeneration,
  });
}

/**
 * 装配齐备 + 事务支持 fence 才有资格做影响判断。
 *
 * 为什么还要查事务：缺了 fence 的话「持有租约」与「这次写入」不在同一事务，
 * 租约在别人手上也照样写得进去，而它看起来一切正常。
 */
export function supportsChangeImpact(ctx: PlatformContext): boolean {
  return Boolean(
    ctx.changeRequests && ctx.changeImpacts && ctx.queuedHops && ctx.hasFencedTransaction(),
  );
}

function requireAssembled(ctx: PlatformContext, claim: QueueClaimIdentity | undefined): void {
  if (!supportsChangeImpact(ctx) || !claim) {
    throw new PlatformRuleError(
      CHANGE_IMPACT_UNSUPPORTED,
      '当前平台没有装配影响判断所需的变更仓储与队列槽，或本次调用没有携带队列领取身份。',
    );
  }
}

/**
 * 开一次限权 impact coordinator Attempt，返回它要判断的那次执行目标。
 *
 * 走 ctx.txFenced：新 Attempt 的 attempt.started 与「这次调用确实持有当时的队列槽」
 * 在**同一事务**里落下。分开写的话，拿到过期租约的调用能把 Attempt 开出来而它的
 * 来源查不到——后面读写都靠来源校核，那次调用的判断就成了孤儿。
 */
export async function startImpactCoordinatorAttempt(
  ctx: PlatformContext,
  missionId: string,
  changeId: string,
  profile: UsedProfile | undefined,
  claim: QueueClaimIdentity | undefined,
): Promise<{ attemptId: string; workItemId: string }> {
  requireAssembled(ctx, claim);
  const requests = ctx.changeRequests!;
  const hops = ctx.queuedHops!;
  const now = ctx.clock.now().toISOString();
  return ctx.txFenced(claim, async () => {
    const request = requireRequest(await requests.get(changeId), changeId);
    requireSameMission(request, missionId, changeId);
    await requireLiveExecutorHop(hops, request, claim!, now);
    const { mission, item } = await ctx.locateItem(missionId, request.workItemId);
    // 目标 attempt 必须还是 in_progress：已经交卷的执行谈不上「改了会不会打到它」。
    const running = item.attempts.find((attempt) => attempt.status === 'in_progress');
    if (!running || running.id !== request.attemptId) {
      throw new PlatformRuleError(
        'UNKNOWN_ATTEMPT',
        `已确认变更指向的 executor attempt ${request.attemptId} 已不在跑。`,
      );
    }
    // 复用 Mission 唯一的 coordinator 规矩（不变量 B）：不改 Mission.status，
    // 也不给这条 Attempt 任何额外权限。
    const started = mission.startCoordinatorAttempt();
    if (profile) started.recordProfile(profile);
    await ctx.event(mission, ATTEMPT_STARTED_KIND, impactStartedData(changeId), undefined, started.id);
    return { attemptId: started.id, workItemId: request.workItemId };
  });
}

/** 读原请求：只给这次 Attempt 被发牌时钉死的那一条。 */
export async function getChangeRequest(
  ctx: PlatformContext,
  missionId: string,
  coordinatorAttemptId: string,
  changeId: string,
  claim: QueueClaimIdentity | undefined,
): Promise<ChangeRequest> {
  requireAssembled(ctx, claim);
  const requests = ctx.changeRequests!;
  const hops = ctx.queuedHops!;
  const now = ctx.clock.now().toISOString();
  return ctx.attemptWrite(missionId, coordinatorAttemptId, claim, async () => {
    const request = requireRequest(await requests.get(changeId), changeId);
    requireSameMission(request, missionId, changeId);
    await requireImpactAttempt(ctx, missionId, coordinatorAttemptId, request);
    await requireLiveExecutorHop(hops, request, claim!, now);
    return request;
  });
}

/**
 * 提交影响判断：保存事实 + 记事件，**不做重派 / 取消**。
 *
 * 只有判断与保存，不是 applied / verified：decision=replan 或 cancel_replace 也不会
 * 触发任何取消或重派——执行应用是另一条链路的事，写进这里就会有人拿「有影响」
 * 当「已处理」。
 */
export async function submitChangeImpact(
  ctx: PlatformContext,
  missionId: string,
  coordinatorAttemptId: string,
  changeId: string,
  body: unknown,
  claim: QueueClaimIdentity | undefined,
): Promise<ChangeImpact> {
  requireAssembled(ctx, claim);
  const requests = ctx.changeRequests!;
  const impacts = ctx.changeImpacts!;
  const hops = ctx.queuedHops!;
  const business = readImpactBody(body);
  const now = ctx.clock.now().toISOString();
  return ctx.attemptWrite(missionId, coordinatorAttemptId, claim, async () => {
    const request = requireRequest(await requests.get(changeId), changeId);
    requireSameMission(request, missionId, changeId);
    const { mission } = await requireImpactAttempt(ctx, missionId, coordinatorAttemptId, request);
    await requireLiveExecutorHop(hops, request, claim!, now);
    const candidate: ChangeImpact = {
      changeId,
      missionId,
      workItemId: request.workItemId,
      attemptId: request.attemptId,
      claimGeneration: request.claimGeneration,
      coordinatorAttemptId,
      claim: claimIdentity(claim!, request),
      decision: business.decision,
      workOrderDiff: business.workOrderDiff,
      affectedAcceptance: business.affectedAcceptance,
      reason: business.reason,
    };
    const saved = await appendImpact(impacts, candidate);
    // 重试不该再发一次事件：事件是「做了次判断」，重复发会让回放看到两条
    // 而实际只有一条记录。
    if (!saved.created) return saved.impact;
    // 同一事务：判断落库与它的事件要么都在，要么都不在。分开写会出现
    // 「有记录没事件」——回放时这一段没有解释，只能靠时间戳猜。
    await ctx.event(
      mission,
      CHANGE_IMPACT_DECIDED_KIND,
      {
        changeId,
        workItemId: saved.impact.workItemId,
        attemptId: saved.impact.attemptId,
        claimGeneration: saved.impact.claimGeneration,
        decision: saved.impact.decision,
        affectedAcceptance: [...saved.impact.affectedAcceptance],
      },
      saved.impact.workItemId,
      coordinatorAttemptId,
    );
    return saved.impact;
  });
}

/**
 * 给监督面用的只读接缝：某个 executor 视角下还没有影响判断的变更请求。
 *
 * 为什么走 txFenced(executorClaim)：这是一句「谁现在正拿着这个执行」的问句，
 * 答案必须与当时的租约同一个事务，否则交回的列表可能已经换代。
 *
 * 为什么固定只看 target（workItem + attempt + generation）：拿 sourceContractRevision
 * 等于当前 revision 当全停条件会静默吃掉「这一代还没判断」的请求——契约代次和
 * 领取代次是两条互不相干的轴。
 */
export async function listPendingChangeRequests(
  ctx: PlatformContext,
  missionId: string,
  workItemId: string,
  executorAttemptId: string,
  executorClaim: QueueClaimIdentity | undefined,
): Promise<readonly ChangeRequest[]> {
  requireAssembled(ctx, executorClaim);
  const requests = ctx.changeRequests!;
  const impacts = ctx.changeImpacts!;
  const hops = ctx.queuedHops!;
  const now = ctx.clock.now().toISOString();
  return ctx.txFenced(executorClaim, async () => {
    const hop = await hops.get(executorClaim!.id);
    const aligned =
      hop !== undefined &&
      hop.missionId === missionId &&
      hop.workItemId === workItemId &&
      hop.role === 'executor';
    if (!aligned || !isLiveClaim(hop, executorClaim!, now)) {
      throw new PlatformRuleError(
        'CLAIM_FENCE_REJECTED',
        '这次查询的队列租约与目标执行不是同一条，或租约已失效 / 代次不匹配，拒绝。',
      );
    }
    const { mission } = await ctx.locate(missionId);
    // 停着 / 终态 / 已有 in_progress coordinator 都返回 []：
    // 已经有 coordinator 说明这一轮判断正在做，再给一次就会开出第二条并发判断。
    if (mission.isPaused || TERMINAL_MISSION.has(mission.status)) return Object.freeze([]);
    if (mission.coordinatorAttempts.some((attempt) => attempt.status === 'in_progress')) {
      return Object.freeze([]);
    }
    const all = await requests.listByMission(missionId, {
      workItemId,
      attemptId: executorAttemptId,
      claimGeneration: executorClaim!.claimGeneration,
    });
    const decided = new Set((await impacts.listByMission(missionId)).map((row) => row.changeId));
    return Object.freeze(all.filter((row) => !decided.has(row.changeId)));
  });
}
