/**
 * 任务详情里「当前实时输出」与「历史选择」的分账（Contract AC3 的呈现层）。
 *
 * 要解决的问题：详情页上默认显示的是**当前这一跳**的实时行，而右侧可以选中**任意
 * 一个历史 Attempt**。两者一旦共用一个 id 变量，就会出现最坏的那种界面：人点开了
 * 上一条失败的尝试，左边却还在刷当前这一跳的正文，右边又把上一跳的尾部摆在一起——
 * 于是「它到底在哪儿跑、跑的是什么」全靠时间顺序猜，猜错的代价是把上一跳的结尾当成
 * 正在进行的进度，或者把当前跳的行算成历史那一次的输出。
 *
 * 所以这里的每一格都**只认自己那一跳的 id**：
 *   - 实时行：只有 `attemptId === currentAttemptId` 的 chunk 能进 liveText。
 *   - 历史正文 / 用量：只有 `selectedAttempt.attemptId === selectedAttemptId` 时才有
 *     可信来源；id 对不上、详情没取到、这一跳还没结束、输出为空，一律「未知」。
 *     **不许退而求其次**去拿 liveText、也不许拿 mission 上别的 output 顶替；那正是
 *     「看起来有内容、其实不是这一跳」的来源，且界面上看不出来。
 *   - 任务累计用量（missionUsage）**不参与**：它是一整条 Mission 的总数，拿它冒充
 *     单跳用量，人就会据此判断「这一跳花了多少」，而这个数字根本没被量过。
 *   - 文件清单：这个接口没有按 Attempt 的清单，所以恒为 null。调用方就算在 input
 *     里塞了 missionDiff / executionResult，也**故意忽略**——那是任务级的事实，
 *     挂到某一跳下面就是把两笔账合成一笔。
 *
 * 心跳看的是**当前**这一跳（currentAttempt），不是选中的历史那一跳：选中历史时右侧
 * 显示的是已保存的结尾，用它的心跳去说「还在跑」或「疑似停滞」都答非所问。
 *
 * 90000 与 `src/application/reconcile.ts` 的 DEFAULT_LEASE_TOLERANCE_MS 同值，但
 * **不 import 那个文件**：这是浏览器模块，拉 application 层会把整条服务端的依赖
 * 拽进前端。两处同值这件事只能靠这条注释和常量名保持，改一处就得改另一处。
 *
 * 零请求、不拼 HTML、不碰 DOM，函数内**不取当前时间**（nowIso 由调用方给）：两次
 * 渲染同一条数据必须得出同样的字，否则「疑似停滞」会随着刷新自己跳来跳去。
 */
import { savedTailEligible } from './session-output.js';

/**
 * 心跳多久没来就算疑似停滞。与 reconcile 的租约容忍窗口一致：
 * 界面上说「疑似停滞」的门槛比收敛真正收掉它的门槛更早，人就不会看到
 * 「还没标停滞，任务却已经被判成没人管」。
 */
export const LEASE_TOLERANCE_MS = 90000;

/** 未知就是未知：不补成 0、不补成一句默认话、不补成上一跳的内容。 */
const UNKNOWN = '未知';
const HISTORY_OUTPUT_UNKNOWN = '历史正文未知';
const HISTORY_FILES_UNKNOWN = '该尝试没有单独的文件清单';
const HEARTBEAT_NOT_APPLICABLE = '心跳不适用';
const HEARTBEAT_UNKNOWN = '心跳未知';
const HEARTBEAT_STALLED = '疑似停滞';

const text = (value) => (value === undefined || value === null ? '' : String(value)).trim();
const object = (value) => (value && typeof value === 'object' ? value : null);
const iso = (value) => (value === undefined || value === null ? '' : String(value));

/** 结束态只有这两个。别的状态既不能说「已结束」，也不能据此断言停滞。 */
const TERMINAL_STATUSES = ['succeeded', 'failed'];

/**
 * 历史正文。
 *
 * 门禁交给 `savedTailEligible` 判，**不在这里抄一份**：id 匹配、这一跳已结束、输出
 * 非空这三条在 session-output.js 里已经写死并有用例，两边各写一份的话迟早只改到
 * 一处，而漏改的那侧在界面上就是一段不该出现或该出现却没了的历史正文。
 */
function projectHistoryOutput(selectedAttempt, selectedAttemptId) {
  const selected = object(selectedAttempt);
  const matched = selected !== null
    && text(selected.attemptId) !== ''
    && text(selected.attemptId) === selectedAttemptId;

  const eligible = matched && savedTailEligible({
    groupAttemptId: selectedAttemptId,
    attemptId: text(selected.attemptId),
    attemptOutput: iso(selected.output),
    attemptStatus: text(selected.status),
  });

  if (!eligible) {
    // 详情缺失、id 不匹配、未结束、空输出都走这条：宁可明说不知道，
    // 也不要让调用方顺手拿实时行或任务级 output 填进来。
    return { attemptId: matched ? selectedAttemptId : null, matched, output: null, note: HISTORY_OUTPUT_UNKNOWN };
  }
  return { attemptId: selectedAttemptId, matched, output: iso(selected.output), note: '' };
}

