/**
 * 任务总览的纯数据投影：一行任务 → 五列要显示的事实，外加三组分组与筛选分页。
 *
 * **为什么单开一个纯模块**：总览的五列（编号/intent、主状态/附标、处理人/下一步、
 * 费用、更新时间）每一条都有「看起来对、其实在说谎」的写法——把还没上报的费用
 * 显示成 $0、把 openEscalations 的条数当成「出了问题」、把 executing 当成
 * 「agent 正在跑」、把终态上残留的 waiting_l3 再翻译一遍「等你处理」。这些错都
 * 不报错、不崩、不影响任何断言，只是让人对着屏幕做错判断。做成纯函数之后，
 * node 里就能直接喂假行断言，浏览器里也不必再写第二份。
 *
 * 这个模块**不拼 HTML、不碰 DOM、不读时钟、不发请求**：转义与配色是渲染层的事，
 * 时间格式化由调用方传进来。它只吃 `/api/missions` 给的那份 MissionSummary
 * （src/application/platform/types.ts）以及真实详情里显式带来的字段。
 *
 * 译文只有一张表、在 narrate.js：状态词（STAGE_CN）、处理人词（WAIT_OWNER）、
 * 等待整句（waitInfoText）都从那儿取。另抄一份的话，两处迟早只改到一处，
 * 而漏改的那边在界面上就是一句不一样的「等你处理」。
 */
import { STAGE_CN, WAIT_OWNER, waitInfoText } from './narrate.js';

const text = (value) => (value === undefined || value === null ? '' : String(value)).trim();
const list = (value) => (Array.isArray(value) ? value : []);

/** 未知就是未知：不补成 0、不补成 false、不补成一句「暂无」。 */
export const UNKNOWN = '未知';

/** 六主状态的固定顺序（内核 MissionStatus，src/kernel/mission.ts）。筛选页签按这个顺序排。 */
export const OVERVIEW_STATUS_ORDER = [
  'investigating',
  'planning',
  'executing',
  'awaiting_review',
  'completed',
  'blocked',
];

/** 终态：内核流转表里 completed / blocked 没有任何出边，所以它们永远先于残留的等待信息。 */
const TERMINAL_STATUSES = new Set(['completed', 'blocked']);

/** 三组：需要你处理在最前，因为「该我动手」比「它在跑」更急。 */
export const OVERVIEW_GROUP_ORDER = ['needs_you', 'active', 'finished'];

export const OVERVIEW_GROUP_TITLES = {
  needs_you: '需要你处理',
  active: '进行中',
  finished: '最近结束',
};

/**
 * 一屏显示多少条。**具名常量，不是散在渲染里的数字**：把设计稿的样本数
 * （8 条 / 119 条总数）写进代码，上线后就变成「最多只能看 8 条」或
 * 「总数永远显示 119」，两个都是把某一轮的样本当成产品事实。
 */
export const OVERVIEW_PAGE_SIZE = 50;

/** 两层协作里主控会话的费用平台拿不到；已知的那部分不能表述成完整总成本。 */
export const OVERVIEW_MAIN_CONTROLLER_NOTE = '主控未计';

/* ============================ 单行投影 ============================ */

/** 阶段词逐字复用 narrate 的 STAGE_CN；认不出的状态回「未知」，不原样印一个英文机器名。 */
export function stageText(status) {
  return STAGE_CN[text(status)] || UNKNOWN;
}

/** 是不是终态。终态判定要看原始 status，不看等待信息——残留的等待信息会说反话。 */
export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(text(status));
}

/**
 * 附标：暂停、直接主控、问题升级。附标**不替代**主状态，所以单独一组，
 * 由渲染层决定用哪个颜色/位置；主状态那一列永远是六态之一。
 *
 * 每一条都必须来自行上真实存在的字段，真实接口里没有的字段一律不认：
 *   - `paused` 是内核布尔量；
 *   - `coordinationMode === 'direct'` 是创建时定下、只读的协作方式；
 *   - 问题升级从真实详情的 `openEscalations` **数组**逐条派生（见
 *     hasUnansweredProblem）。`openEscalations` 的**条数**不是这个问题：平台可信门禁
 *     （费用上限、工作项检查点）同样会产生未答复升级，把条数画成「已升级（问题）」，
 *     人会跑去查一个不存在的范围冲突。
 *
 * **补修（repair）不出标记**：真实 MissionSummary / Mission 上没有指向原工作项的字段，
 * 「补修」目前只是工单正文里的一句话约定，没有结构化来源。`origin.rerunOf` 是重跑
 * （同一个目标重来一遍），不是补修；拿它顶替会把重跑画成补修，人就会去找那张并不
 * 存在的原单据。缺口记在执行交卷里，等有了真实字段再补这一条。
 */
