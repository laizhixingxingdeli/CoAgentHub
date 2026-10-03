/**
 * Postgres 存储。
 *
 * 跑在**真库**上，不是 mock —— 这一层要验的恰恰是"数据库到底怎么反应"：
 * 唯一索引、原子自增、版本冲突。对着 mock 断言等于对着自己的假设断言。
 *
 * 没有可用的 Postgres 时整组跳过而不是报红：文件版仍然是默认存储，
 * 「装了数据库才能跑测试」会让这个仓库变难上手。
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import {
  PgActivityLog,
  PgDeliveryRepository,
  PgIds,
  PgProjectRepository,
  PgQueryRunRepository,
  PgStateStore,
  PgValidationReportRepository,
  WriteConflictError,
} from '../src/application/pg-store.ts';
import { ensureTestDatabase } from './helpers/pg.ts';
import { FixedClock } from '../src/application/in-memory.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { buildPgPlatform } from '../src/main.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import { Project, type MissionContract, type ValidationReport } from '../src/kernel/index.ts';
import type { QueryRunRecord } from '../src/application/query-run.ts';
import {
  ValidationReportConflictError,
  validationReportsEqual,
} from '../src/application/validation/report-repository.ts';

const CONTRACT: MissionContract = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

let store: PgStateStore | undefined;
let available = false;
/** 测试库的连接串。**不是开发库**——理由见 helpers/pg.ts。 */
let dsn = '';

test('项目队列 PG 原子提交、跨实例恢复及旧版本拒绝', async (t) => {
  if (skipIfNoPg(t)) return;
  const first = await buildPgPlatform({ connectionString: dsn });
  const second = await buildPgPlatform({ connectionString: dsn });
  try {
    const config = { projectRoot: process.cwd(), adapter: resolve('src/main.ts'), integrationBranch: 'codex/test', reviewer: 'test', conversationRef: 'test-session', envPassthrough: '-', verification: [{ argv: ['node', '--test'], timeoutMs: 1000 }] };
    const initial = await first.platform.getMissionQueue('P-queue-pg');
    await assert.rejects(first.platform.enqueueMissions('P-queue-pg', { config, expectedRevision: initial.revision, confirmedBy: '测试确认', missions: [
      { missionId: 'queue-pg-A', contract: CONTRACT }, { missionId: 'queue-pg-B', contract: CONTRACT, dependsOn: ['missing'] },
    ] }), { code: 'QUEUE_DEPENDENCY_INVALID' });
    assert.equal((await first.platform.getMissionQueue('P-queue-pg')).config, undefined);
    await first.platform.enqueueMissions('P-queue-pg', { config, expectedRevision: initial.revision, confirmedBy: '测试确认', missions: [
      { missionId: 'queue-pg-A', contract: CONTRACT }, { missionId: 'queue-pg-B', contract: CONTRACT, dependsOn: ['queue-pg-A'] },
    ] });
    await second.refresh();
    assert.deepEqual((await second.platform.getMissionQueue('P-queue-pg')).entries.map((entry) => entry.missionId), ['queue-pg-A', 'queue-pg-B']);
    await assert.rejects(second.platform.configureProjectExecution('P-queue-pg', { config, expectedRevision: initial.revision, confirmedBy: '测试确认' }), { code: 'QUEUE_STALE' });
  } finally { await first.close(); await second.close(); }
});

before(async () => {
  try {
    const target = await ensureTestDatabase('pg_store');
    if (!target) return;
    dsn = target;
    store = await PgStateStore.open({ connectionString: dsn });
    // 每次从干净的库开始，免得上一轮的行影响断言。
    await store.pool.query(
      'TRUNCATE projects, activity, deliveries, id_counters, query_runs, validation_reports, agent_pool',
    );
    await store.refresh();
    available = true;
  } catch {
    available = false;
  }
});

after(async () => {
  await store?.close();
});

function skipIfNoPg(t: { skip: (reason?: string) => void }): boolean {
  if (!available) {
    t.skip('没有可用的 Postgres —— 文件版仍是默认存储，这组跳过');
    return true;
  }
  return false;
}