/**
 * 历史用量。只在 id 匹配时取这一跳自己的 usage；quality 原样留下，
 * 缺失不补成 0——「没报过」和「花了 0」在预算判断上是两件事。
 */
function projectHistoryUsage(selectedAttempt, selectedAttemptId, matched) {
  if (!matched) return null;
  const usage = object(selectedAttempt.usage);
  return usage === null ? null : { ...usage };
}

/**
 * 当前这一跳的心跳。
 *
 * 已结束的两跳即使带着很久以前的心跳，也只能说「不适用」：把它读成停滞，
 * 人就会去重启一个明明已经交回结果的环节。
 *
 * 只有「in_progress + 可解析的真实 heartbeatAt + 可解析的 nowIso + 超窗口」才说
 * 疑似停滞。字段缺失、空串、非法时间读不出来，一律只说「心跳未知」：master 上
 * 已有的 Attempt 响应根本没有 heartbeatAt 这个键，把它读成停滞，人就会去重启一个
 * 也许正在正常输出的环节，而界面上没有任何东西能揭穿这个误判。
 */
function projectHeartbeat(currentAttempt, nowIso) {
  const attempt = object(currentAttempt);
  if (attempt === null) {
    // 详情还没取到：既不能说在跑，也不能说停滞。
    return { applicable: false, heartbeatAt: null, stateText: UNKNOWN, stalled: false };
  }

  const status = text(attempt.status);
  const heartbeatAt = iso(attempt.heartbeatAt);

  if (TERMINAL_STATUSES.includes(status)) {
    return { applicable: false, heartbeatAt: heartbeatAt === '' ? null : heartbeatAt, stateText: HEARTBEAT_NOT_APPLICABLE, stalled: false };
  }
  if (status !== 'in_progress') {
    // 状态未知时不下断言：说「停滞」会催人去动手，说「正常」会让人干等。
    return { applicable: false, heartbeatAt: heartbeatAt === '' ? null : heartbeatAt, stateText: UNKNOWN, stalled: false };
  }

  const last = Date.parse(heartbeatAt);
  const now = Date.parse(iso(nowIso));
  if (heartbeatAt === '' || Number.isNaN(last) || Number.isNaN(now)) {
    // 心跳缺失/为空/读不出，或当前时间读不出：这里没有任何事实能支持「停滞」，
    // 只能承认不知道。判成停滞会催人去重启一条可能还在正常输出的尝试，代价不可逆。
    return { applicable: true, heartbeatAt: heartbeatAt === '' ? null : heartbeatAt, stateText: HEARTBEAT_UNKNOWN, stalled: false };
  }

  const stalled = now - last > LEASE_TOLERANCE_MS;
  return {
    applicable: true,
    heartbeatAt,
    // 显示原 ISO，不在这里本地化：同一条数据在两个界面里不该长得不一样。
    stateText: stalled ? HEARTBEAT_STALLED : `心跳 ${heartbeatAt}`,
    stalled,
  };
}

/**
 * 一条详情页数据 → 实时 / 历史 / 心跳三块互不串账的事实。
 *
 * input = { currentAttemptId, selectedAttemptId, nowIso, currentAttempt,
 *           selectedAttempt, liveChunks, missionUsage }
 * 纯函数：不改入参、不读时钟、不发请求、不拼 HTML。
 */
export function projectOutputBinding(input) {
  const it = object(input) ?? {};

  const currentAttemptId = text(it.currentAttemptId);
  const selectedAttemptId = text(it.selectedAttemptId);

  // 实时输出永远属于**当前**这一跳，与右侧选了哪条历史无关。
  // 这是本模块存在的理由：两者共用一个变量时，选中历史就会把左边也换掉。
  const liveAttemptId = currentAttemptId === '' ? null : currentAttemptId;
  const liveChunks = Array.isArray(it.liveChunks) ? it.liveChunks : [];
  const liveText = currentAttemptId === ''
    ? ''
    : liveChunks
      // 别的 Attempt 的行一律不进：混一行进来，人就会把上一跳的结尾当成这一跳的进度。
      .filter((chunk) => text(chunk && chunk.attemptId) === currentAttemptId)
      .map((chunk) => iso(chunk.text))
      .join('');

  const historyOutput = projectHistoryOutput(it.selectedAttempt, selectedAttemptId);
  const historyUsage = projectHistoryUsage(object(it.selectedAttempt), selectedAttemptId, historyOutput.matched);

  return {
    liveAttemptId,
    historyAttemptId: selectedAttemptId === '' ? null : selectedAttemptId,
    liveText,
    historyOutput,
    historyUsage,
    // 本接口拿不到按 Attempt 的文件清单。恒为 null：拿 missionDiff / executionResult
    // 顶替，就是把任务级的改动记到某一跳名下。
    historyFiles: {
      attemptId: historyOutput.matched ? selectedAttemptId : null,
      files: null,
      note: HISTORY_FILES_UNKNOWN,
    },
    // 心跳看当前这一跳，不看选中的历史那一跳。
    heartbeat: projectHeartbeat(it.currentAttempt, it.nowIso),
  };
}
