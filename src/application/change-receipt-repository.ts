/**
 * ChangeReceipt 仓储：内存版与文件版。
 *
 * 两者都不接生产服务、也不做权限判断——只是记下接收侧承认收到的事实，供消费方
 * 按 changeId / missionId 取。语义与 ChangeImpact 仓储同构：append-only、等值幂等、
 * 异内容冲突。差别只在键是 changeId + layer：同一次变更每层各留一张。
 */

import {
  ChangeReceiptConflictError,
  changeReceiptsEqual,
  cloneChangeReceipt,
  validateChangeReceipt,
  type ChangeReceipt,
  type ChangeReceiptLayer,
  type ChangeReceiptRepository,
} from './change-receipt.ts';
import type { FileStateStore } from './file-store.ts';

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

  async get(changeId: string, layer: ChangeReceiptLayer): Promise<ChangeReceipt | undefined> {
    const found = this.#rows.find((row) => row.changeId === changeId && row.layer === layer);
    return found ? cloneChangeReceipt(found) : undefined;
  }

  async listByChange(changeId: string): Promise<readonly ChangeReceipt[]> {
    return cloneRows(this.#rows.filter((row) => row.changeId === changeId));
  }

  async listByMission(missionId: string): Promise<readonly ChangeReceipt[]> {
    return cloneRows(this.#rows.filter((row) => row.missionId === missionId));
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

  async get(changeId: string, layer: ChangeReceiptLayer): Promise<ChangeReceipt | undefined> {
    this.#store.refreshIfChanged();
    const found = this.#rows().find((row) => row.changeId === changeId && row.layer === layer);
    return found ? cloneChangeReceipt(found) : undefined;
  }

  async listByChange(changeId: string): Promise<readonly ChangeReceipt[]> {
    this.#store.refreshIfChanged();
    return cloneRows(this.#rows().filter((row) => row.changeId === changeId));
  }

  async listByMission(missionId: string): Promise<readonly ChangeReceipt[]> {
    this.#store.refreshIfChanged();
    return cloneRows(this.#rows().filter((row) => row.missionId === missionId));
  }

  #rows(): ChangeReceipt[] {
    const state = this.#store.raw();
    if (!Array.isArray(state.changeReceipts)) state.changeReceipts = [];
    return state.changeReceipts;
  }
}
