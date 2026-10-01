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

import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';

export interface LockInfo {
  pid: number;
  since: string;
  what: string;
  /**
   * 最近一次心跳。持锁者活着时应当持续前移；停在一个旧时间上，才谈得上
   * 「这个持有者可能已经卡死」。接管要看的正是这个字段。
   */
  heartbeatAt?: string;
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

/**
 * 主锁心跳周期。
 *
 * 取得够短，接管方才能在合理时间内看出「持有者还在动」；取得够长，不至于
 * 让每次心跳都去写一次盘。测试可注入更短的周期。
 */
const LOCK_HEARTBEAT_INTERVAL_MS = 30_000;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function lockBusyMessage(path: string, holder: LockInfo | undefined, reasons?: readonly string[]): string {
  const lines = ['平台正被另一个进程占用；不会自动抢占或删除锁。', `锁目录：${path}`];
  if (holder) {
    lines.push(
      `持有者：pid=${holder.pid}，instanceId=${holder.instanceId ?? '（无）'}，port=${holder.port ?? '（无）'}，since=${holder.since}，what=${holder.what}`,
      `核实进程仍活着（POSIX）：kill -0 ${holder.pid} && echo alive || echo not-alive`,
      `核实进程仍活着（Windows PowerShell）：Get-Process -Id ${holder.pid} -ErrorAction SilentlyContinue`,
    );
    if (holder.port !== undefined) {
      // 接管只看端口"是否仍在监听"，而这件事在命令行上不容易随口核实：
      // 给两条现成命令，省得人凭印象说"应该没人了吧"。
      lines.push(
        `核实端口无人监听（POSIX）：lsof -nP -iTCP:${holder.port} -sTCP:LISTEN || ss -ltnp | grep ':${holder.port}'`,
        `核实端口无人监听（Windows PowerShell）：Get-NetTCPConnection -LocalPort ${holder.port} -State Listen -ErrorAction SilentlyContinue`,
      );
    }
  } else {
    lines.push('持有者元数据缺失或损坏，无法确定 PID；请先人工检查锁目录内容及系统中可能运行的平台写者。不要仅凭元数据缺失判断进程已死。');
  }
  if (reasons !== undefined && reasons.length > 0) {
    lines.push('拒绝自动接管的原因：');
    for (const reason of reasons) lines.push(`- ${reason}`);
  }
  lines.push(
    `仅在确认持有者进程已死亡、且无其他写者运行后，手动清理（POSIX）：rm -rf -- ${shellQuote(path)}`,
    `仅在确认持有者进程已死亡、且无其他写者运行后，手动清理（Windows PowerShell）：Remove-Item -LiteralPath ${powershellQuote(path)} -Recurse -Force`,
  );
  return lines.join('\n');
}

export class LockBusyError extends Error {
  readonly holder: LockInfo | undefined;
  /**
   * 拒绝自动接管的逐条原因。同步入口（acquireLock）拿不到锁时通常是空的；
   * 异步接管入口要把"为什么不接管"说清楚，否则用的人只能猜。
   */
  readonly reasons: readonly string[];

