/**
 * ChangeImpact 专属 Platform 动作：为一次已确认变更开限权 coordinator Attempt、
 * 读原请求、提交影响判断。
 *
 * 为什么单独一个模块而不是塞进某个既有层：这三个动作同时碰三条不变量——
 * 队列租约（fence）、Mission 唯一 coordinator（不变量 B）、ChangeRequest 的事实目标。
 * 散在调用方里写，迟早有一处漏掉其中一条，而漏掉的那条表现为`判断的是旧的那一代」。
 *
 * 身份纪律：changeId 之外的身份全部来自可信来源（仓储里的请求记录 + 队列槽），
 * body 里带的任何 identity 字段一律拒绝——把身份放进业务体里，等于允许调用方
 * 自己签自己的来源。
 *
 * 时钟纪律：只信 ctx.clock。body 或外部预取的 clock 会让过期租约能把时间拨回去继续写。
 *
 * 零第三方依赖：第三方只允许出现在 src/application/pg-store.ts。
 */

import { InvariantViolationError } from '../../kernel/index.ts';
import type { Attempt, Mission, UsedProfile, WorkItem } from '../../kernel/index.ts';
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
import { finishAttempt as attemptsFinish } from './attempts.ts';
import type { QueueClaimIdentity } from './types.ts';

/** 缺仓储备或事务不带 fence 时的统一拒绝：不退化成`跳过校验直接写」。 */
export const CHANGE_IMPACT_UNSUPPORTED = 'CHANGE_IMPACT_UNSUPPORTED';

/** 决定事件名。叙事与事件覆盖都按这一个名字归类。 */
export const CHANGE_IMPACT_DECIDED_KIND = 'change.impact_decided';

/** impact hop / run token 的 purpose 取值。 */
export const CHANGE_IMPACT_PURPOSE = 'impact';

/** Mission 终态：这两格上没有出边，之后任何动作都是给既成事实补章。 */
const TERMINAL_MISSION = new Set(['completed', 'blocked']);

/**
 * attempt.started data 里刻下的关联：变更 id + 目标工作项 + 发牌那一刻的 claim 三元组。
 *
 * 为什么连 claim 三元组一起刻：少了它，`这次写是不是发牌给的那张牌」就只能靠
 * attemptId 判断，于是换一张新 impact 牌也能借同一个 Attempt 往里写——限权就
 * 只剩`我自称是 impact」。刻下来之后，后面每次读写都拿三元组对照。
 */
function impactStartedData(
  changeId: string,
  workItemId: string,
  claim: QueueClaimIdentity,
): Record<string, unknown> {
  return {
    kind: 'coordinator',
    queue: true,
    purpose: CHANGE_IMPACT_PURPOSE,
    changeId,
    workItemId,
    claim: { id: claim.id, owner: claim.owner, claimGeneration: claim.claimGeneration },
  };
}

/**
 * 从 attempt.started 的 data 读回关联。缺任一条就不算 impact 专属 Attempt。
 *
 * 返回对象而不只是一个 changeId：调用方还要拿 changeId / target 与本次 claim
 * 三项一起对照，只读 changeId 的话`换了目标工作项」和`换了牌」都看不出来。
 */
interface ImpactAssociation {
  readonly changeId: string;
  readonly workItemId: string;
  readonly claim: { readonly id: string; readonly owner: string; readonly claimGeneration: number };
}

function readAssociation(data: unknown): ImpactAssociation | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const row = data as Record<string, unknown>;
  if (row.queue !== true || row.purpose !== CHANGE_IMPACT_PURPOSE) return undefined;
  const changeId = row.changeId;
  const target = row.workItemId;
  if (typeof changeId !== 'string' || changeId.trim().length === 0) return undefined;
  if (typeof target !== 'string' || target.trim().length === 0) return undefined;
  const claim = row.claim;
  if (claim === null || typeof claim !== 'object') return undefined;
  const triple = claim as Record<string, unknown>;
  const id = triple.id;
  const owner = triple.owner;
  const generation = triple.claimGeneration;
  if (typeof id !== 'string' || typeof owner !== 'string') return undefined;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation <= 0) {
    return undefined;
  }
  return {
    changeId,
    workItemId: target,
    claim: { id, owner, claimGeneration: generation },
  };
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
 * 目标 hop：从队列里查出本目标 role=executor 的**活**租约，代次与请求一致。
 *
 * 为什么从 hops.list 查而不是按 claim.id 取：调用方手上的 claim 是 impact 的，
 * 拿它去 get 出来的行是 impact hop——把它当 executor 目标，等于用 impact 牌的
 * 租约冒充执行者的租约，目标对不对全凭调用方自觉。
 *
 * 代次取自 request.claimGeneration：判断是**对那一代**领取权做出的；换代之后
 * 请求指向的那次执行已经不在了，接着判断等于给空气出结论。
 */
