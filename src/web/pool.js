/**
 * 资源池页（hash `#/pool`）：两张表列出协调者（L2）与执行者（L1）候选，
 * 底下一条添加表单。
 *
 * 与 projects.js / task.js 同一分界：**上面全是纯函数**（喂数据 → 回字符串），
 * 只有底部 renderPoolPage 碰 DOM 与 fetch。分这么开不是为了洁癖——浏览器不在
 * 测试里，而"字段名读错了"这类错在页面上是**没有声音的**：那一格永远是 —，
 * 页面照样跑。纯函数才能在 node 里把真 JSON 喂进去把它抓出来。
 *
 * 这一页是整个界面里唯一有写操作的一张，所以只有在这里才把「模型从清单里选」
 * 定死：模型名让人手输的话，打错一个字母就是一个跑不起来的候选，而这件事要到
 * 派发那一刻才暴露——那时已经烧掉一次尝试。下拉的选项来自适配层报上来的清单，
 * 平台自己不认识模型。
 *
 * provider / model 这两个词**只出现在这个文件里**（外加测它的用例）：平台
 * （application 层）存的是 facts 这包不透明键值，它不该知道里面装的是什么——
 * 知道了就等于把适配层的知识抄了一份，而抄的那份从写下那一刻就开始过期。
 * 把清单翻译成 facts 是界面的事，因为清单本来就是给界面看的。
 */

import { esc } from './projects.js';
import { usageLine } from './narrate.js';

const DASH = '—';

/**
 * 四列的列名。单元格取值的顺序不变，变的只是表头——之所以要变，是因为
 * `ExecutionProfile` / `Runtime` / `AgentEndpoint` 是接口名，不是人话：
 * 看到 `provider/model` 而不知道那是「这条候选会以什么身份跑」的人，就得
 * 去读代码。
 */
export const POOL_COLUMNS = ['候选名称', '接入点', '适配层', '运行时', '健康'];

/* ===================== 纯函数 ===================== */

/** facts 里按 key 取值。平台不解释 key，所以找不到就是找不到，不当错。 */
function factValue(facts, key) {
  const list = Array.isArray(facts) ? facts : [];
  for (const item of list) {
    if (item && item.key === key) return String(item.value ?? '');
  }
  return '';
}

/**
 * 运行时那一格：从 facts 里取 provider 与 model。
 *
 * 刻意**不**退回显示 profileId。这一列是给"这条候选到底会以什么身份跑"看的，
 * 显示一个名字会让人以为身份已经配好了，而派发时交给适配层的其实是空 facts。
 * 缺了仍是 —，但带一句 title：一个孤零零的横杠，人分不出是“还没配”还是“读错了”。
 */
function profileText(row) {
  const provider = factValue(row && row.facts, 'provider');
  const model = factValue(row && row.facts, 'model');
  if (!provider && !model) return { text: DASH, title: '还没配模型身份' };
  return { text: (provider || DASH) + ' / ' + (model || DASH), title: '' };
}

function text(value) {
  return value === undefined || value === null ? '' : String(value);
}

function circuitTone(state) {
  if (state === 'open') return 'failed';
  if (state === 'closed') return 'done';
  if (state === 'half_open') return 'unconfirmed';
  return 'queued';
}

function windowCostText(reportedCost) {
  if (reportedCost === null || reportedCost === undefined || !Number.isFinite(Number(reportedCost))) {
    return '费用未上报';
  }
  return '$' + Number(reportedCost).toFixed(4);
}

/**
 * 候选健康格。字段按 W-130 容错：缺 health、缺子对象、reason 码原样上屏。
 * 不在这里建熔断中文表——跨页文案该进 narrate.js，本单不能改那份文件。
 */
