/**
 * ChangeReceipt：接收侧承认「这次变更我收到了」的 append-only 回执。
 *
 * 为什么和 ChangeRequest / ChangeImpact 分成三条记录：Request 是 L3 确认要改什么，
 * Impact 是判断这次改动会不会打到在跑的执行，Receipt 是接收侧承认已经收到并照着
 * 做了。三者是三个时刻、三方做的；写成一条记录就会让「确认」「判断」「已收到」
 * 变成一个动作，追溯时无法区分「发了但没到」和「到了但没执行」。
 *
 * 为什么分三层：同一次变更在 adapter 收到、session 消费、executor 开跑各留一张
 * 回执，卡在哪一层一眼可见。只留一张「已完成」等于把中间两层丢掉——出问题时
 * 只知道没做完，不知道卡在哪。
 *
 * 为什么没有 verified 层：回执只记「我收到了」，验收通过与否是另一件事。把验收
 * 做成一层，就会有人拿「有回执」当「已通过验收」——写回执的动作不该能证明质量。
 *
 * 除 node:crypto 外不 import 任何东西：接第二个 agent 时不该因为换 executor
 * 就得改数据形状。
 */

import { createHash } from 'node:crypto';
import type { WorkOrder } from '../kernel/index.ts';

/** 回执的层：适配器已收到 / 会话已消费 / 执行器已开跑。**不含**验收层。 */
export type ChangeReceiptLayer = 'adapter_received' | 'session_consumed' | 'executor_started';

export interface ChangeReceipt {
  /** 与 ChangeRequest.changeId / ChangeImpact.changeId 同名：一条变更一条链。 */
  readonly changeId: string;
  readonly missionId: string;
  readonly workItemId: string;
  readonly attemptId: string;
  /** 目标代次：回执是**对这一代**领取权写下的，换代后旧回执不再算数。 */
  readonly claimGeneration: number;
  readonly layer: ChangeReceiptLayer;
  /** 写下回执的时刻（ISO 字符串）。不参与等值比较：同一事实重放只是时间不同。 */
  readonly at: string;
  /** 仅 executor_started 必带：实际开跑的那份工单 diff 的 sha256。 */
  readonly contentHash?: string;
}

export interface ChangeReceiptRepository {
  append(receipt: ChangeReceipt): Promise<void>;
  get(changeId: string, layer: ChangeReceiptLayer): Promise<ChangeReceipt | undefined>;
  listByChange(changeId: string): Promise<readonly ChangeReceipt[]>;
  listByMission(missionId: string): Promise<readonly ChangeReceipt[]>;
}

export class ChangeReceiptConflictError extends Error {
  readonly code = 'CHANGE_RECEIPT_CONFLICT';
  readonly changeId: string;
  readonly layer: ChangeReceiptLayer;

  constructor(changeId: string, layer: ChangeReceiptLayer) {
    super(
      `ChangeReceipt ${changeId} / ${layer} 已存在且内容不同。` +
        '回执是 append-only 不可变事实，禁止覆盖；新事实请换新 changeId。',
    );
    this.name = 'ChangeReceiptConflictError';
    this.changeId = changeId;
    this.layer = layer;
  }
}

/**
 * 全库统一一处哈希算法。不这么做会怎样：两个调用点各按自己的写法算一遍，
 * 迟早算出不同的摘要，然后「同内容幂等」会被误判成「异内容冲突」。
 */
export function diffContentHash(workOrderDiff: string): string {
  return createHash('sha256').update(workOrderDiff, 'utf8').digest('hex');
}

const LAYERS: readonly string[] = ['adapter_received', 'session_consumed', 'executor_started'];

const IDENTITY_STRING_FIELDS: readonly string[] = [
  'changeId',
  'missionId',
  'workItemId',
  'attemptId',
];

const STRING_FIELDS: readonly string[] = [...IDENTITY_STRING_FIELDS, 'at'];

const KNOWN_FIELDS = new Set<string>([
  ...STRING_FIELDS,
  'claimGeneration',
  'layer',
  'contentHash',
]);

const HASH_RE = /^[0-9a-f]{64}$/;

function requireText(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  // 只查 trim 后非空、**不改原文**：回执是事实，改写 caller 的文本等于篡改事实。
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label}.${key} 必须是非空字符串。`);
  }
  return value;
}

function requireGeneration(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label}.${key} 必须是正整数。`);
  }
  return value;
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(record: Record<string, unknown>, known: Set<string>, label: string): void {
  for (const key of Object.keys(record)) {
    if (!known.has(key)) throw new Error(`${label} 含未知字段：${key}`);
  }
}

function requireMissing(record: Record<string, unknown>, fields: readonly string[], label: string): void {
  for (const key of fields) {
    if (!(key in record)) throw new Error(`${label} 缺字段：${key}`);
  }
}

/**
 * contentHash 的层规则：只有真的开跑了才认内容的哈希。
 *
 * 不这么做：adapter 那层随手带上一个哈希，两层哈希不一致时没人知道该信哪个；
 * 反过来 executor 那层没有哈希，就无从证明「跑的就是这份 diff」。
 */
