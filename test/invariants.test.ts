import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IllegalTransitionError,
  InvariantViolationError,
  Mission,
  Project,
  WorkItem,
} from '../src/kernel/index.ts';
import type { WorkOrder } from '../src/kernel/index.ts';

/** 同一 Project 下的兄弟 Mission 对，不变量 C 的用例场景。 */
function missionPair(): { project: Project; first: Mission; second: Mission; third: Mission } {
  const project = Project.create({ id: 'p-inv' });
  return {
    project,
    first: project.createMission({ id: 'm-first' }),
    second: project.createMission({ id: 'm-second' }),
    third: project.createMission({ id: 'm-third' }),
  };
}

/** 一个已派发的 WorkItem，用于验证「只记载荷」的方法不动状态。 */
function dispatchedWorkItem(): WorkItem {
  const project = Project.create({ id: 'p-wi' });
  const mission = project.createMission({ id: 'm-wi' });
  const item = mission.createWorkItem({ id: 'w-wi', title: 't' });
  item.dispatch();
  return item;
}

function invariant(code: string) {
  return (err: unknown) => {
    assert.ok(err instanceof InvariantViolationError, `got ${String(err)}`);
    assert.equal(err.code, code);
    assert.equal(err.name, 'InvariantViolationError');
    return true;
  };
}

function illegalMission(from: string, to: string) {
  return (err: unknown) => {
    assert.ok(err instanceof IllegalTransitionError, `got ${String(err)}`);
    assert.equal(err.code, 'ILLEGAL_TRANSITION');
    assert.equal(err.entity, 'Mission');
    assert.equal(err.from, from);
    assert.equal(err.to, to);
    return true;
  };
}

/** 造一个可派发的 WorkItem。 */
function dispatchedItem(id: string): WorkItem {
  const project = Project.create({ id: `p-${id}` });
  const mission = project.createMission({ id: `m-${id}` });
  mission.startExecuting();
  const item = mission.createWorkItem({ id, title: 't' });
  item.dispatch();
  return item;
}

/** 走 descriptor 收方法名，避免在 prototype 上误触发 getter。 */
function publicMethodNames(cls: { prototype: object }): string[] {
  const names: string[] = [];
  for (const key of Reflect.ownKeys(cls.prototype)) {
    if (key === 'constructor') continue;
    const desc = Object.getOwnPropertyDescriptor(cls.prototype, key);
    if (desc && typeof desc.value === 'function') names.push(String(key));
  }
  return names.sort();
}

