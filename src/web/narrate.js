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

/* ============================ 环节（任务页进度视图） ============================ */

/**
 * 环节角色。一个环节 = 同一个 attemptId 下的一组事件，角色由 attemptId
 * 的形状定（形状写死在内核：`coord-${n}` / `${id}.exec-${n}`）。
 *
 * 没有 attemptId 的那一组是 L3 自己动的手（发起任务、改契约、最终检视），
 * 它们不属于任何一跳，所以只能是检视者。
 */
export function roleOfAttempt(attemptId) {
  const id = text(attemptId);
  if (!id) return 'reviewer';
  if (/^coord/.test(id)) return 'coordinator';
  if (id.includes('.exec-')) return 'executor';
  // 对不上两种形状的 attemptId 按协调者算：猜成执行者会去查一个不存在的工作项
  // 标题，而猜成协调者只是组名宽泛一点（见 stageName 的退回）。
  return 'coordinator';
}

/** 角色徽章文案。任务页与用量卡共用，所以住在表里而不是散在渲染分支。 */
export const ROLE_CN = {
  coordinator: 'L2 协调',
  executor: 'L1 执行',
  reviewer: 'L3 检视者',
};

/**
 * 没有 attemptId 的事件不全是 L3：投递、记忆落地、集成验证是平台自己动的手。
 * 组名留给 task.js 去切；这里只给人话标签，避免页面再写一份「平台」——两份一定会漂。
 */
export const PLATFORM_ROLE_LABEL = '平台';

export function roleBadge(role) {
  return ROLE_CN[normalizeRole(role)] || 'L2 协调';
}

/** 只认这三个角色；拿到别的（包括拼错的）一律当协调者，不让徒章空着。 */
function normalizeRole(role) {
  const r = text(role);
  return r === 'executor' || r === 'reviewer' || r === 'coordinator' ? r : 'coordinator';
}

/**
 * 环节色 class。与 projects.js 的 stageTone 同一套 `--status-*` 令牌，
 * 这样同一环节在任务页与项目页是一种颜色。
 *
 * 为什么复用阶段色而不是给每个角色配一个色：环节色条要说的是「这一跳在
 * 流水线的哪个位置」，与项目页那根色条是同一件事；用角色色（--role-*）
 * 会把「谁在干」和「干到哪」两根轴在一个颜色里混起来，而项目页只有后者。
 */
export const ROLE_TONE = {
  coordinator: 'queued',
  executor: 'running',
  reviewer: 'unconfirmed',
};

export function roleTone(role) {
  return ROLE_TONE[normalizeRole(role)] || 'queued';
}

/**
 * 协调者一个环节里干了哪几件事 → 组名。
 *
 * 从组内 kind 推出，而不是按「第一轮规划、第二轮验收、第三轮交卷」那种
 * 顺序硬编码：协调者第几轮干什么不是平台规定的，实测就有第一轮直接去
 * 验收（重跑场景）。硬编码顺序会让组名说谎。
 *
 * 四个都没命中时退回「协调」，不露 attemptId——人看到的应该是「这一跳在
 * 干一件什么性质的事」，而不是一个只能拿去 grep 的编号。
 */
const COORDINATOR_STAGE_PARTS = [
  { label: '调查与规划', kinds: ['plan.updated', 'work_item.created'] },
  { label: '技术验收', kinds: ['review.recorded'] },
  { label: '派发', kinds: ['work_item.dispatched'] },
  { label: '交卷', kinds: ['mission_result.submitted'] },
];

/**
 * 一组事件 + ctx → 环节名。纯函数，测试能直接 import。
 *
 * 调用方保证这一组确实是同一个 attemptId 下的事件（分组在 task.js），
 * 角色由首条事件的 attemptId 形状定。
 */
export function stageName(events, ctx) {
  const rows = list(events);
  const role = roleOfAttempt(rows[0] && rows[0].attemptId);

  if (role === 'reviewer') return 'L3 检视者';

  if (role === 'executor') {
    const carrier = rows.find((e) => e && text(e.workItemId));
    const id = text(carrier && carrier.workItemId);
    // titleOf 查不到时回 id；连 id 都没有才说不知道是哪个工作项。
    return `执行 · ${id ? titleOf(ctx, id) : '（没有关联工作项）'}`;
  }

  const kinds = new Set(rows.map((e) => text(e && e.kind)).filter(Boolean));
  const parts = COORDINATOR_STAGE_PARTS
    .filter((part) => part.kinds.some((k) => kinds.has(k)))
    .map((part) => part.label);
  return parts.length > 0 ? parts.join('、') : '协调';
}

