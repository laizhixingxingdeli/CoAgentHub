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
 *
 * 常驻服务额外写入 instance / API 版本 / 端口，供 CLI 探测「锁空着 /
 * 活着的本机写者 / 占着但不可用」。探测失败只报告 occupied，绝不自愈删锁：
 * 猜错就会变成两个写者同时落盘。
 */

import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';

export interface LockInfo {
  pid: number;
  since: string;
  what: string;
  stateId?: string;
  instanceId?: string;
  apiVersion?: string;
  port?: number;
}

export type LocalWriterProbe =
  | { status: 'empty' }
  | { status: 'live'; holder: LockInfo }
  | { status: 'occupied'; holder?: LockInfo; reason: string };

/** 回环探测超时。太长会卡住 CLI；太短会把慢启动误判成 occupied。 */
const HEALTH_PROBE_TIMEOUT_MS = 800;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function lockBusyMessage(path: string, holder: LockInfo | undefined): string {
  const lines = ['平台正被另一个进程占用；不会自动抢占或删除锁。', `锁目录：${path}`];
  if (holder) {
    lines.push(
      `持有者：pid=${holder.pid}，instanceId=${holder.instanceId ?? '（无）'}，port=${holder.port ?? '（无）'}，since=${holder.since}，what=${holder.what}`,
      `核实进程仍活着（POSIX）：kill -0 ${holder.pid} && echo alive || echo not-alive`,
      `核实进程仍活着（Windows PowerShell）：Get-Process -Id ${holder.pid} -ErrorAction SilentlyContinue`,
    );
  } else {
    lines.push('持有者元数据缺失或损坏，无法确定 PID；请先人工检查锁目录内容及系统中可能运行的平台写者。不要仅凭元数据缺失判断进程已死。');
  }
  lines.push(
    `仅在确认持有者进程已死亡、且无其他写者运行后，手动清理（POSIX）：rm -rf -- ${shellQuote(path)}`,
    `仅在确认持有者进程已死亡、且无其他写者运行后，手动清理（Windows PowerShell）：Remove-Item -LiteralPath ${powershellQuote(path)} -Recurse -Force`,
  );
  return lines.join('\n');
}

export class LockBusyError extends Error {
  readonly holder: LockInfo | undefined;

  constructor(path: string, holder: LockInfo | undefined) {
    super(lockBusyMessage(path, holder));
    this.name = 'LockBusyError';
    this.holder = holder;
  }
}

/**
 * 同一个真实状态文件的稳定身份（含可解析的符号链接）。
 *
 * 锁目录和探测都按这个身份对齐：否则 `state.json` 与指向它的 symlink 会看成
 * 两把锁，两个写者就能同时落盘。
 */
