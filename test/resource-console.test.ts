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
  applyConfigureSuccess,
  captureSave,
  circuitLines,
  copyResetCommand,
  discardRoleDraft,
  draftDirty,
  endpointOptions,
  failureDetail,
  finiteNumber,
  joinRoleRows,
  moveDraftCandidate,
  poolEndpointOptions,
  postConfigure,
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

test('正式嵌套健康：熔断/真实零/未上报/额度都从 health 这一层读出', () => {
  // 正式 GET /api/pools 的候选把健康放在 health 里，不在顶层。断言这一层的理由：
  // 认错层不报错，整表会静默变成「未知 / 健康未返回」，一道开着的熔断看起来
  // 跟平台没上报一样，人就不会去查那条候选为什么停。
  const healthRows = [{
    profileId: 'sample',
    endpoint: 'local',
    runtime: 'pi',
    facts: [],
    order: 0,
    enabled: true,
    health: {
      circuit: { state: 'open' },
      lastFailure: { failureClass: 'quota', at: '2026-10-27T00:00:00.000Z', source: 'pi' },
      window7d: { attempts: 0, successes: 0, reportedCost: null },
      runtime: { running: false },
      quotaReason: '额度已用完',
      resetCommand: 'node src/l3.ts candidate reset sample',
    },
  }];

  const rows = joinRoleRows([{ profileId: 'sample', endpoint: 'local' }], healthRows);
  const html = resourcePageHtml({
    role: 'coordinator',
    revision: 'r-2',
    counts: { coordinator: 1 },
    rows,
  });
  const segment = rowSegments(html).find((item) => item.startsWith('sample"'));
  assert.ok(segment, '这一行要画出来');
  assert.ok(segment.includes('熔断'), 'health.circuit.state=open 要画成熔断');
  assert.ok(segment.includes('尝试 0'), '平台报的真实零是 0，不是未知');
  assert.ok(segment.includes('费用未上报'), 'reportedCost=null 是未上报，不是 $0');
  assert.ok(segment.includes('额度已用完'), 'quotaReason 原样来自接口');
  assert.equal(segment.includes('健康未返回'), false, '嵌套健康不能画成健康未返回');
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

test('草稿只改本角色且不原地改；patch 改不动 profileId/runtime；新候选采纳启停与参数', () => {
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

  // 添加：只进草稿；runtime 这类未知键仍不吃，但**启停和参数是人的选择，照收**。
  // 忽略 enabled 的后果不是多一条启用行，而是人在抽屉里点了「停用」、屏幕上那条
  // 也显示停用，存下去却是启用的——下次调度就从这条开始跑。
  next = addDraftCandidate(next, 'coordinator', {
    profileId: 'c3',
    endpoint: 'remote',
    runtime: 'x',
    order: 9,
    enabled: false,
    facts: [{ key: 'model', value: 'm', extra: 'ignored' }],
  });
  assert.equal(next.coordinator.length, 3);
  assert.deepEqual(next.coordinator[2], {
    profileId: 'c3',
    endpoint: 'remote',
    enabled: false,
    facts: [{ key: 'model', value: 'm' }],
  });
  assert.equal(next.coordinator[2].runtime, undefined, 'runtime 固定 pi，不从界面写');
  assert.equal(next.coordinator[2].order, undefined, '顺序只由数组位置表达，不带 order 键');
  assert.notEqual(next.coordinator[2].facts, undefined);

  // 全程：执行者草稿、saved 和传入的 drafts 都不能变。
  assert.deepEqual(next.executor, baseline.executor);
  assert.deepEqual(saved, baseline, '草稿操作不能写回 saved，否则「放弃草稿」无从还原');
  assert.deepEqual(drafts, baseline, '不能原地改传入的草稿');
});

test('endpoint 选项只来自真实配置且去重保序；脏判定按角色分开、脏时保存可点', () => {
  assert.deepEqual(
    endpointOptions([{ endpoint: 'local' }, { endpoint: 'remote' }, { endpoint: 'local' }]),
    ['local', 'remote'],
  );
  // 内置一份「常见端点」的后果：人存下一个调度永远失败的候选，而它在列表里长得一样。
  assert.deepEqual(endpointOptions([{ endpoint: 'custom-only' }]), ['custom-only']);
  assert.deepEqual(endpointOptions([{ profileId: 'x' }, { endpoint: '' }]), []);
  assert.deepEqual(endpointOptions(undefined), [], '配置读失败时不能编出选项');

  // 全池：空角色也能用其他角色已返回的端点。只看当前角色的后果是空角色一条都加不了。
  assert.deepEqual(poolEndpointOptions({
    coordinator: [],
    executor: [{ endpoint: 'local' }],
  }), ['local']);
  assert.deepEqual(poolEndpointOptions({
    coordinator: [{ endpoint: 'a' }],
    executor: [{ endpoint: '' }, { actual: 1 }],
    independent_reviewer: 'not-an-array',
    classifier: null,
  }), ['a'], '不是数组的角色跳过，不编出选项');
  assert.deepEqual(poolEndpointOptions({ coordinator: [], executor: [], independent_reviewer: [], classifier: [] }), [],
    '四角色都没有端点时不能凭空给一个端点（包括内置 local）');
  assert.deepEqual(poolEndpointOptions(undefined), [], '配置读失败时不能编出选项');

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

  // 保存条：脏时说「有未保存修改」，保存按钮**可点**（没有冲突就该能存）。
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
  assert.equal(html.includes('data-resource-save-button disabled'), false,
    '没冲突的脏草稿要能保存，否则整页只有一个能改不能存的表单');
  assert.ok(html.includes('gone（缺来源）'), '缺来源的当前值要保留并标出来');
  assert.ok(html.includes('runtime：pi'));
  assert.ok(html.includes('data-draft-profile'), 'profileId 是只读文本，不是输入框');
  assert.equal(html.includes('data-draft-profile value='), false);

  assert.ok(resourcePageHtml({ ...vm, dirty: false }).includes('没有未保存修改'));

  // 添加候选是右侧抽屉，与编辑共享同一份草稿；空角色在加入前不能出现保存条。
  const adding = resourcePageHtml({
    role: 'classifier',
    rows: [],
    drafts: [],
    adding: true,
    addForm: { profileId: '', endpoint: 'local', enabled: true, facts: [] },
    endpointOptions: ['local'],
  });
  assert.ok(adding.includes('data-resource-add-drawer'), '添加没有用抽屉画');
  assert.ok(adding.includes('class="resource-drawer"'), '抽屉要复用已有 resource-drawer class，否则它不会落在右侧');
  assert.ok(adding.includes('>加入角色草稿<'), '主按钮文案不对：加入不是保存');
  assert.equal(adding.includes('data-resource-add-form'), false, '表上方的旧添加表单还在');
  assert.equal(adding.includes('data-resource-save'), false, '添加抽屉里不能出现保存条/保存按钮');
  assert.ok(adding.includes('data-add-endpoint'), '端点必须是下拉，不是自由文本');
  assert.equal(adding.includes('data-draft-endpoint'), false,
    '添加抽屉不能用编辑抽屉的端点属性：change 会被当成改已选草稿');
  assert.equal(adding.includes('data-fact-add'), false,
    '添加抽屉不能用编辑抽屉的 data-fact-add：它改的是已选草稿');

  const noOptions = resourcePageHtml({
    role: 'classifier',
    rows: [],
    drafts: [],
    adding: true,
    addForm: { profileId: '', endpoint: '', enabled: true, facts: [] },
    endpointOptions: [],
  });
  assert.ok(/data-add-join disabled/.test(noOptions), '全池没有端点时加入按钮必须禁用');
  assert.equal(noOptions.includes('endpoint（自由填写）'), false, '不能退回自由文本端点');
  assert.ok(noOptions.includes('全池没有已返回的端点'));
});

test('保存冻结点击时的角色与有序候选；成功采用全池快照但保留其他角色脏草稿', async () => {
  const saved = {
    coordinator: [{ profileId: 'c1', endpoint: 'local' }],
    executor: [{ profileId: 'e1', endpoint: 'local' }],
    classifier: [{ profileId: 'k1', endpoint: 'local' }],
    independent_reviewer: [],
  };
  const drafts = structuredClone(saved);
  drafts.coordinator = [
    { profileId: 'c2', endpoint: 'local', enabled: false },
    { profileId: 'c1', endpoint: 'local' },
  ];
  // 执行者的脏草稿：保存别人的时候不能把它抹掉，那是人还没交的改动。
  drafts.executor = [{ profileId: 'e1', endpoint: 'local' }, { profileId: 'e2', endpoint: 'new' }];

  let role = 'coordinator';
  const captured = captureSave(role, 'rev-1', drafts[role]);
  // 捕获之后改原数组和当前角色：这次请求必须还是协调者的那两行。
  drafts.coordinator.push({ profileId: 'c3', endpoint: 'x' });
  role = 'executor';
  assert.deepEqual(captured.candidates.map((row) => row.profileId), ['c2', 'c1']);
  assert.equal(captured.expectedRevision, 'rev-1');
  assert.equal(captured.role, 'coordinator');

  const calls = [];
  const result = await postConfigure(async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        revision: 'rev-2',
        coordinator: drafts.coordinator.slice(0, 2),
        executor: [{ profileId: 'e1', endpoint: 'local' }],
        classifier: [{ profileId: 'k1', endpoint: 'local' }],
        independent_reviewer: [],
      }),
    };
  }, captured, undefined);

  assert.equal(calls.length, 1, '整个角色只发一次，不逐候选 POST');
  assert.equal(calls[0].url, '/api/pools/coordinator/configure', 'URL 用捕获时的角色');
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body)).sort(), ['candidates', 'expectedRevision']);
  assert.equal(JSON.parse(calls[0].init.body).expectedRevision, 'rev-1');

  const next = applyConfigureSuccess(saved, drafts, result.body, captured.role);
  assert.equal(next.revision, 'rev-2', 'revision 取响应字符串');
  assert.deepEqual(next.drafts.coordinator, next.saved.coordinator, '被保存的角色草稿对齐快照');
  assert.equal(next.saved.coordinator.length, 2);
  assert.deepEqual(next.drafts.executor, drafts.executor, '别的角色脏草稿原样保留');
  assert.equal(next.saved.executor.length, 1, 'saved 取响应快照');
  assert.deepEqual(next.drafts.classifier, next.saved.classifier, '提交前干净的角色跟随快照');

  // 放弃只还原这一个角色。
  const discarded = discardRoleDraft(next.saved, next.drafts, 'coordinator');
  assert.deepEqual(discarded.coordinator, next.saved.coordinator);
  assert.deepEqual(discarded.executor, drafts.executor, '放弃协调者不能顺手丢掉执行者的草稿');
});

