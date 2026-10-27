/**
 * 任务详情页头的纯数据投影：一条 Mission 详情 → 页头那几格事实
 * （完整编号、原始 intent、六态、附标、处理人、恢复方式、保障、协作、费用质量与
 * 实际 cap、时间）。
 *
 * **为什么单开一个纯模块**：页头是「一眼决定要不要动手」的地方，而这里的每一条都
 * 有「看起来对、其实在说谎」的写法——direct 时给主控编一个模型 id、把缺省 costCap
 * 补成 10、终态残留的 waitInfo 翻译成「等你处理」、把 estimated 说成精确金额。做成
 * 纯函数之后，node 里喂假详情就能断言，浏览器里也不必再写第二份。
 *
 * 这个模块**不拼 HTML、不碰 DOM、不读时钟、不发请求**：转义与配色是渲染层的事，
 * 「现在」由调用方传 nowIso 进来。函数内一旦 `new Date()`，同一条数据两次运行会得出
 * 不同的字，测试就没法断言了。
 *
 * **复用而不重写**：六态词、附标、处理人、费用质量这几条判断在
 * console-overview-model.js 里已经有一份（总览行也在用）。这里抄第二份的话，两处
 * 迟早只改到一处，而漏改的那边在界面上就是一句不一样的「等你处理」——且不报错。
 * 补修附标同理，只认 console-overview-enrich.js 的开单声明判据。
 */
import { OVERVIEW_MAIN_CONTROLLER_NOTE, projectOverviewRow } from './console-overview-model.js';
import { explicitRepair } from './console-overview-enrich.js';

const text = (value) => (value === undefined || value === null ? '' : String(value)).trim();
const object = (value) => (value && typeof value === 'object' ? value : null);
const iso = (value) => (value === undefined || value === null ? '' : String(value));

/** 未知就是未知：不补成 0、不补成 false、不补成一句默认话。 */
const UNKNOWN = '未知';

/* ============================ 时间 ============================ */

const pad = (n) => String(n).padStart(2, '0');

/**
 * 时长。**本地一份，不从 task.js import**：task.js 是详情页的渲染模块，它自己会
 * import 本模块（页头要接线），互相 import 就成环——浏览器原生 ES module 下成环
 * 不会报错，只会让某一侧拿到 undefined，然后整页白掉。
 *
 * 两个时间点都由调用方给，函数里不取当前时间，理由见文件头。
 */
