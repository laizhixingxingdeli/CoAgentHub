/**
 * ChangeReceipt 专属 Platform 动作：执行者读发给自己的差异、按层写回执。
 *
 * 为什么单独一个模块而不是并进 change-impact.ts：那边是 L2「这次改动会不会打到
 * 在跑的执行」的判断路径，身份来自 impact 自己的 hop、目标是 coordinator Attempt；
 * 这边是 L1 的接收侧，身份来自执行者自己的 hop、目标是 executor Attempt。两者
 * 代次互不相干，写在一起迟早有人拿 impact 的牌去签执行者的回执。
 *
 * 身份纪律：missionId / workItemId / attemptId / claimGeneration / at 全部来自
 * 本次执行的围栏身份、已持久的 ChangeImpact 与平台时钟。body 里只允许出现
 * changeId / layer（以及 executor_started 的 contentHash），多一个身份字段就拒——
 * 允许调用方自己签自己的来源，回执链就不再是事实。
 *
 * 为什么没有 verified 层：回执只记「我收到了」，验收通过是另一件事。让 ACK 能写成
 * verified，就等于让「有回执」当「已通过验收」用。
 *
 * 零第三方依赖：第三方只允许出现在 src/application/pg-store.ts。
 */

import type { ChangeImpact } from '../change-impact.ts';
import { diffContentHash, type ChangeReceipt, type ChangeReceiptLayer } from '../change-receipt.ts';
import { holdsCurrentClaim } from '../durable-scheduler.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import type { QueueClaimIdentity } from './types.ts';

export const CHANGE_RECEIPT_UNSUPPORTED = 'CHANGE_RECEIPT_UNSUPPORTED';

/** 回执事件名。叙事与事件覆盖都按这一个名字归类。 */
export const CHANGE_RECEIPT_RECORDED_KIND = 'change.receipt_recorded';

/** 可写层的固定顺序：低层没落就写高层是越层，高层已落再写低层是回退。 */
const LAYER_ORDER: readonly ChangeReceiptLayer[] = [
  'adapter_received',
  'session_consumed',
  'executor_started',
];

const HASH_RE = /^[0-9a-f]{64}$/;

/** 执行者视角下一次变更的一份交付：diff + 已记录到哪几层。 */
export interface ChangeDelivery {
  readonly changeId: string;
  readonly workOrderDiff: string;
  readonly affectedAcceptance: readonly number[];
  readonly diffHash: string;
  readonly receipts: readonly ChangeReceiptLayerView[];
}

/** 一层的回执视图：只给层 / 时刻 / 内容哈希，claim / reason 一律不外带。 */
export interface ChangeReceiptLayerView {
  readonly layer: ChangeReceiptLayer;
  readonly at: string;
  readonly contentHash?: string;
}

/**
 * 装配齐备 + 事务支持 fence 才有资格读写回执。
 *
 * 为什么不连 changeRequests 一起要求：回执这一侧不读变更请求，只认已持久的
 * ChangeImpact。把它并进影响判断那一组会让「能判断」与「能回执」互相绑死。
 */
export function supportsChangeReceipt(ctx: PlatformContext): boolean {
  return Boolean(ctx.changeReceipts && ctx.changeImpacts && ctx.queuedHops && ctx.hasFencedTransaction());
}

function requireAssembled(ctx: PlatformContext, claim: QueueClaimIdentity | undefined): void {
  if (!supportsChangeReceipt(ctx) || !claim) {
    throw new PlatformRuleError(
      CHANGE_RECEIPT_UNSUPPORTED,
      '当前平台没有装配回执所需的回执 / 影响仓储与队列槽，或本次调用没有携带队列领取身份。',
    );
  }
}

/**
 * 校完「这次调用就是这趟执行本人」：Attempt 存在且 in_progress、工作项当前跑的
 * 就是它、hop 是执行者自己的槽且租约还在这一代。
 *
 * 为什么三条都要：只验 Attempt 会放行「换了代还拿旧 attemptId 写」；只验租约会
 * 放行「借别人的 execution hop 签自己的回执」。回执是 append-only 事实，写错一条
 * 就再也改不回来。
 */
