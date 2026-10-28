/**
 * 任务详情页「工作流环节」区的渲染层：把 task-detail-flow.js 已经算好的投影拼成
 * HTML，再绑上三件只在本区里生效的交互（换工作项、展开纵向历史、点选一条环节）。
 *
 * **为什么投影与渲染分成两个文件**：这一层要断言的每一条都是「看起来对、其实在
 * 说谎」的形状——把样板里写死的「执行第 13 次」端上来、把还没发生的环节先铺成
 * 占位、把机器自动退回画成协调者的动作、给已验收的工单标上「当前选中」。这些错
 * 在浏览器里都不报错、不崩、也不影响任何断言，只是屏幕上的字看着都挺合理。
 * 判断一律留在 task-detail-flow.js（纯函数，node 里喂假 activity 就能断言），
 * 这里只负责转义和 DOM，**不重算环节、不重算次数、不重算当前项**：抄第二份判断，
 * 两处迟早只改到一处，而漏改的那边在界面上只是一句不一样的话。
 *
 * **不 import task.js、也不 import application**：那边是详情页的渲染模块，它要
 * import 本模块来接线；互相 import 在浏览器原生 ES module 下不成环报错，只会让
 * 某一侧拿到 undefined，然后整页白掉。前端只走 `/api/*` 投影出来的 view。
 */
import { esc } from './projects.js';
import { projectWorkflow } from './task-detail-flow.js';

/** 展开 / 收起的文案就是按钮的全部信息，两处（渲染与点击）必须同一份。 */
const HISTORY_COLLAPSED_LABEL = '展开纵向历史';
const HISTORY_EXPANDED_LABEL = '收起历史';

/**
 * 一条环节里的文字节点：徽章、标题、身份、明细、状态**各占一个节点**。
 *
 * 身份行额外带 title，值与节点文字同一份：卡槽是写死的 136px 且 overflow: hidden，
 * 再长的 profile/model 也只能在卡内折几行，超出部分被裁；不留 title 时那半截在这页
 * 任何地方都查不到，而人核对「这一跳到底用了谁」靠的正是这一行。title 取同一个
 * esc(identityOf(stage))，不另算一份，否则悬停看到的与卡片上写的可能不是一回事。
 * 纵向历史行共用本函数，因此也带 title（那里不裁切，多一个 title 也无害）。
 *
 * 合成一句之后，「平台 · 自动退回执行者 · 验证没过 · 已记录」会被读成一件事，
 * 而人需要分清「谁动的手」「干了什么」「跑完没有」。徽章只在投影给出非空值时
 * 才画：执行者 / 协调者的徽章按角色另出，这里凭空补一个空壳会被当成「有徽章但
 * 是空的」。
 */
function stageBody(stage) {
  const badge = stage.badge === undefined || stage.badge === null ? '' : String(stage.badge).trim();
  const badgeNode = badge === ''
    ? ''
    : '<span class="td-badge">' + esc(badge) + '</span>';

  return badgeNode
    + '<h3 class="td-stage-title">' + esc(stage.title) + '</h3>'
    + '<p class="td-stage-identity" title="' + esc(identityOf(stage)) + '">' + esc(identityOf(stage)) + '</p>'
    + '<p class="td-stage-detail">' + esc(stage.detail) + '</p>'
    + '<p class="td-stage-state">' + esc(stateLine(stage)) + '</p>';
}

/** 身份为空就写「未知」：「这条环节没记候选」与「这里忘了画」不能长得一样。 */
function identityOf(stage) {
  const identity = stage.identity === undefined || stage.identity === null ? '' : String(stage.identity).trim();
  return identity === '' ? '未知' : identity;
}

/** 事件的 ISO → 本地 HH:MM；解析不出来就空串（不编一个时间，也不拿此刻顶上）。 */
function clockOf(at) {
  const raw = at === undefined || at === null ? '' : String(at).trim();
  if (raw === '') return '';
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return pad(when.getHours()) + ':' + pad(when.getMinutes());
}

