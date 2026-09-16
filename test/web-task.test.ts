/**
 * 任务详情页（src/web/task.js）。
 *
 * 正式页在这个仓库里**不在测试的浏览器里**：字段名读错一个，界面照样渲染，
 * 只是那一格永远是 —。所以这个文件分三层守：
 *
 *   1. 文件形状 —— 路由、modulepreload、data-mission-id。这些跨文件，写错了
 *      只有运行时才看得见（浏览器里一个 404，或者点了没反应）。
 *   2. 纯渲染函数喂假数据 —— 事件流、tab、页头、转义、跟随判据。
 *   3. 真读模型喂真渲染函数 —— 页面读的字段必须后端真的给
 *      （同 web.test.ts 为观测面补的那个坑）。
 *
 * 第 2 层里的 shouldFollow 看着只是三个数字比大小，但它是这份代码里唯一一个
 * "判据时机错了就没人报 bug"的地方：在追加之后量，人上滚看历史就会被每一行
 * 新输出拽回底部。四条判据里有三条在钉这个。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { InMemoryLiveOutput } from '../src/application/live.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';

// 读进来就归一化行尾：仓库在 Windows 上 checkout 出来是 CRLF（core.autocrlf）。
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/web/${name}`, import.meta.url)), 'utf8')
    .replace(/\r\n/g, '\n');

/** 取某个 CSS 规则的花括号内容。 */
const ruleBody = (css: string, selector: RegExp): string => {
  const hit = selector.exec(css);
  assert.ok(hit, `找不到规则 ${selector.source}`);
  return hit[1].replace(/\s+/g, ' ');
};

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

/**
 * **不传 webRoot**：这条要验的正是"默认就是 src/web/"，其中包含 /task.js。
 * 传个临时目录进去，测到的就只是那几个假文件。
 */
async function serveDefaultWebRoot(): Promise<{
  platform: Platform;
  live: InMemoryLiveOutput;
  base: string;
}> {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const live = new InMemoryLiveOutput();
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    workspace: new InPlaceWorkspaceManager(),
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
  });
  const server = createApi({ platform, tokens: new RunTokenRegistry(), deliveries, live });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  return { platform, live, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** 一条跑起来的任务：契约、事件流、尝试、升级、diff、实时输出各给一份。 */
async function seedMission(): Promise<{ platform: Platform; base: string }> {
  const { platform, live, base } = await serveDefaultWebRoot();
  await platform.createMission({
    projectId: 'proj-task',
    missionId: 'M-task',
    contract: {
      intent: '把任务页做出来',
      acceptance: ['能看到事件流'],
      constraints: [],
      nonGoals: [],
      guardrails: [],
    },
  });
  const coord = await platform.startCoordinatorAttempt('M-task', {
    profileId: 'coordinator-default',
    endpoint: 'http://127.0.0.1:9/send',
  });
  await platform.updatePlan('M-task', coord.attemptId, {
    findings: 'f',
    rejectedHypotheses: [],
    decisions: [],
    direction: 'd',
    risks: [],
  });
  const { workItemId } = await platform.createWorkItem('M-task', coord.attemptId, {
    title: 'W-1',
    order: {
      objective: 'o',
      allowedScope: ['src/a.ts'],
      requiredBehaviour: 'b',
      constraints: [],
      acceptance: ['a'],
      verification: ['node --test'],
      doNot: [],
      contextRefs: [],
    },
  });
  await platform.dispatchWorkItems('M-task', coord.attemptId, [workItemId]);
  await platform.recordWorkspace('M-task', {
    projectRoot: '/repo/task',
    branch: 'mission/M-task',
    baseRevision: 'deadbeef',
  });
  const exec = await platform.startExecutorAttempt('M-task', workItemId, {
    profileId: 'executor-default',
    endpoint: 'http://127.0.0.1:9/send',
  });
  await platform.submitEvidence('M-task', exec.attemptId, {
    kind: 'test',
    summary: 'node --test 全绿',
    command: 'node --test',
    exitCode: 0,
  });
  await platform.escalateToL3('M-task', coord.attemptId, {
    question: '要不要一起改内核？',
    why: '改了会波及别的 Mission',
    optionsConsidered: ['只改前端', '先加读模型'],
  });
  await live.append({ missionId: 'M-task', attemptId: exec.attemptId, kind: 'text', text: '正在读工单' });
  await live.append({
    missionId: 'M-task',
    attemptId: exec.attemptId,
    kind: 'usage',
    usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, total: 14, quality: 'reported' },
  });
  return { platform, base };
}

/* ===================== 1. 文件形状 ===================== */

