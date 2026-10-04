/**
 * COM3-B1：ChangeRequest 仓储（InMemory + File）。
 *
 * 锁住：已确认变更 append-only 不可变、clone/freeze、同 id 幂等 / 异内容冲突、
 * File 跨实例恢复、随 FileStateStore 事务提交与回滚、旧集合无损。
 *
 * 不接真实服务：样例直接给出 reviewer / reason / 时间与 base hash。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileStateStore } from '../src/application/file-store.ts';
import {
  FileChangeRequestRepository,
  InMemoryChangeRequestRepository,
  type ChangeRequestRepository,
} from '../src/application/change-request-repository.ts';
import {
  ChangeRequestConflictError,
  type ChangeRequest,
} from '../src/application/change-request.ts';
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
  const dir = mkdtempSync(join(tmpdir(), 'coagent-cr-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

/** 可变工厂：故意返回非 frozen，方便断言 append 不冻 caller、也不被 caller 污染。 */
function sample(over: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    changeId: 'CR-1',
    missionId: 'COM3-B1',
    reviewer: 'reviewer-l3',
    reason: 'against acceptance 2',
    confirmedChange: '改 < 为 <=',
    workItemId: 'W-468',
    attemptId: 'AT-7',
    baseSnapshotHash: 'sha256:aaaa',
    createdAt: '2026-10-04T10:00:00.000Z',
    sourceContractRevision: 3,
    claimGeneration: 1,
    ...over,
  };
}

