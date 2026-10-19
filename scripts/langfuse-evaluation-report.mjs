#!/usr/bin/env node
/**
 * 离线模型质量基线报告（可复跑，零依赖）。
 *
 * 为什么要有这一层：Langfuse 里能取到的是「事实记录」（哪个 case 的第几次尝试、什么角色、
 * 什么任务类型/难度、哪个模型与提示词版本、哪版验收规则、费用多少），以及平台给出的
 * 权威验收结论。但这些事实**不能直接平均**：executor 与 coordinator 的验收主体不同
 * （前者只认 L2，后者只认 L3），不同任务类型/难度/提示词版本/验收规则之间也不可比。
 * 把不同条件的样本混在一起算「通过率」，得到的数字看起来很专业，实际没有意义。
 *
 * 所以这个脚本只做一件事：**按比较维度完全分组，然后只在组内算指标**；条件不齐的记录
 * 进 notComparable，绝不参与正式排名。它不做的事同样重要：
 *   - 不做 LLM 裁判，不按 token/字数判断质量；
 *   - 不自动推荐模型、不改变任何路由；
 *   - 不从缺失字段猜值（缺 role 就缺，不按 attempt 前缀猜是 executor）；
 *   - 不把 machine pass 当质量通过，不把 infrastructure failure 当模型能力 reject；
 *   - 不把 unknown 折成 accept 或 reject；0 分母出 null，不出「100%」。
 *
 * 输入是**显式记录数组**（JSON 文件），每条形状见下；不从 Langfuse API 或平台状态文件读，
 * 也不读凭据。导出的 `buildEvaluationReport()` 是纯函数：同样的输入必然得到同样的输出
 * （没有时间戳、没有随机 id、键序固定），便于逐次对比基线。
 *
 *   {
 *     "caseId": "case-001",              // 一次执行案例的唯一 id（同一 case 的多次尝试共用）
 *     "attemptId": "attempt-001-1",      // 平台 Attempt id（同一 case 内唯一）
 *     "attemptIndex": 0,                 // 该 case 内的第几次尝试，整数，>=0，从 0 开始
 *     "role": "executor",                // executor | coordinator
 *     "taskType": "bugfix",              // 任务类型（自由文本，但必须是显式事实）
 *     "difficulty": "easy",              // 难度（同上）
 *     "model": "model-x",                // 模型标识
 *     "promptVersion": "prompt-v1",      // 提示词版本
 *     "codeRevision": "abc1234",         // 被评测的代码版本
 *     "rubricVersion": "rubric-v1",      // 验收规则版本
 *     "outcome": { "status": "accept", "source": "l2" },  // accept|reject|unknown, l2|l3|machine
 *     "infrastructureFailure": false,    // true 表示失败是环境/基础设施，不是模型能力
 *     "costUsd": 0.42                    // 该次尝试的已知费用；未知必须写 null，不能写 0
 *   }
 *
 * 去重与冲突：`caseId + attemptId` 完全相同的重复记录稳定折叠（内容一致才折叠）；
 * 同一 `caseId + attemptId` 但内容不同、或同一 `caseId + attemptIndex` 对应不同 attemptId，
 * 都判为冲突，整份输入拒绝（退出码 2，不输出半份报告），而不是静默取其一。
 * 组合键一律用 `JSON.stringify([...])` 而不是字符串拼接：caseId/attemptId 里带控制字符
 * （例如 NUL）时拼接会碰撞，JSON 数组不会。
 *
 * 闭合口径（`attemptIndex` 从 0 开始）：
 *   - 首次尝试按定义是 index 0。输入里没有 0，就不知道真实首次，`firstAttempt` 记 unknown，
 *     绝不把 index 2 当成首次。
 *   - 最终尝试 = **整个 case** 在输入里可证实的最新一次（`caseBounds.last`），而不是组内最后一条：
 *     同一 case 的后续尝试可能换了模型/难度而落在别的组，组内旧 accept 不能当「最终通过」。
 *     被剔除的残缺记录若带已知 `attemptIndex`，同样参与这个边界（它证明「还有更晚一次」）；
 *     残缺记录的 index 都不可用时无法确定最新，保守记 unknown。
 *   - `completedCases` 与成功成本**只用**同一个「最终可评估且 accept」条件：组内曾 accept 不算完成。
 *   - 「全案成本」只在观测到 0..last 连续索引、每条费用都已知、且该 case 没有被剔除的
 *     残缺记录时才成立；否则该 case 的成本是未知，不能拿「已看到的几条」当完整。
 *   - 指标只表示**输入里**的最新权威结果；输入未闭合不等于整个 Mission 终审完成，
 *     一条「最新观察」也不等于整个 Mission 已经完成。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const EVALUATION_REPORT_SCHEMA_VERSION = 1;
export const INPUT_ERROR = 'EVALUATION_REPORT_INPUT_ERROR';
export const CONFLICT_ERROR = 'EVALUATION_REPORT_CONFLICT';

const ROLES = new Set(['executor', 'coordinator']);
const STATUSES = new Set(['accept', 'reject', 'unknown']);
const SOURCES = new Set(['l2', 'l3', 'machine']);
/** 权威验收来源：executor 的质量只看 L2，coordinator 只看 L3。machine 对两者都不是质量结论。 */
const AUTHORITY = new Map([['executor', 'l2'], ['coordinator', 'l3']]);
const TEXT_FIELDS = [
  'caseId',
  'attemptId',
  'taskType',
  'difficulty',
  'model',
  'promptVersion',
  'codeRevision',
  'rubricVersion',
];
const MAX_EXAMPLES = 5;

