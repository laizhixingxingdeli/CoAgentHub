#!/usr/bin/env node
/**
 * web-shot：用无界面浏览器打开 src/web 的 hash 路由，按视口截一张 PNG。
 *
 * 用法：
 *   node scripts/web-shot.mjs <路由> --name <名字> [--size 1440x1240]
 *       [--click <css>]… [--measure <css>]… [--compare <画板节点>]
 *       [--pair <Figma节点>=<css>]… [--tol 2] [--api <url>] [--chrome <路径>]
 *
 * 路由写成 missions/<id>、pool、projects，不带开头 # 与 /：脚本自己补 `#/`。
 * 截图落在 .coagent-artifacts/shots/<名字>.png，同名覆盖，只留最近 10 组。
 *
 * 三条坑，改这个文件之前先看一眼：
 *
 * 1. **Git Bash 会把 `/#/missions/x` 改写成 Windows 路径**（MSYS 的路径转换把
 *    `/#` 当成绝对路径前缀），于是浏览器打开的是 `C:/Program Files/Git/...`。
 *    所以路由一律不带开头 # 与 /，并且脚本对这两种写法直接报错退出——静默
 *    打开一张空白页比报错难查得多。
 * 2. **绝不连 9222，也不用默认用户配置。** 9222 常被人工调试的浏览器占着，连上去
 *    截的就是别人那个窗口，还可能顺手点掉人家正在看的东西。默认用户目录同理：
 *    会读到真实登录态，两次运行还互相打架。这里固定 `--remote-debugging-port=0`
 *    并从 `DevToolsActivePort` 读实际端口，user-data-dir 用进程 pid 独立目录。
 * 3. **不要调用 `chrome --version` 之类「只是问一下」的命令。** 无 `--headless`
 *    参数时它会在桌面弹一个真窗口，CI / 无人值守下会留下一个没人关的进程，
 *    而命令本身还会返回 0，看起来一切正常。判断浏览器可用性只看 existsSync。
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';

import { serveStatic } from '../src/api/static.ts';
import { isDirectEntry } from '../src/direct-entry.ts';

import { compareBoard } from './web-shot-compare.mjs';

// 画板比对是纯函数，单独放一个文件：扫描 XML 的逻辑塞回这个脚本里，会让本来就长的
// 浏览器流程再翻一圈，测试也没法不启动浏览器直接跑。这里只做接线。
export { compareBoard } from './web-shot-compare.mjs';

const ARTIFACTS = '.coagent-artifacts';
const DEFAULT_API = 'http://127.0.0.1:3101';
const DEFAULT_SIZE = { width: 1440, height: 1240 };
const PAGE_DEADLINE_MS = 20000;
const QUIET_MS = 700;
const MAX_SHOT_GROUPS = 10;

/**
 * 测试里起的小服务。返回的 server 没有 listen，端口由调用方决定：
 * 固定端口会让并行跑的两条用例撞车。
 */
export function createShotServer({ root, apiBase } = {}) {
  const staticRoot = root ?? join(process.cwd(), 'src', 'web');
  const upstreamBase = String(apiBase ?? DEFAULT_API).replace(/\/+$/, '');

  return createServer((req, res) => {
    // 用占位 base 解析，只为拿到 pathname：query 交给 serveStatic 会被当成文件名。
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const { pathname } = url;

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      proxyApi({ req, res, upstreamBase, pathname, search: url.search });
      return;
    }

    if (serveStatic(pathname, res, staticRoot)) return;
    res.writeHead(404);
    res.end();
  });
}

/**
 * 只放行 GET：页面里的写操作走的是真后端的语义，这里转发过去等于替人改了数据，
 * 而截图任务本来就不该有副作用。非 GET 直接 405，连 fetch 都不发。
 */
function proxyApi({ req, res, upstreamBase, pathname, search }) {
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end();
    return;
  }

  const target = `${upstreamBase}${pathname}${search}`;
  fetch(target)
    .then(async (upstream) => {
      const body = Buffer.from(await upstream.arrayBuffer());
      const headers = {};
      const contentType = upstream.headers.get('content-type');
      // 只搬 content-type：上游的连接类头（transfer-encoding 等）搬过来会让本服务
      // 写出非法响应。
      if (contentType) headers['content-type'] = contentType;
      res.writeHead(upstream.status, headers);
      res.end(body);
    })
    .catch(() => {
      // 上游没起（3101 没人在听是常态）时给 502，不要假装 200 空正文：
      // 空正文会让截图里的面板空着，看的人以为是页面坏了。
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(502);
      res.end();
    });
}

