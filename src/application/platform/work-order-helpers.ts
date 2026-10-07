import { ACCEPTANCE_STATUSES } from '../../kernel/index.ts';
import type { AcceptanceResult, Mission, WorkOrder, WorkItemStatus } from '../../kernel/index.ts';
import { invalidArgvReason } from '../validation/engine.ts';
import type { WorkOrderStandardWarning } from './types.ts';
import { PlatformRuleError } from './context.ts';

/**
 * 工单处于「正在跑 / 已出结果」时不能修订。每条给协调者下一步能照做的事：
 * 等结果、先验收、或走作废重建。created / rejected / blocked 不在表里，可修订。
 */
export const REVISE_BLOCKED_HINT: Partial<Record<WorkItemStatus, string>> = {
  // 恢复路径有两条，提示必须照实写清，否则协调者会以为「改不动」而走作废，
  // 把一张还得做的工作项扔掉（作废只表示不用做了，不是重启手段）：
  // 等这次结果或等平台收尾后修订同一张单再派发，且先验收这次结果（要补做就新建
  // 补修单）；还有活执行者或快照过期时收尾暂时收不掉，那就先等平台收尾或升级。
  dispatched:
    '正在执行中，改不了：还有活执行者或快照过期就先等平台收尾，平台会把它转为卡住，转后即可修订同一张单再派发（先验收这次结果）；不要为了改工单而作废它，作废表示这件事不用做了。',
  submitted: '已有执行结果待验收，先 review_execution_result 收掉这次结果，再决定是否修订。',
  accepted:
    '已验收不能修订；要补做就新建一张补修单，在 requiredBehaviour 里引用原工作项 id 与它已满足的验收、只写还缺的部分，原单的验收记录保持不动；目标、验收、范围不变就不需要升级给 L3，变了才升级。',
  retired:
    '已作废，不能修订，作废表示这件事不用做了或已被取代；要做的内容不一样就新建工单并引用原 id，不要用作废来重启一个卡住的工作项。',
};

/**
 * 派发门禁里「当前状态不能派发」的提示：给协调者下一步能照做的事。
 * retired 不是坏状态——它表示这件事已被取代，要再做就新建一张引用原 id 的工单。
 */
export function notDispatchableHint(status: WorkItemStatus): string {
  return status === 'retired'
    ? '已作废，不能派发，作废表示这件事不用做了或已被取代；要做的内容不一样就新建工单并引用原 id，不要用作废来重启一个卡住的工作项。'
    : '改不了这一张就新建一张工单；卡住的工作项先修订再派发。';
}

/**
 * 两份工单的顶层字段差异（字段名，排序）。
 *
 * orderRevision 由 kernel 机械递增，不代表协调者改了什么，所以从两侧剔掉；
 * 修订号单独由事件的 revision 字段给出。用 JSON 值比较能连数组 / 对象的
 * 内容差异一起认出来，而不是只看引用是否变了。
 */
export function orderChangedFields(
  previous: Readonly<WorkOrder> | undefined,
  next: WorkOrder,
): string[] {
  const prev = { ...((previous ?? {}) as Record<string, unknown>) };
  const curr = { ...(next as unknown as Record<string, unknown>) };
  delete prev.orderRevision;
  delete curr.orderRevision;
  const fields = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  const changed: string[] = [];
  for (const field of fields) {
    const before = JSON.stringify(prev[field] ?? null);
    const after = JSON.stringify(curr[field] ?? null);
    if (before !== after) changed.push(field);
  }
  return changed.sort();
}

/**
 * 工单 `criteria` 合法性校验。省略合法：存量工单根本没有这一格。有值就必须每项都是
 * 1..acceptance.length 的整数——越界序号会让统计对着一条不存在的标准计数。
 */
export function checkWorkOrderCriteria(order: WorkOrder, mission: Mission): void {
  const raw = order.criteria;
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    throw new PlatformRuleError(
      'BAD_WORK_ITEM_CRITERIA',
      '工单 criteria 必须是数组（或不填）：填覆盖的验收标准序号，例如 [1, 2]。',
    );
  }
  const limit = mission.contract?.acceptance.length ?? 0;
  for (const n of raw as readonly unknown[]) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > limit) {
      throw new PlatformRuleError(
        'BAD_WORK_ITEM_CRITERIA',
        `工单 criteria 只能是 1 到 ${limit} 的整数（当前契约 acceptance 条数），实际：${JSON.stringify(raw)}。`,
      );
    }
  }
}




/**
 * 工单 `validation.commands[*].argv` 合法性校验（COM13 / W-525）。
 *
 * 判据复用共享的那一份（不是抄一份正则）：收单时不挡，坏 argv 只会在验收阶段
 * 才发现，那时执行者已经按这张单白跑一整跳。省略 validation 合法：旧工单走
 * `verification` 字符串，没有结构化命令可查。
 *
 * 报错必须给到能照做的位置与改法：下标 + 可执行文件 + 原始原因，否则协调者只能
 * 猜是哪一条命令坏了、猜怎么改成不经 shell 的形式。
 */
