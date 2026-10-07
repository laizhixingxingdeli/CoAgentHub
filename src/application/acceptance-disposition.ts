/**
 * AcceptanceDisposition：验收时对某个工作项（或一批工作项）作出的处置结论。
 *
 * 为什么和 ContractHistory 分开记：历史留的是"契约原文写了什么"，处置留的是
 * "面对这份契约，这次验收怎么处置"。合成一条记录就会让"契约改了"和"结论改了"
 * 变成同一个动作，事后无法区分"契换代了所以重验"和"契约没动却重验了一遍"。
 *
 * 为什么键是 dispositionId 全局而不是 missionId + index：处置由验收侧按一次
 * 判断发一张，同一 Mission 的多个工作项可能各有一张，也可能一次判断覆盖多个
 * 工作项（workItemIds）。按 mission + index 分组会让"这次判断"的边界随着别人
 * 补记而平移，id 才是指向具体那一次判断的稳定把手。
 *
 * 为什么 basis 的限制这么死：处置是要拿去挡下一轮工单的机器事实，"凭什么"
 * 说不清楚的处置等于没处置。多一个键就拒绝，是为了让"凭什么"永远只有这几种
 * 说法，不会长出自造字段。note 保存原文不 trim：改写字面等于篡改理由。
 *
 * 本文件不 import 其它模块：接第二个 agent 时不该因为换执行器就得改数据形状。
 */

export type AcceptanceDecision = 'reuse' | 'revalidate' | 'new_requirement';

const DECISIONS = new Set<string>(['reuse', 'revalidate', 'new_requirement']);

/**
 * 处置依据。可选键**出现与否本身就是内容**：写了 priorContractRevision=2 和
 * 根本没写，说的是两件不同的事，等值比较必须能区分。
 */
export interface AcceptanceDispositionBasis {
  readonly submittedAttemptId?: string;
  readonly reviewAttemptId?: string;
  readonly reportId?: string;
  readonly snapshotHash?: string;
  /** 上一版契约代次：整数且 >= 1。 */
  readonly priorContractRevision?: number;
  /** 必填，trim 后非空；保存原文，不 trim。 */
  readonly note: string;
}

export interface AcceptanceDispositionRecord {
  readonly dispositionId: string;
  readonly missionId: string;
  readonly contractRevision: number;
  /** 同一次判断里这批工作项的顺序号：整数且 >= 1。 */
  readonly index: number;
  readonly decision: AcceptanceDecision;
  /** 允许空数组（例如整体 reuse 时不必点名）；元素 trim 后非空。 */
  readonly workItemIds: readonly string[];
  readonly basis: AcceptanceDispositionBasis;
  readonly coordinatorAttemptId: string;
  /** 写下处置的时刻（ISO 字符串）。不参与等值比较：同一事实重放只是时间不同。 */
  readonly at: string;
}

export interface AcceptanceDispositionRepository {
  append(record: AcceptanceDispositionRecord): Promise<void>;
  get(dispositionId: string): Promise<AcceptanceDispositionRecord | undefined>;
  listByMission(missionId: string): Promise<readonly AcceptanceDispositionRecord[]>;
}

export class AcceptanceDispositionConflictError extends Error {
  readonly code = 'ACCEPTANCE_DISPOSITION_CONFLICT';
  readonly dispositionId: string;

  constructor(dispositionId: string) {
    super(
      `AcceptanceDisposition ${dispositionId} 已存在且内容不同。` +
        '处置是 append-only 不可变事实，禁止覆盖；新判断请换新的 dispositionId。',
    );
    this.name = 'AcceptanceDispositionConflictError';
    this.dispositionId = dispositionId;
  }
}

const KNOWN_FIELDS = new Set([
  'dispositionId',
  'missionId',
  'contractRevision',
  'index',
  'decision',
  'workItemIds',
  'basis',
  'coordinatorAttemptId',
  'at',
]);

const TEXT_FIELDS = ['dispositionId', 'missionId', 'coordinatorAttemptId', 'at'] as const;

const BASIS_TEXT_KEYS = ['submittedAttemptId', 'reviewAttemptId', 'reportId', 'snapshotHash'] as const;

const BASIS_KNOWN_KEYS = new Set<string>([
  'submittedAttemptId',
  'reviewAttemptId',
  'reportId',
  'snapshotHash',
  'priorContractRevision',
  'note',
]);

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

function requireText(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  // 只查 trim 后非空、**不改原文**：处置理由是事实，改写 caller 的文本等于篡改理由。
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label}.${key} 必须是非空字符串。`);
  }
  return value;
}

/** 代次 / 顺序号：整数且 >= 1。0 或小数会让键永远配不上。 */
function requirePositiveInt(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label}.${key} 必须是 >= 1 的整数。`);
  }
  return value;
}

