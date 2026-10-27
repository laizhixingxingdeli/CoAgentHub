/**
 * 资源页（#/pool）：四角色候选的**只读**投影 + 只读健康抽屉。
 *
 * 这一页只读，是本单的边界：添加/编辑/排序/保存是下一张单。先把读的那一半做对，
 * 是因为这一页最容易出的错都不报错——缺失的尝试次数被显示成 0、没有失败记录被
 * 画成失败、没有复位命令却给一个能按的按钮。屏幕上看起来完全正常，人却据此
 * 判断「这条候选还能用」。所以这里的每个格式化函数都把「未知」和「真实零」
 * 分成两条路走，宁可多一个字符串也不让 Number(null) 那种伪零流进来。
 *
 * 纯函数（喂数据 → 回字符串）与 DOM 分开：浏览器不在测试里，纯函数能直接在
 * node 里喂假健康断言那几格，而这几格恰恰是改一次就悄悄错一次的地方。
 */

import { esc } from './projects.js';

/** 四角色及其中文标签。顺序就是页签顺序，别处的顺序都从这里取。 */
export const RESOURCE_ROLES = [
  ['coordinator', '协调者'],
  ['executor', '执行者'],
  ['independent_reviewer', '独立复核'],
  ['classifier', '分类'],
];

/**
 * 「平台说过话」才算数：''、'  '、null 一律当没说。
 *
 * 直接 `if (value)` 会让 ' ' 这种空白通过，然后页面上出现一句空的「额度说明：」；
 * 而人看不出那是平台没返回还是渲染漏了。
 */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : '';
}

/**
 * 只认真的数字。
 *
 * **先拒绝 null / undefined / ''，再碰 Number**：`Number(null)` 是 0、`Number('')`
 * 也是 0，而这两个值在健康里出现的含义是「平台没上报」，显示成 0 就是凭空宣布
 * 「这条候选试过 0 次、没花过钱」——比空着更容易让人做错判断。
 */
export function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // 整串匹配：'12abc'、'1e3'、' 12' 都不是平台报的数字，不猜。
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 近 7 天那一格的两行：尝试/成功 与 费用。 */
export function weekLines(window7d) {
  const week = window7d && typeof window7d === 'object' ? window7d : {};
  const attempts = finiteNumber(week.attempts);
  const successes = finiteNumber(week.successes);
  const cost = finiteNumber(week.reportedCost);
  return {
    attemptsLine:
      '尝试 ' + (attempts === null ? '未知' : String(attempts))
      + ' · 成功 ' + (successes === null ? '未知' : String(successes)),
    // 真实的 0 是「这周确实没花钱」，要显示 $0；只有拿不到数字才是「未上报」。
    costLine: cost === null ? '费用未上报' : '$' + String(cost),
  };
}

/** 「平台说过话」才算数：''、'  '、null 一律当没说；字面量 'unknown' 也不算。
 *
 * 'unknown' 是服务端的哨兵值，不是一条信息：resolveCandidateLastFailure 在
 * 「没有任何失败记录」时给的正是 `{ failureClass:'unknown', at:null, source:'unknown' }`
 * （见 src/application/candidate-circuit.ts）。把它当成真实字段，一道已经合上的
 * 熔断就会被画成「最近失败：unknown」——人以为自己漏看了一条失败，去追一个不存在的事件。
 */
function meaningful(value) {
  const text = nonEmpty(value);
  return text && text !== 'unknown' ? text : '';
}

/** 熔断那一格。tone 只取 green/amber/red/unknown，颜色由 CSS 映射到令牌。 */
export function circuitLines(health) {
  if (!health || typeof health !== 'object') {
    return { primary: '未知', secondary: '健康未返回', tone: 'unknown' };
  }
  const circuit = health.circuit && typeof health.circuit === 'object' ? health.circuit : {};
  const state = typeof circuit.state === 'string' ? circuit.state : '';
  if (state === 'closed') {
    // 关着就是正常。**不**因为还留着一条 lastFailure 就画成失败：
    // 上一次失败修好之后那条记录还在，把它当现状会让人天天看到一片红。
    return { primary: '正常', secondary: '', tone: 'green' };
  }
  if (state === 'open') {
    return { primary: '熔断', secondary: nonEmpty(circuit.failureClass), tone: 'red' };
  }
  if (state === 'half_open') {
    return { primary: '试探中', secondary: nonEmpty(circuit.failureClass), tone: 'amber' };
  }
  return {
    primary: '未知',
    secondary: nonEmpty(circuit.reason) || '健康未返回',
    tone: 'unknown',
  };
}

