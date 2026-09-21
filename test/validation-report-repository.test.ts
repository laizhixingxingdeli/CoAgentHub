/**
 * M3-A2：ValidationReport 仓储（InMemory + File）。
 *
 * 锁住：append-only 不可变事实、deep clone/freeze、幂等/conflict、
 * File 跨重启、legacy 缺键、VR high-watermark。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ValidationReport } from '../src/kernel/index.ts';
import {
  FileStateStore,
  FileValidationReportRepository,
  PersistentIds,
} from '../src/application/file-store.ts';
import {
  InMemoryValidationReportRepository,
  ValidationReportConflictError,
  cloneValidationReport,
  validationReportsEqual,
  type ValidationReportRepository,
} from '../src/application/validation/report-repository.ts';

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

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-vr-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

/** 可变工厂：故意返回非 frozen，方便断言 save 不污染 / get 冻结。 */
function sampleReport(over: Partial<ValidationReport> = {}): ValidationReport {
  return {
    id: 'VR-1',
    policyRevision: 1,
    missionId: 'M-1',
    workItemId: 'WI-1',
    attemptId: 'AT-1',
    startedAt: '2026-06-01T12:00:00.000Z',
    endedAt: '2026-06-01T12:00:01.000Z',
    passed: true,
    checks: [
      {
        kind: 'command',
        passed: true,
        startedAt: '2026-06-01T12:00:00.000Z',
        endedAt: '2026-06-01T12:00:00.500Z',
        summary: 'command exited 0',
        command: {
          argv: ['node', '--test'],
          cwd: '/proj',
          exitCode: 0,
          timedOut: false,
          durationMs: 42,
          outputTail: 'ok\n',
        },
      },
      {
        kind: 'changed-paths',
        passed: true,
        startedAt: '2026-06-01T12:00:00.500Z',
        endedAt: '2026-06-01T12:00:01.000Z',
        summary: 'changed-paths: 1 path(s) within scope',
        changedPaths: {
          allowedScope: ['src/'],
          actual: ['src/a.ts'],
          violations: [],
          unsupportedScope: [],
        },
      },
    ],
    ...over,
  };
}

function assertFrozenReport(report: ValidationReport): void {
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.checks));
  for (const check of report.checks) {
    assert.ok(Object.isFrozen(check));
    if (check.command) {
      assert.ok(Object.isFrozen(check.command));
      assert.ok(Object.isFrozen(check.command.argv));
    }
    if (check.changedPaths) {
      assert.ok(Object.isFrozen(check.changedPaths));
      assert.ok(Object.isFrozen(check.changedPaths.allowedScope));
      assert.ok(Object.isFrozen(check.changedPaths.actual));
      assert.ok(Object.isFrozen(check.changedPaths.violations));
      assert.ok(Object.isFrozen(check.changedPaths.unsupportedScope));
    }
  }
}

async function assertRoundTrip(repo: ValidationReportRepository): Promise<void> {
  const original = sampleReport();
  const argv = original.checks[0]!.command!.argv as string[];
  const actual = original.checks[1]!.changedPaths!.actual as string[];

  await repo.save(original);

  // caller mutation 不污染已保存值
  argv.push('--evil');
  actual.push('evil.ts');
  (original as { passed: boolean }).passed = false;

  const got = await repo.get('VR-1');
  assert.ok(got);
  assert.equal(got.passed, true);
  assert.deepEqual(got.checks[0]!.command!.argv, ['node', '--test']);
  assert.deepEqual(got.checks[1]!.changedPaths!.actual, ['src/a.ts']);
  assertFrozenReport(got);

  // 结构相等（相对未污染前的样例）
  assert.ok(validationReportsEqual(got, sampleReport()));
}

async function assertFreshCopy(repo: ValidationReportRepository): Promise<void> {
  await repo.save(sampleReport({ id: 'VR-copy' }));
  const a = await repo.get('VR-copy');
  const b = await repo.get('VR-copy');
  assert.ok(a && b);
  assert.ok(validationReportsEqual(a, b));
  assert.notEqual(a, b);
  assert.notEqual(a.checks, b.checks);
  assert.notEqual(a.checks[0], b.checks[0]);
  if (a.checks[0]!.command && b.checks[0]!.command) {
    assert.notEqual(a.checks[0]!.command.argv, b.checks[0]!.command.argv);
  }
}

async function assertIdempotentAndConflict(repo: ValidationReportRepository): Promise<void> {
  const base = sampleReport({ id: 'VR-c' });
  await repo.save(base);
  // identical（新对象）幂等
  await repo.save(sampleReport({ id: 'VR-c' }));
  await repo.save(cloneValidationReport(base));

  const before = await repo.get('VR-c');
  assert.ok(before);

  const variants: ValidationReport[] = [
    sampleReport({ id: 'VR-c', passed: false }),
    sampleReport({
      id: 'VR-c',
      checks: [
        {
          ...sampleReport().checks[0]!,
          command: {
            ...sampleReport().checks[0]!.command!,
            outputTail: 'DIFFERENT',
          },
        },
        sampleReport().checks[1]!,
      ],
    }),
    sampleReport({
      id: 'VR-c',
      checks: [
        {
          ...sampleReport().checks[0]!,
          passed: false,
          summary: 'fail',
        },
        sampleReport().checks[1]!,
      ],
    }),
    sampleReport({
      id: 'VR-c',
      checks: [sampleReport().checks[1]!, sampleReport().checks[0]!],
    }),
  ];

  for (const bad of variants) {
    await assert.rejects(
      () => repo.save(bad),
      (err: unknown) => {
        assert.ok(err instanceof ValidationReportConflictError);
        assert.equal(err.code, 'VALIDATION_REPORT_CONFLICT');
        assert.equal(err.reportId, 'VR-c');
        return true;
      },
    );
  }

  const after = await repo.get('VR-c');
  assert.ok(after);
  assert.ok(validationReportsEqual(before, after));
  assert.equal(after.passed, true);
  assert.equal(after.checks[0]!.command!.outputTail, 'ok\n');
}