async function requireExecutorFence(
  ctx: PlatformContext,
  missionId: string,
  workItemId: string,
  attemptId: string,
  claim: QueueClaimIdentity,
  now: string,
): Promise<void> {
  await ctx.requireAttempt(missionId, attemptId, 'executor');
  const { item } = await ctx.locateItem(missionId, workItemId);
  const running = item.attempts.find((row) => row.status === 'in_progress');
  if (!running || running.id !== attemptId) {
    throw new PlatformRuleError(
      'CHANGE_NOT_DELIVERABLE',
      '当前 in_progress Attempt 不是这次执行',
    );
  }
  const hop = await ctx.queuedHops!.get(claim.id);
  const aligned =
    hop !== undefined &&
    hop.role === 'executor' &&
    hop.missionId === missionId &&
    hop.workItemId === workItemId;
  if (!aligned || !holdsCurrentClaim(hop, { id: claim.id, owner: claim.owner, claimGeneration: claim.claimGeneration, now })) {
    throw new PlatformRuleError('CLAIM_FENCE_REJECTED', '租约失效或代次不匹配');
  }
}

/** 属于这趟执行、且结论是 compatible 的那些影响判断。replan / cancel_replace 不给。 */
async function deliverableImpacts(
  ctx: PlatformContext,
  missionId: string,
  workItemId: string,
  attemptId: string,
  claimGeneration: number,
): Promise<readonly ChangeImpact[]> {
  const all = await ctx.changeImpacts!.listByMission(missionId);
  return all.filter(
    (impact) =>
      impact.attemptId === attemptId &&
      impact.workItemId === workItemId &&
      impact.claimGeneration === claimGeneration &&
      impact.decision === 'compatible',
  );
}

/** 已记录层按固定层序排好：消费方不该自己去猜哪一层先落。 */
function receiptViews(rows: readonly ChangeReceipt[]): readonly ChangeReceiptLayerView[] {
  const known = new Map<ChangeReceiptLayer, ChangeReceipt>();
  for (const row of rows) {
    if (LAYER_ORDER.includes(row.layer)) known.set(row.layer, row);
  }
  return Object.freeze(
    LAYER_ORDER.filter((layer) => known.has(layer)).map((layer) => {
      const row = known.get(layer)!;
      return Object.freeze({
        layer,
        at: row.at,
        ...(row.contentHash === undefined ? {} : { contentHash: row.contentHash }),
      });
    }),
  );
}

/**
 * 执行者读发给自己的差异。
 *
 * 只读 compatible：replan / cancel_replace 意味着这一趟不该照跑，把它们一起交回
 * 等于让执行者自己决定该不该继续。没有符合的差异就返回空数组而不是抛——「没有
 * 新东西」是正常的，不是错误。
 */
export async function listChangeDeliveries(
  ctx: PlatformContext,
  missionId: string,
  workItemId: string,
  attemptId: string,
  claim: QueueClaimIdentity | undefined,
): Promise<readonly ChangeDelivery[]> {
  requireAssembled(ctx, claim);
  const executor = claim!;
  return ctx.attemptWrite(missionId, attemptId, executor, async () => {
    const now = ctx.clock.now().toISOString();
    await requireExecutorFence(ctx, missionId, workItemId, attemptId, executor, now);
    const impacts = await deliverableImpacts(
      ctx,
      missionId,
      workItemId,
      attemptId,
      executor.claimGeneration,
    );
    const deliveries: ChangeDelivery[] = [];
    for (const impact of impacts) {
      deliveries.push(
        Object.freeze({
          changeId: impact.changeId,
          workOrderDiff: impact.workOrderDiff,
          affectedAcceptance: Object.freeze([...impact.affectedAcceptance]),
          diffHash: diffContentHash(impact.workOrderDiff),
          receipts: receiptViews(await ctx.changeReceipts!.listByChange(impact.changeId)),
        }),
      );
    }
    return Object.freeze(deliveries);
  });
}

