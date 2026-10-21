import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeAgentText, newestMissions, missionTableHtml, overviewHtml } from '../src/web/overview.js';
import { candidateConfig, moveCandidate, priorityHtml } from '../src/web/model-priority.js';
import { usageFieldsHtml, skeletonHtml, stageDetailHtml, groupActivity } from '../src/web/task.js';
import { buildPlatform } from '../src/main.ts';
import { createApi } from '../src/api/server.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import type { AddressInfo } from 'node:net';

test('统一任务列表最新活动在上、所有任务可进入、输入转义且不改入参数组', () => {
  const rows = [{ missionId: 'old', status: 'completed', updatedAt: '2026-01-01' },
    { missionId: 'new', status: 'executing', intent: '<img>', updatedAt: '2026-10-04' }];
  assert.equal(newestMissions(rows)[0].missionId, 'new');
  assert.equal(rows[0].missionId, 'old');
  const html = missionTableHtml(rows);
  assert.ok(html.indexOf('#/missions/new') < html.indexOf('#/missions/old'));
  assert.ok(html.includes('&lt;img&gt;'));
  assert.ok(!html.includes('<img>'));
  assert.ok(!html.includes('最近完成'));
});

test('列表长标题只做两行预览，但完整标题与链接都还在', () => {
  // 长标题在两行预览里被截掉（样式 .mission-title 在 ui.css），可读的只剩开头。
  // 所以这两件事必须同时成立：完整原文要在 title 上，链接要是真 href——
  // 只截不留，等于把任务名字从列表上弄丢了，而页面上看不出少了什么。
  const long = '把观测面的事件表改成能读的人话并且顺带修掉窄屏下导航被拉伸的问题';
  const html = missionTableHtml([{ missionId: 'M-long', status: 'executing', intent: long }]);
  assert.ok(html.includes('class="mission-title"'), html);
  assert.ok(html.includes('title="' + long + '"'), '完整标题要完整地留在 title 上');
  assert.ok(html.includes('href="#/missions/M-long"'), '仍是真链接，键盘也能进');
  // 引号会提前闭合属性：转义不能因为多了一个 title 就漏掉。
  const quoted = missionTableHtml([{ missionId: 'M-q', status: 'executing', intent: 'a"b' }]);
  assert.ok(quoted.includes('title="a&quot;b"'), quoted);
});

test('首页：服务与占用缺失显示未知，执行阶段任务与活跃 Agent 是两个数，暂停任务不计入', () => {
  // 服务和模型数据都没读到：说「未读取 / 未知」，不编成 0。
  const blank = overviewHtml({ missions: [{ missionId: 'paused', status: 'executing', paused: true }], status: null, pools: null, errors: [] });
  assert.ok(blank.includes('未读取'));
  assert.ok(blank.includes('未知'));
  assert.ok(!blank.includes('#/missions/paused'), '暂停的任务不算在执行阶段里');

  const missions = [
    { missionId: 'M-run', status: 'executing' },
    { missionId: 'M-done', status: 'completed' },
  ];
  // 服务已连、占用已读到：1 条任务在走，2 个 Agent 在跑（协调者 + 执行者可能同时在）。
  // 两个数各写一句、用不同的词：「执行阶段任务」是任务数，「活跃 Agent」是租约数。
  // 用同一个词，屏幕上就分不出「任务在走路」和「有进程在跑」——一条在退避的任务
  // 有 0 个租约，一条正在跑的任务可以有 2 个。
  const live = overviewHtml({ missions, status: { occupancy: { activeLeases: 2, global: 1 } }, pools: null, errors: [] });
  assert.match(live, /执行阶段任务：1 项/, live);
  assert.match(live, /data-active-agents="1">活跃 Agent：2 个/, live);
  assert.equal(live.includes('进行中任务'), false, '任务数不能再叫「进行中任务」，会和活跃数混');
  // 不能拿任务数顶活跃数，也不能拿活跃数改任务状态。
  assert.equal(/活跃 Agent：1 个/.test(live), false, live);
  assert.ok(live.includes('#/missions/M-run'), 'Agent 数不影响任务列表');
  assert.equal(live.includes('#/missions/M-done'), false, live);

  // 占用读不到（接口还没回来 / 装配不支持 / 占位为 null）：说未知，不说到 0。
  for (const status of [null, { occupancy: null }, { occupancy: { inapplicable: true, reason: 'queued_hops_unavailable' } }, {}]) {
    const out = overviewHtml({ missions, status, pools: null, errors: [] });
    assert.match(out, /活跃 Agent：未知 个/, out);
    assert.equal(/活跃 Agent：0 个/.test(out), false, out);
  }
  // activeLeases 只有「真正的非负整数 number」才算读到。'2'、false、''、null 经
  // Number() 都会变成数字（false/'' 变 0），画出来就是一句没人核对过的「0 个」；
  // 负数和小数不是条数的形状，四舍五入成 0 同样是凭空断言。
  for (const bad of ['2', '', null, false, Number.NaN, -1, 1.5, undefined]) {
    assert.equal(activeAgentText({ occupancy: { activeLeases: bad } }), '未知', `activeLeases=${String(bad)} 应当显示未知`);
  }
  // 0 是真的「没有 Agent」，必须保留成 0。
  assert.equal(activeAgentText({ occupancy: { activeLeases: 0 } }), '0');

  // 真的没有 Agent：如实写 0，且任务仍是「执行阶段任务：1 项」——
  // Agent=0 不能把 Mission 当成做完了（在退避 / 等人的任务本来就没有活动租约）。
  const idle = overviewHtml({ missions, status: { occupancy: { activeLeases: 0 } }, pools: null, errors: [] });
  assert.match(idle, /活跃 Agent：0 个/, idle);
  assert.match(idle, /执行阶段任务：1 项/, idle);
  assert.ok(idle.includes('#/missions/M-run'), idle);
});

