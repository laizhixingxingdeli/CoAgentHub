/**
 * COM3-B2b：ChangeImpact 仓储（InMemory + File）。
 *
 * 锁住：影响判断 append-only 不可变、深副本（数组与 claim）、同 changeId 等值
 * 幂等 / 异内容冲突、File 真实事务回滚与重开恢复、legacy 缺键补 []。
 *
 * 不接真实服务：样例直接给出身份与来源字段。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileStateStore } from '../src/application/file-store.ts';
import {
  FileChangeImpactRepository,
  InMemoryChangeImpactRepository,
  type ChangeImpactRepository,
} from '../src/application/change-impact-repository.ts';
import {
  ChangeImpactConflictError,
  changeImpactsEqual,
  validateChangeImpactBody,
  type ChangeImpact,
  type ChangeImpactBody,
} from '../src/application/change-impact.ts';
import type { ValidationReport } from '../src/kernel/index.ts';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-ci-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

/** 只取四业务字段：validateChangeImpactBody 不认身份 / 来源字段。 */
function body(over: Partial<ChangeImpactBody> = {}): ChangeImpactBody {
  const full = sample(over);
  return {
    decision: full.decision,
    workOrderDiff: full.workOrderDiff,
    affectedAcceptance: full.affectedAcceptance,
    reason: full.reason,
  };
}

function onDisk(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** 可变工厂：故意返回非 frozen，方便断言 append 不冻 caller、也不被 caller 污染。 */
function sample(over: Partial<ChangeImpact> = {}): ChangeImpact {
  return {
    changeId: 'CR-1',
    missionId: 'COM3-B2b',
    workItemId: 'W-471',
    attemptId: 'AT-7',
    claimGeneration: 1,
    coordinatorAttemptId: 'AT-C-3',
    claim: { id: 'CL-9', owner: 'supervisor', claimGeneration: 1 },
    decision: 'compatible',
    workOrderDiff: 'replace step 2',
    affectedAcceptance: [1, 3],
    reason: 'step 2 still executable',
    ...over,
  };
}

/** 两个实现跑同一套断言：任何一处不一样都说明有一个实现漂了。 */
async function exercise(repo: ChangeImpactRepository): Promise<void> {
  const original = sample();
  await repo.append(original);
  assert.equal(Object.isFrozen(original), false);
  (original as { workOrderDiff: string }).workOrderDiff = 'tampered';
  (original as { affectedAcceptance: number[] }).affectedAcceptance.push(99);
  (original as { claim: { owner: string } }).claim.owner = 'someone-else';

  const first = await repo.get('CR-1');
  assert.ok(first);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.claim));
  assert.ok(Object.isFrozen(first.affectedAcceptance));
  assert.equal(first.workOrderDiff, 'replace step 2');
  assert.deepEqual([...first.affectedAcceptance], [1, 3]);
  assert.equal(first.claim.owner, 'supervisor');

  // get / list 每次都是新对象，数组不共享。
  const second = await repo.get('CR-1');
  assert.ok(second);
  assert.notEqual(first, second);
  assert.notEqual(first.claim, second.claim);
  assert.notEqual(first.affectedAcceptance, second.affectedAcceptance);

  // 同 changeId 等值重试：只有一条。
  await repo.append(sample());
  assert.equal((await repo.listByMission('COM3-B2b')).length, 1);

  // 异内容冲突，原记录一字不变。
  for (const variant of [
    sample({ reason: 'another reason' }),
    sample({ claimGeneration: 2 }),
    sample({ affectedAcceptance: [1] }),
    sample({ decision: 'replan' }),
    sample({ claim: { id: 'CL-9', owner: 'supervisor', claimGeneration: 2 } }),
  ]) {
    await assert.rejects(
      () => repo.append(variant),
      (err: unknown) => {
        assert.ok(err instanceof ChangeImpactConflictError);
        assert.equal(err.code, 'CHANGE_IMPACT_CONFLICT');
        return true;
      },
    );
    const after = await repo.get('CR-1');
    assert.ok(after);
    assert.ok(changeImpactsEqual(after, first), '冲突后原记录一字不变');
  }

  // 业务体不接受身份 / 来源 / 额外字段。
  assert.throws(
    () => validateChangeImpactBody({ ...sample(), changeId: 'x' } as never),
    /未知字段/,
  );
  assert.throws(
    () => validateChangeImpactBody({ ...sample(), source: 'supervisor' } as never),
    /未知字段/,
  );
  // compatible 必须点名受影响验收；其余 decision 可空索引但 diff/reason 不能空。
  assert.throws(() => validateChangeImpactBody(body({ affectedAcceptance: [] })), /验收索引/);
  assert.throws(() => validateChangeImpactBody(body({ affectedAcceptance: [0] })), /正整数/);
  assert.throws(() => validateChangeImpactBody(body({ reason: '   ' })), /非空字符串/);
  assert.throws(() => validateChangeImpactBody(body({ decision: 'ignore' })), /decision/);
  assert.doesNotThrow(() =>
    validateChangeImpactBody(body({ decision: 'cancel_replace', affectedAcceptance: [] })),
  );

  // 多一个身份以外的字段就是另一份协议，拒绝且不落库。
  await assert.rejects(
    () => repo.append({ ...sample(), changeId: 'CR-bad', applied: true } as never),
    /未知字段/,
  );
  assert.equal(await repo.get('CR-bad'), undefined);

  // mission 过滤：只认自己的 mission，追加顺序。
  await repo.append(sample({ changeId: 'CR-2' }));
  await repo.append(sample({ changeId: 'CR-3', missionId: 'COM3-OTHER' }));
  assert.deepEqual((await repo.listByMission('COM3-B2b')).map((row) => row.changeId), [
    'CR-1',
    'CR-2',
  ]);
  assert.ok(Object.isFrozen(await repo.listByMission('COM3-B2b')));
  assert.deepEqual((await repo.listByMission('COM3-OTHER')).map((row) => row.changeId), ['CR-3']);
  assert.equal(await repo.get('CR-none'), undefined);
}