/** 解析命令行。所有校验都在这里做完，这样报错时浏览器还没被启动。 */
export function parseArgs(argv) {
  const opts = {
    route: undefined,
    name: undefined,
    size: { ...DEFAULT_SIZE },
    clicks: [],
    measures: [],
    compare: undefined,
    pairs: [],
    tol: 2,
    api: DEFAULT_API,
    chrome: undefined,
  };

  const needsValue = (flag, value) => {
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 需要一个值`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (opts.route !== undefined) throw new Error(`多了个参数 ${arg}：第一个非旗标已经当作路由了`);
      opts.route = checkRoute(arg);
      continue;
    }
    switch (arg) {
      case '--name':
        opts.name = needsValue(arg, argv[++i]);
        break;
      case '--size':
        opts.size = parseSize(needsValue(arg, argv[++i]));
        break;
      case '--click':
        opts.clicks.push(needsValue(arg, argv[++i]));
        break;
      case '--measure':
        opts.measures.push(needsValue(arg, argv[++i]));
        break;
      case '--compare':
        opts.compare = needsValue(arg, argv[++i]);
        break;
      case '--pair':
        opts.pairs.push(parsePair(needsValue(arg, argv[++i])));
        break;
      case '--tol':
        opts.tol = parseTol(needsValue(arg, argv[++i]));
        break;
      case '--api':
        opts.api = needsValue(arg, argv[++i]);
        break;
      case '--chrome':
        opts.chrome = needsValue(arg, argv[++i]);
        break;
      default:
        throw new Error(`未知旗标 ${arg}`);
    }
  }

  if (opts.route === undefined) {
    throw new Error('缺少路由。写成 missions/<id>、pool、projects，脚本自己补 #/');
  }
  if (!opts.name) throw new Error('缺少 --name：截图文件名要靠它');
  return opts;
}

/**
 * 拒绝三种写法：#/… 、/… 、盘符路径。前两种是 Git Bash 改写与手滑的产物，
 * 第三种说明命令被 shell 展开过；照单全收只会打开一张空白页。
 */
function checkRoute(route) {
  const hint = '写成 missions/<id>、pool、projects，脚本自己补 #/；Git Bash 会改写 /…';
  if (route === '' || /^[#\\/]/.test(route) || /[A-Za-z]:[\\/]/.test(route)) {
    throw new Error(`路由 ${route} 不对：${hint}`);
  }
  return route;
}

function parseSize(value) {
  const hit = /^(\d+)x(\d+)$/.exec(value);
  if (!hit) throw new Error(`--size 要写成 1440x1240 这样，收到的是 ${value}`);
  const width = Number(hit[1]);
  const height = Number(hit[2]);
  if (width <= 0 || height <= 0) throw new Error(`--size 的宽高必须是正数，收到的是 ${value}`);
  return { width, height };
}

/** 只按第一个 = 切：CSS 选择器里带 = （属性选择器）是常见写法。 */
function parsePair(value) {
  const at = value.indexOf('=');
  if (at <= 0 || at === value.length - 1) {
    throw new Error(`--pair 要写成 <Figma节点>=<css>，收到的是 ${value}`);
  }
  return { figma: value.slice(0, at), selector: value.slice(at + 1) };
}

function parseTol(value) {
  const tol = Number(value);
  if (!Number.isFinite(tol) || tol < 0) throw new Error(`--tol 要写成数字，收到的是 ${value}`);
  return tol;
}

/** 找浏览器可执行文件。有 --chrome 就只认它，不存在的路径不回退。 */
function findChrome(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : undefined;

  const env = process.env;
  const candidates = [];
  // 顺序：先 Chrome 后 Edge，先 ProgramFiles 再 x86 再 LOCALAPPDATA。
  for (const base of [env['ProgramFiles'], env['ProgramFiles(x86)'], env['LOCALAPPDATA']]) {
    if (!base) continue;
    candidates.push(
      join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  }
  candidates.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  );
  return candidates.find((path) => existsSync(path));
}

function spawnBrowser(chromePath, userDataDir) {
  // 不用 shell：路径里有空格（Program Files）时 shell 会把它拆成两个参数。
  // --remote-allow-origins=* 不带的话 Chrome 会拒绝 Node 的 WebSocket 握手。
  return spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
}

async function waitForDevToolsPort(userDataDir) {
  const file = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length >= 2) {
        // 9222 是人工调试常用的那个口，连过去截的是别人的窗口。
        if (lines[0] === '9222') throw new Error('调试端口是 9222，拒绝连接');
        return { port: lines[0], path: lines[1] };
      }
    }
    await sleep(100);
  }
  throw new Error('浏览器 10 秒内没写出 DevToolsActivePort');
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** 最小 CDP 客户端。拿 Node 24 的全局 WebSocket，不引第三方库。 */
function openCdp(wsUrl) {
  return new Promise((done, fail) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = new Set();
    let nextId = 0;

    const send = (method, params = {}, sessionId) =>
      new Promise((ok, no) => {
        const id = ++nextId;
        pending.set(id, { ok, no });
        const message = { id, method, params };
        if (sessionId) message.sessionId = sessionId;
        ws.send(JSON.stringify(message));
      });

    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (typeof message.id === 'number' && pending.has(message.id)) {
        const slot = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) slot.no(new Error(message.error.message ?? 'CDP 调用失败'));
        else slot.ok(message.result ?? {});
        return;
      }
      for (const listener of listeners) listener(message);
    });
    ws.addEventListener('error', () => fail(new Error('连不上浏览器的调试端口')));
    ws.addEventListener('open', () => done({ ws, send, on: (fn) => listeners.add(fn) }));
  });
}

/**
 * 一次导航后的「静默」等待：readyState 到 complete、在途请求清零并保持约 0.7 秒、
 * 字体就位。只看 readyState 不够——页面是先渲染壳再用 fetch 填内容的，
 * complete 的时候骨架屏才刚画上。
 */
async function waitForQuiet(cdp, deadline, label) {
  for (;;) {
    assertWithinDeadline(deadline, label);
    const readyState = await cdp.evaluate('document.readyState');
    if (readyState === 'complete' && cdp.state.inflight.size === 0) {
      await sleep(QUIET_MS);
      // 这 0.7 秒里可能又冒出请求（轮询、懒加载），宁可再等一轮。
      if (cdp.state.inflight.size === 0) {
        assertWithinDeadline(deadline, label);
        return;
      }
      continue;
    }
    await sleep(100);
  }
}

function assertWithinDeadline(deadline, label) {
  if (Date.now() > deadline) throw new Error(`页面 20 秒内没加载完（${label}）`);
}

/**
 * 等字体就位，但和导航共用同一个 deadline。裸 await document.fonts.ready 时，
 * 字体请求挂住（上游断了、字体文件 404 后浏览器重试）会让脚本无限等下去，
 * 「总上限 20 秒」就形同虚设——那是这张卡最想堵的洞。
 */
async function waitForFonts(evaluate, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('页面 20 秒内没加载完（字体）');

  const fontsDone = evaluate('document.fonts.ready.then(() => true)');
  // 超时先返回时这条还在飞；它之后失败若不接住，会变成未处理拒绝把进程带崩。
  fontsDone.catch(() => {});

  let timer;
  const timedOut = new Promise((done) => {
    timer = setTimeout(() => done('timeout'), remaining);
  });
  try {
    if ((await Promise.race([fontsDone, timedOut])) === 'timeout') {
      throw new Error('页面 20 秒内没加载完（字体）');
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 记账：在途请求、失败的 /api 请求、页面异常。 */
function trackNetwork(cdp, sessionId) {
  cdp.on((message) => {
    if (message.sessionId && message.sessionId !== sessionId) return;
    const { method, params } = message;
    if (method === 'Network.requestWillBeSent') {
      cdp.state.inflight.set(params.requestId, params.request.url);
      return;
    }
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const url = cdp.state.inflight.get(params.requestId) ?? '';
      if (method === 'Network.loadingFailed' && url.includes('/api/')) cdp.state.failedApi += 1;
      cdp.state.inflight.delete(params.requestId);
      return;
    }
    if (method === 'Network.responseReceived') {
      const { response } = params;
      if (response?.status >= 400 && String(response.url).includes('/api/')) cdp.state.failedApi += 1;
      return;
    }
    if (method === 'Runtime.exceptionThrown') cdp.state.pageErrors += 1;
  });
}

/**
 * 按顺序点 --click 的元素。找不到就失败：静默跳过会截出一张「忘了展开」的图，
 * 而看截图的人无从判断该不该展开。
 */
async function clickAll(cdp, selectors, deadline) {
  for (const selector of selectors) {
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`;
    const clicked = await cdp.evaluate(expression);
    if (!clicked) throw new Error(`找不到要点击的元素：${selector}`);
    await waitForQuiet(cdp, deadline, `点击 ${selector} 之后`);
  }
}

