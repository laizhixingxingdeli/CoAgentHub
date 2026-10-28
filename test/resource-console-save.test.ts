/**
 * 资源页保存真的打到 API（src/web/resource-console.js 的点击分支）。
 *
 * 前面的 test/resource-console.test.ts 只喂纯函数：它能证明 `postConfigure` 会拼出
 * 一条请求，却证明不了「点一下保存按钮」这条路径——按钮选择器、点击时的角色冻结、
 * 成功后的快照写回、409 的分流，全都只在 DOM 里成立。所以这里起一个**隔离的内存
 * API**，让页面的 fetch 真打到 127.0.0.1 上，断言请求条数与响应后的页面文案。
 *
 * 隔离是硬要求：正式池的 revision 是 CAS 基线，测试往里 POST 一次就会把真实调度
 * 顺序改掉，而屏幕上看起来只是「跑了一次测试」。
 *
 * 两条测试，对应验收的三条：
 *   1. 保存只发一次 POST、body 形状固定、成功采用新 revision 且不丢另一个角色的脏草稿。
 *   2. 外部改池后 STALE_POOL 不自动写回、重读只作对比、rebase 不发 POST；
 *      重复 profileId 的 409 不禁用保存（那是人能改的错，不是修订冲突）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Window, noHappyDom } from './helpers/happy-dom.ts';
import { InMemoryAgentPoolRepository } from '../src/application/agent-pool.ts';
import { createApi } from '../src/api/server.ts';
import { buildPlatform } from '../src/main.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import { leaveResourcePage, renderResourcePage } from '../src/web/resource-console.js';

const g = globalThis as any;

type Post = { url: string; body: any };

type Ctx = {
  base: string;
  agentPool: InMemoryAgentPoolRepository;
  container: any;
  posts: Post[];
  click: (selector: string) => Promise<void>;
  waitFor: (check: () => boolean, label: string) => Promise<void>;
  text: (selector: string) => string;
};

const SAVED_MESSAGE = '已保存，只影响以后的调度，不打断在途 Attempt';

/**
 * 起隔离 API + happy-dom，跑完无条件拆掉。
 *
 * 拆的顺序有讲究：先 leaveResourcePage（它要问 confirm，所以 confirm 必须先装好），
 * 再 close 服务、再还原 globalThis。少还原一个 globalThis.document，下一个测试文件
 * 就会拿着已经 close 的 window 跑，报的错与它自己毫无关系。
 */
