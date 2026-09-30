/**
 * 方案运行记录的文件存储：升级握手的跨进程那一半。
 *
 * 驱动方（run-plan）与检视者是两个进程。判据只有一条：**一边写下的，另一边
 * 读得到、写得回，而且两边同时写时谁都不会悄悄盖掉谁。** 所以这里的「另一边」
 * 一律是真的子进程（test/helpers/plan-run-probe.ts），不是同进程里的第二个实例。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PlanRun } from '../src/application/plan-run.ts';
import {
  FilePlanRunStore,
  isSafePlanRunId,
  listPlanRuns,
  readPlanRunById,
} from '../src/application/plan-run-store.ts';
import { LockBusyError } from '../src/application/lock.ts';
import { PlatformRuleError } from '../src/application/platform.ts';

const PROBE = fileURLToPath(new URL('./helpers/plan-run-probe.ts', import.meta.url));
const T0 = '2026-09-23T14:00:00.000Z';
const MIN = 60_000;

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * MIN).toISOString();
}

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** 一份新记录：F1 在跑，第 10 分钟开了升级单 E-1（第 30 分钟截止）。 */
async function storeWithEscalation(options?: { lockWaitMs?: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-plan-run-'));
  dirs.push(dir);
  const path = join(dir, 'R1.json');
  const store = new FilePlanRunStore(path, options);
  await store.create(
    PlanRun.start({
      id: 'R1',
      planId: 'PLAN-x',
      projectId: 'p',
      integrationBranch: 'auto/x',
      reviewer: 'claude',
      stopConditions: { unresolvedEscalations: 5, wallClockMs: 8 * 60 * MIN, escalationTimeoutMs: 20 * MIN },
      featureIds: ['F1', 'F2', 'F3'],
      startedAt: T0,
    }),
  );
  await store.update((run) => {
    run.startFeature('F1', 'M-F1');
    run.openEscalation(
      { featureId: 'F1', missionId: 'M-F1', failure: '集成验证红', question: 'F1 跳过还是隔离重跑？' },
      at(10),
    );
  });
  return { path, store };
}

type ProbeResult = {
  ok: boolean;
  seen?: { id: string; question: string };
  code?: string;
  message?: string;
};

/** 在另一个进程里写回决定；同步跑完。 */
function decideElsewhere(path: string, args: Record<string, unknown>): ProbeResult {
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [PROBE, 'decide', path, JSON.stringify(args)], {
      encoding: 'utf8',
    });
  } catch (error) {
    stdout = String((error as { stdout?: string }).stdout ?? '');
  }
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? '{}') as ProbeResult;
}

const SKIP = {
  escalationId: 'E-1',
  action: 'skip',
  reason: '夹具冲突，今晚不值得再烧',
  decidedBy: 'claude',
};

describe('升级握手跨进程', () => {
  test('活动 run 的 Mission parked 投影持久化且不因升级截止计数', async () => {
    const { store } = await storeWithEscalation();
    await store.update((run) => run.parkMission('M-F1', '等待用户澄清', at(12)));
    const restored = store.read();
    assert.equal(restored?.feature('F1')?.status, 'suspended');
    assert.deepEqual(restored?.parkedMissions, [{
      escalationId: 'E-1', missionId: 'M-F1', reviewer: 'claude', reason: '等待用户澄清', parkedAt: at(12),
    }]);
    assert.equal(restored?.unresolvedCount, 0);
    assert.equal(restored?.stopped, undefined);
  });
  test('另一个进程读到升级单、写回决定，本进程读得到', async () => {
    const { path, store } = await storeWithEscalation();

    const result = decideElsewhere(path, { ...SKIP, at: at(25) });

    assert.equal(result.ok, true, result.message);
    // 它读到的正是这边写下的那张单子。
    assert.equal(result.seen?.id, 'E-1');
    assert.equal(result.seen?.question, 'F1 跳过还是隔离重跑？');
    const run = store.read();
    assert.deepEqual(run?.escalations[0].resolution, {
      kind: 'decided',
      action: 'skip',
      reason: '夹具冲突，今晚不值得再烧',
      decidedBy: 'claude',
      decidedAt: at(25),
    });
    assert.equal(run?.feature('F1')?.status, 'skipped');
  });

  test('先定后判过期：驱动方被明确拒绝，文件里仍是检视者的决定', async () => {
    const { path, store } = await storeWithEscalation();
    assert.equal(decideElsewhere(path, { ...SKIP, at: at(29) }).ok, true);

    await assert.rejects(
      store.update((run) => run.expire('E-1', at(30))),
      (error: unknown) => error instanceof PlatformRuleError && error.code === 'ESCALATION_ALREADY_RESOLVED',
    );
    const run = store.read();
    assert.equal(run?.escalations[0].resolution?.kind, 'decided');
    assert.equal(run?.unresolvedCount, 0);
  });

  test('先判过期后定：检视者被明确拒绝，文件里仍是过期', async () => {
    const { path, store } = await storeWithEscalation();
    await store.update((run) => run.expire('E-1', at(30)));

    const late = decideElsewhere(path, { ...SKIP, at: at(28) });

    assert.equal(late.ok, false);
    assert.equal(late.code, 'ESCALATION_ALREADY_RESOLVED');
    const run = store.read();
    assert.equal(run?.escalations[0].resolution?.kind, 'expired');
    assert.equal(run?.unresolvedCount, 1);
    assert.equal(run?.feature('F1')?.status, 'suspended');
  });
});