test('resourcePageHtml：冲突才禁用保存，冲突可重新读取，消息与空角色各自成立', () => {
  const dirtyVm = {
    role: 'coordinator',
    revision: 'r-1',
    counts: { coordinator: 1 },
    rows: [{ profileId: 'c1', endpoint: 'local', enabled: true, health: null }],
    drafts: [{ profileId: 'c1', endpoint: 'local' }],
    dirty: true,
  };
  const plain = resourcePageHtml(dirtyVm);
  assert.equal(plain.includes('data-resource-save-button disabled'), false, '脏且未冲突时可点');

  const conflicted = resourcePageHtml({ ...dirtyVm, conflict: true });
  assert.ok(conflicted.includes('data-resource-save-button disabled'), '冲突时禁用保存');
  assert.ok(conflicted.includes('重新读取最新'));
  assert.ok(conflicted.includes('放弃草稿'));

  const messaged = resourcePageHtml({ ...dirtyVm, message: '保存失败：HTTP 500' });
  assert.ok(messaged.includes('data-resource-save-message'));
  assert.ok(messaged.includes('保存失败：HTTP 500'));

  // 保存中：按钮文案换成「保存中…」且不能重复点。
  const saving = resourcePageHtml({ ...dirtyVm, busy: true, message: '保存中…' });
  assert.ok(saving.includes('保存中…'));
  assert.ok(saving.includes('data-resource-save-button disabled'), '保存中不能再点一次');

  // 成功文案不得声称打断在中途的尝试。
  const done = resourcePageHtml({
    ...dirtyVm, dirty: false, message: '已保存，只影响以后的调度，不打断在途 Attempt',
  });
  assert.ok(done.includes('已保存，只影响以后的调度，不打断在途 Attempt'));
  assert.equal(done.includes('中止 Attempt'), false);

  const empty = resourcePageHtml({ role: 'executor', revision: 'r-1', counts: {}, rows: [], drafts: [] });
  assert.equal(empty.includes('data-resource-save'), false, '空角色仍无保存条');
  assert.equal(empty.includes('data-resource-remove'), false, '不新增删除候选');
});

