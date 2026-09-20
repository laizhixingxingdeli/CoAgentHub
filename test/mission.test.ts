import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IllegalTransitionError,
  InvariantViolationError,
  KernelError,
  Mission,
  Project,
  WorkItem,
} from '../src/kernel/index.ts';

function freshMission(): Mission {
  return Project.create({ id: 'p-m' }).createMission({ id: 'm-1' });
}

function illegal(entity: string, from: string, to: string) {
  return (err: unknown) => {
    assert.ok(err instanceof IllegalTransitionError, `got ${String(err)}`);
    assert.ok(err instanceof KernelError);
    assert.equal(err.code, 'ILLEGAL_TRANSITION');
    assert.equal(err.name, 'IllegalTransitionError');
    assert.equal(err.entity, entity);
    assert.equal(err.from, from);
    assert.equal(err.to, to);
    return true;
  };
}

function invariant(code: string) {
  return (err: unknown) => {
    assert.ok(err instanceof InvariantViolationError, `got ${String(err)}`);
    assert.ok(err instanceof KernelError);
    assert.equal(err.code, code);
    return true;
  };
}

describe('Project / Mission: 创建', () => {
  test('Project.create 与 createMission 建好链接，Mission 初始 investigating', () => {
    const project = Project.create({ id: 'p-1' });
    assert.equal(project.id, 'p-1');
    assert.deepEqual(project.missions, []);

    const mission = project.createMission({ id: 'm-1' });
    assert.ok(mission instanceof Mission);
    assert.equal(mission.id, 'm-1');
    assert.equal(mission.projectId, 'p-1');
    assert.equal(mission.status, 'investigating');
    assert.equal(mission.isMutating, false);
    assert.deepEqual(mission.workItems, []);
    assert.deepEqual(mission.coordinatorAttempts, []);
    assert.equal(project.missions.length, 1);
    assert.equal(project.missions[0], mission);
  });

  test('同一 Project 里重复 mission id 抛 DUPLICATE_ID', () => {
    const project = Project.create({ id: 'p-dup' });
    project.createMission({ id: 'm-dup' });
    assert.throws(() => project.createMission({ id: 'm-dup' }), invariant('DUPLICATE_ID'));
    assert.equal(project.missions.length, 1);
  });

  test('不同 Project 之间 id 可以相同', () => {
    const a = Project.create({ id: 'pa' }).createMission({ id: 'same' });
    const b = Project.create({ id: 'pb' }).createMission({ id: 'same' });
    assert.equal(a.projectId, 'pa');
    assert.equal(b.projectId, 'pb');
  });

  test('missions / workItems / coordinatorAttempts 是副本', () => {
    const project = Project.create({ id: 'p-copy' });
    const mission = project.createMission({ id: 'm-copy' });
    mission.createWorkItem({ id: 'w-1', title: 't' });

    (project.missions as Mission[]).push(mission);
    (mission.workItems as WorkItem[]).pop();
    assert.equal(project.missions.length, 1);
    assert.equal(mission.workItems.length, 1);
    assert.equal(mission.coordinatorAttempts.length, 0);
  });

  test('Project.id / Mission.id 等字段不可写', () => {
    const project = Project.create({ id: 'p-ro' });
    const mission = project.createMission({ id: 'm-ro' });
    for (const key of ['id', 'missions']) {
      assert.throws(
        () => {
          (project as unknown as Record<string, unknown>)[key] = 'x';
        },
        TypeError,
        `Project.${key}`,
      );
    }
    for (const key of [
      'id',
      'projectId',
      'status',
      'isMutating',
      'workItems',
      'coordinatorAttempts',
      'executionMode',
    ]) {
      assert.throws(
        () => {
          (mission as unknown as Record<string, unknown>)[key] = 'x';
        },
        TypeError,
        `Mission.${key}`,
      );
    }
  });
});