describe('Postgres 存储', () => {
  test('Project 存进去再读出来，领域对象是原样的', async (t) => {
    if (skipIfNoPg(t)) return;
    const s = store as PgStateStore;
    const repo = new PgProjectRepository(s);
    const project = await repo.ensure('P1');
    project.createMission({ id: 'M1', contract: CONTRACT });
    await repo.persist();

    // 换一个 store 实例 = 换一个进程的视角。
    const other = await PgStateStore.open({ connectionString: dsn });
    try {
      const read = await new PgProjectRepository(other).get('P1');
      assert.equal(read?.missions.length, 1);
      assert.equal(read?.missions[0].contract?.intent, '修 X');
      assert.equal(read?.missions[0].status, 'investigating');
    } finally {
      await other.close();
    }
  });

  test('并发写会被发现，不会悄悄覆盖', async (t) => {
    if (skipIfNoPg(t)) return;
    const s = store as PgStateStore;
    await new PgProjectRepository(s).ensure('P-race');
    await s.flush();

    // 两个进程各自读到同一个版本。
    const a = await PgStateStore.open({ connectionString: dsn });
    const b = await PgStateStore.open({ connectionString: dsn });
    try {
      a.projectsMap().get('P-race')?.createMission({ id: 'MA', contract: CONTRACT });
      b.projectsMap().get('P-race')?.createMission({ id: 'MB', contract: CONTRACT });

      await a.flush();
      // B 手上的版本已经过期。悄悄覆盖的话 MA 就凭空消失了——那是最难查的一类丢数据。
      // 点名 projectId：不指定的话，撞在任何一个不相干的 Project 上都算"通过"，
      // 这条测试就废了（早先正是这样蒙混过去的）。
      await assert.rejects(
        () => b.flush(),
        (error: unknown) =>
          error instanceof WriteConflictError && error.projectId === 'P-race',
      );

      const check = await PgStateStore.open({ connectionString: dsn });
      try {
        assert.equal(check.projectsMap().get('P-race')?.missions.length, 1, 'A 的写不该被抹掉');
      } finally {
        await check.close();
      }
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('同一个 store 上并发 flush 不会自己跟自己撞 —— 实跑炸过两次', async (t) => {
    if (skipIfNoPg(t)) return;
    const s = store as PgStateStore;
    const repo = new PgProjectRepository(s);
    const project = await repo.ensure('P-serial');

    // 模拟真实触发条件：API 的 onMutation 每个 POST 打一次，两次工具调用
    // 挨得近时两个 flush 就重叠了。重叠的两个会捏着同一个期望版本去写，
    // 先到的把版本推走，后到的 UPDATE 命中 0 行 —— 报出一个纯属自己
    // 制造的"并发冲突"，而真实的并发根本没发生。
    project.createMission({ id: 'MS1', contract: CONTRACT });
    const a = s.flush();
    project.createMission({ id: 'MS2', contract: CONTRACT });
    const b = s.flush();
    project.createMission({ id: 'MS3', contract: CONTRACT });
    const c = s.flush();
    await Promise.all([a, b, c]);

    // 三次写都得落地，而且是最终内容。
    const other = await PgStateStore.open({ connectionString: dsn });
    try {
      const ids = other.projectsMap().get('P-serial')?.missions.map((m) => m.id) ?? [];
      assert.deepEqual(ids.sort(), ['MS1', 'MS2', 'MS3']);
    } finally {
      await other.close();
    }
  });

  test('活动日志是追加的，按发生顺序读回来', async (t) => {
    if (skipIfNoPg(t)) return;
    const s = store as PgStateStore;
    const log = new PgActivityLog(s, new FixedClock());
    for (const kind of ['mission.created', 'plan.updated', 'work_item.created']) {
      await log.append({ projectId: 'P2', missionId: 'M2', kind, data: { k: kind } });
    }
    const rows = await log.list('M2');
    assert.deepEqual(rows.map((r) => r.kind), [
      'mission.created',
      'plan.updated',
      'work_item.created',
    ]);
    // 时钟是固定的，所以顺序不能靠时间戳排——必须靠自增序列。
    assert.equal(new Set(rows.map((r) => r.at)).size, 1, '这一条的前提：时间戳全一样');
    assert.equal((await log.list('M-不存在')).length, 0);
  });

  test('发号跨实例不重复 —— 文件版在这里有竞态', async (t) => {
    if (skipIfNoPg(t)) return;
    const s = store as PgStateStore;
    const a = new PgIds(s, 4);
    const b = new PgIds(s, 4);
    await a.reserve(['W']);
    await b.reserve(['W']);

    const issued = [a.next('W'), b.next('W'), a.next('W'), b.next('W')];
    assert.equal(new Set(issued).size, 4, `发重了：${issued.join(', ')}`);
  });

  test('PgIds.reserve() 默认含 VR：next(VR) 立即可用且不撞已有 report', async (t) => {
    if (skipIfNoPg(t)) return;
    const s = store as PgStateStore;
    // 已有高号 report，high-watermark 应抬升
    await s.pool.query(
      `INSERT INTO validation_reports (report_id, report)
       VALUES ('VR-40', $1::jsonb)
       ON CONFLICT (report_id) DO NOTHING`,
      [
        JSON.stringify({
          id: 'VR-40',
          policyRevision: 1,
          missionId: 'M-vr-def',
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:00:01.000Z',
          passed: true,
          checks: [],
        }),
      ],
    );
    // 压低计数器，逼 open 的 high-watermark / reserve 抬升
    await s.pool.query(
      `INSERT INTO id_counters (prefix, value) VALUES ('VR', 1)
       ON CONFLICT (prefix) DO UPDATE SET value = 1`,
    );

    const fresh = await PgStateStore.open({ connectionString: dsn });
    try {
      const ids = new PgIds(fresh, 4);
      // 默认 prefixes 含 VR，不必显式传
      await ids.reserve();
      const next = ids.next('VR');
      const n = Number(next.slice(3));
      assert.ok(n > 40, `默认 reserve 后 next(VR) 应高于已有 VR-40，实际 ${next}`);
    } finally {
      await fresh.close();
    }
  });

  test('同一 Mission 的同一个业务键只投递一次 —— 幂等交给唯一索引（C1）', async (t) => {
    if (skipIfNoPg(t)) return;
    const s = store as PgStateStore;
    const ids = new PgIds(s);
    await ids.reserve(['D']);
    const repo = new PgDeliveryRepository(s, new FixedClock(), ids);
    const input = {
      missionId: 'M3',
      projectId: 'P3',
      outcome: 'delivered' as const,
      idempotencyKey: 'result:M3.coord-0',
      recipient: 'cli',
      summary: '第一次',
      payload: null,
    };
    const first = await repo.create(input);
    const second = await repo.create({ ...input, summary: '第二次' });
    assert.equal(second.id, first.id, '重复投递该拿回同一条');
    assert.equal(second.summary, '第一次', '第一条才算数');
    assert.equal(first.idempotencyKey, 'result:M3.coord-0');
    assert.equal((await repo.pending('cli')).length, 1);

    await repo.acknowledge(first.id);
    assert.equal((await repo.pending('cli')).length, 0);
    // 重复确认幂等，且不刷新确认时间。
    const acked = await repo.acknowledge(first.id);
    assert.equal(acked?.status, 'acknowledged');
  });

  test('心跳跨进程可见 —— 不落盘的话租约等于没做', async (t) => {
    if (skipIfNoPg(t)) return;
    const s = store as PgStateStore;
    const clock = new FixedClock();
    const ids = new PgIds(s);
    await ids.reserve();
    const projects = new PgProjectRepository(s);
    const platform = new Platform({
      projects,
      deliveries: new PgDeliveryRepository(s, clock, ids),
      workspace: new InPlaceWorkspaceManager(),
      activity: new PgActivityLog(s, clock),
      clock,
      ids,
    });
    await platform.createMission({ projectId: 'P-beat', missionId: 'M-beat', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('M-beat');
    await projects.persist();
    await platform.beatAttempt('M-beat', coord.attemptId, 'pid-7');

    // 心跳的全部作用就是让**别的进程**看见。只改内存对象的话，
    // 别的进程读到的仍是"从没心跳过"，照样把它判死——租约就白做了。
    const other = await PgStateStore.open({ connectionString: dsn });
    try {
      const attempt = other
        .projectsMap()
        .get('P-beat')
        ?.missions.find((m) => m.id === 'M-beat')
        ?.coordinatorAttempts[0];
      assert.ok(attempt?.heartbeatAt, '另一个进程必须看得到心跳');
      assert.equal(attempt?.leaseOwner, 'pid-7');
      assert.equal(
        attempt?.isAbandoned(new Date(Date.parse(attempt.heartbeatAt as string) + 1000).toISOString(), 90_000),
        false,
        '刚打过心跳的不该被判成没人管',
      );
    } finally {
      await other.close();
    }
  });

  test('整条用例链跑在 Postgres 上 —— 换存储不改用例层', async (t) => {
    if (skipIfNoPg(t)) return;
    const s = store as PgStateStore;
    const clock = new FixedClock();
    const ids = new PgIds(s);
    await ids.reserve();
    const projects = new PgProjectRepository(s);
    const platform = new Platform({
      projects,
      deliveries: new PgDeliveryRepository(s, clock, ids),
      workspace: new InPlaceWorkspaceManager(),
      activity: new PgActivityLog(s, clock),
      clock,
      ids,
    });

    await platform.createMission({ projectId: 'P4', missionId: 'M4', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('M4');
    await platform.updatePlan('M4', coord.attemptId, {
      findings: 'f',
      rejectedHypotheses: [],
      decisions: [],
      direction: 'd',
      risks: [],
    });
    const { workItemId } = await platform.createWorkItem('M4', coord.attemptId, {
      title: 'W',
      order: {
        objective: '改 foo',
        allowedScope: ['src/foo.ts'],
        requiredBehaviour: 'foo 返回 1',
        constraints: [],
        acceptance: ['foo() === 1'],
        verification: ['node --test'],
        doNot: [],
        contextRefs: [],
      },
    });
    await projects.persist();

    const view = await platform.getMissionView('M4');
    assert.equal(view.workItems.length, 1);
    assert.equal(view.workItems[0].id, workItemId);
    assert.ok((await platform.getActivity('M4')).length >= 3, 'Timeline 要有料');

    // 重新载入 = 重启。状态得还在。
    await s.refresh();
    assert.equal((await platform.getMissionView('M4')).workItems.length, 1);
  });

  test('QueryRun 两独立实例 round-trip；project filter；同 id update 不重复', async (t) => {
    if (skipIfNoPg(t)) return;
    const s = store as PgStateStore;
    const repo = new PgQueryRunRepository(s);

    const base: QueryRunRecord = {
      id: 'Q-42',
      projectId: 'P-q1',
      source: 'pg-test',
      prompt: 'what?',
      cwd: '/work',
      startedAt: '2026-06-01T10:00:00.000Z',
      status: 'running',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        quality: 'unknown',
      },
    };
    await repo.save(base);

    const other = await PgStateStore.open({ connectionString: dsn });
    try {
      const otherRepo = new PgQueryRunRepository(other);
      const running = await otherRepo.get('Q-42');
      assert.ok(running);
      assert.equal(running?.status, 'running');
      assert.equal(running?.source, 'pg-test');

      await otherRepo.save({
        ...base,
        status: 'ended',
        outcome: 'answered',
        endedAt: '2026-06-01T10:00:05.000Z',
        output: 'ok',
        toolCalls: ['ls', 'grep'],
        usage: {
          input: 3,
          output: 4,
          cacheRead: 0,
          cacheWrite: 0,
          total: 7,
          quality: 'reported',
        },
      });

      await otherRepo.save({
        id: 'Q-43',
        projectId: 'P-q2',
        source: 'pg-test',
        prompt: 'other',
        cwd: '/work',
        startedAt: '2026-06-01T11:00:00.000Z',
        endedAt: '2026-06-01T11:00:01.000Z',
        status: 'ended',
        outcome: 'failed',
        failureMessage: 'x',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
          quality: 'unknown',
        },
      });

      const back = new PgQueryRunRepository(s);
      const ended = await back.get('Q-42');
      assert.equal(ended?.status, 'ended');
      assert.equal(ended?.outcome, 'answered');
      assert.equal(ended?.output, 'ok');
      assert.deepEqual([...(ended?.toolCalls ?? [])], ['ls', 'grep']);
      assert.equal(ended?.usage.total, 7);

      const byProject = await back.list('P-q1');
      assert.equal(byProject.length, 1);
      assert.equal(byProject[0]?.id, 'Q-42');

      const all = await back.list();
      const ids = all.map((r) => r.id).filter((id) => id === 'Q-42' || id === 'Q-43');
      assert.equal(ids.length, 2);
      assert.equal(all.filter((r) => r.id === 'Q-42').length, 1, '同 id 不得重复行');
    } finally {
      await other.close();
    }
  });

  test('ValidationReport round-trip + cross-store + append-only', async (t) => {
    if (skipIfNoPg(t)) return;
    const s = store as PgStateStore;
    const repo = new PgValidationReportRepository(s);

    const report: ValidationReport = {
      id: 'VR-42',
      policyRevision: 1,
      missionId: 'M-pg',
      workItemId: 'WI-pg',
      attemptId: 'AT-pg',
      startedAt: '2026-06-01T12:00:00.000Z',
      endedAt: '2026-06-01T12:00:01.000Z',
      passed: true,
      checks: [
        {
          kind: 'command',
          passed: true,
          startedAt: '2026-06-01T12:00:00.000Z',
          endedAt: '2026-06-01T12:00:00.500Z',
          summary: 'command exited 0',
          command: {
            argv: ['node', '--test'],
            cwd: '/proj',
            exitCode: 0,
            timedOut: false,
            durationMs: 11,
            outputTail: 'pg-ok',
          },
        },
        {
          kind: 'changed-paths',
          passed: true,
          startedAt: '2026-06-01T12:00:00.500Z',
          endedAt: '2026-06-01T12:00:01.000Z',
          summary: 'changed-paths: no changes',
          changedPaths: {
            allowedScope: ['src/'],
            actual: [],
            violations: [],
            unsupportedScope: [],
          },
        },
      ],
    };

    await repo.save(report);
    const got = await repo.get('VR-42');
    assert.ok(got);
    assert.ok(validationReportsEqual(got, report));
    assert.ok(Object.isFrozen(got));
    assert.ok(Object.isFrozen(got.checks));
    assert.ok(Object.isFrozen(got.checks[0]!.command!.argv));
    assert.notEqual(got, report);

    // cross-store read
    const other = await PgStateStore.open({ connectionString: dsn });
    try {
      const back = new PgValidationReportRepository(other);
      const again = await back.get('VR-42');
      assert.ok(again);
      assert.ok(validationReportsEqual(again, report));
      assert.ok(Object.isFrozen(again));

      // identical 幂等
      await back.save({ ...report, checks: report.checks.map((c) => ({ ...c })) });

      // different same-id => conflict；旧值不变
      await assert.rejects(
        () => back.save({ ...report, passed: false }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationReportConflictError);
          assert.equal(err.code, 'VALIDATION_REPORT_CONFLICT');
          assert.equal(err.reportId, 'VR-42');
          return true;
        },
      );
      await assert.rejects(
        () =>
          back.save({
            ...report,
            checks: [
              {
                ...report.checks[0]!,
                command: {
                  ...report.checks[0]!.command!,
                  outputTail: 'DIFFERENT',
                },
              },
              report.checks[1]!,
            ],
          }),
        (err: unknown) => err instanceof ValidationReportConflictError,
      );

      const still = await back.get('VR-42');
      assert.ok(still);
      assert.equal(still.passed, true);
      assert.equal(still.checks[0]!.command!.outputTail, 'pg-ok');
    } finally {
      await other.close();
    }
  });

  test('ValidationReport VR id high-watermark：新实例不碰撞已有 id', async (t) => {
    if (skipIfNoPg(t)) return;
    await (store as PgStateStore).pool.query(
      `INSERT INTO validation_reports (report_id, report)
       VALUES ('VR-77', $1::jsonb)
       ON CONFLICT (report_id) DO NOTHING`,
      [
        JSON.stringify({
          id: 'VR-77',
          policyRevision: 1,
          missionId: 'M-hw',
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:00:01.000Z',
          passed: true,
          checks: [],
        }),
      ],
    );
    await (store as PgStateStore).pool.query(
      `INSERT INTO id_counters (prefix, value) VALUES ('VR', 1)
       ON CONFLICT (prefix) DO UPDATE SET value = 1`,
    );

    const fresh = await PgStateStore.open({ connectionString: dsn });
    try {
      const ids = new PgIds(fresh, 4);
      await ids.reserve(['VR']);
      const next = ids.next('VR');
      const n = Number(next.slice(3));
      assert.ok(n > 77, `应高于已有 VR-77，实际 ${next}`);
    } finally {
      await fresh.close();
    }
  });

  test('QueryRun Q id high-watermark：新实例不碰撞已有 id', async (t) => {
    if (skipIfNoPg(t)) return;
    // 直接插入高号 Q，模拟「计数器落后于已有记录」
    await (store as PgStateStore).pool.query(
      `INSERT INTO query_runs (query_run_id, project_id, record)
       VALUES ('Q-77', 'P-hw', $1::jsonb)
       ON CONFLICT (query_run_id) DO NOTHING`,
      [
        JSON.stringify({
          id: 'Q-77',
          projectId: 'P-hw',
          source: 'seed',
          prompt: 'p',
          cwd: '/',
          startedAt: '2026-01-01T00:00:00.000Z',
          status: 'ended',
          outcome: 'answered',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
            quality: 'unknown',
          },
        }),
      ],
    );
    // 把计数器压低，逼 open() 的 high-watermark 抬升
    await (store as PgStateStore).pool.query(
      `INSERT INTO id_counters (prefix, value) VALUES ('Q', 1)
       ON CONFLICT (prefix) DO UPDATE SET value = 1`,
    );

    const fresh = await PgStateStore.open({ connectionString: dsn });
    try {
      const ids = new PgIds(fresh, 4);
      await ids.reserve(['Q']);
      const next = ids.next('Q');
      const n = Number(next.slice(2));
      assert.ok(n > 77, `应高于已有 Q-77，实际 ${next}`);
    } finally {
      await fresh.close();
    }
  });

  test('buildPgPlatform 装配 durable queryRuns；仅 query-capable 暴露 runQuery', async (t) => {
    if (skipIfNoPg(t)) return;
    const bare = await buildPgPlatform({ connectionString: dsn });
    try {
      assert.equal(bare.runQuery, undefined);
      assert.equal(bare.queryRunner, undefined);
      assert.ok(bare.queryRuns);

      const runtime = new ScriptedRuntime({
        'query:-': {
          steps: [{ tool: 'ls', body: {} }],
          output: 'pg-ok',
          queryOutcome: 'answered',
          usage: {
            input: 2,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            total: 5,
            quality: 'reported',
          },
        },
      });
      const withQuery = await buildPgPlatform({
        connectionString: dsn,
        queryRuntime: runtime,
      });
      try {
        assert.ok(withQuery.runQuery);
        await withQuery.agentPool.add({ role: 'classifier', profileId: 'test-query', endpoint: 'local' });
        const result = await withQuery.runQuery!({
          projectId: 'P-pg-q',
          prompt: 'hi',
          cwd: process.cwd(),
          source: 'pg-platform',
        });
        assert.equal(result.outcome, 'answered');
        assert.equal(result.record.output, 'pg-ok');

        // 另一个实例读得到
        const again = await buildPgPlatform({ connectionString: dsn });
        try {
          const got = await again.queryRuns.get(result.queryRunId);
          assert.equal(got?.source, 'pg-platform');
          assert.equal(got?.usage.total, 5);
          assert.equal(got?.status, 'ended');
        } finally {
          await again.close();
        }
      } finally {
        await withQuery.close();
      }
    } finally {
      await bare.close();
    }
  });

  test('检视者签名经持久化及新连接读回同一形状', async (t) => {
    if (skipIfNoPg(t)) return;
    const s = store as PgStateStore;
    const clock = new FixedClock('2026-09-25T12:00:00.000Z');
    const ids = new PgIds(s);
    await ids.reserve(['D', 'W', 'VR', 'M', 'E']);
    const projects = new PgProjectRepository(s);
    const platform = new Platform({
      projects,
      deliveries: new PgDeliveryRepository(s, clock, ids),
      workspace: new InPlaceWorkspaceManager(),
      activity: new PgActivityLog(s, clock),
      clock,
      ids,
    });
    const order = {
      objective: '改 foo',
      allowedScope: ['src/foo.ts'],
      requiredBehaviour: 'foo 返回 1',
      constraints: [],
      acceptance: ['foo() === 1'],
      verification: ['node --test'],
      doNot: [],
      contextRefs: [],
    };
    await platform.createMission({ projectId: 'P-r0b', missionId: 'M-r0b', contract: CONTRACT });
    await platform.recordWorkspace('M-r0b', { branch: 'mission/M-r0b', baseRevision: 'base0' });
    const coord = await platform.startCoordinatorAttempt('M-r0b');
    await platform.updatePlan('M-r0b', coord.attemptId, {
      findings: 'f',
      rejectedHypotheses: [],
      decisions: [],
      direction: 'd',
      risks: [],
    });
    const { workItemId } = await platform.createWorkItem('M-r0b', coord.attemptId, {
      title: 'W',
      order,
    });
    // W-334：Standard 第一次派发前必须先落一条当前契约修订的核对结论。
    await platform.submitContractCheck('M-r0b', coord.attemptId, {
      verdict: 'ok',
      summary: '测试契约已核对',
    });
    await platform.dispatchWorkItems('M-r0b', coord.attemptId, [workItemId]);
    const exec = await platform.startExecutorAttempt('M-r0b', workItemId);
    await platform.submitEvidence('M-r0b', exec.attemptId, {
      kind: 'test',
      summary: '绿',
      command: 'node --test',
      exitCode: 0,
    });
    await platform.submitExecutionResult('M-r0b', exec.attemptId, {
      outcome: 'completed',
      summary: '改好了',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: '无',
    });
    await platform.finishAttempt('M-r0b', exec.attemptId, { endedBy: 'structured_submit' });
    await platform.reviewExecutionResult('M-r0b', coord.attemptId, {
      workItemId,
      verdict: 'accept',
      acceptanceResults: order.acceptance.map((criterion) => ({
        criterion,
        status: 'pass' as const,
        evidence: '测试替身：逐条核过',
      })),
      reasons: ['复跑过'],
      requiredChanges: [],
    });
    await platform.submitMissionResult('M-r0b', coord.attemptId, {
      outcome: 'delivered',
      summary: '交付',
      acceptanceEvidence: ['绿'],
      memoryDelta: [],
      openRisks: [],
    });
    await platform.finishAttempt('M-r0b', coord.attemptId, { endedBy: 'structured_submit' });
    await platform.finalizeMissionByReviewer('M-r0b', {
      verdict: 'merge',
      reasons: ['ok'],
      projectRoot: process.cwd(),
      reviewerId: '  claude  ',
      confirmedBy: '  echo  ',
    });
    await projects.persist();

    const other = await PgStateStore.open({ connectionString: dsn });
    try {
      const read = await new PgProjectRepository(other).get('P-r0b');
      const authority = read?.missions.find((mission) => mission.id === 'M-r0b')?.finalReview?.authority;
      assert.deepEqual(authority, {
        kind: 'reviewer',
        reviewerId: 'claude',
        confirmedBy: 'echo',
        confirmedAt: '2026-09-25T12:00:00.000Z',
      });
    } finally {
      await other.close();
    }
  });

  test('没有 authority 的旧 PG 状态仍可读写', async (t) => {
    if (skipIfNoPg(t)) return;
    const s = store as PgStateStore;
    const repo = new PgProjectRepository(s);
    const project = Project.restore({
      id: 'P-r0b-old',
      missions: [
        {
          id: 'M-r0b-old',
          projectId: 'P-r0b-old',
          status: 'completed',
          contractRevision: 1,
          planRevision: 0,
          escalations: [],
          finalReview: { verdict: 'merge', reasons: ['旧放行'] },
          workItems: [],
          coordinatorAttempts: [],
          coordinatorSeq: 0,
        },
      ],
    });
    await repo.save(project);
    await repo.persist();

    const other = await PgStateStore.open({ connectionString: dsn });
    try {
      const read = await new PgProjectRepository(other).get('P-r0b-old');
      const review = read?.missions.find((mission) => mission.id === 'M-r0b-old')?.finalReview;
      assert.equal(review?.verdict, 'merge');
      assert.equal(review?.authority, undefined);
    } finally {
      await other.close();
    }
  });
});
