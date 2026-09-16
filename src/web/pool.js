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

const DASH = '—';

/** 四列的列名，顺序就是契约定的那个。表头与用例都对着这一份。 */
export const POOL_COLUMNS = ['候选名称', 'AgentEndpoint', 'Runtime', 'ExecutionProfile'];

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
 * ExecutionProfile 那一格：从 facts 里取 provider 与 model。
 *
 * 刻意**不**退回显示 profileId。这一列是给"这条候选到底会以什么身份跑"看的，
 * 显示一个名字会让人以为身份已经配好了，而派发时交给适配层的其实是空 facts。
 * 缺了就是 —，不是空白：空白看起来像"本来就还没填"，而那是两种不同的状态。
 */
function profileText(row) {
  const provider = factValue(row && row.facts, 'provider');
  const model = factValue(row && row.facts, 'model');
  if (!provider && !model) return DASH;
  return (provider || DASH) + ' / ' + (model || DASH);
}

function rowsHtml(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    return '<tr><td class="empty" colspan="' + POOL_COLUMNS.length + '">还没有候选</td></tr>';
  }
  return list
    .map((row) => {
      const r = row || {};
      // profileId 也进 data-pool-row：它是这一行的身份，用下标当键会在
      // 删掉一条之后指到别人身上（候选池现在只增，但下标是会被依赖得最久的形状）。
      return '<tr data-pool-row="' + esc(r.profileId) + '">'
        + '<td class="mono">' + esc(r.profileId) + '</td>'
        + '<td class="mono">' + esc(r.endpoint) + '</td>'
        + '<td class="mono">' + esc(r.runtime || 'pi') + '</td>'
        + '<td class="mono">' + esc(profileText(r)) + '</td>'
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
 */
export function addFormHtml(catalog) {
  const usable = Boolean(catalog && catalog.available === true);
  const models = usable && Array.isArray(catalog.models) ? catalog.models : [];
  const options = models.length
    ? models
        .map((m) => '<option value="' + esc(poolModelValue(m)) + '">' + esc(m.label) + '</option>')
        .join('')
    // 清单是空的（适配层在，但一个模型都没报）：给一句占位，
    // 免得下拉展开是一块空白，看着像页面坏了。
    : '<option value="" disabled selected>清单里还没有模型</option>';
  const off = usable ? '' : ' disabled';
  return '<div class="card">'
    + (usable ? '' : '<div class="note" data-pool-note>' + esc(noteText(catalog)) + '</div>')
    + '<div class="note pool-error" data-pool-error hidden></div>'
    + '<form class="pool-form" data-pool-form>'
    +   '<label class="field"><span>角色</span>'
    +     '<select data-pool-role>'
    +       '<option value="coordinator">协调者</option>'
    +       '<option value="executor">执行者</option>'
    +     '</select></label>'
    +   '<label class="field"><span>模型</span>'
    +     '<select data-pool-model' + off + '>' + options + '</select></label>'
    +   '<label class="field"><span>候选名称</span>'
    +     '<input data-pool-profile type="text" placeholder="例如 exec-qwen-flash" /></label>'
    // 默认 local：绝大多数候选就跑在本机，默认值该是那个更常对的一个。
    +   '<label class="field"><span>AgentEndpoint</span>'
    +     '<input data-pool-endpoint type="text" value="local" /></label>'
    +   '<button type="submit" data-pool-submit' + off + '>添加</button>'
    + '</form>'
    + '</div>';
}

/** 整页 HTML。snapshot = { coordinator, executor }，catalog = GET /api/runtime/models 的 JSON。 */
export function poolPageHtml(snapshot, catalog) {
  return '<div class="pool">'
    + countCardsHtml(snapshot)
    + tablesHtml(snapshot)
    + addFormHtml(catalog)
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

function paint(st) {
  const snap = st.snapshot || { coordinator: [], executor: [] };
  // 读不到候选池与"候选池是空的"是两件事，前者要说出来。
  // 后者（空仓）页面自己已经在两张表里画了"还没有候选"。
  const head = st.snapshot === null
    ? '<div class="note">读不到候选池：' + esc(st.loadError) + '</div>'
    : '';
  st.els.root.innerHTML = head + poolPageHtml(snap, st.catalog);
}

function showError(st, message) {
  const box = st.els.root.querySelector('[data-pool-error]');
  if (!box) return;
  box.hidden = false;
  box.textContent = message;
}

async function load(st) {
  let loadError = '';
  const [snapshot, catalog] = await Promise.all([
    get('/api/pools').catch((err) => {
      loadError = err && err.message ? err.message : String(err);
      return null;
    }),
    // 拿不到模型清单**不是**错误：适配层没装、还没配凭据都是正常状态，
    // 页面把原因显示出来就行（见 addFormHtml）。抛出去会让整页只剩一句报错。
    get('/api/runtime/models').catch(() => undefined),
  ]);
  if (st.epoch !== epoch) return;
  st.snapshot = snapshot;
  st.catalog = catalog;
  st.loadError = loadError;
  paint(st);
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
  // 重画顺带把刚才那条错误清掉。
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
    loadError: '',
  };
  mounted = st;
  bind(container);
  await load(st);
}
