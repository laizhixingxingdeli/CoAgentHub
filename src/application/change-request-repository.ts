/**
 * ChangeRequest 仓储：内存版与文件版。
 *
 * 两者都不接生产服务、也不做权限判断——只是把已确认的变更记下来，
 * 供将来的消费者按 changeId 取。
 */

import {
  ChangeRequestConflictError,
  changeRequestsEqual,
  cloneChangeRequest,
  validateChangeRequest,
  type ChangeRequest,
  type ChangeRequestRepository,
  type ChangeRequestTarget,
} from './change-request.ts';
import type { FileStateStore } from './file-store.ts';

/** 目标过滤：给了的条件全部 AND 精确匹配，没给的不参与。 */
function matchesTarget(row: ChangeRequest, target?: ChangeRequestTarget): boolean {
  if (!target) return true;
  if (target.workItemId !== undefined && row.workItemId !== target.workItemId) return false;
  if (target.attemptId !== undefined && row.attemptId !== target.attemptId) return false;
  if (target.claimGeneration !== undefined && row.claimGeneration !== target.claimGeneration) {
    return false;
  }
  return true;
}

/**
 * 内存实现。
 *
 * append 在任何 await 之前就校验并 clone/freeze：caller 之后改自己的对象
 * 不该影响库里的事实，反过来也不该把 caller 的对象冻住。
 */
export class InMemoryChangeRequestRepository implements ChangeRequestRepository {
  #byId = new Map<string, ChangeRequest>();

  async append(request: ChangeRequest): Promise<void> {
    const copy = validateChangeRequest(request);
    const existing = this.#byId.get(copy.changeId);
    if (existing) {
      if (changeRequestsEqual(existing, copy)) return;
      throw new ChangeRequestConflictError(copy.changeId);
    }
    this.#byId.set(copy.changeId, copy);
  }

  async get(changeId: string): Promise<ChangeRequest | undefined> {
    const found = this.#byId.get(changeId);
    return found ? cloneChangeRequest(found) : undefined;
  }

  async listByMission(
    missionId: string,
    target?: ChangeRequestTarget,
  ): Promise<readonly ChangeRequest[]> {
    const rows: ChangeRequest[] = [];
    for (const row of this.#byId.values()) {
      if (row.missionId !== missionId) continue;
      if (!matchesTarget(row, target)) continue;
      rows.push(cloneChangeRequest(row));
    }
    return Object.freeze(rows);
  }
}

/**
 * 文件实现：与 FileValidationReportRepository 同一套纪律。
 *
 * 不自己 new 第二个 FileStateStore：状态文件是单写者的，多一个实例就多一份
 * 内存副本，彼此互相盖。
 */
export class FileChangeRequestRepository implements ChangeRequestRepository {
  #store: FileStateStore;

  constructor(store: FileStateStore) {
    this.#store = store;
  }

  async append(request: ChangeRequest): Promise<void> {
    const copy = validateChangeRequest(request);
    await this.#store.settle();
    this.#store.refreshIfChanged();
    const rows = this.#rows();
    const existing = rows.find((row) => row.changeId === copy.changeId);
    if (existing) {
      if (changeRequestsEqual(existing, copy)) return;
      throw new ChangeRequestConflictError(copy.changeId);
    }
    rows.push(copy);
    this.#store.flush();
  }

  async get(changeId: string): Promise<ChangeRequest | undefined> {
    this.#store.refreshIfChanged();
    const found = this.#rows().find((row) => row.changeId === changeId);
    return found ? cloneChangeRequest(found) : undefined;
  }

  async listByMission(
    missionId: string,
    target?: ChangeRequestTarget,
  ): Promise<readonly ChangeRequest[]> {
    this.#store.refreshIfChanged();
    const rows = this.#rows()
      .filter((row) => row.missionId === missionId && matchesTarget(row, target))
      .map(cloneChangeRequest);
    return Object.freeze(rows);
  }

  #rows(): ChangeRequest[] {
    const state = this.#store.raw();
    if (!Array.isArray(state.changeRequests)) state.changeRequests = [];
    return state.changeRequests;
  }
}
