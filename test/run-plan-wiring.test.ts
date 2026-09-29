/**
 * run-plan 的接线：开跑前检查、机器 L3 在真实装配里可用、在途 Mission 到点暂停。
 *
 * 这几件事单测驱动循环时都是替身，真跑起来才会露馅：
 * - 装配根不给 commandRunner，机器 L3 一调就 MACHINE_FINALIZE_UNAVAILABLE——F2 只在
 *   注入了替身的测试里跑通过；
 * - 项目仓里有一个未跟踪文件，机器 L3 每一次合并都拒绝（git status 非空）；
 * - 墙钟只在两个功能之间看，一条跑了四小时的 Mission 会把「八小时硬墙钟」拖成十二小时。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { API_VERSION, createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { InMemoryAgentPoolRepository } from '../src/application/agent-pool.ts';
import { acquireLock, publishLockPort, stateIdFor } from '../src/application/lock.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { MissionRunner } from '../src/application/mission-runner.ts';
import { preflightPlanRepo, slotHolders } from '../src/application/plan-preflight.ts';
import { runWithDeadline } from '../src/application/plan-driver.ts';
import {
  HOSTED_AGENT_ENV_UNPROVEN_MESSAGE,
  parseHostedPlanBody,
  runHostedPlan,
  runPlanOnPlatform,
} from '../src/application/plan-runtime.ts';
import { FilePlanRunStore } from '../src/application/plan-run-store.ts';
import type { HaRelease } from '../src/application/plan-run.ts';
import { parsePlanSpec, selectPlanCandidates } from '../src/application/plan-spec.ts';
import { Platform, PlatformRuleError, type QueueClaimIdentity } from '../src/application/platform.ts';
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
import { ExecFileCommandRunner } from '../src/application/validation/exec-file-command-runner.ts';
import { GitWorktreeManager, InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import type { WorkspaceManager } from '../src/application/workspace.ts';
import { buildPersistentPlatform, buildPgPlatform, makeIssuer } from '../src/main.ts';
import { FileQueuedHopRepository } from '../src/application/file-store.ts';
import { PgCandidateCircuitRepository, PgQueuedHopRepository } from '../src/application/pg-store.ts';
import type { QueuedHop } from '../src/application/durable-scheduler.ts';
import { ensureTestDatabase } from './helpers/pg.ts';
import { SPAWN_ENV_UNDECLARED_MESSAGE } from '../src/runtime/spawn.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repoOn(branch: string): string {
  const dir = temp('coagent-repo-');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@local');
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  writeFileSync(join(dir, '.gitignore'), 'ignored.log\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', branch);
  return dir;
}

describe('开跑前检查项目仓', () => {
  test('在集成分支上且工作区干净 → 没有问题；被忽略的文件不算', async () => {
    const repo = repoOn('auto/plan-x');
    writeFileSync(join(repo, 'ignored.log'), 'x');
    assert.deepEqual(await preflightPlanRepo(repo, 'auto/plan-x'), []);
  });

  test('不在集成分支上 → 点名现在在哪', async () => {
    const repo = repoOn('auto/plan-x');
    git(repo, 'checkout', '-q', 'master');
    const problems = await preflightPlanRepo(repo, 'auto/plan-x');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /master/);
    assert.match(problems[0], /auto\/plan-x/);
  });

  test('有未跟踪文件 → 列出来：机器 L3 见到它就拒绝每一次合并', async () => {
    const repo = repoOn('auto/plan-x');
    writeFileSync(join(repo, 'stray.json'), '{}');
    const problems = await preflightPlanRepo(repo, 'auto/plan-x');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /stray\.json/);
  });

  test('detached HEAD 也算不在集成分支上', async () => {
    const repo = repoOn('auto/plan-x');
    git(repo, 'checkout', '-q', '--detach');
    const problems = await preflightPlanRepo(repo, 'auto/plan-x');
    assert.match(problems.join('\n'), /detached|分离/);
  });
});

describe('方案运行入口接线 answerEscalation', () => {
  test('runtime adapter 用 persistAfter 包住 platform.answerEscalation', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'application', 'plan-runtime.ts'), 'utf8');
    assert.match(
      src,
      /answerEscalation:\s*\(missionId, answer\) =>\s*persistAfter\(deps\.persist, deps\.platform\.answerEscalation\(missionId, answer\)\)/,
    );
    assert.match(src, /export async function runHostedPlan/);
    assert.match(src, /export function parseHostedPlanBody/);
    assert.doesNotMatch(src, /from ['"]\.\.\/api\//);
    assert.doesNotMatch(src, /from ['"]\.\/loopback-listen\.ts['"]/);
    assert.doesNotMatch(src, /from ['"]\.\.\/main\.ts['"]/);
    assert.doesNotMatch(src, /from ['"]\.\/lock\.ts['"]/);
    assert.doesNotMatch(src, /buildPersistentPlatform\s*\(/);
    assert.doesNotMatch(src, /buildPgPlatform\s*\(/);
    assert.doesNotMatch(src, /startServer\s*\(/);
    assert.doesNotMatch(src, /acquireLock\s*\(/);
    assert.doesNotMatch(src, /createApi\s*\(/);
    assert.doesNotMatch(src, /listenLoopback\s*\(/);
    assert.match(src, /parseAgentEnvPassthrough/);
    assert.match(src, /COAGENT_AGENT_ENV_PASSTHROUGH/);
    assert.match(src, /HOSTED_AGENT_ENV_UNPROVEN_MESSAGE/);
    assert.match(src, /slotHolders\(/);
    assert.match(src, /preflightPlanRepo\(/);
    assert.match(src, /new FilePlanRunStore\(/);
    assert.match(src, /inRunBackoffWaitMs:\s*120_000/);
    const hostedAt = src.indexOf('export async function runHostedPlan');
    const hostedFn = hostedAt >= 0 ? src.slice(hostedAt) : '';
    const pickAt = hostedFn.indexOf('pickHostedCandidates');
    const storeAt = hostedFn.indexOf('new FilePlanRunStore');
    const runAt = hostedFn.indexOf('runPlanOnPlatform');
    assert.ok(
      pickAt >= 0 && storeAt > pickAt && runAt > pickAt,
      '非法候选必须在 FilePlanRunStore / runPlanOnPlatform 之前检查',
    );
  });
});

const CONTRACT: MissionContract = { intent: '改 a.txt', acceptance: ['绿'], constraints: [], nonGoals: [], guardrails: [] };
const ORDER: WorkOrder = {
  objective: '改 a.txt',
  allowedScope: ['a.txt'],
  requiredBehaviour: 'a.txt 变成 mission',
  constraints: [],
  acceptance: ['内容是 mission'],
  verification: ['cat a.txt'],
  doNot: [],
  contextRefs: [],
};

describe('持久化装配里机器 L3 可用', () => {
  test('buildPgPlatform 将熔断仓储绑定到自身 PgStateStore，重建后读到记录', async (t) => {
    const connectionString = await ensureTestDatabase('run_plan_circuit_wiring');
    if (!connectionString) {
      t.skip('Postgres unavailable; buildPgPlatform circuit wiring not verified');
      return;
    }
    const first = await buildPgPlatform({ connectionString });
    try {
      assert.equal(first.candidateCircuits.constructor.name, 'PgCandidateCircuitRepository');
      // The repository and this store must share the same pool; constructing another repository
      // from the platform store must observe the same transaction-backed database.
      assert.ok(first.store instanceof Object);
      assert.ok(first.candidateCircuits instanceof PgCandidateCircuitRepository);
      await first.store.pool.query('TRUNCATE candidate_circuits');
      const projectRoot = repoOn('main');
      const workspace = new GitWorktreeManager(temp('coagent-pg-circuit-wt-'));
      const missionId = `M-pg-circuit-${Date.now()}`;
      await first.platform.createMission({ projectId: 'P', missionId, contract: CONTRACT });
      const openUntil = new Date(Date.now() + 60_000).toISOString();
      await first.candidateCircuits.open({ profileId: 'pg-platform-circuit', failureClass: 'upstream', openUntil: '2030-01-01T00:00:00.000Z' });
      await first.candidateCircuits.open({ profileId: 'P', failureClass: 'upstream', now: new Date().toISOString(), openUntil });
      const second = await buildPgPlatform({ connectionString });
      try {
        assert.deepEqual(await second.candidateCircuits.get('pg-platform-circuit'), {
          profileId: 'pg-platform-circuit', state: 'open', failureClass: 'upstream', openUntil: '2030-01-01T00:00:00.000Z',
        });
        const throughPlatformStore = new PgCandidateCircuitRepository(second.store);
        assert.deepEqual(await throughPlatformStore.get('pg-platform-circuit'), await second.candidateCircuits.get('pg-platform-circuit'));
        const server = createApi({ platform: second.platform, tokens: second.tokens, deliveries: second.deliveries });
        try {
          await listenLoopback(server, 0);
          const address = server.address() as AddressInfo;
          const runtime = new ScriptedRuntime({});
          const runner = new MissionRunner({
            platform: second.platform, tokens: makeIssuer(second.platform, second.tokens),
            baseUrl: `http://127.0.0.1:${address.port}`, workspace,
            candidateCircuits: second.candidateCircuits,
            queuedHops: second.queuedHops,
            coordinator: { runtime, candidates: [{ endpoint: 'local', profileId: 'P' }] },
            executor: { runtime: new ScriptedRuntime({}), candidates: [] },
          });
          await runner.run(missionId, { projectRoot });
          assert.equal(runtime.specs.length, 0, 'PG 重建后未到期 open 候选未启动 Agent');
        } finally {
          if (server.listening) await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
        }
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });
  test('buildPgPlatform 暴露与自身 store 对应的 queuedHops 仓储', async (t) => {
    const connectionString = await ensureTestDatabase('run_plan_queued_hops_wiring');
    if (!connectionString) {
      t.skip('Postgres unavailable; buildPgPlatform queuedHops wiring not verified');
      return;
    }
    const first = await buildPgPlatform({ connectionString });
    try {
      assert.equal(first.queuedHops.constructor.name, 'PgQueuedHopRepository');
      assert.ok(first.queuedHops instanceof PgQueuedHopRepository);
      await first.store.pool.query('TRUNCATE queued_hops');
      const hop: QueuedHop = {
        id: 'pg-wire-h1',
        projectId: 'P',
        missionId: 'M-pg-queue',
        workItemId: 'W-1',
        role: 'executor',
        priority: 1,
        availableAt: '2020-01-01T00:00:00.000Z',
        attemptCount: 0,
        maxAttempts: 2,
        idempotencyKey: 'pg-wire-key',
        status: 'queued',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      };
      const stored = await first.queuedHops.enqueue(hop);
      const second = await buildPgPlatform({ connectionString });
      try {
        assert.ok(second.queuedHops instanceof PgQueuedHopRepository);
        assert.deepEqual(await second.queuedHops.get(hop.id), stored);
        const throughStore = new PgQueuedHopRepository(second.store);
        assert.deepEqual(await throughStore.get(hop.id), await second.queuedHops.get(hop.id));
        assert.equal((await second.queuedHops.list())[0]?.status, 'queued');
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });
  test('buildPersistentPlatform 重建后的 Runner 尊重未到期 open 候选', async () => {
    const statePath = join(temp('coagent-circuit-state-'), 'state.json');
    const projectRoot = repoOn('main');
    const workspace = new GitWorktreeManager(temp('coagent-circuit-wt-'));
    const first = await buildPersistentPlatform(statePath, { workspace });
    await first.platform.createMission({ projectId: 'P', missionId: 'M-circuit-rebuilt', contract: CONTRACT });
    const openUntil = new Date(Date.now() + 60_000).toISOString();
    await first.candidateCircuits.open({
      profileId: 'P', failureClass: 'rate_limit', now: new Date().toISOString(), openUntil,
    });
    first.persist();

    const rebuilt = await buildPersistentPlatform(statePath, { workspace, reconcile: false });
    const persisted = await rebuilt.candidateCircuits.get('P');
    assert.equal(persisted?.state, 'open');
    const server = createApi({ platform: rebuilt.platform, tokens: rebuilt.tokens, deliveries: rebuilt.deliveries });
    try {
      await listenLoopback(server, 0);
      const address = server.address() as AddressInfo;
      const runtime = new ScriptedRuntime({});
      const runner = new MissionRunner({
        platform: rebuilt.platform,
        tokens: makeIssuer(rebuilt.platform, rebuilt.tokens),
        baseUrl: `http://127.0.0.1:${address.port}`,
        workspace,
        candidateCircuits: rebuilt.candidateCircuits,
        queuedHops: rebuilt.queuedHops,
        coordinator: { runtime, candidates: [{ endpoint: 'local', profileId: 'P' }] },
        executor: { runtime: new ScriptedRuntime({}), candidates: [] },
      });
      await runner.run('M-circuit-rebuilt', { projectRoot });
      assert.equal(runtime.specs.length, 0, '未到期 open 候选未启动 Agent');
      assert.deepEqual(await rebuilt.candidateCircuits.get('P'), persisted);
    } finally {
      if (server.listening) await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
      rebuilt.releaseLock();
    }
  });

  test('buildPersistentPlatform 给了真的 commandRunner：合并、在合并结果上跑命令、放行', async () => {
    const repo = repoOn('auto/plan-x');
    const wt = temp('coagent-wt-');
    const workspace = new GitWorktreeManager(wt);
    const statePath = join(temp('coagent-state-'), 'state.json');
    const built = await buildPersistentPlatform(statePath, { workspace });
    const { platform } = built;
    assert.equal(built.candidateCircuits.constructor.name, 'FileCandidateCircuitRepository');
    assert.equal(built.queuedHops.constructor.name, 'FileQueuedHopRepository');
    assert.ok(built.queuedHops instanceof FileQueuedHopRepository);
    await built.candidateCircuits.open({ profileId: 'circuit-persist', failureClass: 'upstream', openUntil: '2030-01-01T00:00:00.000Z' });
    const rebuilt = await buildPersistentPlatform(statePath, { workspace, reconcile: false });
    assert.deepEqual(await rebuilt.candidateCircuits.get('circuit-persist'), {
      profileId: 'circuit-persist', state: 'open', failureClass: 'upstream', openUntil: '2030-01-01T00:00:00.000Z',
    });

    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const prepared = await workspace.prepare('M1', repo);
    await platform.recordWorkspace('M1', {
      projectRoot: repo,
      branch: prepared.branch,
      baseRevision: prepared.baseRevision,
    });
    const coord = await platform.startCoordinatorAttempt('M1');
    await platform.updatePlan('M1', coord.attemptId, { summary: 'p', steps: ['s'], risks: [] } as never);
    const { workItemId } = await platform.createWorkItem('M1', coord.attemptId, { title: 'W', order: ORDER });
    await platform.dispatchWorkItems('M1', coord.attemptId, [workItemId]);
    writeFileSync(join(prepared.cwd, 'a.txt'), 'mission\n');
    const exec = await platform.startExecutorAttempt('M1', workItemId);
    await platform.submitEvidence('M1', exec.attemptId, { kind: 'test', summary: '绿', command: 'x', exitCode: 0 });
    await platform.submitExecutionResult('M1', exec.attemptId, {
      outcome: 'completed',
      summary: '改好了',
      changedFiles: ['a.txt'],
      evidenceIds: [],
      notes: '无',
    });
    await platform.finishAttempt('M1', exec.attemptId, { endedBy: 'structured_submit' });
    await platform.reviewExecutionResult('M1', coord.attemptId, {
      workItemId,
      verdict: 'accept', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })),
      reasons: ['复跑过'],
      requiredChanges: [],
    });
    await platform.submitMissionResult('M1', coord.attemptId, {
      outcome: 'delivered',
      summary: '交付',
      acceptanceEvidence: [],
      memoryDelta: [],
      openRisks: [],
    });
    await platform.finishAttempt('M1', coord.attemptId, { endedBy: 'structured_submit' });

    // 验证命令是真的：在合并结果上读 a.txt，内容不对就非零退出。
    const result = await platform.finalizeMissionByMachine('M1', {
      integrationBranch: 'auto/plan-x',
      verification: [
        {
          argv: [
            process.execPath,
            '-e',
            "process.exit(require('fs').readFileSync('a.txt','utf8').trim()==='mission'?0:3)",
          ],
          timeoutMs: 30_000,
        },
      ],
    });

    assert.equal(result.status, 'completed', result.reason);
    assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'mission');
    const view = await platform.getMissionView('M1');
    assert.equal(view.finalReview?.authority?.kind, 'machine');
  });
});

describe('在途 Mission 到墙钟就暂停', () => {
  test('跑过点了：到点调一次暂停，任务照常收尾拿到结果', async () => {
    let paused = 0;
    const result = await runWithDeadline(
      () => new Promise<string>((done) => setTimeout(() => done('收尾'), 120)),
      30,
      async () => {
        paused += 1;
      },
    );
    assert.equal(result, '收尾');
    assert.equal(paused, 1);
  });

  test('没到点就跑完：不暂停，事后也不会迟到地冒出一次暂停', async () => {
    let paused = 0;
    const result = await runWithDeadline(async () => '早完', 30, async () => {
      paused += 1;
    });
    assert.equal(result, '早完');
    // 等过原定的到点时刻：定时器没清的话，这时会去暂停一条早已跑完的 Mission。
    await new Promise((done) => setTimeout(done, 80));
    assert.equal(paused, 0);
  });

  test('开跑时就已经过点：立刻暂停', async () => {
    let paused = 0;
    await runWithDeadline(
      () => new Promise<void>((done) => setTimeout(done, 40)),
      -5,
      async () => {
        paused += 1;
      },
    );
    assert.equal(paused, 1);
  });
});

describe('运行时产物不弄脏项目仓', () => {
  /**
   * 状态文件放在仓库根（缺省 .coagent-state.json）时，平台会在它旁边生出锁目录、
   * 方案运行记录、归档、外置输出。任何一个没被忽略，机器 L3 就拒绝每一次合并。
   * 原先那条 `.coagent-state*.lock/` 匹配不到真正的锁目录名 `.lock-<状态文件名>`。
   */
  test('平台在状态文件旁生成的东西都被 .gitignore 挡住', () => {
    const root = join(import.meta.dirname, '..');
    for (const path of [
      '.coagent-state.json',
      '.lock-.coagent-state.json/holder.json',
      '.coagent-plans/PLAN-x-20260923.json',
      '.coagent-archive/missions/p/M1.json',
      'artifacts/M1/out.txt',
      '.coagent-worktrees/M1/a.txt',
    ]) {
      assert.doesNotThrow(
        () => execFileSync('git', ['check-ignore', '-q', path], { cwd: root }),
        `${path} 没被忽略`,
      );
    }
  });
});

