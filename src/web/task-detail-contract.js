/**
 * 任务详情「契约」页签的纯数据投影：一条 Mission 详情 + 所选工作项 → 契约全文与
 * 这一项的允许改动范围。
 *
 * **为什么单开一个纯模块**：这里最容易出的错都不报错——把缺掉的 nonGoals 写成 `[]`
 * （页面会显示「本任务没有非目标」，而真相是「这份契约没记这一格」）、把
 * contractRevision 缺省补成 1（人以为自己看的是第一版契约）、把多个工作项的
 * allowedScope 合起来展示（看起来像一张更大的工单，实际哪儿都不是）、把 intent
 * 换成一两句摘要（契约页的全部价值就是原文）。
 *
 * **不拼 HTML、不截断、不发请求**：转义与折叠是渲染层的事；前端只走 `/api/*` 已经
 * 投影好的 view。这里一旦 `slice` 一下长文本，页面上就永远看不到被截掉的那半句，
 * 而人还以为那就是全部契约。
 *
 * **契约与工作项是两份不同的东西**：契约上的 intent / acceptance 讲的是整条 Mission；
 * allowedScope 却是**某一项工作项**工单上的字段。混着读就会拿别的工作项的路径当成
 * 允许范围，交卷时按它判断越界。
 *
 * 页头 / 交付验证各自成模块（task-detail-header.js / task-detail-delivery.js），
 * 本模块只负责契约页签那几格，不重复它们的判断。
 */

const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

/**
 * 列表字段的三种状态必须能分开：**缺失 / 不是数组 → null**（没记），
 * **空数组 → []**（记了，且是空）。都写成 `[]` 之后，界面再也说不出「这份契约
 * 没写非目标」和「这份契约明确没有非目标」的区别。
 */
const copyListOrNull = (value) => (Array.isArray(value) ? value.slice() : null);

/**
 * 所选工作项。**对不上就是没有**：套到别的工单上，页面会展示一张没被选中的工单的
 * 允许范围，而人以为那是当前这一项的。
 */
function selectItem(items, asked) {
  if (typeof asked !== 'string') return null;
  const id = asked.trim();
  if (id === '') return null;
  return items.find((item) => object(item) !== null && typeof item.id === 'string' && item.id.trim() === id) ?? null;
}

/**
 * 一条 Mission 详情 → 契约页签的事实。纯函数：不改入参、不读全局、不发请求。
 *
 * view 形状 = `/api/missions/:id` 的 MissionView（contractRevision / contract / workItems[]）。
 * options = { selectedWorkItemId }：详情页当前点中的那一项。
 *
 * `readOnly` 恒为 true：这一页只读契约原文。审批 / 恢复 / 终审那些动作属于别的页签，
 * 它们的字段不往这里塞——塞进来页面就会长出一排本页签不该有的按钮。
 */
export function projectContractPage(view, options) {
  const v = object(view) ?? {};
  const opts = object(options) ?? {};
  const contract = object(v.contract);

  // 修订号只认真正的有限数字。0 是合法修订（原样返回），缺省或非法值才是「不知道」——
  // 补成 1 会让人以为自己在看第一版。
  const contractRevision = typeof v.contractRevision === 'number' && Number.isFinite(v.contractRevision)
    ? v.contractRevision
    : null;

  // intent 是字符串就原样（含空串：契约写了空 intent 与契约没有 intent 不是一回事）。
  const intent = contract !== null && typeof contract.intent === 'string' ? contract.intent : null;

  const item = selectItem(Array.isArray(v.workItems) ? v.workItems : [], opts.selectedWorkItemId);
  const order = item === null ? null : object(item.order);

  return {
    contractRevision,
    intent,
    acceptance: contract === null ? null : copyListOrNull(contract.acceptance),
    constraints: contract === null ? null : copyListOrNull(contract.constraints),
    nonGoals: contract === null ? null : copyListOrNull(contract.nonGoals),
    guardrails: contract === null ? null : copyListOrNull(contract.guardrails),
    // 只读所选工作项自己的工单；不合并别项、更不读 contract 上同名字段（契约上没有这个字段，
    // 读它只会读到 undefined 然后被当成「没有允许范围」）。
    allowedScope: order === null ? null : copyListOrNull(order.allowedScope),
    selectedWorkItemId: item === null ? null : String(item.id).trim(),
    readOnly: true,
  };
}
