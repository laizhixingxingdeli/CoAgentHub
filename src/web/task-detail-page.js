/**
 * 任务详情页的组合层：把已经验收过的页头、环节、交付、契约、输出五个视图拼成一
 * 页（Contract AC2 / AC3 / AC5 的呈现层），并把交互转成对调用方的一次回调。
 *
 * **为什么单开一个组合层，而不是让 task.js 自己拼**：本层要断言的每一条都是「看
 * 起来对、其实在说谎」的形状——点历史那一跳时左边的实时行跟着换掉、切工作项把实
 * 时输出也切走、把 missionDiff 摆到某一跳名下当文件清单、给 direct 编一个主控模型。
 * 这些错误在浏览器里全都不报错、不崩，也不影响任何断言，只是屏幕上的字看着都挺
 * 合理。做成一个喂 model 就能断言的纯渲染函数之后，node 里就能把它们抓出来。
 *
 * **不 import src/application**：这里是浏览器模块，拉 application 层会把整条服务端
 * 依赖拽进前端。页面只认 `/api/*` 投影出来的 view。
 *
 * **只从 task.js 取 formatTime**：时刻的本地化写法在详情页里已经有一份（那里按本地
 * 时区格式化，后端存的是 UTC）。本层自己再写一份，同一个时刻在两处就会差几个小时，
 * 而且没人会把它当 bug 报。反过来 task.js **不许** import 本模块：互相 import 在浏览
 * 器原生 ES module 下不成环报错，只会让某一侧拿到 undefined，然后整页白掉。
 *
 * **不取当前时间、不发请求**：「现在」由调用方给 nowIso，实时行与轮询都在外面。
 * 函数内一旦 `new Date()`，同一条数据两次渲染会得出不同的字，「疑似停滞」会随着刷新
 * 自己跳来跳去，而人只会以为任务真的在反复卡住。
 */
import { formatTime } from './task.js';
import { esc } from './projects.js';
import { projectWorkflow } from './task-detail-flow.js';
import { bindTaskHeader, ensureTaskHeaderStylesheet, taskHeaderHtml } from './task-detail-header-view.js';
import { bindTaskFlow, ensureTaskFlowStylesheet, taskFlowHtml } from './task-detail-flow-view.js';
import { ensureTaskDeliveryStylesheet, taskDeliveryHtml } from './task-detail-delivery-view.js';
import { ensureTaskContractStylesheet, taskContractHtml } from './task-detail-contract-view.js';
import { bindTaskOutput, ensureTaskOutputStylesheet, taskOutputHtml } from './task-detail-output-view.js';

const text = (value) => (value === undefined || value === null ? '' : String(value)).trim();
const iso = (value) => (value === undefined || value === null ? '' : String(value));
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

/** 三个页签的 key 与面板 data-panel 是同一套词：两处各写一份，改名时必然漏一处。 */
const PANELS = ['workflow', 'delivery', 'contract'];
const DEFAULT_TAB = 'workflow';

/** 输出侧栏的缺省页签：概要是这一区的主内容，缺省落在文件或用量上都会让人以为丢了正文。 */
const DEFAULT_OUTPUT_SIDE = 'summary';

/**
 * 「定位当前」的文案已经不在本层了（按钮由环节视图放进标题带，见
 * task-detail-flow-view.js），但绑定仍然在这里：data-action=locate-current 的处理器
 * 必须留着，否则本层是唯一知道「定位」还要同时改展开状态的地方，删掉就等于按钮
 * 点了只选中不展开。
 */
const HISTORY_EXPANDED_LABEL = '收起纵向历史';

/**
 * 未知页签退回工作流：留一个不是页签的 key，三个按钮全不选中，页头看起来像坏了；
 * 而三个面板也全 hidden，整页只剩页头。
 */
function normalizeTab(value) {
  const key = text(value);
  return PANELS.includes(key) ? key : DEFAULT_TAB;
}