describe('真平台 + 真 git 跑一份方案', () => {
  /**
   * 替身只替「agent 干活」这一步：照着平台 API 把 Mission 推到交卷（改一个文件）。
   * 其余全是真的——平台、git 合并与回滚、方案运行记录、放弃与名额。要验的是
   * F4/F5 串起来之后那条最要命的性质：**一个功能红了，不会钉死后面的功能。**
   */
  async function deliver(
    platform: Awaited<ReturnType<typeof buildPersistentPlatform>>['platform'],
    workspace: GitWorktreeManager,
    repo: string,
    missionId: string,
    file: string,
    content: string,
  ) {
    const prepared = await workspace.prepare(missionId, repo);
    await platform.recordWorkspace(missionId, {
      projectRoot: repo,
      branch: prepared.branch,
      baseRevision: prepared.baseRevision,
    });
    const coord = await platform.startCoordinatorAttempt(missionId);
    await platform.updatePlan(missionId, coord.attemptId, { summary: 'p', steps: ['s'], risks: [] } as never);
    const { workItemId } = await platform.createWorkItem(missionId, coord.attemptId, {
      title: 'W',
      order: { ...ORDER, allowedScope: [file] },
    });
    // 名额被占着的话，这里就是 PROJECT_BUSY——方案就此卡死。
    await platform.dispatchWorkItems(missionId, coord.attemptId, [workItemId]);
    writeFileSync(join(prepared.cwd, file), content);
    const exec = await platform.startExecutorAttempt(missionId, workItemId);
    await platform.submitEvidence(missionId, exec.attemptId, { kind: 'test', summary: '绿', command: 'x', exitCode: 0 });
    await platform.submitExecutionResult(missionId, exec.attemptId, {
      outcome: 'completed',
      summary: '改好了',
      changedFiles: [file],
      evidenceIds: [],
      notes: '无',
    });
    await platform.finishAttempt(missionId, exec.attemptId, { endedBy: 'structured_submit' });
    await platform.reviewExecutionResult(missionId, coord.attemptId, {
      workItemId,
      verdict: 'accept', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })),
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

  test('F1 合进去验证红 → 退回 → 升级单没人定 → 放弃放名额 → F2 照样派发并合进去', async () => {
    const { drivePlan } = await import('../src/application/plan-driver.ts');
    const { parsePlanSpec } = await import('../src/application/plan-spec.ts');
    const { PlanRun } = await import('../src/application/plan-run.ts');
    const { FilePlanRunStore } = await import('../src/application/plan-run-store.ts');

    const repo = repoOn('auto/plan-x');
    writeFileSync(join(repo, 'b.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'b');
    const anchor = git(repo, 'rev-parse', 'HEAD');
    const workspace = new GitWorktreeManager(temp('coagent-wt-'));
    const stateDir = temp('coagent-state-');
    const { platform } = await buildPersistentPlatform(join(stateDir, 'state.json'), { workspace });

    const plan = parsePlanSpec(
      {
        planId: 'PLAN-x',
        projectId: 'P',
        integrationBranch: 'auto/plan-x',
        intent: 'x',
        stopConditions: { unresolvedEscalations: 5, wallClockMs: 8 * 3_600_000, escalationTimeoutMs: 1_200_000 },
        // 集成验证：a.txt 里出现 bad 就算打坏了别人。
        integrationVerification: [
          {
            argv: [process.execPath, '-e', "process.exit(require('fs').readFileSync('a.txt','utf8').includes('bad')?1:0)"],
            timeoutMs: 30_000,
          },
        ],
        features: [
          { id: 'F1', title: '改 a', why: 'w', allowedScope: ['a.txt'], acceptance: ['x'] },
          { id: 'F2', title: '改 b', why: 'w', allowedScope: ['b.txt'], acceptance: ['x'] },
        ],
      },
      { reviewer: 'claude' },
    );
    const store = new FilePlanRunStore(join(stateDir, '.coagent-plans', 'R1.json'));
    let clock = Date.parse('2026-09-23T22:00:00.000Z');
    await store.create(
      PlanRun.start({
        id: 'R1',
        planId: plan.planId,
        projectId: plan.projectId,
        integrationBranch: plan.integrationBranch,
        reviewer: plan.reviewer,
        stopConditions: plan.stopConditions,
        featureIds: ['F1', 'F2'],
        startedAt: new Date(clock).toISOString(),
      }),
    );

    const edits: Record<string, [string, string]> = {
      'R1-F1': ['a.txt', 'bad\n'],
      'R1-F2': ['b.txt', 'good\n'],
    };
    const stop = await drivePlan(plan, {
      store,
      projectRoot: repo,
      platform,
      now: () => new Date(clock).toISOString(),
      sleep: async (ms) => {
        clock += ms;
      },
      log: () => {},
      proposeRoute: async () => ({ ok: false, reason: '本测试不分类' }),
      runMission: async (missionId) => {
        const [file, content] = edits[missionId];
        await deliver(platform, workspace, repo, missionId, file, content);
        return { kind: 'awaiting_l3_review' };
      },
    });

    assert.equal(stop.reason, 'finished');
    const run = store.read()!;
    assert.equal(run.feature('F1')?.status, 'suspended');
    assert.equal(run.unresolvedCount, 1);
    assert.equal(run.feature('F2')?.status, 'merged');
    // 集成分支：F1 被退回、F2 合进来了。
    assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'base');
    assert.equal(git(repo, 'show', 'HEAD:b.txt'), 'good');
    assert.notEqual(git(repo, 'rev-parse', 'HEAD'), anchor);
    // F1 的改动留在它自己的分支上等人看；放弃记在 plan 名下并指向升级单。
    assert.equal(git(repo, 'show', 'mission/R1-F1:a.txt'), 'bad');
    const f1 = await platform.getMissionView('R1-F1');
    assert.equal(f1.status, 'blocked');
    assert.deepEqual(f1.finalReview?.authority, { kind: 'plan', planRunId: 'R1', escalationId: 'E-1' });
    assert.equal((await platform.getMissionView('R1-F2')).finalReview?.authority?.kind, 'machine');
  });
});

describe('开跑前：项目的改动名额被谁占着', () => {
  /**
   * 方案停下时，失败或在途的那条 Mission 是故意原样留给人的——它动过代码、没到
   * 终态，一直占着名额。第二晚不先处理它就开跑，每个功能的协调者都会调查规划
   * 一遍、派发时撞上 PROJECT_BUSY，一整晚白烧。
   */
  test('本项目里有动过代码、没到终态的 Mission → 点名它和处置办法；别的项目、已终结的不算', async () => {
    const { slotHolders } = await import('../src/application/plan-preflight.ts');
    const rows = [
      { missionId: 'R0-F2', projectId: 'P', status: 'awaiting_review', isMutating: true },
      { missionId: 'R0-F1', projectId: 'P', status: 'completed', isMutating: false },
      { missionId: 'X-1', projectId: 'other', status: 'executing', isMutating: true },
      { missionId: 'R0-F3', projectId: 'P', status: 'planning', isMutating: false },
    ];
    const problems = slotHolders(rows, 'P');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /R0-F2/);
    assert.match(problems[0], /awaiting_review/);
    assert.match(problems[0], /l3\.ts/);
    assert.deepEqual(slotHolders(rows.filter((r) => r.missionId !== 'R0-F2'), 'P'), []);
  });

  test('遗留 Mission 占项目名额时拒绝开跑且不领取旧 Hop、不建 PlanRun', async () => {
    const repo = repoOn('auto/plan-x');
    const home = temp('coagent-slot-queue-');
    const statePath = join(home, 'state.json');
    const runDir = join(home, 'plans');
    const workspace = new GitWorktreeManager(temp('coagent-slot-wt-'));
    const seeded = await buildPersistentPlatform(statePath, {
      workspace,
      exclusive: { what: 'seed leftover' },
    });
    try {
      await seeded.platform.createMission({ projectId: 'p', missionId: 'R0-F2', contract: CONTRACT });
      const coord = await seeded.platform.startCoordinatorAttempt('R0-F2');
      await seeded.platform.updatePlan('R0-F2', coord.attemptId, { summary: 'p', steps: ['s'], risks: [] } as never);
      const { workItemId } = await seeded.platform.createWorkItem('R0-F2', coord.attemptId, { title: 'W', order: ORDER });
      await seeded.platform.dispatchWorkItems('R0-F2', coord.attemptId, [workItemId]);
      assert.equal((await seeded.platform.getMissionView('R0-F2')).isMutating, true);
      const hop: QueuedHop = {
        id: 'old-hop',
        projectId: 'p',
        missionId: 'R0-F2',
        workItemId,
        role: 'executor',
        priority: 1,
        availableAt: '2020-01-01T00:00:00.000Z',
        attemptCount: 0,
        maxAttempts: 2,
        idempotencyKey: 'old-hop-key',
        status: 'queued',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      };
      await seeded.queuedHops.enqueue(hop);
      await seeded.persist();
    } finally {
      seeded.releaseLock();
    }

    const planPath = join(home, 'PLAN.json');
    writeFileSync(
      planPath,
      JSON.stringify(
        samplePlan([{ id: 'Ok', title: '待跑', why: 'w', allowedScope: ['a.txt'], acceptance: ['x'], status: 'pending' }]),
        null,
        2,
      ),
    );
    const result = runOpen(planPath, repo, ['--state', statePath, '--run-dir', runDir, '--worktrees', join(home, 'wt')]);
    const out = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, out);
    assert.match(out, /R0-F2/);
    assert.match(out, /占着/);
    assert.doesNotMatch(out, /开跑：/);
    assert.equal(existsSync(runDir), false, '名额拒绝不得新建 PlanRun');

    const after = await buildPersistentPlatform(statePath, { workspace, exclusive: { what: 'inspect' }, reconcile: false });
    try {
      const leftover = await after.queuedHops.get('old-hop');
      assert.equal(leftover?.status, 'queued');
      assert.ok(after.queuedHops instanceof FileQueuedHopRepository);
    } finally {
      after.releaseLock();
    }
  });
});

