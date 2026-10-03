/**
 * 方案运行记录的文件存储——升级握手的另一半。
 *
 * **为什么是一份独立文件，而不是主状态文件。** run-plan 跑 Mission 时整夜
 * 握着主状态的单写者锁（和 run-mission 一样）；检视者要写回决定，就得有一个
 * 不需要那把锁的地方。让 run-plan 等决定时让出主锁、再抢回来重载，驱动就要在
 * 「谁手里有活对象」上反复切换——出错的方式是悄悄丢写。这份记录只有几十行，
 * 写的机会屈指可数，给它单独一把**短锁**就够了。
 *
 * 读不加锁：写入是「临时文件 + rename」，读到的永远是某一次完整写出的内容。
 * 写是「拿锁 → 读 → 改 → 写 → 放锁」：读必须在拿锁**之后**，否则拿到的是
 * 别人写之前的版本，写回去就把别人的决定整份盖掉了。
 *
 * 检视者的决定和驱动方的「判过期」可能撞在同一时刻。锁让它们排队，规则
 * （`PlanRun.choose` / `expire` 都拒绝已了结的单子）决定后到的那个被明确拒绝——
 * 不会出现两边各以为自己赢了。
 */

import { readFileSync, renameSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { LockBusyError, acquireLock } from './lock.ts';
import { PlanRun } from './plan-run.ts';
import type { PlanRunSnapshot, PlanRunStop } from './plan-run.ts';
import { PlatformRuleError } from './platform.ts';

/**
 * Windows 上别的进程恰好打开着目标文件（另一边在读、杀毒在扫）时 rename 会
 * 报 EPERM / EBUSY。那是瞬时的，重试即可；当成失败的话，一次偶然的读就能让
 * 夜里的写丢掉。
 */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

function retrySync<T>(action: () => T): T {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return action();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT.has(code) || attempt >= 20) throw error;
      const until = Date.now() + 25;
      while (Date.now() < until) {
        // 同步路径上的短暂退避；只在上面那几种瞬时错误时发生。
      }
    }
  }
}

export class FilePlanRunStore {
  #path: string;
  #lockWaitMs: number;

  constructor(path: string, options?: { lockWaitMs?: number }) {
    this.#path = resolve(path);
    // 锁只在读-改-写的几毫秒里被拿着；等 10 秒还拿不到，多半是有进程死在了锁里。
    this.#lockWaitMs = options?.lockWaitMs ?? 10_000;
  }

  get path(): string {
    return this.#path;
  }

  /** 没有这份记录时给 undefined；有但读不懂时抛（不静默当成没有）。 */
  read(): PlanRun | undefined {
    let text: string;
    try {
      text = retrySync(() => readFileSync(this.#path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new PlatformRuleError(
        'PLAN_RUN_CORRUPT',
        `方案运行记录不是合法 JSON：${this.#path} —— ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return PlanRun.restore(parsed);
  }

  /** 新建。同一路径已有记录就拒绝：覆盖一份在跑的记录等于抹掉整晚的账。 */
  async create(run: PlanRun): Promise<void> {
    await this.#withLock(`建方案运行记录 ${run.id}`, () => {
      if (existsSync(this.#path)) {
        throw new PlatformRuleError(
          'PLAN_RUN_EXISTS',
          `${this.#path} 已经有一份方案运行记录，拒绝覆盖。`,
        );
      }
      this.#write(run);
    });
  }

