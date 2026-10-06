/**
 * ChangeCoverage：一次变更已经落到哪一轮工单上的覆盖记录。
 *
 * 为什么和 ChangeReceipt / ChangeImpact 分开记：Receipt 是接收侧承认「收到了」，
 * Impact 是判断「会不会打到在跑的执行」，Coverage 是「这次变更已经被写进第 N 轮
 * 工单内容里了」。三件事不是一个时刻，也不是同一方做的；合成一条记录就会让
 * 「已收到」「已判断」「已写进工单」变成一个动作，追溯时无法区分「覆盖了但没
 * 收到」和「收到了但没覆盖」。
 *
 * 为什么键是 changeId + orderRevision 而不是 changeId 单键：同一条变更会随代次
 * 升级被写进新一轮工单，两轮覆盖是两件事实。只按 changeId 留一条，换代后旧覆盖
 * 要么被覆盖（丢历史）、要么把新一轮顶掉（换代不生效）。
 *
 * 为什么记 workOrderHash：光有 orderRevision 只能说明「轮次对」，不能说明
 * 「写进去的就是这份内容」。带上工单内容的 sha256，才能让「覆盖过」这件事可被
 * 独立校验；同键异哈希就是冲突，绝不覆盖。
 *
 * 除本文件外不 import 任何东西（连 node: 都不）：接第二个 agent 时不该因为换
 * 执行器就得改数据形状。
 */

export interface ChangeCoverage {
  /** 与 ChangeRequest.changeId / ChangeImpact.changeId / ChangeReceipt.changeId 同名。 */
  readonly changeId: string;
  readonly missionId: string;
  readonly workItemId: string;
  /** 工单代次：覆盖是**对这一轮**工单内容写下的，换代后旧覆盖不再算这一轮的。 */
  readonly orderRevision: string;
  /** 这一轮工单内容的 sha256 hex：证明覆盖的是这份内容，不只是这个轮次。 */
  readonly workOrderHash: string;
  /** 写下覆盖的协调者那趟执行：与 changeId 一起说明「谁记的」。 */
  readonly coordinatorAttemptId: string;
  /** 写下覆盖的时刻（ISO 字符串）。不参与等值比较：同一事实重放只是时间不同。 */
  readonly at: string;
}

export interface ChangeCoverageRepository {
  append(record: ChangeCoverage): Promise<void>;
  get(changeId: string, orderRevision: string): Promise<ChangeCoverage | undefined>;
  listByMission(missionId: string): Promise<readonly ChangeCoverage[]>;
}

export class ChangeCoverageConflictError extends Error {
  readonly code = 'CHANGE_COVERAGE_CONFLICT';
  readonly changeId: string;
  readonly orderRevision: string;

  constructor(changeId: string, orderRevision: string) {
    super(
      `ChangeCoverage ${changeId} / ${orderRevision} 已存在且内容不同。` +
        '覆盖是 append-only 不可变事实，禁止覆盖；新事实请换新 changeId 或新 orderRevision。',
    );
    this.name = 'ChangeCoverageConflictError';
    this.changeId = changeId;
    this.orderRevision = orderRevision;
  }
}

const KNOWN_FIELDS = new Set([
  'changeId',
  'missionId',
  'workItemId',
  'orderRevision',
  'workOrderHash',
  'coordinatorAttemptId',
  'at',
]);

const STRING_FIELDS = [
  'changeId',
  'missionId',
  'workItemId',
  'orderRevision',
  'workOrderHash',
  'coordinatorAttemptId',
  'at',
] as const;

/** 除 at 外的全部字段：同一事实的重放只是记的时刻不同。 */
const IDENTITY_FIELDS = [
  'changeId',
  'missionId',
  'workItemId',
  'orderRevision',
  'workOrderHash',
  'coordinatorAttemptId',
] as const;

const HASH_RE = /^[0-9a-f]{64}$/;

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
  // 只查 trim 后非空、**不改原文**：记录是事实，改写 caller 的文本等于篡改事实。
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label}.${key} 必须是非空字符串。`);
  }
  return value;
}

function requireHash(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    throw new Error(`${label}.${key} 必须是 64 位小写 hex（sha256）。`);
  }
  return value;
}

/** 校验一份覆盖记录并返回 frozen 副本：caller 之后改自己的对象不该影响库里的事实。 */
export function validateChangeCoverage(record: ChangeCoverage): ChangeCoverage {
  const raw = requirePlainObject(record, 'ChangeCoverage');
  rejectUnknown(raw, 'ChangeCoverage');
  const text: Record<string, string> = {};
  for (const key of STRING_FIELDS) text[key] = requireText(raw, key, 'ChangeCoverage');
  // 哈希另过一遍格式：只按「非空字符串」放行会把任意文本当成内容摘要存进去，
  // 之后「同内容幂等」就再也比不出覆盖的是不是同一份工单。
  text.workOrderHash = requireHash(raw, 'workOrderHash', 'ChangeCoverage');
  return Object.freeze({
    changeId: text.changeId,
    missionId: text.missionId,
    workItemId: text.workItemId,
    orderRevision: text.orderRevision,
    workOrderHash: text.workOrderHash,
    coordinatorAttemptId: text.coordinatorAttemptId,
    at: text.at,
  }) as ChangeCoverage;
}

/** 独立 frozen 副本：get / list 每次给新的，caller 改不动库里的对象。 */
export function cloneChangeCoverage(record: ChangeCoverage): ChangeCoverage {
  return validateChangeCoverage(record);
}

/** 全部业务字段全等；**不比 at**：同一事实的重放只是记的时刻不同。 */
export function changeCoveragesEqual(a: ChangeCoverage, b: ChangeCoverage): boolean {
  if (a === b) return true;
  return IDENTITY_FIELDS.every((key) => a[key] === b[key]);
}
