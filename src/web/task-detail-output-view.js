/**
 * 任务详情「当前实时输出」与「历史选择」两区的渲染层（Contract AC3 的呈现层）。
 *
 * 这两区最容易出的错都不报错、也不崩，屏幕上还挺像那么回事：
 *   - 点了历史那一跳，左边的实时行跟着换成了历史内容（或反过来把历史尾部写进实时框），
 *     人就会把上一跳的结尾当成这一跳正在跑的东西；
 *   - 历史正文缺失时「顺手」拿实时行、任务级 output 或 missionDiff 顶上，页面上看起来
 *     有内容，实际上那是别人的账，而且界面上没有任何东西能揭穿它；
 *   - 用量面板拿 Mission 累计花费冒充单跳花费，人据此判断「这一跳花了多少」；
 *   - 心跳缺失/非法时被读成「疑似停滞」，催人去重启一个可能还在正常输出的环节。
 *
 * 判断一律留在 task-detail-output.js（纯函数，node 里喂假 input 就能断言），这里只
 * 负责转义与 DOM：**不重算哪个 chunk 属于谁、不重判 90000ms 窗口、不取当前时间**。
 * 抄第二份判断，两处迟早只改到一处，而漏改的那边在界面上只是一句不一样的话。
 *
 * 心跳尤其如此：窗口判断只在投影里做一次，本层连 `Date` 都不碰。这里若自己用
 * `new Date()` 重判一次，两次渲染同一条数据就可能得出不同的字，「疑似停滞」会随着
 * 刷新自己跳来跳去，而人只会以为任务真的在反复卡住。
 *
 * **不 import task.js、也不 import src/application**：前者是详情页的渲染模块，它要
 * import 本模块来接线；互相 import 在浏览器原生 ES module 下不成环报错，只会让某一侧
 * 拿到 undefined，然后整页白掉。后者是服务端层，拉进来会把整条服务端依赖拽到前端。
 */
import { esc } from './projects.js';
import { projectOutputBinding } from './task-detail-output.js';

/**
 * 三个页签的固定顺序与文案。顺序由这里定死，不从数据里推：按数据推出来的顺序会随
 * 哪一格先有值而变化，人每次进来看到的按钮位置都不一样。
 */
const SIDES = [
  { side: 'summary', label: '概要' },
  { side: 'files', label: '文件' },
  { side: 'usage', label: '用量' },
];

const DEFAULT_SIDE = 'summary';

/** 标题是这一区的身份。不写「第 N 次执行」之类的次数：那边的次数属于工作流历史， */
/** 抄过来就会在实时框上方写一个与本区无关的数字。 */
const LIVE_TITLE = '当前实时输出';
/** 右卡的标题。它说的是「你在看的这一跳」，与左边「正在跑的那一跳」是两回事。 */
const HISTORY_TITLE = '选中环节';
/** 历史正文的标签：事实区答的是这一跳的身份与账，正文区答的才是它说过的原话。 */
const HISTORY_LABEL = '历史正文';

/**
 * 实时行里认得出的角色。**只有这五个才前缀角色**：kind 是 text 或空时编一个角色，
 * 一行普通正文就会被读成「协调者的结论」，而界面上看不出这是猜的。
 */
const LIVE_ROLE_LABELS = {
  coordinator: '协调者',
  executor: '执行者',
  platform: '平台',
  reviewer: '检视者',
  tool: '工具',
};

/**
 * 概要里每一格的标签。title / identity 在画板上本来就没有标签（它们是这一跳的头两行），
 * 再套一个「标题 / 身份」反而多出两个画板上没有的词。
 */
const FACT_LABELS = {
  scope: '冻结工单与允许范围',
  candidateChange: '候选变更',
  cost: '本环节费用',
  result: '交回结果',
};

/** 未知就是未知：不补成 0、不补成一句默认话、不补成上一跳的内容。 */
const UNKNOWN = '未知';

/**
 * 用量字段的中文标签。认不出的字段原样显示键名——编一个中文名比显示 `cost` 更容易
 * 让人误会成另一笔账。数字本身一律来自投影的 historyUsage，不在这里加总、不做换算。
 */
const USAGE_LABELS = {
  input: '输入',
  output: '输出',
  cacheRead: '缓存命中',
  cacheWrite: '缓存写入',
  cost: '花费',
};

const text = (value) => (value === undefined || value === null ? '' : String(value)).trim();

