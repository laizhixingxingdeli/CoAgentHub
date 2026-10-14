/**
 * 资源池健康投影（GET /api/pools）的合成夹具：纯内存数据 + 真实 createApi / 回环 HTTP。
 *
 * 为什么要这一份而不是用真实 Platform 播种：这份夹具要给「上百 Mission × 每条十来个
 * attempt」的量化用，用平台命令一条条建（createMission / start*Attempt / finishAttempt）
 * 会把绝大部分时间花在跟被扫对象无关的生命周期校验上。健康投影只消费
 * listMissions / getMissionView / getActivity / getAttemptDetail 四个只读方法的返回
 * 结构，所以夹具按那份公共结构直接给数据 —— 被计时的那件事就只剩扫描本身。
 *
 * 为什么夹具内建一个可点的读失败 Mission：扫描对读失败的 Mission 走 continue 路径，
 * 「处理完每条 Mission 让出事件循环」如果只挂在成功路径上，夹具里没有失败 Mission
 * 就永远看不出来。所以失败下标是一等参数，不是后加的补丁。
 *
 * 为什么固定 now 且注入 getRuntimeUsage:async()=>[]：扫描窗口（七日）与用量行都必须
 * 是确定的；缺省的 getRuntimeUsage 会去敲真实适配层（几十秒），那既不是被测的东西，
 * 也会让量化结果变成「等适配层」而不是「等扫描」。
 */

import { get as httpGet } from 'node:http';
import type { Server } from 'node:http';

import { createApi } from '../../src/api/server.ts';
import { RunTokenRegistry } from '../../src/api/run-tokens.ts';
import type { Platform } from '../../src/application/platform.ts';
import type { ControlPrincipalResolver } from '../../src/api/control-auth.ts';
import { InMemoryAgentPoolRepository } from '../../src/application/agent-pool.ts';
import { InMemoryDeliveryRepository } from '../../src/application/delivery.ts';
import { FixedClock, SequentialIds } from '../../src/application/in-memory.ts';
import { listenLoopback } from '../../src/application/loopback-listen.ts';
import type { ActivityEvent, CandidateCircuitRepository } from '../../src/application/ports.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** 量化的规模下限：至少 100 条 Mission、每条至少 10 个 attempt。 */
export const POOLS_HEALTH_BENCHMARK_MISSIONS = 100;
export const POOLS_HEALTH_BENCHMARK_ATTEMPTS_PER_MISSION = 10;

export const POOLS_HEALTH_FIXTURE_NOW_ISO = '2026-01-15T00:00:00.000Z';

/** 只用于「七日窗口外的失败」那条 attempt 的候选：它的 hints 该出现，用量该为 0。 */
export const POOLS_HEALTH_OLD_PROFILE_ID = 'exec-old';

/** 能被 classifyCandidateFailure 认成 quota 的话 —— hints 断言就靠它。 */
const QUOTA_FAILURE_MESSAGE = 'HTTP 429 quota exceeded';

const SUCCESS_USAGE = Object.freeze({
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  total: 15,
  cost: 0.25,
  quality: 'reported' as const,
});

/** 失败 attempt 的用量刻意不带 cost / quality=unknown：用量口径要能被断言成「不计」。 */
const FAILED_USAGE = Object.freeze({
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  total: 15,
  quality: 'unknown' as const,
});

export interface PoolsHealthFixtureHooks {
  /**
   * 每条 Mission 开始处理时同步回调（**含读失败的那条，在它抛错之前**）。
   * 量化与让出事件循环的测试靠它在扫描进行中安排已计时的并发轻请求或宏任务。
   */
  onMissionStart?: (index: number, missionId: string) => void;
}

export interface PoolsHealthFixtureOptions {
  /** Mission 条数。缺省 100（量化规模）。 */
  readonly missions?: number;
  /** 每条 Mission 的 attempt 数。缺省 10。 */
  readonly attemptsPerMission?: number;
  readonly nowIso?: string;
  /** 这些下标的 Mission 在 getMissionView 抛错，走扫描的 continue 路径。 */
  readonly failingMissionIndexes?: readonly number[];
  /**
   * 在这条下标的 Mission 上额外挂一个七日窗口**外**的失败 attempt：
   * hints 不过窗、用量过窗，两条口径都得保持不变。缺省 1。
   */
  readonly windowOutsideFailureMissionIndex?: number;
  /**
   * 扫描顺序写进这个数组（形如 'mission:3'）。
   * 测试想把 hook 自己的标记与 Mission 顺序夹在同一个数组里做先后断言时必须传进来。
   */
  readonly order?: string[];
  readonly hooks?: PoolsHealthFixtureHooks;
  /** 池健康最终响应缓存时长。缺省 0（不缓存）。后单的缓存断言传正数。 */
  readonly poolsHealthCacheMs?: number;
  /** 控制面身份 resolver。注入后 GET /api/pools 会逐请求鉴权。 */
  readonly resolveControlPrincipal?: ControlPrincipalResolver;
  /** 候选熔断仓储。注入后 GET /api/pools 会带 circuit 事实。 */
  readonly candidateCircuits?: CandidateCircuitRepository;
}

