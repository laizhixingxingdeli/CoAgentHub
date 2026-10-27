/**
 * 任务详情页的接线层：取数、轮询、状态记忆与 live 游标。
 *
 * 与 task-detail-page.js 的分工是一条直线：那一层是「这份数据画成什么样」的纯函数，
 * 本层是「什么时候去取、取回来的东西能不能写上屏」。混在一处的后果不是代码丑，而是
 * 每一条「看着对、其实在说谎」的错都变得查不出来——上一跳的实时行混进这一跳、晚到的
 * 响应画到刚切过去的任务上、心跳缺失被读成停滞。这些在浏览器里都不报错、不崩，屏幕
 * 上只是一句不一样的话。
 *
 * **不 import src/application**：这里跑在浏览器里，拉 application 层会把整条服务端
 * 依赖拽进前端。页面只认 `/api/*` 投影出来的 view。
 *
 * **只发五条只读 GET**：mission、activity、attempts/:attemptId、live?cursor=、
 * validation-reports/:reportId。审批、取消、恢复、终审、合入都要人明说且各有入口，
 * 在这一层补一个 POST，屏幕上就会多出一个看起来能点、其实没有业务含义的控件。
 *
 * 最后那一条就是为了交付区能写出「已跑命令与计数」：Mission 视图只带报告简版
 * （reportId/passed），命令的 argv 与输出尾都在完整报告里。它是只读 GET、不新增端点，
 * 所以不违背上面那条边界。
 *
 * **不自己判交付**：六层验证只在 task-detail-delivery.js 里投影一次。本层再判一份
 * 「这一跳算不算交回」，两处迟早只改到一处，而漏改的那边在界面上就是一句「通过」。
 */
import {
  bindTaskDetail,
  currentLiveAttemptId,
  ensureTaskDetailStylesheets,
  latestEndedAttemptId,
  taskDetailHtml,
} from './task-detail-page.js';
import { currentReportIdOf } from './task-detail-delivery.js';
import { normalizeLiveLine } from './session-output.js';
import { nextRefresh } from './projects.js';

const text = (value) => (value === undefined || value === null ? '' : String(value)).trim();
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const list = (value) => (Array.isArray(value) ? value : []);

const pathOfMission = (missionId) => '/api/missions/' + encodeURIComponent(missionId);
const pathOfAttempt = (missionId, attemptId) => pathOfMission(missionId) + '/attempts/' + encodeURIComponent(attemptId);
const pathOfLive = (missionId, cursor) => pathOfMission(missionId) + '/live?cursor=' + cursor;
const pathOfReport = (missionId, reportId) => pathOfMission(missionId)
  + '/validation-reports/' + encodeURIComponent(reportId);

/**
 * 每个 Mission 的 live 游标与已收行，模块级。
 *
 * 游标的语义就是「我看到哪了」：换页再回来要是从 0 重拉，已经翻过去的那几段会被
 * 重新追加一遍，屏幕上看起来像 agent 把同样的活又干了一次。按 missionId 分桶则是因为
 * 两条任务的 seq 各算各的，把上一任务的游标带过去会漏掉新任务开头那几行。
 */
const liveByMission = new Map();

function liveEntry(missionId) {
  let entry = liveByMission.get(missionId);
  if (!entry) {
    entry = { cursor: 0, lines: [] };
    liveByMission.set(missionId, entry);
  }
  return entry;
}

/**
 * 当前活着的那一只控制器。
 *
 * 「换 mission 或换容器时先 stop 上一只」只有模块级登记才做得到：新实例手里没有旧实例
 * 的引用，而容器是构造时定死的，所以「换容器」必然是另一个实例。不登记的话，两只控制器
 * 的定时器一起打接口，晚到的那份还会画到对方刚画好的页面上，而屏幕上只是「数据偶尔
 * 跳一下」。详情页同时只有一页，所以只留一只。
 */
let activeController = null;

async function defaultFetchJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
  return res.json();
}

