/**
 * ChangeCoverage 专属 Platform 动作：协调者声明「这条变更已写进第 N 轮工单内容」。
 *
 * 为什么单独一个模块而不是并进 change-receipt.ts：那边是执行者按层说「我收到了」，
 * 身份来自执行者自己的 hop；这边是协调者说「工单正文里已经有了」，身份来自
 * coordinator Attempt。两者方向相反、代次互不相干，写在一起迟早有人拿执行者的牌
 * 去签协调者的声明。
 *
 * 为什么不并进 change-impact.ts：影响判断是 L2「会不会打到在跑的执行」，覆盖是
 * 「已经落到哪一轮工单」。判断那一侧要读变更请求，这一侧只认已持久的影响判断。
 *
 * 身份纪律：missionId / workItemId / coordinatorAttemptId / at 全部来自调用参数与
 * 平台时钟。body 里只允许 changeId / orderRevision / workOrderHash，多一个身份字段
 * 就拒——允许调用方自己签自己的来源，覆盖就不再是事实。
 *
 * 为什么必须由平台核对哈希而不是照抄 body：这是一条**声明**，声明本身既不是已
 * 应用也不是已验证。平台不拿当前工单内容去比，就等于「记下了覆盖」这件事由调用
 * 方一句话决定，追溯时无从校验。
 *
 * 零第三方依赖：第三方只允许出现在 src/application/pg-store.ts。
 */

import type { ChangeImpact } from '../change-impact.ts';
import { workOrderContentHash } from '../change-receipt.ts';
import type { ChangeCoverage } from '../change-coverage.ts';
import { CHANGE_IMPACT_PURPOSE } from './change-impact.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import type { QueueClaimIdentity } from './types.ts';

/** 缺仓储备时的统一拒绝：不退化成「跳过校验直接写」。 */
export const CHANGE_COVERAGE_UNSUPPORTED = 'CHANGE_COVERAGE_UNSUPPORTED';

/** 覆盖事件名。叙事与事件覆盖都按这一个名字归类。 */
export const CHANGE_COVERAGE_RECORDED_KIND = 'change.coverage_recorded';

/** 可修订状态：与 kernel reviseOrder 允许的那一组同源，别处改了这里也要跟着改。 */
const REVISABLE = new Set(['created', 'rejected', 'blocked']);

const HASH_RE = /^[0-9a-f]{64}$/;

/** body 只允许这三个键；多一个（含任何身份字段）就拒。 */
const BODY_KEYS: readonly string[] = ['changeId', 'orderRevision', 'workOrderHash'];

interface CoverageBody {
  readonly changeId: string;
  readonly orderRevision: string;
  readonly workOrderHash: string;
}

function readBody(body: unknown): CoverageBody {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new PlatformRuleError('CHANGE_COVERAGE_REJECTED', '覆盖声明必须是对象。');
  }
  const raw = body as Record<string, unknown>;
  const keys = Object.keys(raw);
  // 只查 trim 后非空、**不改原文**：记录是事实，改写 caller 的文本等于篡改事实。
  const text: Record<string, string> = {};
  for (const key of BODY_KEYS) {
    const value = raw[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new PlatformRuleError('CHANGE_COVERAGE_REJECTED', `body.${key} 必须是非空字符串。`);
    }
    text[key] = value;
  }
  if (keys.length !== BODY_KEYS.length || keys.some((key) => !BODY_KEYS.includes(key))) {
    throw new PlatformRuleError('CHANGE_COVERAGE_REJECTED', 'body 只允许 changeId / orderRevision / workOrderHash。');
  }
  // 哈希另过一遍格式：只按「非空字符串」放行会把任意文本当成内容摘要存进去，
  // 之后「覆盖过」就再也比不出覆盖的是不是同一份工单。
  if (!HASH_RE.test(text.workOrderHash)) {
    throw new PlatformRuleError('CHANGE_COVERAGE_REJECTED', 'workOrderHash 必须是 64 位小写 hex（sha256）。');
  }
  return { changeId: text.changeId, orderRevision: text.orderRevision, workOrderHash: text.workOrderHash };
}

/**
 * 装配齐备才有资格写覆盖。
 *
 * 只查 changeCoverages 与 changeImpacts：这一侧不读变更请求（只认已持久的影响
 * 判断），把它并进影响判断三件套会让「能判断」与「能记覆盖」互相绑死。
 * 带 claim 时还要有 queuedHops——没有队列槽就无从核对这张牌是谁的。
 */
function requireAssembled(ctx: PlatformContext, claim: QueueClaimIdentity | undefined): void {
  const ready = ctx.changeCoverages && ctx.changeImpacts && (!claim || ctx.queuedHops);
  if (!ready) {
    throw new PlatformRuleError(
      CHANGE_COVERAGE_UNSUPPORTED,
      '当前平台没有装配覆盖所需的覆盖 / 影响仓储与队列槽。',
    );
  }
}