describe('同时写', () => {
  /** 让子进程拿着锁多待 holdMs；等它在锁内打出 LOCKED 才返回。 */
  function holdLockElsewhere(path: string, holdMs: number) {
    const child = spawn(
      process.execPath,
      [PROBE, 'decide', path, JSON.stringify({ ...SKIP, at: at(25), holdMs })],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    const locked = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.includes('LOCKED')) resolve();
      });
      child.on('exit', () => reject(new Error(`探针没拿到锁就退出了：${stdout}`)));
    });
    const done = new Promise<ProbeResult>((resolve) => {
      child.on('exit', () => resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? '{}')));
    });
    return { locked, done };
  }

  test('锁被另一个进程拿着时等它放，拿到后读的是它写过的版本——谁也不丢', async () => {
    const { path, store } = await storeWithEscalation();
    const other = holdLockElsewhere(path, 800);
    await other.locked;

    // 读-改-写要是没等锁、或拿锁前就读了，这里看到的 F1 还在跑 → 开 F2 会撞
    // PLAN_FEATURE_BUSY；就算侥幸写成了，也会把对方的决定整份盖掉。
    await store.update((run) => run.startFeature('F2', 'M-F2'));
    assert.equal((await other.done).ok, true);

    const run = store.read();
    assert.equal(run?.escalations[0].resolution?.kind, 'decided', '对方的决定还在');
    assert.equal(run?.feature('F1')?.status, 'skipped');
    assert.equal(run?.feature('F2')?.status, 'running', '这边的改动也在');
  });

  test('等不到锁就报错，一个字都不写', async () => {
    const { path } = await storeWithEscalation();
    const impatient = new FilePlanRunStore(path, { lockWaitMs: 150 });
    const other = holdLockElsewhere(path, 1500);
    await other.locked;

    await assert.rejects(
      impatient.update((run) => run.startFeature('F2', 'M-F2')),
      (error: unknown) => error instanceof LockBusyError,
    );
    await other.done;
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { features: { featureId: string; status: string }[] };
    assert.equal(onDisk.features.find((f) => f.featureId === 'F2')?.status, 'pending');
  });
});

async function storeWithHa() {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-plan-ha-'));
  dirs.push(dir);
  const path = join(dir, 'R-ha.json');
  const store = new FilePlanRunStore(path);
  const run = PlanRun.start({ id: 'R-ha', planId: 'P', projectId: 'p', integrationBranch: 'main', reviewer: 'claude', stopConditions: { unresolvedEscalations: 2, wallClockMs: 100_000, escalationTimeoutMs: 1000 }, featureIds: ['F1', 'F2'], startedAt: T0 });
  run.startFeature('F1', 'M-F1');
  run.suspendFeature('F1', 'HA 待放行');
  run.startFeature('F2', 'M-F2');
  await store.create(run);
  const make = (featureId: string, missionId: string) => ({ featureId, missionId, reviewedCommit: 'sha1', attemptId: `A-${featureId}`, validationReportId: `VR-${featureId}`, reviewerId: 'claude', integrationBranch: 'main', openedAt: at(1), deadline: at(20), verification: [{ command: 'npm test', timeoutMs: 5000 }, { command: 'npm run lint', timeoutMs: 7000 }] });
  const opened: ReturnType<typeof run.openHaRelease>[] = [];
  await store.update((r) => {
    opened.push(r.openHaRelease(make('F1', 'M-F1')));
    opened.push(r.openHaRelease(make('F2', 'M-F2')));
  });
  return { path, store, make, opened };
}

