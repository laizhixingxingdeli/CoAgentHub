import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Attempt,
  IllegalTransitionError,
  InvariantViolationError,
  KernelError,
  Project,
  WorkItem,
} from '../src/kernel/index.ts';

function dispatchableWorkItem(): WorkItem {
  const project = Project.create({ id: 'p-wi' });
  const mission = project.createMission({ id: 'm-wi' });
  mission.startExecuting();
  return mission.createWorkItem({ id: 'w-1', title: '写测试' });
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
    assert.equal(err.name, 'InvariantViolationError');
    return true;
  };
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

describe('WorkItem: 创建与字段', () => {
  test('由 Mission.createWorkItem 创建，初始 created，attempts 为空', () => {
    const item = dispatchableWorkItem();
    assert.ok(item instanceof WorkItem);
    assert.equal(item.id, 'w-1');
    assert.equal(item.missionId, 'm-wi');
    assert.equal(item.title, '写测试');
    assert.equal(item.status, 'created');
    assert.deepEqual(item.attempts, []);
  });

  test('attempts / workItems 返回的是副本，改不动聚合内部', () => {
    const item = dispatchableWorkItem();
    item.dispatch();
    const attempt = item.startAttempt();
    const copy = item.attempts as Attempt[];
    copy.push(attempt);
    copy.length = 0;
    assert.equal(item.attempts.length, 1);
    assert.equal(item.attempts[0], attempt);
  });
});

describe('WorkItem: 合法流转', () => {
  test('created -> dispatched -> submitted -> accepted', () => {
    const item = dispatchableWorkItem();
    item.dispatch();
    assert.equal(item.status, 'dispatched');
    item.submit({ files: ['a.ts'] });
    assert.equal(item.status, 'submitted');
    assert.deepEqual(item.result, { files: ['a.ts'] });
    assert.equal(item.hasResult, true);
    item.review('accept');
    assert.equal(item.status, 'accepted');
  });

  test('created -> dispatched -> submitted -> rejected -> dispatched（打回重做）', () => {
    const item = dispatchableWorkItem();
    item.dispatch();
    item.submit();
    item.review('reject');
    assert.equal(item.status, 'rejected');
    item.dispatch();
    assert.equal(item.status, 'dispatched');
  });

  test('submit() 可以不带动作参数；hasResult 反映是否提交过', () => {
    const item = dispatchableWorkItem();
    item.dispatch();
    assert.equal(item.hasResult, false);
    item.submit();
    assert.equal(item.status, 'submitted');
    assert.equal(item.result, undefined);
    assert.equal(item.hasResult, true);
  });
});

describe('WorkItem: 非法流转', () => {
  test('created 上 submit / review 都非法', () => {
    const item = dispatchableWorkItem();
    assert.throws(() => item.submit('x'), illegal('WorkItem', 'created', 'submitted'));
    assert.throws(() => item.review('accept'), illegal('WorkItem', 'created', 'accepted'));
    assert.equal(item.status, 'created');
  });

  test('dispatched 上 dispatch 非法（不能跳过 submit 重复派发）', () => {
    const item = dispatchableWorkItem();
    item.dispatch();
    assert.throws(() => item.dispatch(), illegal('WorkItem', 'dispatched', 'dispatched'));
  });

  test('submitted 上 dispatch / submit 非法', () => {
    const item = dispatchableWorkItem();
    item.dispatch();
    item.submit(1);
    assert.throws(() => item.dispatch(), illegal('WorkItem', 'submitted', 'dispatched'));
    assert.throws(() => item.submit(2), illegal('WorkItem', 'submitted', 'submitted'));
    assert.equal(item.status, 'submitted');
  });

  test('accepted 可以被重新打开（L3 打回），但只能走 dispatch 这一条路', () => {
    // 2026-09-15 改：原先 accepted 是终态，于是协调者被 L3 打回后只能
    // 为同一条意见另开新工作项——实测滚出三个工作项、七跳、$2.31。
    // L3 说"这份交付不行"时，组成它的那些验收本来就是暂时的。
    const item = dispatchableWorkItem();
    item.dispatch();
    item.submit();
    item.review('accept');

    // 除了重新派发，其它出口仍然关着。
    assert.throws(() => item.submit(), illegal('WorkItem', 'accepted', 'submitted'));
    assert.throws(() => item.review('reject'), illegal('WorkItem', 'accepted', 'rejected'));

    item.dispatch();
    assert.equal(item.status, 'dispatched');

    // **不变量 A 没被削弱**：重开之后想回到 accepted，还是得先 submit 再 review。
    assert.throws(() => item.review('accept'), illegal('WorkItem', 'dispatched', 'accepted'));
    item.submit();
    item.review('accept');
    assert.equal(item.status, 'accepted');
  });

  test('未知 verdict 也抛 IllegalTransitionError', () => {
    const item = dispatchableWorkItem();
    item.dispatch();
    item.submit();
    assert.throws(
      () => item.review('maybe' as 'accept'),
      illegal('WorkItem', 'submitted', 'maybe'),
    );
    assert.equal(item.status, 'submitted');
  });
});

