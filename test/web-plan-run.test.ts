/**
 * 方案运行详情页（src/web/plan-run.js）。
 *
 * 正式页不在测试的浏览器里：字段名读错一个，界面照样渲染，只是那一格永远
 * 是空的或把未上报费用画成 $0。所以这一组守三件事：
 *
 *   1. 文件形状 —— 路由、modulepreload、只 GET、游标轮询。写错了只有运行时
 *      才看得见（浏览器 404，或停了还在打 live）。
 *   2. 纯函数喂假数据 —— 页头总量、跨次链、升级单转义、花费口径、轮询判据。
 *   3. 真列表接口的字段名两边得对得上（损坏行带 error、摘要带 features）。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { PlanRun } from '../src/application/plan-run.ts';
import { FilePlanRunStore } from '../src/application/plan-run-store.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/web/${name}`, import.meta.url)), 'utf8')
    .replace(/\r\n/g, '\n');

const T0 = '2026-09-23T14:00:00.000Z';
const T1 = '2026-09-23T16:00:00.000Z';
const T2 = '2026-09-23T18:00:00.000Z';
const STOP = {
  unresolvedEscalations: 5,
  wallClockMs: 8 * 60 * 60 * 1000,
  escalationTimeoutMs: 20 * 60 * 1000,
};

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

describe('方案运行页的文件形状', () => {
  test('plan-run.js 是静态服务认得的扁平小写名，且被外壳接上', () => {
    assert.ok(existsSync(new URL('../src/web/plan-run.js', import.meta.url)));
    assert.match('plan-run.js', /^[a-z0-9][a-z0-9._-]*\.(html|css|js|svg)$/);
    const html = read('index.html');
    assert.match(html, /<link rel="modulepreload" href="\/plan-run\.js" \/>/);
    assert.equal(/<script[^>]+src="\/plan-run\.js"/.test(html), false, 'plan-run.js 被写成会执行的 script');
    assert.match(html, /data-route="plan-runs"/);
    assert.match(html, /href="#\/plan-runs"/);
    const shell = read('app.js');
    assert.match(shell, /from '\.\/plan-run\.js'/);
    assert.match(shell, /\/plan-runs\//);
    assert.ok(shell.includes("location.hash = '#/projects'"), '未知 hash 仍回项目页');
  });

  test('样式在 index.html 里，只用 --status-* 令牌，不另起 css', () => {
    const html = read('index.html');
    assert.match(html, /\.plan-run\s*\{/);
    assert.match(html, /\.plan-ring\.tone-done\s*\{[^}]*--status-done/);
    assert.equal(existsSync(new URL('../src/web/plan-run.css', import.meta.url)), false);
    assert.equal(/#[0-9a-fA-F]{3,6}\s*[;}]/.test(html), false, 'index.html 里出现了写死的十六进制色');
  });

  test('这一页只读：不发 POST，文案走 narrate，live 带游标', () => {
    const src = read('plan-run.js');
    assert.equal(/method:\s*'POST'/.test(src), false, '不许发写请求');
    assert.match(src, /cache: 'no-store'/);
    assert.match(src, /\/api\/plan-runs\//);
    assert.match(src, /\/live\?cursor=/);
    assert.match(src, /3000/);
    assert.match(src, /visibilitychange/);
    assert.match(src, /isConnected/);
    assert.match(src, /from '\.\/narrate\.js'/);
    for (const name of ['planStatusText', 'planStopText', 'planFeatureText', 'planCostText']) {
      assert.match(src, new RegExp(name), `页面没引用 ${name}`);
    }
    assert.equal(/onclick=/.test(src), false, 'HTML 里内联 onclick：测得到形状测不到行为');
  });
});

describe('方案运行叙事', () => {
  test('状态 / 停止 / 票状态与花费口径', async () => {
    const {
      planStatusText,
      planStopText,
      planFeatureText,
      planCostText,
    } = await import('../src/web/narrate.js');

    assert.equal(planStatusText({}), '还在跑');
    assert.equal(
      planStatusText({ stopped: { reason: 'finished', detail: '都走完了' } }),
      '停了：走完了——都走完了',
    );
    assert.equal(planStopText(undefined), '');
    assert.equal(planStopText({ reason: 'wall_clock', detail: '8h' }), '墙钟到点——8h');
    assert.equal(planFeatureText('merged'), '已合入');
    assert.equal(planFeatureText('suspended'), '挂起等你');
    assert.equal(planFeatureText('skipped'), '检视者跳过');
    assert.equal(planFeatureText('pending'), '没轮到');
    assert.equal(planFeatureText('running'), '在跑');

    assert.equal(planCostText([]), '费用未上报');
    assert.equal(planCostText([{}]), '费用未上报');
    assert.equal(planCostText([{ total: 12 }]), '费用未上报');
    assert.equal(planCostText([{ cost: 0 }]), '$0.0000');
    assert.equal(planCostText([{ cost: 1.25 }, { cost: 0.25 }]), '$1.5000');
    const mixed = planCostText([{ cost: 2 }, {}]);
    assert.match(mixed, /\$2\.0000/);
    assert.match(mixed, /未上报/);
    assert.equal(mixed.includes('$0.0000') && !mixed.includes('$2.0000'), false);
  });
});

describe('纯函数喂假数据', () => {
  const loaded = import('../src/web/plan-run.js');

  const snapshot = {
    version: 1 as const,
    id: 'R-now',
    planId: 'PLAN-x',
    projectId: 'p-a',
    integrationBranch: 'auto/x',
    reviewer: 'claude',
    startedAt: T0,
    stopConditions: STOP,
    features: [
      {
        featureId: 'F1',
        title: '第一张票',
        status: 'merged',
        missionIds: ['R-now-F1'],
      },
      {
        featureId: 'F2',
        title: '挂起的票',
        status: 'suspended',
        needsDecision: '要你定：隔离重跑还是跳过？',
        missionIds: ['R-now-F2'],
      },
    ],
    escalations: [
      {
        id: 'E-1',
        featureId: 'F2',
        missionId: 'R-now-F2',
        failure: '验证红 <boom>',
        question: '跳过还是重跑？ <q>',
        openedAt: T1,
        deadline: T2,
        resolution: {
          kind: 'decided',
          action: 'skip',
          reason: '今晚不值得 & 停',
          decidedBy: 'claude',
          decidedAt: T2,
        },
      },
      {
        id: 'E-2',
        featureId: 'F2',
        missionId: 'R-now-F2',
        failure: '协调者卡住了',
        question: '原问 <ask>',
        openedAt: T1,
        deadline: T2,
        answerable: true as const,
        resolution: {
          kind: 'decided',
          action: 'answer',
          answer: '按 A 方案 <ok>',
          decidedBy: 'claude',
          decidedAt: T2,
        },
      },
    ],
    haReleases: [
      {
        runId: 'R-now',
        featureId: 'F1',
        missionId: 'R-now-F1',
        reviewedCommit: 'abc123',
        attemptId: 'coord-1',
        validationReportId: 'VR-1',
        reviewerId: 'claude',
        integrationBranch: 'auto/x',
        openedAt: T1,
        deadline: T2,
        verification: [],
        decision: {
          kind: 'approve',
          at: T2,
          by: 'claude',
          confirmedBy: 'user',
          reason: '独立 pass 绿了',
        },
      },
    ],
    stopped: { at: T2, reason: 'finished', detail: '两张票都处理完了' },
  };

  const olderRun = {
    id: 'R-old',
    planId: 'PLAN-x',
    projectId: 'p-a',
    integrationBranch: 'auto/x',
    startedAt: '2026-09-22T10:00:00.000Z',
    features: [
      { featureId: 'F1', title: '第一张票', status: 'suspended', missionIds: ['R-old-F1'] },
    ],
    escalationCount: 1,
  };

  const missions = [
    {
      missionId: 'R-now-F1',
      projectId: 'p-a',
      status: 'completed',
      updatedAt: T1,
      usage: { cost: 1.25, total: 100 },
    },
    {
      missionId: 'R-now-F2',
      projectId: 'p-a',
      status: 'blocked',
      updatedAt: T2,
      usage: { total: 40 },
    },
  ];

  const details = {
    'R-now-F1': { finalReview: { verdict: 'merge', mergedInto: 'deadbeefcafebabe' } },
    'R-now-F2': { finalReview: { verdict: 'abandon', reasons: ['跳过'] } },
  };

  test('页头有时间、票数、花费；未上报不冒充零', async () => {
    const { headerHtml, ticketSummaryText } = await loaded;
    const html = headerHtml(snapshot, missions, T2);
    assert.match(html, /PLAN-x/);
    assert.match(html, /走完了/);
    assert.match(html, /两张票都处理完了/);
    assert.match(html, /2 张票/);
    assert.match(html, /已合入 1/);
    assert.match(html, /挂起 1/);
    assert.match(html, /\$1\.2500/);
    assert.match(html, /未上报/);
    assert.equal(html.includes('$0.0000'), false, `未上报的那条被画成了零：${html}`);
    assert.equal(/undefined|NaN|\[object Object\]/.test(html), false, html);

    const running = headerHtml({ ...snapshot, stopped: undefined }, missions, T2);
    assert.match(running, /还在跑/);
    assert.equal(ticketSummaryText(snapshot.features).includes('2 张票'), true);
  });

  test('同票跨次链保留只有摘要的 Mission，并带结局/SHA/费用', async () => {
    const { buildFeatureChains, featureChainHtml } = await loaded;
    const chains = buildFeatureChains(snapshot, [olderRun, snapshot], missions);
    const f1 = chains.find((c: { featureId: string }) => c.featureId === 'F1');
    assert.ok(f1);
    assert.deepEqual(f1.missionIds, ['R-old-F1', 'R-now-F1']);
    const html = featureChainHtml(chains, details);
    assert.match(html, /R-old-F1/);
    assert.match(html, /R-now-F1/);
    assert.match(html, /deadbeefcafebabe/);
    assert.match(html, /放弃/);
    assert.match(html, /要你定：隔离重跑还是跳过？/);
    // 摘要里没有这条 Mission：链上仍在，费用不能写成 $0。
    assert.match(html, /R-old-F1[\s\S]*费用未上报/);
    assert.equal(html.includes('$0.0000'), false, html);
  });

  test('升级单呈现问/因/选项/决定，可答复单带答复，文本转义', async () => {
    const { escalationsHtml, haReleasesHtml } = await loaded;
    const html = escalationsHtml(snapshot.escalations) + haReleasesHtml(snapshot.haReleases);
    assert.match(html, /跳过还是重跑？/);
    assert.match(html, /验证红/);
    assert.match(html, /可选动作：隔离重跑、跳过、重划剩余范围、停/);
    assert.match(html, /这张单可以答复/);
    assert.match(html, /答复：按 A 方案/);
    assert.match(html, /今晚不值得/);
    assert.match(html, /claude/);
    assert.match(html, /受控放行/);
    assert.match(html, /独立 pass 绿了/);
    assert.equal(html.includes('<boom>'), false, 'failure 没转义');
    assert.equal(html.includes('<q>'), false, 'question 没转义');
    assert.equal(html.includes('<ask>'), false);
    assert.equal(html.includes('<ok>'), false);
    assert.ok(html.includes('&lt;boom&gt;') || html.includes('&lt;q&gt;'));
  });

  test('运行输出：空输出给原因，行要转义，停止原因在页头', async () => {
    const { livePanelHtml, liveLinesHtml, headerHtml } = await loaded;
    const empty = livePanelHtml({ cursor: 0, chunks: [], reason: '本机未托管这次运行' }, true);
    assert.match(empty, /本机未托管这次运行/);
    assert.match(empty, /data-live-reason/);
    const stoppedEmpty = livePanelHtml({ cursor: 0, chunks: [] }, true);
    assert.match(stoppedEmpty, /这里没留下输出/);
    const lines = liveLinesHtml([
      { seq: 1, at: T0, channel: 'stderr', line: 'fail <x>' },
    ]);
    assert.equal(lines.includes('<x>'), false);
    assert.match(lines, /&lt;x&gt;/);
    const head = headerHtml(snapshot, missions, T2);
    assert.match(head, /data-plan-stop/);
    assert.match(head, /走完了——两张票都处理完了/);
  });

  test('运行中才三秒轮询；停止、隐藏、离页都停', async () => {
    const { planRunRefresh } = await loaded;
    assert.deepEqual(planRunRefresh(false, true, true), { intervalMs: 3000, paths: ['record', 'live'] });
    assert.deepEqual(planRunRefresh(true, true, true), { intervalMs: null, paths: [] });
    assert.deepEqual(planRunRefresh(false, false, true), { intervalMs: null, paths: [] });
    assert.deepEqual(planRunRefresh(false, true, false), { intervalMs: null, paths: [] });
  });

  test('不守规矩的字段进不了 DOM', async () => {
    const { planRunListHtml, headerHtml, escalationsHtml } = await loaded;
    const evil = '<img src=x onerror="alert(1)">';
    const listHtml = planRunListHtml([
      { id: evil, planId: evil, features: [], startedAt: T0 },
      { id: 'R-bad', error: evil },
    ]);
    assert.equal(listHtml.includes('<img'), false);
    assert.match(listHtml, /&lt;img/);
    const head = headerHtml({ id: evil, planId: evil, projectId: evil, features: [] }, [], T2);
    assert.equal(head.includes('<img'), false);
    const escHtml = escalationsHtml([
      { id: 'E-1', question: evil, failure: evil, featureId: evil },
    ]);
    assert.equal(escHtml.includes('<img'), false);
  });
});

describe('真列表接口喂真渲染函数', () => {
  test('摘要倒序、损坏行带 error；详情含升级决定', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-plan-run-'));
    try {
      const older = new FilePlanRunStore(join(dir, 'R-old.json'));
      await older.create(
        PlanRun.start({
          id: 'R-old',
          planId: 'PLAN-old',
          projectId: 'p-a',
          integrationBranch: 'auto/a',
          reviewer: 'claude',
          stopConditions: STOP,
          featureIds: ['F1'],
          titles: { F1: '旧功能' },
          startedAt: T0,
        }),
      );
      const openedAt = '2026-09-23T14:10:00.000Z';
      const decidedAt = '2026-09-23T14:12:00.000Z';
      await older.update((run) => {
        run.startFeature('F1', 'R-old-F1');
        run.openEscalation(
          { featureId: 'F1', missionId: 'R-old-F1', failure: '红 <x>', question: '跳过还是重跑？' },
          openedAt,
        );
      });
      await older.update((run) => {
        run.choose('E-1', { action: 'skip', reason: '今晚不值得', decidedBy: 'claude' }, decidedAt);
      });
      writeFileSync(join(dir, 'R-bad.json'), '{not-json', 'utf8');

      const clock = new FixedClock();
      const ids = new SequentialIds();
      const deliveries = new InMemoryDeliveryRepository(clock, ids);
      const platform = new Platform({
        projects: new InMemoryProjectRepository(),
        deliveries,
        workspace: new InPlaceWorkspaceManager(),
        activity: new InMemoryActivityLog(clock),
        clock,
        ids,
      });
      const server = createApi({
        platform,
        tokens: new RunTokenRegistry(),
        deliveries,
        planRunDirs: () => [dir],
      });
      await listenLoopback(server, 0);
      servers.push(server);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      const listed = await (await fetch(`${base}/api/plan-runs`)).json() as Array<Record<string, unknown>>;
      assert.ok(listed.some((row) => row.id === 'R-old' && row.planId === 'PLAN-old'));
      assert.ok(listed.some((row) => row.id === 'R-bad' && typeof row.error === 'string'));

      const snap = await (await fetch(`${base}/api/plan-runs/R-old`)).json() as {
        id: string;
        escalations: Array<Record<string, unknown>>;
        features: Array<Record<string, unknown>>;
        stopped?: { reason: string; detail: string };
      };
      assert.equal(snap.id, 'R-old');
      assert.equal(snap.escalations[0]?.question, '跳过还是重跑？');
      assert.equal((snap.escalations[0]?.resolution as { action?: string })?.action, 'skip');

      const { planRunListHtml, headerHtml, escalationsHtml, buildFeatureChains, featureChainHtml } =
        await import('../src/web/plan-run.js');
      const listHtml = planRunListHtml(listed);
      assert.match(listHtml, /R-old/);
      assert.match(listHtml, /PLAN-old/);
      assert.ok(listHtml.includes('R-bad'));
      assert.equal(listHtml.includes('{not-json'), false);

      const missions = (await (await fetch(`${base}/api/missions`)).json()) as Array<Record<string, unknown>>;
      const head = headerHtml(snap, missions, T2);
      assert.match(head, /PLAN-old/);
      assert.match(head, /费用未上报/);
      const escHtml = escalationsHtml(snap.escalations);
      assert.match(escHtml, /跳过还是重跑？/);
      assert.match(escHtml, /今晚不值得/);
      assert.equal(escHtml.includes('<x>'), false);
      const chains = buildFeatureChains(snap, listed, missions);
      const chainHtml = featureChainHtml(chains, {});
      assert.match(chainHtml, /R-old-F1/);

      const page = await (await fetch(`${base}/plan-run.js`)).text();
      assert.match(page, /export async function renderPlanRunPage/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