describe('run-plan 周期投递修复接线', () => {
  test('在副作用之前解析间隔，finally 里 stop，文件版注入 hasArchivedMission', () => {
    const root = join(import.meta.dirname, '..', 'src');
    const runPlan = readFileSync(join(root, 'run-plan.ts'), 'utf8');
    const main = readFileSync(join(root, 'main.ts'), 'utf8');

    // 一律取调用点，不取名字第一次出现的位置：import 列表在文件最前，按名字 indexOf
    // 会先撞上 import 行，顺序断言就成了「比两个 import 谁在前」，失去意义。
    const parseAt = runPlan.indexOf('parseReconcileIntervalMs(process.env');
    const worktreeAt = runPlan.indexOf('new GitWorktreeManager(');
    const platformAt = runPlan.indexOf('await buildPersistentPlatform(');
    assert.ok(parseAt >= 0 && worktreeAt >= 0 && platformAt >= 0, '三个调用点都应能找到');
    assert.ok(parseAt < worktreeAt && parseAt < platformAt, '非法间隔必须在建 worktree / 开状态之前拒绝');
    const checkAt = runPlan.indexOf("if (process.argv.includes('--check'))");
    const selectAt = runPlan.indexOf('selectPlanCandidates(plan');
    const firstPreflightAt = runPlan.indexOf('await preflightPlanRepo(projectRoot, plan.integrationBranch)');
    const probeAt = runPlan.indexOf('probeLocalWriter(statePath)');
    const runAt = runPlan.indexOf('runPlanOnPlatform(');
    const apiAt = runPlan.indexOf('createApi(');
    const runnerAt = runPlan.indexOf('new MissionRunner(');
    const slotAt = runPlan.indexOf('slotHolders(');
    const afterLockAt = runPlan.indexOf('拿到状态锁之后项目仓变脏了');
    const sigAt = runPlan.indexOf("process.once('SIGINT'");
    assert.ok(checkAt >= 0 && checkAt < platformAt, '--check 只读路径必须在装配平台之前');
    assert.ok(checkAt >= 0 && probeAt >= 0 && checkAt < probeAt, '--check 必须在探测之前只读返回');
    assert.ok(selectAt >= 0 && firstPreflightAt >= 0 && selectAt < firstPreflightAt && firstPreflightAt < probeAt, '资格筛选和第一次 git 预检必须在探测之前');
    assert.ok(probeAt < platformAt, '探测必须在装配平台之前');
    assert.ok(selectAt >= 0 && selectAt < platformAt, '资格筛选必须在装配平台之前');
    assert.ok(runAt >= 0 && selectAt < runAt, '资格筛选必须在内部入口建运行记录之前');
    assert.ok(afterLockAt >= 0 && platformAt < afterLockAt, '二次预检必须在拿锁之后');
    assert.ok(slotAt >= 0 && afterLockAt < slotAt && slotAt < runAt, '名额复检在锁后、建记录之前');
    assert.ok(apiAt >= 0 && runnerAt >= 0 && apiAt < runnerAt && runnerAt < runAt, 'API 与 MissionRunner 在内部入口之前');
    assert.ok(sigAt >= 0 && sigAt < runAt, '信号停记必须在内部入口建记录之前挂上');
    assert.match(runPlan, /process\.argv\.includes\('--check'\)/);
    assert.match(runPlan, /probeLocalWriter/);
    assert.match(runPlan, /loopbackRunRequest/);
    assert.match(runPlan, /loopbackRunRequest\([\s\S]*?timeoutMs: 0/);
    assert.match(runPlan, /\/api\/control\/run-plan/);
    assert.match(runPlan, /HOSTED_AGENT_ENV_UNPROVEN_MESSAGE/);
    assert.match(runPlan, /if \(!usePg\)/);
    assert.match(runPlan, /process\.exit\(code\)/);
    assert.match(runPlan, /from '\.\/application\/plan-runtime\.ts'/);
    assert.match(runPlan, /from '\.\/application\/mission-runner\.ts'/);
    assert.match(runPlan, /runner\.run\(/);
    assert.match(runPlan, /runner\.run\(missionId, missionRunOptions\(options, maxRounds\)\)/);
    assert.match(runPlan, /return maxRounds === undefined \? options : \{ \.\.\.options, maxRounds \}/);
    assert.match(runPlan, /parseMaxRounds\(flagValue\('--max-rounds'\), process\.argv\.includes\('--max-rounds'\)\)/);
    assert.match(runPlan, /new MissionRunner\(\{[\s\S]*?candidateCircuits,/);
    assert.match(runPlan, /new MissionRunner\(\{[\s\S]*?queuedHops,/);
    assert.match(runPlan, /candidateCircuits, queuedHops \} = built/);
    assert.doesNotMatch(runPlan, /--hop-capacity|--capacity-global|--capacity-project|--capacity-role|--capacity-runtime|--capacity-profile/);
    const planStoreAt = runPlan.indexOf('new FilePlanRunStore(');
    assert.ok(planStoreAt >= 0 && slotAt < planStoreAt && planStoreAt < runnerAt, '名额拒绝必须发生在新建 PlanRun 与构造 Runner 之前');
    assert.match(runPlan, /const runId = `\$\{plan\.planId\}-\$\{stamp\(started\)\}`/);
    assert.doesNotMatch(runPlan, /restore.*PlanRun|resumePlanRun|existingPlanRun/);
    assert.equal([...runPlan.matchAll(/createApi\(/g)].length, 1);
    assert.equal([...runPlan.matchAll(/listenLoopback\(/g)].length, 1);
    assert.equal([...runPlan.matchAll(/buildPersistentPlatform\(/g)].length, 1);
    assert.equal([...runPlan.matchAll(/buildPgPlatform\(/g)].length, 1);
    assert.equal([...runPlan.matchAll(/new MissionRunner\(/g)].length, 1);
    assert.equal([...runPlan.matchAll(/runPlanOnPlatform\(/g)].length, 1);
    assert.match(runPlan, /pick\('independent_reviewer'/);
    assert.match(runPlan, /independentReviewer:\s*\{\s*runtime,\s*candidates: independentReviewers/);
    assert.doesNotMatch(runPlan, /independentReviewer:[\s\S]{0,120}candidates:\s*coordinators/);
    assert.doesNotMatch(runPlan, /new Orchestrator/);
    assert.doesNotMatch(runPlan, /drivePlan\(/);
    assert.doesNotMatch(runPlan, /runWithDeadline/);
    assert.doesNotMatch(runPlan, /startServer\s*\(/);
    assert.doesNotMatch(runPlan, /from '\.\/application\/orchestrator\.ts'/);
    assert.doesNotMatch(runPlan, /from '\.\/application\/plan-driver\.ts'/);

    assert.match(runPlan, /startPeriodicDeliveryRepair\(/);
    assert.match(runPlan, /kind: 'file-held'/);
    assert.match(runPlan, /kind: 'pg'/);
    assert.doesNotMatch(runPlan, /startPeriodicReconcile/);
    assert.doesNotMatch(runPlan, /runHeldFileDeliveryRepair/);
    assert.doesNotMatch(runPlan, /runPgDeliveryRepairTick/);
    assert.match(runPlan, /finally \{[\s\S]*runIndependentCleanup/);
    assert.match(runPlan, /periodic\.stop\(\)/);
    assert.match(runPlan, /name: 'persist'/);
    assert.match(runPlan, /name: 'releaseLock'/);
    assert.match(runPlan, /primary = \{ error \}/);
    assert.match(runPlan, /runIndependentCleanup\(\{[\s\S]*primary/);
    assert.match(runPlan, /cleanupAfterSignal/);
    assert.match(runPlan, /formatErrorForLog/);
    assert.doesNotMatch(runPlan, /catch\(\(\) => undefined\)/);
    assert.doesNotMatch(runPlan, /reconcileInterruptedAttempts/);
    assert.doesNotMatch(runPlan, /reconcileOrphanedWorktrees/);

    assert.match(main, /hasArchivedMission/);
    assert.match(main, /export function startPeriodicDeliveryRepair/);
    assert.match(main, /runFileObserverDeliveryRepairTick/);
    assert.match(main, /bindServerCloseToPeriodicStop\(\s*server,/);
    assert.match(main, /periodic\?\.stop\(\)/);
    assert.match(main, /closeHttp = server\.close\.bind\(server\)/);
    assert.match(main, /warnDeliveryRepairErrors/);
    assert.match(main, /acquireLock\(statePath, '周期投递修复'\)/);
    const startServerSrc = main.slice(main.indexOf('export async function startServer'));
    assert.match(startServerSrc, /startPeriodicDeliveryRepair\(/);
    assert.match(startServerSrc, /kind: 'file-held'/);
    assert.match(startServerSrc, /kind: 'pg'/);
    assert.match(startServerSrc, /publishLockPort\(/);
    assert.match(startServerSrc, /attachLoopbackWriterIdentity\(/);
    assert.match(startServerSrc, /randomUUID\(/);
    assert.match(startServerSrc, /API_VERSION/);
    assert.match(startServerSrc, /exclusive:\s*\{/);
    assert.match(startServerSrc, /resolveControlPrincipal/);
    assert.doesNotMatch(startServerSrc, /kind: 'file-observer'/);
    assert.doesNotMatch(startServerSrc, /startPeriodicReconcile/);
    assert.doesNotMatch(startServerSrc, /runFileObserverDeliveryRepairTick/);
    assert.doesNotMatch(startServerSrc, /runPgDeliveryRepairTick/);
  });
});

const RUN_PLAN = fileURLToPath(new URL('../src/run-plan.ts', import.meta.url));

function snapshotTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (root: string, prefix: string) => {
    for (const name of readdirSync(root).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const path = join(root, name);
      const st = statSync(path);
      if (st.isDirectory()) {
        out.push(`${rel}/`);
        walk(path, rel);
      } else {
        out.push(`${rel}:${st.size}`);
      }
    }
  };
  walk(dir, '');
  return out;
}

function samplePlan(features: unknown[]) {
  return {
    planId: 'PLAN-check',
    projectId: 'p',
    integrationBranch: 'auto/plan-x',
    intent: '只读检查',
    stopConditions: { unresolvedEscalations: 5, wallClockMs: 1, escalationTimeoutMs: 1 },
    integrationVerification: [{ argv: ['node', '--test'], timeoutMs: 1 }],
    features,
  };
}

describe('run-plan 轮次选项接线', () => {
  test('仅配置时追加 maxRounds，原 projectRoot 和其他 options 保留；省略时原样传递', async () => {
    const { missionRunOptions } = await import('../src/run-plan.ts');
    const options = { projectRoot: '/plan-runtime-root', attemptWallClockMs: 1234 };
    assert.deepEqual(missionRunOptions(options, 30), { ...options, maxRounds: 30 });
    assert.equal(missionRunOptions(options, undefined), options);
  });
});

describe('run-plan --check 只读、零副作用', () => {
  function runCheck(planPath: string, cwd: string, extra: string[] = [], env?: NodeJS.ProcessEnv) {
    const isolated = temp('coagent-check-cwd-');
    return spawnSync(process.execPath, [RUN_PLAN, ...extra, '--plan', planPath, '--cwd', cwd, '--reviewer', 'claude', '--check'], {
      encoding: 'utf8',
      timeout: 15_000,
      cwd: isolated,
      env: env ?? { ...process.env },
    });
  }

  test('--plan --check 打印入选与未纳入原因；不改方案、不建状态/锁/运行记录/worktree', () => {
    const home = temp('coagent-check-');
    const repo = repoOn('auto/plan-x');
    const planPath = join(home, 'PLAN.json');
    const plan = samplePlan([
      { id: 'Done', title: '已合', why: 'w', allowedScope: ['a.ts'], acceptance: ['x'], status: 'done' },
      { id: 'Ok', title: '待跑', why: 'w', allowedScope: ['a.txt'], acceptance: ['x'], status: 'pending' },
    ]);
    writeFileSync(planPath, JSON.stringify(plan, null, 2));
    const beforePlan = readFileSync(planPath);
    const beforeHome = snapshotTree(home);
    const beforeRepo = snapshotTree(repo);

    const result = runCheck(planPath, repo);
    const out = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, out);
    assert.match(out, /只读检查/);
    assert.match(out, /Ok 待跑/);
    assert.match(out, /候选：待跑/);
    assert.match(out, /Done 已合/);
    assert.match(out, /源方案标 done/);
    assert.match(out, /未开跑/);
    assert.match(out, /两道闸/);
    assert.match(out, /轮次上限：12（缺省）/);
    assert.match(out, /升级单总数上限 5（缺省）/);
    assert.match(out, /每功能重跑上限 1（缺省）/);
    assert.match(out, /停止条件：未解决升级上限 5/);
    assert.doesNotMatch(out, /警告：/);
    assert.equal(readFileSync(planPath).equals(beforePlan), true);
    assert.deepEqual(snapshotTree(home), beforeHome);
    assert.deepEqual(snapshotTree(repo), beforeRepo);
    assert.equal(existsSync(join(repo, '.coagent-state.json')), false);
    assert.equal(existsSync(join(repo, '.coagent-plans')), false);
    assert.ok(!readdirSync(repo).some((name) => name.startsWith('.lock-')));
  });

  test('位置参数旧写法仍可用于 --check；缺 --cwd 或 --reviewer 非零退出', () => {
    const home = temp('coagent-check-pos-');
    const repo = repoOn('auto/plan-x');
    const planPath = join(home, 'PLAN.json');
    // 这份方案显式写了两道闸：--check 照原值展示，不标「缺省」（另一条用例覆盖缺省的情形）。
    writeFileSync(
      planPath,
      JSON.stringify(
        {
          ...samplePlan([{ id: 'Ok', title: '待跑', why: 'w', allowedScope: ['a.txt'], acceptance: ['x'] }]),
          stopConditions: {
            unresolvedEscalations: 5,
            wallClockMs: 1,
            escalationTimeoutMs: 1,
            maxEscalations: 3,
            maxRerunsPerFeature: 2,
          },
        },
        null,
        2,
      ),
    );
    const isolated = temp('coagent-check-pos-cwd-');
    const positional = spawnSync(
      process.execPath,
      [RUN_PLAN, planPath, '--cwd', repo, '--reviewer', 'claude', '--check'],
      { encoding: 'utf8', timeout: 15_000, cwd: isolated, env: { ...process.env } },
    );
    const posOut = `${positional.stdout}${positional.stderr}`;
    assert.equal(positional.status, 0, posOut);
    assert.match(posOut, /候选：旧格式待跑/);
    assert.match(posOut, /轮次上限：12（缺省）/);
    assert.match(posOut, /两道闸：升级单总数上限 3；每功能重跑上限 2\r?\n/);
    assert.doesNotMatch(posOut, /两道闸：[^\r\n]*（缺省）/);

    const missing = spawnSync(process.execPath, [RUN_PLAN, '--plan', planPath, '--check'], {
      encoding: 'utf8',
      timeout: 15_000,
      cwd: isolated,
      env: { ...process.env },
    });
    assert.notEqual(missing.status, 0);
    assert.match(`${missing.stdout}${missing.stderr}`, /--cwd/);

    const configured = spawnSync(
      process.execPath,
      [RUN_PLAN, '--max-rounds', '30', planPath, '--cwd', repo, '--reviewer', 'claude', '--check'],
      { encoding: 'utf8', timeout: 15_000, cwd: isolated, env: { ...process.env } },
    );
    const configuredOut = `${configured.stdout}${configured.stderr}`;
    assert.equal(configured.status, 0, configuredOut);
    assert.match(configuredOut, /轮次上限：30/);
  });

  test('非法 --max-rounds 在读取方案和创建状态/锁之前失败', () => {
    const home = temp('coagent-check-invalid-rounds-');
    const repo = repoOn('auto/plan-x');
    const missingPlan = join(home, 'does-not-exist.json');
    const isolated = temp('coagent-check-invalid-rounds-cwd-');
    const result = spawnSync(
      process.execPath,
      [RUN_PLAN, '--max-rounds', '101', missingPlan, '--cwd', repo, '--reviewer', 'claude', '--check', '--state', join(home, 'state.json')],
      { encoding: 'utf8', timeout: 15_000, cwd: isolated, env: { ...process.env } },
    );
    const out = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, out);
    assert.match(out, /--max-rounds/);
    assert.match(out, /1–100/);
    assert.doesNotMatch(out, /ENOENT|does-not-exist/);
    assert.equal(existsSync(join(home, 'state.json')), false);
    assert.equal(hasLockDir(home), false);
    assert.equal(hasLockDir(repo), false);
  });

  test('有候选且仓库预检不过 → 非零；没有候选 → 退出 0 且明说没有可跑的', () => {
    const dirty = repoOn('auto/plan-x');
    writeFileSync(join(dirty, 'stray.json'), '{}');
    const home = temp('coagent-check-pre-');
    const dirtyPlan = join(home, 'dirty.json');
    writeFileSync(
      dirtyPlan,
      JSON.stringify(
        samplePlan([{ id: 'Ok', title: '待跑', why: 'w', allowedScope: ['a.txt'], acceptance: ['x'], status: 'pending' }]),
        null,
        2,
      ),
    );
    const failed = runCheck(dirtyPlan, dirty);
    assert.notEqual(failed.status, 0, `${failed.stdout}${failed.stderr}`);
    assert.match(`${failed.stdout}${failed.stderr}`, /stray\.json/);
    assert.doesNotMatch(`${failed.stdout}${failed.stderr}`, /未开跑/);

    const emptyPlan = join(home, 'empty.json');
    writeFileSync(
      emptyPlan,
      JSON.stringify(
        samplePlan([{ id: 'Done', title: '已合', why: 'w', allowedScope: ['a.ts'], acceptance: ['x'], status: 'done' }]),
        null,
        2,
      ),
    );
    const none = runCheck(emptyPlan, dirty);
    const noneOut = `${none.stdout}${none.stderr}`;
    assert.equal(none.status, 0, noneOut);
    assert.match(noneOut, /没有可跑的候选/);
    assert.doesNotMatch(noneOut, /警告：/);
  });

  test('入选与未纳入之后展示契约警告；排除项仍按现有格式列入未纳入；无警告不展示警告段', () => {
    const repo = repoOn('auto/plan-x');
    const home = temp('coagent-check-warn-');
    const warnPlan = join(home, 'warn.json');
    writeFileSync(
      warnPlan,
      JSON.stringify(
        samplePlan([
          {
            id: 'Truth', title: '规格', why: 'w',
            allowedScope: ['.coagent/specs/x.md'], acceptance: ['x'], status: 'pending',
          },
          {
            id: 'Warn', title: '待跑', why: 'w',
            allowedScope: ['a.txt'], acceptance: ['src/miss.ts 也要'], status: 'pending',
          },
        ]),
        null,
        2,
      ),
    );
    const warned = runCheck(warnPlan, repo);
    const warnedOut = `${warned.stdout}${warned.stderr}`;
    assert.equal(warned.status, 0, warnedOut);
    assert.match(warnedOut, /Warn 待跑/);
    assert.match(warnedOut, /Truth 规格\s+本次未纳入：allowedScope 含 \.coagent\/ 或 VIBE\.md/);
    assert.match(warnedOut, /未开跑/);
    const warnAt = warnedOut.search(/^警告：/m);
    const selectedAt = warnedOut.search(/入选：/);
    const excludedAt = warnedOut.search(/本次未纳入：/);
    assert.ok(selectedAt >= 0 && excludedAt > selectedAt && warnAt > excludedAt, warnedOut);
    assert.match(warnedOut, /Warn：验收路径 src\/miss\.ts 未被范围覆盖/);
    assert.doesNotMatch(warnedOut, /没有可跑的候选/);
  });
});

function runOpen(planPath: string, cwd: string, extra: string[] = []) {
  const isolated = temp('coagent-open-cwd-');
  return spawnSync(process.execPath, [RUN_PLAN, ...extra, '--plan', planPath, '--cwd', cwd, '--reviewer', 'claude'], {
    encoding: 'utf8',
    timeout: 20_000,
    cwd: isolated,
    env: {
      ...process.env,
      COAGENT_AGENT_ENV_PASSTHROUGH: '-',
      COAGENT_RECONCILE_INTERVAL_MS: '0',
      COAGENT_STORE: 'file',
    },
  });
}

function hasLockDir(dir: string): boolean {
  return readdirSync(dir).some((name) => name.startsWith('.lock-'));
}

describe('run-plan 开跑路径真实副作用次序', () => {
  test('首次预检失败：不拿锁、不建状态/PlanRun，源方案不变', () => {
    const dirty = repoOn('auto/plan-x');
    writeFileSync(join(dirty, 'stray.json'), '{}');
    const home = temp('coagent-open-pre-');
    const planPath = join(home, 'PLAN.json');
    writeFileSync(
      planPath,
      JSON.stringify(
        samplePlan([{ id: 'Ok', title: '待跑', why: 'w', allowedScope: ['a.txt'], acceptance: ['x'], status: 'pending' }]),
        null,
        2,
      ),
    );
    const beforePlan = readFileSync(planPath);
    const beforeHome = snapshotTree(home);
    const beforeRepo = snapshotTree(dirty);
    const result = runOpen(planPath, dirty, ['--state', join(home, 'state.json'), '--run-dir', join(home, 'plans')]);
    const out = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, out);
    assert.match(out, /stray\.json/);
    assert.doesNotMatch(out, /开跑：/);
    assert.equal(readFileSync(planPath).equals(beforePlan), true);
    assert.deepEqual(snapshotTree(home), beforeHome);
    assert.deepEqual(snapshotTree(dirty), beforeRepo);
    assert.equal(existsSync(join(home, 'state.json')), false);
    assert.equal(existsSync(join(home, 'plans')), false);
    assert.equal(hasLockDir(home), false);
    assert.equal(hasLockDir(dirty), false);
  });

  test('没有候选：不拿锁、不建状态，源方案不变', () => {
    const repo = repoOn('auto/plan-x');
    const home = temp('coagent-open-none-');
    const planPath = join(home, 'PLAN.json');
    writeFileSync(
      planPath,
      JSON.stringify(
        samplePlan([{ id: 'Done', title: '已合', why: 'w', allowedScope: ['a.ts'], acceptance: ['x'], status: 'done' }]),
        null,
        2,
      ),
    );
    const beforePlan = readFileSync(planPath);
    const result = runOpen(planPath, repo, ['--state', join(home, 'state.json'), '--run-dir', join(home, 'plans')]);
    const out = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, out);
    assert.match(out, /没有可跑的候选/);
    assert.doesNotMatch(out, /警告：/);
    assert.equal(readFileSync(planPath).equals(beforePlan), true);
    assert.equal(existsSync(join(home, 'state.json')), false);
    assert.equal(hasLockDir(home), false);
  });

  test('正式开跑展示与 --check 同一批警告，不因警告停止；排除项列入未纳入', () => {
    const dirty = repoOn('auto/plan-x');
    writeFileSync(join(dirty, 'stray.json'), '{}');
    const home = temp('coagent-open-warn-');
    const planPath = join(home, 'PLAN.json');
    writeFileSync(
      planPath,
      JSON.stringify(
        samplePlan([
          {
            id: 'Truth', title: '规格', why: 'w',
            allowedScope: ['.coagent/specs/x.md'], acceptance: ['x'], status: 'pending',
          },
          {
            id: 'Warn', title: '待跑', why: 'w',
            allowedScope: ['a.txt'], acceptance: ['src/miss.ts 也要'], status: 'pending',
          },
        ]),
        null,
        2,
      ),
    );
    const result = runOpen(planPath, dirty, ['--state', join(home, 'state.json'), '--run-dir', join(home, 'plans')]);
    const out = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, out);
    assert.match(out, /Warn 待跑/);
    assert.match(out, /Truth 规格\s+本次未纳入：allowedScope 含 \.coagent\/ 或 VIBE\.md/);
    const warnAt = out.search(/^警告：/m);
    const excludedAt = out.search(/本次未纳入：/);
    assert.ok(warnAt > excludedAt, out);
    assert.match(out, /Warn：验收路径 src\/miss\.ts 未被范围覆盖/);
    assert.match(out, /stray\.json/);
    assert.doesNotMatch(out, /开跑：/);
    assert.equal(existsSync(join(home, 'state.json')), false, '警告不得挡住后续预检，也不得当排除');
  });

  test('有警告时正式开跑可继续：首次预检通过后仍拿锁（状态文件使二次预检失败）', () => {
    const repo = repoOn('auto/plan-x');
    const home = temp('coagent-open-warn-continue-');
    const planPath = join(home, 'PLAN.json');
    writeFileSync(
      planPath,
      JSON.stringify(
        samplePlan([
          {
            id: 'Warn', title: '待跑', why: 'w',
            allowedScope: ['a.txt'], acceptance: ['src/miss.ts 也要'], status: 'pending',
          },
        ]),
        null,
        2,
      ),
    );
    const statePath = join(repo, 'state.json');
    const result = runOpen(planPath, repo, [
      '--state',
      statePath,
      '--run-dir',
      join(home, 'plans'),
      '--worktrees',
      join(home, 'wt'),
    ]);
    const out = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, out);
    assert.match(out, /Warn 待跑/);
    assert.match(out, /Warn：验收路径 src\/miss\.ts 未被范围覆盖/);
    const warnAt = out.search(/^警告：/m);
    const lockAt = out.search(/拿到状态锁之后项目仓变脏了/);
    assert.ok(warnAt >= 0 && lockAt > warnAt, out);
    assert.doesNotMatch(out, /开跑：/);
    assert.equal(existsSync(join(home, 'plans')), false);
    assert.equal(hasLockDir(repo), false);
    assert.ok(existsSync(statePath), '警告之后仍开状态拿锁，证明未因警告停止');
  });

  test('锁后二次预检失败：已拿锁并释放，不建 PlanRun / 不起 API 开跑', () => {
    const repo = repoOn('auto/plan-x');
    const home = temp('coagent-open-lock-');
    const planPath = join(home, 'PLAN.json');
    const statePath = join(repo, 'state.json');
    writeFileSync(
      planPath,
      JSON.stringify(
        samplePlan([{ id: 'Ok', title: '待跑', why: 'w', allowedScope: ['a.txt'], acceptance: ['x'], status: 'pending' }]),
        null,
        2,
      ),
    );
    const beforePlan = readFileSync(planPath);
    const result = runOpen(planPath, repo, [
      '--state',
      statePath,
      '--run-dir',
      join(home, 'plans'),
      '--worktrees',
      join(home, 'wt'),
    ]);
    const out = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, out);
    assert.match(out, /拿到状态锁之后项目仓变脏了/);
    assert.doesNotMatch(out, /开跑：/);
    assert.equal(readFileSync(planPath).equals(beforePlan), true);
    assert.equal(existsSync(join(home, 'plans')), false);
    assert.equal(hasLockDir(repo), false);
    assert.equal(hasLockDir(home), false);
    assert.ok(existsSync(statePath), '首次预检过后才开状态；二次预检失败仍会留下状态文件');
  });
});

describe('CLI 同序装配：既有平台 + API + MissionRunner + 内部入口 + 清理', () => {
  const servers: Server[] = [];
  after(() => {
    for (const server of servers) {
      if (server.listening) server.close();
    }
  });

  test('副作用次序：筛选 → 首次预检 → 锁 → 二次预检/名额 → API → PlanRun → 清理；不另建平台/API', async () => {
    const events: string[] = [];
    const repo = repoOn('auto/plan-x');
    const home = temp('coagent-wire-');
    const plan = parsePlanSpec(
      samplePlan([{ id: 'Ok', title: '待跑', why: 'w', allowedScope: ['a.txt'], acceptance: ['x'], status: 'pending' }]),
      { reviewer: 'claude' },
    );
    events.push('select');
    const selection = selectPlanCandidates(plan, { projectRoot: repo });
    assert.equal(selection.candidates.length, 1);
    assert.equal(selection.candidates[0]?.id, 'Ok');

    events.push('preflight');
    assert.deepEqual(await preflightPlanRepo(repo, plan.integrationBranch), []);

    const statePath = join(home, 'state.json');
    const workspace = new GitWorktreeManager(join(home, 'wt'));
    const built = await buildPersistentPlatform(statePath, {
      workspace,
      exclusive: { what: 'run-plan wiring' },
    });
    events.push('lock');
    assert.equal(hasLockDir(home), true);

    let server: Server | undefined;
    try {
      events.push('preflight-after-lock');
      assert.deepEqual(await preflightPlanRepo(repo, plan.integrationBranch), []);
      events.push('slots');
      assert.deepEqual(slotHolders(await built.platform.listMissions(), plan.projectId), []);

      const listeningBefore = { count: 0 };
      server = createApi({
        platform: built.platform,
        tokens: built.tokens,
        deliveries: built.deliveries,
        onMutation: built.persist,
        agentPool: built.agentPool,
      });
      await listenLoopback(server, 0);
      servers.push(server);
      listeningBefore.count = 1;
      events.push('api');
      const portBefore = (server.address() as AddressInfo).port;
      assert.ok(portBefore > 0);
      assert.equal(server.listening, true);

      const store = new FilePlanRunStore(join(home, 'plans', 'R-wire.json'));
      const runner = new MissionRunner({
        platform: built.platform,
        tokens: makeIssuer(built.platform, built.tokens),
        baseUrl: `http://127.0.0.1:${portBefore}`,
        workspace,
        queuedHops: built.queuedHops,
        coordinator: {
          runtime: new ScriptedRuntime({}),
          candidates: [{ endpoint: 'local', profileId: 'c' }],
        },
        executor: {
          runtime: new ScriptedRuntime({}),
          candidates: [{ endpoint: 'local', profileId: 'e' }],
        },
      });
      let ran = 0;
      const stop = await runPlanOnPlatform(plan, selection, {
        store,
        projectRoot: repo,
        platform: built.platform,
        runMission: (missionId, options) => {
          ran += 1;
          return runner.run(missionId, options);
        },
        persist: built.persist,
        pauseInFlight: async (missionId) => {
          await built.platform.pauseMission(missionId);
        },
        now: () => new Date().toISOString(),
        sleep: async () => {},
        log: () => {},
        runId: 'R-wire',
        startedAt: '2020-01-01T00:00:00.000Z',
        checkRepo: () => preflightPlanRepo(repo, plan.integrationBranch),
      });
      events.push('plan-run');
      assert.equal(stop.reason, 'wall_clock');
      assert.equal(ran, 0, '墙钟已过不应派 Mission');
      assert.ok(store.read()?.stopped);
      assert.equal(server.listening, true);
      assert.equal((server.address() as AddressInfo).port, portBefore);
      assert.equal(listeningBefore.count, 1);
    } finally {
      if (server?.listening) server.close();
      await built.persist();
      built.releaseLock();
      events.push('cleanup');
    }
    assert.equal(hasLockDir(home), false);
    assert.deepEqual(events, [
      'select',
      'preflight',
      'lock',
      'preflight-after-lock',
      'slots',
      'api',
      'plan-run',
      'cleanup',
    ]);
  });
});

const HA_PLAN_FACTS = {
  mutationSideEffect: true,
  readOnlyProven: false,
  highAssurance: {
    productionDeployRelease: false,
    externalPaidOp: false,
    destructiveData: false,
    credentialsPermissionsSecurity: true,
    schemaPublicApiPersistenceCompat: true,
    unrecoverableExternalSideEffect: false,
  },
  standardFloor: {
    publicInterface: false,
    buildSystemOrDependency: false,
    multipleDomainModules: false,
    acceptanceNotCheckableUpfront: false,
    rootCauseOrCompetingDesigns: false,
  },
};

const HA_ASSESSMENT = {
  goalUncertainty: 1,
  changeScope: 2,
  operationalRisk: 2,
  verificationDifficulty: 2,
  coordinationNeed: 1,
  recoveryDifficulty: 1,
  reasons: ['HA 合格路径'],
  decidedBy: 'coordinator',
};

const HA_WORK_ORDER: WorkOrder = {
  ...ORDER,
  allowedScope: ['a.txt'],
  validation: { commands: [{ argv: ['node', '--test'], timeoutMs: 1000 }] },
};

function haCoordinatorScript(workItemId = 'W-1'): ScriptTable {
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
        { tool: 'coagent_create_work_item', body: { title: 'W', ...HA_WORK_ORDER } },
        {
          tool: 'coagent_dispatch_work_item',
          body: (previous) => ({ workItemIds: [previous.workItemId] }),
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
            acceptanceResults: ORDER.acceptance.map((criterion) => ({
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
  };
}

function haExecutorScript(workItemId = 'W-1'): ScriptTable {
  return {
    [`executor:${workItemId}`]: {
      steps: [
        { tool: 'coagent_get_work_order', body: {} },
        {
          tool: 'coagent_submit_evidence',
          body: { kind: 'test', summary: '绿', command: 'x', exitCode: 0 },
        },
        {
          tool: 'coagent_submit_execution_result',
          body: (previous) => ({
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

function haReviewerScript(): ScriptTable {
  return {
    'independent_reviewer:-': {
      steps: [
        { tool: 'coagent_get_mission_review_bundle', body: {} },
        { tool: 'coagent_submit_independent_review', body: { verdict: 'pass', reasons: ['齐'] } },
      ],
    },
  };
}

function stubHaWorkspace(head = 'commit-ha', machineFinalize = false): WorkspaceManager {
  return {
    async prepare(_missionId, projectRoot) {
      return {
        cwd: projectRoot,
        branch: 'mission/M',
        targetBranch: 'auto/plan-x',
        baseRevision: head,
      };
    },
    async head() {
      return head;
    },
    async targetHead() {
      return head;
    },
    worktreePath(_missionId, projectRoot) {
      return projectRoot;
    },
    async rollback() {},
    async mergeToTarget() {
      return { ok: true, mergedInto: head };
    },
    async diff() {
      return { stat: '', files: [] };
    },
    async release() {},
    ...(machineFinalize
      ? {
          async currentBranch() { return 'auto/plan-x'; },
          async resetTarget() { return { ok: true }; },
        }
      : {}),
  };
}

function writePlanHaAuthority(): string {
  const dir = temp('coagent-plan-ha-authority-');
  const file = join(dir, 'ha-authority.json');
  writeFileSync(file, JSON.stringify({
    version: 1,
    source: 'test-only authority fixture',
    reviewers: [{ reviewerId: 'claude', confirmedBy: 'test-human', integrationBranches: ['auto/plan-x'] }],
  }));
  return resolve(file);
}

function planHaPassingEngine(ids: SequentialIds) {
  return {
    async validate(input: { missionId: string; projectRoot: string }) {
      const id = ids.next('VR');
      const report = {
        id,
        policyRevision: 1,
        missionId: input.missionId,
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:01.000Z',
        passed: true,
        checks: [{
          kind: 'command' as const,
          passed: true,
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:00:01.000Z',
          summary: 'ok',
          command: {
            argv: [process.execPath, '-e', 'process.exit(0)'],
            cwd: input.projectRoot,
            exitCode: 0,
            timedOut: false,
            durationMs: 1,
            outputTail: 'ok',
          },
        }],
      };
      return { report, authority: { kind: 'validator' as const, reportId: id, policyRevision: 1 } };
    },
  };
}

const PLAN_HA_WORK_ITEM_ARGV = [
  process.execPath,
  '-e',
  "process.exit(require('fs').readFileSync('a.txt','utf8').trim()==='mission'?0:1)",
];

async function advancePlanHaMission(
  missionId: string,
  platform: Platform,
  workspace: WorkspaceManager,
  repo: string,
) {
  const prepared = await workspace.prepare(missionId, repo);
  await platform.recordWorkspace(missionId, {
    projectRoot: repo,
    branch: prepared.branch,
    baseRevision: prepared.baseRevision,
    targetBranch: prepared.targetBranch,
  });
  const coord = await platform.startCoordinatorAttempt(missionId, { profileId: 'coord-a', endpoint: 'local' });
  await platform.updatePlan(missionId, coord.attemptId, {
    findings: '改 a.txt', rejectedHypotheses: [], decisions: ['直接改'], direction: '改 a.txt', risks: [],
  });
  const order: WorkOrder = {
    objective: '改 a.txt',
    allowedScope: ['a.txt'],
    requiredBehaviour: 'a.txt 变成 mission',
    constraints: [],
    acceptance: ['内容是 mission'],
    verification: ['确定性验证已通过'],
    doNot: [],
    contextRefs: [],
    validation: { commands: [{ argv: PLAN_HA_WORK_ITEM_ARGV, timeoutMs: 30_000 }] },
  };
  const { workItemId } = await platform.createWorkItem(missionId, coord.attemptId, { title: '改 a.txt', order });
  await platform.dispatchWorkItems(missionId, coord.attemptId, [workItemId]);
  writeFileSync(join(prepared.cwd, 'a.txt'), 'mission\n');
  const executor = await platform.startExecutorAttempt(missionId, workItemId, { profileId: 'exec-a', endpoint: 'local' });
  await platform.submitEvidence(missionId, executor.attemptId, {
    kind: 'test', summary: '改动已验证', command: 'test fixture', exitCode: 0,
  });
  await platform.submitExecutionResult(missionId, executor.attemptId, {
    outcome: 'completed', summary: '已改好', changedFiles: ['a.txt'], evidenceIds: [], notes: '测试夹具',
  });
  await platform.finishAttempt(missionId, executor.attemptId, { endedBy: 'structured_submit' });
  await platform.reviewExecutionResult(missionId, coord.attemptId, {
    workItemId,
    verdict: 'accept',
    acceptanceResults: order.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '真实 worktree 内容已核对' })),
    reasons: ['验收通过'],
    requiredChanges: [],
  });
  await platform.submitMissionResult(missionId, coord.attemptId, {
    outcome: 'delivered', summary: '已交付', acceptanceEvidence: [], memoryDelta: [], openRisks: [],
  });
  await platform.finishAttempt(missionId, coord.attemptId, { endedBy: 'structured_submit' });
  await platform.runHaDeterministicValidation(missionId, prepared.cwd);
  const reviewer = await platform.startIndependentReviewerAttempt(missionId, [{ profileId: 'ir-a', endpoint: 'local' }]);
  await platform.submitIndependentReview(missionId, reviewer.attemptId, { verdict: 'pass', reasons: ['独立检视通过'] });
  await platform.finishAttempt(missionId, reviewer.attemptId, { endedBy: 'structured_submit' });
  return { prepared, workItemId, coordinatorAttemptId: coord.attemptId, reviewerAttemptId: reviewer.attemptId };
}

describe('真 Git HA 可复用夹具', () => {
  test('真 Git HA 夹具：有效独立 pass 停在 pending_release，目标未合并', async () => {
    const repo = repoOn('auto/plan-x');
    const anchor = git(repo, 'rev-parse', 'HEAD');
    const worktreeRoot = temp('coagent-plan-ha-worktrees-');
    const workspace = new GitWorktreeManager(worktreeRoot);
    const authorityFile = writePlanHaAuthority();
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const projects = new InMemoryProjectRepository();
    const reports = new InMemoryValidationReportRepository();
    const activity = new InMemoryActivityLog(clock);
    const platform = new Platform({
      projects,
      deliveries: new InMemoryDeliveryRepository(clock, ids),
      workspace,
      activity,
      clock,
      ids,
      validation: {
        engine: planHaPassingEngine(ids),
        reports,
        commandRunner: new ExecFileCommandRunner(),
      },
      haAuthorityFile: authorityFile,
    });
    let machineFinalizes = 0;
    let haFinalizes = 0;
    const machineFinalize = platform.finalizeMissionByMachine.bind(platform);
    const haFinalize = platform.finalizeMissionByHaAuthority.bind(platform);
    platform.finalizeMissionByMachine = async (...args) => {
      machineFinalizes += 1;
      return machineFinalize(...args);
    };
    platform.finalizeMissionByHaAuthority = async (...args) => {
      haFinalizes += 1;
      return haFinalize(...args);
    };

    const missionId = 'M-plan-ha-fixture';
    await platform.createClassifiedMission({
      projectId: 'P',
      missionId,
      contract: CONTRACT,
      facts: HA_PLAN_FACTS,
      assessment: { ...HA_ASSESSMENT, assessedAt: new Date().toISOString() },
    });
    const { prepared, reviewerAttemptId } = await advancePlanHaMission(missionId, platform, workspace, repo);
    const pass = await platform.effectiveIndependentReviewPass(missionId);
    const view = await platform.getMissionView(missionId);

    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.haReviewHold, 'pending_release');
    assert.equal(view.workspaceRef?.targetBranch, 'auto/plan-x');
    assert.equal(view.finalReview, undefined);
    assert.equal(pass?.verdict, 'pass');
    assert.ok(pass?.validationReportId);
    assert.equal((await reports.get(pass.validationReportId))?.passed, true);
    assert.ok(pass?.reviewedCommit);
    assert.ok(pass?.reviewerAttemptId);
    assert.equal(pass?.reviewerAttemptId, reviewerAttemptId);
    const independent = view.independentReviews.find((item) => item.reviewerAttemptId === reviewerAttemptId);
    assert.ok(independent);
    assert.equal(pass?.reviewedCommit, independent.reviewedCommit);
    assert.equal(pass?.validationReportId, independent.validationReportId);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), anchor);
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'base\n');
    assert.equal(readFileSync(join(prepared.cwd, 'a.txt'), 'utf8'), 'mission\n');
    assert.notEqual(prepared.cwd, repo);
    assert.equal(machineFinalizes, 0);
    assert.equal(haFinalizes, 0);
    assert.equal(git(repo, 'status', '--porcelain'), '');
    assert.equal(authorityFile.startsWith(repo), false);
    assert.equal(authorityFile.startsWith(worktreeRoot), false);
  });

  test('真 Git：方案 HA approve 受控合入，释放名额后 F2 合入', { skip: 'HA 路暂时关闭（HAOFF1，2026-09-28），恢复 HA 分支时去掉 skip' }, async () => {
    const repo = repoOn('auto/plan-x');
    writeFileSync(join(repo, 'b.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'add b');
    const anchor = git(repo, 'rev-parse', 'HEAD');
    const worktreeRoot = temp('coagent-plan-ha-approve-worktrees-');
    const stateDir = temp('coagent-plan-ha-approve-state-');
    const workspace = new GitWorktreeManager(worktreeRoot);
    const authorityFile = writePlanHaAuthority();
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const projects = new InMemoryProjectRepository();
    const reports = new InMemoryValidationReportRepository();
    const activity = new InMemoryActivityLog(clock);
    const realRunner = new ExecFileCommandRunner();
    const commandCalls: { argv: string[]; cwd: string }[] = [];
    const commandRunner = {
      async run(input: { argv: readonly string[]; cwd: string; timeoutMs: number }) {
        commandCalls.push({ argv: [...input.argv], cwd: input.cwd });
        return realRunner.run(input);
      },
    };
    const platform = new Platform({
      projects,
      deliveries: new InMemoryDeliveryRepository(clock, ids),
      workspace,
      activity,
      clock,
      ids,
      validation: { engine: planHaPassingEngine(ids), reports, commandRunner },
      haAuthorityFile: authorityFile,
    });
    let haMergedInto: string | undefined;
    const events: string[] = [];
    const originalHaFinalize = platform.finalizeMissionByHaAuthority.bind(platform);
    platform.finalizeMissionByHaAuthority = async (...args) => {
      const result = await originalHaFinalize(...args);
      if (result.status === 'completed') {
        haMergedInto = result.mergedInto;
        events.push('ha-merged');
      }
      return result;
    };
    const originalMachineFinalize = platform.finalizeMissionByMachine.bind(platform);
    const machineFinalized: string[] = [];
    platform.finalizeMissionByMachine = async (...args) => {
      machineFinalized.push(args[0]);
      return originalMachineFinalize(...args);
    };
    const originalDispatch = platform.dispatchWorkItems.bind(platform);
    platform.dispatchWorkItems = async (...args) => {
      const result = await originalDispatch(...args);
      if (args[0] === 'R-ha-approve-F2') events.push('f2-dispatched');
      return result;
    };

    const planVerificationArgv = [
      process.execPath,
      '-e',
      "const fs=require('fs');const cp=require('child_process');process.exit(fs.readFileSync('a.txt','utf8').trim()==='mission'&&cp.execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim()==='auto/plan-x'?0:1)",
    ];
    const standardFacts = {
      ...HA_PLAN_FACTS,
      highAssurance: {
        productionDeployRelease: false,
        externalPaidOp: false,
        destructiveData: false,
        credentialsPermissionsSecurity: false,
        schemaPublicApiPersistenceCompat: false,
        unrecoverableExternalSideEffect: false,
      },
      standardFloor: { ...HA_PLAN_FACTS.standardFloor, publicInterface: true },
    };
    const standardAssessment = {
      ...HA_ASSESSMENT,
      goalUncertainty: 0, changeScope: 0, operationalRisk: 0,
      verificationDifficulty: 0, coordinationNeed: 0, recoveryDifficulty: 0,
    };
    const outputFor = (facts: unknown, assessment: unknown) =>
      '分类完成。\n```json\n' + JSON.stringify({ facts, assessment }) + '\n```\n';
    const plan = parsePlanSpec({
      planId: 'PLAN-ha-approve',
      projectId: 'P',
      integrationBranch: 'auto/plan-x',
      intent: '真实 Git HA 放行后推进 F2',
      stopConditions: { unresolvedEscalations: 5, wallClockMs: 8 * 3_600_000, escalationTimeoutMs: 1_200_000 },
      integrationVerification: [{ argv: planVerificationArgv, timeoutMs: 30_000 }],
      features: [
        { id: 'Ha1', title: 'HA 修改 a', why: '先受控放行', allowedScope: ['a.txt'], acceptance: ['a.txt 为 mission'] },
        { id: 'F2', title: '标准修改 b', why: '随后推进', allowedScope: ['b.txt'], acceptance: ['b.txt 为 good'] },
      ],
    }, { reviewer: 'claude' });
    const selection = selectPlanCandidates(plan, { projectRoot: repo });
    const store = new FilePlanRunStore(join(stateDir, 'R-ha-approve.json'));
    const queryCounts = { Ha1: 0, F2: 0 };
    let waitingSnapshot: {
      head: string;
      haStatus: string;
      haFeatureStatus: string | undefined;
      haHold: string | undefined;
      haFinalReview: unknown;
      f2Status: string | undefined;
      f2Classifications: number;
      f2MissionExists: boolean;
      release: HaRelease | undefined;
      pass: Awaited<ReturnType<typeof platform.effectiveIndependentReviewPass>>;
    } | undefined;
    const runId = 'R-ha-approve';
    const haMissionId = `${runId}-Ha1`;
    const f2MissionId = `${runId}-F2`;
    const stop = await runPlanOnPlatform(plan, selection, {
      store,
      projectRoot: repo,
      platform,
      runId,
      startedAt: new Date().toISOString(),
      now: () => new Date().toISOString(),
      sleep: async () => {
        const now = new Date().toISOString();
        const run = store.read();
        const release = run?.haReleases.find((item) => item.featureId === 'Ha1' && !item.decision);
        if (!waitingSnapshot && run && release) {
          const view = await platform.getMissionView(haMissionId);
          const project = await projects.get('P');
          assert.ok(project);
          const pass = await platform.effectiveIndependentReviewPass(haMissionId);
          waitingSnapshot = {
            head: git(repo, 'rev-parse', 'HEAD'),
            haStatus: view.status,
            haFeatureStatus: run.feature('Ha1')?.status,
            haHold: view.haReviewHold,
            haFinalReview: view.finalReview,
            f2Status: run.feature('F2')?.status,
            f2Classifications: queryCounts.F2,
            f2MissionExists: project.missions.some((mission) => mission.id === f2MissionId),
            release,
            pass,
          };
          await store.update((current) => current.decideHaRelease({
            featureId: release.featureId,
            missionId: release.missionId,
            reviewedCommit: release.reviewedCommit,
            attemptId: release.attemptId,
            validationReportId: release.validationReportId,
            target: release.integrationBranch,
            as: 'claude',
            confirmedBy: 'test-human',
            action: 'approve',
          }, now));
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      log: () => {},
      persist: async () => {},
      pauseInFlight: async (missionId) => platform.pauseMission(missionId),
      runQuery: async ({ source }) => {
        const factsAndAssessment = source.endsWith(':Ha1')
          ? (queryCounts.Ha1 += 1, [HA_PLAN_FACTS, HA_ASSESSMENT])
          : source.endsWith(':F2')
            ? (queryCounts.F2 += 1, [standardFacts, standardAssessment])
            : undefined;
        if (!factsAndAssessment) throw new Error(`未知分类 source：${source}`);
        if (source.endsWith(':F2')) events.push('f2-classified');
        return {
          queryRunId: `Q-${source.split(':').at(-1)}`,
          outcome: 'answered',
          record: { output: outputFor(factsAndAssessment[0], factsAndAssessment[1]), id: source },
        } as never;
      },
      runMission: async (missionId) => {
        if (missionId === haMissionId) {
          await advancePlanHaMission(missionId, platform, workspace, repo);
          return { outcome: { kind: 'awaiting_l3_review' }, hops: [], workspace: undefined as never };
        }
        if (missionId !== f2MissionId) throw new Error(`未知 Mission：${missionId}`);
        const prepared = await workspace.prepare(missionId, repo);
        await platform.recordWorkspace(missionId, {
          projectRoot: repo,
          branch: prepared.branch,
          baseRevision: prepared.baseRevision,
          targetBranch: prepared.targetBranch,
        });
        const coord = await platform.startCoordinatorAttempt(missionId, { profileId: 'coord-f2', endpoint: 'local' });
        await platform.updatePlan(missionId, coord.attemptId, {
          findings: '改 b.txt', rejectedHypotheses: [], decisions: ['写入 good'], direction: '改 b.txt', risks: [],
        });
        const order: WorkOrder = {
          objective: '改 b.txt',
          allowedScope: ['b.txt'],
          requiredBehaviour: 'b.txt 内容为 good',
          constraints: [],
          acceptance: ['b.txt 为 good'],
          verification: ['脚本验收'],
          doNot: [],
          contextRefs: [],
          validation: { commands: [{ argv: [process.execPath, '-e', "process.exit(require('fs').readFileSync('b.txt','utf8').trim()==='good'?0:1)"], timeoutMs: 30_000 }] },
        };
        const { workItemId } = await platform.createWorkItem(missionId, coord.attemptId, { title: '改 b.txt', order });
        await platform.dispatchWorkItems(missionId, coord.attemptId, [workItemId]);
        writeFileSync(join(prepared.cwd, 'b.txt'), 'good\n');
        const executor = await platform.startExecutorAttempt(missionId, workItemId, { profileId: 'exec-f2', endpoint: 'local' });
        await platform.submitEvidence(missionId, executor.attemptId, { kind: 'test', summary: 'b.txt 为 good', command: 'fixture', exitCode: 0 });
        await platform.submitExecutionResult(missionId, executor.attemptId, {
          outcome: 'completed', summary: 'b.txt 已写入 good', changedFiles: ['b.txt'], evidenceIds: [], notes: '测试推进',
        });
        await platform.finishAttempt(missionId, executor.attemptId, { endedBy: 'structured_submit' });
        await platform.reviewExecutionResult(missionId, coord.attemptId, {
          workItemId,
          verdict: 'accept',
          acceptanceResults: order.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: 'b.txt 已写为 good' })),
          reasons: ['验收通过'],
          requiredChanges: [],
        });
        await platform.submitMissionResult(missionId, coord.attemptId, {
          outcome: 'delivered', summary: 'F2 已交付', acceptanceEvidence: [], memoryDelta: [], openRisks: [],
        });
        await platform.finishAttempt(missionId, coord.attemptId, { endedBy: 'structured_submit' });
        return { outcome: { kind: 'awaiting_l3_review' }, hops: [], workspace: undefined as never };
      },
    });

    assert.ok(waitingSnapshot);
    assert.equal(waitingSnapshot.head, anchor);
    assert.equal(waitingSnapshot.haStatus, 'awaiting_review');
    assert.equal(waitingSnapshot.haFeatureStatus, 'running');
    assert.equal(waitingSnapshot.haHold, 'pending_release');
    assert.equal(waitingSnapshot.haFinalReview, undefined);
    assert.equal(waitingSnapshot.f2Status, 'pending');
    assert.equal(waitingSnapshot.f2Classifications, 0);
    assert.equal(waitingSnapshot.f2MissionExists, false);
    assert.ok(waitingSnapshot.release);
    assert.ok(waitingSnapshot.pass);
    assert.equal(waitingSnapshot.pass.verdict, 'pass');
    assert.equal(waitingSnapshot.release.reviewedCommit, waitingSnapshot.pass.reviewedCommit);
    assert.equal(waitingSnapshot.release.attemptId, waitingSnapshot.pass.reviewerAttemptId);
    assert.equal(waitingSnapshot.release.validationReportId, waitingSnapshot.pass.validationReportId);

    assert.equal(stop.reason, 'finished');
    const run = store.read()!;
    const haView = await platform.getMissionView(haMissionId);
    const f2View = await platform.getMissionView(f2MissionId);
    assert.equal(haView.status, 'completed');
    assert.equal(haView.finalReview?.authority?.kind, 'reviewer');
    assert.ok(haMergedInto);
    assert.equal(haView.finalReview?.mergedInto, haMergedInto);
    assert.equal(run.feature('Ha1')?.status, 'merged');
    assert.ok(!machineFinalized.includes(haMissionId));
    assert.ok(machineFinalized.includes(f2MissionId));
    assert.equal(run.escalationsOpened, 0);
    assert.equal(commandCalls.length, 2);
    for (const call of commandCalls) {
      assert.deepEqual(call.argv, plan.integrationVerification[0]!.argv);
      assert.equal(call.cwd, repo);
      assert.notDeepEqual(call.argv, PLAN_HA_WORK_ITEM_ARGV);
    }
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8').trim(), 'mission');
    assert.equal(f2View.status, 'completed');
    assert.equal(f2View.finalReview?.authority?.kind, 'machine');
    assert.equal(run.feature('F2')?.status, 'merged');
    assert.equal(queryCounts.Ha1, 1);
    assert.equal(queryCounts.F2, 1);
    assert.equal(readFileSync(join(repo, 'b.txt'), 'utf8').trim(), 'good');
    assert.notEqual(git(repo, 'rev-parse', 'HEAD'), anchor);
    assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'mission');
    assert.equal(git(repo, 'show', 'HEAD:b.txt'), 'good');
    assert.equal(git(repo, 'status', '--porcelain'), '');
    assert.equal(run.escalations.length, 0);
    assert.equal(authorityFile.startsWith(repo), false);
    assert.equal(authorityFile.startsWith(worktreeRoot), false);
    assert.equal(store.path.startsWith(repo), false);
    assert.equal(store.path.startsWith(worktreeRoot), false);
    const mergedAt = events.indexOf('ha-merged');
    const f2ClassifiedAt = events.indexOf('f2-classified');
    const f2DispatchAt = events.indexOf('f2-dispatched');
    assert.ok(mergedAt >= 0);
    assert.ok(f2ClassifiedAt >= 0);
    assert.ok(f2DispatchAt >= 0);
    assert.ok(mergedAt < f2ClassifiedAt);
    assert.ok(f2ClassifiedAt < f2DispatchAt);
  });
});

describe('合格 HA 跑到 pending_release',
  () => {
    const haServers: Server[] = [];
    after(() => {
      for (const server of haServers) {
        if (server.listening) server.close();
      }
    });

    test('真实平台接线：合格 HA 等待决定，stop 保留 Mission',
      { skip: 'HA 路暂时关闭（HAOFF1，2026-09-28），恢复 HA 分支时去掉 skip' }, async () => {
        const clock = new FixedClock();
        const activity = new InMemoryActivityLog(clock);
        const ids = new SequentialIds();
        const deliveries = new InMemoryDeliveryRepository(clock, ids);
        const projects = new InMemoryProjectRepository();
        const workspace = stubHaWorkspace();
        const reports = new InMemoryValidationReportRepository();
        const validation = {
          reports,
          engine: {
            async validate(input: { missionId: string }) {
              const id = ids.next('VR');
              const report = {
                id,
                policyRevision: 1,
                missionId: input.missionId,
                startedAt: '2026-01-01T00:00:00.000Z',
                endedAt: '2026-01-01T00:00:01.000Z',
                passed: true,
                checks: [
                  {
                    kind: 'command' as const,
                    passed: true,
                    startedAt: '2026-01-01T00:00:00.000Z',
                    endedAt: '2026-01-01T00:00:01.000Z',
                    summary: 'ok',
                    command: {
                      argv: ['node', '--test'],
                      cwd: '/tmp',
                      exitCode: 0,
                      timedOut: false,
                      durationMs: 1,
                      outputTail: 'ok',
                    },
                  },
                ],
              };
              return {
                report,
                authority: { kind: 'validator' as const, reportId: id, policyRevision: 1 },
              };
            },
          },
        };
        const platform = new Platform({
          projects,
          deliveries,
          workspace,
          activity,
          clock,
          ids,
          validation,
        });
        const tokens = new RunTokenRegistry();
        const server: Server = createApi({ platform, tokens, deliveries });
        await listenLoopback(server, 0);
        haServers.push(server);
        const port = (server.address() as AddressInfo).port;
        const baseUrl = `http://127.0.0.1:${port}`;
        const home = temp('coagent-ha-plan-');
        const plan = parsePlanSpec(
          {
            planId: 'PLAN-ha',
            projectId: 'P',
            integrationBranch: 'auto/plan-x',
            intent: 'HA 停靠',
            stopConditions: { unresolvedEscalations: 5, wallClockMs: 8 * 3_600_000, escalationTimeoutMs: 1_200_000 },
            integrationVerification: [{ argv: ['node', '--test'], timeoutMs: 30_000 }],
            features: [{ id: 'Ha1', title: '合格 HA', why: 'w', allowedScope: ['a.txt'], acceptance: ['绿'] }],
          },
          { reviewer: 'claude' },
        );
        const selection = selectPlanCandidates(plan, { projectRoot: home });
        const store = new FilePlanRunStore(join(home, 'R-ha.json'));
        let waitingSnapshot: {
          featureStatus: string | undefined;
          releaseCount: number;
          releaseDecision: unknown;
          missionStatus: string;
          haReviewHold: string | undefined;
          finalReview: unknown;
        } | undefined;
        const output =
          '看完了。\n\n```json\n' +
          JSON.stringify({ facts: HA_PLAN_FACTS, assessment: HA_ASSESSMENT }) +
          '\n```\n';
        const stop = await runPlanOnPlatform(plan, selection, {
          store,
          projectRoot: home,
          platform,
          runId: 'R-ha',
          // 墙钟与驱动共用真时间，短暂让出事件循环，避免等待循环饿死平台接线测试。
          startedAt: new Date().toISOString(),
          now: () => new Date().toISOString(),
          sleep: async () => {
            const now = new Date().toISOString();
            const current = store.read();
            const pending = current?.haReleases.find((item) => item.featureId === 'Ha1' && !item.decision);
            if (!waitingSnapshot && current && pending) {
              const feature = current.feature('Ha1');
              const view = await platform.getMissionView('R-ha-Ha1');
              waitingSnapshot = {
                featureStatus: feature?.status,
                releaseCount: current.haReleases.filter((item) => item.featureId === 'Ha1' && !item.decision).length,
                releaseDecision: pending.decision,
                missionStatus: view.status,
                haReviewHold: view.haReviewHold,
                finalReview: view.finalReview,
              };
              await store.update((run) => run.decideHaRelease({
                featureId: pending.featureId,
                missionId: pending.missionId,
                reviewedCommit: pending.reviewedCommit,
                attemptId: pending.attemptId,
                validationReportId: pending.validationReportId,
                target: pending.integrationBranch,
                as: 'claude',
                confirmedBy: 'test-human',
                action: 'send_back',
                reason: '测试中打回',
              }, now));
            } else {
              const open = current?.currentEscalation;
              if (open && !open.resolution) {
                await store.update((run) => run.choose(open.id, {
                  action: 'stop', reason: '测试结束前叫停', decidedBy: 'claude',
                }, now));
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          },
          log: () => {},
          persist: async () => {},
          pauseInFlight: async (missionId) => {
            await platform.pauseMission(missionId);
          },
          runQuery: async () =>
            ({
              queryRunId: 'Q-ha',
              outcome: 'answered',
              record: { output, id: 'Q-ha' },
            }) as never,
          runMission: async (missionId, options) => {
            const runner = new MissionRunner({
              platform,
              tokens: makeIssuer(platform, tokens),
              baseUrl,
              workspace,
              coordinator: {
                runtime: new ScriptedRuntime(haCoordinatorScript()),
                candidates: [{ endpoint: 'local', profileId: 'coord-a' }],
              },
              executor: {
                runtime: new ScriptedRuntime(haExecutorScript()),
                candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
              },
              independentReviewer: {
                runtime: new ScriptedRuntime(haReviewerScript()),
                candidates: [{ endpoint: 'local', profileId: 'ir-a' }],
              },
            });
            return runner.run(missionId, options);
          },
        });
        assert.equal(stop.reason, 'reviewer_stop');
        assert.equal(waitingSnapshot?.featureStatus, 'running');
        assert.equal(waitingSnapshot?.releaseCount, 1);
        assert.equal(waitingSnapshot?.releaseDecision, undefined);
        assert.equal(waitingSnapshot?.missionStatus, 'awaiting_review');
        assert.equal(waitingSnapshot?.haReviewHold, 'pending_release');
        assert.equal(waitingSnapshot?.finalReview, undefined);
        const run = store.read()!;
        const feature = run.feature('Ha1');
        assert.equal(feature?.status, 'suspended');
        assert.equal(run.haReleases[0]?.decision?.kind, 'send_back');
        const view = await platform.getMissionView('R-ha-Ha1');
        assert.equal(view.status, 'awaiting_review');
        assert.equal(view.finalReview, undefined);
        assert.notEqual(view.status, 'completed');
        assert.notEqual(view.status, 'blocked');
      });

    test('真平台：HA 待放行时 F2 无分类、会话或派发；skip 后释放名额再推进', { skip: 'HA 路暂时关闭（HAOFF1，2026-09-28），恢复 HA 分支时去掉 skip' }, async () => {
      const runId = 'R-ha-slot';
      const haMissionId = `${runId}-Ha1`;
      const f2MissionId = `${runId}-F2`;
      const clock = new FixedClock();
      const activity = new InMemoryActivityLog(clock);
      const ids = new SequentialIds();
      const deliveries = new InMemoryDeliveryRepository(clock, ids);
      const projects = new InMemoryProjectRepository();
      const workspace = stubHaWorkspace('commit-ha', true);
      const reports = new InMemoryValidationReportRepository();
      const validation = {
        reports,
        engine: {
          async validate(input: { missionId: string }) {
            const id = ids.next('VR');
            const report = {
              id, policyRevision: 1, missionId: input.missionId,
              startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:01.000Z',
              passed: true,
              checks: [{ kind: 'command' as const, passed: true, startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:01.000Z', summary: 'ok', command: { argv: ['node', '--test'], cwd: '/tmp', exitCode: 0, timedOut: false, durationMs: 1, outputTail: 'ok' } }],
            };
            return { report, authority: { kind: 'validator' as const, reportId: id, policyRevision: 1 } };
          },
        },
        commandRunner: {
          async run() { return { exitCode: 0, timedOut: false, durationMs: 1, output: 'ok' }; },
        },
      };
      const platform = new Platform({ projects, deliveries, workspace, activity, clock, ids, validation });
      const originalAbandon = platform.abandonMissionForPlan.bind(platform);
      const events: string[] = [];
      platform.abandonMissionForPlan = async (...args) => {
        const result = await originalAbandon(...args);
        if (args[0] === haMissionId) events.push('ha-abandon');
        return result;
      };
      const tokens = new RunTokenRegistry();
      const server: Server = createApi({ platform, tokens, deliveries });
      await listenLoopback(server, 0);
      haServers.push(server);
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const home = temp('coagent-ha-slot-');
      const stateDir = temp('coagent-ha-slot-state-');
      const standardFacts = {
        ...HA_PLAN_FACTS,
        highAssurance: {
          ...HA_PLAN_FACTS.highAssurance,
          credentialsPermissionsSecurity: false,
          schemaPublicApiPersistenceCompat: false,
        },
        standardFloor: { ...HA_PLAN_FACTS.standardFloor, publicInterface: true },
      };
      const standardAssessment = {
        ...HA_ASSESSMENT,
        goalUncertainty: 0, changeScope: 0, operationalRisk: 0,
        verificationDifficulty: 0, coordinationNeed: 0, recoveryDifficulty: 0,
      };
      const outputFor = (facts: unknown, assessment: unknown) =>
        '分类完成。\n```json\n' + JSON.stringify({ facts, assessment }) + '\n```\n';
      const plan = parsePlanSpec({
        planId: 'PLAN-ha-slot', projectId: 'P', integrationBranch: 'auto/plan-x', intent: '验证 HA 占名额',
        stopConditions: { unresolvedEscalations: 5, wallClockMs: 8 * 3_600_000, escalationTimeoutMs: 1_200_000 },
        integrationVerification: [{ argv: ['node', '--test'], timeoutMs: 30_000 }],
        features: [
          { id: 'Ha1', title: '合格 HA', why: '先审查', allowedScope: ['a.txt'], acceptance: ['绿'] },
          { id: 'F2', title: '后续标准功能', why: '等待名额', allowedScope: ['a.txt'], acceptance: ['绿'] },
        ],
      }, { reviewer: 'claude' });
      const selection = selectPlanCandidates(plan, { projectRoot: home });
      const store = new FilePlanRunStore(join(stateDir, `${runId}.json`));
      const queryCounts = { Ha1: 0, F2: 0 };
      const counters = { f2CoordinatorSessions: 0, f2WorkItemCreates: 0, f2Dispatches: 0, f2ExecutorSessions: 0 };
      let waitingSnapshot: {
        featureStatus: string | undefined;
        f2Status: string | undefined;
        f2MissionExists: boolean;
        f2Classifications: number;
        f2CoordinatorSessions: number;
        f2WorkItemCreates: number;
        f2Dispatches: number;
        escalationsOpened: number;
        haAbandoned: boolean;
        haStatus: string;
        haHold: string | undefined;
        haFinalReview: unknown;
      } | undefined;
      const stop = await runPlanOnPlatform(plan, selection, {
        store, projectRoot: home, platform, runId,
        startedAt: new Date().toISOString(), now: () => new Date().toISOString(),
        sleep: async () => {
          const now = new Date().toISOString();
          const run = store.read();
          const pending = run?.haReleases.find((release) => release.featureId === 'Ha1' && !release.decision);
          if (!waitingSnapshot && run && pending) {
            const haView = await platform.getMissionView(haMissionId);
            const project = await projects.get('P');
            assert.ok(project, 'HA 首条 Mission 已创建项目');
            waitingSnapshot = {
              featureStatus: run.feature('Ha1')?.status,
              f2Status: run.feature('F2')?.status,
              f2MissionExists: project.missions.some((mission) => mission.id === f2MissionId),
              f2Classifications: queryCounts.F2,
              f2CoordinatorSessions: counters.f2CoordinatorSessions,
              f2WorkItemCreates: counters.f2WorkItemCreates,
              f2Dispatches: counters.f2Dispatches,
              escalationsOpened: run.escalationsOpened,
              haAbandoned: events.includes('ha-abandon'),
              haStatus: haView.status,
              haHold: haView.haReviewHold,
              haFinalReview: haView.finalReview,
            };
            await store.update((current) => current.decideHaRelease({
              featureId: pending.featureId, missionId: pending.missionId,
              reviewedCommit: pending.reviewedCommit, attemptId: pending.attemptId,
              validationReportId: pending.validationReportId, target: pending.integrationBranch,
              as: 'claude', confirmedBy: 'test-human', action: 'send_back', reason: '先放弃再重跑',
            }, now));
          } else {
            const open = run?.currentEscalation;
            if (open && !open.resolution) {
              await store.update((current) => current.choose(open.id, {
                action: 'skip', reason: '释放项目名额', decidedBy: 'claude',
              }, now));
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
        log: () => {}, persist: async () => {}, pauseInFlight: async (missionId) => platform.pauseMission(missionId),
        runQuery: async ({ source }) => {
          const isF2 = source.endsWith(':F2');
          const featureId = isF2 ? 'F2' : 'Ha1';
          queryCounts[featureId] += 1;
          if (isF2) events.push('f2-classification');
          return {
            queryRunId: `Q-${featureId}`, outcome: 'answered',
            record: { output: outputFor(isF2 ? standardFacts : HA_PLAN_FACTS, isF2 ? standardAssessment : HA_ASSESSMENT), id: `Q-${featureId}` },
          } as never;
        },
        runMission: async (missionId, options) => {
          const workItemId = missionId === f2MissionId ? 'W-2' : 'W-1';
          const coordinatorScript = new ScriptedRuntime(haCoordinatorScript(workItemId));
          const executorScript = new ScriptedRuntime(haExecutorScript(workItemId));
          const coordinatorRuntime = {
            kind: coordinatorScript.kind,
            supportsQuery: coordinatorScript.supportsQuery,
            start: async (spec: Parameters<typeof coordinatorScript.start>[0]) => {
              if (missionId === f2MissionId && spec.role === 'coordinator') {
                counters.f2CoordinatorSessions += 1;
                events.push('f2-coordinator');
              }
              const agentRun = await coordinatorScript.start(spec);
              agentRun.on((event) => {
                if (missionId !== f2MissionId || event.kind !== 'tool.started') return;
                if (event.name === 'coagent_create_work_item') {
                  counters.f2WorkItemCreates += 1;
                  events.push('f2-work-item');
                }
                if (event.name === 'coagent_dispatch_work_item') {
                  counters.f2Dispatches += 1;
                  events.push('f2-dispatch');
                }
              });
              return agentRun;
            },
          };
          const executorRuntime = {
            kind: executorScript.kind,
            supportsQuery: executorScript.supportsQuery,
            start: async (spec: Parameters<typeof executorScript.start>[0]) => {
              if (missionId === f2MissionId && spec.role === 'executor') counters.f2ExecutorSessions += 1;
              return executorScript.start(spec);
            },
          };
          const runner = new MissionRunner({
            platform, tokens: makeIssuer(platform, tokens), baseUrl, workspace,
            coordinator: { runtime: coordinatorRuntime, candidates: [{ endpoint: 'local', profileId: 'coord-a' }] },
            executor: { runtime: executorRuntime, candidates: [{ endpoint: 'local', profileId: 'exec-a' }] },
            independentReviewer: { runtime: new ScriptedRuntime(haReviewerScript()), candidates: [{ endpoint: 'local', profileId: 'ir-a' }] },
          });
          return runner.run(missionId, options);
        },
      });
      assert.equal(waitingSnapshot?.featureStatus, 'running');
      assert.equal(waitingSnapshot?.f2Status, 'pending');
      assert.equal(waitingSnapshot?.f2MissionExists, false);
      assert.equal(waitingSnapshot?.f2Classifications, 0);
      assert.equal(waitingSnapshot?.f2CoordinatorSessions, 0);
      assert.equal(waitingSnapshot?.f2WorkItemCreates, 0);
      assert.equal(waitingSnapshot?.f2Dispatches, 0);
      assert.equal(waitingSnapshot?.escalationsOpened, 0);
      assert.equal(waitingSnapshot?.haAbandoned, false);
      assert.equal(waitingSnapshot?.haStatus, 'awaiting_review');
      assert.equal(waitingSnapshot?.haHold, 'pending_release');
      assert.equal(waitingSnapshot?.haFinalReview, undefined);
      const run = store.read()!;
      assert.equal(stop.reason, 'finished');
      assert.equal(run.haReleases[0]?.decision?.kind, 'send_back');
      assert.equal(run.escalationsOpened, 1);
      assert.equal(run.escalations[0]?.resolution?.kind, 'decided');
      assert.equal(run.escalations[0]?.resolution?.action, 'skip');
      assert.equal(run.feature('F2')?.status, 'merged');
      // F2 协调分两跳：规划 / 派发，以及评审 / 交卷。
      assert.equal(counters.f2CoordinatorSessions, 2);
      assert.equal(counters.f2WorkItemCreates, 1);
      assert.equal(counters.f2Dispatches, 1);
      assert.equal(counters.f2ExecutorSessions, 1);
      const abandonAt = events.indexOf('ha-abandon');
      const classifyAt = events.indexOf('f2-classification');
      const coordinatorAt = events.indexOf('f2-coordinator');
      const dispatchAt = events.indexOf('f2-dispatch');
      assert.ok(abandonAt >= 0);
      assert.ok(classifyAt >= 0);
      assert.ok(coordinatorAt >= 0);
      assert.ok(dispatchAt >= 0);
      assert.ok(abandonAt < classifyAt);
      assert.ok(classifyAt < coordinatorAt);
      assert.ok(coordinatorAt < dispatchAt);
      assert.ok(!run.escalations.some((escalation) => escalation.featureId === 'F2' && /PROJECT_BUSY/.test(escalation.failure)));
      assert.ok(!run.escalations.some((escalation) => escalation.featureId === 'F2'));
      assert.equal(queryCounts.Ha1, 1);
      assert.equal(queryCounts.F2, 1);
      const abandonedHa = await platform.getMissionView(haMissionId);
      assert.equal(abandonedHa.status, 'blocked');
      const abandonAuthority = abandonedHa.finalReview?.authority;
      assert.equal(abandonAuthority?.kind, 'plan');
      if (abandonAuthority?.kind === 'plan') {
        assert.equal(abandonAuthority.planRunId, runId);
        assert.equal(abandonAuthority.escalationId, 'E-1');
      }
    });

    test('禁止副作用字段缺失时挂起，建单前不创建 Mission', async () => {
      const clock = new FixedClock();
      const activity = new InMemoryActivityLog(clock);
      const ids = new SequentialIds();
      const deliveries = new InMemoryDeliveryRepository(clock, ids);
      const workspace = stubHaWorkspace();
      const projects = new InMemoryProjectRepository();
      const platform = new Platform({ projects, deliveries, workspace, activity, clock, ids });
      const home = temp('coagent-ha-unproven-');
      const plan = parsePlanSpec(
        {
          planId: 'PLAN-ha-unproven', projectId: 'P', integrationBranch: 'auto/plan-x', intent: '缺失字段挂起',
          stopConditions: { unresolvedEscalations: 5, wallClockMs: 8 * 3_600_000, escalationTimeoutMs: 1_200_000 },
          integrationVerification: [{ argv: ['node', '--test'], timeoutMs: 30_000 }],
          features: [{ id: 'HaMissing', title: '禁止副作用未证明', why: 'w', allowedScope: ['a.txt'], acceptance: ['绿'] }],
        },
        { reviewer: 'claude' },
      );
      const selection = selectPlanCandidates(plan, { projectRoot: home });
      const store = new FilePlanRunStore(join(home, 'R-ha-unproven.json'));
      const incompleteFacts = {
        ...HA_PLAN_FACTS,
        highAssurance: { ...HA_PLAN_FACTS.highAssurance, externalPaidOp: undefined },
      };
      const output = '分类结果。\n```json\n' + JSON.stringify({ facts: incompleteFacts, assessment: HA_ASSESSMENT }) + '\n```\n';
      // 真时间避免墙钟伪过期；任何等待都说明流程错误，立即失败。
      const stop = await runPlanOnPlatform(plan, selection, {
        store, projectRoot: home, platform, runId: 'R-ha-unproven',
        startedAt: new Date().toISOString(), now: () => new Date().toISOString(),
        sleep: async () => { throw new Error('禁止副作用未证明不应等待'); },
        log: () => {}, persist: async () => {}, pauseInFlight: async () => {},
        runQuery: async () => ({ queryRunId: 'Q-unproven', outcome: 'answered', record: { output, id: 'Q-unproven' } }) as never,
        runMission: async () => { throw new Error('不完整禁止副作用信号不得运行 Mission'); },
      });
      assert.equal(stop.reason, 'finished');
      const feature = store.read()!.feature('HaMissing');
      assert.equal(feature?.status, 'suspended');
      assert.match(feature?.needsDecision ?? '', /externalPaidOp/);
      const missions = await platform.listMissions();
      assert.ok(!missions.some((mission) => mission.missionId === 'R-ha-unproven-HaMissing'));
    });

    test('独立检视池为空时不以 coordinator 自审代替',
      () => {
        const src = readFileSync(join(import.meta.dirname, '..', 'src', 'run-plan.ts'), 'utf8');
        assert.match(src, /candidates: independentReviewers/);
        assert.doesNotMatch(src, /independentReviewer:[\s\S]{0,160}candidates:\s*coordinators/);
        assert.match(src, /空池也原样交给 MissionRunner/);
      });

    test('CLI 把运行内退避等待上限 120000 交给 MissionRunner',
      () => {
        const src = readFileSync(join(import.meta.dirname, '..', 'src', 'run-plan.ts'), 'utf8');
        assert.match(src, /new MissionRunner\(\{[\s\S]*?inRunBackoffWaitMs:\s*120_000/);
      });
  });

describe('run-plan 方案驱动：真实 MissionRunner 失败停靠队列',
  () => {
    const servers: Server[] = [];
    after(() => {
      for (const server of servers) {
        if (server.listening) server.close();
      }
    });

    function countingTerminalReview(platform: Platform) {
      const counts = { machine: 0, abandon: 0 };
      const machine = platform.finalizeMissionByMachine.bind(platform);
      const abandon = platform.abandonMissionForPlan.bind(platform);
      platform.finalizeMissionByMachine = (async (...args: Parameters<Platform['finalizeMissionByMachine']>) => {
        counts.machine += 1;
        return machine(...args);
      }) as Platform['finalizeMissionByMachine'];
      platform.abandonMissionForPlan = (async (...args: Parameters<Platform['abandonMissionForPlan']>) => {
        counts.abandon += 1;
        return abandon(...args);
      }) as Platform['abandonMissionForPlan'];
      return counts;
    }

    async function executorQueueRow(queuedHops: {
      get(id: string): Promise<QueuedHop | undefined>;
      list(): Promise<readonly QueuedHop[]>;
    }) {
      const listed = (await queuedHops.list()).filter((row) => row.role === 'executor');
      assert.equal(listed.length, 1);
      const got = await queuedHops.get(listed[0]!.id);
      assert.ok(got);
      assert.deepEqual(got, listed[0]);
      return got!;
    }

    test('注入 queuedHops 的真实 Runner：首次退避、重入不多计、到期死信，不误触终审/放弃',
      async () => {
        const repo = repoOn('auto/plan-x');
        const home = temp('coagent-plan-fail-queue-');
        const workspace = new GitWorktreeManager(join(home, 'wt'));
        const built = await buildPersistentPlatform(join(home, 'state.json'), { workspace });
        try {
          assert.ok(built.queuedHops instanceof FileQueuedHopRepository);
          const server: Server = createApi({
            platform: built.platform,
            tokens: built.tokens,
            deliveries: built.deliveries,
            onMutation: built.persist,
          });
          await listenLoopback(server, 0);
          servers.push(server);
          const port = (server.address() as AddressInfo).port;
          const hopNow = new Date().toISOString();
          const hopClock = new FixedClock(hopNow);
          const terminal = countingTerminalReview(built.platform);
          const coordinatorRuntime = new ScriptedRuntime({
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
                { tool: 'coagent_create_work_item', body: { title: 'W', ...ORDER } },
                {
                  tool: 'coagent_dispatch_work_item',
                  body: (previous) => ({ workItemIds: [previous.workItemId] }),
                },
              ],
            },
          });
          const executorRuntime = new ScriptedRuntime({
            'executor:W-1': { steps: [], upstreamFailure: 'HTTP 503 Service Unavailable' },
          });
          // 与 src/run-plan.ts:399-412 相同：queuedHops / candidateCircuits 注入真实 MissionRunner。
          // 队列退避 1s，默认候选熔断 5min：不把池冷却压到 0，到期重领会被伪装成 no_available_agent。
          const runner = new MissionRunner({
            platform: built.platform,
            tokens: makeIssuer(built.platform, built.tokens),
            baseUrl: `http://127.0.0.1:${port}`,
            workspace,
            candidateCircuits: built.candidateCircuits,
            queuedHops: built.queuedHops,
            hopClock,
            coordinator: {
              runtime: coordinatorRuntime,
              candidates: [{ endpoint: 'local', profileId: 'coord-a' }],
              cooldownMs: 0,
            },
            executor: {
              runtime: executorRuntime,
              candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
              maxAttempts: 2,
              cooldownMs: 0,
            },
          });
          const plan = parsePlanSpec(
            {
              planId: 'PLAN-fail-queue',
              projectId: 'P',
              integrationBranch: 'auto/plan-x',
              intent: '受控上游失败停靠',
              // 第一次等待即过期并因未解决上限停方案：避免无限等升级，且 settle 见 stopped 不放弃 Mission。
              stopConditions: {
                unresolvedEscalations: 1,
                wallClockMs: 8 * 3_600_000,
                escalationTimeoutMs: 20,
              },
              integrationVerification: [{ argv: ['node', '--test'], timeoutMs: 30_000 }],
              features: [{
                id: 'Fail1',
                title: '受控失败',
                why: '队列退避',
                allowedScope: ['a.txt'],
                acceptance: ['绿'],
              }],
            },
            { reviewer: 'claude' },
          );
          const selection = selectPlanCandidates(plan, { projectRoot: repo });
          const store = new FilePlanRunStore(join(home, 'R-fail-queue.json'));
          const runId = 'R-fail-queue';
          const missionId = `${runId}-Fail1`;
          let ran = 0;
          const stop = await runPlanOnPlatform(plan, selection, {
            store,
            projectRoot: repo,
            platform: built.platform,
            runMission: (id, options) => {
              ran += 1;
              return runner.run(id, options);
            },
            persist: built.persist,
            pauseInFlight: async (id) => {
              await built.platform.pauseMission(id);
            },
            now: () => new Date().toISOString(),
            sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
            log: () => {},
            runId,
            startedAt: new Date().toISOString(),
            pollMs: 5,
            checkRepo: () => preflightPlanRepo(repo, plan.integrationBranch),
          });
          assert.equal(ran, 1, '方案驱动必须真正调用注入队列的 MissionRunner');
          assert.equal(stop.reason, 'unresolved_escalations');
          const hop = await executorQueueRow(built.queuedHops);
          assert.equal(hop.status, 'retry_wait');
          assert.equal(hop.attemptCount, 1);
          assert.ok(hop.lastFailure);
          assert.ok(Date.parse(hop.availableAt) > Date.parse(hop.lastFailure.at));
          assert.equal(hop.lastFailure.classification, 'upstream_5xx');
          assert.equal(hop.lastFailure.disposition, 'retry_then_dead_letter');
          assert.equal(hop.lastFailure.retryable, true);
          built.persist();
          const throughStore = new FileQueuedHopRepository(built.store);
          assert.deepEqual(await throughStore.get(hop.id), hop);
          const view1 = await built.platform.getMissionView(missionId);
          assert.notEqual(view1.status, 'completed');
          assert.equal(view1.workItems[0]?.attempts, 1);
          const execStarts1 = executorRuntime.specs.length;
          assert.equal(execStarts1, 1);
          const firstFailure = { ...hop.lastFailure };
          const firstAvailableAt = hop.availableAt;
          assert.equal(terminal.machine, 0, '首次退避不得调用机器终审');
          assert.equal(terminal.abandon, 0, '首次退避不得自动放弃 Mission');

          const early = await runner.run(missionId, { projectRoot: repo });
          assert.equal(early.outcome.kind, 'waiting');
          if (early.outcome.kind === 'waiting') {
            assert.equal(early.outcome.reason, 'project_busy');
            assert.match(early.outcome.detail, /退避/);
          }
          const duringBackoff = await executorQueueRow(built.queuedHops);
          assert.equal(duringBackoff.id, hop.id);
          assert.equal(duringBackoff.status, 'retry_wait');
          assert.equal(duringBackoff.attemptCount, 1);
          assert.equal(duringBackoff.availableAt, firstAvailableAt);
          assert.deepEqual(duringBackoff.lastFailure, firstFailure);
          assert.equal(executorRuntime.specs.length, execStarts1, '退避期间不得启动新 Agent');
          assert.equal((await built.platform.getMissionView(missionId)).workItems[0]?.attempts, 1);
          assert.equal(terminal.machine, 0);
          assert.equal(terminal.abandon, 0);

          hopClock.advance(Date.parse(hop.availableAt) - Date.parse(hopNow));
          const second = await runner.run(missionId, { projectRoot: repo });
          assert.equal(second.outcome.kind, 'waiting');
          if (second.outcome.kind === 'waiting') {
            assert.equal(second.outcome.reason, 'attempt_limit_reached');
            assert.match(second.outcome.detail, /死信/);
          }
          const dead = await executorQueueRow(built.queuedHops);
          assert.equal(dead.id, hop.id);
          assert.equal(dead.status, 'dead_letter');
          assert.equal(dead.attemptCount, 2);
          assert.equal(executorRuntime.specs.length, execStarts1 + 1);
          assert.notEqual((await built.platform.getMissionView(missionId)).status, 'completed');
          built.persist();
          assert.equal((await throughStore.get(dead.id))?.status, 'dead_letter');
          assert.equal(terminal.machine, 0);
          assert.equal(terminal.abandon, 0);

          const again = await runner.run(missionId, { projectRoot: repo });
          assert.equal(again.outcome.kind, 'waiting');
          if (again.outcome.kind === 'waiting') {
            assert.equal(again.outcome.reason, 'attempt_limit_reached');
            assert.notEqual(again.outcome.reason, 'no_available_agent');
            assert.match(again.outcome.detail, /死信/);
          }
          const stillDead = await executorQueueRow(built.queuedHops);
          assert.equal(stillDead.id, hop.id);
          assert.equal(stillDead.status, 'dead_letter');
          assert.equal(stillDead.attemptCount, 2);
          assert.equal(executorRuntime.specs.length, execStarts1 + 1, '死信后不得再启动 Agent');
          assert.notEqual((await built.platform.getMissionView(missionId)).status, 'completed');
          assert.equal(store.read()?.feature('Fail1')?.status, 'suspended');
          assert.equal(terminal.machine, 0, '失败与死信均不得调用机器终审');
          assert.equal(terminal.abandon, 0, '失败与死信均不得自动放弃 Mission');
        } finally {
          built.releaseLock();
        }
      });
  });

async function postAgentJson(
  base: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: { error?: string } }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-coagent-run': token } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: (await res.json()) as { error?: string } };
}

describe('生产入口 makeIssuer 队列领取身份', () => {
  const servers: Server[] = [];
  after(() => {
    for (const server of servers) {
      if (server.listening) server.close();
    }
  });

  test('源码：run-plan 经共用 makeIssuer 发牌', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'run-plan.ts'), 'utf8');
    assert.match(src, /tokens:\s*makeIssuer\(platform,\s*tokens\)/);
  });

  test('三类 start 把真实领取身份交给 Platform 并冻结进 token；失租 finish 拒绝；请求体不能自述身份；非队列不变', async () => {
    const home = temp('coagent-plan-claim-');
    const built = await buildPersistentPlatform(join(home, 'state.json'), {
      workspace: new InPlaceWorkspaceManager(),
    });
    const server: Server = createApi({
      platform: built.platform,
      tokens: built.tokens,
      deliveries: built.deliveries,
    });
    await listenLoopback(server, 0);
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const hops = built.queuedHops;
      assert.ok(hops instanceof FileQueuedHopRepository);
      const now = new Date().toISOString();
      const lease = new Date(Date.now() + 60_000).toISOString();
      await hops.enqueue({
        id: 'h-plan-claim',
        projectId: 'P',
        missionId: 'M-claim',
        workItemId: '-',
        role: 'coordinator',
        priority: 1,
        availableAt: now,
        attemptCount: 0,
        maxAttempts: 2,
        idempotencyKey: 'run-plan-claim',
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      });
      const claimed = await hops.claim('h-plan-claim', 'owner', now, lease);
      assert.equal(claimed?.claimGeneration, 1);
      const live: QueueClaimIdentity = { id: 'h-plan-claim', owner: 'owner', claimGeneration: 1 };

      await built.platform.createMission({
        projectId: 'P',
        missionId: 'M-claim',
        contract: CONTRACT,
      });
      await built.platform.createMission({
        projectId: 'P',
        missionId: 'M-nq',
        contract: CONTRACT,
      });

      const startClaims: Array<{ role: string; claim: QueueClaimIdentity | undefined }> = [];
      const origCoord = built.platform.startCoordinatorAttempt.bind(built.platform);
      built.platform.startCoordinatorAttempt = (async (missionId, profile, claim) => {
        startClaims.push({ role: 'coordinator', claim });
        return origCoord(missionId, profile, claim);
      }) as Platform['startCoordinatorAttempt'];
      const origExec = built.platform.startExecutorAttempt.bind(built.platform);
      built.platform.startExecutorAttempt = (async (missionId, workItemId, profile, claim) => {
        startClaims.push({ role: 'executor', claim });
        return origExec(missionId, workItemId, profile, claim);
      }) as Platform['startExecutorAttempt'];
      const origIr = built.platform.startIndependentReviewerAttempt.bind(built.platform);
      built.platform.startIndependentReviewerAttempt = (async (missionId, candidates, claim) => {
        startClaims.push({ role: 'independent_reviewer', claim });
        return origIr(missionId, candidates, claim);
      }) as Platform['startIndependentReviewerAttempt'];

      const issuer = makeIssuer(built.platform, built.tokens);
      const profile = { endpoint: 'local' as const, profileId: 'coord-a' };
      const queued = await issuer.startCoordinator('M-claim', profile, live);
      const frozen = built.tokens.resolve(queued.token);
      assert.deepEqual(frozen?.claim, live);
      assert.equal(Object.isFrozen(frozen?.claim), true);
      assert.equal(await built.platform.attemptRequiresQueueClaim('M-claim', queued.attemptId), true);
      assert.deepEqual(
        startClaims.find((row) => row.role === 'coordinator' && row.claim !== undefined)?.claim,
        live,
      );

      const unmarked = await issuer.startCoordinator('M-nq', profile);
      assert.equal(built.tokens.resolve(unmarked.token)?.claim, undefined);
      assert.equal(await built.platform.attemptRequiresQueueClaim('M-nq', unmarked.attemptId), false);

      await assert.rejects(() => issuer.startExecutor('M-claim', 'W-missing', profile, live));
      await assert.rejects(() =>
        issuer.startIndependentReviewer!('M-claim', [{ profileId: 'ir-a', endpoint: 'local' }], live),
      );
      assert.deepEqual(startClaims.find((row) => row.role === 'executor')?.claim, live);
      assert.deepEqual(startClaims.find((row) => row.role === 'independent_reviewer')?.claim, live);

      const later = new Date(Date.now() + 120_000).toISOString();
      const taken = await hops.claim(live.id, 'next', lease, later);
      assert.equal(taken?.claimGeneration, 2);
      await assert.rejects(
        () => built.platform.finishAttempt('M-claim', queued.attemptId, { endedBy: 'structured_submit' }, live),
        (error: unknown) => error instanceof PlatformRuleError && error.code === 'CLAIM_FENCE_REJECTED',
      );
      assert.equal(
        (await built.projects.get('P'))!.missions.find((m) => m.id === 'M-claim')!.coordinatorAttempts[0]!.status,
        'in_progress',
      );

      const spoofed = await postAgentJson(
        baseUrl,
        `/api/missions/M-claim/attempts/${queued.attemptId}/finish`,
        { endedBy: 'structured_submit', owner: 'next', claimGeneration: 2, id: live.id },
        queued.token,
      );
      assert.notEqual(spoofed.status, 200);
      assert.equal(spoofed.json.error, 'CLAIM_FENCE_REJECTED');
      assert.equal(
        (await built.projects.get('P'))!.missions.find((m) => m.id === 'M-claim')!.coordinatorAttempts[0]!.status,
        'in_progress',
      );

      await built.platform.finishAttempt('M-nq', unmarked.attemptId, { endedBy: 'structured_submit' });
      assert.notEqual(
        (await built.projects.get('P'))!.missions.find((m) => m.id === 'M-nq')!.coordinatorAttempts[0]!.status,
        'in_progress',
      );
    } finally {
      built.releaseLock();
    }
  });

  test('MissionRunner 队列 hop 开牌与 finally finish 带同一领取身份；非队列不带 claim', async () => {
    const home = temp('coagent-plan-orch-claim-');
    const queuedBuilt = await buildPersistentPlatform(join(home, 'state-q.json'), {
      workspace: new InPlaceWorkspaceManager(),
    });
    const plainBuilt = await buildPersistentPlatform(join(home, 'state-nq.json'), {
      workspace: new InPlaceWorkspaceManager(),
    });
    const qServer: Server = createApi({
      platform: queuedBuilt.platform,
      tokens: queuedBuilt.tokens,
      deliveries: queuedBuilt.deliveries,
    });
    const nqServer: Server = createApi({
      platform: plainBuilt.platform,
      tokens: plainBuilt.tokens,
      deliveries: plainBuilt.deliveries,
    });
    await listenLoopback(qServer, 0);
    await listenLoopback(nqServer, 0);
    servers.push(qServer, nqServer);
    try {
      const finishes: Array<QueueClaimIdentity | undefined> = [];
      const origFinish = queuedBuilt.platform.finishAttempt.bind(queuedBuilt.platform);
      queuedBuilt.platform.finishAttempt = (async (missionId, attemptId, outcome, claim) => {
        finishes.push(claim);
        return origFinish(missionId, attemptId, outcome, claim);
      }) as Platform['finishAttempt'];

      await queuedBuilt.platform.createMission({
        projectId: 'P',
        missionId: 'M-orch',
        contract: CONTRACT,
      });
      const qRunner = new MissionRunner({
        platform: queuedBuilt.platform,
        tokens: makeIssuer(queuedBuilt.platform, queuedBuilt.tokens),
        baseUrl: `http://127.0.0.1:${(qServer.address() as AddressInfo).port}`,
        workspace: new InPlaceWorkspaceManager(),
        queuedHops: queuedBuilt.queuedHops,
        owner: 'runner-claim',
        coordinator: {
          runtime: new ScriptedRuntime({
            'coordinator:-:0': { steps: [{ tool: 'coagent_get_mission', body: {} }] },
          }),
          candidates: [{ endpoint: 'local', profileId: 'coord-a' }],
        },
        executor: {
          runtime: new ScriptedRuntime({}),
          candidates: [],
        },
      });
      await qRunner.run('M-orch', { projectRoot: home, maxRounds: 1 });
      const queuedFinishes = finishes.filter((row): row is QueueClaimIdentity => row !== undefined);
      assert.ok(queuedFinishes.length >= 1);
      assert.ok(
        queuedFinishes.every(
          (row) => row.owner === 'runner-claim' && row.claimGeneration === 1 && row.id.length > 0,
        ),
      );

      const nqFinishes: Array<QueueClaimIdentity | undefined> = [];
      const origNq = plainBuilt.platform.finishAttempt.bind(plainBuilt.platform);
      plainBuilt.platform.finishAttempt = (async (missionId, attemptId, outcome, claim) => {
        nqFinishes.push(claim);
        return origNq(missionId, attemptId, outcome, claim);
      }) as Platform['finishAttempt'];
      await plainBuilt.platform.createMission({
        projectId: 'P',
        missionId: 'M-plain',
        contract: CONTRACT,
      });
      const nqRunner = new MissionRunner({
        platform: plainBuilt.platform,
        tokens: makeIssuer(plainBuilt.platform, plainBuilt.tokens),
        baseUrl: `http://127.0.0.1:${(nqServer.address() as AddressInfo).port}`,
        workspace: new InPlaceWorkspaceManager(),
        owner: 'runner-claim',
        coordinator: {
          runtime: new ScriptedRuntime({
            'coordinator:-:0': { steps: [{ tool: 'coagent_get_mission', body: {} }] },
          }),
          candidates: [{ endpoint: 'local', profileId: 'coord-a' }],
        },
        executor: {
          runtime: new ScriptedRuntime({}),
          candidates: [],
        },
      });
      await nqRunner.run('M-plain', { projectRoot: home, maxRounds: 1 });
      assert.ok(nqFinishes.length >= 1);
      assert.ok(nqFinishes.every((row) => row === undefined));
    } finally {
      queuedBuilt.releaseLock();
      plainBuilt.releaseLock();
    }
  });
});

function hostedPlanRequestBody(overrides: Record<string, unknown> = {}) {
  const plan = parsePlanSpec(
    samplePlan([{ id: 'Ok', title: '待跑', why: 'w', allowedScope: ['a.txt'], acceptance: ['x'], status: 'pending' }]),
    { reviewer: 'claude' },
  );
  return {
    plan,
    selection: { candidates: plan.features, exclusions: [], warnings: [] },
    cwd: '/tmp',
    adapter: '/tmp/fake-adapter.ts',
    runDir: '/tmp/plans',
    store: 'file',
    env: { COAGENT_AGENT_ENV_PASSTHROUGH: '-' },
    ...overrides,
  };
}

function spawnRunPlan(args: string[], env?: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [RUN_PLAN, ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: env ?? { ...process.env, COAGENT_AGENT_ENV_PASSTHROUGH: '-', COAGENT_RECONCILE_INTERVAL_MS: '0', COAGENT_STORE: 'file' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`run-plan 超时：${stdout}${stderr}`));
    }, 20_000);
    child.once('exit', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

describe('hosted Plan 入口与 CLI 回环转发', () => {
  const servers: Server[] = [];
  after(() => {
    for (const server of servers) {
      if (server.listening) server.close();
    }
  });

  test('未声明 CLI env 名单、--store pg、--worktrees、非法 max-rounds 在写入前拒绝', async () => {
    assert.throws(
      () => parseHostedPlanBody(hostedPlanRequestBody({ env: {} })),
      (error: unknown) => error instanceof Error && error.message === SPAWN_ENV_UNDECLARED_MESSAGE,
    );
    assert.throws(() => parseHostedPlanBody(hostedPlanRequestBody({ env: undefined })), /COAGENT_AGENT_ENV_PASSTHROUGH/);
    assert.throws(() => parseHostedPlanBody(hostedPlanRequestBody({ store: 'pg' })), /--store pg/);
    assert.throws(() => parseHostedPlanBody(hostedPlanRequestBody({ worktrees: '/tmp/wt' })), /--worktrees/);
    assert.throws(() => parseHostedPlanBody(hostedPlanRequestBody({ maxRounds: 0 })), /1–100/);
    assert.throws(
      () => parseHostedPlanBody(hostedPlanRequestBody({
        env: { COAGENT_AGENT_ENV_PASSTHROUGH: 'HUB_TEST_TOKEN' },
      })),
      (error: unknown) =>
        error instanceof Error && error.message === HOSTED_AGENT_ENV_UNPROVEN_MESSAGE,
    );
  });

  test('服务 env 的透传名单不得顶替 CLI body 声明；脏仓在建 PlanRun 之前拒绝', async () => {
    const repo = repoOn('auto/plan-x');
    writeFileSync(join(repo, 'stray.json'), '{}');
    const home = temp('coagent-hosted-dirty-');
    const clock = new FixedClock();
    const activity = new InMemoryActivityLog(clock);
    const ids = new SequentialIds();
    const deliveries = new InMemoryDeliveryRepository(clock, ids);
    const projects = new InMemoryProjectRepository();
    const workspace = new InPlaceWorkspaceManager();
    const platform = new Platform({ projects, deliveries, workspace, activity, clock, ids });
    const tokens = new RunTokenRegistry();
    const agentPool = new InMemoryAgentPoolRepository();
    let persistCalls = 0;
    const lines: { channel: string; line: string }[] = [];
    const code = await runHostedPlan(
      hostedPlanRequestBody({
        cwd: repo,
        runDir: join(home, 'plans'),
        env: { COAGENT_AGENT_ENV_PASSTHROUGH: '-' },
      }),
      {
        built: {
          platform,
          tokens: makeIssuer(platform, tokens),
          agentPool,
          persist: () => {
            persistCalls += 1;
          },
        },
        baseUrl: 'http://127.0.0.1:9',
        workspace,
        env: { COAGENT_AGENT_ENV_PASSTHROUGH: 'SHOULD_NOT_USE' },
        runtime: new ScriptedRuntime({}),
      },
      (channel, line) => {
        lines.push({ channel, line });
      },
    );
    assert.equal(code, 2);
    assert.ok(lines.some((row) => row.channel === 'stderr' && /stray\.json|变脏了/.test(row.line)));
    assert.equal(existsSync(join(home, 'plans')), false);
    assert.equal(persistCalls, 0);
  });

  test('额外透传名在建 PlanRun / persist 之前拒绝，不用服务 env 取值顶替', async () => {
    const repo = repoOn('auto/plan-x');
    const home = temp('coagent-hosted-env-unproven-');
    const clock = new FixedClock();
    const activity = new InMemoryActivityLog(clock);
    const ids = new SequentialIds();
    const deliveries = new InMemoryDeliveryRepository(clock, ids);
    const projects = new InMemoryProjectRepository();
    const workspace = new InPlaceWorkspaceManager();
    const platform = new Platform({ projects, deliveries, workspace, activity, clock, ids });
    const tokens = new RunTokenRegistry();
    const agentPool = new InMemoryAgentPoolRepository();
    let persistCalls = 0;
    await assert.rejects(
      () => runHostedPlan(
        hostedPlanRequestBody({
          cwd: repo,
          runDir: join(home, 'plans'),
          env: { COAGENT_AGENT_ENV_PASSTHROUGH: 'HUB_TEST_TOKEN' },
        }),
        {
          built: {
            platform,
            tokens: makeIssuer(platform, tokens),
            agentPool,
            persist: () => {
              persistCalls += 1;
            },
          },
          baseUrl: 'http://127.0.0.1:9',
          workspace,
          env: { COAGENT_AGENT_ENV_PASSTHROUGH: '-', HUB_TEST_TOKEN: 'svc-secret-w96-bb22' },
          runtime: new ScriptedRuntime({}),
        },
        () => {},
      ),
      (error: unknown) =>
        error instanceof Error && error.message === HOSTED_AGENT_ENV_UNPROVEN_MESSAGE,
    );
    assert.equal(existsSync(join(home, 'plans')), false);
    assert.equal(persistCalls, 0);
    assert.deepEqual(await agentPool.list(), { coordinator: [], executor: [], independent_reviewer: [] });
  });

  test('非法 --coordinator 在 seed / 建 PlanRun 之前拒绝且不写主状态', async () => {
    const repo = repoOn('auto/plan-x');
    const home = temp('coagent-hosted-bad-coord-');
    const clock = new FixedClock();
    const activity = new InMemoryActivityLog(clock);
    const ids = new SequentialIds();
    const deliveries = new InMemoryDeliveryRepository(clock, ids);
    const projects = new InMemoryProjectRepository();
    const workspace = new InPlaceWorkspaceManager();
    const platform = new Platform({ projects, deliveries, workspace, activity, clock, ids });
    const tokens = new RunTokenRegistry();
    const agentPool = new InMemoryAgentPoolRepository();
    let persistCalls = 0;
    await assert.rejects(
      () => runHostedPlan(
        hostedPlanRequestBody({
          cwd: repo,
          runDir: join(home, 'plans'),
          coordinator: 'no-such-profile',
        }),
        {
          built: {
            platform,
            tokens: makeIssuer(platform, tokens),
            agentPool,
            persist: () => {
              persistCalls += 1;
            },
          },
          baseUrl: 'http://127.0.0.1:9',
          workspace,
          runtime: new ScriptedRuntime({}),
        },
        () => {},
      ),
      /--coordinator/,
    );
    assert.equal(existsSync(join(home, 'plans')), false);
    assert.equal(persistCalls, 0);
    assert.deepEqual(await agentPool.list(), { coordinator: [], executor: [], independent_reviewer: [] });
  });

  test('注入既有 platform 后预检通过才建 PlanRun；开跑早于停了', async () => {
    const repo = repoOn('auto/plan-x');
    const home = temp('coagent-hosted-run-');
    const clock = new FixedClock();
    const activity = new InMemoryActivityLog(clock);
    const ids = new SequentialIds();
    const deliveries = new InMemoryDeliveryRepository(clock, ids);
    const projects = new InMemoryProjectRepository();
    const workspace = new InPlaceWorkspaceManager();
    const platform = new Platform({ projects, deliveries, workspace, activity, clock, ids });
    const tokens = new RunTokenRegistry();
    const agentPool = new InMemoryAgentPoolRepository();
    await agentPool.add({ role: 'coordinator', profileId: 'c', endpoint: 'local' });
    await agentPool.add({ role: 'executor', profileId: 'e', endpoint: 'local' });
    const lines: string[] = [];
    const code = await runHostedPlan(
      hostedPlanRequestBody({
        cwd: repo,
        runDir: join(home, 'plans'),
        coordinator: 'c',
        executor: 'e',
        maxRounds: 3,
      }),
      {
        built: {
          platform,
          tokens: makeIssuer(platform, tokens),
          agentPool,
          persist: () => {},
        },
        baseUrl: 'http://127.0.0.1:9',
        workspace,
        runtime: new ScriptedRuntime({}),
      },
      (_channel, line) => {
        lines.push(line);
      },
    );
    assert.equal(code, 0);
    const startAt = lines.findIndex((line) => /开跑：/.test(line));
    const stopAt = lines.findIndex((line) => /停了：/.test(line));
    assert.ok(startAt >= 0 && stopAt > startAt, lines.join('\n'));
    assert.ok(lines.some((line) => /▶|墙钟|合入|升级单|停了/.test(line)));
    const planFiles = existsSync(join(home, 'plans')) ? readdirSync(join(home, 'plans')).filter((name) => name.endsWith('.json')) : [];
    assert.equal(planFiles.length, 1);
    const stored = JSON.parse(readFileSync(join(home, 'plans', planFiles[0]!), 'utf8')) as { stopped?: { reason: string } };
    assert.ok(stored.stopped);
  });

  test('live 锁 CLI 原样转发参数与 env 声明，边印 stdout/stderr 并设置退出码', async () => {
    const dir = temp('coagent-plan-fwd-');
    const repo = repoOn('auto/plan-x');
    const statePath = join(dir, 'state.json');
    writeFileSync(statePath, JSON.stringify({}));
    const instanceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const release = acquireLock(statePath, '常驻服务', { instanceId, apiVersion: API_VERSION });
    const seen: unknown[] = [];
    try {
      const clock = new FixedClock();
      const activity = new InMemoryActivityLog(clock);
      const ids = new SequentialIds();
      const deliveries = new InMemoryDeliveryRepository(clock, ids);
      const projects = new InMemoryProjectRepository();
      const platform = new Platform({
        projects,
        deliveries,
        workspace: new InPlaceWorkspaceManager(),
        activity,
        clock,
        ids,
      });
      const tokens = new RunTokenRegistry();
      const server: Server = createApi({
        platform,
        tokens,
        deliveries,
        identity: { instanceId, stateId: stateIdFor(statePath) },
        runPlan: async (body, emit) => {
          seen.push(body);
          emit('stdout', '方案 PLAN-check 开跑：Ok');
          emit('stdout', '[12:00:00] Ok ▶ R-Ok');
          emit('stdout', '  · read');
          emit('stdout', '方案 PLAN-check 停了：finished —— 走完了');
          emit('stderr', 'hosted-err');
          return 9;
        },
      });
      await listenLoopback(server, 0);
      servers.push(server);
      publishLockPort(statePath, instanceId, (server.address() as AddressInfo).port);

      const planPath = join(dir, 'PLAN.json');
      writeFileSync(
        planPath,
        JSON.stringify(
          samplePlan([{ id: 'Ok', title: '待跑', why: 'w', allowedScope: ['a.txt'], acceptance: ['x'], status: 'pending' }]),
          null,
          2,
        ),
      );
      const spawned = await spawnRunPlan([
        '--plan',
        planPath,
        '--cwd',
        repo,
        '--reviewer',
        'claude',
        '--state',
        statePath,
        '--run-dir',
        join(dir, 'plans'),
        '--coordinator',
        'coord-a',
        '--max-rounds',
        '3',
      ]);
      const out = `${spawned.stdout}${spawned.stderr}`;
      assert.equal(spawned.status, 9, out);
      const startAt = spawned.stdout.indexOf('方案 PLAN-check 开跑：Ok');
      const missionAt = spawned.stdout.indexOf('[12:00:00] Ok ▶ R-Ok');
      const toolAt = spawned.stdout.indexOf('  · read');
      const stopAt = spawned.stdout.indexOf('方案 PLAN-check 停了：finished');
      assert.ok(startAt >= 0 && missionAt > startAt && toolAt > missionAt && stopAt > toolAt, spawned.stdout);
      assert.match(spawned.stderr, /hosted-err/);
      assert.equal(seen.length, 1);
      const body = seen[0] as Record<string, unknown>;
      assert.equal((body.plan as { planId: string }).planId, 'PLAN-check');
      assert.equal(body.maxRounds, 3);
      assert.equal(body.coordinator, 'coord-a');
      assert.equal(body.store, 'file');
      assert.equal(body.state, statePath);
      assert.deepEqual(body.env, { COAGENT_AGENT_ENV_PASSTHROUGH: '-' });
      assert.doesNotMatch(out, /平台正被另一个进程占用/);
      assert.equal(existsSync(join(dir, 'plans')), false, 'live CLI 不得在本地建 PlanRun');
    } finally {
      release();
    }
  });

  test('CLI 与服务同名 agent 变量取值不同时拒绝转发且不写、不回落、不打印取值', async () => {
    const dir = temp('coagent-plan-env-mismatch-');
    const repo = repoOn('auto/plan-x');
    const statePath = join(dir, 'state.json');
    writeFileSync(statePath, JSON.stringify({}));
    const instanceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const release = acquireLock(statePath, '常驻服务', { instanceId, apiVersion: API_VERSION });
    const seen: unknown[] = [];
    const persistCalls: number[] = [];
    const cliSecret = 'cli-secret-w96-aa11';
    const svcSecret = 'svc-secret-w96-bb22';
    try {
      const clock = new FixedClock();
      const activity = new InMemoryActivityLog(clock);
      const ids = new SequentialIds();
      const deliveries = new InMemoryDeliveryRepository(clock, ids);
      const projects = new InMemoryProjectRepository();
      const workspace = new InPlaceWorkspaceManager();
      const platform = new Platform({
        projects,
        deliveries,
        workspace,
        activity,
        clock,
        ids,
      });
      const tokens = new RunTokenRegistry();
      const agentPool = new InMemoryAgentPoolRepository();
      const server: Server = createApi({
        platform,
        tokens,
        deliveries,
        identity: { instanceId, stateId: stateIdFor(statePath) },
        runPlan: async (body, emit) => {
          seen.push(body);
          return runHostedPlan(
            body,
            {
              built: {
                platform,
                tokens: makeIssuer(platform, tokens),
                agentPool,
                persist: () => {
                  persistCalls.push(1);
                },
              },
              baseUrl: 'http://127.0.0.1:9',
              workspace,
              env: {
                COAGENT_AGENT_ENV_PASSTHROUGH: 'HUB_TEST_TOKEN',
                HUB_TEST_TOKEN: svcSecret,
              },
              runtime: new ScriptedRuntime({}),
            },
            emit,
          );
        },
      });
      await listenLoopback(server, 0);
      servers.push(server);
      publishLockPort(statePath, instanceId, (server.address() as AddressInfo).port);

      const planPath = join(dir, 'PLAN.json');
      writeFileSync(
        planPath,
        JSON.stringify(
          samplePlan([{ id: 'Ok', title: '待跑', why: 'w', allowedScope: ['a.txt'], acceptance: ['x'], status: 'pending' }]),
          null,
          2,
        ),
      );
      const spawned = await spawnRunPlan(
        [
          '--plan',
          planPath,
          '--cwd',
          repo,
          '--reviewer',
          'claude',
          '--state',
          statePath,
          '--run-dir',
          join(dir, 'plans'),
        ],
        {
          ...process.env,
          COAGENT_AGENT_ENV_PASSTHROUGH: 'HUB_TEST_TOKEN',
          HUB_TEST_TOKEN: cliSecret,
          COAGENT_RECONCILE_INTERVAL_MS: '0',
          COAGENT_STORE: 'file',
        },
      );
      const out = `${spawned.stdout}${spawned.stderr}`;
      assert.notEqual(spawned.status, 0, out);
      assert.match(out, /无法证明|未写入|主状态未改/);
      assert.doesNotMatch(out, new RegExp(cliSecret));
      assert.doesNotMatch(out, new RegExp(svcSecret));
      assert.doesNotMatch(out, /开跑：/);
      assert.equal(seen.length, 0, '取值无法证明一致时不得把 body 送进回环');
      assert.deepEqual(persistCalls, []);
      assert.equal(existsSync(join(dir, 'plans')), false);
      assert.equal(readFileSync(statePath, 'utf8'), '{}');
    } finally {
      release();
    }
  });

  test('--check 在探测之前只读返回，即使锁 live 也不发写请求', async () => {
    const dir = temp('coagent-plan-check-live-');
    const repo = repoOn('auto/plan-x');
    const statePath = join(dir, 'state.json');
    writeFileSync(statePath, JSON.stringify({}));
    const instanceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const release = acquireLock(statePath, '常驻服务', { instanceId, apiVersion: API_VERSION });
    let posts = 0;
    try {
      const clock = new FixedClock();
      const activity = new InMemoryActivityLog(clock);
      const ids = new SequentialIds();
      const deliveries = new InMemoryDeliveryRepository(clock, ids);
      const projects = new InMemoryProjectRepository();
      const platform = new Platform({
        projects,
        deliveries,
        workspace: new InPlaceWorkspaceManager(),
        activity,
        clock,
        ids,
      });
      const tokens = new RunTokenRegistry();
      const server: Server = createApi({
        platform,
        tokens,
        deliveries,
        identity: { instanceId, stateId: stateIdFor(statePath) },
        runPlan: async () => {
          posts += 1;
          return 0;
        },
      });
      await listenLoopback(server, 0);
      servers.push(server);
      publishLockPort(statePath, instanceId, (server.address() as AddressInfo).port);
      const planPath = join(dir, 'PLAN.json');
      writeFileSync(
        planPath,
        JSON.stringify(
          samplePlan([{ id: 'Ok', title: '待跑', why: 'w', allowedScope: ['a.txt'], acceptance: ['x'], status: 'pending' }]),
          null,
          2,
        ),
      );
      const result = spawnSync(
        process.execPath,
        [RUN_PLAN, '--plan', planPath, '--cwd', repo, '--reviewer', 'claude', '--check', '--state', statePath],
        {
          encoding: 'utf8',
          timeout: 15_000,
          cwd: temp('coagent-check-live-cwd-'),
          env: { ...process.env },
        },
      );
      const out = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 0, out);
      assert.match(out, /只读检查/);
      assert.match(out, /未开跑/);
      assert.equal(posts, 0);
    } finally {
      release();
    }
  });

  test('occupied 非零不回退、不写状态；回环断线不落回本地独占装配', async () => {
    const dir = temp('coagent-plan-occ-');
    const repo = repoOn('auto/plan-x');
    const statePath = join(dir, 'state.json');
    writeFileSync(statePath, JSON.stringify({}));
    const instanceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const occupiedRelease = acquireLock(statePath, '常驻服务', { instanceId, apiVersion: API_VERSION });
    const planPath = join(dir, 'PLAN.json');
    writeFileSync(
      planPath,
      JSON.stringify(
        samplePlan([{ id: 'Ok', title: '待跑', why: 'w', allowedScope: ['a.txt'], acceptance: ['x'], status: 'pending' }]),
        null,
        2,
      ),
    );
    try {
      const occupied = spawnSync(
        process.execPath,
        [RUN_PLAN, '--plan', planPath, '--cwd', repo, '--reviewer', 'claude', '--state', statePath, '--run-dir', join(dir, 'plans')],
        {
          encoding: 'utf8',
          timeout: 20_000,
          cwd: temp('coagent-occ-cwd-'),
          env: {
            ...process.env,
            COAGENT_AGENT_ENV_PASSTHROUGH: '-',
            COAGENT_RECONCILE_INTERVAL_MS: '0',
            COAGENT_STORE: 'file',
          },
        },
      );
      const occOut = `${occupied.stdout}${occupied.stderr}`;
      assert.notEqual(occupied.status, 0, occOut);
      assert.match(occOut, /无法安全转发|占锁但未发布端口/);
      assert.doesNotMatch(occOut, /开跑：/);
      assert.equal(existsSync(join(dir, 'plans')), false);
    } finally {
      occupiedRelease();
    }

    const cutDir = temp('coagent-plan-cut-');
    const cutState = join(cutDir, 'state.json');
    writeFileSync(cutState, JSON.stringify({}));
    const cutId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const cutRelease = acquireLock(cutState, '常驻服务', { instanceId: cutId, apiVersion: API_VERSION });
    const cutStateId = stateIdFor(cutState);
    const stub = createServer((req, res) => {
      const url = req.url ?? '/';
      if (url.startsWith('/api/health')) {
        res.writeHead(200, {
          'x-coagent-api': API_VERSION,
          'x-coagent-instance': cutId,
          'x-coagent-state-id': cutStateId,
          'content-type': 'application/json',
        });
        res.end(JSON.stringify({ ok: true, api: API_VERSION }));
        return;
      }
      res.writeHead(200, {
        'x-coagent-api': API_VERSION,
        'x-coagent-instance': cutId,
        'x-coagent-state-id': cutStateId,
        'content-type': 'application/x-ndjson; charset=utf-8',
      });
      res.write(`${JSON.stringify({ channel: 'stdout', line: 'partial' })}\n`);
      req.socket.destroy();
    });
    try {
      await listenLoopback(stub, 0);
      servers.push(stub);
      publishLockPort(cutState, cutId, (stub.address() as AddressInfo).port);
      const cutPlan = join(cutDir, 'PLAN.json');
      writeFileSync(
        cutPlan,
        JSON.stringify(
          samplePlan([{ id: 'Ok', title: '待跑', why: 'w', allowedScope: ['a.txt'], acceptance: ['x'], status: 'pending' }]),
          null,
          2,
        ),
      );
      const spawned = await spawnRunPlan([
        '--plan',
        cutPlan,
        '--cwd',
        repo,
        '--reviewer',
        'claude',
        '--state',
        cutState,
        '--run-dir',
        join(cutDir, 'plans'),
      ]);
      const cutOut = `${spawned.stdout}${spawned.stderr}`;
      assert.notEqual(spawned.status, 0, cutOut);
      assert.match(cutOut, /截断|写者断线/);
      assert.doesNotMatch(cutOut, /方案 PLAN-check 停了/);
      assert.equal(existsSync(join(cutDir, 'plans')), false);
    } finally {
      cutRelease();
    }
  });
});
