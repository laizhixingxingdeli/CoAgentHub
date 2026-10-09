/**
 * C1：投递按业务幂等键去重（设计 §8.1–8.2）。
 *
 * 守住：
 *   - 第二次升级（前一次已答复并确认）进收件箱；L3 打回后重新交卷进收件箱
 *   - 同一个键重建投递拿回原来那条（内存 / 文件 / 真 PG 三个实现同一语义）
 *   - 键只由持久化状态决定：升级 escalated:<第几次>，交卷 result:<协调者 attempt | 验收报告>
 *   - 旧数据：文件版读入时补键，归档包读出的副本补键、盘上不动；PG 迁移回填、换唯一约束、可重复执行
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPlatform } from '../src/main.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import {
  escalationDeliveryKey,
  InMemoryDeliveryRepository,
  legacyDeliveryKey,
  resultDeliveryKey,
} from '../src/application/delivery.ts';
import type { Delivery, DeliveryRepository } from '../src/application/delivery.ts';
import {
  FileDeliveryRepository,
  FileStateStore,
  PersistentIds,
} from '../src/application/file-store.ts';
import { PgDeliveryRepository, PgIds, PgStateStore } from '../src/application/pg-store.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { ValidationEngine } from '../src/application/validation/engine.ts';
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';
import { connectPgClient, ensureTestDatabase } from './helpers/pg.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-c1-'));
  dirs.push(dir);
  return dir;
}

function input(missionId: string, idempotencyKey: string, recipient = 'me', outcome: Delivery['outcome'] = 'escalated') {
  return { missionId, projectId: 'P', recipient, outcome, idempotencyKey, summary: `${missionId} ${idempotencyKey}` };
}

/** 三个实现共用的去重语义。收件人单独一个，免得和同库里别的行混在一起数。 */
async function assertKeySemantics(repo: DeliveryRepository, to = 'sem'): Promise<void> {
  const first = await repo.create(input('M1', 'escalated:0', to));
  const again = await repo.create({ ...input('M1', 'escalated:0', to), summary: '重建' });
  assert.equal(again.id, first.id, '同一个键拿回原来那条');
  assert.equal(again.summary, first.summary, '第一条才算数');
  assert.equal(first.idempotencyKey, 'escalated:0');

  const second = await repo.create(input('M1', 'escalated:1', to));
  assert.notEqual(second.id, first.id, '同一种结局、不同的键：各投一条');
  const otherMission = await repo.create(input('M2', 'escalated:0', to));
  assert.notEqual(otherMission.id, first.id, '键只在同一 Mission 内去重');

  await repo.acknowledge(first.id);
  const afterAck = await repo.create(input('M1', 'escalated:0', to));
  assert.equal(afterAck.id, first.id, '确认过的也不会因为重建而再投一次');
  const pending = await repo.pending(to);
  assert.deepEqual(pending.map((d) => `${d.missionId}/${d.idempotencyKey}`).sort(), ['M1/escalated:1', 'M2/escalated:0']);
}

describe('投递仓储：按 (missionId, idempotencyKey) 去重', () => {
  test('内存版', async () => {
    const clock = new FixedClock();
    await assertKeySemantics(new InMemoryDeliveryRepository(clock, new SequentialIds()));
  });

  test('文件版', async () => {
    const store = new FileStateStore(join(tempDir(), 'state.json'));
    await assertKeySemantics(new FileDeliveryRepository(store, new FixedClock(), new PersistentIds(store)));
  });

  test('键的写法', () => {
    assert.equal(escalationDeliveryKey(2), 'escalated:2');
    assert.equal(resultDeliveryKey('M.coord-3'), 'result:M.coord-3');
    assert.equal(legacyDeliveryKey('escalated'), 'escalated:0');
    assert.equal(legacyDeliveryKey('delivered'), 'result:legacy:delivered');
    assert.equal(legacyDeliveryKey('blocked'), 'result:legacy:blocked');
  });
});