  /**
   * 拿锁、读最新、改、写回。`mutate` 抛错就什么都不写——被规则拒绝的改动不能
   * 留下半截。
   */
  async update<T>(mutate: (run: PlanRun) => T): Promise<T> {
    return this.#withLock('改方案运行记录', () => {
      const run = this.read();
      if (!run) {
        throw new PlatformRuleError('PLAN_RUN_NOT_FOUND', `没有方案运行记录：${this.#path}`);
      }
      const result = mutate(run);
      this.#write(run);
      return result;
    });
  }

  #write(run: PlanRun): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temp = resolve(dirname(this.#path), `.${basename(this.#path)}.${process.pid}.tmp`);
    writeFileSync(temp, `${JSON.stringify(run.toSnapshot(), null, 2)}\n`, 'utf8');
    retrySync(() => renameSync(temp, this.#path));
  }

  async #withLock<T>(what: string, body: () => T): Promise<T> {
    // 锁目录建在记录文件旁边；记录目录还不存在时（run-plan 第一次跑）mkdir
    // 锁会直接 ENOENT，被当成一次崩溃。
    mkdirSync(dirname(this.#path), { recursive: true });
    const deadline = Date.now() + this.#lockWaitMs;
    for (;;) {
      let release: () => void;
      try {
        release = acquireLock(this.#path, what);
      } catch (error) {
        if (!(error instanceof LockBusyError) || Date.now() >= deadline) throw error;
        await sleep(20);
        continue;
      }
      try {
        return body();
      } finally {
        release();
      }
    }
  }
}

/** 单段安全 id：只能当文件名，不能当路径。否则 `../secret` 会读出目录外的任意文件。 */
export function isSafePlanRunId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

export type PlanRunFeatureSummary = {
  readonly featureId: string;
  readonly title?: string;
  readonly status: string;
  readonly missionIds: readonly string[];
};

export type PlanRunListOk = {
  readonly id: string;
  readonly planId: string;
  readonly projectId: string;
  readonly integrationBranch: string;
  readonly startedAt: string;
  readonly stopped?: PlanRunStop;
  readonly features: readonly PlanRunFeatureSummary[];
  readonly escalationCount: number;
};

export type PlanRunListError = {
  readonly id: string;
  readonly error: string;
};

export type PlanRunListItem = PlanRunListOk | PlanRunListError;

export type PlanRunReadResult =
  | { readonly status: 'ok'; readonly snapshot: PlanRunSnapshot }
  | { readonly status: 'missing' }
  | { readonly status: 'corrupt'; readonly error: string };

function isListError(item: PlanRunListItem): item is PlanRunListError {
  return Object.hasOwn(item, 'error');
}

function planRunFileInDir(dir: string, id: string): string | undefined {
  if (!isSafePlanRunId(id)) return undefined;
  const root = resolve(dir);
  const file = resolve(root, `${id}.json`);
  // resolve 会把 `a/../b` 收掉；收完必须还在这个目录里，否则就是越目录。
  if (dirname(file) !== root) return undefined;
  return file;
}

function uniqueResolvedDirs(dirs: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const root = resolve(dir);
    if (seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out;
}

function listSafeJsonIds(dir: string): string[] {
  let entries: readonly { name: string; isFile(): boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // 目录不存在或不可读：当成没有记录，不能把整份列表打成 500。
    return [];
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);
    if (!isSafePlanRunId(id)) continue;
    if (planRunFileInDir(dir, id) === undefined) continue;
    ids.push(id);
  }
  ids.sort();
  return ids;
}

function publicCorruptMessage(error: unknown, file: string): string {
  if (!(error instanceof PlatformRuleError) || error.code !== 'PLAN_RUN_CORRUPT') {
    return '方案运行记录损坏';
  }
  // read() 的 JSON 错会带绝对路径；restore() 的错没有路径。对外一律不回文件位置。
  if (error.message.includes(file)) return '方案运行记录不是合法 JSON';
  return error.message;
}

function readRunAt(file: string): { readonly run: PlanRun } | { readonly error: string } {
  try {
    const run = new FilePlanRunStore(file).read();
    if (!run) return { error: '方案运行记录不存在' };
    return { run };
  } catch (error) {
    return { error: publicCorruptMessage(error, file) };
  }
}

function summarizeRun(run: PlanRun): PlanRunListOk {
  return {
    id: run.id,
    planId: run.planId,
    projectId: run.projectId,
    integrationBranch: run.integrationBranch,
    startedAt: run.startedAt,
    ...(run.stopped ? { stopped: run.stopped } : {}),
    features: run.features.map((feature) => ({
      featureId: feature.featureId,
      ...(feature.title !== undefined ? { title: feature.title } : {}),
      status: feature.status,
      missionIds: feature.missionIds,
    })),
    escalationCount: run.escalationsOpened,
  };
}

function compareListItems(a: PlanRunListItem, b: PlanRunListItem): number {
  const aBad = isListError(a);
  const bBad = isListError(b);
  if (aBad !== bBad) return aBad ? 1 : -1;
  if (!aBad && !bBad) {
    const byTime = Date.parse(b.startedAt) - Date.parse(a.startedAt);
    if (byTime !== 0) return byTime;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  }
  const left = a as PlanRunListError;
  const right = b as PlanRunListError;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  if (left.error !== right.error) return left.error < right.error ? -1 : 1;
  return 0;
}

/**
 * 按目录枚举方案运行记录。坏文件变成 `{id,error}`，不拖垮其它项。
 * 同 id 先扫到的目录赢；后来的记一条重复错误——后写覆盖会让详情跟列表对不上。
 */
export function listPlanRuns(dirs: readonly string[], project?: string): PlanRunListItem[] {
  const items: PlanRunListItem[] = [];
  const claimed = new Set<string>();
  for (const dir of uniqueResolvedDirs(dirs)) {
    for (const id of listSafeJsonIds(dir)) {
      if (claimed.has(id)) {
        items.push({ id, error: '重复的方案运行记录 id' });
        continue;
      }
      claimed.add(id);
      const file = planRunFileInDir(dir, id);
      if (file === undefined) {
        items.push({ id, error: '方案运行记录路径不安全' });
        continue;
      }
      const read = readRunAt(file);
      if ('error' in read) {
        items.push({ id, error: read.error });
        continue;
      }
      if (read.run.id !== id) {
        items.push({ id, error: '记录 id 与文件名不一致' });
        continue;
      }
      items.push(summarizeRun(read.run));
    }
  }
  const filtered =
    project === undefined
      ? items
      : items.filter((item) => isListError(item) || item.projectId === project);
  return filtered.sort(compareListItems);
}

/**
 * 按安全 id 读一份完整快照。只在给定目录里找 `${id}.json`，找不到就是 missing。
 * 同 id 多目录时与 listPlanRuns 一样：先出现的目录赢。
 */
export function readPlanRunById(dirs: readonly string[], id: string): PlanRunReadResult {
  if (!isSafePlanRunId(id)) return { status: 'missing' };
  for (const dir of uniqueResolvedDirs(dirs)) {
    const file = planRunFileInDir(dir, id);
    if (file === undefined || !existsSync(file)) continue;
    const read = readRunAt(file);
    if ('error' in read) return { status: 'corrupt', error: read.error };
    if (read.run.id !== id) return { status: 'corrupt', error: '记录 id 与文件名不一致' };
    return { status: 'ok', snapshot: read.run.toSnapshot() };
  }
  return { status: 'missing' };
}

/** HTTP 决策与驱动复用同一短锁；拿锁后重新读，并验证文件身份。 */
export async function updatePlanRunById<T>(dirs: readonly string[], id: string, mutate: (run: PlanRun) => T): Promise<T> {
  if (isSafePlanRunId(id)) {
    for (const dir of uniqueResolvedDirs(dirs)) {
      const file = planRunFileInDir(dir, id);
      if (file === undefined || !existsSync(file)) continue;
      return new FilePlanRunStore(file).update((run) => {
        if (run.id !== id) throw new PlatformRuleError('PLAN_RUN_CORRUPT', '记录 id 与文件名不一致');
        return mutate(run);
      });
    }
  }
  throw new PlatformRuleError('PLAN_RUN_NOT_FOUND', '没有方案运行记录');
}
