/**
 * ContractHistory 仓储（File）。
 *
 * 锁住：version=1 的旧文件缺 contractHistories 键按 [] 读且不升版本；同键同内容
 * （at 不同）重试幂等不新增；同键异内容抛 ConflictError 且盘上原记录一字不变；
 * FileStateStore.run 里 append 后抛错会回滚。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileStateStore } from '../src/application/file-store.ts';
import { FileContractHistoryRepository } from '../src/application/contract-history-repository.ts';
import {
  ContractHistoryConflictError,
  contractHistoriesEqual,
  type ContractHistoryRecord,
} from '../src/application/contract-history.ts';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-ch-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

function history(over: Partial<ContractHistoryRecord> = {}): ContractHistoryRecord {
  return {
    missionId: 'COM4-AB',
    contractRevision: 1,
    acceptance: ['验收口径一', '验收口径二'],
    at: '2026-10-07T09:00:00.000Z',
    ...over,
  };
}

function rows(path: string): Array<{ at: string }> {
  const state = JSON.parse(readFileSync(path, 'utf8')) as { contractHistories?: Array<{ at: string }> };
  return state.contractHistories ?? [];
}

/** version 仍是 1，且故意缺 contractHistories。 */
function writeLegacy(path: string): void {
  writeFileSync(
    path,
    JSON.stringify({
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
      changeCoverages: [],
    }),
    'utf8',
  );
}

describe('ContractHistory 仓储', () => {
  test('File 实现：legacy 缺键按 [] 读；幂等 / 冲突不覆盖', async () => {
    const path = tempState();
    writeLegacy(path);
    const store = new FileStateStore(path);
    assert.deepEqual(store.raw().contractHistories, []);
    const histories = new FileContractHistoryRepository(store);
    assert.equal(await histories.get('COM4-AB', 1), undefined);

    await histories.append(history());
    // 同键同内容、at 不同：不新增，也不改盘上已有的 at。
    await histories.append(history({ at: '2026-10-07T10:00:00.000Z' }));
    assert.equal(rows(path).length, 1);
    assert.equal(rows(path)[0]!.at, '2026-10-07T09:00:00.000Z');

    const before = await histories.get('COM4-AB', 1);
    assert.ok(before);
    const bytesBefore = readFileSync(path, 'utf8');
    await assert.rejects(
      () => histories.append(history({ acceptance: ['验收口径三'] })),
      (err: unknown) => err instanceof ContractHistoryConflictError && err.code === 'CONTRACT_HISTORY_CONFLICT',
    );
    assert.equal(readFileSync(path, 'utf8'), bytesBefore, '冲突后盘上字节不变');
    assert.ok(contractHistoriesEqual((await histories.get('COM4-AB', 1))!, before));

    // 换一版 contractRevision 是另一条事实，不冲突。
    await histories.append(history({ contractRevision: 2, at: '2026-10-07T11:00:00.000Z' }));
    assert.equal(rows(path).length, 2);
    assert.ok(Object.isFrozen(await histories.get('COM4-AB', 1)));
  });

  test('File 实现：run 内 append 后抛错会回滚', async () => {
    const path = tempState();
    writeLegacy(path);
    const store = new FileStateStore(path);
    const histories = new FileContractHistoryRepository(store);
    const bytesBefore = readFileSync(path, 'utf8');

    await assert.rejects(
      store.run(async () => {
        await histories.append(history());
        assert.equal(readFileSync(path, 'utf8'), bytesBefore, '事务里不落盘');
        assert.ok(await histories.get('COM4-AB', 1), '事务内可读到自己写的行');
        throw new Error('abort');
      }),
      /abort/,
    );

    assert.equal(await histories.get('COM4-AB', 1), undefined);
    assert.equal(readFileSync(path, 'utf8'), bytesBefore, '回滚后盘上字节不变');
    const reopened = new FileStateStore(path);
    assert.deepEqual(reopened.raw().contractHistories, []);
    assert.equal(reopened.raw().idCounters.CI, 7, '既有 idCounters 哨兵不丢');
  });
});
