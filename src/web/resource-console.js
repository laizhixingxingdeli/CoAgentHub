/**
 * 资源页（#/pool）：四角色候选的投影 + 健康抽屉 + 本角色草稿编辑。
 *
 * 这一页最容易出的错都不报错——缺失的尝试次数被显示成 0、没有失败记录被
 * 画成失败、没有复位命令却给一个能按的按钮。屏幕上看起来完全正常，人却据此
 * 判断「这条候选还能用」。所以这里的每个格式化函数都把「未知」和「真实零」
 * 分成两条路走，宁可多一个字符串也不让 Number(null) 那种伪零流进来。
 *
 * 草稿的边界：启停/排序/改 endpoint/加参数/加候选**只改本地草稿**，整页只有
 * 「保存整个角色」一个 POST，且只在人点它时才发。逐控件即时保存的后果是：一次
 * 手滑就把整个角色的调度顺序写到线上，而屏幕上看起来只是点了一下「下移」。
 * saved 只在保存成功后才会变；保存只影响以后的调度，不打断在途的 Attempt。
 *
 * 纯函数（喂数据 → 回字符串/新草稿）与 DOM 分开：浏览器不在测试里，纯函数能
 * 直接在 node 里喂假健康、假草稿断言那几格，而这几格恰恰是改一次就悄悄错一次
 * 的地方。
 */

import { esc } from './projects.js';
// 候选形状与排序只在 model-priority.js 里定义一次：这两页写的是同一份配置，
// 各抄一份「复制候选」和「交换两行」之后，两边迟早对同一行做出不同的事。
import { candidateConfig, moveCandidate } from './model-priority.js';

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

/* ===== 草稿（纯函数） =====
 * 全部返回**新**草稿，不原地改。原地改的后果不是报错，而是「放弃草稿」再也还原
 * 不回去：saved 和 drafts 指向同一个数组，撤销时两个都已经是改完的样子。
 */

function asDrafts(drafts) {
  return drafts && typeof drafts === 'object' ? drafts : {};
}

/** 缺失的 role 一律当空数组：空角色也要能加第一条草稿。 */
function roleRows(drafts, role) {
  const rows = asDrafts(drafts)[role];
  return Array.isArray(rows) ? rows : [];
}

/** 只替换这一个 role 的数组，其余 role 的引用原样带过去（它们没被改）。 */
function withRole(drafts, role, rows) {
  return { ...asDrafts(drafts), [role]: rows };
}

/**
 * 抽屉里 endpoint 下拉的选项：只取这个角色配置里**真实出现**的 endpoint。
 *
 * 不内置任何候选端点目录。编一个 'local' 或一份「常见端点表」出去，接口一改
 * 人就会以为那条端点存在、存下去才发现调度永远失败；而屏幕上它和其他选项长得一样。
 */
export function endpointOptions(configRows) {
  const rows = Array.isArray(configRows) ? configRows : [];
  const options = [];
  for (const row of rows) {
    const endpoint = row && typeof row === 'object' ? nonEmpty(row.endpoint) : '';
    if (endpoint && !options.includes(endpoint)) options.push(endpoint);
  }
  return options;
}

/** 停用/启用。缺省即启用（服务端默认语义），所以 undefined 先落到 false。 */
export function toggleDraftCandidate(drafts, role, index) {
  const rows = roleRows(drafts, role);
  const target = rows[index];
  if (!target || typeof target !== 'object') return withRole(drafts, role, rows);
  const enabled = target.enabled !== false ? false : true;
  return withRole(drafts, role, rows.map(
    (row, i) => (i === index ? { ...row, enabled } : row),
  ));
}

/** 上移/下移复用 moveCandidate：越界时它原样返回，不抛错。 */
export function moveDraftCandidate(drafts, role, index, direction) {
  return withRole(drafts, role, moveCandidate(roleRows(drafts, role), index, direction));
}

/**
 * 只接受 endpoint 与 facts 两个字段。
 *
 * **白的而不是黑名单**：profileId 是候选的身份（健康、熔断、审计全按它匹配），
 * runtime 由平台固定为 pi。允许从界面写这两个字段，等于让一次粘贴把配置指到另
 * 一处运行时上，而列表里那条候选看起来没变。order 也不接受：顺序只由数组位置表达。
 */
