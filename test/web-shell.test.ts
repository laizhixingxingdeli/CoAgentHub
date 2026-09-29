/**
 * 正式 Web 外壳（src/web/）。
 *
 * 这一组测的不是"页面好不好看"，而是三件会被静默弄坏的事：
 *
 *   1. **GET / 吐的是哪份 HTML。** 内置观测面（src/api/web.ts）和正式页抢的是
 *      同一个 `/`，先后顺序写在 src/api/server.ts 里。回归时没有任何报错——
 *      页面照样渲染，只是又变回老观测面了。
 *   2. **静态服务认不认这套文件名。** SAFE_NAME 只认一层小写文件名，
 *      写成 /src/web/app.js 或 App.js 就是浏览器里一个 404，控制台之外没人知道。
 *   3. **色彩令牌是不是同源。** 令牌一旦在两处各存一份，两个界面的"执行中"
 *      就开始漂，而颜色对不上不会有人报 bug。
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
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { WEB_PAGE } from '../src/api/web.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

// 读进来就归一化行尾：这份仓库在 Windows 上 checkout 出来是 CRLF（core.autocrlf），
// 而比对的源 WEB_PAGE 是模板字符串里的 LF。不归一的话，逐字比对会因为行尾而红，
// 报的还是一个谁都没改过的地方。
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
 * **不传 webRoot**：这条要验的正是"默认就是 src/web/"。
 * 传个临时目录进去，测到的就只是那几个假文件，真实的 src/web/ 整个被绕开。
 */
