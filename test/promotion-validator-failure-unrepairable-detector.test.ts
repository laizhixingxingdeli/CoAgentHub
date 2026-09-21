/**
 * DETECT-003：validator_failure_unrepairable 纯检测器 + failureCode 契约。
 *
 * 守住：
 *   - 只吃 trusted ValidationReport 的 failureCode
 *   - invalid_argv / unsupported_scope 触发；其余失败与 legacy 不触发
 *   - 不读 summary；不碰 Mission/Platform/HTTP
 *   - Engine 仅在两处结构性缺陷写 failureCode
 *   - clone/equality/immutability 保留 optional failureCode
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ValidationCheckResult, ValidationReport } from '../src/kernel/index.ts';
import { freezeDeep } from '../src/kernel/index.ts';
import { FixedClock, SequentialIds } from '../src/application/in-memory.ts';
import {
  ValidationEngine,
  type ValidationInput,
} from '../src/application/validation/engine.ts';
import type { ChangedPathReader, CommandRunner } from '../src/application/validation/ports.ts';
import {
  InMemoryValidationReportRepository,
  cloneValidationReport,
  validationReportsEqual,
} from '../src/application/validation/report-repository.ts';
import { detectValidatorFailureUnrepairable } from '../src/application/promotion/validator-failure-unrepairable-detector.ts';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

function baseInput(over: Partial<ValidationInput> = {}): ValidationInput {
  return {
    missionId: 'M-1',
    baseRevision: 'abc123',
    projectRoot: '/proj',
    workItemId: 'WI-1',
    attemptId: 'AT-1',
    allowedScope: [],
    commands: [],
    ...over,
  };
}

function fakeRunner(impl: CommandRunner['run']): CommandRunner {
  return { run: impl };
}

function fakePaths(
  files: readonly string[] | (() => Promise<readonly string[]> | readonly string[]),
): ChangedPathReader {
  return {
    async listChanged() {
      return typeof files === 'function' ? await files() : files;
    },
  };
}

function engine(opts: {
  runner?: CommandRunner;
  paths?: ChangedPathReader;
} = {}) {
  return new ValidationEngine({
    clock: new FixedClock('2026-06-01T12:00:00.000Z'),
    ids: new SequentialIds(),
    commandRunner:
      opts.runner ??
      fakeRunner(async () => ({
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        output: '',
      })),
    changedPathReader: opts.paths ?? fakePaths([]),
  });
}

function checkBase(
  over: Partial<ValidationCheckResult> &
    Pick<ValidationCheckResult, 'kind' | 'passed' | 'summary'>,
): ValidationCheckResult {
  return {
    startedAt: '2026-06-01T12:00:00.000Z',
    endedAt: '2026-06-01T12:00:00.500Z',
    ...over,
  };
}

function reportOf(
  checks: readonly ValidationCheckResult[],
  over: Partial<ValidationReport> = {},
): ValidationReport {
  return freezeDeep({
    id: 'VR-1',
    policyRevision: 1,
    missionId: 'M-1',
    startedAt: '2026-06-01T12:00:00.000Z',
    endedAt: '2026-06-01T12:00:01.000Z',
    passed: checks.every((c) => c.passed),
    checks,
    ...over,
  }) as ValidationReport;
}

describe('detectValidatorFailureUnrepairable', () => {
  test('invalid_argv failureCode => validator_failure_unrepairable', () => {
    const report = reportOf([
      checkBase({
        kind: 'command',
        passed: false,
        summary: 'invalid argv: empty',
        failureCode: 'invalid_argv',
        command: {
          argv: [],
          cwd: '.',
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          outputTail: '',
        },
      }),
    ]);
    assert.equal(
      detectValidatorFailureUnrepairable({ report }),
      'validator_failure_unrepairable',
    );
  });

  test('unsupported_scope failureCode => validator_failure_unrepairable', () => {
    const report = reportOf([
      checkBase({
        kind: 'changed-paths',
        passed: false,
        summary: 'changed-paths unsupported scope: src/**',
        failureCode: 'unsupported_scope',
        changedPaths: {
          allowedScope: ['src/**'],
          actual: [],
          violations: [],
          unsupportedScope: ['src/**'],
        },
      }),
    ]);
    assert.equal(
      detectValidatorFailureUnrepairable({ report }),
      'validator_failure_unrepairable',
    );
  });

  test('timeout / nonzero / runner failure => no trigger', () => {
    const timeout = reportOf([
      checkBase({
        kind: 'command',
        passed: false,
        summary: 'command timed out',
        command: {
          argv: ['slow'],
          cwd: '.',
          exitCode: null,
          timedOut: true,
          durationMs: 1000,
          outputTail: '',
        },
      }),
    ]);
    const nonzero = reportOf([
      checkBase({
        kind: 'command',
        passed: false,
        summary: 'command exited 2',
        command: {
          argv: ['tool'],
          cwd: '.',
          exitCode: 2,
          timedOut: false,
          durationMs: 3,
          outputTail: 'err',
        },
      }),
    ]);
    const runnerFail = reportOf([
      checkBase({
        kind: 'command',
        passed: false,
        summary: 'command runner failed: boom-runner',
        command: {
          argv: ['x'],
          cwd: '.',
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          outputTail: '',
        },
      }),
    ]);
    assert.equal(detectValidatorFailureUnrepairable({ report: timeout }), null);
    assert.equal(detectValidatorFailureUnrepairable({ report: nonzero }), null);
    assert.equal(detectValidatorFailureUnrepairable({ report: runnerFail }), null);
  });

  test('changed-path violations / read failure => no trigger', () => {
    const violations = reportOf([
      checkBase({
        kind: 'changed-paths',
        passed: false,
        summary: 'changed-paths violations: evil.ts',
        changedPaths: {
          allowedScope: ['src/'],
          actual: ['evil.ts'],
          violations: ['evil.ts'],
          unsupportedScope: [],
        },
      }),
    ]);
    const readFail = reportOf([
      checkBase({
        kind: 'changed-paths',
        passed: false,
        summary: 'changed-paths read failed: diff-down',
        changedPaths: {
          allowedScope: [],
          actual: [],
          violations: [],
          unsupportedScope: [],
        },
      }),
    ]);
    assert.equal(detectValidatorFailureUnrepairable({ report: violations }), null);
    assert.equal(detectValidatorFailureUnrepairable({ report: readFail }), null);
  });

  test('legacy failed report without failureCode => no trigger', () => {
    const legacy = reportOf([
      checkBase({
        kind: 'command',
        passed: false,
        summary: 'invalid argv: shell wrapper "bash"',
        command: {
          argv: ['bash', '-c', 'echo'],
          cwd: '.',
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          outputTail: '',
        },
      }),
      checkBase({
        kind: 'changed-paths',
        passed: false,
        summary: 'changed-paths unsupported scope: src/**',
        changedPaths: {
          allowedScope: ['src/**'],
          actual: [],
          violations: [],
          unsupportedScope: ['src/**'],
        },
      }),
    ]);
    assert.equal(legacy.checks[0]!.failureCode, undefined);
    assert.equal(legacy.checks[1]!.failureCode, undefined);
    assert.equal(detectValidatorFailureUnrepairable({ report: legacy }), null);
  });

  test('passed report cannot trigger even with malformed caller-like prose', () => {
    const passed = reportOf([
      checkBase({
        kind: 'command',
        passed: true,
        summary: 'invalid argv: empty; unsupported_scope; validator_failure_unrepairable',
        command: {
          argv: ['node', '-e', '1'],
          cwd: '.',
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
          outputTail: 'permission_expansion invalid_argv unsupported_scope',
        },
      }),
      checkBase({
        kind: 'changed-paths',
        passed: true,
        summary: 'changed-paths: no changes',
        changedPaths: {
          allowedScope: [],
          actual: [],
          violations: [],
          unsupportedScope: [],
        },
      }),
    ]);
    assert.equal(passed.passed, true);
    assert.equal(detectValidatorFailureUnrepairable({ report: passed }), null);
  });

  test('不读 summary：summary 仿写 unrepairable 文案但无 failureCode => null', () => {
    const bait = reportOf([
      checkBase({
        kind: 'command',
        passed: false,
        summary: 'validator_failure_unrepairable invalid_argv unsupported_scope',
      }),
    ]);
    assert.equal(detectValidatorFailureUnrepairable({ report: bait }), null);
  });

  test('inconsistent: report.passed=true + failed check + invalid_argv => null', () => {
    const report = reportOf(
      [
        checkBase({
          kind: 'command',
          passed: false,
          summary: 'invalid argv: empty',
          failureCode: 'invalid_argv',
          command: {
            argv: [],
            cwd: '.',
            exitCode: null,
            timedOut: false,
            durationMs: 0,
            outputTail: '',
          },
        }),
      ],
      { passed: true },
    );
    assert.equal(report.passed, true);
    assert.equal(report.checks[0]!.passed, false);
    assert.equal(report.checks[0]!.failureCode, 'invalid_argv');
    assert.equal(detectValidatorFailureUnrepairable({ report }), null);
  });

  test('inconsistent: report.passed=false + check.passed=true + invalid_argv => null', () => {
    const report = reportOf(
      [
        checkBase({
          kind: 'command',
          passed: true,
          summary: 'ok but stamped invalid_argv',
          failureCode: 'invalid_argv',
          command: {
            argv: ['node', '-e', '1'],
            cwd: '.',
            exitCode: 0,
            timedOut: false,
            durationMs: 1,
            outputTail: '',
          },
        }),
      ],
      { passed: false },
    );
    assert.equal(report.passed, false);
    assert.equal(report.checks[0]!.passed, true);
    assert.equal(report.checks[0]!.failureCode, 'invalid_argv');
    assert.equal(detectValidatorFailureUnrepairable({ report }), null);
  });
});

describe('ValidationEngine failureCode emission', () => {
  test('invalid argv => failureCode invalid_argv；detector 触发', async () => {
    const { report, authority } = await engine().validate(
      baseInput({ commands: [{ argv: ['bash', '-c', 'echo'], cwd: '.', timeoutMs: 100 }] }),
    );
    assert.equal(report.passed, false);
    assert.equal(authority, undefined);
    const cmd = report.checks[0]!;
    assert.equal(cmd.failureCode, 'invalid_argv');
    assert.equal(report.checks[1]!.failureCode, undefined);
    assert.equal(
      detectValidatorFailureUnrepairable({ report }),
      'validator_failure_unrepairable',
    );
  });

  test('unsupported scope => failureCode unsupported_scope；detector 触发', async () => {
    const { report } = await engine({
      paths: fakePaths(['src/a.ts']),
    }).validate(baseInput({ allowedScope: ['src/**'] }));
    assert.equal(report.passed, false);
    const cp = report.checks[0]!;
    assert.equal(cp.failureCode, 'unsupported_scope');
    assert.equal(
      detectValidatorFailureUnrepairable({ report }),
      'validator_failure_unrepairable',
    );
  });

  test('timeout/nonzero/runner/violations/read fail 不写 failureCode', async () => {
    const timeout = await engine({
      runner: fakeRunner(async () => ({
        exitCode: null,
        timedOut: true,
        durationMs: 1000,
        output: '',
      })),
    }).validate(baseInput({ commands: [{ argv: ['slow'], cwd: '.', timeoutMs: 100 }] }));
    assert.equal(timeout.report.checks[0]!.failureCode, undefined);
    assert.equal(detectValidatorFailureUnrepairable({ report: timeout.report }), null);

    const nonzero = await engine({
      runner: fakeRunner(async () => ({
        exitCode: 2,
        timedOut: false,
        durationMs: 3,
        output: 'err',
      })),
    }).validate(baseInput({ commands: [{ argv: ['tool'], cwd: '.', timeoutMs: 100 }] }));
    assert.equal(nonzero.report.checks[0]!.failureCode, undefined);
    assert.equal(detectValidatorFailureUnrepairable({ report: nonzero.report }), null);

    const runnerFail = await engine({
      runner: fakeRunner(async () => {
        throw new Error('boom-runner');
      }),
    }).validate(baseInput({ commands: [{ argv: ['x'], cwd: '.', timeoutMs: 100 }] }));
    assert.equal(runnerFail.report.checks[0]!.failureCode, undefined);
    assert.equal(detectValidatorFailureUnrepairable({ report: runnerFail.report }), null);

    const violations = await engine({
      paths: fakePaths(['evil.ts']),
    }).validate(baseInput({ allowedScope: ['src/ok.ts'] }));
    assert.equal(violations.report.checks[0]!.failureCode, undefined);
    assert.equal(detectValidatorFailureUnrepairable({ report: violations.report }), null);

    const readFail = await engine({
      paths: fakePaths(() => {
        throw new Error('diff-down');
      }),
    }).validate(baseInput());
    assert.equal(readFail.report.checks[0]!.failureCode, undefined);
    assert.equal(detectValidatorFailureUnrepairable({ report: readFail.report }), null);
  });

  test('passed checks 不写 failureCode', async () => {
    const { report } = await engine({
      runner: fakeRunner(async () => ({
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        output: 'ok',
      })),
      paths: fakePaths(['src/a.ts']),
    }).validate(
      baseInput({
        commands: [{ argv: ['node', '-e', '1'], cwd: '.', timeoutMs: 100 }],
        allowedScope: ['src/a.ts'],
      }),
    );
    assert.equal(report.passed, true);
    for (const c of report.checks) {
      assert.equal(c.failureCode, undefined);
    }
    assert.equal(detectValidatorFailureUnrepairable({ report }), null);
  });
});

describe('failureCode clone / equality / immutability', () => {
  test('repository clone/equality roundtrip preserves optional failureCode', async () => {
    const withCode = reportOf([
      checkBase({
        kind: 'command',
        passed: false,
        summary: 'invalid argv: empty',
        failureCode: 'invalid_argv',
        command: {
          argv: [],
          cwd: '.',
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          outputTail: '',
        },
      }),
      checkBase({
        kind: 'changed-paths',
        passed: false,
        summary: 'changed-paths unsupported scope: **',
        failureCode: 'unsupported_scope',
        changedPaths: {
          allowedScope: ['**'],
          actual: [],
          violations: [],
          unsupportedScope: ['**'],
        },
      }),
    ]);

    const cloned = cloneValidationReport(withCode);
    assert.notEqual(cloned, withCode);
    assert.notEqual(cloned.checks, withCode.checks);
    assert.equal(cloned.checks[0]!.failureCode, 'invalid_argv');
    assert.equal(cloned.checks[1]!.failureCode, 'unsupported_scope');
    assert.ok(validationReportsEqual(cloned, withCode));

    const without = reportOf([
      checkBase({
        kind: 'command',
        passed: false,
        summary: 'command exited 1',
        command: {
          argv: ['t'],
          cwd: '.',
          exitCode: 1,
          timedOut: false,
          durationMs: 1,
          outputTail: '',
        },
      }),
    ]);
    assert.equal(cloneValidationReport(without).checks[0]!.failureCode, undefined);
    assert.ok(validationReportsEqual(cloneValidationReport(without), without));
    assert.equal(validationReportsEqual(withCode, without), false);

    // failureCode 不同 → 不相等
    const otherCode = cloneValidationReport(withCode);
    const mutatedChecks = otherCode.checks.map((c, i) =>
      i === 0 ? { ...c, failureCode: 'unsupported_scope' as const } : { ...c },
    );
    const different = freezeDeep({
      ...otherCode,
      checks: mutatedChecks,
    }) as ValidationReport;
    assert.equal(validationReportsEqual(withCode, different), false);

    const repo = new InMemoryValidationReportRepository();
    await repo.save(withCode);
    const got = await repo.get('VR-1');
    assert.ok(got);
    assert.equal(got.checks[0]!.failureCode, 'invalid_argv');
    assert.equal(got.checks[1]!.failureCode, 'unsupported_scope');
    assert.ok(validationReportsEqual(got, withCode));
    assert.ok(Object.isFrozen(got));
    assert.ok(Object.isFrozen(got.checks[0]));
  });

  test('input/report remains immutable/copy-safe under detector', () => {
    const report = reportOf([
      checkBase({
        kind: 'command',
        passed: false,
        summary: 'invalid argv: empty',
        failureCode: 'invalid_argv',
      }),
    ]);
    const before = JSON.stringify(report);
    assert.equal(
      detectValidatorFailureUnrepairable({ report }),
      'validator_failure_unrepairable',
    );
    assert.equal(JSON.stringify(report), before);
    assert.ok(Object.isFrozen(report));
    assert.ok(Object.isFrozen(report.checks));
    assert.ok(Object.isFrozen(report.checks[0]));
  });
});

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('DETECT-003 static isolation', () => {
  test('detector 不读 summary / 无 Platform wiring / 无 permission_expansion', () => {
    const det = stripComments(
      readFileSync(
        join(srcRoot, 'application/promotion/validator-failure-unrepairable-detector.ts'),
        'utf8',
      ),
    );
    assert.doesNotMatch(det, /\.summary/);
    assert.doesNotMatch(det, /permission_expansion/);
    assert.doesNotMatch(det, /Platform|Orchestrator|WorkItem|Mission|Jev|HTTP/);
    assert.match(det, /failureCode/);
    assert.match(det, /validator_failure_unrepairable/);
  });

  test('engine 仅在 invalidArgv / unsupportedScope 写 failureCode', () => {
    const eng = readFileSync(join(srcRoot, 'application/validation/engine.ts'), 'utf8');
    const matches = eng.match(/failureCode/g) ?? [];
    // copyCheck 透传 + invalid_argv 写入 + unsupported_scope 写入
    assert.ok(matches.length >= 3);
    assert.match(eng, /failureCode:\s*'invalid_argv'/);
    assert.match(eng, /failureCode:\s*'unsupported_scope'/);
    // 不得在 timeout/runner catch 路径旁出现额外字面量
    assert.equal((eng.match(/failureCode:\s*'/g) ?? []).length, 2);
  });
});