test('费用：可见文本两位小数，原值在 data-reported-cost 与 title 上，且不改传入对象', () => {
  // 真实费用是浮点累加出来的长小数，原样画在格子上既难读又像坏数据；但只把它
  // toFixed 掉人就再也查不到平台到底报了多少。所以显示两精度、原值另挂在属性上。
  const exact = 102.63400399999996;
  // 把 window7d 单独拿一份引用，就能在渲染之后直接检查它没被 toFixed 覆写。
  const paidWindow = { attempts: 7, successes: 6, reportedCost: exact };
  const paid = healthRow('paid', { window7d: paidWindow });
  // 同一页另一行平台没报费用：必须仍是「费用未上报」，不能借上一条的格式化成 $0.00。
  const silent = healthRow('silent', { window7d: { attempts: 3, successes: 3, reportedCost: null } });

  const rows = joinRoleRows(
    [{ profileId: 'paid', endpoint: 'local' }, { profileId: 'silent', endpoint: 'local' }],
    [paid, silent],
  );
  const html = resourcePageHtml({
    role: 'coordinator',
    revision: 'r-cost',
    counts: { coordinator: 2 },
    rows,
  });

  const paidRow = rowSegments(html).find((segment) => segment.startsWith('paid"'));
  const silentRow = rowSegments(html).find((segment) => segment.startsWith('silent"'));
  assert.ok(paidRow && silentRow, '两行都要画出来');

  assert.ok(paidRow.includes('$102.63'), '有限费用按两位小数显示');
  assert.ok(paidRow.includes('data-reported-cost="' + String(exact) + '"'), '原值要可查');
  assert.ok(paidRow.includes('title="费用原值 ' + String(exact) + '"'), '悬停也要看到原值');
  assert.equal(paidRow.includes('$102.63400399999996'), false, '格子上的可见文本不能是原值');
  // 格式化只能落在显示字符串上：写回健康就等于改掉真实费用，下游算账全错。
  assert.equal(paidWindow.reportedCost, exact, '调用后传入对象的 reportedCost 不变');

  assert.ok(silentRow.includes('费用未上报'));
  assert.equal(silentRow.includes('data-reported-cost'), false, '未上报不挂原值属性');
  assert.equal(silentRow.includes('$0'), false, '未知不能显示成 0');
});