describe('InMemoryValidationReportRepository', () => {
  test('save/get nested deep equal + frozen；caller mutation 不污染', async () => {
    await assertRoundTrip(new InMemoryValidationReportRepository());
  });

  test('get 每次新 copy', async () => {
    await assertFreshCopy(new InMemoryValidationReportRepository());
  });

  test('identical 幂等；不同字段 conflict 且旧值不变', async () => {
    await assertIdempotentAndConflict(new InMemoryValidationReportRepository());
  });
});

describe('FileValidationReportRepository', () => {
  test('save/get nested deep equal + frozen；caller mutation 不污染', async () => {
    const store = new FileStateStore(tempState());
    await assertRoundTrip(new FileValidationReportRepository(store));
  });

  test('get 每次新 copy', async () => {
    const store = new FileStateStore(tempState());
    await assertFreshCopy(new FileValidationReportRepository(store));
  });

  test('identical 幂等；不同字段 conflict 且旧值不变', async () => {
    const store = new FileStateStore(tempState());
    await assertIdempotentAndConflict(new FileValidationReportRepository(store));
  });

  test('新 store 实例从同 path 可读（restart）', async () => {
    const path = tempState();
    const store1 = new FileStateStore(path);
    const repo1 = new FileValidationReportRepository(store1);
    await repo1.save(sampleReport({ id: 'VR-9' }));

    const store2 = new FileStateStore(path);
    const repo2 = new FileValidationReportRepository(store2);
    const got = await repo2.get('VR-9');
    assert.ok(got);
    assert.ok(validationReportsEqual(got, sampleReport({ id: 'VR-9' })));
    assertFrozenReport(got);
  });

  test('legacy StateFile 缺 validationReports 仍可 load', async () => {
    const path = tempState();
    writeFileSync(
      path,
      JSON.stringify(
        {
          version: 1,
          projects: [],
          deliveries: [],
          events: [],
          idCounters: {},
          agentPool: [],
          archivedMissions: [],
          queryRuns: [],
          // 故意无 validationReports
        },
        null,
        2,
      ),
      'utf8',
    );
    const store = new FileStateStore(path);
    assert.deepEqual(store.raw().validationReports, []);
    const repo = new FileValidationReportRepository(store);
    assert.equal(await repo.get('VR-1'), undefined);
    await repo.save(sampleReport());
    assert.ok(await repo.get('VR-1'));
  });

  test('VR high-watermark：预置 VR-7 抬 counter；更高 counter 不回退', async () => {
    const pathLow = tempState();
    writeFileSync(
      pathLow,
      JSON.stringify(
        {
          version: 1,
          projects: [],
          deliveries: [],
          events: [],
          idCounters: { VR: 2 },
          agentPool: [],
          archivedMissions: [],
          queryRuns: [],
          validationReports: [sampleReport({ id: 'VR-7' })],
        },
        null,
        2,
      ),
      'utf8',
    );
    const low = new FileStateStore(pathLow);
    assert.equal(low.raw().idCounters.VR, 7);
    const idsLow = new PersistentIds(low);
    assert.equal(idsLow.next('VR'), 'VR-8');

    const pathMissing = tempState();
    writeFileSync(
      pathMissing,
      JSON.stringify(
        {
          version: 1,
          projects: [],
          deliveries: [],
          events: [],
          idCounters: {},
          agentPool: [],
          archivedMissions: [],
          queryRuns: [],
          validationReports: [sampleReport({ id: 'VR-7' })],
        },
        null,
        2,
      ),
      'utf8',
    );
    const missing = new FileStateStore(pathMissing);
    assert.equal(missing.raw().idCounters.VR, 7);
    assert.equal(new PersistentIds(missing).next('VR'), 'VR-8');

    const pathHigh = tempState();
    writeFileSync(
      pathHigh,
      JSON.stringify(
        {
          version: 1,
          projects: [],
          deliveries: [],
          events: [],
          idCounters: { VR: 20 },
          agentPool: [],
          archivedMissions: [],
          queryRuns: [],
          validationReports: [sampleReport({ id: 'VR-7' })],
        },
        null,
        2,
      ),
      'utf8',
    );
    const high = new FileStateStore(pathHigh);
    assert.equal(high.raw().idCounters.VR, 20, '已有更高 counter 不得回退');
    assert.equal(new PersistentIds(high).next('VR'), 'VR-21');
  });
});
