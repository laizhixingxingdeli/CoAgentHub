/**
 * ValidationReport 仓储：append-only 不可变机器事实。
 *
 * ReviewAuthority.validator.reportId 只能指向这里真实保存的报告。
 * 不提供 list / update / delete；同 id 仅允许结构完全相同的幂等 save。
 */

import { freezeDeep } from '../../kernel/index.ts';
import type { ValidationCheckResult, ValidationReport } from '../../kernel/index.ts';

export interface ValidationReportRepository {
  save(report: ValidationReport): Promise<void>;
  get(reportId: string): Promise<ValidationReport | undefined>;
}

export class ValidationReportConflictError extends Error {
  readonly code = 'VALIDATION_REPORT_CONFLICT';
  readonly reportId: string;

  constructor(reportId: string) {
    super(
      `ValidationReport ${reportId} 已存在且内容不同。` +
        '报告是 append-only 不可变事实，禁止覆盖。',
    );
    this.name = 'ValidationReportConflictError';
    this.reportId = reportId;
  }
}

/** 按已知字段重建；nested arrays 全复制并 deep-freeze。不 mutate 入参。 */
export function cloneValidationReport(report: ValidationReport): ValidationReport {
  const checks = report.checks.map(cloneCheck);
  const out: ValidationReport = {
    id: report.id,
    policyRevision: report.policyRevision,
    missionId: report.missionId,
    ...(report.workItemId !== undefined ? { workItemId: report.workItemId } : {}),
    ...(report.attemptId !== undefined ? { attemptId: report.attemptId } : {}),
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    passed: report.passed,
    checks,
  };
  return freezeDeep(out) as ValidationReport;
}

/** 结构相等；不得靠引用。顺序敏感。 */
export function validationReportsEqual(a: ValidationReport, b: ValidationReport): boolean {
  if (a === b) return true;
  if (a.id !== b.id) return false;
  if (a.policyRevision !== b.policyRevision) return false;
  if (a.missionId !== b.missionId) return false;
  if (a.workItemId !== b.workItemId) return false;
  if (a.attemptId !== b.attemptId) return false;
  if (a.startedAt !== b.startedAt) return false;
  if (a.endedAt !== b.endedAt) return false;
  if (a.passed !== b.passed) return false;
  if (a.checks.length !== b.checks.length) return false;
  for (let i = 0; i < a.checks.length; i++) {
    if (!checksEqual(a.checks[i]!, b.checks[i]!)) return false;
  }
  return true;
}

function cloneCheck(check: ValidationCheckResult): ValidationCheckResult {
  const base: ValidationCheckResult = {
    kind: check.kind,
    passed: check.passed,
    startedAt: check.startedAt,
    endedAt: check.endedAt,
    summary: check.summary,
    ...(check.failureCode !== undefined ? { failureCode: check.failureCode } : {}),
  };
  if (check.command) {
    return {
      ...base,
      command: {
        argv: [...check.command.argv],
        cwd: check.command.cwd,
        exitCode: check.command.exitCode,
        timedOut: check.command.timedOut,
        durationMs: check.command.durationMs,
        outputTail: check.command.outputTail,
      },
    };
  }
  if (check.changedPaths) {
    return {
      ...base,
      changedPaths: {
        allowedScope: [...check.changedPaths.allowedScope],
        actual: [...check.changedPaths.actual],
        violations: [...check.changedPaths.violations],
        unsupportedScope: [...check.changedPaths.unsupportedScope],
      },
    };
  }
  return base;
}

function checksEqual(a: ValidationCheckResult, b: ValidationCheckResult): boolean {
  if (a.kind !== b.kind) return false;
  if (a.passed !== b.passed) return false;
  if (a.startedAt !== b.startedAt) return false;
  if (a.endedAt !== b.endedAt) return false;
  if (a.summary !== b.summary) return false;
  if (a.failureCode !== b.failureCode) return false;

  const ac = a.command;
  const bc = b.command;
  if ((ac === undefined) !== (bc === undefined)) return false;
  if (ac && bc) {
    if (ac.cwd !== bc.cwd) return false;
    if (ac.exitCode !== bc.exitCode) return false;
    if (ac.timedOut !== bc.timedOut) return false;
    if (ac.durationMs !== bc.durationMs) return false;
    if (ac.outputTail !== bc.outputTail) return false;
    if (!stringArraysEqual(ac.argv, bc.argv)) return false;
  }

  const ap = a.changedPaths;
  const bp = b.changedPaths;
  if ((ap === undefined) !== (bp === undefined)) return false;
  if (ap && bp) {
    if (!stringArraysEqual(ap.allowedScope, bp.allowedScope)) return false;
    if (!stringArraysEqual(ap.actual, bp.actual)) return false;
    if (!stringArraysEqual(ap.violations, bp.violations)) return false;
    if (!stringArraysEqual(ap.unsupportedScope, bp.unsupportedScope)) return false;
  }
  return true;
}

function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * 内存实现。get 每次返回新 frozen deep copy；save 不 mutate/freeze caller 原对象。
 */
export class InMemoryValidationReportRepository implements ValidationReportRepository {
  #byId = new Map<string, ValidationReport>();

  async save(report: ValidationReport): Promise<void> {
    const existing = this.#byId.get(report.id);
    if (existing) {
      if (validationReportsEqual(existing, report)) return;
      throw new ValidationReportConflictError(report.id);
    }
    // 存内部 frozen clone；caller 之后改自己的对象不影响库。
    this.#byId.set(report.id, cloneValidationReport(report));
  }

  async get(reportId: string): Promise<ValidationReport | undefined> {
    const found = this.#byId.get(reportId);
    return found ? cloneValidationReport(found) : undefined;
  }
}
