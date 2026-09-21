/**
 * ValidationEngine — 独立于 Executor 自报的确定性验收最小竖切。
 *
 * 只做 command + changed-paths；产出不可变 ValidationReport。
 * 全部通过时返回 validator ReviewAuthority；失败不签发权威。
 * 不接 WorkItem 状态机 / Platform / Orchestrator，不自动 accept。
 */

import { freezeDeep } from '../../kernel/index.ts';
import type {
  ReviewAuthority,
  ValidationCheckResult,
  ValidationReport,
} from '../../kernel/index.ts';
import type { Clock, IdGenerator } from '../ports.ts';
import type { ChangedPathReader, CommandRunner } from './ports.ts';

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

  constructor(deps: {
    clock: Clock;
    ids: IdGenerator;
    commandRunner: CommandRunner;
    changedPathReader: ChangedPathReader;
  }) {
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#runner = deps.commandRunner;
    this.#paths = deps.changedPathReader;
  }

  async validate(input: ValidationInput): Promise<ValidationEngineResult> {
    const startedAt = this.#clock.now().toISOString();
    const checks: ValidationCheckResult[] = [];

    for (const command of input.commands) {
      checks.push(await this.#runCommandCheck(command));
    }
    checks.push(await this.#runChangedPathsCheck(input));

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
      const outputTail = tail(result.output, OUTPUT_TAIL_MAX_CHARS);
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
      changedPaths: {
        allowedScope: Object.freeze(verdict.allowedScope) as readonly string[],
        actual: Object.freeze(verdict.actual) as readonly string[],
        violations: Object.freeze(verdict.violations) as readonly string[],
        unsupportedScope: Object.freeze(verdict.unsupportedScope) as readonly string[],
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
  return base;
}

function invalidArgvReason(argv: readonly string[]): string | undefined {
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