export function projectMarks(row) {
  const r = row && typeof row === 'object' ? row : {};
  const marks = [];
  if (r.paused === true) marks.push({ key: 'paused', text: '已暂停' });
  if (text(r.coordinationMode) === 'direct') marks.push({ key: 'direct', text: '直接主控' });
  if (hasUnansweredProblem(r.openEscalations)) marks.push({ key: 'problem', text: '已升级（问题）' });
  return marks;
}

/**
 * 一条未答复、且**不是**平台可信门禁的升级才算「问题升级」。
 *
 * 逐字段这么严的理由：
 *   - 只认真实数组（EscalationBody[]）。条数、缺字段、别的类型都当成没有证据 → 不出标记；
 *   - 答过了（answer / answeredAt 有值）说明分歧已经解决，不是问题；
 *   - 带 `platformGate`（kind = cost_cap | work_item_checkpoint）的升级是平台按阈值做的
 *     门禁，本来就不进入 L3 人工决策，算成问题会让人去查一个不存在的分歧。
 */
function hasUnansweredProblem(escalations) {
  for (const escalation of list(escalations)) {
    if (!escalation || typeof escalation !== 'object') continue;
    if (text(escalation.answer) !== '' || text(escalation.answeredAt) !== '') continue;
    if (escalation.platformGate && typeof escalation.platformGate === 'object') continue;
    return true;
  }
  return false;
}

/**
 * 费用列：**质量比数字重要**。
 *
 * usage.quality 是平台对「这组数字可不可信」的结论（src/kernel/payloads.ts 的
 * TokenUsage）：
 *   - `unknown`：一条都没上报。此时 usage.cost 上的 0 只是结构里的默认值，
 *     显示成 $0.00 就是「这次不要钱」——比空着更误导，所以照样回「未知」。
 *   - `estimated`：部分为估算，数字可以用，但必须带 ≈，不能冒充精确。
 *   - `reported`：全部由运行时上报，那就照实显示，包括真实的 $0.00（真的没花钱
 *     和没上报是两件事，抹在一起就再也分不开了）。
 *   - 两层协作（direct）：平台看不见主控会话的模型与费用，已知的这部分只是执行侧的，
 *     后面挂「主控未计」，不能表述成完整总成本。
 *
 * 为什么不直接用 narrate 的 formatUsage：那个函数是给详情页讲完整句子的（新增/缓存/
 * 占比），没有 quality 这个概念，也没有主控未计这一格；硬塞进去会让详情页的话跟着变。
 */
export function projectCost(usage, options) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const opts = options && typeof options === 'object' ? options : {};
  const direct = opts.direct === true;
  const quality = u.quality === 'reported' || u.quality === 'estimated' ? u.quality : 'unknown';
  const known = quality !== 'unknown' && u.cost !== undefined && u.cost !== null && Number.isFinite(Number(u.cost));
  const amount = known ? Number(u.cost) : null;

  let label;
  if (amount === null) {
    label = direct ? `${UNKNOWN}（${OVERVIEW_MAIN_CONTROLLER_NOTE}）` : UNKNOWN;
  } else {
    const head = `${quality === 'estimated' ? '≈' : ''}$${amount.toFixed(2)}`;
    label = direct ? `${head} + ${OVERVIEW_MAIN_CONTROLLER_NOTE}` : head;
  }

  return { quality, estimated: quality === 'estimated', amount, text: label, mainControllerUncounted: direct };
}

/**
 * 等待整句。
 *
 * narrate 的 waitInfoText 把两个布尔当三元条件的判据：缺 `autoResume` 就印「不会自动
 * 恢复」，缺 `activeAgent` 就印「没有活动 Agent」。两条都是断言，而真相是不知道——
 * 人看到「没有活动 Agent」就会去重启一个其实还在跑的任务。
 *
 * 所以只在两个布尔都真实存在时才整句交给 narrate；否则复用同一张处理人表逐格拼，
 * 缺的那一格写「未知」。不另编一句「平台会自己好」。
 */
