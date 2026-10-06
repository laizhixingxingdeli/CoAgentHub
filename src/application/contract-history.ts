/**
 * ContractHistory：Mission 契约在某一版（contractRevision）上的原文留档。
 *
 * 为什么和 Mission 快照分开记：快照里的契约是"现在这份"，换代后被就地改写；
 * 而验收时要回答的是"第 N 版当时到底写了什么"。只看快照，换代之后旧版契约
 * 就再也问不出来，"按哪一版验收"变成没法核对的口头说法。
 *
 * 为什么键是 missionId + contractRevision 而不是 missionId 单键：契约会随代次
 * 升级换一版，两版原文是两件事实。只留一条，换代后要么被覆盖（丢原文），
 * 要么把新版本顶掉（换代不生效）。
 *
 * 为什么 acceptance 存原文数组且不 trim：它是契约里逐条写下的验收口径，
 * 改写 caller 的文本等于篡改契约。校验只看形状，不碰内容。
 *
 * 为什么等值不比 at：同一份原文的重放只是记的时刻不同，是同一件事实。
 *
 * 除本文件外不 import 任何东西（连 node: 都不）：接第二个 agent 时不该因为换
 * 执行器就得改数据形状。
 */

export interface ContractHistoryRecord {
  readonly missionId: string;
  /** 契约代次：留的是**这一版**的原文，换代后旧版不再算这一版的。 */
  readonly contractRevision: number;
  /** 这一版契约里逐条写下的验收口径；可为空数组（尚未写下验收口径）。 */
  readonly acceptance: readonly string[];
  /** 写下留档的时刻（ISO 字符串）。不参与等值比较：同一事实重放只是时间不同。 */
  readonly at: string;
}

export interface ContractHistoryRepository {
  append(record: ContractHistoryRecord): Promise<void>;
  get(missionId: string, contractRevision: number): Promise<ContractHistoryRecord | undefined>;
  listByMission(missionId: string): Promise<readonly ContractHistoryRecord[]>;
}

export class ContractHistoryConflictError extends Error {
  readonly code = 'CONTRACT_HISTORY_CONFLICT';
  readonly missionId: string;
  readonly contractRevision: number;

  constructor(missionId: string, contractRevision: number) {
    super(
      `ContractHistory ${missionId} / ${contractRevision} 已存在且内容不同。` +
        '契约原文是 append-only 不可变事实，禁止覆盖；新事实请换新的 contractRevision。',
    );
    this.name = 'ContractHistoryConflictError';
    this.missionId = missionId;
    this.contractRevision = contractRevision;
  }
}

const KNOWN_FIELDS = new Set(['missionId', 'contractRevision', 'acceptance', 'at']);

const TEXT_FIELDS = ['missionId', 'at'] as const;

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(record: Record<string, unknown>, label: string): void {
  for (const key of Object.keys(record)) {
    if (!KNOWN_FIELDS.has(key)) throw new Error(`${label} 含未知字段：${key}`);
  }
}

function requireText(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  // 只查 trim 后非空、**不改原文**：留档是事实，改写 caller 的文本等于篡改事实。
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label}.${key} 必须是非空字符串。`);
  }
  return value;
}

/**
 * 代次必须是 >= 1 的整数。
 *
 * 0 或负数留不下"第几版"，小数会让键永远配不上——键配不上就等于这份原文
 * 谁也读不到，留档白留。
 */
function requireRevision(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label}.${key} 必须是 >= 1 的整数。`);
  }
  return value;
}

/**
 * acceptance 必须是字符串数组，元素原样保留（不 trim）。
 *
 * 为什么不再要求元素非空：验收口径允许写"暂缺"这类占位，是否算数由写契
 * 约的那一侧决定；仓储层加限制会把合法的空口径挡在门外，却又挡不住真正
 * 的问题（口径写错）。
 */
function requireAcceptance(record: Record<string, unknown>, label: string): string[] {
  const value = record.acceptance;
  if (!Array.isArray(value)) throw new Error(`${label}.acceptance 必须是数组。`);
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${label}.acceptance 元素必须是字符串。`);
  }
  return [...value];
}

/** 校验一份留档并返回 frozen 副本：caller 之后改自己的对象不该影响库里的原文。 */
export function validateContractHistory(record: ContractHistoryRecord): ContractHistoryRecord {
  const raw = requirePlainObject(record, 'ContractHistory');
  rejectUnknown(raw, 'ContractHistory');
  const text: Record<string, string> = {};
  for (const key of TEXT_FIELDS) text[key] = requireText(raw, key, 'ContractHistory');
  const contractRevision = requireRevision(raw, 'contractRevision', 'ContractHistory');
  const acceptance = requireAcceptance(raw, 'ContractHistory');
  return Object.freeze({
    missionId: text.missionId,
    contractRevision,
    // 新数组 + freeze：直接冻 caller 的数组会让 caller 自己再也改不动它。
    acceptance: Object.freeze(acceptance),
    at: text.at,
  }) as ContractHistoryRecord;
}

/** 独立 frozen 副本：get / list 每次给新的，caller 改不动库里的对象。 */
export function cloneContractHistory(record: ContractHistoryRecord): ContractHistoryRecord {
  return validateContractHistory(record);
}

/** 除 at 外的全部字段全等；acceptance 逐项全等。不比 at。 */
export function contractHistoriesEqual(a: ContractHistoryRecord, b: ContractHistoryRecord): boolean {
  if (a === b) return true;
  if (a.missionId !== b.missionId) return false;
  if (a.contractRevision !== b.contractRevision) return false;
  if (a.acceptance.length !== b.acceptance.length) return false;
  for (let i = 0; i < a.acceptance.length; i += 1) {
    if (a.acceptance[i] !== b.acceptance[i]) return false;
  }
  return true;
}
