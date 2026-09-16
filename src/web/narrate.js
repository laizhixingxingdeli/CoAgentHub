/**
 * 事件 / 状态 / 用量 → 人话。项目页、任务页、资源池页共用这一张表。
 *
 * 为什么收在一个纯函数模块里，而不是散在各页面的渲染分支里：契约列了十几条
 * 事件，散着写必然漏掉几条，而漏掉的那条在界面上就是一行机器名
 * （mission.created）。它不报错、不崩、不影响任何断言——只是没人看得懂，
 * 所以也没人会把它当 bug 报。做成一张表 + 一条「未翻译」兜底之后，
 * 漏没漏用一条测试就能问出来。
 *
 * **不拼 HTML、不 esc、不碰 DOM**：这里只回字符串，转义留给调用方（页面里
 * 那些字段全是外部输入）。这么分以后 node 里能直接喂假事件断言文案，
 * 浏览器里也不会有第二份实现——两份实现迟早只改到一处。
 *
 * 零 import，且**不能**引 src/web/projects.js：那会把页面渲染拖进这条依赖里，
 * 而这层存在的意义就是能在没有 DOM、没有浏览器的地方被跑。
 * 代价是 num() 这类小工具在这里要再放一份——比多一条 import 划算。
 */

const text = (value) => (value === undefined || value === null ? '' : String(value)).trim();
/** 可读的退回：空、undefined、null 一律换成一句人话，绝不把 undefined 漏进界面。 */
const or = (value, fallback) => text(value) || fallback;
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/* ============================ 尝试 ID ============================ */

/**
 * 尝试 ID 拆成人话。
 *
 * 两个形状都是内核写死的（src/kernel/mission.ts 的 `coord-${n}`、
 * src/kernel/work-item.ts 的 `${id}.exec-${n}`）。对不上就原样回显，
 * **不做猜测性解析**：ID 里有 `.` 也认成 `.exec-N` 的话，
 * 一个叫 `W-1.2.exec-3` 的工作项会被切错，而错的那部分看起来很像对的。
 *
 * raw 永远原样带出：排障时人要拿它去 grep 日志。
 */
export function formatAttemptId(id) {
  const raw = id;
  const idText = text(id);
  if (!idText) return { label: '尝试（没有编号）', raw };

  const coord = /^coord-(\d+)$/.exec(idText);
  if (coord) return { label: `协调者第 ${Number(coord[1])} 次尝试`, raw };

  const exec = /^(.+)\.exec-(\d+)$/.exec(idText);
  if (exec) return { label: `工作项 ${exec[1]} · 执行者第 ${Number(exec[2])} 次尝试`, raw };

  return { label: `尝试 ${idText}`, raw };
}

/* ============================ 用量 ============================ */

/**
 * 只给一个 18,813,282 等于没给：那个数里绝大部分是缓存读，而缓存读便宜得多。
 * 拆成「新增」与「缓存命中」两项之后，人才知道钱花在哪。
 *
 * 数字缺失一律当 0（状态是整份写出去的，历史记录里没有这些字段很正常）；
 * 缺 total 时按 input+output+cacheWrite 推新增，而不是用 0 —— 0 会把
 * 「没上报」显示成「没花钱」。
 */
export function formatUsage(usage) {
  const u = usage || {};
  const input = num(u.input);
  const output = num(u.output);
  const cached = num(u.cacheRead);
  const cacheWrite = num(u.cacheWrite);
  const hasTotal = Number.isFinite(Number(u.total));
  const total = hasTotal ? Number(u.total) : input + output + cached + cacheWrite;
  const added = hasTotal ? total - cached : input + output + cacheWrite;

  const cacheRatio = total > 0 ? cached / total : 0;
  const cachePctText = `${Math.round(cacheRatio * 100)}%`;

  // 费用是可选上报的：没报就直说没报，不要显示 $0.0000 —— 那看起来像"这次不要钱"。
  const costReported = u.cost !== undefined && u.cost !== null && Number.isFinite(Number(u.cost));
  const costText = costReported ? `$${Number(u.cost).toFixed(4)}` : '费用未上报';

  const note = total > 0 && cacheRatio >= 0.5 ? '缓存部分计费便宜得多' : '';

  return { added, cached, cacheRatio, cachePctText, costText, note, total };
}

/**
 * 表格单元格用的紧凑版。
 *
 * 完整那句放进表格会把整行撑爆——实测项目页的标题列被挤成了一列竖字。
 * 详情页有空间讲清楚，表格里只需要"花了多少、多少是缓存"这两件事，
 * 剩下的让人点进去看。
 */
