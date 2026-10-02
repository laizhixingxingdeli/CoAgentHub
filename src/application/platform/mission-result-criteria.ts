import { PlatformRuleError } from './context.ts';

/**
 * 交卷 criteria 的运行时校验与闸门诊断。
 *
 * 只做纯计算、不碰 I/O：交卷数据来自 agent，形状不定的东西必须在**进聚合
 * 之前**挡掉，否则一条缺号的 criteria 会一路带到机器闸门，被当成"读不懂，
 * 算了"。两套出口分开：`validate` 用于写入路径（拒绝），`issues` 用于闸门
 * 诊断（说明差在哪，好让人去补）。
 */

const CRITERION_STATUSES = ['pass', 'fail', 'unverified', 'not_applicable'] as const;
const CRITERION_FIELDS = ['index', 'status', 'evidence'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 形状问题。空数组表示形状合法——**不含**"这条标准达成没有"的判断。 */
function structuralProblems(criteria: unknown, acceptanceCount: number): string[] {
  if (!Array.isArray(criteria)) return [`criteria 必须是数组（验收标准 ${acceptanceCount} 条）`];
  if (criteria.length !== acceptanceCount) {
    return [`criteria 有 ${criteria.length} 条，验收标准有 ${acceptanceCount} 条`];
  }
  const problems: string[] = [];
  const seen = new Set<number>();
  criteria.forEach((raw, position) => {
    const at = `第 ${position + 1} 项`;
    if (!isRecord(raw)) {
      problems.push(`${at}不是对象`);
      return;
    }
    const unknown = Object.keys(raw).filter((key) => !CRITERION_FIELDS.includes(key as never));
    if (unknown.length > 0) {
      problems.push(`${at}含未知字段 ${unknown.join(', ')}`);
      return;
    }
    const { index, status, evidence } = raw;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > acceptanceCount) {
      problems.push(`${at}index 必须是 1..${acceptanceCount} 的整数`);
    } else if (seen.has(index)) {
      // 缺号和重复一起查：少一条下标会让后面全部错位，读出来看着"都齐了"。
      problems.push(`index ${index} 重复`);
    } else {
      seen.add(index);
    }
    if (typeof status !== 'string' || !CRITERION_STATUSES.includes(status as never)) {
      problems.push(`${at}status 必须是 ${CRITERION_STATUSES.join(' / ')} 之一`);
    }
    if (typeof evidence !== 'string') {
      problems.push(`${at}evidence 必须是字符串`);
    } else if (status === 'not_applicable' && evidence.trim() === '') {
      // 没有理由的 not_applicable 等于一句话把这条标准划掉，等于没验收。
      problems.push(`#${typeof index === 'number' ? index : position + 1} not_applicable 必须给出理由`);
    }
  });
  return problems;
}

export function validateMissionResultCriteria(criteria: unknown, acceptanceCount: number): void {
  // 历史交卷没有 criteria（那时是自由文本的 acceptanceEvidence），缺字段要能读回来。
  if (criteria === undefined) return;
  const problems = structuralProblems(criteria, acceptanceCount);
  if (problems.length > 0) {
    throw new PlatformRuleError('MISSION_RESULT_CRITERIA_INVALID', problems.join('；'));
  }
}

export function missionResultCriteriaIssues(criteria: unknown, acceptanceCount: number): string[] {
  if (criteria === undefined) {
    return [`缺少 criteria：${acceptanceCount} 条验收标准没有逐条结论`];
  }
  const problems = structuralProblems(criteria, acceptanceCount);
  if (problems.length > 0) return problems;
  const issues: string[] = [];
  (criteria as readonly Record<string, unknown>[]).forEach((raw, position) => {
    const index = typeof raw.index === 'number' ? raw.index : position + 1;
    const status = String(raw.status);
    // 闸门口径：只有 pass 和带理由的 not_applicable 算达成；缺 criteria、
    // fail、unverified 一样都不能算过——否则"没验证"会被当成"验证过了"。
    if (status === 'pass' || status === 'not_applicable') return;
    issues.push(`#${index} status=${status}：${raw.evidence === '' ? '无证据' : String(raw.evidence)}`);
  });
  return issues;
}