/** 侧栏只认已知的三个值：别的值落回「概要」，页面上不会出现一个什么都不显示的空面板。 */
function normalizeSide(value) {
  const side = text(value);
  return ['summary', 'files', 'usage'].includes(side) ? side : DEFAULT_OUTPUT_SIDE;
}

/**
 * 创建时刻：activity 里第一条带非空 at 的事件。
 *
 * 只认事件流，不认 view 上的字段——MissionView 没有 createdAt，拿 updatedAt 顶上就是
 * 把「最后动过的时间」当成「开工时间」，页头那句「运行 X」会越算越小。
 */
function firstCreatedAt(activity) {
  for (const event of activity) {
    const at = iso(event && event.at);
    if (at !== '') return at;
  }
  return '';
}

/**
 * 当前**实时**那一跳：activity 里最后一条 attempt.started 且其后没有同 attemptId 的
 * attempt.ended。没有就 null。
 *
 * 不看 attemptIds 的最后一项：dispatch 不清旧结果，最后一项既可能是还没跑的那次，
 * 也可能是跑完被打回的那次。也不许拿 selectedAttemptId 顶上——那正是「点开历史，
 * 左边的实时行跟着换成上一跳」的来源，而且界面上没有任何东西能揭穿它。
 */
export function currentLiveAttemptId(activity) {
  const events = Array.isArray(activity) ? activity : [];
  const endedAfter = new Set();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = object(events[i]);
    if (event === null) continue;
    const id = text(event.attemptId);
    if (id === '') continue;
    const kind = text(event.kind);
    if (kind === 'attempt.ended') {
      endedAfter.add(id);
      continue;
    }
    if (kind === 'attempt.started' && !endedAfter.has(id)) return id;
  }
  return null;
}

/**
 * 一个页签的面板。三个面板一次性全画，非当前的带 hidden：点一下才拼内容，那片空白
 * 和「这一块没有内容」长得一模一样，人分不出是没做还是没数据。
 */
function panelHtml(key, inner, current) {
  return '<div class="td-tab-panel" data-panel="' + key + '"' + (current ? '' : ' hidden') + '>'
    + inner
    + '</div>';
}

/**
 * 整页 HTML。根节点 div.td-page。
 *
 * 顺序由这里定死（页头 → 三页签），不从数据里推：按数据推出来的顺序会随
 * 哪一块先有值而变化，人每次进来看到的位置都不一样。
 *
 * **输出区在**工作流页签的面板内部，**且只挂一份**。它说的是「这一跳在跑什么」与
 * 「我点开的这一跳是什么」，两者都是工作流的事；挂到交付/契约面板里就是同一块内容
 * 在两个页签上各讲一遍，而两边刷新的节奏与游标一旦不同，其中一侧会停在旧数据上
 * 而看起来完全正常。
 *
 * 定位按钮不在本层拼：它属于环节区的标题带（task-detail-flow-view.js），在那个
 * 带子里与「展开纵向历史」是同一排控件；本层再拼一个，页面上就会出现两个都能点、
 * 文案还可能不一致的「定位当前」。
 *
 * model = { view, activity, nowIso, tab, intentExpanded, historyExpanded, outputSide,
 *           selectedWorkItemId, selectedAttemptId, currentAttempt, selectedAttempt,
 *           liveChunks, validationReportFull }
 *
 * validationReportFull 是 `GET /api/missions/:id/validation-reports/:reportId` 取回来的
 * 完整报告：它是「已跑命令 / 计数 / 行数」的唯一来源，没取到就是 null。
 */
