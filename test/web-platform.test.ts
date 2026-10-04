/**
 * 平台页（src/web/platform.js）。
 *
 * 正式页不在测试的浏览器里：字段名读错一个，界面照样渲染，只是那一格永远
 * 空着或把 PG 不适用画成「没有身份」。所以这一组守三件事：
 *
 *   1. 文件形状 —— 路由、modulepreload、只 GET、10 秒轮询。
 *   2. 纯函数喂假数据 —— 空值、不适用、死信倒序、五维占用、HTML 转义。
 *   3. 离页后过期的异步响应不得写 DOM。
 */

import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/web/${name}`, import.meta.url)), 'utf8')
    .replace(/\r\n/g, '\n');

describe('平台页的文件形状', () => {
  test('platform.js 是静态服务认得的扁平小写名，且被外壳接上', () => {
    assert.ok(existsSync(new URL('../src/web/platform.js', import.meta.url)));
    assert.match('platform.js', /^[a-z0-9][a-z0-9._-]*\.(html|css|js|svg)$/);
    const html = read('index.html');
    assert.match(html, /<link rel="modulepreload" href="\/platform\.js" \/>/);
    assert.equal(/<script[^>]+src="\/platform\.js"/.test(html), false, 'platform.js 被写成会执行的 script');
    assert.doesNotMatch(html, /data-route="platform"/, '兼容页面不占主导航');
    assert.match(html, /href="#\/"[^>]*data-route="home"/, '首页为主入口');
    const shell = read('app.js');
    assert.match(shell, /from '\.\/platform\.js'/);
    assert.match(shell, /\/platform/);
    assert.match(shell, /renderPlatformPage/);
    assert.ok(shell.includes("location.hash = '#/projects'"), '未知 hash 仍回项目页');
  });

  test('样式在 index.html 里，只用令牌，不另起 css', () => {
    const html = read('index.html');
    assert.match(html, /\.platform\s*\{/);
    assert.equal(existsSync(new URL('../src/web/platform.css', import.meta.url)), false);
    const platformSrc = read('platform.js');
    assert.equal(/#[0-9a-fA-F]{3,6}/.test(platformSrc), false, 'platform.js 里出现了写死的十六进制色');
    assert.equal(/oklch\(/.test(platformSrc), false, 'platform.js 里出现了写死的 oklch');
  });

  test('这一页只读：不发 POST，10 秒轮询，离页靠 epoch/isConnected', () => {
    const src = read('platform.js');
    assert.equal(/method:\s*'POST'/.test(src), false, '不许发写请求');
    assert.match(src, /\/api\/platform\/status/);
    assert.match(src, /PLATFORM_POLL_MS/);
    assert.match(src, /10000/);
    assert.match(src, /isConnected/);
    assert.match(src, /epoch/);
  });
});

describe('平台页纯函数', () => {
  const loaded = import('../src/web/platform.js');

  const fileStatus = {
    api: 'v1',
    pid: 4242,
    store: 'file',
    instanceId: 'inst-file',
    statePath: '/tmp/state.json',
    holdsMainLock: true,
    startedAt: '2026-01-01T00:00:00.000Z',
    listen: { address: '127.0.0.1', port: 9414 },
    queue: {
      counts: { queued: 1, claimed: 2, completed: 3, retry_wait: 4, dead_letter: 2 },
      deadLetters: [
        {
          hopId: 'h-old',
          missionId: 'M-old',
          workItemId: 'w1',
          role: 'executor',
          at: '2026-01-01T00:10:00.000Z',
          classification: 'auth',
        },
        {
          hopId: 'h-new',
          missionId: 'M-new',
          workItemId: 'w2',
          role: 'coordinator',
          at: '2026-01-01T00:20:00.000Z',
          classification: 'quota',
        },
      ],
    },
    occupancy: {
      now: '2026-01-01T00:30:00.000Z',
      limits: { global: 8, project: 2, role: 4, runtime: 4, profile: 2 },
      activeLeases: 1,
      global: 1,
      project: { P1: 1 },
      role: { executor: 1 },
      runtime: { pi: 1 },
      profile: { 'exec-qwen': 1 },
      runtimeUnattributed: 0,
      profileUnattributed: 0,
    },
    agentEnv: {
      passthroughDeclared: true,
      baselineFiltered: true,
      extraPassthroughCount: 0,
    },
    defaultAdapter: 'pi',
  };

  test('空值与 PG 不适用项都有字，不当成空白', async () => {
    const { platformPageHtml, identityCardHtml, queueCardHtml, occupancyCardHtml, configCardHtml } = await loaded;
    assert.match(platformPageHtml(null), /正在读取平台状态/);
    assert.match(platformPageHtml(null, 'boom'), /读不到平台状态：boom/);
    assert.match(queueCardHtml(undefined), /还没读到队列/);
    assert.match(occupancyCardHtml(undefined), /还没读到占用/);

    const pg = identityCardHtml({
      api: 'v1',
      pid: 1,
      store: 'pg',
      instanceId: { inapplicable: true, reason: 'pg_has_no_file_instance_lock' },
      statePath: { inapplicable: true, reason: 'pg_has_no_state_file' },
      holdsMainLock: { inapplicable: true, reason: 'pg_has_no_file_main_lock' },
      startedAt: { inapplicable: true, reason: 'started_at_not_assembled' },
      listen: { inapplicable: true, reason: 'listen_address_unavailable' },
    });
    assert.match(pg, /不适用（pg_has_no_file_instance_lock）/);
    assert.match(pg, /不适用（pg_has_no_state_file）/);
    assert.match(pg, /不适用（pg_has_no_file_main_lock）/);
    assert.match(pg, /不适用（listen_address_unavailable）/);
    assert.equal(/undefined|NaN|\[object Object\]/.test(pg), false, pg);

    const unavailable = occupancyCardHtml({ inapplicable: true, reason: 'queued_hops_unavailable' });
    assert.match(unavailable, /不适用（queued_hops_unavailable）/);
    assert.equal(unavailable.includes('data-occupancy="global"'), false, '不适用时不能画成 0 占用');

    const cfg = configCardHtml({
      defaultAdapter: { inapplicable: true, reason: 'default_adapter_not_assembled' },
      agentEnv: { inapplicable: true, reason: 'agent_env_not_assembled' },
    });
    assert.match(cfg, /不适用（default_adapter_not_assembled）/);
    assert.match(cfg, /不适用（agent_env_not_assembled）/);
  });

  test('按实际数据渲染身份、五态队列、死信倒序、五维占用、配置', async () => {
    const { platformPageHtml, sortDeadLetters } = await loaded;
    const html = platformPageHtml(fileStatus);
    assert.match(html, /inst-file/);
    assert.match(html, /\/tmp\/state\.json/);
    assert.match(html, /127\.0\.0\.1:9414/);
    assert.match(html, /data-queue="queued">1</);
    assert.match(html, /data-queue="claimed">2</);
    assert.match(html, /data-queue="completed">3</);
    assert.match(html, /data-queue="retry_wait">4</);
    assert.match(html, /data-queue="dead_letter">2</);
    const posNew = html.indexOf('data-dead-letter="h-new"');
    const posOld = html.indexOf('data-dead-letter="h-old"');
    assert.ok(posNew >= 0 && posOld >= 0 && posNew < posOld, '死信必须最新在上');
    assert.match(html, /quota/);
    assert.match(html, /data-occupancy="global">1 \/ 8</);
    assert.match(html, /P1/);
    assert.match(html, /exec-qwen/);
    assert.match(html, />pi</);
    assert.match(html, /环境透传已声明/);
    assert.equal(/undefined|NaN|\[object Object\]/.test(html), false, html);

    const sorted = sortDeadLetters(fileStatus.queue.deadLetters);
    assert.deepEqual(sorted.map((row: { hopId: string }) => row.hopId), ['h-new', 'h-old']);
    assert.equal(fileStatus.queue.deadLetters[0]?.hopId, 'h-old', '不能原地改入参');
  });

  test('外部数据进不了 DOM', async () => {
    const { platformPageHtml } = await loaded;
    const evil = '<img src=x onerror="alert(1)">';
    const html = platformPageHtml({
      api: evil,
      instanceId: evil,
      statePath: evil,
      store: evil,
      queue: {
        counts: { queued: 0, claimed: 0, completed: 0, retry_wait: 0, dead_letter: 1 },
        deadLetters: [{
          hopId: evil,
          missionId: evil,
          workItemId: evil,
          role: evil,
          at: '2026-01-01T00:00:00.000Z',
          classification: evil,
        }],
      },
      occupancy: {
        limits: { global: 8, project: 2, role: 4, runtime: 4, profile: 2 },
        activeLeases: 1,
        global: 1,
        project: { [evil]: 1 },
        role: {},
        runtime: {},
        profile: {},
        runtimeUnattributed: 0,
        profileUnattributed: 0,
      },
      defaultAdapter: evil,
      agentEnv: { passthroughDeclared: true, baselineFiltered: true, extraPassthroughCount: 0 },
    });
    assert.equal(/<img\b/i.test(html), false, '外部字段没转义就被当标签解析了');
    assert.ok(html.includes('&lt;img'), '转义后的形式应当出现');
    assert.equal(html.includes('onerror="'), false, '引号没转义，onerror 仍能当属性');
  });

  test('缺队列计数键当 0，不是 NaN', async () => {
    const { queueCardHtml } = await loaded;
    const html = queueCardHtml({ counts: {}, deadLetters: [] });
    assert.match(html, /data-queue="queued">0</);
    assert.match(html, /没有死信/);
    assert.equal(/NaN|undefined/.test(html), false, html);
  });
});

describe('平台页：轮询与陈旧响应', { concurrency: false }, () => {
  const loaded = import('../src/web/platform.js');

  type FetchCall = { url: string; method: string };
  const calls: FetchCall[] = [];
  let handler: ((url: string) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>) | null = null;
  let origFetch: typeof fetch;
  let origSetInterval: typeof setInterval;
  let origClearInterval: typeof clearInterval;
  const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  let nextTimerId = 1;

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

  function fakePage() {
    let html = '';
    const root: {
      isConnected: boolean;
      innerHTML: string;
      querySelector: (sel: string) => null;
    } = {
      isConnected: true,
      get innerHTML() {
        return html;
      },
      set innerHTML(v: string) {
        html = String(v);
      },
      querySelector() {
        return null;
      },
    };
    const container = {
      dataset: {} as Record<string, string>,
      isConnected: true,
      innerHTML: '',
      querySelector(sel: string) {
        if (attrName(sel) === 'data-platform-root') return root;
        return null;
      },
    };
    return { container, root };
  }

  before(() => {
    origFetch = globalThis.fetch;
    origSetInterval = globalThis.setInterval;
    origClearInterval = globalThis.clearInterval;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== '/api/platform/status') return origFetch(input, init);
      calls.push({ url, method: (init && init.method) || 'GET' });
      if (!handler) throw new Error('没有安装平台 fetch handler');
      return handler(url);
    }) as typeof fetch;
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      const id = nextTimerId++;
      timers.push({ id, fn, ms: ms ?? 0 });
      return id as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
      const n = Number(id);
      const i = timers.findIndex((t) => t.id === n);
      if (i >= 0) timers.splice(i, 1);
    }) as typeof clearInterval;
  });
  after(() => {
    globalThis.fetch = origFetch;
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  });
  beforeEach(() => {
    calls.length = 0;
    timers.length = 0;
    nextTimerId = 1;
    handler = async () => jsonRes({
      api: 'v1',
      pid: 1,
      store: 'memory',
      instanceId: { inapplicable: true, reason: 'memory_has_no_file_instance_lock' },
      queue: { inapplicable: true, reason: 'queued_hops_unavailable' },
      occupancy: { inapplicable: true, reason: 'queued_hops_unavailable' },
      agentEnv: { inapplicable: true, reason: 'agent_env_not_assembled' },
      defaultAdapter: { inapplicable: true, reason: 'default_adapter_not_assembled' },
    });
  });

  test('首屏拉 /api/platform/status，定时器是 10 秒', async () => {
    const { renderPlatformPage, PLATFORM_POLL_MS } = await loaded;
    assert.equal(PLATFORM_POLL_MS, 10000);
    const { container, root } = fakePage();
    await renderPlatformPage(container);
    assert.deepEqual(calls.map((c) => c.url), ['/api/platform/status']);
    assert.match(root.innerHTML, /memory_has_no_file_instance_lock/);
    assert.equal(timers.length, 1);
    assert.equal(timers[0]?.ms, 10000);
  });

  test('离页后过期的 status 不写 DOM', async () => {
    const { renderPlatformPage } = await loaded;
    let release!: (body: unknown) => void;
    const gate = new Promise<unknown>((r) => {
      release = r;
    });
    handler = async () => {
      const body = await gate;
      return jsonRes(body);
    };
    const first = fakePage();
    const pending = renderPlatformPage(first.container);
    first.root.isConnected = false;
    release({ instanceId: 'stale-should-not-appear', api: 'v1' });
    await pending;
    assert.equal(first.root.innerHTML.includes('stale-should-not-appear'), false, first.root.innerHTML);
  });

  test('换代之后旧响应不能盖住新页', async () => {
    const { renderPlatformPage } = await loaded;
    const waiters: Array<(body: unknown) => void> = [];
    handler = async () => {
      const body = await new Promise<unknown>((r) => waiters.push(r));
      return jsonRes(body);
    };
    const page = fakePage();
    const first = renderPlatformPage(page.container);
    const second = renderPlatformPage(page.container);
    assert.equal(waiters.length, 2);
    waiters[0]!({ instanceId: 'from-first', api: 'v1' });
    await first;
    assert.equal(page.root.innerHTML.includes('from-first'), false, page.root.innerHTML);
    waiters[1]!({ instanceId: 'from-second', api: 'v1' });
    await second;
    assert.match(page.root.innerHTML, /from-second/);
    assert.equal(page.root.innerHTML.includes('from-first'), false);
  });
});