/* ============================ 用量卡文案 ============================ */

/**
 * 用量卡第二层：按角色拆的一行。
 *
 * 占比分母用的是 L2+L1 的加总而不是 view.usage.total：在途的那一跳还没
 * attempt.ended，total 会比两 role 之和大，拿它当分母算出来的两个百分比
 * 加起来不等于 100%，看起来像漏了一笔钱。
 */
export function roleUsageLine(role, tokens, pct, costText) {
  const label = roleBadge(role);
  const pctText = Number.isFinite(Number(pct)) ? `${Math.round(Number(pct))}%` : '—';
  return `${label} ${num(tokens).toLocaleString('en-US')} tokens（占比 ${pctText}）${costText ? ` · ${costText}` : ''}`;
}

/** 用量卡第三层：按类型拆（新增 / 缓存命中 + 占比）。 */
export function usageTypeLine(usage) {
  const f = formatUsage(usage);
  return `新增 ${num(f.added).toLocaleString('en-US')} tokens · 缓存命中 ${num(f.cached).toLocaleString('en-US')}（${f.cachePctText}）`;
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
 * 与 projects.js 共用本表：两个界面里同一个原因必须说同一句话。
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
  runaway_suspected: '一跳跑太久，已停下来等人看',
  execution_budget_exceeded: '执行预算硬上限已耗尽',
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

/**
 * 证据类型的人话标签。认不出来时原样回显（写错一个 kind 至少还能看到线索），
 * 与这张表其余部分同一取舍。详情页与事件表共用，所以导出去。
 */
export function evidenceKindLabel(kind) {
  return ({ test: '测试', command: '命令', diff: '改动摘要', typecheck: '类型检查', build: '构建', observation: '观察' })[kind]
    || (text(kind) || '证据');
}

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

  'work_item.order_revised': (event) => {
    const data = (event && event.data) || {};
    const revision = text(data.revision);
    const fields = list(data.changedFields);
    // 事件只记修订号与字段名（full order 在工单时间线重复无意义），缺了就直说。
    const revisionText = revision ? `（${revision}）` : '（没写修订号）';
    const changedText = fields.length === 0 ? '（没写改了哪些字段）' : fields.join('、');
    return {
      badge: 'L2',
      action: '修订工单',
      detail: `工作项 ${or(event && event.workItemId, '（没有工作项 ID）')}${revisionText} · 改了：${changedText}`,
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
      detail: `${kind ? evidenceKindLabel(kind) + '（' + kind + '）' : '证据'} · 退出码 ${exitCode}`,
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

  'mission.conflict_dispatch_barrier': (event) => {
    const data = (event && event.data) || {};
    const files = list(data.conflictFiles);
    return {
      badge: 'L2',
      action: '冲突期间暂停派发',
      detail: files.length ? `冲突文件：${files.join('、')}` : '检测到冲突，已暂停派发工作项',
    };
  },

  'mission.conflict_dispatch_cleared': () => ({
    badge: 'L2',
    action: '解除冲突派发限制',
    detail: '冲突已清除，可以继续派发工作项',
  }),

  'mission.parked': (event) => ({
    badge: 'L2',
    action: '挂起 Mission',
    detail: or(event && event.data && event.data.reason, '等待用户答复，暂时挂起'),
  }),

  'mission.resume_sync_conflict': (event) => {
    const data = (event && event.data) || {};
    const files = list(data.conflictFiles);
    const reason = text(data.reason);
    return {
      badge: 'L2',
      action: '续跑同步遇到冲突',
      detail: [reason, files.length ? `冲突文件：${files.join('、')}` : '', data.baseRevision ? `集成基线：${data.baseRevision}` : '']
        .filter(Boolean).join(' · ') || '与集成分支同步时发生冲突，需协调处理',
    };
  },

  'mission.resumed_from_park': (event) => {
    const data = (event && event.data) || {};
    return {
      badge: 'L2',
      action: '从挂起状态续跑',
      detail: [text(data.reason), data.baseRevision ? `集成基线：${data.baseRevision}` : '']
        .filter(Boolean).join(' · ') || '已同步集成分支并恢复 Mission',
    };
  },

  'mission.resumed': () => ({ badge: 'L2', action: '又动起来了', detail: '接着往下走' }),

  'orchestration.round.started': () => ({
    badge: PLATFORM_ROLE_LABEL,
    action: '开始新一轮调度',
    detail: '记下本轮预算事实',
  }),

  'memory.applied': (event) => {
    const written = list(event && event.data && event.data.written);
    return {
      badge: PLATFORM_ROLE_LABEL,
      action: '写入项目记忆',
      detail: written.length === 0 ? '（没有写出文件清单）' : written.map((p) => String(p)).join('、'),
    };
  },

  'delivery.created': (event) => ({
    badge: PLATFORM_ROLE_LABEL,
    action: '投进收件箱',
    detail: or(event && event.data && event.data.deliveryId, '（没有投递编号）'),
  }),

  'final_review.integration_anchor': (event) => {
    const data = (event && event.data) || {};
    const branch = or(data.integrationBranch, '集成分支');
    return {
      badge: 'L3',
      action: '记下集成锚点',
      detail: data.anchor ? `${branch} · ${data.anchor}` : branch,
    };
  },

  'final_review.integration_verified': (event) => {
    const data = (event && event.data) || {};
    return {
      badge: 'L3',
      action: data.passed === false ? '集成验证未通过' : '集成验证通过',
      detail: or(data.reportId, '（没有报告编号）'),
    };
  },

  'final_review.merge_applied': (event) => {
    const data = (event && event.data) || {};
    return {
      badge: 'L3',
      action: '合进集成分支',
      detail: or(data.mergedInto, or(data.integrationBranch, '改动已经合进集成分支')),
    };
  },

  'work_item.redispatched': (event, ctx) => {
    const ids = list(event && event.data && event.data.ids);
    return {
      badge: 'L3 → L1',
      action: '重新派发工作项',
      detail: ids.length === 0 ? '（没有写派了哪些工作项）' : ids.map((id) => titleOf(ctx, id)).join('、'),
    };
  },

  'final_review.send_back': (event) => ({
    badge: 'L3',
    action: '打回',
    detail: or(list(event && event.data && event.data.reasons)[0], '（没有写理由）'),
  }),

  'final_review.abandoned': (event) => ({
    badge: 'L3',
    action: '放弃这批改动',
    detail: or(list(event && event.data && event.data.reasons)[0], '（没有写理由）'),
  }),

  'final_review.merge_failed': (event) => ({
    badge: 'L3',
    action: '合并失败',
    detail: or(event && event.data && event.data.reason, '（没有写原因）'),
  }),

  'final_review.ha_authorized': (event) => {
    const data = (event && event.data) || {};
    return {
      badge: 'L3',
      action: 'HA 受控放行',
      detail: or(data.reviewerId, or(data.integrationReportId, '外置常设授权已核对')),
    };
  },

  'final_review.ha_unsafe': (event) => {
    const data = (event && event.data) || {};
    return {
      badge: 'L3',
      action: 'HA 状态不安全',
      detail: or(data.hint, or(data.reason, '（没有写原因）')),
    };
  },

  'mission.routed': (event) => {
    const data = (event && event.data) || {};
    const lane = or(data.recommended, data.executionMode);
    const reason = or(list(data.reasons)[0], '');
    return {
      badge: PLATFORM_ROLE_LABEL,
      action: '分好了车道',
      detail: lane ? (reason ? `${lane} · ${reason}` : lane) : or(reason, '已按分类入口分发'),
    };
  },

  'independent_review.blocked': (event) => ({
    badge: 'L3',
    action: '独立检视开不了',
    detail: or(event && event.data && event.data.detail, or(event && event.data && event.data.reason, '（没有写原因）')),
  }),

  'independent_review.recorded': (event) => {
    const data = (event && event.data) || {};
    const action = data.verdict === 'pass'
      ? '独立检视：通过'
      : data.verdict === 'send_back'
        ? '独立检视：打回'
        : '记下独立检视';
    return {
      badge: 'L3',
      action,
      detail: or(data.reviewedCommit, or(data.verdict, '（没有写结论）')),
    };
  },

  'mission.cancelled': (event) => ({
    badge: 'L3',
    action: '叫停任务',
    detail: or(event && event.data && event.data.reason, '被叫停了'),
  }),

  'mission.paused': () => ({ badge: 'L3', action: '暂停任务', detail: '调度器不再碰它' }),

  'mission.resumed_from_pause': () => ({
    badge: 'L3',
    action: '从暂停恢复',
    detail: '调度器可以再碰它了',
  }),

  /*
   * 执行前记下的 diff 比较基线（platform 在派发时写，data.head 是那个版本号）。
   * 这是「之后验什么」的参照点，不是验证结论：动作只能写成记基线，
   * 写成「验证通过」/「工作项已接受」会让时间线把还没发生的事说成发生了。
   */
  'work_item.validation_baseline_recorded': (event) => {
    const data = (event && event.data) || {};
    return {
      badge: PLATFORM_ROLE_LABEL,
      action: '记下验证基线',
      detail: `执行前基线 ${or(data.head, '（没有基线版本）')}`,
    };
  },

  'validation.reported': (event) => {
    const data = (event && event.data) || {};
    return {
      badge: PLATFORM_ROLE_LABEL,
      action: data.passed === false ? '验证未通过' : '验证通过',
      detail: or(data.reportId, '（没有报告编号）'),
    };
  },

  'context.truncated': (event) => {
    const data = (event && event.data) || {};
    const hasBudget = data.budget !== undefined && data.budget !== null;
    return {
      badge: PLATFORM_ROLE_LABEL,
      action: '裁剪了上下文',
      detail: hasBudget
        ? `预算 ${data.budget} · 裁前 ${or(data.estimatedBefore, '?')} → 裁后 ${or(data.estimatedAfter, '?')}`
        : '上下文超出预算，已经裁过',
    };
  },

  'mission.budget.threshold': (event) => {
    const data = (event && event.data) || {};
    const dim = or(data.dimension, '预算');
    return {
      badge: PLATFORM_ROLE_LABEL,
      action: '预算过线',
      detail: data.threshold === undefined || data.threshold === null ? dim : `${dim} · 阈值 ${data.threshold}`,
    };
  },

  'escalation.answered': (event) => ({
    badge: 'L3 → L2',
    action: '答复升级',
    detail: or(event && event.data && event.data.answer, '（没有写答复）'),
  }),

  'blocked.reported': (event) => ({
    badge: 'L1 → L2',
    action: '报了阻塞',
    detail: or(event && event.data && event.data.reason, '（没有写原因）'),
  }),

  'mission.promoted': (event) => {
    const data = (event && event.data) || {};
    const from = or(data.oldMode, '（不知道原车道）');
    const to = or(data.newMode, '（不知道新车道）');
    return {
      badge: PLATFORM_ROLE_LABEL,
      action: '车道升级',
      detail: `${from} → ${to}`,
    };
  },

  'recovery.applied': (event) => ({
    badge: PLATFORM_ROLE_LABEL,
    action: '补上了投递',
    detail: or(event && event.data && event.data.deliveryId, '启动收敛补的投递'),
  }),

  'decision.shadow': (event) => {
    const data = (event && event.data) || {};
    return {
      badge: PLATFORM_ROLE_LABEL,
      action: '影子决策审计',
      detail: or(data.hook, or(data.quality, '只记不拦')),
    };
  },

  'decision.post_execution': (event) => {
    const data = (event && event.data) || {};
    return {
      badge: PLATFORM_ROLE_LABEL,
      action: '交卷后影子评估',
      detail: or(data.quality, '只记不改审查级别'),
    };
  },
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

/* ============================ 命令族（供 task.js 折叠） ============================ */

/**
 * runtime.command.* / runtime.command_tracking.* 是汇总命令族：
 * 单条不值得占一行进度（LQ1 一跳 20 条 started）。
 * 未来新增的同前缀 kind 也算这一族——覆盖测试对它们豁免「必须单条翻译」，
 * 不是把它们当成不存在。
 */
export function isRuntimeCommand(kind) {
  const k = text(kind);
  return k.startsWith('runtime.command.') || k.startsWith('runtime.command_tracking.');
}

/** 环节头上那句「跑了多少条命令」。零条也说人话，不说 0 条——零和「没折叠」长得一样。 */
export function commandCountLabel(count) {
  const n = Math.max(0, Math.floor(num(count)));
  if (n === 0) return '没有命令';
  return `${n} 条命令`;
}

/**
 * 单条命令事件的细节行。折叠后仍可能展开看。
 *
 * 平台落库目前只写 schemaVersion/callId（platform.recordCommandStarted）。
 * 契约要「有命令文本与退出码就显示」——字段是可选的，缺了就
 * 退回 callId / 跟踪说明，绝不要编一条命令或一个退出码：
 * 编出来的看起来像真跑过。
 */
export function commandDetail(event) {
  const kind = text(event && event.kind);
  const data = (event && event.data) || {};
  if (kind === 'runtime.command.started') {
    const commandText = typeof data.command === 'string' ? text(data.command) : '';
    const head = commandText || or(data.callId, '（没有 callId）');
    // 0 是合法退出码；undefined/null 才算没有。String(缺值) 会变成
    // "undefined" 漏进界面——所以先把空值挡掉，不要让 String 起步。
    const exit =
      data.exitCode === undefined || data.exitCode === null ? '' : String(data.exitCode).trim();
    if (!exit || exit === 'undefined') return `命令 ${head}`;
    return `命令 ${head} · 退出码 ${exit}`;
  }
  if (kind === 'runtime.command_tracking.enabled') {
    return '开始跟踪本跳的命令';
  }
  if (kind === 'runtime.command_tracking.invalid') {
    return '命令跟踪失效，次数按未知计';
  }
  return or(kind, '命令');
}

/* ============================ 终审收尾摘要（供任务页环节用量/摘要行） ============================ */

/**
 * 终态平台/L3 收尾组的一句结论。
 *
 * 签名：finalReviewSummary(finalReview) → string
 * 字段形状与 MissionView.finalReview 一致：verdict 为 merge / send_back / abandon，
 * mergedInto 可选。缺对象、缺结论、认不出的值都说人话，绝不把
 * undefined/null 漏进界面。返回纯字符串，调用方负责 HTML 转义。
 *
 * 供 W-122 接线：task.js 的环节用量行应直接调这个导出，不要再写一份
 * verdict 人话映射——两份一定会漂。
 */
export function finalReviewSummary(finalReview) {
  if (!finalReview) return '还没有最终检视结论';
  const key = text(finalReview.verdict);
  const verdict = key === 'merge' ? '放行并落地'
    : key === 'send_back' ? '打回'
    : key === 'abandon' ? '放弃这批改动'
    : (key || '（没有结论）');
  const sha = text(finalReview.mergedInto);
  return sha ? `终审：${verdict} · 合入 ${sha}` : `终审：${verdict}`;
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

/* ============================ 方案运行（供方案页与后续项目页共用） ============================ */

/**
 * 方案运行里一张票的状态。词必须和 Mission 的 STAGE_CN 不一样：
 * 「已完成」是一条任务走完，这里说的是方案里这张票合没合进去。
 */
export const PLAN_FEATURE_CN = {
  pending: '没轮到',
  running: '在跑',
  merged: '已合入',
  suspended: '挂起等你',
  skipped: '检视者跳过',
};

/** 方案为什么停。只贴 enum 名字等于没贴——交接面和网页必须说同一句话。 */
export const PLAN_STOP_CN = {
  unresolved_escalations: '未解决升级到上限',
  wall_clock: '墙钟到点',
  reviewer_stop: '检视者叫停',
  finished: '走完了',
  unsafe: '集成分支不安全',
  crashed: '驱动方出错',
  escalation_limit: '升级单到上限',
};

/** 夜间检视者能选的动作。网页只读展示，不把动作做成按钮。 */
export const PLAN_ACTION_CN = {
  rerun_isolated: '隔离重跑',
  skip: '跳过',
  rescope: '重划剩余范围',
  stop: '停',
  answer: '答复',
};

export const PLAN_HA_CN = {
  approve: '受控放行',
  send_back: '打回',
  expired: '审批过期',
  invalidated: '已失效',
};

/** 一张票现在处在方案里的哪一格。认不出的原样回显，空白会把线索吃掉。 */
export function planFeatureText(status) {
  const key = text(status);
  return PLAN_FEATURE_CN[key] || key || '（没有票状态）';
}

/**
 * 停止原因 + 细节。没有 stopped 回空串而不是「—」：还在跑和「原因就是横杠」
 * 必须分得开；空态由页面自己说「还在跑」。
 */
export function planStopText(stopped) {
  if (!stopped) return '';
  const reason = text(stopped.reason);
  const label = PLAN_STOP_CN[reason] || reason || '（没有写停止原因）';
  const detail = text(stopped.detail);
  return detail ? `${label}——${detail}` : label;
}

/** 方案运行还在不在跑。stopped 在就说停了，细节走 planStopText。 */
export function planStatusText(run) {
  const stop = planStopText(run && run.stopped);
  return stop ? `停了：${stop}` : '还在跑';
}

/** 检视者动作的人话。未知动作原样回显。 */
export function planActionText(action) {
  const key = text(action);
  return PLAN_ACTION_CN[key] || key || '（没有动作）';
}

/** HA 决定的人话。没有决定回空串：空着由页面说「还没有 HA 决定」。 */
export function planHaDecisionText(decision) {
  if (!decision) return '';
  const key = text(decision.kind);
  return PLAN_HA_CN[key] || key || '（没有 HA 结论）';
}

/**
 * 一次方案运行的花费：把各 Mission 的 usage.cost 加起来。
 *
 * **没上报的不能显示成 $0**：那看起来像「这次不要钱」。一条都没报就直说未上报；
 * 报了几条、漏了几条，把漏的数出来——漏的不当 0 加进去。
 */
export function planCostText(usages) {
  const list = Array.isArray(usages) ? usages : [];
  let sum = 0;
  let reported = 0;
  let missing = 0;
  for (const usage of list) {
    const cost = usage && usage.cost;
    if (cost !== undefined && cost !== null && Number.isFinite(Number(cost))) {
      sum += Number(cost);
      reported += 1;
    } else {
      missing += 1;
    }
  }
  if (reported === 0) return '费用未上报';
  const head = `$${sum.toFixed(4)}`;
  if (missing > 0) return `${head}（另有 ${missing} 条未上报，未计入）`;
  return head;
}

/* ============================ 上下文指标 / 任务改动 / 输出末尾 ============================ */

/**
 * 上下文采集分类。key 与 attempt.ended.contextMetrics 的桶对齐：
 * brief 是简报字节；工具桶 kind 是闭集（read/grep/find/ls/bash）。
 * 认不出的 key 原样回显：编一个「其它」会把唯一可查的线索抹掉。
 */
export const CONTEXT_METRIC_LABEL = {
  brief: '简报',
  read: '读文件',
  grep: '搜索',
  find: '查找',
  ls: '目录',
  bash: '命令输出',
};

export function contextMetricLabel(key) {
  const k = text(key);
  return CONTEXT_METRIC_LABEL[k] || k || '（没有分类）';
}

/** 缺整份指标时的说明。不能写成「0 字节」——没上报不是没采集。 */
export function contextMetricsMissingText() {
  return '这一跳没有上报上下文指标';
}

export function contextMetricsTitle() {
  return '上下文采集';
}

export function bytesText(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '（没有字节数）';
  return `${v.toLocaleString('en-US')} 字节`;
}

export function contextMetricLegendLine(key, bytes) {
  return `${contextMetricLabel(key)} ${bytesText(bytes)}`;
}

export function outputTailTitle() {
  return '输出末尾（已脱敏）';
}

export function changesTitle() {
  return '任务改动';
}

export function changesLoadingText() {
  return '改动读取中…';
}

export function changesEmptyText() {
  return '没有改动';
}

/** 读失败。message 是接口/网络给的，调用方负责转义。 */
export function changesErrorText(message) {
  const m = text(message);
  return m ? `读不到改动：${m}` : '读不到改动';
}

export function changesFileCountText(count) {
  const n = Math.max(0, Math.floor(num(count)));
  return `${n} 个文件`;
}

/**
 * 增删行。null/undefined 表示没上报，不说 0 行——git --stat 摘要缺失时
 * 写成 +0/-0 看起来像「对过了，就是零」。
 */
export function changesLineDeltaText(added, deleted) {
  const a = added === undefined || added === null || added === '' ? null : Number(added);
  const d = deleted === undefined || deleted === null || deleted === '' ? null : Number(deleted);
  const aOk = a !== null && Number.isFinite(a);
  const dOk = d !== null && Number.isFinite(d);
  if (!aOk && !dOk) return '';
  const plus = aOk ? `新增 ${a.toLocaleString('en-US')} 行` : '新增行数未上报';
  const minus = dOk ? `删除 ${d.toLocaleString('en-US')} 行` : '删除行数未上报';
  return `${plus} · ${minus}`;
}

export function changesFileLinesText(changed) {
  const n = Number(changed);
  if (!Number.isFinite(n)) return '';
  return `${n.toLocaleString('en-US')} 行`;
}

export function newFileLabel() {
  return '新建';
}

export function diffSummaryLabel() {
  return '差异摘要';
}

export function pendingMemoryNote(count) {
  const n = Math.max(0, Math.floor(num(count)));
  if (n === 0) return '';
  return `另有 ${n} 个文件会随本次落地一并写入`;
}