function requireDecision(record: Record<string, unknown>, label: string): AcceptanceDecision {
  const value = record.decision;
  if (typeof value !== 'string' || !DECISIONS.has(value)) {
    throw new Error(`${label}.decision 必须是 reuse | revalidate | new_requirement。`);
  }
  return value as AcceptanceDecision;
}

/** workItemIds 允许空数组：整体 reuse 时不必点名具体工作项。 */
function requireWorkItemIds(record: Record<string, unknown>, label: string): string[] {
  const value = record.workItemIds;
  if (!Array.isArray(value)) throw new Error(`${label}.workItemIds 必须是数组。`);
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`${label}.workItemIds 元素必须是非空字符串。`);
    }
  }
  return [...value];
}

function requireBasis(record: Record<string, unknown>, label: string): AcceptanceDispositionBasis {
  const raw = requirePlainObject(record.basis, `${label}.basis`);
  rejectUnknown(raw, BASIS_KNOWN_KEYS, `${label}.basis`);
  const basis: Record<string, unknown> = {};
  // 可选键：出现就得非空，不出现就不写进结果——写 undefined 会让"没写"和
  // "写了空串"在等值比较里长得一样。
  for (const key of BASIS_TEXT_KEYS) {
    if (key in raw) basis[key] = requireText(raw, key, `${label}.basis`);
  }
  if ('priorContractRevision' in raw) {
    basis.priorContractRevision = requirePositiveInt(raw, 'priorContractRevision', `${label}.basis`);
  }
  basis.note = requireText(raw, 'note', `${label}.basis`);
  return Object.freeze(basis) as AcceptanceDispositionBasis;
}

/** 校验一份处置并返回 frozen 副本：caller 之后改自己的对象不该影响库里的事实。 */
export function validateAcceptanceDisposition(
  record: AcceptanceDispositionRecord,
): AcceptanceDispositionRecord {
  const raw = requirePlainObject(record, 'AcceptanceDisposition');
  rejectUnknown(raw, KNOWN_FIELDS, 'AcceptanceDisposition');
  const text: Record<string, string> = {};
  for (const key of TEXT_FIELDS) text[key] = requireText(raw, key, 'AcceptanceDisposition');
  const decision = requireDecision(raw, 'AcceptanceDisposition');
  // 新数组 + freeze：直接冻 caller 的数组会让 caller 自己再也改不动它。
  const workItemIds = Object.freeze(requireWorkItemIds(raw, 'AcceptanceDisposition'));
  const basis = requireBasis(raw, 'AcceptanceDisposition');
  return Object.freeze({
    dispositionId: text.dispositionId,
    missionId: text.missionId,
    contractRevision: requirePositiveInt(raw, 'contractRevision', 'AcceptanceDisposition'),
    index: requirePositiveInt(raw, 'index', 'AcceptanceDisposition'),
    decision,
    workItemIds,
    basis,
    coordinatorAttemptId: text.coordinatorAttemptId,
    at: text.at,
  }) as AcceptanceDispositionRecord;
}

/** 独立 frozen 副本：get / list 每次给新的，caller 改不动库里的对象。 */
export function cloneAcceptanceDisposition(
  record: AcceptanceDispositionRecord,
): AcceptanceDispositionRecord {
  return validateAcceptanceDisposition(record);
}

function basisEqual(a: AcceptanceDispositionBasis, b: AcceptanceDispositionBasis): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i += 1) {
    const key = ka[i]!;
    if (key !== kb[i]) return false;
    if (a[key as keyof AcceptanceDispositionBasis] !== b[key as keyof AcceptanceDispositionBasis]) {
      return false;
    }
  }
  return true;
}

/**
 * 除 at 外的全部字段全等；workItemIds 按顺序逐项比，basis 出现与否也算内容。
 *
 * 不比 at：同一份判断的重放只是记的时刻不同。
 */
export function acceptanceDispositionsEqual(
  a: AcceptanceDispositionRecord,
  b: AcceptanceDispositionRecord,
): boolean {
  if (a === b) return true;
  if (a.dispositionId !== b.dispositionId) return false;
  if (a.missionId !== b.missionId) return false;
  if (a.contractRevision !== b.contractRevision) return false;
  if (a.index !== b.index) return false;
  if (a.decision !== b.decision) return false;
  if (a.coordinatorAttemptId !== b.coordinatorAttemptId) return false;
  if (a.workItemIds.length !== b.workItemIds.length) return false;
  for (let i = 0; i < a.workItemIds.length; i += 1) {
    if (a.workItemIds[i] !== b.workItemIds[i]) return false;
  }
  return basisEqual(a.basis, b.basis);
}
