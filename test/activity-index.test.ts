/**
 * ActivityIndex：按 Mission 的事件索引（纯数据结构）。
 *
 * 为什么只有一条测试：契约 AC5 把关键测试限制在 3 条以内，本单占 1 条。
 * 增量与重建是同一条不变量的两面——「只读尾巴」和「该重建时必须重建」——
 * 拆成两条就容易只测到一边，所以合在一起写。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ActivityIndex } from '../src/application/activity-index.ts';
import type { ActivityEvent } from '../src/application/ports.ts';

function event(missionId: string, kind: string): ActivityEvent {
  return { at: '2026-10-15T00:00:00.000Z', projectId: 'p1', missionId, kind, data: null };
}

/**
 * 用 Proxy 记录对数字下标的读取。
 *
 * 为什么盯下标而不是别的：索引的全部价值就在「不重读旧前缀」。只断言结果正确
 * 是看不出来的——整表重建也会给出正确结果，只是白扫一遍，正是要防的性能回退。
 */
function trackIndexReads(events: ActivityEvent[]): { arr: ActivityEvent[]; reads: number[] } {
  const reads: number[] = [];
  const arr = new Proxy(events, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^(?:0|[1-9][0-9]*)$/.test(prop)) reads.push(Number(prop));
      return Reflect.get(target, prop, receiver);
    },
  });
  return { arr, reads };
}

test('ActivityIndex：同数组仅追加只读尾部，数组替换/缩短/末项变化时整表重建；list 保序保引用且不泄露桶', () => {
  const index = new ActivityIndex();

  /* ---- 1. 同数组仅追加：只允许读旧末项与新尾巴，旧前缀一个都不重读 ---- */
  const base = [
    event('m1', 'a0'),
    event('m1', 'a1'),
    event('m2', 'a2'),
    event('m1', 'a3'),
    event('m2', 'a4'),
    event('m3', 'a5'),
  ];
  const { arr, reads } = trackIndexReads(base);
  index.sync(arr);
  reads.length = 0;

  const tail = [event('m1', 'a6'), event('m2', 'a7'), event('', 'a8')];
  arr.push(...tail);
  index.sync(arr);

  // 5 是旧末项（用来确认它没被换掉），6/7/8 是新增尾部。0..4 一个都没碰。
  assert.deepEqual(reads, [5, 6, 7, 8]);

  /* ---- 2. list 与 filter 等价、保序、保对象引用、每次新数组、不泄露桶 ---- */
  for (const missionId of ['m1', 'm2', 'm3', 'm9', '']) {
    const got = index.list(missionId);
    const expected = arr.filter((e) => e.missionId === missionId);
    assert.deepEqual(
      got.map((e) => e.kind),
      expected.map((e) => e.kind),
      `missionId=${missionId} 的顺序/内容应与 filter 一致`,
    );
    assert.ok(
      got.every((e, i) => e === expected[i]),
      'list 必须返回原事件对象引用，拷贝内容会让上层的引用断言失去意义',
    );
    assert.notStrictEqual(index.list(missionId), got, '每次调用都要返回新数组');
    got.push(event('m1', 'polluted'));
    if (got.length > 0) got[0] = event('m1', 'polluted');
    assert.deepEqual(
      index.list(missionId).map((e) => e.kind),
      expected.map((e) => e.kind),
      '改动返回数组不得污染内部桶',
    );
  }

  /* ---- 3. 同一个数组、长度不变、末项被换成别的对象：必须重建 ---- */
  const rollback = [event('m1', 'b0'), event('m2', 'b1'), event('m1', 'b2')];
  const idx2 = new ActivityIndex();
  idx2.sync(rollback);
  const replaced = event('m1', 'b2-replaced');
  rollback[2] = replaced;
  idx2.sync(rollback);
  assert.deepEqual(
    idx2.list('m1').map((e) => e.kind),
    ['b0', 'b2-replaced'],
    '末项被替换后不许返回陈旧结果',
  );
  assert.strictEqual(idx2.list('m1')[1], replaced);

  /* ---- 4. 换成另一个数组、长度相同（事务快照副本）：必须重建 ---- */
  const snapshot = rollback.map((e) => ({ ...e }));
  idx2.sync(snapshot);
  assert.strictEqual(idx2.list('m1')[0], snapshot[0], '换数组后必须用新数组里的对象重建');
  assert.strictEqual(idx2.list('m1')[1], snapshot[2]);

  /* ---- 5. 数组比已索引的短、以及空数组：必须重建 ---- */
  idx2.sync(snapshot.slice(0, 1));
  assert.deepEqual(idx2.list('m2'), [], '缩短后应丢掉已删除的桶');
  assert.deepEqual(idx2.list('m1').map((e) => e.kind), ['b0']);

  idx2.sync([]);
  assert.deepEqual(idx2.list('m1'), []);
  assert.deepEqual(idx2.list(''), []);
});
