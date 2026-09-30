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
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_VERSION } from '../src/api/server.ts';
import {
  acquireLock,
  probeLocalWriter,
  publishLockPort,
  stateIdFor,
} from '../src/application/lock.ts';
import {
  LoopbackIdentityError,
  loopbackControlRequest,
} from '../src/application/loopback-control-client.ts';
import { PlanRun } from '../src/application/plan-run.ts';
import { FilePlanRunStore } from '../src/application/plan-run-store.ts';
import type { AgentRunSpec } from '../src/application/ports.ts';
import { GitWorktreeManager, InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';
import { buildPersistentPlatform, startServer } from '../src/main.ts';
import { ScriptedRuntime, type ScriptTable } from '../src/runtime/scripted.ts';

const L3 = fileURLToPath(new URL('../src/l3.ts', import.meta.url));
const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const MIN = 60_000;

const WRITE_CONTRACT: MissionContract = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const WRITE_ORDER: WorkOrder = {
  objective: '改 a.txt',
  allowedScope: ['a.txt'],
  requiredBehaviour: 'a.txt 内容变成 mission',
  constraints: [],
  acceptance: ['内容是 mission'],
  verification: ['cat a.txt'],
  doNot: [],
  contextRefs: [],
};

const WRITE_PLAN = {
  findings: 'f',
  rejectedHypotheses: [],
  decisions: [],
  direction: 'd',
  risks: [],
};

const dirs: string[] = [];
const liveServers: Server[] = [];
after(() => {
  for (const server of liveServers) {
    if (!server.listening) continue;
    try {
      server.close();
    } catch {
      /* already closed */
    }
  }
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

/** 可答复升级单：协调者原问绑在 E-1 上。 */
async function nightAnswerable(options?: { openedAgoMin?: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-l3-plan-'));
  dirs.push(dir);
  const statePath = join(dir, 'state.json');
  const store = new FilePlanRunStore(join(dir, '.coagent-plans', 'PLAN-x-20260923-2200.json'));
  const openedAt = new Date(Date.now() - (options?.openedAgoMin ?? 0) * MIN).toISOString();
  const startedAt = new Date(Date.parse(openedAt) - MIN).toISOString();
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
      startedAt,
    }),
  );
  await store.update((run) => {
    run.startFeature('F1', 'PLAN-x-20260923-2200-F1');
    run.openEscalation(
      {
        featureId: 'F1',
        missionId: 'PLAN-x-20260923-2200-F1',
        failure: '协调者提问',
        question: '这个 missionId 对不对？',
        answerable: true,
      },
      openedAt,
    );
  });
  return { dir, statePath, store };
}

function l3(statePath: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [L3, ...args, '--state', statePath], { encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** 本进程在听 HTTP 时不能 spawnSync：会堵住事件循环，探活超时。 */
function l3Async(statePath: string, ...args: string[]) {
  return new Promise<{ status: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [L3, ...args, '--state', statePath]);
    let out = '';
    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('close', (status) => resolve({ status, out }));
  });
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
    assert.doesNotMatch(out, /--action answer/);
    assert.doesNotMatch(out, /原问/);
  });

  test('可答复单给出原问和答复命令；其它失败仍只有四动作', async () => {
    const answerable = await nightAnswerable();
    const shown = l3(answerable.statePath, 'plan');
    assert.equal(shown.status, 0, shown.out);
    assert.match(shown.out, /原问：这个 missionId 对不对？/);
    assert.match(shown.out, /plan decide E-1 --action <rerun_isolated\|skip\|rescope\|stop>/);
    assert.match(shown.out, /plan decide E-1 --action answer --answer "…" --as claude --run /);

    const { statePath } = await nightInProgress();
    const other = l3(statePath, 'plan');
    assert.equal(other.status, 0, other.out);
    assert.doesNotMatch(other.out, /原问/);
    assert.doesNotMatch(other.out, /--action answer/);
    assert.match(other.out, /plan decide E-1 --action/);
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

    for (const args of [['plan'], ['show', 'PLAN-x-20260923-2200-F1'], ['inbox'], ['runs', 'PLAN-x-20260923-2200-F1']]) {
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

  test('answer 可省 reason：结论写入记录，主状态不变，功能仍 running', async () => {
    const first = await nightAnswerable();
    const platform = await buildPersistentPlatform(first.statePath, { workspace: new InPlaceWorkspaceManager() });
    await platform.persist();
    const stateBefore = readFileSync(first.statePath);
    const release = acquireLock(first.statePath, 'run-plan PLAN-x');
    try {
      const { status, out } = l3(
        first.statePath,
        'plan', 'decide', 'E-1', '--action', 'answer', '--answer', '  用这个 id  ', '--as', 'claude',
      );
      assert.equal(status, 0, out);
      assert.match(out, /answer —— 用这个 id/);
    } finally {
      release();
    }
    const resolution = first.store.read()?.escalations[0].resolution;
    assert.equal(resolution?.kind, 'decided');
    assert.equal(resolution?.kind === 'decided' && resolution.action === 'answer' ? resolution.answer : '', '用这个 id');
    assert.equal(resolution?.kind === 'decided' && resolution.action === 'answer' ? resolution.reason : 'x', undefined);
    assert.equal(first.store.read()?.feature('F1')?.status, 'running');
    assert.deepEqual(readFileSync(first.statePath), stateBefore);

    const second = await nightAnswerable();
    const withReason = l3(
      second.statePath,
      'plan', 'decide', 'E-1', '--action', 'answer', '--answer', '否', '--reason', '现场还在跑', '--as', 'claude',
    );
    assert.equal(withReason.status, 0, withReason.out);
    const r2 = second.store.read()?.escalations[0].resolution;
    assert.equal(r2?.kind === 'decided' && r2.action === 'answer' ? r2.reason : '', '现场还在跑');
    assert.equal(r2?.kind === 'decided' && r2.action === 'answer' ? r2.answer : '', '否');
  });

  test('answer 拒绝：非法单、已决/到期、空白/过长、错误 reviewer 均非零且记录字节不变', async () => {
    {
      const { statePath, store } = await nightInProgress();
      const before = readFileSync(store.path);
      const { status, out } = l3(
        statePath, 'plan', 'decide', 'E-1', '--action', 'answer', '--answer', '不行', '--as', 'claude',
      );
      assert.notEqual(status, 0, out);
      assert.match(out, /不是可答复单/);
      assert.deepEqual(readFileSync(store.path), before);
    }
    {
      const { statePath, store } = await nightAnswerable();
      const before = readFileSync(store.path);
      const { status, out } = l3(
        statePath, 'plan', 'decide', 'E-9', '--action', 'answer', '--answer', 'x', '--as', 'claude',
      );
      assert.notEqual(status, 0, out);
      assert.match(out, /没有升级单/);
      assert.deepEqual(readFileSync(store.path), before);
    }
    {
      const { statePath, store } = await nightAnswerable();
      const first = l3(
        statePath, 'plan', 'decide', 'E-1', '--action', 'answer', '--answer', '先定', '--as', 'claude',
      );
      assert.equal(first.status, 0, first.out);
      const before = readFileSync(store.path);
      const second = l3(
        statePath, 'plan', 'decide', 'E-1', '--action', 'answer', '--answer', '再定', '--as', 'claude',
      );
      assert.notEqual(second.status, 0, second.out);
      assert.match(second.out, /定过了/);
      assert.deepEqual(readFileSync(store.path), before);
    }
    {
      const { statePath, store } = await nightAnswerable({ openedAgoMin: 21 });
      const before = readFileSync(store.path);
      const { status, out } = l3(
        statePath, 'plan', 'decide', 'E-1', '--action', 'answer', '--answer', '晚了', '--as', 'claude',
      );
      assert.notEqual(status, 0, out);
      assert.match(out, /截止/);
      assert.deepEqual(readFileSync(store.path), before);
    }
    {
      const { statePath, store } = await nightAnswerable();
      const before = readFileSync(store.path);
      const { status, out } = l3(
        statePath, 'plan', 'decide', 'E-1', '--action', 'answer', '--answer', '   ', '--as', 'claude',
      );
      assert.notEqual(status, 0, out);
      assert.match(out, /答复必须是/);
      assert.deepEqual(readFileSync(store.path), before);
    }
    {
      const { statePath, store } = await nightAnswerable();
      const before = readFileSync(store.path);
      const { status, out } = l3(
        statePath, 'plan', 'decide', 'E-1', '--action', 'answer', '--answer', 'x'.repeat(4001), '--as', 'claude',
      );
      assert.notEqual(status, 0, out);
      assert.match(out, /答复必须是/);
      assert.deepEqual(readFileSync(store.path), before);
    }
    {
      const { statePath, store } = await nightAnswerable();
      const before = readFileSync(store.path);
      const { status, out } = l3(
        statePath, 'plan', 'decide', 'E-1', '--action', 'answer', '--answer', 'x', '--as', 'mallory',
      );
      assert.notEqual(status, 0, out);
      assert.match(out, /指定的检视者是 claude/);
      assert.deepEqual(readFileSync(store.path), before);
    }
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-l3-write-repo-'));
  dirs.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@local');
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function lockDirOf(statePath: string): string {
  const id = stateIdFor(statePath);
  return join(dirname(id), `.lock-${basename(id)}`);
}

async function driveToReview(
  platform: {
    recordWorkspace: (missionId: string, ref: { projectRoot?: string; branch: string; baseRevision: string }) => Promise<unknown>;
    startCoordinatorAttempt: (missionId: string) => Promise<{ attemptId: string }>;
    updatePlan: (missionId: string, attemptId: string, plan: typeof WRITE_PLAN) => Promise<unknown>;
    createWorkItem: (missionId: string, attemptId: string, input: { title: string; order: WorkOrder }) => Promise<{ workItemId: string }>;
    dispatchWorkItems: (missionId: string, attemptId: string, ids: string[]) => Promise<unknown>;
    startExecutorAttempt: (missionId: string, workItemId: string) => Promise<{ attemptId: string }>;
    submitEvidence: (missionId: string, attemptId: string, evidence: object) => Promise<unknown>;
    submitExecutionResult: (missionId: string, attemptId: string, result: object) => Promise<unknown>;
    finishAttempt: (missionId: string, attemptId: string, input: { endedBy: string }) => Promise<unknown>;
    reviewExecutionResult: (missionId: string, attemptId: string, review: object) => Promise<unknown>;
    submitMissionResult: (missionId: string, attemptId: string, result: object) => Promise<unknown>;
  },
  workspace: GitWorktreeManager,
  repo: string,
  missionId: string,
) {
  const prepared = await workspace.prepare(missionId, repo);
  await platform.recordWorkspace(missionId, {
    projectRoot: repo,
    branch: prepared.branch,
    baseRevision: prepared.baseRevision,
  });
  const coord = await platform.startCoordinatorAttempt(missionId);
  await platform.updatePlan(missionId, coord.attemptId, WRITE_PLAN);
  const { workItemId } = await platform.createWorkItem(missionId, coord.attemptId, {
    title: 'W',
    order: WRITE_ORDER,
  });
  await platform.dispatchWorkItems(missionId, coord.attemptId, [workItemId]);
  writeFileSync(join(prepared.cwd, 'a.txt'), 'mission\n');
  const exec = await platform.startExecutorAttempt(missionId, workItemId);
  await platform.submitEvidence(missionId, exec.attemptId, {
    kind: 'test',
    summary: 'node --test 全绿',
    command: 'node --test',
    exitCode: 0,
  });
  await platform.submitExecutionResult(missionId, exec.attemptId, {
    outcome: 'completed',
    summary: '改好了',
    changedFiles: ['a.txt'],
    evidenceIds: [],
    notes: '无',
  });
  await platform.finishAttempt(missionId, exec.attemptId, { endedBy: 'structured_submit' });
  await platform.reviewExecutionResult(missionId, coord.attemptId, {
    workItemId,
    verdict: 'accept',
    acceptanceResults: WRITE_ORDER.acceptance.map((criterion) => ({
      criterion,
      status: 'pass' as const,
      evidence: '测试替身：逐条核过',
    })),
    reasons: ['复跑过'],
    requiredChanges: [],
  });
  await platform.submitMissionResult(missionId, coord.attemptId, {
    outcome: 'delivered',
    summary: '交付',
    acceptanceEvidence: [],
    memoryDelta: [],
    openRisks: [],
  });
  await platform.finishAttempt(missionId, coord.attemptId, { endedBy: 'structured_submit' });
}

async function seedMainWrites() {
  const repo = tempRepo();
  const dir = mkdtempSync(join(tmpdir(), 'coagent-l3-writes-'));
  dirs.push(dir);
  const statePath = join(dir, 'state.json');
  const workspace = new GitWorktreeManager();
  const built = await buildPersistentPlatform(statePath, {
    workspace,
    reconcile: false,
    exclusive: { what: 'seed-writes' },
  });
  try {
    for (const id of ['M-merge', 'M-back', 'M-abandon'] as const) {
      // 各占一个 Project：awaiting_review 占着改动名额，同项目塞不下三条。
      await built.platform.createMission({ projectId: `P-${id}`, missionId: id, contract: WRITE_CONTRACT });
      await driveToReview(built.platform, workspace, repo, id);
    }
    await built.platform.createMission({ projectId: 'P-misc', missionId: 'M-answer', contract: WRITE_CONTRACT });
    const answerCoord = await built.platform.startCoordinatorAttempt('M-answer');
    await built.platform.escalateToL3('M-answer', answerCoord.attemptId, {
      question: '要不要继续？',
      why: '不确定',
      optionsConsidered: ['继续', '停'],
    });
    await built.platform.createMission({ projectId: 'P-misc', missionId: 'M-revise', contract: WRITE_CONTRACT });
    await built.platform.createMission({ projectId: 'P-misc', missionId: 'M-cancel', contract: WRITE_CONTRACT });
    await built.platform.createMission({ projectId: 'P-misc', missionId: 'M-pause', contract: WRITE_CONTRACT });
    await built.platform.createMission({ projectId: 'P-misc', missionId: 'M-resume', contract: WRITE_CONTRACT });
    await built.platform.pauseMission('M-resume');
    await built.platform.createMission({ projectId: 'P-misc', missionId: 'M-retire', contract: WRITE_CONTRACT });
    const retireCoord = await built.platform.startCoordinatorAttempt('M-retire');
    await built.platform.updatePlan('M-retire', retireCoord.attemptId, WRITE_PLAN);
    const retired = await built.platform.createWorkItem('M-retire', retireCoord.attemptId, {
      title: 'W',
      order: WRITE_ORDER,
    });
    await built.platform.createMission({ projectId: 'P-misc', missionId: 'M-rerun', contract: WRITE_CONTRACT });
    built.persist();
    const pending = await built.deliveries.pending();
    const deliveryId = pending[0]?.id;
    assert.ok(deliveryId, '升级应进收件箱');
    return {
      dir,
      repo,
      statePath,
      workItemId: retired.workItemId,
      deliveryId,
      contractFile: join(dir, 'new-contract.json'),
    };
  } finally {
    built.releaseLock();
  }
}

async function startLiveChild(statePath: string): Promise<{ stop: () => Promise<void> }> {
  // 服务必须在独立进程：父进程 spawnSync CLI 会堵住事件循环，同进程 HTTP 探活会超时。
  const child = spawn(process.execPath, [MAIN], {
    env: {
      ...process.env,
      COAGENT_STORE: 'file',
      COAGENT_STATE: statePath,
      PORT: '0',
      COAGENT_RECONCILE_INTERVAL_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    let started = false;
    const timer = setTimeout(() => {
      if (started) return;
      child.kill();
      reject(new Error(`常驻服务启动超时：${stderr}`));
    }, 20_000);
    child.stdout?.on('data', (chunk) => {
      if (started) return;
      if (String(chunk).includes('平台已启动')) {
        started = true;
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', (error) => {
      if (started) return;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (started) return;
      clearTimeout(timer);
      reject(new Error(`常驻服务提前退出 ${String(code)}：${stderr}`));
    });
  });
  return {
    stop: () =>
      new Promise((resolve) => {
        const done = () => resolve();
        child.once('exit', done);
        child.kill();
        setTimeout(() => {
          child.kill('SIGKILL');
          done();
        }, 3000);
      }),
  };
}

async function withWriter(
  statePath: string,
  mode: 'live' | 'exclusive',
  fn: () => void | Promise<void>,
): Promise<void> {
  if (mode === 'exclusive') {
    await fn();
    return;
  }
  const live = await startLiveChild(statePath);
  try {
    await fn();
  } finally {
    await live.stop();
  }
}

describe('l3 主写：探测与回环转发', () => {
  test('持锁常驻服务及无服务：11 个写命令成功', async () => {
    for (const mode of ['exclusive', 'live'] as const) {
      const fx = await seedMainWrites();
      writeFileSync(
        fx.contractFile,
        JSON.stringify({
          contract: {
            intent: '新契约',
            acceptance: ['绿'],
            constraints: [],
            nonGoals: [],
            guardrails: [],
          },
        }),
      );
      await withWriter(fx.statePath, mode, () => {
        const cases: Array<{ name: string; args: string[]; why: RegExp }> = [
          { name: 'merge', args: ['merge', 'M-merge', '--reason', 'ok', '--repo', fx.repo], why: /Mission M-merge → completed/ },
          { name: 'send-back', args: ['send-back', 'M-back', '--reason', '再改'], why: /Mission M-back → planning/ },
          { name: 'abandon', args: ['abandon', 'M-abandon', '--reason', '不做了'], why: /Mission M-abandon → blocked/ },
          { name: 'answer', args: ['answer', 'M-answer', '--answer', '继续'], why: /已答复 M-answer/ },
          { name: 'revise', args: ['revise', 'M-revise', '--contract', fx.contractFile], why: /Contract → r2/ },
          { name: 'cancel', args: ['cancel', 'M-cancel', '--reason', '停'], why: /已叫停/ },
          { name: 'pause', args: ['pause', 'M-pause'], why: /已暂停/ },
          { name: 'resume', args: ['resume', 'M-resume'], why: /已恢复/ },
          { name: 'retire', args: ['retire', 'M-retire', '--item', fx.workItemId, '--reason', '不做'], why: /已作废/ },
          { name: 'rerun', args: ['rerun', 'M-rerun', '--as', 'M-rerun-2'], why: /已另起一条：M-rerun-2/ },
          { name: 'ack', args: ['ack', fx.deliveryId], why: new RegExp(`${fx.deliveryId} 已确认`) },
        ];
        for (const item of cases) {
          const result = l3(fx.statePath, ...item.args);
          assert.equal(result.status, 0, `${mode} ${item.name}: ${result.out}`);
          assert.match(result.out, item.why, `${mode} ${item.name}`);
        }
      });
    }
  });

  test('持锁常驻服务及无服务：规则拒绝非零且错误可见；reviewer 不降级', async () => {
    for (const mode of ['exclusive', 'live'] as const) {
      const fx = await seedMainWrites();
      await withWriter(fx.statePath, mode, async () => {
        const before = readFileSync(fx.statePath);
        const prior: Array<{ name: string; args: string[]; why: RegExp }> = [
          { name: 'send-back 缺理由', args: ['send-back', 'M-back'], why: /--reason/ },
          { name: 'revise 缺文件', args: ['revise', 'M-revise'], why: /--contract/ },
          { name: 'retire 缺理由', args: ['retire', 'M-retire', '--item', fx.workItemId], why: /--reason/ },
        ];
        for (const item of prior) {
          const result = l3(fx.statePath, ...item.args);
          assert.notEqual(result.status, 0, `${mode} ${item.name} 应失败：${result.out}`);
          assert.match(result.out, item.why, `${mode} ${item.name}: ${result.out}`);
          assert.equal(readFileSync(fx.statePath).equals(before), true, `${mode} ${item.name} 改了状态`);
        }
        const afterAssembly: Array<{ name: string; args: string[]; why: RegExp }> = [
          { name: 'merge 未知', args: ['merge', 'NO-SUCH'], why: /不存在|UNKNOWN_MISSION/ },
          { name: 'answer 无升级', args: ['answer', 'M-revise', '--answer', 'x'], why: /没有待答复|NO_OPEN_ESCALATION/ },
          { name: 'cancel 未知', args: ['cancel', 'NO-SUCH'], why: /不存在|UNKNOWN_MISSION/ },
        ];
        for (const item of afterAssembly) {
          const result = l3(fx.statePath, ...item.args);
          assert.notEqual(result.status, 0, `${mode} ${item.name} 应失败：${result.out}`);
          assert.match(result.out, item.why, `${mode} ${item.name}: ${result.out}`);
          if (mode === 'live') {
            assert.equal(readFileSync(fx.statePath).equals(before), true, `${mode} ${item.name} 改了状态`);
          }
        }
        const signed = l3(
          fx.statePath,
          'merge',
          'M-merge',
          '--as',
          'claude',
          '--confirmed-by',
          'echo',
          '--repo',
          fx.repo,
        );
        assert.equal(signed.status, 0, `${mode} reviewer merge: ${signed.out}`);
        const revived = await buildPersistentPlatform(fx.statePath, { reconcile: false });
        const view = await revived.platform.getMissionView('M-merge');
        assert.equal(view.finalReview?.authority?.kind, 'reviewer');
        revived.releaseLock();
      });
    }
  });

  test('HA merge --as 不降级为普通 finalize', async () => {
    const repo = tempRepo();
    const dir = mkdtempSync(join(tmpdir(), 'coagent-l3-ha-fwd-'));
    dirs.push(dir);
    const statePath = join(dir, 'state.json');
    const workspace = new GitWorktreeManager();
    const built = await buildPersistentPlatform(statePath, {
      workspace,
      reconcile: false,
      exclusive: { what: 'seed-ha' },
    });
    const project = await built.projects.ensure('P');
    project.createMission({ id: 'M-HA', contract: WRITE_CONTRACT, executionMode: 'high_assurance' });
    await built.projects.save(project);
    await driveToReview(built.platform, workspace, repo, 'M-HA');
    built.persist();
    built.releaseLock();
    const before = readFileSync(statePath);
    await withWriter(statePath, 'live', () => {
      const result = l3(
        statePath,
        'merge',
        'M-HA',
        '--as',
        'claude',
        '--confirmed-by',
        'echo',
        '--repo',
        repo,
      );
      assert.notEqual(result.status, 0, result.out);
      assert.match(result.out, /HA_AUTHORITY|未配置授权/);
      assert.doesNotMatch(result.out, /本项不开放合并/);
      assert.equal(readFileSync(statePath).equals(before), true);
    });
  });

  test('残锁、活 PID 非匹配、端口不可达、身份不符：CLI 非零且主状态不变', async () => {
    const fx = await seedMainWrites();
    const before = readFileSync(fx.statePath);
    const mergeArgs = ['merge', 'M-merge', '--reason', 'ok', '--repo', fx.repo];

    mkdirSync(lockDirOf(fx.statePath));
    const residual = l3(fx.statePath, ...mergeArgs);
    assert.notEqual(residual.status, 0, residual.out);
    assert.match(residual.out, /无法安全转发|占用|缺失|损坏/);
    assert.equal(readFileSync(fx.statePath).equals(before), true);
    rmSync(lockDirOf(fx.statePath), { recursive: true, force: true });

    const instanceId = 'inst-mismatch';
    const release = acquireLock(fx.statePath, '常驻', { instanceId, apiVersion: API_VERSION });
    try {
      const { server, port } = await listenHealth({
        instanceId: 'inst-other',
        stateId: stateIdFor(fx.statePath),
        api: API_VERSION,
      });
      publishLockPort(fx.statePath, instanceId, port);
      const mismatch = await l3Async(fx.statePath, ...mergeArgs);
      assert.notEqual(mismatch.status, 0, mismatch.out);
      assert.match(mismatch.out, /无法安全转发|实例/);
      assert.equal(readFileSync(fx.statePath).equals(before), true);
      server.close();

      const closed = createServer();
      liveServers.push(closed);
      const closedPort = await new Promise<number>((resolve, reject) => {
        closed.once('error', reject);
        closed.listen(0, '127.0.0.1', () => resolve((closed.address() as AddressInfo).port));
      });
      await new Promise<void>((done, fail) => closed.close((err) => (err ? fail(err) : done())));
      publishLockPort(fx.statePath, instanceId, closedPort);
      const unreachable = l3(fx.statePath, ...mergeArgs);
      assert.notEqual(unreachable.status, 0, unreachable.out);
      assert.match(unreachable.out, /无法安全转发|连接不可达|断线/);
      assert.equal(readFileSync(fx.statePath).equals(before), true);
    } finally {
      release();
    }
  });

  test('Mission park 与带 answer 的 resume 经唯一持锁服务转发', async () => {
    const { statePath } = await emptyPlanState();
    const instanceId = 'inst-mission-park';
    const stateId = stateIdFor(statePath);
    const release = acquireLock(statePath, '常驻', { instanceId, apiVersion: API_VERSION });
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const server = createServer(async (req, res) => {
      const path = String(req.url ?? '/').split('?')[0];
      if (req.method === 'GET' && path === '/api/health') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'x-coagent-api': API_VERSION,
          'x-coagent-instance': instanceId,
          'x-coagent-state-id': stateId,
        });
        res.end(JSON.stringify({ ok: true, api: API_VERSION }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      requests.push({ method: req.method ?? '', path, body });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'x-coagent-api': API_VERSION,
        'x-coagent-instance': instanceId,
        'x-coagent-state-id': stateId,
      });
      res.end(JSON.stringify({ status: 'parked' }));
    });
    liveServers.push(server);
    try {
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      });
      publishLockPort(statePath, instanceId, port);
      const parked = await l3Async(statePath, 'park', 'M-park', '--reason', '等用户', '--as', 'reviewer');
      assert.equal(parked.status, 0, parked.out);
      const resumed = await l3Async(statePath, 'resume', 'M-park', '--answer', '继续', '--reason', '已答复', '--as', 'reviewer');
      assert.equal(resumed.status, 0, resumed.out);
      assert.deepEqual(requests, [
        { method: 'POST', path: '/api/missions/M-park/park', body: { reason: '等用户', reviewer: 'reviewer' } },
        { method: 'POST', path: '/api/missions/M-park/parked-resume', body: { answer: '继续', reason: '已答复', reviewer: 'reviewer' } },
      ]);
      assert.throws(() => acquireLock(statePath, 'second-writer', { instanceId: 'inst-second', apiVersion: API_VERSION }));
    } finally {
      release();
      await closeServer(server);
    }
  });

  test('probe live 但写应答身份不符：非零且不离线回退', async () => {
    const fx = await seedMainWrites();
    const before = readFileSync(fx.statePath);
    const instanceId = 'inst-live-ok';
    const stateId = stateIdFor(fx.statePath);
    const release = acquireLock(fx.statePath, '常驻', { instanceId, apiVersion: API_VERSION });
    try {
      const server = createServer((req, res) => {
        const path = String(req.url ?? '/').split('?')[0];
        if (req.method === 'GET' && path === '/api/health') {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'x-coagent-api': API_VERSION,
            'x-coagent-instance': instanceId,
            'x-coagent-state-id': stateId,
          });
          res.end(JSON.stringify({ ok: true, api: API_VERSION }));
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'x-coagent-api': API_VERSION,
          'x-coagent-instance': 'inst-drifted',
          'x-coagent-state-id': stateId,
        });
        res.end(JSON.stringify({ status: 'completed' }));
      });
      liveServers.push(server);
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      });
      publishLockPort(fx.statePath, instanceId, port);
      const result = await l3Async(fx.statePath, 'merge', 'M-merge', '--reason', 'ok', '--repo', fx.repo);
      assert.notEqual(result.status, 0, result.out);
      assert.match(result.out, /实例漂移/);
      assert.equal(readFileSync(fx.statePath).equals(before), true);
    } finally {
      release();
    }
  });

  test('假 health 的 stateId/API 版本不匹配：CLI 非零且主状态不变', async () => {
    const fx = await seedMainWrites();
    const before = readFileSync(fx.statePath);
    const mergeArgs = ['merge', 'M-merge', '--reason', 'ok', '--repo', fx.repo];
    const instanceId = 'inst-health-mismatch';
    const canonical = stateIdFor(fx.statePath);
    const release = acquireLock(fx.statePath, '常驻', { instanceId, apiVersion: API_VERSION });
    try {
      const { server: stateServer, port: statePort } = await listenHealth({
        instanceId,
        stateId: canonical + '-other',
        api: API_VERSION,
      });
      publishLockPort(fx.statePath, instanceId, statePort);
      const stateMismatch = await l3Async(fx.statePath, ...mergeArgs);
      assert.notEqual(stateMismatch.status, 0, stateMismatch.out);
      assert.match(stateMismatch.out, /无法安全转发|状态/);
      assert.equal(readFileSync(fx.statePath).equals(before), true);
      stateServer.close();

      const { server: apiServer, port: apiPort } = await listenHealth({
        instanceId,
        stateId: canonical,
        api: `${API_VERSION}-other`,
      });
      publishLockPort(fx.statePath, instanceId, apiPort);
      const apiMismatch = await l3Async(fx.statePath, ...mergeArgs);
      assert.notEqual(apiMismatch.status, 0, apiMismatch.out);
      assert.match(apiMismatch.out, /无法安全转发|API 版本/);
      assert.equal(readFileSync(fx.statePath).equals(before), true);
      apiServer.close();
    } finally {
      release();
    }
  });

  test('probe live 但写应答 API 版本不符：非零且不离线回退', async () => {
    const fx = await seedMainWrites();
    const before = readFileSync(fx.statePath);
    const instanceId = 'inst-live-api';
    const stateId = stateIdFor(fx.statePath);
    const release = acquireLock(fx.statePath, '常驻', { instanceId, apiVersion: API_VERSION });
    try {
      const server = createServer((req, res) => {
        const path = String(req.url ?? '/').split('?')[0];
        if (req.method === 'GET' && path === '/api/health') {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'x-coagent-api': API_VERSION,
            'x-coagent-instance': instanceId,
            'x-coagent-state-id': stateId,
          });
          res.end(JSON.stringify({ ok: true, api: API_VERSION }));
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'x-coagent-api': `${API_VERSION}-other`,
          'x-coagent-instance': instanceId,
          'x-coagent-state-id': stateId,
        });
        res.end(JSON.stringify({ status: 'completed' }));
      });
      liveServers.push(server);
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      });
      publishLockPort(fx.statePath, instanceId, port);
      const result = await l3Async(fx.statePath, 'merge', 'M-merge', '--reason', 'ok', '--repo', fx.repo);
      assert.notEqual(result.status, 0, result.out);
      assert.match(result.out, /错误版本/);
      assert.equal(readFileSync(fx.statePath).equals(before), true);
    } finally {
      release();
    }
  });

  test('probe live→回环写：同一状态大小写 Windows 接受、非 Windows 拒绝；错误实例/版本一律拒', async () => {
    const fx = await seedMainWrites();
    const before = readFileSync(fx.statePath);
    const instanceId = 'inst-case-write';
    const canonical = stateIdFor(fx.statePath);
    const folded = flipAsciiCase(canonical);
    assert.notEqual(folded, canonical);
    const release = acquireLock(fx.statePath, '常驻', { instanceId, apiVersion: API_VERSION });
    try {
      const server = createServer((req, res) => {
        const path = String(req.url ?? '/').split('?')[0];
        if (req.method === 'GET' && path === '/api/health') {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'x-coagent-api': API_VERSION,
            'x-coagent-instance': instanceId,
            'x-coagent-state-id': canonical,
          });
          res.end(JSON.stringify({ ok: true, api: API_VERSION }));
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'x-coagent-api': queryParam(req.url, 'api') ?? API_VERSION,
          'x-coagent-instance': queryParam(req.url, 'instance') ?? instanceId,
          'x-coagent-state-id': queryParam(req.url, 'state') ?? folded,
        });
        res.end(JSON.stringify({ status: 'completed' }));
      });
      liveServers.push(server);
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      });
      publishLockPort(fx.statePath, instanceId, port);

      const cli = await l3Async(fx.statePath, 'merge', 'M-merge', '--reason', 'ok', '--repo', fx.repo);
      if (process.platform === 'win32') {
        assert.equal(cli.status, 0, cli.out);
        assert.match(cli.out, /Mission M-merge → completed/);
      } else {
        assert.notEqual(cli.status, 0, cli.out);
        assert.match(cli.out, /状态身份不符/);
      }
      assert.equal(readFileSync(fx.statePath).equals(before), true);

      const target = {
        port,
        instanceId,
        stateId: canonical,
        apiVersion: API_VERSION,
      };
      const asWin = await loopbackControlRequest(
        target,
        { method: 'POST', path: '/api/missions/M-merge/finalize', body: { verdict: 'merge', reasons: ['ok'] } },
        { treatStateIdAsWindows: true },
      );
      assert.deepEqual(asWin, { status: 'completed' });

      await assert.rejects(
        () =>
          loopbackControlRequest(
            target,
            { method: 'POST', path: '/api/missions/M-merge/finalize', body: { verdict: 'merge', reasons: ['ok'] } },
            { treatStateIdAsWindows: false },
          ),
        (error: unknown) => error instanceof LoopbackIdentityError && /状态身份不符/.test(error.message),
      );

      await assert.rejects(
        () =>
          loopbackControlRequest(
            target,
            {
              method: 'POST',
              path: '/api/missions/M-merge/finalize?state=' + encodeURIComponent(canonical + '-other'),
              body: { verdict: 'merge', reasons: ['ok'] },
            },
            { treatStateIdAsWindows: true },
          ),
        (error: unknown) => error instanceof LoopbackIdentityError && /状态身份不符/.test(error.message),
      );

      await assert.rejects(
        () =>
          loopbackControlRequest(
            target,
            {
              method: 'POST',
              path: '/api/missions/M-merge/finalize?instance=inst-other',
              body: { verdict: 'merge', reasons: ['ok'] },
            },
            { treatStateIdAsWindows: true },
          ),
        (error: unknown) => error instanceof LoopbackIdentityError && /实例漂移/.test(error.message),
      );

      await assert.rejects(
        () =>
          loopbackControlRequest(
            target,
            {
              method: 'POST',
              path: `/api/missions/M-merge/finalize?api=${encodeURIComponent(API_VERSION + '-other')}`,
              body: { verdict: 'merge', reasons: ['ok'] },
            },
            { treatStateIdAsWindows: true },
          ),
        (error: unknown) => error instanceof LoopbackIdentityError && /错误版本/.test(error.message),
      );
    } finally {
      release();
    }
  });

  test('空锁启动竞争不产生无锁第二写者', async () => {
    const fx = await seedMainWrites();
    const spawnOnce = (args: string[]) =>
      new Promise<{ status: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, [L3, ...args, '--state', fx.statePath]);
        let out = '';
        child.stdout?.on('data', (chunk) => {
          out += String(chunk);
        });
        child.stderr?.on('data', (chunk) => {
          out += String(chunk);
        });
        child.on('close', (status) => resolve({ status, out }));
      });
    const [a, b] = await Promise.all([
      spawnOnce(['merge', 'M-merge', '--reason', 'ok', '--repo', fx.repo]),
      spawnOnce(['merge', 'M-merge', '--reason', 'ok', '--repo', fx.repo]),
    ]);
    const oks = [a, b].filter((row) => row.status === 0);
    const fails = [a, b].filter((row) => row.status !== 0);
    assert.equal(oks.length, 1, `${a.out}\n---\n${b.out}`);
    assert.equal(fails.length, 1);
    const revived = await buildPersistentPlatform(fx.statePath, { reconcile: false });
    const view = await revived.platform.getMissionView('M-merge');
    assert.equal(view.status, 'completed');
    revived.releaseLock();
  });

  test('plan decide/approve 与 inbox/show/runs 不被主锁阻塞；帮助说明 AQ1', async () => {
    const { statePath, store } = await nightInProgress();
    const ha = await haReleaseRun();
    const residualDir = lockDirOf(statePath);
    mkdirSync(residualDir);
    const inbox = l3(statePath, 'inbox');
    assert.equal(inbox.status, 0, inbox.out);
    assert.doesNotMatch(inbox.out, /无法安全转发/);
    const shown = l3(statePath, 'show', 'NOPE');
    assert.doesNotMatch(shown.out, /无法安全转发/);
    const plan = l3(statePath, 'plan');
    assert.equal(plan.status, 0, plan.out);
    assert.doesNotMatch(plan.out, /无法安全转发/);
    const runs = l3(statePath, 'runs', 'NOPE');
    assert.doesNotMatch(runs.out, /无法安全转发/);
    assert.notEqual(runs.status, 0);
    const decide = l3(
      statePath,
      'plan',
      'decide',
      'E-1',
      '--action',
      'skip',
      '--reason',
      '夹具',
      '--as',
      'claude',
    );
    assert.equal(decide.status, 0, decide.out);
    assert.equal(store.read()?.feature('F1')?.status, 'skipped');
    const approve = l3(ha.statePath, ...haArgs(ha.recordPath));
    assert.equal(approve.status, 0, approve.out);
    const help = l3(statePath);
    assert.equal(help.status, 0, help.out);
    assert.match(help.out, /AQ1/);
    assert.match(help.out, /plan decide --action answer/);
    assert.match(help.out, /HTTP 不复制续跑/);
    rmSync(residualDir, { recursive: true, force: true });
  });
});

