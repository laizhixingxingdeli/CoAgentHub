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
import type { WorkOrder } from '../src/kernel/index.ts';

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

describe('WorkItem: submittedAttemptId provenance', () => {
  test('默认 undefined；submit 未传 attempt id 仍是 undefined', () => {
    const item = dispatchableWorkItem();
    assert.equal(item.submittedAttemptId, undefined);
    item.dispatch();
    item.submit({ files: ['a.ts'] });
    assert.equal(item.submittedAttemptId, undefined);
    assert.equal(item.toSnapshot().submittedAttemptId, undefined);
  });

  test('submit(result, attemptId) 后 getter/snapshot 等于该值', () => {
    const item = dispatchableWorkItem();
    item.dispatch();
    item.submit({ files: ['a.ts'] }, 'W-1.exec-2');
    assert.equal(item.submittedAttemptId, 'W-1.exec-2');
    assert.equal(item.toSnapshot().submittedAttemptId, 'W-1.exec-2');
  });

  test('reject → redispatch → 第二次 submit 覆盖为新 attempt id', () => {
    const item = dispatchableWorkItem();
    item.dispatch();
    item.submit({ v: 1 }, 'w-1.exec-1');
    assert.equal(item.submittedAttemptId, 'w-1.exec-1');
    item.review('reject');
    item.dispatch();
    item.submit({ v: 2 }, 'w-1.exec-2');
    assert.equal(item.submittedAttemptId, 'w-1.exec-2');
    assert.equal(item.toSnapshot().submittedAttemptId, 'w-1.exec-2');
  });

  test('restore 老 snapshot 无字段 => undefined，不猜 attempts', () => {
    const item = dispatchableWorkItem();
    item.dispatch();
    const attempt = item.startAttempt();
    attempt.succeed();
    item.submit({ files: ['a.ts'] }, 'should-not-leak-via-attempts');
    const snap = item.toSnapshot();
    // 模拟老快照：有 attempts / result，但没有 submittedAttemptId 字段。
    const { submittedAttemptId: _drop, ...legacy } = snap;
    assert.equal('submittedAttemptId' in legacy, false);
    const restored = WorkItem.restore(legacy as typeof snap);
    assert.equal(restored.submittedAttemptId, undefined);
    assert.equal(restored.attempts.length, 1, 'attempts 仍在，但 provenance 不从它猜');
    assert.equal(restored.hasResult, true);
    assert.equal(restored.toSnapshot().submittedAttemptId, undefined);
  });

  test('restore 原样恢复已有 submittedAttemptId', () => {
    const item = dispatchableWorkItem();
    item.dispatch();
    item.submit({ ok: true }, 'w-1.exec-3');
    const restored = WorkItem.restore(item.toSnapshot());
    assert.equal(restored.submittedAttemptId, 'w-1.exec-3');
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

  test('id / missionId / title / attempts / result / submittedAttemptId 也不可直接写', () => {
    const item = dispatchableWorkItem();
    for (const key of [
      'id',
      'missionId',
      'title',
      'attempts',
      'result',
      'hasResult',
      'submittedAttemptId',
    ]) {
      assert.throws(
        () => {
          (item as unknown as Record<string, unknown>)[key] = 'hacked';
        },
        TypeError,
        `assigning ${key} should throw TypeError`,
      );
    }
  });

  test('公开方法只有 dispatch / startAttempt / submit / review / recordBlocked / retire', () => {
    // 没有 accept() / forceAccepted() 之类的后门：只有 review('accept') 能到 accepted。
    // recordBlocked 与 retire 都会流转，但一个只到 blocked、一个只到 retired
    // （逐项证明见 invariants.test.ts）。
    assert.deepEqual(publicMethodNames(WorkItem), [
      'dispatch',
      'recordBlocked',
      'retire',
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

const BASE_ORDER: WorkOrder = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
};

describe('WorkOrder.validation 合同', () => {
  test('legacy WorkOrder 无 validation：行为不变', () => {
    const item = new WorkItem({
      id: 'W-leg',
      missionId: 'M1',
      title: 'legacy',
      order: { ...BASE_ORDER },
    });
    assert.equal(item.order?.objective, BASE_ORDER.objective);
    assert.equal(item.order?.validation, undefined);
    assert.equal('validation' in (item.order as object), false);
  });

  test('合法 validation round-trip；argv/commands/validation 深冻结且 input-mutation-safe', () => {
    const argv = ['node', '--test'];
    const commands = [{ argv, timeoutMs: 30_000 }];
    const validation = { commands };
    const order: WorkOrder = { ...BASE_ORDER, validation };
    const item = new WorkItem({
      id: 'W-val',
      missionId: 'M1',
      title: 'with validation',
      order,
    });

    assert.deepEqual(item.order?.validation, {
      commands: [{ argv: ['node', '--test'], timeoutMs: 30_000 }],
    });

    // 调用方事后改输入不得污染 item.order
    argv.push('--hack');
    commands.push({ argv: ['rm', '-rf', '/'], timeoutMs: 1 });
    (validation as { commands: unknown }).commands = [];
    assert.deepEqual(item.order?.validation?.commands, [
      { argv: ['node', '--test'], timeoutMs: 30_000 },
    ]);

    // 深冻结
    assert.ok(Object.isFrozen(item.order));
    assert.ok(Object.isFrozen(item.order!.validation));
    assert.ok(Object.isFrozen(item.order!.validation!.commands));
    assert.ok(Object.isFrozen(item.order!.validation!.commands[0]));
    assert.ok(Object.isFrozen(item.order!.validation!.commands[0].argv));
    assert.throws(() => {
      (item.order!.validation!.commands as unknown as unknown[]).push({});
    }, TypeError);
    assert.throws(() => {
      (item.order!.validation!.commands[0].argv as unknown as string[]).push('x');
    }, TypeError);

    // 空 commands 合法
    const empty = new WorkItem({
      id: 'W-empty-cmd',
      missionId: 'M1',
      title: 'empty commands',
      order: { ...BASE_ORDER, validation: { commands: [] } },
    });
    assert.deepEqual(empty.order?.validation?.commands, []);
    assert.ok(Object.isFrozen(empty.order!.validation!.commands));
  });

  test('cwd / 未知 key / 空 argv / 空字符串 argv / bad timeout 全拒绝且不创建 item', () => {
    const cases: Array<{ label: string; validation: unknown }> = [
      {
        label: 'cwd on command',
        validation: {
          commands: [{ argv: ['node', '--test'], timeoutMs: 1000, cwd: '/tmp' }],
        },
      },
      {
        label: 'unknown key on validation',
        validation: { commands: [], shell: true },
      },
      {
        label: 'unknown key on command',
        validation: {
          commands: [{ argv: ['node'], timeoutMs: 1000, env: {} }],
        },
      },
      {
        label: 'empty argv',
        validation: { commands: [{ argv: [], timeoutMs: 1000 }] },
      },
      {
        label: 'empty string in argv',
        validation: { commands: [{ argv: ['node', ''], timeoutMs: 1000 }] },
      },
      {
        label: 'timeout 0',
        validation: { commands: [{ argv: ['node'], timeoutMs: 0 }] },
      },
      {
        label: 'timeout negative',
        validation: { commands: [{ argv: ['node'], timeoutMs: -1 }] },
      },
      {
        label: 'timeout NaN',
        validation: { commands: [{ argv: ['node'], timeoutMs: Number.NaN }] },
      },
      {
        label: 'timeout Infinity',
        validation: {
          commands: [{ argv: ['node'], timeoutMs: Number.POSITIVE_INFINITY }],
        },
      },
      {
        label: 'timeout decimal',
        validation: { commands: [{ argv: ['node'], timeoutMs: 1.5 }] },
      },
    ];

    for (const c of cases) {
      assert.throws(
        () =>
          new WorkItem({
            id: `W-bad-${c.label}`,
            missionId: 'M1',
            title: c.label,
            order: { ...BASE_ORDER, validation: c.validation as WorkOrder['validation'] },
          }),
        invariant('INVALID_WORK_ORDER_VALIDATION'),
        c.label,
      );
    }

    // Mission.createWorkItem 失败时不得留下污染的 work item
    const project = Project.create({ id: 'p-val' });
    const mission = project.createMission({ id: 'm-val' });
    mission.startExecuting();
    assert.throws(
      () =>
        mission.createWorkItem({
          id: 'w-bad',
          title: 'bad',
          order: {
            ...BASE_ORDER,
            validation: {
              commands: [{ argv: ['node'], timeoutMs: 1, cwd: '.' } as never],
            },
          },
        }),
      invariant('INVALID_WORK_ORDER_VALIDATION'),
    );
    assert.equal(mission.workItems.length, 0);
  });

  test('restore malformed validation => drop validation，其余 order 保留；legacy 仍恢复', () => {
    const good = new WorkItem({
      id: 'W-r1',
      missionId: 'M1',
      title: 'r',
      order: {
        ...BASE_ORDER,
        validation: { commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }] },
      },
    });
    good.dispatch();
    const snap = good.toSnapshot();

    // 合法 validation 重建/冻结
    const restoredGood = WorkItem.restore(snap);
    assert.deepEqual(restoredGood.order?.validation, {
      commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }],
    });
    assert.ok(Object.isFrozen(restoredGood.order!.validation!.commands[0].argv));

    // malformed：含 cwd
    const badSnap = {
      ...snap,
      order: {
        ...BASE_ORDER,
        objective: 'preserved-objective',
        validation: {
          commands: [{ argv: ['node'], timeoutMs: 1000, cwd: '/evil' }],
        },
      },
    };
    const restoredBad = WorkItem.restore(badSnap as ReturnType<WorkItem['toSnapshot']>);
    assert.equal(restoredBad.order?.objective, 'preserved-objective');
    assert.deepEqual(restoredBad.order?.allowedScope, BASE_ORDER.allowedScope);
    assert.equal(restoredBad.order?.validation, undefined);

    // legacy 无 validation
    const legacy = WorkItem.restore({
      ...snap,
      order: { ...BASE_ORDER },
    } as ReturnType<WorkItem['toSnapshot']>);
    assert.equal(legacy.order?.validation, undefined);
    assert.equal(legacy.order?.objective, BASE_ORDER.objective);
  });
});

describe('ReviewRecord 审计语义', () => {
  function submittedItem(): WorkItem {
    const item = dispatchableWorkItem();
    item.dispatch();
    item.submit({ ok: true }, 'w-1.exec-1');
    return item;
  }

  test('legacy ReviewRecord {attemptId,...} 写入与 restore 原样', () => {
    const item = submittedItem();
    item.review('accept', {
      attemptId: 'coord-1',
      reasons: ['ok'],
      requiredChanges: [],
    });
    const last = item.reviews[0];
    assert.equal(last.attemptId, 'coord-1');
    assert.equal(last.submittedAttemptId, undefined);
    assert.equal(last.authority, undefined);
    assert.equal(last.verdict, 'accept');

    const restored = WorkItem.restore(item.toSnapshot());
    assert.deepEqual(restored.reviews[0], last);
    assert.equal(restored.reviews[0].attemptId, 'coord-1');
  });

  test('validator review：omit attemptId + submittedAttemptId + authority 可写入/快照/restore，嵌套不可变', () => {
    const item = submittedItem();
    const reasons = ['machine pass'];
    const requiredChanges: string[] = [];
    const authority = {
      kind: 'validator' as const,
      reportId: 'vr-1',
      policyRevision: 3,
    };
    item.review('accept', {
      submittedAttemptId: 'w-1.exec-1',
      authority,
      reasons,
      requiredChanges,
    });

    const last = item.reviews[0];
    assert.equal(last.attemptId, undefined);
    assert.equal(last.submittedAttemptId, 'w-1.exec-1');
    assert.deepEqual(last.authority, {
      kind: 'validator',
      reportId: 'vr-1',
      policyRevision: 3,
    });

    // input mutation safety
    reasons.push('hack');
    requiredChanges.push('hack');
    (authority as { reportId: string }).reportId = 'mutated';
    assert.deepEqual(last.reasons, ['machine pass']);
    assert.deepEqual(last.requiredChanges, []);
    assert.equal(
      last.authority && last.authority.kind === 'validator' ? last.authority.reportId : '',
      'vr-1',
    );

    assert.ok(Object.isFrozen(last));
    assert.ok(Object.isFrozen(last.reasons));
    assert.ok(Object.isFrozen(last.requiredChanges));
    assert.ok(Object.isFrozen(last.authority));

    const restored = WorkItem.restore(item.toSnapshot());
    assert.equal(restored.reviews[0].attemptId, undefined);
    assert.equal(restored.reviews[0].submittedAttemptId, 'w-1.exec-1');
    assert.deepEqual(restored.reviews[0].authority, {
      kind: 'validator',
      reportId: 'vr-1',
      policyRevision: 3,
    });
    assert.ok(Object.isFrozen(restored.reviews[0].authority));
  });

  test('无 attemptId 且无 validator authority => 拒绝；状态/reviews 不污染', () => {
    const item = submittedItem();
    assert.throws(
      () =>
        item.review('accept', {
          reasons: ['x'],
          requiredChanges: [],
        }),
      invariant('INVALID_REVIEW_RECORD'),
    );
    assert.equal(item.status, 'submitted');
    assert.equal(item.reviews.length, 0);

    assert.throws(
      () =>
        item.review('accept', {
          authority: { kind: 'coordinator', attemptId: 'c-1' },
          reasons: ['x'],
          requiredChanges: [],
        }),
      invariant('INVALID_REVIEW_RECORD'),
    );
    assert.equal(item.status, 'submitted');
  });

  test('validator 缺 submittedAttemptId / bad reportId / bad policyRevision => 拒绝', () => {
    const item = submittedItem();

    assert.throws(
      () =>
        item.review('accept', {
          authority: { kind: 'validator', reportId: 'r1', policyRevision: 1 },
          reasons: [],
          requiredChanges: [],
        }),
      invariant('INVALID_REVIEW_RECORD'),
    );

    assert.throws(
      () =>
        item.review('accept', {
          submittedAttemptId: 'w-1.exec-1',
          authority: { kind: 'validator', reportId: '', policyRevision: 1 },
          reasons: [],
          requiredChanges: [],
        }),
      invariant('INVALID_REVIEW_RECORD'),
    );

    for (const policyRevision of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () =>
          item.review('accept', {
            submittedAttemptId: 'w-1.exec-1',
            authority: {
              kind: 'validator',
              reportId: 'r1',
              policyRevision,
            },
            reasons: [],
            requiredChanges: [],
          }),
        invariant('INVALID_REVIEW_RECORD'),
      );
    }

    assert.equal(item.status, 'submitted');
    assert.equal(item.reviews.length, 0);

    // policyRevision 0 合法
    item.review('accept', {
      submittedAttemptId: 'w-1.exec-1',
      authority: { kind: 'validator', reportId: 'r0', policyRevision: 0 },
      reasons: ['ok'],
      requiredChanges: [],
    });
    assert.equal(item.status, 'accepted');
    assert.equal(
      item.reviews[0].authority && item.reviews[0].authority.kind === 'validator'
        ? item.reviews[0].authority.policyRevision
        : -1,
      0,
    );
  });

  test('不变量 A：accepted 仍只能经 review(accept)；无 record 的 accept 继续可用', () => {
    const item = dispatchableWorkItem();
    item.dispatch();
    item.submit();
    item.review('accept');
    assert.equal(item.status, 'accepted');
    assert.equal(item.reviews.length, 0);
  });
});
