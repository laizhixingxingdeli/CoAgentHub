/**
 * 周期投递修复：调度函数、文件版 tick、PG tick。
 *
 * 不把 Attempt / worktree 收敛改成定时任务；这里只验「按间隔补可核实投递」。
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireLock } from '../src/application/lock.ts';
import {
  FileActivityLog,
  FileDeliveryRepository,
  FileProjectRepository,
  FileStateStore,
  PersistentIds,
} from '../src/application/file-store.ts';
import { SystemClock } from '../src/application/in-memory.ts';
import {
  PgActivityLog,
  PgDeliveryRepository,
  PgIds,
  PgProjectRepository,
  PgStateStore,
  PERIODIC_RECONCILE_LOCK_KEY1,
  PERIODIC_RECONCILE_LOCK_KEY2,
  tryPgAdvisoryLock,
} from '../src/application/pg-store.ts';
import {
  parseReconcileIntervalMs,
  repairMissingDeliveries,
  startPeriodicReconcile,
} from '../src/application/reconcile.ts';
import {
  buildFileDeliveryRepairDeps,
  runFileObserverDeliveryRepairTick,
  runHeldFileDeliveryRepair,
  runPgDeliveryRepairTick,
} from '../src/main.ts';
import { ensureTestDatabase } from './helpers/pg.ts';
import type { MissionContract } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const RESULT = {
  outcome: 'delivered' as const,
  summary: '交付',
  acceptanceEvidence: [] as string[],
  memoryDelta: [] as never[],
  openRisks: [] as string[],
};

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-periodic-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedFileGap(statePath: string, missionId = 'M-gap'): Promise<void> {
  const store = new FileStateStore(statePath);
  const clock = new SystemClock();
  const projects = new FileProjectRepository(store);
  const activity = new FileActivityLog(store, clock);
  const project = await projects.ensure('P');
  const mission = project.createMission({
    id: missionId,
    contract: CONTRACT,
    origin: { clientType: 'test' },
  });
  const attempt = mission.startCoordinatorAttempt();
  mission.recordResult(RESULT);
  mission.submitForReview();
  projects.persist();
  await activity.append({
    projectId: 'P',
    missionId,
    attemptId: attempt.id,
    kind: 'mission_result.submitted',
    data: { outcome: 'delivered' },
  });
}

async function fileDeliveries(statePath: string, missionId: string) {
  const store = new FileStateStore(statePath);
  const deliveries = new FileDeliveryRepository(store, new SystemClock(), new PersistentIds(store));
  return deliveries.listForMission(missionId);
}

describe('parseReconcileIntervalMs', () => {
  test('未设 = 60000；0 关闭；正整数原样', () => {
    assert.equal(parseReconcileIntervalMs(undefined), 60_000);
    assert.equal(parseReconcileIntervalMs('0'), 0);
    assert.equal(parseReconcileIntervalMs('1500'), 1500);
  });

  test('非法值拒绝', () => {
    for (const raw of ['', '-1', '1.5', 'abc', '01', ' 1', '+1']) {
      assert.throws(() => parseReconcileIntervalMs(raw), /COAGENT_RECONCILE_INTERVAL_MS/);
    }
  });
});

describe('startPeriodicReconcile 调度', () => {
  test('按间隔跑；0 不跑', async () => {
    let n = 0;
    const running = startPeriodicReconcile({
      intervalMs: 25,
      tick: async () => {
        n += 1;
      },
      warn: () => {},
    });
    await sleep(80);
    await running.stop();
    assert.ok(n >= 2, `应至少跑两轮，实际 ${n}`);

    let zero = 0;
    const off = startPeriodicReconcile({
      intervalMs: 0,
      tick: async () => {
        zero += 1;
      },
      warn: () => {},
    });
    await sleep(60);
    await off.stop();
    assert.equal(zero, 0);
  });

  test('慢 tick 不重叠', async () => {
    let concurrent = 0;
    let max = 0;
    const handle = startPeriodicReconcile({
      intervalMs: 15,
      tick: async () => {
        concurrent += 1;
        max = Math.max(max, concurrent);
        await sleep(50);
        concurrent -= 1;
      },
      warn: () => {},
    });
    await sleep(140);
    await handle.stop();
    assert.equal(max, 1);
  });

  test('tick 抛错只 warn，下一轮照跑', async () => {
    const warns: string[] = [];
    let n = 0;
    const handle = startPeriodicReconcile({
      intervalMs: 20,
      tick: async () => {
        n += 1;
        if (n === 1) throw new Error('boom');
      },
      warn: (message) => {
        warns.push(message);
      },
    });
    await sleep(70);
    await handle.stop();
    assert.ok(n >= 2, `失败后应继续，实际 ${n}`);
    assert.ok(warns.some((row) => row.includes('boom')));
  });

  test('stop 等待在途 tick，之后不再跑', async () => {
    let inTick = false;
    let finished = false;
    let n = 0;
    const handle = startPeriodicReconcile({
      intervalMs: 20,
      tick: async () => {
        n += 1;
        inTick = true;
        await sleep(50);
        finished = true;
      },
      warn: () => {},
    });
    const deadline = Date.now() + 200;
    while (!inTick && Date.now() < deadline) await sleep(5);
    assert.equal(inTick, true);
    const stopping = handle.stop();
    assert.equal(finished, false);
    await stopping;
    assert.equal(finished, true);
    const after = n;
    await sleep(60);
    assert.equal(n, after);
  });
});

describe('文件版 tick', () => {
  test('锁被别人持有时不写；放锁后下一轮补建', async () => {
    const statePath = tempState();
    await seedFileGap(statePath);
    const release = acquireLock(statePath, '测试占锁');
    const warns: string[] = [];
    try {
      await runFileObserverDeliveryRepairTick(statePath, (message) => warns.push(message));
      assert.ok(warns.some((row) => row.includes('锁忙')));
      assert.equal((await fileDeliveries(statePath, 'M-gap')).length, 0);
    } finally {
      release();
    }
    await runFileObserverDeliveryRepairTick(statePath, () => {});
    assert.equal((await fileDeliveries(statePath, 'M-gap')).length, 1);
  });

  test('run-plan 持锁路径注入 hasArchivedMission：归档视为 skipped', async () => {
    const statePath = tempState();
    await seedFileGap(statePath);
    const store = new FileStateStore(statePath);
    const deps = buildFileDeliveryRepairDeps(store);
    assert.equal(typeof deps.isArchivedMission, 'function');
    assert.equal(deps.isArchivedMission!('no-such'), false);
    const skipped = await repairMissingDeliveries({
      ...deps,
      isArchivedMission: () => true,
    });
    assert.equal(skipped.created.length, 0);
    assert.ok(skipped.skipped.some((row) => row.reason.includes('归档')));
    await runHeldFileDeliveryRepair(store);
    assert.equal((await fileDeliveries(statePath, 'M-gap')).length, 1);
  });
});

describe('PG tick', () => {
  let dsn = '';
  let available = false;

  before(async () => {
    const target = await ensureTestDatabase('c5bper');
    if (!target) return;
    dsn = target;
    const boot = await PgStateStore.open({ connectionString: dsn });
    await boot.close();
    available = true;
  });

  function skipIfNoPg(t: { skip: (reason?: string) => void }): boolean {
    if (!available) {
      t.skip('没有可用的 Postgres —— 文件版仍是默认存储，这组跳过');
      return true;
    }
    return false;
  }

  async function reset(): Promise<void> {
    const store = await PgStateStore.open({ connectionString: dsn });
    try {
      await store.pool.query(
        'TRUNCATE projects, activity, deliveries, id_counters, query_runs, validation_reports',
      );
    } finally {
      await store.close();
    }
  }

  async function seedPgGap(missionId = 'M-gap'): Promise<void> {
    const store = await PgStateStore.open({ connectionString: dsn });
    try {
      const clock = new SystemClock();
      const projects = new PgProjectRepository(store);
      const activity = new PgActivityLog(store, clock);
      const project = await projects.ensure('P');
      const mission = project.createMission({
        id: missionId,
        contract: CONTRACT,
        origin: { clientType: 'test' },
      });
      const attempt = mission.startCoordinatorAttempt();
      mission.recordResult(RESULT);
      mission.submitForReview();
      await projects.persist();
      await activity.append({
        projectId: 'P',
        missionId,
        attemptId: attempt.id,
        kind: 'mission_result.submitted',
        data: { outcome: 'delivered' },
      });
    } finally {
      await store.close();
    }
  }

  async function pgDeliveries(missionId: string) {
    const store = await PgStateStore.open({ connectionString: dsn });
    try {
      return await new PgDeliveryRepository(store, new SystemClock(), new PgIds(store)).listForMission(
        missionId,
      );
    } finally {
      await store.close();
    }
  }

  test('能看见别的进程先前提交的缺口并补建', async (t) => {
    if (skipIfNoPg(t)) return;
    await reset();
    await seedPgGap();
    assert.equal((await pgDeliveries('M-gap')).length, 0);
    await runPgDeliveryRepairTick({ connectionString: dsn, warn: () => {} });
    assert.equal((await pgDeliveries('M-gap')).length, 1);
  });

  test('两个实例竞争时至多一个执行；锁持有者会让另一轮跳过', async (t) => {
    if (skipIfNoPg(t)) return;
    await reset();
    await seedPgGap();
    const holder = await PgStateStore.open({ connectionString: dsn });
    try {
      const lock = await tryPgAdvisoryLock(
        holder.pool,
        PERIODIC_RECONCILE_LOCK_KEY1,
        PERIODIC_RECONCILE_LOCK_KEY2,
      );
      assert.equal(lock.held, true);
      const warns: string[] = [];
      await Promise.all([
        runPgDeliveryRepairTick({
          connectionString: dsn,
          warn: (message) => warns.push(message),
        }),
        runPgDeliveryRepairTick({
          connectionString: dsn,
          warn: (message) => warns.push(message),
        }),
      ]);
      assert.equal(warns.filter((row) => row.includes('互斥')).length, 2);
      assert.equal((await pgDeliveries('M-gap')).length, 0);
      await lock.release();
    } finally {
      await holder.close();
    }
    await runPgDeliveryRepairTick({ connectionString: dsn, warn: () => {} });
    assert.equal((await pgDeliveries('M-gap')).length, 1);
  });

  test('不把别人正在跑的 Attempt 判死；tick 后锁与连接释放', async (t) => {
    if (skipIfNoPg(t)) return;
    await reset();
    const live = await PgStateStore.open({ connectionString: dsn });
    try {
      const projects = new PgProjectRepository(live);
      const project = await projects.ensure('P-live');
      const mission = project.createMission({ id: 'M-live', contract: CONTRACT });
      const attempt = mission.startCoordinatorAttempt();
      await projects.persist();
      assert.equal(attempt.status, 'in_progress');

      await seedPgGap('M-other');
      await runPgDeliveryRepairTick({ connectionString: dsn, warn: () => {} });

      await live.refresh();
      const still = live.projectsMap().get('P-live')?.missions.find((row) => row.id === 'M-live');
      assert.equal(still?.coordinatorAttempts[0]?.status, 'in_progress');

      const leftover = await live.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND classid = $1 AND objid = $2`,
        [PERIODIC_RECONCILE_LOCK_KEY1, PERIODIC_RECONCILE_LOCK_KEY2],
      );
      assert.equal(leftover.rows[0]?.n, 0);
    } finally {
      await live.close();
    }
  });
});