describe('任务页的文件形状', () => {
  test('task.js 在，且是静态服务认得的扁平小写名', () => {
    assert.ok(existsSync(new URL('../src/web/task.js', import.meta.url)), '缺 src/web/task.js');
    assert.match('task.js', /^[a-z0-9][a-z0-9._-]*\.(html|css|js|svg)$/);
  });

  test('index.html modulepreload 了 task.js，且没有第二个会执行的 script', () => {
    const html = read('index.html');
    assert.match(html, /<link rel="modulepreload" href="\/task\.js" \/>/);
    // app.js import task.js；再写一个 <script src="/task.js"> 会让它执行两遍，
    // 定时器与监听各注册两次。
    assert.equal(/<script[^>]+src="\/task\.js"/.test(html), false, 'task.js 被写成会执行的 script');
    assert.equal((html.match(/<script type="module"/g) || []).length, 1, '外壳只该有一个入口 script');
  });

  test('app.js import task.js 并认得 #/missions/<id>', () => {
    const shell = read('app.js');
    assert.match(shell, /from '\.\/task\.js'/);
    assert.match(shell, /renderTaskPage/);
    assert.ok(shell.includes('/missions/'), 'parseRoute 要认 #/missions/<missionId>');
    // 项目页仍在：任务页是加进去的第四种路由，不是替掉项目页。
    assert.match(shell, /from '\.\/projects\.js'/);
    assert.ok(shell.includes("location.hash = '#/projects'"), '空/未知 hash 仍要打回项目页');
    // 「无 id 的 #/missions」不该被当成一条真任务。
    assert.ok(shell.includes(String.raw`/^\/missions\/(.+)$/.exec(raw)`), 'parseRoute 里要有一条真能匹配 #/missions/<id> 的正则');
  });

  test('项目页任务行带 data-mission-id，且没内联 onclick', () => {
    const page = read('projects.js');
    assert.match(page, /data-mission-id="' \+ esc\(m\.missionId\)/, '属性值必须经过 esc');
    assert.ok(page.includes("location.hash = '#/missions/'"), '点击要改写 hash 到任务页');
    assert.equal(/onclick=/.test(page), false, 'HTML 里内联 onclick：测得到形状测不到行为');
  });

  test('侧栏用 sidebar 令牌，正文区不用', () => {
    const html = read('index.html');
    const nav = ruleBody(html, /\.nav\s*\{([^}]*)\}/s);
    for (const token of ['--sidebar', '--sidebar-foreground']) {
      assert.ok(nav.includes(`var(${token})`), `.nav 没引用 var(${token})`);
    }
    // 激活项归侧栏。写错一个字母不会报错，只会侧栏还是白的。
    const active = ruleBody(html, /\.nav \.item\[data-active="1"\]\s*\{([^}]*)\}/s);
    assert.ok(active.includes('var(--sidebar-accent)'), '激活项要用 var(--sidebar-accent)');

    // 正文区域保持原样：侧栏黑不等于整页黑。
    for (const [name, re] of [
      ['.main', /^\.main\s*\{([^}]*)\}/m],
      ['.topbar', /^\.topbar\s*\{([^}]*)\}/m],
      ['.view', /^\.view\s*\{([^}]*)\}/m],
      ['.card', /^\.card\s*\{([^}]*)\}/m],
      ['.page', /^\.page\s*\{([^}]*)\}/m],
    ] as [string, RegExp][]) {
      const body = ruleBody(html, re);
      assert.equal(/--sidebar/.test(body), false, `${name} 不该改成 sidebar 令牌`);
    }
    assert.match(ruleBody(html, /^\.card\s*\{([^}]*)\}/m), /var\(--card\)/);
    assert.match(ruleBody(html, /^\.view\s*\{([^}]*)\}/m), /padding/);
  });

  test('任务页样式在 index.html 里，终端块用 --terminal-*', () => {
    const html = read('index.html');
    assert.match(html, /pre\.term\s*\{[^}]*var\(--terminal-bg\)/s);
    assert.match(html, /pre\.term\s*\{[^}]*var\(--terminal-fg\)/s);
    assert.match(html, /\.evt\[data-active="1"\]/, '选中事件要有高亮样式');
    assert.match(html, /button\[disabled\]/, 'disabled 的停止按钮要看得出不可点');
    assert.equal(existsSync(new URL('../src/web/task.css', import.meta.url)), false, '不另起 task.css');
  });

  test('task.js 取的锚点在它自己的骨架里都在', async () => {
    // 跨文件才看得见的错：renderTaskPage 靠 id 接页面，写错一个字母不报错，
    // 只会静静地往 null 上写 innerHTML——整屏白。（同 web-shell 对外壳的断言。）
    const src = read('task.js');
    const ids = [...src.matchAll(/querySelector\('#([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(ids.length >= 5, '该从骨架里取到五个区域锛点，拿到了：' + ids.join(','));
    const { skeletonHtml } = await import('../src/web/task.js');
    const skeleton = skeletonHtml();
    for (const id of ids) {
      assert.ok(skeleton.includes(`id="${id}"`), `task.js 取 #${id}，骨架里没有`);
    }
  });

  test('这一页只读：不发 POST，也不碰写操作', () => {
    const src = read('task.js');
    assert.equal(/method:\s*'POST'/.test(src), false, '不许发写请求');
    assert.match(src, /cache: 'no-store'/, '读接口不该被缓存住');
    // cursor 是实时输出的全部要点：不带 cursor 就是每次从头拉。
    assert.match(src, /\/live\?cursor=/);
  });
});

/* ===================== 2. 纯函数喂假数据 ===================== */

/** 与实现无关的本地时间算式：断言"渲染出来的是本地时间"而不是抄实现。 */
function localStamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

describe('任务页的纯渲染函数', () => {
  const loaded = import('../src/web/task.js');

  test('事件流：时间本地化、kind、关联 id、选中高亮', async () => {
    const { eventStreamHtml } = await loaded;
    const events = [
      { at: '2026-03-04T05:06:07.000Z', kind: 'mission.created', data: {} },
      {
        at: '2026-03-04T05:06:08.000Z',
        kind: 'attempt.started',
        workItemId: 'W-7',
        attemptId: 'W-7.exec-1',
        data: {},
      },
    ];
    const html = eventStreamHtml(events, 1);
    assert.ok(html.includes(localStamp('2026-03-04T05:06:07.000Z')), '时间没按本地时区渲染');
    assert.equal(html.includes('2026-03-04T05:06:07'), false, '直接切了 ISO 字符串：时区会差几小时');
    assert.ok(html.includes('attempt.started') && html.includes('mission.created'), 'kind 要上屏');
    assert.ok(html.includes('W-7 · W-7.exec-1'), '关联的 workItemId / attemptId 要显示');
    assert.match(html, /data-event-key="1" data-active="1"/, '选中项要标出来');
    assert.equal(html.includes('data-event-key="0" data-active'), false, '只该有一条是选中的');
    // 没有关联 id 的事件不显示那一行：空的一行看着像坏了。
    assert.equal(html.split('<div class="evt-refs').length, 2);
  });

  test('事件流：关联 id 缺省不显示；空事件流有说明句', async () => {
    const { eventStreamHtml } = await loaded;
    assert.match(eventStreamHtml([], null), /还没有事件/);
    assert.match(eventStreamHtml(undefined, null), /还没有事件/);
    assert.equal(eventStreamHtml([{ at: '', kind: 'x' }], null).includes('evt-refs'), false);
  });

  test('五个 tab 文案齐，active 跟着入参走', async () => {
    const { tabBarHtml, TASK_TABS } = await loaded;
    assert.deepEqual([...TASK_TABS], ['实时输出', '文件变更', '验证结果', '相关消息', '原始数据']);
    for (const tab of TASK_TABS) {
      const html = tabBarHtml(tab);
      for (const each of TASK_TABS) assert.ok(html.includes('>' + each + '<'), `少了标签 ${each}`);
      assert.match(html, new RegExp(`data-tab="${tab}" data-active="1"`), `${tab} 该是选中态`);
      assert.equal(html.match(/data-active="1"/g)?.length, 1, '选中项只能有一个');
    }
  });

  test('切 tab 是纯函数出 HTML：同一份数据不同 activeTab 出不同内容', async () => {
    const { tabPanelHtml } = await loaded;
    const data = {
      live: { lines: [{ at: '2026-03-04T05:06:07.000Z', kind: 'text', text: '正在读工单' }] },
      diff: { stat: '2 files changed, 9 insertions(+)', files: ['src/a.ts'] },
      evidence: [{ kind: 'test', summary: '全绿', command: 'node --test', exitCode: 0 }],
      escalationLog: [{ question: '要不要改内核？', why: '会波及别人', optionsConsidered: ['只改前端'] }],
      event: { kind: 'attempt.started', at: '2026-03-04T05:06:07.000Z' },
    };
    assert.match(tabPanelHtml('实时输出', data), /正在读工单/);
    assert.match(tabPanelHtml('文件变更', data), /2 files changed/);
    assert.match(tabPanelHtml('验证结果', data), /exit=0/);
    assert.match(tabPanelHtml('相关消息', data), /要不要改内核？/);
    assert.match(tabPanelHtml('原始数据', data), /attempt\.started/);
    // 认不出的标签不崩，也不留白。
    assert.match(tabPanelHtml('没有这个标签', data), /不认识的标签/);
  });

  test('实时输出：usage chunk 不当终端行；空时有说明句；有自动滚动勾选', async () => {
    const { livePanelHtml } = await loaded;
    const empty = livePanelHtml({ lines: [] });
    assert.match(empty, /还没有实时输出/, '黑空一块看起来像坏了');
    assert.match(empty, /data-autoscroll/, '要能关掉自动滚动');
    assert.match(empty, /checked/, '默认开着');
    assert.match(empty, /class="term"/);

    const withUsage = livePanelHtml({
      lines: [{ at: '2026-03-04T05:06:07.000Z', kind: 'text', text: '第一行' }],
      usage: { total: 1234 },
    });
    assert.ok(withUsage.includes('第一行'));
    assert.equal(withUsage.includes('undefined'), false, 'usage chunk 被当终端行拼进来了');
    assert.match(withUsage, /tokens 1,234/);
    // tool 行有它自己的形状；默认关滚动时勾选框不该是选中的。
    assert.match(
      livePanelHtml({ lines: [{ kind: 'tool', text: 'read a.ts' }], autoScroll: false }),
      /▸ read a\.ts/,
    );
    assert.equal(
      livePanelHtml({ lines: [], autoScroll: false }).includes(' checked'),
      false,
      'autoScroll=false 时勾选框不该是选中的',
    );
  });

  test('终端行：usage chunk 不当行拼，时间只到钟点', async () => {
    const { liveLinesHtml } = await loaded;
    const html = liveLinesHtml([
      { at: '2026-03-04T05:06:07.000Z', kind: 'text', text: '第一行' },
      { at: '2026-03-04T05:06:08.000Z', kind: 'usage', usage: { total: 7 } },
      { at: '2026-03-04T05:06:09.000Z', kind: 'tool', text: 'read src/a.ts' },
    ]);
    assert.equal(html.includes('undefined'), false, 'usage chunk 被当终端行拼进去了');
    assert.equal(html.includes('"total"'), false);
    assert.ok(html.includes('▸ read src/a.ts'));
    // 终端里每行前摆个日期太长；到秒就够了。
    assert.ok(html.includes(localStamp('2026-03-04T05:06:07.000Z').slice(11)), html);
    assert.equal(html.includes(localStamp('2026-03-04T05:06:07.000Z')), false, '终端行不该带日期');
  });

  test('文件变更：stat 与文件清单；没有工作区时不空白', async () => {
    const { diffPanelHtml } = await loaded;
    const html = diffPanelHtml({ stat: ' src/a.ts | 3 ++-', files: ['src/a.ts', 'src/b.ts'] });
    assert.ok(html.includes('src/a.ts | 3'));
    assert.ok(html.includes('<li class="mono">src/b.ts</li>'));
    assert.match(diffPanelHtml({ stat: '', files: [] }), /（无改动）/);
    assert.match(diffPanelHtml(null), /读取中/);
    assert.match(diffPanelHtml({ error: 'HTTP 500' }), /读不到改动/);
  });

  test('验证结果：kind / summary / command / exitCode 都上屏；没有时是说明', async () => {
    const { evidencePanelHtml } = await loaded;
    const html = evidencePanelHtml([
      { kind: 'test', summary: '274 条全绿', command: 'node --test', exitCode: 0 },
      { kind: 'observation', summary: '看了日志' },
    ]);
    assert.ok(html.includes('274 条全绿') && html.includes('node --test') && html.includes('exit=0'));
    assert.ok(html.includes('看了日志'));
    assert.match(evidencePanelHtml([]), /没有对应证据/);
    assert.match(evidencePanelHtml(undefined), /没有对应证据/);
  });

  test('相关消息：问答与备选都上屏；没有答复要说明', async () => {
    const { escalationPanelHtml } = await loaded;
    const html = escalationPanelHtml([
      {
        question: '要不要一起改内核？',
        why: '改了会波及别的 Mission',
        optionsConsidered: ['只改前端', '先加读模型'],
      },
      {
        question: '第二问',
        why: '第二个理由',
        optionsConsidered: [],
        answer: '改吧',
      },
    ]);
    assert.ok(html.includes('要不要一起改内核？'));
    assert.ok(html.includes('改了会波及别的 Mission'));
    assert.ok(html.includes('只改前端'));
    assert.ok(html.includes('还没有答复'), '未答复要看得出来——那是"在等你"');
    assert.ok(html.includes('答复：改吧'));
    assert.match(escalationPanelHtml([]), /没有升级过问题/);
  });

  test('原始数据：整条 JSON 等宽显示；没选中时说明', async () => {
    const { rawPanelHtml } = await loaded;
    const html = rawPanelHtml({ kind: 'evidence.submitted', data: { exitCode: 0 } });
    // JSON 里的引号也被 esc 转掉了，所以这里对的是转义后的形。
    assert.ok(html.includes('&quot;kind&quot;: &quot;evidence.submitted&quot;'), html);
    assert.match(html, /class="term"/);
    assert.match(rawPanelHtml(null), /没有选中事件/);
  });

  test('页头：intent、阶段中文、状态 chip、三统计格、disabled 的停止按钮', async () => {
    const { headerHtml } = await loaded;
    const view = {
      projectId: 'p',
      missionId: 'M1',
      status: 'executing',
      paused: false,
      updatedAt: '2026-03-04T06:00:00.000Z',
      usage: { total: 12345 },
      contract: { intent: '做任务页' },
    };
    const activity = [
      { at: '2026-03-04T05:00:00.000Z', kind: 'mission.created' },
      { at: '2026-03-04T05:30:00.000Z', kind: 'attempt.started' },
    ];
    const html = headerHtml(view, activity, '2026-03-04T08:00:00.000Z');
    assert.ok(html.includes('做任务页'), '标题是 contract.intent');
    assert.ok(html.includes('执行中'), '阶段 chip 用内核 MissionStatus 的中文');
    assert.ok(html.includes('进行中'), '状态 chip 是第二根轴');
    assert.ok(html.includes('12,345'), '总消耗读 usage.total 并带千分位');
    assert.ok(html.includes('3 小时 0 分'), `运行时长该是创建时间到传入的 nowIso，出来是：${html}`);
    assert.ok(html.includes(localStamp('2026-03-04T05:00:00.000Z')), '创建时间取事件流第一条');
    assert.match(html, /disabled title="API 尚无鉴权，写操作暂不开放"/);
    assert.ok(html.includes('停止任务'));
    assert.equal(html.includes('onclick'), false, '不绑定点击：不发 POST');
  });

  test('页头：创建时间取的是 activity 第一条，不是最后一条', async () => {
    const { headerHtml } = await loaded;
    const view = { status: 'executing', contract: { intent: 'x' }, usage: { total: 0 } };
    const activity = [
      { at: '2026-03-04T05:00:00.000Z', kind: 'mission.created' },
      { at: '2026-03-04T09:00:00.000Z', kind: 'attempt.started' },
    ];
    const html = headerHtml(view, activity, '2026-03-04T09:30:00.000Z');
    assert.ok(html.includes(localStamp('2026-03-04T05:00:00.000Z')), '创建时间该是第一条的时间');
    assert.ok(html.includes('4 小时 30 分'), '活着的任务时长跑到传入的 nowIso');
  });

  test('页头：终态的时长停在 updatedAt，不是"现在"', async () => {
    const { headerHtml } = await loaded;
    const view = {
      status: 'completed',
      paused: false,
      updatedAt: '2026-03-04T07:00:00.000Z',
      contract: { intent: 'x' },
      usage: { total: 1 },
    };
    const html = headerHtml(view, [{ at: '2026-03-04T05:00:00.000Z' }], '2026-12-31T23:59:00.000Z');
    assert.ok(html.includes('2 小时 0 分'), '已完成的任务时长该停在 updatedAt，而不是墙上时钟');
    assert.ok(html.includes('已完成') && html.includes('等你检视') === false);
  });

  test('页头：空契约、缺 usage、没有事件流都塌不了', async () => {
    const { headerHtml } = await loaded;
    const html = headerHtml({ status: 'investigating', contract: { intent: '' } }, [], '2026-03-04T05:00:00.000Z');
    assert.ok(html.includes('（没有契约）'));
    assert.ok(html.includes('调查中'));
    // 缺数据是 —，不是 NaN / undefined——那两个字上屏等于把字段名写错这件事藏起来。
    assert.equal(/NaN|undefined|null/.test(html), false, `上屏了 NaN/undefined：${html}`);
    assert.ok(html.includes('—'));
  });

  test('事件详情：kind / 时间 / causationId / profile / 用量', async () => {
    const { eventDetailHtml } = await loaded;
    const event = {
      kind: 'attempt.started',
      at: '2026-03-04T05:06:07.000Z',
      workItemId: 'W-7',
      causationId: 'W-7.exec-1',
    };
    const attempt = {
      profile: { profileId: 'executor-default', endpoint: 'http://127.0.0.1:9/send' },
      usage: { total: 4321 },
    };
    const html = eventDetailHtml(event, attempt);
    assert.ok(html.includes('attempt.started') && html.includes('causationId'));
    assert.ok(html.includes('W-7.exec-1') && html.includes('W-7'));
    assert.ok(html.includes('executor-default') && html.includes('http://127.0.0.1:9/send'));
    assert.ok(html.includes('4,321'));
    assert.ok(html.includes(localStamp('2026-03-04T05:06:07.000Z')));
  });

  test('事件详情：没选中 / 没有 causationId 时是 —，不是空白也不是崩', async () => {
    const { eventDetailHtml } = await loaded;
    const none = eventDetailHtml(null, null);
    assert.ok(none.includes('—'));
    assert.equal(/undefined|NaN/.test(none), false);
    assert.match(none, /没有选中事件/);
    // mission.created 没有 causationId（JSON 会省掉这个键），profile/用量才是 —
    const created = eventDetailHtml({ kind: 'mission.created', at: '2026-03-04T05:06:07.000Z' }, null);
    assert.ok(created.includes('mission.created'));
    assert.equal(created.includes('executor-default'), false);
  });

  test('面包屑三段，前两段是链接', async () => {
    const { crumbParts } = await loaded;
    const parts = crumbParts('proj-a', 'M-1');
    assert.deepEqual(parts, [
      { text: '项目', href: '#/projects' },
      { text: 'proj-a', href: '#/projects/proj-a' },
      { text: '任务 M-1', here: true },
    ]);
    assert.equal(parts[2].href, undefined, '当前页不该是链接');
    // 带斜杠 / 带百分号的 id 要能编回一条解得开的 hash。
    const odd = crumbParts('a/b c', 'M-1');
    assert.equal(odd[1].href, '#/projects/' + encodeURIComponent('a/b c'));
    // 读不到 view 时中间那段干脆没有，而不是一个指向不存在项目的 —。
    assert.deepEqual(crumbParts('', 'M-1').map((p) => p.text), ['项目', '任务 M-1']);
  });

  test('不守规矩的字段进不了 DOM', async () => {
    const {
      headerHtml, eventStreamHtml, eventDetailHtml, livePanelHtml, diffPanelHtml,
      evidencePanelHtml, escalationPanelHtml, rawPanelHtml, tabBarHtml,
    } = await loaded;
    const evil = '<img src=x onerror="alert(1)">';
    const pages: [string, boolean][] = [
      [headerHtml({ status: evil, contract: { intent: evil }, usage: { total: 1 } }, [], '2026-03-04T05:00:00.000Z'), true],
      [eventStreamHtml([{ at: '2026-03-04T05:06:07.000Z', kind: evil, attemptId: evil }], 0), true],
      [eventDetailHtml({ kind: evil, at: '', causationId: evil }, { profile: { profileId: evil }, usage: { total: 1 } }), true],
      [livePanelHtml({ lines: [{ at: '2026-03-04T05:06:07.000Z', kind: 'text', text: evil }] }), true],
      [diffPanelHtml({ stat: evil, files: [evil] }), true],
      [evidencePanelHtml([{ kind: evil, summary: evil, command: evil, exitCode: 1 }]), true],
      [escalationPanelHtml([{ question: evil, why: evil, optionsConsidered: [evil], answer: evil }]), true],
      [rawPanelHtml({ kind: evil, nested: { deep: evil } }), true],
      // tab 条只画已知的那五个词，外部输入进不了它；这里验的是它不会把入参原样回显。
      [tabBarHtml(evil), false],
    ];
    for (const [html, mustShowEscaped] of pages) {
      assert.equal(html.includes('<img'), false, `外部输入被当标签解析了：${html}`);
      if (mustShowEscaped) assert.ok(html.includes('&lt;img'), `该看到转义后的形式：${html}`);
      else assert.equal(html.includes(evil), false, 'tabBar 不该把入参回显上屏');
    }
  });
});

describe('自动滚动跟随判据', () => {
  const loaded = import('../src/web/task.js');

  test('勾选 + 贴底 → 跟随', async () => {
    const { shouldFollow } = await loaded;
    assert.equal(shouldFollow({ autoScroll: true, scrollTop: 900, clientHeight: 100, scrollHeight: 1000 }), true);
  });

  test('勾选但上滚看历史 → 不跟随', async () => {
    const { shouldFollow } = await loaded;
    assert.equal(shouldFollow({ autoScroll: true, scrollTop: 0, clientHeight: 100, scrollHeight: 1000 }), false);
    // 32px 以内仍算贴底：差几像素不该让人错过最新一行。
    assert.equal(shouldFollow({ autoScroll: true, scrollTop: 868, clientHeight: 100, scrollHeight: 1000 }), true);
    assert.equal(shouldFollow({ autoScroll: true, scrollTop: 867, clientHeight: 100, scrollHeight: 1000 }), false);
  });

  test('没勾选 → 一律不跟随，哪怕正贴底', async () => {
    const { shouldFollow } = await loaded;
    assert.equal(shouldFollow({ autoScroll: false, scrollTop: 900, clientHeight: 100, scrollHeight: 1000 }), false);
  });

  test('追加抬高 scrollHeight 后同一 scrollTop 变为不跟随 —— 所以必须追加前量', async () => {
    const { shouldFollow } = await loaded;
    const before = { autoScroll: true, scrollTop: 860, clientHeight: 100, scrollHeight: 960 };
    assert.equal(shouldFollow(before), true, '追加前贴着底');
    // 同一次追加把 scrollHeight 抬到 1100：追加**后**再量就是 false，
    // 于是"跟随"这个开关在界面上表现为只跟一半，且没人会当 bug 报。
    const after = { autoScroll: true, scrollTop: 860, clientHeight: 100, scrollHeight: 1100 };
    assert.equal(shouldFollow(after), false, '追加后再量：这正是判据时机写反的形状');
  });

  test('入参缺失不崩（首帧还没有 pre）', async () => {
    const { shouldFollow } = await loaded;
    assert.equal(shouldFollow(), false);
    assert.equal(shouldFollow({ autoScroll: true }), true, '全是 0 视为贴底：首帧要落在最新一行');
  });
});

/* ===================== 3. 真读模型喂真渲染函数 ===================== */

describe('真 API 字段喂真渲染函数', () => {
  test('任务页读的每个字段后端都真的给', async () => {
    const { platform, base } = await seedMission();
    assert.ok(platform);

    const view = (await (await fetch(`${base}/api/missions/M-task`)).json()) as Record<string, any>;
    for (const field of ['contract', 'status', 'paused', 'projectId', 'usage', 'escalationLog', 'updatedAt']) {
      assert.ok(field in view, `页头/详情读 view.${field}，读模型没给`);
    }
    assert.equal(view.contract.intent, '把任务页做出来');
    assert.equal(view.projectId, 'proj-task');
    assert.equal(typeof view.usage.total, 'number');
    assert.equal(view.escalationLog.length, 1, '升级问答要传出来，相关消息那一 tab 靠它');

    // MissionView 没有 createdAt —— 页头那格取的是事件流第一条。
    assert.equal('createdAt' in view, false, 'createdAt 不该被当成已有字段来读');

    const activity = (await (await fetch(`${base}/api/missions/M-task/activity`)).json()) as Record<
      string,
      any[]
    >;
    assert.ok(Array.isArray(activity), 'activity 是数组');
    assert.ok(activity.length >= 5);
    for (const event of activity) {
      assert.equal(typeof event.at, 'string', '每条事件都要有 at');
      assert.equal(typeof event.kind, 'string', '每条事件都要有 kind');
    }
    const startedRows = activity.filter((e) => e.kind === 'attempt.started');
    assert.ok(startedRows.length >= 2, '协调者与执行者各该有一条 attempt.started');
    for (const row of startedRows) {
      assert.ok(row.causationId, 'attempt.started 该带 causationId——右上详情去取 attempt 的钥匙');
      assert.equal(row.causationId, row.attemptId, '这一跳由那次尝试引发');
    }
    // 证据只挂在执行者的 attempt 上，所以取带 workItemId 的那一条。
    const started = startedRows.find((e) => e.workItemId) ?? startedRows[startedRows.length - 1];
    // mission.created 没有 causationId：JSON 会省略 undefined 键，别照着它断言。
    const created = activity.find((e) => e.kind === 'mission.created');
    assert.equal('causationId' in (created ?? {}), false, '没有 causationId 时后端不该塞 null 进来');

    const attempt = (await (
      await fetch(`${base}/api/missions/M-task/attempts/${encodeURIComponent(started.causationId)}`)
    ).json()) as Record<string, any>;
    for (const field of ['profile', 'usage', 'evidence']) {
      assert.ok(field in attempt, `事件详情/验证结果读 attempt.${field}，读模型没给`);
    }
    assert.equal(attempt.evidence.length, 1, '执行者那条 attempt 上要能看到证据');
    assert.equal(attempt.evidence[0].command, 'node --test');
    assert.equal(attempt.profile.profileId, 'executor-default');

    const diff = (await (await fetch(`${base}/api/missions/M-task/diff`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal(typeof diff.stat, 'string', '文件变更读 stat');
    assert.ok(Array.isArray(diff.files), '文件变更读 files');

    const live = (await (await fetch(`${base}/api/missions/M-task/live?cursor=0`)).json()) as {
      cursor: number;
      chunks: { seq: number; kind: string; text?: string; usage?: { total: number } }[];
    };
    assert.equal(typeof live.cursor, 'number', '实时输出是游标轮询，必须回 cursor');
    assert.ok(Array.isArray(live.chunks) && live.chunks.length === 2);
    assert.equal(live.cursor, live.chunks.at(-1)?.seq, 'cursor 要能续上，否则第二次拉会重复');
  });

  test('GET /task.js 取得到（浏览器那边不是 404）', async () => {
    const { base } = await seedMission();
    const res = await fetch(`${base}/task.js`);
    assert.equal(res.status, 200, '/task.js 不满足 SAFE_NAME 或没写出来，就是浏览器里的白屏');
    assert.match(res.headers.get('content-type') ?? '', /javascript/);
  });

  test('真 JSON 灌进真渲染函数，该出现的字都出现，且没有 undefined/NaN/[object Object]', async () => {
    const { base } = await seedMission();
    const view = await (await fetch(`${base}/api/missions/M-task`)).json();
    const activity = await (await fetch(`${base}/api/missions/M-task/activity`)).json();
    // 证据只挂在执行者那条 attempt 上。
    const started = activity
      .filter((e: { kind: string }) => e.kind === 'attempt.started')
      .find((e: { workItemId?: string }) => e.workItemId);
    const attempt = await (
      await fetch(`${base}/api/missions/M-task/attempts/${encodeURIComponent(started.causationId)}`)
    ).json();
    const diff = await (await fetch(`${base}/api/missions/M-task/diff`)).json();
    const live = await (await fetch(`${base}/api/missions/M-task/live?cursor=0`)).json();

    const {
      headerHtml, eventStreamHtml, eventDetailHtml, tabBarHtml, tabPanelHtml, formatTime,
    } = await import('../src/web/task.js');

    const nowIso = '2026-01-01T00:00:30.000Z';
    const lines = live.chunks
      .filter((c: { kind: string }) => c.kind !== 'usage')
      .map((c: { at: string; kind: string; text: string }) => ({ ...c }));
    const rendered = [
      headerHtml(view, activity, nowIso),
      eventStreamHtml(activity, 0),
      eventDetailHtml(started, attempt),
      tabBarHtml('实时输出'),
      tabPanelHtml('实时输出', { live: { lines, usage: { total: 14 } } }),
      tabPanelHtml('文件变更', { diff }),
      tabPanelHtml('验证结果', { evidence: attempt.evidence }),
      tabPanelHtml('相关消息', { escalationLog: view.escalationLog }),
      tabPanelHtml('原始数据', { event: started }),
    ];
    const all = rendered.join('\n');

    assert.ok(all.includes('把任务页做出来'), 'intent 得上屏');
    assert.ok(all.includes('executor-default'), '右上详情要把真的 profile 亮出来');
    assert.ok(all.includes('W-1'), '事件流要把关联的工作项亮出来');
    assert.ok(all.includes('正在读工单'), '实时输出的文本行得上屏');
    assert.ok(all.includes('要不要一起改内核？'), '升级问答得上屏');
    assert.ok(all.includes('node --test'), '证据里的命令得上屏');
    assert.ok(all.includes(formatTime(activity[0].at)), '事件流与页头用的是同一个本地时间格式');
    for (const html of rendered) {
      assert.equal(
        /undefined|NaN|\[object Object\]/.test(html),
        false,
        `字段名两边不一致时这里不报错，只是屏幕上多了这几个字：${html}`,
      );
    }
    // usage chunk 不进终端：它没有 text，拼进去就是一行 undefined。
    const liveHtml = rendered[4];
    assert.equal(liveHtml.includes('undefined'), false);
    assert.match(liveHtml, /tokens 14/);
  });

  test('任务表点进去的那条 id 与路由要读的是同一个键', async () => {
    const { base } = await seedMission();
    const missions = (await (await fetch(`${base}/api/missions`)).json()) as { missionId: string }[];
    const { taskTableHtml } = await import('../src/web/projects.js');
    const html = taskTableHtml(missions);
    const hit = /data-mission-id="([^"]*)"/.exec(html);
    assert.ok(hit, '任务行没有 data-mission-id：点不动任务页');
    assert.equal(hit[1], 'M-task');
    // 点击只改 hash（app.js 那边 parseRoute 认 #/missions/<id>），所以这里的
    // 属性值必须能原样拼回一条能解析的 hash。
    assert.equal('#/missions/' + encodeURIComponent(hit[1]), '#/missions/M-task');
  });
});
