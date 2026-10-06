/**
 * ChangeCoverage 仓储：内存版与文件版。
 *
 * 两者都不接生产服务、也不做身份判断——只是记下「这次变更已写进第 N 轮工单内容」
 * 的事实，供消费方按 changeId + orderRevision / missionId 取。语义与 ChangeReceipt
 * 仓储同构：append-only、等值幂等、异内容冲突。差别只在键是 changeId +
 * orderRevision 而不是 layer：同一条变更每轮工单各留一张。
 */

import {
  ChangeCoverageConflictError,
  changeCoveragesEqual,
  cloneChangeCoverage,
  validateChangeCoverage,
  type ChangeCoverage,
  type ChangeCoverageRepository,
} from './change-coverage.ts';
import type { FileStateStore } from './file-store.ts';

/**
 * 入库前的一步：同键同内容幂等放行，异内容一律冲突，绝不覆盖。
 *
 * 返回 null = 已有同键同内容、无需写入；否则返回该写入的行。
 */
function resolveAppend(rows: readonly ChangeCoverage[], copy: ChangeCoverage): ChangeCoverage | null {
  for (const row of rows) {
    if (row.changeId !== copy.changeId) continue;
    if (row.orderRevision !== copy.orderRevision) continue;
    if (changeCoveragesEqual(row, copy)) return null;
    throw new ChangeCoverageConflictError(copy.changeId, copy.orderRevision);
  }
  return copy;
}

function cloneRows(rows: readonly ChangeCoverage[]): readonly ChangeCoverage[] {
  return Object.freeze(rows.map(cloneChangeCoverage));
}

/**
 * 内存实现。
 *
 * append 在任何 await 之前就校验并 clone/freeze：caller 之后改自己的对象
 * 不该影响库里的事实，反过来也不该把 caller 的对象冻住。
 */
export class InMemoryChangeCoverageRepository implements ChangeCoverageRepository {
  #rows: ChangeCoverage[] = [];

  async append(record: ChangeCoverage): Promise<void> {
    const copy = validateChangeCoverage(record);
    const decided = resolveAppend(this.#rows, copy);
    if (decided === null) return;
    this.#rows = [...this.#rows, decided];
  }

  async get(changeId: string, orderRevision: string): Promise<ChangeCoverage | undefined> {
    const found = this.#rows.find((row) => row.changeId === changeId && row.orderRevision === orderRevision);
    return found ? cloneChangeCoverage(found) : undefined;
  }

  async listByMission(missionId: string): Promise<readonly ChangeCoverage[]> {
    return cloneRows(this.#rows.filter((row) => row.missionId === missionId));
  }
}

/**
 * 文件实现：接收既有 store 实例，沿用 settle/refresh/flush 事务纪律。
 *
 * 不自己 new 第二个 FileStateStore：状态文件是单写者的，多一个实例就多一份
 * 内存副本，彼此互相盖。
 */
export class FileChangeCoverageRepository implements ChangeCoverageRepository {
  #store: FileStateStore;

  constructor(store: FileStateStore) {
    this.#store = store;
  }

  async append(record: ChangeCoverage): Promise<void> {
    const copy = validateChangeCoverage(record);
    await this.#store.settle();
    this.#store.refreshIfChanged();
    const decided = resolveAppend(this.#rows(), copy);
    if (decided === null) return;
    // 就地 push 到活数组：换一个新数组赋回去就脱离了 File 事务的回滚视野，
    // 同一事务里后面的拒绝会回滚不掉这一条。
    this.#rows().push(decided);
    this.#store.flush();
  }

  async get(changeId: string, orderRevision: string): Promise<ChangeCoverage | undefined> {
    this.#store.refreshIfChanged();
    const found = this.#rows().find((row) => row.changeId === changeId && row.orderRevision === orderRevision);
    return found ? cloneChangeCoverage(found) : undefined;
  }

  async listByMission(missionId: string): Promise<readonly ChangeCoverage[]> {
    this.#store.refreshIfChanged();
    return cloneRows(this.#rows().filter((row) => row.missionId === missionId));
  }

  /** 旧文件缺这个键：按 [] 读，不 bump StateFile.version。 */
  #rows(): ChangeCoverage[] {
    const state = this.#store.raw();
    if (!Array.isArray(state.changeCoverages)) state.changeCoverages = [];
    return state.changeCoverages;
  }
}
