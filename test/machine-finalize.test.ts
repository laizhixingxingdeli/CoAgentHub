/**
 * 机器 L3：合进集成分支 → 在合并结果上验证 → 绿才放行。
 *
 * 这组测试的形状是手工跑一遍方案推进换来的。三个顺序约束都是那次撞出来的：
 *
 * - **验证必须夹在 merge 和 complete 之间**：`MISSION_TRANSITIONS.completed = []`，
 *   先 complete 再验，红了就只能退 git、退不了状态，两边当场分叉。
 * - **锚点必须先落事件**：手工时我把合并前的 HEAD 存在 shell 变量里，进程一死
 *   就没人知道该退回哪。
 * - **分支必须现场核对**：合并目标取自「当时 checkout 的分支」，无人值守连跑时
 *   有别的东西 checkout 回 master，后续功能会静默合进 master。
 *
 * 用真 git 仓库验，不用替身——要挡的就是真实 git 行为。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform, PlatformRuleError } from '../src/application/platform.ts';
import { GitWorktreeManager } from '../src/application/workspace.ts';
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
import type { MemoryDeltaProposal, MissionContract, WorkOrder } from '../src/kernel/index.ts';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const CONTRACT: MissionContract = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

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

const PLAN = { summary: 'p', steps: ['s'], risks: [] };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** 带初始提交、且已经 checkout 到集成分支的仓库。 */
function tempRepoOnIntegration(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-repo-'));
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

/** 按脚本返回退出码的 CommandRunner 替身。不跑真命令——这组验的是编排顺序。 */
function scriptedRunner(exitCodes: number[]) {
  let index = 0;
  const seen: string[][] = [];
  return {
    seen,
    async run(input: { argv: readonly string[]; cwd: string; timeoutMs: number }) {
      seen.push([...input.argv]);
      const code = exitCodes[index] ?? 0;
      index += 1;
      return { exitCode: code, timedOut: false, durationMs: 1, output: `out ${code}` };
    },
  };
}

async function readyForReview(
  repo: string,
  worktreeRoot: string,
  missionId: string,
  runner: ReturnType<typeof scriptedRunner>,
  options?: { executionMode?: 'high_assurance'; memoryDelta?: MemoryDeltaProposal[] },
) {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const workspace = new GitWorktreeManager(worktreeRoot);
  const reports = new InMemoryValidationReportRepository();
  const projects = new InMemoryProjectRepository();
  const platform = new Platform({
    projects,
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    workspace,
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
    validation: {
      engine: { validate: () => Promise.reject(new Error('本组不用 engine')) },
      reports,
      commandRunner: runner,
    },
  });

  if (options?.executionMode) {
    // 公开入口建不出 high_assurance（分类到它就拒绝建），只能从仓储直接放一条进去
    // ——要验的正是「万一有一条走到了机器 L3 门口」。
    const project = await projects.ensure('P');
    project.createMission({ id: missionId, contract: CONTRACT, executionMode: options.executionMode });
    await projects.save(project);
  } else {
    await platform.createMission({ projectId: 'P', missionId, contract: CONTRACT });
  }
  const prepared = await workspace.prepare(missionId, repo);
  await platform.recordWorkspace(missionId, {
    branch: prepared.branch,
    baseRevision: prepared.baseRevision,
  });
  const coord = await platform.startCoordinatorAttempt(missionId);
  await platform.updatePlan(missionId, coord.attemptId, PLAN);
  const { workItemId } = await platform.createWorkItem(missionId, coord.attemptId, {
    title: 'W',
    order: ORDER,
  });
  await platform.dispatchWorkItems(missionId, coord.attemptId, [workItemId]);
  writeFileSync(join(prepared.cwd, 'a.txt'), 'mission\n');
  const exec = await platform.startExecutorAttempt(missionId, workItemId);
  await platform.submitEvidence(missionId, exec.attemptId, {
    kind: 'test',
    summary: '绿',
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
    reasons: ['复跑过'],
    requiredChanges: [],
  });
  await platform.submitMissionResult(missionId, coord.attemptId, {
    outcome: 'delivered',
    summary: '交付',
    acceptanceEvidence: [],
    memoryDelta: options?.memoryDelta ?? [],
    openRisks: [],
  });
  await platform.finishAttempt(missionId, coord.attemptId, { endedBy: 'structured_submit' });
  return { platform, workspace, reports };
}

const VERIFY = [{ argv: ['node', '--test'], timeoutMs: 60_000 }];

describe('机器 L3 放行', () => {
  test('集成验证通过 → completed，权威是 machine 且指向那份报告', async () => {
    const repo = tempRepoOnIntegration('auto/plan-x');
    const wt = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(wt);
    const runner = scriptedRunner([0]);
    const { platform, reports } = await readyForReview(repo, wt, 'M1', runner);

    const result = await platform.finalizeMissionByMachine('M1', {
      integrationBranch: 'auto/plan-x',
      verification: VERIFY,
      projectRoot: repo,
    });

    assert.equal(result.status, 'completed');
    assert.ok(result.reportId);
    assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'mission');

    const view = await platform.getMissionView('M1');
    assert.deepEqual(view.finalReview?.authority, {
      kind: 'machine',
      integrationReportId: result.reportId,
      policyRevision: 1,
    });
    // 报告是 durable 的，不是只存在于返回值里。
    const saved = await reports.get(result.reportId!);
    assert.equal(saved?.passed, true);
    // 验证确实跑在项目仓（合并结果）上，不是 Mission worktree。
    assert.deepEqual(runner.seen, [['node', '--test']]);
  });

  test('集成验证的输出尾部先脱敏再截尾：key 被截尾点切开也不留半截', async () => {
    const repo = tempRepoOnIntegration('auto/plan-x');
    const wt = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(wt);
    const key = 'sk-proj-abcdefghijklmnopqrstuv';
    // key、换行、再跟 2000-9 个 y：先截尾（2000）的话，留下的是 key 的最后 8 个字符。
    const runner = {
      seen: [] as string[][],
      async run(input: { argv: readonly string[]; cwd: string; timeoutMs: number }) {
        runner.seen.push([...input.argv]);
        return { exitCode: 0, timedOut: false, durationMs: 1, output: `${key}\n${'y'.repeat(2000 - 9)}` };
      },
    };
    const { platform, reports } = await readyForReview(repo, wt, 'M1', runner);
    const result = await platform.finalizeMissionByMachine('M1', {
      integrationBranch: 'auto/plan-x',
      verification: VERIFY,
      projectRoot: repo,
    });
    const tail = (await reports.get(result.reportId!))!.checks[0]!.command!.outputTail;
    assert.equal(tail.length, 2000);
    assert.ok(!tail.includes(key.slice(-8)), `半截 key 漏出来了：${tail.slice(0, 20)}`);
  });

  /**
   * 这条是整票的要害：验证红了，集成分支必须**逐字**回到合并前。
   */
  test('集成验证未通过 → 退回锚点，Mission 留在 awaiting_review', async () => {
    const repo = tempRepoOnIntegration('auto/plan-x');
    const wt = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(wt);
    const runner = scriptedRunner([1]);
    const { platform } = await readyForReview(repo, wt, 'M1', runner);
    const anchor = git(repo, 'rev-parse', 'HEAD');

    const result = await platform.finalizeMissionByMachine('M1', {
      integrationBranch: 'auto/plan-x',
      verification: VERIFY,
      projectRoot: repo,
    });

    assert.equal(result.status, 'awaiting_review', '机器判不了不等于这条完了');
    assert.equal(result.rolledBackTo, anchor);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), anchor, '集成分支逐字回到合并前');
    assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'base', '改动不该还在');

    const view = await platform.getMissionView('M1');
    assert.equal(view.waitReason, 'waiting_l3');
    assert.equal(view.finalReview, undefined, '没放行就不该有 finalReview');
  });

  test('项目仓不在集成分支上 → 拒绝，什么都不合', async () => {
    const repo = tempRepoOnIntegration('auto/plan-x');
    const wt = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(wt);
    const runner = scriptedRunner([0]);
    const { platform } = await readyForReview(repo, wt, 'M1', runner);
    const before = git(repo, 'rev-parse', 'HEAD');

    // 有别的东西把仓库切回了 master。
    git(repo, 'checkout', '-q', 'master');

    await assert.rejects(
      () =>
        platform.finalizeMissionByMachine('M1', {
          integrationBranch: 'auto/plan-x',
          verification: VERIFY,
          projectRoot: repo,
        }),
      (error: unknown) =>
        error instanceof PlatformRuleError && error.code === 'INTEGRATION_BRANCH_MISMATCH',
    );

    assert.equal(git(repo, 'rev-parse', 'auto/plan-x'), before, '集成分支没动');
    assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'base', 'master 更不该动');
    assert.deepEqual(runner.seen, [], '连验证都不该跑');
  });

  test('空的集成命令表 → 拒绝：那就只是把 validator 那份又数一遍', async () => {
    const repo = tempRepoOnIntegration('auto/plan-x');
    const wt = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(wt);
    const runner = scriptedRunner([0]);
    const { platform } = await readyForReview(repo, wt, 'M1', runner);

    await assert.rejects(
      () =>
        platform.finalizeMissionByMachine('M1', {
          integrationBranch: 'auto/plan-x',
          verification: [],
          projectRoot: repo,
        }),
      (error: unknown) =>
        error instanceof PlatformRuleError &&
        error.code === 'MACHINE_FINALIZE_NEEDS_VERIFICATION',
    );
  });

  test('没注入 commandRunner → 机器放行不可用，不退化成不验直接合', async () => {
    const repo = tempRepoOnIntegration('auto/plan-x');
    const wt = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(wt);
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const workspace = new GitWorktreeManager(wt);
    const platform = new Platform({
      projects: new InMemoryProjectRepository(),
      deliveries: new InMemoryDeliveryRepository(clock, ids),
      workspace,
      activity: new InMemoryActivityLog(clock),
      clock,
      ids,
    });
    await platform.createMission({ projectId: 'P', missionId: 'M9', contract: CONTRACT });

    await assert.rejects(
      () =>
        platform.finalizeMissionByMachine('M9', {
          integrationBranch: 'auto/plan-x',
          verification: VERIFY,
          projectRoot: repo,
        }),
      (error: unknown) => error instanceof PlatformRuleError,
    );
  });
});

