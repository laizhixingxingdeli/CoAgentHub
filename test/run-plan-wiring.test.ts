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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPersistentPlatform } from '../src/main.ts';
import { preflightPlanRepo } from '../src/application/plan-preflight.ts';
import { runWithDeadline } from '../src/application/plan-driver.ts';
import { GitWorktreeManager } from '../src/application/workspace.ts';
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
  test('buildPersistentPlatform 给了真的 commandRunner：合并、在合并结果上跑命令、放行', async () => {
    const repo = repoOn('auto/plan-x');
    const wt = temp('coagent-wt-');
    const workspace = new GitWorktreeManager(wt);
    const built = await buildPersistentPlatform(join(temp('coagent-state-'), 'state.json'), { workspace });
    const { platform } = built;

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
});

describe('run-plan 周期投递修复接线', () => {
  test('在副作用之前解析间隔，finally 里 stop，文件版注入 hasArchivedMission', () => {
    const root = join(import.meta.dirname, '..', 'src');
    const runPlan = readFileSync(join(root, 'run-plan.ts'), 'utf8');
    const main = readFileSync(join(root, 'main.ts'), 'utf8');

    const parseAt = runPlan.indexOf('parseReconcileIntervalMs');
    const worktreeAt = runPlan.indexOf('new GitWorktreeManager');
    const platformAt = runPlan.indexOf('buildPersistentPlatform');
    assert.ok(parseAt >= 0, 'run-plan 应解析 COAGENT_RECONCILE_INTERVAL_MS');
    assert.ok(parseAt < worktreeAt && parseAt < platformAt, '非法间隔必须在建 worktree / 开状态之前拒绝');

    assert.match(runPlan, /startPeriodicReconcile/);
    assert.match(runPlan, /runHeldFileDeliveryRepair/);
    assert.match(runPlan, /runPgDeliveryRepairTick/);
    assert.match(runPlan, /finally \{[\s\S]*runIndependentCleanup/);
    assert.match(runPlan, /periodic\.stop\(\)/);
    assert.match(runPlan, /name: 'persist'/);
    assert.match(runPlan, /name: 'releaseLock'/);
    assert.doesNotMatch(runPlan, /reconcileInterruptedAttempts/);
    assert.doesNotMatch(runPlan, /reconcileOrphanedWorktrees/);

    assert.match(main, /hasArchivedMission/);
    assert.match(main, /runFileObserverDeliveryRepairTick/);
    assert.match(main, /bindServerCloseToPeriodicStop\(server,/);
    assert.match(main, /periodic\?\.stop\(\)/);
    assert.match(main, /closeHttp = server\.close\.bind\(server\)/);
    assert.match(main, /warnDeliveryRepairErrors/);
    assert.match(main, /acquireLock\(statePath, '周期投递修复'\)/);
    assert.doesNotMatch(
      main.slice(main.indexOf('export async function startServer')),
      /exclusive:\s*\{/
    );
  });
});