async function requireLiveExecutorHop(
  hops: QueuedHopRepository,
  request: ChangeRequest,
  now: string,
): Promise<void> {
  const candidates = (await hops.list()).filter(
    (hop) =>
      hop.missionId === request.missionId &&
      hop.workItemId === request.workItemId &&
      hop.role === 'executor',
  );
  const live = candidates.find(
    (hop) => hop.claimGeneration === request.claimGeneration && isLiveHopAt(hop, now),
  );
  if (!live) {
    throw new PlatformRuleError(
      'CLAIM_FENCE_REJECTED',
      '已确认变更指向的那次执行没有活着的 executor 租约，或代次不匹配，拒绝。',
    );
  }
}

/**
 * impact hop 自身：role=coordinator / purpose=impact / changeId 与请求一致、
 * mission 与工作项准确、租约活着。
 *
 * 为什么身份只从**仓储里的 request** 取而不是从 body：request 是已确认的持久事实，
 * body 是调用方这一次带上来的话。用 body 里的 mission/workItem 去比对 hop，等于让
 * 调用方自己声明「我这张牌是给这个目标的」，错目标的 impact 牌就能自称对齐。
 *
 * 不查这些的话，任意一张活着的 coordinator 牌都能自称`我在做影响判断」,
 * 而 purpose / changeId / 目标工作项正是发牌时钉死的那几件事。
 */
async function requireLiveImpactHop(
  hops: QueuedHopRepository,
  request: ChangeRequest,
  claim: QueueClaimIdentity,
  now: string,
): Promise<void> {
  const hop = await hops.get(claim.id);
  const aligned =
    hop !== undefined &&
    hop.role === 'coordinator' &&
    hop.purpose === CHANGE_IMPACT_PURPOSE &&
    hop.changeId === request.changeId &&
    hop.missionId === request.missionId &&
    hop.workItemId === request.workItemId;
  if (!aligned || !isLiveClaim(hop, claim, now)) {
    throw new PlatformRuleError(
      'CLAIM_FENCE_REJECTED',
      '这次调用没有持有本条变更的 impact 活租约，或租约绑的目标不是这条变更指向的工作项，拒绝。',
    );
  }
}

/**
 * 同事务里把「impact 牌 + 目标执行 + 目标 attempt」一次性校完。
 *
 * 只在 started 事件上校绑定是不够的：事件刻的是**发牌那一刻**的关联，它不证明
 * 现在这张 hop/workItem 还对、也不证明那次 executor attempt 还在跑。三条都要现查：
 *   1. impact hop：role/purpose/changeId/mission/workItem 与仓储 request 对齐、租约活；
 *   2. executor hop：request 指向的那一代仍有活租约（换代即失配）；
 *   3. 目标最新 executor attempt：还是 request.attemptId 且 in_progress。
 *
 * 为什么取「最新 executor attempt」而不是 `find(in_progress)`：find 会在历史里
 * 捞到任意一条在跑的，哪怕目标早就换了另一次执行。取最后一条才对应「现在这一次」。
 */
async function requireCurrentImpactTarget(
  ctx: PlatformContext,
  request: ChangeRequest,
  claim: QueueClaimIdentity,
  now: string,
): Promise<{ mission: Mission; item: WorkItem }> {
  const hops = ctx.queuedHops!;
  await requireLiveImpactHop(hops, request, claim, now);
  await requireLiveExecutorHop(hops, request, now);
  const { mission, item } = await ctx.locateItem(request.missionId, request.workItemId);
  const executorAttempts = item.attempts.filter((attempt) => attempt.kind === 'executor');
  const latest = executorAttempts[executorAttempts.length - 1];
  if (!latest || latest.id !== request.attemptId || latest.status !== 'in_progress') {
    throw new PlatformRuleError(
      'UNKNOWN_ATTEMPT',
      `已确认变更指向的 executor attempt ${request.attemptId} 已不在跑。`,
    );
  }
  return { mission, item };
}

/**
 * 能不能开新的 impact 判断：暂停 / 终态的 Mission 上没有出边。
 *
 * 暂停时开等于在`先别动它」的命令下偷偷动它；终态上开则是给既成事实补章。
 */
function requireStartable(mission: Mission): void {
  if (mission.isPaused || TERMINAL_MISSION.has(mission.status)) {
    throw new PlatformRuleError(
      'MISSION_NOT_STARTABLE',
      `Mission ${mission.id} 已暂停或在终态，不能开新的影响判断。`,
    );
  }
}

