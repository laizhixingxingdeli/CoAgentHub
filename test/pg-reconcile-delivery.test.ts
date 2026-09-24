/**
 * C5a：真 PG 缺失投递补建。
 *
 * 独立库 coagenthub_v5_test_c5a_repair；TRUNCATE 只打这个库。
 * 没有 Postgres 时整组跳过。
 */

import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { FixedClock } from '../src/application/in-memory.ts';
import {
  PgActivityLog,
  PgDeliveryRepository,
  PgIds,
  PgProjectRepository,
  PgStateStore,
} from '../src/application/pg-store.ts';
import type { ActivityLog } from '../src/application/ports.ts';
import { repairMissingDeliveries } from '../src/application/reconcile.ts';
import type { MissionContract, MissionResultBody } from '../src/kernel/index.ts';
import { ensureTestDatabase } from './helpers/pg.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const RESULT: MissionResultBody = {
  outcome: 'delivered',
  summary: '改好了',
  acceptanceEvidence: ['e'],
  memoryDelta: [],
  openRisks: [],
};

const origin = { clientType: 'cli', conversationRef: 'me' };

let dsn: string | undefined;
const stores: PgStateStore[] = [];

before(async () => {
  dsn = await ensureTestDatabase('c5a_repair');
  if (!dsn) return;
  const store = await PgStateStore.open({ connectionString: dsn });
  await store.close();
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
});
after(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
});

beforeEach(async () => {
  if (!dsn) return;
  const store = await PgStateStore.open({ connectionString: dsn });
  try {
    await store.pool.query(
      'TRUNCATE projects, activity, deliveries, id_counters, query_runs, validation_reports',
    );
  } finally {
    await store.close();
  }
});

function skip(t: { skip: (reason?: string) => void }): boolean {
  if (dsn) return false;
  t.skip('没有可用的 Postgres');
  return true;
}

async function open(): Promise<PgStateStore> {
  const store = await PgStateStore.open({ connectionString: dsn! });
  stores.push(store);
  return store;
}

async function repos(store: PgStateStore) {
  const clock = new FixedClock();
  const ids = new PgIds(store);
  await ids.reserve(['D', 'W', 'VR', 'M', 'E']);
  return {
    clock,
    ids,
    projects: new PgProjectRepository(store),
    activity: new PgActivityLog(store, clock),
    deliveries: new PgDeliveryRepository(store, clock, ids),
  };
}

function deps(
  store: PgStateStore,
  r: Awaited<ReturnType<typeof repos>>,
) {
  return {
    projects: r.projects,
    activity: r.activity,
    deliveries: r.deliveries,
    transaction: store,
    clock: r.clock,
  };
}

async function seedMission(
  r: Awaited<ReturnType<typeof repos>>,
  id: string,
) {
  const project = await r.projects.ensure('P');
  const mission = project.createMission({ id, contract: CONTRACT, origin });
  await r.projects.save(project);
  return mission;
}

describe('PG listForMission：含 acknowledged，事务里含暂存', () => {
  test('已确认行能枚举到', async (t) => {
    if (skip(t)) return;
    const store = await open();
    const r = await repos(store);
    const pending = await r.deliveries.create({
      missionId: 'M',
      projectId: 'P',
      recipient: 'me',
      outcome: 'escalated',
      idempotencyKey: 'escalated:0',
      summary: 'q0',
    });
    const acked = await r.deliveries.create({
      missionId: 'M',
      projectId: 'P',
      recipient: 'me',
      outcome: 'escalated',
      idempotencyKey: 'escalated:1',
      summary: 'q1',
    });
    await r.deliveries.acknowledge(acked.id);
    const listed = await r.deliveries.listForMission('M');
    assert.deepEqual(
      listed.map((row) => `${row.idempotencyKey}:${row.status}`).sort(),
      ['escalated:0:pending', 'escalated:1:acknowledged'],
    );
    assert.equal((await r.deliveries.pending('me')).length, 1);
    assert.equal((await r.deliveries.get(pending.id))?.status, 'pending');
  });

  test('命令事务里 listForMission 看得到暂存的投递', async (t) => {
    if (skip(t)) return;
    const store = await open();
    const r = await repos(store);
    await store.run(async () => {
      await r.deliveries.create({
        missionId: 'M-tx',
        projectId: 'P',
        recipient: 'me',
        outcome: 'escalated',
        idempotencyKey: 'escalated:0',
        summary: 'staged',
      });
      const listed = await r.deliveries.listForMission('M-tx');
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.idempotencyKey, 'escalated:0');
      const { rows } = await store.pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM deliveries WHERE mission_id = $1',
        ['M-tx'],
      );
      assert.equal(Number(rows[0]?.n), 0, '提交前库里还没有');
    });
    assert.equal((await r.deliveries.listForMission('M-tx')).length, 1);
  });
});

