/**
 * 任务页刷新接线（src/web/task.js 的 DOM / fetch / 定时器）。
 *
 * 纯策略 nextRefresh 已在 web-shell.test.ts 里钉死，这里不复制。
 * 本文件用假 document / fetch / setInterval 跑真的 renderTaskPage，
 * 断言实际打出的 URL、间隔、可见性/终态/离页，以及有无重画。
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { renderTaskPage } from '../src/web/task.js';

type Timer = { fn: () => void; ms: number };

let realSetInterval: typeof setInterval;
let realClearInterval: typeof clearInterval;
let realFetch: typeof fetch;
let realDocument: unknown;

let intervals: Map<number, Timer>;
let nextTimerId: number;
let requests: { url: string }[];
let visibilityState: string;
let visListeners: Array<() => void>;
let idMap: Map<string, FakeEl>;
let viewById: Map<string, Record<string, unknown>>;
let activityById: Map<string, unknown[]>;
let liveById: Map<string, { cursor: number; chunks: unknown[] }>;
let attemptById: Map<string, unknown>;
let fetchGate: Promise<void> | null;
let unlockGate: (() => void) | null;
let failNextView: boolean;

class FakeEl {
  tagName: string;
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  attrs: Record<string, string> = Object.create(null);
  dataset: Record<string, string> = Object.create(null);
  className = '';
  href = '';
  open = false;
  scrollTop = 0;
  clientHeight = 100;
  scrollHeight = 100;
  checked = false;
  _html = '';
  _text = '';
  _id = '';
  _connected = false;
  _listeners: Record<string, Array<(ev: { target: FakeEl }) => void>> = Object.create(null);

  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
  }

  get id() {
    return this._id;
  }
  set id(v: string) {
    this._id = v;
    if (v) idMap.set(v, this);
  }

  get innerHTML() {
    return this._html;
  }
  set innerHTML(v: string) {
    for (const c of this.children) c.parentNode = null;
    this._html = String(v);
    this.children = parseHtml(this._html, this);
  }

  get textContent() {
    return this._text;
  }
  set textContent(v: string) {
    this._text = String(v);
  }

  get isConnected() {
    let n: FakeEl | null = this;
    while (n.parentNode) n = n.parentNode;
    return n._connected === true;
  }

  querySelector(sel: string): FakeEl | null {
    const all = this.querySelectorAll(sel);
    return all[0] ?? null;
  }

  querySelectorAll(sel: string): FakeEl[] {
    const out: FakeEl[] = [];
    walk(this, (el) => {
      if (el !== this && matches(el, sel)) out.push(el);
    });
    return out;
  }

  addEventListener(type: string, fn: (ev: { target: FakeEl }) => void) {
    (this._listeners[type] ||= []).push(fn);
  }

  closest(sel: string): FakeEl | null {
    let n: FakeEl | null = this;
    while (n) {
      if (matches(n, sel)) return n;
      n = n.parentNode;
    }
    return null;
  }

  replaceChildren(...nodes: FakeEl[]) {
    for (const c of this.children) c.parentNode = null;
    this.children = nodes;
    for (const n of nodes) n.parentNode = this;
  }
}

function walk(el: FakeEl, visit: (el: FakeEl) => void) {
  visit(el);
  for (const c of el.children) walk(c, visit);
}

function camelData(name: string) {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function matches(el: FakeEl, sel: string): boolean {
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('[') && sel.endsWith(']')) {
    const body = sel.slice(1, -1);
    const eq = body.indexOf('=');
    const raw = eq < 0 ? body : body.slice(0, eq);
    if (raw.startsWith('data-')) {
      const key = camelData(raw.slice(5));
      if (!(key in el.dataset)) return false;
      if (eq < 0) return true;
      const expect = body.slice(eq + 1).replace(/"/g, '');
      return el.dataset[key] === expect;
    }
    return false;
  }
  const dot = sel.indexOf('.');
  if (dot >= 0) {
    const tag = sel.slice(0, dot);
    const cls = sel.slice(dot + 1);
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    return el.className.split(/\s+/).includes(cls);
  }
  return el.tagName === sel.toUpperCase();
}

const VOID_TAGS = new Set(['INPUT', 'BR', 'IMG', 'HR', 'META', 'LINK']);

function applyAttrs(el: FakeEl, attrs: string) {
  const id = /(?:\s|^)id="([^"]*)"/.exec(attrs);
  if (id) el.id = id[1];
  const cls = /(?:\s|^)class="([^"]*)"/.exec(attrs);
  if (cls) el.className = cls[1];
  if (/(?:^|\s)open(?:\s|$|\/|>)/.test(attrs) || /(?:\s|^)open="/.test(attrs)) el.open = true;
  if (/(?:\s|^)checked(?:\s|$|\/|>)/.test(attrs)) el.checked = true;
  for (const dm of attrs.matchAll(/data-([a-z0-9-]+)(?:="([^"]*)")?/gi)) {
    const key = camelData(dm[1]);
    el.dataset[key] = dm[2] ?? '';
  }
}

function parseHtml(html: string, parent: FakeEl): FakeEl[] {
  const top: FakeEl[] = [];
  const stack: FakeEl[] = [];
  const re = /<\/?([a-zA-Z0-9]+)([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const full = m[0];
    const tag = m[1];
    if (full.startsWith('</')) {
      const cur = stack[stack.length - 1];
      if (cur && cur.tagName === tag.toUpperCase()) stack.pop();
      continue;
    }
    const el = new FakeEl(tag);
    applyAttrs(el, m[2] || '');
    const host = stack[stack.length - 1] ?? parent;
    el.parentNode = host;
    if (stack.length === 0) top.push(el);
    else host.children.push(el);
    const selfClose = /\/$/.test(full.trim()) || VOID_TAGS.has(el.tagName);
    if (!selfClose) stack.push(el);
  }
  return top;
}

function dispatchClick(target: FakeEl) {
  const ev = { target };
  let n: FakeEl | null = target;
  while (n) {
    for (const fn of n._listeners.click || []) fn(ev);
    n = n.parentNode;
  }
}

function countWrites(el: FakeEl) {
  let writes = 0;
  let value = el.innerHTML;
  Object.defineProperty(el, 'innerHTML', {
    configurable: true,
    get() {
      return value;
    },
    set(v: string) {
      writes += 1;
      value = String(v);
      for (const c of el.children) c.parentNode = null;
      el.children = parseHtml(value, el);
    },
  });
  return {
    get writes() {
      return writes;
    },
    reset() {
      writes = 0;
    },
  };
}

function missionView(id: string, extra: Record<string, unknown> = {}) {
  return {
    status: 'executing',
    projectId: 'p1',
    contract: { intent: '刷新 ' + id },
    usage: { total: 0 },
    workItems: [],
    escalationLog: [],
    paused: false,
    ...extra,
  };
}

function activityFor(id: string, extra: unknown[] = []) {
  return [
    { at: '2026-01-01T00:00:00.000Z', kind: 'mission.created' },
    { at: '2026-01-01T00:00:01.000Z', kind: 'attempt.started', attemptId: id + '.coord-1' },
    ...extra,
  ];
}

function jsonOk(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function jsonErr(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({ error: 'nope' }),
  };
}

function parseMission(url: string) {
  const u = String(url);
  const live = /\/api\/missions\/([^/?]+)\/live/.exec(u);
  if (live) return { id: decodeURIComponent(live[1]), kind: 'live' as const };
  const act = /\/api\/missions\/([^/?]+)\/activity/.exec(u);
  if (act) return { id: decodeURIComponent(act[1]), kind: 'activity' as const };
  const att = /\/api\/missions\/([^/?]+)\/attempts\/([^/?]+)/.exec(u);
  if (att) {
    return { id: decodeURIComponent(att[1]), kind: 'attempt' as const, attemptId: decodeURIComponent(att[2]) };
  }
  const view = /\/api\/missions\/([^/?]+)$/.exec(u);
  if (view) return { id: decodeURIComponent(view[1]), kind: 'view' as const };
  return { id: '', kind: 'other' as const };
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function tick(ms: number) {
  const fns = [...intervals.values()].filter((t) => t.ms === ms).map((t) => t.fn);
  for (const fn of fns) fn();
}

function setVisible(visible: boolean) {
  visibilityState = visible ? 'visible' : 'hidden';
  for (const fn of visListeners.slice()) fn();
}

function installHarness() {
  intervals = new Map();
  nextTimerId = 1;
  requests = [];
  visibilityState = 'visible';
  visListeners = [];
  idMap = new Map();
  viewById = new Map();
  activityById = new Map();
  liveById = new Map();
  attemptById = new Map();
  fetchGate = null;
  unlockGate = null;
  failNextView = false;

  realSetInterval = globalThis.setInterval;
  realClearInterval = globalThis.clearInterval;
  realFetch = globalThis.fetch;
  realDocument = globalThis.document;

  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    const id = nextTimerId++;
    intervals.set(id, { fn, ms: Number(ms) });
    return id as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;

  globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
    intervals.delete(id as unknown as number);
  }) as typeof clearInterval;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push({ url });
    const go = async () => {
      const hit = parseMission(url);
      if (failNextView && (hit.kind === 'view' || hit.kind === 'activity')) {
        return jsonErr(500) as unknown as Response;
      }
      if (hit.kind === 'view') {
        return jsonOk(viewById.get(hit.id) || missionView(hit.id)) as unknown as Response;
      }
      if (hit.kind === 'activity') {
        return jsonOk(activityById.get(hit.id) || activityFor(hit.id)) as unknown as Response;
      }
      if (hit.kind === 'live') {
        return jsonOk(liveById.get(hit.id) || { cursor: 0, chunks: [] }) as unknown as Response;
      }
      if (hit.kind === 'attempt') {
        return jsonOk(attemptById.get(hit.attemptId || '') || { evidence: [] }) as unknown as Response;
      }
      return jsonErr(404) as unknown as Response;
    };
    if (fetchGate) return fetchGate.then(go);
    return go();
  }) as typeof fetch;

  const crumbs = new FakeEl('div');
  crumbs.id = 'crumbs';
  crumbs._connected = true;

  const document = {
    visibilityState: 'visible' as string,
    getElementById(id: string) {
      return idMap.get(id) ?? null;
    },
    createElement(tag: string) {
      return new FakeEl(tag);
    },
    addEventListener(type: string, fn: () => void) {
      if (type === 'visibilitychange') visListeners.push(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      if (type !== 'visibilitychange') return;
      visListeners = visListeners.filter((x) => x !== fn);
    },
  };
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get() {
      return visibilityState;
    },
  });
  globalThis.document = document as unknown as Document;
}

function restoreHarness() {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  globalThis.fetch = realFetch;
  if (realDocument === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { document?: unknown }).document;
  } else {
    globalThis.document = realDocument as Document;
  }
}

function seed(id: string, viewExtra: Record<string, unknown> = {}, activity?: unknown[]) {
  viewById.set(id, missionView(id, viewExtra));
  activityById.set(id, activity ?? activityFor(id));
}

function mount(id: string) {
  const container = new FakeEl('div');
  container._connected = true;
  return container;
}

function urls() {
  return requests.map((r) => r.url);
}

function kinds(id: string) {
  return urls()
    .map((u) => parseMission(u))
    .filter((x) => x.id === id)
    .map((x) => x.kind);
}

beforeEach(() => {
  installHarness();
});

afterEach(() => {
  restoreHarness();
});

describe('任务页刷新：请求、间隔、终态、可见性', () => {
  test('在途可见：首屏拉 view/activity 再拉 live，之后 3000/1000 周期刷', async () => {
    seed('M-run');
    const box = mount('M-run');
    await renderTaskPage(box, 'M-run');
    await settle();

    assert.deepEqual(kinds('M-run'), ['view', 'activity', 'live']);
    const head = box.querySelector('#task-head');
    assert.ok(head && head.innerHTML.includes('刷新 M-run'), head?.innerHTML);

    const ms = [...intervals.values()].map((t) => t.ms).sort((a, b) => a - b);
    assert.deepEqual(ms, [1000, 3000]);

    requests.length = 0;
    tick(1000);
    await settle();
    assert.deepEqual(kinds('M-run'), ['live']);

    requests.length = 0;
    tick(3000);
    await settle();
    assert.deepEqual(kinds('M-run'), ['view', 'activity']);
  });

  test('paused 不停 view/activity：契约终态只有 completed/blocked', async () => {
    seed('M-pause', { paused: true, waitReason: 'waiting_l3' });
    const box = mount('M-pause');
    await renderTaskPage(box, 'M-pause');
    await settle();
    const ms = [...intervals.values()].map((t) => t.ms).sort((a, b) => a - b);
    assert.deepEqual(ms, [1000, 3000]);
    requests.length = 0;
    tick(3000);
    await settle();
    assert.deepEqual(kinds('M-pause'), ['view', 'activity']);
  });

  test('首屏已终态：不拉 live，不挂任何轮询', async () => {
    seed('M-done', { status: 'completed' });
    const box = mount('M-done');
    await renderTaskPage(box, 'M-done');
    await settle();
    assert.deepEqual(kinds('M-done'), ['view', 'activity']);
    assert.equal(intervals.size, 0);
    requests.length = 0;
    tick(1000);
    tick(3000);
    await settle();
    assert.deepEqual(urls(), []);
  });

  test('首屏 blocked 同样不拉 live', async () => {
    seed('M-block', { status: 'blocked' });
    const box = mount('M-block');
    await renderTaskPage(box, 'M-block');
    await settle();
    assert.deepEqual(kinds('M-block'), ['view', 'activity']);
    assert.equal(intervals.size, 0);
  });

  test('运行中刷到终态：两类轮询都停', async () => {
    seed('M-stop');
    const box = mount('M-stop');
    await renderTaskPage(box, 'M-stop');
    await settle();
    viewById.set('M-stop', missionView('M-stop', { status: 'completed' }));
    requests.length = 0;
    tick(3000);
    await settle();
    assert.deepEqual(kinds('M-stop'), ['view', 'activity']);
    assert.equal(intervals.size, 0);
    requests.length = 0;
    tick(1000);
    tick(3000);
    await settle();
    assert.deepEqual(urls(), []);
  });

  test('隐藏时不发请求；恢复可见立刻补拉仍在途的 view/activity 与 live 并重设定时器', async () => {
    seed('M-hid');
    const box = mount('M-hid');
    await renderTaskPage(box, 'M-hid');
    await settle();
    requests.length = 0;
    setVisible(false);
    tick(1000);
    tick(3000);
    await settle();
    assert.deepEqual(urls(), [], 'hidden 还在打接口');
    assert.equal(intervals.size, 0);

    requests.length = 0;
    setVisible(true);
    await settle();
    assert.deepEqual(kinds('M-hid'), ['view', 'activity', 'live']);
    const ms = [...intervals.values()].map((t) => t.ms).sort((a, b) => a - b);
    assert.deepEqual(ms, [1000, 3000]);
  });

  test('隐藏期间落地的响应不写 DOM；终态恢复可见仍核对 view/activity', async () => {
    seed('M-stale');
    fetchGate = new Promise((resolve) => {
      unlockGate = resolve;
    });
    const box = mount('M-stale');
    const pending = renderTaskPage(box, 'M-stale');
    await settle();
    setVisible(false);
    viewById.set('M-stale', missionView('M-stale', { status: 'completed' }));
    unlockGate && unlockGate();
    fetchGate = null;
    await pending;
    await settle();
    const head = box.querySelector('#task-head');
    assert.equal(head && head.innerHTML.includes('刷新 M-stale'), false, 'hidden 时把终态写进了 DOM');

    requests.length = 0;
    setVisible(true);
    await settle();
    assert.ok(kinds('M-stale').includes('view'), '恢复可见必须核对 view 以确认终态');
    assert.ok(kinds('M-stale').includes('activity'));
    assert.equal(kinds('M-stale').includes('live'), false, '核对后已是终态，不该再拉 live');
    assert.ok(head && head.innerHTML.includes('刷新 M-stale'), head?.innerHTML);
    assert.equal(intervals.size, 0);
  });

  test('数据不变不重画；有变化才重画且保留展开与选中', async () => {
    seed('M-paint');
    const box = mount('M-paint');
    await renderTaskPage(box, 'M-paint');
    await settle();

    const stages = box.querySelector('#task-stages');
    const head = box.querySelector('#task-head');
    assert.ok(stages && head);
    const summary = stages.querySelector('[data-stage-select]');
    assert.ok(summary, '环节头要能点');
    dispatchClick(summary);
    await settle();
    assert.ok(stages.innerHTML.includes('open'), '点开后要写回 open');
    assert.ok(stages.innerHTML.includes('data-active="1"'), '点开后要选中');

    const headW = countWrites(head);
    const stageW = countWrites(stages);
    tick(3000);
    await settle();
    assert.equal(headW.writes, 0, '数据没变却重画了页头');
    assert.equal(stageW.writes, 0, '数据没变却重画了环节');

    activityById.set('M-paint', activityFor('M-paint', [
      { at: '2026-01-01T00:00:02.000Z', kind: 'plan.updated', attemptId: 'M-paint.coord-1' },
    ]));
    tick(3000);
    await settle();
    assert.ok(stageW.writes >= 1, 'activity 变了该重画环节');
    assert.ok(stages.innerHTML.includes('open'), '重画后展开丢了');
    assert.ok(stages.innerHTML.includes('data-active="1"'), '重画后选中丢了');
    assert.ok(stages.innerHTML.includes('data-attempt-id="M-paint.coord-1"'));
  });

  test('防重叠：上一轮 view/activity 没回来不再发一轮', async () => {
    seed('M-olap');
    const box = mount('M-olap');
    await renderTaskPage(box, 'M-olap');
    await settle();

    fetchGate = new Promise((resolve) => {
      unlockGate = resolve;
    });
    requests.length = 0;
    tick(3000);
    await settle();
    const first = urls().length;
    assert.ok(first >= 2, '这一拍该发出 view+activity');
    tick(3000);
    await settle();
    assert.equal(urls().length, first, '重叠发出了第二轮');
    unlockGate && unlockGate();
    fetchGate = null;
    await settle();
  });

  test('离页/换任务：停轮询、解绑 visibility，过期响应不写新页', async () => {
    seed('M-old');
    seed('M-new');
    fetchGate = new Promise((resolve) => {
      unlockGate = resolve;
    });
    const box = mount('M-old');
    const first = renderTaskPage(box, 'M-old');
    await settle();
    const second = renderTaskPage(box, 'M-new');
    unlockGate && unlockGate();
    fetchGate = null;
    await first;
    await second;
    await settle();

    const head = box.querySelector('#task-head');
    assert.ok(head);
    assert.equal(head.innerHTML.includes('刷新 M-old'), false, '旧任务的响应写进了新页');
    assert.ok(head.innerHTML.includes('刷新 M-new'), head.innerHTML);

    const before = visListeners.length;
    setVisible(false);
    setVisible(true);
    await settle();
    assert.ok(visListeners.length <= before, '旧页 visibility listener 没解绑会越积越多');
  });

  test('轮询失败不清空已有内容', async () => {
    seed('M-err');
    const box = mount('M-err');
    await renderTaskPage(box, 'M-err');
    await settle();
    const head = box.querySelector('#task-head');
    const saved = head && head.innerHTML;
    assert.ok(saved && saved.includes('刷新 M-err'));
    failNextView = true;
    tick(3000);
    await settle();
    assert.equal(head && head.innerHTML, saved, '轮询失败把已有内容清空了');
  });

  test('离页后断开的节点上，定时器不再发请求', async () => {
    seed('M-gone');
    const box = mount('M-gone');
    await renderTaskPage(box, 'M-gone');
    await settle();
    box._connected = false;
    requests.length = 0;
    tick(1000);
    tick(3000);
    await settle();
    assert.deepEqual(urls(), []);
    assert.equal(intervals.size, 0);
  });
});