export function updateDraftCandidate(drafts, role, index, patch) {
  const rows = roleRows(drafts, role);
  const target = rows[index];
  if (!target || typeof target !== 'object') return withRole(drafts, role, rows);
  const source = patch && typeof patch === 'object' ? patch : {};
  const next = { ...target };
  if (typeof source.endpoint === 'string') next.endpoint = source.endpoint;
  // facts 只存字符串键值、原样保留：把它「整理」成已知字段，适配层后来新加的键就丢了。
  if (Array.isArray(source.facts)) {
    next.facts = source.facts.map((fact) => {
      const entry = fact && typeof fact === 'object' ? fact : {};
      return {
        key: typeof entry.key === 'string' ? entry.key : '',
        value: typeof entry.value === 'string' ? entry.value : '',
      };
    });
  }
  return withRole(drafts, role, rows.map((row, i) => (i === index ? next : row)));
}

/**
 * 追加一条草稿。**只进草稿，不发任何请求**。
 *
 * endpoint 是调用方给的自由文本：新候选本来就可能引入新端点，而下拉里只有
 * 配置里已有的端点——只给下拉就永远加不了第一条（空角色一个选项都没有）。
 */
export function addDraftCandidate(drafts, role, input) {
  const source = input && typeof input === 'object' ? input : {};
  const candidate = {
    profileId: typeof source.profileId === 'string' ? source.profileId : '',
    endpoint: typeof source.endpoint === 'string' ? source.endpoint : '',
    enabled: true,
    facts: [],
  };
  return withRole(drafts, role, [...roleRows(drafts, role), candidate]);
}

/** 本角色草稿是否偏离已保存配置。JSON 比较够用：候选是小对象数组，没有循环引用。 */
export function draftDirty(saved, drafts, role) {
  return JSON.stringify(roleRows(saved, role)) !== JSON.stringify(roleRows(drafts, role));
}

/** 任一角色脏。离页保护按全局判断：切到别的页签再离开，那边的改动也不能悄悄丢。 */
export function anyDraftDirty(saved, drafts) {
  return RESOURCE_ROLES.some(([role]) => draftDirty(saved, drafts, role));
}

/**
 * 点击那一瞬间的保存请求：角色、修订、有序候选全部深拷贝冻结下来。
 *
 * 不冻结的后果不是报错，而是把**别的角色**的候选存到这个角色头上：POST 在路上时
 * 人切了页签、又改了两行，响应回来写的就是新角色了。expectedRevision 只认字符串——
 * Number() 会把 '007' 变成 7，而服务端 CAS 比的是字符串，两者永远不相等。
 */
export function captureSave(role, revision, candidates) {
  return {
    role,
    expectedRevision: typeof revision === 'string' ? revision : '',
    candidates: structuredClone(Array.isArray(candidates) ? candidates : []),
  };
}

/**
 * 只发一次 POST，body 只有 expectedRevision 与 candidates。
 *
 * 逐候选 POST 会在半路失败时留下一个「只改了一半」的角色，而那时它已经在调度了；
 * 一次提交要么整角色换掉，要么一个字节都没动。
 */
export async function postConfigure(fetchImpl, captured, signal) {
  const response = await fetchImpl('/api/pools/' + captured.role + '/configure', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: captured.expectedRevision,
      candidates: captured.candidates,
    }),
    signal,
  });
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  return { ok: response.ok, status: response.status, body };
}

/**
 * 成功响应带的是**全池快照**：四个角色一起换，revision 也换。
 *
 * 只把被保存的角色对齐快照是不够的：页签计数、别的角色的 diff 基线都来自 saved，
 * 留着旧的那份，下一次保存就会拿着过期的基线算出「没改过」。同时**不能**把其他
 * 角色的脏草稿一起覆盖掉——人手里那份改动还没交，快照只是服务端此刻的样子。
 * 所以只有「被保存的角色」和「提交前本来就干净的角色」跟随快照，脏的保留原样。
 */
export function applyConfigureSuccess(saved, drafts, body, savedRole) {
  const snapshot = body && typeof body === 'object' ? body : {};
  const nextSaved = {};
  const nextDrafts = { ...drafts };
  for (const [role] of RESOURCE_ROLES) {
    const rows = Array.isArray(snapshot[role]) ? snapshot[role].map(candidateConfig) : [];
    const clean = JSON.stringify(roleRows(saved, role)) === JSON.stringify(roleRows(drafts, role));
    nextSaved[role] = rows;
    nextDrafts[role] = (role === savedRole || clean) ? structuredClone(rows) : roleRows(drafts, role);
  }
  return {
    revision: typeof snapshot.revision === 'string' ? snapshot.revision : '',
    saved: nextSaved,
    drafts: nextDrafts,
  };
}

