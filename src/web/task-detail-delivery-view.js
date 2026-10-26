/**
 * 任务详情「交付与验证」页签的渲染层：把 task-detail-delivery.js 已经算好的六层投影与
 * 交卷摘要拼成 HTML，再挂一次同源样式。
 *
 * **为什么投影与渲染分成两个文件**：这一块最容易出的错都不报错、不崩、也不影响任何
 * 断言——把上一跳残留的机器报告端上来当「这一跳通过」、把 direct 的验收写成「协调者
 * 验收」、把标准任务的独立复核写成「未知」、把上一跳的交卷文件当成这一跳改了的东西。
 * 判断一律留在 task-detail-delivery.js（纯函数，node 里喂假 view 就能断言），这里只
 * 负责转义与 DOM，**不自己判 passed、不自己判当前是否交回**：抄第二份判断，两处迟早
 * 只改到一处，而漏改的那边在界面上只是一句不一样的话。
 *
 * **时刻的本地化只借 task.js 的 formatTime 一处**：后端存的是 UTC，视图自己再写一份
 * 格式化，同一个事件在两处就会差几个小时，而且没人会把它当 bug 报。为了避开循环
 * import（task.js 是本页的渲染模块），调用方可以经 `options.formatTime` 注进来；
 * 注不进来时才用这里 import 的那一份——两条路走的是同一个函数。
 *
 * **这一区只读**：交付与验证是一件被记录下来的事实，不是一个可以在这里动手的地方。
 * 审批、恢复、终审、合入各走各自的入口（并且都要人明说），在这一区补一个按钮，
 * 屏幕上就会出现一个看起来能点、其实没有业务含义的控件。
 */
import { esc } from './projects.js';
import { formatTime } from './task.js';
import { projectDelivery } from './task-detail-delivery.js';

const text = (value) => (value === undefined || value === null ? '' : String(value)).trim();

/**
 * 一个时刻节点：看得懂的是本地时间，原文留在 title 里。
 *
 * 只印本地时间就丢了原始 ISO，事后对台账对不上；只印 ISO 则挤满一行且要看的人得
 * 自己在脑子里换算。未知（投影给的「未知」或空）照样原样输出，不编钟点。
 */
function timeHtml(iso, formatter, className) {
  const raw = text(iso);
  if (raw === '' || raw === '未知') {
    return '<p class="' + className + '">未知</p>';
  }
  const shown = formatter(raw);
  // formatTime 对不可解析的输入回「—」：那时只写原文，不把破折号当钟点。
  const body = shown === '' || shown === '—' ? raw : shown;
  return '<p class="' + className + '" title="' + esc(raw) + '">' + esc(body) + '</p>';
}

/**
 * 逐条验收结论只认投影给的 acceptanceResults。
 *
 * **没有这个字段就整段不写**：按契约条数在这里自己铺一遍「1. 2. 3.」，会把「还没评」
 * 画成「评了、条数还对得上」，而人正是靠这一块判断验收到底看没看过逐条结论。
 */
function acceptanceHtml(layer) {
  if (!Array.isArray(layer.acceptanceResults)) return '';
  const rows = layer.acceptanceResults;
  if (rows.length === 0) return '<p class="td-layer-criterion-empty">逐条结论为空</p>';
  const items = rows.map((row) => (
    '<li class="td-layer-criterion">' + esc(text(row && row.criterion)) + '</li>'
  )).join('');
  return '<ul class="td-layer-criteria">' + items + '</ul>';
}

/**
 * 一层 = article.td-layer，横着三欄：标签 / 状态与证据 / 时间（画板 70:4250）。
 *
 * 三个节点分开而不是拼成一句：「机器验证 当前未交回；残留报告 VR-616 不作为当前结果」
 * 会被读成一句正常结论，而人需要的恰恰是把状态词、依据和时刻分开看。三欄的列宽
 * 由 CSS 网格给，状态与标题同一行也是网格排出来的，而不是靠把六个字段纵向堆成一条
 * 超出视口的长条。
 *
 * data-layer / data-state 是接线与断言用的：state 是七个固定词之一，stateText 是它的
 * 中文，两者都来自投影，这里不重算。
 */