/**
 * 这张牌必须是本 Mission 的协调者牌，且不是 impact 专属牌。
 *
 * 为什么不认 impact 牌：impact 牌是限权发的，只够写「这次改动影响谁」；拿它来
 * 声明「工单已经覆盖」等于把限权牌扩成全权牌。
 */
async function requireCoordinatorHop(
  ctx: PlatformContext,
  missionId: string,
  claim: QueueClaimIdentity,
): Promise<void> {
  const hop = await ctx.queuedHops!.get(claim.id);
  if (hop !== undefined && hop.purpose === CHANGE_IMPACT_PURPOSE) {
    throw new PlatformRuleError(
      'WRONG_ROLE',
      'impact 牌是限权牌，只能写影响判断，不能记录覆盖。',
    );
  }
  const aligned = hop !== undefined && hop.role === 'coordinator' && hop.missionId === missionId;
  if (!aligned) {
    throw new PlatformRuleError('CLAIM_FENCE_REJECTED', '这次调用没有持有本 Mission 的协调者牌，拒绝。');
  }
}

/** 只有 compatible 且目标就是本工作项 / 本 Mission 的影响判断才谈得上覆盖。 */
function requireCompatible(
  impact: ChangeImpact | undefined,
  changeId: string,
  missionId: string,
  workItemId: string,
): ChangeImpact {
  const ok =
    impact !== undefined &&
    impact.decision === 'compatible' &&
    impact.workItemId === workItemId &&
    impact.missionId === missionId;
  if (!ok) {
    throw new PlatformRuleError(
      'CHANGE_COVERAGE_NOT_COMPATIBLE',
      `changeId ${changeId} 没有针对工作项 ${workItemId} 的 compatible 影响判断，不能记覆盖。`,
    );
  }
  return impact;
}

/**
 * 记下一条覆盖。
 *
 * 核对顺序即拒绝顺序：身份 → 声明形状 → 有判断 → 可修订 → 轮次与内容哈希都对。
 * 任一条不符就抛，事务回滚，盘上一个字节都不变。
 */
export async function recordChangeCoverage(
  ctx: PlatformContext,
  missionId: string,
  coordinatorAttemptId: string,
  workItemId: string,
  body: unknown,
  claim?: QueueClaimIdentity,
): Promise<ChangeCoverage> {
  requireAssembled(ctx, claim);
  const coverages = ctx.changeCoverages!;
  return ctx.attemptWrite(missionId, coordinatorAttemptId, claim, async () => {
    // 这已经拒绝非协调者 Attempt 与非 in_progress。
    await ctx.requireAttempt(missionId, coordinatorAttemptId, 'coordinator');
    if (claim) await requireCoordinatorHop(ctx, missionId, claim);
    const business = readBody(body);
    requireCompatible(
      await ctx.changeImpacts!.get(business.changeId),
      business.changeId,
      missionId,
      workItemId,
    );
    const { mission, item } = await ctx.locateItem(missionId, workItemId);
    if (!REVISABLE.has(item.status)) {
      throw new PlatformRuleError(
        'CHANGE_COVERAGE_NOT_REVISABLE',
        `工作项 ${workItemId} 当前是 ${item.status}，工单已定稿，不能再记覆盖。`,
      );
    }
    const order = item.order;
    // 两条都要比：只看轮次会放行「轮次对但正文被换过」，只看内容会放行
    // 「内容一样但这是上一轮的工单」——覆盖必须钉在**这一轮**的这份正文上。
    const matches =
      order !== undefined &&
      order.orderRevision === business.orderRevision &&
      workOrderContentHash(order) === business.workOrderHash;
    if (!matches) {
      throw new PlatformRuleError(
        'CHANGE_COVERAGE_MISMATCH',
        `changeId ${business.changeId} 声明的轮次 / 内容哈希与工作项 ${workItemId} 当前工单不一致。`,
      );
    }
    // 身份字段只从参数与时钟取：body 里的身份一律不信。
    const record: ChangeCoverage = {
      changeId: business.changeId,
      missionId,
      workItemId,
      orderRevision: business.orderRevision,
      workOrderHash: business.workOrderHash,
      coordinatorAttemptId,
      at: ctx.clock.now().toISOString(),
    };
    const existing = await coverages.get(business.changeId, business.orderRevision);
    // 同键异内容由仓储抛 ChangeCoverageConflictError——不接住、不覆盖：覆盖是
    // append-only 事实，静默覆盖会让追溯时看到一条却说不清它是第几版。
    await coverages.append(record);
    // 已有同键同内容：幂等重放，交回落库的那条，不再发第二次事件——重复发会让
    // 回放看到两条而实际只有一条记录。
    if (existing) return existing;
    await ctx.event(
      mission,
      CHANGE_COVERAGE_RECORDED_KIND,
      { changeId: business.changeId, workItemId, orderRevision: business.orderRevision, workOrderHash: business.workOrderHash },
      workItemId,
      coordinatorAttemptId,
    );
    return (await coverages.get(business.changeId, business.orderRevision)) ?? record;
  });
}