function formatDuration(startIso, endIso) {
  const a = Date.parse(iso(startIso));
  const b = Date.parse(iso(endIso));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return UNKNOWN;
  let left = Math.round((b - a) / 1000);
  const days = Math.floor(left / 86400);
  left -= days * 86400;
  const hours = Math.floor(left / 3600);
  left -= hours * 3600;
  const minutes = Math.floor(left / 60);
  const seconds = left - minutes * 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

/**
 * 两格时间。
 *
 * 三条不许越界：
 *   1. **终态的结束时刻是 updatedAt，不是 nowIso**：已完成的任务用「现在」算时长，
 *      数字会随着人盯着屏幕一直变大——一个永远在增长的历史任务，比没有这一格更误导。
 *   2. **缺一边就是「未知」**，不退回 0 也不退回「刚刚」：`options.createdAt` 缺失
 *      （老接口 / 调用方没取事件流）时算不出时长，编一个出来就是假事实。
 *   3. **createdText 只格式化，不猜**：调用方给了 formatTime（详情页按本地时区的
 *      那个）就用它，没给就原样给 ISO——在这里绑一种本地化写法，同一个时间在两个
 *      界面里就会长得不一样。
 */
function projectTime(view, options) {
  const opts = object(options) ?? {};
  const createdAt = iso(opts.createdAt);
  const createdKnown = createdAt !== '' && Number.isFinite(Date.parse(createdAt));

  const createdText = createdKnown
    ? (typeof opts.formatTime === 'function' ? String(opts.formatTime(createdAt)) : createdAt)
    : UNKNOWN;

  // 终态用 view.updatedAt；非终态才用调用方给的「现在」。
  const terminal = text(view.status) === 'completed' || text(view.status) === 'blocked';
  const endedAt = terminal ? iso(view.updatedAt) : iso(opts.nowIso);

  const runningText = createdKnown && endedAt !== '' && Number.isFinite(Date.parse(endedAt))
    ? formatDuration(createdAt, endedAt)
    : UNKNOWN;

  return { createdAt: createdKnown ? createdAt : null, createdText, runningText };
}

/* ============================ 那几格 ============================ */

/** 执行保障：只认创建时选定的 executionMode，不从 origin / workItems 反推。 */
function assuranceText(executionMode) {
  const mode = text(executionMode);
  if (mode === 'standard') return '执行保障：标准';
  if (mode === 'lightweight') return '执行保障：轻量';
  if (mode === 'high_assurance') return '执行保障：高保障';
  return '执行保障：未知';
}

/** 协作方式：与执行保障正交的另一根轴，不合并成一格。 */
function collaborationText(coordinationMode) {
  const mode = text(coordinationMode);
  if (mode === 'hierarchical') return '协作方式：三层';
  if (mode === 'direct') return '协作方式：直接主控';
  return '协作方式：未知';
}

/**
 * 恢复方式。**autoResume 缺省不是 false**：model 层把「没这个字段」投影成 'unknown'，
 * 这里只在真的是布尔时才下断言。补成 false 等于替平台说「不会自动恢复」，
 * 人会去重启一个到点本来会自己接着跑的任务。
 */
function projectRecovery(owner) {
  const autoResume = owner !== null && typeof owner === 'object' ? owner.autoResume : 'unknown';
  const recoveryText = autoResume === true
    ? '会自动恢复'
    : autoResume === false
      ? '不会自动恢复'
      : '自动恢复：未知';
  return { autoResume, text: recoveryText };
}

/**
 * 费用那一格：**质量比数字重要**，上限是不是已知比上限是多少重要。
 *
 * 三条不许越界：
 *   1. **quality === 'unknown' 就是「费用未知」**。usage.cost 上的 0 只是结构默认值，
 *      印成 $0.00 就是「这次不要钱」。
 *   2. **estimated 必须带「部分为估算」**（金额本身带 ≈，由 model 层给），不能冒充
 *      精确值。
 *   3. **cap 缺失写「上限未知」，绝不补 10**。mission 默认 10 是 Standard 新建时的
 *      值，`MissionView.costCap` 缺这一格的意思是「旧快照没落过上限」（
 *      src/application/platform/types.ts），补 10 会画出一条从没生效过的门禁，
 *      人据此判断还要不要增额就错了。
 *
 * direct 时保留 model 层已有的「主控未计」：平台看不见主控会话的模型与费用，
 * 已知的这部分只是执行侧的，不能表述成完整总成本，更不能自己造一个 L2 数字。
 */
function projectCostCell(base, cap) {
  const cost = object(base) ?? {};
  const quality = cost.quality === 'estimated' || cost.quality === 'reported' ? cost.quality : 'unknown';
  const amount = cost.amount === null || cost.amount === undefined ? null : Number(cost.amount);

  const parts = [];
  if (quality === 'unknown' || amount === null || !Number.isFinite(amount)) {
    parts.push('费用未知');
  } else if (quality === 'estimated') {
    parts.push(`费用（部分为估算） ≈$${amount.toFixed(2)}`);
  } else {
    parts.push(`费用 $${amount.toFixed(2)}`);
  }
  if (cost.mainControllerUncounted === true) parts.push(OVERVIEW_MAIN_CONTROLLER_NOTE);
  parts.push(cap === null ? '上限未知' : `上限 $${cap.toFixed(2)}`);

  return {
    ...cost,
    cap,
    capKnown: cap !== null,
    line: parts.join(' · '),
  };
}

/**
 * 一条 Mission 详情 → 页头事实。纯函数：不改入参、不读全局。
 *
 * view 形状 = `/api/missions/:id` 的 MissionView（contract / status / coordinationMode /
 * executionMode / costCap / usage / waitInfo / updatedAt / workItems …）。
 * options = { createdAt, nowIso, formatTime }：createdAt 由调用方从事件流头部取
 * （MissionView 没有 createdAt），nowIso 是「现在」，formatTime 是本地时刻格式化。
 */
export function projectTaskHeader(view, options) {
  const v = object(view) ?? {};
  const contract = object(v.contract);

  // 页头标题是**原始 intent**，不是 L2 改写的目标：人要对得上自己当初写的那句话。
  const intent = text(contract === null ? '' : contract.intent);

  // 六态 / 附标 / 处理人 / 费用质量都交给总览那一份投影算。
  // 只把 intent 换成 contract.intent（详情里才有），其余字段原样透传。
  const row = projectOverviewRow({
    missionId: iso(v.missionId),
    projectId: iso(v.projectId),
    intent,
    status: v.status,
    coordinationMode: v.coordinationMode,
    paused: v.paused,
    waitInfo: v.waitInfo,
    usage: v.usage,
    openEscalations: v.openEscalations,
    updatedAt: v.updatedAt,
  }, { formatTime: (object(options) ?? {}).formatTime });

  // 附标只追加：model 层从真实字段投影出来的 paused / direct / problem 这里没资格删。
  // 补修在 model 层故意不出（那里拿不到详情），只在详情上按开单声明判，判据不抄第二份。
  const marks = Array.isArray(row.marks) ? row.marks.map((mark) => ({ ...mark })) : [];
  if (explicitRepair(v) && !marks.some((mark) => mark.key === 'repair')) {
    marks.push({ key: 'repair', text: '补修' });
  }

  // cap：只认真正的有限数字。字符串 '10'、null、undefined 都是「上限未知」。
  const cap = typeof v.costCap === 'number' && Number.isFinite(v.costCap) ? v.costCap : null;

  return {
    missionId: iso(v.missionId),
    projectId: text(v.projectId),
    intent,
    intentKnown: intent !== '',
    statusKey: row.statusKey,
    // 六态词逐字来自 narrate 的 STAGE_CN（经 projectOverviewRow）；附标是另一根轴，
    // 混进 statusText 就会让「执行中 · 直接主控 · 补修」看起来像一个状态。
    statusText: row.statusText,
    terminal: row.terminal,
    marks,
    marksText: marks.map((mark) => text(mark.text)).join(' · '),
    owner: row.owner,
    nextStep: row.nextStep,
    recovery: projectRecovery(row.owner),
    assurance: assuranceText(v.executionMode),
    collaboration: collaborationText(v.coordinationMode),
    direct: text(v.coordinationMode) === 'direct',
    cost: projectCostCell(row.cost, cap),
    time: projectTime(v, options),
    // 恒为 null：direct 的两层协作里平台拿不到主控会话的模型与费用，这一格没有可信
    // 来源。给个占位 id 就是凭空造一个「主控用的是哪个模型」的事实。
    coordinatorModel: null,
  };
}
