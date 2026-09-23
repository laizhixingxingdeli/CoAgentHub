/**
 * 单写者锁。
 *
 * 要防的不是"数据库并发"，是一个很具体的场景：`run-mission` 跑着的十分钟里，
 * 你在另一个终端 `l3 merge`。两边各持一份内存快照，谁最后落盘谁赢，
 * 另一边的改动**悄无声息地没了**。
 *
 * 所以判据有两条：写入口互斥，只读入口不受影响。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LockBusyError, acquireLock } from '../src/application/lock.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { buildPersistentPlatform } from '../src/main.ts';

const CONTRACT = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-lock-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

describe('单写者锁', () => {
  test('第二个写者拿不到锁，而且错误信息说得出是谁占着', () => {
    const statePath = tempState();
    const release = acquireLock(statePath, '跑 Mission M1');
    try {
      assert.throws(
        () => acquireLock(statePath, 'l3 merge M2'),
        (error: unknown) => {
          assert.ok(error instanceof LockBusyError);
          assert.equal(error.holder?.pid, process.pid);
          assert.match(error.message, /跑 Mission M1/);
          // 报错要告诉人怎么办，不是甩一句 EEXIST。
          assert.match(error.message, /等它结束|删掉/);
          return true;
        },
      );
    } finally {
      release();
    }
  });

  test('放掉之后下一个拿得到；重复释放无害', () => {
    const statePath = tempState();
    const first = acquireLock(statePath, 'a');
    first();
    first(); // 重复释放不该炸
    const second = acquireLock(statePath, 'b');
    second();
  });

  test('**不自动抢占**陈旧的锁：进程卡住和进程已死从外面看一模一样', () => {
    const statePath = tempState();
    const release = acquireLock(statePath, '假装卡住了');
    try {
      // 即使持有者看起来不动了，也不许自己判定它死了然后抢过来——
      // 猜错的代价就是两个进程一起写，正是这把锁要防的事。
      assert.throws(() => acquireLock(statePath, '我觉得它死了'), LockBusyError);
    } finally {
      release();
    }
  });

  test('写入口互斥：第二个 buildPersistentPlatform 被挡', async () => {
    const statePath = tempState();
    const first = await buildPersistentPlatform(statePath, {
      workspace: new InPlaceWorkspaceManager(),
      exclusive: { what: '跑 Mission' },
    });
    try {
      await assert.rejects(
        () =>
          buildPersistentPlatform(statePath, {
            workspace: new InPlaceWorkspaceManager(),
            exclusive: { what: 'l3 merge' },
          }),
        LockBusyError,
      );
    } finally {
      first.releaseLock();
    }
  });

  test('只读入口不抢锁：跑着 Mission 的时候照样能看', async () => {
    const statePath = tempState();
    const writer = await buildPersistentPlatform(statePath, {
      workspace: new InPlaceWorkspaceManager(),
      exclusive: { what: '跑 Mission' },
    });
    try {
      await writer.platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });

      // 观测面/只读命令不带 exclusive，应当照常打开并读到最新内容。
      const viewer = await buildPersistentPlatform(statePath, {
        workspace: new InPlaceWorkspaceManager(),
      });
      const rows = await viewer.platform.listMissions();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].missionId, 'M1');
    } finally {
      writer.releaseLock();
    }
  });

  test('锁目录用完要清掉，不留垃圾', () => {
    const statePath = tempState();
    const lockPath = join(statePath, '..', '.lock-state.json');
    const release = acquireLock(statePath, 'x');
    assert.ok(existsSync(lockPath));
    release();
    assert.ok(!existsSync(lockPath));
  });

  test('反复拿放不在 process 上堆 exit 监听：常驻进程一晚上要拿几十次', () => {
    const statePath = tempState();
    const before = process.listenerCount('exit');
    for (let i = 0; i < 20; i += 1) acquireLock(statePath, `第 ${i} 次`)();
    assert.equal(process.listenerCount('exit'), before);
  });
});