export class EvaluationReportError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'EvaluationReportError';
    this.code = code;
    this.detail = detail;
  }
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' && value.trim().length > 0 ? value : null);
/** 费用求和走定点取整：0.1+0.2 不能报成 0.30000000000000004。 */
const round = (value) => Math.round(value * 1e6) / 1e6;
/** 0 分母一律 null：没有样本不是「100% 成功」，也不是「0 元」。 */
const rate = (numerator, denominator) => (denominator > 0 ? round(numerator / denominator) : null);
const ratio = (numerator, denominator) => (denominator > 0 ? round(numerator / denominator) : null);
const sortedUnique = (values) => [...new Set(values)].sort();

/**
 * 把一条原始记录规范化。缺字段与字段非法分开记：前者说明「这份数据没采集到」，
 * 后者说明「这份数据不可信」，两种都要能追溯到具体字段，但都不许猜。
 */
function normalize(raw) {
  if (!isObject(raw)) return { record: null, missing: ['record'], invalid: [] };
  const missing = [];
  const invalid = [];
  const record = {};

  for (const field of TEXT_FIELDS) {
    const value = raw[field];
    if (value === undefined || value === null) {
      missing.push(field);
    } else if (text(value) === null) {
      invalid.push(field);
    } else {
      record[field] = value;
    }
  }

  const attemptIndex = raw.attemptIndex;
  if (attemptIndex === undefined || attemptIndex === null) missing.push('attemptIndex');
  else if (!Number.isInteger(attemptIndex) || attemptIndex < 0) invalid.push('attemptIndex');
  else record.attemptIndex = attemptIndex;

  if (raw.role === undefined || raw.role === null) missing.push('role');
  else if (!ROLES.has(raw.role)) invalid.push('role');
  else record.role = raw.role;

  if (raw.outcome === undefined || raw.outcome === null) {
    missing.push('outcome');
  } else if (!isObject(raw.outcome)) {
    invalid.push('outcome');
  } else {
    const status = raw.outcome.status;
    if (status === undefined || status === null) missing.push('outcome.status');
    else if (!STATUSES.has(status)) invalid.push('outcome.status');
    else record.status = status;
    const source = raw.outcome.source;
    if (source === undefined || source === null) missing.push('outcome.source');
    else if (!SOURCES.has(source)) invalid.push('outcome.source');
    else record.source = source;
  }

  if (typeof raw.infrastructureFailure !== 'boolean') {
    if (raw.infrastructureFailure === undefined || raw.infrastructureFailure === null) missing.push('infrastructureFailure');
    else invalid.push('infrastructureFailure');
  } else {
    record.infrastructureFailure = raw.infrastructureFailure;
  }

  if (!('costUsd' in raw)) missing.push('costUsd');
  else if (raw.costUsd === null) record.costUsd = null;
  else if (typeof raw.costUsd === 'number' && Number.isFinite(raw.costUsd) && raw.costUsd >= 0) record.costUsd = raw.costUsd;
  else invalid.push('costUsd');

  return { record: missing.length === 0 && invalid.length === 0 ? record : null, missing, invalid };
}

