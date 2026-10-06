/**
 * ContractHistory 仓储：内存版与文件版。
 *
 * 两者都不接生产服务、也不判断契约好坏——只是留下一版契约的原文，供消费方按
 * missionId + contractRevision / missionId 取。语义与 ChangeCoverage 仓储同构：
 * append-only、等值幂等、异内容冲突。差别只在键是 missionId + contractRevision
 * 而不是 changeId + 代次字符串：留的是契约本身，不是变更的行踪。
 */

import {
  ContractHistoryConflictError,
  cloneContractHistory,
  contractHistoriesEqual,
  validateContractHistory,
  type ContractHistoryRecord,
  type ContractHistoryRepository,
} from './contract-history.ts';
import type { FileStateStore } from './file-store.ts';

/**
 * 入库前的一步：同键同内容幂等放行，异内容一律冲突，绝不覆盖。
 *
 * 返回 null = 已有同键同内容、无需写入；否则返回该写入的行。
 */
function resolveAppend(
  rows: readonly ContractHistoryRecord[],
  copy: ContractHistoryRecord,
): ContractHistoryRecord | null {
  for (const row of rows) {
    if (row.missionId !== copy.missionId) continue;
    if (row.contractRevision !== copy.contractRevision) continue;
    if (contractHistoriesEqual(row, copy)) return null;
    throw new ContractHistoryConflictError(copy.missionId, copy.contractRevision);
  }
  return copy;
}

function cloneRows(rows: readonly ContractHistoryRecord[]): readonly ContractHistoryRecord[] {
  return Object.freeze(rows.map(cloneContractHistory));
}

/**
 * 内存实现。
 *
 * append 在任何 await 之前就校验并 clone/freeze：caller 之后改自己的对象
 * 不该影响库里的事实，反过来也不该把 caller 的对象冻住。
 */
export class InMemoryContractHistoryRepository implements ContractHistoryRepository {
  #rows: ContractHistoryRecord[] = [];

  async append(record: ContractHistoryRecord): Promise<void> {
    const copy = validateContractHistory(record);
    const decided = resolveAppend(this.#rows, copy);
    if (decided === null) return;
    this.#rows = [...this.#rows, decided];
  }

  async get(
    missionId: string,
    contractRevision: number,
  ): Promise<ContractHistoryRecord | undefined> {
    const found = this.#rows.find(
      (row) => row.missionId === missionId && row.contractRevision === contractRevision,
    );
    return found ? cloneContractHistory(found) : undefined;
  }

  async listByMission(missionId: string): Promise<readonly ContractHistoryRecord[]> {
    return cloneRows(this.#rows.filter((row) => row.missionId === missionId));
  }
}

/**
 * 文件实现：接收既有 store 实例，沿用 settle/refresh/flush 事务纪律。
 *
 * 不自己 new 第二个 FileStateStore：状态文件是单写者的，多一个实例就多一份
 * 内存副本，彼此互相盖。
 */
export class FileContractHistoryRepository implements ContractHistoryRepository {
  #store: FileStateStore;

  constructor(store: FileStateStore) {
    this.#store = store;
  }

  async append(record: ContractHistoryRecord): Promise<void> {
    const copy = validateContractHistory(record);
    await this.#store.settle();
    this.#store.refreshIfChanged();
    const decided = resolveAppend(this.#rows(), copy);
    if (decided === null) return;
    // 就地 push 到活数组：换一个新数组赋回去就脱离了 File 事务的回滚视野，
    // 同一事务里后面的拒绝会回滚不掉这一条。
    this.#rows().push(decided);
    this.#store.flush();
  }

  async get(
    missionId: string,
    contractRevision: number,
  ): Promise<ContractHistoryRecord | undefined> {
    this.#store.refreshIfChanged();
    const found = this.#rows().find(
      (row) => row.missionId === missionId && row.contractRevision === contractRevision,
    );
    return found ? cloneContractHistory(found) : undefined;
  }

  async listByMission(missionId: string): Promise<readonly ContractHistoryRecord[]> {
    this.#store.refreshIfChanged();
    return cloneRows(this.#rows().filter((row) => row.missionId === missionId));
  }

  /** 旧文件缺这个键：按 [] 读，不 bump StateFile.version。 */
  #rows(): ContractHistoryRecord[] {
    const state = this.#store.raw();
    if (!Array.isArray(state.contractHistories)) state.contractHistories = [];
    return state.contractHistories;
  }
}