async function serveDefaultWebRoot(): Promise<{ platform: Platform; base: string }> {
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
  const server = createApi({ platform, tokens: new RunTokenRegistry(), deliveries });
  await listenLoopback(server, 0);
  servers.push(server);
  return { platform, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('外壳的文件形状', () => {
  test('四个文件都在，且都是静态服务认得的扁平小写名', () => {
    // 静态服务只认 `^[a-z0-9][a-z0-9._-]*\.(html|css|js|svg)$`：大写、多级目录、
    // 别的扩展名，全都是浏览器里一个 404。这里先红，好过界面上是白屏。
    for (const name of ['index.html', 'app.js', 'tokens.css', 'projects.js', 'plan-run.js', 'platform.js']) {
      assert.ok(existsSync(new URL(`../src/web/${name}`, import.meta.url)), `缺 src/web/${name}`);
      assert.match(name, /^[a-z0-9][a-z0-9._-]*\.(html|css|js|svg)$/);
    }
  });

  test('index.html 引到了这三个资源', () => {
    const html = read('index.html');
    assert.match(html, /tokens\.css/);
    assert.match(html, /app\.js/);
    assert.match(html, /projects\.js/);
  });

  test('外壳有品牌、四个入口、无设置/用户占位、面包屑容器', () => {
    const html = read('index.html');
    assert.match(html, /CoAgentHub/);
    assert.match(html, />项目</);
    assert.match(html, />方案运行</);
    assert.match(html, />资源池</);
    assert.match(html, />平台</);
    assert.match(html, /href="#\/platform"/);
    assert.equal(html.includes('>设置<') || /\n\s*设置\s*\n/.test(html), false, '设置占位还在');
    assert.equal(/>用户</.test(html), false, '用户占位还在');
    // 面包屑的文字由 app.js 按当前 hash 填，所以这里要的是那个容器本身。
    assert.match(html, /id="crumbs"/);
  });

  test('导航有图标（内联 SVG，fill=currentColor），也不引外链图片', () => {
    const html = read('index.html');
    const nav = /<nav[\s\S]*?<\/nav>/.exec(html);
    assert.ok(nav, '找不到导航');
    assert.equal((nav[0].match(/<svg/g) || []).length, 4, '「项目」「方案运行」「资源池」「平台」各要一个图标');
    assert.equal((nav[0].match(/fill="currentColor"/g) || []).length, 4, '图标要 fill=currentColor');
    // 不靠图片资源：这一页零构建、零外链，图标必须内联。
    assert.equal(/<img/.test(nav[0]), false);
  });

  test('narrate.js 被 modulepreload，且不是会执行的 script', () => {
    const html = read('index.html');
    assert.match(html, /<link rel="modulepreload" href="\/narrate\.js" \/>/);
    assert.equal(/<script[^>]+src="\/narrate\.js"/.test(html), false, 'narrate.js 被写成会执行的 script');
    assert.equal((html.match(/<script type="module"/g) || []).length, 1, '外壳只该有一个入口 script');
  });

  test('app.js 用 location.hash 路由，认不出的 hash 落回 #/projects', () => {
    const shell = read('app.js');
    assert.match(shell, /location\.hash/);
    assert.match(shell, /hashchange/);
    assert.ok(shell.includes("location.hash = '#/projects'"), '空/未知 hash 要改写到项目页，而不是渲染空白');
    // projects.js 由 app.js import；index.html 里那份只是 modulepreload，不执行。
    assert.match(shell, /from '\.\/projects\.js'/);
  });

  test('app.js 要的 DOM 锚点在 index.html 里都在', () => {
    // 外壳靠 id 接上页面。写错一个字母不会报错，只会一个事件监听都接不上——
    // 页面停在建好的骨架上不动。这类名子对不上只有跨文件才能发现。
    const html = read('index.html');
    const ids = [...read('app.js').matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(ids.length >= 2, 'app.js 该从 index.html 里取到外壳锚点');
    for (const id of ids) {
      assert.ok(html.includes(`id="${id}"`), `app.js 取 #${id}，index.html 里没有`);
    }
    // 项目页自己建的骨架与导航类名：nav 的高亮选择器要真能命中。
    const projects = read('projects.js');
    for (const id of ['proj-list', 'proj-detail']) {
      assert.ok(projects.includes(`#${id}`) && projects.includes(`id="${id}"`), `骨架里缺 #${id}`);
    }
    assert.match(html, /class="item"[^>]*data-route="projects"/);
    assert.match(html, /class="item"[^>]*data-route="pool"/);
    assert.match(html, /class="item"[^>]*data-route="platform"/);
  });

  test('外壳不靠内置观测面', () => {
    // 正式页不该把观测面那段 HTML 拼进来：两个界面共用一份字符串的话，
    // 观测面一改，正式页也跟着变，而没人会想到它们原来是一体。
    const html = read('index.html');
    assert.equal(html.includes('三栏'), false);
    assert.equal(WEB_PAGE.includes('id="crumbs"'), false, '观测面里不该已经有外壳的锚点');
  });
});

describe('色彩令牌与观测面同源', () => {
  test('表格行色条与阶段 chip 同源，且只用 --status-*', () => {
    const html = read('index.html');
    for (const tone of ['queued', 'running', 'done', 'failed', 'unconfirmed', 'cancelled']) {
      const rule = ruleBody(html, new RegExp(`\\.tasks tbody tr\\.row-${tone}\\s*\\{([^}]*)\\}`));
      assert.ok(rule.includes(`var(--status-${tone})`), `row-${tone} 该用 var(--status-${tone})`);
    }
    // 色条本身不写死色值：新摧一个 oklch 就是与观测面分叉一处。
    const bar = ruleBody(html, /\.tasks tbody tr td:first-child\s*\{([^}]*)\}/);
    assert.ok(bar.includes('var(--row-tone)'), `色条要走 --row-tone：${bar}`);
    assert.equal(/oklch\(|#[0-9a-fA-F]{3,6}/.test(bar), false, '色条不该写死颜色');
  });
  test(':root 两块是从 web.ts 逐字搬过来的', () => {
    const source = WEB_PAGE.replace(/\r\n/g, '\n');
    const from = source.indexOf(':root {');
    const to = source.indexOf('* {', from);
    const original = source.slice(from, to < 0 ? source.length : to).trim();
    assert.ok(original.length > 1000, '没从观测面里取到那两块令牌');
    // 整段比对，不挨个断言几个"代表值"：抽几个值测恰好放过剩下几十个被人
    // 顺手改一个的情况，而那种改动在界面上看不出名堂，只是颜色在漂。
    assert.ok(
      read('tokens.css').includes(original),
      'tokens.css 的 :root 与 :root[data-theme="dark"] 必须与 src/api/web.ts 逐字相同',
    );
  });

  test('关键 oklch 值与全部 status 令牌都在', () => {
    const tokens = read('tokens.css');
    // 亮暗两个 --background：少一个就说明某一边的整页配色是猜出来的。
    assert.match(tokens, /--background: oklch\(0\.991 0\.001 106\.423\)/);
    assert.match(tokens, /--background: oklch\(0\.201 0\.011 242\.328\)/);
    for (const name of [
      '--status-queued',
      '--status-running',
      '--status-done',
      '--status-failed',
      '--status-cancelled',
      '--status-unconfirmed',
    ]) {
      // 亮色 + 暗色各一次。只出现一次的那几个等于暗色主题下没有对应色。
      const count = tokens.split(name + ':').length - 1;
      assert.ok(count >= 2, `${name} 要在亮暗两块里都有`);
    }
  });

  test('chip 的配色公式与观测面 .badge 一致', () => {
    // 观测面用 color-mix 把 status 令牌调成 14% 底、35% 边。正式页换一个百分比
    // 不会报错，只会两个界面的同一个状态看着不是一种颜色。
    const chip = ruleBody(read('index.html'), /\.chip\s*\{([^}]*)\}/s);
    const badge = ruleBody(WEB_PAGE, /\.badge\s*\{([^}]*)\}/s);
    for (const pct of ['14', '35']) {
      const pattern = new RegExp(`color-mix\\(in oklch,[^;]*? ${pct}%, transparent\\)`);
      assert.ok(pattern.test(chip), `chip 少了 ${pct}% 那一路 color-mix`);
      assert.ok(pattern.test(badge), `观测面 .badge 的 ${pct}% 公式变了，chip 得跟着改`);
    }
  });
});

describe('项目页的文案表', () => {
  test('阶段中文来自 narrate.js，项目页里不再抄第二份', async () => {
    const page = read('projects.js');
    // 中文表只住在 narrate.js。再抄一份，加一个状态就会只改到一处，
    // 另一处的 chip 静悄悄退回默认灰。
    assert.match(page, /from '\.\/narrate\.js'/);
    assert.match(page, /STAGE_CN/);
    assert.equal(/STAGE_CN\s*=\s*\{/.test(page), false, 'projects.js 里又定义了一份 STAGE_CN');
    assert.equal(/WAIT_REASON\s*=\s*\{/.test(page), false, 'projects.js 里又定义了一份 WAIT_REASON');
    // 这三个是设计稿里的阶段名，内核里没有。照抄上去就是一个永远配不上的 chip。
    for (const fake of ['investigation', 'execution', 'technical_review']) {
      assert.equal(new RegExp(`\\b${fake}\\b`).test(page), false, `projects.js 不该出现 ${fake}`);
    }
    const { STAGE_CN } = await import('../src/web/narrate.js');
    for (const cn of ['调查中', '规划中', '执行中', '等你检视', '已完成', '已中止']) {
      assert.ok(Object.values(STAGE_CN).includes(cn), `缺阶段文案 ${cn}`);
    }
    const { stageChip } = await import('../src/web/projects.js');
    assert.ok(stageChip('executing').includes(STAGE_CN.executing));
  });

  test('停机原因来自 narrate.js；任务表七列齐', async () => {
    const page = read('projects.js');
    assert.match(page, /reasonText/, '只贴一个 enum 名字等于没贴');
    const reasons = [
      'no_available_agent', 'platform_unreachable', 'waiting_l3', 'escalated', 'project_busy',
      'attempt_limit_reached', 'target_changed', 'base_revision_stale', 'cancelled_by_user',
    ];
    for (const reason of reasons) {
      assert.equal(new RegExp(`${reason}:\\s*'`).test(page), false, `projects.js 里又抄了一份 ${reason}`);
    }
    const { WAIT_REASON } = await import('../src/web/narrate.js');
    for (const reason of reasons) assert.ok(reason in WAIT_REASON, `缺停机原因文案 ${reason}`);
    for (const column of ['任务 ID', '标题', '阶段', '状态', '原因', '最新更新时间', 'Token']) {
      assert.ok(page.includes(`'${column}'`), `任务表少一列：${column}`);
    }
    assert.match(page, /usageLine/, 'Token 列与任务页同一个 usageLine');
    // 左栏与详情卡要的字段。少一个的 symptom 是那一格永远空着，不报错。
    for (const field of ['projectId', 'mutating', 'projectRoot', 'branch', 'intent']) {
      assert.ok(page.includes(field), `projects.js 没读 ${field}`);
    }
    assert.match(page, /\/api\/projects/, '左栏数据来自 GET /api/projects');
    assert.match(page, /\/api\/missions/, '任务表数据来自 GET /api/missions');
  });

  test('项目页按策略轮询：可见挂定时器，隐藏与离页停', () => {
    const page = read('projects.js');
    assert.match(page, /updatedAt/, '任务表要读行上的 updatedAt，不能再写死占位');
    assert.match(page, /nextRefresh/);
    assert.match(page, /visibilitychange/);
    assert.match(page, /setInterval/);
    assert.match(page, /isConnected/);
  });

  test('插进 DOM 的字段走转义', () => {
    const page = read('projects.js');
    for (const ent of ['&amp;', '&lt;', '&gt;', '&quot;']) {
      assert.ok(page.includes(ent), `转义表里少了 ${ent}——那个字符会原样进 DOM`);
    }
    assert.match(page, /esc\(/, '字段得经过 esc 再拼进 innerHTML');
  });
});

/* ===== 把渲染函数当真跑一遍 =====
 * 这些是纯函数（喂数据 → 回 HTML），所以 node 里就能跑。
 * 不这么做的话，"字段名读错了"这类错没有任何东西接得住：界面照样渲染，
 * 只是那一列永远是 —。（web.test.ts 里那条「页面读的字段必须真的存在」
 * 就是为同一个坑补的，只不过那是观测面的。）
 */
describe('项目页的渲染函数喂真数据', () => {
  const loaded = import('../src/web/projects.js');

  test('阶段 chip：六种内核状态各自的中文与取色', async () => {
    const { taskTableHtml } = await loaded;
    const html = taskTableHtml([
      { missionId: 'M1', status: 'executing', usage: { total: 12 } },
      { missionId: 'M2', status: 'investigating' },
      { missionId: 'M3', status: 'planning' },
      { missionId: 'M4', status: 'awaiting_review' },
      { missionId: 'M5', status: 'completed' },
      { missionId: 'M6', status: 'blocked' },
    ]);
    const expect: Record<string, [string, string]> = {
      M1: ['执行中', 'running'],
      M2: ['调查中', 'queued'],
      M3: ['规划中', 'queued'],
      M4: ['等你检视', 'unconfirmed'],
      M5: ['已完成', 'done'],
      M6: ['已中止', 'failed'],
    };
    for (const [id, [cn, tone]] of Object.entries(expect)) {
      assert.ok(
        html.includes('<span class="chip ' + tone + '">' + cn + '</span>'),
        `${id} 的阶段 chip 应当是 ${tone} 色的「${cn}」`,
      );
    }
  });

  test('状态 chip 是第二根轴，终态词与阶段不撞，且优先级对', async () => {
    const { stateChip, stageChip } = await loaded;
    // 暂停 > 停机 > 终态 > 进行中。顺序弄反会把"人叫停了"显示成"进行中"。
    assert.match(stateChip({ paused: true, status: 'completed' }), /cancelled"[^>]*>已暂停/);
    assert.match(stateChip({ waitReason: 'project_busy' }), /unconfirmed"[^>]*>等待中/);
    assert.match(stateChip({ status: 'completed' }), /done"[^>]*>已结束/);
    assert.match(stateChip({ status: 'blocked' }), /failed"[^>]*>已停止/);
    assert.match(stateChip({ status: 'executing' }), /running"[^>]*>进行中/);
    // 完成品：阶段说「已完成」/「已中止」，状态说「已结束」/「已停止」。同一个
    // 词会让「卡住了」和「做完了」在两列里长得一模一样。
    assert.notEqual(stateChip({ status: 'completed' }), stageChip('completed'));
    assert.notEqual(stateChip({ status: 'blocked' }), stageChip('blocked'));
    // 等待中的行，停机原因必须跟得上（title）。
    assert.match(
      stateChip({ waitReason: 'project_busy' }),
      /title="同项目有别的 Mission 占着改动名额"/,
    );
  });

  test('原因栏：waitDetail 优先，没有才翻 enum，都没有是空串', async () => {
    const { reasonText } = await loaded;
    assert.equal(
      reasonText({ waitReason: 'project_busy', waitDetail: 'M-别的 占着名额' }),
      'M-别的 占着名额',
    );
    assert.equal(reasonText({ waitReason: 'no_available_agent' }), '候选全在冷却，等一会儿重跑');
    // 内核加了一个前端不认识的 reason：原样显示，不能显示成空白。
    assert.equal(reasonText({ waitReason: 'brand_new_reason' }), 'brand_new_reason');
    // 没停机就回空串，不是一个「—」：一个横杠什么信息都没有，还容易被当成
    // 「原因就是横杠」。空态由页面说清楚（见 taskTableHtml）。
    assert.equal(reasonText({}), '');
  });

  test('七列齐；空契约有文案；缺时间不谎称接口没有；Token 拆项；行有色条', async () => {
    const { taskTableHtml, TASK_COLUMNS } = await loaded;
    assert.deepEqual([...TASK_COLUMNS], [
      '任务 ID', '标题', '阶段', '状态', '原因', '最新更新时间', 'Token',
    ]);
    const html = taskTableHtml([{ missionId: 'M1', status: 'investigating' }]);
    for (const column of TASK_COLUMNS) {
      assert.ok(html.includes('<th>' + column + '</th>'), `表头缺 ${column}`);
    }
    assert.match(html, /（没有契约）/);
    // 行上缺 updatedAt 是这一行没读到，不是接口没这个字段。旧占位会把人
    // 指向错误的根因（去怪后端），所以这句话不能再上屏。
    assert.equal(html.includes('列表接口不提供时间戳'), false, `不能假称接口没有时间：${html}`);
    assert.ok(html.includes('还没读到更新时间'), `缺时间要解释这一行：${html}`);
    assert.equal(html.includes('<td class="muted">—</td>'), false, '不再用 — 当唯一内容');
    // 没停机也不留 —。
    assert.ok(html.includes('没有停机，正常推进'), html);
    // Token 拆成新增 + 缓存命中（口径与任务页同一个 usageLine）。
    assert.ok(html.includes('新增') && html.includes('缓存命中'), html);
    // 行左侧色条：tone 与阶段 chip 一致，取色留给 CSS 的 .row-* —— 
    // 测试守的是“行上有这个类”，具体色值在 index.html 里再断言。
    assert.match(html, /<tr class="row-queued" data-mission-id="M1">/);
    // usage 缺失当 0，而不是把 NaN / undefined 映上屏。
    assert.equal(/NaN|undefined|null/.test(html), false, '上屏了 NaN/undefined 这种字串');
  });

  test('任务表按 updatedAt 降序，列上本地 MM-DD HH:mm，title 是完整时刻', async () => {
    const { taskTableHtml } = await loaded;
    const rows = [
      { missionId: 'old', status: 'executing', updatedAt: '2026-01-01T00:00:00.000Z' },
      { missionId: 'new', status: 'executing', updatedAt: '2026-09-29T08:11:00.000Z' },
      { missionId: 'mid', status: 'executing', updatedAt: '2026-03-15T12:30:00.000Z' },
      { missionId: 'none', status: 'executing' },
    ];
    const html = taskTableHtml(rows);
    const pos = (id: string) => {
      const i = html.indexOf('data-mission-id="' + id + '"');
      assert.ok(i >= 0, `缺行 ${id}`);
      return i;
    };
    assert.ok(pos('new') < pos('mid') && pos('mid') < pos('old') && pos('old') < pos('none'), html);
    // 入参数组不能被原地排序：调用方还拿着同一份列表做别的事。
    assert.equal(rows[0]?.missionId, 'old');
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = (iso: string) => {
      const d = new Date(iso);
      return {
        short: pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()),
        full: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
          + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()),
      };
    };
    const shown = local('2026-09-29T08:11:00.000Z');
    assert.ok(html.includes('>' + shown.short + '<'), `列上应是 ${shown.short}：${html}`);
    assert.ok(html.includes('title="' + shown.full + '"'), `title 应是 ${shown.full}：${html}`);
    assert.equal(html.includes('列表接口不提供时间戳'), false);
  });

  test('不守规矩的字段进不了 DOM', async () => {
    const { taskTableHtml, projectListHtml, detailCardHtml, esc } = await loaded;
    const evil = '<img src=x onerror="alert(1)">';
    const table = taskTableHtml([{ missionId: evil, status: 'executing', intent: evil }]);
    assert.equal(table.includes('<img'), false, 'intent/missionId 没转义就被当标签解析了');
    assert.ok(table.includes('&lt;img'), '转义后的形式应当出现在表格里');
    const list = projectListHtml([{ projectId: evil, missions: 1 }], evil);
    assert.equal(list.includes('<img'), false, 'projectId 没转义');
    assert.match(list, /data-active="1"/, '选中的项目要看得出');
    const card = detailCardHtml({ projectId: 'P', mutating: true }, {});
    assert.ok(card.includes('1/1'), 'mutating 有值要显示 1/1');
    assert.ok(card.includes('还没读到'), '拿不到仓库与分支时要解释，不是孤零零一个 —');
    assert.equal(esc('a&b<c>d"e'), 'a&amp;b&lt;c&gt;d&quot;e');
  });

  test('详情卡：没占用名额时是 0/1', async () => {
    const { detailCardHtml } = await loaded;
    const card = detailCardHtml({ projectId: 'P' }, { projectRoot: '/repo', branch: 'main' });
    assert.ok(card.includes('0/1'));
    assert.ok(card.includes('/repo') && card.includes('main'), '仓库与分支得从 workspaceRef 显示出来');
  });

  test('项目页刷新策略：可见每 5 秒拉两个列表，隐藏与离页都不拉', async () => {
    const { nextRefresh } = await loaded;
    const on = nextRefresh('projects', 'executing', true);
    assert.deepEqual(on.paths, ['/api/projects', '/api/missions']);
    assert.equal(on.intervalMs, 5000);
    assert.equal(on.liveIntervalMs, null);
    // 项目页不按某一条任务的状态停：两个列表都要刷。
    assert.deepEqual(nextRefresh('projects', 'completed', true), on);
    const hidden = nextRefresh('projects', 'executing', false);
    assert.deepEqual(hidden.paths, []);
    assert.equal(hidden.intervalMs, null);
    assert.equal(hidden.liveIntervalMs, null);
    // 隐藏→可见：paths 再次有值，调用方据此立刻补拉，再按 intervalMs 续上。
    const resumed = nextRefresh('projects', '', true);
    assert.deepEqual(resumed.paths, on.paths);
    assert.equal(resumed.intervalMs, 5000);
    assert.deepEqual(nextRefresh('pool', '', true).paths, []);
  });

  test('任务页刷新策略：未终态可见拉 view/activity/live，终态与隐藏停', async () => {
    const { nextRefresh } = await loaded;
    const live = nextRefresh('mission', 'executing', true);
    assert.deepEqual(live.paths, ['view', 'activity', 'live']);
    assert.equal(live.intervalMs, 3000);
    assert.equal(live.liveIntervalMs, 1000);
    // 状态还不知道不当终态，否则首屏读失败就再也不会重试。
    assert.deepEqual(nextRefresh('mission', '', true), live);
    assert.deepEqual(nextRefresh('mission', 'investigating', true), live);
    for (const status of ['completed', 'blocked']) {
      const done = nextRefresh('mission', status, true);
      assert.deepEqual(done.paths, [], status);
      assert.equal(done.intervalMs, null, status);
      assert.equal(done.liveIntervalMs, null, status);
    }
    const hidden = nextRefresh('mission', 'executing', false);
    assert.deepEqual(hidden.paths, []);
    assert.equal(hidden.intervalMs, null);
    assert.equal(hidden.liveIntervalMs, null);
    // 隐藏→可见：paths 再次有值，调用方立刻补拉。
    const resumed = nextRefresh('mission', 'awaiting_review', true);
    assert.deepEqual(resumed.paths, live.paths);
    assert.equal(resumed.intervalMs, 3000);
    assert.equal(resumed.liveIntervalMs, 1000);
  });
});

describe('GET / 是正式页，不是内置观测面', () => {
  test('根路径吐 src/web/index.html', async () => {
    const { base } = await serveDefaultWebRoot();
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /CoAgentHub/);
    assert.ok(html.includes('app.js') || html.includes('tokens.css'), '没引到外壳资源');
    // 「连接中…」是观测面顶栏那句。它还在这儿就说明静态层没接上：
    // 人以为自己看的是新页面，其实看的是回退页。
    assert.equal(html.includes('连接中…'), false, 'GET / 回退到了内置观测面');
  });

  test('三个资源都能按扁平路径取到', async () => {
    const { base } = await serveDefaultWebRoot();
    for (const path of ['/index.html', '/app.js', '/tokens.css', '/projects.js', '/plan-run.js', '/platform.js']) {
      const res = await fetch(base + path);
      assert.equal(
        res.status,
        200,
        `${path} 取不到：名字不满足 SAFE_NAME（大写/多级目录/扩展名），或文件没写出来`,
      );
    }
  });

  test('静态层没把 API 吃掉', async () => {
    const { base } = await serveDefaultWebRoot();
    const res = await fetch(`${base}/api/version`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { api: string }).api, 'v1');
  });
});

/**
/**
 * 把真读模型的 JSON 喂给真渲染函数。
 *
 * 这一类错在页面上是**没有声音的**：后端把 workspaceRef 改名了，详情卡只是
 * 多一个 —，页面照样跑。所以这里拿真的平台建一条真 Mission、真派发一次，
 * 再把真 JSON 灌进真渲染函数，对出该出现的字。
 * （web.test.ts 里「页面读的字段必须真的存在」给观测面补的是同一个坑。）
 */
describe('真读模型喂真渲染函数', () => {
  test('项目行、任务行、workspaceRef 的字段名两边得一致', async () => {
    const { platform, base } = await serveDefaultWebRoot();
    const contract = { intent: '修 X', acceptance: [], constraints: [], nonGoals: [], guardrails: [] };
    await platform.createMission({ projectId: 'proj-a', missionId: 'M-1', contract });
    await platform.createMission({
      projectId: 'proj-a',
      missionId: 'M-2',
      contract: { ...contract, intent: '' },
    });
    // 真派发一次：改动名额是内核那条不变量，mutating 这个键只有真占上了才出现。
    const coord = await platform.startCoordinatorAttempt('M-1');
    await platform.updatePlan('M-1', coord.attemptId, {
      findings: 'f',
      rejectedHypotheses: [],
      decisions: [],
      direction: 'd',
      risks: [],
    });
    const { workItemId } = await platform.createWorkItem('M-1', coord.attemptId, {
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
    await platform.dispatchWorkItems('M-1', coord.attemptId, [workItemId]);
    await platform.recordWorkspace('M-1', {
      projectRoot: '/repo/a',
      branch: 'coagent/M-1',
      baseRevision: 'abc',
    });
    await platform.setWaitReason('M-2', 'no_available_agent');

    const projects = (await (await fetch(`${base}/api/projects`)).json()) as Record<
      string,
      unknown
    >[];
    const missions = (await (await fetch(`${base}/api/missions`)).json()) as Record<
      string,
      unknown
    >[];
    const view = (await (await fetch(`${base}/api/missions/M-1`)).json()) as {
      workspaceRef?: { projectRoot?: string; branch?: string };
    };

    assert.deepEqual(Object.keys(projects[0]).sort(), ['missions', 'mutating', 'projectId', 'usage']);
    assert.equal(projects[0].mutating, 'M-1', '占着名额的那条要报出来，详情卡据此画 1/1');
    for (const field of ['missionId', 'projectId', 'status', 'intent', 'paused', 'usage']) {
      assert.ok(field in missions[0]!, `任务行读 missions.${field}，读模型没给`);
    }
    const stalled = missions.find((m) => m.missionId === 'M-2');
    assert.equal(stalled?.waitReason, 'no_available_agent', '停机原因是第二根轴，必须传出来');
    assert.equal(view.workspaceRef?.projectRoot, '/repo/a', '详情卡读 workspaceRef.projectRoot');
    assert.equal(view.workspaceRef?.branch, 'coagent/M-1', '详情卡读 workspaceRef.branch');

    const { projectListHtml, detailCardHtml, taskTableHtml } = await import(
      '../src/web/projects.js'
    );
    const list = projectListHtml(projects, 'proj-a');
    const card = detailCardHtml(projects[0]!, view.workspaceRef ?? {});
    const table = taskTableHtml(missions.filter((m) => m.projectId === 'proj-a'));

    assert.ok(list.includes('proj-a') && list.includes('2 个任务'), '左栏要点出项目与任务数');
    assert.ok(card.includes('/repo/a') && card.includes('coagent/M-1'), '仓库与分支要显示出来');
    assert.ok(card.includes('1/1'), '占了名额就该是 1/1');
    assert.ok(table.includes('修 X') && table.includes('（没有契约）'));
    assert.ok(table.includes('执行中'), '派发后阶段该是执行中');
    assert.ok(table.includes('候选全在冷却，等一会儿重跑'), 'waitReason 要翻成人话');
    assert.equal(
      [list, card, table].some((x) => /undefined|NaN/.test(x) || x.includes('[object Object]')),
      false,
      '把 undefined/NaN 映上屏了：字段名两边不一致，而这里不报错',
    );
  });
  test('没有 Mission 的项目：名额 0/1，mutating 键干脆不存在', async () => {
    const { platform, base } = await serveDefaultWebRoot();
    const created = await platform.createMission({
      projectId: 'proj-empty',
      missionId: 'M-only',
      contract: { intent: 'x', acceptance: [], constraints: [], nonGoals: [], guardrails: [] },
    });
    assert.ok(created);
    await platform.cancelMission('M-only', '清场');
    const projects = (await (await fetch(`${base}/api/projects`)).json()) as Record<
      string,
      unknown
    >[];
    // mutating 是可选键：没占用时 JSON 里根本没有它（和 waitReason 同理）。
    assert.equal('mutating' in projects[0]!, false, '没占名额时后端不该塞一个 null 进来');
    const { detailCardHtml } = await import('../src/web/projects.js');
    assert.ok(detailCardHtml(projects[0]!, {}).includes('0/1'), '读不到 mutating 就是 0/1');
    assert.ok(detailCardHtml(projects[0]!, {}).includes('还没读到'), '拿不到 workspaceRef 时要解释为什么');
  });
});