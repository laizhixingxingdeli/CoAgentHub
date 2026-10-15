/**
 * FileActivityLog 的 list 接线 ActivityIndex 前后的合成量化（W-694 / 契约 AC4）。
 *
 * 测的是什么：
 *   1. `FileActivityLog.list(missionId)` 单次耗时（新：ActivityIndex；旧：整表 filter）。
 *   2. 项目内 100 个已排队 Mission 的 `readMissionQueue(ctx, 'P')` 单次耗时（新旧各测）。
 *
 * 为什么不用平台命令一条条造 Mission：50000 次 append 会把绝大部分时间花在跟被扫
 * 对象无关的校验与整份状态落盘上（第 N 次 append 的耗时取决于前面 N-1 次），量出来
 * 的是造数不是读取。这里直接建 Project + 一次播种 events 再 flush 一次。
 *
 * 为什么新旧共用同一个 store，而不是两个 store 各建一份：两个 store 的 refreshIfChanged
 * 会各自 stat 自己的文件，且内存里的事件对象引用不同——那比出来的差异里混着"文件不同"，
 * 不是"索引与 filter"的差异。
 *
 * 为什么要保留旧 list 的 refresh/stat 开销：如果旧替身省掉 refreshIfChanged，比较就变成
 * "带 stat 的新路径 vs 不带 stat 的旧路径"，两者都不真实。所以旧替身原样抄改前的三段。
 *
 * 为什么不加时延断言：这是量化（契约 AC4 明确"建议值，不作硬卡"），进断言就会在慢机器
 * 上偶发变红，而变红说明不了任何行为问题。
 *
 * 用法：node test/helpers/activity-index-benchmark.ts
 * 输出：JSON（Node 版本、规模、每侧样本均值、比率）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileActivityLog, FileProjectRepository, FileStateStore } from '../../src/application/file-store.ts';
import { Project } from '../../src/kernel/index.ts';
import type { ActivityEvent } from '../../src/application/ports.ts';
import { PlatformContext } from '../../src/application/platform/context.ts';
import { readMissionQueue } from '../../src/application/platform/mission-queue.ts';
import { InMemoryDeliveryRepository } from '../../src/application/delivery.ts';
import { FixedClock, SequentialIds } from '../../src/application/in-memory.ts';

const MISSIONS = 100;
const EVENTS_PER_MISSION = 500;
const PROJECT_ID = 'P';
const LIST_ITERATIONS = 200;
const QUEUE_ITERATIONS = 10;
/** 计时之外先跑几轮：第一轮的 JIT 与页缓存会把它变成离群值。 */
const WARMUP_ROUNDS = 5;
const LIST_TARGET = 'M-050';

interface Fixture {
  readonly dir: string;
  readonly store: FileStateStore;
  readonly projects: FileProjectRepository;
  readonly dispose: () => void;
}

/**
 * 旧 list：改前实现的三段（refresh → 归档分支 → filter），原样抄下来当基准。
 *
 * 为什么用子类而不是给生产类加开关：开关是为了测试存在的生产代码；而这里要的是
 * "同一份数据、同一个 store 上再跑一遍改前的写法"。子类能拿到 store，且不碰生产实现。
 */
class LegacyFileActivityLog extends FileActivityLog {
  #legacyStore: FileStateStore;

  constructor(store: FileStateStore, clock: { now: () => Date }) {
    super(store, clock);
    this.#legacyStore = store;
  }

  override async list(missionId: string): Promise<readonly ActivityEvent[]> {
    const store = this.#legacyStore;
    store.refreshIfChanged();
    if (store.hasArchivedMission(missionId)) return store.archivedEvents(missionId);
    return store.raw().events.filter((event) => event.missionId === missionId);
  }
}

function missionId(index: number): string {
  return `M-${String(index).padStart(3, '0')}`;
}

/** 每条 Mission 首个事件是 mission.queued（readMissionQueue 据此入队），其余是 note。 */
function buildEvents(): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (let i = 0; i < MISSIONS; i += 1) {
    const id = missionId(i);
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    events.push({
      at,
      projectId: PROJECT_ID,
      missionId: id,
      kind: 'mission.queued',
      data: { position: i, dependsOn: [] },
    });
    for (let n = 1; n < EVENTS_PER_MISSION; n += 1) {
      events.push({
        at,
        projectId: PROJECT_ID,
        missionId: id,
        kind: 'note',
        data: { n },
      });
    }
  }
  return events;
}

/**
 * 落一份真实 state.json：Project 走仓储保存，events 直接播种（一次 flush）。
 *
 * 「不逐条 append」是必须的：50000 次 append 每次都会触发一次整份状态落盘，造数本身
 * 就是分钟级，而且把量化对象（读取）埋在噪声里。
 */
