import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { middleEllipsis, newestMissions, missionTableHtml, overviewHtml } from '../src/web/overview.js';
import { candidateConfig, moveCandidate, priorityHtml } from '../src/web/model-priority.js';
import { usageFieldsHtml, skeletonHtml, stageDetailHtml, groupActivity } from '../src/web/task.js';
import { buildPlatform } from '../src/main.ts';
import { createApi } from '../src/api/server.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import type { AddressInfo } from 'node:net';

/** src/web/ 下的文件按真实路径读：断言的是画板上的尺寸真的写进去了，不是「函数返回了个字符串」。 */
const webFile = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/web/${name}`, import.meta.url)), 'utf8');

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

/* ===== 任务总览：五列记录（画板 2:47） =====
 * 这一节的断言盯三类错，它们在浏览器里都不报错：
 *   1. 长编号被截断后完整值也丢了——屏幕上看着正常，可再也查不到是哪一条；
 *   2. 五列宽度/行高被顺手改掉——只是越来越不像画板，没人说得清哪一条不对；
 *   3. 页签计数拿可见批次算——点进「已完成」是 0 条，而它明明有一堆。
 */
function overviewRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    missionId: 'M-1',
    projectId: 'P-1',
    status: 'executing',
    coordinationMode: 'hierarchical',
    updatedAt: '2026-10-26T06:32:00.000Z',
    paused: false,
    isMutating: false,
    intent: '做一件有边界的事',
    openEscalations: 0,
    usage: { cost: 1.5, quality: 'reported' },
    ...overrides,
  };
}

const OVERVIEW_NOW = Date.parse('2026-10-26T08:00:00.000Z');

test('长编号中间省略但完整值留在 title，intent 单行省略且完整内容可查', () => {
  // 画板 2:47 上那条被省略的编号：头 31 字 + 尾 11 字，中间一个省略号。
  const full = 'Vehicle-Resource-Validation-Final-Review-20261023';
  assert.equal(
    middleEllipsis(full),
    'Vehicle-Resource-Validation-Fin…ew-20261023',
    '中间省略的保留字数和画板不一致',
  );
  // 没超长的编号一个字符都不动：短编号被塞一个省略号会让人以为它还有后半段。
  assert.equal(middleEllipsis('M-1'), 'M-1');

  const html = overviewHtml({ missions: [overviewRow({ missionId: full, intent: '<img src=x> 核对车辆资源' })] }, { now: OVERVIEW_NOW });
  assert.ok(html.includes('Vehicle-Resource-Validation-Fin…ew-20261023'), '编号没有中间省略');
  // 完整编号与完整 intent 都要在 title 里——省略只发生在视觉上。
  assert.ok(html.includes(`title="${full}"`), '完整编号没留在 title 里，省略之后就再也查不到是哪一条');
  assert.ok(html.includes('title="&lt;img src=x&gt; 核对车辆资源"'), '完整 intent 没留在 title 里');
  // 转义：intent 是外部输入，正文和属性两处都不能漏。
  assert.equal(html.includes('<img src=x'), false, 'intent 被当成 HTML 插进去了');
  assert.equal((html.match(/&lt;img src=x&gt;/g) || []).length, 2, '正文与 title 都该是转义后的 intent');
});

test('五列宽度/行高/分组底与画板一致，状态与开关用落盘的 16x16 / 34x20 原图', () => {
  const css = webFile('console-overview.css');
  const rule = (name: string): string => {
    const hit = new RegExp(`\\.console-overview \\.${name}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(hit, `console-overview.css 里没有 .${name} 规则`);
    return hit[1];
  };
  for (const [cls, width] of [['co-identity', '400px'], ['co-status', '194px'], ['co-owner', '290px'], ['co-cost', '144px'], ['co-updated', '100px']] as [string, string][]) {
    assert.match(rule(cls), new RegExp(`width:\\s*${width}`), `${cls} 的列宽不是画板上的 ${width}`);
  }
  assert.match(rule('co-row'), /height:\s*64px/, '记录行是 64px');
  assert.match(rule('co-row'), /gap:\s*4px/, '列间距是 4');
  assert.match(rule('co-row'), /padding:\s*0 16px/, '记录左右内缩 16');
  assert.match(rule('co-group-head'), /background:\s*var\(--color-nav\)/, '分组头用 nav 底');
  // 白色底板包住页签、表头、三个分组；每组内容结束留 8px（228 = 28 + 3*64 + 8）。
  assert.match(rule('co-board'), /background:\s*var\(--color-white\)/, '数据底板是白色');
  assert.match(rule('co-board'), /gap:\s*12px/, '页签/表头/分组之间 12px');
  assert.match(rule('co-group'), /padding-bottom:\s*8px/, '每组内容结束该留 8px');
  // 行内格子贴顶：垂直居中会让只有一行的费用/时间比别列低 12px。
  assert.match(rule('co-cell'), /justify-content:\s*flex-start/, '行内格子文字要贴顶');
  // 分页在白板外，左边与内容对齐，不额外缩进 16。
  assert.match(rule('co-page'), /padding:\s*0;/, '分页不该缩进 16');
  // 白色记录底：行自己不染色，靠 table 的 white 底；选中才换成 select。
  assert.match(rule('co-table'), /background:\s*var\(--color-white\)/, '数据区是白色底板');
  // 局部作用域：这份文件由下一单挂载，不能顺手改别的页面。
  assert.equal(/^\.co-/m.test(css), false, '有选择器没带 .console-overview 作用域');
  assert.equal(/#[0-9a-fA-F]{3,6}\s*[;,}]/.test(css), false, 'console-overview.css 里出现了写死的十六进制色');

  const html = overviewHtml({ missions: [overviewRow({ status: 'awaiting_review' }), overviewRow({ missionId: 'M-2', status: 'completed' })] }, { now: OVERVIEW_NOW });
  assert.match(html, /<h1 class="fixed-page-title[^"]*">任务总览<\/h1>/, '页名该用 fixed-page-title');
  // 图标是 src/web/ 下真实落盘的 SVG，尺寸与原设计一致，不用字符代用。
  for (const name of ['console-icon-review.svg', 'console-icon-complete.svg', 'console-icon-search.svg', 'console-icon-switch.svg']) {
    assert.ok(html.includes(`src="/${name}"`), `没引用本地图标 ${name}`);
  }
  assert.match(html, /width="16" height="16"/, '状态图标是 16x16');
  // 搜索图标在文字左侧（ConsoleField Search：icon 后接 placeholder）。
  assert.match(html, /data-overview-search><img class="co-field-icon"[^>]*\/><input class="co-field-input"[^>]*placeholder="搜索编号或 intent"/, '搜索图标不在输入框左侧');
  // 页签、表头、分组在同一个白色 wrapper 里；分页在白板外。
  const board = /<div class="co-board">([\s\S]*?)<div class="co-page">/.exec(html);
  assert.ok(board, '找不到白色数据底板');
  for (const marker of ['co-tabs', 'co-head', 'co-group-head']) {
    assert.ok(board![1].includes(marker), `${marker} 不在白色底板里`);
  }
  assert.equal(board![1].includes('co-page-count'), false, '分页跑到白板里面了');
  assert.match(html, /width="34" height="20"/, '开关轨道是 34x20');
  assert.equal(html.includes('figma.com'), false, '页面里出现了 figma 临时下载地址');
  // 五列表头一字不差地连着画板。
  const head = /class="co-table">([\s\S]*?)<div class="co-group"/.exec(html);
  assert.ok(head, '找不到表头');
  for (const label of ['编号 / intent', '主状态 / 附加标记', '谁处理 / 下一步', '费用（标价折算）', '更新时间']) {
    assert.ok(head[1].includes(label), `表头缺「${label}」`);
  }
});