/** 只认白名单里的三个值：别的值落回「概要」，页面上不会出现一个什么都不显示的空面板。 */
function normalizeSide(value) {
  const side = text(value);
  return SIDES.some((entry) => entry.side === side) ? side : DEFAULT_SIDE;
}

/** 一格事实。`inner` 是已经转义好的 HTML：允许范围是一串路径，得排成列表。 */
function factHtml(name, inner) {
  const label = FACT_LABELS[name] || '';
  const labelHtml = label === '' ? '' : '<span class="td-fact-label">' + esc(label) + '</span>';
  return '<div class="td-fact" data-fact="' + esc(name) + '">'
    + labelHtml
    + '<div class="td-fact-value">' + inner + '</div>'
    + '</div>';
}

/**
 * 允许范围：投影给 null 就是「未知」，给数组就逐条列。
 *
 * **不读 missionDiff / executionResult.changedFiles**：那是一跳事后动了哪些文件，
 * 与「派活时允许它动哪些」是两笔账。摆在一起人就会拿事后结果去核对事前授权，而
 * 两个数字本来就该不一样。
 */
function scopeValueHtml(scope) {
  if (!Array.isArray(scope)) return esc(UNKNOWN);
  const rows = scope.map(text).filter((file) => file !== '');
  if (rows.length === 0) return esc(UNKNOWN);
  return '<ul class="td-fact-list">'
    + rows.map((file) => '<li class="td-fact-item">' + esc(file) + '</li>').join('')
    + '</ul>';
}

/** 本环节费用：只拼投影给的原值。cost 为 0 也当值显示——「报过 0」不是「没报」。 */
function costValueHtml(cost) {
  const c = cost && typeof cost === 'object' ? cost : null;
  if (c === null) return esc(UNKNOWN);
  const parts = [text(c.cost), text(c.quality)].filter((part) => part !== '' && part !== UNKNOWN);
  return esc(parts.length === 0 ? UNKNOWN : parts.join(' · '));
}

/**
 * 事实区。六格都带 data-fact，顺序写死：按数据顺序排会让「交回结果」在每次刷新时
 * 上下跳，而人正拿它对着同一块区域的另一条页面在核。
 *
 * 每一格的值**只来自投影的 facts**：本层不读 selectedAttempt、不读 activity，也不
 * 自己判 id 是否匹配。抄第二份判断，两处迟早只改到一处，而漏改的那边在界面上只是
 * 一格看起来完全正常的数字。
 */
function factsHtml(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  return '<div class="td-facts">'
    + factHtml('title', esc(text(f.title) || UNKNOWN))
    + factHtml('identity', esc(text(f.identity) || UNKNOWN))
    + factHtml('scope', scopeValueHtml(f.scope))
    + factHtml('candidateChange', esc(text(f.candidateChange) || UNKNOWN))
    + factHtml('cost', costValueHtml(f.cost))
    + factHtml('result', esc(text(f.result) || UNKNOWN))
    + '</div>';
}

/**
 * 历史正文（概要页签）。
 *
 * 事实区在前、正文在后，两者是**两块互不替代的内容**：output 为空时正文区仍照原样
 * 说「历史正文未知」，并**不**用事实把它填满——事实区回答「这一跳是谁」，正文区
 * 回答「它说了什么」，拿一个顶一个等于告诉人这一跳有正文而它其实没有。
 *
 * `output` 为非空串才当正文用；否则显示投影给的 note（当前是「历史正文未知」）。
 * **绝不回头读 liveText 或 input 上的任务级 output**：那正是「看起来有内容、其实
 * 不是这一跳」的来源，而且它长得和真正文一模一样。
 */
function summaryBody(historyOutput, facts) {
  const output = historyOutput && typeof historyOutput.output === 'string' ? historyOutput.output : '';
  const body = text(output) !== ''
    ? '<pre class="td-history-text">' + esc(output) + '</pre>'
    : '<p class="td-history-note">' + esc(text(historyOutput && historyOutput.note) || UNKNOWN) + '</p>';
  return factsHtml(facts)
    + '<p class="td-history-label">' + esc(HISTORY_LABEL) + '</p>'
    + body;
}

/**
 * 文件清单（文件页签）。
 *
 * 投影里 `files` 恒为 null（这个接口没有按 Attempt 的清单），此时显示它的 note。
 * **故意不读 input.missionDiff / input.executionResult**：那是任务级事实，列在某
 * 一跳下面就是「这一跳动了这些文件」，而这笔账谁也说不清。
 */
