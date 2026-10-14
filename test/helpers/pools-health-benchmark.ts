/**
 * 资源池健康扫描的并发轻请求等待量化（W-687），并在 W-690 补上「缓存命中耗时」。
 *
 * 测的是什么：
 *   1. GET /api/pools（未命中，扫全部 Mission）进行期间，一条轻请求
 *      （GET /api/health）从**发起到读完整份响应**要等多久。
 *   2. 启用 poolsHealthCacheMs 后，warm 一次未命中，再连发几次命中读的耗时。
 *
 * 为什么轻请求必须从扫描内部驱动：等扫描结束再计时发请求，量到的永远是 0 ——
 * 那时候事件循环已经空了。所以计时发起点挂在夹具的 onMissionStart 上（扫描
 * 正在处理第 N 条 Mission），这才是「这条轻请求在扫描期间等了多久」。
 *
 * 为什么要独立连接（agent:false）：统一 keep-alive 池会把并发请求排到一条
 * 连接上，客户端自己先串行化了，量出来的不是服务端的等待。
 *
 * 为什么每轮换新夹具：夹具自带的扫描计数与 hook 是每实例的；同一夹具跑多轮
 * 会让「这一轮扫了多少条」不再干净。数据构建一律在计时之外。
 *
 * 用法：node test/helpers/pools-health-benchmark.ts [轮数]
 * 输出：JSON（Node 版本、数据规模、各轮样本、最长等待）。
 */

import {
  createPoolsHealthFixture,
  httpGetJson,
  POOLS_HEALTH_BENCHMARK_ATTEMPTS_PER_MISSION,
  POOLS_HEALTH_BENCHMARK_MISSIONS,
} from './pools-health-fixture.ts';

/** 每隔这么多条 Mission 发一条已计时的轻请求，覆盖整段扫描而非只在开头。 */
const LIGHT_REQUEST_STRIDE = 10;

/** 命中量化每轮连发多少次缓存命中读。 */
const CACHE_HIT_SAMPLES = 5;

interface LightSample {
  /** 相对本轮扫描起点的发出时刻（ms）。 */
  readonly issuedAtMs: number;
  /** 相对本轮扫描起点的完成时刻（ms）。 */
  readonly resolvedAtMs: number;
  /** 从发起到响应读完的耗时（ms）—— 这就是「一次未命中扫描期间并发轻请求的等待」。 */
  readonly ms: number;
  readonly status: number;
}

interface ScanSample {
  readonly scanMs: number;
  readonly scannedMissions: number;
  readonly lightRequests: number;
  readonly longestLightWaitMs: number;
  readonly longests: readonly LightSample[];
}

async function runSample(missionCount: number, attemptsPerMission: number): Promise<ScanSample> {
  const fixture = await createPoolsHealthFixture({ missions: missionCount, attemptsPerMission });
  try {
    const pending: Array<Promise<LightSample>> = [];
    let scanStart = 0;
    let scanFinished = false;
    fixture.hooks.onMissionStart = (index: number) => {
      if (index % LIGHT_REQUEST_STRIDE !== 0) return;
      const issuedAtMs = performance.now() - scanStart;
      pending.push(
        httpGetJson(`${fixture.base}/api/health`).then((res) => ({
          issuedAtMs,
          resolvedAtMs: performance.now() - scanStart,
          ms: res.ms,
          status: res.status,
        })),
      );
    };
    scanStart = performance.now();
    const scan = await httpGetJson(`${fixture.base}/api/pools`);
    scanFinished = true;
    const scanMs = performance.now() - scanStart;
    const lights = await Promise.all(pending);
    if (scan.status !== 200) throw new Error(`GET /api/pools 返回 ${scan.status}`);
    if (lights.length === 0) throw new Error('没有采到任何轻请求样本');
    // 重叠判据：轻请求的发出时刻必须落在扫描区间内（挂钩子保证了这一点），
    // 并且至少有一条在发起点上「扫描尚未结束」。扫完才发请求的话这里必红。
    if (!lights.some((row) => row.issuedAtMs < scanMs)) {
      throw new Error('没有任何轻请求在扫描进行中发出 —— 计时点错了');
    }
    if (scanFinished !== true) throw new Error('unreachable');
    const sorted = [...lights].sort((a, b) => b.ms - a.ms);
    return {
      scanMs: Number(scanMs.toFixed(1)),
      scannedMissions: fixture.scanned(),
      lightRequests: lights.length,
      longestLightWaitMs: Number((sorted[0]?.ms ?? 0).toFixed(1)),
      longests: sorted.slice(0, 3).map((row) => ({
        issuedAtMs: Number(row.issuedAtMs.toFixed(1)),
        resolvedAtMs: Number(row.resolvedAtMs.toFixed(1)),
        ms: Number(row.ms.toFixed(1)),
        status: row.status,
      })),
    };
  } finally {
    await fixture.close();
  }
}