/** 只对已知字段做规范化比较：同一 attempt 的重复导出即使多带了元数据，也不算冲突。 */
function canonical(record) {
  return JSON.stringify([
    record.caseId,
    record.attemptId,
    record.attemptIndex,
    record.role,
    record.taskType,
    record.difficulty,
    record.model,
    record.promptVersion,
    record.codeRevision,
    record.rubricVersion,
    record.status,
    record.source,
    record.infrastructureFailure,
    record.costUsd,
  ]);
}

function exampleOf(raw) {
  const out = {};
  if (typeof raw?.caseId === 'string') out.caseId = raw.caseId;
  if (typeof raw?.attemptId === 'string') out.attemptId = raw.attemptId;
  if (Number.isInteger(raw?.attemptIndex)) out.attemptIndex = raw.attemptIndex;
  return out;
}

function dimensionsOf(record) {
  return {
    role: record.role,
    taskType: record.taskType,
    difficulty: record.difficulty,
    model: record.model,
    promptVersion: record.promptVersion,
    codeRevision: record.codeRevision,
    rubricVersion: record.rubricVersion,
    source: record.source,
  };
}

/**
 * 单组指标。只接收「条件齐全、来源与角色匹配、非 infra」的尝试；
 * 每条尝试都属于某个 case，case 内按 attemptIndex 排序。
 *
 * 首尾两次的口径跨组判定：`caseBounds` 给出该 case 在**整份输入**里真实的首/末
 * attemptIndex。首次按定义是 0（`first` 在输入里没有 index 0 时是 null），所以组内最小
 * attemptIndex 比它大——首次尝试被排除在组外（infra、machine、来源与角色不符，维度不同），
 * 或根本没有观测到 index 0——此时首次只能是 unknown，绝不能把组内第二条尝试当「首次」。
 * 最终结论同理（末次 = 输入里观测到的最大 attemptIndex）。
 */