  constructor(path: string, holder: LockInfo | undefined, reasons?: readonly string[]) {
    super(lockBusyMessage(path, holder, reasons));
    this.name = 'LockBusyError';
    this.holder = holder;
    this.reasons = reasons ?? [];
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

export type LockAcquireOptions = {
  /**
   * 测试注入：心跳周期（毫秒）。<= 0 表示不启动心跳定时器（仍然算持锁，
   * 只是元数据不随时间前移）。
   */
  heartbeatIntervalMs?: number;
};

/**
 * 用 temp + rename 原子换掉持有者元数据。
 *
 * 直接覆写 holder.json 时，读到半截 JSON 的探测方会把它判成「元数据损坏」，
 * 于是报 occupied 并要人手工删锁——一次心跳就能凭空造出一个假故障。
 */
function writeHolderAtomic(lockPath: string, info: LockInfo): void {
  const tmpPath = join(lockPath, `holder.json.${process.pid}.tmp`);
  try {
    writeFileSync(tmpPath, JSON.stringify(info, null, 2), 'utf8');
    renameSync(tmpPath, join(lockPath, 'holder.json'));
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* 清临时文件失败不改变上层错误 */
    }
    throw error;
  }
}

/**
 * 拿到锁就返回一个释放函数；拿不到就抛 LockBusyError。
 *
 * **不自动抢占陈旧的锁**：进程还活着但卡住了，和进程已经死了，从外面看
 * 一模一样。猜错的代价是两个进程一起写——正是这把锁要防的事。宁可让人
 * 看一眼再手动删。
 *
 * 第三参是常驻写者身份。普通 CLI 写者继续 `acquireLock(path, what)` 即可。
 * 第四参只给测试用（注入心跳周期）。
 */
export function acquireLock(
  statePath: string,
  what: string,
  identity?: { instanceId: string; apiVersion: string },
  options?: LockAcquireOptions,
): () => void {
  const lockPath = lockPathFor(statePath);
  try {
    mkdirSync(lockPath, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new LockBusyError(lockPath, readHolder(lockPath));
  }

  const now = new Date().toISOString();
  const info: LockInfo = {
    pid: process.pid,
    since: now,
    what,
    // 拿锁那一刻就算一次心跳：否则「刚拿到的锁」在接管方眼里是一把从没
    // 动过、出生即陈旧的锁。
    heartbeatAt: now,
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

  /**
   * 刷新自己的心跳。
   *
   * 只更新元数据、绝不删锁：写心跳失败可能是磁盘、权限、锁已经被别人接管，
   * 任何一个都不是「可以顺手清掉锁」的理由。
   */
  const refreshHeartbeat = (): void => {
    // 锁目录没了、或者里面的持有者已经不是「我们」，就什么都不做。
    // 锁被释放后又被别人重建时，照着自己的旧快照写回去等于伪造持有者。
    if (!stillHeldByUs(lockPath, identity?.instanceId)) return;
    const current = readHolder(lockPath);
    // 目录在但元数据读不出来：说不清这是谁的锁，宁可不动手。
    if (!current) return;
    try {
      writeHolderAtomic(lockPath, { ...current, heartbeatAt: new Date().toISOString() });
    } catch {
      // 一次心跳写不进去不影响互斥语义，下一拍再试。
    }
  };

  const heartbeatIntervalMs = options?.heartbeatIntervalMs ?? LOCK_HEARTBEAT_INTERVAL_MS;
  const heartbeat =
    heartbeatIntervalMs > 0
      ? setInterval(() => {
          try {
            refreshHeartbeat();
          } catch {
            // 定时器回调里抛出的异常会变成 unhandled 异常直接结束进程，
            // 那就把「一次写心跳失败」升级成「进程带着锁死掉」了。
          }
        }, heartbeatIntervalMs)
      : undefined;
  // unref：心跳不该成为进程退不出去的理由（CLI 干完活要能自然退出）。
  heartbeat?.unref();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    // 先停心跳再删锁。顺序反过来的话，残留的定时器会在一把已经清掉的锁上
    // 继续写：要么在目录被重建后往里塞我们这份旧元数据，要么把一个刚拿到
    // 锁的新持有者刷成「pid 是我们」。
    if (heartbeat !== undefined) clearInterval(heartbeat);
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
    // 两次读之间心跳可能已经把 heartbeatAt 前移了。以重读到的那份为基再写
    // 一次：否则 rename 会把心跳倒退回旧值，接管方就会以为持有者已经停摆。
    if (still.heartbeatAt !== next.heartbeatAt) {
      writeFileSync(tmpPath, JSON.stringify({ ...still, port }, null, 2), 'utf8');
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
  // 旧版本写的锁没有这个字段：缺了就当「没心跳」，由接管逻辑去判断，
  // 不能因此把整把锁判成元数据损坏。
  if (typeof rec.heartbeatAt === 'string') info.heartbeatAt = rec.heartbeatAt;
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

/**
 * 残锁接管的停摆阈值（毫秒）。
 *
 * 心跳 30 秒一跳（W-297），阈值取它的四倍：一次心跳写失败、进程被短暂挂起、
 * 机器刚从休眠醒来，都不该让接管方把仍在推进的写者判成「已停摆」。判错的
 * 方向只有一个——两个写者同时落盘。
 */
const STALE_LOCK_HEARTBEAT_MS = 120_000;

/** 回环端口探测超时。够短以免拖住启动，够长以免把正在慢启动的服务误判成无人监听。 */
const PORT_PROBE_TIMEOUT_MS = 500;

export type RecoverableLockOptions = {
  /** 透传给 acquireLock：心跳周期（毫秒）。 */
  heartbeatIntervalMs?: number;
  /** 测试注入：当前时间（毫秒）。默认 Date.now。 */
  now?: () => number;
  /** 测试注入：进程存活探测。默认 process.kill(pid, 0)，EPERM 算存活。 */
  pidAlive?: (pid: number) => boolean;
  /** 测试注入：端口监听探测。只有返回 false 才算「确定无人监听」；抛错一律算未知。 */
  portListening?: (port: number) => Promise<boolean>;
};

export interface LockTakeoverAuditRecord {
  /** 接管完成的时刻（ISO 8601）。 */
  at: string;
  oldPid: number;
  oldInstanceId?: string;
  oldHeartbeatAt?: string;
  newPid: number;
  newInstanceId?: string;
}

/**
 * 接管审计文件的位置：状态文件旁边，按状态身份稳定。
 *
 * 放状态旁边而不是系统临时目录，是因为它回答的是「这份状态被谁接管过」，
 * 得跟着这份状态一起被备份、迁移和查看。
 */
export function lockAuditPathFor(statePath: string): string {
  const id = stateIdFor(statePath);
  return join(dirname(id), `.lock-audit-${basename(id)}.jsonl`);
}

/** 读回接管审计。没接管过返回空数组；文件在但内容坏了就抛，不假装「没有记录」。 */
export function readLockAudit(statePath: string): LockTakeoverAuditRecord[] {
  let raw: string;
  try {
    raw = readFileSync(lockAuditPathFor(statePath), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LockTakeoverAuditRecord);
}

type StaleLockProbes = {
  now: () => number;
  pidAlive: (pid: number) => boolean;
  portListening: (port: number) => Promise<boolean>;
};

type StaleLockAssessment =
  | { recoverable: true; holder: LockInfo }
  | { recoverable: false; holder: LockInfo | undefined; reasons: string[] };

/**
 * 安全接管入口：无锁时与 acquireLock 完全一致；锁被占着时，只接管
 * 「已死亡 + 已停摆 + 端口无人监听」**三个条件同时成立**的残锁。
 *
 * 为什么不能像同步入口那样一律报忙：常驻服务被 SIGKILL 之后锁留在本机，
 * 每次重启都要人核实一遍再手工删锁（#25）。但为什么不能一律接管：进程
 * 卡住和进程已死从外面看一模一样，只有把三个条件都证实了才敢动手。
 *
 * 任何一步「说不清」都不接管：拿不到解析不了的心跳、EPERM（进程其实是活的，
 * 只是没权限发信号）、端口探测报的不是明确 ECONNREFUSED 都算拒绝理由，
 * 逐条写在 LockBusyError 里，连同人工核实与清理命令一起交给人。
 *
 * 与同步入口共享同一套互斥手段（mkdir + holder.json），所以接管期间
 * 照样严守单写者：候选先拿唯一 takeover guard，再重读旧 holder 重做条件判断，
 * 然后才把旧锁目录 rename 到同目录唯一隔离名，最后用 mkdir 对原锁路径
 * 做原子竞争。别人先拿到锁，我们就什么都不碰。
 */
export async function acquireRecoverableLock(
  statePath: string,
  what: string,
  identity?: { instanceId: string; apiVersion: string },
  options?: RecoverableLockOptions,
): Promise<() => void> {
  try {
    // 无锁的情况不该多走一步：接管路径只在真被占着时才启用。
    return acquireLock(statePath, what, identity, { heartbeatIntervalMs: options?.heartbeatIntervalMs });
  } catch (error) {
    if (!(error instanceof LockBusyError)) throw error;
  }

  const lockPath = lockPathFor(statePath);
  const probes: StaleLockProbes = {
    now: options?.now ?? Date.now,
    pidAlive: options?.pidAlive ?? pidAlive,
    portListening: options?.portListening ?? probePortListening,
  };

  // 唯一名字的 guard：两个候选的名字不同，所以它不是互斥手段本身，
  // 真正的互斥在下面 rename + mkdir 那两步的原子性上。它标记的是
  // 「有人正在这条锁上做接管」，让清理和排障分得清谁留下的目录。
  const guardPath = uniqueSiblingPath(lockPath, 'takeover');
  try {
    mkdirSync(guardPath, { recursive: false });
  } catch (error) {
    throw new LockBusyError(lockPath, readHolder(lockPath), [
      `接管 guard 目录建不起来（${(error as Error).message}），放弃接管。`,
    ]);
  }

  let quarantinePath: string | undefined;
  try {
    const assessed = await assessStaleLock(lockPath, probes);
    if (!assessed.recoverable) {
      throw new LockBusyError(lockPath, assessed.holder, assessed.reasons);
    }

    // guard 只是自己的标记，挡不住别的候选。动手之前重读旧 holder、
    // 重新做一遍条件判断：这之间旧锁可能已经换人，或者已经被人接管。
    const recheck = await assessStaleLock(lockPath, probes);
    if (!recheck.recoverable || !sameHolderIdentity(recheck.holder, assessed.holder)) {
      throw new LockBusyError(lockPath, recheck.holder ?? assessed.holder, [
        '接管 guard 期间锁的状态变了：不再满足接管条件，放弃接管（不覆盖、不删除当前持有者的锁）。',
        ...(recheck.recoverable ? [] : recheck.reasons),
      ]);
    }

    // 先移走旧锁目录，再用 mkdir 在原路径上竞争：这一步决定谁是新持有者。
    // 隔离名同样唯一，所以输的一方绝不会删到赢家的锁目录。
    const quarantine = uniqueSiblingPath(lockPath, 'stale');
    try {
      renameSync(lockPath, quarantine);
    } catch (error) {
      throw new LockBusyError(lockPath, readHolder(lockPath), [
        `把旧锁移进隔离目录失败（${(error as Error).message}），放弃接管。`,
      ]);
    }
    // 从这一刻起隔离目录归本次接管清理。
    quarantinePath = quarantine;

    // 移完之后先看一眼移走的确实是刚才那把残锁。
    //
    // 上面那次重读与 rename 之间还有一个很窄的窗口：另一个候选可能刚完成接管，
    // 把一把**新的、活着的**锁放在原路径上。不查这一步，我们会把别人刚拿到的
    // 锁卷进隔离目录，接着在原路径上 mkdir 成功——两个进程同时以为自己持有锁，
    // 正是这把锁要防的事。查出来不对就原样放回去，绝不当垃圾清掉。
    const moved = readHolder(quarantine);
    if (!sameHolderIdentity(moved, assessed.holder)) {
      // 不管放不放得回去，都不能在 finally 里清掉它：里面可能是别人活着的锁。
      quarantinePath = undefined;
      let restored = false;
      try {
        renameSync(quarantine, lockPath);
        restored = true;
      } catch {
        restored = false;
      }
      throw new LockBusyError(lockPath, moved ?? assessed.holder, [
        restored
          ? '隔离目录里不是刚才证实的那把残锁（另一个候选已经接管），已原样放回，放弃接管。'
          : `隔离目录里不是刚才证实的那把残锁，且放不回去；锁暂存于 ${quarantine}，请人工核实后再恢复。`,
      ]);
    }

    const release = acquireAfterQuarantine(
      statePath,
      lockPath,
      what,
      identity,
      options?.heartbeatIntervalMs,
    );

    // 先确实持有，再留痕。审计是「这次接管发生过」的唯一记录：写不进去就
    // 放掉自己的新锁报错，绝不允许「接管成功但没人知道」。
    try {
      appendTakeoverAudit(statePath, assessed.holder, identity, probes.now());
    } catch (error) {
      release();
      throw new Error(`接管残锁后写审计失败，已释放本次取得的锁：${(error as Error).message}`);
    }
    return release;
  } finally {
    // 隔离目录里装的是已经证实死掉的旧锁，guard 是自己刚建的临时目录：
    // 两条路径都以唯一名字创建，清掉不会碰到任何人的锁。
    rmSync(guardPath, { recursive: true, force: true });
    if (quarantinePath !== undefined) rmSync(quarantinePath, { recursive: true, force: true });
  }
}

/**
 * 同目录下的唯一名字。
 *
 * 必须同目录：rename / mkdir 的原子性只在同一个文件系统上成立。名字里带
 * pid 与随机串，两个候选不会撞到同一个隔离名，也就不会互相删对方的目录。
 */
function uniqueSiblingPath(lockPath: string, tag: string): string {
  const nonce = `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${lockPath}.${tag}-${nonce}`;
}

function sameHolderIdentity(left: LockInfo | undefined, right: LockInfo | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  return (
    left.pid === right.pid &&
    left.since === right.since &&
    left.heartbeatAt === right.heartbeatAt &&
    left.instanceId === right.instanceId
  );
}

/**
 * 依次证实四个条件，得出「这把锁是不是可以安全接管的残锁」。
 *
 * 四条都写进 reasons 而不是遇到第一条就返回：人看报告时要一次看懂
 * 「是进程还活着，还是心跳没停、还是端口还占着」，而不是改一个条件重跑一次。
 */
async function assessStaleLock(lockPath: string, probes: StaleLockProbes): Promise<StaleLockAssessment> {
  const holder = readHolder(lockPath);
  if (!holder) {
    return {
      recoverable: false,
      holder: undefined,
      reasons: ['锁目录存在但持有者元数据缺失或损坏，无法证实旧持有者已死亡。'],
    };
  }

  const reasons: string[] = [];

  const heartbeatMs = holder.heartbeatAt === undefined ? Number.NaN : Date.parse(holder.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) {
    reasons.push(
      `旧持有者 pid=${holder.pid} 没有可解析的 heartbeatAt（旧版本锁或字段缺失），说不清它停摆了多久。`,
    );
  }

  if (probes.pidAlive(holder.pid)) {
    reasons.push(
      `旧持有者进程 pid=${holder.pid} 仍然存活（EPERM 也算存活）；进程卡住和进程已死从外面看一模一样。`,
    );
  }

  if (Number.isFinite(heartbeatMs)) {
    const idleMs = probes.now() - heartbeatMs;
    if (idleMs <= STALE_LOCK_HEARTBEAT_MS) {
      reasons.push(
        `旧持有者 pid=${holder.pid} 的心跳还在阈值内：距今 ${idleMs}ms ≤ ${STALE_LOCK_HEARTBEAT_MS}ms。`,
      );
    }
  }

  if (holder.port === undefined) {
    // 没登记端口：没有常驻服务，也就没有第二个写者能借那个端口落盘。
  } else {
    try {
      if (await probes.portListening(holder.port)) {
        reasons.push(`旧持有者登记的端口 ${holder.port} 仍在监听，可能有另一个写者活着。`);
      }
    } catch (error) {
      // 只有明确的「无人监听」才放行；网络错误、超时、权限问题一律算未知。
      reasons.push(
        `旧持有者登记的端口 ${holder.port} 状态未知（${(error as Error).message}），不能当作无人监听。`,
      );
    }
  }

  if (reasons.length > 0) return { recoverable: false, holder, reasons };
  return { recoverable: true, holder };
}

function acquireAfterQuarantine(
  statePath: string,
  lockPath: string,
  what: string,
  identity: { instanceId: string; apiVersion: string } | undefined,
  heartbeatIntervalMs: number | undefined,
): () => void {
  try {
    return acquireLock(statePath, what, identity, { heartbeatIntervalMs });
  } catch (error) {
    throw new LockBusyError(lockPath, readHolder(lockPath), [
      `隔离旧锁之后锁被其他写者取得（${(error as Error).message}），放弃接管。`,
    ]);
  }
}

function appendTakeoverAudit(
  statePath: string,
  oldHolder: LockInfo,
  identity: { instanceId: string; apiVersion: string } | undefined,
  nowMs: number,
): void {
  const record: LockTakeoverAuditRecord = {
    at: new Date(nowMs).toISOString(),
    oldPid: oldHolder.pid,
    newPid: process.pid,
  };
  if (oldHolder.instanceId !== undefined) record.oldInstanceId = oldHolder.instanceId;
  if (oldHolder.heartbeatAt !== undefined) record.oldHeartbeatAt = oldHolder.heartbeatAt;
  if (identity !== undefined) record.newInstanceId = identity.instanceId;
  // append 而不是重写：审计是流水，接管可能一次接一次，历史不能被后一次抹掉。
  appendFileSync(lockAuditPathFor(statePath), `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * 端口是否有人监听。
 *
 * 只有明确的 ECONNREFUSED 才等于「确定无人监听」。「连不上」和「没人听」是
 * 两回事：超时、EHOSTUNREACH、EPERM 都可能是本机网络栈/防火墙的问题，
 * 把它们当成空闲就会在别人还活着的时候接管锁。
 */
function probePortListening(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = connect({ host: '127.0.0.1', family: 4, port });
    const done = (error?: Error, listening?: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(listening as boolean);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => done(new Error(`连接 127.0.0.1:${port} 超时`)));
    socket.once('connect', () => done(undefined, true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') done(undefined, false);
      else done(error);
    });
  });
}