function waitLineFor(info, formatTime) {
  const autoKnown = typeof info.autoResume === 'boolean';
  const agentKnown = typeof info.activeAgent === 'boolean';
  if (autoKnown && agentKnown) return waitInfoText(info, undefined, formatTime);

  const at = text(info.nextRetryAt);
  const parts = [WAIT_OWNER[text(info.owner)] || text(info.owner) || UNKNOWN];
  if (!autoKnown) parts.push('自动恢复：未知');
  else if (info.autoResume) parts.push(`会自动恢复${at === '' ? '' : `（下次 ${typeof formatTime === 'function' ? formatTime(at) : at}）`}`);
  else parts.push('不会自动恢复');
  if (!agentKnown) parts.push('活动 Agent：未知');
  else parts.push(info.activeAgent ? '有活动 Agent' : '没有活动 Agent');
  const action = text(info.action);
  return `${parts.join(' · ')}${action === '' ? '' : `。下一步：${action}`}`;
}

/** 没有 waitInfo 时的中性处理人：既不说平台会自己好，也不说没人管。 */
function unknownOwner(source) {
  return {
    key: 'unknown',
    text: UNKNOWN,
    autoResume: 'unknown',
    nextRetryAt: null,
    retry: null,
    activeAgent: 'unknown',
    action: '',
    reason: null,
    source,
  };
}

/**
 * waitInfo 原样投影（src/application/platform/wait-info.ts）。
 *
 * 这五个字段一个都不许推断：owner 不会自动恢复时 fallback 到 l3、autoResume 是
 * 平台算出来的、activeAgent 来自「有没有 in_progress 的 Attempt」、action 是平台给的
 * 下一步。缺失（老接口 / 局部对象）就逐字段保持未知，不补 false：
 * 补成 false 等于断言「不会自动恢复」，而真相是不知道。
 */
function ownerFromWaitInfo(info) {
  const field = (value) => (typeof value === 'boolean' ? value : 'unknown');
  const ownerKey = text(info.owner);
  const known = ownerKey === 'platform' || ownerKey === 'coordinator' || ownerKey === 'l3' || ownerKey === 'user';
  const retry = info.retry && typeof info.retry === 'object' ? info.retry : null;
  return {
    key: known ? ownerKey : 'unknown',
    text: known ? WAIT_OWNER[ownerKey] : UNKNOWN,
    autoResume: field(info.autoResume),
    nextRetryAt: text(info.nextRetryAt) || null,
    retry: retry ? { attempt: Number(retry.attempt), max: Number(retry.max) } : null,
    activeAgent: field(info.activeAgent),
    action: text(info.action),
    reason: text(info.reason) || null,
    source: 'waitInfo',
  };
}

/**
 * 终态的处理人。
 *
 * completed / blocked 在内核流转表里没有出边，平台不会再去调度，所以**待办那几格**
 * 任何残留 waitInfo 都不能改变：owner 一律 none、autoResume 一律 false、action 与
 * waitLine 一律空。把残留的 waitInfo 照抄过来，界面就成了「已中止 + 需要用户处理 +
 * 不会自动恢复 + 下一步去答复」，人就去查一个根本不存在的待办。
 *
 * **但 activeAgent 不是待办，是一条观察事实，不能跟着一起抹成 false**：
 * kernel/mission.ts 的 cancel() 与 platform/mission-lifecycle.ts 的 cancelMission()
 * 都不关闭正在运行的 Attempt（用户叫停时进程可能还在跑完手里那一跳）。从「任务已经
 * completed / blocked」推断「此刻没有活动 Agent」，是把状态当成了进程证据——和上面
 * 把 executing 当成「agent 正在跑」是同一类错，只是方向相反。所以这一格照 waitInfo 里
 * 真实上报的布尔走；没有这个字段（老接口 / 局部对象）就是 unknown，不补 false。
 *
 * 唯一保留的是原因：blocked 到底是用户叫停还是平台掐断，是只读的事实，值得留着；
 * 但它是原因，不是待办。
 */
function terminalOwner(info) {
  const reason = info !== null ? text(info.reason) : '';
  return {
    ...unknownOwner('terminal'),
    key: 'none',
    text: '已结束，没有待办',
    autoResume: false,
    activeAgent: info !== null && typeof info.activeAgent === 'boolean' ? info.activeAgent : 'unknown',
    action: '',
    reason: reason === '' ? null : reason,
  };
}

/**
 * 处理人 / 下一步。
 *
 * 三条不许越界的判断：
 *   1. **终态压过一切残留等待信息**：completed / blocked 没有出边，可快照里可能留着
 *      上一轮没清的 waiting_l3 或别的停机原因。终态一律走 terminalOwner，只剩只读原因。
 *   2. **executing / isMutating 不证明 agent 在跑**：executing 是阶段，isMutating 是
 *      「占着改动名额」，都可能在两跳之间、进程早已退出时仍然为真。有没有活动 Agent
 *      只认 waitInfo.activeAgent；没有 waitInfo 就是未知。
 *   3. **awaiting_review 的处理人是 L3**：这不是猜的，是内核定义——协调者交卷后没有
 *      任何角色能继续推进，只有检视者能终审。没有 waitInfo 时说这一句也不会错。
 */