async function withIsolatedPage(run: (ctx: Ctx) => Promise<void>): Promise<void> {
  const agentPool = new InMemoryAgentPoolRepository();
  await agentPool.add({ role: 'coordinator', profileId: 'c1', endpoint: 'local' });
  await agentPool.add({ role: 'executor', profileId: 'e1', endpoint: 'local' });

  // 用量读取打桩：真实实现会 spawn `npx tsx src/cli.ts usage`（本机实测约 14 秒），
  // 而页面挂载要等它（GET /api/pools 与 config 并行取）。隔离实例不该去起适配层
  // CLI：那是另一个服务、还要读凭据，且会把本测试推到超时。
  const server = createApi({
    ...buildPlatform(),
    agentPool,
    getRuntimeUsage: async () => ({ available: false, note: '隔离测试实例，不读适配层用量' }),
  });
  await listenLoopback(server, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const saved = {
    document: g.document,
    window: g.window,
    Element: g.Element,
    HTMLElement: g.HTMLElement,
    fetch: g.fetch,
    confirm: g.confirm,
  };

  const window = new Window({ url: base + '/#/pool' });
  const document = window.document;
  document.body.innerHTML = '<div id="view"></div>';
  g.window = window;
  g.document = document;
  // Element 必须挂：点击处理里有 `target instanceof Element`，Node 里没有这个全局时
  // 每个点击都从第一行返回，保存分支根本不跑——测试会「绿」，但什么都没验证。
  g.Element = window.Element;
  g.HTMLElement = window.HTMLElement;
  g.confirm = () => true;
  (window as any).confirm = () => true;

  const realFetch = saved.fetch;
  const posts: Post[] = [];
  // 页面用的是相对路径（/api/pools/...），这里补成隔离实例的 base：不补就会打到
  // 正式服务，或者直接抛「无效 URL」。
  g.fetch = (async (input: any, init: any) => {
    const raw = String(input);
    const url = raw.startsWith('http') ? raw : base + raw;
    if (init && String(init.method || '').toUpperCase() === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
    }
    return realFetch(url, init);
  }) as typeof fetch;

  const container = document.getElementById('view');
  const text = (selector: string): string => (container.querySelector(selector)?.textContent || '').trim();
  const click = async (selector: string): Promise<void> => {
    const element = container.querySelector(selector);
    assert.ok(element, `要点的元素不在页面上：${selector}`);
    element.dispatchEvent(new window.Event('click', { bubbles: true }) as unknown as Event);
    // 点击分支里带 await（POST / 读最新），等一拍让它们跑完再断言。
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  const waitFor = async (check: () => boolean, label: string): Promise<void> => {
    for (let i = 0; i < 300; i += 1) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`等待超时：${label}`);
  };

  try {
    await renderResourcePage(container);
    await waitFor(() => container.querySelector('[data-resource-row="c1"]') !== null, '出现 c1 行');
    await run({ base, agentPool, container, posts, click, waitFor, text });
  } finally {
    g.confirm = () => true;
    (window as any).confirm = () => true;
    leaveResourcePage();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    window.close();
    g.document = saved.document;
    g.window = saved.window;
    g.Element = saved.Element;
    g.HTMLElement = saved.HTMLElement;
    g.fetch = saved.fetch;
    g.confirm = saved.confirm;
  }
}

/** 页面上显示的修订：文案是「配置修订 <revision>」，比较 CAS 基线时只要后半段。 */
function revisionOnPage(text: (selector: string) => string): string {
  return text('[data-resource-revision]').replace('配置修订 ', '');
}

test('保存只发一次整角色 POST：成功采用新 revision，另一个角色的脏草稿还在', { skip: noHappyDom }, async () => {
  await withIsolatedPage(async ({ base, container, posts, click, waitFor, text }) => {
    const revisionBefore = revisionOnPage(text);
    assert.notEqual(revisionBefore, '', '页面没显示修订号，后面的 CAS 断言无从比起');

    // 协调者停用 c1。
    await click('[data-resource-row="c1"]');
    await click('[data-draft-toggle]');
    assert.equal(text('[data-resource-save-title]'), '有未保存修改');
    assert.equal(container.querySelector('[data-resource-save-button]').hasAttribute('disabled'), false);

    // 执行者停用 e1，然后切回协调者：两份草稿都要在，保存只交协调者那份。
    await click('[data-resource-role="executor"]');
    await click('[data-resource-row="e1"]');
    await click('[data-draft-toggle]');
    await click('[data-resource-role="coordinator"]');

    const before = posts.length;
    await click('[data-resource-save-button]');
    await waitFor(() => text('[data-resource-save-message]') === SAVED_MESSAGE, '出现成功文案');

    assert.equal(posts.length, before + 1, '一次保存只能发一条 POST');
    const sent = posts[posts.length - 1]!;
    assert.ok(sent.url.endsWith('/api/pools/coordinator/configure'), `POST 打到了 ${sent.url}`);
    assert.deepEqual(Object.keys(sent.body).sort(), ['candidates', 'expectedRevision']);
    assert.equal(typeof sent.body.expectedRevision, 'string');
    assert.notEqual(sent.body.expectedRevision, '', 'expectedRevision 是 CAS 基线，不能是空串');
    assert.equal(sent.body.candidates[0].profileId, 'c1');
    assert.equal(sent.body.candidates[0].enabled, false);

    const config = await (await fetch(`${base}/api/pools/config`)).json();
    assert.notEqual(config.revision, revisionBefore, '保存成功后服务端修订应当变了');
    assert.deepEqual(config.executor.map((row: any) => row.profileId), ['e1'], '执行者被协调者的保存带跑了');

    // 成功快照不该抹掉别人手里的改动。
    await click('[data-resource-role="executor"]');
    assert.equal(text('[data-resource-save-title]'), '有未保存修改', '执行者的停用草稿被成功快照覆盖了');
    await click('[data-resource-role="coordinator"]');
    assert.equal(text('[data-resource-save-message]'), SAVED_MESSAGE, '切页签把成功文案弄丢了');
  });
});

test('外部改池后保存得到 STALE_POOL 不自动写回；重复 profileId 的 409 不禁用保存', { skip: noHappyDom }, async () => {
  await withIsolatedPage(async ({ base, agentPool, container, posts, click, waitFor, text }) => {
    const revisionBefore = revisionOnPage(text);
    assert.notEqual(revisionBefore, '', '页面没显示修订号，后面的 CAS 断言无从比起');

    // 绕过页面改池：页面的 revision 就此过期，而草稿仍是人手上的那份。
    await agentPool.add({ role: 'executor', profileId: 'e2', endpoint: 'local' });

    await click('[data-resource-row="c1"]');
    await click('[data-draft-toggle]');
    await click('[data-resource-save-button]');
    await waitFor(() => text('[data-resource-save-message]').includes('候选池已变化'), '出现修订冲突文案');

    assert.equal(container.querySelector('[data-resource-save-button]').hasAttribute('disabled'), true,
      '修订冲突时保存必须禁用：再提也是白提');
    assert.ok(container.querySelector('[data-resource-compare]'), '冲突时要给「重新读取最新」');
    assert.ok(text('[data-resource-row="c1"]').includes('停用'), '冲突把行内的停用草稿擦掉了');
    assert.ok(text('[data-resource-revision]').includes(revisionBefore), '冲突时修订不该被悄悄换成最新');

    // 重新读取只是对比材料：不换 revision、不动草稿、更不发 POST。
    await click('[data-resource-compare]');
    await waitFor(() => container.querySelector('[data-resource-latest]') !== null, '出现最新配置');
    // 比较面板渲染的是**当前角色切片**（resource-console.js 只画 latest[role]），
    // 停在 coordinator 页签时外部加的 executor 候选不该出现在这里。解析成 JSON 再断言，
    // 否则一句空字符串也能「不含 e2」地蒙混过去。
    const latestSlice = JSON.parse(text('[data-resource-latest]'));
    assert.ok(Array.isArray(latestSlice), '比较面板不是候选数组，切片断言无从做起');
    assert.ok(latestSlice.map((row: any) => row.profileId).includes('c1'), '比较面板没显示当前角色的候选');
    assert.equal(latestSlice.map((row: any) => row.profileId).includes('e2'), false,
      '比较面板混进了别的角色的候选：切片边界破了');

    // 但服务端确实已经多了一条：重读只是没把它画进当前角色的切片，不是没读到、
    // 更不是把它清掉了。页面修订也必须仍是旧的（重读不等于采用）。
    const latestConfig = await (await fetch(base + '/api/pools/config')).json();
    assert.ok(latestConfig.executor.map((row: any) => row.profileId).includes('e2'),
      '服务端已经没有外部加的 executor 候选：重读路径把它清掉了');
    assert.ok(text('[data-resource-revision]').includes(revisionBefore), '重读最新不该改页面修订');

    const beforeRebase = posts.length;
    await click('[data-resource-rebase]');
    assert.equal(posts.length, beforeRebase, 'rebase 只换 CAS 基线，不许自动写回');
    const revisionAfterRebase = revisionOnPage(text);
    assert.notEqual(revisionAfterRebase, '', 'rebase 后页面没显示修订，下面的换基线断言就会空过');
    assert.notEqual(revisionAfterRebase, revisionBefore,
      'rebase 没把比较读到的 latest.revision 换成 CAS 基线，下一次保存还会再撞一次冲突');
    assert.equal(text('[data-resource-save-message]'), '草稿保留，请重新保存。');
    assert.equal(container.querySelector('[data-resource-save-button]').hasAttribute('disabled'), false);

    await click('[data-resource-save-button]');
    await waitFor(() => text('[data-resource-save-message]') === SAVED_MESSAGE, 'rebase 后保存成功');
    assert.equal(posts.length, beforeRebase + 1);
    assert.ok(posts[posts.length - 1]!.url.endsWith('/api/pools/coordinator/configure'));

    const revisionAfterSave = revisionOnPage(text);
    assert.notEqual(revisionAfterSave, revisionBefore);

    // 重复 profileId：人能自己改的错，说清原因但别把保存锁死。
    await click('[data-resource-add]');
    container.querySelector('[data-add-profile]').value = 'c1';
    // 端点是下拉，只受已返回过的端点：这条测试的池里已经有 'local'。
    container.querySelector('[data-add-endpoint]').value = 'local';
    await click('[data-add-join]');
    await click('[data-resource-save-button]');
    await waitFor(() => text('[data-resource-save-message]').includes('profileId=c1'), '出现重复 profileId 文案');

    assert.equal(container.querySelector('[data-resource-save-button]').hasAttribute('disabled'), false,
      '重复 profileId 是人能改的错，不能像修订冲突那样禁用保存');
    assert.equal(container.querySelectorAll('[data-resource-row="c1"]').length, 2, '重复那条草稿行不该消失');
    assert.equal(posts[posts.length - 1]!.body.expectedRevision, revisionAfterSave,
      '这次提交的基线应当是保存后的新修订，不是最初的 R1');

    // 只验证这一条请求的基线，不替页面再点一次保存：第二次成功会把这条错误掩盖掉。
    const config = await (await fetch(`${base}/api/pools/config`)).json();
    assert.equal(config.revision, revisionAfterSave, '失败的保存不该改服务端修订');
  });
});
