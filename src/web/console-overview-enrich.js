/**
 * 总览的补充投影：详情里那些**列表接口没有**的事实——补修、集成落地、真实运行、
 * 问题附标——投影成一行上可以显示的几格。
 *
 * **为什么单开一个模块而不是塞进 console-overview-model.js**：model 吃的是
 * `/api/missions` 的 MissionSummary，一行一个列表项，每条事实都必须从那一行上真实
 * 存在的字段来。这几格只有 `/api/missions/:id` 的详情才有（workItems[].order、
 * finalReview.mergedInto、attemptIds），拿不到就只能是「未记录」。混进 model 里，
 * 迟早有人从列表行上「补一个默认值」，于是屏幕上出现一条没有来源的断言。
 *
 * 这个模块**不拼 HTML、不碰 DOM、不读时钟、不发请求**：它只吃详情对象与 Attempt
 * 列表，吐纯数据。取数是控制器的事，接线是渲染层的事。
 *
 * 四条不许越界的判断（每一条错了都不报错，只是让人对着屏幕做错判断）：
 *   1. **补修只认工单自己的开单声明**：真实数据里没有指向原工作项的结构化字段，
 *      `repairOf` 不存在、`origin.rerunOf` 是重跑不是补修。声明只能写在标题里，或写在
 *      `order.requiredBehaviour` 的第一行；正文后部的实现说明、代码块、测试夹具、
 *      上下文引用和检视意见都不算。把重跑画成补修，人会去找一张并不存在的原单据。
 *      全文关键词命中的危害见 `explicitRepair` 上方。
 *   2. **落地只认 finalReview.mergedInto**：没有这条证据就照实说「未记录」，
 *      不替平台断言「没合入」，也不引一句设计稿里的样本文案。
 *   3. **运行中只认真实 in_progress 的 Attempt**：executing 是阶段、isMutating 是
 *      占着改动名额、dispatched 是派出去了，三者在进程早已退出时都可能仍然为真。
 *   4. **问题升级的门禁判断不许抄第二份**：`projectMarks` 里那条已经区分了平台
 *      可信门禁（费用上限、工作项检查点）与真正的范围冲突；抄一份，两处迟早只改到
 *      一处，改掉的那边人就会去查一个不存在的分歧。
 */
import { projectMarks } from './console-overview-model.js';

const text = (value) => (value === undefined || value === null ? '' : String(value)).trim();
const list = (value) => (Array.isArray(value) ? value : []);
const object = (value) => (value && typeof value === 'object' ? value : null);

/** Attempt 只有这三种 kind 才对应一个能说出名字的角色。 */
const LIVE_KINDS = new Set(['executor', 'coordinator', 'independent_reviewer']);

/** 落地那两句的共同结尾：平台没有 master 上的合并证据，就不替它说合了还是没合。 */
const MASTER_UNRECORDED = 'master 未记录';

/**
 * 「正文说了补修并且点名原单就行」的老判据是错的，所以改成只认开单声明。
 *
 * 为什么不能拼全文做关键词命中：正在**实现**补修附标的那张单，标题就写着
 * 「总览补充投影：补修、落地与真实运行」，正文后部还抄了一条测试规则「含「补修」
 * 且含「原项」或「W-12」」；下游那些单的正文和 DOM 夹具里嵌着「补修原项 W-1 的
 * 缺口」。拼全文就会把这些正在实现附标的任务自己标成补修——它会让人去找一张并不
 * 存在的原单据，而且越是被引用得多、越容易被误判。
 *
 * 所以声明只有两个位置：标题，或 `requiredBehaviour` 的第一行。代码块、测试夹具行、
 * `contextRefs`、`doNot`、检视意见里引用的样例都是「提到补修」，不是「本单是补修」。
 */
