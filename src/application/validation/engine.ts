/**
 * ValidationEngine — 独立于 Executor 自报的确定性验收最小竖切。
 *
 * 跑 command* + changed-paths；当 Frozen WorkOrder.validation 携带配置时
 * 追加 forbidden-paths / diff-size（VAL-002）。产出不可变 ValidationReport。
 * 全部通过时返回 validator ReviewAuthority；失败不签发权威。
 * 不接 WorkItem 状态机 / Platform / Orchestrator，不自动 accept。
 */

import { freezeDeep } from '../../kernel/index.ts';
import type {
  ReviewAuthority,
  ValidationCheckResult,
  ValidationDiffSizeUnknownDimension,
  ValidationReport,
  WorkOrderValidationDiffSize,
} from '../../kernel/index.ts';
import type { Clock, IdGenerator } from '../ports.ts';
import type { ChangedPathReader, CommandRunner, DiffFactReader } from './ports.ts';
import { redactSecrets } from '../redact.ts';

export const VALIDATION_POLICY_REVISION = 1;
export const OUTPUT_TAIL_MAX_CHARS = 4096;

const SHELL_WRAPPERS = new Set([
  'cmd',
  'cmd.exe',
  'sh',
  'bash',
  'powershell',
  'pwsh',
]);

export interface ValidationCommand {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

export interface ValidationInput {
  readonly missionId: string;
  readonly baseRevision: string;
  readonly projectRoot: string;
  readonly workItemId?: string;
  readonly attemptId?: string;
  readonly allowedScope: readonly string[];
  readonly commands: readonly ValidationCommand[];
  /** 显式 denylist；`undefined` = 检查不在 force；`[]` = 在 force 且无 forbidden。 */
  readonly forbiddenPaths?: readonly string[];
  /** 显式体积上限；`undefined` = 检查不在 force。 */
  readonly diffSize?: WorkOrderValidationDiffSize;
}

export interface ValidationEngineResult {
  readonly report: ValidationReport;
  readonly authority?: Extract<ReviewAuthority, { kind: 'validator' }>;
}

export class ValidationEngine {
  #clock: Clock;
  #ids: IdGenerator;
  #runner: CommandRunner;
  #paths: ChangedPathReader;
  #diffFacts: DiffFactReader | undefined;

  constructor(deps: {
    clock: Clock;
    ids: IdGenerator;
    commandRunner: CommandRunner;
    changedPathReader: ChangedPathReader;
    /** maxChangedLines 在 force 且缺省 reader → 该维 unknown → fail。 */
    diffFactReader?: DiffFactReader;
  }) {
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#runner = deps.commandRunner;
    this.#paths = deps.changedPathReader;
    this.#diffFacts = deps.diffFactReader;
  }

