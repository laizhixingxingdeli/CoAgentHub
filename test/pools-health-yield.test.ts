/**
 * W-687：池健康扫描逐 Mission 让出事件循环。
 *
 * 断言的是**顺序**不是墙钟阈值：扫描处理到某条 Mission 时安排一个 setImmediate
 * 回调，它必须在那次扫描处理完**最后**一条 Mission 之前跑掉。改前一次性扫完
 * 才轮到事件循环，这个顺序必然反过来，所以它不依赖机器快慢。
 *
 * 夹具里放了一条读失败的 Mission：让出挂在 try/finally 上，正是为了覆盖
 * getMissionView/getActivity 抛错走 continue 的那条路径 —— 只挂在成功路径上
 * 时这个用例会红。同一条 Mission 还得证明统计与 hints 没被改动。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPoolsHealthFixture,
  httpGetJson,
  POOLS_HEALTH_FIXTURE_NOW_ISO,
  POOLS_HEALTH_OLD_PROFILE_ID,
} from './helpers/pools-health-fixture.ts';

const MISSION_COUNT = 6;
const ATTEMPTS_PER_MISSION = 2;
/** 读失败的 Mission 下标。夹在这里，让出事件循环的 finally 路径才有机会被证伪。 */
const FAILING_MISSION_INDEX = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

interface HealthRow {
  readonly profileId: string;
  readonly health: {
    readonly circuit: { readonly state: string; readonly reason?: string };
    readonly lastFailure: { readonly failureClass: string; readonly at: string | null; readonly source: string };
    readonly window7d: { readonly attempts: number; readonly successes: number; readonly reportedCost: number | null };
  };
}

test('池健康扫描逐个 Mission 让出事件循环，且读失败的 Mission 不影响统计与 hints', async () => {
  // 顺序数组同时装：夹具的 Mission 顺序标记 + 我们自己的 setImmediate 回调标记。
  const order: string[] = [];
  const fixture = await createPoolsHealthFixture({
    missions: MISSION_COUNT,
    attemptsPerMission: ATTEMPTS_PER_MISSION,
    failingMissionIndexes: [FAILING_MISSION_INDEX],
    order,
    hooks: {
      onMissionStart: (index) => {
        // 只在首条与读失败那条上排回调：读失败那条的 onMissionStart 是在抛错**之前**
        // 调用的，所以它证明的是 continue 路径上也让出了事件循环。
        if (index !== 0 && index !== FAILING_MISSION_INDEX) return;
        setImmediate(() => order.push(index === 0 ? 'immediate:first' : 'immediate:failed'));
      },
    },
  });
  try {
    const response = await httpGetJson(`${fixture.base}/api/pools`);
    assert.equal(response.status, 200);
    const snapshot = response.json as { executor: HealthRow[] };

    // 让出事件循环：两个回调都必须跑在最后一条 Mission 处理之前。
    const lastMissionAt = order.lastIndexOf(`mission:${MISSION_COUNT - 1}`);
    assert.ok(lastMissionAt >= 0, `缺少最后一条 Mission 的顺序标记：${order.join(',')}`);
    for (const marker of ['immediate:first', 'immediate:failed']) {
      const at = order.indexOf(marker);
      assert.ok(at >= 0, `回调没跑：${marker}；顺序=${order.join(',')}`);
      assert.ok(
        at < lastMissionAt,
        `${marker} 该在扫描结束前执行；顺序=${order.join(',')}`,
      );
    }
    // 读失败那条夹在中间，回调顺序也得在它之后、最后一条之前 —— 说明让出发生在它身上。
    const failedMissionAt = order.indexOf(`mission:${FAILING_MISSION_INDEX}`);
    assert.ok(failedMissionAt > order.indexOf('immediate:first'));

    // 统计与 hints 与读失败之前一致：读失败那条整体不计，其余照常。
    const counted = MISSION_COUNT - 1;
    const exec0 = snapshot.executor.find((row) => row.profileId === 'exec-0');
    const exec1 = snapshot.executor.find((row) => row.profileId === 'exec-1');
    const old = snapshot.executor.find((row) => row.profileId === POOLS_HEALTH_OLD_PROFILE_ID);
    assert.ok(exec0);
    assert.ok(exec1);
    assert.ok(old);
    // 没注入熔断仓储：circuit 必须说明原因，不能编一个状态。
    assert.equal(exec0.health.circuit.state, 'unknown');
    assert.equal(exec0.health.circuit.reason, 'candidate_circuits_unavailable');
    assert.equal(exec0.health.window7d.attempts, counted);
    assert.equal(exec0.health.window7d.successes, counted);
    assert.equal(exec0.health.window7d.reportedCost, counted * 0.25);
    assert.equal(exec1.health.window7d.attempts, counted);
    assert.equal(exec1.health.window7d.successes, 0);
    // 失败的 attempt 没报 cost：这一格必须是 null，不是 0。
    assert.equal(exec1.health.window7d.reportedCost, null);
    assert.equal(exec1.health.lastFailure.failureClass, 'quota');
    assert.equal(exec1.health.lastFailure.source, 'attempt.ended');
    // 七日窗口外的失败：hint 看得到、用量看不到。
    assert.equal(old.health.lastFailure.failureClass, 'quota');
    assert.equal(old.health.lastFailure.source, 'attempt.ended');
    assert.equal(old.health.lastFailure.at, new Date(Date.parse(POOLS_HEALTH_FIXTURE_NOW_ISO) - 8 * DAY_MS).toISOString());
    assert.equal(old.health.window7d.attempts, 0);
  } finally {
    await fixture.close();
  }
});