function filesBody(historyFiles) {
  const files = historyFiles && Array.isArray(historyFiles.files) ? historyFiles.files : null;
  if (files === null) {
    return '<p class="td-history-note">' + esc(text(historyFiles && historyFiles.note) || UNKNOWN) + '</p>';
  }
  const rows = files.map(text).filter((file) => file !== '');
  if (rows.length === 0) {
    return '<p class="td-history-note">' + esc(UNKNOWN) + '</p>';
  }
  const items = rows.map((file) => '<li class="td-file-item">' + esc(file) + '</li>').join('');
  return '<ul class="td-file-list">' + items + '</ul>';
}

/**
 * 单跳用量（用量页签）。
 *
 * 只认投影的 historyUsage（null = 这一跳没有自己的用量）。**不读 input.missionUsage**：
 * 那是整条 Mission 的累计数，摆在这里就被读成「这一跳花了这些」，而这个数字从来没按
 * 这一跳量过。缺失时说「未知」，不补 0——「没报过」和「花了 0」在预算判断上是两件事。
 */
function usageBody(historyUsage) {
  const usage = historyUsage && typeof historyUsage === 'object' ? historyUsage : null;
  if (usage === null) return '<p class="td-history-note">' + esc(UNKNOWN) + '</p>';

  // 键名排序：同一条数据两次渲染必须得出同样的字，否则「多了/少了一行」看起来像数据在变。
  const items = Object.keys(usage).sort().map((key) => {
    const value = usage[key];
    const shown = value === undefined || value === null ? UNKNOWN : String(value);
    const label = USAGE_LABELS[key] || key;
    return '<li class="td-usage-item" data-field="' + esc(key) + '">'
      + '<span class="td-usage-label">' + esc(label) + '</span>'
      + '<span class="td-usage-value">' + esc(shown) + '</span>'
      + '</li>';
  }).join('');

  if (items === '') return '<p class="td-history-note">' + esc(UNKNOWN) + '</p>';
  return '<ul class="td-usage-list">' + items + '</ul>';
}

/**
 * 一条实时行。
 *
 * 每条一个**块级** `.td-live-line`，而不是把整段 liveText 塞进一个 pre：黏成一段之后
 * 「这条是哪一秒、谁说的」只能靠肉眼在长串里找，而相邻两条正文之间往往没有换行符。
 *
 * at 与 kind 都只认行上真实存在的值：没有 at 就不编时间（编一个「刚刚」会让人以为
 * 这一行是新的）；kind 不在白名单里就不编角色。
 */
function liveLineHtml(line) {
  const source = line && typeof line === 'object' ? line : {};
  const at = text(source.at);
  const role = LIVE_ROLE_LABELS[text(source.kind)] || '';
  const head = (at === '' ? '' : '[' + at + '] ') + (role === '' ? '' : '[' + role + '] ');
  return '<span class="td-live-line">' + esc(head + text(source.text)) + '</span>';
}

/**
 * 一个页签的面板。三个面板**一次性全画**，非当前的带 hidden：
 *
 * bindTaskOutput 按契约只翻根上的 data-side、aria-selected 与 hidden，不重算内容。
 * 面板要等点选才拼的话，点一下按钮就会看到一片空白，而那片空白和「这一跳确实没有
 * 输出」长得一模一样。
 */
function panelHtml(side, inner, current) {
  return '<div class="td-panel" data-panel="' + side + '"' + (current ? '' : ' hidden') + '>'
    + inner
    + '</div>';
}

/** 三个页签按钮。aria-selected 只认当前 side，两处给值会让人看到两个「选中」。 */
function switchHtml(side) {
  const buttons = SIDES.map((entry) => (
    '<button type="button" class="td-side" data-side="' + entry.side + '"'
    + ' aria-selected="' + (entry.side === side ? 'true' : 'false') + '">'
    + esc(entry.label) + '</button>'
  )).join('');
  return '<div class="td-side-switch" role="tablist">' + buttons + '</div>';
}

/**
 * 两卡 HTML。根节点 section.td-output，里面是**两张各自独立的白卡**。
 *
 * 不包在同一张白卡里：抠在一起时两块共用一条外框，「当前在跑的那一跳」与「你点开
 * 的那一跳」看起来是同一块内容的两个子区，而它们的事实来源完全不同（左边只认
 * currentAttemptId，右边只认 selectedAttemptId）。
 *
 * 左 .td-live 只放当前这一跳（binding.liveAttemptId）的实时行与心跳；右 .td-history
 * 只放选中那一跳（binding.historyAttemptId）的概要/文件/用量。两边的 id 分别写在
 * data-live-attempt / data-history-attempt 上——它们**可以不同**，这正是这两个区
 * 互不串账的凭据；接线时也只改后者相关的页签，不动前者。
 *
 * 心跳文本与 data-stalled 原样取自投影的 heartbeat：本层不判窗口、不取当前时间。
 * 实时行也只用投影给的 liveLines（已经按 currentAttemptId 过滤过）：本层再滤一遍
 * 就是第二份判断，两处迟早只改到一处，漏改的那侧会把上一跳的结尾摆进来。
 */
