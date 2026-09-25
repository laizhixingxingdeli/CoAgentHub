/**
 * `node src/l3.ts plan`：检视者夜里每 20 分钟醒一次读升级单、写回决定；早上人看交接面。
 *
 * 它跑的时候，run-plan 正握着主状态锁在写。所以这组验的是三件事，另一边一律是
 * **真子进程**：
 * 1. 不需要主状态锁——锁被占着照样能看、能定；
 * 2. 不写主状态文件——只读命令没有立场判定别的进程死了。启动收敛会把刚开出来、
 *    还没来得及打第一次心跳的 attempt 判死并**整份写回**：两个写者，后写的盖掉
 *    先写的，悄无声息；
 * 3. 决定真的写进了方案运行记录；规则拒绝的明确报错、非零退出。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireLock } from '../src/application/lock.ts';
import { PlanRun } from '../src/application/plan-run.ts';
import { FilePlanRunStore } from '../src/application/plan-run-store.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { buildPersistentPlatform } from '../src/main.ts';

const L3 = fileURLToPath(new URL('../src/l3.ts', import.meta.url));
const MIN = 60_000;

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** 一晚正在进行：F1 失败开了单 E-1（用真实时钟，截止在 20 分钟后）。 */
async function nightInProgress() {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-l3-plan-'));
  dirs.push(dir);
  const statePath = join(dir, 'state.json');
  const store = new FilePlanRunStore(join(dir, '.coagent-plans', 'PLAN-x-20260923-2200.json'));
  const now = new Date().toISOString();
  await store.create(
    PlanRun.start({
      id: 'PLAN-x-20260923-2200',
      planId: 'PLAN-x',
      projectId: 'P',
      integrationBranch: 'auto/plan-x',
      reviewer: 'claude',
      stopConditions: { unresolvedEscalations: 5, wallClockMs: 8 * 60 * MIN, escalationTimeoutMs: 20 * MIN },
      featureIds: ['F1', 'F2', 'F3'],
      titles: { F1: '升级握手', F2: '驱动', F3: '交接面' },
      startedAt: now,
    }),
  );
  await store.update((run) => {
    run.startFeature('F1', 'PLAN-x-20260923-2200-F1');
    run.openEscalation(
      { featureId: 'F1', missionId: 'PLAN-x-20260923-2200-F1', failure: '集成验证红（报告 IVAL-7）', question: 'F1 跳过还是重跑？' },
      now,
    );
  });
  return { dir, statePath, store };
}