export interface PoolsHealthFixture {
  readonly base: string;
  readonly missions: number;
  readonly attemptsPerMission: number;
  /** 扫描按 Mission 记的顺序；hook 往同一个数组里追加它自己的标记。 */
  readonly order: string[];
  /** getMissionView 被调用过多少次（后单的 single-flight 断言用）。 */
  readonly scanned: () => number;
  /** 可写：量化/测试按轮次换 hook 时改这里，不必重建夹具。 */
  readonly hooks: PoolsHealthFixtureHooks;
  /**
   * 让**下一次**扫描在处理到这条下标的 Mission 时挂起，直到 release()。
   * 后单要确定性地把两个并发扫描叠在一起时用它；不调用则零开销。
   */
  readonly holdAt: (index: number) => void;
  readonly release: () => void;
  /** 缓存 TTL 与「完成计时」需要拨动夹具时钟；只拨服务看的那只，不动数据时间戳。 */
  readonly setNow: (ms: number) => void;
  /** 候选举例：测试要可控地让**下一次扫描**从顶层拒绝（如 agentPool.list 抛错）。 */
  readonly pool: InMemoryAgentPoolRepository;
  readonly close: () => Promise<void>;
}

interface AttemptDetailStub {
  readonly attemptId: string;
  readonly status: 'succeeded' | 'failed';
  readonly profile: { readonly profileId: string; readonly endpoint: string };
  readonly usage: Record<string, unknown>;
}

interface MissionStub {
  readonly missionId: string;
  readonly projectId: string;
  readonly attemptIds: readonly string[];
  readonly events: readonly ActivityEvent[];
  readonly details: ReadonlyMap<string, AttemptDetailStub>;
  readonly readFails: boolean;
}

/**
 * 每条 Mission：偶数下标 attempt 成功且报了 cost，奇数下标失败（429）。
 * 候选按 attempt 下标一一对应（exec-0..exec-N-1），于是「某候选的七日用量」
 * 就是「可读 Mission 数 × 该下标是否偶数」——断言可以写成确定的小整数。
 */
function buildMissions(
  missionCount: number,
  attemptsPerMission: number,
  nowMs: number,
  failing: ReadonlySet<number>,
  windowOutsideFailureMissionIndex: number,
): MissionStub[] {
  const rows: MissionStub[] = [];
  for (let m = 0; m < missionCount; m += 1) {
    const missionId = `M-${String(m).padStart(3, '0')}`;
    const projectId = 'P';
    const attemptIds: string[] = [];
    const events: ActivityEvent[] = [];
    const details = new Map<string, AttemptDetailStub>();
    for (let i = 0; i < attemptsPerMission; i += 1) {
      const attemptId = `att-${m}-${i}`;
      const profileId = `exec-${i}`;
      const succeeded = i % 2 === 0;
      // 全部落在窗口内：一条 Mission 一个起始时刻，attempt 之间差一分钟。
      const at = new Date(nowMs - 2 * DAY_MS + m * HOUR_MS + i * 60_000).toISOString();
      attemptIds.push(attemptId);
      events.push({ at, projectId, missionId, kind: 'attempt.started', attemptId, data: {} });
      events.push({
        at,
        projectId,
        missionId,
        kind: 'attempt.ended',
        attemptId,
        data: succeeded
          ? { endedBy: 'structured_submit' }
          : { endedBy: 'upstream_failure', failureMessage: QUOTA_FAILURE_MESSAGE },
      });
      details.set(attemptId, {
        attemptId,
        status: succeeded ? 'succeeded' : 'failed',
        profile: { profileId, endpoint: 'local' },
        usage: succeeded ? SUCCESS_USAGE : FAILED_USAGE,
      });
    }
    if (m === windowOutsideFailureMissionIndex) {
      const attemptId = `att-${m}-old`;
      const at = new Date(nowMs - 8 * DAY_MS).toISOString();
      attemptIds.push(attemptId);
      events.push({ at, projectId, missionId, kind: 'attempt.started', attemptId, data: {} });
      events.push({
        at,
        projectId,
        missionId,
        kind: 'attempt.ended',
        attemptId,
        data: { endedBy: 'upstream_failure', failureMessage: QUOTA_FAILURE_MESSAGE },
      });
      details.set(attemptId, {
        attemptId,
        status: 'failed',
        profile: { profileId: POOLS_HEALTH_OLD_PROFILE_ID, endpoint: 'local' },
        usage: FAILED_USAGE,
      });
    }
    rows.push({ missionId, projectId, attemptIds, events, details, readFails: failing.has(m) });
  }
  return rows;
}

/**
 * 建夹具。数据在返回之前就建好（计时之外），返回后即可直接发 HTTP。
 */