function groupMetrics(dims, attempts, caseCostOf, caseBounds) {
  const byCase = new Map();
  for (const record of attempts) {
    const list = byCase.get(record.caseId);
    if (list) list.push(record);
    else byCase.set(record.caseId, [record]);
  }
  for (const list of byCase.values()) list.sort((a, b) => a.attemptIndex - b.attemptIndex);

  const outcomes = { accept: 0, reject: 0, unknown: 0 };
  let knownCostUsd = 0;
  let knownCostAttempts = 0;
  for (const record of attempts) {
    outcomes[record.status] += 1;
    if (record.costUsd !== null) {
      knownCostUsd += record.costUsd;
      knownCostAttempts += 1;
    }
  }

  let decidedCases = 0;
  let firstEvaluated = 0;
  let firstAccepted = 0;
  let firstUnknown = 0;
  let finalEvaluated = 0;
  let finalAccepted = 0;
  let finalUnknown = 0;
  let rejectCount = 0;
  let completedCases = 0;
  let costKnownCompletedCases = 0;
  let costUnknownCompletedCases = 0;
  let completedCostUsd = 0;

  for (const [caseId, list] of byCase) {
    const decided = list.some((record) => record.status !== 'unknown');
    if (decided) decidedCases += 1;
    rejectCount += list.filter((record) => record.status === 'reject').length;

    // 首次 = 该 case 的 attemptIndex 0。只有输入里真的有 0 且它就在本组时才算数；
    // 没有 0（例如只导出了第 2 次）或 0 被排除在组外，都是 unknown——
    // 绝不把第二次尝试顶上来当「首次」。
    const first = list[0];
    const bounds = caseBounds.get(caseId);
    if (first.status === 'unknown' || !bounds || bounds.first === null || bounds.first !== first.attemptIndex) firstUnknown += 1;
    else {
      firstEvaluated += 1;
      if (first.status === 'accept') firstAccepted += 1;
    }

    // 最终 = 整个 case 在输入里可证实的最新一次尝试，且它落在本组、有权威结论。
    // 只有这个条件成立才算「完成」：组内更早的 accept 不算——后续尝试可能已经换组
    // （另一个模型/难度）判了 reject，或还有一条残缺记录证明存在更晚的一次。
    const last = list[list.length - 1];
    const isLatest = Boolean(bounds) && bounds.last !== null && bounds.last === last.attemptIndex;
    const finalEvaluable = isLatest && last.status !== 'unknown';
    if (finalEvaluable) {
      finalEvaluated += 1;
      if (last.status === 'accept') finalAccepted += 1;
    } else finalUnknown += 1;

    if (finalEvaluable && last.status === 'accept') {
      completedCases += 1;
      // 单位成功成本要包含这个 case 此前所有尝试（跨组的也算）。
      // 只有 0..last 连续、每条费用已知、没有残缺记录被剔除时才是「全案」；
      // 否则整案未知——不能把缺的当 0 拉低平均值，也不能把看到的几条当完整。
      const cost = caseCostOf(caseId);
      if (cost === null) costUnknownCompletedCases += 1;
      else {
        costKnownCompletedCases += 1;
        completedCostUsd += cost;
      }
    }
  }

  return {
    group: dims,
    attempts: attempts.length,
    cases: byCase.size,
    decidedCases,
    undecidedCases: byCase.size - decidedCases,
    outcomes,
    firstAttempt: {
      evaluatedCases: firstEvaluated,
      acceptedCases: firstAccepted,
      unknownCases: firstUnknown,
      passRate: rate(firstAccepted, firstEvaluated),
    },
    finalAttempt: {
      evaluatedCases: finalEvaluated,
      acceptedCases: finalAccepted,
      unknownCases: finalUnknown,
      passRate: rate(finalAccepted, finalEvaluated),
    },
    rework: {
      rejectCount,
      cases: byCase.size,
      perCase: ratio(rejectCount, byCase.size),
    },
    cost: {
      knownAttempts: knownCostAttempts,
      unknownAttempts: attempts.length - knownCostAttempts,
      coverage: ratio(knownCostAttempts, attempts.length),
      knownCostUsd: knownCostAttempts > 0 ? round(knownCostUsd) : null,
    },
    completedCaseCost: {
      caseCostScope: 'all-attempts-of-case',
      completedCases,
      costKnownCases: costKnownCompletedCases,
      costUnknownCases: costUnknownCompletedCases,
      coverage: ratio(costKnownCompletedCases, completedCases),
      // 没有任何费用已知的已完成 case 时，总额也是未知，不写 0 冒充「零成本」。
      totalCostUsd: costKnownCompletedCases > 0 ? round(completedCostUsd) : null,
      perCompletedCaseUsd: rate(completedCostUsd, costKnownCompletedCases),
    },
  };
}

/**
 * 纯函数入口：显式记录数组 -> 报告对象。不读文件、不读环境、不读时间。
 * 输入形状不对或存在冲突时抛 EvaluationReportError（code 为 INPUT_ERROR / CONFLICT_ERROR）。
 */