/** 放弃草稿只还原本角色：把别的角色一起还原，等于替人丢掉他还没交的改动。 */
export function discardRoleDraft(saved, drafts, role) {
  return withRole(drafts, role, structuredClone(roleRows(saved, role)));
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

/**
 * 保存条。flags = { busy, conflict, message, latest }，缺省全空。
 *
 * 只有**修订冲突**（STALE_POOL）才禁用保存：那是「你不知道最新是什么，再提也是白提」。
 * 其余失败（比如重复 profileId）是人自己能改的，禁掉保存反而把人卡在一个改不了
 * 的地方。冲突时保存虽然禁用，但草稿一直留着、也一直显示着——不能因为一次冲突
 * 就把人刚敲的东西抹掉，更不能拿到最新就自动写回。
 */
function saveBarHtml(label, revision, dirty, role, flags) {
  const view = flags && typeof flags === 'object' ? flags : {};
  const busy = view.busy === true;
  const conflict = view.conflict === true;
  const message = typeof view.message === 'string' ? view.message : '';
  const latest = view.latest && typeof view.latest === 'object' ? view.latest : null;
  const saveDisabled = busy || conflict || !dirty;
  const discardDisabled = busy || !dirty;
  return '<div class="resource-savebar" data-resource-save'
    + (dirty ? ' data-dirty="1"' : '') + '>'
    + '<div class="resource-save-summary">'
    +   '<span class="resource-save-title console-body" data-resource-save-title>'
    +     (dirty ? '有未保存修改' : '没有未保存修改') + '</span>'
    +   '<span class="resource-sub console-body">' + esc(label + ' · 修订 ' + (revision || '未知')) + '</span>'
    + '</div>'
    + '<div class="resource-save-actions">'
    +   '<button type="button" class="resource-primary" data-resource-save-button'
    +     (saveDisabled ? ' disabled' : '') + '>'
    +     '<span class="resource-primary-face console-body">'
    +       (busy ? '保存中…' : '保存整个角色') + '</span>'
    +   '</button>'
    +   '<button type="button" class="resource-button" data-resource-discard'
    +     (discardDisabled ? ' disabled' : '') + '>放弃草稿</button>'
    +   (conflict
      ? '<button type="button" class="resource-button" data-resource-compare>重新读取最新</button>'
      : '')
    + '</div>'
    + (message
      ? '<p class="resource-sub console-body" data-resource-save-message>' + esc(message) + '</p>'
      : '')
    + (latest
      ? '<pre class="resource-command" data-resource-latest>'
      +   esc(JSON.stringify(latest[role] || [], null, 2)) + '</pre>'
      + '<div><button type="button" class="resource-button" data-resource-rebase>'
      +   '已比较，保留草稿重试</button></div>'
      : '')
    + '</div>';
}

/** facts 的每一行：key + value + 删本行。删的是参数，不是候选。 */
function factsHtml(facts) {
  const rows = Array.isArray(facts) ? facts : [];
  return rows.map((fact, index) => {
    const entry = fact && typeof fact === 'object' ? fact : {};
    const key = typeof entry.key === 'string' ? entry.key : '';
    const value = typeof entry.value === 'string' ? entry.value : '';
    return '<div class="resource-fact" data-fact-row="' + index + '">'
      + '<input type="text" class="resource-input console-data" data-fact-key="' + index
      +   '" value="' + esc(key) + '" placeholder="key" aria-label="参数名">'
      + '<input type="text" class="resource-input console-data" data-fact-value="' + index
      +   '" value="' + esc(value) + '" placeholder="value" aria-label="参数值">'
      + '<button type="button" class="resource-button resource-button-small" data-fact-remove="'
      +   index + '">删除本行</button>'
      + '</div>';
  }).join('');
}

/**
 * endpoint 下拉。当前值不在选项里时**补一条带「（缺来源）」的**，而不是把它改写成
 * 集合里的第一个：那会让人以为这条候选用的是别的端点，一保存就真换了端点。
 * 补进来的那条只属于当前候选——它不进 endpointOptions，别的候选的下拉里看不到它。
 */
function endpointSelectHtml(endpoint, options) {
  const current = typeof endpoint === 'string' ? endpoint : '';
  const values = Array.isArray(options) ? options : [];
  const items = values.map((value) => '<option value="' + esc(value) + '"'
    + (value === current ? ' selected' : '') + '>' + esc(value) + '</option>').join('');
  let extra = '';
  if (current !== '' && !values.includes(current)) {
    extra = '<option value="' + esc(current) + '" selected>' + esc(current) + '（缺来源）</option>';
  } else if (current === '') {
    extra = '<option value="" selected>（未设置）</option>';
  }
  return '<select class="resource-input console-data" data-draft-endpoint>' + items + extra + '</select>';
}

/**
 * 候选抽屉：草稿编辑区 + 只读健康详情。
 *
 * candidate 是渲染副本：草稿对象本身不带 health（健康不属于草稿，带进去就会
 * 让「草稿是否脏」跟着健康变化抖）。total 只用来判断上移/下移能不能按。
 * 没有删除候选按钮：删一条候选会改变整角色的调度面，留到单独一单。
 */
function drawerHtml(candidate, options, index, total) {
  const row = candidate && typeof candidate === 'object' ? candidate : {};
  const profileId = nonEmpty(row.profileId);
  const health = row.health;
  const circuit = circuitLines(health);
  const command = resetCommandView(health);
  const enabled = row.enabled !== false;
  return '<aside class="resource-drawer" data-resource-drawer>'
    + '<div class="resource-drawer-title console-data">' + esc(profileId) + '</div>'
    + '<div class="resource-sub console-body">runtime：pi</div>'
    + '<div class="resource-drawer-heading console-body">候选设置（草稿，未下发）</div>'
    + '<div class="resource-field">'
    +   '<span class="resource-sub console-body">profileId（只读）</span>'
    +   '<div class="resource-readonly console-data" data-draft-profile>' + esc(profileId) + '</div>'
    + '</div>'
    + '<div class="resource-field">'
    +   '<span class="resource-sub console-body">endpoint</span>'
    +   endpointSelectHtml(row.endpoint, options)
    + '</div>'
    + '<div class="resource-field">'
    +   '<span class="resource-sub console-body">参数（key / value）</span>'
    +   '<div class="resource-facts">' + factsHtml(row.facts) + '</div>'
    +   '<div><button type="button" class="resource-button" data-fact-add>添加参数</button></div>'
    + '</div>'
    + '<div class="resource-drawer-actions">'
    +   '<button type="button" class="resource-button" data-draft-toggle>'
    +     (enabled ? '停用' : '启用') + '</button>'
    +   '<button type="button" class="resource-button" data-draft-move="-1"'
    +     (index <= 0 ? ' disabled' : '') + '>上移</button>'
    +   '<button type="button" class="resource-button" data-draft-move="1"'
    +     (index >= total - 1 ? ' disabled' : '') + '>下移</button>'
    + '</div>'
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

/** 添加候选表单。endpoint 是自由输入：下拉里只有已有端点，空角色一个都没有。 */
function addFormHtml() {
  return '<div class="resource-addform" data-resource-add-form>'
    + '<label class="resource-field">'
    +   '<span class="resource-sub console-body">profileId</span>'
    +   '<input type="text" class="resource-input console-data" data-add-profile value="">'
    + '</label>'
    + '<label class="resource-field">'
    +   '<span class="resource-sub console-body">endpoint（自由填写）</span>'
    +   '<input type="text" class="resource-input console-data" data-add-endpoint value="">'
    + '</label>'
    + '<div class="resource-addform-actions">'
    +   '<button type="button" class="resource-button" data-add-confirm>确定</button>'
    +   '<button type="button" class="resource-button" data-add-cancel>取消</button>'
    + '</div>'
    + '</div>';
}

/**
 * 页面 HTML。vm = `{ role, revision, configError, healthError, counts, rows,
 * drafts, selected, selectedIndex, endpointOptions, dirty, adding, busy, conflict,
 * message, latest }`。
 *
 * counts 用调用方给的数字：写死 8/4/0/0 会在接入真实池之后仍然显示样例值，
 * 而那种错没人会当成 bug 报（数字看起来总是合理的）。counts 来自**已保存**配置，
 * 不是草稿长度：草稿里加了一条就说这个角色配了两条，页签会先于保存就变，
 * 人以后每次看页签都得想「这数字到底是存下的还是手上的」。
 */
export function resourcePageHtml(vm) {
  const state = vm && typeof vm === 'object' ? vm : {};
  const role = RESOURCE_ROLES.some(([id]) => id === state.role) ? state.role : RESOURCE_ROLES[0][0];
  const label = roleLabelOf(role);
  const revision = typeof state.revision === 'string' ? state.revision : '';
  const configError = nonEmpty(state.configError);
  const healthError = nonEmpty(state.healthError);
  const rows = Array.isArray(state.rows) ? state.rows : [];
  const drafts = Array.isArray(state.drafts) ? state.drafts : [];
  const selectedProfileId = nonEmpty(state.selectedProfileId);
  const selectedIndex = Number.isInteger(state.selectedIndex) ? state.selectedIndex : -1;
  const selected = state.selected && typeof state.selected === 'object' ? state.selected : null;
  const dirty = state.dirty === true;
  // 每角色的 busy/conflict/message/latest：保存中的那个角色禁用按钮，别的角色照常。
  const busy = state.busy === true;
  const conflict = state.conflict === true;
  const message = typeof state.message === 'string' ? state.message : '';
  const latest = state.latest && typeof state.latest === 'object' ? state.latest : null;

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
    +   '<button type="button" class="resource-button" data-resource-add>添加候选</button>'
    +   '<span class="resource-sub console-body" data-resource-revision>'
    +     esc(revision ? '配置修订 ' + revision : '配置修订 未知') + '</span>'
    + '</div>'
    + (configError
      ? '<p class="resource-error console-body" data-resource-config-error>' + esc(configError) + '</p>'
      : '')
    + (healthError
      ? '<p class="resource-error console-body" data-resource-health-error>' + esc(healthError) + '</p>'
      : '')
    + (state.adding === true ? addFormHtml() : '')
    + '<div class="resource-table">'
    +   '<div class="resource-head console-body">' + head + '</div>'
    +   '<div class="resource-body">' + body + '</div>'
    + '</div>'
    // 空角色加了第一条草稿也要有保存条：否则那一条既在抽屉里、又没有「未保存」的提示。
    + (rows.length || drafts.length ? saveBarHtml(label, revision, dirty, role, {
      busy, conflict, message, latest,
    }) : '')
    + (selected ? drawerHtml(selected, state.endpointOptions, selectedIndex, drafts.length) : '')
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

/**
 * 离开资源页。有脏草稿先问一句。
 *
 * 不问就直接走，是本页唯一会「不报错地丢东西」的路径：草稿只存在这个模块的闭包里，
 * 页面一卸载就没了，而人刚在抽屉里改过 endpoint、调过顺序，屏幕上看起来什么都没发生。
 * 签名不带参：app.js 不因为本单改动（确认取消就返回 false，路由就不会卸页）。
 */
export function leaveResourcePage() {
  if (mounted && typeof mounted.isDirty === 'function' && mounted.isDirty()) {
    if (!window.confirm('资源池有未保存修改，离开将放弃。确认离开？')) return false;
  }
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
    // 每角色一份草稿：-saved 是配置下来的原样，-drafts 是可改的那份。
    // 只维护一份「当前值」就没有放弃草稿可言了。
    saved: {},
    drafts: {},
    adding: false,
    // 每个角色一份保存状态：{ busy, conflict, message, latest }。
    // 按角色存放而不是全局：保存执行者时切到分类，分类的保存按钮不能跟着被禁掉。
    status: {},
  };

  /** 该角色的保存状态，缺省全空：没存过的角色不该带着别人的冲突或错误文案。 */
  const statusOf = (role) => {
    const entry = state.status && typeof state.status[role] === 'object' && state.status[role]
      ? state.status[role]
      : {};
    return {
      busy: entry.busy === true,
      conflict: entry.conflict === true,
      message: typeof entry.message === 'string' ? entry.message : '',
      latest: entry.latest && typeof entry.latest === 'object' ? entry.latest : null,
    };
  };

  const setStatus = (role, next) => {
    state.status = { ...state.status, [role]: { ...statusOf(role), ...next } };
  };

  const currentConfigRows = () => (state.config && Array.isArray(state.config[state.role])
    ? state.config[state.role]
    : []);

  const viewModel = () => {
    const role = state.role;
    const configRows = currentConfigRows();
    const healthRows = state.health && Array.isArray(state.health[role]) ? state.health[role] : [];
    const drafts = Array.isArray(state.drafts[role]) ? state.drafts[role] : [];
    const status = statusOf(role);
    const selectedIndex = state.selectedProfileId
      ? drafts.findIndex((row) => row && row.profileId === state.selectedProfileId)
      : -1;
    const selectedDraft = selectedIndex >= 0 ? drafts[selectedIndex] : null;
    // 草稿里没有健康：健康只属于服务端那一行。摊到草稿上，一次健康刷新就会让
    // 「有未保存修改」自己跳出来。
    const healthOf = (profileId) => {
      const found = joinRoleRows([{ profileId }], healthRows).find((item) => item.health);
      return found ? found.health : null;
    };
    return {
      role,
      revision: state.revision,
      configError: state.configError,
      healthError: state.healthError,
      counts: state.counts,
      // 表格画**草稿**（未保存的顺序/启停/新候选得看得见），健康按 profileId 关联。
      // 只画已保存配置的话，加了一条候选、调了顺序，屏幕上什么都没变——而保存条
      // 已经说「有未保存修改」，两处对不上，人就会去怀疑保存没生效。
      rows: joinRoleRows(drafts, healthRows),
      selectedProfileId: state.selectedProfileId,
      drafts,
      selectedIndex,
      selected: selectedDraft
        ? { ...selectedDraft, health: healthOf(selectedDraft.profileId) }
        : null,
      endpointOptions: endpointOptions(configRows),
      dirty: draftDirty(state.saved, state.drafts, role),
      adding: state.adding,
      busy: status.busy,
      conflict: status.conflict,
      message: status.message,
      latest: status.latest,
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

  // 浏览器关页/刷新走的是 beforeunload，不经过路由：只做 leaveResourcePage 的确认
  // 等于把「直接关页签」这条最常见的丢草稿路径漏掉。与 model-priority.js 同一套写法。
  const unload = (event) => {
    if (!anyDraftDirty(state.saved, state.drafts)) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', unload);

  // isDirty 挂在挂载对象上：leaveResourcePage 是模块级的，只能经由它问到草稿状态。
  mounted = {
    stop: () => {
      window.removeEventListener('beforeunload', unload);
      controller.abort();
    },
    isDirty: () => anyDraftDirty(state.saved, state.drafts),
    root,
  };
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
    // 四角色一次性都建好：切角色时才建草稿的话，先改协调者再切到执行者，
    // 执行者的 saved 就只剩「空」——一比对就凭空多出一堆脏，离页提示跟着报错。
    state.saved = {};
    state.drafts = {};
    for (const [id] of RESOURCE_ROLES) {
      const rows = Array.isArray(config[id]) ? config[id] : [];
      state.saved[id] = rows.map(candidateConfig);
      // 深拷贝：省这一步，「放弃草稿」时 drafts 和 saved 是同一批对象，改了就回不去。
      state.drafts[id] = structuredClone(state.saved[id]);
    }
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

  // 草稿编辑全走这一条：只改本地草稿并重画。**这里不发任何请求**——启停、排序、
  // 改 endpoint 都是即时生效的写操作，一跳过一个控就 POST 一次，一次手滑就把
  // 整个角色的调度顺序写到线上。下发只有保存条上那一个按钮。
  const applyDraft = (nextDrafts) => {
    state.drafts = nextDrafts;
    paint();
  };
  const draftIndexOf = (profileId) => {
    const drafts = Array.isArray(state.drafts[state.role]) ? state.drafts[state.role] : [];
    return drafts.findIndex((row) => row && row.profileId === profileId);
  };
  const factsOfTarget = () => {
    const drafts = Array.isArray(state.drafts[state.role]) ? state.drafts[state.role] : [];
    const index = draftIndexOf(state.selectedProfileId);
    const target = index >= 0 ? drafts[index] : null;
    return Array.isArray(target && target.facts) ? target.facts : [];
  };
  const setFacts = (facts) => {
    const index = draftIndexOf(state.selectedProfileId);
    if (index < 0) return;
    applyDraft(updateDraftCandidate(state.drafts, state.role, index, { facts }));
  };

  root.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const roleButton = target.closest('[data-resource-role]');
    if (roleButton) {
      const role = roleButton.getAttribute('data-resource-role');
      if (RESOURCE_ROLES.some(([id]) => id === role)) {
        state.role = role;
        state.selectedProfileId = '';
        state.adding = false;
        paint();
      }
      return;
    }

    // 下面四个按钮都在行选择之前处理：行选择会改 state.selectedProfileId 并重画，
    // 保存分支落到那里就已经错过了本次点击该做的事。
    //
    // 保存：整个角色一次提交。role 在**点击时**就冻结进 captured，后面全部用
    // captured.role 写回：POST 在路上时人切了页签，用 await 之后的 state.role
    // 就会把协调者的结果写到执行者头上，而屏幕上看起来只是两次正常操作。
    if (target.closest('[data-resource-save-button]')) {
      const role = state.role;
      const status = statusOf(role);
      if (!draftDirty(state.saved, state.drafts, role) || status.busy || status.conflict) return;
      const captured = captureSave(role, state.revision, state.drafts[role]);
      setStatus(role, { busy: true, conflict: false, message: '保存中…', latest: null });
      paint();
      let result;
      try {
        result = await postConfigure(fetch, captured, controller.signal);
      } catch (error) {
        // 离页/切页导致的中断不是失败：报一句错会让人以为配置没存上。
        if (controller.signal.aborted) return;
        setStatus(captured.role, { busy: false, message: messageOf(error) });
        paint();
        return;
      }
      if (!result.ok && result.status === 409 && result.body.error === 'STALE_POOL') {
        // 只有修订过期才禁用保存：drafts/saved/revision 全部不动，也不自动读最新。
        // 自动读并覆盖等于替人丢掉手上的改动，而那正是他刚敲进去的东西。
        setStatus(captured.role, {
          busy: false,
          conflict: true,
          message: nonEmpty(result.body.message) || '修订已过期，请重新读取最新配置',
        });
        paint();
        return;
      }
      if (!result.ok) {
        // 其他 409（比如重复 profileId）是人能自己改的：说清原因，草稿与修订都不动，
        // 保存保持可点。禁掉会把人卡在一个他改不了的地方。
        setStatus(captured.role, {
          busy: false,
          conflict: false,
          message: nonEmpty(result.body.message) || ('保存失败：HTTP ' + result.status),
        });
        paint();
        return;
      }
      const next = applyConfigureSuccess(state.saved, state.drafts, result.body, captured.role);
      const snapshot = result.body && typeof result.body === 'object' ? result.body : {};
      state.revision = next.revision;
      state.saved = next.saved;
      state.drafts = next.drafts;
      // config 只带新 revision：它是 endpoint 选项的来源，过期就会画出一份不存在的端点。
      state.config = { ...snapshot, revision: next.revision };
      // 页签计数来自**已保存**配置：草稿长度会让没存上的候选先占一格数。
      state.counts = Object.fromEntries(RESOURCE_ROLES.map(
        ([id]) => [id, Array.isArray(next.saved[id]) ? next.saved[id].length : 0],
      ));
      setStatus(captured.role, {
        busy: false,
        conflict: false,
        latest: null,
        message: '已保存，只影响以后的调度，不打断在途 Attempt',
      });
      paint();
      return;
    }

    // 重新读取最新：只把响应当作对比材料存起来。**不**碰 revision、不碰 drafts，
    // conflict 也不清：悄悄换上最新就等于自动替人决定了存什么。
    if (target.closest('[data-resource-compare]')) {
      const role = state.role;
      if (statusOf(role).busy) return;
      try {
        const response = await fetch('/api/pools/config', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const latest = await response.json();
        setStatus(role, {
          latest: latest && typeof latest === 'object' ? latest : {},
          message: '已读取最新配置，草稿仍保留。比较后再重试。',
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setStatus(role, { message: '读取最新失败：' + messageOf(error) });
      }
      paint();
      return;
    }

    // 已比较、保留草稿重试：只把 CAS 基线换成最新修订，**不发 POST**。
    // 自动写回等于把一次冲突变成一次无人的覆盖，而人根本没看到差异。
    if (target.closest('[data-resource-rebase]')) {
      const role = state.role;
      const latest = statusOf(role).latest;
      if (!latest || typeof latest.revision !== 'string') return;
      state.revision = latest.revision;
      setStatus(role, { conflict: false, latest: null, message: '草稿保留，请重新保存。' });
      paint();
      return;
    }

    // 放弃草稿：只还原本角色。四个角色一起还原，等于替人丢掉他还没交的另外三份改动。
    if (target.closest('[data-resource-discard]')) {
      const role = state.role;
      if (statusOf(role).busy) return;
      state.drafts = discardRoleDraft(state.saved, state.drafts, role);
      state.status = { ...state.status, [role]: {} };
      paint();
      return;
    }

    // 添加候选：空角色也要能加第一条，所以表单不看当前行数。
    if (target.closest('[data-resource-add]')) {
      state.adding = true;
      paint();
      return;
    }
    if (target.closest('[data-add-cancel]')) {
      state.adding = false;
      paint();
      return;
    }
    const addConfirm = target.closest('[data-add-confirm]');
    if (addConfirm) {
      const form = addConfirm.closest('[data-resource-add-form]');
      const profileId = form && form.querySelector('[data-add-profile]')
        ? form.querySelector('[data-add-profile]').value.trim()
        : '';
      const endpoint = form && form.querySelector('[data-add-endpoint]')
        ? form.querySelector('[data-add-endpoint]').value.trim()
        : '';
      // 空 profileId 加进去就是一条永远不会被调度、也无法在列表里认出来的行。
      if (!profileId) {
        addConfirm.textContent = '请填 profileId';
        return;
      }
      state.drafts = addDraftCandidate(state.drafts, state.role, { profileId, endpoint });
      state.adding = false;
      // 加完就选中新的那条：不选中的话，抽屉还停在上一条上，人刚填的 endpoint 就看不见了，
      // 看起来像没加上。
      state.selectedProfileId = profileId;
      paint();
      return;
    }

    if (target.closest('[data-draft-toggle]')) {
      const index = draftIndexOf(state.selectedProfileId);
      if (index >= 0) applyDraft(toggleDraftCandidate(state.drafts, state.role, index));
      return;
    }

    const moveButton = target.closest('[data-draft-move]');
    if (moveButton) {
      if (moveButton.disabled) return;
      const index = draftIndexOf(state.selectedProfileId);
      const direction = Number(moveButton.getAttribute('data-draft-move'));
      if (index >= 0 && Number.isFinite(direction)) {
        applyDraft(moveDraftCandidate(state.drafts, state.role, index, direction));
      }
      return;
    }

    // 删的是参数行，不是候选：删候选会改变整个角色的调度面，本单不做。
    const factRemove = target.closest('[data-fact-remove]');
    if (factRemove) {
      const index = Number(factRemove.getAttribute('data-fact-remove'));
      setFacts(factsOfTarget().filter((_fact, i) => i !== index));
      return;
    }
    if (target.closest('[data-fact-add]')) {
      setFacts([...factsOfTarget(), { key: '', value: '' }]);
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

  // 输入走 change 而不是 input：每敲一个字符就重画会把光标顶掉，
  // 而 endpoint 是人从下拉里选、facts 是一格一格填，change 的粒度刚好。
  root.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const index = draftIndexOf(state.selectedProfileId);
    if (index < 0) return;

    const endpointSelect = target.closest('[data-draft-endpoint]');
    if (endpointSelect) {
      applyDraft(updateDraftCandidate(state.drafts, state.role, index, {
        endpoint: endpointSelect.value,
      }));
      return;
    }

    const factKey = target.closest('[data-fact-key]');
    const factValue = target.closest('[data-fact-value]');
    const field = factKey || factValue;
    if (field) {
      const which = factKey ? 'data-fact-key' : 'data-fact-value';
      const factIndex = Number(field.getAttribute(which));
      const next = factsOfTarget().map((fact, i) => {
        if (i !== factIndex) return fact;
        // 缺 key 的行从下拉里选不中、也认不出来，补成空串让它保持一行而不是消失。
        const entry = { key: typeof fact.key === 'string' ? fact.key : '', value: typeof fact.value === 'string' ? fact.value : '' };
        return factKey ? { ...entry, key: field.value } : { ...entry, value: field.value };
      });
      setFacts(next);
    }
  });
}