test('分组三组且组内倒序；暂停与终态都能进入；首屏不虚构选中', () => {
  const rows = [
    overviewRow({ missionId: 'A-wait', status: 'awaiting_review', updatedAt: '2026-10-26T05:00:00.000Z' }),
    overviewRow({ missionId: 'B-run', status: 'executing', updatedAt: '2026-10-26T06:00:00.000Z' }),
    overviewRow({ missionId: 'C-paused', status: 'executing', paused: true, updatedAt: '2026-10-26T04:00:00.000Z' }),
    overviewRow({ missionId: 'D-done', status: 'completed', updatedAt: '2026-10-24T10:02:00.000Z' }),
  ];
  const html = overviewHtml({ missions: rows }, { now: OVERVIEW_NOW });
  const order = [...html.matchAll(/co-group-head">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(order, ['需要你处理', '进行中', '最近结束'], '分组顺序或组数不对');
  const links = [...html.matchAll(/href="#\/missions\/([^"]+)"/g)].map((m) => decodeURIComponent(m[1]));
  // 暂停中的任务与终态任务都得在里面：旧首页把两条都滤掉了，等于「点不进去」。
  for (const id of ['A-wait', 'B-run', 'C-paused', 'D-done']) assert.ok(links.includes(id), `${id} 进不去`);
  // 组内倒序：进行中那一组里 B-run（06:00）排在 C-paused（04:00）前。
  const active = /data-group="active">([\s\S]*?)(?=<\/div>\s*<div class="co-group")/.exec(html);
  assert.ok(active, '找不到进行中分组');
  assert.ok(active[1].indexOf('B-run') < active[1].indexOf('C-paused'), '组内不是 updatedAt 降序');
  // 首屏不写虚构的默认选中：没有传 selectedId 时任何行都没有 data-selected。
  assert.equal(/co-row"[^>]*data-selected="1"/.test(html), false, '首屏出现了一个没人点过的选中行');
  const picked = overviewHtml({ missions: rows }, { now: OVERVIEW_NOW, selectedId: 'B-run' });
  assert.match(picked, /co-row"[^>]*data-selected="1"/, '真实选择没有落到行上');
  assert.equal((picked.match(/co-row"[^>]*data-selected="1"/g) || []).length, 1, '选中态只能有一行');
});

test('页签计数与完整统计不被可见批次截断，过滤条件驱动页签与开关', () => {
  const rows = Array.from({ length: 60 }, (_, i) => overviewRow({
    missionId: `M-${String(i).padStart(2, '0')}`,
    projectId: i % 2 === 0 ? 'P-1' : 'P-2',
    // 前 30 条已完成，后 30 条执行中：这样「全部」和单态计数一眼能分开。
    status: i < 30 ? 'completed' : 'executing',
    paused: i === 41,
    updatedAt: new Date(Date.UTC(2026, 9, 26, 10, 0, 0) - i * 60_000).toISOString(),
  }));
  const html = overviewHtml({ missions: rows }, { now: OVERVIEW_NOW, shown: 2 });
  assert.ok(html.includes('全部 60'), '「全部」计数被可见批次截断了');
  assert.ok(html.includes('已完成 30'), '六态计数不是完整集合');
  assert.ok(html.includes('执行中 30'), '六态计数不是完整集合');
  assert.ok(html.includes('显示 2 / 60'), '分页文案不是「显示 可见 / 完整」');
  assert.match(html, /data-overview-more/, '还有更多时要给「加载更早」标记');

  // 筛选是真实条件：项目 + 暂停 + 状态都照它渲染，不是画板上那个静态高亮。
  const scoped = overviewHtml({ missions: rows }, { now: OVERVIEW_NOW, filter: { projectId: 'P-2', pausedOnly: true, status: 'executing' } });
  assert.match(scoped, /data-overview-status="executing" data-selected="1"/, '页签选中态没跟着真实筛选');
  assert.match(scoped, /data-overview-status="all" data-selected="0"/, '「全部」页签不该也是选中的');
  assert.match(scoped, /src="\/console-icon-switch-on\.svg"/, '仅看已暂停打开时该用打开态原图');
  assert.ok(scoped.includes('全部 1'), '暂停 + 项目过滤后的「全部」计数不对');

  // 横幅只说真实条数与真实范围，不写设计稿上的样本数（「3 项」）。
  const bannered = overviewHtml({
    missions: [
      overviewRow({ missionId: 'W-1', projectId: 'P-2', status: 'awaiting_review' }),
      overviewRow({ missionId: 'W-2', projectId: 'P-1', status: 'awaiting_review' }),
    ],
  }, { now: OVERVIEW_NOW, filter: { projectId: 'P-2' } });
  assert.ok(bannered.includes('需要你处理 1 项：1 项等检视者'), '横幅条数不是按真实筛选算的');
  assert.ok(bannered.includes('项目「P-2」'), '横幅没说当前是哪个项目');
  // 缺 waitInfo 的行 autoResume 是 unknown：不能写成「均不会自动恢复」，要说未知。
  assert.equal(bannered.includes('均不会自动恢复'), false, '未知被说成了均不会自动恢复');
  assert.ok(bannered.includes('1 项恢复方式未知'), '未知恢复方式没标出来');

  // 明确 false 与未知混合：分开数，只有全部确为 false 才用「均不会自动恢复」。
  const mixed = overviewHtml({
    missions: [
      overviewRow({
        missionId: 'X-1',
        status: 'awaiting_review',
        waitInfo: { reason: 'waiting_l3', owner: 'l3', autoResume: false, activeAgent: false, action: '核对最终交卷' },
      }),
      overviewRow({ missionId: 'X-2', status: 'awaiting_review' }),
    ],
  }, { now: OVERVIEW_NOW });
  assert.ok(mixed.includes('1 项不会自动恢复'), '明确 false 的那项没数出来');
  assert.ok(mixed.includes('1 项恢复方式未知'), '未知的那项被算进了确定值');
  assert.equal(mixed.includes('均不会自动恢复'), false, '混合未知时不能下「均」的结论');
  const allKnown = overviewHtml({
    missions: ['Y-1', 'Y-2'].map((missionId) => overviewRow({
      missionId,
      status: 'awaiting_review',
      waitInfo: { reason: 'waiting_l3', owner: 'l3', autoResume: false, activeAgent: false },
    })),
  }, { now: OVERVIEW_NOW });
  assert.ok(allKnown.includes('以上 2 项均不会自动恢复'), '全部确为 false 时才该用「均不会自动恢复」');

  // 处理人/恢复方式要上屏：主行能分开三态，退避显示真实时刻与次数，不止在 title 里。
  const ownerRow = (waitInfo: Record<string, unknown>) => {
    const html = overviewHtml({ missions: [overviewRow({ status: 'executing', waitInfo })] }, { now: OVERVIEW_NOW });
    const text = /<p class="co-owner-text"[^>]*>([^<]*)<\/p><p class="co-next"[^>]*>([^<]*)<\/p>/.exec(html);
    assert.ok(text, '找不到处理人/下一步两行');
    return { owner: text![1], next: text![2] };
  };
  const stopped = ownerRow({ reason: 'waiting_l3', owner: 'l3', autoResume: false, activeAgent: false, action: '核对最终交卷' });
  assert.match(stopped.owner, /不会自动恢复/, '不会自动恢复没上屏');
  assert.equal(/恢复方式未知/.test(stopped.owner), false, '确定不会恢复的行不该同时说未知');
  const waiting = ownerRow({ reason: 'waiting_l3', owner: 'l3', action: '等答复' });
  assert.match(waiting.owner, /恢复方式未知/, '缺布尔的行要说未知，不能默认成不会恢复');
  const backoff = ownerRow({
    reason: 'retry_backoff', owner: 'platform', autoResume: true, activeAgent: false,
    nextRetryAt: '2026-10-26T06:36:00.000Z', retry: { attempt: 2, max: 5 }, action: '到点自动重试',
  });
  // 12:36 是这里 now=08:00Z 的本地时刻；写死在断言里是为了证明它是实际时刻，不止「会自动恢复」。
  assert.match(backoff.owner, /^平台自动处理 · \d\d:\d\d 自动重试$/, '自动恢复没写出实际重试时刻');
  assert.match(backoff.next, /^退避第 2\/5 次/, '退避次数没上屏');
  // 终态没有待办，也不跟着说恢复方式。
  const done = /<p class="co-owner-text"[^>]*>([^<]*)<\/p>/.exec(
    overviewHtml({ missions: [overviewRow({ status: 'completed' })] }, { now: OVERVIEW_NOW }),
  )![1];
  assert.match(done, /已结束，没有待办/, '终态处理人不是「没有待办」');
  assert.equal(/自动恢复|恢复方式未知/.test(done), false, '终态跟着说了恢复方式');
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
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('补充投影只叠在可见行：补修/落地/真实运行上屏，且不压过终态、自动恢复与等人', () => {
  // 两条任务、只显示一条：overlay 必须只落在可见的那条上。把它套在进
  // buildOverview 的 missions 上，隐藏行的附标就会跟着分组/计数一路走进去。
  // M-live 给更新的 updatedAt：分页切的是「组内倒序」之后的头一批，
  // 同刻时用 missionId 兜底排序，会让 M-hidden 排到前面去。
  const missions = [
    overviewRow({ missionId: 'M-live', status: 'executing', updatedAt: '2026-10-26T07:00:00.000Z' }),
    overviewRow({ missionId: 'M-hidden', status: 'executing', updatedAt: '2026-10-26T05:00:00.000Z' }),
  ];
  const before = JSON.parse(JSON.stringify(missions));
  const html = overviewHtml({ missions }, {
    now: OVERVIEW_NOW,
    shown: 1,
    overlay: {
      'M-live': { repair: true, problem: false, landingLine: '落地未记录 · master 未记录', liveAttempt: true, runningText: '执行者运行中' },
      'M-hidden': { repair: true, landingLine: '隐藏行不该出现', liveAttempt: true, runningText: '隐藏运行' },
    },
  });
  assert.ok(html.includes('补修'), '补修附标没上屏');
  assert.ok(html.includes('落地未记录 · master 未记录'), '落地那一句没和附标拼在一格里');
  assert.ok(html.includes('执行者运行中'), '真实运行的文案没上屏');
  assert.ok(html.includes('src="/console-icon-running.svg"'), '有真实 in_progress 的 Attempt 却不是运行蓝');
  assert.equal(html.includes('隐藏行不该出现'), false, '不可见那一行的落地文案被画出来了');
  assert.equal(html.includes('隐藏运行'), false, '不可见那一行的运行文案被画出来了');
  // 全集计数不能被 overlay 或可见批次改动。
  assert.ok(html.includes('全部 2'), '页签计数不是完整匹配集');
  assert.ok(html.includes('显示 1 / 2'), '分页不是「显示 可见 / 完整」');
  assert.equal(html.includes('119'), false, '出现了一个没人算过的计数');

  // 终态压过一切：运行蓝不能盖掉绿勾，落地那句不许写成「未合入」或设计稿的样本文案。
  const done = overviewHtml({ missions: [overviewRow({ missionId: 'M-done', status: 'completed' })] }, {
    now: OVERVIEW_NOW,
    overlay: { 'M-done': { liveAttempt: true, runningText: '执行者运行中', landingLine: '已合入集成 · master 未记录' } },
  });
  assert.ok(done.includes('console-icon-complete.svg'), '终态图标被运行蓝盖掉了');
  assert.equal(done.includes('console-icon-running.svg'), false, '已完成的任务被画成运行中');
  assert.ok(done.includes('已合入集成 · master 未记录'), '已合入那一句没上屏');
  assert.equal(done.includes('master 未合入'), false, '写了设计稿上的样本文案「master 未合入」');
  assert.equal(done.includes('master 等待用户签名'), false, '写了设计稿上的样本文案「master 等待用户签名」');
  assert.equal(done.includes('已合入集成分支'), false, '写了设计稿上的样本文案「已合入集成分支」');

  // 等人动手（检视者）仍是琥珀，不能因为 liveAttempt 变成运行蓝。
  const review = overviewHtml({ missions: [overviewRow({ missionId: 'M-rev', status: 'awaiting_review' })] }, {
    now: OVERVIEW_NOW,
    overlay: { 'M-rev': { liveAttempt: true } },
  });
  assert.ok(review.includes('console-icon-review.svg'), '等检视者的琥珀图标被运行蓝盖掉了');
  assert.equal(review.includes('console-icon-running.svg'), false, '等人工处理的行被画成运行中');

  // 自动恢复（灰色时钟）也压得住：运行文案不能盖掉「它会自己接着跑」这句话。
  const backoff = overviewHtml({ missions: [overviewRow({
    missionId: 'M-backoff',
    status: 'executing',
    waitInfo: { owner: 'platform', autoResume: true, activeAgent: false, reason: 'retry_backoff' },
  })] }, {
    now: OVERVIEW_NOW,
    overlay: { 'M-backoff': { liveAttempt: true, runningText: '执行者运行中' } },
  });
  assert.ok(backoff.includes('console-icon-clock.svg'), '自动重试的灰色时钟被运行蓝盖掉了');
  assert.equal(backoff.includes('console-icon-running.svg'), false, '自动重试的行被画成运行中');
  assert.ok(backoff.includes('执行者运行中'), '真实运行的事实被丢掉了');
  assert.equal(/自动重试|会自动恢复/.test(backoff), true, '恢复方式被运行文案盖掉了');

  // 纯呈现：入参一个字段都不改。
  assert.deepEqual(missions, before, '渲染改了入参');
});
