/**
 * C3：PG 单事务命令（设计 §8.1）——跑在真库上，独立库 coagenthub_v5_test_command_tx。
 *
 * 守住：
 *   - 事务里的事件、投递暂存，提交时与变了的快照（版本检查）同一个数据库事务写下；事务里读得到自己暂存的
 *   - 事务里抛错 / 提交失败（含提交时版本冲突）：库里什么都没有，活对象回到之前，记账不前移
 *   - 事务外的写与重读等事务结束
 *   - 交卷（Standard / Lightweight）与升级：每个写边界注入崩溃，新开 store 读库全有或全无；重放恰好一条
 *   - 快照 flush 回滚后记账不前移（早先边写边前移）
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
  PgValidationReportRepository,
  WriteConflictError,
} from '../src/application/pg-store.ts';
import { Project } from '../src/kernel/index.ts';
import type { DeliveryRepository } from '../src/application/delivery.ts';
import type { ActivityLog } from '../src/application/ports.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { ValidationEngine } from '../src/application/validation/engine.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';
import { connectPgClient, ensureTestDatabase } from './helpers/pg.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};
const origin = { clientType: 'cli', conversationRef: 'me' };

let dsn: string | undefined;
const stores: PgStateStore[] = [];

before(async () => {
  dsn = await ensureTestDatabase('command_tx');
});

// 每条用例结束就关掉它开的连接池：几十个 store 同时挂着会顶到 Postgres 的连接上限。
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
});
after(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
});

async function open(): Promise<PgStateStore> {
  const store = await PgStateStore.open({ connectionString: dsn! });
  stores.push(store);
  return store;
}

beforeEach(async () => {
  if (!dsn) return;
  const store = await PgStateStore.open({ connectionString: dsn });
  try {
    await store.pool.query('TRUNCATE projects, activity, deliveries, id_counters, query_runs, validation_reports');
  } finally {
    await store.close();
  }
});

/** 另一个连接：看库里真有什么，或者扮演别的写者。 */
async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = await connectPgClient(dsn!);
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