interface CacheHitSample {
  /** 每个命中样本的耗时（ms）。 */
  readonly hitMs: readonly number[];
  readonly maxHitMs: number;
  /** 命中计时段里 scanned 是否始终不增长（应当为 true）。 */
  readonly scannedStable: boolean;
  /** 命中计时段结束时的扫描计数（应等于一次扫描的规模）。 */
  readonly scannedAfter: number;
  /** 命中返回与未命中响应是否逐字段一致。 */
  readonly bodyEqualsMiss: boolean;
}

/**
 * 量化缓存命中：同一份夹具启用缓存，先 warm 一次未命中扫描，再连发若干次读，
 * 每条都计「从发起到读完整份响应」的耗时；期间 scanned 不得增长。
 */
async function runCacheHitSample(
  missionCount: number,
  attemptsPerMission: number,
  hits: number,
): Promise<CacheHitSample> {
  const fixture = await createPoolsHealthFixture({ missions: missionCount, attemptsPerMission, poolsHealthCacheMs: 60_000 });
  try {
    const miss = await httpGetJson(`${fixture.base}/api/pools`);
    if (miss.status !== 200) throw new Error(`GET /api/pools warm 返回 ${miss.status}`);
    const scannedAtWarm = fixture.scanned();
    const hitMs: number[] = [];
    let scannedStable = true;
    let bodyEqualsMiss = true;
    for (let i = 0; i < hits; i += 1) {
      const hit = await httpGetJson(`${fixture.base}/api/pools`);
      if (hit.status !== 200) throw new Error(`GET /api/pools 命中返回 ${hit.status}`);
      hitMs.push(Number(hit.ms.toFixed(3)));
      if (fixture.scanned() !== scannedAtWarm) scannedStable = false;
      bodyEqualsMiss = bodyEqualsMiss && JSON.stringify(hit.json) === JSON.stringify(miss.json);
    }
    return {
      hitMs,
      maxHitMs: Number(Math.max(...hitMs).toFixed(3)),
      scannedStable,
      scannedAfter: fixture.scanned(),
      bodyEqualsMiss,
    };
  } finally {
    await fixture.close();
  }
}

export async function runPoolsHealthBenchmark(
  rounds = 3,
  missionCount = POOLS_HEALTH_BENCHMARK_MISSIONS,
  attemptsPerMission = POOLS_HEALTH_BENCHMARK_ATTEMPTS_PER_MISSION,
): Promise<Record<string, unknown>> {
  // 预热一轮不计入：第一轮的 JIT / 连接建立会把它变成离群值。
  await runSample(missionCount, attemptsPerMission);
  const samples: ScanSample[] = [];
  for (let round = 0; round < rounds; round += 1) {
    samples.push(await runSample(missionCount, attemptsPerMission));
  }
  const longest = Math.max(...samples.map((sample) => sample.longestLightWaitMs));
  const cacheHit = await runCacheHitSample(missionCount, attemptsPerMission, CACHE_HIT_SAMPLES);
  return {
    node: process.version,
    platform: process.platform,
    fixture: {
      missions: missionCount,
      attemptsPerMission,
      totalAttempts: missionCount * attemptsPerMission,
      candidates: attemptsPerMission + 1,
      lightRequestStride: LIGHT_REQUEST_STRIDE,
    },
    rounds,
    longestLightWaitMs: longest,
    samples,
    cacheHit,
  };
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /pools-health-benchmark\.ts$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  const rounds = Number(process.argv[2] ?? '3');
  runPoolsHealthBenchmark(Number.isFinite(rounds) && rounds > 0 ? rounds : 3).then(
    (report) => {
      console.log(JSON.stringify(report, null, 2));
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    },
  );
}