/**
 * 历史行的时间列：本地「MM-DD HH:mm」，**日期与时刻一起给**。
 *
 * 只写 HH:MM 在横向卡里够用（那里看的是最近几条、都在今天），一整列历史却会跨天：
 * 三条都写着「09:02」时人无法分辩哪条是今天、哪条是昨天的。也不写死源稿里的示例
 * 时刻：那是一个具体日子的字面量，抄进代码后先在夹具上看着对，到真实数据上就全错。
 * 解析不出来回「未知」，比留空强：空白看起来像这一行没有发生时间。
 */
function stampOf(at) {
  const raw = at === undefined || at === null ? '' : String(at).trim();
  if (raw === '') return '未知';
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) return '未知';
  const pad = (n) => String(n).padStart(2, '0');
  return pad(when.getMonth() + 1) + '-' + pad(when.getDate())
    + ' ' + pad(when.getHours()) + ':' + pad(when.getMinutes());
}

/**
 * 状态行 = 状态词 + （事件自带 at 能解析时）那一跳发生的本地时刻。
 *
 * **时斜只从事件 at 来，本层不取「现在」**：取了新时刻，盯一眼页面就会把两小时前
 * 结束的一跳读成刚刚才完；而且同一条数据两次渲染会得出不同的字。状态词不拿时间
 * 代替 —— 「12:30」回答不了「跑完没有」。
 */
function stateLine(stage) {
  const state = stage.stateText === undefined || stage.stateText === null ? '' : String(stage.stateText).trim();
  const clock = clockOf(stage.at);
  return clock === '' ? state : state + ' · ' + clock;
}

/** 当前项标记只认投影给的 currentKey，不按「最后一条」另算一次。 */
function currentAttr(stage, currentKey) {
  return stage.key !== null && stage.key === currentKey ? ' data-current="true"' : '';
}

/** 收起时的横向步骤卡：一条 article，data-key / data-attempt 都是接线与测试要用的。 */
function stageCard(stage, currentKey) {
  return '<article class="td-stage" data-key="' + esc(stage.key)
    + '" data-attempt="' + esc(stage.attemptId) + '"' + currentAttr(stage, currentKey) + '>'
    + stageBody(stage)
    + '</article>';
}

/**
 * 展开后的纵向历史：一行 li，三列（标题 / 身份 / 时间+结果），顺序由调用方保证（旧在前）。
 *
 * **不复用 stageBody**：那是横向卡的排版（徽章 + 标题 + 身份 + 明细 + 状态五行堆在
 * 136px 里）。把它搬进纵向列表，展开后就是「同一批环节在一屏里说两遍，第二种说法还是
 * 横卡形状」，而屏幕上看着一点也不错。三列各有固定槽宽（240 / 400 / 剩余），所以列与
 * 列在各行之间对齐——读到「时间」那一列时人是在扫一列，不是每行重找一次位置。
 *
 * 身份与标题都带 title＝全文：身份列 overflow:hidden 裁长 profile/model，裁掉的那半截
 * 若不留在 title 里，这页就再也查不到「这一跳到底用了谁」。时间列 title 只放原始 at
 * ISO：它是核对本地时间对不对的唯一凭据；没有 at 就不编一个 title。
 */
function historyRow(stage, currentKey) {
  const title = stage.title === undefined || stage.title === null ? '' : String(stage.title);
  const identity = identityOf(stage);
  const rawAt = stage.at === undefined || stage.at === null ? '' : String(stage.at).trim();
  const result = stage.resultLabel === undefined || stage.resultLabel === null || String(stage.resultLabel).trim() === ''
    ? (stage.stateText === undefined || stage.stateText === null ? '' : String(stage.stateText).trim())
    : String(stage.resultLabel).trim();

  return '<li class="td-history-row" data-key="' + esc(stage.key)
    + '" data-attempt="' + esc(stage.attemptId) + '"' + currentAttr(stage, currentKey) + '>'
    + '<h3 class="td-history-title" title="' + esc(title) + '">' + esc(title) + '</h3>'
    + '<p class="td-history-identity" title="' + esc(identity) + '">' + esc(identity) + '</p>'
    + '<p class="td-history-time"' + (rawAt === '' ? '' : ' title="' + esc(rawAt) + '"')
    + '>' + esc(stampOf(rawAt) + ' · ' + result) + '</p>'
    + '</li>';
}

