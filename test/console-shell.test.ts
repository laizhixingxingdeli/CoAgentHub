/**
 * 双入口外壳（src/web/console-shell.js）。
 *
 * 只写两条：这个模块真正容易被悄悄说坏的两个接缝。
 *
 *   1. **外壳说的话与算的格。** 顶栏那句同步状态：写死一个时刻最省事，但那句话
 *      从此和平台无关；一次都没读成功时还显示「服务正常」，等于告诉人一切正常。
 *      一级入口与项目下拉同理——高亮一个不属于任何入口的页面，人就会以为自己在
 *      看任务列表；资源页藏掉项目下拉，人又会以为资源页没有项目这个维度。
 *   2. **请求的生命周期。** 换页时旧响应晚到会把项目名与同步时刻写进**新**页面，
 *      而屏幕上没有任何报错，只是顶栏显示的是上一页的事实。
 *
 * 其余分支不各写一条：同一个判断写第二遍不会更准，只会多一处要跟着改。
 *
 * DOM 用仓库里已有的 happy-dom（l3-mcp-server 的 devDependency，经 npm workspaces
 * 装在根 node_modules）。**不安装新依赖**：无构建、零安装是本仓的静态边界。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Window } from 'happy-dom';

import {
  ALL_PROJECTS,
  START_COMMAND,
  createShell,
  formatClock,
  navKeyForRoute,
  projectSelectState,
  projectSelectTarget,
  shellBanner,
  syncStatusLabel,
} from '../src/web/console-shell.js';

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/web/${name}`, import.meta.url)), 'utf8')
    .replace(/\r\n/g, '\n');

/**
 * 用**真的 index.html 骨架**搭页面，不另写一份迷你 DOM。
 *
 * 另写一份的话，这里全绿而真实页面缺一个 id 也不会被发现——那正是外壳最典型的
 * 故障（往 null 上写，不报错，只是那一块永远空着）。只取 <body> 里的标记，
 * 不执行 <script>：外壳模块在这一组里是被 import 的，不该再跑一遍。
 */
