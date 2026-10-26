/**
 * 任务详情页「工作流环节」的纯投影：一条 Mission 的 view + activity →
 * 工作项清单、当前选中的那一项、它的轮次与执行次数，以及**已经发生过**的环节。
 *
 * **为什么单开一个纯模块**：这一块最容易出的错都不报错、不崩、也不影响任何断言——
 * 把还没发生的环节先铺成占位（看起来像任务规划得很好）、按 Figma 样板写死「执行第
 * 13 次」、把别的工单的事件算进这一项、把「机器自动退回」画成协调者的动作。
 * 这些错误在界面上都长得像对的，只有对着真实 activity 断言才问得出来。
 *
 * **不拼 HTML、不读时钟、不发请求**：转义与配色是渲染层的事；时间一律用事件里
 * 自带的 at，函数内不取「现在」——一旦 `new Date()`，同一条数据两次运行会得出
 * 不同的字，测试就没法断言。
 *
 * **不 import task.js**：那边是详情页的渲染模块，它自己会要这份投影，互相 import
 * 就成环；浏览器原生 ES module 下成环不报错，只会让某一侧拿到 undefined，然后
 * 整页白掉。也不 import application：前端只走 `/api/*` 投影出来的 view。
 */
import { PLATFORM_ROLE_LABEL, modelLabel, narrateEvent, stageName } from './narrate.js';

const text = (value) => (value === undefined || value === null ? '' : String(value)).trim();
const list = (value) => (Array.isArray(value) ? value : []);
const object = (value) => (value && typeof value === 'object' ? value : null);

/** 收起时最多留几条：再少就看不出「刚才在干嘛」，再多就退化成整条时间线。 */
const COLLAPSED_LIMIT = 4;

/* ============================ 工作项与选择 ============================ */

/**
 * 工作项清单。**严格保持 view.workItems 的原顺序**，也不补造不存在的 id：
 * 界面上换一个顺序或出现一个库里没有的工单，人会对着一个不存在的编号去催活。
 * 只投影 {id, title, status}——别的字段这一块用不上，带出来只会诱使渲染层去读。
 */
function projectItems(rawItems) {
  return rawItems.map((item) => ({
    id: text(item && item.id),
    title: text(item && item.title),
    status: text(item && item.status),
  }));
}

/**
 * 哪些 attempt 已经有 attempt.started、却还没有 attempt.ended。
 *
 * 只看 activity 里的开关门事件，不看 `attemptIds` 的最后一项：`attemptIds` 只是
 * 「开过几次」，`work-item.ts` 里 dispatch 不清旧结果，所以最后一项既可能是还没跑
 * 的那次，也可能是跑完被打回的那次。判断「还在跑」只能靠事件。
 */
function openAttemptIds(activity) {
  const started = new Set();
  const ended = new Set();
  for (const event of list(activity)) {
    const id = text(event && event.attemptId);
    if (!id) continue;
    const kind = text(event && event.kind);
    if (kind === 'attempt.started') started.add(id);
    else if (kind === 'attempt.ended') ended.add(id);
  }
  const open = new Set();
  for (const id of started) if (!ended.has(id)) open.add(id);
  return open;
}

/**
 * 选中哪个工作项。
 *
 * 三条判据依次退让，**越具体越先用**：
 *   1. 调用方点名的那个（路由 / 用户点击），对不上任何工单就当没点名——把用户的
 *      选择硬套到一个不存在的 id 上，界面会空着而没有任何提示。
 *   2. 正在跑的那一项（有 started 没 ended）。多处同时开着时取**最后**一项：
 *      append-only 的 activity 里后派发的在后面，人关心的是刚动的那张。
 *   3. 最后一个没被作废的。retired 是「这张不用做了」，把它选成当前项等于让界面
 *      一直指着一张已经被取消的工单。
 *
 * 三条都落空才回 null（例如全部 retired），**不兜底成第一项**：第一项往往是
 * 早就验收掉的那张，看起来像它才是当前活。
 */
function selectWorkItem(rawItems, activity, options) {
  if (rawItems.length === 0) return null;

  const asked = text(options && options.selectedWorkItemId);
  if (asked) {
    const hit = rawItems.find((item) => text(item && item.id) === asked);
    if (hit) return hit;
  }

  const open = openAttemptIds(activity);
  for (let i = rawItems.length - 1; i >= 0; i -= 1) {
    const ids = list(rawItems[i] && rawItems[i].attemptIds).map(text);
    if (ids.some((id) => id !== '' && open.has(id))) return rawItems[i];
  }

  for (let i = rawItems.length - 1; i >= 0; i -= 1) {
    if (text(rawItems[i] && rawItems[i].status) !== 'retired') return rawItems[i];
  }
  return null;
}

