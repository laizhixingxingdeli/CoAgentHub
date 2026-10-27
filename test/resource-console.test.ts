/**
 * 资源页的只读投影（src/web/resource-console.js）。
 *
 * 只写两条，对应验收里的关键场景：
 *   1. 未知 / 未上报 / 真实零三者要分得开，页签计数来自传入的数组长度。
 *      这一层最容易出的错都不报错：`Number(null)` 变成 0 之后页面上显示
 *      「尝试 0 · 成功 0 · $0」，看起来完全正常，人却据此判断「这条候选
 *      没被用过、不花钱」。断言写在这里而不是逐个分支各来一条。
 *   2. 复位命令只复制不执行，且失败不虚报成功：空命令交给剪贴板会悄悄
 *      留下上一次的内容；writeText 抛错还说「已复制」比没有这个按钮更糟。
 *
 * 其余分支不各写一条：同一个判断写第二遍不会更准，只会多一处要跟着改。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESOURCE_ROLES,
  circuitLines,
  copyResetCommand,
  failureDetail,
  finiteNumber,
  joinRoleRows,
  resetCommandView,
  resourcePageHtml,
} from '../src/web/resource-console.js';

/** 健康行的最小真实形状：字段名照 src/application/agent-pool.ts 的 AgentPoolCandidateHealth。 */
function healthRow(profileId, overrides = {}) {
  return {
    profileId,
    // 没有失败记录时服务端给的就是这一行（resolveCandidateLastFailure 的哨兵）：
    // failureClass / source 都是字面量 'unknown'，at 为 null。
    circuit: { state: 'closed' },
    lastFailure: { failureClass: 'unknown', at: null, source: 'unknown' },
    window7d: { attempts: 0, successes: 0, reportedCost: 0 },
    runtime: { running: false, reason: '' },
    ...overrides,
  };
}

/** 按 data-resource-row 切片：断言「这一行里没有那句」时不能靠整页搜字。 */
function rowSegments(html) {
  return html.split('data-resource-row="').slice(1);
}

test('四角色计数取自数组长度；未知/未上报/真实零各自准确；空角色无保存条', () => {
  const configRows = [
    { profileId: 'coordinator-a', endpoint: 'local' },
    { profileId: 'coordinator-b', endpoint: 'local' },
  ];
  // 第二条候选没有任何健康行：平台这次没返回它，join 之后 health 必须是 null。
  const healthRows = [healthRow('coordinator-a')];
  const rows = joinRoleRows(configRows, healthRows);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].health, null);

  const counts = Object.fromEntries(RESOURCE_ROLES.map(([id]) => [id, 0]));
  counts.coordinator = configRows.length;

  const html = resourcePageHtml({ role: 'coordinator', revision: '', counts, rows });

  assert.ok(html.includes('协调者 2'), '页签计数要来自传入的数组长度');
  assert.ok(html.includes('执行者 0'));
  assert.ok(html.includes('独立复核 0'));
  assert.ok(html.includes('分类 0'));
  assert.equal(html.includes('协调者 8'), false, '写死样例数量会在接入真池后仍然显示样例值');
  assert.ok(html.includes('配置修订 未知'), '没有 revision 时要说未知，不能编一个');
  assert.ok(html.includes('data-resource-save'), '非空角色要有保存条');

  const segments = rowSegments(html);
  assert.equal(segments.length, 2);
  const zeroRow = segments.find((segment) => segment.startsWith('coordinator-a"'));
  const unknownRow = segments.find((segment) => segment.startsWith('coordinator-b"'));
  assert.ok(zeroRow && unknownRow, '两行都要画出来');

  // 真实零：平台报了 0，就是 0 与 $0。
  assert.ok(zeroRow.includes('尝试 0 · 成功 0'));
  assert.ok(zeroRow.includes('$0'));

  // 未上报：显示未知，且不得把 0 的写法挪到这一行上。
  assert.ok(unknownRow.includes('尝试 未知 · 成功 未知'));
  assert.ok(unknownRow.includes('费用未上报'));
  assert.equal(unknownRow.includes('尝试 0 · 成功 0'), false);
  assert.equal(unknownRow.includes('$0'), false);

  // 空角色：空态文案在，保存条与保存按钮都不能有。
  const emptyHtml = resourcePageHtml({
    role: 'executor',
    revision: 'r-1',
    counts,
    rows: joinRoleRows([], []),
  });
  assert.ok(emptyHtml.includes('候选为空，该角色无法调度；为空不等于可以自审'));
  assert.equal(emptyHtml.includes('data-resource-save'), false, '空角色不该有保存条');

  // 抽屉里的「最近失败」三态：closed 且无真实失败、缺健康。
  assert.equal(failureDetail(healthRows[0]), '最近失败：无失败记录');
  assert.equal(failureDetail(null), '最近失败：未知');
  assert.equal(circuitLines(healthRows[0]).primary, '正常');

  // 拒绝 null 必须在碰 Number 之前，否则 Number(null) === 0。
  assert.equal(finiteNumber(null), null);
  assert.equal(finiteNumber(0), 0);
  assert.equal(finiteNumber(''), null);
});

test('复位命令：无命令禁用、空命令不碰剪贴板、写失败不虚报成功', async () => {
  const missing = resetCommandView({ profileId: 'x' });
  assert.equal(missing.disabled, true);
  assert.equal(missing.command, '');

  const present = resetCommandView({ resetCommand: 'node src/l3.ts candidate reset x' });
  assert.equal(present.disabled, false);
  assert.equal(present.text, 'node src/l3.ts candidate reset x', '命令原文显示，不改写');

  let calls = 0;
  const disabled = await copyResetCommand('', async () => { calls += 1; });
  assert.deepEqual(disabled, { ok: false, status: 'disabled' });
  assert.equal(calls, 0, '空命令不得交给 writeText：剪贴板里会留下上一次的内容');

  const failed = await copyResetCommand('node src/l3.ts candidate reset x', async () => {
    throw new Error('no');
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.ok, false);
});