async function createFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-activity-index-bench-'));
  const statePath = join(dir, 'state.json');
  const store = new FileStateStore(statePath);
  const projects = new FileProjectRepository(store);

  const project = Project.create({ id: PROJECT_ID });
  for (let i = 0; i < MISSIONS; i += 1) {
    project.createMission({
      id: missionId(i),
      contract: {
        intent: `合成 Mission ${i}`,
        acceptance: ['ok'],
        constraints: [],
        nonGoals: [],
        guardrails: [],
      },
      origin: { clientType: 'claude-code', conversationRef: `conv-${i}` },
    });
  }
  await projects.save(project);
  for (const event of buildEvents()) store.raw().events.push(event);
  store.flush();

  return {
    dir,
    store,
    projects,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function meanMs(samples: number[]): number {
  return samples.reduce((sum, row) => sum + row, 0) / samples.length;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

async function measureList(
  log: { list: (missionId: string) => Promise<readonly ActivityEvent[]> },
  iterations: number,
): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    await log.list(LIST_TARGET);
    samples.push(performance.now() - started);
  }
  return meanMs(samples);
}

async function measureQueue(ctx: PlatformContext, iterations: number): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    await readMissionQueue(ctx, PROJECT_ID);
    samples.push(performance.now() - started);
  }
  return meanMs(samples);
}

export async function runActivityIndexBenchmark(): Promise<Record<string, unknown>> {
  const fixture = await createFixture();
  try {
    const clock = new FixedClock('2026-10-15T00:00:00.000Z');
    const ids = new SequentialIds();
    const activity = new FileActivityLog(fixture.store, clock);
    const legacyActivity = new LegacyFileActivityLog(fixture.store, clock);
    const deliveries = new InMemoryDeliveryRepository(clock, ids);
    const ctx = new PlatformContext({ projects: fixture.projects, activity, ids, deliveries, clock });
    const legacyCtx = new PlatformContext({
      projects: fixture.projects,
      activity: legacyActivity,
      ids,
      deliveries,
      clock,
    });

    // 计时之前先确认取向正确：队列必须真的看得见 100 条，新旧结果必须逐字段相同。
    // 不先确认，量出来的可能是"两边都在扫一个空项目"，比得再快也没有意义。
    const newQueue = await readMissionQueue(ctx, PROJECT_ID);
    const legacyQueue = await readMissionQueue(legacyCtx, PROJECT_ID);
    if (newQueue.entries.length !== MISSIONS) {
      throw new Error(`readMissionQueue 只看到 ${newQueue.entries.length} 条，期望 ${MISSIONS}`);
    }
    if (JSON.stringify(newQueue.entries) !== JSON.stringify(legacyQueue.entries)) {
      throw new Error('新旧 readMissionQueue 结果不一致 —— 量化对象不可比');
    }

    // 预热不计入：JIT 与文件页缓存必须在计时之外热起来。
    for (let round = 0; round < WARMUP_ROUNDS; round += 1) {
      await activity.list(LIST_TARGET);
      await legacyActivity.list(LIST_TARGET);
      await readMissionQueue(ctx, PROJECT_ID);
      await readMissionQueue(legacyCtx, PROJECT_ID);
    }

    const newListMs = await measureList(activity, LIST_ITERATIONS);
    const oldListMs = await measureList(legacyActivity, LIST_ITERATIONS);
    const newQueueMs = await measureQueue(ctx, QUEUE_ITERATIONS);
    const oldQueueMs = await measureQueue(legacyCtx, QUEUE_ITERATIONS);

    return {
      node: process.version,
      platform: process.platform,
      fixture: {
        missions: MISSIONS,
        eventsPerMission: EVENTS_PER_MISSION,
        totalEvents: MISSIONS * EVENTS_PER_MISSION,
        queuedMissions: newQueue.entries.length,
      },
      list: {
        missionId: LIST_TARGET,
        iterations: LIST_ITERATIONS,
        newMs: round(newListMs),
        oldMs: round(oldListMs),
        ratioOldOverNew: round(oldListMs / newListMs),
      },
      readMissionQueue: {
        iterations: QUEUE_ITERATIONS,
        newMs: round(newQueueMs),
        oldMs: round(oldQueueMs),
        ratioOldOverNew: round(oldQueueMs / newQueueMs),
      },
      warmupRounds: WARMUP_ROUNDS,
    } satisfies Record<string, unknown>;
  } finally {
    fixture.dispose();
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  /activity-index-benchmark\.ts$/.test(process.argv[1].replace(/\\/g, '/'));

if (invokedDirectly) {
  runActivityIndexBenchmark().then(
    (report) => {
      console.log(JSON.stringify(report, null, 2));
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    },
  );
}