export function healthCellHtml(health) {
  if (!health || typeof health !== 'object') {
    return '<td class="cell-reason" data-pool-health><span class="muted">还没读到健康</span></td>';
  }
  const circuit = health.circuit && typeof health.circuit === 'object' ? health.circuit : {};
  const window7d = health.window7d && typeof health.window7d === 'object' ? health.window7d : {};
  const last = health.lastFailure && typeof health.lastFailure === 'object' ? health.lastFailure : {};
  const runtime = health.runtime && typeof health.runtime === 'object' ? health.runtime : {};

  const state = text(circuit.state) || 'unknown';
  const circuitExtra = text(circuit.failureClass) || text(circuit.reason);
  const circuitLine = '<span class="chip ' + circuitTone(state) + '">' + esc(state) + '</span>'
    + (circuitExtra ? ' · ' + esc(circuitExtra) : '');

  const attempts = Number.isFinite(Number(window7d.attempts)) ? Number(window7d.attempts) : 0;
  const successes = Number.isFinite(Number(window7d.successes)) ? Number(window7d.successes) : 0;
  const windowLine = '近七日：尝试 ' + attempts + ' · 成功 ' + successes + ' · ' + windowCostText(window7d.reportedCost);

  const failClass = text(last.failureClass);
  const failAt = text(last.at);
  const failSource = text(last.source);
  const hasFail = Boolean(failAt || failSource || (failClass && failClass !== 'unknown'));
  const failLine = hasFail
    ? '最近失败：' + (failClass || 'unknown') + (failAt ? ' · ' + failAt : '') + (failSource ? ' · ' + failSource : '')
    : '没有失败记录';

  let runtimeLine;
  if (runtime.running === true) {
    const kind = text(runtime.runtimeKind);
    const hopId = text(runtime.hopId);
    runtimeLine = '占用中' + (kind ? ' · ' + kind : '') + (hopId ? ' · ' + hopId : '');
  } else {
    const reason = text(runtime.reason);
    runtimeLine = '未在跑' + (reason ? ' · ' + reason : '');
  }

  return '<td class="cell-reason" data-pool-health>'
    + '<div data-health-circuit>' + circuitLine + '</div>'
    + '<div data-health-window>' + esc(windowLine) + '</div>'
    + '<div data-health-failure>' + esc(failLine) + '</div>'
    + '<div data-health-runtime>' + esc(runtimeLine) + '</div>'
    + '</td>';
}

function rowsHtml(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    return '<tr><td class="empty" colspan="' + POOL_COLUMNS.length + '">还没有候选</td></tr>';
  }
  return list
    .map((row) => {
      const r = row || {};
      const profile = profileText(r);
      // profileId 也进 data-pool-row：它是这一行的身份，用下标当键会在
      // 删掉一条之后指到别人身上（候选池现在只增，但下标是会被依赖得最久的形状）。
      return '<tr data-pool-row="' + esc(r.profileId) + '">'
        + '<td class="mono">' + esc(r.profileId) + '</td>'
        + '<td class="mono">' + esc(r.endpoint) + '</td>'
        + '<td class="mono">' + esc(r.runtime || 'pi') + '</td>'
        + '<td class="mono"' + (profile.title ? ' title="' + esc(profile.title) + '"' : '') + '>'
        +   esc(profile.text) + '</td>'
        + healthCellHtml(r.health)
        + '</tr>';
    })
    .join('');
}

function tableHtml(caption, rows) {
  const head = POOL_COLUMNS.map((name) => '<th>' + name + '</th>').join('');
  return '<div class="card">'
    + '<h2>' + esc(caption) + '</h2>'
    + '<div class="table-wrap"><table class="tasks">'
    + '<thead><tr>' + head + '</tr></thead>'
    + '<tbody>' + rowsHtml(rows) + '</tbody>'
    + '</table></div>'
    + '</div>';
}

/**
 * 顶部两张计数卡。顺序与下面两张表一致（先 L2 后 L1），
 * 数字上带 data-count 是为了用例能精确断言"这一格是 2"——
 * 断言页面里出现过字符 2 那种写法，随便一个别的地方有 2 就绿了。
 */
export function countCardsHtml(snapshot) {
  const snap = snapshot || {};
  const count = (role) => (Array.isArray(snap[role]) ? snap[role].length : 0);
  return '<div class="card"><dl class="task-stats">'
    + '<div class="stat"><dt>协调者（L2）</dt>'
    + '<dd class="mono" data-count="coordinator">' + esc(count('coordinator')) + '</dd></div>'
    + '<div class="stat"><dt>执行者（L1）</dt>'
    + '<dd class="mono" data-count="executor">' + esc(count('executor')) + '</dd></div>'
    + '</dl></div>';
}

export function tablesHtml(snapshot) {
  const snap = snapshot || {};
  return tableHtml('协调者（L2）', snap.coordinator) + tableHtml('执行者（L1）', snap.executor);
}

/**
 * 用量卡：GET /api/usage 的 total。口径与任务页、项目页同一个 usageLine。
 *
 * total 有三种状态，三种都要说得出来：
 *   undefined —— 还没读到（首帧）；null —— 读失败；对象 —— 真数字。
 * 读失败写「读不到用量」而不是留空白：空白在屏幕上像“本来就是 0”。
 */