export function usageCell(usage) {
  const f = formatUsage(usage);
  return `${f.costText} · 新增 ${num(f.added).toLocaleString('en-US')}（缓存 ${f.cachePctText}）`;
}

/** 三个页面共用的一句话。四样都得有：新增、缓存命中、占比、费用。 */
export function usageLine(usage) {
  const f = formatUsage(usage);
  return (
    `新增 ${num(f.added).toLocaleString('en-US')} tokens` +
    ` · 缓存命中 ${num(f.cached).toLocaleString('en-US')}（${f.cachePctText}）` +
    ` · ${f.costText}` +
    (f.note ? `（${f.note}）` : '')
  );
}

/* ============================ 内部词 ============================ */

/**
 * 内部词表。技术 ID 仍然要能看到（排障要用），但不该是第一眼看到的东西——
 * 这一层只负责给 key 配一个人话标签，原样回显交给调用方拼在旁边。
 */
const FIELD_CN = {
  attempt: '尝试',
  causationId: '由哪一跳引发',
  profileId: '候选',
  ExecutionProfile: '运行时',
  WorkItem: '工作项',
};

/** 认不出来的 key 原样回显：显示一个生词也比显示空白强，至少还能 grep。 */
export function fieldLabel(key) {
  const k = text(key);
  return FIELD_CN[k] || k;
}

/** 「规划 r2」「契约 r3」——版本号离了名词就是一串看不懂的数字。 */
export function revisionLabel(kind, n) {
  const label = kind === 'plan' ? '规划' : kind === 'contract' ? '契约' : or(kind, '修订');
  return `${label} r${num(n)}`;
}

/* ============================ 阶段 / 状态 ============================ */

/** 阶段 = 内核 MissionStatus（src/kernel/mission.ts）。与 projects.js 逐字一致。 */
export const STAGE_CN = {
  investigating: '调查中',
  planning: '规划中',
  executing: '执行中',
  awaiting_review: '等你检视',
  completed: '已完成',
  blocked: '已中止',
};

/**
 * 状态是第二根轴：阶段说"走到哪了"，这根说"为什么不动"。
 *
 * 词**必须**和 STAGE_CN 不一样（完成品是「已完成」/「已中止」，这里只能是
 * 「已结束」/「已停止」）。用了同一个词，人就会以为是同一根轴，
 * 于是"卡住了"和"做完了"在两列里长得一模一样。
 */
export function stateLabel(row) {
  const r = row || {};
  if (r.paused) return '已暂停';
  if (r.waitReason) return '等待中';
  if (r.status === 'completed') return '已结束';
  if (r.status === 'blocked') return '已停止';
  return '进行中';
}

/**
 * 停机原因翻译成人话。只贴一个 enum 名字等于没贴——那是给写代码的人看的。
 * 9 条与 projects.js 逐字一致：两个界面里同一个原因必须说同一句话。
 */
export const WAIT_REASON = {
  no_available_agent: '候选全在冷却，等一会儿重跑',
  platform_unreachable: '连不上平台自己 —— 平台侧故障，不是候选的问题',
  waiting_l3: '等你处理',
  escalated: '执行者升级了问题，等你答复',
  project_busy: '同项目有别的 Mission 占着改动名额',
  attempt_limit_reached: '尝试到上限了 —— 继续换候选不会产生新信息',
  target_changed: '目标分支在检视期间变了',
  base_revision_stale: '分叉基线已过期，需要重新核对',
  cancelled_by_user: '被叫停了',
};

/**
 * waitDetail 优先：那是平台写下的具体情形（"卡在 exec-a"），比 enum 翻出来的
 * 套话有用。没有原因时回空串而不是「—」：空态该由页面说清楚为什么空，
 * 一个横杠什么信息都没有，还容易被当成"原因就是横杠"。
 */
export function reasonText(row) {
  const r = row || {};
  if (r.waitDetail) return r.waitDetail;
  if (!r.waitReason) return '';
  return WAIT_REASON[r.waitReason] || r.waitReason;
}

/** 一跳为什么结束（src/kernel/attempt.ts 的 AttemptEndReason）。 */
export const END_REASON = {
  structured_submit: '正常交了结果',
  no_structured_result: '跑完了却没交结果',
  upstream_failure: '上游调用失败',
  platform_unreachable: '连不上平台',
  cancelled: '被叫停',
  interrupted: '被中断',
};

/** 未知原因原样显示：编一句"其它原因"会把唯一可查的线索抹掉。 */
export function endReasonText(endedBy) {
  const key = text(endedBy);
  return END_REASON[key] || key || '（没有写结束原因）';
}

/* ============================ 事件翻译表 ============================ */