describe('验收 5：真 PG 补建、已确认去重、重复运行、重开、失败回滚', () => {
  test('补建缺失升级与当前交卷', async (t) => {
    if (skip(t)) return;
    const store = await open();
    const r = await repos(store);
    const mission = await seedMission(r, 'M-pg');
    mission.recordEscalation({
      attemptId: 'A-1',
      question: '第一问？',
      why: 'w1',
      optionsConsidered: [],
    });
    mission.recordResult(RESULT);
    mission.submitForReview();
    await r.projects.save((await r.projects.get('P'))!);
    await r.activity.append({
      projectId: 'P',
      missionId: 'M-pg',
      attemptId: 'coord-1',
      kind: 'mission_result.submitted',
      data: { outcome: 'delivered', missionStatus: 'awaiting_review' },
    });

    const report = await repairMissingDeliveries(deps(store, r));
    assert.deepEqual(
      report.created.map((row) => row.idempotencyKey).sort(),
      ['escalated:0', 'result:coord-1'],
    );
    const rows = await r.deliveries.listForMission('M-pg');
    assert.equal(rows.find((row) => row.idempotencyKey === 'escalated:0')?.summary, '第一问？\n\n为什么需要 L3：w1');
    assert.equal(rows.find((row) => row.idempotencyKey === 'result:coord-1')?.summary, '改好了');
    const events = await r.activity.list('M-pg');
    assert.equal(events.filter((event) => event.kind === 'recovery.applied').length, 2);
  });

  test('已确认去重：不重投、不改成 pending', async (t) => {
    if (skip(t)) return;
    const store = await open();
    const r = await repos(store);
    const mission = await seedMission(r, 'M-ack');
    mission.recordEscalation({
      attemptId: 'A-1',
      question: 'q',
      why: 'w',
      optionsConsidered: [],
    });
    await r.projects.save((await r.projects.get('P'))!);
    const row = await r.deliveries.create({
      missionId: 'M-ack',
      projectId: 'P',
      recipient: 'me',
      outcome: 'escalated',
      idempotencyKey: 'escalated:0',
      summary: 'q\n\n为什么需要 L3：w',
    });
    await r.deliveries.acknowledge(row.id);

    const report = await repairMissingDeliveries(deps(store, r));
    assert.equal(report.created.length, 0);
    assert.equal((await r.deliveries.get(row.id))?.status, 'acknowledged');
    assert.equal((await r.activity.list('M-ack')).filter((event) => event.kind === 'recovery.applied').length, 0);
  });

  test('重复运行无新增投递或审计', async (t) => {
    if (skip(t)) return;
    const store = await open();
    const r = await repos(store);
    const mission = await seedMission(r, 'M-rep');
    mission.recordEscalation({
      attemptId: 'A-1',
      question: 'q',
      why: 'w',
      optionsConsidered: [],
    });
    await r.projects.save((await r.projects.get('P'))!);
    await repairMissingDeliveries(deps(store, r));
    const again = await repairMissingDeliveries(deps(store, r));
    assert.equal(again.created.length, 0);
    assert.equal((await r.deliveries.listForMission('M-rep')).length, 1);
    assert.equal((await r.activity.list('M-rep')).filter((event) => event.kind === 'recovery.applied').length, 1);
  });

  test('重开实例后投递与审计一致', async (t) => {
    if (skip(t)) return;
    const store = await open();
    const r = await repos(store);
    const mission = await seedMission(r, 'M-reopen');
    mission.recordEscalation({
      attemptId: 'A-1',
      question: 'q',
      why: 'w',
      optionsConsidered: [],
    });
    await r.projects.save((await r.projects.get('P'))!);
    await repairMissingDeliveries(deps(store, r));

    const store2 = await open();
    const r2 = await repos(store2);
    const rows = await r2.deliveries.listForMission('M-reopen');
    const events = await r2.activity.list('M-reopen');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.idempotencyKey, 'escalated:0');
    assert.equal(events.filter((event) => event.kind === 'recovery.applied').length, 1);
    const again = await repairMissingDeliveries(deps(store2, r2));
    assert.equal(again.created.length, 0);
  });

  test('追加事件失败：库里投递与两个事件都没有', async (t) => {
    if (skip(t)) return;
    const store = await open();
    const r = await repos(store);
    const mission = await seedMission(r, 'M-fail');
    mission.recordEscalation({
      attemptId: 'A-1',
      question: 'q',
      why: 'w',
      optionsConsidered: [],
    });
    await r.projects.save((await r.projects.get('P'))!);

    const activity: ActivityLog = {
      async append(event) {
        if (event.kind === 'recovery.applied') throw new Error('CRASH before recovery.applied');
        return r.activity.append(event);
      },
      list: (missionId) => r.activity.list(missionId),
    };
    const report = await repairMissingDeliveries({
      ...deps(store, r),
      activity,
    });
    assert.ok(report.errors.some((row) => row.missionId === 'M-fail'));

    const store2 = await open();
    const r2 = await repos(store2);
    assert.equal((await r2.deliveries.listForMission('M-fail')).length, 0);
    const events = await r2.activity.list('M-fail');
    assert.equal(events.filter((event) => event.kind === 'delivery.created').length, 0);
    assert.equal(events.filter((event) => event.kind === 'recovery.applied').length, 0);
  });

  test('事务提交前抛错：整段回滚', async (t) => {
    if (skip(t)) return;
    const store = await open();
    const r = await repos(store);
    const mission = await seedMission(r, 'M-txfail');
    mission.recordEscalation({
      attemptId: 'A-1',
      question: 'q',
      why: 'w',
      optionsConsidered: [],
    });
    await r.projects.save((await r.projects.get('P'))!);

    const transaction = {
      async run<T>(fn: () => Promise<T>): Promise<T> {
        return store.run(async () => {
          const result = await fn();
          throw new Error('CRASH before commit');
        });
      },
    };
    const report = await repairMissingDeliveries({
      ...deps(store, r),
      transaction,
    });
    assert.ok(report.errors.length > 0);

    const store2 = await open();
    const r2 = await repos(store2);
    assert.equal((await r2.deliveries.listForMission('M-txfail')).length, 0);
    assert.equal((await r2.activity.list('M-txfail')).length, 0);
  });
});
