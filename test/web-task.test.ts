/**
 * 任务详情页（src/web/task.js）。
 *
 * 正式页在这个仓库里**不在测试的浏览器里**：字段名读错一个，界面照样渲染，
 * 只是那一格永远是 —。所以这个文件分三层守：
 *
 *   1. 文件形状 —— 路由、modulepreload、data-mission-id、锚点。这些跨文件，
 *      写错了只有运行时才看得见（浏览器里一个 404，或者点了没反应）。
 *   2. 纯函数喂假数据 —— 环节分组、按角色的用量、详情正文、终端、转义、
 *      跟随判据。
 *   3. 真读模型喂真渲染函数 —— 页面读的字段必须后端真的给
 *      （同 web.test.ts 为观测面补的那个坑）。
 *
 * 第 2 层里最要紧的是「环节分组」：一个环节 = 同一个 attemptId 下的一跳，
 * 而没有 attemptId 的事件散在流的头和尾。按连续分段切会在开头多出一个组，
 * 而多出来的那个组在屏幕上就是一个凭空的 L3 环节——不报错，只是骗人。
 *
 * shouldFollow 看着只是三个数字比大小，但它是这份代码里唯一一个
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
import { listenLoopback } from '../src/application/loopback-listen.ts';

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
  await listenLoopback(server, 0);
  servers.push(server);
  return { platform, live, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** 一条跑起来的任务：契约、事件流、尝试、升级、实时输出各给一份。 */
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
    findings: '翻译表散在渲染分支里',
    rejectedHypotheses: ['在 prompt 里要求模型说人话'],
    decisions: ['收成一个 narrate.js'],
    direction: '先落翻译表再改页面',
    risks: [],
  });
  const { workItemId } = await platform.createWorkItem('M-task', coord.attemptId, {
    title: 'W-1',
    order: {
      objective: '把任务页改成折叠视图',
      allowedScope: ['src/a.ts'],
      requiredBehaviour: 'b',
      constraints: [],
      acceptance: ['a'],
      verification: ['node --test'],
      doNot: [],
      contextRefs: [],
    },
  });
  // 冻结契约核对前置（W-334）：Standard 第一次派发前必须先落一条当前修订的核对结论。
  await platform.submitContractCheck('M-task', coord.attemptId, {
    verdict: 'ok',
    summary: '测试契约已核对',
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
  // 执行者交回结果与 L2 验收：详情页的「执行者交回的正文」与「技术验收」两块
  // 读的就是这两个字段。不给它们，那两格在页面上永远是解释句，而字段名读错了
  // 也是同样的表现——所以这里必须把真值灌进去验。
  await platform.submitExecutionResult('M-task', exec.attemptId, {
    outcome: 'completed',
    summary: '环节折叠成 6 组了',
    changedFiles: ['src/web/task.js'],
    evidenceIds: ['E-1'],
    notes: '没动内核',
  });
  await platform.reviewExecutionResult('M-task', coord.attemptId, {
    workItemId,
    verdict: 'accept',
    reasons: ['测试跑过了'],
    requiredChanges: [],
    acceptanceResults: [{ criterion: 'a', status: 'pass', evidence: '测试替身：逐条核过' }],
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

/**
 * W4 形状的 activity：真实跑完的一条 Mission 就是这个样子。
 *
 * 关键是**没有 attemptId 的事件同时出现在流的头和尾**（mission.created 在
 * index 0，final_review.merged / contract.revised 在末尾）。按连续分段切的实现
 * 会在这里多出一个开头的 L3 组，6 个环节变 7 个。
 */
function w4Activity(): Record<string, any>[] {
  const t = (n: number) => `2026-03-04T05:${String(n).padStart(2, '0')}:00.000Z`;
  const coordUsage = { input: 6000, output: 400, cacheRead: 1000, cacheWrite: 0, total: 7400, cost: 0.74, quality: 'reported' };
  const execUsage = { input: 2000, output: 300, cacheRead: 300, cacheWrite: 0, total: 2600, cost: 0.26, quality: 'reported' };
  const execGroup = (attemptId: string, workItemId: string, offset: number) => [
    { at: t(offset + 1), kind: 'attempt.started', attemptId, workItemId, data: { kind: 'executor' } },
    { at: t(offset + 2), kind: 'evidence.submitted', attemptId, workItemId, data: { kind: 'test', exitCode: 0 } },
    { at: t(offset + 3), kind: 'execution_result.submitted', attemptId, workItemId, data: { outcome: 'completed', changedFiles: 2 } },
    { at: t(offset + 4), kind: 'attempt.ended', attemptId, workItemId, data: { endedBy: 'structured_submit', usage: execUsage } },
  ];
  return [
    { at: t(0), kind: 'mission.created', data: { contractRevision: 1 } },
    { at: t(1), kind: 'attempt.started', attemptId: 'coord-1', data: { kind: 'coordinator' } },
    { at: t(2), kind: 'plan.updated', attemptId: 'coord-1', data: { planRevision: 1 } },
    { at: t(3), kind: 'work_item.created', attemptId: 'coord-1', workItemId: 'W-1649', data: { title: '接上读模型' } },
    { at: t(4), kind: 'work_item.dispatched', attemptId: 'coord-1', data: { ids: ['W-1649'] } },
    { at: t(5), kind: 'attempt.ended', attemptId: 'coord-1', data: { endedBy: 'structured_submit', usage: coordUsage } },
    ...execGroup('W-1649.exec-1', 'W-1649', 5),
    { at: t(10), kind: 'attempt.started', attemptId: 'coord-2', data: { kind: 'coordinator' } },
    { at: t(11), kind: 'review.recorded', attemptId: 'coord-2', workItemId: 'W-1649', data: { verdict: 'accept', reasons: ['测试跑过了'] } },
    { at: t(12), kind: 'work_item.created', attemptId: 'coord-2', workItemId: 'W-1650', data: { title: '折叠成环节' } },
    { at: t(13), kind: 'work_item.dispatched', attemptId: 'coord-2', data: { ids: ['W-1650'] } },
    { at: t(14), kind: 'attempt.ended', attemptId: 'coord-2', data: { endedBy: 'structured_submit' } },
    ...execGroup('W-1650.exec-1', 'W-1650', 15),
    { at: t(20), kind: 'attempt.started', attemptId: 'coord-3', data: { kind: 'coordinator' } },
    { at: t(21), kind: 'mission_result.submitted', attemptId: 'coord-3', data: { outcome: 'delivered' } },
    { at: t(22), kind: 'attempt.ended', attemptId: 'coord-3', data: { endedBy: 'structured_submit' } },
    { at: t(23), kind: 'contract.revised', data: { contractRevision: 2 } },
    { at: t(24), kind: 'final_review.merged', data: { mergedInto: 'main' } },
  ];
}

/** W4 那六个环节的期望组名。 */
const W4_TITLES = [
  '调查与规划、派发',
  '执行 · 接上读模型',
  '调查与规划、技术验收、派发',
  '执行 · 折叠成环节',
  '交卷',
  'L3 检视者',
];

const W4_CTX = {
  workItems: [
    { id: 'W-1649', title: '接上读模型' },
    { id: 'W-1650', title: '折叠成环节' },
  ],
};

/** 与 web-narrate 夹具同形：LQ1 当时那页 65 条。不读状态文件。 */
function lq1Events(): Record<string, any>[] {
  const rows: Record<string, any>[] = [
    { kind: 'mission.created', data: { contractRevision: 1 } },
    { kind: 'attempt.started', data: { kind: 'coordinator' }, attemptId: 'coord-1' },
    { kind: 'plan.updated', data: { planRevision: 1 }, attemptId: 'coord-1' },
    { kind: 'work_item.created', data: { title: '事件翻译表' }, workItemId: 'W-465', attemptId: 'coord-1' },
    { kind: 'work_item.dispatched', data: { ids: ['W-465'] }, attemptId: 'coord-1' },
    { kind: 'attempt.ended', data: { endedBy: 'structured_submit' }, attemptId: 'coord-1' },
    { kind: 'attempt.started', data: { kind: 'executor' }, attemptId: 'W-465.exec-1', workItemId: 'W-465' },
    { kind: 'runtime.command_tracking.enabled', data: { schemaVersion: 1 }, attemptId: 'W-465.exec-1' },
    { kind: 'runtime.command_tracking.enabled', data: { schemaVersion: 1 }, attemptId: 'W-465.exec-1' },
    { kind: 'runtime.command_tracking.enabled', data: { schemaVersion: 1 }, attemptId: 'W-465.exec-1' },
    { kind: 'runtime.command_tracking.enabled', data: { schemaVersion: 1 }, attemptId: 'W-465.exec-1' },
    { kind: 'runtime.command_tracking.enabled', data: { schemaVersion: 1 }, attemptId: 'W-465.exec-1' },
  ];
  for (let i = 0; i < 20; i += 1) {
    rows.push({
      kind: 'runtime.command.started',
      data: { schemaVersion: 1, callId: `call-${i}` },
      attemptId: 'W-465.exec-1',
    });
  }
  rows.push(
    { kind: 'evidence.submitted', data: { kind: 'test', exitCode: 0 }, attemptId: 'W-465.exec-1', workItemId: 'W-465' },
    { kind: 'execution_result.submitted', data: { outcome: 'completed', changedFiles: 3 }, attemptId: 'W-465.exec-1' },
    { kind: 'attempt.ended', data: { endedBy: 'structured_submit' }, attemptId: 'W-465.exec-1' },
    { kind: 'review.recorded', data: { verdict: 'accept', reasons: ['测试跑过了'] }, attemptId: 'coord-2' },
    { kind: 'orchestration.round.started', data: { schemaVersion: 1 } },
    { kind: 'orchestration.round.started', data: { schemaVersion: 1 } },
    { kind: 'orchestration.round.started', data: { schemaVersion: 1 } },
    { kind: 'mission_result.submitted', data: { outcome: 'delivered' }, attemptId: 'coord-2' },
    { kind: 'delivery.created', data: { deliveryId: 'D-lq1' } },
    { kind: 'memory.applied', data: { written: ['VIBE.md'] } },
    { kind: 'final_review.integration_anchor', data: { integrationBranch: 'auto/x', anchor: 'aaa' } },
    { kind: 'final_review.merge_applied', data: { mergedInto: 'bbb', integrationBranch: 'auto/x' } },
    { kind: 'final_review.integration_verified', data: { reportId: 'IVAL-1', passed: true } },
    { kind: 'final_review.merged', data: { mergedInto: 'bbb' } },
    { kind: 'work_item.retired', data: { reason: '不做了' }, workItemId: 'W-466' },
    { kind: 'contract.revised', data: { contractRevision: 2 } },
    { kind: 'mission.waiting', data: { reason: 'waiting_l3' } },
    { kind: 'mission.resumed', data: {} },
    { kind: 'escalated', data: { question: '要不要合？' }, attemptId: 'coord-2' },
    { kind: 'work_item.redispatched', data: { ids: ['W-465'] }, workItemId: 'W-465' },
    { kind: 'final_review.send_back', data: { reasons: ['再看一眼'] } },
    { kind: 'mission.routed', data: { recommended: 'lightweight', reasons: ['单文件'] } },
    { kind: 'mission.paused', data: {} },
    { kind: 'mission.resumed_from_pause', data: {} },
    { kind: 'mission.cancelled', data: { reason: '不要了' } },
    { kind: 'blocked.reported', data: { reason: '缺上下文' }, workItemId: 'W-465' },
    { kind: 'escalation.answered', data: { question: '要不要合？', answer: '合' } },
    { kind: 'validation.reported', data: { reportId: 'VAL-1', passed: true } },
    { kind: 'context.truncated', data: { budget: 8000, estimatedBefore: 9000, estimatedAfter: 7000 } },
    { kind: 'mission.budget.threshold', data: { dimension: 'rounds', threshold: 0.8 } },
    { kind: 'independent_review.blocked', data: { reason: 'no_candidates', detail: '没有独立检视候选' } },
    { kind: 'independent_review.recorded', data: { verdict: 'pass', reviewedCommit: 'abc' } },
    { kind: 'recovery.applied', data: { deliveryId: 'D-fix' } },
  );
  return rows;
}

const LQ1_CTX = {
  intent: '把三个页面从状态转储改成人话',
  plan: { direction: '先落翻译表，再改页面', findings: '事件表散在渲染分支里' },
  workItems: [
    { id: 'W-465', title: '事件翻译表' },
    { id: 'W-466', title: '用量拆项' },
  ],
  result: { summary: '三个页面都改好了', outcome: 'delivered' },
};

/** 与实现无关的本地时间算式：断言"渲染出来的是本地时间"而不是抄实现。 */
function localStamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 已知机器事件名：第一眼（事件流 / 环节头 / 详情）一个都不许露。 */
const MACHINE_KINDS = [
  'mission.created', 'attempt.started', 'plan.updated', 'work_item.created',
  'work_item.dispatched', 'work_item.retired', 'evidence.submitted',
  'execution_result.submitted', 'review.recorded', 'escalated', 'escalation.raised',
  'mission_result.submitted', 'attempt.ended', 'contract.revised',
  'final_review.merged', 'mission.waiting', 'mission.resumed',
];

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
    assert.ok(shell.includes('/missions/'), 'parseRoute 要认 #/missions/<id>');
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
    assert.match(html, /\.stage\b/, '环节折叠样式要在 index.html 里（不另起文件）');
    assert.equal(existsSync(new URL('../src/web/task.css', import.meta.url)), false, '不另起 task.css');
  });

  test('环节色只用 --status-* 那三个，不引用 --role-*，也不新写死色值', () => {
    const html = read('index.html');
    const src = read('task.js');
    // 环节 class 只允许这三个色位（与 projects.js stageTone 同一套 token）。
    for (const tone of ['queued', 'running', 'unconfirmed']) {
      const rule = ruleBody(html, new RegExp(`\\.stage\\.tone-${tone}\\s*\\{([^}]*)\\}`));
      assert.ok(rule.includes(`var(--status-${tone})`), `.stage.tone-${tone} 该走 var(--status-${tone})：${rule}`);
      assert.equal(/--role-/.test(rule), false, `.stage.tone-${tone} 不许引用 --role-*`);
    }
    // 任务页源码里出现的环节色 class 只有这三个（外加已有 chip 的 status token）。
    assert.equal(/tone-(?!queued|running|unconfirmed)[a-z]+/.test(src), false, '环节色 class 超纲');
    assert.equal(/--role-/.test(src), false, 'task.js 不许引用 --role-*');
    // index.html 里不新增写死色值：只允许经由令牌与 color-mix。
    assert.equal(/#[0-9a-fA-F]{3,6}\s*[;}]/.test(html), false, 'index.html 里出现了写死的十六进制色');
  });

  test('task.js 取的锚点在它自己的骨架里都在', async () => {
    // 跨文件才看得见的错：renderTaskPage 靠 id 接页面，写错一个字母不报错，
    // 只会静静地往 null 上写 innerHTML——整屏白。（同 web-shell 对外壳的断言。）
    const src = read('task.js');
    const ids = [...src.matchAll(/querySelector\('#([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(ids.length >= 5, '该从骨架里取到五个区域锚点，拿到了：' + ids.join(','));
    const { skeletonHtml } = await import('../src/web/task.js');
    const skeleton = skeletonHtml();
    for (const id of ids) {
      assert.ok(skeleton.includes(`id="${id}"`), `task.js 取 #${id}，骨架里没有`);
    }
    // 不再经 tab 切换的那两块必须始终在骨架里：环节列表与常驻终端。
    assert.ok(skeleton.includes('id="task-stages"'), '环节列表要在骨架里');
    assert.ok(skeleton.includes('id="task-live"'), '实时输出要常驻骨架，不再经 tab');
    assert.ok(skeleton.includes('id="task-usage"'), '用量卡要独立在骨架里');
    assert.equal(skeleton.includes('id="task-tabs"'), false, 'tab 条已经去掉，别为凑数留一个不用的锚点');
  });

  test('这一页只读：不发 POST，也不碰写操作', () => {
    const src = read('task.js');
    assert.equal(/method:\s*'POST'/.test(src), false, '不许发写请求');
    assert.match(src, /cache: 'no-store'/, '读接口不该被缓存住');
    // cursor 是实时输出的全部要点：不带 cursor 就是每次从头拉。
    assert.match(src, /\/live\?cursor=/);
  });

  test('tab 那一套已经从呈现层拿掉了', () => {
    const src = read('task.js');
    for (const gone of [
      'TASK_TABS', 'tabBarHtml', 'tabPanelHtml', 'diffPanelHtml',
      'evidencePanelHtml', 'escalationPanelHtml', 'rawPanelHtml', 'loadDiff',
      'eventDetailHtml',
    ]) {
      assert.equal(src.includes(gone), false, `${gone} 还留在 task.js 里：删干净，不留死代码`);
    }
  });
});

/* ===================== 2. 纯函数喂假数据 ===================== */

describe('环节分组', () => {
  const loaded = import('../src/web/task.js');

  test('W4 形状：6 个环节，attemptId 顺序对，L3 组在最后', async () => {
    const { groupActivity } = await loaded;
    const groups = groupActivity(w4Activity());
    assert.deepEqual(groups.map((g: any) => g.attemptId), [
      'coord-1', 'W-1649.exec-1', 'coord-2', 'W-1650.exec-1', 'coord-3', '',
    ]);
    assert.equal(groups.length, 6);
    // mission.created 排在 activity[0]，但不单独成组——它进最后那个 L3 组。
    const last = groups[groups.length - 1];
    assert.deepEqual(last.events.map((e: any) => e.kind), ['mission.created', 'contract.revised', 'final_review.merged']);
    // 组内保持原有先后。
    assert.deepEqual(groups[0].events.map((e: any) => e.kind), [
      'attempt.started', 'plan.updated', 'work_item.created', 'work_item.dispatched', 'attempt.ended',
    ]);
  });

  test('按首次出现顺序成组，不是 attemptId 一变就切段的连续分段', async () => {
    const { groupActivity } = await loaded;
    // 同 id 不相邻：连续分段会切成 3 组，按首次出现成组是 2 组。
    const rows = [
      { kind: 'a', attemptId: 'coord-1' },
      { kind: 'b', attemptId: 'W-1.exec-1' },
      { kind: 'c', attemptId: 'coord-1' },
    ];
    const groups = groupActivity(rows);
    assert.deepEqual(groups.map((g: any) => g.attemptId), ['coord-1', 'W-1.exec-1']);
    assert.deepEqual(groups[0].events.map((e: any) => e.kind), ['a', 'c']);
  });

  test('六个组名逐字对得上（组名从组内 kind 推，不是硬编码顺序）', async () => {
    const { groupActivity, stageListHtml } = await loaded;
    const groups = groupActivity(w4Activity());
    const { stageName } = await import('../src/web/narrate.js');
    assert.deepEqual(groups.map((g: any) => stageName(g.events, W4_CTX)), W4_TITLES);
    // 渲染出来的环节头里这六个名字都在。
    const html = stageListHtml(w4Activity(), null, null, W4_CTX);
    for (const name of W4_TITLES) assert.ok(html.includes(name), `环节头少了「${name}」：\n${html}`);
  });

  test('环节 <details> 默认收起：不出现 open 属性', async () => {
    const { stageListHtml } = await loaded;
    const html = stageListHtml(w4Activity(), null, null, W4_CTX);
    assert.equal((html.match(/<details/g) || []).length, 6);
    assert.equal(/<details[^>]*\bopen\b/.test(html), false, '默认展开等于没折叠');
    // 显式选中某个环节也不许顺手加 open。
    const selected = stageListHtml(w4Activity(), 'coord-1', null, W4_CTX);
    assert.equal(/<details[^>]*\bopen\b/.test(selected), false);
    assert.match(selected, /data-attempt-id="coord-1" data-active="1"/, '选中的环节要标出来');
  });

  test('用户展开过的环节在重画之后仍然展开，其它组不受影响', async () => {
    const { stageListHtml } = await loaded;
    /** 哪些组的 <details> 带着 open，按出现顺序。 */
    const opened = (html: string): string[] =>
      [...html.matchAll(/<details[^>]*>/g)]
        .filter((m) => /\bopen\b/.test(m[0]))
        .map((m) => /data-attempt-id="([^"]*)"/.exec(m[0])![1]);

    // 首屏（不传展开集）：一个 open 都没有——默认收起不变。
    assert.deepEqual(opened(stageListHtml(w4Activity(), 'coord-1', null, W4_CTX)), []);

    // 人展开了 coord-1。
    const first = stageListHtml(w4Activity(), null, null, W4_CTX, ['coord-1']);
    assert.deepEqual(opened(first), ['coord-1']);
    assert.equal((first.match(/<details/g) || []).length, 6, '重画不该多出/少掉环节');

    // 因选中变化（点环节头、点组内事件都会走到这一步）再画一次：coord-1 必须
    // 还开着。这是这一跳的回归点：旧实现每次重画都换成一份全收起的新节点，
    // 浏览器刚展开的节点连同组内逐条事件一起被换掉。
    const again = stageListHtml(w4Activity(), 'W-1649.exec-1', 3, W4_CTX, ['coord-1']);
    assert.deepEqual(opened(again), ['coord-1']);
    // 展开才有东西可看：那一组的组内逐条事件还在表里。
    assert.match(again, /data-attempt-id="coord-1"[^>]*>[\s\S]*?data-event-key="/);

    // 展开集里每一组都开着：点组内事件不许把别的已展开环节折回去。
    assert.deepEqual(
      opened(stageListHtml(w4Activity(), 'coord-1', 1, W4_CTX, ['coord-1', 'W-1650.exec-1'])),
      ['coord-1', 'W-1650.exec-1'],
    );

    // 线要接上：纯函数对了而调用方不喂展开集，页面上仍是每次重画全收起。
    const src = read('task.js');
    const at = src.indexOf('innerHTML = stageListHtml(');
    assert.ok(at > 0, '找不到重画环节列表的地方');
    assert.match(src.slice(at, src.indexOf(');', at)), /expanded/, '重画必须把展开集喂给 stageListHtml');
    assert.match(src, /node\.open/, '重画之前要先从 DOM 收原生展开状态');
  });

  test('环节头一行自足：环节名、角色徽章、耗时、token/费用、一句话摘要', async () => {
    const { stageListHtml } = await loaded;
    const html = stageListHtml(w4Activity(), null, null, W4_CTX);
    assert.match(html, /class="stage-name"/);
    assert.match(html, /class="chip (queued|running|unconfirmed)">L2 协调</);
    assert.match(html, /L1 执行</);
    assert.match(html, /L3 检视者</, '角色徽章三种都要有');
    // 耗时用组内首末事件的时间差（W4 夹具里每一跳跳了一分钟一档）。
    assert.match(html, /class="stage-dur mono">\d+ 分 \d+ 秒/, '环节头要有耗时');
    assert.ok(html.includes('class="stage-dur mono">4 分 0 秒'), 'coord-1 该是 4 分 0 秒');
    // token 与费用走 usageLine（新增 = total - 缓存）。
    assert.ok(html.includes('新增 6,400 tokens') && html.includes('缓存命中 1,000') && html.includes('$0.7400'), html);
    assert.match(html, /class="stage-summary"/, '一句话摘要要在环节头');
    // 机器 kind 不得出现在第一眼。
    for (const kind of MACHINE_KINDS) {
      assert.equal(html.includes(kind), false, `环节头漏出机器 kind「${kind}」`);
    }
  });

  test('没有 attempt.ended 的环节说清为什么没有用量，不给孤零零的 —', async () => {
    const { stageListHtml } = await loaded;
    const rows = [
      { at: '2026-03-04T05:00:00.000Z', kind: 'attempt.started', attemptId: 'coord-9', data: {} },
    ];
    const html = stageListHtml(rows, null, null, W4_CTX);
    assert.ok(html.includes('这一跳还没结束，用量要等它收尾'), html);
    assert.equal(html.includes('<span class="stage-usage">—</span>'), false);
    assert.equal(/undefined|NaN/.test(html), false, html);
  });

  test('空 activity / 缺参数塌不了，且给的是说明句', async () => {
    const { stageListHtml, groupActivity } = await loaded;
    assert.deepEqual(groupActivity([]), []);
    assert.deepEqual(groupActivity(undefined), []);
    assert.match(stageListHtml([], null, null, {}), /还没有事件/);
    assert.match(stageListHtml(undefined, null, null, undefined), /还没有事件/);
  });

  test('组内逐条事件仍是三件套，未知 kind 标明未翻译', async () => {
    const { stageListHtml } = await loaded;
    const rows = [
      { at: '2026-03-04T05:06:07.000Z', kind: 'attempt.started', attemptId: 'coord-1', data: {} },
      { at: '2026-03-04T05:06:08.000Z', kind: 'definitely.not.a.real.kind', attemptId: 'coord-1', data: {} },
    ];
    const html = stageListHtml(rows, 'coord-1', 1, W4_CTX);
    assert.ok(html.includes('evt-badge') && html.includes('evt-action') && html.includes('evt-detail'));
    assert.ok(html.includes('未翻译'), html);
    assert.ok(html.includes('definitely.not.a.real.kind'), '未翻译要把 kind 本身带出来');
    assert.ok(html.includes(localStamp('2026-03-04T05:06:07.000Z')), '时间没按本地时区渲染');
    assert.equal(html.includes('2026-03-04T05:06:07'), false, '直接切了 ISO 字符串：时区会差几小时');
    // 尝试 ID：人话标签在前，原始 id 仍能看到（排障时人要拿它去 grep 日志）。
    assert.ok(html.includes('协调者第 1 次尝试') && html.includes('coord-1'));
    // data-event-key 是整条 activity 的下标，不是组内下标。
    assert.match(html, /data-event-key="1" data-active="1"/);
  });

  test('没有 attemptId 的平台与 L3 分开，L1/L2 orphan 不进 L3', async () => {
    const { groupActivity, stageListHtml } = await loaded;
    const rows = [
      { kind: 'attempt.started', attemptId: 'coord-1', data: {} },
      { kind: 'orchestration.round.started', data: {} },
      { kind: 'memory.applied', data: { written: ['VIBE.md'] } },
      { kind: 'final_review.merged', data: { mergedInto: 'abc1234' } },
      { kind: 'mission.waiting', data: { reason: 'waiting_l3' } },
      { kind: 'blocked.reported', data: { reason: '缺上下文' }, workItemId: 'W-1' },
    ];
    const groups = groupActivity(rows);
    assert.deepEqual(groups.map((g: any) => g.attemptId), ['coord-1', '', '', '', '']);
    assert.deepEqual(groups.map((g: any) => g.role), [
      'coordinator', 'coordinator', 'executor', 'platform', 'reviewer',
    ]);
    const byRole = Object.fromEntries(groups.map((g: any) => [g.role + ':' + g.attemptId, g.events.map((e: any) => e.kind)]));
    assert.deepEqual(byRole['platform:'], ['orchestration.round.started', 'memory.applied']);
    assert.deepEqual(byRole['reviewer:'], ['final_review.merged']);
    assert.deepEqual(byRole['coordinator:'], ['mission.waiting']);
    assert.deepEqual(byRole['executor:'], ['blocked.reported']);
    const html = stageListHtml(rows, null, null, W4_CTX);
    assert.ok(html.includes('>平台<'), html);
    assert.ok(html.includes('L3 检视者'), html);
    const l3 = html.slice(html.lastIndexOf('class="stage '));
    assert.equal(l3.includes('mission.waiting') || l3.includes('blocked.reported'), false, l3);
    assert.equal(l3.includes('这一跳还没结束'), true, '未终态 L3 仍说在途');
  });

  test('命令族不逐条上屏：环节头汇总、清单可折叠、callId 去重、文本转义', async () => {
    const { stageListHtml } = await loaded;
    const evil = '<img src=x onerror="alert(1)">';
    const rows = [
      { kind: 'attempt.started', attemptId: 'W-1.exec-1', workItemId: 'W-1', data: {} },
      { kind: 'runtime.command_tracking.enabled', attemptId: 'W-1.exec-1', data: {} },
      { kind: 'runtime.command.started', attemptId: 'W-1.exec-1', data: { callId: 'same' } },
      { kind: 'runtime.command.started', attemptId: 'W-1.exec-1', data: { callId: 'same' } },
      { kind: 'runtime.command.started', attemptId: 'W-1.exec-1', data: { callId: evil, command: 'rm ' + evil, exitCode: 1 } },
      { kind: 'attempt.ended', attemptId: 'W-1.exec-1', data: { endedBy: 'structured_submit' } },
    ];
    const html = stageListHtml(rows, 'W-1.exec-1', null, { workItems: [{ id: 'W-1', title: 'x' }] });
    assert.equal(html.includes('runtime.command.started'), false, html);
    assert.equal(html.includes('runtime.command_tracking'), false, html);
    assert.ok(html.includes('跑了 2 条命令'), html);
    assert.match(html, /<details class="cmd-fold">/);
    assert.equal(/<details class="cmd-fold"[^>]*open/.test(html), false, '命令清单默认收起');
    assert.ok(html.includes('class="cmd-fold-head">2 条命令'), html);
    assert.ok(html.includes('same'), html);
    assert.ok(html.includes('命令 rm &lt;img'), html, '可用命令文字要上屏且转义');
    assert.ok(html.includes('退出码 1'), html);
    assert.equal(html.includes('<img'), false, html);
    assert.ok(html.includes('&lt;img'), html);
    // tracking / 命令族不得占普通 evt 行。
    const evtCount = (html.match(/class="evt"/g) || []).length;
    assert.equal(evtCount, 2, html);
  });

  test('LQ1 字面量 65 事件 stageListHtml 零未翻译，终态 L3 展示 SHA', async () => {
    const { groupActivity, stageListHtml } = await loaded;
    const rows = lq1Events();
    assert.equal(rows.length, 65);
    const groups = groupActivity(rows);
    assert.ok(groups.some((g: any) => g.role === 'platform' && g.events.some((e: any) => e.kind === 'memory.applied')));
    assert.ok(groups.some((g: any) => g.role === 'reviewer' && g.events.some((e: any) => e.kind === 'final_review.merged')));
    const l3 = groups.find((g: any) => g.role === 'reviewer');
    assert.equal((l3.events as any[]).some((e: any) => e.kind === 'mission.waiting'), false);
    assert.equal((l3.events as any[]).some((e: any) => e.kind === 'blocked.reported'), false);

    const running = stageListHtml(rows, null, null, LQ1_CTX);
    assert.equal(running.includes('未翻译'), false, running);
    assert.ok(running.includes('跑了 20 条命令'), running);
    assert.ok(running.includes('>平台<'), running);
    assert.ok(running.includes('L3 检视者'), running);
    assert.ok(running.includes('这一跳还没结束，用量要等它收尾'), running);
    assert.equal(running.includes('runtime.command.started'), false, running);
    assert.equal(running.includes('runtime.command_tracking'), false, running);

    const done = stageListHtml(rows, null, null, {
      ...LQ1_CTX,
      status: 'completed',
      finalReview: { verdict: 'merge', mergedInto: 'deadbeefcafebabe', reasons: ['过了'] },
    });
    assert.equal(done.includes('未翻译'), false, done);
    assert.equal(done.includes('这一跳还没结束'), false, done);
    assert.ok(done.includes('终审：放行并落地'), done);
    assert.ok(done.includes('合入 deadbeefcafebabe'), done);
  });
});

describe('用量卡', () => {
  const loaded = import('../src/web/task.js');

  test('按角色拆：L2 74% / L1 26%，分母是两者之和', async () => {
    const { usageByRole } = await loaded;
    // coord-1 与 exec-1 的 attempt.ended.usage.total 按 74/26 喂。
    const coord = { at: '', kind: 'attempt.ended', attemptId: 'coord-1', data: { usage: { total: 7400 } } };
    const exec = { at: '', kind: 'attempt.ended', attemptId: 'W-1649.exec-1', data: { usage: { total: 2600 } } };
    const two = usageByRole([coord, exec]);
    assert.equal(two.coordinator.tokens, 7400);
    assert.equal(two.executor.tokens, 2600);
    assert.equal(Math.round(two.coordinator.pct), 74);
    assert.equal(Math.round(two.executor.pct), 26);
    assert.equal(two.total, 10000);
    // W4 真实形状：两次执行各 2600 → L1 累计 5200，协调 7400。
    const w4 = usageByRole(w4Activity());
    assert.equal(w4.coordinator.tokens, 7400);
    assert.equal(w4.executor.tokens, 5200);
    // 一条 ended 都没有时 total 为 0（调用方靠它说「暂时算不出」）。
    assert.equal(usageByRole([{ at: '', kind: 'attempt.started', attemptId: 'coord-1', data: {} }]).total, 0);
  });

  test('只从 attempt.ended 算，且不为用量去拉 /attempts/<id>', async () => {
    const src = read('task.js');
    // 证据按需取选中环节那一个 attempt，全站只该有一处拼这个 URL。
    assert.equal((src.match(/'\/attempts\/' \+/g) || []).length, 1, '/attempts/ 只许在一处拼');
    // usageByRole 本身不许发请求。
    const a = src.indexOf('export function usageByRole');
    const b = src.indexOf('const roleLine =', a);
    assert.ok(a > 0 && b > a, '取不到 usageByRole 函数体');
    const body = src.slice(a, b);
    for (const forbidden of ['fetch(', 'get(', '/attempts/', '/api/']) {
      assert.equal(body.includes(forbidden), false, `用量计算里出现了 ${forbidden}：那是 N+1 的形状`);
    }
    // 也只认 attempt.ended：别的 kind 带 usage 也不能算进去。
    assert.match(body, /kind !== 'attempt\.ended'/);
  });

  test('用量卡独立三层：总计 / 按角色占比 / 按类型', async () => {
    const { usageCardHtml } = await loaded;
    const view = { usage: { input: 8000, output: 700, cacheRead: 1300, cacheWrite: 0, total: 10000, cost: 1.0, quality: 'reported' } };
    // 一次一跳：coord 7400 / exec 2600，占比就是 74% 与 26%。
    const rows = [
      { at: '', kind: 'attempt.ended', attemptId: 'coord-1', data: { usage: { total: 7400, cost: 0.74 } } },
      { at: '', kind: 'attempt.ended', attemptId: 'W-1649.exec-1', data: { usage: { total: 2600, cost: 0.26 } } },
    ];
    const html = usageCardHtml(view, rows);
    // 第一层：总计大字与费用。
    assert.match(html, /class="usage-num mono">10,000/);
    assert.ok(html.includes('$1.0000'), html);
    // 第二层（重点）：按角色，数量与占比都要能断言。
    assert.ok(html.includes('L2 协调 7,400 tokens（占比 74%）'), html);
    assert.ok(html.includes('L1 执行 2,600 tokens（占比 26%）'), html);
    // 第三层：按类型。
    assert.ok(html.includes('新增 8,700 tokens') && html.includes('缓存命中 1,300（13%）'), html);
    assert.equal(/undefined|NaN|\[object Object\]/.test(html), false, html);
  });

  test('还没结束的一跳不报 0 占比，说的是暂时算不出', async () => {
    const { usageCardHtml } = await loaded;
    const html = usageCardHtml({ usage: { total: 0 } }, [
      { at: '', kind: 'attempt.started', attemptId: 'coord-1', data: {} },
    ]);
    assert.ok(html.includes('还没有结束的一跳'), html);
    assert.equal(html.includes('占比 0%'), false, '还没数据 ≠ 没花钱');
  });

  test('页头不再印 Token 那一格（搬进独立用量卡了）', async () => {
    const { headerHtml } = await loaded;
    const view = {
      projectId: 'p', missionId: 'M1', status: 'executing', paused: false,
      updatedAt: '2026-03-04T06:00:00.000Z', usage: { total: 12345 },
      contractRevision: 2, planRevision: 1, contract: { intent: '做任务页' },
    };
    const activity = [
      { at: '2026-03-04T05:00:00.000Z', kind: 'mission.created' },
      { at: '2026-03-04T05:30:00.000Z', kind: 'attempt.started' },
    ];
    const html = headerHtml(view, activity, '2026-03-04T08:00:00.000Z');
    assert.ok(html.includes('做任务页'), '标题是 contract.intent');
    assert.ok(html.includes('执行中'), '阶段 chip 用内核 MissionStatus 的中文');
    assert.ok(html.includes('进行中'), '状态 chip 是第二根轴');
    assert.ok(html.includes('现在在干什么'));
    assert.ok(html.includes('契约 r2') && html.includes('规划 r1'), '修订号要说人话');
    // 时长与创建时间留在页头；Token 不再在这儿。
    assert.ok(html.includes('3 小时 0 分'), html);
    assert.ok(html.includes(localStamp('2026-03-04T05:00:00.000Z')));
    assert.equal(html.includes('Token'), false, '页头不该再有 Token 那一格');
    assert.equal(html.includes('新增'), false, '用量拆项该在独立卡里，不在 task-stats');
    assert.match(html, /disabled title="API 尚无鉴权，写操作暂不开放"/);
    assert.ok(html.includes('停止任务'));
    assert.equal(html.includes('onclick'), false, '不绑定点击：不发 POST');
  });

  test('页头：等待时停机原因看得见，runaway_suspected 是人话', async () => {
    const { headerHtml } = await loaded;
    const waiting = headerHtml(
      { status: 'executing', paused: false, waitReason: 'project_busy', contract: { intent: 'x' }, usage: {} },
      [], '2026-03-04T05:10:00.000Z',
    );
    assert.ok(waiting.includes('等待中') && waiting.includes('停机原因'));
    assert.ok(waiting.includes('同项目有别的 Mission 占着改动名额'), waiting);
    const runaway = headerHtml(
      { status: 'executing', paused: false, waitReason: 'runaway_suspected', contract: { intent: 'x' }, usage: {} },
      [], '2026-03-04T05:10:00.000Z',
    );
    assert.ok(runaway.includes('一跳跑太久，已停下来等人看'), runaway);
    assert.equal(runaway.includes('runaway_suspected'), false, '停机原因要翻成人话');
  });

  test('页头：终态时长停在 updatedAt；空契约/缺 usage 塌不了', async () => {
    const { headerHtml } = await loaded;
    const done = headerHtml(
      { status: 'completed', paused: false, updatedAt: '2026-03-04T07:00:00.000Z', contract: { intent: 'x' }, usage: { total: 1 } },
      [{ at: '2026-03-04T05:00:00.000Z' }], '2026-12-31T23:59:00.000Z',
    );
    assert.ok(done.includes('2 小时 0 分'), '已完成的任务时长该停在 updatedAt，而不是墙上时钟');
    assert.ok(done.includes('已完成') && done.includes('等你检视') === false);

    const empty = headerHtml({ status: 'investigating', contract: { intent: '' } }, [], '2026-03-04T05:00:00.000Z');
    assert.ok(empty.includes('（没有契约）') && empty.includes('调查中'));
    assert.equal(/NaN|undefined|null/.test(empty), false, `上屏了 NaN/undefined：${empty}`);
  });
});

describe('详情页：这一跳实际传递的正文', () => {
  const loaded = import('../src/web/task.js');
  const groups = async () => {
    const { groupActivity } = await loaded;
    return groupActivity(w4Activity());
  };
  const W4_VIEW = {
    plan: {
      findings: '翻译表散在渲染分支里',
      rootCause: '没有单一出口',
      rejectedHypotheses: ['在 prompt 里要求模型说人话'],
      decisions: ['收成一个 narrate.js'],
      direction: '先落翻译表再改页面',
      risks: [],
    },
    workItems: [
      {
        id: 'W-1649',
        title: '接上读模型',
        order: {
          objective: '把读接口接上',
          allowedScope: ['src/web/task.js'],
          verification: ['node --test'],
          acceptance: ['环节折叠成 6 组'],
        },
        lastReview: { verdict: 'accept', reasons: ['测试跑过了', '没有多余的依赖'], requiredChanges: [] },
        executionResult: {
          outcome: 'completed',
          summary: '接上了，验证全绿',
          changedFiles: ['src/web/task.js'],
          notes: '没动内核',
        },
      },
      { id: 'W-1650', title: '折叠成环节', order: null, lastReview: null, executionResult: null },
    ],
    escalationLog: [
      { attemptId: 'coord-1', question: '要不要一起改内核？', why: '改了会波及别的 Mission', optionsConsidered: ['只改前端'], answer: '不要' },
    ],
    finalReview: { verdict: 'merge', reasons: ['边界没有漂'], mergedInto: 'main' },
  };

  test('协调者调查规划环节 → plan 的五块正文', async () => {
    const { stageDetailHtml } = await loaded;
    const g = (await groups())[0];
    const html = stageDetailHtml(g, W4_VIEW, null);
    assert.ok(html.includes('翻译表散在渲染分支里'), html);
    assert.ok(html.includes('没有单一出口'), 'rootCause 要上屏');
    assert.ok(html.includes('在 prompt 里要求模型说人话'), '排除掉的假设要上屏');
    assert.ok(html.includes('收成一个 narrate.js'), '决策要上屏');
    assert.ok(html.includes('先落翻译表再改页面'), '方向要上屏');
    assert.match(html, /调查与规划结论/);
  });

  test('派发环节 → 被派工作项的工单正文', async () => {
    const { stageDetailHtml } = await loaded;
    const g = (await groups())[0];
    const html = stageDetailHtml(g, W4_VIEW, null);
    assert.ok(html.includes('把读接口接上'), 'objective 要上屏');
    assert.ok(html.includes('src/web/task.js'), 'allowedScope 要上屏');
    assert.ok(html.includes('node --test'), 'verification 要上屏');
    assert.ok(html.includes('环节折叠成 6 组'), 'acceptance 要上屏');
    assert.ok(html.includes('W-1649'), '技术 ID 仍要能找到');
  });

  test('执行者环节 → executionResult + 这一跳的证据（含 command 与退出码）', async () => {
    const { stageDetailHtml } = await loaded;
    const g = (await groups())[1];
    const attempt = {
      attemptId: 'W-1649.exec-1',
      evidence: [
        { kind: 'test', summary: '274 条全绿', command: 'node --test', exitCode: 0, output: 'pass 274' },
        { kind: 'observation', summary: '看了日志' },
      ],
    };
    const html = stageDetailHtml(g, W4_VIEW, attempt);
    assert.ok(html.includes('接上了，验证全绿'), 'summary 要上屏');
    assert.ok(html.includes('没动内核'), 'notes 要上屏');
    assert.ok(html.includes('src/web/task.js'), 'changedFiles 要上屏');
    assert.ok(html.includes('node --test'), '证据的 command 要上屏');
    assert.ok(html.includes('274 条全绿') && html.includes('退出码 0'), html);
    assert.ok(html.includes('pass 274'), 'output 也要带上，那才是能被复核的东西');
    assert.ok(html.includes('看了日志'), '没有退出码的那条也不能丢');
    assert.equal(html.includes('exitCode'), false, '不要露字段名');
  });

  test('技术验收环节 → lastReview 的结论/理由/要求', async () => {
    const { stageDetailHtml } = await loaded;
    const g = (await groups())[2];
    const html = stageDetailHtml(g, W4_VIEW, null);
    assert.match(html, /技术验收/);
    assert.ok(html.includes('通过'), 'verdict 要翻成人话');
    assert.ok(html.includes('测试跑过了') && html.includes('没有多余的依赖'), html);
    assert.ok(html.includes('接上读模型'), '验收讲的是哪个工作项要说清');
    // 这个环节同时有派发，两块正文要一起出现。
    assert.ok(html.includes('派发的工单'), '同一环节有几类事件就渲染几块');
    assert.equal(html.includes('accept"'), false, '不露 verdict 机器值');
  });

  test('升级问答 → escalationLog 的 question / why / answer（从旧 tab 搬过来）', async () => {
    const { stageDetailHtml } = await loaded;
    const { groupActivity } = await loaded;
    const rows = [
      { at: '2026-03-04T05:00:00.000Z', kind: 'attempt.started', attemptId: 'coord-1', data: {} },
      { at: '2026-03-04T05:00:01.000Z', kind: 'escalated', attemptId: 'coord-1', data: { question: '要不要一起改内核？' } },
    ];
    const html = stageDetailHtml(groupActivity(rows)[0], W4_VIEW, null);
    assert.ok(html.includes('要不要一起改内核？'), html);
    assert.ok(html.includes('改了会波及别的 Mission'), 'why 要上屏');
    assert.ok(html.includes('只改前端'), 'optionsConsidered 要上屏');
    assert.ok(html.includes('答复：不要'), 'answer 要上屏');
  });

  test('L3 环节 → finalReview 的 verdict / reasons / mergedInto', async () => {
    const { stageDetailHtml } = await loaded;
    const g = (await groups())[5];
    assert.equal(g.attemptId, '', 'L3 那一组没有 attemptId，不该去拉证据');
    const html = stageDetailHtml(g, W4_VIEW, null);
    assert.ok(html.includes('放行并落地'), `verdict 要翻成人话：${html}`);
    assert.ok(html.includes('main'), 'mergedInto 要上屏');
    assert.ok(html.includes('边界没有漂'), 'reasons 要上屏');
    assert.ok(html.includes('L3 检视者'), '环节头是检视者');
  });

  test('点开平台 / L1 / L2 orphan 详情不走 L3 终审，L3 仍展示 SHA', async () => {
    const { groupActivity, stageDetailHtml } = await loaded;
    const evil = '<img src=x onerror="alert(1)">';
    const rows = [
      { kind: 'orchestration.round.started', data: {} },
      { kind: 'memory.applied', data: { written: [evil, 'VIBE.md'] } },
      { kind: 'final_review.merged', data: { mergedInto: 'deadbeef' } },
      { kind: 'mission.waiting', data: { reason: 'waiting_l3' } },
      { kind: 'blocked.reported', data: { reason: '缺上下文' }, workItemId: 'W-1' },
    ];
    const groups = groupActivity(rows);
    const view = {
      ...W4_VIEW,
      finalReview: { verdict: 'merge', reasons: ['过了'], mergedInto: 'cafebabeSHA' },
    };
    const byRole = Object.fromEntries(groups.map((g: any) => [g.role, g]));

    const plat = stageDetailHtml(byRole.platform, view, null);
    assert.ok(plat.includes('>平台<') || plat.includes('平台'), plat);
    assert.ok(plat.includes('开始新一轮调度'), plat);
    assert.ok(plat.includes('写入项目记忆'), plat);
    assert.ok(plat.includes('VIBE.md'), plat);
    assert.ok(plat.includes('&lt;img'), plat);
    assert.equal(plat.includes('<img'), false, plat);
    assert.equal(plat.includes('L3 最终检视'), false, plat);
    assert.equal(plat.includes('cafebabeSHA'), false, '平台组不该贴 finalReview 的 SHA');
    assert.equal(plat.includes('还没有最终检视结论'), false, plat);
    assert.equal(plat.includes('L3 自己动手的'), false, plat);

    const l2 = stageDetailHtml(byRole.coordinator, view, null);
    assert.equal(l2.includes('L3 最终检视'), false, l2);
    assert.equal(l2.includes('cafebabeSHA'), false, l2);
    assert.ok(l2.includes('L2 协调'), l2);

    const l1 = stageDetailHtml(byRole.executor, view, null);
    assert.equal(l1.includes('L3 最终检视'), false, l1);
    assert.equal(l1.includes('cafebabeSHA'), false, l1);
    assert.ok(l1.includes('L1 执行'), l1);

    const l3 = stageDetailHtml(byRole.reviewer, view, null);
    assert.ok(l3.includes('L3 最终检视'), l3);
    assert.ok(l3.includes('放行并落地'), l3);
    assert.ok(l3.includes('cafebabeSHA'), l3);
    assert.ok(l3.includes('L3 检视者'), l3);
  });

  test('平台仅命令族走已有空态，非 L3 orphan 技术行不误称 L3', async () => {
    const { stageDetailHtml, groupActivity } = await loaded;
    const view = {
      ...W4_VIEW,
      finalReview: { verdict: 'merge', reasons: ['过了'], mergedInto: 'cafebabeSHA' },
    };
    const plat = stageDetailHtml({
      attemptId: '',
      role: 'platform',
      events: [
        { kind: 'runtime.command_tracking.enabled', data: {} },
        { kind: 'runtime.command.started', data: { callId: 'c1' } },
      ],
    }, view, null);
    assert.ok(plat.includes('这一跳还没有把正文写回平台'), plat);
    assert.equal(plat.includes('L3 最终检视'), false, plat);
    assert.equal(plat.includes('cafebabeSHA'), false, plat);
    assert.equal(plat.includes('L3 自己动手的'), false, plat);
    assert.equal(plat.includes('未翻译'), false, plat);
    assert.ok(plat.includes('尝试（没有编号）'), plat);

    const rows = [
      { kind: 'mission.waiting', data: { reason: 'waiting_l3' } },
      { kind: 'blocked.reported', data: { reason: '缺上下文' }, workItemId: 'W-1' },
    ];
    const groups = groupActivity(rows);
    const l2 = stageDetailHtml(groups.find((g: any) => g.role === 'coordinator'), view, null);
    const l1 = stageDetailHtml(groups.find((g: any) => g.role === 'executor'), view, null);
    assert.equal(l2.includes('L3 自己动手的'), false, l2);
    assert.equal(l1.includes('L3 自己动手的'), false, l1);
    assert.equal(l2.includes('这一组事件不属于任何一跳'), false, l2);
    assert.equal(l1.includes('这一组事件不属于任何一跳'), false, l1);
    assert.ok(l2.includes('尝试（没有编号）'), l2);
    assert.ok(l1.includes('尝试（没有编号）'), l1);
    assert.ok(l2.includes('尝试'), l2);
    assert.ok(l1.includes('尝试'), l1);
  });

  test('缺数据是解释句，不是 — / undefined / NaN / [object Object]', async () => {
    const { stageDetailHtml } = await loaded;
    const g = (await groups())[1];
    const bare = stageDetailHtml(g, { workItems: [], escalationLog: [] }, null);
    assert.equal(/undefined|NaN|\[object Object\]/.test(bare), false, bare);
    assert.ok(bare.includes('这一跳还没有执行者交回结果'), bare);
    assert.ok(bare.includes('这一跳还没有证据'), '证据没取到要说原因');
    // 没选中任何环节时也要有一句，不是一块空白。
    assert.match(stageDetailHtml(null, {}, null), /还没有选中环节|点一个环节/);
  });

  test('详情里不出现机器事件名', async () => {
    const { stageDetailHtml, groupActivity } = await loaded;
    for (const g of groupActivity(w4Activity())) {
      const html = stageDetailHtml(g, W4_VIEW, { evidence: [{ kind: 'test', summary: 's', command: 'c', exitCode: 0 }] });
      for (const kind of MACHINE_KINDS) {
        assert.equal(html.includes(kind), false, `环节 ${g.attemptId || '(L3)'} 的详情漏出机器事件名「${kind}」：\n${html}`);
      }
      assert.equal(/--role-|tone-(?!queued|running|unconfirmed)/.test(html), false, '环节色 class 超纲');
    }
  });

  test('没有 attemptId 的环节不发证据请求', async () => {
    // 这条守的是形状：loadAttempt 只在拿到非空 attemptId 时才拼 URL。
    const src = read('task.js');
    const a = src.indexOf('async function loadAttempt');
    const body = src.slice(a, src.indexOf('/** 一轮游标拉取', a));
    assert.match(body, /if \(!attemptId\)/, '空 attemptId 要直接返回，不打 /attempts/undefined');
    assert.equal(body.includes('causationId'), false, '钥匙是环节自己的 attemptId，不是事件的 causationId');
  });
});

describe('实时输出', () => {
  const loaded = import('../src/web/task.js');

  test('裁剪说明挂横幅，不混进终端正文', async () => {
    const { livePanelHtml, liveNoteHtml } = await loaded;
    const chunks = [
      { at: '2026-03-04T05:06:07.000Z', kind: 'text', text: '第一行' },
      { at: '2026-03-04T05:06:08.000Z', kind: 'note', text: '实时输出已裁剪：本跳共 1200 行，只保留最后 500 行。' },
    ];
    const html = livePanelHtml({ lines: chunks });
    const term = /<pre class="term"[^>]*>([\s\S]*?)<\/pre>/.exec(html);
    assert.ok(term, '终端块要在');
    assert.equal(term[1].includes('已裁剪'), false, 'note 混在正文里会被读成「后面还有」');
    assert.ok(html.includes('只保留最后 500 行'), '横幅里要有那句话');
    // 横幅在 pre 之前。
    assert.ok(html.indexOf('live-note') < html.indexOf('<pre class="term"'), '横幅要挂在终端上方');
    assert.equal(liveNoteHtml([]), '', '没有裁剪说明时不留一个空块');
    // 行数不把 note/usage 算进去。
    assert.match(html, /1 行/);
  });

  test('usage chunk 不当终端行；工具行有形状；勾选框默认开着', async () => {
    const { livePanelHtml, liveLinesHtml } = await loaded;
    const empty = livePanelHtml({ lines: [] });
    assert.match(empty, /还没有实时输出/, '黑空一块看起来像坏了');
    assert.match(empty, /data-autoscroll/, '要能关掉自动滚动');
    assert.match(empty, /checked/, '默认开着');
    assert.equal(livePanelHtml({ lines: [], autoScroll: false }).includes(' checked'), false,
      'autoScroll=false 时勾选框不该是选中的');

    const withUsage = livePanelHtml({
      lines: [{ at: '2026-03-04T05:06:07.000Z', kind: 'text', text: '第一行' },
        { at: '2026-03-04T05:06:08.000Z', kind: 'usage', usage: { total: 1234 } }],
      usage: { total: 1234 },
    });
    assert.ok(withUsage.includes('第一行'));
    assert.equal(withUsage.includes('undefined'), false, 'usage chunk 被当终端行拼进来了');
    assert.match(withUsage, /tokens 1,234/);
    assert.match(liveLinesHtml([{ kind: 'tool', text: 'read a.ts' }]), /▸ read a\.ts/);
  });

  test('终态且没有输出行：不再说「这一跳已经结束…原始输出里」', async () => {
    const { liveLinesHtml, livePanelHtml } = await loaded;
    const ended = liveLinesHtml([], false);
    assert.equal(ended.includes('这一跳已经结束'), false, '原始数据 tab 已删，那句会指空');
    assert.equal(ended.includes('还没有实时输出'), false, '结束了就不该说「还没有」');
    assert.ok(ended.trim().length > 0, '空态也得有一句说明');
    assert.match(livePanelHtml({ lines: [], running: false }), /没有在这里留下输出行/);
    // 有正文行就正常显示，不套空态。
    assert.match(liveLinesHtml([{ at: '2026-03-04T05:06:07.000Z', kind: 'text', text: '还在滚' }], false), /还在滚/);
  });

  test('终端行时间只到钟点', async () => {
    const { liveLinesHtml } = await loaded;
    const html = liveLinesHtml([
      { at: '2026-03-04T05:06:07.000Z', kind: 'text', text: '第一行' },
      { at: '2026-03-04T05:06:09.000Z', kind: 'tool', text: 'read src/a.ts' },
    ]);
    assert.equal(html.includes('"total"'), false);
    assert.ok(html.includes('▸ read src/a.ts'));
    assert.ok(html.includes(localStamp('2026-03-04T05:06:07.000Z').slice(11)), html);
    assert.equal(html.includes(localStamp('2026-03-04T05:06:07.000Z')), false, '终端行不该带日期');
  });
});

describe('上下文采集指标', () => {
  const loaded = import('../src/web/task.js');

  const ended = (metrics?: unknown) => ({
    at: '2026-03-04T05:00:00.000Z',
    kind: 'attempt.ended',
    attemptId: 'coord-1',
    data: metrics === undefined ? { endedBy: 'structured_submit' } : { endedBy: 'structured_submit', contextMetrics: metrics },
  });

  test('有上报时按类别画分段条和图例，字节数是真的', async () => {
    const { contextMetricsBlockHtml, contextMetricSegments, stageDetailHtml, groupActivity } = await loaded;
    const metrics = {
      version: 1,
      coverage: 'complete',
      brief: { renderedUtf8Bytes: 1200, sources: [] },
      tools: [
        { kind: 'read', calls: 2, returnedUtf8Bytes: 80 },
        { kind: 'bash', calls: 1, returnedUtf8Bytes: 9 },
      ],
    };
    const segs = contextMetricSegments(metrics);
    assert.deepEqual(segs, [
      { key: 'brief', bytes: 1200 },
      { key: 'read', bytes: 80 },
      { key: 'bash', bytes: 9 },
    ]);
    const html = contextMetricsBlockHtml([ended(metrics)]);
    assert.ok(html.includes('简报 1,200 字节'), html);
    assert.ok(html.includes('读文件 80 字节'), html);
    assert.ok(html.includes('命令输出 9 字节'), html);
    assert.match(html, /flex:1200/);
    assert.match(html, /flex:80/);
    assert.match(html, /var\(--status-queued\)/);
    assert.equal(html.includes('搜索'), false, '没上报的 grep 不该出现');
    assert.equal(/简报 0\b/.test(html), false, html);
    assert.equal(html.includes('没有上报'), false, html);
    const detail = stageDetailHtml(groupActivity([ended(metrics)])[0], {}, null);
    assert.ok(detail.includes('简报 1,200 字节'), detail);
  });

  test('没上报明确说没有指标，不把缺失当零', async () => {
    const { contextMetricsFromEvents, contextMetricSegments, contextMetricsBlockHtml, stageListHtml } = await loaded;
    assert.equal(contextMetricsFromEvents([ended()]), null);
    assert.equal(contextMetricSegments(null), null);
    assert.equal(contextMetricSegments({ version: 1, coverage: 'unknown' }), null);
    const html = contextMetricsBlockHtml([ended()]);
    assert.ok(html.includes('这一跳没有上报上下文指标'), html);
    assert.equal(html.includes('0 字节'), false, html);
    assert.equal(html.includes('简报'), false, html);
    const list = stageListHtml([ended()], null, null, {});
    assert.ok(list.includes('这一跳没有上报上下文指标'), list);
    assert.equal(list.includes('简报 0'), false, list);
  });
});

describe('任务改动卡', () => {
  const loaded = import('../src/web/task.js');

  test('文件、增删行数、可展开差异；空结果不假装有改动', async () => {
    const { changesCardHtml, parseDiffStat } = await loaded;
    const stat = [
      ' src/web/task.js | 12 ++++----',
      ' src/web/narrate.js | 40 +++++++++++++++++',
      ' 2 files changed, 48 insertions(+), 4 deletions(-)',
    ].join('\n');
    const parsed = parseDiffStat(stat);
    assert.equal(parsed.added, 48);
    assert.equal(parsed.deleted, 4);
    const html = changesCardHtml({
      stat,
      files: ['src/web/task.js', 'src/web/narrate.js'],
      pendingMemory: ['VIBE.md'],
    });
    assert.ok(html.includes('任务改动'), html);
    assert.ok(html.includes('2 个文件'), html);
    assert.ok(html.includes('新增 48 行') && html.includes('删除 4 行'), html);
    assert.ok(html.includes('<details'), '每条文件要能展开');
    assert.ok(html.includes('src/web/task.js'), html);
    assert.ok(html.includes('12 行'), html);
    assert.ok(html.includes('差异摘要'), html);
    assert.ok(html.includes('另有 1 个文件会随本次落地一并写入'), html);
    assert.ok(html.includes('VIBE.md'), html);

    const empty = changesCardHtml({ stat: '（无改动）', files: [], pendingMemory: [] });
    assert.ok(empty.includes('（无改动）'), empty);
    assert.equal(empty.includes('<details'), false, '空结果不该画出可展开的假文件');
    const none = changesCardHtml({ stat: '', files: [], pendingMemory: [] });
    assert.ok(none.includes('没有改动'), none);
    const fail = changesCardHtml({ error: 'HTTP 500' });
    assert.ok(fail.includes('读不到改动：HTTP 500'), fail);
    assert.equal(fail.includes('个文件'), false, fail);
  });
});

describe('输出末尾退路', () => {
  const loaded = import('../src/web/task.js');

  test('没有实时行时用 attempt.output；有实时行不把旧跳当当前输出', async () => {
    const { livePanelHtml } = await loaded;
    const hist = livePanelHtml({
      lines: [],
      running: false,
      historicalOutput: '脱敏后的尾巴\n第二行',
    });
    assert.ok(hist.includes('输出末尾（已脱敏）'), hist);
    assert.ok(hist.includes('脱敏后的尾巴'), hist);
    assert.equal(hist.includes('还没有实时输出'), false, hist);
    const live = livePanelHtml({
      lines: [{ at: '2026-03-04T05:06:07.000Z', kind: 'text', text: '正在滚' }],
      historicalOutput: '旧跳不该出现',
    });
    assert.ok(live.includes('正在滚'), live);
    assert.equal(live.includes('旧跳不该出现'), false, live);
    assert.equal(live.includes('输出末尾（已脱敏）'), false, live);
  });
});

describe('转义', () => {
  test('不守规矩的字段进不了 DOM', async () => {
    const {
      headerHtml, stageListHtml, stageDetailHtml, usageCardHtml, livePanelHtml, groupActivity,
      changesCardHtml, contextMetricsBlockHtml,
    } = await import('../src/web/task.js');
    const evil = '<img src=x onerror="alert(1)">';
    const group = groupActivity([{ at: '', kind: 'attempt.started', attemptId: evil, workItemId: evil, data: {} }])[0];
    // 第二项：这一页**应该**把 evil 转义后回显（而不是吞掉或当标签解析）。
    const pages: [string, boolean][] = [
      [headerHtml({ status: evil, contract: { intent: evil }, usage: { total: 1 } }, [], '2026-03-04T05:00:00.000Z'), true],
      [stageListHtml([{ at: '', kind: evil, attemptId: evil, workItemId: evil, data: { ids: [evil], title: evil } }], evil, 0, { workItems: [{ id: evil, title: evil }] }), true],
      [stageDetailHtml(group, {
        plan: { findings: evil, rootCause: evil, rejectedHypotheses: [evil], decisions: [evil], direction: evil },
        workItems: [{ id: evil, title: evil, executionResult: { summary: evil, changedFiles: [evil], notes: evil }, order: { objective: evil, allowedScope: [evil], verification: [evil], acceptance: [evil] } }],
        escalationLog: [{ question: evil, why: evil, optionsConsidered: [evil], answer: evil }],
        finalReview: { verdict: evil, reasons: [evil], mergedInto: evil },
      }, { evidence: [{ kind: evil, summary: evil, command: evil, exitCode: 1, output: evil }] }), true],
      [livePanelHtml({ lines: [{ at: '2026-03-04T05:06:07.000Z', kind: 'text', text: evil }, { kind: 'note', text: evil }] }), true],
      [livePanelHtml({ lines: [], running: false, historicalOutput: evil }), true],
      [changesCardHtml({ stat: evil, files: [evil], pendingMemory: [evil] }), true],
      [changesCardHtml({ error: evil }), true],
      [contextMetricsBlockHtml([{ kind: 'attempt.ended', data: { contextMetrics: { brief: { renderedUtf8Bytes: 1 }, tools: [{ kind: evil, returnedUtf8Bytes: 3 }] } } }]), true],
      // 环节名也吃外部输入（工作项标题是 L2 写的）。
      [stageListHtml([{ at: '', kind: 'attempt.started', attemptId: 'W-x.exec-1', workItemId: evil }], null, null, { workItems: [{ id: evil, title: evil }] }), true],
      // 用量卡只从 usage 取数字、从 attemptId 取角色，本来就不该回显入参。
      [usageCardHtml({ usage: { total: 1, cost: 1 } }, [{ at: '', kind: 'attempt.ended', attemptId: evil, data: { usage: { total: 1 } } }]), false],
    ];
    for (const [html, mustShowEscaped] of pages) {
      assert.equal(html.includes('<img'), false, `外部输入被当标签解析了：${html}`);
      if (mustShowEscaped) assert.ok(html.includes('&lt;img'), `该看到转义后的形式：${html}`);
      else assert.equal(html.includes(evil), false, '用量卡不该把入参原样回显上屏');
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

describe('面包屑', () => {
  test('三段，前两段是链接', async () => {
    const { crumbParts } = await import('../src/web/task.js');
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
    assert.deepEqual(crumbParts('', 'M-1').map((p: any) => p.text), ['项目', '任务 M-1']);
  });

  test('方案运行来源多一段可点的方案运行，普通任务仍是三段', async () => {
    const { crumbParts } = await import('../src/web/task.js');
    const fromPlan = crumbParts('proj-a', 'R1-F1', {
      clientType: 'plan-run',
      conversationRef: 'plan-run:R1',
    });
    assert.deepEqual(fromPlan, [
      { text: '项目', href: '#/projects' },
      { text: 'proj-a', href: '#/projects/proj-a' },
      { text: '方案运行', href: '#/plan-runs/R1' },
      { text: '任务 R1-F1', here: true },
    ]);
    const odd = crumbParts('proj-a', 'M-1', {
      clientType: 'plan-run',
      conversationRef: 'plan-run:a/b c',
    });
    assert.equal(odd[2].href, '#/plan-runs/' + encodeURIComponent('a/b c'));
    // clientType 或 conversationRef 对不上就当普通任务：猜一段链到不存在的运行更糟。
    assert.deepEqual(
      crumbParts('proj-a', 'M-1', { clientType: 'cli', conversationRef: 'plan-run:R1' }).map((p: any) => p.text),
      ['项目', 'proj-a', '任务 M-1'],
    );
    assert.deepEqual(
      crumbParts('proj-a', 'M-1', { clientType: 'plan-run', conversationRef: 'R1' }).map((p: any) => p.text),
      ['项目', 'proj-a', '任务 M-1'],
    );
    assert.deepEqual(
      crumbParts('proj-a', 'M-1', { clientType: 'plan-run', conversationRef: 'plan-run:' }).map((p: any) => p.text),
      ['项目', 'proj-a', '任务 M-1'],
    );
  });
});

/* ===================== 项目页：方案标签与按票分组 ===================== */

describe('项目页方案运行标签与按票分组', () => {
  const loaded = import('../src/web/projects.js');

  test('默认方案标签；按开跑时间倒序；票/升级/真实花费；坏记录不冒充一行方案', async () => {
    const { projectWorkbenchHtml, planRunsTableHtml } = await loaded;
    const workbench = projectWorkbenchHtml({
      missions: [{ missionId: 'M1', status: 'executing' }],
      planRuns: [],
    });
    assert.match(workbench, /data-tab="plan-runs"[^>]*data-active="1"|data-active="1"[^>]*data-tab="plan-runs"/);
    assert.match(workbench, /全部任务/);
    assert.equal(workbench.includes('data-tab="missions" data-active="1"'), false);

    const runs = [
      {
        id: 'R-old',
        planId: 'PLAN-old',
        startedAt: '2026-01-01T00:00:00.000Z',
        features: [{ featureId: 'F1', title: '旧', status: 'merged', missionIds: ['R-old-F1'] }],
        escalationCount: 2,
      },
      {
        id: 'R-new',
        planId: 'PLAN-new',
        startedAt: '2026-09-29T08:00:00.000Z',
        features: [
          { featureId: 'A', status: 'running', missionIds: ['R-new-A'] },
          { featureId: 'B', status: 'pending', missionIds: [] },
        ],
        escalationCount: 0,
      },
      { id: 'R-bad', error: '方案运行记录不是合法 JSON' },
    ];
    const missions = [
      { missionId: 'R-old-F1', planRunId: 'R-old', usage: { cost: 1.25 } },
      { missionId: 'R-new-A', planRunId: 'R-new', usage: { total: 9 } },
    ];
    const html = planRunsTableHtml(runs, missions);
    const pos = (id: string) => {
      const i = html.indexOf('data-plan-run-id="' + id + '"');
      assert.ok(i >= 0, `缺行 ${id}: ${html}`);
      return i;
    };
    assert.ok(pos('R-new') < pos('R-old'), html);
    assert.ok(html.indexOf('data-plan-run-error="R-bad"') > pos('R-old'), '坏记录应沉底');
    assert.match(html, /href="#\/plan-runs\/R-new"/);
    assert.match(html, /2 张票/);
    assert.match(html, /已合入 1/);
    assert.ok(html.includes('$1.2500'), html);
    assert.match(html, /费用未上报/);
    assert.equal(html.includes('$0.0000'), false, `缺费用不能画成零：${html}`);
    assert.equal(runs[0]?.id, 'R-old', '不能原地排序调用方的数组');
    const evil = planRunsTableHtml(
      [{ id: '<img>', error: '<script>x</script>' }],
      [],
    );
    assert.equal(evil.includes('<img'), false);
    assert.equal(evil.includes('<script'), false);
  });

  test('全部任务按 featureId 分组，无票任务保持独立，更新时间倒序，四态筛选', async () => {
    const { groupMissionsByFeature, filterMissionGroups, missionFilterKey, missionGroupsHtml, projectWorkbenchHtml } =
      await loaded;
    const rows = [
      { missionId: 'solo-new', status: 'executing', updatedAt: '2026-09-29T10:00:00.000Z', intent: '独立新' },
      { missionId: 'F1-old', featureId: 'F1', status: 'blocked', updatedAt: '2026-09-01T00:00:00.000Z', intent: '旧尝试' },
      { missionId: 'F1-new', featureId: 'F1', status: 'completed', updatedAt: '2026-09-28T00:00:00.000Z', intent: '新尝试' },
      { missionId: 'solo-old', status: 'investigating', updatedAt: '2026-08-01T00:00:00.000Z', intent: '独立旧' },
      { missionId: 'need', featureId: 'N1', status: 'awaiting_review', updatedAt: '2026-09-20T00:00:00.000Z' },
    ];
    const groups = groupMissionsByFeature(rows);
    assert.equal(groups.length, 4);
    assert.equal(groups[0]?.missions[0]?.missionId, 'solo-new');
    assert.equal(groups[1]?.featureId, 'F1');
    assert.deepEqual(groups[1]?.missions.map((m: { missionId: string }) => m.missionId), ['F1-new', 'F1-old']);
    assert.equal(groups[2]?.featureId, 'N1');
    assert.equal(groups[3]?.missions[0]?.missionId, 'solo-old');
    const solos = groups.filter((g: { featureId: string }) => !g.featureId);
    assert.equal(solos.length, 2, '两个无票任务不能揉成一组');
    assert.equal(rows[0]?.missionId, 'solo-new', '不能原地改入参');

    assert.equal(missionFilterKey({ status: 'executing' }), 'active');
    assert.equal(missionFilterKey({ status: 'awaiting_review' }), 'needs');
    assert.equal(missionFilterKey({ status: 'executing', waitReason: 'escalated' }), 'needs');
    assert.equal(missionFilterKey({ status: 'executing', waitReason: 'project_busy' }), 'active');
    assert.equal(missionFilterKey({ status: 'completed' }), 'completed');
    assert.equal(missionFilterKey({ status: 'blocked' }), 'blocked');

    const completed = filterMissionGroups(groups, 'completed');
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.featureId, 'F1');
    const active = filterMissionGroups(groups, 'active');
    assert.deepEqual(active.map((g: { missions: { missionId: string }[] }) => g.missions[0].missionId), ['solo-new', 'solo-old']);
    const needs = filterMissionGroups(groups, 'needs');
    assert.equal(needs[0]?.featureId, 'N1');

    const html = missionGroupsHtml(rows, '', [], []);
    assert.match(html, /data-group-id="feature:F1"/);
    assert.match(html, /href="#\/missions\/F1-old"/);
    assert.match(html, /href="#\/missions\/solo-new"/);
    assert.ok(html.indexOf('solo-new') < html.indexOf('F1-new'), html);

    const filtered = projectWorkbenchHtml({ tab: 'missions', filter: 'blocked', missions: rows, planRuns: [] });
    assert.match(filtered, /没有符合筛选的任务/);
    const missionsTab = projectWorkbenchHtml({ tab: 'missions', missions: rows, planRuns: [] });
    assert.match(missionsTab, /进行中/);
    assert.match(missionsTab, /需处理/);
    assert.match(missionsTab, /已完成/);
    assert.match(missionsTab, /已中止/);
    assert.match(missionsTab, /data-tab="missions"[^>]*data-active="1"|data-active="1"[^>]*data-tab="missions"/);

    const evil = missionGroupsHtml(
      [{ missionId: '<img>', featureId: '<x>', status: 'executing', intent: '<script>' }],
      '',
      [],
      [],
    );
    assert.equal(evil.includes('<img'), false);
    assert.equal(evil.includes('<script'), false);
  });
});

/* ===================== 3. 真读模型喂真渲染函数 ===================== */

describe('真 API 字段喂真渲染函数', () => {
  test('任务页读的每个字段后端都真的给', async () => {
    const { platform, base } = await seedMission();
    assert.ok(platform);

    const view = (await (await fetch(`${base}/api/missions/M-task`)).json()) as Record<string, any>;
    // 页头与详情读的字段。finalReview / result 到那里才会出现，现在还没走到那一步，
    // 所以不在本条里要求（它们缺席时详情页该给解释句，由下面那几条守）。
    for (const f of [
      'contract', 'status', 'paused', 'projectId', 'usage', 'escalationLog', 'updatedAt',
      'plan', 'workItems',
    ]) {
      assert.ok(f in view, `页头/详情读 view.${f}，读模型没给`);
    }
    assert.equal(view.contract.intent, '把任务页做出来');
    assert.equal(typeof view.usage.total, 'number');
    assert.equal(view.escalationLog.length, 1, '升级问答要传出来，详情页那一块靠它');
    // 详情页的正文全在 workItems 上，后端不给就得改后端——这条先钉住不给的后果。
    const item = view.workItems[0];
    for (const f of ['id', 'title', 'order', 'executionResult', 'lastReview']) {
      assert.ok(f in item, `详情读 workItems[].${f}，读模型没给`);
    }

    // MissionView 没有 createdAt —— 页头那格取的是事件流第一条。
    assert.equal('createdAt' in view, false, 'createdAt 不该被当成已有字段来读');

    const activity = (await (await fetch(`${base}/api/missions/M-task/activity`)).json()) as Record<
      string, any[]
    >;
    assert.ok(Array.isArray(activity) && activity.length >= 5);
    for (const event of activity) {
      assert.equal(typeof event.at, 'string', '每条事件都要有 at');
      assert.equal(typeof event.kind, 'string', '每条事件都要有 kind');
    }
    const startedRows = activity.filter((e) => e.kind === 'attempt.started');
    assert.ok(startedRows.length >= 2, '协调者与执行者各该有一条 attempt.started');
    // 证据挂在环节自己的 attemptId 上（详情页取证据用的就是这个键）。
    const execStarted = startedRows.find((e) => e.workItemId);
    assert.ok(execStarted && execStarted.attemptId, '执行者那一跳要有 attemptId');
    // mission.created 没有 attemptId / causationId：JSON 会省略 undefined 键。
    const created = activity.find((e) => e.kind === 'mission.created');
    assert.equal('causationId' in (created ?? {}), false, '没有 causationId 时后端不该塞 null 进来');

    const attempt = (await (
      await fetch(`${base}/api/missions/M-task/attempts/${encodeURIComponent(execStarted.attemptId)}`)
    ).json()) as Record<string, any>;
    assert.equal(attempt.evidence.length, 1, '执行者那条 attempt 上要能看到证据');
    assert.equal(attempt.evidence[0].command, 'node --test');

    const live = (await (await fetch(`${base}/api/missions/M-task/live?cursor=0`)).json()) as {
      cursor: number;
      chunks: { seq: number; kind: string; text?: string; usage?: { total: number } }[];
    };
    assert.equal(typeof live.cursor, 'number', '实时输出是游标轮询，必须回 cursor');
    assert.ok(Array.isArray(live.chunks) && live.chunks.length === 2);
    assert.equal(live.cursor, live.chunks.at(-1)?.seq, 'cursor 要能续上，否则第二次拉会重复');

    const diff = (await (await fetch(`${base}/api/missions/M-task/diff`)).json()) as {
      stat: string;
      files: string[];
      pendingMemory: string[];
    };
    assert.ok(Array.isArray(diff.files), '改动卡读 diff.files');
    assert.equal(typeof diff.stat, 'string', '改动卡读 diff.stat');
    assert.ok(Array.isArray(diff.pendingMemory), '改动卡读 diff.pendingMemory');
    const { changesCardHtml } = await import('../src/web/task.js');
    const diffHtml = changesCardHtml(diff);
    assert.equal(/undefined|NaN|\[object Object\]/.test(diffHtml), false, diffHtml);
    // 原地模式没有隔离工作区：空结果必须说清楚，不许画一套假文件。
    if (diff.files.length === 0) {
      assert.equal(diffHtml.includes('<details'), false, diffHtml);
    }
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
    const {
      headerHtml, stageListHtml, stageDetailHtml, usageCardHtml, livePanelHtml, groupActivity, formatTime,
    } = await import('../src/web/task.js');

    const ctx = {
      intent: view.contract && view.contract.intent,
      plan: view.plan,
      workItems: view.workItems || [],
      result: view.result,
      escalationLog: view.escalationLog || [],
      finalReview: view.finalReview,
    };
    const groups = groupActivity(activity);
    const execGroup = groups.find((g: any) => String(g.attemptId).includes('.exec-'));
    const attempt = await (
      await fetch(`${base}/api/missions/M-task/attempts/${encodeURIComponent(execGroup.attemptId)}`)
    ).json();
    const live = await (await fetch(`${base}/api/missions/M-task/live?cursor=0`)).json();
    const lines = live.chunks
      .filter((c: { kind: string }) => c.kind !== 'usage')
      .map((c: { at: string; kind: string; text: string }) => ({ ...c }));

    const liveHtml = livePanelHtml({ lines, usage: { total: 14 } });
    const rendered = [
      headerHtml(view, activity, '2026-01-01T00:00:30.000Z'),
      usageCardHtml(view, activity),
      stageListHtml(activity, execGroup.attemptId, null, ctx),
      ...groups.map((g: any) => stageDetailHtml(g, ctx, g === execGroup ? attempt : null)),
      liveHtml,
    ];
    const all = rendered.join('\n');

    assert.ok(all.includes('把任务页做出来'), 'intent 得上屏');
    assert.ok(all.includes('正在读工单'), '实时输出的文本行得上屏');
    assert.ok(all.includes('要不要一起改内核？'), '升级问答得上屏');
    assert.ok(all.includes('node --test'), '证据里的命令得上屏');
    assert.ok(all.includes('W-1'), '技术 ID 仍要能找到');
    assert.ok(all.includes(formatTime(activity[0].at)), '事件流与页头用的是同一个本地时间格式');
    for (const html of rendered) {
      assert.equal(
        /undefined|NaN|\[object Object\]/.test(html),
        false,
        `字段名两边不一致时这里不报错，只是屏幕上多了这几个字：${html}`,
      );
    }
    // 环节视图与详情不得出现任何机器事件名。
    for (const kind of MACHINE_KINDS) {
      assert.equal(all.includes(kind), false, `渲染结果漏出了机器事件名「${kind}」：\n${all}`);
    }
    // 终端里没有 usage chunk 的形状。
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
