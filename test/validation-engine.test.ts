/**
 * VAL-001：ValidationEngine 最小竖切（command + changed-paths）。
 *
 * 守住：独立观测、不可变报告、validator authority、不接状态机/自动 accept。
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import type { ReviewAuthority, ValidationReport } from '../src/kernel/index.ts';
import { FixedClock, SequentialIds } from '../src/application/in-memory.ts';
import type { WorkspaceManager } from '../src/application/workspace.ts';
import {
  VALIDATION_POLICY_REVISION,
  ValidationEngine,
  type ValidationInput,
} from '../src/application/validation/engine.ts';
import type {
  ChangedPathReader,
  CommandRunner,
  DiffFactReader,
  DiffLineFacts,
} from '../src/application/validation/ports.ts';
import { ExecFileCommandRunner } from '../src/application/validation/exec-file-command-runner.ts';
import { WorkspaceChangedPathReader } from '../src/application/validation/workspace-changed-path-reader.ts';
import {
  countTextLines,
  WorkspaceDiffFactReader,
} from '../src/application/validation/workspace-diff-fact-reader.ts';

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

function fakeDiffFacts(
  facts: DiffLineFacts | (() => Promise<DiffLineFacts> | DiffLineFacts),
): DiffFactReader & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async measureLines(input) {
      calls.push(input);
      return typeof facts === 'function' ? await facts() : facts;
    },
  };
}

function engine(opts: {
  runner?: CommandRunner;
  paths?: ChangedPathReader;
  diffFacts?: DiffFactReader;
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
    ...(opts.diffFacts ? { diffFactReader: opts.diffFacts } : {}),
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
  test('12. Engine 接口无 executor self-report / Evidence 输入', async () => {
    const engSrc = stripComments(
      readFileSync(join(srcRoot, 'application/validation/engine.ts'), 'utf8'),
    );
    const portsSrc = stripComments(
      readFileSync(join(srcRoot, 'application/validation/ports.ts'), 'utf8'),
    );
    assert.doesNotMatch(engSrc, /EvidenceRecord/);
    assert.doesNotMatch(engSrc, /ExecutionResult/);
    assert.doesNotMatch(portsSrc, /EvidenceRecord/);
    assert.doesNotMatch(portsSrc, /ExecutionResult/);
    // ValidationInput 形参字段钉死（无执行者自报通道；diff-size 的 used.changedFiles 是计量维度名）
    assert.match(engSrc, /interface ValidationInput/);
    assert.doesNotMatch(engSrc, /evidence\s*:/);
    assert.doesNotMatch(engSrc, /evidenceIds\s*:/);
    assert.doesNotMatch(engSrc, /readonly changedFiles\s*:/);
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

  test('engine 无 ExecutionResult / EvidenceRecord pass dependency', () => {
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
    assert.doesNotMatch(eng, /EvidenceRecord/);
    assert.doesNotMatch(reader, /EvidenceRecord/);
    assert.doesNotMatch(reader, /ExecutionResult/);
    assert.match(reader, /\.diff\(/);
    assert.match(reader, /\.files/);
  });
});

describe('ValidationEngine — forbidden-paths (VAL-002)', () => {
  test('omitted → no forbidden-paths check; empty allow + empty actual still authority', async () => {
    const { report, authority } = await engine({ paths: fakePaths([]) }).validate(baseInput());
    assert.equal(report.passed, true);
    assert.ok(authority);
    assert.deepEqual(
      report.checks.map((c) => c.kind),
      ['changed-paths'],
    );
  });

  test('[] in force + dirty tree → pass (if allow ok)', async () => {
    const { report, authority } = await engine({
      paths: fakePaths(['src/a.ts']),
    }).validate(
      baseInput({
        allowedScope: ['src/a.ts'],
        forbiddenPaths: [],
      }),
    );
    assert.equal(report.passed, true);
    assert.ok(authority);
    assert.equal(report.checks.map((c) => c.kind).includes('forbidden-paths'), true);
    const fp = report.checks.find((c) => c.kind === 'forbidden-paths')!;
    assert.equal(fp.passed, true);
    assert.deepEqual(fp.forbiddenPaths?.violations, []);
  });

  test('exact deny hit → fail, violation listed, no authority', async () => {
    const { report, authority } = await engine({
      paths: fakePaths(['src/a.ts', 'src/secret.ts']),
    }).validate(
      baseInput({
        allowedScope: ['src/'],
        forbiddenPaths: ['src/secret.ts'],
      }),
    );
    assert.equal(report.passed, false);
    assert.equal(authority, undefined);
    const fp = report.checks.find((c) => c.kind === 'forbidden-paths')!;
    assert.equal(fp.passed, false);
    assert.deepEqual(fp.forbiddenPaths?.violations, ['src/secret.ts']);
    assert.equal(fp.failureCode, undefined);
  });

  test('prefix src/secret/ denies descendants; src/secret does not deny src/secret/a.ts', async () => {
    const dirHit = await engine({
      paths: fakePaths(['src/secret/a.ts']),
    }).validate(
      baseInput({
        allowedScope: ['src/'],
        forbiddenPaths: ['src/secret/'],
      }),
    );
    assert.equal(dirHit.report.passed, false);
    assert.deepEqual(
      dirHit.report.checks.find((c) => c.kind === 'forbidden-paths')!.forbiddenPaths?.violations,
      ['src/secret/a.ts'],
    );

    const exactMiss = await engine({
      paths: fakePaths(['src/secret/a.ts']),
    }).validate(
      baseInput({
        allowedScope: ['src/'],
        forbiddenPaths: ['src/secret'],
      }),
    );
    assert.equal(exactMiss.report.passed, true);
    assert.ok(exactMiss.authority);
  });

  test('deny ∩ allow → forbidden fails (deny wins)', async () => {
    const { report, authority } = await engine({
      paths: fakePaths(['src/a.ts']),
    }).validate(
      baseInput({
        allowedScope: ['src/a.ts'],
        forbiddenPaths: ['src/a.ts'],
      }),
    );
    const cp = report.checks.find((c) => c.kind === 'changed-paths')!;
    const fp = report.checks.find((c) => c.kind === 'forbidden-paths')!;
    assert.equal(cp.passed, true);
    assert.equal(fp.passed, false);
    assert.equal(report.passed, false);
    assert.equal(authority, undefined);
  });

  test('glob / escape / empty string in denylist → unsupported_scope fail-closed', async () => {
    for (const bad of ['src/**', '../x', ''] as const) {
      // '' cannot arrive via freeze; engine still handles raw input
      const forbiddenPaths = bad === '' ? [''] : [bad];
      const { report, authority } = await engine({
        paths: fakePaths(['src/a.ts']),
      }).validate(
        baseInput({
          allowedScope: ['src/'],
          forbiddenPaths,
        }),
      );
      assert.equal(report.passed, false, bad);
      assert.equal(authority, undefined, bad);
      const fp = report.checks.find((c) => c.kind === 'forbidden-paths')!;
      assert.equal(fp.failureCode, 'unsupported_scope', bad);
      assert.ok(fp.forbiddenPaths!.unsupportedScope.length > 0, bad);
    }
  });

  test('escape actual vs deny → violation', async () => {
    const { report } = await engine({
      paths: fakePaths(['../secret']),
    }).validate(
      baseInput({
        allowedScope: ['src/'],
        forbiddenPaths: ['src/x.ts'],
      }),
    );
    // changed-paths also fails; forbidden still lists escape as violation
    const fp = report.checks.find((c) => c.kind === 'forbidden-paths')!;
    assert.equal(fp.passed, false);
    assert.ok(fp.forbiddenPaths?.violations.includes('../secret'));
  });

  test('reader throw → fail-closed', async () => {
    const paths = fakePaths(() => {
      throw new Error('deny-diff-down');
    });
    const { report, authority } = await engine({ paths }).validate(
      baseInput({ forbiddenPaths: ['src/x.ts'] }),
    );
    assert.equal(report.passed, false);
    assert.equal(authority, undefined);
    const fp = report.checks.find((c) => c.kind === 'forbidden-paths')!;
    assert.equal(fp.passed, false);
    assert.match(fp.summary, /deny-diff-down|read failed/);
    assert.deepEqual(fp.forbiddenPaths?.actual, []);
  });

  test('normalize \\ / ./ , stable dedupe; input mutation does not leak', async () => {
    const forbiddenPaths = ['.\\src\\secret.ts', './src/secret.ts'];
    const { report } = await engine({
      paths: fakePaths(['src/secret.ts', '.\\src\\secret.ts']),
    }).validate(
      baseInput({
        allowedScope: ['src/'],
        forbiddenPaths,
      }),
    );
    const fp = report.checks.find((c) => c.kind === 'forbidden-paths')!;
    assert.deepEqual(fp.forbiddenPaths?.actual, ['src/secret.ts']);
    assert.deepEqual(fp.forbiddenPaths?.forbiddenScope, ['src/secret.ts', 'src/secret.ts']);
    assert.deepEqual(fp.forbiddenPaths?.violations, ['src/secret.ts']);
    assertFrozen(fp);
    assertFrozen(fp.forbiddenPaths!);
    assertFrozen(fp.forbiddenPaths!.violations);
    forbiddenPaths.push('evil');
    assert.equal(fp.forbiddenPaths!.forbiddenScope.includes('evil'), false);
  });

  test('check order command → changed-paths → forbidden-paths', async () => {
    const { report } = await engine({
      paths: fakePaths([]),
    }).validate(
      baseInput({
        commands: [{ argv: ['t'], cwd: '.', timeoutMs: 1 }],
        forbiddenPaths: [],
      }),
    );
    assert.deepEqual(
      report.checks.map((c) => c.kind),
      ['command', 'changed-paths', 'forbidden-paths'],
    );
  });
});

describe('ValidationEngine — diff-size (VAL-002)', () => {
  test('omitted → no diff-size check; VAL-001 pass unchanged', async () => {
    const { report, authority } = await engine({ paths: fakePaths([]) }).validate(baseInput());
    assert.equal(report.passed, true);
    assert.ok(authority);
    assert.equal(report.checks.some((c) => c.kind === 'diff-size'), false);
  });

  test('maxChangedFiles 按「最多」：恰好到上限通过，多一个就失败', async () => {
    // E1 实测的形状：单文件金丝雀 maxChangedFiles: 1、改了 1 个文件，旧语义（>=）判它超限。
    const atLimit = await engine({ paths: fakePaths(['a.ts']) }).validate(
      baseInput({ allowedScope: ['a.ts'], diffSize: { maxChangedFiles: 1 } }),
    );
    assert.equal(atLimit.report.passed, true);
    assert.ok(atLimit.authority);
    const dsAt = atLimit.report.checks.find((c) => c.kind === 'diff-size')!;
    assert.equal(dsAt.passed, true);
    assert.equal(dsAt.diffSize?.used.changedFiles, 1);

    const over = await engine({ paths: fakePaths(['a.ts', 'b.ts']) }).validate(
      baseInput({
        allowedScope: ['a.ts', 'b.ts'],
        diffSize: { maxChangedFiles: 1 },
      }),
    );
    assert.equal(over.report.passed, false);
    assert.equal(over.authority, undefined);
    const dsOver = over.report.checks.find((c) => c.kind === 'diff-size')!;
    assert.equal(dsOver.passed, false);
    assert.equal(dsOver.failureCode, undefined);
    assert.equal(dsOver.diffSize?.used.changedFiles, 2);
    assert.equal(dsOver.summary, 'diff-size exceeded: changedFiles 2 > maxChangedFiles 1');
  });

  test('maxChangedFiles: 0 就是一个都不许改：零改动通过，改一个就失败', async () => {
    const none = await engine({ paths: fakePaths([]) }).validate(
      baseInput({ diffSize: { maxChangedFiles: 0 } }),
    );
    assert.equal(none.report.passed, true);
    assert.ok(none.authority);
    const dsNone = none.report.checks.find((c) => c.kind === 'diff-size')!;
    assert.equal(dsNone.passed, true);
    assert.equal(dsNone.diffSize?.used.changedFiles, 0);
    assert.deepEqual(dsNone.diffSize?.unknown, []);

    const one = await engine({ paths: fakePaths(['a.ts']) }).validate(
      baseInput({ allowedScope: ['a.ts'], diffSize: { maxChangedFiles: 0 } }),
    );
    assert.equal(one.report.passed, false);
    assert.equal(one.authority, undefined);
    const dsOne = one.report.checks.find((c) => c.kind === 'diff-size')!;
    assert.equal(dsOne.passed, false);
    assert.equal(dsOne.diffSize?.used.changedFiles, 1);
  });

  test('maxChangedLines known under/at/over', async () => {
    const under = await engine({
      paths: fakePaths(['a.ts']),
      diffFacts: fakeDiffFacts({ changedLines: 3, unknown: [] }),
    }).validate(
      baseInput({
        allowedScope: ['a.ts'],
        diffSize: { maxChangedLines: 5 },
      }),
    );
    assert.equal(under.report.passed, true);

    const at = await engine({
      paths: fakePaths(['a.ts']),
      diffFacts: fakeDiffFacts({ changedLines: 5, unknown: [] }),
    }).validate(
      baseInput({
        allowedScope: ['a.ts'],
        diffSize: { maxChangedLines: 5 },
      }),
    );
    assert.equal(at.report.passed, true, '恰好 5 行、上限 5：最多 5 行，通过');

    const over = await engine({
      paths: fakePaths(['a.ts']),
      diffFacts: fakeDiffFacts({ changedLines: 6, unknown: [] }),
    }).validate(
      baseInput({
        allowedScope: ['a.ts'],
        diffSize: { maxChangedLines: 5 },
      }),
    );
    assert.equal(over.report.passed, false, '多一行就失败');
    const dsOver = over.report.checks.find((c) => c.kind === 'diff-size')!;
    assert.equal(dsOver.summary, 'diff-size exceeded: changedLines 6 > maxChangedLines 5');
  });

  test('line limit in force + missing reader / unknown facts → fail', async () => {
    const noReader = await engine({ paths: fakePaths(['a.ts']) }).validate(
      baseInput({
        allowedScope: ['a.ts'],
        diffSize: { maxChangedLines: 10 },
      }),
    );
    assert.equal(noReader.report.passed, false);
    const ds1 = noReader.report.checks.find((c) => c.kind === 'diff-size')!;
    assert.equal(ds1.diffSize?.used.changedLines, undefined);
    assert.deepEqual(ds1.diffSize?.unknown, ['changedLines']);

    const unknownFacts = await engine({
      paths: fakePaths(['a.ts']),
      diffFacts: fakeDiffFacts({ unknown: ['changedLines'] }),
    }).validate(
      baseInput({
        allowedScope: ['a.ts'],
        diffSize: { maxChangedLines: 10 },
      }),
    );
    assert.equal(unknownFacts.report.passed, false);
    const ds2 = unknownFacts.report.checks.find((c) => c.kind === 'diff-size')!;
    assert.equal(ds2.diffSize?.used.changedLines, undefined);
    assert.deepEqual(ds2.diffSize?.unknown, ['changedLines']);
  });

  test('untracked included in file count; check order ends with diff-size', async () => {
    const { report } = await engine({
      paths: fakePaths(['tracked.ts', 'new-untracked.ts']),
      diffFacts: fakeDiffFacts({ changedLines: 2, unknown: [] }),
    }).validate(
      baseInput({
        allowedScope: ['tracked.ts', 'new-untracked.ts'],
        commands: [{ argv: ['t'], cwd: '.', timeoutMs: 1 }],
        forbiddenPaths: [],
        diffSize: { maxChangedFiles: 10, maxChangedLines: 10 },
      }),
    );
    assert.deepEqual(
      report.checks.map((c) => c.kind),
      ['command', 'changed-paths', 'forbidden-paths', 'diff-size'],
    );
    const ds = report.checks.find((c) => c.kind === 'diff-size')!;
    assert.equal(ds.diffSize?.used.changedFiles, 2);
    assert.equal(report.passed, true);
  });

  test('nested freeze; input mutation does not leak into report', async () => {
    const diffSize = { maxChangedFiles: 5, maxChangedLines: 100 };
    const { report } = await engine({
      paths: fakePaths(['a.ts']),
      diffFacts: fakeDiffFacts({ changedLines: 1, unknown: [] }),
    }).validate(baseInput({ allowedScope: ['a.ts'], diffSize }));
    const ds = report.checks.find((c) => c.kind === 'diff-size')!;
    assertFrozen(ds);
    assertFrozen(ds.diffSize!);
    assertFrozen(ds.diffSize!.limits);
    assertFrozen(ds.diffSize!.used);
    assertFrozen(ds.diffSize!.unknown);
    (diffSize as { maxChangedFiles: number }).maxChangedFiles = 0;
    assert.equal(ds.diffSize!.limits.maxChangedFiles, 5);
  });
});

describe('WorkspaceDiffFactReader — trusted line facts', () => {
  const dirs: string[] = [];

  after(() => {
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  function tempGit(): { root: string; base: string; wt: string; missionId: string } {
    const root = mkdtempSync(join(tmpdir(), 'coagent-diff-fact-'));
    dirs.push(root);
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, 'keep.txt'), 'line1\n');
    execFileSync('git', ['add', 'keep.txt'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: root, stdio: 'ignore' });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();

    const missionId = 'M-diff';
    const wtRoot = join(root, '.coagent-worktrees');
    const wt = join(wtRoot, missionId);
    mkdirSync(wtRoot, { recursive: true });
    execFileSync('git', ['worktree', 'add', '-b', `mission/${missionId}`, wt, base], {
      cwd: root,
      stdio: 'ignore',
    });
    return { root, base, wt, missionId };
  }

  test('tracked numstat + untracked text lines; binary numstat → unknown', async () => {
    const { root, base, wt, missionId } = tempGit();
    writeFileSync(join(wt, 'keep.txt'), 'line1\nline2\nline3\n');
    writeFileSync(join(wt, 'new.txt'), 'a\nb\n');
    // binary-ish tracked change via numstat "-"
    writeFileSync(join(wt, 'pic.bin'), Buffer.from([0, 1, 2, 3, 0, 5]));
    execFileSync('git', ['add', 'pic.bin'], { cwd: wt, stdio: 'ignore' });
    // keep uncommitted so diff sees it; adding binary may show as numstat -

    const workspace = {
      worktreePath(m: string, projectRoot: string) {
        assert.equal(m, missionId);
        assert.equal(projectRoot, root);
        return wt;
      },
    } as unknown as WorkspaceManager;

    const reader = new WorkspaceDiffFactReader(workspace);

    // Without binary: only text changes
    execFileSync('git', ['reset', 'HEAD', 'pic.bin'], { cwd: wt, stdio: 'ignore' });
    rmSync(join(wt, 'pic.bin'), { force: true });

    const textFacts = await reader.measureLines({
      missionId,
      baseRevision: base,
      projectRoot: root,
    });
    assert.deepEqual(textFacts.unknown, []);
    // keep.txt: +2 lines (was 1 line "line1\n", now 3 lines); new.txt untracked 2 lines
    assert.equal(textFacts.changedLines, 2 + 2);

    // Binary untracked → unknown
    writeFileSync(join(wt, 'blob.bin'), Buffer.from([0, 1, 2, 0]));
    const binFacts = await reader.measureLines({
      missionId,
      baseRevision: base,
      projectRoot: root,
    });
    assert.deepEqual(binFacts.unknown, ['changedLines']);
    assert.equal(binFacts.changedLines, undefined);

    assert.equal(countTextLines(''), 0);
    assert.equal(countTextLines('a'), 1);
    assert.equal(countTextLines('a\nb\n'), 2);
  });

  test('missing worktree → unknown', async () => {
    const reader = new WorkspaceDiffFactReader({
      worktreePath: () => join(tmpdir(), 'no-such-wt-val002'),
    } as unknown as WorkspaceManager);
    const facts = await reader.measureLines({
      missionId: 'x',
      baseRevision: 'abc',
      projectRoot: '/p',
    });
    assert.deepEqual(facts.unknown, ['changedLines']);
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
