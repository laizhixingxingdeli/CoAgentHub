/**
 * ChangeImpact：一次「改了会不会打到正在跑的执行」的判断结果（append-only 不可变事实）。
 *
 * 为什么和 ChangeRequest 分成两条记录：ChangeRequest 记的是 L3「确认要改什么」，
 * ChangeImpact 记的是这次改动对某个在跑 Attempt 的影响结论。写在一个对象里会让
 * 「已确认」和「已判断影响」变成一个动作——而它们是两个人、两个时刻做的。
 *
 * 为什么带上 claim / coordinatorAttemptId：影响结论要能被质疑——谁在第几代领取
 * 权下、对哪次 coordinator 尝试做出的判断，后面重放时得对得上。只存 conclusion
 * 字符串的判断在追溯时等于没有判断。
 *
 * 不含 applied / consumed / verified：那是执行侧的事，写进事实里就会有人拿
 * 「有影响」当「已处理」。
 *
 * 不 import 任何东西：接第二个 agent 时不该因为换 executor 就得改数据形状。
 */

/** 结论：兼容（照跑）/ 重排（推倒换 Imaging 的活儿）/ 取消替换。 */
export type ChangeImpactDecision = 'compatible' | 'replan' | 'cancel_replace';

/** 做出这次判断时所依据的那次领取事实：impact 可信与否全靠它。 */
export interface ChangeImpactClaim {
  readonly id: string;
  readonly owner: string;
  readonly claimGeneration: number;
}

/**
 * 纯业务输入：只有四业务字段。
 *
 * 身份 / 来源字段不在这里：组装记录的那一层负责给出身份，业务侧不该有机会
 * 顺手改写 changeId 或 claim——把它们放进「业务体」里，就等于允许调用方自己
 * 签自己的来源。
 */
export interface ChangeImpactBody {
  readonly decision: ChangeImpactDecision;
  readonly workOrderDiff: string;
  readonly affectedAcceptance: readonly number[];
  readonly reason: string;
}

export interface ChangeImpact extends ChangeImpactBody {
  /** 与 ChangeRequest.changeId 同名：一条变更对应一份影响判断。 */
  readonly changeId: string;
  readonly missionId: string;
  /** 目标 executor 的工作项。 */
  readonly workItemId: string;
  /** 目标 executor 的 attempt。 */
  readonly attemptId: string;
  /** 目标代次：判断是**对这一代**领取权做出的，换代后旧判断不再能用。 */
  readonly claimGeneration: number;
  readonly coordinatorAttemptId: string;
  readonly claim: ChangeImpactClaim;
}

export interface ChangeImpactRepository {
  append(impact: ChangeImpact): Promise<void>;
  get(changeId: string): Promise<ChangeImpact | undefined>;
  listByMission(missionId: string): Promise<readonly ChangeImpact[]>;
}

export class ChangeImpactConflictError extends Error {
  readonly code = 'CHANGE_IMPACT_CONFLICT';
  readonly changeId: string;

  constructor(changeId: string) {
    super(
      `ChangeImpact ${changeId} 已存在且内容不同。` +
        '影响判断是 append-only 不可变事实，禁止覆盖；重算结论请换新 id。',
    );
    this.name = 'ChangeImpactConflictError';
    this.changeId = changeId;
  }
}

const DECISIONS: readonly string[] = ['compatible', 'replan', 'cancel_replace'];

const BODY_FIELDS: readonly string[] = [
  'decision',
  'workOrderDiff',
  'affectedAcceptance',
  'reason',
];

const IDENTITY_STRING_FIELDS: readonly string[] = [
  'changeId',
  'missionId',
  'workItemId',
  'attemptId',
  'coordinatorAttemptId',
];

const CLAIM_FIELDS: readonly string[] = ['id', 'owner', 'claimGeneration'];

const KNOWN_FIELDS = new Set<string>([
  ...IDENTITY_STRING_FIELDS,
  'claimGeneration',
  'claim',
  ...BODY_FIELDS,
]);

function requireText(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  // 只查 trim 后非空、**不改原文**：记录是事实，改写 caller 的文本等于篡改事实。
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label}.${key} 必须是非空字符串。`);
  }
  return value;
}

function requireGeneration(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label}.${key} 必须是正整数。`);
  }
  return value;
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(record: Record<string, unknown>, known: Set<string>, label: string): void {
  for (const key of Object.keys(record)) {
    if (!known.has(key)) throw new Error(`${label} 含未知字段：${key}`);
  }
}

function requireMissing(record: Record<string, unknown>, fields: readonly string[], label: string): void {
  for (const key of fields) {
    if (!(key in record)) throw new Error(`${label} 缺字段：${key}`);
  }
}