function projectOwner(row, statusKey) {
  const info = row.waitInfo && typeof row.waitInfo === 'object' ? row.waitInfo : null;

  if (TERMINAL_STATUSES.has(statusKey)) return terminalOwner(info);

  if (info !== null) return ownerFromWaitInfo(info);

  if (statusKey === 'awaiting_review') {
    return {
      ...unknownOwner('status'),
      key: 'l3',
      text: WAIT_OWNER.l3,
    };
  }

  return unknownOwner('unknown');
}

/**
 * 一行 MissionSummary → 总览要的事实。纯函数：不改入参、不读全局。
 *
 * options.formatTime 透传给 narrate 的 waitInfoText（页面按本地时区格式化），
 * 默认原样给 ISO —— 界面想显示 14:36 就自己传一个，不在这里绑一种本地化写法。
 */
export function projectOverviewRow(row, options) {
  const r = row && typeof row === 'object' ? row : {};
  const opts = options && typeof options === 'object' ? options : {};
  const statusKey = text(r.status);
  const terminal = TERMINAL_STATUSES.has(statusKey);
  const marks = projectMarks(r);
  const direct = text(r.coordinationMode) === 'direct';
  const owner = projectOwner(r, statusKey);

  const info = r.waitInfo && typeof r.waitInfo === 'object' ? r.waitInfo : null;
  // 终态没有等待整句：残留原因已经在 owner.reason 里，复述一遍就是给终态加一条待办。
  const waitLine = terminal || info === null
    ? ''
    : waitLineFor(info, typeof opts.formatTime === 'function' ? opts.formatTime : undefined);

  return {
    missionId: text(r.missionId),
    projectId: text(r.projectId),
    intent: text(r.intent),
    status: statusKey,
    statusKey: OVERVIEW_STATUS_ORDER.includes(statusKey) ? statusKey : 'unknown',
    statusText: stageText(statusKey),
    terminal,
    marks,
    marksText: marks.map((mark) => mark.text).join(' · '),
    owner,
    // 下一步直接用平台给的那句；没有就是空串，由渲染层说「未知」，不在这里编。
    nextStep: owner.action,
    waitLine,
    cost: projectCost(r.usage, { direct }),
    updatedAt: text(r.updatedAt) || null,
    openEscalations: Number.isFinite(Number(r.openEscalations)) ? Number(r.openEscalations) : null,
    group: groupKeyFor({ statusKey, owner }),
  };
}

/** 一组投影行。保持入参顺序，不做别的排序。 */
export function projectOverviewRows(rows, options) {
  return list(rows).map((row) => projectOverviewRow(row, options));
}

/* ============================ 分组 / 排序 ============================ */

/**
 * 归组：
 *   - 终态 → 最近结束（不管还有没有残留等待信息）；
 *   - 处理人是检视者/用户、且平台不会自动恢复 → 需要你处理；
 *   - 其余 → 进行中。
 *
 * `autoResume === 'unknown'` 也算「需要你处理」：处理人已经明说是要人动手了，
 * 这时候把「会不会自己好」当未知而丢进「进行中」，人就会等着一个不会自己好的任务。
 * 反过来 `autoResume === true` 时不算——平台到点会接着跑，不该占用「需要你处理」。
 */
function groupKeyFor(row) {
  if (TERMINAL_STATUSES.has(row.statusKey)) return 'finished';
  const ownerKey = row.owner && row.owner.key;
  if ((ownerKey === 'l3' || ownerKey === 'user') && row.owner.autoResume !== true) return 'needs_you';
  return 'active';
}

/**
 * updatedAt 降序；同一时刻用 missionId 兜底，让顺序稳定（同样的输入永远同样的顺序，
 * 否则每次重画行都会跳一下）。
 */