/** 量哪些选择器：--measure 在前，--pair 的 selector 补在后面，按出现顺序去重。 */
function measureSelectors(opts) {
  const wanted = [];
  for (const selector of [...opts.measures, ...opts.pairs.map((pair) => pair.selector)]) {
    if (!wanted.includes(selector)) wanted.push(selector);
  }
  return wanted;
}

/** 契约点名的九个计算样式，键名保持带连字符的原样。 */
const MEASURE_STYLE_PROPS = [
  'font-size',
  'line-height',
  'font-weight',
  'color',
  'background-color',
  'padding',
  'gap',
  'border-radius',
  'border-width',
];

/**
 * 在页面里量全部匹配元素。用 querySelectorAll 而不是 querySelector：一个选择器
 * 命中多个元素是常态（列表项），只量第一个会悄悄漏掉「第 3 行折了」这类问题。
 * 选择器与属性名都过 JSON.stringify，引号、= 、反斜杠原样进脚本，不会被拆开。
 */
async function measureAll(evaluate, selectors) {
  const expression = `(() => {
    const props = ${JSON.stringify(MEASURE_STYLE_PROPS)};
    const out = {};
    for (const selector of ${JSON.stringify(selectors)}) {
      out[selector] = [...document.querySelectorAll(selector)].map((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const box = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        };
        for (const prop of props) box[prop] = style.getPropertyValue(prop);
        return box;
      });
    }
    return out;
  })()`;
  return evaluate(expression);
}

