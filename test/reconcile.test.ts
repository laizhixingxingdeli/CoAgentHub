/**
 * 启动收敛的边界。
 *
 * 这组测试的由来是一次实跑事故：Mission 正在跑，我重启了一下**只读**的观测面，
 * 它开机就跑收敛，把在途 attempt 判成 interrupted 写回了共用的数据库——
 * 那条 Mission 当场坏掉，调度器随后撞上写冲突整个进程退出。
 *
 * 根因不是收敛写错了，是它的**前提**换存储之后不成立了：
 * 「我自己刚起来，所以没有任何 attempt 可能还活着」只在单写者下为真。
 * 文件版有进程锁所以为真；Postgres 共用状态之后就假了。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { reconcileInterruptedAttempts } from '../src/application/reconcile.ts';
import { InMemoryProjectRepository } from '../src/application/in-memory.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const ORDER: WorkOrder = {
  objective: 'o',
  allowedScope: ['src/a.ts'],
  requiredBehaviour: 'b',
  constraints: [],
  acceptance: ['a'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
};

/**
 * 两条正在跑的 Mission，各有一个在途协调者 attempt 和一个在途执行者 attempt。
 *
 * 放在**两个不同的 Project** 里：不变量 C 不允许同项目两条同时改代码，
 * 而且事故场景本来就是「重启一次，全库任意 Mission 都可能被殃及」。
 */
async function twoRunningMissions() {
  const repo = new InMemoryProjectRepository();
  for (const [projectId, id] of [
    ['P-mine', 'M-mine'],
    ['P-other', 'M-别人的'],
  ]) {
    const project = await repo.ensure(projectId);
    const mission = project.createMission({ id, contract: CONTRACT });
    mission.startCoordinatorAttempt();
    mission.startPlanning();
    const item = mission.createWorkItem({ id: `${id}-W1`, title: 'W', order: ORDER });
    mission.startExecuting();
    item.dispatch();
    item.startAttempt();
  }
  return { repo, projects: await repo.list() };
}

function findMission(projects: readonly { missions: readonly { id: string }[] }[], id: string) {
  for (const project of projects) {
    const hit = project.missions.find((m) => m.id === id);
    if (hit) return hit;
  }
  return undefined;
}

describe('启动收敛的范围', () => {
  test('不限定范围时收敛全部 —— 单写者下这是对的', async () => {
    const { projects } = await twoRunningMissions();
    const result = await reconcileInterruptedAttempts(projects);
    assert.equal(result.interrupted.length, 4, '两条 Mission 各两个在途 attempt');
  });

  test('限定 missionId 时**只**碰那一条 —— 别人的在途 attempt 不许动', async () => {
    const { projects } = await twoRunningMissions();
    const result = await reconcileInterruptedAttempts(projects, undefined, {
      missionId: 'M-mine',
    });

    assert.equal(result.interrupted.length, 2);
    assert.ok(
      result.interrupted.every((r) => r.missionId === 'M-mine'),
      `碰到了别人的：${result.interrupted.map((r) => r.missionId).join(', ')}`,
    );

    // 别人那条必须原封不动。判死它等于杀掉一个正在跑的 Mission——
    // 实测就是这么把一条跑到一半的 Mission 搞坏的。
    const other = findMission(projects, 'M-别人的');
    assert.equal(other?.coordinatorAttempts[0].status, 'in_progress');
    assert.equal(other?.workItems[0].attempts[0].status, 'in_progress');
  });

  test('心跳还新鲜的不许碰 —— 那是另一个进程正在跑的', async () => {
    const { projects } = await twoRunningMissions();
    const now = new Date('2026-01-01T00:10:00.000Z');

    // M-mine 刚打过心跳（10 秒前），M-别人的 从没打过。
    const mine = findMission(projects, 'M-mine');
    for (const attempt of [
      ...(mine?.coordinatorAttempts ?? []),
      ...(mine?.workItems.flatMap((w) => w.attempts) ?? []),
    ]) {
      attempt.beat('2026-01-01T00:09:50.000Z', 'pid-999');
    }

    const result = await reconcileInterruptedAttempts(projects, undefined, {
      now,
      toleranceMs: 90_000,
    });

    // 这正是弄坏过一条真 Mission 的那一幕：另一个进程重启，看到在途 attempt
    // 就判死。有租约之后，"还有人在跑"是状态里看得见的事实，不用再猜。
    assert.deepEqual(
      result.interrupted.map((r) => r.missionId).sort(),
      ['M-别人的', 'M-别人的'],
      '只该收掉没心跳的那条',
    );
    assert.equal(result.alive.length, 2, '活着的要报出来，否则不知道为什么没收它');
    assert.ok(result.alive.every((a) => a.owner === 'pid-999'), '要说清楚本来是谁在跑');
    assert.equal(mine?.coordinatorAttempts[0].status, 'in_progress');
  });

  test('心跳过期了就收 —— 租约不能变成永不回收', async () => {
    const { projects } = await twoRunningMissions();
    const mine = findMission(projects, 'M-mine');
    mine?.coordinatorAttempts[0].beat('2026-01-01T00:00:00.000Z', 'pid-999');

    // 距最后一次心跳 10 分钟，远超容忍窗口：跑它的进程显然已经没了。
    const result = await reconcileInterruptedAttempts(projects, undefined, {
      missionId: 'M-mine',
      now: new Date('2026-01-01T00:10:00.000Z'),
      toleranceMs: 90_000,
    });
    assert.ok(result.interrupted.some((r) => r.attemptId === mine?.coordinatorAttempts[0].id));
    assert.equal(mine?.coordinatorAttempts[0].status, 'failed');
  });

  test('从没打过心跳的一律收 —— 老数据和不打心跳的运行时行为不变', async () => {
    // 这条很重要：如果"没心跳"被当成"还活着"，升级之后那些旧的 in_progress
    // 会永远收不掉，不变量 B 会把对应的 Mission 永久焊死。
    const { projects } = await twoRunningMissions();
    const result = await reconcileInterruptedAttempts(projects, undefined, {
      missionId: 'M-mine',
      now: new Date(),
    });
    assert.equal(result.interrupted.length, 2);
    assert.equal(result.alive.length, 0);
  });

  test('判成 interrupted 而不是失败 —— 它没交出任何技术结论，可以重试', async () => {
    const { projects } = await twoRunningMissions();
    await reconcileInterruptedAttempts(projects, undefined, { missionId: 'M-mine' });
    const mine = findMission(projects, 'M-mine');
    const attempt = mine?.coordinatorAttempts[0];
    assert.equal(attempt?.status, 'failed');
    assert.equal(attempt?.endedBy, 'interrupted');
    // 收敛完必须能重新开一个，否则不变量 B 会把这条 Mission 永久卡死。
    assert.doesNotThrow(() => mine?.startCoordinatorAttempt());
  });
});