/** 健康抽屉里的「最近失败」一行。 */
export function failureDetail(health) {
  if (!health || typeof health !== 'object') return '最近失败：未知';
  const circuit = health.circuit && typeof health.circuit === 'object' ? health.circuit : {};
  const last = health.lastFailure && typeof health.lastFailure === 'object' ? health.lastFailure : {};
  const at = meaningful(last.at);
  const source = meaningful(last.source);
  const failureClass = meaningful(last.failureClass);
  if (circuit.state === 'closed') {
    // 关着的熔断不需要失败说明：上一次的修复已经让它合上了。
    if (!at && !source && !failureClass) return '最近失败：无失败记录';
  }
  if (!at && !failureClass) return '最近失败：未知';
  return '最近失败：' + [at, failureClass || '未知'].filter(Boolean).join(' · ');
}

/** resetAt → 「M/D」；解析不了就把原始字符串还回去，不吞掉平台给的信息。 */
function resetAtText(value) {
  const raw = nonEmpty(value);
  if (!raw) return '';
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return raw;
  const date = new Date(time);
  return date.getMonth() + 1 + '/' + date.getDate();
}

/**
 * 健康抽屉里的「额度说明」一行。
 *
 * quotaReason 是服务端写好的整句：窗口自动重置 vs 人工复位已经在原文里分开了，
 * 这里改写等于再抄一份会过期的措辞。没有 remainingPercent 也不要画成 0%——
 * 「额度未知」和「额度用完了」是两个完全不同的下一步。
 */
export function quotaDetail(health) {
  if (health && typeof health === 'object') {
    const reason = nonEmpty(health.quotaReason);
    if (reason) return reason;
    const usage = health.usage && typeof health.usage === 'object' ? health.usage : null;
    const remaining = usage ? finiteNumber(usage.remainingPercent) : null;
    if (remaining !== null) {
      const reset = resetAtText(usage.resetAt);
      return '额度说明：剩 ' + remaining + '%' + (reset ? ' · ' + reset + ' 重置' : '');
    }
  }
  return '额度说明：平台未返回';
}

/** 占用那一格：只有明确的 true/false 才算知道，别把「没上报」画成空闲。 */
export function occupancyLine(health) {
  const runtime = health && typeof health === 'object' && health.runtime && typeof health.runtime === 'object'
    ? health.runtime
    : {};
  if (runtime.running === true) {
    const hopId = nonEmpty(runtime.hopId);
    return '运行中' + (hopId ? ' · ' + hopId : '');
  }
  if (runtime.running === false) return '空闲';
  return '未知';
}

/**
 * 配置行 × 健康行。只遍历配置：健康里多出来的 profileId 不进表——
 * 那条候选不在这个角色的配置里，画出来等于它还能被调度。
 */
export function joinRoleRows(configRows, healthRows) {
  const configs = Array.isArray(configRows) ? configRows : [];
  const healths = Array.isArray(healthRows) ? healthRows : [];
  return configs.map((row) => {
    const candidate = row && typeof row === 'object' ? row : {};
    const match = healths.find(
      (item) => item && typeof item === 'object' && item.profileId === candidate.profileId,
    );
    return {
      profileId: candidate.profileId,
      endpoint: candidate.endpoint,
      // 缺省即启用是服务端的默认语义，这里只照它显示，不改配置。
      enabled: candidate.enabled === false ? false : true,
      health: match && typeof match === 'object' ? match : null,
    };
  });
}

/** 复位命令块。没有命令就禁用，并说清是平台没给，而不是让人以为自己漏看了。 */
export function resetCommandView(health) {
  const command = health && typeof health === 'object' ? nonEmpty(health.resetCommand) : '';
  if (command) return { command, text: command, disabled: false };
  return { command: '', text: '平台未提供复位命令', disabled: true };
}

/**
 * 复制复位命令。**只复制**：真正执行复位是「人确认充值完了」之后的动作，
 * 页面自己发一次等于把熔断开关交给一个还没充值的额度。
 *
 * 空命令不交给 writeText：剪贴板里会留下上一次的内容，人以为复制成功了。
 */
export async function copyResetCommand(command, writeText) {
  if (typeof command !== 'string' || command.trim() === '') return { ok: false, status: 'disabled' };
  try {
    await writeText(command);
    return { ok: true, status: 'copied' };
  } catch {
    return { ok: false, status: 'failed' };
  }
}

