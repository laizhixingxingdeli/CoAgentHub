/**
 * COM3-B3：ChangeReceipt 仓储（InMemory + File）。
 *
 * 锁住：回执 append-only 不可变、同层同内容幂等 / 同层异内容与跨 attempt 冲突、
 * verified 不是可写层、contentHash 的层规则、File 真实事务回滚与重开恢复、
 * legacy 缺键补 []。
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
  FileChangeReceiptRepository,
  InMemoryChangeReceiptRepository,
  type ChangeReceiptRepository,
} from '../src/application/change-receipt-repository.ts';
import {
  ChangeReceiptConflictError,
  changeReceiptsEqual,
  diffContentHash,
  validateChangeReceipt,
  type ChangeReceipt,
} from '../src/application/change-receipt.ts';

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
function sample(over: Partial<ChangeReceipt> = {}): ChangeReceipt {
  return {
    changeId: 'CR-1',
    missionId: 'COM3-B3',
    workItemId: 'W-484',
    attemptId: 'AT-7',
    claimGeneration: 1,
    layer: 'adapter_received',
    at: '2026-10-06T09:00:00.000Z',
    ...over,
  };
}

function onDisk(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function ids(path: string): string[] {
  const rows = (onDisk(path).changeReceipts as Array<{ changeId: string; layer: string }>) ?? [];
  return rows.map((row) => `${row.changeId}/${row.layer}`);
}

const HASH = diffContentHash('把 step 2 换成 step 2b');

/** 两个实现跑同一套断言：任何一处不一样都说明有一个实现漂了。 */
async function exercise(repo: ChangeReceiptRepository): Promise<void> {
  // 三层可追加，同层只有一张。
  await repo.append(sample());
  await repo.append(sample({ layer: 'session_consumed', at: '2026-10-06T09:00:01.000Z' }));
  await repo.append(
    sample({ layer: 'executor_started', at: '2026-10-06T09:00:02.000Z', contentHash: HASH }),
  );
  assert.deepEqual((await repo.listByChange('CR-1')).map((row) => row.layer), [
    'adapter_received',
    'session_consumed',
    'executor_started',
  ]);

  // 同层同内容（at 不同）重试：不新增行。
  await repo.append(sample({ at: '2026-10-06T10:00:00.000Z' }));
  assert.equal((await repo.listByChange('CR-1')).length, 3);

  // 同层异 contentHash 冲突，原记录一字不变。
  const before = await repo.get('CR-1', 'executor_started');
  assert.ok(before);
  for (const variant of [
    sample({ layer: 'executor_started', contentHash: diffContentHash('另一份 diff') }),
    sample({ layer: 'executor_started', attemptId: 'AT-9', contentHash: HASH }),
    sample({ layer: 'executor_started', claimGeneration: 2, contentHash: HASH }),
  ]) {
    await assert.rejects(
      () => repo.append(variant),
      (err: unknown) => {
        assert.ok(err instanceof ChangeReceiptConflictError);
        assert.equal(err.code, 'CHANGE_RECEIPT_CONFLICT');
        return true;
      },
    );
    const after = await repo.get('CR-1', 'executor_started');
    assert.ok(after);
    assert.ok(changeReceiptsEqual(after, before), '冲突后原记录一字不变');
  }

  // 同一 changeId 换了 attemptId / claimGeneration：另一趟执行，冲突且不写入。
  for (const variant of [
    sample({ changeId: 'CR-1', attemptId: 'AT-8' }),
    sample({ changeId: 'CR-1', claimGeneration: 2 }),
    sample({ changeId: 'CR-1', workItemId: 'W-999' }),
    sample({ changeId: 'CR-1', missionId: 'COM3-OTHER' }),
  ]) {
    await assert.rejects(
      () => repo.append(variant),
      (err: unknown) => err instanceof ChangeReceiptConflictError,
    );
    assert.equal((await repo.listByChange('CR-1')).length, 3);
  }

  // get / list 返回 clone：caller 改不动库内的对象。
  const cloned = await repo.get('CR-1', 'adapter_received');
  assert.ok(cloned);
  assert.ok(Object.isFrozen(cloned));
  const again = await repo.get('CR-1', 'adapter_received');
  assert.ok(again);
  assert.notEqual(cloned, again);
  assert.ok(Object.isFrozen(await repo.listByChange('CR-1')));

  // verified 不是可写层：拒绝且 get 仍 undefined。
  await assert.rejects(
    () => repo.append(sample({ changeId: 'CR-v', layer: 'verified' as never })),
    /layer/,
  );
  assert.equal(await repo.get('CR-v', 'verified' as never), undefined);

  // 非法层、executor_started 缺/坏 contentHash、另外两层带 contentHash：一律拒绝。
  await assert.rejects(() => repo.append(sample({ changeId: 'CR-x', layer: 'nope' as never })), /layer/);
  await assert.rejects(
    () => repo.append(sample({ changeId: 'CR-y', layer: 'executor_started' })),
    /contentHash/,
  );
  await assert.rejects(
    () => repo.append(sample({ changeId: 'CR-z', layer: 'executor_started', contentHash: 'ABC' })),
    /contentHash/,
  );
  await assert.rejects(
    () => repo.append(sample({ changeId: 'CR-w', layer: 'session_consumed', contentHash: HASH })),
    /contentHash/,
  );
  assert.throws(() => validateChangeReceipt({ ...sample(), extra: 1 } as never), /未知字段/);
  assert.throws(
    () => validateChangeReceipt(sample({ claimGeneration: 0 })),
    /claimGeneration/,
  );
  assert.equal(await repo.get('CR-x', 'nope' as never), undefined);

  // 别的 changeId 互不干扰；listByMission 只认自己的 mission，保持插入顺序。
  await repo.append(sample({ changeId: 'CR-2' }));
  await repo.append(sample({ changeId: 'CR-3', missionId: 'COM3-OTHER' }));
  assert.deepEqual((await repo.listByMission('COM3-B3')).map((row) => row.changeId), [
    'CR-1',
    'CR-1',
    'CR-1',
    'CR-2',
  ]);
  assert.deepEqual((await repo.listByMission('COM3-OTHER')).map((row) => row.changeId), ['CR-3']);
}