describe('Mission: executionMode', () => {
  test('新建默认 standard，快照写出 concrete standard', () => {
    const mission = freshMission();
    assert.equal(mission.executionMode, 'standard');
    assert.equal(mission.toSnapshot().executionMode, 'standard');
  });

  test('Project.createMission 各显式档位 getter/snapshot 一致', () => {
    for (const mode of ['lightweight', 'standard', 'high_assurance'] as const) {
      const mission = Project.create({ id: `p-em-${mode}` }).createMission({
        id: `m-${mode}`,
        executionMode: mode,
      });
      assert.equal(mission.executionMode, mode);
      assert.equal(mission.toSnapshot().executionMode, mode);
    }
  });

  test('老快照缺字段 restore -> standard，后续 snapshot 显式 standard', () => {
    const project = Project.create({ id: 'p-em-old' });
    const base = project.createMission({ id: 'm-old' });
    const snap = base.toSnapshot();
    delete snap.executionMode;
    const restored = Mission.restore(snap, project);
    assert.equal(restored.executionMode, 'standard');
    assert.equal(restored.toSnapshot().executionMode, 'standard');
  });

  test('lightweight / high_assurance 往返保留', () => {
    for (const mode of ['lightweight', 'high_assurance'] as const) {
      const project = Project.create({ id: `p-rt-${mode}` });
      const mission = project.createMission({ id: `m-rt-${mode}`, executionMode: mode });
      const restored = Mission.restore(mission.toSnapshot(), project);
      assert.equal(restored.executionMode, mode);
      assert.equal(restored.toSnapshot().executionMode, mode);
    }
  });

  test("损坏 'nope' 与 null restore -> standard", () => {
    const project = Project.create({ id: 'p-em-bad' });
    const base = project.createMission({ id: 'm-bad' });
    for (const bad of ['nope', null] as const) {
      const snap = base.toSnapshot();
      (snap as { executionMode?: unknown }).executionMode = bad as never;
      const restored = Mission.restore(snap, project);
      assert.equal(restored.executionMode, 'standard');
    }
  });
});

describe('Mission: 合法流转', () => {
  test('investigating -> planning -> executing -> awaiting_review -> completed', () => {
    const mission = freshMission();
    mission.startPlanning();
    assert.equal(mission.status, 'planning');
    mission.startExecuting();
    assert.equal(mission.status, 'executing');
    assert.equal(mission.isMutating, true);
    // 交卷只到 awaiting_review：没经过 L3 检视不算完成，改动也还没落地。
    mission.submitForReview();
    assert.equal(mission.status, 'awaiting_review');
    assert.equal(mission.isMutating, true, '等检视时名额仍然握着');
    mission.complete();
    assert.equal(mission.status, 'completed');
    assert.equal(mission.isMutating, false);
  });

  test('investigating 可以直接 executing', () => {
    const mission = freshMission();
    mission.startExecuting();
    assert.equal(mission.status, 'executing');
  });

  test('executing 可以退回 planning，但名额不放', () => {
    const mission = freshMission();
    mission.startExecuting();
    mission.startPlanning();
    assert.equal(mission.status, 'planning');
    // 动过代码就一直占着名额，直到落地或放弃：分支上的改动还在。
    assert.equal(mission.isMutating, true);
  });

  test('investigating / planning / executing 都能 block', () => {
    for (const path of [
      [],
      ['startPlanning'],
      ['startPlanning', 'startExecuting'],
      ['startExecuting'],
    ] as const) {
      const mission = freshMission();
      for (const step of path) mission[step]();
      mission.block();
      assert.equal(mission.status, 'blocked');
      assert.equal(mission.isMutating, false);
    }
  });
});