interface AckBody {
  readonly changeId: string;
  readonly layer: ChangeReceiptLayer;
  readonly contentHash: string | undefined;
}

/**
 * 读 body：只允许 changeId / layer，executor_started 必须带 contentHash。
 *
 * contentHash 在这里只当**待核对的输入**（后面必须等于 impact 的 diff 哈希），
 * 不直接信它；其余身份字段一律不收，因为它们全部应该来自围栏与已持久的判断。
 */
function readAckBody(body: unknown): AckBody {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new PlatformRuleError('INVALID_CHANGE_RECEIPT', '回执体必须是对象。');
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set<string>(
    record.layer === 'executor_started'
      ? ['changeId', 'layer', 'contentHash']
      : ['changeId', 'layer'],
  );
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new PlatformRuleError('INVALID_CHANGE_RECEIPT', `回执体不接受字段：${key}`);
    }
  }
  const { changeId, layer } = record;
  if (typeof changeId !== 'string' || changeId.trim().length === 0) {
    throw new PlatformRuleError('INVALID_CHANGE_RECEIPT', 'changeId 必须是非空字符串。');
  }
  if (typeof layer !== 'string' || !LAYER_ORDER.includes(layer as ChangeReceiptLayer)) {
    throw new PlatformRuleError(
      'INVALID_CHANGE_RECEIPT',
      `layer 必须是 ${LAYER_ORDER.join(' | ')} 之一：${String(layer)}`,
    );
  }
  if (layer !== 'executor_started') return { changeId, layer: layer as ChangeReceiptLayer, contentHash: undefined };
  const hash = record.contentHash;
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
    throw new PlatformRuleError(
      'INVALID_CHANGE_RECEIPT',
      'executor_started 的 contentHash 必须是 64 位小写 hex（sha256）。',
    );
  }
  return { changeId, layer: layer as ChangeReceiptLayer, contentHash: hash };
}

/** 目标变更必须存在、属于这趟执行、且结论是 compatible。 */
function requireDeliverableImpact(
  impact: ChangeImpact | undefined,
  missionId: string,
  workItemId: string,
  attemptId: string,
  claimGeneration: number,
  changeId: string,
): ChangeImpact {
  if (
    !impact ||
    impact.missionId !== missionId ||
    impact.workItemId !== workItemId ||
    impact.attemptId !== attemptId ||
    impact.claimGeneration !== claimGeneration ||
    impact.decision !== 'compatible'
  ) {
    throw new PlatformRuleError(
      'CHANGE_NOT_DELIVERABLE',
      `changeId ${changeId} 不是发给这次执行的 compatible 差异`,
    );
  }
  return impact;
}

/**
 * 层序：低层没落就写高层是越层，高层已落再写低层是回退。
 *
 * 为什么不许回退：回执是 append-only 事实链，`收到 → 消费 → 开跑` 只能往前。
 * 允许补写低层，这条链就再也不能回答「卡在哪一层」。
 */
function requireLayerOrder(
  rows: readonly ChangeReceipt[],
  layer: ChangeReceiptLayer,
  changeId: string,
): void {
  const at = LAYER_ORDER.indexOf(layer);
  const present = new Set(rows.map((row) => row.layer));
  for (let i = 0; i < at; i += 1) {
    if (!present.has(LAYER_ORDER[i]!)) {
      throw new PlatformRuleError(
        'RECEIPT_LAYER_ORDER',
        `changeId ${changeId} 的 ${LAYER_ORDER[i]} 还没落，不能写 ${layer}。`,
      );
    }
  }
  for (let i = at + 1; i < LAYER_ORDER.length; i += 1) {
    if (present.has(LAYER_ORDER[i]!)) {
      throw new PlatformRuleError(
        'RECEIPT_LAYER_ORDER',
        `changeId ${changeId} 的 ${LAYER_ORDER[i]} 已落，不能再回写 ${layer}。`,
      );
    }
  }
}