describe('ChangeImpactRepository', () => {
  test('内存与 File 实现：幂等/冲突/深不可变/mission 过滤', async () => {
    await exercise(new InMemoryChangeImpactRepository());
    await exercise(new FileChangeImpactRepository(new FileStateStore(tempState())));
  });

  test('File 实现：legacy 缺键 → []；真实事务回滚与重开恢复', async () => {
    const path = tempState();
    const reportFixture: ValidationReport = {
      id: 'VR-1',
      policyRevision: 1,
      missionId: 'COM3-B2b',
      startedAt: '2026-10-05T09:00:00.000Z',
      endedAt: '2026-10-05T09:00:01.000Z',
      passed: true,
      checks: [],
    };
    // version 仍是 1，且故意缺 changeImpacts：旧文件必须能读。
    writeFileSync(
      path,
      JSON.stringify(
        {
          version: 1,
          projects: [],
          deliveries: [],
          events: [],
          idCounters: { CI: 7 },
          agentPool: [],
          archivedMissions: [],
          queryRuns: [],
          validationReports: [reportFixture],
          changeRequests: [],
        },
        null,
        2,
      ),
      'utf8',
    );

    const store = new FileStateStore(path);
    assert.deepEqual(store.raw().changeImpacts, [], 'legacy 缺 changeImpacts 补 []');
    const repo = new FileChangeImpactRepository(store);
    assert.equal(await repo.get('CR-1'), undefined);

    await repo.append(sample());
    const beforeBytes = readFileSync(path, 'utf8');

    // 事务里抛错：内存 / 磁盘 / 重开都不含待回滚记录。
    await assert.rejects(
      store.run(async () => {
        await repo.append(sample({ changeId: 'CR-abort' }));
        assert.equal(readFileSync(path, 'utf8'), beforeBytes, '事务里不落盘');
        assert.ok(await repo.get('CR-abort'), '事务内可读到自己写的记录');
        throw new Error('abort');
      }),
      /abort/,
    );
    assert.equal(await repo.get('CR-abort'), undefined);
    assert.deepEqual(
      ((onDisk(path).changeImpacts as Array<{ changeId: string }>) ?? []).map((r) => r.changeId),
      ['CR-1'],
    );
    assert.equal(
      await new FileChangeImpactRepository(new FileStateStore(path)).get('CR-abort'),
      undefined,
    );

    // 回滚之后的成功 append 不带回半截，且跨重开可读。
    await repo.append(sample({ changeId: 'CR-after' }));
    assert.deepEqual(
      ((onDisk(path).changeImpacts as Array<{ changeId: string }>) ?? []).map((r) => r.changeId),
      ['CR-1', 'CR-after'],
    );
    const reopened = new FileChangeImpactRepository(new FileStateStore(path));
    const restored = await reopened.get('CR-after');
    assert.ok(restored);
    assert.ok(changeImpactsEqual(restored, sample({ changeId: 'CR-after' })));
    await reopened.append(sample({ changeId: 'CR-after' }));
    await assert.rejects(
      () => reopened.append(sample({ changeId: 'CR-after', reason: 'changed' })),
      (err: unknown) => err instanceof ChangeImpactConflictError,
    );

    const finalStore = new FileStateStore(path);
    assert.deepEqual(finalStore.raw().validationReports, [reportFixture]);
    assert.equal(finalStore.raw().idCounters.CI, 7, '既有 idCounters 哨兵不丢');
    assert.equal((onDisk(path) as { version?: number }).version, 1, 'StateFile 版本保持 1');
  });
});
