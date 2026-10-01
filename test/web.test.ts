/**
 * 观测面的读端点。
 *
 * 界面本身是静态字符串，值得测的是它依赖的两个读口，以及一条容易被
 * 忽略的行为：**状态文件被别的进程改过之后，常驻服务器要看得到新内容**。
 * 没有这条，页面上显示的永远是启动那一刻的快照——跑着的 Mission 纹丝不动，
 * 比没有界面更误导。
 */

import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApi } from '../src/api/server.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { buildPersistentPlatform } from '../src/main.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

const CONTRACT = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const servers: Server[] = [];
const dirs: string[] = [];
after(() => {
  for (const server of servers) server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-web-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

async function serve(statePath: string) {
  const built = await buildPersistentPlatform(statePath, new InPlaceWorkspaceManager());
  const server = createApi({
    platform: built.platform,
    tokens: built.tokens,
    deliveries: built.deliveries,
    onMutation: built.persist,
  });
  await listenLoopback(server, 0);
  servers.push(server);
  return { ...built, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('观测面', () => {
  test('根路径返回可渲染的 HTML', async () => {
    const { base } = await serve(tempState());
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /<!doctype html>/i);
    // 原来这两条断言的是 `CoAgentHub v5` 和正文里出现 /api/missions，而那两条
    // 是内置观测面（WEB_PAGE）的特征。GET / 现在给的是 src/web/index.html：
    // 正式壳把 /api/* 放在 app.js 引的 projects.js 里，index.html 文本里没这两个串。
    // 还按老串断言，测到的其实是“回退页赢了”。
    assert.match(html, /CoAgentHub/);
    assert.ok(
      html.includes('app.js') || html.includes('tokens.css'),
      '正式壳要引到外壳资源',
    );
  });

  test('Mission 列表带够列表页要的字段', async () => {
    const { platform, base } = await serve(tempState());
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const rows = (await (await fetch(`${base}/api/missions`)).json()) as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    for (const key of [
      'missionId',
      'projectId',
      'status',
      'isMutating',
      'intent',
      'workItems',
      'accepted',
      'openEscalations',
      'usage',
    ]) {
      assert.ok(key in rows[0], `列表缺字段 ${key}`);
    }
  });

  test('时间线按发生顺序返回；不存在的 Mission 要报错而不是给空数组', async () => {
    const { platform, base } = await serve(tempState());
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await platform.startCoordinatorAttempt('M1');

    const events = (await (await fetch(`${base}/api/missions/M1/activity`)).json()) as {
      kind: string;
    }[];
    assert.deepEqual(
      events.map((e) => e.kind),
      ['mission.created', 'attempt.started'],
    );

    // 空 Timeline 和「这条 Mission 不存在」在界面上长得一样，必须区分开。
    const missing = await fetch(`${base}/api/missions/不存在/activity`);
    assert.equal(missing.status, 409);
  });

  test('别的进程改了状态文件，常驻服务器要看得到', async () => {
    const statePath = tempState();
    const viewer = await serve(statePath);
    assert.equal(((await (await fetch(`${viewer.base}/api/missions`)).json()) as []).length, 0);

    // 另一个进程（这里用另一套实例模拟）建了一条 Mission 并落盘。
    const writer = await buildPersistentPlatform(statePath, new InPlaceWorkspaceManager());
    await writer.platform.createMission({
      projectId: 'P',
      missionId: 'M-new',
      contract: CONTRACT,
    });
    writer.persist();

    const rows = (await (await fetch(`${viewer.base}/api/missions`)).json()) as {
      missionId: string;
    }[];
    assert.equal(rows.length, 1, '不热重载的话这里永远是 0，页面就成了启动快照');
    assert.equal(rows[0].missionId, 'M-new');
  });
});

describe('页面读的字段必须真的存在', () => {
  // 实测踩到的：页面写的是 `w.attempts` / `view.coordinatorAttempts`，
  // 读模型给的却是 `attemptIds` / `coordinatorAttemptIds`。结果是尝试芯片
  // 一个都不渲染——**而且不报错**，页面照常显示，只是少了一块。
  //
  // 这类错没有任何东西会接住：页面是字符串，字段是运行时取的。所以这里
  // 拿真实读模型来对，把"页面以为有"和"后端真的有"钉在一起。
  test('MissionView 上页面用到的字段都在', async () => {
    const { platform, base } = await serve(tempState());
    await platform.createMission({
      projectId: 'P',
      missionId: 'M1',
      contract: {
        intent: '修 X',
        acceptance: ['绿'],
        constraints: [],
        nonGoals: [],
        guardrails: ['别动 package.json'],
      },
    });
    const coord = await platform.startCoordinatorAttempt('M1');
    await platform.updatePlan('M1', coord.attemptId, {
      findings: 'f',
      rejectedHypotheses: ['排除了 A'],
      decisions: [],
      direction: 'd',
      risks: [],
    });
    await platform.createWorkItem('M1', coord.attemptId, {
      title: 'W',
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

    const view = (await (await fetch(`${base}/api/missions/M1`)).json()) as Record<string, unknown>;
    for (const field of [
      'missionId', 'projectId', 'status', 'paused', 'isMutating',
      'contract', 'contractRevision', 'plan', 'planRevision',
      'workItems', 'coordinatorAttemptIds', 'openEscalations', 'usage',
    ]) {
      assert.ok(field in view, `页面读 view.${field}，读模型里没有`);
    }
    for (const field of ['intent', 'acceptance', 'guardrails']) {
      assert.ok(field in (view.contract as object), `页面读 contract.${field}`);
    }
    for (const field of ['direction', 'rejectedHypotheses']) {
      assert.ok(field in (view.plan as object), `页面读 plan.${field}`);
    }
    const item = (view.workItems as Record<string, unknown>[])[0];
    for (const field of ['id', 'title', 'status', 'attemptIds']) {
      assert.ok(field in item, `页面读 workItem.${field}`);
    }
    for (const field of ['input', 'output', 'cacheRead', 'total', 'quality']) {
      assert.ok(field in (view.usage as object), `页面读 usage.${field}`);
    }
  });

  test('列表行上页面用到的字段都在', async () => {
    const { platform, base } = await serve(tempState());
    await platform.createMission({
      projectId: 'P',
      missionId: 'M1',
      contract: { intent: '修 X', acceptance: [], constraints: [], nonGoals: [], guardrails: [] },
    });
    const rows = (await (await fetch(`${base}/api/missions`)).json()) as Record<string, unknown>[];
    for (const field of [
      'missionId', 'projectId', 'status', 'intent', 'workItems', 'accepted',
      'isMutating', 'paused', 'openEscalations', 'usage',
    ]) {
      assert.ok(field in rows[0], `页面读列表行的 ${field}，读模型里没有`);
    }

    // waitReason / waitDetail 是可选的：没停机时 JSON 里根本不会有这两个键，
    // 页面也是按可选渲染的。所以判据落在「**设了就必须传出来**」，
    // 而不是「键永远在」——后者只会逼后端序列化一堆 null。
    await platform.setWaitReason('M1', 'project_busy', 'M-其他 占着名额');
    const stalled = (await (await fetch(`${base}/api/missions`)).json()) as Record<
      string,
      unknown
    >[];
    assert.equal(stalled[0].waitReason, 'project_busy');
    assert.equal(stalled[0].waitDetail, 'M-其他 占着名额');
  });
});

/* --------------------------- 资源池首屏（src/web/pool.js） --------------------------- */

/**
 * 首屏不等 /api/runtime/models。
 *
 * 浏览器不在 node 测里，所以用一个只认 [data-*] 的假 DOM + 假 fetch：
 * 要抓的是「调了哪几条接口、HTML 里有没有候选和用量」，
 * 不是 layout。假 fetch 只拦相对 /api/*，绝对地址仍交给真 fetch——
 * 同文件上面那组观测面用例可能并发，不能把全局 fetch 整条吞掉。
 */

describe('资源池页：首屏不阻塞模型', { concurrency: false }, () => {
  const loaded = import('../src/web/pool.js');

  const snapshot = {
    coordinator: [
      {
        profileId: 'coord-a',
        endpoint: 'local',
        runtime: 'pi',
        order: 0,
        facts: [
          { key: 'provider', value: 'p1' },
          { key: 'model', value: 'm1' },
        ],
      },
    ],
    executor: [],
  };
  const catalog = {
    available: true,
    runtime: 'pi',
    models: [{ provider: 'a', model: 'b', label: 'A / B' }],
  };
  const usageTotal = {
    input: 100,
    output: 50,
    cacheRead: 850,
    cacheWrite: 0,
    total: 1000,
    cost: 1.2345,
  };

  type FetchCall = { url: string; method: string; body?: string };
  const calls: FetchCall[] = [];
  let handler: ((url: string, init?: RequestInit) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>) | null = null;
  let origFetch: typeof fetch;

  function jsonRes(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }

  function attrName(sel: string): string | null {
    const m = /^\[([^\]=]+)[^\]]*\]$/.exec(sel.trim());
    return m ? m[1] : null;
  }

  function parseAttrValue(html: string, attr: string): string {
    const tag = new RegExp('<[a-z][^>]*' + attr + '[^>]*>', 'i').exec(html);
    if (!tag) return '';
    const v = /\bvalue="([^"]*)"/.exec(tag[0]);
    return v ? v[1] : '';
  }

  function fakePage() {
    const listeners: Array<{ type: string; fn: (ev: unknown) => void }> = [];
    const fields = new Map<string, { value: string; hidden: boolean; textContent: string }>();
    let html = '';
    const root: {
      isConnected: boolean;
      innerHTML: string;
      querySelector: (sel: string) => ReturnType<typeof makeField> | null;
    } = {
      isConnected: true,
      get innerHTML() {
        return html;
      },
      set innerHTML(v: string) {
        html = String(v);
        fields.clear();
      },
      querySelector(sel: string) {
        const attr = attrName(sel);
        if (!attr || !html.includes(attr)) return null;
        if (!fields.has(attr)) fields.set(attr, makeField(attr));
        return fields.get(attr)!;
      },
    };

    function makeField(attr: string) {
      let value = parseAttrValue(html, attr);
      const el = {
        get value() {
          return value;
        },
        set value(v: string) {
          value = String(v);
        },
        hidden: false,
        textContent: '',
        querySelector(sel: string) {
          return root.querySelector(sel);
        },
        closest(sel: string) {
          const a = attrName(sel);
          if (a === attr) return el;
          return root.querySelector(sel);
        },
        hasAttribute(name: string) {
          return html.includes(name);
        },
      };
      return el;
    }

    const container = {
      dataset: {} as Record<string, string>,
      isConnected: true,
      innerHTML: '',
      querySelector(sel: string) {
        if (attrName(sel) === 'data-pool-root') return root;
        return root.querySelector(sel);
      },
      addEventListener(type: string, fn: (ev: unknown) => void) {
        listeners.push({ type, fn });
      },
      dispatch(type: string, event: unknown) {
        for (const l of listeners) {
          if (l.type === type) l.fn(event);
        }
      },
    };
    return { container, root };
  }

  function intercepting(url: string): boolean {
    return (
      url === '/api/pools' || url === '/api/usage' || url === '/api/runtime/models'
    );
  }

  before(() => {
    origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!intercepting(url)) return origFetch(input, init);
      calls.push({
        url,
        method: (init && init.method) || 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      if (!handler) throw new Error('没有安装资源池 fetch handler: ' + url);
      return handler(url, init);
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = origFetch;
  });
  beforeEach(() => {
    calls.length = 0;
    handler = async (url) => {
      if (url === '/api/pools') return jsonRes(snapshot);
      if (url === '/api/usage') return jsonRes({ total: usageTotal });
      if (url === '/api/runtime/models') return jsonRes(catalog);
      throw new Error('意外的 fetch ' + url);
    };
  });

  async function waitFor(fn: () => boolean, ms = 800) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('waitFor timeout');
  }

  function openAddForm(container: ReturnType<typeof fakePage>['container']) {
    const details = {
      open: true,
      hasAttribute(name: string) {
        return name === 'data-pool-add';
      },
      closest(sel: string) {
        return attrName(sel) === 'data-pool-add' ? details : null;
      },
    };
    container.dispatch('toggle', { target: details });
  }

  test('纯 HTML：表单默认收起；读取中只在表单处提示', async () => {
    const { poolPageHtml, addFormHtml } = await loaded;
    const html = poolPageHtml(snapshot, catalog, usageTotal);
    assert.match(html, /data-count="coordinator">1</);
    assert.match(html, /coord-a/);
    assert.ok(html.includes('新增 150'), '用量卡要有新增 tokens');
    const detailsTag = /<details\b[^>]*>/.exec(html);
    assert.ok(detailsTag, '添加表单要装在 details 里');
    assert.equal(/\bopen\b/.test(detailsTag[0]), false, '默认不该展开');
    assert.match(html, /data-pool-form/);

    const loading = addFormHtml(undefined, { open: true, modelsStatus: 'loading' });
    assert.match(loading, /data-pool-models-status/);
    assert.match(loading, /模型清单读取中/);
    assert.equal(loading.includes('适配层没上线'), false, '读取中不该写成适配层故障');

    const idle = addFormHtml(undefined, { open: false, modelsStatus: 'idle' });
    assert.equal(idle.includes('适配层没上线'), false, '还没拉清单时不该告诉人适配层没上线');
    assert.match(idle, /<details\b/);
    assert.match(html, /还没读到健康/, '没有 health 对象时要说出来，不能空着像没这列');
  });

  test('健康格：熔断、七日、失败、无运行时原因；缺字段与注入', async () => {
    const { poolPageHtml, healthCellHtml } = await loaded;
    const html = poolPageHtml({
      coordinator: [],
      executor: [
        {
          profileId: '<x>',
          endpoint: 'local',
          runtime: 'pi',
          health: {
            circuit: { state: 'open', failureClass: 'quota"' },
            lastFailure: { failureClass: 'quota', at: '2026-01-01T00:00:00.000Z', source: 'attempt.ended' },
            window7d: { attempts: 1, successes: 0, reportedCost: 1.25 },
            runtime: { running: false, reason: 'no_active_lease' },
          },
        },
      ],
    }, catalog, usageTotal);
    assert.match(html, /data-health-circuit/);
    assert.match(html, /chip failed/);
    assert.match(html, />open</);
    assert.match(html, /近七日：尝试 1 · 成功 0 · \$1\.2500/);
    assert.match(html, /最近失败：quota/);
    assert.match(html, /未在跑 · no_active_lease/);
    assert.equal(html.includes('<x>'), false, 'profileId 没转义');
    assert.equal(html.includes('quota"'), false);

    const missing = healthCellHtml(undefined);
    assert.match(missing, /还没读到健康/);
    const idle = healthCellHtml({
      circuit: { state: 'closed' },
      lastFailure: { failureClass: 'unknown', at: null },
      window7d: { attempts: 0, successes: 0, reportedCost: null },
      runtime: { running: false, reason: 'queued_hops_unavailable' },
    });
    assert.match(idle, /chip done/);
    assert.match(idle, /没有失败记录/);
    assert.match(idle, /费用未上报/);
    assert.match(idle, /queued_hops_unavailable/);
    const evil = healthCellHtml({
      circuit: { state: 'unknown', reason: '<img src=x>' },
      lastFailure: { failureClass: '<b>', at: null, source: '<i>' },
      window7d: { attempts: 'x', successes: undefined, reportedCost: 'nope' },
      runtime: { running: false, reason: '<script>' },
    });
    assert.equal(evil.includes('<img'), false);
    assert.equal(evil.includes('<script>'), false);
    assert.equal(evil.includes('<b>'), false);
    assert.match(evil, /&lt;img/);
    assert.match(evil, /近七日：尝试 0 · 成功 0 · 费用未上报/);
    assert.equal(evil.includes('data-health-usage'), false, '没有用量字段时整行不出现');
  });

  test('健康格：定时重置显示套餐与剩余百分比', async () => {
    const { healthCellHtml } = await loaded;
    const html = healthCellHtml({
      circuit: { state: 'open', failureClass: 'quota' },
      window7d: { attempts: 3, successes: 1, reportedCost: 0.5 },
      runtime: { running: false, reason: 'no_active_lease' },
      usage: { provider: 'xai', plan: 'SuperGrok', remainingPercent: 0, resetAt: '2026-10-05T16:10:00.000Z' },
      quotaReason: '额度已用完，2026-10-05T16:10:00.000Z 重置后再派活。',
    });
    assert.match(html, /data-health-usage/);
    assert.match(html, /SuperGrok 剩 0%/);
    // 用量行里的重置时间要缩短到分钟；额度原因里带 ISO 原串是后端原样文案，不算退化。
    const usageLine = /data-health-usage>([^<]*)</.exec(html);
    assert.ok(usageLine, '要有用量行');
    assert.match(usageLine[1], /^SuperGrok 剩 0% · \d{1,2}\/\d{1,2} \d{2}:\d{2} 重置$/);
    assert.equal(usageLine[1].includes('2026-10-05T16:10'), false, 'ISO 原串不该占满整行');
    assert.match(html, /data-health-quota-reason/);
    assert.match(html, /重置后再派活/);
    assert.match(html, /近七日：尝试 3 · 成功 1/, '既有健康行不能因为加了用量行而退化');
  });

  test('健康格：没有重置时间时给复位命令，命令只显示且转义', async () => {
    const { healthCellHtml } = await loaded;
    const html = healthCellHtml({
      circuit: { state: 'open', failureClass: 'quota' },
      window7d: { attempts: 2, successes: 0, reportedCost: null },
      runtime: { running: false, reason: 'no_active_lease' },
      quotaReason: '额度已用完，适配层没有给出重置时间 —— 不会自动恢复，要等充值后人工复位。',
      resetCommand: "coagentctl pool reset 'grok' && echo <script>",
    });
    assert.match(html, /要等充值后人工复位/);
    assert.match(html, /data-health-quota-reset/);
    assert.match(html, /<code>/);
    assert.equal(html.includes('<script>'), false, '复位命令是外来文案，必须转义');
    assert.match(html, /&lt;script&gt;/);
    assert.equal(html.includes('data-health-usage'), false, '没有用量就不显示用量行');
    assert.match(html, /chip failed/, '既有熔断 chip 不受影响');
  });

  test('首屏只拉 pools 与 usage，不发也不等 models', async () => {
    const { renderPoolPage } = await loaded;
    let modelsHit = false;
    let releaseModels!: () => void;
    const modelsGate = new Promise<void>((r) => {
      releaseModels = r;
    });
    handler = async (url) => {
      if (url === '/api/pools') return jsonRes(snapshot);
      if (url === '/api/usage') return jsonRes({ total: usageTotal });
      if (url === '/api/runtime/models') {
        modelsHit = true;
        await modelsGate;
        return jsonRes(catalog);
      }
      throw new Error(url);
    };
    const { container, root } = fakePage();
    const done = renderPoolPage(container);
    const first = await Promise.race([
      done.then(() => 'rendered' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 400)),
    ]);
    assert.equal(first, 'rendered', '首屏被 models 接口挡住了');
    assert.equal(modelsHit, false, '首屏不该去请 /api/runtime/models');
    assert.equal(
      calls.some((c) => c.url === '/api/runtime/models'),
      false,
    );
    assert.deepEqual(
      calls.map((c) => c.url).sort(),
      ['/api/pools', '/api/usage'].sort(),
    );
    assert.match(root.innerHTML, /coord-a/);
    assert.match(root.innerHTML, /data-count="coordinator">1</);
    assert.ok(root.innerHTML.includes('新增 150'), '用量要画出来');
    const detailsTag = /<details\b[^>]*>/.exec(root.innerHTML);
    assert.ok(detailsTag);
    assert.equal(/\bopen\b/.test(detailsTag[0]), false, '首屏表单要收起');
    releaseModels();
    await done;
  });

  test('打开表单才拉模型；读取中提示；失败只影响表单', async () => {
    const { renderPoolPage } = await loaded;
    let releaseModels!: (fail: boolean) => void;
    const modelsGate = new Promise<boolean>((r) => {
      releaseModels = r;
    });
    handler = async (url) => {
      if (url === '/api/pools') return jsonRes(snapshot);
      if (url === '/api/usage') return jsonRes({ total: usageTotal });
      if (url === '/api/runtime/models') {
        const fail = await modelsGate;
        if (fail) return jsonRes({ message: 'down' }, 500);
        return jsonRes(catalog);
      }
      throw new Error(url);
    };
    const { container, root } = fakePage();
    await renderPoolPage(container);
    assert.equal(calls.some((c) => c.url === '/api/runtime/models'), false);

    openAddForm(container);
    await waitFor(() => root.innerHTML.includes('模型清单读取中'));
    assert.ok(calls.some((c) => c.url === '/api/runtime/models'), '打开表单后才请模型');
    assert.match(root.innerHTML, /coord-a/);
    assert.ok(root.innerHTML.includes('新增 150'));

    releaseModels(true);
    await waitFor(() => root.innerHTML.includes('拿不到模型清单'));
    assert.match(root.innerHTML, /coord-a/, '模型失败不能把候选表撤掉');
    assert.ok(root.innerHTML.includes('新增 150'), '模型失败不能把用量撤掉');
    assert.match(root.innerHTML, /data-pool-note/);
  });

  test('模型清单回来时不清空已填的候选名称；POST /api/pools 仍发', async () => {
    const { renderPoolPage } = await loaded;
    let releaseModels!: () => void;
    const modelsGate = new Promise<void>((r) => {
      releaseModels = r;
    });
    handler = async (url, init) => {
      if (url === '/api/pools' && (init?.method || 'GET') === 'POST') {
        return jsonRes({ ok: true }, 201);
      }
      if (url === '/api/pools') return jsonRes(snapshot);
      if (url === '/api/usage') return jsonRes({ total: usageTotal });
      if (url === '/api/runtime/models') {
        await modelsGate;
        return jsonRes(catalog);
      }
      throw new Error(url);
    };
    const { container, root } = fakePage();
    await renderPoolPage(container);
    openAddForm(container);
    await waitFor(() => root.innerHTML.includes('模型清单读取中'));
    root.querySelector('[data-pool-profile]')!.value = 'keep-me';
    root.querySelector('[data-pool-role]')!.value = 'executor';
    releaseModels();
    await waitFor(() => root.innerHTML.includes('A / B'));
    assert.equal(
      root.querySelector('[data-pool-profile]')!.value,
      'keep-me',
      '清单重画把候选名称清掉了',
    );
    assert.equal(root.querySelector('[data-pool-role]')!.value, 'executor');

    const modelValue = JSON.stringify({ provider: 'a', model: 'b' });
    root.querySelector('[data-pool-model]')!.value = modelValue;
    const form = root.querySelector('[data-pool-form]')!;
    container.dispatch('submit', { target: form, preventDefault() {} });
    await waitFor(() => calls.some((c) => c.url === '/api/pools' && c.method === 'POST'));
    const posted = calls.find((c) => c.url === '/api/pools' && c.method === 'POST');
    assert.ok(posted?.body, 'POST 要带 body');
    const body = JSON.parse(posted!.body!) as {
      role: string;
      profileId: string;
      endpoint: string;
      facts: Array<{ key: string; value: string }>;
    };
    assert.equal(body.role, 'executor');
    assert.equal(body.profileId, 'keep-me');
    assert.equal(body.endpoint, 'local');
    assert.deepEqual(body.facts, [
      { key: 'provider', value: 'a' },
      { key: 'model', value: 'b' },
    ]);
  });
});