const RUN_PLAN = fileURLToPath(new URL('../src/run-plan.ts', import.meta.url));

function planRepoOn(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-l3-plan-repo-'));
  dirs.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@local');
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', branch);
  return dir;
}

/** 执行者在隔离 worktree 里真改 a.txt，机器 L3 才能合出非空提交。 */
class WritesWorktreeFileRuntime extends ScriptedRuntime {
  async start(spec: AgentRunSpec) {
    if (spec.role === 'executor') {
      writeFileSync(join(spec.cwd, 'a.txt'), 'mission\n');
    }
    return super.start(spec);
  }
}

function waitUntil(predicate: () => boolean, timeoutMs: number, dump: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`等待超时：${dump()}`));
        return;
      }
      setTimeout(tick, 40);
    };
    tick();
  });
}

function waitChildExit(child: ChildProcess, timeoutMs: number, dump: () => string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI 未自然退出：${dump()}`));
    }, timeoutMs);
    child.once('exit', (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
}

function spawnRunPlanCli(input: {
  planPath: string;
  repo: string;
  statePath: string;
  runDir: string;
  adapter: string;
  extra?: string[];
}): { child: ChildProcess; captured: { stdout: string; stderr: string } } {
  const child = spawn(
    process.execPath,
    [
      RUN_PLAN,
      '--plan',
      input.planPath,
      '--cwd',
      input.repo,
      '--reviewer',
      'claude',
      '--state',
      input.statePath,
      '--run-dir',
      input.runDir,
      '--adapter',
      input.adapter,
      ...(input.extra ?? []),
    ],
    {
      env: { ...process.env, COAGENT_AGENT_ENV_PASSTHROUGH: '-', COAGENT_STORE: 'file' },
    },
  );
  const captured = { stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk) => {
    captured.stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    captured.stderr += String(chunk);
  });
  return { child, captured };
}

function hostedPlanSpec(overrides: Record<string, unknown> = {}) {
  return {
    planId: 'PLAN-wait',
    projectId: 'P-wait',
    integrationBranch: 'auto/plan-x',
    intent: '等决定',
    stopConditions: {
      unresolvedEscalations: 5,
      wallClockMs: 8 * 60 * MIN,
      escalationTimeoutMs: 20 * MIN,
    },
    integrationVerification: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 8_000 }],
    features: [
      {
        id: 'F1',
        title: '升级握手',
        why: 'w',
        allowedScope: ['a.txt'],
        acceptance: ['绿'],
        status: 'pending',
      },
    ],
    ...overrides,
  };
}

function escalateScript(): ScriptTable {
  return {
    'coordinator:-:0': {
      steps: [
        { tool: 'coagent_get_mission', body: {} },
        {
          tool: 'coagent_escalate_to_l3',
          body: {
            question: '这个 missionId 对不对？',
            why: '不确定',
            optionsConsidered: ['继续', '停'],
          },
        },
      ],
    },
  };
}

function deliverScripts(workItemId = 'W-1'): ScriptTable {
  return {
    'coordinator:-:0': {
      steps: [
        { tool: 'coagent_get_mission', body: {} },
        {
          tool: 'coagent_update_plan',
          body: {
            findings: '要改 a.txt',
            rejectedHypotheses: [],
            decisions: ['直接改'],
            direction: '改 a.txt',
            risks: [],
          },
        },
        { tool: 'coagent_create_work_item', body: { title: 'W', ...WRITE_ORDER } },
        {
          tool: 'coagent_dispatch_work_item',
          body: (previous: Record<string, unknown>) => ({ workItemIds: [previous.workItemId] }),
        },
      ],
    },
    'coordinator:-:1': {
      steps: [
        { tool: 'coagent_get_mission', body: {} },
        {
          tool: 'coagent_review_execution_result',
          body: {
            workItemId,
            verdict: 'accept',
            acceptanceResults: WRITE_ORDER.acceptance.map((criterion) => ({
              criterion,
              status: 'pass' as const,
              evidence: '测试替身：逐条核过',
            })),
            reasons: ['复跑过'],
            requiredChanges: [],
          },
        },
        {
          tool: 'coagent_submit_mission_result',
          body: {
            outcome: 'delivered',
            summary: '交付',
            acceptanceEvidence: [],
            memoryDelta: [],
            openRisks: [],
          },
        },
      ],
    },
    [`executor:${workItemId}`]: {
      steps: [
        { tool: 'coagent_get_work_order', body: {} },
        {
          tool: 'coagent_submit_evidence',
          body: { kind: 'test', summary: '绿', command: 'x', exitCode: 0 },
        },
        {
          tool: 'coagent_submit_execution_result',
          body: (previous: Record<string, unknown>) => ({
            outcome: 'completed',
            summary: '改好了',
            changedFiles: ['a.txt'],
            evidenceIds: [previous.evidenceId],
            notes: '无',
          }),
        },
      ],
    },
  };
}

function escalateThenDeliverScripts(workItemId = 'W-1'): ScriptTable {
  const deliver = deliverScripts(workItemId);
  return {
    ...escalateScript(),
    'coordinator:-:1': deliver['coordinator:-:0']!,
    'coordinator:-:2': deliver['coordinator:-:1']!,
    [`executor:${workItemId}`]: deliver[`executor:${workItemId}`]!,
  };
}

async function emptyPlanState(): Promise<{ dir: string; statePath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-l3-plan-hosted-'));
  dirs.push(dir);
  return { dir, statePath: join(dir, 'state.json') };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((done) => {
    if (!server.listening) {
      done();
      return;
    }
    server.close(() => done());
  });
}

describe('持锁服务上方案等待决定时短锁与 L3 主状态仍可回应', () => {
  test(
    'hosted Plan 等待决定：独立短锁 decide 与 l3 answer/merge 经服务成功，其它 HTTP 不堵',
    { timeout: 70_000 },
    async () => {
      const fx = await seedMainWrites();
      const repo = planRepoOn('auto/plan-x');
      const adapter = join(fx.dir, 'adapter.ts');
      writeFileSync(adapter, '// hosted plan adapter\n');
      const planPath = join(fx.dir, 'PLAN-wait.json');
      writeFileSync(planPath, JSON.stringify(hostedPlanSpec()));
      const built = await startServer(0, fx.statePath, {
        env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
        workspace: new InPlaceWorkspaceManager(),
        runtime: new ScriptedRuntime(escalateScript()),
      });
      liveServers.push(built.server);
      try {
        const probed = await probeLocalWriter(fx.statePath);
        assert.equal(probed.status, 'live');
        const addr = built.server.address() as AddressInfo;

        const { child, captured } = spawnRunPlanCli({
          planPath,
          repo,
          statePath: fx.statePath,
          runDir: join(fx.dir, '.coagent-plans'),
          adapter,
        });
        const dump = () => `${captured.stdout}${captured.stderr}`;
        await waitUntil(() => /\[[^\]]+\] F1 ▶ /.test(captured.stdout), 20_000, dump);
        const mid = captured.stdout;
        assert.match(mid, /开跑/);
        assert.match(mid, /\[[^\]]+\] F1 ▶ /);
        assert.doesNotMatch(mid, /停了：/);
        assert.equal(child.exitCode, null, dump());
        await waitUntil(() => /⚑ 升级单/.test(captured.stdout), 15_000, dump);
        assert.equal(child.exitCode, null, dump());
        assert.match(dump(), /⚑ 升级单/, dump());

        const healthDuring = await fetch(`http://${addr.address}:${addr.port}/api/health`);
        assert.equal(healthDuring.status, 200);
        const extra = await fetch(`http://${addr.address}:${addr.port}/api/missions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId: 'P-extra',
            missionId: 'M-extra',
            contract: WRITE_CONTRACT,
          }),
        });
        assert.equal(extra.status, 201, await extra.text());

        const decide = await l3Async(
          fx.statePath,
          'plan',
          'decide',
          'E-1',
          '--action',
          'skip',
          '--reason',
          '夹具放行',
          '--as',
          'claude',
        );
        assert.equal(decide.status, 0, decide.out);
        assert.match(decide.out, /skip|跳过|E-1/);

        const answered = await l3Async(fx.statePath, 'answer', 'M-answer', '--answer', '继续');
        assert.equal(answered.status, 0, answered.out);
        assert.match(answered.out, /已答复 M-answer/);

        const merged = await l3Async(
          fx.statePath,
          'merge',
          'M-merge',
          '--reason',
          'ok',
          '--repo',
          fx.repo,
        );
        assert.equal(merged.status, 0, merged.out);
        assert.match(merged.out, /Mission M-merge → completed/);

        const status = await waitChildExit(child, 30_000, dump);
        const out = dump();
        assert.equal(status, 0, out);
        const recordMatch = captured.stdout.match(/方案运行记录：(.+\.json)/);
        assert.ok(recordMatch, out);
        const stored = new FilePlanRunStore(recordMatch[1]!.trim());
        const run = stored.read();
        const resolution = run?.escalations[0]?.resolution;
        assert.equal(resolution?.kind, 'decided');
        assert.equal(resolution?.kind === 'decided' ? resolution.action : '', 'skip');
        assert.equal(run?.feature('F1')?.status, 'skipped');
        assert.equal(run?.stopped?.reason, 'finished');

        const startAt = captured.stdout.indexOf('开跑');
        const progressAt = captured.stdout.search(/\[[^\]]+\] F1 ▶ /);
        const escalateAt = captured.stdout.indexOf('⚑ 升级单');
        const stopAt = captured.stdout.indexOf('停了：');
        const handoffAt = captured.stdout.indexOf('已合入');
        assert.ok(startAt >= 0 && progressAt > startAt && escalateAt > progressAt, out);
        assert.ok(stopAt > escalateAt && handoffAt > stopAt, out);
        assert.match(captured.stdout, /检视者跳过/);
      } finally {
        await closeServer(built.server);
      }
    },
  );

  test(
    'hosted Plan 成功合入：工具行、▶、✓ 合入、停了与交接面在自然退出后可读',
    { timeout: 45_000 },
    async () => {
      const fx = await emptyPlanState();
      const repo = planRepoOn('auto/plan-x');
      const adapter = join(fx.dir, 'adapter.ts');
      writeFileSync(adapter, '// hosted plan adapter\n');
      const planPath = join(fx.dir, 'PLAN-merge.json');
      writeFileSync(planPath, JSON.stringify(hostedPlanSpec({ planId: 'PLAN-merge', intent: '合入' })));
      const built = await startServer(0, fx.statePath, {
        env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
        workspace: new GitWorktreeManager(join(fx.dir, 'wt')),
        runtime: new WritesWorktreeFileRuntime(deliverScripts()),
      });
      liveServers.push(built.server);
      try {
        const { child, captured } = spawnRunPlanCli({
          planPath,
          repo,
          statePath: fx.statePath,
          runDir: join(fx.dir, '.coagent-plans'),
          adapter,
        });
        const dump = () => `${captured.stdout}${captured.stderr}`;
        await waitUntil(() => /\[[^\]]+\] F1 ▶ /.test(captured.stdout), 20_000, dump);
        assert.equal(child.exitCode, null, dump());
        assert.match(captured.stdout, /开跑/);
        assert.doesNotMatch(captured.stdout, /停了：/);
        const status = await waitChildExit(child, 25_000, dump);
        const out = dump();
        assert.equal(status, 0, out);
        assert.match(captured.stdout, /  · coagent_get_mission/);
        assert.match(captured.stdout, /F1 ✓ 合入 auto\/plan-x/);
        assert.match(captured.stdout, /方案 PLAN-merge 停了：/);
        assert.match(captured.stdout, /已合入/);
        const startAt = captured.stdout.indexOf('开跑');
        const progressAt = captured.stdout.search(/\[[^\]]+\] F1 ▶ /);
        const toolAt = captured.stdout.indexOf('  · coagent_get_mission');
        const mergeAt = captured.stdout.indexOf('✓ 合入');
        const stopAt = captured.stdout.indexOf('停了：');
        assert.ok(startAt >= 0 && progressAt > startAt && toolAt >= 0 && mergeAt > progressAt && stopAt > mergeAt, out);
        const recordMatch = captured.stdout.match(/方案运行记录：(.+\.json)/);
        assert.ok(recordMatch, out);
        const stored = new FilePlanRunStore(recordMatch[1]!.trim());
        assert.equal(stored.read()?.feature('F1')?.status, 'merged');
        assert.equal(stored.read()?.stopped?.reason, 'finished');
      } finally {
        await closeServer(built.server);
      }
    },
  );

  test(
    'hosted Plan 答复后续跑：独立 decide answer 后出现 ↩ 并自然合入',
    { timeout: 70_000 },
    async () => {
      const fx = await emptyPlanState();
      const repo = planRepoOn('auto/plan-x');
      const adapter = join(fx.dir, 'adapter.ts');
      writeFileSync(adapter, '// hosted plan adapter\n');
      const planPath = join(fx.dir, 'PLAN-answer.json');
      writeFileSync(planPath, JSON.stringify(hostedPlanSpec({ planId: 'PLAN-answer', intent: '答复' })));
      const built = await startServer(0, fx.statePath, {
        env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
        workspace: new GitWorktreeManager(join(fx.dir, 'wt')),
        runtime: new WritesWorktreeFileRuntime(escalateThenDeliverScripts()),
      });
      liveServers.push(built.server);
      try {
        const { child, captured } = spawnRunPlanCli({
          planPath,
          repo,
          statePath: fx.statePath,
          runDir: join(fx.dir, '.coagent-plans'),
          adapter,
        });
        const dump = () => `${captured.stdout}${captured.stderr}`;
        await waitUntil(() => /⚑ 升级单/.test(captured.stdout), 20_000, dump);
        assert.equal(child.exitCode, null, dump());
        assert.match(captured.stdout, /\[[^\]]+\] F1 ▶ /);
        const decide = await l3Async(
          fx.statePath,
          'plan',
          'decide',
          'E-1',
          '--action',
          'answer',
          '--answer',
          '对，继续',
          '--as',
          'claude',
        );
        assert.equal(decide.status, 0, decide.out);
        const status = await waitChildExit(child, 30_000, dump);
        const out = dump();
        assert.equal(status, 0, out);
        assert.match(captured.stdout, /↩ 检视者答复了 E-1/);
        assert.match(captured.stdout, /F1 ✓ 合入/);
        assert.match(captured.stdout, /停了：/);
        const escalateAt = captured.stdout.indexOf('⚑ 升级单');
        const answerAt = captured.stdout.indexOf('↩ 检视者答复了');
        const mergeAt = captured.stdout.indexOf('✓ 合入');
        assert.ok(escalateAt >= 0 && answerAt > escalateAt && mergeAt > answerAt, out);
        const recordMatch = captured.stdout.match(/方案运行记录：(.+\.json)/);
        assert.ok(recordMatch, out);
        const stored = new FilePlanRunStore(recordMatch[1]!.trim());
        const resolution = stored.read()?.escalations[0]?.resolution;
        assert.equal(resolution?.kind === 'decided' ? resolution.action : '', 'answer');
        assert.equal(stored.read()?.feature('F1')?.status, 'merged');
      } finally {
        await closeServer(built.server);
      }
    },
  );

  test(
    'hosted Plan 服务内失败：stderr 带消息且 CLI 非零退出，不把 kill 当终态',
    { timeout: 30_000 },
    async () => {
      const fx = await emptyPlanState();
      const repo = planRepoOn('auto/plan-x');
      const adapter = join(fx.dir, 'adapter.ts');
      writeFileSync(adapter, '// hosted plan adapter\n');
      const planPath = join(fx.dir, 'PLAN-fail.json');
      writeFileSync(planPath, JSON.stringify(hostedPlanSpec({ planId: 'PLAN-fail', intent: '失败' })));
      const built = await startServer(0, fx.statePath, {
        env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
        workspace: new InPlaceWorkspaceManager(),
        runtime: new ScriptedRuntime({}),
      });
      liveServers.push(built.server);
      try {
        const { child, captured } = spawnRunPlanCli({
          planPath,
          repo,
          statePath: fx.statePath,
          runDir: join(fx.dir, '.coagent-plans'),
          adapter,
          extra: ['--coordinator', 'no-such-profile'],
        });
        const dump = () => `${captured.stdout}${captured.stderr}`;
        const status = await waitChildExit(child, 20_000, dump);
        const out = dump();
        assert.notEqual(status, 0, out);
        assert.match(captured.stderr, /--coordinator|no-such-profile/);
        assert.doesNotMatch(captured.stdout, /方案 PLAN-fail 停了/);
      } finally {
        await closeServer(built.server);
      }
    },
  );
});

function flipAsciiCase(value: string): string {
  return value.replace(/[A-Za-z]/g, (ch) =>
    ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase(),
  );
}

function queryParam(url: string | undefined, name: string): string | undefined {
  if (!url || !url.includes('?')) return undefined;
  return new URLSearchParams(url.slice(url.indexOf('?') + 1)).get(name) ?? undefined;
}

function listenHealth(headers: {
  instanceId: string;
  stateId: string;
  api: string;
}): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/api/health') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'x-coagent-instance': headers.instanceId,
        'x-coagent-state-id': headers.stateId,
      });
      res.end(JSON.stringify({ ok: true, api: headers.api }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  liveServers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}