export function taskDetailHtml(model) {
  const m = object(model) ?? {};
  const view = object(m.view) ?? {};
  const activity = Array.isArray(m.activity) ? m.activity : [];
  const tab = normalizeTab(m.tab);
  const intentExpanded = m.intentExpanded === true;
  const historyExpanded = m.historyExpanded === true;
  const outputSide = normalizeSide(m.outputSide);
  const nowIso = iso(m.nowIso);
  const createdAt = firstCreatedAt(activity);
  const selectedWorkItemId = typeof m.selectedWorkItemId === 'string' ? m.selectedWorkItemId : '';

  // 选工单的规则只在 projectWorkflow 里有一份：这里另写一套，就会出现「环节区选的
  // 是 W-2、契约区显示的是 W-1」这种两处都对、合起来错的页面。
  const flow = projectWorkflow(view, activity, {
    selectedWorkItemId,
    expanded: historyExpanded,
  });

  // 历史选择：调用方点名优先；否则跟着「当前环节」走；再没有就取该工作项 stages 里
  // 最后一条非空 attemptId；都不行就空串。**不拿实时那一跳顶上**：那正是「点开历史，
  // 右边展示的其实是这一跳」的来源，而界面上没任何东西能揭穿它。
  const askedAttemptId = typeof m.selectedAttemptId === 'string' ? m.selectedAttemptId.trim() : '';
  const currentStage = flow.stages.find((stage) => stage.key === flow.currentKey) || null;
  const stageAttemptId = currentStage === null ? '' : text(currentStage.attemptId);
  const lastStageAttemptId = flow.stages.reduce((last, stage) => {
    const id = text(stage.attemptId);
    return id === '' ? last : id;
  }, '');
  const selectedAttemptId = askedAttemptId !== ''
    ? askedAttemptId
    : (stageAttemptId !== '' ? stageAttemptId : lastStageAttemptId);

  // 输出区的输入只放**这两跳自己的东西**。
  //
  //   - selectedWorkItem：只留 id / status / attemptIds / order.allowedScope——允许范围
  //     与 attemptIds 都在这张工单上。整个 view.workItems 传下去，渲染层就会有一份
  //     完整清单可挑，写着写着就变成「只要是张工单的就列出来」。
  //   - selectedActivity：只传 attemptId 等于选中那一跳的事件（候选变更只在那里）。
  //   - fileEvidence：只摘这一跳的归属链（见下方 fileEvidenceOf），**不整份**传
  //     executionResult 或 missionDiff——一个是任务级清单、一个是任务级改动，传下去
  //     迟早会被当成某一跳的，而那笔账谁也说不清。
  //   - **不传** missionDiff / executionResult / missionUsage：它们是任务级事实，
  //     一旦传下去就会被当成某一跳的，而那笔账谁也说不清。
  //
  // 工单优先认调用方点名的那个（id 等于 selectedWorkItemId）；它没点名时退回环节区
  // 实际选中的那张（flow.selectedId）。选工单的规则只在 projectWorkflow 里有一份，
  // 它已经按「正在跑的那张 → 最后一张未作废的」选过了；这里若只认调用方的空串，
  // 就会出现「环节区显示 W-1、概要却说允许范围未知」——两处都对、合起来错。
  const rawWorkItems = Array.isArray(view.workItems) ? view.workItems : [];
  const itemWithId = (id) => (id === ''
    ? null
    : rawWorkItems.find((item) => object(item) !== null && text(item.id) === id) || null);
  const rawItem = itemWithId(selectedWorkItemId) ?? itemWithId(text(flow.selectedId));
  const workItemOrder = rawItem === null ? null : object(rawItem.order);
  const selectedWorkItem = rawItem === null ? null : {
    id: text(rawItem.id),
    status: text(rawItem.status),
    attemptIds: Array.isArray(rawItem.attemptIds) ? rawItem.attemptIds.map(iso) : [],
    order: workItemOrder === null
      ? null
      : { allowedScope: Array.isArray(workItemOrder.allowedScope) ? workItemOrder.allowedScope.map(iso) : null },
  };
  // 空串不当作「这一跳的事件」：没有 attemptId 的事件是平台 / L3 零散动的手，
  // 混进某一跳名下就会把一次全局改派说成这一跳的候选变更。
  const selectedActivity = selectedAttemptId === ''
    ? []
    : activity.filter((event) => text(event && event.attemptId) === selectedAttemptId);

  const output = taskOutputHtml({
    currentAttemptId: currentLiveAttemptId(activity),
    selectedAttemptId,
    nowIso,
    currentAttempt: m.currentAttempt,
    selectedAttempt: m.selectedAttempt,
    liveChunks: Array.isArray(m.liveChunks) ? m.liveChunks : [],
    selectedWorkItem,
    selectedActivity,
    fileEvidence: fileEvidenceOf(rawWorkItems, activity, selectedAttemptId),
  }, { side: outputSide });

  const header = taskHeaderHtml(view, {
    tab,
    intentExpanded,
    createdAt,
    nowIso,
    formatTime,
  });

  const workflowPanel = panelHtml(
    'workflow',
    taskFlowHtml(view, activity, { selectedWorkItemId, expanded: historyExpanded })
      // 输出区**只放在工作流面板里**：它是这一页唯一会自己变的东西，两边各挂一份就是
      // 两个游标、两种刷新节奏，其中一份会停在旧数据上而看起来完全正常。放在面板内部
      // 而不是外面，切到交付/契约页签时它跟着 hidden——人不会以为它还在追这一跳。
      + output,
    tab === 'workflow',
  );

  const deliveryPanel = panelHtml(
    'delivery',
    // activity 是交付六层时间的唯一来源，validationReportFull 是「已跑命令与计数」的唯一
    // 来源：两者都不传，屏幕上就只能写「未知」，而事实明明已经在只读数据里了。
    taskDeliveryHtml(view, {
      selectedWorkItemId,
      activity,
      validationReport: object(m.validationReportFull),
      formatTime,
    }),
    tab === 'delivery',
  );

  const contractPanel = panelHtml(
    'contract',
    taskContractHtml(view, { selectedWorkItemId }),
    tab === 'contract',
  );

  return '<div class="td-page"'
    + ' data-mission-id="' + esc(iso(view.missionId)) + '"'
    + ' data-tab="' + esc(tab) + '">'
    + header
    + workflowPanel
    + deliveryPanel
    + contractPanel
    + '</div>';
}

