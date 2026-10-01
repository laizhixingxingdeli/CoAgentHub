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
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
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
import { listenLoopback } from '../src/application/loopback-listen.ts';

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
const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
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
  const projects = new InMemoryProjectRepository();
  const activity = new InMemoryActivityLog(clock);
  const platform = new Platform({
    projects,
    deliveries,
    workspace,
    activity,
    clock,
    ids,
  });
  return { platform, workspace, deliveries, projects, activity, clock };
}

/** 把一条 Mission 推到「已交卷、等 L3 检视」，并在工作区里留下真实改动。 */
async function missionReadyForReview(
  repo: string,
  worktreeRoot: string,
  missionId: string,
  options?: { executionMode?: 'high_assurance' },
) {
  const harness = makeHarness(worktreeRoot);
  const { platform, workspace, projects } = harness;
  if (options?.executionMode) {
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
  if (options?.executionMode !== 'high_assurance') {
    // W-334：Standard 第一次派发前必须先落一条契约核对结论，否则派发被门禁拒绝；
    // 不给 HA 补这一条——HA 不经过这个门禁，补了等于改掉被测场景。
    await platform.submitContractCheck(missionId, coord.attemptId, {
      verdict: 'ok',
      summary: '测试契约已核对',
    });
  }
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

/**
 * 谁放行的，必须记下来（F1）。
 *
 * 由来：无人值守推进时，机器放行的 Mission 早上看起来和人工放行的一模一样。
 * 不记权威就回答不了「这是谁放的」——而出事后第一个要问的就是这个。
 */
describe('最终检视权威', () => {
  test('merge 记下人类权威', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);
    const { platform } = await missionReadyForReview(repo, worktrees, 'M1');

    await platform.finalizeMission('M1', {
      verdict: 'merge',
      reasons: ['ok'],
      projectRoot: repo,
    });

    const view = await platform.getMissionView('M1');
    assert.deepEqual(view.finalReview?.authority, { kind: 'human' });
  });

  test('有 principalId 就记下是谁', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);
    const { platform } = await missionReadyForReview(repo, worktrees, 'M1');

    await platform.finalizeMission('M1', {
      verdict: 'merge',
      reasons: ['ok'],
      projectRoot: repo,
      authority: { kind: 'human', principalId: 'echo' },
    });

    const view = await platform.getMissionView('M1');
    assert.deepEqual(view.finalReview?.authority, { kind: 'human', principalId: 'echo' });
  });

  test('send_back 也记权威 —— 打回同样是一次放行判断', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);
    const { platform } = await missionReadyForReview(repo, worktrees, 'M1');

    await platform.finalizeMission('M1', {
      verdict: 'send_back',
      reasons: ['再改'],
      projectRoot: repo,
    });

    const view = await platform.getMissionView('M1');
    assert.deepEqual(view.finalReview?.authority, { kind: 'human' });
  });

  /**
   * 这一条是整票的要害：能从外面写一个 kind 上去，权威就等于没有。
   * 同 promoteMissionToStandard 拒绝 budget_exceeded 的纪律。
   */
  test('公开入口拒绝机器权威', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);
    const { platform } = await missionReadyForReview(repo, worktrees, 'M1');

    await assert.rejects(
      () =>
        platform.finalizeMission('M1', {
          verdict: 'merge',
          reasons: ['ok'],
          projectRoot: repo,
          authority: {
            kind: 'machine',
            integrationReportId: 'VAL-forged',
            policyRevision: 1,
          } as never,
        }),
      (error: unknown) =>
        error instanceof PlatformRuleError &&
        error.code === 'FINAL_REVIEW_AUTHORITY_FORBIDDEN',
    );

    // 被拒之后 Mission 一点没动：不留半套流转。
    assert.equal((await platform.getMissionView('M1')).status, 'awaiting_review');
  });
});

