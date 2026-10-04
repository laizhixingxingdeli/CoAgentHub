/**
 * ChangeRequest：L3 确认的原始变更记录（append-only 不可变事实）。
 *
 * 为什么单独存一条记录：review 结论里的「要改成什么」和 L2 还没发生的 diff
 * 是两件事——写在一起就会有人拿「已确认」当「已应用」。所以这里只记确认
 * 那一刻的事实：不含 diff，不含 queued/consumed/applied/verified 之类的
 * 应用状态，也不以 source='L3' 这种字符串当鉴权（谁在调用由调用链决定，
 * 本模块不校验身份，也不自称鉴权）。
 *
 * 不 import 任何东西：接第二个 agent 时不该因为换 executor 就得改数据形状。
 */

export interface ChangeRequest {
  readonly changeId: string;
  readonly missionId: string;
  /**
   * 真实身份事实，由受信调用者传入。
   *
   * 不是"自称"字段：本模块不做任何校验，也不据此授权——把它当成调用者
   * 已经核过身份后写下的名字。若在这里校验身份，将来换一套身份体系就得
   * 连带改数据模块。
   */
  readonly reviewer: string;
  readonly reason: string;
  readonly confirmedChange: string;
  readonly workItemId: string;
  readonly attemptId: string;
  /** 只记调用者给的 hash：本模块不生成、也不强制某套未冻结的 hash 算法。 */
  readonly baseSnapshotHash: string;
  /**
   * 由调用者明确传入。
   *
   * 绝不能用"now()"替 caller 补时间：重试会写出两条 createdAt 不同的记录，
   * 于是同一次确认变成两条、幂等判断失效。重试应当复用原记录。
   */
  readonly createdAt: string;
  readonly sourceContractRevision: number;
  readonly claimGeneration: number;
}

/** 目标过滤：给了的条件全部 AND 精确匹配，没给的不参与。 */
export interface ChangeRequestTarget {
  readonly workItemId?: string;
  readonly attemptId?: string;
  readonly claimGeneration?: number;
}

export interface ChangeRequestRepository {
  append(request: ChangeRequest): Promise<void>;
  get(changeId: string): Promise<ChangeRequest | undefined>;
  listByMission(missionId: string, target?: ChangeRequestTarget): Promise<readonly ChangeRequest[]>;
}

export class ChangeRequestConflictError extends Error {
  readonly code = 'CHANGE_REQUEST_CONFLICT';
  readonly changeId: string;

  constructor(changeId: string) {
    super(
      `ChangeRequest ${changeId} 已存在且内容不同。` +
        '已确认的变更是 append-only 不可变事实，禁止覆盖；重试请复用原记录。',
    );
    this.name = 'ChangeRequestConflictError';
    this.changeId = changeId;
  }
}

const STRING_FIELDS = [
  'changeId',
  'missionId',
  'reviewer',
  'reason',
  'confirmedChange',
  'workItemId',
  'attemptId',
  'baseSnapshotHash',
  'createdAt',
] as const;

const NUMBER_FIELDS = ['sourceContractRevision', 'claimGeneration'] as const;

const KNOWN_FIELDS = new Set<string>([...STRING_FIELDS, ...NUMBER_FIELDS]);

/**
 * 必须带时区。
 *
 * 不带时区的本地时间在不同机器上是不同的瞬间，同一次确认重试两遍就会变成
 * 两条记录——幂等判断直接失效。
 */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * 校验并返回一份 frozen 副本。
 *
 * 只认上面那份字段清单：多一个字段就抛（改协议的人必须显式改这里，而不是
 * 悄悄把 diff / receipt 塞进记录里）。字符串只查「trim 后非空」，**不改原文**——
 * 记录是事实，改写 caller 的文本等于篡改事实。
 */
export function validateChangeRequest(request: ChangeRequest): ChangeRequest {
  const plain: unknown = request;
  if (plain === null || typeof plain !== 'object' || Array.isArray(plain)) {
    throw new Error('ChangeRequest 必须是对象。');
  }
  const record = plain as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_FIELDS.has(key)) {
      throw new Error(`ChangeRequest 含未知字段：${key}（只接受已确认变更的已知字段）`);
    }
  }
  for (const key of [...STRING_FIELDS, ...NUMBER_FIELDS]) {
    if (!(key in record)) throw new Error(`ChangeRequest 缺字段：${key}`);
  }
  for (const key of STRING_FIELDS) {
    const value = record[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`ChangeRequest.${key} 必须是非空字符串。`);
    }
  }
  const createdAt = record.createdAt as string;
  if (!ISO_WITH_ZONE.test(createdAt) || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error(`ChangeRequest.createdAt 必须是带时区的合法时间：${createdAt}`);
  }
  for (const key of NUMBER_FIELDS) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`ChangeRequest.${key} 必须是正整数。`);
    }
  }
  return Object.freeze({
    changeId: record.changeId,
    missionId: record.missionId,
    reviewer: record.reviewer,
    reason: record.reason,
    confirmedChange: record.confirmedChange,
    workItemId: record.workItemId,
    attemptId: record.attemptId,
    baseSnapshotHash: record.baseSnapshotHash,
    createdAt: record.createdAt,
    sourceContractRevision: record.sourceContractRevision,
    claimGeneration: record.claimGeneration,
  }) as ChangeRequest;
}

/** 独立 frozen 副本：扁平标量对象，一层 Object.freeze 就够，不用 deep freeze。 */
export function cloneChangeRequest(request: ChangeRequest): ChangeRequest {
  return validateChangeRequest(request);
}

/** 已知字段全等；靠值不靠引用。 */
export function changeRequestsEqual(a: ChangeRequest, b: ChangeRequest): boolean {
  if (a === b) return true;
  for (const key of STRING_FIELDS) if (a[key] !== b[key]) return false;
  for (const key of NUMBER_FIELDS) if (a[key] !== b[key]) return false;
  return true;
}
