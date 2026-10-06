/**
 * 建 Mission 与改契约时留下契约原文。
 *
 * 锁住：建 Mission 写入 r1 原文且不 trim；reviseContract 追加 r2 后 r1 仍是旧
 * 数组；仓储缺席（buildPlatform）建 Mission 不抛错；留档 append 抛错时整笔与
 * Mission 一起回滚，盘上既没有 Mission 也没有历史行。
 *
 * 为什么回滚那条要重开一个 FileStateStore 读：同一个实例手里那一份内存副本在
 * 事务回滚时会被换回去，用它自己读等于自己给自己发成绩单。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPersistentPlatform, buildPlatform } from '../src/main.ts';
import { Platform } from '../src/application/platform.ts';
import { FileStateStore, FileProjectRepository, FileActivityLog, FileDeliveryRepository, PersistentIds } from '../src/application/file-store.ts';
import { FixedClock } from '../src/application/in-memory.ts';
import { FileContractHistoryRepository } from '../src/application/contract-history-repository.ts';
import type { ContractHistoryRepository } from '../src/application/contract-history.ts';
import type { MissionContract } from '../src/kernel/index.ts';

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
  const dir = mkdtempSync(join(tmpdir(), 'coagent-chw-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

/** acceptance 故意带前后空格：留档是原文，trim 就等于改写 caller 写下的口径。 */
const CONTRACT: MissionContract = {
  intent: '留下原文',
  acceptance: [' 不trim '],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

describe('建 Mission 与改契约时同事务留下原文', () => {
  test('buildPersistentPlatform：r1 原文不 trim，reviseContract 追加 r2 且 r1 仍在；未装配仓储的 buildPlatform 照样建 Mission', async () => {
    const statePath = tempState();
    const built = await buildPersistentPlatform(statePath, { reconcile: false });
    try {
      const { missionId } = await built.platform.createMission({
        projectId: 'P-chw',
        missionId: 'M-chw',
        contract: CONTRACT,
      });
      const histories = new FileContractHistoryRepository(built.store);
      const r1 = await histories.get(missionId, 1);
      assert.deepEqual(r1?.acceptance, [' 不trim ']);

      await built.platform.reviseContract(missionId, {
        ...CONTRACT,
        acceptance: ['新口径'],
      });

      const r2 = await histories.get(missionId, 2);
      assert.deepEqual(r2?.acceptance, ['新口径']);
      // 换代是加一版，不是改写上一版：r1 仍得是当时写下的那个数组。
      assert.deepEqual((await histories.get(missionId, 1))?.acceptance, [' 不trim ']);
      assert.equal((await histories.listByMission(missionId)).length, 2);
    } finally {
      built.releaseLock();
    }

    // 没装 contractHistories 的装配不该因为少了留档能力就建不了 Mission。
    const memory = buildPlatform();
    const { missionId } = await memory.platform.createMission({ projectId: 'P-mem', contract: CONTRACT });
    assert.equal(missionId, 'M-1');
  });

  test('留档 append 抛错：createMission 整笔回滚，盘上没有这个 Mission 也没有历史行', async () => {
    const statePath = tempState();
    const store = new FileStateStore(statePath);
    const clock = new FixedClock();
    const histories: ContractHistoryRepository = {
      // 永远失败：留档写不下去时，Mission 也不该留下——留一条没有原文的 Mission
      // 等于给后面"按哪一版验收"留下一个问不出来的洞。
      append: async () => {
        throw new Error('history-boom');
      },
      get: async () => undefined,
      listByMission: async () => [],
    };
    const platform = new Platform({
      projects: new FileProjectRepository(store),
      deliveries: new FileDeliveryRepository(store, clock, new PersistentIds(store)),
      activity: new FileActivityLog(store, clock),
      clock,
      ids: new PersistentIds(store),
      transaction: store,
      contractHistories: histories,
    });

    await assert.rejects(
      () =>
        platform.createMission({
          projectId: 'P-chw',
          missionId: 'M-chw',
          contract: CONTRACT,
        }),
      /history-boom/,
    );

    // 另开一个实例读盘：回滚要连状态文件的落盘一起撤，不是只换内存副本。
    const reread = new FileStateStore(statePath);
    const projects = await new FileProjectRepository(reread).list();
    assert.equal(
      projects.some((project) => project.missions.some((mission) => mission.id === 'M-chw')),
      false,
    );
    assert.deepEqual(await new FileContractHistoryRepository(reread).listByMission('M-chw'), []);
  });
});