export function buildEvaluationReport(input) {
  if (!Array.isArray(input)) throw new EvaluationReportError(INPUT_ERROR, 'input must be an array of records');

  const notComparable = new Map();
  const unique = new Map();
  const attemptIndexOwner = new Map();
  const partialCaseIds = new Set();
  /** 残缺记录给出的 attemptIndex：证明「这个 case 还有第几次」，即使那次的结论不可用。 */
  const partialIndexes = new Map();
  /** 残缺记录连 attemptIndex 都不可用的 case：最新一次无法确定，最终只能记 unknown。 */
  const unindexedPartialCases = new Set();
  let duplicatesCollapsed = 0;
  let partialRecords = 0;

  const noteNotComparable = (raw, missing, invalid) => {
    const key = JSON.stringify([sortedUnique(missing), sortedUnique(invalid)]);
    let bucket = notComparable.get(key);
    if (!bucket) {
      bucket = { reason: 'incomplete_record', missing: sortedUnique(missing), invalid: sortedUnique(invalid), count: 0, examples: [] };
      notComparable.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.examples.length < MAX_EXAMPLES) bucket.examples.push(exampleOf(raw));
  };

  for (const raw of input) {
    const { record, missing, invalid } = normalize(raw);
    if (!record) {
      partialRecords += 1;
      // 这个 case 有记录被剔除：它的输入不闭合，费用不可能再声称「全案」。
      if (typeof raw?.caseId === 'string') {
        partialCaseIds.add(raw.caseId);
        // 残缺记录也可能给出真实边界（「第几次」还在）：index 已知就参与首/末判定；
        // 连 index 都不知道时，该 case 最新一次无从确定。
        if (Number.isInteger(raw.attemptIndex) && raw.attemptIndex >= 0) {
          const seen = partialIndexes.get(raw.caseId);
          if (seen) seen.push(raw.attemptIndex);
          else partialIndexes.set(raw.caseId, [raw.attemptIndex]);
        } else unindexedPartialCases.add(raw.caseId);
      }
      noteNotComparable(raw, missing, invalid);
      continue;
    }
    const key = JSON.stringify([record.caseId, record.attemptId]);
    const existing = unique.get(key);
    if (existing) {
      if (canonical(existing) !== canonical(record)) {
        throw new EvaluationReportError(CONFLICT_ERROR, `conflicting content for caseId=${record.caseId} attemptId=${record.attemptId}`);
      }
      duplicatesCollapsed += 1;
      continue;
    }
    const indexKey = JSON.stringify([record.caseId, record.attemptIndex]);
    const owner = attemptIndexOwner.get(indexKey);
    if (owner !== undefined && owner !== record.attemptId) {
      throw new EvaluationReportError(
        CONFLICT_ERROR,
        `conflicting attemptIndex for caseId=${record.caseId} attemptIndex=${record.attemptIndex}`,
      );
    }
    attemptIndexOwner.set(indexKey, record.attemptId);
    unique.set(key, record);
  }

  // 每案的全量尝试（跨组）只用于单位成功成本；组内指标仍按组切分。
  const allByCase = new Map();
  for (const record of unique.values()) {
    const list = allByCase.get(record.caseId);
    if (list) list.push(record);
    else allByCase.set(record.caseId, [record]);
  }
  const caseCostOf = (caseId) => {
    const list = allByCase.get(caseId) ?? [];
    if (list.length === 0) return null;
    // 有记录被剔除（缺字段/字段非法）说明这个 case 的输入没闭合：可能还有一次尝试的钱不知道。
    if (partialCaseIds.has(caseId)) return null;
    const indexes = list.map((record) => record.attemptIndex).sort((a, b) => a - b);
    // 只有 0..last 连续观测到，才敢说「全案」的钱都在这里；缺 0 或中间缺号一律未知。
    for (let i = 0; i < indexes.length; i += 1) if (indexes[i] !== i) return null;
    let sum = 0;
    for (const record of list) {
      if (record.costUsd === null) return null;
      sum += record.costUsd;
    }
    return round(sum);
  };
  const caseBounds = new Map();
  for (const [caseId, list] of allByCase) {
    const indexes = list.map((record) => record.attemptIndex);
    const partial = partialIndexes.get(caseId) ?? [];
    // attemptIndex 从 0 开始：没有完整的 0 就是没有观测到真实首次，first 记 null（不是最小值）。
    // 若有一条残缺记录声称自己是 index 0，那次「首次」本身不可信，同样记 null。
    const first = indexes.includes(0) && !partial.includes(0) ? 0 : null;
    // 最新 = 整案可证实的最大 index：残缺记录给出的 index 也算（它证明还有更晚一次）；
    // 有一条残缺记录的 index 不可用，就无法确定最新，保守记 null。
    const last = unindexedPartialCases.has(caseId) ? null : Math.max(...indexes, ...partial);
    caseBounds.set(caseId, { first, last });
  }

  const groups = new Map();
  const comparableCaseIds = new Set();
  const machine = [];
  const sourceRoleMismatch = [];
  const infrastructureFailures = [];

  for (const record of unique.values()) {
    const dims = dimensionsOf(record);
    if (record.infrastructureFailure) {
      infrastructureFailures.push({ ...dims, caseId: record.caseId, attemptId: record.attemptId, attemptIndex: record.attemptIndex, status: record.status, costUsd: record.costUsd });
      continue;
    }
    if (record.source === 'machine') {
      machine.push({ ...dims, caseId: record.caseId, attemptId: record.attemptId, attemptIndex: record.attemptIndex, status: record.status, costUsd: record.costUsd });
      continue;
    }
    if (AUTHORITY.get(record.role) !== record.source) {
      sourceRoleMismatch.push({ ...dims, caseId: record.caseId, attemptId: record.attemptId, attemptIndex: record.attemptIndex, status: record.status, costUsd: record.costUsd });
      continue;
    }
    const key = JSON.stringify([dims.role, dims.taskType, dims.difficulty, dims.model, dims.promptVersion, dims.codeRevision, dims.rubricVersion, dims.source]);
    comparableCaseIds.add(record.caseId);
    const bucket = groups.get(key);
    if (bucket) bucket.push(record);
    else groups.set(key, [record]);
  }

  const rows = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, attempts]) => groupMetrics(dimensionsOf(attempts[0]), attempts, caseCostOf, caseBounds));

  const byAttempt = (a, b) => (a.caseId === b.caseId ? (a.attemptIndex - b.attemptIndex || (a.attemptId < b.attemptId ? -1 : 1)) : a.caseId < b.caseId ? -1 : 1);
  machine.sort(byAttempt);
  sourceRoleMismatch.sort(byAttempt);
  infrastructureFailures.sort(byAttempt);

  const comparableAttempts = rows.reduce((sum, row) => sum + row.attempts, 0);
  const infraKnownCost = infrastructureFailures.reduce((sum, record) => sum + (typeof record.costUsd === 'number' ? record.costUsd : 0), 0);

  return {
    schemaVersion: EVALUATION_REPORT_SCHEMA_VERSION,
    summary: {
      recordsRead: input.length,
      duplicatesCollapsed,
      partialRecords,
      comparableAttempts,
      comparableCases: comparableCaseIds.size,
      groups: rows.length,
      notComparableRecords: partialRecords,
      machineRecords: machine.length,
      sourceRoleMismatchRecords: sourceRoleMismatch.length,
      infrastructureFailureRecords: infrastructureFailures.length,
      infrastructureFailureKnownCostUsd: round(infraKnownCost),
    },
    groups: rows,
    notComparable: [...notComparable.values()].sort((a, b) => {
      const left = JSON.stringify([a.missing, a.invalid]);
      const right = JSON.stringify([b.missing, b.invalid]);
      return left < right ? -1 : left > right ? 1 : 0;
    }),
    excluded: {
      machine: { count: machine.length, records: machine },
      sourceRoleMismatch: { count: sourceRoleMismatch.length, records: sourceRoleMismatch },
      infrastructureFailures: { count: infrastructureFailures.length, records: infrastructureFailures },
    },
  };
}