test('任务输出常驻独立区域，缺失用量不计作零，真实零值保留', () => {
  const html = skeletonHtml();
  assert.ok(!/data-task-panel="events"/.test(html));
  assert.equal((html.match(/id="task-live"/g) || []).length, 1);
  assert.equal((html.match(/id="task-stages"/g) || []).length, 1);
  const usage = usageFieldsHtml({ input: 0, output: 12 });
  assert.ok(usage.includes('未知'));
  assert.ok(usage.includes('>0</dd>'));
  assert.ok(usage.includes('>12</dd>'));
  const unknown = usageFieldsHtml({ quality: 'unknown', input: 0, output: 0, total: 0, cost: 0 });
  assert.ok(!unknown.includes('>0</dd>'));
  assert.equal((unknown.match(/未知/g) || []).length, 6);
  const group = groupActivity([{ kind: 'attempt.started', attemptId: 'W-1.exec-1', workItemId: 'W-1' }])[0];
  const history = stageDetailHtml(group, { workItems: [{ id: 'W-1', attemptIds: ['W-1.exec-1', 'W-1.exec-2'], executionResult: { summary: '最新尝试独有正文' } }] }, { attemptId: 'W-1.exec-1', status: 'succeeded', evidence: [], output: '历史输出' });
  assert.ok(!history.includes('最新尝试独有正文'));
  assert.ok(history.includes('本次历史交回正文未保留'));
  assert.ok(history.includes('历史输出'));

});