  async validate(input: ValidationInput): Promise<ValidationEngineResult> {
    const startedAt = this.#clock.now().toISOString();
    const checks: ValidationCheckResult[] = [];

    for (const command of input.commands) {
      checks.push(await this.#runCommandCheck(command));
    }
    checks.push(await this.#runChangedPathsCheck(input));

    if (input.forbiddenPaths !== undefined) {
      checks.push(await this.#runForbiddenPathsCheck(input));
    }
    if (input.diffSize !== undefined) {
      checks.push(await this.#runDiffSizeCheck(input));
    }

    const endedAt = this.#clock.now().toISOString();
    const passed = checks.every((c) => c.passed);

    const report = freezeDeep({
      id: this.#ids.next('VR'),
      policyRevision: VALIDATION_POLICY_REVISION,
      missionId: input.missionId,
      ...(input.workItemId !== undefined ? { workItemId: input.workItemId } : {}),
      ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
      startedAt,
      endedAt,
      passed,
      checks: checks.map((c) => freezeDeep(copyCheck(c))),
    }) as ValidationReport;

    let authority: Extract<ReviewAuthority, { kind: 'validator' }> | undefined;
    if (passed) {
      authority = freezeDeep({
        kind: 'validator' as const,
        reportId: report.id,
        policyRevision: VALIDATION_POLICY_REVISION,
      });
    }

    return freezeDeep({ report, ...(authority ? { authority } : {}) }) as ValidationEngineResult;
  }

  async #runCommandCheck(command: ValidationCommand): Promise<ValidationCheckResult> {
    const startedAt = this.#clock.now().toISOString();
    const argvCopy = Object.freeze([...command.argv]) as readonly string[];
    const cwd = command.cwd;

    const argvError = invalidArgvReason(argvCopy);
    if (argvError) {
      const endedAt = this.#clock.now().toISOString();
      return freezeDeep({
        kind: 'command' as const,
        passed: false,
        startedAt,
        endedAt,
        summary: argvError,
        failureCode: 'invalid_argv' as const,
        command: {
          argv: argvCopy,
          cwd,
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          outputTail: '',
        },
      });
    }

    try {
      const result = await this.#runner.run({
        argv: argvCopy,
        cwd,
        timeoutMs: command.timeoutMs,
      });
      const endedAt = this.#clock.now().toISOString();
      const passed = result.exitCode === 0 && !result.timedOut;
      // 先脱敏再截尾：截断点切在一个 key 中间时，剩下的半截对不上任何形状，就漏了。
      const outputTail = tail(redactSecrets(result.output), OUTPUT_TAIL_MAX_CHARS);
      const summary = passed
        ? `command exited 0`
        : result.timedOut
          ? `command timed out`
          : `command exited ${result.exitCode === null ? 'null' : result.exitCode}`;
      return freezeDeep({
        kind: 'command' as const,
        passed,
        startedAt,
        endedAt,
        summary,
        command: {
          argv: argvCopy,
          cwd,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          outputTail,
        },
      });
    } catch (err) {
      const endedAt = this.#clock.now().toISOString();
      const message = err instanceof Error ? err.message : String(err);
      return freezeDeep({
        kind: 'command' as const,
        passed: false,
        startedAt,
        endedAt,
        summary: `command runner failed: ${message}`,
        command: {
          argv: argvCopy,
          cwd,
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          outputTail: '',
        },
      });
    }
  }

  async #runChangedPathsCheck(input: ValidationInput): Promise<ValidationCheckResult> {
    const startedAt = this.#clock.now().toISOString();
    const allowedRaw = [...input.allowedScope];

    let actualRaw: string[] = [];
    let readError: string | undefined;
    try {
      actualRaw = [...(await this.#paths.listChanged({
        missionId: input.missionId,
        baseRevision: input.baseRevision,
        projectRoot: input.projectRoot,
      }))];
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
    }

    const endedAt = this.#clock.now().toISOString();

    if (readError) {
      return freezeDeep({
        kind: 'changed-paths' as const,
        passed: false,
        startedAt,
        endedAt,
        summary: `changed-paths read failed: ${readError}`,
        changedPaths: {
          allowedScope: Object.freeze(allowedRaw.map(normalizePath)) as readonly string[],
          actual: Object.freeze([]) as readonly string[],
          violations: Object.freeze([]) as readonly string[],
          unsupportedScope: Object.freeze([]) as readonly string[],
        },
      });
    }

