/**
 * ContractHistory / AcceptanceDisposition 仓储（File）。
 *
 * 锁住：version=1 的旧文件缺这两个键按 [] 读且不升版本；同键同内容（at 不同）
 * 重试幂等不新增；同键异内容抛各自 ConflictError 且盘上原记录一字不变；
 * FileStateStore.run 里 append 后抛错，两个集合一起回滚。
 *
 * 不接真实服务：样例直接给出身份字段。
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
import { FileAcceptanceDispositionRepository } from '../src/application/acceptance-disposition-repository.ts';
import {
  AcceptanceDispositionConflictError,
  acceptanceDispositionsEqual,
  type AcceptanceDispositionRecord,
} from '../src/application/acceptance-disposition.ts';

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

function disposition(over: Partial<AcceptanceDispositionRecord> = {}): AcceptanceDispositionRecord {
  return {
    dispositionId: 'AD-1',
    missionId: 'COM4-AB',
    contractRevision: 1,
    index: 1,
    decision: 'revalidate',
    workItemIds: ['W-499'],
    basis: { submittedAttemptId: 'AT-7', note: '契约换代，重验' },
    coordinatorAttemptId: 'AT-7',
    at: '2026-10-07T09:00:00.000Z',
    ...over,
  };
}

function onDisk(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function rows(path: string, key: string): Array<Record<string, unknown>> {
  return (onDisk(path)[key] as Array<Record<string, unknown>>) ?? [];
}

/** version 仍是 1，且故意缺 contractHistories / acceptanceDispositions。 */
function writeLegacy(path: string): void {
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
        changeCoverages: [],
      },
      null,
      2,
    ),
    'utf8',
  );
}