/**
 * 轮次。**只认 order.orderRevision 的 rN 形状**，对不上就是「没有轮次」。
 *
 * 不许默认第 1 轮：老工单 / 未派发的工单没有 orderRevision，补一个「第 1 轮」
 * 就是凭空说这张工单已经被派过一轮了，而 roundNumber 会被人拿去算重派上限。
 */
function projectRound(item) {
  const revision = text(item && item.order && item.order.orderRevision);
  const matched = /^r(\d+)$/.exec(revision);
  if (!matched) return { roundNumber: null, label: '' };
  const n = Number(matched[1]);
  return { roundNumber: n, label: `第 ${n} 轮` };
}

/* ============================ 环节 ============================ */

/**
 * 这条事件算不算所选工作项的。
 *
 * 两条判据缺一不可：只看 workItemId 会漏掉执行者事件（它挂的是 attemptId），
 * 只看 attemptId 会把协调者那条 `work_item.dispatched`（没有 attemptId）漏掉。
 * 别的工单的事件、以及没有 workItemId 的协调者事件一律不进这一项——混进来的
 * 那一刻，界面就在说「这张工单干了这些」，而它其实没干。
 */
function belongsToItem(event, itemId, attemptIds) {
  const workItemId = text(event && event.workItemId);
  if (workItemId !== '' && workItemId === itemId) return true;
  const attemptId = text(event && event.attemptId);
  return attemptId !== '' && attemptIds.has(attemptId);
}

/**
 * 过滤后的事件按 attemptId 首次出现顺序成组；`attemptId` 为空的事件各自成行。
 *
 * **为什么是首次出现顺序、不是连续分段**：activity 是 append-only 的，同一个
 * attempt 的事件会被别的事件穿插，连续分段会把一跳切成七八段。
 *
 * **为什么空 attemptId 不并成一组**：那是平台 / L3 零散动的手，没有共同的
 * 「一跳」。硬并成一个假 Attempt，界面会显示「这一跳干了 5 件事」并给它一个
 * 「进行中 / 已记录」——而根本不存在这一跳。
 */
function groupEvents(events) {
  const groups = [];
  const byAttempt = new Map();
  events.forEach((event, index) => {
    const attemptId = text(event && event.attemptId);
    if (attemptId === '') {
      // key 用过滤后的下标：同一份 activity 两次投影得到同一批 key，展开状态才不会串。
      groups.push({ key: `orphan-${index}`, attemptId: '', events: [event] });
      return;
    }
    if (!byAttempt.has(attemptId)) {
      const group = { key: attemptId, attemptId, events: [] };
      byAttempt.set(attemptId, group);
      groups.push(group);
    }
    byAttempt.get(attemptId).events.push(event);
  });
  return groups;
}

/** 本组那一跳发牌时选中的候选 → 模型文案；没记下来就 null（不编一个模型名）。 */
function profileOf(events) {
  const started = events.find((event) => text(event && event.kind) === 'attempt.started');
  const data = object(started && started.data);
  return object(data && data.profile);
}

/**
 * 一组事件 → 一条环节。
 *
 * 三种角色互斥，优先级是「谁最有资格说这条环节是什么」：
 *   1. `work_item.auto_redispatched` —— 这条是平台自己把工单退回去的。写成协调者
 *      或「外部主控切换候选」，人会去找 L2 追问一个它根本不知道的动作。
 *   2. 执行者（attemptId 带 `.exec-`，或发牌时 data.kind 就是 executor）。
 *   3. 协调者。direct 协作下没有 L2，主控在平台看不见的外面。
 */