export function stateIdFor(statePath: string): string {
  const abs = resolve(statePath);
  try {
    return realpathSync(abs);
  } catch {
    // 文件可能还没建：规范到已存在的父目录，避免相对路径/中间链接每次不一样。
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

function lockPathFor(statePath: string): string {
  const id = stateIdFor(statePath);
  return join(dirname(id), `.lock-${basename(id)}`);
}

/**
 * 拿到锁就返回一个释放函数；拿不到就抛 LockBusyError。
 *
 * **不自动抢占陈旧的锁**：进程还活着但卡住了，和进程已经死了，从外面看
 * 一模一样。猜错的代价是两个进程一起写——正是这把锁要防的事。宁可让人
 * 看一眼再手动删。
 *
 * 第三参是常驻写者身份。普通 CLI 写者继续 `acquireLock(path, what)` 即可。
 */
export function acquireLock(
  statePath: string,
  what: string,
  identity?: { instanceId: string; apiVersion: string },
): () => void {
  const lockPath = lockPathFor(statePath);
  try {
    mkdirSync(lockPath, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new LockBusyError(lockPath, readHolder(lockPath));
  }

  const info: LockInfo = {
    pid: process.pid,
    since: new Date().toISOString(),
    what,
    stateId: stateIdFor(statePath),
  };
  if (identity) {
    info.instanceId = identity.instanceId;
    info.apiVersion = identity.apiVersion;
  }
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
    // 只清自己持有的锁。发布/释放交错时别人可能已经 mkdir 成功；
    // 误删会让探测短暂看到 empty，下一个写者以为锁空着。
    if (!stillHeldByUs(lockPath, identity?.instanceId)) return;
    rmSync(lockPath, { recursive: true, force: true });
  };

  // 进程正常退出时自动放；被 SIGKILL 时放不掉，那就是要人看一眼的情况。
  process.once('exit', release);
  return release;
}

/**
 * 持有者把实际监听端口写进锁元数据。只允许本进程、本 instanceId。
 *
 * 失败必须抛错（调用方好停下来），并且不能把锁目录删掉再重建——中间窗口
 * 会被 probe 看成 empty，CLI 就会再拉起一个写者。
 */
export function publishLockPort(statePath: string, instanceId: string, port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`发布锁端口失败：端口必须是 1–65535 的整数，收到 ${String(port)}。`);
  }
  if (typeof instanceId !== 'string' || instanceId.length === 0) {
    throw new Error('发布锁端口失败：缺少 instanceId。');
  }
  const lockPath = lockPathFor(statePath);
  const holderPath = join(lockPath, 'holder.json');
  const tmpPath = join(lockPath, 'holder.json.tmp');
  const holder = readHolder(lockPath);
  if (!holder || holder.pid !== process.pid || holder.instanceId !== instanceId) {
    throw new Error(`发布锁端口失败：当前进程不是锁持有者（${lockPath}）。`);
  }
  const next: LockInfo = { ...holder, port };
  try {
    // 不 mkdir：锁目录没了说明已经释放，再建就会伪造一把「非 empty」的锁。
    writeFileSync(tmpPath, JSON.stringify(next, null, 2), 'utf8');
    const still = readHolder(lockPath);
    if (!still || still.pid !== process.pid || still.instanceId !== instanceId) {
      throw new Error(`发布锁端口失败：当前进程不是锁持有者（${lockPath}）。`);
    }
    renameSync(tmpPath, holderPath);
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* 清临时文件失败不影响原错误 */
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`发布锁端口失败：当前进程不是锁持有者（${lockPath}）。`);
    }
    throw error;
  }
}

/**
 * 状态文件身份是否同一真实文件。
 *
 * Windows 上盘符与路径不区分大小写，而 `realpathSync` 又不会改写入时的大小写，
 * CLI 传入 `c:\x`、持锁者记下 `C:\x` 时直比会误判 occupied，调用方就会再拉起一个写者。
 * 非 Windows 上大小写不同就是两个路径，合并会把两个状态文件当成同一个。
 *
 * `windows` 可注入，便于在非 Windows 上锁住这条规则；生产调用走 `process.platform`。
 */
function sameStateIdentity(left: string, right: string, windows: boolean): boolean {
  if (left === right) return true;
  if (!windows) return false;
  return left.toLowerCase() === right.toLowerCase();
}

export type ProbeLocalWriterOptions = {
  /** 测试注入：覆盖是否按 Windows 规则比较状态路径。 */
  treatStateIdAsWindows?: boolean;
};

/**
 * 本机写者探测。empty **仅**锁目录不存在；其余失败一律 occupied，且不删锁。
 */