/**
 * 选中那一跳的文件归属链，只摘判断要用的几格。
 *
 * 按 attemptIds **找包含它的那一张工单**，找不到或找到不止一张就 null：两张都含它时
 * 说不好这三格属于哪张，挑一张看着对的，屏幕上就成了一份看着精准、其实属于另一版
 * 工单的清单。
 *
 * 事件只留 `execution_result.submitted` 与 `validation.reported`，且**不按 attemptId
 * 过滤**：后者记的是「报告评的是哪一跳」（data.submittedAttemptId），事件自己的
 * attemptId 是校验方那一跳，按它过滤会把要找的那条刚好滤掉。顺序也不排：
 * 「最新一条」由投影按数组末项判，这里排一次就是两份不同的「最新」。
 *
 * 事件里的 `data.changedFiles` 是**数量**，投影不拿它当路径；这里也不摘它。
 */
function fileEvidenceOf(workItems, activity, selectedAttemptId) {
  if (selectedAttemptId === '') return null;
  const owners = workItems.filter((item) => object(item) !== null
    && Array.isArray(item.attemptIds)
    && item.attemptIds.map(text).includes(selectedAttemptId));
  if (owners.length !== 1) return null;

  const item = owners[0];
  const workItemId = text(item.id);
  if (workItemId === '') return null;

  const order = object(item.order);
  const executionResult = object(item.executionResult);
  const review = object(item.lastReview);
  const report = object(item.validationReport);

  const events = [];
  for (const event of activity) {
    const e = object(event);
    if (e === null || text(e.workItemId) !== workItemId) continue;
    const kind = text(e.kind);
    if (kind !== 'execution_result.submitted' && kind !== 'validation.reported') continue;
    const data = object(e.data) ?? {};
    // 只摘投影读的三格：整份 data 传下去，下一个人就会顺手在里面找路径。
    events.push({
      kind,
      workItemId,
      attemptId: text(e.attemptId),
      data: {
        orderRevision: data.orderRevision === undefined ? undefined : text(data.orderRevision),
        reportId: data.reportId === undefined ? undefined : text(data.reportId),
        submittedAttemptId: data.submittedAttemptId === undefined ? undefined : text(data.submittedAttemptId),
      },
    });
  }

  return {
    workItemId,
    attemptIds: item.attemptIds.map(text),
    orderRevision: order === null ? '' : text(order.orderRevision),
    changedFiles: executionResult !== null && Array.isArray(executionResult.changedFiles)
      ? executionResult.changedFiles.filter((file) => typeof file === 'string')
      : null,
    reviewSubmittedAttemptId: review === null ? '' : text(review.submittedAttemptId),
    reportId: report === null ? '' : text(report.reportId),
    events,
  };
}