    const verdict = evaluateChangedPaths(allowedRaw, actualRaw);
    return freezeDeep({
      kind: 'changed-paths' as const,
      passed: verdict.passed,
      startedAt,
      endedAt,
      summary: verdict.summary,
      ...(verdict.unsupportedScope.length > 0
        ? { failureCode: 'unsupported_scope' as const }
        : {}),
      changedPaths: {
        allowedScope: Object.freeze(verdict.allowedScope) as readonly string[],
        actual: Object.freeze(verdict.actual) as readonly string[],
        violations: Object.freeze(verdict.violations) as readonly string[],
        unsupportedScope: Object.freeze(verdict.unsupportedScope) as readonly string[],
      },
    });
  }

  async #runForbiddenPathsCheck(input: ValidationInput): Promise<ValidationCheckResult> {
    const startedAt = this.#clock.now().toISOString();
    const forbiddenRaw = [...(input.forbiddenPaths ?? [])];

    let actualRaw: string[] = [];
    let readError: string | undefined;
    try {
      actualRaw = [...(await this.#paths.listChanged({
        missionId: input.missionId,
        baseRevision: input.baseRevision,
        projectRoot: input.projectRoot,
      }))];
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
    }

    const endedAt = this.#clock.now().toISOString();

    if (readError) {
      return freezeDeep({
        kind: 'forbidden-paths' as const,
        passed: false,
        startedAt,
        endedAt,
        summary: `forbidden-paths read failed: ${readError}`,
        forbiddenPaths: {
          forbiddenScope: Object.freeze(forbiddenRaw.map(normalizePath)) as readonly string[],
          actual: Object.freeze([]) as readonly string[],
          violations: Object.freeze([]) as readonly string[],
          unsupportedScope: Object.freeze([]) as readonly string[],
        },
      });
    }

    const verdict = evaluateForbiddenPaths(forbiddenRaw, actualRaw);
    return freezeDeep({
      kind: 'forbidden-paths' as const,
      passed: verdict.passed,
      startedAt,
      endedAt,
      summary: verdict.summary,
      ...(verdict.unsupportedScope.length > 0
        ? { failureCode: 'unsupported_scope' as const }
        : {}),
      forbiddenPaths: {
        forbiddenScope: Object.freeze(verdict.forbiddenScope) as readonly string[],
        actual: Object.freeze(verdict.actual) as readonly string[],
        violations: Object.freeze(verdict.violations) as readonly string[],
        unsupportedScope: Object.freeze(verdict.unsupportedScope) as readonly string[],
      },
    });
  }

  async #runDiffSizeCheck(input: ValidationInput): Promise<ValidationCheckResult> {
    const startedAt = this.#clock.now().toISOString();
    const limitsRaw = input.diffSize!;
    const limits: {
      maxChangedFiles?: number;
      maxChangedLines?: number;
    } = {};
    if (limitsRaw.maxChangedFiles !== undefined) {
      limits.maxChangedFiles = limitsRaw.maxChangedFiles;
    }
    if (limitsRaw.maxChangedLines !== undefined) {
      limits.maxChangedLines = limitsRaw.maxChangedLines;
    }

    const used: { changedFiles?: number; changedLines?: number } = {};
    const unknown: ValidationDiffSizeUnknownDimension[] = [];

    if (limits.maxChangedFiles !== undefined) {
      try {
        const files = await this.#paths.listChanged({
          missionId: input.missionId,
          baseRevision: input.baseRevision,
          projectRoot: input.projectRoot,
        });
        used.changedFiles = files.length;
      } catch {
        unknown.push('changedFiles');
      }
    }

    if (limits.maxChangedLines !== undefined) {
      if (!this.#diffFacts) {
        unknown.push('changedLines');
      } else {
        try {
          const facts = await this.#diffFacts.measureLines({
            missionId: input.missionId,
            baseRevision: input.baseRevision,
            projectRoot: input.projectRoot,
          });
          if (
            facts.changedLines === undefined ||
            facts.unknown.includes('changedLines')
          ) {
            unknown.push('changedLines');
          } else {
            used.changedLines = facts.changedLines;
          }
        } catch {
          unknown.push('changedLines');
        }
      }
    }

    const endedAt = this.#clock.now().toISOString();

    // 上限按字面「最多」：恰好到上限算通过，超过才失败。
    //
    // 以前是 `used >= max` 失败，于是 `maxChangedFiles: 1` 实际意思是「一个文件都不许改」——
    // 写工单的人（人或协调者）没有谁会这么读。E1 实测踩中：单文件金丝雀的执行者改对了，
    // 却在这一项上被判超限，Lightweight 又没有升级出口，Mission 就停住等人。
    // 预算（budget-usage 的 compareUsage）仍是 `>=`：那是「下一步动作前」的闸，用满额度就不该
    // 再开新的一跳；这里是对已经产出的结果做事后检查，两者语义本来就不同。
    const over: string[] = [];
    if (
      limits.maxChangedFiles !== undefined &&
      used.changedFiles !== undefined &&
      used.changedFiles > limits.maxChangedFiles
    ) {
      over.push(
        `changedFiles ${used.changedFiles} > maxChangedFiles ${limits.maxChangedFiles}`,
      );
    }
    if (
      limits.maxChangedLines !== undefined &&
      used.changedLines !== undefined &&
      used.changedLines > limits.maxChangedLines
    ) {
      over.push(
        `changedLines ${used.changedLines} > maxChangedLines ${limits.maxChangedLines}`,
      );
    }

    const passed = unknown.length === 0 && over.length === 0;
    let summary: string;
    if (unknown.length > 0) {
      summary = `diff-size unknown measurement: ${unknown.join(', ')}`;
    } else if (over.length > 0) {
      summary = `diff-size exceeded: ${over.join('; ')}`;
    } else {
      const bits: string[] = [];
      if (used.changedFiles !== undefined) bits.push(`files=${used.changedFiles}`);
      if (used.changedLines !== undefined) bits.push(`lines=${used.changedLines}`);
      summary = bits.length > 0 ? `diff-size within limits (${bits.join(', ')})` : 'diff-size ok';
    }

    return freezeDeep({
      kind: 'diff-size' as const,
      passed,
      startedAt,
      endedAt,
      summary,
      diffSize: {
        limits: Object.freeze({ ...limits }),
        used: Object.freeze({ ...used }),
        unknown: Object.freeze([...unknown]) as readonly ValidationDiffSizeUnknownDimension[],
      },
    });
  }
}

