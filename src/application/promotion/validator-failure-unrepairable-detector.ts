/**
 * DETECT-003：纯确定性 validator_failure_unrepairable 晋升触发检测。
 *
 * 只消费 trusted ValidationReport 上机器写入的 failureCode。
 * 不读 summary 文本、不碰 WorkItem/Mission/Jev/HTTP/caller flags。
 * 本模块不接线、不自动 promote、不实现 permission_expansion。
 */

import type { ValidationReport } from '../../kernel/index.ts';

/** 检测器输入：trusted ValidationEngine 产出的报告。 */
export interface ValidatorFailureUnrepairableDetectInput {
  readonly report: ValidationReport;
}

const UNREPAIRABLE_CODES = new Set(['invalid_argv', 'unsupported_scope']);

/**
 * report.passed === false 且存在 check.passed === false 且
 * failureCode 为 invalid_argv / unsupported_scope
 * → `validator_failure_unrepairable`。
 * 报告通过、检查通过、旧报告无 failureCode、普通失败 → null。
 * 不一致持久化数据（passed 与 failureCode 冲突）→ null。
 */
export function detectValidatorFailureUnrepairable(
  input: ValidatorFailureUnrepairableDetectInput,
): 'validator_failure_unrepairable' | null {
  const { report } = input;
  if (report.passed !== false) return null;
  for (const check of report.checks) {
    if (
      check.passed === false &&
      check.failureCode !== undefined &&
      UNREPAIRABLE_CODES.has(check.failureCode)
    ) {
      return 'validator_failure_unrepairable';
    }
  }
  return null;
}
