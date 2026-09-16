import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Attempt,
  IllegalTransitionError,
  KernelError,
  Project,
} from '../src/kernel/index.ts';

/** 开一个 project/mission/workItem，拿到一个 factory 造出来的 attempt。 */
function freshExecutor(): Attempt {
  const project = Project.create({ id: 'p-attempt' });
  const mission = project.createMission({ id: 'm-attempt' });
  mission.startExecuting();
  const item = mission.createWorkItem({ id: 'w-1', title: 'do it' });
  item.dispatch();
  return item.startAttempt();
}

function freshCoordinator(): Attempt {
  const project = Project.create({ id: 'p-attempt' });
  const mission = project.createMission({ id: 'm-attempt' });
  return mission.startCoordinatorAttempt();
}

function illegal(entity: string, from: string, to: string) {
  return (err: unknown) => {
    assert.ok(err instanceof IllegalTransitionError, `expected IllegalTransitionError, got ${String(err)}`);
    assert.ok(err instanceof KernelError);
    assert.ok(err instanceof Error);
    assert.equal(err.code, 'ILLEGAL_TRANSITION');
    assert.equal(err.name, 'IllegalTransitionError');
    assert.equal(err.entity, entity);
    assert.equal(err.from, from);
    assert.equal(err.to, to);
    return true;
  };
}

/**
 * 类 prototype 上的公开方法名。
 * 走 descriptor 而不是取值 —— 取值会在「未初始化私有字段的 prototype 对象」上
 * 调用 getter，直接抛 TypeError。
 */
function publicMethodNames(cls: { prototype: object }): string[] {
  const names: string[] = [];
  for (const key of Reflect.ownKeys(cls.prototype)) {
    if (key === 'constructor') continue;
    const desc = Object.getOwnPropertyDescriptor(cls.prototype, key);
    if (desc && typeof desc.value === 'function') names.push(String(key));
  }
  return names.sort();
}

describe('Attempt: 字段与工厂链接', () => {
  test('executor attempt 由 WorkItem 工厂创建，带 kind/id/外键', () => {
    const attempt = freshExecutor();
    assert.ok(attempt instanceof Attempt);
    assert.equal(attempt.kind, 'executor');
    assert.equal(attempt.id, 'w-1.exec-1');
    assert.equal(attempt.workItemId, 'w-1');
    assert.equal(attempt.missionId, 'm-attempt');
    assert.equal(attempt.status, 'in_progress');
    assert.equal(attempt.failReason, undefined);
  });

  test('coordinator attempt 带 missionId，不带 workItemId', () => {
    const attempt = freshCoordinator();
    assert.equal(attempt.kind, 'coordinator');
    assert.equal(attempt.id, 'coord-1');
    assert.equal(attempt.missionId, 'm-attempt');
    assert.equal(attempt.workItemId, undefined);
    assert.equal(attempt.status, 'in_progress');
  });

  test('id 按序递增', () => {
    const project = Project.create({ id: 'p-seq' });
    const mission = project.createMission({ id: 'm-seq' });
    mission.startExecuting();
    const item = mission.createWorkItem({ id: 'w-seq', title: 'seq' });
    item.dispatch();

    const a1 = item.startAttempt();
    assert.equal(a1.id, 'w-seq.exec-1');
    a1.succeed();
    const a2 = item.startAttempt();
    assert.equal(a2.id, 'w-seq.exec-2');
    a2.fail('nope');
    const a3 = item.startAttempt();
    assert.equal(a3.id, 'w-seq.exec-3');
    assert.equal(item.attempts.length, 3);
  });
});

describe('Attempt: 合法流转', () => {
  test('in_progress -> succeeded', () => {
    const attempt = freshCoordinator();
    attempt.succeed();
    assert.equal(attempt.status, 'succeeded');
  });

  test('in_progress -> failed，failReason 被记录', () => {
    const attempt = freshCoordinator();
    attempt.fail('工具调用超时');
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.failReason, '工具调用超时');
  });

  test('fail() 可以不带原因', () => {
    const attempt = freshExecutor();
    attempt.fail();
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.failReason, undefined);
  });
});

describe('Attempt: 非法流转抛 IllegalTransitionError', () => {
  test('succeeded 之后再 succeed / fail 都不行', () => {
    const attempt = freshExecutor();
    attempt.succeed();
    assert.throws(() => attempt.succeed(), illegal('Attempt', 'succeeded', 'succeeded'));
    assert.throws(() => attempt.fail('x'), illegal('Attempt', 'succeeded', 'failed'));
    assert.equal(attempt.status, 'succeeded');
  });

  test('failed 是终态', () => {
    const attempt = freshExecutor();
    attempt.fail('第一次');
    assert.throws(() => attempt.succeed(), illegal('Attempt', 'failed', 'succeeded'));
    assert.throws(() => attempt.fail('第二次'), illegal('Attempt', 'failed', 'failed'));
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.failReason, '第一次');
  });

  test('被拒绝的流转不会改动状态，也不会写入原因', () => {
    const attempt = freshExecutor();
    attempt.fail('原始原因');
    assert.throws(
      () => attempt.succeed(),
      illegal('Attempt', 'failed', 'succeeded'),
    );
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.failReason, '原始原因');
  });
});