function l3(statePath: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [L3, ...args, '--state', statePath], { encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('l3 plan：看', () => {
  test('不给 --run 就取状态文件旁最新的那份；开着的单子连同照抄就能用的命令一起给出', async () => {
    const { dir, statePath, store } = await nightInProgress();
    // 再放一份更早的记录：取最新和取最旧要分得出来。
    const older = join(dir, '.coagent-plans', 'PLAN-old-20260901-2200.json');
    mkdirSync(join(dir, '.coagent-plans'), { recursive: true });
    writeFileSync(older, readFileSync(store.path, 'utf8').replace(/PLAN-x-20260923-2200/g, 'PLAN-old-20260901-2200'));
    utimesSync(older, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));
    const { status, out } = l3(statePath, 'plan');
    assert.equal(status, 0, out);
    assert.match(out, /PLAN-x-20260923-2200/);
    assert.doesNotMatch(out, /PLAN-old/, '取了更早的那份');
    assert.match(out, /▶ F1 升级握手/);
    assert.match(out, /⚑ 升级单 E-1/);
    assert.match(out, /IVAL-7/);
    assert.match(out, /plan decide E-1 --action/);
  });

  test('l3 plan 另列源方案未纳入；不把源 skipped 显示成检视者跳过', async () => {
    const { statePath, store } = await nightInProgress();
    const snap = store.read()!.toSnapshot();
    const withExclusions = {
      ...snap,
      sourceExclusions: [
        {
          featureId: 'A4',
          title: '软预算',
          sourceStatus: 'skipped',
          reason: '本次未纳入：源方案标 skipped；查看 skipReason，重新开工须由 L3 修订。',
        },
      ],
    };
    writeFileSync(store.path, JSON.stringify(withExclusions, null, 2));
    const { status, out } = l3(statePath, 'plan');
    assert.equal(status, 0, out);
    assert.match(out, /本次未纳入（源方案，不是本次运行的检视者跳过）/);
    assert.match(out, /A4 源状态 skipped/);
    const a4 = out.split(/\r?\n/).find((l) => l.includes('A4')) ?? '';
    assert.doesNotMatch(a4, /⊘/);
    assert.match(out, /▶ F1/);
  });

  test('只读命令不写主状态文件：刚开、还没打第一次心跳的 attempt 不能被它判死', async () => {
    const { statePath } = await nightInProgress();
    // 另一个进程（run-plan）刚开了一跳：attempt 已落盘，spawn 还没回来，没心跳。
    const writer = await buildPersistentPlatform(statePath, { workspace: new InPlaceWorkspaceManager() });
    await writer.platform.createMission({
      projectId: 'P',
      missionId: 'PLAN-x-20260923-2200-F1',
      contract: { intent: 'x', acceptance: ['x'], constraints: [], nonGoals: [], guardrails: [] },
    });
    await writer.platform.startCoordinatorAttempt('PLAN-x-20260923-2200-F1');
    writer.persist();
    const before = readFileSync(statePath, 'utf8');

    for (const args of [['plan'], ['show', 'PLAN-x-20260923-2200-F1'], ['inbox']]) {
      const { status, out } = l3(statePath, ...args);
      assert.equal(status, 0, out);
      assert.equal(readFileSync(statePath, 'utf8'), before, `l3 ${args[0]} 改写了主状态文件`);
    }
    // 直接看落盘的那一跳：还在进行中，没被判成 interrupted。
    const onDisk = JSON.parse(readFileSync(statePath, 'utf8')) as {
      projects: { missions: { coordinatorAttempts: { status: string; endedBy?: string }[] }[] }[];
    };
    const attempt = onDisk.projects[0].missions[0].coordinatorAttempts[0];
    assert.equal(attempt.status, 'in_progress');
    assert.equal(attempt.endedBy, undefined);
  });
});

describe('l3 plan decide：写回决定', () => {
  test('run-plan 握着主状态锁时照样能定；决定落进方案运行记录', async () => {
    const { statePath, store } = await nightInProgress();
    const release = acquireLock(statePath, 'run-plan PLAN-x');
    try {
      const { status, out } = l3(
        statePath,
        'plan', 'decide', 'E-1', '--action', 'rescope', '--reason', 'F3 用到 F1 的新字段', '--drop', 'F3', '--as', 'claude',
      );
      assert.equal(status, 0, out);
    } finally {
      release();
    }
    const resolution = store.read()?.escalations[0].resolution;
    assert.equal(resolution?.kind, 'decided');
    assert.equal(resolution?.kind === 'decided' ? resolution.action : '', 'rescope');
    assert.deepEqual(resolution?.kind === 'decided' ? resolution.dropFeatures : [], ['F3']);
    assert.equal(store.read()?.feature('F3')?.status, 'skipped');
  });

  test('不重划的动作不带名单也能定：没给 --drop 就是没给', async () => {
    const { statePath, store } = await nightInProgress();
    const { status, out } = l3(statePath, 'plan', 'decide', 'E-1', '--action', 'skip', '--reason', '夹具冲突', '--as', 'claude');
    assert.equal(status, 0, out);
    const resolution = store.read()?.escalations[0].resolution;
    assert.equal(resolution?.kind === 'decided' ? resolution.action : '', 'skip');
    assert.equal(store.read()?.feature('F1')?.status, 'skipped');
  });

  test('规则拒绝的：非零退出、说清为什么、记录一字不动', async () => {
    const { statePath, store } = await nightInProgress();
    const before = JSON.stringify(store.read()?.toSnapshot());
    const cases: [string[], RegExp][] = [
      [['--action', 'merge', '--reason', 'x', '--as', 'claude'], /没有「通过」也没有「合并」/],
      [['--action', 'skip', '--reason', 'x', '--as', 'mallory'], /指定的检视者是 claude/],
      [['--action', 'skip', '--as', 'claude'], /理由/],
      [['--action', 'skip', '--reason', 'x'], /--as/],
    ];
    for (const [flags, why] of cases) {
      const { status, out } = l3(statePath, 'plan', 'decide', 'E-1', ...flags);
      assert.notEqual(status, 0, out);
      assert.match(out, why);
    }
    assert.equal(JSON.stringify(store.read()?.toSnapshot()), before);
  });
});