/**
 * 人没点名、深链也没对上时，默认选中哪一项。
 *
 * 规则与 task-detail-flow.js 的 selectWorkItem **逐条对齐**：先看是否有一跳正在跑
 * （started 且还没 ended，多个同时开着取最后一个），再看最后一个没被作废的，
 * 都落空就是空串。不兜底成第一项：第一项往往是早就验收掉的那张，看起来像它才是当前活。
 *
 * 为什么要在这里也有一份：交付与契约两个页签只认显式传下去的 selectedWorkItemId，
 * 给空串就是「没有所选工作项」——一条明明在跑的工单，交付六层
 * 全说没开始，人就会去重派一次。上一轮的页模块只在自己的投影里退让，没把这个选择
 * 回传给调用方，而本单不允许改那个文件。
 */
function defaultWorkItemId(view, activity) {
  const items = list(object(view) && object(view).workItems).filter((item) => object(item) !== null);
  if (items.length === 0) return '';
  const live = currentLiveAttemptId(activity);
  if (live !== null) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (list(items[i].attemptIds).map(text).includes(live)) return text(items[i].id);
    }
    const events = list(activity);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = object(events[i]);
      if (event === null || text(event.attemptId) !== live) continue;
      const workItemId = text(event.workItemId);
      if (workItemId !== '') return workItemId;
    }
  }
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (text(items[i].status) !== 'retired') return text(items[i].id);
  }
  return '';
}

/**
 * 这一项当前环节是哪一跳。
 *
 * 先认活动流里最后一次 attempt.started（那是真的派出去了），再退回工单上记的最后一跳：
 * 事件刚落库之前 attemptIds 已经有了，这段窗口里留空会让右侧显示「未知」，而这一项
 * 其实明明派出去过。
 */
function currentStageAttemptId(view, activity, workItemId) {
  const id = text(workItemId);
  if (id === '') return '';
  const events = list(activity);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = object(events[i]);
    if (event === null) continue;
    if (text(event.workItemId) !== id) continue;
    if (text(event.kind) !== 'attempt.started') continue;
    const attemptId = text(event.attemptId);
    if (attemptId !== '') return attemptId;
  }
  const items = list(object(view) && object(view).workItems);
  const item = items.find((entry) => text(entry && entry.id) === id);
  const attempts = list(item && item.attemptIds).map(text).filter((attemptId) => attemptId !== '');
  return attempts.length === 0 ? '' : attempts[attempts.length - 1];
}

/**
 * 建一个任务详情控制器。返回 `{ start, stop, refresh, state }`。
 *
 * deps 全部可注入（doc / container / missionId / selectedStep / fetchJson / nowIso /
 * setInterval / clearInterval / visible）：浏览器里默认就是全局那几个，测试里换掉它们
 * 才能在没有真服务、真时钟的情况下验「续游标」「隐藏不发 live」「晚到不落 DOM」这类
 * 只在时序里出现的错。
 */
