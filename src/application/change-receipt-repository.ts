/**
 * ChangeReceipt 仓储：内存版与文件版。
 *
 * 两者都不接生产服务、也不做权限判断——只是记下接收侧承认收到的事实，供消费方
 * 按 changeId / missionId 取。语义与 ChangeImpact 仓储同构：append-only、等值幂等、
 * 异内容冲突。差别只在键是 changeId + layer：同一次变更每层各留一张。
 */

import {
  ChangeReceiptConflictError,
  RECEIPT_LAYERS,
  changeReceiptsEqual,
  cloneChangeReceipt,
  validateChangeReceipt,
  type ChangeReceipt,
  type ChangeReceiptLayer,
  type ChangeReceiptRepository,
  type VerifiedChangeRecord,
} from './change-receipt.ts';
import type { FileStateStore } from './file-store.ts';

/** verified 不是接收侧的一层：它只在记录库里同住，不参与回执语义。 */
function isReceiptLayer(row: { readonly layer: string }): boolean {
  return RECEIPT_LAYERS.includes(row.layer as ChangeReceiptLayer);
}

const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * 校验一份 verified 记录并 frozen 副本。
 *
 * 为什么单写一份校验而不复用 validateChangeReceipt：那边把 layer 限定在三层、把
 * 字段限定在 KNOWN_FIELDS，verified 走它必被拒——而它就该被拒（执行侧写不进来）。
 * 平台侧的入口另写一份，两边互不开后门。
 */
function validateVerifiedRecord(record: VerifiedChangeRecord): VerifiedChangeRecord {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('VerifiedChangeRecord 必须是对象。');
  }
  if (record.layer !== 'verified') throw new Error('VerifiedChangeRecord.layer 必须是 verified。');
  const text: Record<string, string> = {};
  for (const key of ['changeId', 'missionId', 'workItemId', 'attemptId', 'sourceAttemptId', 'reportId', 'at'] as const) {
    // 只查 trim 后非空、不改原文：改 caller 的文本等于篡改事实。
    const value = record[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`VerifiedChangeRecord.${key} 必须是非空字符串。`);
    }
    text[key] = value;
  }
  const claimGeneration = record.claimGeneration;
  if (typeof claimGeneration !== 'number' || !Number.isSafeInteger(claimGeneration) || claimGeneration <= 0) {
    throw new Error('VerifiedChangeRecord.claimGeneration 必须是正整数。');
  }
  const contentHash = record.contentHash;
  if (typeof contentHash !== 'string' || !HASH_RE.test(contentHash)) {
    throw new Error('VerifiedChangeRecord.contentHash 必须是 64 位小写 hex（sha256）。');
  }
  return Object.freeze({
    changeId: text.changeId,
    missionId: text.missionId,
    workItemId: text.workItemId,
    attemptId: text.attemptId,
    claimGeneration,
    layer: 'verified' as const,
    at: text.at,
    contentHash,
    sourceAttemptId: text.sourceAttemptId,
    reportId: text.reportId,
  });
}

const VERIFIED_EQUAL_FIELDS: readonly (keyof VerifiedChangeRecord)[] = [
  'changeId',
  'missionId',
  'workItemId',
  'attemptId',
  'claimGeneration',
  'contentHash',
  'sourceAttemptId',
  'reportId',
];

/** 不比 at：同一事实重放只是记的时刻不同。 */
function verifiedEqual(a: VerifiedChangeRecord, b: VerifiedChangeRecord): boolean {
  return VERIFIED_EQUAL_FIELDS.every((key) => a[key] === b[key]);
}

/**
 * 入库前扫一遍已有的 verified：同内容幂等放行，异内容一律抛，绝不覆盖。
 * 返回 true = 新写。
 */
function resolveVerified(rows: readonly ChangeReceipt[], copy: VerifiedChangeRecord): boolean {
  for (const row of rows) {
    if (row.layer !== 'verified') continue;
    if (row.changeId !== copy.changeId) continue;
    if (verifiedEqual(row as unknown as VerifiedChangeRecord, copy)) return false;
    throw new ChangeReceiptConflictError(copy.changeId, 'verified' as ChangeReceiptLayer);
  }
  return true;
}

/**
 * 同一 changeId 的不同层必须来自同一趟执行。
 *
 * 已有的层与新行的 missionId / workItemId / attemptId / claimGeneration 任一不同，
 * 说明这不是「同一条变更走到下一层」，而是另一次执行的回执误挂在这条变更上——
 * 放行就会让一张回执链串起两趟执行，追溯时对不上是谁跑的。
 */
function crossLayerIdentity(row: ChangeReceipt, copy: ChangeReceipt): boolean {
  return (
    row.missionId === copy.missionId &&
    row.workItemId === copy.workItemId &&
    row.attemptId === copy.attemptId &&
    row.claimGeneration === copy.claimGeneration
  );
}

/**
 * 入库前的一步：同层同内容幂等放行，异内容一律冲突，绝不覆盖。
 *
 * 先扫完同一 changeId 的全部层才决定要不要抛：跨层身份是在「有没有同层」之前就要
 * 判的，遇到第一条对不上就抛，一条身份拧巴的行不会被当成新层收下。
 */