export function checkWorkOrderValidationArgv(order: WorkOrder): void {
  const commands = order.validation?.commands;
  if (commands === undefined) return;
  for (let i = 0; i < commands.length; i += 1) {
    const argv = (commands[i] ?? ({} as { argv?: readonly string[] })).argv ?? [];
    const reason = invalidArgvReason(argv);
    if (reason === undefined) continue;
    const bin = argv.length === 0 ? '（空：commands[' + String(i) + '].argv 一项都没有）' : argv[0];
    throw new PlatformRuleError(
      'WORK_ORDER_VALIDATION_ARGV',
      `工单 validation.commands[${String(i)}] 的 argv 不合法：可执行文件 ${JSON.stringify(bin)}（${reason}）。` +
        '验证命令不经 shell，直接写可执行文件与参数，例如 ["node","--test"] 或 ' +
        '["node","--import","tsx","--test","src/*.test.ts"]（glob 由 Node 自己展开）。',
    );
  }
}

/**
 * 纯校验：工单是否超出「工单标准」又不至于硬拒。
 *
 * 规则放在 Platform 而非 HTTP handler：两个 coordinator 工具共用同一份真话。
 * 仅按末尾扩展名识别文件、把纯目录路径剔除——目录不得冒充文件；
 * 不发明任何新硬拒，所有命中项都只是软警告。
 */
export function checkWorkOrderStandard(order: WorkOrder): WorkOrderStandardWarning[] {
  const warnings: WorkOrderStandardWarning[] = [];
  const files = (order.allowedScope ?? []).filter((p) => /\.[^/]+$/.test(p));
  const dirs = (order.allowedScope ?? []).filter((p) => !/\.[^/]+$/.test(p));
  if (files.length + dirs.length > 2) {
    warnings.push({
      rule: 'allowedScope',
      suggestion:
        'allowedScope 超过 2 项：一张工单只做一个行为、改 1–2 个文件，请拆成多张工单。',
    });
  } else if (dirs.length > 0) {
    warnings.push({
      rule: 'allowedScope',
      suggestion: 'allowedScope 含纯目录路径，不得冒充文件：请列出具体文件（带扩展名）。',
    });
  }
  if ((order.verification ?? []).length > 2) {
    warnings.push({
      rule: 'verification',
      suggestion: 'verification 超过 2 条：每条验收 1–2 条验证即可，请精简或拆单。',
    });
  }
  if ((order.contextRefs ?? []).length === 0) {
    warnings.push({
      rule: 'contextRefs',
      suggestion: 'contextRefs 为空：至少给出最小充分上下文（文件行段或 Living Spec 引用）。',
    });
  }
  return warnings;
}

/**
 * 协调者评审的逐条结果（方案 §11）：工单有验收标准时必须一条对一条、照抄原文。
 *
 * 为什么强制：一句总结里「都过了」和「三条过了、第四条没法验」看起来一样，
 * 而后者正是 L3 最需要看到的。报错写成协调者能照做的话——它下一步就是按这句改。
 * 没有验收标准的旧工作项不要求；给了就得是空的，不然对不上。
 */
export function checkAcceptanceResults(
  workItemId: string,
  acceptance: readonly string[],
  raw: unknown,
): AcceptanceResult[] | undefined {
  if (acceptance.length === 0) {
    if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return undefined;
    throw new PlatformRuleError('ACCEPTANCE_RESULTS_MISMATCH', `工作项 ${workItemId} 的工单没有验收标准，acceptanceResults 应为空数组。`);
  }
  if (!Array.isArray(raw)) {
    throw new PlatformRuleError(
      'ACCEPTANCE_RESULTS_REQUIRED',
      `工作项 ${workItemId} 有 ${acceptance.length} 条验收标准，评审必须逐条给出 acceptanceResults：` +
        'criterion 照抄原文，status 为 pass / fail / unverified / not_applicable。只写一句总结不收。',
    );
  }
  if (raw.length !== acceptance.length) {
    throw new PlatformRuleError(
      'ACCEPTANCE_RESULTS_MISMATCH',
      `逐条结果 ${raw.length} 条、验收标准 ${acceptance.length} 条：要一条对一条、顺序一致。`,
    );
  }
  return raw.map((entry, i) => {
    const r = (entry ?? {}) as Partial<AcceptanceResult>;
    if (r.criterion !== acceptance[i]) {
      throw new PlatformRuleError('ACCEPTANCE_RESULTS_MISMATCH', `第 ${i + 1} 条的 criterion 要照抄验收原文：「${acceptance[i]}」。`);
    }
    if (!(ACCEPTANCE_STATUSES as readonly unknown[]).includes(r.status)) {
      throw new PlatformRuleError('ACCEPTANCE_RESULT_INVALID', `第 ${i + 1} 条的 status 只能是 pass / fail / unverified / not_applicable。`);
    }
    if (r.status === 'pass' && !(typeof r.evidence === 'string' && r.evidence.trim())) {
      throw new PlatformRuleError('ACCEPTANCE_EVIDENCE_REQUIRED', `第 ${i + 1} 条判 pass 要写出证据（命令 + 退出码、diff 的位置……）。`);
    }
    if ((r.status === 'unverified' || r.status === 'not_applicable') && !(typeof r.note === 'string' && r.note.trim())) {
      throw new PlatformRuleError('ACCEPTANCE_NOTE_REQUIRED', `第 ${i + 1} 条判 ${r.status} 要写明原因。`);
    }
    return {
      criterion: r.criterion,
      status: r.status as AcceptanceResult['status'],
      ...(typeof r.evidence === 'string' && r.evidence.trim() ? { evidence: r.evidence } : {}),
      ...(typeof r.note === 'string' && r.note.trim() ? { note: r.note } : {}),
    };
  });
}