describe('HA 待放行记录存储', () => {
  test('旧 version 1 快照缺少 haReleases 仍可恢复', async () => {
    const { path, store } = await storeWithEscalation();
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete snapshot.haReleases;
    writeFileSync(path, JSON.stringify(snapshot));
    assert.deepEqual(store.read()?.haReleases, []);
  });

  test('已决定与待决记录 round-trip 保持值和顺序', async () => {
    const { path, store, opened } = await storeWithHa();
    const decided = await store.update((run) => run.decideHaRelease({ featureId: 'F1', missionId: 'M-F1', reviewedCommit: 'sha1', attemptId: 'A-F1', validationReportId: 'VR-F1', target: 'main', as: 'claude', confirmedBy: 'human', action: 'approve' }, at(10)));
    const expected = [decided, opened[1]];
    const restored = new FilePlanRunStore(path).read()?.haReleases;
    assert.deepEqual(restored, expected);
    assert.equal(expected[0].decision?.kind, 'approve');
    assert.equal(expected[1].decision, undefined);
    assert.deepEqual(expected[0].verification.map((v) => v.command), ['npm test', 'npm run lint']);
  });

  test('畸形 HA 快照统一 fail-closed', async () => {
    const cases: Array<(snapshot: Record<string, any>) => void> = [
      (s) => { s.haReleases = {}; },
      (s) => { delete s.haReleases[0].reviewedCommit; },
      (s) => { s.haReleases[0].decision = { kind: 'send-back', at: at(10) }; },
      (s) => { s.haReleases[0].decision = { kind: 'approve', at: at(10), confirmedBy: 'human' }; },
      (s) => { s.haReleases.push({ ...s.haReleases[0] }); },
      (s) => { s.haReleases[0].missionId = 'foreign'; },
      (s) => { s.haReleases[0].runId = 'foreign'; },
      (s) => { s.haReleases[0].integrationBranch = 'foreign'; },
      (s) => { s.haReleases[0].reviewerId = 'someone-else'; },
      (s) => { s.haReleases[0].decision = null; },
    ];
    for (const mutate of cases) {
      const { path, store } = await storeWithHa();
      const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
      mutate(snapshot);
      writeFileSync(path, JSON.stringify(snapshot));
      assert.throws(() => store.read(), (error: unknown) => error instanceof PlatformRuleError && error.code === 'PLAN_RUN_CORRUPT');
    }
  });

  test('规则拒绝的 HA 签字不改变文件字节', async () => {
    const { path, store } = await storeWithHa();
    const before = readFileSync(path);
    await assert.rejects(store.update((run) => run.decideHaRelease({ featureId: 'F1', missionId: 'M-F1', reviewedCommit: 'wrong', attemptId: 'A-F1', validationReportId: 'VR-F1', target: 'main', as: 'claude', confirmedBy: 'human', action: 'approve' }, at(10))), (error: unknown) => error instanceof PlatformRuleError && error.code === 'HA_RELEASE_REJECTED');
    assert.deepEqual(readFileSync(path), before);
  });
});