/**
 * 拿设计稿比对。layout.xml 只在这里读：compareBoard 是纯函数，读文件留在调用方，
 * 测试才能内联一小段 XML 直接跑。文件不在就抛（交给 main 的 catch：退出码非 0）。
 */
function compareWithBoard(opts, measures) {
  const xml = readFileSync(join(process.cwd(), '.impeccable', 'reference', 'layout.xml'), 'utf8');
  const measured = {};
  for (const pair of opts.pairs) {
    const hits = measures[pair.selector];
    // 比对只看第一个匹配元素：--pair 的语义是「这个节点的框」，多个命中说不清是哪个。
    measured[pair.selector] = Array.isArray(hits) ? (hits[0] ?? null) : null;
  }
  return compareBoard({ xml, boardNode: opts.compare, pairs: opts.pairs, measured, tol: opts.tol });
}

/** 只留最近 10 组截图。png 与同名 json 算一组，按组内最新 mtime 排序。 */
function pruneShots(dir, keep = MAX_SHOT_GROUPS) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const groups = new Map();
  for (const name of names) {
    const dot = name.lastIndexOf('.');
    const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
    if (ext !== 'png' && ext !== 'json') continue;
    let mtimeMs;
    try {
      mtimeMs = statSync(join(dir, name)).mtimeMs;
    } catch {
      continue;
    }
    const key = name.slice(0, dot);
    const group = groups.get(key) ?? { mtimeMs: 0, names: [] };
    group.names.push(name);
    group.mtimeMs = Math.max(group.mtimeMs, mtimeMs);
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of ordered.slice(keep)) {
    for (const name of stale.names) {
      try {
        rmSync(join(dir, name), { force: true });
      } catch {
        // 被占用（有人正开着这张图）就算了，下次再删。
      }
    }
  }
}

/** 启动时清掉超过 1 小时的旧 profile：它们只会在磁盘上越攒越多。 */
function pruneOldChromeDirs(dir, maxAgeMs = 3600000) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    if (!name.startsWith('chrome-')) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs > cutoff) continue;
    } catch {
      continue;
    }
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // 仍被占用，跳过。
    }
  }
}

/**
 * 杀进程树。只 child.kill() 不够：Chrome 会拉起一串子进程（renderer、gpu…），
 * 父进程没了它们还占着 user-data-dir，下一次启动就会因为 profile 锁起不来。
 */
async function stopBrowser(child, userDataDir) {
  const pid = child.pid;
  if (typeof pid === 'number') {
    if (process.platform === 'win32') {
      await new Promise((done) => {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => done());
        killer.on('close', () => done());
      });
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已经退出了。
      }
    }
  }
  // taskkill 刚返回时句柄可能还没完全放开，重试两次再放弃。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(150);
    }
  }
}

