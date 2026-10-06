/**
 * ChangeCoverage 仓储（InMemory + File）。
 *
 * 锁住：append-only 幂等键 changeId+orderRevision、同键同内容重试幂等、同键异内容
 * 冲突不覆盖、get 返回 clone、File legacy 缺 changeCoverages 按 [] 读且版本仍是 1、
 * 真实事务里失败回滚后盘上没有半截记录。
 *
 * 不接真实服务：样例直接给出身份字段。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileStateStore } from '../src/application/file-store.ts';
import {
  FileChangeCoverageRepository,
  InMemoryChangeCoverageRepository,
  type ChangeCoverageRepository,
} from '../src/application/change-coverage-repository.ts';
import {
  ChangeCoverageConflictError,
  changeCoveragesEqual,
  type ChangeCoverage,
} from '../src/application/change-coverage.ts';

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
  const dir = mkdtempSync(join(tmpdir(), 'coagent-cc-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

/** 可变工厂：故意返回非 frozen，方便断言 append 不冻 caller、也不被 caller 污染。 */
function sample(over: Partial<ChangeCoverage> = {}): ChangeCoverage {
  return {
    changeId: 'CR-1',
    missionId: 'COM4-C',
    workItemId: 'W-494',
    orderRevision: 'r1',
    workOrderHash: 'a'.repeat(64),
    coordinatorAttemptId: 'AT-7',
    at: '2026-10-07T09:00:00.000Z',
    ...over,
  };
}

function onDisk(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function keys(path: string): string[] {
  const rows = (onDisk(path).changeCoverages as Array<{ changeId: string; orderRevision: string }>) ?? [];
  return rows.map((row) => `${row.changeId}/${row.orderRevision}`);
}

/** 两个实现跑同一套断言：任何一处不一样都说明有一个实现漂了。 */
async function exercise(repo: ChangeCoverageRepository): Promise<void> {
  await repo.append(sample());
  const first = await repo.get('CR-1', 'r1');
  assert.ok(first);
  assert.equal(first.workOrderHash, 'a'.repeat(64));

  // 同键同内容（at 不同）重试：不抛，也不新增行。
  await repo.append(sample({ at: '2026-10-07T10:00:00.000Z' }));
  assert.equal((await repo.listByMission('COM4-C')).length, 1);

  // 同键异 workOrderHash：冲突且不覆盖。
  await assert.rejects(
    () => repo.append(sample({ workOrderHash: 'b'.repeat(64) })),
    (err: unknown) => {
      assert.ok(err instanceof ChangeCoverageConflictError);
      assert.equal(err.code, 'CHANGE_COVERAGE_CONFLICT');
      return true;
    },
  );
  const after = await repo.get('CR-1', 'r1');
  assert.ok(after);
  assert.ok(changeCoveragesEqual(after, first), '冲突后原记录一字不变');

  // 换一轮 orderRevision 是另一张覆盖，不冲突。
  await repo.append(sample({ orderRevision: 'r2', at: '2026-10-07T11:00:00.000Z' }));
  assert.deepEqual(
    (await repo.listByMission('COM4-C')).map((row) => row.orderRevision),
    ['r1', 'r2'],
  );

  // get 返回 clone：caller 改不动库内的对象。
  const cloned = await repo.get('CR-1', 'r1');
  assert.ok(cloned);
  assert.ok(Object.isFrozen(cloned));
  assert.notEqual(cloned, await repo.get('CR-1', 'r1'));
  assert.ok(Object.isFrozen(await repo.listByMission('COM4-C')));

  assert.equal(await repo.get('CR-1', 'r9'), undefined);
  assert.deepEqual(await repo.listByMission('COM4-OTHER'), []);
}

describe('ChangeCoverageRepository', () => {
  test('内存与 File 实现：幂等键 / 同内容重试 / 异内容冲突 / clone', async () => {
    await exercise(new InMemoryChangeCoverageRepository());
    await exercise(new FileChangeCoverageRepository(new FileStateStore(tempState())));
  });

  test('File 实现：legacy 缺键 → []；真实事务回滚', async () => {
    const path = tempState();
    // version 仍是 1，且故意缺 changeCoverages：旧文件必须能读。
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
          validationReports: [],
          changeRequests: [],
          changeImpacts: [],
          changeReceipts: [],
        },
        null,
        2,
      ),
      'utf8',
    );

    const store = new FileStateStore(path);
    assert.deepEqual(store.raw().changeCoverages, [], 'legacy 缺 changeCoverages 补 []');
    assert.equal((onDisk(path) as { version?: number }).version, 1, 'StateFile 版本保持 1');
    const repo = new FileChangeCoverageRepository(store);
    assert.deepEqual(await repo.listByMission('COM4-C'), []);

    await repo.append(sample());
    assert.deepEqual(keys(path), ['CR-1/r1']);
    const beforeBytes = readFileSync(path, 'utf8');

    // 事务里 append 后抛错：盘上字节与事务前一致，回滚后读不到被回滚的行。
    await assert.rejects(
      store.run(async () => {
        await repo.append(sample({ changeId: 'CR-abort' }));
        assert.equal(readFileSync(path, 'utf8'), beforeBytes, '事务里不落盘');
        assert.ok(await repo.get('CR-abort', 'r1'), '事务内可读到自己写的行');
        throw new Error('abort');
      }),
      /abort/,
    );
    assert.equal(readFileSync(path, 'utf8'), beforeBytes, '回滚后盘上字节不变');
    assert.equal(await repo.get('CR-abort', 'r1'), undefined);
    assert.deepEqual(keys(path), ['CR-1/r1']);
    assert.equal(await new FileChangeCoverageRepository(new FileStateStore(path)).get('CR-abort', 'r1'), undefined);
    assert.equal(new FileStateStore(path).raw().idCounters.CI, 7, '既有 idCounters 哨兵不丢');
  });
});