describe('ContractHistory / AcceptanceDisposition 仓储', () => {
  test('File 实现：legacy 缺键按 [] 读；幂等 / 冲突不覆盖', async () => {
    const path = tempState();
    writeLegacy(path);

    const store = new FileStateStore(path);
    assert.deepEqual(store.raw().contractHistories, [], 'legacy 缺 contractHistories 补 []');
    assert.deepEqual(store.raw().acceptanceDispositions, [], 'legacy 缺 acceptanceDispositions 补 []');
    assert.equal((onDisk(path) as { version?: number }).version, 1, 'StateFile 版本保持 1');

    const histories = new FileContractHistoryRepository(store);
    const dispositions = new FileAcceptanceDispositionRepository(store);
    assert.equal(await histories.get('COM4-AB', 1), undefined);
    assert.deepEqual(await histories.listByMission('COM4-AB'), []);
    assert.equal(await dispositions.get('AD-1'), undefined);
    assert.deepEqual(await dispositions.listByMission('COM4-AB'), []);

    await histories.append(history());
    await dispositions.append(disposition());
    assert.equal(rows(path, 'contractHistories').length, 1);
    assert.equal(rows(path, 'acceptanceDispositions').length, 1);

    // 同键同内容、at 换另一个非空字符串：不新增，也不改盘上已有的 at。
    await histories.append(history({ at: '2026-10-07T10:00:00.000Z' }));
    await dispositions.append(disposition({ at: '2026-10-07T10:00:00.000Z' }));
    assert.equal(rows(path, 'contractHistories').length, 1, '历史幂等不新增');
    assert.equal(rows(path, 'acceptanceDispositions').length, 1, '处置幂等不新增');
    assert.equal((rows(path, 'contractHistories')[0] as { at: string }).at, '2026-10-07T09:00:00.000Z');

    const historyBefore = await histories.get('COM4-AB', 1);
    const dispositionBefore = await dispositions.get('AD-1');
    assert.ok(historyBefore);
    assert.ok(dispositionBefore);
    const bytesBefore = readFileSync(path, 'utf8');

    // 同键改 acceptance：冲突，且不覆盖原记录。
    await assert.rejects(
      () => histories.append(history({ acceptance: ['验收口径三'] })),
      (err: unknown) => {
        assert.ok(err instanceof ContractHistoryConflictError);
        assert.equal(err.code, 'CONTRACT_HISTORY_CONFLICT');
        return true;
      },
    );
    // 同键改 decision：冲突，且不覆盖原记录。
    await assert.rejects(
      () => dispositions.append(disposition({ decision: 'reuse' })),
      (err: unknown) => {
        assert.ok(err instanceof AcceptanceDispositionConflictError);
        assert.equal(err.code, 'ACCEPTANCE_DISPOSITION_CONFLICT');
        return true;
      },
    );
    assert.equal(readFileSync(path, 'utf8'), bytesBefore, '冲突后盘上字节不变');
    const historyAfter = await histories.get('COM4-AB', 1);
    const dispositionAfter = await dispositions.get('AD-1');
    assert.ok(historyAfter);
    assert.ok(dispositionAfter);
    assert.ok(contractHistoriesEqual(historyAfter, historyBefore), '冲突后原历史一字不变');
    assert.ok(
      acceptanceDispositionsEqual(dispositionAfter, dispositionBefore),
      '冲突后原处置一字不变',
    );

    // 换一版 contractRevision / 换一个 dispositionId 是另一条事实，不冲突。
    await histories.append(history({ contractRevision: 2, at: '2026-10-07T11:00:00.000Z' }));
    await dispositions.append(disposition({ dispositionId: 'AD-2', at: '2026-10-07T11:00:00.000Z' }));
    assert.equal(rows(path, 'contractHistories').length, 2);
    assert.equal(rows(path, 'acceptanceDispositions').length, 2);

    // get / list 返回 clone：caller 改不动库内的对象。
    assert.ok(Object.isFrozen(await histories.get('COM4-AB', 1)));
    assert.ok(Object.isFrozen(await histories.listByMission('COM4-AB')));
    assert.ok(Object.isFrozen(await dispositions.get('AD-1')));
    assert.ok(Object.isFrozen(await dispositions.listByMission('COM4-AB')));
    assert.equal(
      (await dispositions.get('AD-1'))?.workItemIds[0],
      'W-499',
      'basis 的可选键与 workItemIds 都还在',
    );
  });

  test('File 实现：run 内 append 后抛错，两个集合一起回滚', async () => {
    const path = tempState();
    writeLegacy(path);
    const store = new FileStateStore(path);
    const histories = new FileContractHistoryRepository(store);
    const dispositions = new FileAcceptanceDispositionRepository(store);
    const bytesBefore = readFileSync(path, 'utf8');

    await assert.rejects(
      store.run(async () => {
        await histories.append(history());
        await dispositions.append(disposition());
        assert.equal(readFileSync(path, 'utf8'), bytesBefore, '事务里不落盘');
        assert.ok(await histories.get('COM4-AB', 1), '事务内可读到自己写的行');
        assert.ok(await dispositions.get('AD-1'), '事务内可读到自己写的行');
        throw new Error('abort');
      }),
      /abort/,
    );

    assert.deepEqual(store.raw().contractHistories, [], '回滚后契约历史回到 []');
    assert.deepEqual(store.raw().acceptanceDispositions, [], '回滚后验收处置回到 []');
    assert.equal(await histories.get('COM4-AB', 1), undefined);
    assert.equal(await dispositions.get('AD-1'), undefined);
    assert.equal(readFileSync(path, 'utf8'), bytesBefore, '回滚后盘上字节不变');
    assert.equal(
      rows(path, 'contractHistories').length,
      0,
      '盘上没有半截契约历史',
    );
    assert.equal(
      rows(path, 'acceptanceDispositions').length,
      0,
      '盘上没有半截验收处置',
    );
    // 重新开一个 store 读盘：回滚必须真的落到了文件上，不是只在内存里。
    const reopened = new FileStateStore(path);
    assert.deepEqual(reopened.raw().contractHistories, []);
    assert.deepEqual(reopened.raw().acceptanceDispositions, []);
    assert.equal(reopened.raw().idCounters.CI, 7, '既有 idCounters 哨兵不丢');
  });
});