function listenOn(server) {
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => done(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((done) => {
    server.close(() => done());
    server.closeAllConnections?.();
  });
}

/** 导航 + 等待 + 点击 + 截图。返回本次运行的计数与耗时。 */
async function drive({ cdp, pagePort, opts, shotsDir }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attach = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attach.sessionId;
  const session = { ...cdp, sessionId };
  const call = (method, params = {}) => cdp.send(method, params, sessionId);
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? '页面脚本抛错');
    return result.result?.value;
  };
  const wrapped = { ...session, evaluate, state: cdp.state };
  trackNetwork(cdp, sessionId);

  await call('Emulation.setDeviceMetricsOverride', {
    width: opts.size.width,
    height: opts.size.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call('Page.enable');
  await call('Network.enable');
  await call('Runtime.enable');

  const startedAt = Date.now();
  const deadline = startedAt + PAGE_DEADLINE_MS;
  // 路由原样拼接：中间的 / 不能编码掉，页面的解析器按真斜杠分段。
  const url = `http://127.0.0.1:${pagePort}/#/${opts.route}`;
  await call('Page.navigate', { url });

  await waitForQuiet(wrapped, deadline, '首次加载');
  await waitForFonts(evaluate, deadline);
  await clickAll(wrapped, opts.clicks, deadline);

  // 量在截图之前：点开的面板还没画上去就量，拿到的是空框或旧位置。
  const selectors = measureSelectors(opts);
  const measures = selectors.length > 0 ? await measureAll(evaluate, selectors) : {};

  const shot = await call('Page.captureScreenshot', { format: 'png' });
  mkdirSync(shotsDir, { recursive: true });
  const png = join(shotsDir, `${opts.name}.png`);
  // 同名覆盖：跑第二遍要看到的是新图，不是上一轮留下的。
  writeFileSync(png, Buffer.from(shot.data, 'base64'));

  // 没 --compare 时 compare 字段留 null，也不读 layout.xml。
  const compare = opts.compare ? compareWithBoard(opts, measures) : null;
  let json;
  // 工单的条件是「measures 非空或有 --compare」：纯截图时 measures 是空对象，不落 json；
  // 有 --pair 的时候 measures 里已经有那些框（不管 --compare 写没写），就该落盘。
  if (Object.keys(measures).length > 0 || compare) {
    json = join(shotsDir, `${opts.name}.json`);
    const payload = {
      viewport: { width: opts.size.width, height: opts.size.height },
      measures,
      compare: compare
        ? { board: opts.compare, tol: opts.tol, over: compare.over, missing: compare.missing, rows: compare.rows }
        : null,
    };
    writeFileSync(json, `${JSON.stringify(payload, null, 2)}\n`);
  }
  // 只在产物都落地之后 prune 一次：先 prune 会把上一轮的 json 连同新图一起当旧的删掉。
  pruneShots(shotsDir);

  return {
    png,
    json,
    compareLines: compare ? compare.lines : [],
    seconds: ((Date.now() - startedAt) / 1000).toFixed(1),
    pageErrors: cdp.state.pageErrors,
    failedApi: cdp.state.failedApi,
  };
}

async function main(argv) {
  const opts = parseArgs(argv);
  const artifactsRoot = resolve(process.cwd(), ARTIFACTS);
  pruneOldChromeDirs(artifactsRoot);

  const chrome = findChrome(opts.chrome);
  if (!chrome) throw new Error('找不到浏览器：Chrome / Edge 都不在常见位置，可用 --chrome 指定');

  const userDataDir = join(artifactsRoot, `chrome-${process.pid}`);
  const server = createShotServer({});
  let child;
  let cdp;
  let summary;
  try {
    const pagePort = await listenOn(server);
    child = spawnBrowser(chrome, userDataDir);
    const { port, path } = await waitForDevToolsPort(userDataDir);
    cdp = await openCdp(`ws://127.0.0.1:${port}${path}`);
    cdp.state = { inflight: new Map(), failedApi: 0, pageErrors: 0 };

    const result = await drive({ cdp, pagePort, opts, shotsDir: join(artifactsRoot, 'shots') });
    // 比对逐行打在摘要之前：超差是这一趟最想看的东西，压在摘要底下会被漏掉。
    for (const line of result.compareLines) console.log(line);
    summary = [
      `截图 ${result.png}`,
      ...(result.json ? [`json ${result.json}`] : []),
      `视口 ${opts.size.width}x${opts.size.height}`,
      `耗时 ${result.seconds}s`,
      `页面异常 ${result.pageErrors}`,
      `失败的 /api 请求 ${result.failedApi}`,
      // 有超差也不改退出码：截图任务的成功与否只看「页面打开、图写出来了」。
      '浏览器已退出',
    ].join(' ');
  } finally {
    cdp?.ws.close();
    if (child) await stopBrowser(child, userDataDir);
    await closeServer(server);
  }
  // 清理完成之后才打印：这一行是对结果的承诺，不能提前说。
  if (summary) console.log(summary);
}

if (isDirectEntry(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    // 只打 message：栈对用的人是噪音，对改的人是这个文件本身。
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