export function taskOutputHtml(input, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const binding = projectOutputBinding(input);
  const side = normalizeSide(opts.side);

  const liveAttempt = binding.liveAttemptId === null ? '' : text(binding.liveAttemptId);
  const historyAttempt = binding.historyAttemptId === null ? '' : text(binding.historyAttemptId);
  const heartbeat = binding.heartbeat && typeof binding.heartbeat === 'object' ? binding.heartbeat : {};
  const lines = Array.isArray(binding.liveLines) ? binding.liveLines : [];

  return '<section class="td-output" data-side="' + side + '">'
    + '<div class="td-live" data-live-attempt="' + esc(liveAttempt) + '">'
    + '<div class="td-live-head">'
    + '<h2 class="td-live-title">' + esc(LIVE_TITLE) + '</h2>'
    + '<p class="td-heartbeat" data-stalled="' + String(heartbeat.stalled === true) + '">'
    + esc(heartbeat.stateText) + '</p>'
    + '</div>'
    + '<pre class="td-live-text">' + lines.map(liveLineHtml).join('') + '</pre>'
    + '</div>'
    + '<div class="td-history" data-history-attempt="' + esc(historyAttempt) + '">'
    + '<div class="td-history-head">'
    + '<h2 class="td-history-title">' + esc(HISTORY_TITLE) + '</h2>'
    + switchHtml(side)
    + '</div>'
    + panelHtml('summary', summaryBody(binding.historyOutput, binding.facts), side === 'summary')
    + panelHtml('files', filesBody(binding.historyFiles), side === 'files')
    + panelHtml('usage', usageBody(binding.historyUsage), side === 'usage')
    + '</div>'
    + '</section>';
}

/** hidden 用属性 + 属性反射一起写：只改其中一个，某些实现下面板会既不可见也不占位。 */
function setHidden(el, hidden) {
  if (hidden) el.setAttribute('hidden', '');
  else el.removeAttribute('hidden');
  if ('hidden' in el) el.hidden = hidden;
}

/**
 * 只绑 root 里的页签切换。
 *
 * 用 `button.onclick =` 而不是 addEventListener：详情页每次重渲染都会再调一次本函数，
 * 赋值会覆盖上一次的处理器；监听器则会一层层叠上去，点一次换多次面板，表现为点了
 * 没反应。
 *
 * 边界：只改根上的 data-side、三个按钮的 aria-selected、三个面板的 hidden。
 * **不动 data-live-attempt，也不重渲染任何内容**——重渲染要重新取数，凭旧数据重画
 * 一次，屏幕上就会出现另一跳的正文，而它看起来完全正常。
 */
export function bindTaskOutput(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;

  for (const button of root.querySelectorAll('[data-side]')) {
    button.onclick = () => {
      const side = text(button.getAttribute('data-side'));
      if (!SIDES.some((entry) => entry.side === side)) return;

      root.setAttribute('data-side', side);
      for (const other of root.querySelectorAll('[data-side]')) {
        other.setAttribute('aria-selected', text(other.getAttribute('data-side')) === side ? 'true' : 'false');
      }
      for (const panel of root.querySelectorAll('[data-panel]')) {
        setHidden(panel, text(panel.getAttribute('data-panel')) !== side);
      }
    };
  }
}

/**
 * 只挂一次同源样式，挂法与 ensureTaskFlowStylesheet 一致。
 *
 * 不写进 index.html：那份文件所有页面共用，这两区的排版进去之后，别的页面改一次
 * 全局样式就可能连带改到这里。按 href 判断是否已存在：每次挂载都会调到，不查就会
 * 每换一条任务多叠一张表。
 */
export function ensureTaskOutputStylesheet(doc) {
  if (!doc || typeof doc.createElement !== 'function') return;
  const head = doc.head || doc.documentElement;
  if (!head) return;
  const href = '/task-detail-output.css';
  if (doc.querySelector('link[href="' + href + '"]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  head.appendChild(link);
}
