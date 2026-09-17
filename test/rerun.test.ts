/**
 * 可重跑 + 结果分类。
 *
 * ## 要解决的问题
 *
 * 一条 Mission 原先是**一次性**的：跑砸了想再来一遍，只能手工 `git worktree
 * remove` 再重新分叉——这个动作在一次会话里我做了三遍。而"同一个任务跑 N 遍、
 * 换配置比成本"是优化的前提：不能重复一次，就谈不上比较。
 *
 * 重跑的做法是**另起一条 Mission、契约一字不改地抄过来**，不是把原来那条洗
 * 干净重用。洗掉重用会把上一次的记录抹了，而那正是要比的东西。
 *
 * ## 结束原因为什么要分类
 *
 * `upstream_failure` 原先同时覆盖「模型不存在」「静默卡死被我们杀」「跑太久被
 * 我们杀」。实测 W5 有四跳失败，翻记录只能看到四个 upstream_failure，要分辨
 * 得去 failureMessage 里做字符串匹配——而那是一句给人读的话。
 *
 * 判准：**这一跳是别人挂了，还是我们自己掐的？** 两者处置相反。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform, PlatformRuleError } from '../src/application/platform.ts';
import { KILLED_BY_US } from '../src/kernel/index.ts';
import type { MissionContract } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '把事件流折叠成环节',
  acceptance: ['默认全部收起'],
  constraints: ['不改内核'],
  nonGoals: [],
  guardrails: ['不改 package.json'],
};

function makePlatform() {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  return new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
  });
}

describe('重跑：另起一条，契约照抄', () => {
  test('新 Mission 的契约与源头逐字相同，源头一点没动', async () => {
    const platform = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'W9', contract: CONTRACT });

    const again = await platform.rerunMission('W9');
    assert.equal(again.missionId, 'W9#2');
    assert.equal(again.rerunOf, 'W9');

    const fresh = await platform.getMissionView('W9#2');
    assert.deepEqual(fresh.contract, CONTRACT, '契约必须逐字照抄，改一个字就不是同一个任务了');
    assert.equal(fresh.status, 'investigating');
    assert.equal(fresh.workItems.length, 0, '重跑是从头开始，不继承上一次的工作项');

    // **源头必须原样不动。** 洗掉重用会把要比的那一份抹了。
    const origin = await platform.getMissionView('W9');
    assert.equal(origin.status, 'investigating');
    assert.deepEqual(origin.contract, CONTRACT);
  });

  test('抄的是当前生效的契约，不是 r1', async () => {
    const platform = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'W9', contract: CONTRACT });
    const revised = { ...CONTRACT, intent: '改过的目标' };
    await platform.reviseContract('W9', revised);

    await platform.rerunMission('W9');
    const fresh = await platform.getMissionView('W9#2');
    // 重跑的意思是"照**现在**的要求再来一次"。抄 r1 等于跑一个已经作废的任务。
    assert.equal(fresh.contract?.intent, '改过的目标');
  });

  test('重跑的重跑仍然挂在最初那条上，不连成链', async () => {
    const platform = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'W9', contract: CONTRACT });
    await platform.rerunMission('W9');
    const third = await platform.rerunMission('W9#2');

    // 挂成链的话，"这个任务一共跑过几遍"就得顺着指针爬，断一环就散了。
    assert.equal(third.rerunOf, 'W9', '源头永远指向最初那条');
    assert.equal(third.missionId, 'W9#3', '编号按这个任务已有的运行数来');
  });

  test('起点钉在源头那次的分叉基线上', async () => {
    const platform = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'W9', contract: CONTRACT });
    await platform.recordWorkspace('W9', {
      projectRoot: 'C:/repo',
      branch: 'mission/W9',
      baseRevision: 'abc1234',
    });

    const again = await platform.rerunMission('W9');
    assert.equal(again.baseRevision, 'abc1234');
    // 记在新 Mission 上，调度器 prepare 时会照它分叉。不记的话第二次会从
    // 「跑它时的 HEAD」起步——而源头的产出多半已经合进去了，比较当场失效。
    const fresh = await platform.getMissionView('W9#2');
    assert.equal(fresh.workspaceRef?.baseRevision, 'abc1234');
    assert.equal(fresh.workspaceRef?.branch, 'mission/W9#2', '分支是自己的，基线才是共用的');
  });

  test('源头没记过工作区时如实返回 undefined —— 不许假装钉住了', async () => {
    const platform = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'W9', contract: CONTRACT });
    const again = await platform.rerunMission('W9');
    // CLI 据此打一句"这一跑和源头不是同一个起点，数不能对比"。
    // 编一个基线出来比说不知道更坏：人会以为比较是成立的。
    assert.equal(again.baseRevision, undefined);
  });

  test('没有契约就不给重跑 —— 抄不出东西来', async () => {
    const platform = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'W9' } as never);
    await assert.rejects(
      () => platform.rerunMission('W9'),
      (error: unknown) => error instanceof PlatformRuleError,
    );
  });
});

describe('listRuns：把历次运行摆在一起', () => {
  test('从任意一次运行都能列出全部，标出哪条是最初的', async () => {
    const platform = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'W9', contract: CONTRACT });
    await platform.rerunMission('W9');
    await platform.rerunMission('W9');

    for (const from of ['W9', 'W9#2', 'W9#3']) {
      const runs = await platform.listRuns(from);
      assert.deepEqual(
        runs.map((r) => r.missionId),
        ['W9', 'W9#2', 'W9#3'],
        `从 ${from} 问也该拿到同一份清单 —— 否则人得先知道哪条是源头才敢问`,
      );
      assert.deepEqual(runs.map((r) => r.isOriginal), [true, false, false]);
    }
  });

  test('结束原因按种类计数 —— 分类的价值就在这一格', async () => {
    const platform = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'W9', contract: CONTRACT });
    const a = await platform.startCoordinatorAttempt('W9');
    await platform.finishAttempt('W9', a.attemptId, { endedBy: 'killed_wall_clock' });
    const b = await platform.startCoordinatorAttempt('W9');
    await platform.finishAttempt('W9', b.attemptId, { endedBy: 'upstream_failure' });

    const [run] = await platform.listRuns('W9');
    // 以前这两跳都会是 upstream_failure，这一格永远只有一个数。
    assert.deepEqual(run.endedBy, { killed_wall_clock: 1, upstream_failure: 1 });
    assert.equal(run.coordinatorHops, 2);
  });

  test('「我们自己掐的」是一个能查的集合，不是散在各处的字符串比较', () => {
    // 调度器、CLI、以后的报表都要问同一个问题。各写各的 includes 迟早分叉：
    // 加第三种 killed_* 时，漏改的那一处不会报错，只会悄悄把它算成别人的锅。
    assert.ok(KILLED_BY_US.includes('killed_idle'));
    assert.ok(KILLED_BY_US.includes('killed_wall_clock'));
    assert.ok(!KILLED_BY_US.includes('upstream_failure'), '上游挂了不是我们掐的');
    assert.ok(!KILLED_BY_US.includes('platform_unreachable'));
  });
});