/** hidden 用属性 + 属性反射一起写：只改其中一个，某些实现下面板会既不可见也不占位。 */
function setHidden(el, hidden) {
  if (hidden) el.setAttribute('hidden', '');
  else el.removeAttribute('hidden');
  if ('hidden' in el) el.hidden = hidden;
}

/**
 * 在某元素已有的处理器之后再挂一层。
 *
 * 三个子视图已经各自用 `el.onclick =` 绑了「翻自己的状态」，这里**必须保留**那些
 * 处理器：直接覆盖会让页头自己的页签高亮不再翻；换成 addEventListener 则与它们叠成
 * 两个监听器，点一次页签先翻两次再回原样，表现为按钮点了没反应。
 */
function after(el, handlerName, run) {
  const prev = el[handlerName];
  el[handlerName] = (event) => {
    if (typeof prev === 'function') prev.call(el, event);
    run(event);
  };
}

/** handlers 缺省为空对象，缺函数就跳过：调用方只关心其中一两个回调时不该崩。 */
function call(handlers, name, arg) {
  const fn = handlers && typeof handlers[name] === 'function' ? handlers[name] : null;
  if (fn !== null) fn(arg);
}

/** UI 状态一次只报一格：把整份 model 报回去，调用方分不清是哪一次交互触发的。 */
function callUi(handlers, patch) {
  call(handlers, 'onUi', patch);
}

/**
 * 只绑 root 里的交互。
 *
 * 每一层都**只改自己那份状态**，边界是矩形的：
 *   - 页签只翻面板的 hidden；
 *   - 展开 intent / 纵向历史只把翻好的状态报给调用方（文案与 data-expanded 由子视图
 *     自己翻，这里照抄它的结果，不另判一次）；
 *   - 切工作项只把选择报给调用方，**不在这里重算环节**：重算要重新取 activity；
 *   - 选历史只报 attemptId，**绝不动 .td-live 的 data-live-attempt**：那是这一页存在
 *     的理由，改它一次，人就会把上一跳的结尾当成正在跑的进度；
 *   - 输出侧栏同理，只报 side，不动实时那一跳。
 *
 * 「定位当前」是唯一一处一次改动两样东西（展开 + 选中）的按钮：它本来就等于「把
 * 界面挪到正在跑的那一条」。这里找的是 [data-current="true"]，**不按「最后一条」
 * 另算一次**：当前项的定义在投影里只有一份。
 */