/**
 * 写一层回执：同层同内容幂等返回原记录（不 append、不发事件），异内容交给仓储抛冲突。
 *
 * 身份与 at 全在这里从围栏 / impact / 平台时钟现取，不从 body 抄一个——抄来的
 * at 可以让一条回执看起来早于它要承认的那份 diff。
 */
async function recordLayer(
  ctx: PlatformContext,
  missionId: string,
  workItemId: string,
  attemptId: string,
  claimGeneration: number,
  impact: ChangeImpact,
  layer: ChangeReceiptLayer,
  contentHash: string | undefined,
  at: string,
): Promise<{ receipt: ChangeReceipt; created: boolean }> {
  const rows = await ctx.changeReceipts!.listByChange(impact.changeId);
  const receipt: ChangeReceipt = {
    changeId: impact.changeId,
    missionId,
    workItemId,
    attemptId,
    claimGeneration,
    layer,
    at,
    ...(layer === 'executor_started' ? { contentHash } : {}),
  };
  const existing = rows.find((row) => row.layer === layer);
  if (existing) {
    // 这一层已写且与这次要写的只差时刻：幂等重放，直接把落库的那条交回去。
    if (existing.contentHash === receipt.contentHash) return { receipt: existing, created: false };
    // 同层异内容：交给仓储抛 ChangeReceiptConflictError——不降级成平台错误，也不覆盖。
    await ctx.changeReceipts!.append(receipt);
    throw new Error('unreachable: 同层异内容 append 必须冲突');
  }
  requireLayerOrder(rows, layer, impact.changeId);
  await ctx.changeReceipts!.append(receipt);
  return { receipt, created: true };
}

/**
 * 执行者按层回执。
 *
 * 为什么和读一样走 attemptWrite：租约核对与写入必须在同一事务里，否则「验过的那
 * 一代」与「写下的那一刻」之间可以被换掉。
 */
export async function ackChangeReceipt(
  ctx: PlatformContext,
  missionId: string,
  workItemId: string,
  attemptId: string,
  claim: QueueClaimIdentity | undefined,
  body: unknown,
): Promise<ChangeReceipt> {
  requireAssembled(ctx, claim);
  const executor = claim!;
  const ack = readAckBody(body);
  return ctx.attemptWrite(missionId, attemptId, executor, async () => {
    const now = ctx.clock.now().toISOString();
    await requireExecutorFence(ctx, missionId, workItemId, attemptId, executor, now);
    const impact = requireDeliverableImpact(
      await ctx.changeImpacts!.get(ack.changeId),
      missionId,
      workItemId,
      attemptId,
      executor.claimGeneration,
      ack.changeId,
    );
    // executor_started 才认内容哈希：说「照这份 diff 开跑了」就得拿出那份 diff 的哈希。
    if (ack.layer === 'executor_started' && ack.contentHash !== diffContentHash(impact.workOrderDiff)) {
      throw new PlatformRuleError(
        'RECEIPT_HASH_MISMATCH',
        `contentHash 与 changeId ${ack.changeId} 的工单 diff 不一致。`,
      );
    }
    const saved = await recordLayer(
      ctx,
      missionId,
      workItemId,
      attemptId,
      executor.claimGeneration,
      impact,
      ack.layer,
      ack.contentHash,
      now,
    );
    // 同层同内容的幂等重试不发第二次事件：事件是「记下了一层」，重复发会让回放
    // 看到两条而实际只有一条记录。
    if (!saved.created) return saved.receipt;
    const { mission } = await ctx.locateItem(missionId, workItemId);
    await ctx.event(
      mission,
      CHANGE_RECEIPT_RECORDED_KIND,
      {
        changeId: impact.changeId,
        layer: saved.receipt.layer,
        attemptId,
        claimGeneration: executor.claimGeneration,
        workItemId,
        ...(saved.receipt.contentHash === undefined ? {} : { contentHash: saved.receipt.contentHash }),
      },
      workItemId,
      attemptId,
    );
    return saved.receipt;
  });
}