describe('平台：每一次升级、每一次交卷都进收件箱', () => {
  test('第二次升级（前一次已答复并确认）照样进收件箱，键按第几次升级', async () => {
    const { platform, deliveries } = buildPlatform(new InPlaceWorkspaceManager());
    await platform.createMission({
      projectId: 'P',
      missionId: 'M',
      contract: CONTRACT,
      origin: { clientType: 'cli', conversationRef: 'me' },
    });
    const { attemptId: first } = await platform.startCoordinatorAttempt('M');
    await platform.escalateToL3('M', first, { question: '第一问？', why: 'w1', options: ['x', 'y'] });
    const [one] = await deliveries.pending('me');
    assert.equal(one?.idempotencyKey, 'escalated:0');
    await platform.answerEscalation('M', { answer: 'x' });
    await deliveries.acknowledge(one!.id);
    await platform.finishAttempt('M', first, { endedBy: 'structured_submit' });

    const { attemptId: second } = await platform.startCoordinatorAttempt('M');
    await platform.escalateToL3('M', second, { question: '第二问？', why: 'w2', options: ['p', 'q'] });

    const pending = await deliveries.pending('me');
    assert.equal(pending.length, 1, '第二次升级必须进收件箱');
    assert.equal(pending[0]!.idempotencyKey, 'escalated:1');
    assert.match(pending[0]!.summary, /第二问/);
  });

  test('L3 打回后重新交卷：新结果进收件箱，键是提交它的协调者 attempt', async () => {
    const { platform, deliveries } = buildPlatform(new InPlaceWorkspaceManager());
    await platform.createMission({
      projectId: 'P',
      missionId: 'M',
      contract: CONTRACT,
      origin: { clientType: 'cli', conversationRef: 'me' },
    });
    const result = (summary: string) => ({
      outcome: 'delivered' as const,
      summary,
      acceptanceEvidence: ['e'],
      memoryDelta: [],
      openRisks: [],
    });
    const { attemptId: first } = await platform.startCoordinatorAttempt('M');
    await platform.submitMissionResult('M', first, result('第一版'));
    // 同一次交卷重复提交（同一个协调者 attempt）：状态机拒也好、放也好，收件箱里只能有一条。
    await platform.submitMissionResult('M', first, result('第一版重发')).catch(() => undefined);
    await platform.finishAttempt('M', first, { endedBy: 'structured_submit' });
    const firstRound = await deliveries.pending('me');
    assert.equal(firstRound.length, 1, '同一次交卷只投一条');
    const [firstDelivery] = firstRound;
    assert.equal(firstDelivery?.idempotencyKey, `result:${first}`);
    assert.equal(firstDelivery?.summary, '第一版');
    await deliveries.acknowledge(firstDelivery!.id);

    await platform.finalizeMission('M', { verdict: 'send_back', reasons: ['边界说明不够'] });
    const { attemptId: second } = await platform.startCoordinatorAttempt('M');
    await platform.submitMissionResult('M', second, result('第二版'));

    const pending = await deliveries.pending('me');
    assert.equal(pending.length, 1, '重新交卷的结果必须进收件箱');
    assert.equal(pending[0]!.idempotencyKey, `result:${second}`);
    assert.equal(pending[0]!.summary, '第二版');
  });

  test('Lightweight 交卷：键是那份验收报告', async () => {
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const projects = new InMemoryProjectRepository();
    const deliveries = new InMemoryDeliveryRepository(clock, ids);
    const platform = new Platform({
      projects,
      deliveries,
      workspace: new InPlaceWorkspaceManager(),
      activity: new InMemoryActivityLog(clock),
      clock,
      ids,
      validation: {
        engine: new ValidationEngine({
          clock,
          ids: new SequentialIds(),
          commandRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 1, output: 'ok' }) },
          changedPathReader: { listChanged: async () => ['src/foo.ts'] },
        }),
        reports: new InMemoryValidationReportRepository(),
      },
    });
    const project = await projects.ensure('P');
    project.createMission({
      id: 'M-lw',
      contract: CONTRACT,
      executionMode: 'lightweight',
      runKind: 'mutation',
      origin: { clientType: 'cli', conversationRef: 'me' },
    });
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
    await platform.recordWorkspace('M-lw', { projectRoot: '/proj', branch: 'mission/M-lw', baseRevision: 'base-rev-1' });
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
    const validated = await platform.validateAndAcceptLightweightWorkItem({ missionId: 'M-lw', workItemId, cwd: process.cwd() });
    // 机器过了也留在 submitted：验收结论归协调者（W-442 之后），交卷前必须先有 L2 的 accept。
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

    const { reportId } = await platform.submitLightweightMissionForReview('M-lw');

    const [delivery] = await deliveries.pending('me');
    assert.equal(delivery?.idempotencyKey, `result:${reportId}`);
  });
});

