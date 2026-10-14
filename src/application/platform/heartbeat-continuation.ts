/**
 * 心跳窗口续跑（W-685，契约第 3 条 (b) 路）。
 *
 * 服务的锁被 SIGKILL 之外的方式留下时，重启后的进程会接管旧锁；接管审计里
 * 记着旧服务的最后心跳时刻 D。只在「收敛判为 interrupted」那一路（(a) 路）之外
 * 补一条：本进程接管上来的话，D 前后还在活动的托管 Mission 也请求续跑一次。
 *
 * 判据必须是纯函数、宁可漏判：判错会把一条早就自己停了的 Mission（比如撞了
 * maxRounds）重新叫起来花钱，而漏判只是少救一条，下次接管还有机会。
 */

import { readLockAudit } from '../lock.ts';

/** 判定需要的 Mission 摘要切片：只取列表页已有的字段，不为它多读一次。 */
export type HeartbeatContinuationMission = {
  readonly status: string;
  readonly waitReason: string | undefined;
  readonly paused: boolean;
  readonly parked: boolean;
  readonly openEscalations: number;
};

/** 托管启动状态切片：有没有托管启动参数、入没入过队列。 */
export type HeartbeatContinuationHosted = {
  readonly hasRunRequest: boolean;
  readonly queued: boolean;
};

/** 只认这三种「正在推进」的状态；停在这些状态上的 Mission 才有续跑意义。 */
const CONTINUABLE_STATUSES: ReadonlySet<string> = new Set([
  'investigating',
  'planning',
  'executing',
]);

/** 死前多久算「还在动」。早于窗口下界的活动说明它早就自己停下了（如撞 maxRounds）。 */
const WINDOW_BEFORE_MS = 20 * 60 * 1000;
/** 上界给 2 分钟余量：心跳和最后一条活动事件之间可能隔着一次落盘延迟。 */
const WINDOW_AFTER_MS = 2 * 60 * 1000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 一条 Mission 是否属于「旧服务死前还在动」的续跑对象。
 *
 * 任何一项不满足都返回 false：任何已定义的等待原因（含 retry_backoff）都说明
 * 它本来就打算自己接着跑，平台再插一脚会和退避调度抢同一条 Mission。
 */
export function qualifiesForHeartbeatContinuation(
  mission: HeartbeatContinuationMission,
  latestEventAt: string,
  stoppedAt: string,
  hosted: HeartbeatContinuationHosted,
): boolean {
  if (!CONTINUABLE_STATUSES.has(mission.status)) return false;
  if (mission.waitReason !== undefined) return false;
  if (mission.paused || mission.parked) return false;
  if (mission.openEscalations !== 0) return false;
  if (!hosted.hasRunRequest || hosted.queued) return false;
  const stoppedMs = Date.parse(stoppedAt);
  const eventMs = Date.parse(latestEventAt);
  // 缺事件 / 空字符串 / 解析失败一律不当命中：拿默认值兜底会变成「永远在内」。
  if (!Number.isFinite(stoppedMs) || !Number.isFinite(eventMs)) return false;
  return eventMs >= stoppedMs - WINDOW_BEFORE_MS && eventMs <= stoppedMs + WINDOW_AFTER_MS;
}

/**
 * 本进程是不是接管旧锁上来的；是的话给出旧服务最后心跳时刻 D。
 *
 * 干净启动（审计里没有本进程的记录）和无审计文件一样返回 undefined 且不警告：
 * 那是最常见的情况，每次启动都报一句会让真正的异常淹掉。
 */
export function readPreviousServiceHeartbeatAt(
  statePath: string,
  pid: number,
  warn: (message: string) => void,
): string | undefined {
  let records: readonly { newPid: number; oldHeartbeatAt?: string }[];
  try {
    records = readLockAudit(statePath);
  } catch (error) {
    // 审计读不动只是少了 (b) 路，(a) 路照旧，不该让启动挂掉。
    warn(`[启动续跑] 读取接管审计失败，跳过心跳窗口续跑：${messageOf(error)}`);
    return undefined;
  }
  // 追加序里最后一条 newPid 命中才是本进程最近一次接管——中途可能被别的进程插过。
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i]!;
    // === 而不是 ==：字符串数字不是本进程 pid，不能当命中。
    if (record.newPid !== pid) continue;
    const heartbeatAt = record.oldHeartbeatAt;
    if (typeof heartbeatAt !== 'string' || heartbeatAt === '' || !Number.isFinite(Date.parse(heartbeatAt))) {
      warn('[启动续跑] 本进程的接管记录没有可用的 oldHeartbeatAt，跳过心跳窗口续跑');
      return undefined;
    }
    return heartbeatAt;
  }
  return undefined;
}

/** collectHeartbeatContinuationIds 只用到的平台方法，接口收窄以免顺手多调别的。 */
type HeartbeatContinuationPlatform = {
  listMissions(): Promise<
    readonly {
      missionId: string;
      status: string;
      waitReason: string | undefined;
      paused: boolean;
      openEscalations: number;
    }[]
  >;
  getMissionView(missionId: string): Promise<{ parked: boolean }>;
  getActivity(missionId: string): Promise<readonly { at: string }[]>;
  getRunDriver(missionId: string): Promise<{ queued: boolean; request?: unknown }>;
};

/**
 * 按心跳窗口筛出要并入续跑请求的 missionId。
 *
 * 先按列表字段粗筛再逐条读视图 / 活动 / 驱动：粗筛条件都在列表里，能挡掉绝大多数
 * Mission 的三次额外读取。这里只收集不请求，也不写事件——请求那一步归启动收敛，
 * 免得失败路径留下半截事实。
 */
export async function collectHeartbeatContinuationIds(
  platform: HeartbeatContinuationPlatform,
  stoppedAt: string,
  warn: (message: string) => void,
): Promise<string[]> {
  let summaries: Awaited<ReturnType<HeartbeatContinuationPlatform['listMissions']>>;
  try {
    summaries = await platform.listMissions();
  } catch (error) {
    warn(`[启动续跑] 读取 Mission 列表失败，跳过心跳窗口续跑：${messageOf(error)}`);
    return [];
  }
  const ids: string[] = [];
  for (const summary of summaries) {
    if (!CONTINUABLE_STATUSES.has(summary.status)) continue;
    if (summary.waitReason !== undefined) continue;
    if (summary.paused) continue;
    if (summary.openEscalations !== 0) continue;
    try {
      const view = await platform.getMissionView(summary.missionId);
      const events = await platform.getActivity(summary.missionId);
      const driver = await platform.getRunDriver(summary.missionId);
      const latestEventAt = events.length > 0 ? events[events.length - 1]!.at : '';
      const qualified = qualifiesForHeartbeatContinuation(
        {
          status: summary.status,
          waitReason: summary.waitReason,
          paused: summary.paused,
          parked: view.parked,
          openEscalations: summary.openEscalations,
        },
        latestEventAt,
        stoppedAt,
        { hasRunRequest: driver.request !== undefined, queued: driver.queued },
      );
      if (qualified) ids.push(summary.missionId);
    } catch (error) {
      // 单条读失败只跳过它：一条 Mission 的数据坏了不该让整次启动续跑少掉其余条。
      warn(`[启动续跑] ${summary.missionId} 收集心跳窗口续跑信息失败：${messageOf(error)}`);
    }
  }
  return ids;
}