export async function probeLocalWriter(
  statePath: string,
  options?: ProbeLocalWriterOptions,
): Promise<LocalWriterProbe> {
  const lockPath = lockPathFor(statePath);
  try {
    statSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'empty' };
    return { status: 'occupied', reason: `无法读取锁目录：${(error as Error).message}` };
  }

  const holder = readHolder(lockPath);
  if (!holder) {
    return { status: 'occupied', reason: '锁目录存在但持有者元数据缺失或损坏' };
  }
  if (holder.port === undefined) {
    return { status: 'occupied', holder, reason: '占锁但未发布端口' };
  }
  if (!pidAlive(holder.pid)) {
    return { status: 'occupied', holder, reason: `持有者进程 pid ${holder.pid} 已不在` };
  }

  let health: LoopbackHealth;
  try {
    health = await getLoopbackHealth(holder.port);
  } catch (error) {
    return { status: 'occupied', holder, reason: `连接不可达：${(error as Error).message}` };
  }

  const canonicalStateId = stateIdFor(statePath);
  if (typeof health.api !== 'string' || !holder.apiVersion || health.api !== holder.apiVersion) {
    return { status: 'occupied', holder, reason: 'API 版本不符' };
  }
  if (!holder.instanceId || health.instanceId !== holder.instanceId) {
    return { status: 'occupied', holder, reason: '实例身份不符' };
  }
  const windowsStateId = options?.treatStateIdAsWindows ?? process.platform === 'win32';
  if (
    !holder.stateId ||
    typeof health.stateId !== 'string' ||
    !sameStateIdentity(holder.stateId, health.stateId, windowsStateId) ||
    !sameStateIdentity(health.stateId, canonicalStateId, windowsStateId)
  ) {
    return { status: 'occupied', holder, reason: '状态身份不符' };
  }
  return { status: 'live', holder };
}

function stillHeldByUs(lockPath: string, instanceId: string | undefined): boolean {
  try {
    statSync(lockPath);
  } catch {
    return false;
  }
  const holder = readHolder(lockPath);
  if (!holder) {
    // 我们 mkdir 之后 holder.json 没写上：目录还是自己的残局，该清。
    return true;
  }
  if (holder.pid !== process.pid) return false;
  if (instanceId !== undefined && holder.instanceId !== instanceId) return false;
  return true;
}

function readHolder(lockPath: string): LockInfo | undefined {
  try {
    return parseHolder(readFileSync(join(lockPath, 'holder.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

function parseHolder(raw: string): LockInfo | undefined {
  const value = JSON.parse(raw) as unknown;
  if (typeof value !== 'object' || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.pid !== 'number' || !Number.isInteger(rec.pid)) return undefined;
  if (typeof rec.since !== 'string' || typeof rec.what !== 'string') return undefined;
  const info: LockInfo = { pid: rec.pid, since: rec.since, what: rec.what };
  if (typeof rec.stateId === 'string') info.stateId = rec.stateId;
  if (typeof rec.instanceId === 'string') info.instanceId = rec.instanceId;
  if (typeof rec.apiVersion === 'string') info.apiVersion = rec.apiVersion;
  if (typeof rec.port === 'number' && Number.isInteger(rec.port) && rec.port >= 1 && rec.port <= 65535) {
    info.port = rec.port;
  }
  return info;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程在，只是没权限发信号。当成还活着，避免误报 empty/抢锁。
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface LoopbackHealth {
  api: unknown;
  instanceId: string | undefined;
  stateId: string | undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function getLoopbackHealth(port: number): Promise<LoopbackHealth> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error: Error | undefined, value?: LoopbackHealth) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value as LoopbackHealth);
    };
    const req = httpRequest(
      {
        host: '127.0.0.1',
        family: 4,
        port,
        path: '/api/health',
        method: 'GET',
        timeout: HEALTH_PROBE_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => {
          chunks.push(chunk as Buffer);
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            done(new Error(`health HTTP ${String(res.statusCode)}`));
            return;
          }
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          } catch {
            done(new Error('health 响应不是 JSON'));
            return;
          }
          const api = body && typeof body === 'object' ? (body as { api?: unknown }).api : undefined;
          done(undefined, {
            api,
            instanceId: headerValue(res.headers['x-coagent-instance']),
            stateId: headerValue(res.headers['x-coagent-state-id']),
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      done(new Error('health 探测超时'));
    });
    req.on('error', (error) => done(error));
    req.end();
  });
}