describe('Mission: 非法流转', () => {
  test('调查/规划阶段可以直接交给 L3 检视：查完发现不用改代码是正常结局', () => {
    // 这条在 2026-09-15 建平台时改过。原先禁止 investigating/planning ->
    // completed，理由是「complete 表示改动完成」。但 Mission 是一次用户目标，
    // 交出一个有据可依的结论也算达成；强迫它先走一遍 executing 只会制造假的
    // 改动阶段。关键不变式仍在：这种 Mission 从不占用不变量 C 的名额。
    const direct = freshMission();
    direct.submitForReview();
    assert.equal(direct.status, 'awaiting_review');
    direct.complete();
    assert.equal(direct.status, 'completed');
    assert.equal(direct.isMutating, false, '没改过代码的 Mission 不该占用改动名额');

    const afterPlanning = freshMission();
    afterPlanning.startPlanning();
    afterPlanning.submitForReview();
    afterPlanning.complete();
    assert.equal(afterPlanning.status, 'completed');
  });

  test('终态没有任何出边', () => {
    const done = freshMission();
    done.submitForReview();
    done.complete();
    assert.throws(() => done.startPlanning(), illegal('Mission', 'completed', 'planning'));
    assert.throws(() => done.startExecuting(), illegal('Mission', 'completed', 'executing'));
    assert.throws(() => done.block(), illegal('Mission', 'completed', 'blocked'));

    const stopped = freshMission();
    stopped.block();
    assert.throws(() => stopped.complete(), illegal('Mission', 'blocked', 'completed'));
  });

  test('planning -> planning 非法', () => {
    const mission = freshMission();
    mission.startPlanning();
    assert.throws(() => mission.startPlanning(), illegal('Mission', 'planning', 'planning'));
  });

  test('executing -> executing 非法（且优先于不变量 C）', () => {
    const mission = freshMission();
    mission.startExecuting();
    assert.throws(() => mission.startExecuting(), illegal('Mission', 'executing', 'executing'));
  });

  test('completed 是终态：任何状态操作都抛 IllegalTransitionError', () => {
    const mission = freshMission();
    mission.startExecuting();
    mission.submitForReview();
    mission.complete();

    assert.throws(() => mission.startPlanning(), illegal('Mission', 'completed', 'planning'));
    assert.throws(() => mission.startExecuting(), illegal('Mission', 'completed', 'executing'));
    assert.throws(() => mission.complete(), illegal('Mission', 'completed', 'completed'));
    assert.throws(() => mission.block(), illegal('Mission', 'completed', 'blocked'));
    assert.throws(
      () => mission.startCoordinatorAttempt(),
      illegal('Mission', 'completed', 'startCoordinatorAttempt'),
    );
    assert.throws(
      () => mission.createWorkItem({ id: 'w-late', title: 't' }),
      illegal('Mission', 'completed', 'createWorkItem'),
    );
    assert.deepEqual(mission.workItems, []);
  });

  test('blocked 是终态', () => {
    const mission = freshMission();
    mission.block();
    assert.throws(() => mission.startPlanning(), illegal('Mission', 'blocked', 'planning'));
    assert.throws(() => mission.startExecuting(), illegal('Mission', 'blocked', 'executing'));
    assert.throws(() => mission.complete(), illegal('Mission', 'blocked', 'completed'));
    assert.throws(() => mission.block(), illegal('Mission', 'blocked', 'blocked'));
    assert.throws(
      () => mission.startCoordinatorAttempt(),
      illegal('Mission', 'blocked', 'startCoordinatorAttempt'),
    );
    assert.throws(
      () => mission.createWorkItem({ id: 'w-late', title: 't' }),
      illegal('Mission', 'blocked', 'createWorkItem'),
    );
  });
});

describe('Mission: createWorkItem', () => {
  test('建出的 WorkItem 挂到本 Mission 上，初始 created', () => {
    const mission = freshMission();
    const item = mission.createWorkItem({ id: 'w-7', title: '跑通测试' });
    assert.equal(item.id, 'w-7');
    assert.equal(item.missionId, mission.id);
    assert.equal(item.status, 'created');
    assert.equal(mission.workItems.length, 1);
    assert.equal(mission.workItems[0], item);
  });

  test('investigating / planning / executing 上都能建 WorkItem', () => {
    const mission = freshMission();
    mission.createWorkItem({ id: 'w-a', title: 'a' });
    mission.startPlanning();
    mission.createWorkItem({ id: 'w-b', title: 'b' });
    mission.startExecuting();
    mission.createWorkItem({ id: 'w-c', title: 'c' });
    assert.equal(mission.workItems.length, 3);
  });

  test('同一 Mission 内 workItem id 重复抛 DUPLICATE_ID', () => {
    const mission = freshMission();
    mission.createWorkItem({ id: 'w-dup', title: 'a' });
    assert.throws(
      () => mission.createWorkItem({ id: 'w-dup', title: 'b' }),
      invariant('DUPLICATE_ID'),
    );
    assert.equal(mission.workItems.length, 1);
  });

  test('不同 Mission 的 workItem id 互不影响', () => {
    const project = Project.create({ id: 'p-wi-scope' });
    const m1 = project.createMission({ id: 'm1' });
    const m2 = project.createMission({ id: 'm2' });
    m1.createWorkItem({ id: 'w-shared', title: 'a' });
    m2.createWorkItem({ id: 'w-shared', title: 'b' });
    assert.equal(m1.workItems[0].missionId, 'm1');
    assert.equal(m2.workItems[0].missionId, 'm2');
  });
});

describe('Mission: coordinator attempt 归属', () => {
  test('startCoordinatorAttempt 记录到 coordinatorAttempts，不影响 workItems', () => {
    const mission = freshMission();
    const attempt = mission.startCoordinatorAttempt();
    assert.equal(mission.coordinatorAttempts.length, 1);
    assert.equal(mission.coordinatorAttempts[0], attempt);
    assert.deepEqual(mission.workItems, []);
    assert.equal(mission.status, 'investigating');
  });

  test('executor attempt 不会出现在 coordinatorAttempts 里', () => {
    const mission = freshMission();
    mission.startExecuting();
    const item = mission.createWorkItem({ id: 'w-x', title: 't' });
    item.dispatch();
    item.startAttempt();
    assert.deepEqual(mission.coordinatorAttempts, []);
    assert.equal(item.attempts.length, 1);
  });
});