export function usageCardHtml(total) {
  const text = total === undefined
    ? '用量读取中…'
    : total === null
      ? '读不到用量'
      : usageLine(total);
  const known = total !== null && total !== undefined;
  return '<div class="card">'
    + '<div class="pane-title">Token 用量</div>'
    + '<div class="usage-breakdown' + (known ? '' : ' muted') + '">' + esc(text) + '</div>'
    + '</div>';
}

/**
 * 一条模型在 option 上的 value。
 *
 * 用 JSON 而不是把 provider 与 model 拼成一个字符串：label 是人写的，里面
 * 完全可能有斜杠或空格，拼串在提交那一刻就得反着猜"切在哪儿"。JSON 里两边
 * 各是一个字段，拆回来不需要任何约定。
 */
export function poolModelValue(item) {
  return JSON.stringify({ provider: String(item.provider), model: String(item.model) });
}

export function parseModelValue(value) {
  try {
    const parsed = JSON.parse(String(value ?? ''));
    if (!parsed || typeof parsed.provider !== 'string' || typeof parsed.model !== 'string') {
      return null;
    }
    return { provider: parsed.provider, model: parsed.model };
  } catch {
    // 下拉被人改成别的东西（或清单一边变了）时给 null，不抛：
    // 一个 JSON.parse 的异常从 submit 里冒出去，会变成一条谁也看不懂的报错。
    return null;
  }
}

/**
 * POST body 里的 facts：`[{key:'provider'},{key:'model'}]`。
 *
 * 拆不出来就回 null，调用方据此拒绝提交。**不要**在这里给个空 facts 兜底：
 * 那会存下一条"看起来配好了、其实什么身份都没带"的候选，
 * 而它要到第一次派发失败时才说话。
 */
export function factsFromModel(value) {
  const picked = parseModelValue(value);
  if (!picked) return null;
  return [
    { key: 'provider', value: picked.provider },
    { key: 'model', value: picked.model },
  ];
}

/** 失败时显示的话。后端的 message 是写给界面与模型看的，优先原样显示。 */
export function errorText(body, status) {
  const message = body && body.message;
  return message ? String(message) : 'HTTP ' + status;
}

/** 适配层没上线时的说明。有 note 就用它的原话——那是唯一说清原因的地方。 */
function noteText(catalog) {
  const note = catalog && catalog.note;
  if (typeof note === 'string' && note.trim()) return note;
  return '拿不到模型清单：适配层没上线，或者还没配好凭据。';
}

/**
 * 底部添加表单。
 *
 * catalog.available === false 时：note 原样摆出来，模型下拉与提交按钮都 disabled。
 * 契约要的是"不要让人在填不对的表单上瞎试"——一个能点但必然失败的按钮，
 * 比一个灰按钮更坑：人会把后端报的错当成自己的输入有问题。
 *
 * opts.modelsStatus：idle 还没拉、loading 正在拉、ready 有响应、error 拉失败。
 * 纯函数默认 ready——既有用例把 catalog 直接喂进来，不该被当成「还没拉」。
 */