describe('不变量 A：执行者路径不能验收', () => {
  test('dispatch -> submit 只到 submitted，review(accept) 才到 accepted', () => {
    const item = dispatchedItem('w-a');
    const attempt = item.startAttempt();
    attempt.succeed();

    // 执行者把自己的尝试标成 succeeded，也不会让 WorkItem 变成 accepted。
    assert.equal(attempt.status, 'succeeded');
    assert.equal(item.status, 'dispatched');

    item.submit({ diff: '...' });
    assert.equal(item.status, 'submitted');
    assert.notEqual(item.status, 'accepted');

    item.review('accept');
    assert.equal(item.status, 'accepted');
  });

  test('dispatch 后直接 review(accept) 抛 IllegalTransitionError', () => {
    const item = dispatchedItem('w-a2');
    assert.throws(
      () => item.review('accept'),
      (err: unknown) => {
        assert.ok(err instanceof IllegalTransitionError);
        assert.equal(err.code, 'ILLEGAL_TRANSITION');
        assert.equal(err.entity, 'WorkItem');
        assert.equal(err.from, 'dispatched');
        assert.equal(err.to, 'accepted');
        return true;
      },
    );
    assert.equal(item.status, 'dispatched');
  });

  test('Attempt 层面的成功/失败都到不了 accepted；只有 review("accept") 能', () => {
    const item = dispatchedItem('w-a3');
    const statuses: string[] = [];
    const record = (step: string) => {
      statuses.push(step);
      assert.notEqual(item.status, 'accepted', `${step} 之后不应该已经是 accepted`);
    };

    item.startAttempt().succeed();
    record('attempt.succeed');
    item.submit('artifact');
    record('submit');
    assert.equal(item.status, 'submitted');

    item.review('reject');
    record('review(reject)');
    assert.equal(item.status, 'rejected');

    item.dispatch();
    item.startAttempt().fail('重做时又崩了');
    record('attempt.fail');
    item.submit('artifact 2');
    record('submit 2');
    item.review('accept');
    assert.equal(item.status, 'accepted');
    assert.deepEqual(statuses, [
      'attempt.succeed',
      'submit',
      'review(reject)',
      'attempt.fail',
      'submit 2',
    ]);
  });

  test('WorkItem 的公开方法里只有 review 能把状态写成 accepted', () => {
    // **结构性判据，不是名单。**
    //
    // 原先这里锁的是公开方法名单，结果每次新增一个只读方法（toSnapshot、
    // recordBlocked……）都会把它弄红。一个每次良性新增都要改的守卫，迟早
    // 会被人随手改过去——那正是真问题溜进来的方式。
    //
    // 现在改成：**逐个调用除 dispatch/submit/review 之外的每一个公开方法，
    // 证明它们都动不了 status。** 新增方法不需要改这个测试；新增一个能偷偷
    // 改状态的方法会立刻红。
    // recordBlocked 在 2026-09-15 从"只记载荷"变成了真流转（dispatched ->
    // blocked）：让工作项留在 dispatched 会被调度器当成还在途，立刻再派一个
    // 执行者做同一张不成立的工单。这条守卫当场抓到了那次语义变化。
    // retire 在 2026-09-16 加进来，也是真流转（任意状态 -> retired）。
    // 这条守卫同样当场抓到了它——加方法的人必须显式声明"它会改状态"，
    // 而不是让它悄悄混进只读那一堆里。
    // 它到不了 accepted：流转表里 accepted 的入边只有 review('accept')。
    const stateChanging = new Set(['dispatch', 'submit', 'review', 'recordBlocked', 'retire']);
    const args: Record<string, unknown[]> = {
      startAttempt: [],
      toSnapshot: [],
      // reviseOrder 要一份满足 WorkOrder 格式的完整工单才谈得上"能不能改状态"。
      // 在 dispatched 上它必须被状态机拒绝（见下方 rejectedOnDispatched）。
      reviseOrder: [
        {
          objective: '守卫遍历用的一份合法工单',
          allowedScope: ['test/invariants.test.ts'],
          requiredBehaviour: '提供一个可被 reviseOrder 接受的工单载荷',
          constraints: [],
          acceptance: [],
          verification: [],
          doNot: [],
          contextRefs: [],
        } satisfies WorkOrder,
      ],
    };

    // 在 dispatched 上被状态机**直接拒绝**的公开方法：调用抛 IllegalTransitionError，
    // 连状态都没碰到，因此也算"改不了状态"。但必须逐个显式声明——
    // 否则以后新增一个方法，只要开头就抛个 IllegalTransitionError，
    // 就能悄悄混过下面"逐个调用证明改不了状态"这条守卫。
    const rejectedOnDispatched: Record<string, (err: unknown) => boolean> = {
      // reviseOrder 只在 created / rejected / blocked 生效（见 kernel 的注释）。
      // 在 dispatched 上拒绝，正是"它不是验收后门"的证据：它碰不到 status。
      reviseOrder: (err) => {
        assert.ok(err instanceof IllegalTransitionError, `got ${String(err)}`);
        assert.equal(err.code, 'ILLEGAL_TRANSITION');
        assert.equal(err.entity, 'WorkItem');
        assert.equal(err.from, 'dispatched');
        assert.equal(err.to, 'reviseOrder');
        return true;
      },
    };

    for (const name of publicMethodNames(WorkItem)) {
      if (stateChanging.has(name)) continue;
      assert.ok(name in args, `新公开方法 ${name} 没被这条守卫覆盖：补一组入参再跑`);
      const item = dispatchedWorkItem();
      const before = item.status;
      const invoke = () =>
        (item as unknown as Record<string, (...a: unknown[]) => unknown>)[name](
          ...(args[name] as unknown[]),
        );
      if (name in rejectedOnDispatched) {
        assert.throws(invoke, rejectedOnDispatched[name]);
      } else {
        invoke();
      }
      assert.equal(item.status, before, `${name} 不得改变 WorkItem 状态`);
      assert.notEqual(item.status, 'accepted', `${name} 不得把 WorkItem 写成 accepted`);
    }

    // recordBlocked 只能把状态推到 blocked，推不到 accepted。
    const blockedItem = dispatchedWorkItem();
    blockedItem.recordBlocked({
      attemptId: 'exec-1',
      reason: 'r',
      whatWasTried: [],
      needsFromUpstream: 'n',
    });
    assert.equal(blockedItem.status, 'blocked');

    // 而且 accepted 只能由 review('accept') 到达：submit 只到 submitted。
    const item = dispatchedWorkItem();
    item.submit({ outcome: 'completed' });
    assert.equal(item.status, 'submitted');
    item.review('accept');
    assert.equal(item.status, 'accepted');

    // 每个公开访问器都只有 getter（没有 status setter 这条后门）。
    for (const key of Reflect.ownKeys(WorkItem.prototype)) {
      if (key === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(WorkItem.prototype, key);
      if (desc && typeof desc.get === 'function') {
        assert.equal(desc.set, undefined, `WorkItem.${String(key)} 不应有 setter`);
      }
    }
  });
});

describe('不变量 B：同一 Mission 同一时刻只有一个 in_progress coordinator attempt', () => {
  test('第二个 in_progress 被拒绝；第一个结束（succeed / fail）之后可以再开', () => {
    const mission = Project.create({ id: 'p-b' }).createMission({ id: 'm-b' });

    const first = mission.startCoordinatorAttempt();
    assert.equal(first.id, 'coord-1');
    assert.equal(first.status, 'in_progress');
    assert.throws(() => mission.startCoordinatorAttempt(), invariant('CONCURRENT_COORDINATOR_ATTEMPT'));
    assert.equal(mission.coordinatorAttempts.length, 1);

    first.succeed();
    const second = mission.startCoordinatorAttempt();
    assert.equal(second.id, 'coord-2');
    assert.throws(() => mission.startCoordinatorAttempt(), invariant('CONCURRENT_COORDINATOR_ATTEMPT'));

    second.fail('换思路');
    assert.equal(mission.startCoordinatorAttempt().id, 'coord-3');
    assert.equal(mission.coordinatorAttempts.length, 3);
  });

  test('被拒绝的第二个 attempt 不入列，也不改变 Mission 状态', () => {
    const mission = Project.create({ id: 'p-b2' }).createMission({ id: 'm-b2' });
    mission.startCoordinatorAttempt();
    mission.startPlanning();
    assert.throws(() => mission.startCoordinatorAttempt(), invariant('CONCURRENT_COORDINATOR_ATTEMPT'));
    assert.equal(mission.status, 'planning');
    assert.equal(mission.coordinatorAttempts.length, 1);
  });

  test('不变量 B 只在 Mission 内部生效，跨 Mission 互不影响', () => {
    const { first, second, third } = missionPair();
    first.startCoordinatorAttempt();
    second.startCoordinatorAttempt();
    assert.equal(third.startCoordinatorAttempt().kind, 'coordinator');
    assert.equal(first.coordinatorAttempts.length, 1);
    assert.equal(second.coordinatorAttempts.length, 1);
    assert.equal(third.coordinatorAttempts.length, 1);
  });

  test('WorkItem 侧同理：同一 WorkItem 只能有一个 in_progress executor attempt', () => {
    const a = dispatchedItem('w-b3a');
    const b = dispatchedItem('w-b3b');
    a.startAttempt();
    assert.throws(() => a.startAttempt(), invariant('CONCURRENT_EXECUTOR_ATTEMPT'));
    // 另一个 WorkItem 的 executor attempt 不占用本 WorkItem 的名额。
    assert.equal(b.startAttempt().id, 'w-b3b.exec-1');
  });
});

describe('不变量 C：同一 Project 同一时刻只有一个 executing Mission', () => {
  test('兄弟已在 executing 时，第二个 startExecuting 被拒绝', () => {
    const { first, second } = missionPair();
    first.startExecuting();
    assert.equal(first.isMutating, true);

    assert.throws(() => second.startExecuting(), invariant('CONCURRENT_MUTATING_MISSION'));
    assert.equal(second.status, 'investigating');
    assert.equal(second.isMutating, false);
    assert.equal(second.workItems.length, 0);
  });

  test('名额握到终态为止：退回 planning / 等 L3 检视都不放', () => {
    // 语义在 2026-09-15 收紧过。原先只要离开 executing 就放名额，包括
    // 退回 planning 和交卷。但只要动过代码，分支上就有未合并的改动；
    // 这时放名额，下一条 Mission 会从看不见这些改动的基线上分叉，
    // 两边迟早撞车。判据改成「动过代码且还没到终态」。
    const a = Project.create({ id: 'p-hold' }).missions;
    void a;

    const project = Project.create({ id: 'p-hold2' });
    const first = project.createMission({ id: 'm-1' });
    const second = project.createMission({ id: 'm-2' });

    first.startExecuting();
    assert.equal(first.isMutating, true);

    first.startPlanning();
    assert.equal(first.isMutating, true, '退回 planning 不放名额：改动还在分支上');
    assert.throws(() => second.startExecuting(), invariant('CONCURRENT_MUTATING_MISSION'));

    first.submitForReview();
    assert.equal(first.isMutating, true, '等 L3 检视时不放名额：还没落地');
    assert.throws(() => second.startExecuting(), invariant('CONCURRENT_MUTATING_MISSION'));

    first.complete();
    assert.equal(first.isMutating, false, 'L3 放行、改动落地之后才放名额');
    second.startExecuting();
    assert.equal(second.status, 'executing');
  });

  test('park 保留历史、释放名额并在恢复时保留；冲突续跑不改变挂起状态', () => {
    const project = Project.create({ id: 'p-park' });
    const first = project.createMission({ id: 'm-park' });
    const second = project.createMission({ id: 'm-next' });
    first.startExecuting();
    const item = first.createWorkItem({ id: 'w-accepted', title: 'accepted' });
    item.dispatch();
    item.submit({ result: true });
    item.review('accept');

    first.park('等待用户答复');
    assert.equal(first.status, 'executing');
    assert.equal(first.hasMutated, true);
    assert.equal(first.workItems[0]?.status, 'accepted');
    assert.equal(first.isMutating, false);
    assert.equal(first.parkReason, '等待用户答复');
    const restored = Project.restore(project.toSnapshot()).missions[0]!;
    assert.equal(restored.isParked, true);
    assert.equal(restored.parkReason, '等待用户答复');
    assert.equal(restored.workItems[0]?.status, 'accepted');

    second.startExecuting();
    assert.throws(() => first.resume(), invariant('CONCURRENT_MUTATING_MISSION'));
    assert.equal(first.isParked, true);
    assert.equal(first.isPaused, false);
    second.block();
    first.resume();
    assert.equal(first.isParked, false);
    assert.equal(first.isMutating, true);
  });

  test('放弃也放名额', () => {
    const project = Project.create({ id: 'p-abandon' });
    const first = project.createMission({ id: 'm-1' });
    const second = project.createMission({ id: 'm-2' });
    first.startExecuting();
    first.submitForReview();
    first.block();
    assert.equal(first.isMutating, false);
    second.startExecuting();
  });

  test('从没动过代码的 Mission 不占名额', () => {
    const project = Project.create({ id: 'p-readonly' });
    const reader = project.createMission({ id: 'm-read' });
    const writer = project.createMission({ id: 'm-write' });
    reader.startPlanning();
    reader.submitForReview();
    assert.equal(reader.isMutating, false, '只调查没改代码，不该挡住别人');
    writer.startExecuting();
    assert.equal(writer.status, 'executing');
  });

  test('名额交接是单向的：前一个到终态之后，后一个才拿得到，且前一个拿不回来', () => {
    const { first, second } = missionPair();
    first.startExecuting();
    first.startPlanning();
    // 新语义：退回 planning 不放名额，所以 second 这时还抢不到。
    assert.throws(() => second.startExecuting(), invariant('CONCURRENT_MUTATING_MISSION'));

    first.submitForReview();
    first.complete();
    second.startExecuting();
    assert.equal(second.isMutating, true);

    // first 已经是终态，想拿回名额是非法流转（而不是不变量冲突）。
    assert.throws(() => first.startExecuting(), illegalMission('completed', 'executing'));
    assert.equal(second.isMutating, true);
  });

  test('investigating / planning 中的兄弟允许 startPlanning，但不允许 startExecuting', () => {
    const { first, second, third } = missionPair();
    first.startExecuting();

    second.startPlanning();
    assert.equal(second.status, 'planning');
    assert.throws(() => second.startExecuting(), invariant('CONCURRENT_MUTATING_MISSION'));
    assert.equal(second.status, 'planning');

    assert.equal(third.status, 'investigating');
    third.startPlanning();
    assert.equal(third.status, 'planning');
    assert.throws(() => third.startExecuting(), invariant('CONCURRENT_MUTATING_MISSION'));
    assert.equal(third.status, 'planning');

    // 同样允许的是 block / complete 之外的非 executing 流转。
    third.block();
    assert.equal(third.isMutating, false);
    assert.equal(first.isMutating, true);
  });

  test('investigating / planning 的 Mission 不占用 executing 名额', () => {
    const { first, second } = missionPair();
    second.startPlanning();
    first.startExecuting();
    assert.equal(first.isMutating, true);
    assert.equal(second.isMutating, false);
  });

  test('终态 Mission 不占名额；completed/blocked 上的 startExecuting 是非法流转', () => {
    const { first, second, third } = missionPair();
    first.startExecuting();
    first.submitForReview();
    first.complete();
    second.startExecuting();
    assert.throws(() => third.startExecuting(), invariant('CONCURRENT_MUTATING_MISSION'));
    assert.throws(() => first.startExecuting(), illegalMission('completed', 'executing'));
  });

  test('不同 Project 可以同时 executing', () => {
    const a = Project.create({ id: 'pa' }).createMission({ id: 'm' });
    const b = Project.create({ id: 'pb' }).createMission({ id: 'm' });
    a.startExecuting();
    b.startExecuting();
    assert.equal(a.isMutating, true);
    assert.equal(b.isMutating, true);
    assert.equal(a.projectId, 'pa');
    assert.equal(b.projectId, 'pb');
  });

  test('hasOtherMutatingMission 只看别的 Mission，忽略自己与未知 id', () => {
    const project = Project.create({ id: 'p-c' });
    const first = project.createMission({ id: 'm-1' });
    const second = project.createMission({ id: 'm-2' });
    assert.equal(project.hasOtherMutatingMission('m-1'), false);
    first.startExecuting();
    assert.equal(project.hasOtherMutatingMission('m-1'), false, '自己不算');
    assert.equal(project.hasOtherMutatingMission('m-2'), true);
    assert.equal(project.hasOtherMutatingMission('m-none'), true);
    first.submitForReview();
    first.complete();
    assert.equal(project.hasOtherMutatingMission('m-2'), false);
    assert.equal(second.status, 'investigating');
  });
});

describe('Attempt 失败 ≠ WorkItem 失败', () => {
  test('两次 Attempt：fail 之后 WorkItem 仍是 dispatched，可再试并 submit', () => {
    const item = dispatchedItem('w-retry');

    const first = item.startAttempt();
    first.fail('环境缺依赖');
    assert.equal(first.status, 'failed');
    assert.equal(first.failReason, '环境缺依赖');
    assert.equal(item.status, 'dispatched', 'Attempt 失败不改变 WorkItem 状态');

    const second = item.startAttempt();
    assert.notEqual(second, first);
    second.succeed();
    assert.equal(item.status, 'dispatched');

    item.submit({ ok: true });
    assert.equal(item.status, 'submitted');
    assert.deepEqual(item.result, { ok: true });

    assert.equal(item.attempts.length, 2);
    assert.deepEqual(
      item.attempts.map((attempt) => attempt.id),
      ['w-retry.exec-1', 'w-retry.exec-2'],
    );
    assert.deepEqual(
      item.attempts.map((attempt) => attempt.status),
      ['failed', 'succeeded'],
    );
    assert.deepEqual(
      item.attempts.map((attempt) => attempt.workItemId),
      ['w-retry', 'w-retry'],
    );
  });

  test('全部 Attempt 都失败也不会把 WorkItem 推入任何失败/终态', () => {
    const item = dispatchedItem('w-all-fail');
    for (let i = 0; i < 3; i += 1) {
      const attempt = item.startAttempt();
      attempt.fail('again');
      assert.equal(attempt.status, 'failed');
      assert.equal(item.status, 'dispatched');
      assert.notEqual(item.status, 'rejected');
      assert.notEqual(item.status, 'accepted');
    }
    // 仍然可以交付并走正常验收。
    item.submit();
    item.review('accept');
    assert.equal(item.status, 'accepted');
    assert.equal(item.attempts.length, 3);
  });

  test('单次 Attempt 失败也不影响 Mission 状态', () => {
    const project = Project.create({ id: 'p-mission-status' });
    const mission = project.createMission({ id: 'm-status' });
    mission.startExecuting();
    const item = mission.createWorkItem({ id: 'w-status', title: 't' });
    item.dispatch();
    item.startAttempt().fail('炸了');
    assert.equal(mission.status, 'executing');
    assert.equal(mission.isMutating, true);
    item.submit();
    assert.equal(mission.status, 'executing');
  });

  test('rejected 之后重做：回到 dispatched 并可开新的 Attempt', () => {
    const item = dispatchedItem('w-rework');
    item.startAttempt().succeed();
    item.submit('v1');
    item.review('reject');
    assert.equal(item.status, 'rejected');

    item.dispatch();
    const second = item.startAttempt();
    assert.ok(second.id.endsWith('.exec-2'), second.id);
    second.fail('还是不行');
    assert.equal(item.status, 'dispatched');
    item.submit('v2');
    assert.equal(item.status, 'submitted');
  });

  test('WorkItem 没有 failed 状态可言，也不能被强行写状态', () => {
    const item = Project.create({ id: 'p-nofailed' })
      .createMission({ id: 'm-nofailed' })
      .createWorkItem({ id: 'w', title: 't' });

    for (const forced of ['failed', 'accepted', 'done'] as const) {
      assert.throws(
        () => {
          (item as unknown as Record<string, unknown>).status = forced;
        },
        TypeError,
        `status = ${forced}`,
      );
    }
    assert.equal(item.status, 'created');
    assert.ok(item instanceof WorkItem);
  });
});