const COLUMNS = ['顺序', '候选 / endpoint', '启用', '熔断', '近 7 天', '额度', '占用'];

function roleLabelOf(role) {
  const hit = RESOURCE_ROLES.find(([id]) => id === role);
  return hit ? hit[1] : RESOURCE_ROLES[0][1];
}

function countOf(counts, id) {
  const value = counts && typeof counts === 'object' ? counts[id] : undefined;
  return Number.isFinite(value) ? value : 0;
}

/** 长 profileId 中间省略：头尾是分辨两条同前缀候选的唯一线索。 */
function shortId(id) {
  return id.length > 48 ? id.slice(0, 20) + '…' + id.slice(-12) : id;
}

function quotaCellText(health) {
  if (!health || typeof health !== 'object') return '未知';
  const reason = nonEmpty(health.quotaReason);
  if (reason) return reason;
  const usage = health.usage && typeof health.usage === 'object' ? health.usage : {};
  const remaining = finiteNumber(usage.remainingPercent);
  return remaining === null ? '未知' : '剩 ' + remaining + '%';
}

function rowHtml(row, index, selectedProfileId) {
  const candidate = row && typeof row === 'object' ? row : {};
  const profileId = nonEmpty(candidate.profileId);
  const circuit = circuitLines(candidate.health);
  const week = weekLines(candidate.health && candidate.health.window7d);
  const endpoint = nonEmpty(candidate.endpoint);
  return '<div class="resource-row" data-resource-row="' + esc(profileId) + '"'
    + (selectedProfileId && selectedProfileId === profileId ? ' data-selected="1"' : '') + '>'
    + '<span class="resource-col" data-col="1">' + esc(String(index + 1)) + '</span>'
    + '<span class="resource-col" data-col="2">'
    +   '<span class="resource-cell console-data" title="' + esc(profileId) + '">' + esc(shortId(profileId)) + '</span>'
    +   '<span class="resource-sub console-body">' + esc(endpoint) + '</span>'
    + '</span>'
    + '<span class="resource-col" data-col="3">' + (candidate.enabled === false ? '停用' : '启用') + '</span>'
    + '<span class="resource-col" data-col="4">'
    +   '<span class="resource-cell resource-tone-' + esc(circuit.tone) + '">' + esc(circuit.primary) + '</span>'
    +   '<span class="resource-sub console-body">' + esc(circuit.secondary) + '</span>'
    + '</span>'
    + '<span class="resource-col" data-col="5">'
    +   '<span class="resource-cell console-body">' + esc(week.attemptsLine) + '</span>'
    +   '<span class="resource-sub console-body">' + esc(week.costLine) + '</span>'
    + '</span>'
    + '<span class="resource-col" data-col="6">'
    +   '<span class="resource-cell console-body">' + esc(quotaCellText(candidate.health)) + '</span>'
    + '</span>'
    + '<span class="resource-col" data-col="7">'
    +   '<span class="resource-cell console-body">' + esc(occupancyLine(candidate.health)) + '</span>'
    + '</span>'
    + '</div>';
}

function saveBarHtml(label, revision) {
  // 本单没有草稿：摘要写「没有未保存修改」，按钮先禁用（保存是下一张单）。
  // 文案不说「已保存，将打断进行中的 Attempt」——保存只影响以后调度，不打断在途的。
  return '<div class="resource-savebar" data-resource-save>'
    + '<div class="resource-save-summary">'
    +   '<span class="resource-save-title console-body">没有未保存修改</span>'
    +   '<span class="resource-sub console-body">' + esc(label + ' · 修订 ' + (revision || '未知')) + '</span>'
    + '</div>'
    + '<div class="resource-save-actions">'
    +   '<button type="button" class="resource-primary" data-resource-save-button disabled>'
    +     '<span class="resource-primary-face console-body">保存整个角色</span>'
    +   '</button>'
    +   '<button type="button" class="resource-button" data-resource-discard disabled>放弃草稿</button>'
    + '</div>'
    + '</div>';
}