/** 验收索引：必须是正整数数组。索引从 1 起，0 或负数说明调用方搞错了基。 */
function requireAcceptanceIndexes(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${label}.affectedAcceptance 必须是数组。`);
  const indexes: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item <= 0) {
      throw new Error(`${label}.affectedAcceptance 必须全是正整数索引。`);
    }
    indexes.push(item);
  }
  return indexes;
}

/**
 * 校验业务体并返回 frozen 副本。
 *
 * compatible 必须点名至少一条受影响验收：说「兼容」却不指认任何一条，这条结论
 * 没法被用来核对漏判——后期换人复算时它既不能证实也不能证伪。其余 decision
 * 允许空索引（确实没有要重跑的验收），但 diff / reason 仍必须是明确文本。
 */
export function validateChangeImpactBody(body: ChangeImpactBody): ChangeImpactBody {
  const record = requirePlainObject(body, 'ChangeImpactBody');
  rejectUnknown(record, new Set(BODY_FIELDS), 'ChangeImpactBody（只接受四业务字段）');
  requireMissing(record, BODY_FIELDS, 'ChangeImpactBody');
  const decision = record.decision;
  if (typeof decision !== 'string' || !DECISIONS.includes(decision)) {
    throw new Error(
      `ChangeImpactBody.decision 必须是 ${DECISIONS.join(' | ')} 之一：${String(decision)}`,
    );
  }
  const affectedAcceptance = requireAcceptanceIndexes(record.affectedAcceptance, 'ChangeImpactBody');
  if (decision === 'compatible' && affectedAcceptance.length === 0) {
    throw new Error('ChangeImpactBody.decision=compatible 必须给出受影响的验收索引。');
  }
  return Object.freeze({
    decision: decision as ChangeImpactDecision,
    workOrderDiff: requireText(record, 'workOrderDiff', 'ChangeImpactBody'),
    affectedAcceptance: Object.freeze([...affectedAcceptance]),
    reason: requireText(record, 'reason', 'ChangeImpactBody'),
  }) as ChangeImpactBody;
}

function validateClaim(value: unknown): ChangeImpactClaim {
  const record = requirePlainObject(value, 'ChangeImpact.claim');
  rejectUnknown(record, new Set(CLAIM_FIELDS), 'ChangeImpact.claim');
  requireMissing(record, CLAIM_FIELDS, 'ChangeImpact.claim');
  return Object.freeze({
    id: requireText(record, 'id', 'ChangeImpact.claim'),
    owner: requireText(record, 'owner', 'ChangeImpact.claim'),
    claimGeneration: requireGeneration(record, 'claimGeneration', 'ChangeImpact.claim'),
  }) as ChangeImpactClaim;
}

/**
 * 校验整份记录并返回 frozen 副本。
 *
 * 身份 / 来源字段由调用者传入、本模块不核身份——把它当成调用者已经核过之后
 * 写下的名字。在这里校验身份，将来换一套身份体系就得连带改数据模块。
 */
export function validateChangeImpact(impact: ChangeImpact): ChangeImpact {
  const record = requirePlainObject(impact, 'ChangeImpact');
  rejectUnknown(record, KNOWN_FIELDS, 'ChangeImpact');
  requireMissing(
    record,
    [...IDENTITY_STRING_FIELDS, 'claimGeneration', 'claim', ...BODY_FIELDS],
    'ChangeImpact',
  );
  const identity: Record<string, string> = {};
  for (const key of IDENTITY_STRING_FIELDS) identity[key] = requireText(record, key, 'ChangeImpact');
  const claim = validateClaim(record.claim);
  const body = validateChangeImpactBody({
    decision: record.decision,
    workOrderDiff: record.workOrderDiff,
    affectedAcceptance: record.affectedAcceptance,
    reason: record.reason,
  } as ChangeImpactBody);
  // claim 已在内部 freeze；数组也已 freeze 成新数组，两层都不指向 caller。
  return Object.freeze({
    changeId: identity.changeId,
    missionId: identity.missionId,
    workItemId: identity.workItemId,
    attemptId: identity.attemptId,
    claimGeneration: requireGeneration(record, 'claimGeneration', 'ChangeImpact'),
    coordinatorAttemptId: identity.coordinatorAttemptId,
    claim,
    decision: body.decision,
    workOrderDiff: body.workOrderDiff,
    affectedAcceptance: body.affectedAcceptance,
    reason: body.reason,
  }) as ChangeImpact;
}

/** 独立 frozen 副本：数组和 claim 也一起换掉，caller 改原数组不进库。 */
export function cloneChangeImpact(impact: ChangeImpact): ChangeImpact {
  return validateChangeImpact(impact);
}

/** 已知字段全等，数组与 claim 逐项比；靠值不靠引用。 */
export function changeImpactsEqual(a: ChangeImpact, b: ChangeImpact): boolean {
  if (a === b) return true;
  for (const key of IDENTITY_STRING_FIELDS) {
    if (a[key as keyof ChangeImpact] !== b[key as keyof ChangeImpact]) return false;
  }
  if (a.claimGeneration !== b.claimGeneration) return false;
  if (a.claim.id !== b.claim.id || a.claim.owner !== b.claim.owner) return false;
  if (a.claim.claimGeneration !== b.claim.claimGeneration) return false;
  if (a.decision !== b.decision) return false;
  if (a.workOrderDiff !== b.workOrderDiff) return false;
  if (a.reason !== b.reason) return false;
  const left = a.affectedAcceptance;
  const right = b.affectedAcceptance;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}