export function createTaskDetailController(deps = {}) {
  const doc = deps.doc || globalThis.document;
  const container = deps.container;
  if (!doc || !container) throw new TypeError('createTaskDetailController 需要 doc 与 container');

  const fetchJson = deps.fetchJson || defaultFetchJson;
  const setIntervalFn = deps.setInterval || globalThis.setInterval;
  const clearIntervalFn = deps.clearInterval || globalThis.clearInterval;

  // nowIso 由调用方给：函数里一旦自己 new Date()，同一条数据两次渲染会得出不同的字，
  // 「运行 3 分 12 秒」会随着刷新自己跳，而人只看到任务在反复变长。缺省才取当前时刻。
  const nowIsoFn = deps.nowIso === undefined
    ? () => new Date().toISOString()
    : (typeof deps.nowIso === 'function' ? deps.nowIso : () => String(deps.nowIso));

  // 缺省看标签页可见性：隐藏着的页面继续轮询，是给看不见的人烧配额。
  const isVisible = typeof deps.visible === 'function'
    ? deps.visible
    : () => (typeof doc.visibilityState === 'string' ? doc.visibilityState !== 'hidden' : true);

  const state = {
    missionId: text(deps.missionId),
    /**
     * 深链给的那一步（工作项 id 或 attemptId）。先存着、等 view 回来再对上：
     * 现在就套，等于在还不知道有哪些工作项的时候猜一个选中项。
     */
    pendingStep: deps.selectedStep === null || deps.selectedStep === undefined ? '' : String(deps.selectedStep),
    // 人自己点过一次之后，深链那一步就不再回手套上去——那会把人的选择翻回去。
    userPicked: false,
    view: null,
    activity: [],
    nowIso: '',
    // 四个交互态由 onUi 写回：轮询重绘时必须原样传回 taskDetailHtml，否则每 3 秒
    // 一次刷新都会把页签、展开态和输出侧栏弹回缺省，人正在看的那块自己消失。
    tab: '',
    intentExpanded: false,
    historyExpanded: false,
    outputSide: '',
    selectedWorkItemId: '',
    selectedAttemptId: '',
    currentAttempt: null,
    selectedAttempt: null,
    /**
     * 没有实时那一跳时，同一条 Mission **最近一条已结束 Attempt** 的详情。
     *
     * 单独一格、不写进 currentAttempt / selectedAttempt：那两格各有一个含义（“正在跑的”
     * 与“人点开的”），把已结束的一跳塞进去，左标题会把一次停了的执行写成当前，右栏
     * 又会把人的浏览选择翻掉。
     */
    recentEndedAttempt: null,
    /**
     * recentEndedAttempt 取的是哪一个 id（拉过就记住，拉失败也算，“”= 还没取过）。
     * 不记住就会每 3 秒重拉一次同一条已结束 Attempt：它永远不会变，而那些请求
     * 在“这一页已经不动了”的时候仍然刷着接口。
     */
    recentEndedLoadedId: '',
    /**
     * 当前选中那一跳的完整机器验证报告（已跑命令、计数、行数的唯一来源）。
     * 切工作项或报告对不上时必须先置 null 再 paint：留着上一份，屏幕上就会把
     * 别人的命令当成本跳跑过的。
     */
    validationReportFull: null,
  };

  let running = false;
  let stopped = false;
  /** 代次：换任务、隐藏、stop 各加一，晚到的响应凭它作废。 */
  let cycleGen = 0;
  /** 在飞那一轮的代次。-1 = 没有在飞的。按代次判而不是一个布尔：换任务后旧那轮还在路上，
   * 布尔会让新那一轮被当成「上一轮没回来」直接不发，整页就停在旧数据上。 */
  let inflightGen = -1;
  let timer = null;
  let liveTimer = null;
  /** 有没有往 container 里画过这一页。没画过的容器谈不上「被别人换掉」。 */
  let painted = false;
  /** hashchange 只挂一次：同一条 Mission 重复 start 会走早退分支，再挂一次就会停两次。 */
  let listening = false;

  // 事件挂在 window 上而不是 document 上：hashchange 是 window 的事件，挂错对象就永远
  // 收不到，离页后旧轮询会一直打接口，屏幕上看起来只是「返回了但请求还在」
  const win = deps.win
    || (doc && doc.defaultView)
    || (typeof globalThis.window === 'undefined' ? null : globalThis.window);

  /* ---------------------------- 画 ---------------------------- */

  /**
   * 容器里画的还是不是我们这一页。
   *
   * 生产路径是 app.js 的 hashchange → render() 给同一个 #view 换 innerHTML：容器始终
   * connected，所以 onTick 里那道 isConnected 一句话都不会说。只有「画出来的那页还带着
   * 我写下的归属标记」能说明所有权，少了这一句，旧定时器与在途响应会把任务详情
   * 画回资源页或总览。
   */
  function relinquished() {
    if (!painted) return false;
    if (typeof container.querySelector !== 'function') return false;
    const root = container.querySelector('[data-td-owner]');
    const owner = root && typeof root.getAttribute === 'function' ? text(root.getAttribute('data-td-owner')) : '';
    return owner !== text(state.missionId);
  }

  function paint() {
    // 归属已经换人（或已经被 stop 过）：先停自己再走，一个字都不许写回容器。
    // 在途响应晚到也是走这条路，所以只挡定时器是不够的。
    if (stopped || relinquished()) {
      stop();
      return;
    }
    const entry = liveEntry(text(state.missionId));
    container.innerHTML = taskDetailHtml({
      view: state.view,
      activity: state.activity,
      nowIso: state.nowIso,
      tab: state.tab,
      intentExpanded: state.intentExpanded,
      historyExpanded: state.historyExpanded,
      outputSide: state.outputSide,
      selectedWorkItemId: state.selectedWorkItemId,
      selectedAttemptId: state.selectedAttemptId,
      currentAttempt: state.currentAttempt,
      selectedAttempt: state.selectedAttempt,
      recentEndedAttempt: state.recentEndedAttempt,
      validationReportFull: state.validationReportFull,
      // 重绘时 live 正文用这份 lines：它不是「这一轮新到的」，而是这一任务至今收到的
      // 全部行——只传本轮新增的话，每次重绘屏幕上就只剩最新一段。
      liveChunks: entry.lines,
    });
    const root = typeof container.querySelector === 'function' ? container.querySelector('.td-page') : null;
    if (root) {
      // 写下归属：之后别的页面把同一个容器的 innerHTML 换掉，这一句就是 relinquished()
      // 唯一能识破的方式。写在画完之后，写之前就查等于给自己判「还没画」。
      if (typeof root.setAttribute === 'function') root.setAttribute('data-td-owner', text(state.missionId));
      bindTaskDetail(root, handlers);
    }
    painted = true;
  }

  /* ---------------------------- 交互 ---------------------------- */

  /** UI 状态一次只报一格：把整份 model 报回去，调用方分不清是哪一次交互触发的。 */
  function onUi(patch) {
    const p = object(patch) ?? {};
    if ('tab' in p) state.tab = text(p.tab);
    if ('intentExpanded' in p) state.intentExpanded = p.intentExpanded === true;
    if ('historyExpanded' in p) state.historyExpanded = p.historyExpanded === true;
    if ('outputSide' in p) state.outputSide = text(p.outputSide);
    paint();
  }

  /**
   * 切工作项：只换选择，不动 live Map。
   *
   * 历史那一跳跟着这一项的当前环节走，**绝不动实时那一跳**：左边是这一页存在的理由，
   * 改它一次，人就会把上一跳的结尾当成正在跑的进度。
   */
  async function onWorkItem(workItemId) {
    if (stopped) return;
    const id = text(workItemId);
    const missionId = text(state.missionId);
    state.userPicked = true;
    state.selectedWorkItemId = id;
    const attemptId = currentStageAttemptId(state.view, state.activity, id);
    state.selectedAttemptId = attemptId;
    state.selectedAttempt = null;
    // 切工作项先清掉上一项的完整报告再 paint：留着它，屏幕上会把上一项跑过的命令
    // 写在新选中项的摘要里，而两者看起来完全一样。
    state.validationReportFull = null;
    paint();
    if (missionId === '') return;
    const gen = cycleGen;
    state.validationReportFull = await loadValidationReport(gen, missionId, state.view);
    if (gen !== cycleGen || stopped || !isVisible()) return;
    if (attemptId !== '') {
      const detail = await loadAttempt(gen, missionId, attemptId);
      if (gen !== cycleGen || stopped || !isVisible()) return;
      state.selectedAttempt = detail;
    }
    paint();
  }

  /** 选历史那一跳：只拉这一跳的 Attempt，实时 id 一个字都不动。 */
  async function onSelectAttempt(attemptId) {
    if (stopped) return;
    const id = text(attemptId);
    const missionId = text(state.missionId);
    state.userPicked = true;
    state.selectedAttemptId = id;
    state.selectedAttempt = null;
    if (id === '' || missionId === '') {
      paint();
      return;
    }
    const gen = cycleGen;
    const detail = await loadAttempt(gen, missionId, id);
    if (gen !== cycleGen || stopped || !isVisible()) return;
    state.selectedAttempt = detail;
    paint();
  }

  const handlers = { onUi, onWorkItem, onSelectAttempt };

  /* ---------------------------- 取 / 拉 ---------------------------- */

  async function loadAttempt(gen, missionId, attemptId) {
    const id = text(attemptId);
    if (id === '') return null;
    try {
      const detail = await fetchJson(pathOfAttempt(missionId, id));
      if (gen !== cycleGen || stopped) return null;
      return detail;
    } catch {
      // 一跳的明细拉不到只影响那一格：把整页说成「加载失败」，人会以为整条任务没了。
      return null;
    }
  }

  /**
   * 拉当前选中那一跳的完整机器验证报告（已跑命令 / 计数 / 行数）。
   *
   * 三个前置条件缺一个就不发请求：没选中项、未交回、报告号为空。dispatched 上
   * 残留着上一跳的 reportId 时，那份报告讲不出这一跳过没过，拉回来只会把它贴上。
   *
   * 失败一律回 null：报告拉不到只影响「已跑命令」那几行，整页六层事实还在；
   * 但绝不能用上一份顶上——那就是把别人的命令当这一跳跑过的。
   */
  async function loadValidationReport(gen, missionId, view) {
    const reportId = currentReportIdOf(view, state.selectedWorkItemId);
    if (reportId === '') return null;
    try {
      const full = await fetchJson(pathOfReport(missionId, reportId));
      if (gen !== cycleGen || stopped) return null;
      return object(full);
    } catch {
      return null;
    }
  }

  /**
   * 拉一次 live，追加到这一任务自己的 lines 上。返回是否真的收到了行。
   *
   * usage 类 chunk 不推进 lines：它是累计用量快照，不是一行正文；塞进去会让实时正文
   * 里多出一段屏幕上根本没有的东西，而且每次轮询都重复追加一遍。
   */
  async function pullLive(gen, missionId, entry) {
    const body = await fetchJson(pathOfLive(missionId, entry.cursor));
    if (gen !== cycleGen || stopped) return false;
    const b = object(body) ?? {};
    let changed = false;
    for (const chunk of list(b.chunks)) {
      const c = object(chunk);
      if (c === null) continue;
      if (text(c.kind) === 'usage') continue;
      // normalizeLiveLine 保留 attemptId 与 seq：丢了 attemptId，实时正文就分不清
      // 这一行是谁吐的；丢了 seq，「这两段是不是同一次流」再也答不上来。
      entry.lines.push(normalizeLiveLine(c));
      changed = true;
    }
    // cursor 为有限数才写入：把 undefined / NaN 写进 Map，下一次请求带上 cursor=NaN，
    // 服务端按 0 处理，整段历史会被重复追加一遍。
    const next = typeof b.cursor === 'number' ? b.cursor : Number(b.cursor);
    if (Number.isFinite(next)) entry.cursor = next;
    return changed;
  }

  /**
   * 深链那一步对上号。
   *
   * 等于某个 workItem.id 时选中它；等于某个 workItem.attemptIds 里的 id 时选中拥有它的
   * 工作项。**对不上就什么都不设**，让页模块自己选：硬套到别的工单上，界面会显示一张
   * 没被选中的工单的结论，而人正拿它判断要不要动手。
   */
  function applyPendingStep() {
    const step = text(state.pendingStep);
    if (step === '' || state.userPicked) return;
    const view = object(state.view);
    if (view === null) return;
    state.pendingStep = '';
    const items = list(view.workItems);
    if (items.some((item) => text(item && item.id) === step)) {
      state.selectedWorkItemId = step;
      return;
    }
    const owner = items.find((item) => list(item && item.attemptIds).map(text).includes(step));
    if (owner) {
      state.selectedWorkItemId = text(owner.id);
      state.selectedAttemptId = step;
    }
  }

  /** 一轮完整取数：mission → activity → 两跳 Attempt → live。 */
  async function refresh() {
    if (stopped || !running) return;
    if (!isVisible()) {
      stopTimers();
      return;
    }
    const missionId = text(state.missionId);
    if (missionId === '') return;
    // 同一代里上一轮还没回来就不发下一轮：两轮同时在路上时，先发出去的那轮晚到
    // 就会覆盖新的。换代（换任务 / 隐藏 / stop）之后旧那轮已经作废，不挡新的。
    if (inflightGen === cycleGen) return;
    const gen = cycleGen;
    inflightGen = gen;
    try {
      let view;
      try {
        view = await fetchJson(pathOfMission(missionId));
      } catch {
        // 一次瞬时故障不能画成「这条任务不存在」：保留上一帧，下一轮再试。
        return;
      }
      if (gen !== cycleGen || stopped) return;

      let activity;
      try {
        activity = await fetchJson(pathOfMission(missionId) + '/activity');
      } catch {
        return;
      }
      if (gen !== cycleGen || stopped || !isVisible()) return;

      // view 原样留着：contract / usage / costCap / waitInfo / workItems（含
      // validationReport、executionResult、lastReview、attemptIds）都要交给页头与
      // 交付投影。在这里「只挑 missionId 与 intent」，费用、cap 与六层就全成了未知。
      state.view = view;
      state.activity = list(activity);
      state.nowIso = nowIsoFn();
      applyPendingStep();
      // 人没点过、深链也没对上时由这里给一个默认选中项：留空会让交付六层全说
      // 「没有所选工作项」，而页头已经显示这条任务在跑。
      if (text(state.selectedWorkItemId) === '') {
        state.selectedWorkItemId = defaultWorkItemId(state.view, state.activity);
      }

      // 完整报告在 activity 之后、paint 之前取：交付投影要同时用到两者。
      // 先清掉上一份再拉：这份是「新的选中项的报告」，不是「上一份加上新的」，
      // 拉失败时屏幕上必须回到未知，而不是继续登着上一项的命令。
      state.validationReportFull = null;
      state.validationReportFull = await loadValidationReport(gen, missionId, state.view);
      if (gen !== cycleGen || stopped || !isVisible()) return;
      const liveAttemptId = currentLiveAttemptId(state.activity);

      const current = liveAttemptId === null ? null : await loadAttempt(gen, missionId, liveAttemptId);
      if (gen !== cycleGen || stopped || !isVisible()) return;
      state.currentAttempt = current;

      // 已结束的那一路与实时那一路**只能有一边有值**：有 active 时再留着上一次的结尾，
      // 左侧两块就同时有正文，而屏幕上它们长得一模一样，人分不出哪一块是现在的。
      if (liveAttemptId !== null) {
        state.recentEndedAttempt = null;
        state.recentEndedLoadedId = '';
      } else {
        const endedId = latestEndedAttemptId(state.activity) ?? '';
        if (endedId === '') {
          state.recentEndedAttempt = null;
          state.recentEndedLoadedId = '';
        } else if (state.recentEndedLoadedId !== endedId) {
          // 先记 id 再请求：拉回来的那一刻这一轮可能已经换代（换任务 / 隐藏），
          // 那次 null 也算“试过了”，不记就每轮重拉同一条已结束 Attempt。
          state.recentEndedLoadedId = endedId;
          const recent = await loadAttempt(gen, missionId, endedId);
          if (gen !== cycleGen || stopped || !isVisible()) return;
          state.recentEndedAttempt = recent;
        }
      }

      const selectedId = text(state.selectedAttemptId);
      if (selectedId === '') {
        state.selectedAttempt = null;
      } else if (selectedId === text(liveAttemptId)) {
        // 选中的就是正在跑的那一跳：两格同一份事实，再取一次只会多一次请求。
        state.selectedAttempt = current;
      } else {
        const selected = await loadAttempt(gen, missionId, selectedId);
        if (gen !== cycleGen || stopped || !isVisible()) return;
        state.selectedAttempt = selected;
      }

      // live 只在 nextRefresh 说该拉的时候拉：completed / blocked 之后实时流已经结束，
      // 继续轮询只会把「上一跳的尾巴」当成还在发生的进度摆着。
      const plan = nextRefresh('mission', text(object(state.view) && object(state.view).status), isVisible());
      if (plan.paths.includes('live')) {
        try {
          await pullLive(gen, missionId, liveEntry(missionId));
        } catch {
          // 实时流断了不影响已经取到的任务事实：下一轮接着从同一个 cursor 追。
        }
      }
      if (gen !== cycleGen || stopped || !isVisible()) return;
      paint();
    } finally {
      if (inflightGen === gen) inflightGen = -1;
      if (gen === cycleGen) arm();
    }
  }

  /** live 单独一轮：只追加行、只重绘，不重取任务事实。 */
  async function liveTick() {
    if (stopped || !running) return;
    // 同样两道闸：resource 页可能先换掉容器、hashchange 还没跑到，先查归属再查代次。
    if (relinquished()) {
      stop();
      return;
    }
    if (!isVisible()) {
      stopTimers();
      return;
    }
    const missionId = text(state.missionId);
    if (missionId === '') return;
    const plan = nextRefresh('mission', text(object(state.view) && object(state.view).status), true);
    if (!plan.paths.includes('live')) {
      stopLiveTimer();
      return;
    }
    const gen = cycleGen;
    let changed = false;
    try {
      changed = await pullLive(gen, missionId, liveEntry(missionId));
    } catch {
      return;
    }
    if (gen !== cycleGen || stopped || !isVisible()) return;
    if (changed) paint();
  }

  /* ---------------------------- 定时器 ---------------------------- */

  function stopTimer() {
    if (timer === null) return;
    clearIntervalFn(timer);
    timer = null;
  }

  function stopLiveTimer() {
    if (liveTimer === null) return;
    clearIntervalFn(liveTimer);
    liveTimer = null;
  }

  function stopTimers() {
    stopTimer();
    stopLiveTimer();
  }

  function onTick() {
    if (stopped) return;
    // 容器被别的页面接管（innerHTML 被换掉、容器本身仍 connected）：停止并作废在途。
    // 只判 isConnected 的话这一条永远不成立，#view 从来不会被摘掉。
    if (relinquished()) {
      stop();
      return;
    }
    // 节点已经离开文档（换页了、但这一页没被显式 stop）：定时器必须自己停。不停的话
    // 它会对着一个已经不在屏幕上的容器一直打接口，直到整个标签页关掉。
    if (typeof container.isConnected === 'boolean' && !container.isConnected) {
      stop();
      return;
    }
    void refresh();
  }

  function onLiveTick() {
    void liveTick();
  }

  /**
   * 按 nextRefresh 挂间隔。已经有那只就不重挂：每轮都重挂等于把间隔重置，
   * 一个永远等不到下一次触发的定时器，看起来就像「轮询停了」。
   */
  function arm() {
    if (stopped || !running || !isVisible()) {
      stopTimers();
      return;
    }
    const plan = nextRefresh('mission', text(object(state.view) && object(state.view).status), true);
    if (plan.intervalMs === null) stopTimer();
    else if (timer === null) timer = setIntervalFn(onTick, plan.intervalMs);
    if (plan.liveIntervalMs === null) stopLiveTimer();
    else if (liveTimer === null) liveTimer = setIntervalFn(onLiveTick, plan.liveIntervalMs);
  }

  /**
   * 路由离开本 Mission：停止轮询、作废在途响应。
   *
   * 直接读 location.hash 而不是用 app.js 的 parseRoute：那会把外壳的路由表拽进这一层，
   * 而且这里只关心一件极窄的事——hash 还是不是本 Mission。hash 仍是本 Mission（含
   * ?selectedStep= 这类查询）就不许停，否则人在详情页里点一下深链，轮询就自己没了。
   */
  function onHashLeave() {
    if (stopped) return;
    const location = win && win.location ? win.location : null;
    const hash = location && typeof location.hash === 'string' ? location.hash : '';
    const own = '#/missions/' + encodeURIComponent(text(state.missionId));
    if (hash === own || hash.indexOf(own + '?') === 0) return;
    stop();
  }

  function onVisibilityChange() {
    if (stopped) return;
    if (!isVisible()) {
      stopTimers();
      // 在途结果不许落 DOM：这一刻页面已经看不见，写上去还会盖掉恢复可见后补拉的那份。
      cycleGen += 1;
      return;
    }
    // 回到可见立即补拉一次，不等下一个周期：人切回来看到的第一屏必须是现在的。
    void refresh();
  }

  /* ---------------------------- 生命周期 ---------------------------- */

  function startOptions(options) {
    if (typeof options === 'string') return { missionId: text(options), hasStep: false, selectedStep: '' };
    const o = object(options) ?? {};
    const hasStep = 'selectedStep' in o;
    return {
      missionId: o.missionId === undefined ? text(state.missionId) : text(o.missionId),
      hasStep,
      selectedStep: hasStep && o.selectedStep !== null && o.selectedStep !== undefined ? String(o.selectedStep) : '',
    };
  }

  /**
   * 开跑。options 可以是一个 missionId，也可以是 `{ missionId, selectedStep }`。
   *
   * 同一 container、同一 missionId、根节点仍连着时**不新开定时器**：路由抖动或重复
   * 挂载会因此只剩一只，否则两只定时器交替打接口，屏幕上看起来只是「数据偶尔闪」。
   */
  function start(options) {
    const next = startOptions(options);

    // 已经有一只控制器在别的容器上（换页了、但上一页没被显式 stop）：先停它。
    if (activeController !== null && activeController !== api) activeController.stop();
    activeController = api;

    const attached = typeof container.isConnected === 'boolean' ? container.isConnected : true;
    if (running && !stopped && next.missionId === state.missionId && attached) {
      if (next.hasStep) {
        state.pendingStep = next.selectedStep;
        state.userPicked = false;
        // 深链换了，选中的那一跳也要跟着换：只重绘会把「选中项」留在上一次那一项上。
        return refresh();
      }
      paint();
      return Promise.resolve();
    }

    const switched = next.missionId !== state.missionId;
    running = true;
    stopped = false;
    // 走到这里就是自己重新立一次所有权（换任务 / stop 后再进）：容器里那份旧页是我们
    // 画的不算「被抢」，否则换任务那一下会被自己的归属标记判成离页而直接停掉。
    painted = false;
    cycleGen += 1;
    state.missionId = next.missionId;
    if (next.hasStep) {
      state.pendingStep = next.selectedStep;
      state.userPicked = false;
    } else if (switched) {
      // 换任务还留着上一条的深链：它会在新任务里选中一个不相干的工作项。
      state.pendingStep = '';
    }
    if (switched) {
      // 换任务：上一任务的事实一条都不能留在屏幕上。留着的话，新任务页头会挂着旧
      // 意图、旧费用，而编号已经是新的——这比空白更糟：它看起来是真的。
      state.view = null;
      state.activity = [];
      state.nowIso = '';
      state.currentAttempt = null;
      state.selectedAttempt = null;
      // 已结束那一跳也属于上一任务：留着它，新任务页面上会挂着一跳不存在于这条
      // Mission 的 saved tail，而编号已经是新的。
      state.recentEndedAttempt = null;
      state.recentEndedLoadedId = '';
      state.selectedWorkItemId = '';
      state.selectedAttemptId = '';
    }

    ensureTaskDetailStylesheets(doc);
    if (typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibilityChange);
    if (!listening && win && typeof win.addEventListener === 'function') {
      win.addEventListener('hashchange', onHashLeave);
      listening = true;
    }
    // 先画一帧：不画的话容器是空的，看起来像这一页坏了。
    paint();
    return refresh();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    running = false;
    // 代次一变，所有在飞的响应都作废（包括之后才 reject 的那一批）。
    cycleGen += 1;
    stopTimers();
    if (typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibilityChange);
    // 停了还听着，下一次 hashchange 会对着已停的控制器再跑一遍判断，语义上像它还活着。
    if (listening && win && typeof win.removeEventListener === 'function') {
      win.removeEventListener('hashchange', onHashLeave);
      listening = false;
    }
    if (activeController === api) activeController = null;
  }

  const api = { start, stop, refresh, state, paint };
  return api;
}

/**
 * 页面入口：用 document 与全局 fetch 建一个控制器并 start()。
 *
 * 入口接线（路由换 hash、换任务）在 W-906 做，这里只保证「给一个容器和一个 Mission
 * 编号就能出这一页」。返回值是控制器本身，start() 的 promise 由调用方按需等待。
 */
export function renderTaskDetailPage(container, missionId, selectedStep = null) {
  const controller = createTaskDetailController({
    doc: globalThis.document,
    container,
    missionId,
    selectedStep,
  });
  controller.start();
  return controller;
}