describe('WorkItem: startAttempt', () => {
  test('只有 dispatched 上能开尝试', () => {
    const created = dispatchableWorkItem();
    assert.throws(() => created.startAttempt(), illegal('WorkItem', 'created', 'startAttempt'));

    const item = dispatchableWorkItem();
    item.dispatch();
    item.submit();
    assert.throws(() => item.startAttempt(), illegal('WorkItem', 'submitted', 'startAttempt'));

    item.review('accept');
    assert.throws(() => item.startAttempt(), illegal('WorkItem', 'accepted', 'startAttempt'));
  });

  test('开尝试不改变 WorkItem 状态', () => {
    const item = dispatchableWorkItem();
    item.dispatch();
    item.startAttempt();
    assert.equal(item.status, 'dispatched');
  });

  test('已有 in_progress 尝试时抛 CONCURRENT_EXECUTOR_ATTEMPT', () => {
    const item = dispatchableWorkItem();
    item.dispatch();
    const first = item.startAttempt();
    assert.throws(() => item.startAttempt(), invariant('CONCURRENT_EXECUTOR_ATTEMPT'));
    assert.equal(item.attempts.length, 1);
    first.succeed();
    const second = item.startAttempt();
    assert.equal(second.id, 'w-1.exec-2');
    assert.equal(item.attempts.length, 2);
  });

  test('上一次尝试 failed 之后可以再开（失败不占用并发名额）', () => {
    const item = dispatchableWorkItem();
    item.dispatch();
    item.startAttempt().fail('崩了');
    const retry = item.startAttempt();
    assert.equal(retry.status, 'in_progress');
    assert.equal(item.status, 'dispatched');
  });
});

describe('WorkItem: 封装', () => {
  test('status 赋值抛 TypeError（不变量 A 的机械化保证）', () => {
    const item = dispatchableWorkItem();
    assert.throws(() => {
      (item as unknown as Record<string, unknown>).status = 'accepted';
    }, TypeError);
    assert.equal(item.status, 'created');
    item.dispatch();
    assert.throws(() => {
      (item as unknown as Record<string, unknown>).status = 'accepted';
    }, TypeError);
    assert.equal(item.status, 'dispatched');
  });

  test('id / missionId / title / attempts / result 也不可直接写', () => {
    const item = dispatchableWorkItem();
    for (const key of ['id', 'missionId', 'title', 'attempts', 'result', 'hasResult']) {
      assert.throws(
        () => {
          (item as unknown as Record<string, unknown>)[key] = 'hacked';
        },
        TypeError,
        `assigning ${key} should throw TypeError`,
      );
    }
  });

  test('公开方法只有 dispatch / startAttempt / submit / review / recordBlocked', () => {
    // 没有 accept() / forceAccepted() 之类的后门：只有 review('accept') 能到 accepted。
    // recordBlocked 会流转，但只流到 blocked（逐项证明见 invariants.test.ts）。
    assert.deepEqual(publicMethodNames(WorkItem), [
      'dispatch',
      'recordBlocked',
      'review',
      'startAttempt',
      'submit',
      'toSnapshot',
    ]);
  });
});

describe('还没派发也能作废', () => {
  test('created -> blocked 合法 —— 作废的判据是工单成不成立，与派没派发无关', () => {
    // 实测撞到的：契约改了，协调者照新契约另拆了一批，旧的那批里有些
    // 还停在 created。早先 created 只能去 dispatched，于是"这张已经不算数了"
    // 非得等它被派出去才能表达——而那时执行者已经在跑了。
    const item = new WorkItem({ id: 'W-1', missionId: 'M1', title: 'W' });
    item.recordBlocked({
      attemptId: 'l3',
      reason: '契约改了，已被新工单取代',
      whatWasTried: [],
      needsFromUpstream: '重新判断要不要重做',
    });
    assert.equal(item.status, 'blocked');
    // 作废之后还能重新派发——它不是终态。
    assert.doesNotThrow(() => item.dispatch());
  });

  test('不变量 A 不受影响：到达 accepted 的路仍然只有 review(accept)', () => {
    const item = new WorkItem({ id: 'W-2', missionId: 'M1', title: 'W' });
    item.recordBlocked({
      attemptId: 'l3',
      reason: 'x',
      whatWasTried: [],
      needsFromUpstream: 'y',
    });
    // blocked 直接去 accepted 必须不行。
    assert.throws(() => item.review('accept'));
  });
});