function drawerHtml(row) {
  const profileId = nonEmpty(row.profileId);
  const health = row.health;
  const circuit = circuitLines(health);
  const command = resetCommandView(health);
  // 只读：没有删除按钮，也没有可改 profileId 的输入框——编辑是下一张单，
  // 现在就给出控件等于让人以为改了会生效。
  return '<aside class="resource-drawer" data-resource-drawer>'
    + '<div class="resource-drawer-title console-data">' + esc(profileId) + '</div>'
    + '<div class="resource-sub console-body">runtime：pi</div>'
    + '<div class="resource-drawer-heading console-body">健康详情（只读）</div>'
    + '<div class="resource-drawer-line console-body resource-tone-' + esc(circuit.tone) + '">'
    +   esc(circuit.primary) + '</div>'
    + '<div class="resource-sub console-body">' + esc(failureDetail(health)) + '</div>'
    + '<div class="resource-sub console-body">' + esc(quotaDetail(health)) + '</div>'
    + '<div class="resource-sub console-body">平台给出的复位命令原文</div>'
    + '<div class="resource-command console-data" data-reset-command>' + esc(command.text) + '</div>'
    + '<div><button type="button" class="resource-button" data-copy-reset'
    +   (command.disabled ? ' disabled' : '') + '>复制命令</button></div>'
    + '</aside>';
}

/**
 * 页面 HTML。vm = `{ role, revision, configError, healthError, counts, rows, selectedProfileId }`。
 *
 * counts 用调用方给的数字：写死 8/4/0/0 会在接入真实池之后仍然显示样例值，
 * 而那种错没人会当成 bug 报（数字看起来总是合理的）。
 */
export function resourcePageHtml(vm) {
  const state = vm && typeof vm === 'object' ? vm : {};
  const role = RESOURCE_ROLES.some(([id]) => id === state.role) ? state.role : RESOURCE_ROLES[0][0];
  const label = roleLabelOf(role);
  const revision = typeof state.revision === 'string' ? state.revision : '';
  const configError = nonEmpty(state.configError);
  const healthError = nonEmpty(state.healthError);
  const rows = Array.isArray(state.rows) ? state.rows : [];
  const selectedProfileId = nonEmpty(state.selectedProfileId);
  const selectedRow = selectedProfileId
    ? rows.find((row) => row && nonEmpty(row.profileId) === selectedProfileId)
    : null;

  const tabs = RESOURCE_ROLES.map(([id, name]) =>
    '<button type="button" class="resource-tab console-body" data-resource-role="' + esc(id) + '"'
    + (id === role ? ' data-active="1"' : '') + '>'
    + esc(name + ' ' + countOf(state.counts, id)) + '</button>').join('');
  const head = COLUMNS.map((name, index) =>
    '<span class="resource-col" data-col="' + (index + 1) + '">' + esc(name) + '</span>').join('');

  // rows 为空就是空角色：空态文案照写（即使配置读失败也写，错误行在它上面，
  // 两句话一起读才是全文）。**不**在这里伪造任何一行：那是拿样例候选顶替一次失败的读取。
  const body = rows.length
    ? rows.map((row, index) => rowHtml(row, index, selectedProfileId)).join('')
    : '<p class="resource-empty console-body" data-resource-empty>候选为空，该角色无法调度；为空不等于可以自审。</p>';

  return '<section class="resource-console" data-resource-page>'
    + '<h1 class="fixed-page-title">模型资源</h1>'
    + '<div class="resource-tabs">' + tabs + '</div>'
    + '<div class="resource-toolbar">'
    +   '<button type="button" class="resource-button" data-resource-add disabled>添加候选</button>'
    +   '<span class="resource-sub console-body" data-resource-revision>'
    +     esc(revision ? '配置修订 ' + revision : '配置修订 未知') + '</span>'
    + '</div>'
    + (configError
      ? '<p class="resource-error console-body" data-resource-config-error>' + esc(configError) + '</p>'
      : '')
    + (healthError
      ? '<p class="resource-error console-body" data-resource-health-error>' + esc(healthError) + '</p>'
      : '')
    + '<div class="resource-table">'
    +   '<div class="resource-head console-body">' + head + '</div>'
    +   '<div class="resource-body">' + body + '</div>'
    + '</div>'
    + (rows.length ? saveBarHtml(label, revision) : '')
    + (selectedRow ? drawerHtml(selectedRow) : '')
    + '</section>';
}

/** 样式与页面同源：从模块里挂，index.html 不引（见 ensureResourceStylesheet）。 */
const STYLESHEET_HREF = '/resource-console.css';

