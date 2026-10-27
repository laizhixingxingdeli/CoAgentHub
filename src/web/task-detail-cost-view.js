/**
 * 任务费用明细框（画板 .impeccable/reference/figma-45-1588.txt 的 45:1588）。
 *
 * 只渲染 header.cost 已经算好的那几个字段：quality / amount / mainControllerUncounted /
 * cap / capKnown。这里**不重算费用、不读 usage、不碰 costCap**——页头那一格和这个框
 * 讲的必须是同一份事实，各算一遍之后，页头写「≈$2.11 · 上限未知」而框里写「$2.11 ·
 * 上限 $10」时，两边都不报错，只是有一个人在照着错的那个决定还要不要增额。
 *
 * 三条不许越界（与 console-overview-model.js 的 projectCost 一致）：
 *   1. quality 不是 reported / estimated，或 amount 不是有限数字 → 「费用未知」。
 *      usage.cost 上的 0 只是结构默认值，印成 $0.00 就是「这次不要钱」。
 *   2. 真实的 reported $0.00 就是 $0.00：真没花钱和没上报是两件事，不能抹成同一句。
 *   3. cap 缺失或不是有限数字 → 「预算上限未知」，绝不补成 10（那是从没生效过的门禁）。
 *
 * 不写死画板里的 $2.11 / $10：那是截图那一刻的样例数字，抄进代码就成了一条
 * 永远显示同一笔花费的假账。
 */
import { esc } from './projects.js';

const TITLE = '任务费用明细（标价折算）';
const UNKNOWN = '费用未知';
const CAP_UNKNOWN = '预算上限未知';

/** 金额行：质量决定写法，质量不明时金额本身不可信。 */
function amountLine(cost) {
  const quality = cost.quality === 'reported' || cost.quality === 'estimated' ? cost.quality : 'unknown';
  const amount = cost.amount;
  if (quality === 'unknown' || typeof amount !== 'number' || !Number.isFinite(amount)) return UNKNOWN;
  // ≈ 只属于 estimated：reported 带 ≈ 就等于把上报值降级成估算。
  if (quality === 'estimated') return '费用（标价折算）≈$' + amount.toFixed(2);
  return '费用（标价折算）$' + amount.toFixed(2);
}

/** 上限行：只认真正的有限数字，缺失不补默认值。 */
function capLine(cost) {
  const cap = cost.cap;
  if (cost.capKnown !== true || typeof cap !== 'number' || !Number.isFinite(cap)) return CAP_UNKNOWN;
  return '预算上限 $' + cap.toFixed(2);
}

/**
 * 明细框 HTML。open 为假时带 hidden——框仍在 DOM 里，打开只是去掉属性，
 * 这样点击不需要重建节点，刷新（重渲染）也只需按保存的开合状态带上 attribute。
 */
export function taskCostDetailHtml(cost, open) {
  const c = cost && typeof cost === 'object' ? cost : {};
  const lines = [amountLine(c)];
  // direct 的两层协作里平台看不见主控会话的费用，已知的这部分只是执行侧的。
  // 不写这一句，框里的数字看起来就是完整总成本。
  if (c.mainControllerUncounted === true) lines.push('主控未计');
  lines.push(capLine(c));

  // 标了 tabindex="-1" 与 role：它是浮层，读屏时应当被当成一块独立内容，
  // 而不是页头那段流里多出来的三句话。
  return '<div class="td-cost-detail" role="dialog" aria-label="' + esc(TITLE) + '" tabindex="-1"'
    + (open === true ? '' : ' hidden') + '>'
    + '<p class="td-cost-detail-title">' + esc(TITLE) + '</p>'
    + '<div class="td-cost-detail-body">'
    + lines.map((line) => '<p class="td-cost-detail-line">' + esc(line) + '</p>').join('')
    + '</div>'
    + '<button type="button" class="td-cost-detail-back" data-action="close-cost">返回</button>'
    + '</div>';
}
