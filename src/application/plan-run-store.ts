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
 * （`PlanRun.decide` / `expire` 都拒绝已了结的单子）决定后到的那个被明确拒绝——
 * 不会出现两边各以为自己赢了。
 */

import { readFileSync, renameSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { LockBusyError, acquireLock } from './lock.ts';
import { PlanRun } from './plan-run.ts';
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