export function addFormHtml(catalog, opts) {
  const open = Boolean(opts && opts.open);
  const modelsStatus = opts && opts.modelsStatus ? opts.modelsStatus : 'ready';
  const loading = modelsStatus === 'loading';
  const idle = modelsStatus === 'idle';
  const usable = Boolean(catalog && catalog.available === true);
  const models = usable && Array.isArray(catalog.models) ? catalog.models : [];
  const optionTags = models.length
    ? models
        .map((m) => '<option value="' + esc(poolModelValue(m)) + '">' + esc(m.label) + '</option>')
        .join('')
    // 清单是空的（适配层在，但一个模型都没报）：给一句占位，
    // 免得下拉展开是一块空白，看着像页面坏了。
    : '<option value="" disabled selected>清单里还没有模型</option>';
  const off = usable && !loading ? '' : ' disabled';
  // idle/读取中还没拿到清单：不要写「适配层没上线」——那是拉失败才该说的话，
  // 拉之前就写会让人以为出了故障。
  const showNote = !idle && !loading && !usable;
  const loadingNote = loading
    ? '<div class="note" data-pool-models-status>模型清单读取中…</div>'
    : '';
  // details 默认收起：打开才去拉慢的模型接口。用原生 details
  // 就不用为「展开」再写一套按钮状态，否则漏一个 hidden 就会在首屏露出空表单。
  return '<div class="card">'
    + '<details class="pool-add" data-pool-add' + (open ? ' open' : '') + '>'
    + '<summary>添加候选</summary>'
    + loadingNote
    + (showNote ? '<div class="note" data-pool-note>' + esc(noteText(catalog)) + '</div>' : '')
    + '<div class="note pool-error" data-pool-error hidden></div>'
    + '<form class="pool-form" data-pool-form>'
    +   '<label class="field"><span>角色</span>'
    +     '<select data-pool-role>'
    +       '<option value="coordinator">协调者</option>'
    +       '<option value="executor">执行者</option>'
    +     '</select></label>'
    +   '<label class="field"><span>模型</span>'
    +     '<select data-pool-model' + off + '>' + optionTags + '</select></label>'
    +   '<label class="field"><span>候选名称</span>'
    +     '<input data-pool-profile type="text" placeholder="例如 exec-qwen-flash" /></label>'
    // 默认 local：绝大多数候选就跑在本机，默认值该是那个更常对的一个。
    +   '<label class="field"><span>接入点</span>'
    +     '<input data-pool-endpoint type="text" value="local" /></label>'
    +   '<button type="submit" data-pool-submit' + off + '>添加</button>'
    + '</form>'
    + '</details>'
    + '</div>';
}

/** 整页 HTML。snapshot = { coordinator, executor }，catalog = GET /api/runtime/models 的 JSON，
 *  usage = GET /api/usage 的 total（undefined 还没读到 / null 读失败 / 对象是真数字）。
 *  formOpts.open / formOpts.modelsStatus 只影响底部表单，纯函数用例可不传。 */
export function poolPageHtml(snapshot, catalog, usage, formOpts) {
  return '<div class="pool">'
    + countCardsHtml(snapshot)
    + usageCardHtml(usage)
    + tablesHtml(snapshot)
    + addFormHtml(catalog, formOpts)
    + '</div>';
}

/* ===================== 下面才是碰 DOM 的部分 ===================== */

async function get(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
  return res.json();
}

let mounted = null;
let epoch = 0;

function fieldValue(root, sel) {
  const el = root.querySelector(sel);
  return el && typeof el.value === 'string' ? el.value : '';
}

function setFieldValue(root, sel, value) {
  const el = root.querySelector(sel);
  if (el) el.value = value;
}

function readDraft(root) {
  if (!root || !root.querySelector('[data-pool-form]')) return null;
  return {
    role: fieldValue(root, '[data-pool-role]'),
    profile: fieldValue(root, '[data-pool-profile]'),
    endpoint: fieldValue(root, '[data-pool-endpoint]'),
  };
}

function writeDraft(root, draft) {
  if (!draft) return;
  setFieldValue(root, '[data-pool-role]', draft.role);
  setFieldValue(root, '[data-pool-profile]', draft.profile);
  setFieldValue(root, '[data-pool-endpoint]', draft.endpoint);
}

function paint(st, opts) {
  const snap = st.snapshot || { coordinator: [], executor: [] };
  // 读不到候选池与"候选池是空的"是两件事，前者要说出来。
  // 后者（空仓）页面自己已经在两张表里画了"还没有候选"。
  const head = st.snapshot === null
    ? '<div class="note">读不到候选池：' + esc(st.loadError) + '</div>'
    : '';
  // 模型清单回来时会整块重画：不把已经填的名称/接入点抄回来，
  // 人会以为页面把输入吞了（清单接口实测要数秒）。
  const keepDraft = Boolean(opts && opts.keepDraft);
  const draft = keepDraft ? readDraft(st.els.root) : null;
  st.els.root.innerHTML = head + poolPageHtml(snap, st.catalog, st.usage, {
    open: st.formOpen,
    modelsStatus: st.modelsStatus,
  });
  if (draft) writeDraft(st.els.root, draft);
}

function showError(st, message) {
  const box = st.els.root.querySelector('[data-pool-error]');
  if (!box) return;
  box.hidden = false;
  box.textContent = message;
}