export function bindTaskDetail(root, handlers) {
  if (!root || typeof root.querySelectorAll !== 'function') return;

  // 三个 bind* 各自只认自己那一块的根：页头那一个必须拿到 .td-header 本身，它翻的是
  // **页头根上**的 data-tab，而下面按「header 的 data-tab」给面板设 hidden 时读的也是
  // 同一个属性。传整页进来，页头根上的 data-tab 就永远停在初始值，切页签时面板不跟着
  // 换，而页头自己看着像是切过去了。
  const headerRoot = root.querySelector('.td-header') || root;
  const flowRoot = root.querySelector('.td-flow') || root;
  const outputRoot = root.querySelector('.td-output') || root;
  bindTaskHeader(headerRoot);
  bindTaskFlow(flowRoot);
  bindTaskOutput(outputRoot);

  for (const button of root.querySelectorAll('button[data-tab]')) {
    after(button, 'onclick', () => {
      // 页签的权威状态在页头根上（bindTaskHeader 已经翻好），照抄它，不读按钮自己的
      // data-tab：读按钮会在「键盘 / 程序触发」这类路径下与页头不一致。
      const header = root.querySelector('.td-header');
      const tab = normalizeTab(header === null ? '' : header.getAttribute('data-tab'));
      root.setAttribute('data-tab', tab);
      for (const panel of root.querySelectorAll('.td-tab-panel')) {
        setHidden(panel, text(panel.getAttribute('data-panel')) !== tab);
      }
      callUi(handlers, { tab });
    });
  }

  for (const button of root.querySelectorAll('[data-action="toggle-intent"]')) {
    after(button, 'onclick', () => {
      const intent = root.querySelector('.td-intent');
      callUi(handlers, { intentExpanded: intent !== null && intent.getAttribute('data-expanded') === 'true' });
    });
  }

  for (const toggle of root.querySelectorAll('[data-action="toggle-history"]')) {
    after(toggle, 'onclick', () => {
      const flow = root.querySelector('.td-flow');
      callUi(handlers, { historyExpanded: flow !== null && flow.getAttribute('data-expanded') === 'true' });
    });
  }

  for (const select of root.querySelectorAll('select.td-work-item')) {
    after(select, 'onchange', () => {
      call(handlers, 'onWorkItem', text(select.value));
    });
  }

  for (const row of root.querySelectorAll('.td-stage, .td-history-row')) {
    after(row, 'onclick', () => {
      // data-attempt 可能是空串（平台 / L3 的零散动作不是一次「一跳」），原样报出去：
      // 调用方看到空串就知道这一行没有 Attempt 可选，比这里悄悄吞掉一次点击更好排查。
      call(handlers, 'onSelectAttempt', text(row.getAttribute('data-attempt')));
    });
  }

  for (const button of root.querySelectorAll('.td-output [data-side]')) {
    after(button, 'onclick', () => {
      callUi(handlers, { outputSide: text(button.getAttribute('data-side')) });
    });
  }

  for (const button of root.querySelectorAll('[data-action="locate-current"]')) {
    // 这里没有子视图的处理器要保留，用赋值而不是 addEventListener 的理由同别处：
    // 详情页每次重渲染都会再调一次本函数，监听器会一层层叠上去。
    button.onclick = () => {
      const flow = root.querySelector('.td-flow');
      if (flow === null) return;
      // 先找当前项，找不到就**什么都不改**：没有当前项时把界面展开、把按钮文案翻成
      // 「收起…」，等于演了一次「已经定位到某处」，而那里一条都没高亮。
      const current = flow.querySelector('[data-current="true"]');
      if (current === null) return;

      flow.setAttribute('data-expanded', 'true');
      const toggle = flow.querySelector('[data-action="toggle-history"]');
      if (toggle !== null) toggle.textContent = HISTORY_EXPANDED_LABEL;

      const key = text(current.getAttribute('data-key'));
      flow.setAttribute('data-selected-stage', key);

      const attemptId = text(current.getAttribute('data-attempt'));
      if (attemptId !== '') call(handlers, 'onSelectAttempt', attemptId);
      if (typeof current.scrollIntoView === 'function') current.scrollIntoView();
    };
  }
}

/**
 * 挂齐这一页用到的六张同源样式（五个子视图各一张 + 本层一张）。
 *
 * 只挂一次、按 href 判断，挂法与各子视图的 ensure* 一致：每次换任务都会调到这里，
 * 不查就会每换一条任务多叠一张表。
 */
export function ensureTaskDetailStylesheets(doc) {
  if (!doc || typeof doc.createElement !== 'function') return;
  ensureTaskHeaderStylesheet(doc);
  ensureTaskFlowStylesheet(doc);
  ensureTaskDeliveryStylesheet(doc);
  ensureTaskContractStylesheet(doc);
  ensureTaskOutputStylesheet(doc);

  const head = doc.head || doc.documentElement;
  if (!head) return;
  const href = '/task-detail-page.css';
  if (doc.querySelector('link[href="' + href + '"]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  head.appendChild(link);
}