describe('机器 L3 的边界', () => {
  test('合并失败 → 留在 awaiting_review 等人，不冒签任何权威，也不跑验证', async () => {
    const repo = tempRepoOnIntegration('auto/plan-x');
    const wt = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(wt);
    const runner = scriptedRunner([0]);
    const { platform } = await readyForReview(repo, wt, 'M1', runner);
    // 分叉之后集成分支上又落了别的提交：合并那道闸按基线拒绝。
    writeFileSync(join(repo, 'b.txt'), 'other\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'someone else');
    const head = git(repo, 'rev-parse', 'HEAD');

    const result = await platform.finalizeMissionByMachine('M1', {
      integrationBranch: 'auto/plan-x',
      verification: VERIFY,
      projectRoot: repo,
    });

    assert.equal(result.status, 'awaiting_review', '机器合不进去不等于这条完了');
    assert.match(result.reason ?? '', /HEAD 变了/);
    const view = await platform.getMissionView('M1');
    // 以前这里记的是 { kind: 'human' }：机器路径冒签了人的权威。
    assert.equal(view.finalReview, undefined);
    assert.equal(view.waitReason, 'waiting_l3');
    assert.match(view.waitDetail ?? '', /合并失败/);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head, '集成分支没动');
    assert.deepEqual(runner.seen, [], '合不进去就不该跑验证');
  });

  test('high_assurance 永远要人：机器 L3 直接拒绝，什么都不合', async () => {
    const repo = tempRepoOnIntegration('auto/plan-x');
    const wt = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(wt);
    const runner = scriptedRunner([0]);
    const { platform } = await readyForReview(repo, wt, 'M-HA', runner, {
      executionMode: 'high_assurance',
    });
    const before = git(repo, 'rev-parse', 'HEAD');

    await assert.rejects(
      () =>
        platform.finalizeMissionByMachine('M-HA', {
          integrationBranch: 'auto/plan-x',
          verification: VERIFY,
          projectRoot: repo,
        }),
      (error: unknown) =>
        error instanceof PlatformRuleError && error.code === 'HIGH_ASSURANCE_NEEDS_HUMAN',
    );
    assert.equal(git(repo, 'rev-parse', 'HEAD'), before);
    assert.deepEqual(runner.seen, []);
    assert.equal((await platform.getMissionView('M-HA')).status, 'awaiting_review');
  });
});