describe('记录本身', () => {
  test('同一路径不能建两次：覆盖一份在跑的记录等于抹掉整晚的账', async () => {
    const { store } = await storeWithEscalation();
    await assert.rejects(
      store.create(
        PlanRun.start({
          id: 'R1',
          planId: 'PLAN-x',
          projectId: 'p',
          integrationBranch: 'auto/x',
          reviewer: 'claude',
          stopConditions: { unresolvedEscalations: 5, wallClockMs: 1, escalationTimeoutMs: 1 },
          featureIds: ['F1'],
          startedAt: T0,
        }),
      ),
      (error: unknown) => error instanceof PlatformRuleError && error.code === 'PLAN_RUN_EXISTS',
    );
    assert.equal(store.read()?.feature('F1')?.status, 'running');
  });

  test('规则拒绝的改动不落盘', async () => {
    const { path, store } = await storeWithEscalation();
    const before = readFileSync(path, 'utf8');
    await assert.rejects(
      store.update((run) => run.choose('E-1', { action: 'merge', reason: 'x', decidedBy: 'claude' }, at(12))),
      (error: unknown) => error instanceof PlatformRuleError && error.code === 'REVIEWER_ACTION_FORBIDDEN',
    );
    assert.equal(readFileSync(path, 'utf8'), before);
  });

  test('超额 rerun 的 update 抛错，文件字节不变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-plan-run-'));
    dirs.push(dir);
    const path = join(dir, 'R1.json');
    const store = new FilePlanRunStore(path);
    await store.create(
      PlanRun.start({
        id: 'R1',
        planId: 'PLAN-x',
        projectId: 'p',
        integrationBranch: 'auto/x',
        reviewer: 'claude',
        stopConditions: {
          unresolvedEscalations: 5,
          wallClockMs: 8 * 60 * MIN,
          escalationTimeoutMs: 20 * MIN,
          maxRerunsPerFeature: 1,
        },
        featureIds: ['F1'],
        startedAt: T0,
      }),
    );
    await store.update((run) => {
      run.startFeature('F1', 'M-F1');
      run.openEscalation(
        { featureId: 'F1', missionId: 'M-F1', failure: '红', question: '重跑吗？' },
        at(10),
      );
    });
    await store.update((run) =>
      run.choose('E-1', { action: 'rerun_isolated', reason: '再来', decidedBy: 'claude' }, at(12)),
    );
    await store.update((run) => {
      run.startFeature('F1', 'M-F1-r2');
      run.openEscalation(
        { featureId: 'F1', missionId: 'M-F1-r2', failure: '又红', question: '还重跑吗？' },
        at(40),
      );
    });
    const before = readFileSync(path, 'utf8');
    await assert.rejects(
      store.update((run) =>
        run.choose('E-2', { action: 'rerun_isolated', reason: '还来', decidedBy: 'claude' }, at(42)),
      ),
      (error: unknown) => error instanceof PlatformRuleError && error.code === 'RERUN_LIMIT_REACHED',
    );
    assert.equal(readFileSync(path, 'utf8'), before);
  });

  test('记录目录还不存在时也建得出来：run-plan 第一次跑就是这样', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-plan-run-'));
    dirs.push(dir);
    const store = new FilePlanRunStore(join(dir, '.coagent-plans', 'R9.json'));
    await store.create(
      PlanRun.start({
        id: 'R9',
        planId: 'PLAN-x',
        projectId: 'p',
        integrationBranch: 'auto/x',
        reviewer: 'claude',
        stopConditions: { unresolvedEscalations: 5, wallClockMs: 1, escalationTimeoutMs: 1 },
        featureIds: ['F1'],
        startedAt: T0,
      }),
    );
    assert.equal(store.read()?.id, 'R9');
  });

  test('没有记录时 read 给 undefined；update 明确报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-plan-run-'));
    dirs.push(dir);
    const store = new FilePlanRunStore(join(dir, 'none.json'));
    assert.equal(store.read(), undefined);
    await assert.rejects(
      store.update(() => undefined),
      (error: unknown) => error instanceof PlatformRuleError && error.code === 'PLAN_RUN_NOT_FOUND',
    );
  });
});

async function storeWithAnswerable() {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-plan-run-'));
  dirs.push(dir);
  const path = join(dir, 'R1.json');
  const store = new FilePlanRunStore(path);
  await store.create(
    PlanRun.start({
      id: 'R1',
      planId: 'PLAN-x',
      projectId: 'p',
      integrationBranch: 'auto/x',
      reviewer: 'claude',
      stopConditions: { unresolvedEscalations: 5, wallClockMs: 8 * 60 * MIN, escalationTimeoutMs: 20 * MIN },
      featureIds: ['F1', 'F2'],
      startedAt: T0,
    }),
  );
  await store.update((run) => {
    run.startFeature('F1', 'M-F1');
    run.openEscalation(
      {
        featureId: 'F1',
        missionId: 'M-F1',
        failure: '协调者提问',
        question: '  原问  ',
        answerable: true,
      },
      at(10),
    );
  });
  return { path, store };
}