export async function createPoolsHealthFixture(
  options: PoolsHealthFixtureOptions = {},
): Promise<PoolsHealthFixture> {
  const missionCount = options.missions ?? POOLS_HEALTH_BENCHMARK_MISSIONS;
  const attemptsPerMission = options.attemptsPerMission ?? POOLS_HEALTH_BENCHMARK_ATTEMPTS_PER_MISSION;
  const nowMs = Date.parse(options.nowIso ?? POOLS_HEALTH_FIXTURE_NOW_ISO);
  const failing = new Set(options.failingMissionIndexes ?? []);
  const windowOutsideFailureMissionIndex = options.windowOutsideFailureMissionIndex ?? 1;
  const order = options.order ?? [];
  const hooks: PoolsHealthFixtureHooks = options.hooks ?? {};

  const missions = buildMissions(
    missionCount,
    attemptsPerMission,
    nowMs,
    failing,
    windowOutsideFailureMissionIndex,
  );
  const byId = new Map(missions.map((mission) => [mission.missionId, mission]));

  const pool = new InMemoryAgentPoolRepository();
  for (let i = 0; i < attemptsPerMission; i += 1) {
    await pool.add({ role: 'executor', profileId: `exec-${i}`, endpoint: 'local' });
  }
  await pool.add({ role: 'executor', profileId: POOLS_HEALTH_OLD_PROFILE_ID, endpoint: 'local' });

  // 缓存 TTL 要能拨：服务看的是这一只，Mission 数据的时间戳用的仍是固定的 nowMs。
  let currentNow = nowMs;

  let scanned = 0;
  let holdIndex: number | undefined;
  let holdReleased = false;
  const holdWaiters: Array<() => void> = [];

  async function waitIfHeld(index: number): Promise<void> {
    if (holdIndex !== index || holdReleased) return;
    holdIndex = undefined;
    await new Promise<void>((resume) => {
      holdWaiters.push(resume);
    });
  }

  // 只读替身：形状按 server.ts 实际消费的那几个字段给，不多给也不导出生产内部函数。
  const platformStub = {
    async listMissions() {
      return missions.map((mission) => ({ missionId: mission.missionId, projectId: mission.projectId }));
    },
    async getMissionView(missionId: string) {
      const mission = byId.get(missionId);
      if (!mission) throw new Error(`fixture: 没有这条 Mission：${missionId}`);
      const index = missions.indexOf(mission);
      scanned += 1;
      order.push(`mission:${index}`);
      hooks.onMissionStart?.(index, missionId);
      await waitIfHeld(index);
      if (mission.readFails) throw new Error(`fixture: 读 Mission 失败：${missionId}`);
      return { missionId, projectId: mission.projectId, coordinatorAttemptIds: [...mission.attemptIds] };
    },
    async getActivity(missionId: string) {
      const mission = byId.get(missionId);
      if (!mission) throw new Error(`fixture: 没有这条 Mission：${missionId}`);
      // 读失败的那条连活动也不给：扫描的 catch 覆盖这两个调用，夹具要让两条都断开。
      if (mission.readFails) throw new Error(`fixture: 读 Mission 活动失败：${missionId}`);
      return mission.events;
    },
    async getAttemptDetail(missionId: string, attemptId: string) {
      const mission = byId.get(missionId);
      const detail = mission?.details.get(attemptId);
      if (!detail) throw new Error(`fixture: 没有这个 attempt：${missionId}/${attemptId}`);
      return detail;
    },
  };

  const server = createApi({
    platform: platformStub as unknown as Platform,
    tokens: new RunTokenRegistry(),
    deliveries: new InMemoryDeliveryRepository(new FixedClock(options.nowIso ?? POOLS_HEALTH_FIXTURE_NOW_ISO), new SequentialIds()),
    agentPool: pool,
    // 用量行注入空数组：缺省会去敲真实适配层，量化就会变成「等适配层」。
    getRuntimeUsage: async () => [],
    now: () => currentNow,
    ...(options.poolsHealthCacheMs === undefined ? {} : { poolsHealthCacheMs: options.poolsHealthCacheMs }),
    ...(options.resolveControlPrincipal === undefined ? {} : { resolveControlPrincipal: options.resolveControlPrincipal }),
    ...(options.candidateCircuits === undefined ? {} : { candidateCircuits: options.candidateCircuits }),
  });
  const port = await listenLoopback(server, 0);

  return {
    base: `http://127.0.0.1:${port}`,
    missions: missionCount,
    attemptsPerMission,
    order,
    scanned: () => scanned,
    hooks,
    holdAt: (index: number) => {
      holdIndex = index;
      holdReleased = false;
    },
    release: () => {
      holdReleased = true;
      while (holdWaiters.length > 0) holdWaiters.shift()?.();
    },
    setNow: (ms: number) => {
      currentNow = ms;
    },
    pool,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((closed) => {
        (server as Server).close(() => closed());
      });
    },
  };
}

/**
 * 走真实回环 HTTP 取一条 JSON，返回「从发起到读完整份响应」的耗时。
 *
 * agent:false —— 每个请求一条独立连接。共用 keep-alive 连接会把并发请求退化成
 * 串行，量出来的就不是「轻请求在扫描期间的等待」了。
 */
export async function httpGetJson(url: string): Promise<{ status: number; json: unknown; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = httpGet(url, { agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const ms = performance.now() - started;
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')), ms });
        } catch (error) {
          reject(new Error(`响应不是 JSON：${String(error)}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}