function layerHtml(layer, formatTimeFn) {
  const attribution = text(layer.attribution);
  const priorNote = text(layer.priorNote);
  return '<article class="td-layer" data-layer="' + esc(layer.key) + '">'
    + '<h3 class="td-layer-title">' + esc(layer.title) + '</h3>'
    + '<div class="td-layer-main">'
    + '<p class="td-layer-state" data-state="' + esc(layer.state) + '">'
    + esc(layer.stateText) + '</p>'
    + '<p class="td-layer-detail">' + esc(layer.detail) + '</p>'
    // 逐条验收只在这里画一次（投影已经把逐条从 detail 里拿掉了）：两边各写一遍时，
    // 同一条验收在同一层里出现两次，人分不清那是两条结论还是抄重了。
    + acceptanceHtml(layer)
    // 上轮结论另起一行带出处：混进 detail 会被读成这一轮的终审结果。
    + (priorNote === '' ? '' : '<p class="td-layer-prior">' + esc(priorNote) + '</p>')
    // 归属只在投影给出非空值时画：空壳的「来源：」会被读成「来源不明」。
    + (attribution === '' ? '' : '<p class="td-layer-attr">' + esc(attribution) + '</p>')
    + '</div>'
    + timeHtml(layer.timeText, formatTimeFn, 'td-layer-time')
    + '</article>';
}

/** 文件清单。数组之外的形状（null）不猜：写「没有当前提交的文件清单」比编一份更老实。 */
function filesHtml(current, files) {
  if (!current) {
    // 未交回时投影给的就是 null，也**不能**回头去读 executionResult.changedFiles：
    // 那是上一跳的信，写进来就成了「这一跳动了这些文件」。
    return '<p class="td-submission-files-empty">当前未交回，没有这一跳的提交文件</p>';
  }
  const rows = Array.isArray(files) ? files.map(text).filter((file) => file !== '') : [];
  if (rows.length === 0) return '<p class="td-submission-files-empty">没有当前提交的文件清单</p>';
  const items = rows.map((file) => '<li class="td-submission-file">' + esc(file) + '</li>').join('');
  return '<ul class="td-submission-files">' + items + '</ul>';
}

/**
 * 交卷摘要的字段行。缺失一律写「未知」：空白行会被读成「这一项不适用」。
 */
function fieldHtml(label, valueHtml) {
  return '<div class="td-submission-field">'
    + '<p class="td-submission-label">' + esc(label) + '</p>'
    + valueHtml
    + '</div>';
}

/**
 * 交卷摘要（aside.td-submission，画板 70:4280）。
 *
 * 字段与画板一致：提交时间、受评执行、修改范围、文件、报告归属、验证命令、已跑命令。
 * 尤其后两件：verification 是**工单要求**，ranCommands 才是**已跑结果**；把两者并排
 * 放且不带说明，人会把「要求跑 node --test」读成「已经跑过 node --test」。
 */