describe('文件版旧数据：读入补键，去重接得上', () => {
  test('加键之前的状态文件：读入时按旧规则补键；重建第一次升级拿回旧行，第二次升级新建', async () => {
    const path = join(tempDir(), 'state.json');
    const legacy = (id: string, outcome: Delivery['outcome'], status: Delivery['status']) => ({
      id,
      missionId: 'M-old',
      projectId: 'P',
      recipient: 'me',
      outcome,
      summary: `${outcome} 旧行`,
      createdAt: '2026-01-01T00:00:00.000Z',
      status,
    });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        projects: [],
        deliveries: [legacy('D-1', 'escalated', 'pending'), legacy('D-2', 'delivered', 'acknowledged')],
        events: [],
        idCounters: { D: 2 },
      }),
    );
    const store = new FileStateStore(path);
    const repo = new FileDeliveryRepository(store, new FixedClock(), new PersistentIds(store));

    assert.equal((await repo.get('D-1'))?.idempotencyKey, 'escalated:0');
    assert.equal((await repo.get('D-2'))?.idempotencyKey, 'result:legacy:delivered');
    const rebuilt = await repo.create(input('M-old', 'escalated:0'));
    assert.equal(rebuilt.id, 'D-1', '旧行就是第一次升级的投递');
    const next = await repo.create(input('M-old', 'escalated:1'));
    assert.equal(next.id, 'D-3');

    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { deliveries: Delivery[] };
    assert.deepEqual(
      onDisk.deliveries.map((d) => `${d.id}=${d.idempotencyKey}`),
      ['D-1=escalated:0', 'D-2=result:legacy:delivered', 'D-3=escalated:1'],
      '下一次落盘把补上的键一起写下',
    );

    // 「重启」：新开一个 store 读同一个文件，重建同一次升级的投递拿回原来那条。
    const reopened = new FileStateStore(path);
    const again = new FileDeliveryRepository(reopened, new FixedClock(), new PersistentIds(reopened));
    assert.equal((await again.create(input('M-old', 'escalated:1'))).id, 'D-3');
    assert.equal((await again.create(input('M-old', 'escalated:0'))).id, 'D-1');
    assert.equal((await again.pending('me')).filter((d) => d.missionId === 'M-old').length, 2);
  });
});

/* ------------------------------ 真 PG：迁移（独立库） ------------------------------ */

describe('PG：迁移回填、换唯一约束、可重复执行（独立库，不碰并行跑的 pg-store 测试）', () => {
  let dsn: string | undefined;

  before(async () => {
    dsn = await ensureTestDatabase('delivery_key');
  });

  async function legacySchema(connectionString: string): Promise<void> {
    const client = await connectPgClient(connectionString);
    await client.connect();
    try {
      // 回到加键之前的形状：没有 idempotency_key 列，唯一约束是 (mission_id, outcome)。
      await client.query('DROP TABLE IF EXISTS deliveries');
      await client.query(`CREATE TABLE deliveries (
        delivery_id text PRIMARY KEY, mission_id text NOT NULL, project_id text NOT NULL,
        outcome text NOT NULL, recipient text, summary text NOT NULL, payload jsonb,
        status text NOT NULL, created_at timestamptz NOT NULL, acknowledged_at timestamptz)`);
      await client.query('CREATE UNIQUE INDEX deliveries_mission_outcome_idx ON deliveries (mission_id, outcome)');
      await client.query(`INSERT INTO deliveries (delivery_id, mission_id, project_id, outcome, recipient, summary, status, created_at)
        VALUES ('D-OLD-1','M-old','P','escalated','me','旧升级','acknowledged',now()),
               ('D-OLD-2','M-old','P','delivered','me','旧交卷','pending',now())`);
    } finally {
      await client.end();
    }
  }

  async function indexes(store: PgStateStore): Promise<string[]> {
    const { rows } = await store.pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'deliveries' ORDER BY indexname",
    );
    return rows.map((r) => r.indexname);
  }

  test('旧库打开即迁移：旧行补键、只剩新约束；第一次升级重建拿回旧行，第二次升级新建；再开一次不出错不改数', async (t) => {
    if (!dsn) {
      t.skip('没有可用的 Postgres');
      return;
    }
    await legacySchema(dsn);

    let store = await PgStateStore.open({ connectionString: dsn });
    try {
      const { rows } = await store.pool.query<{ delivery_id: string; idempotency_key: string }>(
        'SELECT delivery_id, idempotency_key FROM deliveries ORDER BY delivery_id',
      );
      assert.deepEqual(
        rows.map((r) => `${r.delivery_id}=${r.idempotency_key}`),
        ['D-OLD-1=escalated:0', 'D-OLD-2=result:legacy:delivered'],
      );
      assert.deepEqual(await indexes(store), ['deliveries_mission_key_idx', 'deliveries_pkey']);

      const ids = new PgIds(store);
      await ids.reserve(['D']);
      const repo = new PgDeliveryRepository(store, new FixedClock(), ids);
      assert.equal((await repo.create(input('M-old', 'escalated:0'))).id, 'D-OLD-1');
      const second = await repo.create(input('M-old', 'escalated:1'));
      assert.notEqual(second.id, 'D-OLD-1', '第二次升级在旧约束下会被吞掉，新约束下要新建');
      await assertKeySemantics(repo, `sem-${Date.now()}`);
    } finally {
      await store.close();
    }

    // 迁移可重复执行：再开一次，不报错、不改已有键。
    store = await PgStateStore.open({ connectionString: dsn });
    try {
      const { rows } = await store.pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM deliveries WHERE mission_id = 'M-old'",
      );
      assert.equal(Number(rows[0]!.n), 3);
      assert.deepEqual(await indexes(store), ['deliveries_mission_key_idx', 'deliveries_pkey']);
    } finally {
      await store.close();
    }
  });
});