function compareByUpdatedAtDesc(a, b) {
  const at = Date.parse(a.updatedAt);
  const bt = Date.parse(b.updatedAt);
  const delta = (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
  if (delta !== 0) return delta;
  return String(a.missionId).localeCompare(String(b.missionId));
}

/**
 * 三组。组序固定为 需要你处理 → 进行中 → 最近结束，组内按 updatedAt 降序。
 * 返回新对象与新数组，入参一个都不动（同样的数据被两个地方同时渲染时，
 * 就地排序会让另一边看到另一种顺序）。
 */
export function groupOverview(rows) {
  const buckets = new Map(OVERVIEW_GROUP_ORDER.map((key) => [key, []]));
  for (const row of list(rows)) {
    const key = OVERVIEW_GROUP_ORDER.includes(row && row.group) ? row.group : 'active';
    buckets.get(key).push(row);
  }
  return OVERVIEW_GROUP_ORDER.map((key) => ({
    key,
    title: OVERVIEW_GROUP_TITLES[key],
    rows: [...buckets.get(key)].sort(compareByUpdatedAtDesc),
  }));
}

/* ============================ 筛选 / 分页 ============================ */

/**
 * 筛选条件归一化。`status` 缺省是「全部」；`projectId` 空串沿用外壳的「全部项目」哨兵
 * （src/web/console-shell.js 的 ALL_PROJECTS），这样调用方不必为「全部」另写一个分支。
 */
function normalizeFilter(filter) {
  const f = filter && typeof filter === 'object' ? filter : {};
  const status = text(f.status);
  return {
    projectId: text(f.projectId),
    status: status === '' || status === 'all' ? 'all' : status,
    pausedOnly: f.pausedOnly === true,
    query: text(f.query).toLowerCase(),
  };
}

/** 编号 / intent 搜索。两列都是「一眼认这条任务」的信息，所以都搜；空查询放行。 */
function matchesQuery(row, query) {
  if (query === '') return true;
  if (text(row.missionId).toLowerCase().includes(query)) return true;
  return text(row.intent).toLowerCase().includes(query);
}

/** 除状态以外的条件（项目、暂停、搜索）。页签上的计数用的就是这一层。 */
function matchesScope(row, filter) {
  if (filter.projectId !== '' && text(row.projectId) !== filter.projectId) return false;
  if (filter.pausedOnly && !row.marks.some((mark) => mark.key === 'paused')) return false;
  return matchesQuery(row, filter.query);
}

/**
 * 按筛选返回**完整匹配集合**——不截断。截断是分页的事，混在一处就再也说不清
 * 「显示 8 / 119」里那个 119 到底是不是匹配总数。
 */
export function filterOverviewRows(rows, filter) {
  const f = normalizeFilter(filter);
  return list(rows).filter((row) => matchesScope(row, f) && (f.status === 'all' || row.statusKey === f.status));
}

/** 页签计数：全部 + 六态，按状态以外的条件统计（否则点进去只会剩 0 条）。 */
export function overviewStatusCounts(rows, filter) {
  const f = normalizeFilter(filter);
  const counts = { all: 0 };
  for (const key of OVERVIEW_STATUS_ORDER) counts[key] = 0;
  for (const row of list(rows)) {
    if (!matchesScope(row, f)) continue;
    counts.all += 1;
    if (OVERVIEW_STATUS_ORDER.includes(row.statusKey)) counts[row.statusKey] += 1;
  }
  return counts;
}

/**
 * 总览的完整装配：投影 → 筛选 → 分组排序 → 分页。
 *
 * 返回里 `matched` / `total` 是**完整匹配集合**（不被可见批次截断），
 * `page.rows` 才是一屏要画的那一批，`page.hasMore` 说明还有没有「加载更早」。
 * 分组在分页之后做：先按组序把整条流排好再切一批，切出来的那一批再归组，
 * 否则每组各切一段，屏幕上就是三个互不相干的半截列表。
 */
export function buildOverview(rows, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const filter = normalizeFilter(opts.filter);
  const size = Number.isFinite(Number(opts.shown)) && Number(opts.shown) > 0
    ? Math.floor(Number(opts.shown))
    : OVERVIEW_PAGE_SIZE;

  const projected = projectOverviewRows(rows, opts);
  const scoped = projected.filter((row) => matchesScope(row, filter));
  const counts = { all: 0 };
  for (const key of OVERVIEW_STATUS_ORDER) counts[key] = 0;
  for (const row of scoped) {
    counts.all += 1;
    if (OVERVIEW_STATUS_ORDER.includes(row.statusKey)) counts[row.statusKey] += 1;
  }

  const matched = scoped.filter((row) => filter.status === 'all' || row.statusKey === filter.status);
  const ordered = groupOverview(matched).flatMap((group) => group.rows);
  const visible = ordered.slice(0, size);

  return {
    counts,
    matched,
    total: matched.length,
    groups: groupOverview(visible),
    page: {
      rows: visible,
      shown: visible.length,
      size,
      total: matched.length,
      hasMore: ordered.length > visible.length,
      remaining: Math.max(0, ordered.length - visible.length),
    },
    filter,
  };
}