describe('Attempt: 封装', () => {
  test('status / id / kind 赋值抛 TypeError', () => {
    const attempt = freshExecutor();
    assert.throws(() => {
      (attempt as unknown as Record<string, unknown>).status = 'succeeded';
    }, TypeError);
    assert.throws(() => {
      (attempt as unknown as Record<string, unknown>).id = 'exec-999';
    }, TypeError);
    assert.throws(() => {
      (attempt as unknown as Record<string, unknown>).kind = 'coordinator';
    }, TypeError);
    assert.equal(attempt.status, 'in_progress');
    assert.equal(attempt.id, 'w-1.exec-1');
    assert.equal(attempt.kind, 'executor');
  });

  test('prototype 上的访问器全部只有 getter', () => {
    for (const key of Reflect.ownKeys(Attempt.prototype)) {
      if (key === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(Attempt.prototype, key);
      assert.ok(desc, `descriptor for ${String(key)}`);
      if (typeof desc.get === 'function') {
        assert.equal(desc.set, undefined, `Attempt.${String(key)} must not have a setter`);
      }
    }
  });

  test('只有 succeed / fail 会流转状态，其余公开方法一律只写载荷', () => {
    // 判据是**行为**，不是方法名清单。
    //
    // 原先这里 deepEqual 一串名字，于是每加一个 record* 都会红——而它红的
    // 时候什么也没证明，只是提醒你去改那串名字。真正要钉住的是：除了
    // succeed / fail，没有任何公开方法能改 status。
    //
    // 新方法没登记就报错，是刻意的：那会逼着加方法的人明说它改不改状态。
    const STATUS_CHANGING = new Set(['succeed', 'fail']);
    const ARGS: Record<string, unknown[]> = {
      addEvidence: [{ id: 'e0', attemptId: 'a-probe', kind: 'test', summary: 's' }],
      appendOutput: ['x'],
      beat: ['2026-01-01T00:00:00.000Z', 'pid-1'],
      isAbandoned: ['2026-01-01T00:00:00.000Z', 1000],
      recordEndReason: ['structured_submit'],
      recordOutputRef: ['abcdef01'],
      recordProfile: [{ profileId: 'p', endpoint: 'local' }],
      recordResumeRef: ['r'],
      recordToolCall: ['bash', '2026-01-01T00:00:00.000Z'],
      recordUsage: [{ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, quality: 'reported' }],
      toSnapshot: [],
    };

    for (const name of publicMethodNames(Attempt)) {
      if (STATUS_CHANGING.has(name)) continue;
      assert.ok(
        name in ARGS,
        `新公开方法 ${name} 没有登记调用参数：请在 ARGS 里补上，` +
          '顺带确认它确实不改 status —— 会改的话它得进 STATUS_CHANGING 并单独立一条。',
      );
      const probe = new Attempt({ id: 'a-probe', kind: 'executor' }) as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      probe[name](...ARGS[name]);
      assert.equal(
        (probe as unknown as { status: string }).status,
        'in_progress',
        `${name} 改变了 Attempt 状态`,
      );
    }

    const attempt = new Attempt({ id: 'a-payload', kind: 'executor' });
    attempt.addEvidence({
      id: 'e1',
      attemptId: 'a-payload',
      kind: 'test',
      summary: 'node --test 全绿',
      exitCode: 0,
    });
    attempt.recordUsage({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 0,
      total: 6,
      quality: 'reported',
    });
    attempt.recordEndReason('structured_submit');
    attempt.recordResumeRef('handle-1');
    attempt.appendOutput('一些输出');
    attempt.recordProfile({ profileId: 'exec-a', endpoint: 'local' });
    attempt.recordToolCall('bash', '2026-01-01T00:00:00.000Z');
    assert.equal(attempt.status, 'in_progress', 'record* 不得改变 Attempt 状态');
    // 配置冻在 attempt 上：池子以后怎么改，这一跳的历史记录都不变。
    assert.equal(attempt.profile?.profileId, 'exec-a');
    assert.equal(attempt.toolActivity.length, 1);
    assert.equal(attempt.output, '一些输出');
    assert.equal(attempt.resumeRef, 'handle-1');
    assert.equal(attempt.evidence.length, 1);
    assert.equal(attempt.usage.cacheRead, 3, '用量必须分项存，不能只留 total');
    assert.equal(attempt.endedBy, 'structured_submit');
  });

  test('终态之后不再接受证据', () => {
    const attempt = new Attempt({ id: 'a-done', kind: 'executor' });
    attempt.succeed();
    assert.throws(
      () =>
        attempt.addEvidence({
          id: 'e2',
          attemptId: 'a-done',
          kind: 'command',
          summary: '迟到的证据',
        }),
      IllegalTransitionError,
    );
  });
});

describe('Attempt: 原始输出（Timeline 第三层）', () => {
  test('超限时只留尾部，并在开头标明截断了多少', () => {
    const attempt = new Attempt({ id: 'a-out', kind: 'executor' });
    attempt.appendOutput('x'.repeat(50), 20);
    // 排障看的几乎总是最后那段；但**要让人知道自己看到的不是全部**，
    // 否则会基于半截输出下判断。
    assert.ok(attempt.output.length < 50 + 40);
    assert.match(attempt.output, /已截断/);
    assert.ok(attempt.output.endsWith('x'.repeat(20)));
  });

  test('多次追加会累计', () => {
    const attempt = new Attempt({ id: 'a-out2', kind: 'executor' });
    attempt.appendOutput('第一段');
    attempt.appendOutput('第二段');
    assert.equal(attempt.output, '第一段第二段');
  });
});