describe('检视者终审签名', () => {
  test('三种 verdict 都记下 reviewer 签名；身份 trim；confirmedAt 来自平台时钟', async () => {
    const cases: Array<'merge' | 'send_back' | 'abandon'> = ['merge', 'send_back', 'abandon'];
    for (const verdict of cases) {
      const repo = tempRepo();
      const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
      dirs.push(worktrees);
      const { platform, clock } = await missionReadyForReview(repo, worktrees, 'M1');
      clock.advance(5_000);
      const result = await platform.finalizeMissionByReviewer('M1', {
        verdict,
        reasons: verdict === 'merge' ? ['ok'] : ['再改'],
        projectRoot: repo,
        reviewerId: '  claude  ',
        confirmedBy: '  echo  ',
      });
      if (verdict === 'merge') {
        assert.equal(result.status, 'completed');
        assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'mission');
      }
      if (verdict === 'send_back') {
        assert.equal(result.status, 'planning');
        assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'base');
      }
      if (verdict === 'abandon') {
        assert.equal(result.status, 'blocked');
        assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'base');
      }
      const view = await platform.getMissionView('M1');
      assert.deepEqual(view.finalReview?.authority, {
        kind: 'reviewer',
        reviewerId: 'claude',
        confirmedBy: 'echo',
        confirmedAt: '2026-01-01T00:00:05.000Z',
      });
      const events = await platform.getActivity('M1');
      const kind =
        verdict === 'merge'
          ? 'final_review.merged'
          : verdict === 'send_back'
            ? 'final_review.send_back'
            : 'final_review.abandoned';
      const reviewEvent = events.find((event) => event.kind === kind);
      assert.equal((reviewEvent?.data as { authority?: string } | undefined)?.authority, 'reviewer');
    }
  });

  test('身份非法时拒绝且状态不变', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);
    const { platform } = await missionReadyForReview(repo, worktrees, 'M1');
    const before = git(repo, 'rev-parse', 'HEAD');
    await assert.rejects(
      () =>
        platform.finalizeMissionByReviewer('M1', {
          verdict: 'merge',
          reasons: ['ok'],
          projectRoot: repo,
          reviewerId: '   ',
          confirmedBy: 'echo',
        }),
      (error: unknown) =>
        error instanceof PlatformRuleError && error.code === 'REVIEWER_IDENTITY_INVALID',
    );
    await assert.rejects(
      () =>
        platform.finalizeMissionByReviewer('M1', {
          verdict: 'merge',
          reasons: ['ok'],
          projectRoot: repo,
          reviewerId: 'r',
          confirmedBy: 'x'.repeat(129),
        }),
      (error: unknown) =>
        error instanceof PlatformRuleError && error.code === 'REVIEWER_IDENTITY_INVALID',
    );
    assert.equal((await platform.getMissionView('M1')).status, 'awaiting_review');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), before);
  });

  test('合并闸不变：目标 HEAD 变过，检视者 merge 仍不合', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);
    const { platform } = await missionReadyForReview(repo, worktrees, 'M1');
    writeFileSync(join(repo, 'other.txt'), 'someone else\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', '别人的提交');
    const result = await platform.finalizeMissionByReviewer('M1', {
      verdict: 'merge',
      reasons: ['看着没问题'],
      projectRoot: repo,
      reviewerId: 'claude',
      confirmedBy: 'echo',
    });
    assert.equal(result.status, 'blocked');
    assert.match(result.reason ?? '', /HEAD 变了/);
    assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'base');
    const view = await platform.getMissionView('M1');
    assert.equal(view.finalReview?.authority?.kind, 'reviewer');
  });

  // 旧 reviewer / 机器入口对 HA merge 仍拒；受控放行走 finalizeMissionByHaAuthority。
  test('HA：检视者 merge 被拒；机器 L3 仍 HIGH_ASSURANCE_NEEDS_HUMAN', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);
    const { platform } = await missionReadyForReview(repo, worktrees, 'M-HA', {
      executionMode: 'high_assurance',
    });
    const before = git(repo, 'rev-parse', 'HEAD');
    await assert.rejects(
      () =>
        platform.finalizeMissionByMachine('M-HA', {
          integrationBranch: 'master',
          verification: [{ argv: ['node', '--test'], timeoutMs: 1_000 }],
          projectRoot: repo,
        }),
      (error: unknown) =>
        error instanceof PlatformRuleError && error.code === 'HIGH_ASSURANCE_NEEDS_HUMAN',
    );
    assert.equal((await platform.getMissionView('M-HA')).status, 'awaiting_review');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), before);

    await assert.rejects(
      () =>
        platform.finalizeMissionByReviewer('M-HA', {
          verdict: 'merge',
          reasons: ['用户确认过'],
          projectRoot: repo,
          reviewerId: 'claude',
          confirmedBy: 'echo',
        }),
      (error: unknown) =>
        error instanceof PlatformRuleError &&
        error.code === 'HIGH_ASSURANCE_MERGE_NOT_AVAILABLE',
    );
    const view = await platform.getMissionView('M-HA');
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.finalReview, undefined);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), before);
    assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'base');
  });
});

