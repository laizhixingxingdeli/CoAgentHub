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
import { execFileSync, spawnSync } from 'node:child_process';
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

async function haReleaseRun(options?: { deadline?: string; stopped?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-l3-ha-'));
  dirs.push(dir);
  const statePath = join(dir, 'state.json');
  const recordPath = join(dir, 'run.json');
  const store = new FilePlanRunStore(recordPath);
  const now = new Date().toISOString();
  const run = PlanRun.start({ id: 'R-HA', planId: 'P', projectId: 'P', integrationBranch: 'main', reviewer: 'claude', stopConditions: { unresolvedEscalations: 2, wallClockMs: 8 * MIN, escalationTimeoutMs: 20 * MIN }, featureIds: ['F1', 'F2'], startedAt: now });
  run.startFeature('F1', 'M-F1');
  run.suspendFeature('F1', 'HA 等待');
  run.startFeature('F2', 'M-F2');
  run.suspendFeature('F2', 'HA 等待');
  const release = (featureId: string, missionId: string) => ({ featureId, missionId, reviewedCommit: 'sha1', attemptId: `A-${featureId}`, validationReportId: `VR-${featureId}`, reviewerId: 'claude', integrationBranch: 'main', openedAt: options?.deadline ? new Date(Date.parse(options.deadline) - MIN).toISOString() : now, deadline: options?.deadline ?? new Date(Date.now() + 60 * MIN).toISOString(), verification: [{ command: 'node --test', timeoutMs: 10_000 }] });
  run.openHaRelease(release('F1', 'M-F1'));
  run.openHaRelease(release('F2', 'M-F2'));
  await store.create(run);
  if (options?.stopped) {
    const snapshot = run.toSnapshot();
    writeFileSync(recordPath, JSON.stringify({ ...snapshot, stopped: { at: now, reason: 'crashed', detail: 'test' } }));
  }
  return { dir, statePath, recordPath, store };
}

function haArgs(recordPath: string, ...extra: string[]) {
  return ['plan', 'approve', 'M-F1', '--feature', 'F1', '--commit', 'sha1', '--review', 'A-F1', '--report', 'VR-F1', '--target', 'main', '--as', 'claude', '--confirmed-by', 'human', '--run', recordPath, ...extra];
}

function replaceFlag(args: string[], flag: string, value: string): string[] {
  const index = args.indexOf(flag);
  args[index + 1] = value;
  return args;
}

describe('l3 plan HA 签字：子进程', () => {
  test('approve 与 send-back 成功记录唯一决定及签字声明', async () => {
    for (const action of ['approve', 'send-back'] as const) {
      const { statePath, recordPath, store } = await haReleaseRun();
      const args = haArgs(recordPath);
      if (action === 'send-back') args.splice(1, 1, 'send-back');
      if (action === 'send-back') args.push('--reason', '补齐证据');
      const result = l3(statePath, ...args);
      assert.equal(result.status, 0, result.out);
      const decision = store.read()?.haReleases.find((r) => r.featureId === 'F1')?.decision;
      assert.equal(decision?.kind, action === 'approve' ? 'approve' : 'send_back');
      assert.equal(decision?.by, 'claude');
      assert.equal(decision?.confirmedBy, 'human');
      if (action === 'send-back') assert.equal(decision?.reason, '补齐证据');
    }
  });

  test('每类拒绝均非零退出且记录字节不变', async () => {
    const cases: Array<{ name: string; why: RegExp; args?: (path: string) => string[]; options?: { deadline?: string; stopped?: boolean } }> = [
      { name: '错 feature', why: /没有该功能的待决记录/, args: (p) => replaceFlag(haArgs(p), '--feature', 'NO') },
      { name: '错 Mission', why: /HA_RELEASE_REJECTED|待放行绑定/, args: (p) => ['plan','approve','WRONG', ...haArgs(p).slice(3)] },
      { name: '错提交', why: /HA_RELEASE_REJECTED|待放行绑定/, args: (p) => replaceFlag(haArgs(p), '--commit', 'wrong') },
      { name: '错检视', why: /HA_RELEASE_REJECTED|待放行绑定/, args: (p) => replaceFlag(haArgs(p), '--review', 'wrong') },
      { name: '错报告', why: /HA_RELEASE_REJECTED|待放行绑定/, args: (p) => replaceFlag(haArgs(p), '--report', 'wrong') },
      { name: '错目标', why: /HA_RELEASE_REJECTED|待放行绑定/, args: (p) => replaceFlag(haArgs(p), '--target', 'other') },
      { name: '非指定检视者', why: /HA_RELEASE_REJECTED|待放行绑定/, args: (p) => replaceFlag(haArgs(p), '--as', 'other') },
      { name: '缺 --as', why: /--as/, args: (p) => haArgs(p).filter((x, i, a) => x !== '--as' && a[i - 1] !== '--as') },
      { name: '缺 --confirmed-by', why: /--confirmed-by/, args: (p) => haArgs(p).filter((x, i, a) => x !== '--confirmed-by' && a[i - 1] !== '--confirmed-by') },
      { name: '缺 --run', why: /--run/, args: (p) => haArgs(p).filter((x, i, a) => x !== '--run' && a[i - 1] !== '--run') },
      { name: '缺 Mission id', why: /Mission id/, args: (p) => { const a = haArgs(p); a.splice(2, 1); return a; } },
      { name: '错 run', why: /HA_RELEASE_REJECTED|没有该功能的待决记录/ },
      { name: '非法 --as', why: /--as 的值不能只是空白/, args: (p) => replaceFlag(haArgs(p), '--as', '   ') },
      { name: '非法 --confirmed-by', why: /--confirmed-by 的值不能只是空白/, args: (p) => replaceFlag(haArgs(p), '--confirmed-by', '   ') },
      { name: '过期', why: /HA_RELEASE_REJECTED|截止/, options: { deadline: new Date(Date.now() - 60_000).toISOString() } },
      { name: '已停运行', why: /PLAN_RUN_STOPPED|停止/, options: { stopped: true } },
      { name: 'send-back 缺理由', why: /reason|理由/, args: (p) => { const a = haArgs(p); a[1] = 'send-back'; return a; } },
    ];
    for (const item of cases) {
      const { dir, statePath, recordPath } = await haReleaseRun(item.options);
      const before = readFileSync(recordPath);
      let otherRunPath: string | undefined;
      let otherRunBefore: Buffer | undefined;
      if (item.name === '错 run') {
        otherRunPath = join(dir, 'other-run.json');
        const otherStore = new FilePlanRunStore(otherRunPath);
        await otherStore.create(PlanRun.start({ id: 'OTHER-RUN', planId: 'P', projectId: 'P', integrationBranch: 'main', reviewer: 'claude', stopConditions: { unresolvedEscalations: 2, wallClockMs: 8 * MIN, escalationTimeoutMs: 20 * MIN }, featureIds: ['F1'], startedAt: new Date().toISOString() }));
        otherRunBefore = readFileSync(otherRunPath);
      }
      const args = item.args?.(recordPath) ?? (otherRunPath ? replaceFlag(haArgs(recordPath), '--run', otherRunPath) : haArgs(recordPath));
      const result = l3(statePath, ...args);
      assert.notEqual(result.status, 0, `${item.name}: ${result.out}`);
      assert.ok(result.out.length > 0, `${item.name}: 应说明拒绝原因`);
      assert.match(result.out, item.why, `${item.name}: 输出应指出拒绝缘由`);
      assert.deepEqual(readFileSync(recordPath), before, `${item.name}: 拒绝不得写原记录`);
      if (otherRunPath && otherRunBefore) assert.deepEqual(readFileSync(otherRunPath), otherRunBefore, `${item.name}: 拒绝不得写目标记录`);
    }
  });

  test('重复签拒绝；主状态锁被占仍能签，平台状态和 Git HEAD 不变', async () => {
    const { dir, statePath, recordPath, store } = await haReleaseRun();
    const platform = await buildPersistentPlatform(statePath, { workspace: new InPlaceWorkspaceManager() });
    await platform.persist();
    const stateBefore = readFileSync(statePath);
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'file'), 'x');
    execFileSync('git', ['-C', repo, 'add', 'file']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'init']);
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const releaseLock = acquireLock(statePath, 'run-plan');
    let first;
    try { first = l3(statePath, ...haArgs(recordPath)); } finally { releaseLock(); }
    assert.equal(first!.status, 0, first!.out);
    assert.deepEqual(readFileSync(statePath), stateBefore);
    assert.equal(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }), head);
    const before = readFileSync(recordPath);
    const second = l3(statePath, ...haArgs(recordPath));
    assert.notEqual(second.status, 0, second.out);
    assert.deepEqual(readFileSync(recordPath), before);
    assert.equal(store.read()?.haReleases.find((r) => r.featureId === 'F1')?.decision?.kind, 'approve');
  });

  test('决定与过期按两个确定顺序争锁，败方拒绝且不覆盖终结值', async () => {
    const { statePath, recordPath, store } = await haReleaseRun();
    const afterDeadline = new Date(Date.now() + 90 * MIN).toISOString();
    await store.update((run) => run.expireHaRelease('F1', afterDeadline));
    const before = readFileSync(recordPath);
    const late = l3(statePath, ...haArgs(recordPath));
    assert.notEqual(late.status, 0, late.out);
    assert.deepEqual(readFileSync(recordPath), before);
    assert.equal(store.read()?.haReleases.find((r) => r.featureId === 'F1')?.decision?.kind, 'expired');

    const second = await haReleaseRun();
    const signed = l3(second.statePath, ...haArgs(second.recordPath));
    assert.equal(signed.status, 0, signed.out);
    const signedBytes = readFileSync(second.recordPath);
    await assert.rejects(second.store.update((run) => run.expireHaRelease('F1', afterDeadline)));
    assert.deepEqual(readFileSync(second.recordPath), signedBytes);
    assert.equal(second.store.read()?.haReleases.find((r) => r.featureId === 'F1')?.decision?.kind, 'approve');
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

  test('超额 rerun_isolated：非零退出，输出含功能 id / 已用 / 上限，记录文件字节不变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-l3-plan-'));
    dirs.push(dir);
    const statePath = join(dir, 'state.json');
    const store = new FilePlanRunStore(join(dir, '.coagent-plans', 'PLAN-x.json'));
    const now = new Date();
    const iso = now.toISOString();
    await store.create(
      PlanRun.start({
        id: 'PLAN-x-cap',
        planId: 'PLAN-x',
        projectId: 'P',
        integrationBranch: 'auto/plan-x',
        reviewer: 'claude',
        stopConditions: {
          unresolvedEscalations: 5,
          wallClockMs: 8 * 60 * MIN,
          escalationTimeoutMs: 20 * MIN,
          maxRerunsPerFeature: 1,
        },
        featureIds: ['F1'],
        titles: { F1: '升级握手' },
        startedAt: iso,
      }),
    );
    await store.update((run) => {
      run.startFeature('F1', 'M-F1');
      run.openEscalation(
        { featureId: 'F1', missionId: 'M-F1', failure: '红', question: '重跑吗？' },
        iso,
      );
    });
    const first = l3(
      statePath,
      'plan', 'decide', 'E-1', '--action', 'rerun_isolated', '--reason', '再来', '--as', 'claude',
    );
    assert.equal(first.status, 0, first.out);
    await store.update((run) => {
      run.startFeature('F1', 'M-F1-r2');
      run.openEscalation(
        { featureId: 'F1', missionId: 'M-F1-r2', failure: '又红', question: '还重跑吗？' },
        new Date().toISOString(),
      );
    });
    const before = readFileSync(store.path);
    const second = l3(
      statePath,
      'plan', 'decide', 'E-2', '--action', 'rerun_isolated', '--reason', '还来', '--as', 'claude',
    );
    assert.notEqual(second.status, 0, second.out);
    assert.match(second.out, /F1/);
    assert.match(second.out, /1/);
    assert.equal(readFileSync(store.path).equals(before), true);
  });
});

describe('l3 plan：额度展示', () => {
  test('l3 plan 显示升级单已开数/上限，开着的功能显示重跑已用/上限', async () => {
    const { statePath } = await nightInProgress();
    const { status, out } = l3(statePath, 'plan');
    assert.equal(status, 0, out);
    assert.match(out, /升级单 1\/5/);
    assert.match(out, /重跑 0\/1/);
  });
});
