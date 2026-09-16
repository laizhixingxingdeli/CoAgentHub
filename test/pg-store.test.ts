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

import {
  PgActivityLog,
  PgDeliveryRepository,
  PgIds,
  PgProjectRepository,
  PgStateStore,
  WriteConflictError,
} from '../src/application/pg-store.ts';
import { ensureTestDatabase } from './helpers/pg.ts';
import { FixedClock } from '../src/application/in-memory.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import type { MissionContract } from '../src/kernel/index.ts';

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

before(async () => {
  try {
    const target = await ensureTestDatabase();
    if (!target) return;
    dsn = target;
    store = await PgStateStore.open({ connectionString: dsn });
    // 每次从干净的库开始，免得上一轮的行影响断言。
    await store.pool.query('TRUNCATE projects, activity, deliveries, id_counters');
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

  test('同一 Mission 的同一种结局只投递一次 —— 幂等交给唯一索引', async (t) => {
    if (skipIfNoPg(t)) return;
    const s = store as PgStateStore;
    const ids = new PgIds(s);
    await ids.reserve(['D']);
    const repo = new PgDeliveryRepository(s, new FixedClock(), ids);
    const input = {
      missionId: 'M3',
      projectId: 'P3',
      outcome: 'delivered' as const,
      recipient: 'cli',
      summary: '第一次',
      payload: null,
    };
    const first = await repo.create(input);
    const second = await repo.create({ ...input, summary: '第二次' });
    assert.equal(second.id, first.id, '重复投递该拿回同一条');
    assert.equal(second.summary, '第一次', '第一条才算数');
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
});