describe('可答复升级单存储',
  () => {
    test('含答复结论的落盘重读逐字段一致',
      async () => {
        const { path, store } = await storeWithAnswerable();
        const decided = await store.update((run) =>
          run.choose(
            'E-1',
            { action: 'answer', answer: '  用这个 id  ', reason: '现场还在跑', decidedBy: 'claude' },
            at(12),
          ),
        );
        const reread = new FilePlanRunStore(path).read();
        assert.ok(reread);
        assert.deepEqual(reread.escalations[0].resolution, decided.resolution);
        assert.deepEqual(reread.escalations[0].resolution, {
          kind: 'decided',
          action: 'answer',
          answer: '用这个 id',
          reason: '现场还在跑',
          decidedBy: 'claude',
          decidedAt: at(12),
        });
        assert.equal(reread.escalations[0].answerable, true);
        assert.equal(reread.escalations[0].question, '原问');
        assert.equal(reread.feature('F1')?.status, 'running');
        assert.equal(reread.rerunsUsed('F1'), 0);
        assert.deepEqual(reread.toSnapshot(), store.read()?.toSnapshot());
      });

    test('旧无新字段记录可读',
      async () => {
        const { path, store } = await storeWithEscalation();
        const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
        delete snapshot.escalations[0].answerable;
        writeFileSync(path, JSON.stringify(snapshot));
        const run = store.read();
        assert.equal(run?.escalations[0].answerable, undefined);
        assert.equal(run?.escalations[0].question, 'F1 跳过还是隔离重跑？');
        assert.equal(run?.currentEscalation?.id, 'E-1');
      });

    test('坏的 answer 记录（缺 answer 或不可答复）拒读',
      async () => {
        const cases: Array<(snapshot: Record<string, any>) => void> = [
          (s) => {
            s.escalations[0].resolution = {
              kind: 'decided',
              action: 'answer',
              decidedBy: 'claude',
              decidedAt: at(12),
            };
          },
          (s) => {
            s.escalations[0].answerable = true;
            s.escalations[0].resolution = {
              kind: 'decided',
              action: 'answer',
              decidedBy: 'claude',
              decidedAt: at(12),
            };
          },
          (s) => {
            s.escalations[0].resolution = {
              kind: 'decided',
              action: 'answer',
              answer: '不该出现在旧单上',
              decidedBy: 'claude',
              decidedAt: at(12),
            };
          },
          (s) => {
            s.escalations[0].answerable = true;
            s.escalations[0].missionId = 'M-F1';
            s.escalations[0].question = '   ';
          },
          (s) => {
            s.escalations[0].answerable = true;
            s.escalations[0].missionId = 'M-F1';
            s.escalations[0].question = '';
          },
        ];
        for (const mutate of cases) {
          const { path, store } = await storeWithEscalation();
          const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
          mutate(snapshot);
          writeFileSync(path, JSON.stringify(snapshot));
          assert.throws(
            () => store.read(),
            (error: unknown) => error instanceof PlatformRuleError && error.code === 'PLAN_RUN_CORRUPT',
          );
        }
      });

    test('规则拒绝的 answer 不落盘',
      async () => {
        const { path, store } = await storeWithEscalation();
        const before = readFileSync(path, 'utf8');
        await assert.rejects(
          store.update((run) =>
            run.choose('E-1', { action: 'answer', answer: '不行', decidedBy: 'claude' }, at(12)),
          ),
          (error: unknown) => error instanceof PlatformRuleError && error.code === 'ESCALATION_NOT_ANSWERABLE',
        );
        assert.equal(readFileSync(path, 'utf8'), before);

        const answerable = await storeWithAnswerable();
        const beforeAnswer = readFileSync(answerable.path, 'utf8');
        await assert.rejects(
          answerable.store.update((run) =>
            run.choose('E-1', { action: 'answer', answer: '   ', decidedBy: 'claude' }, at(12)),
          ),
          (error: unknown) => error instanceof PlatformRuleError && error.code === 'DECISION_ANSWER_INVALID',
        );
        assert.equal(readFileSync(answerable.path, 'utf8'), beforeAnswer);
      });

    test('空白原问的可答复开单拒绝写入',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'coagent-plan-run-'));
        dirs.push(dir);
        const path = join(dir, 'R1.json');
        const store = new FilePlanRunStore(path);
        await store.create(
          PlanRun.start({
            id: 'R1',
            planId: 'PLAN-x',
            projectId: 'p',
            integrationBranch: 'auto/x',
            reviewer: 'claude',
            stopConditions: {
              unresolvedEscalations: 5,
              wallClockMs: 8 * 60 * MIN,
              escalationTimeoutMs: 20 * MIN,
            },
            featureIds: ['F1'],
            startedAt: T0,
          }),
        );
        await store.update((run) => {
          run.startFeature('F1', 'M-F1');
        });
        const before = readFileSync(path, 'utf8');
        await assert.rejects(
          store.update((run) =>
            run.openEscalation(
              {
                featureId: 'F1',
                missionId: 'M-F1',
                failure: '协调者提问',
                question: '   ',
                answerable: true,
              },
              at(10),
            ),
          ),
          (error: unknown) =>
            error instanceof PlatformRuleError && error.code === 'ANSWERABLE_QUESTION_REQUIRED',
        );
        assert.equal(readFileSync(path, 'utf8'), before);
      });
  });