function copyCheck(check: ValidationCheckResult): ValidationCheckResult {
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
        argv: Object.freeze([...check.command.argv]) as readonly string[],
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
        allowedScope: Object.freeze([...check.changedPaths.allowedScope]) as readonly string[],
        actual: Object.freeze([...check.changedPaths.actual]) as readonly string[],
        violations: Object.freeze([...check.changedPaths.violations]) as readonly string[],
        unsupportedScope: Object.freeze([
          ...check.changedPaths.unsupportedScope,
        ]) as readonly string[],
      },
    };
  }
  if (check.forbiddenPaths) {
    return {
      ...base,
      forbiddenPaths: {
        forbiddenScope: Object.freeze([
          ...check.forbiddenPaths.forbiddenScope,
        ]) as readonly string[],
        actual: Object.freeze([...check.forbiddenPaths.actual]) as readonly string[],
        violations: Object.freeze([...check.forbiddenPaths.violations]) as readonly string[],
        unsupportedScope: Object.freeze([
          ...check.forbiddenPaths.unsupportedScope,
        ]) as readonly string[],
      },
    };
  }
  if (check.diffSize) {
    return {
      ...base,
      diffSize: {
        limits: Object.freeze({ ...check.diffSize.limits }),
        used: Object.freeze({ ...check.diffSize.used }),
        unknown: Object.freeze([
          ...check.diffSize.unknown,
        ]) as readonly ValidationDiffSizeUnknownDimension[],
      },
    };
  }
  return base;
}

export function invalidArgvReason(argv: readonly string[]): string | undefined {
  if (argv.length === 0) return 'invalid argv: empty';
  if (argv.some((a) => a === '')) return 'invalid argv: empty string entry';
  const bin = argv[0]!;
  const base = bin.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  if (SHELL_WRAPPERS.has(base) || SHELL_WRAPPERS.has(bin.toLowerCase())) {
    return `invalid argv: shell wrapper "${bin}"`;
  }
  return undefined;
}

function tail(output: string, max: number): string {
  if (output.length <= max) return output;
  return output.slice(output.length - max);
}

/** 规范化路径：`\\`→`/`，去重复前导 `./`，去空白外壳。 */
export function normalizePath(raw: string): string {
  let s = raw.trim().replace(/\\/g, '/');
  while (s.startsWith('./')) {
    s = s.slice(2);
  }
  return s;
}

function isAbsoluteOrDrive(p: string): boolean {
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:(\/|$)/.test(p)) return true;
  return false;
}

/** 绝对路径或含 `..` 段 → 逃逸。 */
export function isEscapePath(p: string): boolean {
  if (isAbsoluteOrDrive(p)) return true;
  const parts = p.split('/');
  return parts.some((part) => part === '..');
}