function projectStage(group, ctx, direct) {
  const events = group.events;
  const first = events[0];
  const ended = events.some((event) => text(event && event.kind) === 'attempt.ended');
  const started = events.find((event) => text(event && event.kind) === 'attempt.started');
  const startedData = object(started && started.data);
  const auto = events.find((event) => text(event && event.kind) === 'work_item.auto_redispatched');

  const base = {
    key: group.key,
    attemptId: group.attemptId,
    // at 原样给出：格式化是渲染层的事，这里换一种写法就会与事件明细里的时刻对不上。
    at: first && first.at !== undefined && first.at !== null ? first.at : '',
    // 没有 attempt.ended 就是还在跑。不能反过来把「旧那次被打回」写成当前这次在进行中。
    stateText: ended ? '已记录' : '进行中',
  };

  if (auto) {
    const told = narrateEvent(auto, ctx);
    return {
      ...base,
      role: 'platform',
      // 徽章固定在平台这一侧：narrateEvent 的 badge 是「角色流转」，将来改表也不该
      // 让这一行的归属跟着漂。
      badge: PLATFORM_ROLE_LABEL,
      title: told.action,
      detail: told.detail,
      model: null,
    };
  }

  const executorKind = startedData !== null && text(startedData.kind) === 'executor';
  const isExecutor = group.attemptId !== '' && (group.attemptId.includes('.exec-') || executorKind);

  if (isExecutor) {
    // 次数只从 attemptId 的 `.exec-N` 尾巴解析。用数组下标当次数会在有 orphan 行
    // 或跨工单时错位，而错位的「执行第 N 次」看起来完全正常。
    const matched = /\.exec-(\d+)$/.exec(group.attemptId);
    return {
      ...base,
      role: 'executor',
      // 非平台行的徽章由渲染层按 role 出（这里只有 role）；给个空串会被当成「有徽章但是空」。
      badge: null,
      title: matched ? `执行第 ${Number(matched[1])} 次` : '执行',
      detail: '',
      model: modelLabel(profileOf(events)),
    };
  }

  return {
    ...base,
    role: 'coordinator',
    badge: null,
    // direct 下平台看不见谁来协调，它就在外面。这里给 title 一个确定的说法，
    // 比留空更像事实：留空会被渲染层填成「L2 协调」。
    title: direct ? '外部主控' : stageName(events, ctx),
    detail: '',
    // direct 时不许编一个 L2 profile：平台根本没看见主控用的模型。
    model: direct ? null : modelLabel(profileOf(events)),
  };
}

/**
 * 当前环节的 key：从后往前找第一条还没结束的；全都结束了就是最后一条。
 *
 * **只在 attempt 组里找，orphan 行不参与**：orphan 行是单独一条事件，不是一次
 * 「还在跑的尝试」。让它当当前项，界面会说某个东西正在进行中，而实际上什么都没跑
 * （典型形状：收尾的 auto_redispatched 挂在最后）。没有 attempt 组时回 null，
 * 由调用方说「还没有环节」。
 */
function currentStageKey(stages) {
  const attempts = stages.filter((stage) => stage.attemptId !== '');
  if (attempts.length === 0) return null;
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    if (attempts[i].stateText !== '已记录') return attempts[i].key;
  }
  return attempts[attempts.length - 1].key;
}

/* ============================ 投影 ============================ */

/**
 * view + activity → 工作流环节。
 *
 * view 形状 = `/api/missions/:id` 的 MissionView（workItems[].id/title/status/
 * attemptIds/order.orderRevision、coordinationMode）。
 * activity = `/api/missions/:id/activity` 的事件数组，append-only，已经发生过的。
 *
 * options = { selectedWorkItemId, expanded }：
 *   - selectedWorkItemId 是**调用方路由里的当前选择**，对不上就退让（见 selectWorkItem）；
 *   - expanded 只决定 visibleStages 取全部还是最近几条，不影响 stages 本身，
 *     也不影响 currentKey —— 展开/收起是显示状态，不是「当前在哪」。
 *
 * 返回里 **不带任何还没发生的环节**：不铺「下一步」「待执行」占位。预铺的占位和
 * 真发生过的环节长得一样，人分不出哪些是真跑过的。
 */
export function projectWorkflow(view, activity, options) {
  const v = object(view) ?? {};
  const opts = object(options) ?? {};
  const rawItems = list(v.workItems);
  const items = projectItems(rawItems);
  const events = list(activity);

  const selected = selectWorkItem(rawItems, events, opts);
  const selectedId = selected ? text(selected.id) : null;
  const attemptIds = new Set(list(selected && selected.attemptIds).map(text).filter((id) => id !== ''));

  const round = projectRound(selected);
  // 次数就是视图里记了几次尝试，不按 attempt 事件条数或数组下标另算。
  const executionCount = selected ? list(selected.attemptIds).length : 0;
  const direct = text(v.coordinationMode) === 'direct';

  const stages = selectedId === null
    ? []
    : groupEvents(events.filter((event) => belongsToItem(event, selectedId, attemptIds)))
      .map((group) => projectStage(group, { workItems: items }, direct));

  return {
    items,
    selectedId,
    round,
    executionCount,
    executionLabel: `已记录 ${executionCount} 次执行`,
    stages,
    // 收起时留最后几条，**顺序不变**（旧在前、新在后）：倒着排会让「越往下越新」
    // 这个直觉失效，而同一列表展开后又变回正序。
    visibleStages: opts.expanded === true ? stages : stages.slice(-COLLAPSED_LIMIT),
    currentKey: currentStageKey(stages),
    // 其它已验收的工单：给「切换工作项」那一栏标出哪些已经做完，省得一个个点开看。
    acceptedOthers: items
      .filter((item) => item.status === 'accepted' && item.id !== selectedId)
      .map((item) => item.id),
  };
}
