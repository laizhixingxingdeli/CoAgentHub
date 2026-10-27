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
import { PLATFORM_ROLE_LABEL, endReasonText, modelLabel, narrateEvent, roleOfAttempt, stageName } from './narrate.js';

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
 * 别的工单的事件不进这一项——混进来的那一刻，界面就在说「这张工单干了这些」，
 * 而它其实没干。
 *
 * 没有 workItemId 的事件里，只有 `attempt.started` 能靠「这一跳已经由别的事件挂上
 * 本工单」补进来（见 linkedAttemptIds）：协调者的 started 常常不带 workItemId，
 * 硬滤掉会让这一跳的身份退化成「协调者 · 未知 · 未知 · 未知」，明明它发牌时选过
 * 候选。其它没有 workItemId 的事件仍然不进——它们没有任何凭据说明属于这一项。
 */
function belongsToItem(event, itemId, attemptIds) {
  const workItemId = text(event && event.workItemId);
  if (workItemId !== '' && workItemId === itemId) return true;
  const attemptId = text(event && event.attemptId);
  return attemptId !== '' && attemptIds.has(attemptId);
}

/**
 * 已经凭本工单的事件挂上来的 attemptId。
 *
 * 用途只有一个：把那些**没有 workItemId 的 `attempt.started`** 补回它自己那一组。
 * 这些 started 一旦被滤掉，本组就没有 profile，身份行变成三连「未知」——而这一跳
 * 发牌时到底选了什么候选，事实是记着了的。关联只能靠 attemptId：按工单先过滤、
 * 再从当前候选池推，两者都会把历史换成今天的样子。
 */