async function load(st) {
  let loadError = '';
  // 模型清单不进这一帧：实测 /api/runtime/models 要数秒，放进 Promise.all
  // 会让候选和用量一起空白。打开添加表单再拉（见 loadModels）。
  const [snapshot, total] = await Promise.all([
    get('/api/pools').catch((err) => {
      loadError = err && err.message ? err.message : String(err);
      return null;
    }),
    // 用量读失败要写「读不到用量」，所以不能把失败静默成 undefined——
    // 那看起来和“首帧还没到”一模一样。null 明确代表读失败。
    get('/api/usage').then((body) => (body && body.total) || null).catch(() => null),
  ]);
  if (st.epoch !== epoch) return;
  st.snapshot = snapshot;
  st.usage = total;
  st.loadError = loadError;
  paint(st);
}

async function loadModels(st) {
  if (st.modelsRequested) return;
  st.modelsRequested = true;
  st.modelsStatus = 'loading';
  paint(st, { keepDraft: true });
  // 拿不到模型清单**不是**整页错误：适配层没装、还没配凭据都是正常状态，
  // 只让表单把原因显示出来。抛出去会让已经画好的候选和用量一起消失。
  const catalog = await get('/api/runtime/models').catch(() => undefined);
  if (st.epoch !== epoch) return;
  st.catalog = catalog;
  st.modelsStatus = catalog === undefined ? 'error' : 'ready';
  paint(st, { keepDraft: true });
}

async function submit(st, form) {
  const role = form.querySelector('[data-pool-role]').value;
  const facts = factsFromModel(form.querySelector('[data-pool-model]').value);
  const profileId = form.querySelector('[data-pool-profile]').value.trim();
  const endpoint = form.querySelector('[data-pool-endpoint]').value.trim();
  if (!facts) {
    showError(st, '先从清单里选一个模型');
    return;
  }
  let res;
  try {
    res = await fetch('/api/pools', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role, profileId, endpoint, facts }),
    });
  } catch (err) {
    showError(st, '提交失败：' + (err && err.message ? err.message : String(err)));
    return;
  }
  if (st.epoch !== epoch) return;
  if (!res.ok) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      // 后端没回 JSON（502 的 HTML 之类）：下面那句 HTTP 状态码就是全部信息。
      body = null;
    }
    if (st.epoch === epoch) showError(st, errorText(body, res.status));
    return;
  }
  // 成功就整块重画：列表与计数都从后端重新拉，不在前端自己加一行——
  // 前端算出来的 order、以及"同 role 重复会被拒"这类规则，都只有后端说了算。
  // 重画顺带把刚才那条错误清掉。模型清单已经在手里，不再等它。
  await load(st);
}

function bind(container) {
  // 监听挂在常驻容器上：每次刷新都整块重写 innerHTML，绑在表单那个元素上的话，
  // 刷新一次就丢一次监听——表现是"加了一条之后按钮就点不动了"。
  if (container.dataset.poolBound === '1') return;
  container.dataset.poolBound = '1';
  container.addEventListener('submit', (ev) => {
    const form = ev.target && ev.target.closest && ev.target.closest('[data-pool-form]');
    if (!form) return;
    ev.preventDefault();
    const st = mounted;
    if (!st || st.epoch !== epoch) return;
    void submit(st, form);
  });
  // toggle 不冒泡；挂捕获才能在常驻容器上听到 details 被打开。
  // 不这么做的话，每次 paint 换掉 details 节点，监听就丢了，表单再也拉不了模型。
  container.addEventListener('toggle', (ev) => {
    const t = ev.target;
    if (!t) return;
    const details = t.closest ? t.closest('[data-pool-add]') : null;
    const el = details || (t.hasAttribute && t.hasAttribute('data-pool-add') ? t : null);
    if (!el) return;
    const st = mounted;
    if (!st || st.epoch !== epoch) return;
    st.formOpen = Boolean(el.open);
    if (st.formOpen) void loadModels(st);
  }, true);
}

/**
 * 挂载资源池页。
 *
 * 同一个容器、节点还挂在树上 —— 不重建。重建会把已经填了一半的表单清掉，
 * 而人切走再切回来（比如去项目页看一眼名字）时那是他最不想要的事。
 */
export async function renderPoolPage(container) {
  const same = mounted
    && mounted.container === container
    && mounted.els.root
    && mounted.els.root.isConnected;
  if (same) return;

  epoch += 1;
  container.innerHTML = '<section class="pool" data-pool-root></section>';
  const st = {
    container,
    epoch,
    els: { root: container.querySelector('[data-pool-root]') },
    snapshot: null,
    catalog: undefined,
    usage: undefined,
    loadError: '',
    formOpen: false,
    modelsStatus: 'idle',
    modelsRequested: false,
  };
  mounted = st;
  bind(container);
  await load(st);
}