const evidenceKind = (kind) =>
  ({ test: '测试', command: '命令', diff: '改动摘要', typecheck: '类型检查', build: '构建', observation: '观察' })[kind] ||
  kind;

const OUTCOME_CN = { completed: '完成', partial: '部分完成', delivered: '已交付', blocked: '没做出来' };

/** outcome 是人话在前、机器值在括号里：两边的人都要能对上号。 */
const outcomeText = (outcome) => {
  const key = text(outcome);
  if (!key) return '（没有写结果）';
  return OUTCOME_CN[key] ? `${OUTCOME_CN[key]}（${key}）` : key;
};

const list = (value) => (Array.isArray(value) ? value : []);

/** ctx.workItems 里按 id 查标题；查不到就回 id —— 空着等于把线索丢了。 */
function titleOf(ctx, workItemId) {
  const id = text(workItemId);
  const hit = list(ctx && ctx.workItems).find((it) => it && text(it.id) === id);
  return or(hit && hit.title, id);
}

/**
 * attempt.started 是唯一一条需要先判角色的：同一种 kind 由两个不同层发出。
 *
 * 判据按 data.kind 优先（写入方明确说了是谁），历史事件没有这个字段时用
 * ID 前缀兜底。两边都没有时按协调者算：每条 Mission 的第一跳就是协调者，
 * 猜错顶多多显示一次「协调者接手」，而猜成执行者会去查一个不存在的工作项标题。
 */
function attemptRole(event) {
  const kind = text(event && event.data && event.data.kind);
  if (kind === 'coordinator' || kind === 'executor') return kind;
  if (/^coord-/.test(text(event && event.attemptId))) return 'coordinator';
  if (text(event && event.workItemId)) return 'executor';
  return 'coordinator';
}

const sameAsEscalated = (event) => ({
  badge: 'L2 → L3',
  action: '升级提问',
  detail: or(event && event.data && event.data.question, '（没有写问题）'),
});

/** 事件表：kind → { badge, action, detail }。加一条事件就加一行，漏了会被测试问出来。 */
const EVENT_TABLE = {
  'mission.created': (event, ctx) => ({
    badge: 'L3 → L2',
    action: '发起任务',
    // 意图在 MissionView 上，事件里没有；取不到就直说没有契约，不要空着。
    detail: or(ctx && ctx.intent, '（没有契约）'),
  }),

  'attempt.started': (event, ctx) => {
    if (attemptRole(event) === 'coordinator') {
      return { badge: 'L2', action: '协调者接手', detail: formatAttemptId(event && event.attemptId).label };
    }
    return {
      badge: 'L1',
      action: '执行者开工',
      detail: titleOf(ctx, event && event.workItemId) || '（不知道是哪个工作项）',
    };
  },

  'plan.updated': (event, ctx) => ({
    badge: 'L2',
    action: '写回调查结论',
    // 只补 findings 的那种更新（update_findings）没有 direction，退回发现内容。
    detail: or(ctx && ctx.plan && ctx.plan.direction, or(ctx && ctx.plan && ctx.plan.findings, revisionLabel('plan', event && event.planRevision))),
  }),

  'work_item.created': (event) => ({
    badge: 'L2',
    action: '拆出工作项',
    detail: or(event && event.data && event.data.title, or(event && event.workItemId, '（没有标题）')),
  }),

  'work_item.dispatched': (event, ctx) => {
    const ids = list(event && event.data && event.data.ids);
    return {
      badge: 'L2 → L1',
      action: '派发工作项',
      detail: ids.length === 0 ? '（没有写派了哪些工作项）' : ids.map((id) => titleOf(ctx, id)).join('、'),
    };
  },

  'work_item.retired': (event) => ({
    badge: 'L2',
    action: '作废工作项',
    detail: or(event && event.data && event.data.reason, '（没有写理由）'),
  }),

  'evidence.submitted': (event) => {
    const data = (event && event.data) || {};
    const kind = text(data.kind);
    const exitCode = data.exitCode === undefined || data.exitCode === null ? '没有退出码' : String(data.exitCode);
    // 事件上没有 summary（平台只带了 kind 与 exitCode），所以这里不编摘要。
    return {
      badge: 'L1',
      action: '提交证据',
      detail: `${kind ? evidenceKind(kind) + '（' + kind + '）' : '证据'} · 退出码 ${exitCode}`,
    };
  },

  'execution_result.submitted': (event) => {
    const data = (event && event.data) || {};
    const changed = data.changedFiles;
    const count = Array.isArray(changed) ? changed.length : changed === undefined || changed === null ? undefined : num(changed);
    return {
      badge: 'L1 → L2',
      action: '交回结果',
      detail: outcomeText(data.outcome) + (count === undefined ? '' : ` · 改了 ${count} 个文件`),
    };
  },

  'review.recorded': (event) => {
    const data = (event && event.data) || {};
    return {
      badge: 'L2',
      action: data.verdict === 'accept' ? '技术验收：通过' : '技术验收：打回',
      detail: or(list(data.reasons)[0], '（没有写理由）'),
    };
  },

  // 平台真实 kind 是 escalated，契约翻译表写的是 escalation.raised。
  // 两边都要认——只认一个，另一个就是界面上的一行机器名。
  'escalation.raised': sameAsEscalated,
  escalated: sameAsEscalated,

  'mission_result.submitted': (event, ctx) => ({
    badge: 'L2 → L3',
    action: '交卷',
    detail: or(ctx && ctx.result && ctx.result.summary, outcomeText((event && event.data && event.data.outcome) || (ctx && ctx.result && ctx.result.outcome))),
  }),

  'attempt.ended': (event) => ({
    badge: /^coord-/.test(text(event && event.attemptId)) ? 'L2' : 'L1',
    action: '这一跳结束',
    detail: endReasonText(event && event.data && event.data.endedBy),
  }),

  'contract.revised': (event) => {
    const revision = (event && event.data && event.data.contractRevision) ?? (event && event.contractRevision);
    return {
      badge: 'L3',
      action: '改了契约',
      detail: revision === undefined || revision === null ? '契约（没有写新版本号）' : revisionLabel('contract', revision),
    };
  },

  'final_review.merged': (event) => ({
    badge: 'L3',
    action: '放行并落地',
    detail: or(event && event.data && event.data.mergedInto, '改动已经落到目标分支'),
  }),

  'mission.waiting': (event) => {
    const reason = text(event && event.data && event.data.reason);
    return {
      badge: 'L2',
      action: '暂停',
      // enum 有翻译就用翻译，没有就把原因原样端出来，别丢线索。
      detail: reason ? WAIT_REASON[reason] || reason : '（没有写原因）',
    };
  },

  'mission.resumed': () => ({ badge: 'L2', action: '又动起来了', detail: '接着往下走' }),
};