test('模型顺序保存真实 HTTP CAS，保留配置事实与停用，旧版本不覆盖', async () => {
  const built = buildPlatform();
  await built.agentPool.add({ role: 'executor', profileId: 'a', endpoint: 'local', facts: [{ key: 'reasoning', value: 'high' }] });
  await built.agentPool.add({ role: 'executor', profileId: 'b', endpoint: 'local', enabled: false });
  const server = createApi(built);
  await listenLoopback(server, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const initial = await (await fetch(base + '/api/pools/config')).json();
    const initialized = await fetch(base + '/api/pools/executor/configure', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: initial.revision, candidates: initial.executor.map((row: { profileId: string }) => ({ ...candidateConfig(row), enabled: row.profileId !== 'b' })) }) });
    assert.equal(initialized.status, 200);
    const snapshot = await initialized.json();
    const original = snapshot.executor.map(candidateConfig);
    const draft = moveCandidate(original, 1, -1);
    assert.deepEqual(original.map(row => row.profileId), ['a', 'b']);
    assert.deepEqual(draft.map(row => row.profileId), ['b', 'a']);
    const save = () => fetch(base + '/api/pools/executor/configure', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: snapshot.revision, candidates: draft }) });
    assert.equal((await save()).status, 200);
    assert.equal((await save()).status, 409);
    const stored = await (await fetch(base + '/api/pools/config')).json();
    assert.equal(stored.executor[0].enabled, false);
    assert.deepEqual(stored.executor[1].facts, original[0].facts);
    const view = priorityHtml({ role: 'executor', saved: { executor: original }, drafts: { executor: draft }, message: '配置版本冲突', conflict: true });
    assert.ok(view.includes('有未保存修改'));
    assert.match(view, /data-priority-save disabled/);
    assert.ok(view.includes('读取最新配置'));
    // 候选行要说出「这到底是哪一条」：真实 provider/model、优先级、启停文字。
    // 光看 profileId 分不出，而这一页正是人决定下一跳用谁的地方。
    assert.match(view, /data-priority-state="disabled">停用/, 'b 是停用的，要写出「停用」两个字');
    assert.match(view, /data-priority-state="enabled">启用/, view);
    assert.match(view, /优先级 1/, view);
    assert.match(view, /优先级 2/, view);
    assert.match(view, /候选 a</, 'profileId 作为次级技术信息仍要在');
    assert.match(view, /思考 high/, 'a 只有 reasoning fact，有就如实写出来');
    assert.match(view, /模型未指定/, 'a 没写 model fact，不编也不留空格子');
    // 缺的 facts 说「未指定」，不从名字猜、也不把空格子画成已配置。
    const sparse = priorityHtml({ role: 'executor', saved: {}, drafts: { executor: [{ profileId: 'x', endpoint: 'local' }] }, busy: false });
    assert.match(sparse, /模型未指定/, sparse);
    assert.match(sparse, /渠道未指定/, sparse);
    assert.match(sparse, /思考 未指定/, sparse);
    assert.match(sparse, /data-priority-state="enabled">启用</, '未写 enabled 就是启用，不是未知');
    // reasoning 有就写出来：它是适配层报的 fact，不是从模型名推的。
    const withReasoning = priorityHtml({ role: 'executor', saved: {}, drafts: { executor: [{ profileId: 'r', endpoint: 'local', facts: [{ key: 'provider', value: 'codebuddy' }, { key: 'model', value: 'deepseek-v4.1-flash' }, { key: 'reasoning', value: 'high' }] }] }, busy: false });
    assert.match(withReasoning, /思考 high/, withReasoning);
    // 国内外两个渠道直接可区分；未知 provider 保留原值、不猜渠道。
    const channels = priorityHtml({ role: 'executor', saved: {}, drafts: { executor: [
      { profileId: 'cn', endpoint: 'local', facts: [{ key: 'provider', value: 'codebuddy' }, { key: 'model', value: 'm1' }] },
      { profileId: 'intl', endpoint: 'local', facts: [{ key: 'provider', value: 'codebuddy-intl' }, { key: 'model', value: 'm1' }] },
      { profileId: 'qcn', endpoint: 'local', facts: [{ key: 'provider', value: 'qoder-cn' }, { key: 'model', value: 'm2' }] },
      { profileId: 'qgl', endpoint: 'local', facts: [{ key: 'provider', value: 'qoder' }, { key: 'model', value: 'm2' }] },
      { profileId: 'unknown', endpoint: 'local', facts: [{ key: 'provider', value: 'some-new-runtime' }, { key: 'model', value: 'm3' }] },
      { profileId: 'ctor', endpoint: 'local', facts: [{ key: 'provider', value: 'constructor' }, { key: 'model', value: 'm4' }] },
      { profileId: 'tostr', endpoint: 'local', facts: [{ key: 'provider', value: 'toString' }, { key: 'model', value: 'm4' }] },
      { profileId: 'proto', endpoint: 'local', facts: [{ key: 'provider', value: '__proto__' }, { key: 'model', value: 'm4' }] },
    ] }, busy: false });
    assert.match(channels, /codebuddy · CodeBuddy 国内/, channels);
    assert.match(channels, /codebuddy-intl · CodeBuddy 国际/, channels);
    assert.match(channels, /qoder-cn · Qoder 国内/, channels);
    assert.match(channels, /qoder · Qoder 国际/, channels);
    assert.match(channels, /data-candidate-provider="some-new-runtime">some-new-runtime</, '认不出的 provider 原样回显、不补渠道');
    assert.equal(/some-new-runtime · /.test(channels), false, '认不出的 provider 不该被编一个渠道');
    // provider 是外部输入。原型链上那几个键（constructor / toString / __proto__）
    // 用 PROVIDER_CHANNEL[raw] 查是「查得到」的，取回来是函数或对象，界面上就成了
    // 「constructor · function Object() { [native code] }」——替一个没核对过的值
    // 宣称它有渠道。所以查询只认自有属性，这几个键必须原样回显。
    for (const key of ['constructor', 'toString', '__proto__']) {
      assert.ok(channels.includes(`data-candidate-provider="${key}">${key}</span>`), `原型键 ${key} 应原样回显：` + channels);
      assert.equal(channels.includes(`${key} · `), false, `原型键 ${key} 不该被当成渠道：` + channels);
    }
    // 名称仍是外部输入：facts 与 profileId 里带尖括号不能变成真标签。
    const quoted = priorityHtml({ role: 'executor', saved: {}, drafts: { executor: [{ profileId: '<b>', endpoint: 'local', facts: [{ key: 'provider', value: '<img>' }, { key: 'model', value: '<script>' }] }] }, busy: false });
    assert.ok(!quoted.includes('<img>'), quoted);
    assert.ok(!quoted.includes('<script>'), quoted);
    assert.match(quoted, /&lt;script&gt;/, quoted);

  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