function linkedAttemptIds(events, itemId, attemptIds) {
  const linked = new Set();
  for (const event of events) {
    if (!belongsToItem(event, itemId, attemptIds)) continue;
    const attemptId = text(event && event.attemptId);
    if (attemptId !== '') linked.add(attemptId);
  }
  return linked;
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
 * 全量 activity 里哪些 attemptId 已经 attempt.ended，以及那一条的 data.endedBy。
 *
 * **必须扫完整 activity，不能扫过滤后的那一组**：协调者这一跳的 attempt.ended 常常
 * 既没有 workItemId、也不在 workItem.attemptIds 里（实测 coord-7 就是这样），按
 * belongsToItem 先过滤就会把它丢掉，于是界面把已经 13:28:26 结束的协调者一直写成
 * 「进行中」并标成当前项。这里只回答「这一跳结束了没有」，不把事件并进任何一组。
 *
 * 值是 endedBy 原样字符串；事件里没写就存空串（不编一个「正常结束」）。
 */
function endedAttempts(activity) {
  const ended = new Map();
  for (const event of list(activity)) {
    const id = text(event && event.attemptId);
    if (id === '') continue;
    if (text(event && event.kind) !== 'attempt.ended') continue;
    const by = text(object(event && event.data) && event.data.endedBy);
    const known = ended.get(id);
    // 同一跳重复记了 ended（重放 / 补写）时补上先到的空串，别让空串盖掉真原因。
    if (known === undefined || (known === '' && by !== '')) ended.set(id, by);
  }
  return ended;
}

/** profile.facts 里的一条不透明键值；没有就空串（missing 由调用方翻成「未知」）。 */
function factOf(profile, key) {
  const facts = list(object(profile) && profile.facts);
  const hit = facts.find((fact) => fact && text(fact.key) === key);
  return hit ? text(hit.value) : '';
}

/**
 * 一条环节的身份行：谁 + 真实候选 + 真实 provider/model + 真实思考档。
 *
 * 判据只取本组 attempt.started 的 data.profile，**不查当前候选池、也不借别的
 * Attempt 的 profile**：候选表会被改，查今天配置等于给昨天那一跳换一个模型；借用
 * 相邻那一跳的 profile 更糟——它长得完全像事实，而这一跳根本没跑过它。
 *
 * 缺哪一段就写「未知」，既不省略也不编候选名：省略会让人以为「这一跳没有候选」
 * 与「界面没显示」是两回事，编一个名字则会去核对一个不存在的候选。
 */
function identityText(roleLabel, profile) {
  const p = object(profile);
  const profileId = text(p && p.profileId);
  const provider = factOf(p, 'provider');
  const model = factOf(p, 'model');
  const reasoning = factOf(p, 'reasoning');
  // provider/model 是一段：两个都没记就只写一个未知，只缺一半时把缺的那半写成未知——
  // 写成“grok-4.7”会让人以为已确认的是 provider 也记过了。
  const pair = provider === '' && model === ''
    ? '未知'
    : (provider || '未知') + '/' + (model || '未知');
  return [roleLabel, profileId || '未知', pair, reasoning || '未知'].join(' · ');
}

/**
 * 这一跳的结束依据：本组里那条 attempt.ended 的 endedBy，没有就用全局扫到的那条。
 *
 * 返回空串表示「结束了但没写原因」，与「还没结束」由调用方区分开。
 */
function endedByOf(events, attemptId, endedIds) {
  const local = events.find((event) => text(event && event.kind) === 'attempt.ended');
  const localBy = text(object(local && local.data) && local.data.endedBy);
  if (localBy !== '') return localBy;
  const known = attemptId === '' ? undefined : endedIds.get(attemptId);
  return text(known);
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
function projectStage(group, ctx, direct, endedIds) {
  const events = group.events;
  const first = events[0];
  const started = events.find((event) => text(event && event.kind) === 'attempt.started');
  const startedData = object(started && started.data);
  const auto = events.find((event) => text(event && event.kind) === 'work_item.auto_redispatched');
  const profile = profileOf(events);
  const isOrphan = group.attemptId === '';

  // 结束与否看两处：本组里有 attempt.ended，或**全量** activity 里这一跳已经 ended。
  // 只看本组会把「ended 事件丢了 workItemId」的协调者一直写成进行中；只看全局又会
  // 把没有任何 attemptId 的零散动作当成「还在跑的一跳」——那种记录根本不是一跳。
  const ended = isOrphan
    ? true
    : events.some((event) => text(event && event.kind) === 'attempt.ended')
      || endedIds.has(group.attemptId);
  const endedBy = endedByOf(events, group.attemptId, endedIds);

  const stateText = ended ? '已记录' : '进行中';
  // **结果词只从 endedBy 来**：`已记录` 是「这一跳有没有落账」，不是「它成没成」。
  // 没有 endedBy 时才退回状态词——把 upstream_failure 也写成「已记录」，人会把一次
  // 上游炸掉读成一次正常收尾；反过来从 executionResult / validationReport.passed /
  // status === 'succeeded' 推一句「验收通过」，则是拿机器跑绿冒充 L3 已验收。
  const resultLabel = endedBy !== '' ? endReasonText(endedBy) : stateText;
  const base = {
    key: group.key,
    attemptId: group.attemptId,
    // at 原样给出：格式化是渲染层的事，这里换一种写法就会与事件明细里的时刻对不上。
    at: first && first.at !== undefined && first.at !== null ? first.at : '',
    // 没有 attempt.ended 的**真实 Attempt** 才是在跑。空 attemptId 的记录一律
    // 「已记录」：它不是一次尝试，写成进行中等于让界面说某个东西正在跑，而其实没有。
    stateText,
    // 有结束原因就原样带上（structured_submit 这类机器值由渲染层决定怎么说），
    // 没写原因就退回状态词——编一个「正常结束」会把「没记原因」显示成「记了原因」。
    resultText: endedBy !== '' ? endedBy : stateText,
    // 与 resultText 同一份来源，只是换成界面上的说法：resultText 留机器值给别处核对，
    // resultLabel 才是给人看的；两处各判一次迟早一处改了一处没改。
    resultLabel,
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
      // 平台自己动的手没有候选也没有模型，这一行的身份就是平台。
      identity: PLATFORM_ROLE_LABEL,
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
      model: modelLabel(profile),
      identity: identityText('执行者', profile),
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
    model: direct ? null : modelLabel(profile),
    // 角色段跟 title 用同一个判据（narrate 的 roleOfAttempt 形状规则）：
    // 没有 attemptId 的是 L3 自己的动作，写成「协调者」会让这一行的标题说检视者、
    // 身份说协调者，两个字段相互矛盾。
    // direct 且没记下 profile：说「外部主控 · 未知」，绝不编一个 L2 模型名。
    identity: direct
      ? (object(profile) === null ? '外部主控 · 未知' : identityText('外部主控', profile))
      : identityText(roleOfAttempt(group.attemptId) === 'reviewer' ? 'L3 检视者' : '协调者', profile),
  };
}

/**
 * 当前环节的 key：最后一个**真的还在跑**的 attempt 组；没有就 null。
 *
 * 两条都不能放宽：
 *   - 只看 attempt 组，orphan 行不参与——那是一条零散事件，不是「还在跑的尝试」，
 *     让它当当前项，界面会说某个东西正在进行中，而其实什么都没跑。
 *   - 全部已结束就回 null，**不回退到「最后一条已结束」**：那正是实测到的错觉——
 *     coord-7 在 13:28:26 已经 ended，界面仍把它标成当前并写「进行中」。没有当前项
 *     时由渲染层什么都不标，而不是硬指一条已经跑完的。
 */
function currentStageKey(stages) {
  for (let i = stages.length - 1; i >= 0; i -= 1) {
    if (stages[i].attemptId === '') continue;
    if (stages[i].stateText === '进行中') return stages[i].key;
  }
  return null;
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

  // 结束事实先按**全量** activity 扫一遍，再过滤分组：end 事件常常挂在没有
  // workItemId、也不在 attemptIds 的那一侧，先过滤就等于看不见它已经结束。
  const endedIds = endedAttempts(events);

  // 先扫一遍定下「哪些 attemptId 已经凭本工单的事件挂上了」，再按 activity 原顺序过滤：
  // 这样补回来的 started 落在它真实发生的位置上，而不是被追加到列表末尾——追加会让
  // 一个 13:31 开始的环节排到 13:40 的事件后面，顺序错得看不出来。
  const linkedIds = selectedId === null
    ? new Set()
    : linkedAttemptIds(events, selectedId, attemptIds);

  const stages = selectedId === null
    ? []
    : groupEvents(events.filter((event) => belongsToItem(event, selectedId, attemptIds)
      // 只补 attempt.started：同一 attemptId 的其它全局事件（别的工单上的 dispatched、
      // 没写 workItemId 的 attempt.ended）不属于本项，拉进来等于把它干的事算给本工单。
      // 结束事实继续由 endedAttempts 全量扫描回答，不靠把 ended 并进组。
      || (text(event && event.kind) === 'attempt.started' && linkedIds.has(text(event.attemptId)))))
      .map((group) => projectStage(group, { workItems: items }, direct, endedIds));

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