/**
 * 一条事件 → 一段人话。
 *
 * 返回 { badge, action, detail, untranslated }：badge 是角色流转（「L3 → L2」），
 * action 是一句动作短语，detail 是细节行。**三条都不许是空白**——空白行在
 * 界面上和"这条事件没有内容"长得一样，而真实原因是"翻译表漏了它"。
 */
export function narrateEvent(event, ctx) {
  const e = event || {};
  const kind = text(e.kind);
  const translate = EVENT_TABLE[kind];

  if (!translate) {
    // 兜底：显示 kind 本身但标明「未翻译」。渲染成空白等于把这条事件吃掉，
    // 而漏掉的那条往往正好是排障要找的那条（新加的 kind 一定是先出现在这儿）。
    return {
      badge: '未翻译',
      action: '未翻译的事件',
      detail: `未翻译的事件类型：${kind || '没有 kind'}`,
      untranslated: true,
    };
  }

  const out = translate(e, ctx || {}) || {};
  return {
    badge: or(out.badge, '未翻译'),
    action: or(out.action, '未翻译的事件'),
    detail: or(out.detail, '（没有细节）'),
    untranslated: false,
  };
}

/* ============================ 现在在干什么 ============================ */

/**
 * 任务页头部的一句话。
 *
 * 只回人话，不回阶段名（「executing」这种词在这一行没有任何用处——阶段另有
 * 一根 chip 在说）。判据顺序就是优先级：停下（暂停 / 等停机原因）压过阶段，
 * 因为"为什么不动"比"走到哪一步"更急。
 */
export function nowDoing(view) {
  const v = view || {};
  const items = list(v.workItems);

  if (v.paused) return '在等暂停结束';
  if (v.waitReason) return `在等：${reasonText(v) || '（没有写原因）'}`;

  const summary = text(v.result && v.result.summary);

  switch (text(v.status)) {
    case 'investigating':
      return items.length === 0
        ? '协调者还在调查，没拆工作项'
        : `协调者还在调查，已经拆出 ${items.length} 个工作项`;
    case 'planning':
      return '协调者正在写规划';
    case 'executing': {
      const running = items.find((it) => it && it.status === 'dispatched');
      return running
        ? `正在跑「${or(running.title, running.id)}」，L1 执行者在干`
        : '协调者正在处理';
    }
    case 'awaiting_review':
      return '在等你最终检视';
    case 'completed':
      return `结束了：${summary || '已完成'}`;
    case 'blocked':
      return `结束了（被中止）：${summary || reasonText(v) || '没有写中止原因'}`;
    default:
      return '还没有动作';
  }
}