function resolveAppend(
  rows: readonly ChangeReceipt[],
  copy: ChangeReceipt,
): { readonly ok: false } | { readonly ok: true; readonly rows: ChangeReceipt[] } {
  let sameLayer = false;
  for (const row of rows) {
    // verified 行不参与回执的身份比对：它是验收记录，拿它跟接收侧的层比对身份
    // 会让「这次验收」误判成「另一趟执行也写了回执」。
    if (!isReceiptLayer(row)) continue;
    if (row.changeId !== copy.changeId) continue;
    if (!crossLayerIdentity(row, copy)) throw new ChangeReceiptConflictError(copy.changeId, copy.layer);
    if (row.layer !== copy.layer) continue;
    sameLayer = true;
    if (changeReceiptsEqual(row, copy)) return { ok: false };
  }
  if (sameLayer) throw new ChangeReceiptConflictError(copy.changeId, copy.layer);
  return { ok: true, rows: [...rows, copy] };
}

function cloneRows(rows: readonly ChangeReceipt[]): readonly ChangeReceipt[] {
  return Object.freeze(rows.map(cloneChangeReceipt));
}

/**
 * 内存实现。
 *
 * append 在任何 await 之前就校验并 clone/freeze：caller 之后改自己的对象
 * 不该影响库里的事实，反过来也不该把 caller 的对象冻住。
 */
export class InMemoryChangeReceiptRepository implements ChangeReceiptRepository {
  #rows: ChangeReceipt[] = [];

  async append(receipt: ChangeReceipt): Promise<void> {
    const copy = validateChangeReceipt(receipt);
    const decided = resolveAppend(this.#rows, copy);
    if (!decided.ok) return;
    this.#rows = decided.rows;
  }

  async recordVerified(record: VerifiedChangeRecord): Promise<boolean> {
    const copy = validateVerifiedRecord(record);
    // 扫原始数组而不是 list/get：那两个把 verified 滤掉了，看不到已有记录，
    // 于是每次 accept 都会当成新事实重写一遍。
    if (!resolveVerified(this.#rows, copy)) return false;
    this.#rows.push(copy as unknown as ChangeReceipt);
    return true;
  }

  async get(changeId: string, layer: ChangeReceiptLayer): Promise<ChangeReceipt | undefined> {
    const found = this.#rows.find((row) => row.changeId === changeId && row.layer === layer && isReceiptLayer(row));
    return found ? cloneChangeReceipt(found) : undefined;
  }

  async listByChange(changeId: string): Promise<readonly ChangeReceipt[]> {
    return cloneRows(this.#rows.filter((row) => row.changeId === changeId && isReceiptLayer(row)));
  }

  async listByMission(missionId: string): Promise<readonly ChangeReceipt[]> {
    return cloneRows(this.#rows.filter((row) => row.missionId === missionId && isReceiptLayer(row)));
  }
}

/**
 * 文件实现：接收既有 store 实例，沿用 settle/refresh/flush 事务纪律。
 *
 * 不自己 new 第二个 FileStateStore：状态文件是单写者的，多一个实例就多一份
 * 内存副本，彼此互相盖。
 */
export class FileChangeReceiptRepository implements ChangeReceiptRepository {
  #store: FileStateStore;

  constructor(store: FileStateStore) {
    this.#store = store;
  }

  async append(receipt: ChangeReceipt): Promise<void> {
    const copy = validateChangeReceipt(receipt);
    await this.#store.settle();
    this.#store.refreshIfChanged();
    const decided = resolveAppend(this.#rows(), copy);
    if (!decided.ok) return;
    this.#store.raw().changeReceipts = decided.rows;
    this.#store.flush();
  }

  async recordVerified(record: VerifiedChangeRecord): Promise<boolean> {
    const copy = validateVerifiedRecord(record);
    await this.#store.settle();
    this.#store.refreshIfChanged();
    if (!resolveVerified(this.#rows(), copy)) return false;
    // 就地 push 到活数组：换一个新数组赋回去就脱离了 File 事务的回滚视野，
    // 同一事务里后面的拒绝会回滚不掉这一条。
    this.#rows().push(copy as unknown as ChangeReceipt);
    this.#store.flush();
    return true;
  }

  async get(changeId: string, layer: ChangeReceiptLayer): Promise<ChangeReceipt | undefined> {
    this.#store.refreshIfChanged();
    const found = this.#rows().find((row) => row.changeId === changeId && row.layer === layer && isReceiptLayer(row));
    return found ? cloneChangeReceipt(found) : undefined;
  }

  async listByChange(changeId: string): Promise<readonly ChangeReceipt[]> {
    this.#store.refreshIfChanged();
    return cloneRows(this.#rows().filter((row) => row.changeId === changeId && isReceiptLayer(row)));
  }

  async listByMission(missionId: string): Promise<readonly ChangeReceipt[]> {
    this.#store.refreshIfChanged();
    return cloneRows(this.#rows().filter((row) => row.missionId === missionId && isReceiptLayer(row)));
  }

  #rows(): ChangeReceipt[] {
    const state = this.#store.raw();
    if (!Array.isArray(state.changeReceipts)) state.changeReceipts = [];
    return state.changeReceipts;
  }
}
