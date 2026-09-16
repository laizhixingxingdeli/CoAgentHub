/**
 * L3 最终检视与落地。
 *
 * 重点是那条闸：**落地前核对目标分支的 HEAD 还是不是分叉时那个**。
 * 不核对就直接合，等于拿一份过时的基线覆盖别人在这期间做的事。
 * 这条用真 git 仓库验，不用替身——它要挡的就是真实的 git 行为。
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
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

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
  requiredBehaviour: 'a.txt 内容变成 mission',
  constraints: [],
  acceptance: ['内容是 mission'],
  verification: ['cat a.txt'],
  doNot: [],
  contextRefs: [],
};

const PLAN = {
  findings: 'f',
  rejectedHypotheses: [],
  decisions: [],
  direction: 'd',
  risks: [],
};

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** 造一个带初始提交的临时仓库。 */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-repo-'));
  dirs.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@local');
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function makeHarness(worktreeRoot: string) {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const workspace = new GitWorktreeManager(worktreeRoot);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    workspace,
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
  });
  return { platform, workspace, deliveries };
}

/** 把一条 Mission 推到「已交卷、等 L3 检视」，并在工作区里留下真实改动。 */
async function missionReadyForReview(repo: string, worktreeRoot: string, missionId: string) {
  const harness = makeHarness(worktreeRoot);
  const { platform, workspace } = harness;
  await platform.createMission({ projectId: 'P', missionId, contract: CONTRACT });

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

  // 执行者在自己的 worktree 里真的改了东西。
  writeFileSync(join(prepared.cwd, 'a.txt'), 'mission\n');

  const exec = await platform.startExecutorAttempt(missionId, workItemId);
  // S11.1：completed 必须有证据撑着，平台会拦下没证据的提交。
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
  return { ...harness, prepared };
}

describe('L3 最终检视：放行与落地', () => {
  test('merge 之后改动真的落到了目标分支', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);

    const { platform } = await missionReadyForReview(repo, worktrees, 'M1');
    assert.equal((await platform.getMissionView('M1')).status, 'awaiting_review');

    const result = await platform.finalizeMission('M1', {
      verdict: 'merge',
      reasons: ['验收标准逐条对上了'],
      projectRoot: repo,
    });

    assert.equal(result.status, 'completed');
    assert.ok(result.mergedInto, '要记下落到了哪个版本');

    // 目标分支上的文件内容确实变了。
    assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'mission');

    const view = await platform.getMissionView('M1');
    assert.equal(view.finalReview?.verdict, 'merge');
    assert.equal(view.finalReview?.mergedInto, result.mergedInto);
    assert.equal(view.isMutating, false, '落地之后名额才释放');
  });

  test('目标分支在检视期间被改动过 —— 不合，Mission 转 blocked', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);

    const { platform } = await missionReadyForReview(repo, worktrees, 'M1');

    // L3 还在看的时候，有人往目标分支上提交了东西。
    writeFileSync(join(repo, 'other.txt'), 'someone else\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', '别人的提交');

    const result = await platform.finalizeMission('M1', {
      verdict: 'merge',
      reasons: ['看着没问题'],
      projectRoot: repo,
    });

    assert.equal(result.status, 'blocked', '基线变了就不该假装完成');
    assert.match(result.reason ?? '', /HEAD 变了/);
    // 没有把过时的改动合进去。
    assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'base');
    const view = await platform.getMissionView('M1');
    assert.equal(view.isMutating, false, 'blocked 是终态，名额释放');
  });

  test('目标工作区不干净时拒绝合并', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);

    const { platform } = await missionReadyForReview(repo, worktrees, 'M1');
    // 有人在目标工作区里留了未提交的改动。
    writeFileSync(join(repo, 'a.txt'), '我正在改这个文件\n');

    const result = await platform.finalizeMission('M1', {
      verdict: 'merge',
      reasons: ['ok'],
      projectRoot: repo,
    });
    assert.equal(result.status, 'blocked');
    assert.match(result.reason ?? '', /未提交的改动/);
    // 别人手里那份没被动过。
    assert.equal(
      execFileSync('git', ['diff', '--name-only'], { cwd: repo, encoding: 'utf8' }).trim(),
      'a.txt',
    );
  });
});

describe('L3 最终检视：打回与放弃', () => {
  test('send_back 交回协调者重做，名额不放', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);

    const { platform } = await missionReadyForReview(repo, worktrees, 'M1');
    const result = await platform.finalizeMission('M1', {
      verdict: 'send_back',
      reasons: ['实现越过了 Contract 的架构边界：新增了一个持久化层'],
    });

    assert.equal(result.status, 'planning', '回到规划，协调者可以再来一轮');
    const view = await platform.getMissionView('M1');
    assert.equal(view.isMutating, true, '分支上的改动还在，名额不能放');
    assert.equal(view.finalReview?.verdict, 'send_back');
    // 目标分支没动。
    assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'base');
  });

  test('打回必须写清楚为什么', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);

    const { platform } = await missionReadyForReview(repo, worktrees, 'M1');
    await assert.rejects(
      () => platform.finalizeMission('M1', { verdict: 'send_back', reasons: [] }),
      (e: unknown) => (e as PlatformRuleError).code === 'SEND_BACK_NEEDS_REASONS',
    );
  });

  test('没在等检视的 Mission 不能被 finalize', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);

    const { platform } = makeHarness(worktrees);
    await platform.createMission({ projectId: 'P', missionId: 'M-new', contract: CONTRACT });
    await assert.rejects(
      () => platform.finalizeMission('M-new', { verdict: 'merge', reasons: [], projectRoot: repo }),
      (e: unknown) => (e as PlatformRuleError).code === 'NOT_AWAITING_REVIEW',
    );
  });
});

describe('给 L3 看的改动摘要', () => {
  test('新建文件也要出现在 diff 里 —— 落地时它们会被一起合进去', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);

    const { platform, prepared } = await missionReadyForReview(repo, worktrees, 'M1');
    // 执行者新建了一个文件（未跟踪）。
    writeFileSync(join(prepared.cwd, 'NEW.md'), '全新的文件\n');

    const diff = await platform.getMissionDiff('M1');
    assert.ok(
      diff.files.includes('NEW.md'),
      'git diff 看不到未跟踪文件，但落地时 git add -A 会把它合进去——' +
        'L3 就会在没看过的内容上签字',
    );
    assert.ok(diff.files.includes('a.txt'), '已跟踪的改动照样要在');
    assert.match(diff.stat, /NEW\.md/);

    // 落地之后目标分支上确实有这个文件。
    await platform.finalizeMission('M1', { verdict: 'merge', reasons: ['ok'], projectRoot: repo });
    assert.equal(git(repo, 'show', 'HEAD:NEW.md'), '全新的文件');
  });
});