describe('ChangeReceiptRepository', () => {
  test('内存与 File 实现：三层/幂等/冲突/层规则/克隆', async () => {
    await exercise(new InMemoryChangeReceiptRepository());
    await exercise(new FileChangeReceiptRepository(new FileStateStore(tempState())));

    assert.equal(
      HASH,
      '9d4fbbb3d09d3b36d8573d4185d0bbc69e52e61c3b2dabb72e68c11539512241',
      'diffContentHash 必须是 sha256 hex',
    );
  });

  test('File 实现：legacy 缺键 → []；真实事务回滚与重开恢复', async () => {
    const path = tempState();
    // version 仍是 1，且故意缺 changeReceipts：旧文件必须能读。
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
        },
        null,
        2,
      ),
      'utf8',
    );

    const store = new FileStateStore(path);
    assert.deepEqual(store.raw().changeReceipts, [], 'legacy 缺 changeReceipts 补 []');
    assert.equal((onDisk(path) as { version?: number }).version, 1, 'StateFile 版本保持 1');
    const repo = new FileChangeReceiptRepository(store);
    assert.equal(await repo.get('CR-1', 'adapter_received'), undefined);

    await repo.append(sample());
    const beforeBytes = readFileSync(path, 'utf8');

    // 事务里 append 后抛错：盘上字节与事务前一致，重开读不到被回滚的行。
    await assert.rejects(
      store.run(async () => {
        await repo.append(sample({ changeId: 'CR-abort' }));
        assert.equal(readFileSync(path, 'utf8'), beforeBytes, '事务里不落盘');
        assert.ok(await repo.get('CR-abort', 'adapter_received'), '事务内可读到自己写的行');
        throw new Error('abort');
      }),
      /abort/,
    );
    assert.equal(readFileSync(path, 'utf8'), beforeBytes, '回滚后盘上字节不变');
    assert.equal(await repo.get('CR-abort', 'adapter_received'), undefined);
    assert.deepEqual(ids(path), ['CR-1/adapter_received']);
    assert.equal(
      await new FileChangeReceiptRepository(new FileStateStore(path)).get(
        'CR-abort',
        'adapter_received',
      ),
      undefined,
    );

    // 回滚之后的成功 append 不带回半截，且跨重开可读。
    await repo.append(sample({ changeId: 'CR-after', layer: 'executor_started', contentHash: HASH }));
    assert.deepEqual(ids(path), ['CR-1/adapter_received', 'CR-after/executor_started']);
    const reopened = new FileChangeReceiptRepository(new FileStateStore(path));
    const restored = await reopened.get('CR-after', 'executor_started');
    assert.ok(restored);
    assert.equal(restored.contentHash, HASH);
    assert.ok(changeReceiptsEqual(restored, sample({ changeId: 'CR-after', layer: 'executor_started', contentHash: HASH })));
    // 重开后同层同内容仍幂等，异内容仍冲突。
    await reopened.append(sample({ changeId: 'CR-after', layer: 'executor_started', contentHash: HASH }));
    await assert.rejects(
      () => reopened.append(sample({ changeId: 'CR-after', layer: 'executor_started', contentHash: diffContentHash('别的') })),
      (err: unknown) => err instanceof ChangeReceiptConflictError,
    );
    assert.equal(new FileStateStore(path).raw().idCounters.CI, 7, '既有 idCounters 哨兵不丢');
  });
});