function submissionHtml(submission, formatTimeFn) {
  const s = submission && typeof submission === 'object' ? submission : {};
  const current = s.current === true;
  const verification = s.verification && typeof s.verification === 'object' ? s.verification : {};
  const commands = Array.isArray(verification.commands)
    ? verification.commands.map(text).filter((command) => command !== '')
    : [];
  const note = text(verification.note);
  const summary = current ? text(s.summary) : '';
  // 未知的统一口径在投影里（submittedAtText / lineDeltaText 直接给「未知」），
  // 这里不自己再写一份，也不再拿 updatedAt 或空串顶上。
  const reviewedExecution = current ? (text(s.reviewedExecution) || '未知') : '未知';
  const lineDelta = text(s.lineDeltaText) || '未知';
  const fileCount = current && typeof s.fileCount === 'number' ? s.fileCount : null;
  // 行数没有字段可读时，就只写文件数那一半；编一个「+0 / −0 行」比不写更糟。
  const scopeText = fileCount === null ? '未知' : `${fileCount} 个文件 · ${lineDelta}`;
  const reportAttribution = current ? (text(s.reportAttribution) || '未知') : '未知';
  // 已跑命令只从归属对得上的完整报告来；投影给 null 就写未知，绝不把工单命令重抄一遍。
  const ranCommands = current && Array.isArray(s.ranCommands)
    ? s.ranCommands.map(text).filter((command) => command !== '')
    : [];
  const ranCounts = current ? text(s.ranCounts) : '';

  const commandItems = commands.length === 0
    ? '<li class="td-submission-command" data-empty="true">工单没有列出验证命令</li>'
    : commands.map((command) => (
      '<li class="td-submission-command">' + esc(command) + '</li>'
    )).join('');

  // 已跑命令用同一套行样式，只靠 data-ran-command 区分：新加一个未定义的 class
  // 会在屏幕上长出默认项目符号，而这里恰好要让人一眼分得清哪几行是跑过的。
  // 未知的那一行不带 data-ran-command：它不是一条跑过的命令，只是这个位置的说明。
  const ranItems = ranCommands.length === 0
    ? '<li class="td-submission-command" data-empty="true">未知：没有与这一跳归属对得上的完整机器报告</li>'
    : ranCommands.map((command) => (
      '<li class="td-submission-command" data-ran-command="true">' + esc(command) + '</li>'
    )).join('');

  return '<aside class="td-submission" data-current="' + (current ? 'true' : 'false') + '">'
    + '<h2 class="td-submission-title">交卷摘要</h2>'
    + '<p class="td-submission-current">'
    + esc(current ? '已交回，以下是这一跳的提交' : '当前未交回，以下只有工单要求')
    + '</p>'
    + fieldHtml('提交时间', timeHtml(s.submittedAtText, formatTimeFn, 'td-submission-value'))
    + fieldHtml('受评执行', '<p class="td-submission-value">' + esc(reviewedExecution) + '</p>')
    + fieldHtml('修改范围', '<p class="td-submission-value">' + esc(scopeText) + '</p>')
    + fieldHtml('文件', filesHtml(current, s.currentFiles))
    + fieldHtml('报告归属', '<p class="td-submission-value">' + esc(reportAttribution) + '</p>')
    + '<div class="td-submission-field">'
    + '<p class="td-submission-label">验证命令</p>'
    + '<ul class="td-submission-commands">' + commandItems + '</ul>'
    // 这行说明必须留在命令旁边：它决定上面那份清单是「跑过」还是「要求跑」。
    + (note === '' ? '' : '<p class="td-submission-note">' + esc(note) + '</p>')
    + '</div>'
    + '<div class="td-submission-field">'
    + '<p class="td-submission-label">已跑命令</p>'
    + '<ul class="td-submission-commands">' + ranItems + '</ul>'
    + (ranCounts === '' ? '' : '<p class="td-submission-value">' + esc(ranCounts) + '</p>')
    + '</div>'
    + (summary === ''
      ? ''
      : fieldHtml('交卷说明', '<p class="td-submission-summary">' + esc(summary) + '</p>'))
    + '</aside>';
}

/**
 * 交付与验证区 HTML。根节点 section.td-delivery。
 *
 * 六层顺序由投影保证（机器 → 角色 → 独立复核 → 终审 → 集成 → master），这里原样
 * 遍历 delivery.layers，不排序、不筛选：在这一层漏掉或挪动一层，屏幕上少的那一层
 * 与「本来就没有这一层」长得一模一样。
 */
export function taskDeliveryHtml(view, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const delivery = projectDelivery(view, opts);
  const layers = Array.isArray(delivery.layers) ? delivery.layers : [];
  const current = delivery.currentReturned === true;
  const selected = delivery.selectedWorkItemId === null ? '' : text(delivery.selectedWorkItemId);
  // formatTime 可由调用方注入（避开与 task.js 的循环 import）；没注就用本模块 import 的同一份。
  const formatTimeFn = typeof opts.formatTime === 'function' ? opts.formatTime : formatTime;

  return '<section class="td-delivery"'
    + ' data-current-returned="' + (current ? 'true' : 'false') + '"'
    + ' data-selected-work-item="' + esc(selected) + '">'
    + '<div class="td-delivery-layers">' + layers.map((layer) => layerHtml(layer, formatTimeFn)).join('') + '</div>'
    + submissionHtml(delivery.submission, formatTimeFn)
    + '</section>';
}

/**
 * 只挂一次同源样式，挂法与 ensureTaskFlowStylesheet 一致。
 *
 * 不写进 index.html：那份文件所有页面共用，交付区的排版进去之后，别的页面改一次
 * 全局样式就可能连带改到这里的层卡片与交卷摘要。按 href 判断是否已存在：每次挂载
 * 都会调到，不查就会每换一条任务多叠一张表。
 */
export function ensureTaskDeliveryStylesheet(doc) {
  if (!doc || typeof doc.createElement !== 'function') return;
  const head = doc.head || doc.documentElement;
  if (!head) return;
  const href = '/task-detail-delivery.css';
  if (doc.querySelector('link[href="' + href + '"]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  head.appendChild(link);
}
