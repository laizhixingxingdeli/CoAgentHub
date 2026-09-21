/**
 * VAL-001：ValidationEngine 最小竖切（command + changed-paths）。
 *
 * 守住：独立观测、不可变报告、validator authority、不接状态机/自动 accept。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import type { ReviewAuthority, ValidationReport } from '../src/kernel/index.ts';
import { FixedClock, SequentialIds } from '../src/application/in-memory.ts';
import type { WorkspaceManager } from '../src/application/workspace.ts';
import {
  VALIDATION_POLICY_REVISION,
  ValidationEngine,
  type ValidationInput,
} from '../src/application/validation/engine.ts';
import type { ChangedPathReader, CommandRunner } from '../src/application/validation/ports.ts';
import { ExecFileCommandRunner } from '../src/application/validation/exec-file-command-runner.ts';
import { WorkspaceChangedPathReader } from '../src/application/validation/workspace-changed-path-reader.ts';

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

function fakeRunner(
  impl: CommandRunner['run'],
): CommandRunner & { calls: Parameters<CommandRunner['run']>[0][] } {
  const calls: Parameters<CommandRunner['run']>[0][] = [];
  return {
    calls,
    async run(input) {
      calls.push(input);
      return impl(input);
    },
  };
}

function fakePaths(
  files: readonly string[] | (() => Promise<readonly string[]> | readonly string[]),
): ChangedPathReader & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async listChanged(input) {
      calls.push(input);
      return typeof files === 'function' ? await files() : files;
    },
  };
}

function engine(opts: {
  runner?: CommandRunner;
  paths?: ChangedPathReader;
  clock?: FixedClock;
  ids?: SequentialIds;
} = {}) {
  return new ValidationEngine({
    clock: opts.clock ?? new FixedClock('2026-06-01T12:00:00.000Z'),
    ids: opts.ids ?? new SequentialIds(),
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

describe('ValidationEngine — command checks', () => {
  test('1. command exit0 pass，记录 argv/cwd/exit/duration/outputTail', async () => {
    const runner = fakeRunner(async () => ({
      exitCode: 0,
      timedOut: false,
      durationMs: 42,
      output: 'hello-out',
    }));
    const eng = engine({ runner, paths: fakePaths([]) });
    const { report, authority } = await eng.validate(
      baseInput({
        commands: [{ argv: ['node', '-e', '1'], cwd: '/w', timeoutMs: 5000 }],
        allowedScope: [],
      }),
    );
    assert.equal(report.passed, true);
    assert.equal(report.checks.length, 2);
    const cmd = report.checks[0]!;
    assert.equal(cmd.kind, 'command');
    assert.equal(cmd.passed, true);
    assert.deepEqual(cmd.command?.argv, ['node', '-e', '1']);
    assert.equal(cmd.command?.cwd, '/w');
    assert.equal(cmd.command?.exitCode, 0);
    assert.equal(cmd.command?.durationMs, 42);
    assert.equal(cmd.command?.outputTail, 'hello-out');
    assert.equal(cmd.command?.timedOut, false);
    assert.ok(authority);
    assert.equal(authority!.kind, 'validator');
  });

  test('2. command nonzero fail，authority undefined', async () => {
    const runner = fakeRunner(async () => ({
      exitCode: 2,
      timedOut: false,
      durationMs: 3,
      output: 'err',
    }));
    const { report, authority } = await engine({ runner }).validate(
      baseInput({
        commands: [{ argv: ['tool'], cwd: '.', timeoutMs: 1000 }],
      }),
    );
    assert.equal(report.passed, false);
    assert.equal(report.checks[0]!.passed, false);
    assert.equal(report.checks[0]!.command?.exitCode, 2);
    assert.equal(authority, undefined);
  });

  test('3. timeout (timedOut=true, exitCode null) fail', async () => {
    const runner = fakeRunner(async () => ({
      exitCode: null,
      timedOut: true,
      durationMs: 1000,
      output: '',
    }));
    const { report, authority } = await engine({ runner }).validate(
      baseInput({
        commands: [{ argv: ['slow'], cwd: '.', timeoutMs: 100 }],
      }),
    );
    assert.equal(report.checks[0]!.passed, false);
    assert.equal(report.checks[0]!.command?.timedOut, true);
    assert.equal(report.checks[0]!.command?.exitCode, null);
    assert.equal(report.passed, false);
    assert.equal(authority, undefined);
  });

  test('4. runner throw fail-closed，仍返回 report', async () => {
    const runner = fakeRunner(async () => {
      throw new Error('boom-runner');
    });
    const { report, authority } = await engine({ runner }).validate(
      baseInput({
        commands: [{ argv: ['x'], cwd: '.', timeoutMs: 100 }],
      }),
    );
    assert.equal(report.passed, false);
    assert.equal(report.checks[0]!.passed, false);
    assert.match(report.checks[0]!.summary, /boom-runner/);
    assert.equal(authority, undefined);
    assert.ok(report.id);
  });

  test('5. invalid argv/shell wrapper fail 且 runner calls=0', async () => {
    const cases: readonly (readonly string[])[] = [
      [],
      ['node', ''],
      ['cmd', '/c', 'echo'],
      ['cmd.exe', '/c', 'echo'],
      ['sh', '-c', 'echo'],
      ['bash', '-c', 'echo'],
      ['powershell', '-Command', '1'],
      ['pwsh', '-Command', '1'],
    ];
    for (const argv of cases) {
      const runner = fakeRunner(async () => ({
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        output: 'should-not-run',
      }));
      const { report } = await engine({ runner }).validate(
        baseInput({ commands: [{ argv, cwd: '.', timeoutMs: 100 }] }),
      );
      assert.equal(runner.calls.length, 0, `argv=${JSON.stringify(argv)}`);
      assert.equal(report.checks[0]!.passed, false, `argv=${JSON.stringify(argv)}`);
      assert.equal(report.passed, false);
    }
  });
});

describe('ValidationEngine — changed-paths', () => {
  test('6. changed-path exact allowed pass', async () => {
    const { report, authority } = await engine({
      paths: fakePaths(['src/a.ts', 'src/b.ts']),
    }).validate(
      baseInput({
        allowedScope: ['src/a.ts', 'src/b.ts'],
        commands: [],
      }),
    );
    assert.equal(report.passed, true);
    const cp = report.checks[0]!;
    assert.equal(cp.kind, 'changed-paths');
    assert.equal(cp.passed, true);
    assert.deepEqual(cp.changedPaths?.actual, ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(cp.changedPaths?.violations, []);
    assert.ok(authority);
  });

  test('7. escape path fail + violations', async () => {
    const { report } = await engine({
      paths: fakePaths(['../secret', '/etc/passwd', 'src/ok.ts']),
    }).validate(
      baseInput({
        allowedScope: ['src/ok.ts'],
      }),
    );
    assert.equal(report.passed, false);
    const cp = report.checks[0]!;
    assert.equal(cp.passed, false);
    assert.ok(cp.changedPaths?.violations.includes('../secret'));
    assert.ok(cp.changedPaths?.violations.includes('/etc/passwd'));
    assert.ok(!cp.changedPaths?.violations.includes('src/ok.ts'));
  });

  test('8. trailing `/` directory prefix allows descendant；`src/foo` 不允许 `src/foo/a.ts`', async () => {
    const dirOk = await engine({
      paths: fakePaths(['src/foo', 'src/foo/a.ts', 'src/foo/b/c.ts']),
    }).validate(baseInput({ allowedScope: ['src/foo/'] }));
    assert.equal(dirOk.report.passed, true);

    const exactNo = await engine({
      paths: fakePaths(['src/foo/a.ts']),
    }).validate(baseInput({ allowedScope: ['src/foo'] }));
    assert.equal(exactNo.report.passed, false);
    assert.deepEqual(exactNo.report.checks[0]!.changedPaths?.violations, ['src/foo/a.ts']);

    // exact still allows the path itself
    const exactSelf = await engine({
      paths: fakePaths(['src/foo']),
    }).validate(baseInput({ allowedScope: ['src/foo'] }));
    assert.equal(exactSelf.report.passed, true);
  });

  test('9. unsupported glob `src/**` fail-closed', async () => {
    const { report, authority } = await engine({
      paths: fakePaths(['src/a.ts']),
    }).validate(baseInput({ allowedScope: ['src/**'] }));
    assert.equal(report.passed, false);
    const cp = report.checks[0]!;
    assert.equal(cp.passed, false);
    assert.deepEqual(cp.changedPaths?.unsupportedScope, ['src/**']);
    assert.equal(authority, undefined);
  });

  test('10. empty scope + no change pass；empty scope + change fail', async () => {
    const pass = await engine({ paths: fakePaths([]) }).validate(
      baseInput({ allowedScope: [] }),
    );
    assert.equal(pass.report.passed, true);
    assert.ok(pass.authority);

    const fail = await engine({ paths: fakePaths(['x.ts']) }).validate(
      baseInput({ allowedScope: [] }),
    );
    assert.equal(fail.report.passed, false);
    assert.deepEqual(fail.report.checks[0]!.changedPaths?.violations, ['x.ts']);
    assert.equal(fail.authority, undefined);
  });

  test('changed-path reader throw fail-closed', async () => {
    const paths = fakePaths(() => {
      throw new Error('diff-down');
    });
    const { report, authority } = await engine({ paths }).validate(baseInput());
    assert.equal(report.passed, false);
    assert.match(report.checks[0]!.summary, /diff-down|read failed/);
    assert.deepEqual(report.checks[0]!.changedPaths?.actual, []);
    assert.equal(authority, undefined);
  });

  test('normalize backslash, strip ./, dedupe actual stable order', async () => {
    const { report } = await engine({
      paths: fakePaths(['.\\src\\a.ts', './src/a.ts', 'src/b.ts', 'src/b.ts']),
    }).validate(
      baseInput({
        allowedScope: ['src\\a.ts', './src/b.ts'],
      }),
    );
    assert.equal(report.passed, true);
    assert.deepEqual(report.checks[0]!.changedPaths?.actual, ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(report.checks[0]!.changedPaths?.allowedScope, ['src/a.ts', 'src/b.ts']);
  });
});

describe('WorkspaceChangedPathReader', () => {
  test('11. spy：调用 workspace.diff(missionId, baseRevision, projectRoot)，使用 .files（含 untracked）', async () => {
    const diffCalls: unknown[] = [];
    const workspace = {
      async diff(missionId: string, baseRevision: string, projectRoot: string) {
        diffCalls.push({ missionId, baseRevision, projectRoot });
        return {
          stat: '1 file',
          files: ['tracked.ts', 'untracked-new.ts'],
        };
      },
    } as unknown as WorkspaceManager;

    const reader = new WorkspaceChangedPathReader(workspace);
    const files = await reader.listChanged({
      missionId: 'M-9',
      baseRevision: 'rev-base',
      projectRoot: '/root/proj',
    });
    assert.deepEqual(diffCalls, [
      { missionId: 'M-9', baseRevision: 'rev-base', projectRoot: '/root/proj' },
    ]);
    assert.deepEqual(files, ['tracked.ts', 'untracked-new.ts']);

    const { report } = await engine({ paths: reader }).validate(
      baseInput({
        missionId: 'M-9',
        baseRevision: 'rev-base',
        projectRoot: '/root/proj',
        allowedScope: ['tracked.ts', 'untracked-new.ts'],
      }),
    );
    assert.equal(report.passed, true);
    assert.deepEqual(report.checks[0]!.changedPaths?.actual, [
      'tracked.ts',
      'untracked-new.ts',
    ]);
  });
});

describe('ValidationEngine — report shape, authority, immutability', () => {
  test('12. Engine 接口无 executor changedFiles/evidence 输入', async () => {
    const engSrc = stripComments(
      readFileSync(join(srcRoot, 'application/validation/engine.ts'), 'utf8'),
    );
    const portsSrc = stripComments(
      readFileSync(join(srcRoot, 'application/validation/ports.ts'), 'utf8'),
    );
    assert.doesNotMatch(engSrc, /changedFiles/);
    assert.doesNotMatch(engSrc, /EvidenceRecord/);
    assert.doesNotMatch(portsSrc, /changedFiles/);
    assert.doesNotMatch(portsSrc, /EvidenceRecord/);
    // ValidationInput 形参字段钉死（无执行者自报通道）
    assert.match(engSrc, /interface ValidationInput/);
    assert.doesNotMatch(engSrc, /changedFiles\s*:/);
    assert.doesNotMatch(engSrc, /evidence\s*:/);
    assert.doesNotMatch(engSrc, /evidenceIds\s*:/);
  });

  test('13. report id VR-1、policyRevision=1、check order command→changed-paths、authority 引用 report id', async () => {
    const runner = fakeRunner(async () => ({
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      output: 'ok',
    }));
    const { report, authority } = await engine({
      runner,
      paths: fakePaths([]),
      ids: new SequentialIds(),
    }).validate(
      baseInput({
        commands: [
          { argv: ['a'], cwd: '.', timeoutMs: 1 },
          { argv: ['b'], cwd: '.', timeoutMs: 1 },
        ],
        allowedScope: [],
      }),
    );
    assert.equal(report.id, 'VR-1');
    assert.equal(report.policyRevision, 1);
    assert.equal(VALIDATION_POLICY_REVISION, 1);
    assert.deepEqual(
      report.checks.map((c) => c.kind),
      ['command', 'command', 'changed-paths'],
    );
    assert.equal(report.passed, true);
    assert.deepEqual(authority, {
      kind: 'validator',
      reportId: 'VR-1',
      policyRevision: 1,
    });
  });

  test('14. report/check/nested arrays frozen；调用方 mutate 输入 arrays 不影响 report', async () => {
    const allowedScope = ['src/a.ts'];
    const argv = ['node', '-e', '1'];
    const commands = [{ argv, cwd: '/w', timeoutMs: 10 }];
    const runner = fakeRunner(async () => ({
      exitCode: 0,
      timedOut: false,
      durationMs: 5,
      output: 'x'.repeat(5000),
    }));
    const { report } = await engine({
      runner,
      paths: fakePaths(['src/a.ts']),
    }).validate(baseInput({ allowedScope, commands }));

    assertFrozen(report);
    for (const check of report.checks) {
      assertFrozen(check);
      if (check.command) {
        assertFrozen(check.command);
        assertFrozen(check.command.argv);
      }
      if (check.changedPaths) {
        assertFrozen(check.changedPaths);
        assertFrozen(check.changedPaths.allowedScope);
        assertFrozen(check.changedPaths.actual);
        assertFrozen(check.changedPaths.violations);
        assertFrozen(check.changedPaths.unsupportedScope);
      }
    }

    // outputTail 截最后 4096
    assert.equal(report.checks[0]!.command!.outputTail.length, 4096);

    allowedScope.push('evil.ts');
    argv.push('--hack');
    commands.push({ argv: ['nope'], cwd: '.', timeoutMs: 1 });
    assert.deepEqual(report.checks[0]!.command!.argv, ['node', '-e', '1']);
    assert.deepEqual(report.checks[1]!.changedPaths!.allowedScope, ['src/a.ts']);
    assert.equal(report.checks.length, 2);
  });

  test('15. ReviewAuthority 类型无 executor 分支；engine 不产 coordinator authority', async () => {
    const payloads = readFileSync(join(srcRoot, 'kernel/payloads.ts'), 'utf8');
    assert.match(payloads, /export type ReviewAuthority/);
    assert.match(payloads, /kind: 'coordinator'/);
    assert.match(payloads, /kind: 'validator'/);
    assert.doesNotMatch(payloads, /kind: 'executor'/);

    const fail = await engine({
      runner: fakeRunner(async () => ({
        exitCode: 1,
        timedOut: false,
        durationMs: 1,
        output: '',
      })),
    }).validate(baseInput({ commands: [{ argv: ['t'], cwd: '.', timeoutMs: 1 }] }));
    assert.equal(fail.authority, undefined);

    const pass = await engine({ paths: fakePaths([]) }).validate(baseInput());
    assert.equal(pass.authority?.kind, 'validator');
    // 运行时对象不得出现 coordinator
    assert.notEqual(pass.authority?.kind, 'coordinator');

    // 类型层面：Extract coordinator 与 validator 互斥（编译期由 tsc/strip 保留结构）
    const sample: ReviewAuthority = {
      kind: 'validator',
      reportId: 'VR-1',
      policyRevision: 1,
    };
    assert.equal(sample.kind, 'validator');
  });

  test('16. ExecFileCommandRunner 真实 adapter pass：process.execPath -e stdout', async () => {
    const runner = new ExecFileCommandRunner();
    const result = await runner.run({
      argv: [process.execPath, '-e', "process.stdout.write('ok')"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.output, 'ok');
    assert.ok(result.durationMs >= 0);

    const { report, authority } = await engine({
      runner,
      paths: fakePaths([]),
    }).validate(
      baseInput({
        commands: [
          {
            argv: [process.execPath, '-e', "process.stdout.write('ok')"],
            cwd: process.cwd(),
            timeoutMs: 10_000,
          },
        ],
      }),
    );
    assert.equal(report.passed, true);
    assert.equal(report.checks[0]!.command?.outputTail, 'ok');
    assert.equal(authority?.kind, 'validator');
  });
});

describe('static isolation', () => {
  test('orchestrator.ts / platform.ts 无 ValidationEngine production import', () => {
    const orch = readFileSync(join(srcRoot, 'application/orchestrator.ts'), 'utf8');
    const plat = readFileSync(join(srcRoot, 'application/platform.ts'), 'utf8');
    assert.doesNotMatch(orch, /ValidationEngine/);
    assert.doesNotMatch(orch, /application\/validation/);
    assert.doesNotMatch(plat, /ValidationEngine/);
    assert.doesNotMatch(plat, /application\/validation/);
  });

  test('engine 无 ExecutionResult.changedFiles / EvidenceRecord pass dependency', () => {
    const eng = stripComments(
      readFileSync(join(srcRoot, 'application/validation/engine.ts'), 'utf8'),
    );
    const reader = stripComments(
      readFileSync(
        join(srcRoot, 'application/validation/workspace-changed-path-reader.ts'),
        'utf8',
      ),
    );
    assert.doesNotMatch(eng, /ExecutionResult/);
    assert.doesNotMatch(eng, /changedFiles/);
    assert.doesNotMatch(eng, /EvidenceRecord/);
    assert.doesNotMatch(reader, /changedFiles/);
    assert.doesNotMatch(reader, /EvidenceRecord/);
    assert.match(reader, /\.diff\(/);
    assert.match(reader, /\.files/);
  });
});

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[ \t])\/\/.*$/gm, '$1');
}

function assertFrozen(value: object): void {
  assert.ok(Object.isFrozen(value), 'expected frozen object');
}

// type-only sanity: ValidationReport is the machine conclusion
void (null as unknown as ValidationReport);