function requireContentHash(record: Record<string, unknown>, layer: string): string | undefined {
  if (layer !== 'executor_started') {
    if ('contentHash' in record) {
      throw new Error(`ChangeReceipt.layer=${layer} 不带 contentHash：只有 executor_started 才认内容哈希。`);
    }
    return undefined;
  }
  if (!('contentHash' in record)) {
    throw new Error('ChangeReceipt.layer=executor_started 必须带 contentHash。');
  }
  const value = record.contentHash;
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    throw new Error('ChangeReceipt.contentHash 必须是 64 位小写 hex（sha256）。');
  }
  return value;
}

/** 校验整份回执并返回 frozen 副本：caller 之后改自己的对象不该影响库里的事实。 */
export function validateChangeReceipt(receipt: ChangeReceipt): ChangeReceipt {
  const record = requirePlainObject(receipt, 'ChangeReceipt');
  rejectUnknown(record, KNOWN_FIELDS, 'ChangeReceipt');
  requireMissing(record, [...STRING_FIELDS, 'claimGeneration', 'layer'], 'ChangeReceipt');
  const layer = record.layer;
  if (typeof layer !== 'string' || !LAYERS.includes(layer)) {
    throw new Error(
      `ChangeReceipt.layer 必须是 ${LAYERS.join(' | ')} 之一：${String(layer)}` +
        '（verified 不是可写层：回执只记收到，验收通过是另一件事）',
    );
  }
  const text: Record<string, string> = {};
  for (const key of STRING_FIELDS) text[key] = requireText(record, key, 'ChangeReceipt');
  const contentHash = requireContentHash(record, layer);
  return Object.freeze({
    changeId: text.changeId,
    missionId: text.missionId,
    workItemId: text.workItemId,
    attemptId: text.attemptId,
    claimGeneration: requireGeneration(record, 'claimGeneration', 'ChangeReceipt'),
    layer: layer as ChangeReceiptLayer,
    at: text.at,
    ...(contentHash === undefined ? {} : { contentHash }),
  }) as ChangeReceipt;
}

/** 独立 frozen 副本：get / list 每次给新的，caller 改不动库里的对象。 */
export function cloneChangeReceipt(receipt: ChangeReceipt): ChangeReceipt {
  return validateChangeReceipt(receipt);
}

/**
 * 规范化 JSON：对象键按字典序重排、数组保序，然后 stringify。
 *
 * 为什么必须有序化：键顺序变了而内容没变的两个对象，不有序化会算出两个摘要，
 * 于是「同一份工单」会因为字段书写顺序被判成「内容变了」。
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 全部业务字段全等；**不比 at**：同一事实的重放只是记的时刻不同。 */
export function changeReceiptsEqual(a: ChangeReceipt, b: ChangeReceipt): boolean {
  if (a === b) return true;
  for (const key of IDENTITY_STRING_FIELDS) {
    if (a[key as keyof ChangeReceipt] !== b[key as keyof ChangeReceipt]) return false;
  }
  if (a.claimGeneration !== b.claimGeneration) return false;
  if (a.layer !== b.layer) return false;
  if (a.contentHash !== b.contentHash) return false;
  return true;
}

/** sha256 hex。全库一处算法：两处各写一遍迟早算出不同的摘要。 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 交卷快照里的一条变更：只认 changeId 与它实际开跑那份 diff 的哈希。 */
export interface AppliedChangeRef {
  readonly changeId: string;
  readonly contentHash: string;
}

/**
 * 工单内容哈希。**不含 orderRevision**：修订号是「第几次派」的序号，不是工单内容。
 * 把它算进去会怎样：同一份内容换个修订号就换摘要，快照比对就再也认不出「原样重派」。
 */
export function workOrderContentHash(order: WorkOrder): string {
  return sha256Hex(
    canonicalJson({
      objective: order.objective,
      allowedScope: [...order.allowedScope],
      requiredBehaviour: order.requiredBehaviour,
      constraints: [...order.constraints],
      acceptance: [...order.acceptance],
      verification: [...order.verification],
      doNot: [...order.doNot],
      contextRefs: order.contextRefs,
      validation: order.validation ?? null,
      criteria: order.criteria ?? null,
    }),
  );
}

/**
 * 交卷快照哈希。
 *
 * appliedChanges 先按 changeId 升序：回执入库顺序取决于执行者 ack 的先后，
 * 那不是内容的一部分。不排序的话，同一批变更换个 ack 顺序就是另一个摘要。
 */
export function submissionSnapshotHash(input: {
  readonly orderRevision: string;
  readonly contractRevision: number;
  readonly workOrderHash: string;
  readonly appliedChanges: readonly AppliedChangeRef[];
}): string {
  const appliedChanges = [...input.appliedChanges]
    .sort((a, b) => (a.changeId < b.changeId ? -1 : a.changeId > b.changeId ? 1 : 0))
    .map((row) => ({ changeId: row.changeId, contentHash: row.contentHash }));
  return sha256Hex(
    canonicalJson({
      v: 1,
      orderRevision: input.orderRevision,
      contractRevision: input.contractRevision,
      workOrderHash: input.workOrderHash,
      appliedChanges,
    }),
  );
}