function onDisk(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function assertFrozenRecord(row: ChangeRequest): void {
  assert.ok(Object.isFrozen(row));
}

async function assertConflictKeepsOriginal(
  repo: ChangeRequestRepository,
  before: ChangeRequest,
  variant: ChangeRequest,
): Promise<void> {
  await assert.rejects(
    () => repo.append(variant),
    (err: unknown) => {
      assert.ok(err instanceof ChangeRequestConflictError);
      assert.equal(err.code, 'CHANGE_REQUEST_CONFLICT');
      assert.equal(err.changeId, before.changeId);
      return true;
    },
  );
  const after = await repo.get(before.changeId);
  assert.ok(after);
  assert.ok(changeRequestsDeepEqual(after, before), '冲突后原记录一字不变');
}

function changeRequestsDeepEqual(a: ChangeRequest, b: ChangeRequest): boolean {
  return (
    a.changeId === b.changeId &&
    a.missionId === b.missionId &&
    a.reviewer === b.reviewer &&
    a.reason === b.reason &&
    a.confirmedChange === b.confirmedChange &&
    a.workItemId === b.workItemId &&
    a.attemptId === b.attemptId &&
    a.baseSnapshotHash === b.baseSnapshotHash &&
    a.createdAt === b.createdAt &&
    a.sourceContractRevision === b.sourceContractRevision &&
    a.claimGeneration === b.claimGeneration
  );
}

/** 两个实现跑同一套断言：任何一处不一样都说明有一个实现漂了。 */
async function exercise(repo: ChangeRequestRepository): Promise<void> {
  const original = sample();
  await repo.append(original);

  // caller 对象没被冻住（仓储不接管它），但它之后的修改不进库。
  assert.equal(Object.isFrozen(original), false);
  (original as { reviewer: string }).reviewer = 'someone-else';
  (original as { reason: string }).reason = 'tampered';

  const first = await repo.get('CR-1');
  assert.ok(first);
  assert.equal(first.reviewer, 'reviewer-l3');
  assert.equal(first.reason, 'against acceptance 2');
  assertFrozenRecord(first);

  // get / list 每次都是新对象。
  const second = await repo.get('CR-1');
  assert.ok(second);
  assert.notEqual(first, second);
  const listTwice = await repo.listByMission('COM3-B1');
  assert.notEqual(listTwice[0], first);

  // 同一个 id 重试：只有一条。
  await repo.append(sample());
  const afterRetry = await repo.listByMission('COM3-B1');
  assert.equal(afterRetry.length, 1);

  // 内容不同必须换新 id：同 id 改 reason / createdAt 冲突，原记录不变。
  await assertConflictKeepsOriginal(repo, first, sample({ reason: 'another reason' }));
  await assertConflictKeepsOriginal(repo, first, sample({ createdAt: '2026-10-04T11:00:00.000Z' }));

  // 多填一个字段就是另一份协议，拒绝且不落库。
  await assert.rejects(
    () => repo.append({ ...sample(), changeId: 'CR-bad', source: 'L3' } as unknown as ChangeRequest),
    /未知字段/,
  );
  assert.equal(await repo.get('CR-bad'), undefined);

  // mission / target 过滤：给了的条件 AND 精确匹配，追加顺序。
  await repo.append(sample({ changeId: 'CR-2', attemptId: 'AT-8', claimGeneration: 2 }));
  await repo.append(sample({ changeId: 'CR-3', missionId: 'COM3-OTHER' }));

  const all = await repo.listByMission('COM3-B1');
  assert.deepEqual(all.map((row) => row.changeId), ['CR-1', 'CR-2']);
  assert.ok(Object.isFrozen(all));
  assert.ok(changeRequestsDeepEqual(all[0]!, first));
  assert.deepEqual(
    (await repo.listByMission('COM3-B1', { attemptId: 'AT-8' })).map((row) => row.changeId),
    ['CR-2'],
  );
  assert.deepEqual(
    (await repo.listByMission('COM3-B1', { claimGeneration: 1 })).map((row) => row.changeId),
    ['CR-1'],
  );
  assert.deepEqual(
    (await repo.listByMission('COM3-B1', { workItemId: 'W-468', attemptId: 'AT-7' })).map(
      (row) => row.changeId,
    ),
    ['CR-1'],
  );
  assert.deepEqual(await repo.listByMission('COM3-B1', { attemptId: 'AT-none' }), []);
  assert.deepEqual((await repo.listByMission('COM3-OTHER')).map((row) => row.changeId), ['CR-3']);
  assert.equal(await repo.get('CR-none'), undefined);
}

describe('ChangeRequestRepository', () => {
  test('内存与 File 实现：幂等/冲突/不可变/mission+target 过滤', async () => {
    await exercise(new InMemoryChangeRequestRepository());
    await exercise(new FileChangeRequestRepository(new FileStateStore(tempState())));
  });

  test('File 实现：legacy 缺键 → []；跨实例恢复；随事务提交/回滚', async () => {
    const path = tempState();
    const reportFixture: ValidationReport = {
      id: 'VR-1',
      policyRevision: 1,
      missionId: 'COM3-B1',
      startedAt: '2026-10-04T09:00:00.000Z',
      endedAt: '2026-10-04T09:00:01.000Z',
      passed: true,
      checks: [],
    };
    // version 仍是 1，且故意缺 changeRequests：旧文件必须能读。
    writeFileSync(
      path,
      JSON.stringify(
        {
          version: 1,
          projects: [],
          deliveries: [],
          events: [],
          idCounters: { CR: 7 },
          agentPool: [],
          archivedMissions: [],
          queryRuns: [],
          validationReports: [reportFixture],
        },
        null,
        2,
      ),
      'utf8',
    );

    const store = new FileStateStore(path);
    assert.deepEqual(store.raw().changeRequests, [], 'legacy 缺 changeRequests 补 []');
    const otherBefore = JSON.parse(
      JSON.stringify({
        validationReports: store.raw().validationReports,
        idCounters: store.raw().idCounters,
      }),
    ) as { validationReports: unknown; idCounters: Record<string, number> };
    const repo = new FileChangeRequestRepository(store);
    assert.equal(await repo.get('CR-1'), undefined);

    await repo.append(sample());
    const beforeBytes = readFileSync(path, 'utf8');

    // 同 path 新实例：跨重启恢复，且重试幂等。
    const reopened = new FileChangeRequestRepository(new FileStateStore(path));
    const restored = await reopened.get('CR-1');
    assert.ok(restored);
    assert.ok(changeRequestsDeepEqual(restored, sample()));
    await reopened.append(sample());
    assert.deepEqual((await reopened.listByMission('COM3-B1')).map((row) => row.changeId), ['CR-1']);
    await assert.rejects(
      () => reopened.append(sample({ reason: 'changed' })),
      (err: unknown) => err instanceof ChangeRequestConflictError,
    );

    // 事务里提交：提交前盘上一个字节都不动，commit 后可读。
    await store.run(async () => {
      await repo.append(sample({ changeId: 'CR-commit' }));
      assert.equal(readFileSync(path, 'utf8'), beforeBytes, '事务里不落盘');
      assert.ok(await repo.get('CR-commit'), '事务内可读到自己写的记录');
    });
    assert.ok(onDisk(path).changeRequests);
    const committed = await new FileChangeRequestRepository(new FileStateStore(path)).get(
      'CR-commit',
    );
    assert.ok(committed);
    assert.ok(changeRequestsDeepEqual(committed, sample({ changeId: 'CR-commit' })), 'commit 后跨实例可读');

    // 事务里抛错：内存 / 磁盘 / 重开都不含待回滚记录。
    const beforeAbortBytes = readFileSync(path, 'utf8');
    await assert.rejects(
      store.run(async () => {
        await repo.append(sample({ changeId: 'CR-abort' }));
        assert.equal(readFileSync(path, 'utf8'), beforeAbortBytes);
        throw new Error('abort');
      }),
      /abort/,
    );
    assert.equal(await repo.get('CR-abort'), undefined);
    assert.deepEqual(
      ((onDisk(path).changeRequests as Array<{ changeId: string }>) ?? []).map((r) => r.changeId),
      ['CR-1', 'CR-commit'],
    );
    assert.equal(
      await new FileChangeRequestRepository(new FileStateStore(path)).get('CR-abort'),
      undefined,
    );

    // 回滚之后的有效 append 不带回半截。
    await repo.append(sample({ changeId: 'CR-after' }));
    assert.deepEqual(
      ((onDisk(path).changeRequests as Array<{ changeId: string }>) ?? []).map((r) => r.changeId),
      ['CR-1', 'CR-commit', 'CR-after'],
    );
    assert.equal(
      await new FileChangeRequestRepository(new FileStateStore(path)).get('CR-abort'),
      undefined,
    );

    // fixture 里的其它集合写前写后无损。
    const finalStore = new FileStateStore(path);
    assert.deepEqual(finalStore.raw().validationReports, otherBefore.validationReports);
    assert.equal(finalStore.raw().idCounters.CR, otherBefore.idCounters.CR, '既有 idCounters 哨兵不丢');
    assert.equal((onDisk(path) as { version?: number }).version, 1, 'StateFile 版本保持 1');
  });
});