function ensureResourceStylesheet() {
  if (typeof document === 'undefined') return;
  if (document.querySelector('link[data-resource-console]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLESHEET_HREF;
  link.dataset.resourceConsole = '1';
  document.head.appendChild(link);
}

let mounted = null;

function stopMounted() {
  if (!mounted) return;
  try {
    mounted.stop();
  } finally {
    mounted = null;
  }
}

/** 本单没有草稿：离开不需要确认。在飞请求要收掉，否则晚到的响应会画进别人的容器。 */
export function leaveResourcePage() {
  stopMounted();
  return true;
}

/** 失败原因分两类不合并：HTTP 状态说明服务活着但这一页读不出来，其余说明连不上。 */
function messageOf(reason) {
  return nonEmpty(reason && reason.message) || '读取失败';
}

/**
 * 挂载资源页。
 *
 * config 与健康并行取：串行会把「一页两份数据」变成两倍等待，而这两份互不依赖。
 * 健康失败**不清空**配置：那会让一次健康抖动把四角色画成空角色，人以为配置没了。
 */
export async function renderResourcePage(container) {
  if (mounted && mounted.root && mounted.root.isConnected) return;
  stopMounted();
  ensureResourceStylesheet();

  const root = document.createElement('div');
  container.replaceChildren(root);
  const controller = new AbortController();
  const state = {
    role: RESOURCE_ROLES[0][0],
    revision: '',
    config: null,
    health: null,
    configError: '',
    healthError: '',
    counts: {},
    selectedProfileId: '',
  };

  const viewModel = () => {
    const role = state.role;
    const configRows = state.config && Array.isArray(state.config[role]) ? state.config[role] : [];
    const healthRows = state.health && Array.isArray(state.health[role]) ? state.health[role] : [];
    return {
      role,
      revision: state.revision,
      configError: state.configError,
      healthError: state.healthError,
      counts: state.counts,
      rows: joinRoleRows(configRows, healthRows),
      selectedProfileId: state.selectedProfileId,
    };
  };
  const paint = () => {
    if (root.isConnected) root.innerHTML = resourcePageHtml(viewModel());
  };
  const readJson = async (path) => {
    const response = await fetch(path, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  };

  mounted = { stop: () => controller.abort(), root };
  root.innerHTML = '<div class="resource-console-loading console-body">加载中…</div>';

  const [configResult, healthResult] = await Promise.allSettled([
    readJson('/api/pools/config'),
    readJson('/api/pools'),
  ]);
  if (controller.signal.aborted) return;

  if (configResult.status === 'fulfilled') {
    const config = configResult.value && typeof configResult.value === 'object' ? configResult.value : {};
    state.config = config;
    state.revision = typeof config.revision === 'string'
      ? config.revision
      : (Number.isFinite(config.revision) ? String(config.revision) : '');
    // 页签计数是数组长度，不是健康数值：它回答「这个角色配了几条」。
    state.counts = Object.fromEntries(RESOURCE_ROLES.map(
      ([id]) => [id, Array.isArray(config[id]) ? config[id].length : 0],
    ));
    state.configError = '';
  } else {
    // 不清 state.config：已经读到的配置比一句错误更有用，下次重画还在。
    state.configError = messageOf(configResult.reason);
  }

  if (healthResult.status === 'fulfilled') {
    state.health = healthResult.value && typeof healthResult.value === 'object' ? healthResult.value : {};
    state.healthError = '';
  } else {
    state.healthError = messageOf(healthResult.reason);
  }
  paint();

  root.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const roleButton = target.closest('[data-resource-role]');
    if (roleButton) {
      const role = roleButton.getAttribute('data-resource-role');
      if (RESOURCE_ROLES.some(([id]) => id === role)) {
        state.role = role;
        state.selectedProfileId = '';
        paint();
      }
      return;
    }

    const copyButton = target.closest('[data-copy-reset]');
    if (copyButton) {
      if (copyButton.disabled) return;
      const row = viewModel().rows.find(
        (item) => item && item.profileId === state.selectedProfileId,
      );
      const command = resetCommandView(row ? row.health : null);
      // 只改按钮文字，不重画：重画会把这一次的「已复制 / 复制失败」擦掉。
      const result = await copyResetCommand(
        command.command,
        (text) => navigator.clipboard.writeText(text),
      );
      if (result.status === 'copied') copyButton.textContent = '已复制';
      else if (result.status === 'failed') copyButton.textContent = '复制失败';
      return;
    }

    const rowElement = target.closest('[data-resource-row]');
    if (rowElement) {
      state.selectedProfileId = rowElement.getAttribute('data-resource-row') || '';
      paint();
    }
  });
}
