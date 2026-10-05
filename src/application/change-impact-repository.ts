/**
 * ChangeImpact 仓储：内存版与文件版。
 *
 * 两者都不接生产服务、也不做权限判断——只是把影响判断记下来，供消费方按
 * changeId 取。语义与 ChangeRequest 仓储同构：append-only、等值幂等、异内容冲突。
 */

import {
  ChangeImpactConflictError,
  changeImpactsEqual,
  cloneChangeImpact,
  validateChangeImpact,
  type ChangeImpact,
  type ChangeImpactRepository,
} from './change-impact.ts';
import type { FileStateStore } from './file-store.ts';

/**
 * 内存实现。
 *
 * append 在任何 await 之前就校验并 clone/freeze：caller 之后改自己的对象
 * 不该影响库里的事实，反过来也不该把 caller 的对象冻住。
 */
export class InMemoryChangeImpactRepository implements ChangeImpactRepository {
  #byId = new Map<string, ChangeImpact>();

  async append(impact: ChangeImpact): Promise<void> {
    const copy = validateChangeImpact(impact);
    const existing = this.#byId.get(copy.changeId);
    if (existing) {
      if (changeImpactsEqual(existing, copy)) return;
      throw new ChangeImpactConflictError(copy.changeId);
    }
    this.#byId.set(copy.changeId, copy);
  }

  async get(changeId: string): Promise<ChangeImpact | undefined> {
    const found = this.#byId.get(changeId);
    return found ? cloneChangeImpact(found) : undefined;
  }

  async listByMission(missionId: string): Promise<readonly ChangeImpact[]> {
    const rows: ChangeImpact[] = [];
    for (const row of this.#byId.values()) {
      if (row.missionId !== missionId) continue;
      rows.push(cloneChangeImpact(row));
    }
    return Object.freeze(rows);
  }
}

/**
 * 文件实现：接收既有 store 实例，沿用 settle/refresh/flush 事务纪律。
 *
 * 不自己 new 第二个 FileStateStore：状态文件是单写者的，多一个实例就多一份
 * 内存副本，彼此互相盖。
 */
export class FileChangeImpactRepository implements ChangeImpactRepository {
  #store: FileStateStore;

  constructor(store: FileStateStore) {
    this.#store = store;
  }

  async append(impact: ChangeImpact): Promise<void> {
    const copy = validateChangeImpact(impact);
    await this.#store.settle();
    this.#store.refreshIfChanged();
    const rows = this.#rows();
    const existing = rows.find((row) => row.changeId === copy.changeId);
    if (existing) {
      if (changeImpactsEqual(existing, copy)) return;
      throw new ChangeImpactConflictError(copy.changeId);
    }
    rows.push(copy);
    this.#store.flush();
  }

  async get(changeId: string): Promise<ChangeImpact | undefined> {
    this.#store.refreshIfChanged();
    const found = this.#rows().find((row) => row.changeId === changeId);
    return found ? cloneChangeImpact(found) : undefined;
  }

  async listByMission(missionId: string): Promise<readonly ChangeImpact[]> {
    this.#store.refreshIfChanged();
    const rows = this.#rows()
      .filter((row) => row.missionId === missionId)
      .map(cloneChangeImpact);
    return Object.freeze(rows);
  }

  #rows(): ChangeImpact[] {
    const state = this.#store.raw();
    if (!Array.isArray(state.changeImpacts)) state.changeImpacts = [];
    return state.changeImpacts;
  }
}