/**
 * 工作项下拉。option 的值就是 item.id（接线只认 id），文本是 `${id} ${title}`：
 * 只写标题时人得自己把标题对回工单号，而工单号才是催活、grep 用的那个。
 *
 * 选中只认 flow.selectedId —— 不顺手把已验收的那张也标成 selected：一个 select
 * 出现两个选中项时，浏览器显示哪一个取决于实现，人看到的可能是已经做完的那张。
 */
function workItemSelect(flow) {
  const options = flow.items.map((item) => {
    const selected = item.id === flow.selectedId ? ' selected' : '';
    return '<option value="' + esc(item.id) + '"' + selected + '>'
      + esc(item.id + ' ' + item.title) + '</option>';
  }).join('');
  return '<select class="td-work-item" aria-label="工作项">' + options + '</select>';
}

/**
 * 标题带「第几轮」与「已记录几次执行」。
 *
 * 轮次为空就整段不写：老工单没有 orderRevision，补一句「第 1 轮」等于说这张单
 * 已经被派过一轮了。次数取投影给的 executionLabel，不按卡片条数另算——收起时
 * 只显示最近几条，按条数算会把「13 次」显示成「4 次」。
 *
 * **展开态写两个真实数字**：底下就是完整纵向历史，标题是唯一能核对「下面是不是
 * 全部」的地方。两个数都取投影（stages / executionCount），本层不数 DOM 行——数行
 * 等于给了第二份判断，收起时那行数又是被剪过的。轮次仍只用 round.label，不合成
 * 「第 1–3 轮」：任务里没有这个区间事实，写了就是编。
 */
function flowTitle(flow, expanded) {
  if (!flow.selectedId) return '还没有工作项';
  const parts = [flow.selectedId];
  if (flow.round && flow.round.label) parts.push(flow.round.label);
  parts.push(expanded === true
    ? flow.stages.length + ' 个已发生环节 / ' + flow.executionCount + ' 次执行'
    : flow.executionLabel);
  return parts.join(' · ');
}

/**
 * 已验收的芯片：**只画所选工作项前面紧邻的那一项**。
 *
 * 不把全部已验收项都铺出来（14 张验收单会把标题带挤成一条收不住的线），也不只看
 * 列表里最后一项：与当前项不相邻的那张已验收单跟眼前这件事没有关系，拿出来只是噪声。
 */
function acceptedChip(flow) {
  const index = flow.items.findIndex((item) => item.id === flow.selectedId);
  if (index <= 0) return '';
  const previous = flow.items[index - 1];
  if (previous.status !== 'accepted') return '';
  return '<span class="td-accepted" data-work-item="' + esc(previous.id) + '">'
    + esc(previous.id + ' 已验收') + '</span>';
}

/**
 * 环节区 HTML。根节点 section.td-flow。
 *
 * 结构分三层，每一层的位置都是排版事实：
 *   - `.td-flow-picker` 在白板**外面**：选哪张单是在选“看什么”，不是白板里的一条环节；
 *     它留在标题带里会跟轮次、展开按钮抢同一行，而标题带只说一件事——这版内容是什么。
 *   - `.td-flow-board` 是白底那块：标题带 + 步骤卡 + 纵向历史，三样才是一组。
 *   - 标题带里的展开与定位都在带内靠右：它们是这一块的两个动作，不是环节本身。
 *
 * **只渲染已经发生过的环节**：投影里没有未来环节，这里也就不可能铺出「下一步」
 * 「待执行」的占位。占位和真跑过的环节长得一模一样，人分不出哪些是真的。
 *
 * **纵向历史一开始就在 DOM 里，收起时靠 CSS 隐藏**（见 task-detail-flow.css 的
 * `.td-flow .td-history`）：bindTaskFlow 按契约只翻根上的 data-expanded 与按钮
 * 文案、不重算环节，如果历史行要等展开才拼，点一下按钮就永远什么都不出现。
 * 卡片列表仍然只铺 flow.visibleStages：收起时看到的是最近几条，不是整条时间线。
 */