/**
 * 开 Attempt：复用 Mission 的唯一 coordinator 规矩。
 *
 * kernel 抛的不变量错误要翻成 Platform 语言带上上下文——否则调用方只拿到一句
 * `already has an in_progress coordinator attempt」，说不清是被谁占着。
 */
function startImpactAttempt(mission: Mission): Attempt {
  try {
    return mission.startCoordinatorAttempt();
  } catch (error) {
    if (error instanceof InvariantViolationError) {
      throw new PlatformRuleError(
        error.code,
        `Mission ${mission.id} 已有一个在跑的 coordinator Attempt，影响判断不得抢占。`,
      );
    }
    throw error;
  }
}

/** 租约活着：status=claimed 且未到期。过期租约等价于没有租约。 */
function isLiveHopAt(hop: QueuedHop, now: string): boolean {
  const leaseUntil = hop.leaseUntil;
  if (hop.status !== 'claimed' || typeof leaseUntil !== 'string') return false;
  return Date.parse(now) < Date.parse(leaseUntil);
}

/**
 * 校核`这个 Attempt、这次调用、这条变更」确实是发牌那一刻配好的那一组。
 *
 * 三层都查：Attempt 本身是 in_progress 的 coordinator（requireAttempt），
 * 它的 started 事件带 impact 关联（changeId 与 target 对得上），且事件里刻的
 * claim 三元组与本次调用携带的 claim 完全相同。
 *
 * 少了最后一层，同一条变更的另一张 impact 牌也能借当前 Attempt 往里写——
 * 两张牌各自以为自己在判断，写出来的记录只有一条。
 */
