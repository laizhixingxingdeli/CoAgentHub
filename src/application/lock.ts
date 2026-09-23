/**
 * 单写者锁。
 *
 * 状态是整份写出去的，两个进程同时写就是"后写的盖掉先写的"，而且**悄无声息**。
 * 真实场景：`run-mission` 跑着一条 Mission 的十分钟里，你在另一个终端
 * `l3.ts merge` 了另一条——两边各持一份内存快照，谁最后落盘谁赢。
 *
 * 解法不是上数据库。写并发在这里根本不该发生：同一时刻只该有一个进程在
 * 推进平台状态。所以做成**排他锁 + 拿不到就明确报错**，而不是想办法让并发
 * 写正确（那需要行级存储、事务、冲突合并，是另一个量级的东西）。
 *
 * 用 `mkdir` 做锁：POSIX 与 Windows 上它都是原子的，不需要额外依赖。
 * 锁目录里写下持有者的 pid 与时间，卡死时看得出来是谁。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface LockInfo {
  pid: number;
  since: string;
  what: string;
}

export class LockBusyError extends Error {
  readonly holder: LockInfo | undefined;

  constructor(path: string, holder: LockInfo | undefined) {
    super(
      holder
        ? `平台正被另一个进程占用（pid ${holder.pid}，自 ${holder.since} 起，${holder.what}）。` +
            `等它结束再操作；确认那个进程已经死了的话，删掉 ${path}。`
        : `平台正被另一个进程占用。等它结束再操作；确认没有别的进程的话，删掉 ${path}。`,
    );
    this.name = 'LockBusyError';
    this.holder = holder;
  }
}

/**
 * 拿到锁就返回一个释放函数；拿不到就抛 LockBusyError。
 *
 * **不自动抢占陈旧的锁**：进程还活着但卡住了，和进程已经死了，从外面看
 * 一模一样。猜错的代价是两个进程一起写——正是这把锁要防的事。宁可让人
 * 看一眼再手动删。
 */
export function acquireLock(statePath: string, what: string): () => void {
  const lockPath = resolve(dirname(resolve(statePath)), `${'.lock-'}${basenameOf(statePath)}`);
  try {
    mkdirSync(lockPath, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new LockBusyError(lockPath, readHolder(lockPath));
  }

  const info: LockInfo = { pid: process.pid, since: new Date().toISOString(), what };
  try {
    writeFileSync(join(lockPath, 'holder.json'), JSON.stringify(info, null, 2), 'utf8');
  } catch {
    // 写不进持有者信息不影响互斥，只是卡死时少一条线索。
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    // 放锁时把下面那个 exit 兜底一起摘掉。不摘的话，常驻进程每拿一次锁就在
    // process 上多挂一个监听——方案运行记录一晚上要拿几十次，过了 10 个 Node
    // 就开始报泄漏告警，而且这些闭包到进程退出才释放。
    process.removeListener('exit', release);
    rmSync(lockPath, { recursive: true, force: true });
  };

  // 进程正常退出时自动放；被 SIGKILL 时放不掉，那就是要人看一眼的情况。
  process.once('exit', release);
  return release;
}

function readHolder(lockPath: string): LockInfo | undefined {
  try {
    return JSON.parse(readFileSync(join(lockPath, 'holder.json'), 'utf8')) as LockInfo;
  } catch {
    return undefined;
  }
}

function basenameOf(path: string): string {
  return resolve(path).split(/[\\/]/).pop() ?? 'state';
}