describe('方案放弃失败的 Mission', () => {
  const ABANDON = { planRunId: 'R1', escalationId: 'E-1', reasons: ['检视者跳过：夹具冲突'] };

  test('放掉改动名额、分支留着、权威记 plan 并指向升级单', async () => {
    const repo = tempRepoOnIntegration('auto/plan-x');
    const wt = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(wt);
    const { platform } = await readyForReview(repo, wt, 'M1', scriptedRunner([1]));

    // M1 动过代码、没终结：它占着名额，下一个功能派发不了——方案就卡死在这。
    await platform.createMission({ projectId: 'P', missionId: 'M2', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('M2');
    await platform.updatePlan('M2', coord.attemptId, PLAN);
    const { workItemId } = await platform.createWorkItem('M2', coord.attemptId, {
      title: 'W2',
      order: ORDER,
    });
    await assert.rejects(
      () => platform.dispatchWorkItems('M2', coord.attemptId, [workItemId]),
      (error: unknown) => error instanceof PlatformRuleError && error.code === 'PROJECT_BUSY',
    );

    const result = await platform.abandonMissionForPlan('M1', { ...ABANDON, projectRoot: repo });

    assert.equal(result.status, 'blocked');
    const view = await platform.getMissionView('M1');
    assert.deepEqual(view.finalReview, {
      verdict: 'abandon',
      reasons: ['检视者跳过：夹具冲突'],
      authority: { kind: 'plan', planRunId: 'R1', escalationId: 'E-1' },
    });
    assert.equal(git(repo, 'show', 'mission/M1:a.txt'), 'mission', '改动留在分支上给人看');
    assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'base', '集成分支没动');
    await platform.dispatchWorkItems('M2', coord.attemptId, [workItemId]);
    assert.equal((await platform.getMissionView('M2')).status, 'executing', '名额腾出来了');
  });

  test('必须指向方案运行与升级单并写理由；已终结的不再放弃', async () => {
    const repo = tempRepoOnIntegration('auto/plan-x');
    const wt = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(wt);
    const { platform } = await readyForReview(repo, wt, 'M1', scriptedRunner([0]));
    const invalid = (error: unknown) =>
      error instanceof PlatformRuleError && error.code === 'PLAN_ABANDON_INVALID';

    await assert.rejects(() => platform.abandonMissionForPlan('M1', { ...ABANDON, planRunId: '' }), invalid);
    await assert.rejects(() => platform.abandonMissionForPlan('M1', { ...ABANDON, escalationId: ' ' }), invalid);
    await assert.rejects(() => platform.abandonMissionForPlan('M1', { ...ABANDON, reasons: [] }), invalid);
    assert.equal((await platform.getMissionView('M1')).status, 'awaiting_review');

    await platform.abandonMissionForPlan('M1', ABANDON);
    await assert.rejects(
      () => platform.abandonMissionForPlan('M1', ABANDON),
      (error: unknown) => error instanceof PlatformRuleError && error.code === 'MISSION_ALREADY_TERMINAL',
    );
  });

  test('公开 finalizeMission 发不出 plan 权威', async () => {
    const repo = tempRepoOnIntegration('auto/plan-x');
    const wt = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(wt);
    const { platform } = await readyForReview(repo, wt, 'M1', scriptedRunner([0]));
    await assert.rejects(
      () =>
        platform.finalizeMission('M1', {
          verdict: 'abandon',
          reasons: ['x'],
          authority: { kind: 'plan', planRunId: 'R1', escalationId: 'E-1' } as never,
        }),
      (error: unknown) =>
        error instanceof PlatformRuleError && error.code === 'FINAL_REVIEW_AUTHORITY_FORBIDDEN',
    );
    assert.equal((await platform.getMissionView('M1')).status, 'awaiting_review');
  });
});

describe('机器 L3 与项目记忆', () => {
  test('协调者提议的 Living Spec 跟代码同一次合进集成分支——人工放行怎么落，机器放行也怎么落', async () => {
    const repo = tempRepoOnIntegration('auto/plan-x');
    const wt = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(wt);
    const { platform } = await readyForReview(repo, wt, 'M1', scriptedRunner([0]), {
      memoryDelta: [{ kind: 'living_spec', slug: 'demo-capability', title: 'Demo', body: '# Demo\n\n机器放行也要落这份。' }],
    });

    const result = await platform.finalizeMissionByMachine('M1', {
      integrationBranch: 'auto/plan-x',
      verification: VERIFY,
      projectRoot: repo,
    });

    assert.equal(result.status, 'completed');
    // 以前只合了代码：这份提议被悄悄丢掉，没有事件、没有提示。
    assert.match(git(repo, 'show', 'HEAD:.coagent/specs/demo-capability.md'), /机器放行也要落这份/);
    assert.match(git(repo, 'show', 'HEAD:VIBE.md'), /demo-capability/);
  });
});

describe('A/B 表里的 L3 只数人', () => {
  test('机器放行与方案放弃不算 L3 检视：不稀释「L3 打回」的分母', async () => {
    const repo = tempRepoOnIntegration('auto/plan-x');
    const wt = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(wt);
    const merged = await readyForReview(repo, wt, 'M1', scriptedRunner([0]));
    await merged.platform.finalizeMissionByMachine('M1', {
      integrationBranch: 'auto/plan-x',
      verification: VERIFY,
      projectRoot: repo,
    });
    const [machineRun] = await merged.platform.listRuns('M1');
    assert.equal(machineRun.status, 'completed');
    assert.equal(machineRun.l3Reviews, 0, '机器合并不是 L3 的人工检视');

    const repo2 = tempRepoOnIntegration('auto/plan-x');
    const wt2 = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(wt2);
    const abandoned = await readyForReview(repo2, wt2, 'M2', scriptedRunner([0]));
    await abandoned.platform.abandonMissionForPlan('M2', {
      planRunId: 'R1',
      escalationId: 'E-1',
      reasons: ['超时没人定'],
      projectRoot: repo2,
    });
    const [planRun] = await abandoned.platform.listRuns('M2');
    assert.equal(planRun.l3Reviews, 0, '方案放弃也不是');

    // 人工的照数：打回一次算一次检视、一次打回。
    const repo3 = tempRepoOnIntegration('auto/plan-x');
    const wt3 = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(wt3);
    const human = await readyForReview(repo3, wt3, 'M3', scriptedRunner([0]));
    await human.platform.finalizeMission('M3', { verdict: 'send_back', reasons: ['重做'] });
    const [humanRun] = await human.platform.listRuns('M3');
    assert.equal(humanRun.l3Reviews, 1);
    assert.equal(humanRun.l3SendBacks, 1);
  });
});