async function requireImpactAttempt(
  ctx: PlatformContext,
  missionId: string,
  coordinatorAttemptId: string,
  request: ChangeRequest,
  claim: QueueClaimIdentity,
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
  if (!associated || associated.changeId !== request.changeId) {
    throw new PlatformRuleError(
      'WRONG_ROLE',
      `attempt ${coordinatorAttemptId} 不是这次变更的影响判断 Attempt。`,
    );
  }
  if (associated.workItemId !== request.workItemId) {
    throw new PlatformRuleError(
      'WRONG_ROLE',
      `attempt ${coordinatorAttemptId} 判断的目标工作项不是 ${request.workItemId}。`,
    );
  }
  const same =
    associated.claim.id === claim.id &&
    associated.claim.owner === claim.owner &&
    associated.claim.claimGeneration === claim.claimGeneration;
  if (!same) {
    throw new PlatformRuleError(
      'CLAIM_FENCE_REJECTED',
      '这次调用的 impact 领取身份与发牌时钉下的不一致，拒绝。',
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
 * 冲突时不覆盖：影响判断是 append-only 事实，`重算结论」应当换新 id，
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

function claimIdentity(claim: QueueClaimIdentity): ChangeImpactClaim {
  return Object.freeze({
    id: claim.id,
    owner: claim.owner,
    claimGeneration: claim.claimGeneration,
  });
}

/**
 * 装配齐备 + 事务支持 fence 才有资格做影响判断。
 *
 * 为什么还要查事务：缺了 fence 的话`持有租约」与`这次写入」不在同一事务，
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
 * 走 ctx.txFenced：新 Attempt 的 attempt.started 与`这次调用确实持有当时的队列槽」
 * 在**同一事务**里落下。分开写的话，拿到过期租约的调用能把 Attempt 开出来而它的
 * 来源查不到——后面读写都靠来源校核，那次调用的判断就成了孤儿。
 *
 * claim 在这里是 impact 自己的 hop，不是目标 executor 的 hop：两者角色不同、
 * 代次也不相干，混用会拿 impact 牌的租约去冒充执行者的租约。
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
  const impact = claim!;
  return ctx.txFenced(impact, async () => {
    // 时钟只从 ctx 取，且要取在事务里：事务外的预取时间可以用`这一刻还没过期」
    // 的说法让过期租约再写一次。
    const now = ctx.clock.now().toISOString();
    const request = requireRequest(await requests.get(changeId), changeId);
    requireSameMission(request, missionId, changeId);
    // impact 牌、executor 租约、目标 attempt 三条在同一事务里一次校完，都在才谈开局。
    const { mission } = await requireCurrentImpactTarget(ctx, request, impact, now);
    requireStartable(mission);
    // 也不给这条 Attempt 任何额外权限。普通 coordinator 正在跑时这里抛
    // CONCURRENT_COORDINATOR_ATTEMPT——impact 不抢占在跑的判断。
    const started = startImpactAttempt(mission);
    if (profile) started.recordProfile(profile);
    await ctx.event(
      mission,
      ATTEMPT_STARTED_KIND,
      impactStartedData(changeId, request.workItemId, impact),
      undefined,
      started.id,
    );
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
  return ctx.attemptWrite(missionId, coordinatorAttemptId, claim, async () => {
    const now = ctx.clock.now().toISOString();
    const request = requireRequest(await requests.get(changeId), changeId);
    requireSameMission(request, missionId, changeId);
    await requireImpactAttempt(ctx, missionId, coordinatorAttemptId, request, claim!);
    await requireCurrentImpactTarget(ctx, request, claim!, now);
    return request;
  });
}

/**
 * 提交影响判断：保存事实 + 记事件，**不做重派 / 取消**。
 *
 * 只有判断与保存，不是 applied / verified：decision=replan 或 cancel_replace 也不会
 * 触发任何取消或重派——执行应用是另一条链路的事，写进这里就会有人拿`有影响」
 * 当`已处理」。
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
  const business = readImpactBody(body);
  return ctx.attemptWrite(missionId, coordinatorAttemptId, claim, async () => {
    const now = ctx.clock.now().toISOString();
    const request = requireRequest(await requests.get(changeId), changeId);
    requireSameMission(request, missionId, changeId);
    const { mission } = await requireImpactAttempt(
      ctx,
      missionId,
      coordinatorAttemptId,
      request,
      claim!,
    );
    // 读/写都在同一回调里现校 impact 归属与当前 running executor 目标：
    // 只验 started 事件会让「目标已结束、租约却还活着」的窗口可写。
    await requireCurrentImpactTarget(ctx, request, claim!, now);
    const candidate: ChangeImpact = {
      changeId,
      missionId,
      workItemId: request.workItemId,
      attemptId: request.attemptId,
      claimGeneration: request.claimGeneration,
      coordinatorAttemptId,
      // 内层 claim 必须是 impact 自己的真实代次：用 request 的代次会让记录
      // 看起来像`那条执行自己做的判断」。
      claim: claimIdentity(claim!),
      decision: business.decision,
      workOrderDiff: business.workOrderDiff,
      affectedAcceptance: business.affectedAcceptance,
      reason: business.reason,
    };
    const saved = await appendImpact(impacts, candidate);
    // 重试不该再发一次事件：事件是`做了次判断」，重复发会让回放看到两条
    // 而实际只有一条记录。
    if (!saved.created) return saved.impact;
    // 同一事务：判断落库与它的事件要么都在，要么都不在。分开写会出现
    // `有记录没事件」——回放时这一段没有解释，只能靠时间戳猜。
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
 * 为什么走 txFenced(executorClaim)：这是一句`谁现在正拿着这个执行」的问句，
 * 答案必须与当时的租约同一个事务，否则交回的列表可能已经换代。
 *
 * 为什么固定只看 target（workItem + attempt + generation）：拿 sourceContractRevision
 * 等于当前 revision 当全停条件会静默吃掉`这一代还没判断」的请求——契约代次和
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
  return ctx.txFenced(executorClaim, async () => {
    const now = ctx.clock.now().toISOString();
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
    const { mission, item } = await ctx.locateItem(missionId, workItemId);
    // 停着 / 终态 / 已有 in_progress coordinator 都返回 []：
    // 已经有 coordinator 说明这一轮判断正在做，再给一次就会开出第二条并发判断。
    if (mission.isPaused || TERMINAL_MISSION.has(mission.status)) return Object.freeze([]);
    if (mission.coordinatorAttempts.some((attempt) => attempt.status === 'in_progress')) {
      return Object.freeze([]);
    }
    // 正在跑的必须是这次查询点名的那一次：执行的 attempt 已经换了代还在按旧
    // attemptId 报未决项，给出的清单没有人在跑。
    const running = item.attempts.find((attempt) => attempt.status === 'in_progress');
    if (!running || running.id !== executorAttemptId) return Object.freeze([]);
    const all = await requests.listByMission(missionId, {
      workItemId,
      attemptId: executorAttemptId,
      claimGeneration: executorClaim!.claimGeneration,
    });
    const decided = new Set((await impacts.listByMission(missionId)).map((row) => row.changeId));
    return Object.freeze(all.filter((row) => !decided.has(row.changeId)));
  });
}

/**
 * 失租的旧 impact Attempt 的可信收尾：**只关这一条 Attempt，不写任何判断。**
 *
 * 为什么需要它：impact hop 在跑的时候，它的租约可能到期或被别的进程接管（换代）。
 * 那时正常的 `finishAttempt(claim)` 会被围栏拒掉，而调度器的 finally 必须把
 * Attempt 关掉 —— 否则执行者都已经终态了，平台上还留着一条没人认领的
 * in_progress impact coordinator：它占着「唯一 coordinator」名额，让后面的普通
 * 验收连 Attempt 都开不出来。
 *
 * 为什么不能拿调用方给的 owner / generation / clock 当依据：那些正是失租之后不再
 * 可信的东西。身份全部从**已持久化的 started 事件**读回来（发牌那一刻刻下的
 * changeId、目标工作项、claim 三元组），再与仓储里的请求与 hop 行对照；时钟只取
 * ctx.clock。HTTP body 永远不是这里的输入。
 *
 * 三条都成立才收：
 *   1. 这条 Attempt 确实是影响判断专属 Attempt（started 事件带 impact 关联）；
 *   2. 关联的那条变更与工作项仍对得上（不给「顺手关别人的 Attempt」留口子）；
 *   3. 事件里那次领取**确实已经失效** —— 还活着就拒绝走这条路径，围栏不该被绕过。
 *
 * 收尾复用 `attempts.finishAttempt` 本体：用量、输出尾部、结束原因都按同一套内部
 * 事件落账，**不**在这里另写一份，也不写 ChangeImpact。
 */
export async function finishLostImpactAttempt(
  ctx: PlatformContext,
  missionId: string,
  coordinatorAttemptId: string,
  outcome: Parameters<typeof attemptsFinish>[3],
): Promise<void> {
  if (!supportsChangeImpact(ctx)) {
    throw new PlatformRuleError(
      CHANGE_IMPACT_UNSUPPORTED,
      '当前平台没有装配影响判断所需的变更仓储与队列槽，失租收尾也无从可信核对。',
    );
  }
  const requests = ctx.changeRequests!;
  const hops = ctx.queuedHops!;
  return ctx.tx(async () => {
    const now = ctx.clock.now().toISOString();
    const { mission } = await ctx.locate(missionId);
    const attempt = mission.attempt(coordinatorAttemptId);
    if (!attempt) {
      throw new PlatformRuleError('UNKNOWN_ATTEMPT', `attempt ${coordinatorAttemptId} 不存在`);
    }
    // 只关 impact coordinator：执行者与后来新开的普通 coordinator 都不在这条路径上。
    if (attempt.kind !== 'coordinator') {
      throw new PlatformRuleError(
        'WRONG_ROLE',
        `attempt ${coordinatorAttemptId} 不是 coordinator，影响判断失租收尾只关 impact coordinator。`,
      );
    }
    // 已经终态：幂等 no-op。重复收尾会把用量与输出尾部再记一次。
    if (attempt.status !== 'in_progress') return;
    const events = await ctx.activity.list(missionId);
    const started = events.find(
      (event) => event.kind === ATTEMPT_STARTED_KIND && event.attemptId === coordinatorAttemptId,
    );
    const association = readAssociation(started?.data);
    if (!association) {
      throw new PlatformRuleError(
        'WRONG_ROLE',
        `attempt ${coordinatorAttemptId} 的 started 事件没有影响判断关联，不是 impact Attempt，拒绝按失租收尾。`,
      );
    }
    const request = requireRequest(await requests.get(association.changeId), association.changeId);
    requireSameMission(request, missionId, association.changeId);
    if (request.workItemId !== association.workItemId) {
      throw new PlatformRuleError(
        'CLAIM_FENCE_REJECTED',
        `变更 ${association.changeId} 的目标工作项与发牌时钉下的不一致，拒绝收尾。`,
      );
    }
    const hop = await hops.get(association.claim.id);
    const aligned =
      hop !== undefined &&
      hop.role === 'coordinator' &&
      hop.purpose === CHANGE_IMPACT_PURPOSE &&
      hop.changeId === request.changeId &&
      hop.missionId === missionId &&
      hop.workItemId === request.workItemId;
    if (!aligned) {
      throw new PlatformRuleError(
        'CLAIM_FENCE_REJECTED',
        '这条 Attempt 记下的队列槽不是本条变更的 impact hop，拒绝收尾。',
      );
    }
    // 旧 claim 必须**确实**失效：还活着就说明调用方该走带围栏的正常路径。
    if (isLiveClaim(hop, association.claim, now)) {
      throw new PlatformRuleError(
        'CLAIM_FENCE_REJECTED',
        '这条 Attempt 的 impact 租约仍然有效，失租收尾不得绕过围栏代写。',
      );
    }
    await attemptsFinish(ctx, missionId, coordinatorAttemptId, outcome);
  });
}