export function taskFlowHtml(view, activity, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const flow = projectWorkflow(view, activity, opts);
  const expanded = opts.expanded === true;
  const currentKey = flow.currentKey;

  const cards = flow.visibleStages.map((stage) => stageCard(stage, currentKey)).join('');
  const rows = flow.stages.map((stage) => historyRow(stage, currentKey)).join('');

  return '<section class="td-flow"'
    + ' data-selected-work-item="' + esc(flow.selectedId === null ? '' : flow.selectedId) + '"'
    + ' data-expanded="' + (expanded ? 'true' : 'false') + '">'
    + '<div class="td-flow-picker">'
    + workItemSelect(flow)
    + '</div>'
    + '<div class="td-flow-board">'
    + '<div class="td-flow-head">'
    + '<span class="td-flow-title">' + esc(flowTitle(flow, expanded)) + '</span>'
    + acceptedChip(flow)
    + '<button type="button" class="td-locate" data-action="locate-current">定位当前</button>'
    + '<button type="button" class="td-history-toggle" data-action="toggle-history">'
    + esc(expanded ? HISTORY_EXPANDED_LABEL : HISTORY_COLLAPSED_LABEL) + '</button>'
    + '</div>'
    + '<div class="td-flow-stages">' + cards + '</div>'
    + '<ol class="td-history">' + rows + '</ol>'
    + '</div>'
    + '</section>';
}

/**
 * 只绑 root 里的交互。
 *
 * 用 `el.onchange =` / `el.onclick =` 而不是 addEventListener：详情页每次重渲染都
 * 会再调一次本函数，赋值会覆盖上一次的处理器；监听器则会一层层叠上去，点一次
 * 「展开」翻转多次，表现为按钮点了没反应（翻两下正好回到原状）。
 *
 * 三件事的边界都是矩形的，不能互相串：
 *   - 换工作项只改 option 的 selected 与根上的 data-selected-work-item，**不在这里
 *     重算环节**：重算要重新拉 activity，那是调用方的事；在这里凭旧数据重算一次，
 *     屏幕会显示另一张工单的环节，而它看起来完全正常。
 *   - 展开只翻 data-expanded 与按钮文案。哪些行显示由 CSS 决定，所以不必重算。
 *   - 点一条环节只记 data-selected-stage，**不动 data-selected-work-item**：选中的
 *     环节永远属于当前工作项，二者一起改会让「点一下看看这条」变成「换了个工单」。
 */
export function bindTaskFlow(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;

  for (const select of root.querySelectorAll('select.td-work-item')) {
    select.onchange = () => {
      const value = String(select.value === undefined || select.value === null ? '' : select.value).trim();
      for (const option of root.querySelectorAll('select.td-work-item option')) {
        if (String(option.value).trim() === value) option.setAttribute('selected', 'selected');
        else option.removeAttribute('selected');
      }
      root.setAttribute('data-selected-work-item', value);
    };
  }

  for (const button of root.querySelectorAll('[data-action="toggle-history"]')) {
    button.onclick = () => {
      const expanded = root.getAttribute('data-expanded') !== 'true';
      root.setAttribute('data-expanded', expanded ? 'true' : 'false');
      button.textContent = expanded ? HISTORY_EXPANDED_LABEL : HISTORY_COLLAPSED_LABEL;
    };
  }

  for (const row of root.querySelectorAll('.td-stage, .td-history-row')) {
    row.onclick = () => {
      const key = row.getAttribute('data-key');
      if (key === null) return;
      root.setAttribute('data-selected-stage', key);
    };
  }
}

/**
 * 只挂一次同源样式，挂法与 ensureTaskHeaderStylesheet 一致。
 *
 * 不写进 index.html：那份文件所有页面共用，环节区的排版进去之后，别的页面改一次
 * 全局样式就可能连带改到这里的卡片与历史行。按 href 判断是否已存在：每次挂载都会
 * 调到，不查就会每换一条任务多叠一张表。
 */
export function ensureTaskFlowStylesheet(doc) {
  if (!doc || typeof doc.createElement !== 'function') return;
  const head = doc.head || doc.documentElement;
  if (!head) return;
  const href = '/task-detail-flow.css';
  if (doc.querySelector('link[href="' + href + '"]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  head.appendChild(link);
}
