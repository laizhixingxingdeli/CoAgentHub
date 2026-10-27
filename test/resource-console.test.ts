/**
 * 资源页的投影与草稿编辑（src/web/resource-console.js）。
 *
 * 写四条，对应验收里的关键场景：
 *   1. 未知 / 未上报 / 真实零三者要分得开，页签计数来自传入的数组长度。
 *      这一层最容易出的错都不报错：`Number(null)` 变成 0 之后页面上显示
 *      「尝试 0 · 成功 0 · $0」，看起来完全正常，人却据此判断「这条候选
 *      没被用过、不花钱」。断言写在这里而不是逐个分支各来一条。
 *   2. 复位命令只复制不执行，且失败不虚报成功：空命令交给剪贴板会悄悄
 *      留下上一次的内容；writeText 抛错还说「已复制」比没有这个按钮更糟。
 *   3. 草稿操作只改本角色、且不原地改：原地改之后「放弃草稿」再也还原不回去。
 *   4. endpoint 选项只来自真实配置、脏判定按角色分开：多一个内置端点或多报一次脏，
 *      前者会让人存下一个调度永远失败的候选，后者会让离页提示天天弹。
 *
 * 其余分支不各写一条：同一个判断写第二遍不会更准，只会多一处要跟着改。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESOURCE_ROLES,
  addDraftCandidate,
  anyDraftDirty,
  circuitLines,
  copyResetCommand,
  draftDirty,
  endpointOptions,
  failureDetail,
  finiteNumber,
  joinRoleRows,
  moveDraftCandidate,
  resetCommandView,
  resourcePageHtml,
  toggleDraftCandidate,
  updateDraftCandidate,
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

test('草稿只改本角色且不原地改；patch 改不动 profileId/runtime；新候选启用且无参数', () => {
  const saved = {
    coordinator: [
      { profileId: 'c1', endpoint: 'local' },
      { profileId: 'c2', endpoint: 'local' },
    ],
    executor: [{ profileId: 'e1', endpoint: 'local', enabled: false }],
  };
  // baseline 是「改动前」的深拷贝：每一步都拿它比 saved，才能证明 saved 没被改动过。
  const baseline = structuredClone(saved);
  const drafts = structuredClone(saved);

  // 启停：undefined 先落到 false，再翻回去。
  let next = toggleDraftCandidate(drafts, 'coordinator', 0);
  assert.equal(next.coordinator[0].enabled, false);
  assert.equal(toggleDraftCandidate(next, 'coordinator', 0).coordinator[0].enabled, true);

  // 排序复用 moveCandidate：换的是位置，不是内容。
  next = moveDraftCandidate(next, 'coordinator', 0, 1);
  assert.deepEqual(next.coordinator.map((row) => row.profileId), ['c2', 'c1']);

  // patch 里塞 profileId/runtime/order/enabled：只有 endpoint/facts 能进去。
  // 让界面改得动 profileId 就等于让一条候选凭空换个身份（健康/熔断/审计全按它匹配）。
  next = updateDraftCandidate(next, 'coordinator', 0, {
    profileId: 'hack',
    runtime: 'x',
    order: 9,
    enabled: false,
    endpoint: 'new',
    facts: [{ key: 'model', value: 'm', extra: 'ignored' }],
  });
  const edited = next.coordinator[0];
  assert.equal(edited.profileId, 'c2', 'profileId 只读');
  assert.equal(edited.runtime, undefined, 'runtime 固定 pi，不从界面写');
  assert.equal(edited.order, undefined, '顺序只由数组位置表达，不带 order 键');
  assert.equal(edited.enabled, undefined, 'patch 不得顺手改启停');
  assert.equal(edited.endpoint, 'new');
  assert.deepEqual(edited.facts, [{ key: 'model', value: 'm' }], 'facts 只留字符串键值，原样保留');

  // 添加：只进草稿、默认启用、无参数，且不吃 input 里多给的键。
  next = addDraftCandidate(next, 'coordinator', {
    profileId: 'c3',
    endpoint: 'remote',
    runtime: 'x',
    enabled: false,
  });
  assert.equal(next.coordinator.length, 3);
  assert.deepEqual(next.coordinator[2], {
    profileId: 'c3',
    endpoint: 'remote',
    enabled: true,
    facts: [],
  });

  // 全程：执行者草稿、saved 和传入的 drafts 都不能变。
  assert.deepEqual(next.executor, baseline.executor);
  assert.deepEqual(saved, baseline, '草稿操作不能写回 saved，否则「放弃草稿」无从还原');
  assert.deepEqual(drafts, baseline, '不能原地改传入的草稿');
});

test('endpoint 选项只来自真实配置且去重保序；脏判定按角色分开、保存条脏时仍禁用', () => {
  assert.deepEqual(
    endpointOptions([{ endpoint: 'local' }, { endpoint: 'remote' }, { endpoint: 'local' }]),
    ['local', 'remote'],
  );
  // 内置一份「常见端点」的后果：人存下一个调度永远失败的候选，而它在列表里长得一样。
  assert.deepEqual(endpointOptions([{ endpoint: 'custom-only' }]), ['custom-only']);
  assert.deepEqual(endpointOptions([{ profileId: 'x' }, { endpoint: '' }]), []);
  assert.deepEqual(endpointOptions(undefined), [], '配置读失败时不能编出选项');

  const saved = {
    coordinator: [{ profileId: 'c1', endpoint: 'local' }],
    executor: [{ profileId: 'e1', endpoint: 'local' }],
  };
  const drafts = structuredClone(saved);
  assert.equal(draftDirty(saved, drafts, 'coordinator'), false);
  assert.equal(anyDraftDirty(saved, drafts), false);

  const toggled = toggleDraftCandidate(drafts, 'coordinator', 0);
  assert.equal(draftDirty(saved, toggled, 'coordinator'), true);
  assert.equal(draftDirty(saved, toggled, 'executor'), false, '别的角色的脏不能算到本角色头上');
  assert.equal(draftDirty(saved, toggled, 'classifier'), false, '没有配置的角色不是脏');
  assert.equal(anyDraftDirty(saved, toggled), true, '离页保护按全局判断');

  // 保存条：脏时说「有未保存修改」，但保存按钮仍禁用（保存是下一张单）。
  // endpoint 不在选项里时只能保留并标「缺来源」，不能悄悄改成集合里的第一个。
  const vm = {
    role: 'coordinator',
    revision: 'r-1',
    counts: { coordinator: 1 },
    rows: joinRoleRows(saved.coordinator, []),
    drafts: [{ profileId: 'c1', endpoint: 'gone', facts: [{ key: 'model', value: 'm' }] }],
    selectedIndex: 0,
    selected: { profileId: 'c1', endpoint: 'gone', facts: [{ key: 'model', value: 'm' }] },
    endpointOptions: endpointOptions(saved.coordinator),
    dirty: true,
  };
  const html = resourcePageHtml(vm);
  assert.ok(html.includes('有未保存修改'));
  assert.ok(html.includes('data-resource-save-button disabled'), '保存按钮在脏时也必须禁用');
  assert.ok(html.includes('gone（缺来源）'), '缺来源的当前值要保留并标出来');
  assert.ok(html.includes('runtime：pi'));
  assert.ok(html.includes('data-draft-profile'), 'profileId 是只读文本，不是输入框');
  assert.equal(html.includes('data-draft-profile value='), false);

  assert.ok(resourcePageHtml({ ...vm, dirty: false }).includes('没有未保存修改'));
});