const USAGE = 'usage: node scripts/langfuse-evaluation-report.mjs --input <json-file> [--report <json-file>]';

async function main(argv) {
  let inputPath;
  let reportPath;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--input' && argv[i + 1] && !argv[i + 1].startsWith('--')) inputPath = argv[++i];
    else if (argv[i] === '--report' && argv[i + 1] && !argv[i + 1].startsWith('--')) reportPath = argv[++i];
    else {
      process.stderr.write(`${INPUT_ERROR}\n${USAGE}\n`);
      return 2;
    }
  }
  if (!inputPath) {
    process.stderr.write(`${INPUT_ERROR}\n${USAGE}\n`);
    return 2;
  }
  try {
    const parsed = JSON.parse((await readFile(inputPath)).toString('utf8'));
    const report = buildEvaluationReport(parsed);
    const body = `${JSON.stringify(report, null, 2)}\n`;
    if (reportPath) await writeFile(reportPath, body, { flag: 'w' });
    process.stdout.write(body);
    return 0;
  } catch (error) {
    const code = error instanceof EvaluationReportError ? error.code : INPUT_ERROR;
    // 只回固定错误码与字段名：不打印路径、不打印记录正文。
    const detail = error instanceof EvaluationReportError && error.code === CONFLICT_ERROR ? `\n${error.detail}` : '';
    process.stderr.write(`${code}${detail}\n`);
    return 2;
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write(`${INPUT_ERROR}\n`);
      process.exitCode = 2;
    });
}
