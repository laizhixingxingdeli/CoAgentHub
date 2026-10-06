/**
 * AcceptanceDisposition 仓储：内存版与文件版。
 *
 * 与 ContractHistory 仓储同构（append-only、等值幂等、异内容冲突），差别只在键：
 * 处置按 dispositionId 全局成键，不按 mission 分组——一张处置就是一次独立判断，
 * 不该因为同一 Mission 里补记了别的判断而互相顶掉。
 */

import {
  AcceptanceDispositionConflictError,
  acceptanceDispositionsEqual,
  cloneAcceptanceDisposition,
  validateAcceptanceDisposition,
  type AcceptanceDispositionRecord,
  type AcceptanceDispositionRepository,
} from './acceptance-disposition.ts';
import type { FileStateStore } from './file-store.ts';

/**
 * 入库前的一步：同键同内容幂等放行，异内容一律冲突，绝不覆盖。
 *
 * 返回 null = 已有同键同内容、无需写入；否则返回该写入的行。
 */
function resolveAppend(
  rows: readonly AcceptanceDispositionRecord[],
  copy: AcceptanceDispositionRecord,
): AcceptanceDispositionRecord | null {
  for (const row of rows) {
    if (row.dispositionId !== copy.dispositionId) continue;
    if (acceptanceDispositionsEqual(row, copy)) return null;
    throw new AcceptanceDispositionConflictError(copy.dispositionId);
  }
  return copy;
}

function cloneRows(
  rows: readonly AcceptanceDispositionRecord[],
): readonly AcceptanceDispositionRecord[] {
  return Object.freeze(rows.map(cloneAcceptanceDisposition));
}

/**
 * 内存实现。
 *
 * append 在任何 await 之前就校验并 clone/freeze：caller 之后改自己的对象
 * 不该影响库里的事实，反过来也不该把 caller 的对象冻住。
 */
export class InMemoryAcceptanceDispositionRepository implements AcceptanceDispositionRepository {
  #rows: AcceptanceDispositionRecord[] = [];

  async append(record: AcceptanceDispositionRecord): Promise<void> {
    const copy = validateAcceptanceDisposition(record);
    const decided = resolveAppend(this.#rows, copy);
    if (decided === null) return;
    this.#rows = [...this.#rows, decided];
  }

  async get(dispositionId: string): Promise<AcceptanceDispositionRecord | undefined> {
    const found = this.#rows.find((row) => row.dispositionId === dispositionId);
    return found ? cloneAcceptanceDisposition(found) : undefined;
  }

  async listByMission(missionId: string): Promise<readonly AcceptanceDispositionRecord[]> {
    return cloneRows(this.#rows.filter((row) => row.missionId === missionId));
  }
}

/**
 * 文件实现：接收既有 store 实例，沿用 settle/refresh/flush 事务纪律。
 *
 * 不自己 new 第二个 FileStateStore：状态文件是单写者的，多一个实例就多一份
 * 内存副本，彼此互相盖。
 */
export class FileAcceptanceDispositionRepository implements AcceptanceDispositionRepository {
  #store: FileStateStore;

  constructor(store: FileStateStore) {
    this.#store = store;
  }

  async append(record: AcceptanceDispositionRecord): Promise<void> {
    const copy = validateAcceptanceDisposition(record);
    await this.#store.settle();
    this.#store.refreshIfChanged();
    const decided = resolveAppend(this.#rows(), copy);
    if (decided === null) return;
    // 就地 push 到活数组：换一个新数组赋回去就脱离了 File 事务的回滚视野，
    // 同一事务里后面的拒绝会回滚不掉这一条。
    this.#rows().push(decided);
    this.#store.flush();
  }

  async get(dispositionId: string): Promise<AcceptanceDispositionRecord | undefined> {
    this.#store.refreshIfChanged();
    const found = this.#rows().find((row) => row.dispositionId === dispositionId);
    return found ? cloneAcceptanceDisposition(found) : undefined;
  }

  async listByMission(missionId: string): Promise<readonly AcceptanceDispositionRecord[]> {
    this.#store.refreshIfChanged();
    return cloneRows(this.#rows().filter((row) => row.missionId === missionId));
  }

  /** 旧文件缺这个键：按 [] 读，不 bump StateFile.version。 */
  #rows(): AcceptanceDispositionRecord[] {
    const state = this.#store.raw();
    if (!Array.isArray(state.acceptanceDispositions)) state.acceptanceDispositions = [];
    return state.acceptanceDispositions;
  }
}