const STOP = {
  unresolvedEscalations: 5,
  wallClockMs: 8 * 60 * MIN,
  escalationTimeoutMs: 20 * MIN,
};

async function seedRun(
  dir: string,
  input: {
    id: string;
    projectId: string;
    startedAt: string;
    titles?: Record<string, string>;
    halt?: boolean;
  },
) {
  const store = new FilePlanRunStore(join(dir, `${input.id}.json`));
  await store.create(
    PlanRun.start({
      id: input.id,
      planId: `PLAN-${input.id}`,
      projectId: input.projectId,
      integrationBranch: 'auto/x',
      reviewer: 'claude',
      stopConditions: STOP,
      featureIds: ['F1', 'F2'],
      titles: input.titles ?? { F1: '一', F2: '二' },
      startedAt: input.startedAt,
    }),
  );
  await store.update((run) => {
    run.startFeature('F1', `${input.id}-F1`);
    if (input.halt) run.halt('unsafe', '停', at(1));
  });
  return store;
}

describe('方案运行记录只读枚举', () => {
  test('安全 id：拒绝路径段与越目录形状', () => {
    assert.equal(isSafePlanRunId('R1'), true);
    assert.equal(isSafePlanRunId('PLAN-x-20260929'), true);
    assert.equal(isSafePlanRunId('../secret'), false);
    assert.equal(isSafePlanRunId('a/b'), false);
    assert.equal(isSafePlanRunId('a\\b'), false);
    assert.equal(isSafePlanRunId(''), false);
    assert.equal(isSafePlanRunId('.hidden'), false);
  });

  test('列表按 startedAt 降序，坏文件单独成行，不拖垮其它记录', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-plan-list-'));
    dirs.push(dir);
    await seedRun(dir, { id: 'R-old', projectId: 'p-a', startedAt: at(0), halt: true });
    await seedRun(dir, { id: 'R-new', projectId: 'p-b', startedAt: at(30) });
    writeFileSync(join(dir, 'R-bad.json'), '{not-json', 'utf8');
    writeFileSync(join(dir, 'ignore.txt'), 'nope', 'utf8');
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'R-nested.json'), '{"version":1}', 'utf8');

    const listed = listPlanRuns([dir]);
    assert.equal(listed[0] && !('error' in listed[0]) && listed[0].id, 'R-new');
    assert.equal(listed[1] && !('error' in listed[1]) && listed[1].id, 'R-old');
    const bad = listed.find((item) => 'error' in item && item.id === 'R-bad');
    assert.ok(bad && 'error' in bad);
    assert.equal(bad.error, '方案运行记录不是合法 JSON');
    assert.equal(listed.some((item) => item.id === 'R-nested'), false);
    assert.equal(listed.some((item) => item.id === 'ignore'), false);

    const older = listed[1];
    assert.ok(older && !('error' in older));
    assert.equal(older.planId, 'PLAN-R-old');
    assert.equal(older.projectId, 'p-a');
    assert.equal(older.integrationBranch, 'auto/x');
    assert.equal(older.startedAt, at(0));
    assert.equal(older.stopped?.reason, 'unsafe');
    assert.equal(older.escalationCount, 0);
    assert.deepEqual(
      older.features.map((f) => ({ featureId: f.featureId, title: f.title, status: f.status, missionIds: f.missionIds })),
      [
        { featureId: 'F1', title: '一', status: 'suspended', missionIds: ['R-old-F1'] },
        { featureId: 'F2', title: '二', status: 'pending', missionIds: [] },
      ],
    );
  });

  test('?project 只筛有效记录；重复 id 先到的目录赢', async () => {
    const first = mkdtempSync(join(tmpdir(), 'coagent-plan-a-'));
    const second = mkdtempSync(join(tmpdir(), 'coagent-plan-b-'));
    dirs.push(first, second);
    await seedRun(first, { id: 'R1', projectId: 'p-a', startedAt: at(0) });
    await seedRun(second, { id: 'R1', projectId: 'p-other', startedAt: at(40) });
    await seedRun(second, { id: 'R2', projectId: 'p-b', startedAt: at(10) });
    writeFileSync(join(second, 'R-bad.json'), '{', 'utf8');

    const all = listPlanRuns([first, second]);
    const r1 = all.filter((item) => item.id === 'R1');
    assert.equal(r1.length, 2);
    assert.ok(r1[0] && !('error' in r1[0]));
    assert.equal(r1[0].projectId, 'p-a');
    assert.ok(r1[1] && 'error' in r1[1]);
    assert.equal(r1[1].error, '重复的方案运行记录 id');

    const filtered = listPlanRuns([first, second], 'p-a');
    assert.ok(filtered.some((item) => !('error' in item) && item.id === 'R1' && item.projectId === 'p-a'));
    assert.equal(filtered.some((item) => !('error' in item) && item.id === 'R2'), false);
    assert.ok(filtered.some((item) => 'error' in item && item.id === 'R-bad'));
    assert.ok(filtered.some((item) => 'error' in item && item.id === 'R1'));
  });

  test('按 id 读完整快照；缺失 missing；损坏不带路径；恶意 id 不越目录', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-plan-read-'));
    dirs.push(dir);
    const store = await seedRun(dir, { id: 'R1', projectId: 'p', startedAt: T0 });
    await store.update((run) => {
      run.openEscalation(
        { featureId: 'F1', missionId: 'R1-F1', failure: '红', question: '怎么办？' },
        at(10),
      );
    });
    const ok = readPlanRunById([dir], 'R1');
    assert.equal(ok.status, 'ok');
    if (ok.status !== 'ok') return;
    assert.equal(ok.snapshot.id, 'R1');
    assert.equal(ok.snapshot.escalations.length, 1);
    assert.equal(ok.snapshot.escalations[0]?.question, '怎么办？');
    assert.equal(ok.snapshot.escalations[0]?.openedAt, at(10));
    assert.equal(ok.snapshot.features[0]?.missionIds[0], 'R1-F1');

    assert.equal(readPlanRunById([dir], 'nope').status, 'missing');
    assert.equal(readPlanRunById([dir], '../R1').status, 'missing');
    assert.equal(readPlanRunById([dir], 'R1/../../etc/passwd').status, 'missing');

    writeFileSync(join(dir, 'R-bad.json'), '{', 'utf8');
    const bad = readPlanRunById([dir], 'R-bad');
    assert.equal(bad.status, 'corrupt');
    if (bad.status === 'corrupt') {
      assert.equal(bad.error.includes(dir), false);
      assert.equal(bad.error, '方案运行记录不是合法 JSON');
    }

    const mismatch = PlanRun.start({
      id: 'R-real',
      planId: 'PLAN-x',
      projectId: 'p',
      integrationBranch: 'auto/x',
      reviewer: 'claude',
      stopConditions: STOP,
      featureIds: ['F1'],
      startedAt: T0,
    });
    writeFileSync(join(dir, 'R-name.json'), `${JSON.stringify(mismatch.toSnapshot(), null, 2)}\n`, 'utf8');
    const named = readPlanRunById([dir], 'R-name');
    assert.equal(named.status, 'corrupt');
    if (named.status === 'corrupt') assert.equal(named.error, '记录 id 与文件名不一致');
  });
});