async function count(table: string, missionId: string): Promise<number> {
  const rows = await sql<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE mission_id = $1`, [missionId]);
  return Number(rows[0]!.n);
}

function skip(t: { skip: (reason?: string) => void }): boolean {
  if (dsn) return false;
  t.skip('没有可用的 Postgres');
  return true;
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

const deliveryInput = (missionId: string, key: string) => ({
  missionId,
  projectId: 'P',
  recipient: 'me',
  outcome: 'escalated' as const,
  idempotencyKey: key,
  summary: `${missionId} ${key}`,
});

/* ============================ A. 存储层 ============================ */

describe('PgStateStore.run（真库）', () => {
  test('提交：事务中途别的连接什么都看不到；提交后快照、事件、投递一起在，版本只 +1', async (t) => {
    if (skip(t)) return;
    const store = await open();
    const r = await repos(store);
    await r.projects.ensure('P');
    const [{ version: v0 }] = await sql<{ version: string }>("SELECT version FROM projects WHERE project_id = 'P'");

    await store.run(async () => {
      const project = (await r.projects.get('P'))!;
      project.createMission({ id: 'M', contract: CONTRACT });
      await r.projects.save(project);
      await r.activity.append({ projectId: 'P', missionId: 'M', kind: 'mission.created', data: {} });
      await r.deliveries.create(deliveryInput('M', 'escalated:0'));
      assert.equal(await count('activity', 'M'), 0, '事务中途：事件不在库里');
      assert.equal(await count('deliveries', 'M'), 0, '事务中途：投递不在库里');
      const [{ snapshot }] = await sql<{ snapshot: { missions: unknown[] } }>("SELECT snapshot FROM projects WHERE project_id = 'P'");
      assert.equal(snapshot.missions.length, 0, '事务中途：快照没写');
    });

    assert.equal(await count('activity', 'M'), 1);
    assert.equal(await count('deliveries', 'M'), 1);
    const [{ version, snapshot }] = await sql<{ version: string; snapshot: { missions: unknown[] } }>(
      "SELECT version, snapshot FROM projects WHERE project_id = 'P'",
    );
    assert.equal(snapshot.missions.length, 1);
    assert.equal(Number(version), Number(v0) + 1, '一个事务只推一次版本');
  });

  test('事务里读得到自己暂存的事件与投递；同键重复建拿回暂存那条', async (t) => {
    if (skip(t)) return;
    const store = await open();
    const r = await repos(store);
    await store.run(async () => {
      await r.activity.append({ projectId: 'P', missionId: 'M', kind: 'k1', data: {} });
      assert.deepEqual((await r.activity.list('M')).map((e) => e.kind), ['k1']);
      const first = await r.deliveries.create(deliveryInput('M', 'escalated:0'));
      const again = await r.deliveries.create(deliveryInput('M', 'escalated:0'));
      assert.equal(again.id, first.id);
      assert.equal((await r.deliveries.get(first.id))?.id, first.id);
      assert.deepEqual((await r.deliveries.pending('me')).map((d) => d.id), [first.id]);
      const acked = await r.deliveries.acknowledge(first.id);
      assert.equal(acked?.status, 'acknowledged');
      assert.deepEqual(await r.deliveries.pending('me'), [], '暂存的确认读得到');
    });
    const [row] = await sql<{ status: string }>("SELECT status FROM deliveries WHERE mission_id = 'M'");
    assert.equal(row?.status, 'acknowledged', '暂存的确认与投递一起提交');
  });

  test('事务里抛错：库里什么都没有；活对象回到之前；之后一次 flush 正常（记账没动）', async (t) => {
    if (skip(t)) return;
    const store = await open();
    const r = await repos(store);
    const project = await r.projects.ensure('P');
    const before = JSON.stringify(project.toSnapshot());

    await assert.rejects(
      store.run(async () => {
        const live = (await r.projects.get('P'))!;
        live.createMission({ id: 'M', contract: CONTRACT });
        await r.activity.append({ projectId: 'P', missionId: 'M', kind: 'mission.created', data: {} });
        await r.deliveries.create(deliveryInput('M', 'escalated:0'));
        throw new Error('命令半路失败');
      }),
      /命令半路失败/,
    );

    assert.equal(await count('activity', 'M'), 0);
    assert.equal(await count('deliveries', 'M'), 0);
    assert.equal(JSON.stringify((await r.projects.get('P'))!.toSnapshot()), before);

    const live = (await r.projects.get('P'))!;
    live.createMission({ id: 'M2', contract: CONTRACT });
    await r.projects.persist();
    const [{ snapshot }] = await sql<{ snapshot: { missions: { id: string }[] } }>("SELECT snapshot FROM projects WHERE project_id = 'P'");
    assert.deepEqual(snapshot.missions.map((m) => m.id), ['M2']);
  });

  test('提交时版本冲突（别的写者抢先改了）：整个事务回滚，事件与投递都不在库里', async (t) => {
    if (skip(t)) return;
    const store = await open();
    const r = await repos(store);
    await r.projects.ensure('P');
    await assert.rejects(
      store.run(async () => {
        const live = (await r.projects.get('P'))!;
        live.createMission({ id: 'M', contract: CONTRACT });
        await r.activity.append({ projectId: 'P', missionId: 'M', kind: 'mission.created', data: {} });
        await r.deliveries.create(deliveryInput('M', 'escalated:0'));
        await sql("UPDATE projects SET version = version + 1 WHERE project_id = 'P'");
      }),
      (error: unknown) => error instanceof WriteConflictError,
    );
    assert.equal(await count('activity', 'M'), 0);
    assert.equal(await count('deliveries', 'M'), 0);
    assert.equal((await r.projects.get('P'))!.missions.length, 0, '活对象回滚');
  });

  test('事务外的写（事件 / 投递 / 确认 / 快照 / 新建项目）等事务结束，且熬过它的回滚', async (t) => {
    if (skip(t)) return;
    const store = await open();
    const r = await repos(store);
    const outsider = await r.projects.ensure('P-out');
    const toAck = await r.deliveries.create(deliveryInput('M-ack', 'escalated:0'));
    let releaseTx!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTx = resolve;
    });
    const tx = store.run(async () => {
      await r.activity.append({ projectId: 'P', missionId: 'M-tx', kind: 'inside', data: {} });
      await gate;
      throw new Error('回滚');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    outsider.createMission({ id: 'M-saved', contract: CONTRACT });
    let settled = false;
    const outside = Promise.all([
      r.activity.append({ projectId: 'P', missionId: 'M-out', kind: 'outside', data: {} }),
      r.deliveries.create(deliveryInput('M-out', 'escalated:0')),
      r.deliveries.acknowledge(toAck.id),
      r.projects.save(outsider),
      r.projects.ensure('P-new'),
    ]).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(settled, false, '事务开着时事务外的写在等');
    assert.equal(await count('activity', 'M-out'), 0, '事件没抢在事务结束前写');
    assert.equal(await count('deliveries', 'M-out'), 0, '投递没抢在事务结束前写');
    const [{ status: ackDuring }] = await sql<{ status: string }>('SELECT status FROM deliveries WHERE delivery_id = $1', [toAck.id]);
    assert.equal(ackDuring, 'pending', '确认没抢在事务结束前写');
    releaseTx();
    await assert.rejects(tx, /回滚/);
    await outside;

    assert.equal(await count('activity', 'M-tx'), 0);
    assert.equal(await count('activity', 'M-out'), 1);
    assert.equal(await count('deliveries', 'M-out'), 1);
    const [{ snapshot }] = await sql<{ snapshot: { missions: { id: string }[] } }>("SELECT snapshot FROM projects WHERE project_id = 'P-out'");
    assert.deepEqual(snapshot.missions.map((m) => m.id), ['M-saved']);
    const [{ status: ackAfter }] = await sql<{ status: string }>('SELECT status FROM deliveries WHERE delivery_id = $1', [toAck.id]);
    assert.equal(ackAfter, 'acknowledged');
    assert.equal((await sql("SELECT 1 FROM projects WHERE project_id = 'P-new'")).length, 1, '事务开着时新建的项目没被它的回滚删掉');
  });

  test('嵌套：内层并进外层，一起提交', async (t) => {
    if (skip(t)) return;
    const store = await open();
    const r = await repos(store);
    await store.run(async () => {
      await r.activity.append({ projectId: 'P', missionId: 'M', kind: 'outer', data: {} });
      await store.run(async () => {
        await r.activity.append({ projectId: 'P', missionId: 'M', kind: 'inner', data: {} });
      });
      assert.equal(await count('activity', 'M'), 0, '内层结束时也还没落库');
    });
    const kinds = (await sql<{ kind: string }>("SELECT kind FROM activity WHERE mission_id = 'M' ORDER BY seq")).map((row) => row.kind);
    assert.deepEqual(kinds, ['outer', 'inner']);
  });

  test('事务开着时 API 的 persist（直接 flush、不先等）推迟到事务结束：事务的半截改动不会先落库', async (t) => {
    if (skip(t)) return;
    const store = await open();
    const r = await repos(store);
    await r.projects.ensure('P');
    let releaseTx!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTx = resolve;
    });
    const tx = store.run(async () => {
      const live = (await r.projects.get('P'))!;
      live.createMission({ id: 'M-half', contract: CONTRACT });
      await gate;
      throw new Error('回滚');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const persisted = r.projects.persist();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const [{ snapshot: during }] = await sql<{ snapshot: { missions: unknown[] } }>("SELECT snapshot FROM projects WHERE project_id = 'P'");
    assert.equal(during.missions.length, 0, '事务开着时 persist 没把半截改动写下去');
    releaseTx();
    await assert.rejects(tx, /回滚/);
    await persisted;
    const [{ snapshot: after }] = await sql<{ snapshot: { missions: unknown[] } }>("SELECT snapshot FROM projects WHERE project_id = 'P'");
    assert.equal(after.missions.length, 0, '事务回滚后 persist 也不会把它写下去');
  });

  test('重读不在事务中途换掉活对象：事务里跳过，事务外等事务结束', async (t) => {
    if (skip(t)) return;
    const store = await open();
    const r = await repos(store);
    await r.projects.ensure('P');
    let releaseTx!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTx = resolve;
    });
    let liveInTx: Project | undefined;
    const tx = store.run(async () => {
      liveInTx = (await r.projects.get('P'))!;
      liveInTx.createMission({ id: 'M', contract: CONTRACT });
      await store.refresh(); // 事务里：跳过
      assert.equal(await r.projects.get('P'), liveInTx, '事务里重读没换掉活对象');
      await gate;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    let refreshed = false;
    const outside = store.refresh().then(() => {
      refreshed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(refreshed, false, '事务外的重读在等');
    releaseTx();
    await tx;
    await outside;
    assert.ok((await r.projects.get('P'))!.missions.some((m) => m.id === 'M'), '重读读到的是提交后的库');
  });

  test('快照 flush 在库里回滚时记账不前移：去掉冲突的那个再 flush，前面那个照样写下（早先边写边前移会漏写）', async (t) => {
    if (skip(t)) return;
    const store = await open();
    const r = await repos(store);
    const a = await r.projects.ensure('A');
    a.createMission({ id: 'M-a', contract: CONTRACT });
    store.projectsMap().set('B', Project.create({ id: 'B' }));
    // 别的写者先插了 B：这次 flush 里 A 的 UPDATE 先成功、B 的 INSERT 撞唯一键，整个事务回滚。
    await sql("INSERT INTO projects (project_id, snapshot) VALUES ('B', '{\"id\":\"B\",\"missions\":[]}'::jsonb)");
    await assert.rejects(store.flush());
    store.projectsMap().delete('B');
    await store.flush();
    const [{ snapshot }] = await sql<{ snapshot: { missions: { id: string }[] } }>("SELECT snapshot FROM projects WHERE project_id = 'A'");
    assert.deepEqual(snapshot.missions.map((m) => m.id), ['M-a'], 'A 没被当成已落库');
  });
});

/* ============================ B. 平台命令的崩溃注入（真库） ============================ */

type Crash =
  | { readonly kind: 'none' }
  | { readonly kind: 'beforeEvent'; readonly event: string }
  | { readonly kind: 'beforeDelivery' }
  | { readonly kind: 'commitConflict' };

async function pgPlatform(crash: Crash = { kind: 'none' }) {
  const store = await open();
  const r = await repos(store);
  let armed = false;
  const activity: ActivityLog = {
    async append(event) {
      if (armed && crash.kind === 'beforeEvent' && crash.event === event.kind) throw new Error(`CRASH before ${event.kind}`);
      if (armed && crash.kind === 'commitConflict' && event.kind === 'delivery.created') {
        // 命令最后一步之前，别的写者把快照版本推了一格：提交时版本检查必然失败。
        await sql('UPDATE projects SET version = version + 1');
      }
      return r.activity.append(event);
    },
    list: (missionId) => r.activity.list(missionId),
  };
  const deliveries: DeliveryRepository = {
    async create(input) {
      if (armed && crash.kind === 'beforeDelivery') throw new Error('CRASH before delivery');
      return r.deliveries.create(input);
    },
    pending: (recipient) => r.deliveries.pending(recipient),
    acknowledge: (id) => r.deliveries.acknowledge(id),
    get: (id) => r.deliveries.get(id),
  };
  const platform = new Platform({
    projects: r.projects,
    deliveries,
    activity,
    workspace: new InPlaceWorkspaceManager(),
    clock: r.clock,
    ids: r.ids,
    transaction: store,
    validation: {
      engine: new ValidationEngine({
        clock: r.clock,
        ids: r.ids,
        commandRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 1, output: 'ok' }) },
        changedPathReader: { listChanged: async () => ['src/foo.ts'] },
      }),
      reports: new PgValidationReportRepository(store),
    },
  });
  return {
    platform,
    projects: r.projects,
    arm() {
      armed = true;
    },
  };
}

interface Scenario {
  readonly name: string;
  readonly missionId: string;
  prepare(platform: Platform, projects: PgProjectRepository): Promise<(platform: Platform) => Promise<unknown>>;
  readonly terminalEvent: string;
  readonly deliveryKey: RegExp;
  readonly statusAfter: (before: string) => string;
}

const scenarios: Scenario[] = [
  {
    name: 'Standard 交卷',
    missionId: 'M',
    async prepare(platform) {
      await platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT, origin });
      const { attemptId } = await platform.startCoordinatorAttempt('M');
      const body = { outcome: 'delivered' as const, summary: '改好了', acceptanceEvidence: ['e'], memoryDelta: [], openRisks: [] };
      return (p) => p.submitMissionResult('M', attemptId, body);
    },
    terminalEvent: 'mission_result.submitted',
    deliveryKey: /^result:/,
    statusAfter: () => 'awaiting_review',
  },
  {
    name: '升级',
    missionId: 'M',
    async prepare(platform) {
      await platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT, origin });
      const { attemptId } = await platform.startCoordinatorAttempt('M');
      return (p) => p.escalateToL3('M', attemptId, { question: '要不要拆？', why: '两种设计', options: ['拆', '不拆'] });
    },
    terminalEvent: 'escalated',
    deliveryKey: /^escalated:0$/,
    statusAfter: (before) => before,
  },
  {
    name: 'Lightweight 交卷',
    missionId: 'M-lw',
    async prepare(platform, projects) {
      const project = await projects.ensure('P');
      project.createMission({ id: 'M-lw', contract: CONTRACT, executionMode: 'lightweight', runKind: 'mutation', origin });
      await projects.save(project);
      const order: WorkOrder = {
        objective: '改 foo',
        allowedScope: ['src/foo.ts'],
        requiredBehaviour: 'foo 返回 1',
        constraints: [],
        acceptance: ['foo() === 1'],
        verification: ['node --test'],
        doNot: [],
        contextRefs: [],
        validation: { commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }] },
      };
      const { workItemId } = await platform.createLightweightWorkItem('M-lw', { order });
      await platform.dispatchLightweightWorkItem('M-lw', workItemId);
      await platform.recordWorkspace('M-lw', { projectRoot: '/proj', branch: 'mission/M-lw', baseRevision: 'base' });
      const { attemptId } = await platform.startExecutorAttempt('M-lw', workItemId);
      await platform.submitEvidence('M-lw', attemptId, { kind: 'test', summary: '绿', command: 'node --test', exitCode: 0 });
      await platform.submitExecutionResult('M-lw', attemptId, {
        outcome: 'completed',
        summary: '改好了',
        changedFiles: ['src/foo.ts'],
        evidenceIds: [],
        notes: '',
      });
      await platform.finishAttempt('M-lw', attemptId, { endedBy: 'structured_submit' });
      const validated = await platform.validateAndAcceptLightweightWorkItem({ missionId: 'M-lw', workItemId, cwd: '/proj' });
      // 机器过了也留在 submitted：验收结论归协调者（W-442 之后），交卷前必须先有这一跳的 L2 accept。
      assert.equal(validated.status, 'submitted');
      // 真实 L2：起协调者 attempt，凭这份报告逐条判 pass，再收尾这一跳。
      const { attemptId: l2 } = await platform.startCoordinatorAttempt('M-lw');
      await platform.reviewExecutionResult('M-lw', l2, {
        workItemId,
        verdict: 'accept',
        reasons: ['机器验收通过，逐条核过'],
        requiredChanges: [],
        acceptanceResults: order.acceptance.map((criterion) => ({
          criterion,
          status: 'pass' as const,
          evidence: `机器验收报告 ${validated.reportId}：node --test 退出 0`,
        })),
      });
      await platform.finishAttempt('M-lw', l2, { endedBy: 'structured_submit' });
      await projects.persist();
      return (p) => p.submitLightweightMissionForReview('M-lw');
    },
    terminalEvent: 'mission_result.submitted',
    deliveryKey: /^result:VR-/,
    statusAfter: () => 'awaiting_review',
  },
];

const crashes: Crash[] = [
  { kind: 'beforeEvent', event: 'mission_result.submitted' },
  { kind: 'beforeEvent', event: 'escalated' },
  { kind: 'beforeDelivery' },
  { kind: 'beforeEvent', event: 'delivery.created' },
  { kind: 'commitConflict' },
];

function label(crash: Crash): string {
  if (crash.kind === 'beforeEvent') return `记 ${crash.event} 之前`;
  if (crash.kind === 'beforeDelivery') return '建投递之前';
  if (crash.kind === 'commitConflict') return '提交时版本冲突';
  return '不崩';
}

/** 「重启」：新开一个 store 读库。 */
async function inspect(missionId: string) {
  const { platform, projects } = await pgPlatform();
  const store = stores.at(-1)!;
  const view = await platform.getMissionView(missionId);
  const kinds = (await new PgActivityLog(store, new FixedClock()).list(missionId)).map((e) => e.kind);
  const rows = await sql<{ idempotency_key: string }>('SELECT idempotency_key FROM deliveries WHERE mission_id = $1', [missionId]);
  return { platform, projects, view, kinds, rows };
}

for (const scenario of scenarios) {
  describe(`崩溃注入（真库）：${scenario.name}`, () => {
    const relevant = crashes.filter(
      (c) => c.kind !== 'beforeEvent' || c.event === 'delivery.created' || c.event === scenario.terminalEvent,
    );
    for (const crash of relevant) {
      test(`${label(crash)} → 新开 store 全无；重放后恰好一条终态事件、一条投递`, async (t) => {
        if (skip(t)) return;
        const first = await pgPlatform(crash);
        const command = await scenario.prepare(first.platform, first.projects);
        await first.projects.persist();
        const statusBefore = (await first.platform.getMissionView(scenario.missionId)).status;

        first.arm();
        await assert.rejects(command(first.platform));

        const afterCrash = await inspect(scenario.missionId);
        assert.equal(afterCrash.view.status, statusBefore, '库里的状态还在命令之前');
        assert.ok(!afterCrash.kinds.includes(scenario.terminalEvent), `库里没有 ${scenario.terminalEvent}：${afterCrash.kinds.join(',')}`);
        assert.ok(!afterCrash.kinds.includes('delivery.created'));
        assert.deepEqual(afterCrash.rows, [], '库里没有投递');

        await command(afterCrash.platform);
        const replayed = await inspect(scenario.missionId);
        assert.equal(replayed.view.status, scenario.statusAfter(statusBefore));
        assert.equal(replayed.kinds.filter((k) => k === scenario.terminalEvent).length, 1, '恰好一条终态事件');
        assert.equal(replayed.kinds.filter((k) => k === 'delivery.created').length, 1);
        assert.equal(replayed.rows.length, 1, '恰好一条投递');
        assert.match(replayed.rows[0]!.idempotency_key, scenario.deliveryKey);
      });
    }
  });
}

/* ============================ C. 装配 ============================ */

describe('buildPgPlatform 注入了事务（真库）', () => {
  test('库里的版本被别的写者推过：升级在提交时整体失败，库里没有 escalated 与投递（没注入的话事件与投递即时写进去、命令还报成功）', async (t) => {
    if (skip(t)) return;
    const { buildPgPlatform } = await import('../src/main.ts');
    const built = await buildPgPlatform({ connectionString: dsn!, workspace: new InPlaceWorkspaceManager() });
    try {
      await built.platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT, origin });
      const { attemptId } = await built.platform.startCoordinatorAttempt('M');
      await built.persist();
      await sql("UPDATE projects SET version = version + 1 WHERE project_id = 'P'");

      await assert.rejects(
        built.platform.escalateToL3('M', attemptId, { question: '拆吗？', why: 'w', options: ['是', '否'] }),
        (error: unknown) => error instanceof WriteConflictError,
      );
      assert.equal(await count('deliveries', 'M'), 0);
      const kinds = (await sql<{ kind: string }>("SELECT kind FROM activity WHERE mission_id = 'M'")).map((r) => r.kind);
      assert.ok(!kinds.includes('escalated'), kinds.join(','));
    } finally {
      await built.close();
    }
  });
});