function openingLine(body) {
  const raw = text(body);
  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') return '';
    if (trimmed.startsWith('```')) return '';
    if (/^(assert\.|explicitRepair\s*\(|it\s*\(|test\s*\(|title\s*:|order\s*:|requiredBehaviour\s*:|contextRefs\s*:|workItems\s*:)/.test(trimmed)) return '';
    return trimmed;
  }
  return '';
}

const TITLE_DECLARATION = /补修原项(?:\s+W-\d+)?|补修(?:工单|单)?[：:\s]+W-\d+|本单补修原项(?:\s+W-\d+)?/;
const OPENING_DECLARATION = /^(?:补修原项(?:\s+W-\d+)?|补修(?:工单|单)?[：:\s]+W-\d+|本单补修原项(?:\s+W-\d+)?)/;

function declaresRepair(title, body) {
  if (TITLE_DECLARATION.test(text(title))) return true;
  if (OPENING_DECLARATION.test(openingLine(body))) return true;
  return false;
}

/**
 * 补修：**只看 L2 交给 L1 那张工单自己的标题和 first line**。
 *
 * 每个 workItem 只交这两个字段给 `declaresRepair`：`objective`、`constraints`、
 * `acceptance`、`verification`、`doNot`、`contextRefs`、`executionResult`、`notes`、
 * `origin`、`repairOf` 一概不读。读它们就等于允许「复述一条规则」或「引用一个样例」
 * 变成一条附标。任一工单声明为真即返回真。
 *
 * `origin.rerunOf` 明确不看：它是「同一个目标重来一遍」，与「补上一张单没做完的
 * 部分」是两件事。`repairOf` 这个字段真实数据里不存在，也不认——认了就等于给
 * 一个不存在的接口留了钩子，谁都能往里塞一个 id 把重跑画成补修。
 */
export function explicitRepair(detail) {
  const d = object(detail);
  if (d === null) return false;
  if (!Array.isArray(d.workItems)) return false;

  for (const workItem of d.workItems) {
    const item = object(workItem);
    if (item === null) continue;
    const order = object(item.order) ?? {};
    if (declaresRepair(item.title, order.requiredBehaviour)) return true;
  }
  return false;
}

/**
 * 集成落地那一格。
 *
 * `finalReview.mergedInto` 是平台唯一一条「合进哪儿了」的证据（内核 FinalReview）。
 * 没有它就不能说「未合入」——终审可能还没做，也可能做了但这条记录没落盘，
 * 两种都只是「平台不知道」。所以两句都用「未记录」，不替平台下结论。
 *
 * 只在 completed / blocked 这种已经走完的状态上说「未记录」：执行中的任务本来就
 * 还没到落地这一步，在它旁边挂一句「落地未记录」，等于催一件还没轮到的事。
 */
export function landingLine(detail) {
  const d = object(detail);
  if (d === null) return '';

  const finalReview = object(d.finalReview) ?? {};
  if (text(finalReview.mergedInto) !== '') return `已合入集成 · ${MASTER_UNRECORDED}`;

  const status = text(d.status);
  if (status === 'completed' || status === 'blocked') return `落地未记录 · ${MASTER_UNRECORDED}`;
  return '';
}

/**
 * 详情里**每个槽位的最后一条** Attempt，供控制器去取那几条详情。
 *
 * 只取最后一条的理由：attemptIds 是历史，几百条一路列出来既没人看、又把请求量
 * 放大成整条时间线。运行中与否、当前在哪一跳，答案都在最后那条上；之前的 id 对
 * 「这一刻发生过什么」没有增量。
 *
 * 顺序固定为 协调者 → 独立检视者 → 各工作项：屏幕上按这个顺序排，改一次顺序就
 * 是所有人重新认一遍位置。按 attemptId 去重，但保持首次出现的顺序。
 */
export function candidateAttemptRefs(detail) {
  const d = object(detail) ?? {};
  const missionId = text(d.missionId);
  const seen = new Set();
  const refs = [];

  const take = (id) => {
    const attemptId = text(id);
    if (attemptId === '' || seen.has(attemptId)) return;
    seen.add(attemptId);
    refs.push({ missionId, attemptId });
  };
  const lastOf = (ids) => {
    const arr = list(ids);
    return arr.length === 0 ? '' : arr[arr.length - 1];
  };

  take(lastOf(d.coordinatorAttemptIds));
  take(lastOf(d.independentReviewerAttemptIds));
  for (const workItem of list(d.workItems)) {
    const item = object(workItem);
    if (item === null) continue;
    take(lastOf(item.attemptIds));
  }
  return refs;
}

/**
 * 真实的运行中 Attempt。
 *
 * `status === 'in_progress'` 是**进程层面**的事实（Attempt 详情里才有），别的都不算：
 * executing 是 Mission 阶段，isMutating 说的是占着改动名额，dispatched 只说明派出去了。
 * 三者都可能在进程退出后仍然为真，拿它们推断「正在跑」会让人等一个不会自己再动的
 * 任务，或者去 Kill 一个刚起来的进程。
 *
 * kind 认不出就留空串，由 runningTextOf 说一句中性的「运行中」——不猜角色。
 */
export function liveAttemptOf(attempts) {
  if (!Array.isArray(attempts)) return { live: false, kind: '' };
  for (const candidate of attempts) {
    const attempt = object(candidate);
    if (attempt === null) continue;
    if (text(attempt.status) !== 'in_progress') continue;
    const kind = text(attempt.kind);
    return { live: true, kind: LIVE_KINDS.has(kind) ? kind : '' };
  }
  return { live: false, kind: '' };
}

/** 运行中那句话。只有真有一个 in_progress 的 Attempt 才说得出口。 */
export function runningTextOf(live) {
  const l = object(live);
  if (l === null || l.live !== true) return '';
  if (l.kind === 'executor') return '执行者运行中';
  if (l.kind === 'coordinator') return '协调者运行中';
  if (l.kind === 'independent_reviewer') return '检视运行中';
  return '运行中';
}

/**
 * 详情 + Attempt 列表 → 一行上要补的那几格。
 *
 * problem 走 `projectMarks`，不自己判：那条门禁（未答复 **且** 不带 platformGate）
 * 决定了「已升级（问题）」出不出，抄一份就等于允许两处哪天只改到一处。
 * `openEscalations` 的**数字**在这里没有用：条数含平台可信门禁（费用上限、
 * 工作项检查点），把它当问题会让人去查一个不存在的范围冲突。
 */
export function overlayFromDetail(detail, attempts) {
  const d = object(detail);
  const marks = projectMarks({ openEscalations: d === null ? undefined : d.openEscalations });
  const live = liveAttemptOf(attempts);
  return {
    repair: explicitRepair(d),
    problem: marks.some((mark) => mark.key === 'problem'),
    landingLine: landingLine(d),
    liveAttempt: live.live,
    runningText: runningTextOf(live),
  };
}

/**
 * 把补充投影合到一行上，**返回副本**。
 *
 * 返回副本而不是就地改：同一行可能被两个地方同时渲染（列表与选中详情），就地追加
 * 会让另一边莫名其妙多出几个附标，而且刷新一次就多一组，越刷新越长。
 *
 * 附标只追加、不替换：paused / direct / problem 都是 model 从真实字段投影出来的，
 * 这里没有资格删。追加过才重算 marksText —— 没追加就保留原来那句，免得把别的
 * 地方拼进去的分隔或措辞悄悄改掉。
 *
 * 空串一律不写：「不知道」在界面上应该是没有这一格，而不是一格空白或一句默认话。
 * owner 一个字都不动：补修与运行中都不改变「该谁动手」。
 */
export function applyOverlay(row, overlay) {
  const base = object(row) ?? {};
  const copy = {
    ...base,
    marks: list(base.marks).map((mark) => (object(mark) === null ? mark : { ...mark })),
  };

  const o = object(overlay);
  if (o === null) return copy;

  let appended = false;
  const has = (key) => copy.marks.some((mark) => object(mark) !== null && mark.key === key);

  if (o.repair === true && !has('repair')) {
    copy.marks.push({ key: 'repair', text: '补修' });
    appended = true;
  }
  if (o.problem === true && !has('problem')) {
    copy.marks.push({ key: 'problem', text: '已升级（问题）' });
    appended = true;
  }
  if (appended) copy.marksText = copy.marks.map((mark) => text(object(mark)?.text)).join(' · ');

  const landing = text(o.landingLine);
  if (landing !== '') copy.landingLine = landing;
  if (o.liveAttempt === true) copy.liveAttempt = true;

  const running = text(o.runningText);
  if (running !== '') copy.runningText = running;

  return copy;
}