function mountShell(fetchJson: unknown, options: { now?: () => number; pollMs?: number } = {}) {
  const html = read('index.html');
  const body = /<body>([\s\S]*?)<script/.exec(html);
  assert.ok(body, 'index.html 里找不到 body 内容');
  const window = new Window({ url: 'http://127.0.0.1:3101/#/' });
  window.document.body.innerHTML = body[1] as string;
  const shell = createShell({
    doc: window.document as unknown as Document,
    win: window as unknown as Window & typeof globalThis,
    fetchJson: fetchJson as never,
    now: options.now,
    pollMs: options.pollMs ?? 60_000,
  });
  return { window, document: window.document, shell };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('外壳说什么、算哪一格', () => {
  const NOW = Date.UTC(2026, 9, 26, 6, 0, 0);
  const at = NOW - 5_000;

  test('同步状态不编时刻；一级入口与项目下拉各归其位', () => {
    // 初次加载就是绿的，等于告诉人一切正常——而那时一次读取都没成功。
    // 14:32:08 是画板里的示例值，绝不能出现：它会被当成「刚才同步过」。
    for (const state of [
      { lastOkAt: null, statusError: null },
      { lastOkAt: null, statusError: { kind: 'unreachable' } },
    ]) {
      const label = syncStatusLabel(state, NOW);
      assert.equal(label.tone, 'unknown');
      assert.ok(!label.text.includes('服务正常'), label.text);
      assert.ok(!/\d{2}:\d{2}:\d{2}/.test(label.text), `不该出现任何时刻：${label.text}`);
    }

    // 读到过：时刻就是那次读取的时刻（换一个时刻文字必须跟着变——写死的值在这里露馅）。
    const ok = syncStatusLabel({ lastOkAt: at, statusError: null }, NOW);
    assert.equal(ok.tone, 'ok');
    assert.equal(ok.text, '最近同步 ' + formatClock(at) + ' · 服务正常');
    assert.notEqual(syncStatusLabel({ lastOkAt: at - 3_600_000, statusError: null }, NOW).text, ok.text);

    // 读失败（或只是过期）都保留最后的成功时刻，并且都不说「服务正常」。
    const down = syncStatusLabel({ lastOkAt: at, statusError: { kind: 'unreachable' } }, NOW);
    assert.equal(down.tone, 'down');
    assert.ok(down.text.includes(formatClock(at)) && !down.text.includes('服务正常'), down.text);

    // 横幅只在真需要动手时出现：一句「服务正常」写两遍不算信息，还把真需要处理的
    // 那次淹掉。故障时必须给一条能照着敲的命令。
    assert.equal(shellBanner({ lastOkAt: NOW, statusError: null }, NOW), '');
    const banner = shellBanner({ lastOkAt: NOW, statusError: { kind: 'unreachable' } }, NOW);
    assert.ok(banner.includes('服务未运行') && banner.includes(formatClock(NOW)), banner);
    // 命令与 docs/getting-started.md、README.md 是同一句；凭印象写一句 npm start
    // 会把人引到不存在的脚本上，而屏幕上完全看不出那是猜的。
    assert.ok(banner.includes(START_COMMAND), banner);
    assert.equal(START_COMMAND, 'node scripts/coagent.mjs start');
    for (const doc of ['../docs/getting-started.md', '../README.md']) {
      assert.ok(
        readFileSync(fileURLToPath(new URL(doc, import.meta.url)), 'utf8').includes(START_COMMAND),
        `${doc} 里找不到这条命令，说明它已经变了`,
      );
    }
    // 一次都没读到过时也要说清楚，而不是给一条空白的横幅。
    assert.ok(
      shellBanner({ lastOkAt: null, statusError: { kind: 'unreachable' } }, NOW).includes(START_COMMAND),
    );

    // 任务是「所有关于任务的页面」这一项，不只是首页。
    for (const name of ['home', 'projects', 'mission', 'project-spec']) {
      assert.equal(navKeyForRoute(name), 'tasks', `${name} 该归在「任务」下`);
    }
    assert.equal(navKeyForRoute('pool'), 'pool');
    // 这些页面还可达（旧深链接不被 404），但**不属于**任何一级入口。
    for (const name of ['agents', 'settings', 'platform', 'plan-runs', 'plan-run', 'inbox', 'unknown']) {
      assert.equal(navKeyForRoute(name), '', `${name} 不该占一级入口`);
    }

    // 资源页的项目控件和任务页一样可见（Figma 2:214 顶栏就是「项目：全部项目」）。
    // 池没有项目私池这回事，所以这里只看控件：它不改变池的读取范围。
    assert.deepEqual(projectSelectState({ name: 'pool' }), { visible: true, value: ALL_PROJECTS });
    assert.deepEqual(projectSelectState({ name: 'projects', projectId: 'p1' }), { visible: true, value: 'p1' });
    // 任务详情页的所属项目只有任务页拿得到（外壳不读业务数据），所以显示「全部项目」。
    assert.deepEqual(projectSelectState({ name: 'mission', missionId: 'M1' }), {
      visible: true,
      value: ALL_PROJECTS,
    });
    // 「全部项目」去任务总览：#/projects 会落到列表里排在第一个的那个项目，
    // 那不是「全部」，只是恰好排第一。
    assert.equal(projectSelectTarget(ALL_PROJECTS), '#/');
    assert.equal(projectSelectTarget('p 1'), '#/projects/p%201');
  });
});

describe('外壳的请求生命周期（真 DOM）', () => {
  test('项目来自真接口、时刻是真的读取时间；换页取消在飞的请求，旧响应不得覆盖新路由', async () => {
    const now = () => Date.UTC(2026, 9, 26, 6, 0, 0);
    const { window, document, shell } = mountShell(
      async (path: string) => {
        if (path === '/api/projects') return [{ projectId: 'p1' }, { projectId: 'p2' }];
        if (path === '/api/platform/status') return { api: 'v1' };
        throw new Error('HTTP 404');
      },
      { now },
    );
    await shell.update({ name: 'home' });

    const select = document.getElementById('cs-project-select');
    assert.ok(select, '项目下拉没接上（index.html 缺 #cs-project-select？）');
    assert.deepEqual(
      [...select.querySelectorAll('option')].map((o) => o.value),
      [ALL_PROJECTS, 'p1', 'p2'],
      '项目选项必须来自接口，不能写死',
    );
    const sync = document.getElementById('cs-sync');
    assert.equal(sync?.dataset.tone, 'ok');
    assert.equal(sync?.textContent, '最近同步 ' + formatClock(now()) + ' · 服务正常');
    assert.equal(document.getElementById('cs-banner')?.hidden, true);

    // 换项目：改 hash 而不是整页跳转——外壳走 hash 路由，重载会把读到的项目与
    // 时刻扔掉重来一遍。
    (select as unknown as { value: string }).value = 'p1';
    select.dispatchEvent(new window.Event('change') as unknown as Event);
    assert.equal(window.location.hash, '#/projects/p1');
    shell.dispose();

    // 第二轮：让第一次读取一直挂着，在它回来之前换页。旧响应晚到会把上一页的
    // 项目名写进新页面，而屏幕上没有任何报错。
    const pending: { resolve: (value: unknown) => void }[] = [];
    const paths: string[] = [];
    const resolveLater = (path: string) => {
      paths.push(path);
      return new Promise((resolve) => pending.push({ resolve }));
    };
    const second = mountShell(resolveLater);
    const first = second.shell.update({ name: 'projects', projectId: 'p1' });
    const swapped = second.shell.update({ name: 'pool' });
    assert.equal(pending.length, 4, '两轮各两个请求：换页必须另起一轮，不能复用旧的那轮');

    pending[0]!.resolve([{ projectId: 'stale-project' }]);
    pending[1]!.resolve({ api: 'v1' });
    pending[2]!.resolve([{ projectId: 'p1' }, { projectId: 'p2' }]);
    pending[3]!.resolve({ api: 'v1' });
    await first;
    await swapped;
    await tick();

    const next = second.document.getElementById('cs-project-select')!;
    assert.deepEqual(
      [...next.querySelectorAll('option')].map((o) => o.value),
      [ALL_PROJECTS, 'p1', 'p2'],
      '第一轮的 stale-project 晚到，绝不能写进下拉',
    );
    // 资源页也显示项目控件，且不把上一页的 p1 留在选中态；选中的项目走的是任务页。
    assert.equal(second.document.getElementById('cs-project')!.hidden, false);
    assert.equal((next as unknown as { value: string }).value, ALL_PROJECTS);
    // 池的读取仍是全局的：换到资源页后的请求不带任何项目维度。
    assert.ok(paths.every((path) => !path.includes('projectId')), `池请求不该带项目：${paths.join(', ')}`);
    second.shell.dispose();
  });
});