function hasGlobMeta(p: string): boolean {
  return /[*?\[]/.test(p);
}

function dedupeStable(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * 单个 allowed 是否覆盖 actual。
 * - 普通 scope：精确匹配
 * - 以 `/` 结尾：目录前缀（目录自身 + descendants）
 */
export function scopeMatches(allowed: string, actual: string): boolean {
  if (allowed.endsWith('/')) {
    const dir = allowed.slice(0, -1);
    if (actual === dir) return true;
    if (dir === '') return !isAbsoluteOrDrive(actual) && !isEscapePath(actual);
    return actual.startsWith(`${dir}/`);
  }
  return allowed === actual;
}

function evaluateChangedPaths(
  allowedRaw: readonly string[],
  actualRaw: readonly string[],
): {
  passed: boolean;
  summary: string;
  allowedScope: string[];
  actual: string[];
  violations: string[];
  unsupportedScope: string[];
} {
  const allowedScope = allowedRaw.map(normalizePath);
  const actual = dedupeStable(actualRaw.map(normalizePath));

  const unsupportedScope: string[] = [];
  for (const a of allowedScope) {
    if (hasGlobMeta(a) || isEscapePath(a) || a === '') {
      unsupportedScope.push(a);
    }
  }

  if (unsupportedScope.length > 0) {
    return {
      passed: false,
      summary: `changed-paths unsupported scope: ${unsupportedScope.join(', ')}`,
      allowedScope,
      actual,
      violations: [],
      unsupportedScope: dedupeStable(unsupportedScope),
    };
  }

  const violations: string[] = [];
  for (const path of actual) {
    if (isEscapePath(path) || path === '') {
      violations.push(path);
      continue;
    }
    const ok = allowedScope.some((scope) => scopeMatches(scope, path));
    if (!ok) violations.push(path);
  }

  // empty allowed + empty actual => pass; empty allowed + nonempty => all actual are violations
  const passed = violations.length === 0;
  const summary = passed
    ? actual.length === 0
      ? 'changed-paths: no changes'
      : `changed-paths: ${actual.length} path(s) within scope`
    : `changed-paths violations: ${violations.join(', ')}`;

  return {
    passed,
    summary,
    allowedScope,
    actual,
    violations,
    unsupportedScope: [],
  };
}

function evaluateForbiddenPaths(
  forbiddenRaw: readonly string[],
  actualRaw: readonly string[],
): {
  passed: boolean;
  summary: string;
  forbiddenScope: string[];
  actual: string[];
  violations: string[];
  unsupportedScope: string[];
} {
  const forbiddenScope = forbiddenRaw.map(normalizePath);
  const actual = dedupeStable(actualRaw.map(normalizePath));

  const unsupportedScope: string[] = [];
  for (const a of forbiddenScope) {
    if (hasGlobMeta(a) || isEscapePath(a) || a === '') {
      unsupportedScope.push(a);
    }
  }

  if (unsupportedScope.length > 0) {
    return {
      passed: false,
      summary: `forbidden-paths unsupported scope: ${unsupportedScope.join(', ')}`,
      forbiddenScope,
      actual,
      violations: [],
      unsupportedScope: dedupeStable(unsupportedScope),
    };
  }

  const violations: string[] = [];
  for (const path of actual) {
    // 逃逸 actual 对任何 denylist 都算命中（与 changed-paths 一致：不得蒙混）。
    if (isEscapePath(path) || path === '') {
      violations.push(path);
      continue;
    }
    const hit = forbiddenScope.some((scope) => scopeMatches(scope, path));
    if (hit) violations.push(path);
  }

  const passed = violations.length === 0;
  const summary = passed
    ? actual.length === 0
      ? 'forbidden-paths: no changes'
      : `forbidden-paths: ${actual.length} path(s) clear of denylist`
    : `forbidden-paths violations: ${violations.join(', ')}`;

  return {
    passed,
    summary,
    forbiddenScope,
    actual,
    violations,
    unsupportedScope: [],
  };
}