describe('公开终审入口仍只发 human', () => {
  test('公开 finalizeMission 拒绝伪造的 reviewer / machine / plan', async () => {
    const forgeries: unknown[] = [
      { kind: 'reviewer', reviewerId: 'r', confirmedBy: 'c', confirmedAt: '2026-01-01T00:00:00.000Z' },
      { kind: 'machine', integrationReportId: 'IVAL-forged', policyRevision: 1 },
      { kind: 'plan', planRunId: 'R1', escalationId: 'E-1' },
    ];
    for (const authority of forgeries) {
      const repo = tempRepo();
      const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
      dirs.push(worktrees);
      const { platform } = await missionReadyForReview(repo, worktrees, 'M1');
      await assert.rejects(
        () =>
          platform.finalizeMission('M1', {
            verdict: 'merge',
            reasons: ['ok'],
            projectRoot: repo,
            authority: authority as never,
          }),
        (error: unknown) =>
          error instanceof PlatformRuleError && error.code === 'FINAL_REVIEW_AUTHORITY_FORBIDDEN',
      );
      assert.equal((await platform.getMissionView('M1')).status, 'awaiting_review');
    }
  });

  test('HTTP POST /finalize 伪造 reviewer / machine / plan 被拒且状态不变', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);
    const { platform, deliveries } = await missionReadyForReview(repo, worktrees, 'M1');
    const server = createApi({
      platform,
      tokens: new RunTokenRegistry(),
      deliveries,
    });
    servers.push(server);
    await listenLoopback(server, 0);
    const port = (server.address() as AddressInfo).port;
    const forgeries = [
      { kind: 'reviewer', reviewerId: 'r', confirmedBy: 'c', confirmedAt: '2026-01-01T00:00:00.000Z' },
      { kind: 'machine', integrationReportId: 'IVAL-forged', policyRevision: 1 },
      { kind: 'plan', planRunId: 'R1', escalationId: 'E-1' },
    ];
    for (const authority of forgeries) {
      const res = await fetch(`http://127.0.0.1:${port}/api/missions/M1/finalize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          verdict: 'merge',
          reasons: ['ok'],
          projectRoot: repo,
          authority,
        }),
      });
      const json = (await res.json()) as { error?: string };
      assert.equal(res.status, 409, json.error);
      assert.equal(json.error, 'FINAL_REVIEW_AUTHORITY_FORBIDDEN');
      assert.equal((await platform.getMissionView('M1')).status, 'awaiting_review');
    }
  });
});

describe('listRuns：检视者终审不计入人类 L3', () => {
  test('reviewer 三种 verdict 经真实入口不计且事件标 authority reviewer', async () => {
    const cases: Array<'merge' | 'send_back' | 'abandon'> = ['merge', 'send_back', 'abandon'];
    for (const verdict of cases) {
      const repo = tempRepo();
      const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
      dirs.push(worktrees);
      const missionId = `M-rev-${verdict}`;
      const { platform } = await missionReadyForReview(repo, worktrees, missionId);
      await platform.finalizeMissionByReviewer(missionId, {
        verdict,
        reasons: verdict === 'merge' ? ['ok'] : ['检视者打回'],
        projectRoot: repo,
        reviewerId: 'claude',
        confirmedBy: 'echo',
      });
      const kind =
        verdict === 'merge'
          ? 'final_review.merged'
          : verdict === 'send_back'
            ? 'final_review.send_back'
            : 'final_review.abandoned';
      const events = await platform.getActivity(missionId);
      const reviewEvent = events.find((event) => event.kind === kind);
      assert.equal((reviewEvent?.data as { authority?: string } | undefined)?.authority, 'reviewer');
      const [run] = await platform.listRuns(missionId);
      assert.equal(run.l3Reviews, 0, `${verdict} 检视者终审不得计入 l3Reviews`);
      assert.equal(run.l3SendBacks, 0, `${verdict} 检视者终审不得计入 l3SendBacks`);
    }
  });

  test('finalizeMission 的 human 与无 authority 历史事件仍计；未知 authority 不计', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);
    const { platform, activity } = await missionReadyForReview(repo, worktrees, 'M-human');
    await platform.finalizeMission('M-human', {
      verdict: 'send_back',
      reasons: ['人打回'],
      projectRoot: repo,
    });

    let [run] = await platform.listRuns('M-human');
    assert.equal(run.l3Reviews, 1, '公开 finalizeMission 写出的 human 终审要计次数');
    assert.equal(run.l3SendBacks, 1, '公开 finalizeMission 的 send_back 要计打回');

    await activity.append({
      projectId: 'P',
      missionId: 'M-human',
      kind: 'final_review.merged',
      data: { reasons: ['旧人类放行'] },
    });
    await activity.append({
      projectId: 'P',
      missionId: 'M-human',
      kind: 'final_review.send_back',
      data: { authority: 'human', reasons: ['显式 human 打回'] },
    });
    [run] = await platform.listRuns('M-human');
    assert.equal(run.l3Reviews, 3, '无标记历史事件与显式 authority:human 都要计');
    assert.equal(run.l3SendBacks, 2);

    await activity.append({
      projectId: 'P',
      missionId: 'M-human',
      kind: 'final_review.send_back',
      data: { authority: 'unknown', reasons: ['未知权威'] },
    });
    await activity.append({
      projectId: 'P',
      missionId: 'M-human',
      kind: 'final_review.merged',
      data: { authority: 'machine' },
    });
    await activity.append({
      projectId: 'P',
      missionId: 'M-human',
      kind: 'final_review.abandoned',
      data: { authority: 'plan' },
    });
    [run] = await platform.listRuns('M-human');
    assert.equal(run.l3Reviews, 3, 'unknown / machine / plan 不得计入');
    assert.equal(run.l3SendBacks, 2);
  });
});
