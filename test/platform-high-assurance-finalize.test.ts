/**
 * HA 受控放行：真实临时 Git 仓库覆盖绿/红/闸门/unsafe。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

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

const VERIFY_ARGV = ['node', '-e', 'process.exit(0)'];

const ORDER: WorkOrder = {
  objective: '改 a.txt',
  allowedScope: ['a.txt'],
  requiredBehaviour: 'a.txt 变成 mission',
  constraints: [],
  acceptance: ['内容是 mission'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
  validation: { commands: [{ argv: VERIFY_ARGV, timeoutMs: 5_000 }] },
};

const PLAN = {
  findings: 'f',
  rejectedHypotheses: [],
  decisions: [],
  direction: 'd',
  risks: [],
};

const SECRET = 'ha-config-body-secret';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function tempRepoOnIntegration(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-ha-repo-'));
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

function passingEngine(ids: SequentialIds, reports: InMemoryValidationReportRepository) {
  return {
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
              argv: [...VERIFY_ARGV],
              cwd: '/tmp',
              exitCode: 0,
              timedOut: false,
              durationMs: 1,
              outputTail: 'ok',
            },
          },
        ],
      };
      return { report, authority: { kind: 'validator' as const, reportId: id, policyRevision: 1 } };
    },
    reports,
  };
}

function writeAuthority(
  over: {
    reviewerId?: string;
    confirmedBy?: string;
    branches?: string[];
  } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-ha-auth-'));
  dirs.push(dir);
  const file = join(dir, 'ha.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      source: SECRET,
      reviewers: [
        {
          reviewerId: over.reviewerId ?? 'rv-1',
          confirmedBy: over.confirmedBy ?? 'human-1',
          integrationBranches: over.branches ?? ['auto/plan-x'],
        },
      ],
    }),
  );
  return resolve(file);
}

async function haReady(options?: {
  branch?: string;
  runner?: ReturnType<typeof scriptedRunner>;
  authorityFile?: string;
  skipPass?: boolean;
  sendBack?: boolean;
  omitTarget?: boolean;
}) {
  const branch = options?.branch ?? 'auto/plan-x';
  const repo = tempRepoOnIntegration(branch);
  const wt = mkdtempSync(join(tmpdir(), 'coagent-ha-wt-'));
  dirs.push(wt);
  const runner = options?.runner ?? scriptedRunner([0]);
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const workspace = new GitWorktreeManager(wt);
  const reports = new InMemoryValidationReportRepository();
  const engineBundle = passingEngine(ids, reports);
  const authorityFile = options?.authorityFile ?? writeAuthority({ branches: [branch] });
  const innerProjects = new InMemoryProjectRepository();
  const activity = new InMemoryActivityLog(clock);
  const platform2 = new Platform({
    projects: innerProjects,
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    workspace,
    activity,
    clock,
    ids,
    validation: {
      engine: engineBundle,
      reports,
      commandRunner: runner,
    },
    haAuthorityFile: authorityFile,
  });

  const missionId = 'M-ha';
  const projectObj = await innerProjects.ensure('P');
  projectObj.createMission({ id: missionId, contract: CONTRACT, executionMode: 'high_assurance' });
  await innerProjects.save(projectObj);

  const prepared = await workspace.prepare(missionId, repo);
  await platform2.recordWorkspace(missionId, {
    projectRoot: repo,
    branch: prepared.branch,
    baseRevision: prepared.baseRevision,
    ...(options?.omitTarget ? {} : { targetBranch: prepared.targetBranch }),
  });
  const coord = await platform2.startCoordinatorAttempt(missionId, {
    profileId: 'coord-a',
    endpoint: 'local',
  });
  await platform2.updatePlan(missionId, coord.attemptId, PLAN);
  const { workItemId } = await platform2.createWorkItem(missionId, coord.attemptId, {
    title: 'W',
    order: ORDER,
  });
  await platform2.dispatchWorkItems(missionId, coord.attemptId, [workItemId]);
  writeFileSync(join(prepared.cwd, 'a.txt'), 'mission\n');
  const exec = await platform2.startExecutorAttempt(missionId, workItemId, {
    profileId: 'exec-a',
    endpoint: 'local',
  });
  await platform2.submitEvidence(missionId, exec.attemptId, {
    kind: 'test',
    summary: '绿',
    command: 'node --test',
    exitCode: 0,
  });
  await platform2.submitExecutionResult(missionId, exec.attemptId, {
    outcome: 'completed',
    summary: '改好了',
    changedFiles: ['a.txt'],
    evidenceIds: [],
    notes: '无',
  });
  await platform2.finishAttempt(missionId, exec.attemptId, { endedBy: 'structured_submit' });
  await platform2.reviewExecutionResult(missionId, coord.attemptId, {
    workItemId,
    verdict: 'accept',
    acceptanceResults: ORDER.acceptance.map((criterion) => ({
      criterion,
      status: 'pass' as const,
      evidence: '测试替身：逐条核过',
    })),
    reasons: ['复跑过'],
    requiredChanges: [],
  });
  await platform2.submitMissionResult(missionId, coord.attemptId, {
    outcome: 'delivered',
    summary: '交付',
    acceptanceEvidence: [],
    memoryDelta: [],
    openRisks: [],
  });
  await platform2.finishAttempt(missionId, coord.attemptId, { endedBy: 'structured_submit' });

  if (!options?.skipPass) {
    await platform2.runHaDeterministicValidation(missionId, prepared.cwd);
    const started = await platform2.startIndependentReviewerAttempt(missionId, [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    await platform2.submitIndependentReview(missionId, started.attemptId, {
      verdict: options?.sendBack ? 'send_back' : 'pass',
      reasons: ['独立检视'],
    });
    await platform2.finishAttempt(missionId, started.attemptId, { endedBy: 'structured_submit' });
  }

  return {
    repo,
    wt,
    platform: platform2,
    workspace,
    runner,
    authorityFile,
    missionId,
    prepared,
    reports,
    clock,
    ids,
    projects: innerProjects,
    activity,
  };
}

function rebuildPlatform(fx: Awaited<ReturnType<typeof haReady>>): Platform {
  return new Platform({
    projects: fx.projects,
    deliveries: new InMemoryDeliveryRepository(fx.clock, fx.ids),
    workspace: fx.workspace,
    activity: fx.activity,
    clock: fx.clock,
    ids: fx.ids,
    validation: {
      engine: passingEngine(fx.ids, fx.reports),
      reports: fx.reports,
      commandRunner: fx.runner,
    },
    haAuthorityFile: fx.authorityFile,
  });
}

function release(
  platform: Platform,
  missionId: string,
  repo: string,
  over: {
    reviewerId?: string;
    confirmedBy?: string;
    verification?: readonly { argv: readonly string[]; timeoutMs: number }[];
  } = {},
) {
  return platform.finalizeMissionByHaAuthority(missionId, {
    reviewerId: over.reviewerId ?? 'rv-1',
    confirmedBy: over.confirmedBy ?? 'human-1',
    projectRoot: repo,
    ...(over.verification === undefined ? {} : { verification: over.verification }),
  });
}

function assertNoSecret(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  assert.equal(message.includes(SECRET), false, message);
}

describe('HA 受控放行：配置拒绝', () => {
  test('配置缺失且不泄露正文；HEAD / 状态 / FinalReview 不变', async () => {
    const fx = await haReady({ authorityFile: join(tempDirAuth(), 'missing.json') });
    const before = git(fx.repo, 'rev-parse', 'HEAD');
    await assert.rejects(
      () => release(fx.platform, fx.missionId, fx.repo),
      (error: unknown) => {
        assert.equal(error instanceof PlatformRuleError, true);
        assertNoSecret(error);
        return (error as PlatformRuleError).code === 'HA_AUTHORITY_FILE_MISSING';
      },
    );
    assert.equal(git(fx.repo, 'rev-parse', 'HEAD'), before);
    const view = await fx.platform.getMissionView(fx.missionId);
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.finalReview, undefined);
  });

  test('仓库内符号链接指向仓库外：拒绝且 HEAD/状态/FinalReview 不变', async (t) => {
    const fx = await haReady();
    const link = join(fx.repo, 'ha-inside-link.json');
    try {
      symlinkSync(fx.authorityFile, link);
    } catch {
      t.skip('未验证：本机无权创建符号链接');
      return;
    }
    const before = git(fx.repo, 'rev-parse', 'HEAD');
    const platform = new Platform({
      projects: fx.projects,
      deliveries: new InMemoryDeliveryRepository(fx.clock, fx.ids),
      workspace: fx.workspace,
      activity: fx.activity,
      clock: fx.clock,
      ids: fx.ids,
      validation: {
        engine: passingEngine(fx.ids, fx.reports),
        reports: fx.reports,
        commandRunner: fx.runner,
      },
      haAuthorityFile: link,
    });
    await assert.rejects(
      () => release(platform, fx.missionId, fx.repo),
      (error: unknown) =>
        error instanceof PlatformRuleError && error.code === 'HA_AUTHORITY_PATH_IN_REPO',
    );
    assert.equal(git(fx.repo, 'rev-parse', 'HEAD'), before);
    const view = await platform.getMissionView(fx.missionId);
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.finalReview, undefined);
  });

  test('改写配置撤销后同进程立即拒绝', async () => {
    const file = writeAuthority();
    const fx = await haReady({ authorityFile: file });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        source: SECRET,
        reviewers: [
          {
            reviewerId: 'other',
            confirmedBy: 'human-1',
            integrationBranches: ['auto/plan-x'],
          },
        ],
      }),
    );
    const before = git(fx.repo, 'rev-parse', 'HEAD');
    await assert.rejects(
      () => release(fx.platform, fx.missionId, fx.repo),
      (error: unknown) =>
        error instanceof PlatformRuleError && error.code === 'HA_AUTHORITY_REVIEWER_UNREGISTERED',
    );
    assert.equal(git(fx.repo, 'rev-parse', 'HEAD'), before);
  });

  test('未登记 / confirmedBy 不一致 / 分支不在 allowlist 均在合并前拒绝', async () => {
    const fx = await haReady();
    const before = git(fx.repo, 'rev-parse', 'HEAD');
    await assert.rejects(
      () => release(fx.platform, fx.missionId, fx.repo, { reviewerId: 'nope' }),
      (error: unknown) =>
        error instanceof PlatformRuleError && error.code === 'HA_AUTHORITY_REVIEWER_UNREGISTERED',
    );
    await assert.rejects(
      () => release(fx.platform, fx.missionId, fx.repo, { confirmedBy: 'human-2' }),
      (error: unknown) =>
        error instanceof PlatformRuleError && error.code === 'HA_AUTHORITY_CONFIRMED_BY_MISMATCH',
    );
    const other = await haReady({
      authorityFile: writeAuthority({ branches: ['auto/other'] }),
    });
    await assert.rejects(
      () => release(other.platform, other.missionId, other.repo),
      (error: unknown) =>
        error instanceof PlatformRuleError && error.code === 'HA_AUTHORITY_BRANCH_NOT_ALLOWED',
    );
    assert.equal(git(fx.repo, 'rev-parse', 'HEAD'), before);
    assert.equal(git(fx.repo, 'show', 'HEAD:a.txt'), 'base');
  });
});

function tempDirAuth(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-ha-missing-'));
  dirs.push(dir);
  return dir;
}

describe('HA 受控放行：分支与 pass', () => {
  test('缺历史目标分支拒绝', async () => {
    const fx = await haReady({ omitTarget: true });
    await assert.rejects(
      () => release(fx.platform, fx.missionId, fx.repo),
      (error: unknown) => error instanceof PlatformRuleError && error.code === 'HA_TARGET_MISSING',
    );
  });

  test('detached HEAD 拒绝', async () => {
    const fx = await haReady();
    git(fx.repo, 'checkout', '--detach', '-q');
    await assert.rejects(
      () => release(fx.platform, fx.missionId, fx.repo),
      (error: unknown) => error instanceof PlatformRuleError && error.code === 'HA_DETACHED_HEAD',
    );
  });

  test('错误目标拒绝', async () => {
    const fx = await haReady();
    git(fx.repo, 'checkout', '-q', '-b', 'auto/wrong');
    await assert.rejects(
      () => release(fx.platform, fx.missionId, fx.repo),
      (error: unknown) => error instanceof PlatformRuleError && error.code === 'HA_TARGET_MISMATCH',
    );
  });

  test('master 拒绝', async () => {
    const fx = await haReady();
    git(fx.repo, 'checkout', '-q', 'master');
    // 目标仍是 auto/plan-x 时先不一致；把持久目标也改不了，checkout master 即拦。
    await assert.rejects(
      () => release(fx.platform, fx.missionId, fx.repo),
      (error: unknown) =>
        error instanceof PlatformRuleError &&
        (error.code === 'HA_TARGET_MISMATCH' || error.code === 'HA_AUTHORITY_MASTER_FORBIDDEN'),
    );
  });

  test('旧分叉基线在合并前拒绝', async () => {
    const fx = await haReady();
    writeFileSync(join(fx.repo, 'other.txt'), 'x\n');
    git(fx.repo, 'add', '-A');
    git(fx.repo, 'commit', '-q', '-m', 'advance');
    const before = git(fx.repo, 'rev-parse', 'HEAD');
    await assert.rejects(
      () => release(fx.platform, fx.missionId, fx.repo),
      (error: unknown) => error instanceof PlatformRuleError && error.code === 'HA_STALE_BASELINE',
    );
    assert.equal(git(fx.repo, 'rev-parse', 'HEAD'), before);
    assert.equal((await fx.platform.getMissionView(fx.missionId)).finalReview, undefined);
  });

  test('HEAD 变化后当前 pass 失效，不能合并', async () => {
    const fx = await haReady();
    writeFileSync(join(fx.prepared.cwd, 'b.txt'), 'x\n');
    git(fx.prepared.cwd, 'add', '-A');
    git(fx.prepared.cwd, 'commit', '-q', '-m', 'move head');
    const before = git(fx.repo, 'rev-parse', 'HEAD');
    await assert.rejects(
      () => release(fx.platform, fx.missionId, fx.repo),
      (error: unknown) => error instanceof PlatformRuleError && error.code === 'HA_NO_EFFECTIVE_PASS',
    );
    assert.equal(git(fx.repo, 'rev-parse', 'HEAD'), before);
  });

  test('无有效 pass / 最新 send_back 不能合并', async () => {
    const none = await haReady({ skipPass: true });
    await assert.rejects(
      () => release(none.platform, none.missionId, none.repo),
      (error: unknown) => error instanceof PlatformRuleError && error.code === 'HA_NO_EFFECTIVE_PASS',
    );
    const back = await haReady({ sendBack: true });
    await assert.rejects(
      () => release(back.platform, back.missionId, back.repo),
      (error: unknown) => error instanceof PlatformRuleError && error.code === 'HA_NO_EFFECTIVE_PASS',
    );
  });
});

describe('HA 受控放行：显式方案验证', () => {
  test('显式命令保序运行并取代工作项命令', async () => {
    const fx = await haReady();
    const commands = [
      { argv: ['node', '-e', 'first'], timeoutMs: 1000 },
      { argv: ['node', '-e', 'second'], timeoutMs: 2000 },
    ];
    const result = await release(fx.platform, fx.missionId, fx.repo, { verification: commands });
    assert.equal(result.status, 'completed');
    assert.deepEqual(fx.runner.seen, commands.map((command) => [...command.argv]));
    assert.equal(git(fx.repo, 'show', 'HEAD:a.txt'), 'mission');
  });

  test('空命令、畸形 argv 与非法 timeout 在合并前拒绝', async () => {
    const cases: unknown[] = [[], [{ argv: [], timeoutMs: 1 }], [{ argv: [''], timeoutMs: 1 }],
      [{ argv: ['node', 3], timeoutMs: 1 }], ...[0, -1, 1.5, '1'].map((timeoutMs) => [{ argv: ['node'], timeoutMs }])];
    for (const verification of cases) {
      const fx = await haReady();
      const head = git(fx.repo, 'rev-parse', 'HEAD');
      await assert.rejects(() => release(fx.platform, fx.missionId, fx.repo, {
        verification: verification as { argv: readonly string[]; timeoutMs: number }[],
      }), (error: unknown) => error instanceof PlatformRuleError && error.code === 'HA_VERIFICATION_REQUIRED');
      assert.equal(git(fx.repo, 'rev-parse', 'HEAD'), head);
      assert.equal((await fx.platform.getMissionView(fx.missionId)).status, 'awaiting_review');
    }
  });

  test('显式验证红：回滚到锚点且仍 awaiting_review', async () => {
    const explicit = ['node', '-e', 'explicit-fail'];
    const fx = await haReady({ runner: scriptedRunner([1]) });
    const anchor = git(fx.repo, 'rev-parse', 'HEAD');
    const result = await release(fx.platform, fx.missionId, fx.repo, {
      verification: [{ argv: explicit, timeoutMs: 1000 }],
    });
    assert.equal(result.status, 'awaiting_review');
    assert.equal(result.rolledBackTo, anchor);
    assert.equal(git(fx.repo, 'rev-parse', 'HEAD'), anchor);
    assert.equal((await fx.platform.getMissionView(fx.missionId)).finalReview, undefined);
    assert.deepEqual(fx.runner.seen, [explicit]);
  });

  test('显式验证红且回滚失败：unsafe 持久并禁止再次放行', async () => {
    const explicit = ['node', '-e', 'explicit-fail'];
    const fx = await haReady({ runner: scriptedRunner([1]) });
    fx.workspace.resetTarget = async () => { throw new Error('simulated reset failure'); };
    const result = await release(fx.platform, fx.missionId, fx.repo, {
      verification: [{ argv: explicit, timeoutMs: 1000 }],
    });
    assert.equal(result.status, 'awaiting_review');
    assert.match(result.reason ?? '', /禁止自动重合/);
    const events = await fx.platform.getActivity(fx.missionId);
    assert.equal((events.find((event) => event.kind === 'final_review.ha_unsafe')?.data as { reason?: string } | undefined)?.reason, 'rollback_failed');
    assert.deepEqual(fx.runner.seen, [explicit]);
    const again = await release(rebuildPlatform(fx), fx.missionId, fx.repo, {
      verification: [{ argv: explicit, timeoutMs: 1000 }],
    });
    assert.match(again.reason ?? '', /禁止自动重合/);
    assert.deepEqual(fx.runner.seen, [explicit]);
  });

  test('显式验证期间目标推进：unsafe 且不完成', async () => {
    const explicit = ['node', '-e', 'explicit-advance'];
    const runner = {
      seen: [] as string[][],
      async run(input: { argv: readonly string[]; cwd: string }) {
        runner.seen.push([...input.argv]);
        writeFileSync(join(input.cwd, 'explicit-during.txt'), 'x\\n');
        git(input.cwd, 'add', '-A');
        git(input.cwd, 'commit', '-q', '-m', 'advance during explicit verify');
        return { exitCode: 0, timedOut: false, durationMs: 1, output: 'ok' };
      },
    };
    const fx = await haReady({ runner: runner as ReturnType<typeof scriptedRunner> });
    const result = await release(fx.platform, fx.missionId, fx.repo, {
      verification: [{ argv: explicit, timeoutMs: 1000 }],
    });
    assert.equal(result.status, 'awaiting_review');
    assert.match(result.reason ?? '', /禁止自动重合/);
    assert.equal((await fx.platform.getMissionView(fx.missionId)).finalReview, undefined);
    assert.deepEqual(runner.seen, [explicit]);
    const events = await fx.platform.getActivity(fx.missionId);
    assert.equal((events.find((event) => event.kind === 'final_review.ha_unsafe')?.data as { reason?: string } | undefined)?.reason, 'advanced_during_verify');
  });

  test('显式命令下三道闸仍在合并前拒绝且状态不变', async () => {
    const explicit = [{ argv: ['node', '-e', 'must-not-run'], timeoutMs: 1000 }];
    // 临时仓库 init 后本来就有 master，不能再以 master 为集成分支新建；照「master 拒绝」
    // 用例的造法：夹具照常建好再 checkout master，目标不一致或 master 禁令任一拦下都算。
    const onMaster = await haReady();
    git(onMaster.repo, 'checkout', '-q', 'master');
    const cases = [
      { fx: await haReady(), over: { reviewerId: 'unregistered' }, codes: ['HA_AUTHORITY_REVIEWER_UNREGISTERED'] },
      { fx: await haReady({ skipPass: true }), over: {}, codes: ['HA_NO_EFFECTIVE_PASS'] },
      { fx: onMaster, over: {}, codes: ['HA_TARGET_MISMATCH', 'HA_AUTHORITY_MASTER_FORBIDDEN'] },
    ];
    for (const item of cases) {
      const head = git(item.fx.repo, 'rev-parse', 'HEAD');
      await assert.rejects(() => release(item.fx.platform, item.fx.missionId, item.fx.repo, {
        ...item.over, verification: explicit,
      }), (error: unknown) => error instanceof PlatformRuleError && item.codes.includes(error.code));
      assert.equal(git(item.fx.repo, 'rev-parse', 'HEAD'), head);
      const view = await item.fx.platform.getMissionView(item.fx.missionId);
      assert.equal(view.status, 'awaiting_review');
      assert.equal(view.finalReview, undefined);
      assert.deepEqual(item.fx.runner.seen, []);
    }
  });
});

describe('HA 受控放行：绿 / 红 / 重复 / unsafe', () => {
  test('绿：合并、completed、reviewer 权威、事件关联 source 与报告', async () => {
    const fx = await haReady();
    const result = await release(fx.platform, fx.missionId, fx.repo);
    assert.equal(result.status, 'completed');
    assert.equal(git(fx.repo, 'show', 'HEAD:a.txt'), 'mission');
    const view = await fx.platform.getMissionView(fx.missionId);
    assert.equal(view.finalReview?.authority?.kind, 'reviewer');
    if (view.finalReview?.authority?.kind === 'reviewer') {
      assert.equal(view.finalReview.authority.reviewerId, 'rv-1');
      assert.equal(view.finalReview.authority.confirmedBy, 'human-1');
      assert.match(view.finalReview.authority.confirmedAt, /^\d{4}-\d{2}-\d{2}T/);
    }
    const events = await fx.platform.getActivity(fx.missionId);
    const auth = events.find((event) => event.kind === 'final_review.ha_authorized');
    const data = auth?.data as { source?: string; integrationReportId?: string } | undefined;
    assert.equal(data?.source, SECRET);
    assert.equal(data?.integrationReportId, result.reportId);
    assert.ok(result.reportId);
  });

  test('红：回滚到锚点，仍 awaiting_review，无 FinalReview', async () => {
    const fx = await haReady({ runner: scriptedRunner([1]) });
    const anchor = git(fx.repo, 'rev-parse', 'HEAD');
    const result = await release(fx.platform, fx.missionId, fx.repo);
    assert.equal(result.status, 'awaiting_review');
    assert.equal(result.rolledBackTo, anchor);
    assert.equal(git(fx.repo, 'rev-parse', 'HEAD'), anchor);
    assert.equal(git(fx.repo, 'show', 'HEAD:a.txt'), 'base');
    const view = await fx.platform.getMissionView(fx.missionId);
    assert.equal(view.finalReview, undefined);
  });

  test('第三方推进：unsafe 且禁止再合', async () => {
    const runner = {
      seen: [] as string[][],
      async run(input: { argv: readonly string[]; cwd: string }) {
        runner.seen.push([...input.argv]);
        writeFileSync(join(input.cwd, 'third.txt'), 'x\n');
        git(input.cwd, 'add', '-A');
        git(input.cwd, 'commit', '-q', '-m', 'third party');
        return { exitCode: 1, timedOut: false, durationMs: 1, output: 'fail' };
      },
    };
    const fx = await haReady({ runner: runner as ReturnType<typeof scriptedRunner> });
    const result = await release(fx.platform, fx.missionId, fx.repo);
    assert.equal(result.status, 'awaiting_review');
    assert.match(result.reason ?? '', /禁止自动重合/);
    const head = git(fx.repo, 'rev-parse', 'HEAD');
    const again = await release(fx.platform, fx.missionId, fx.repo);
    assert.equal(again.status, 'awaiting_review');
    assert.match(again.reason ?? '', /禁止自动重合/);
    assert.equal(git(fx.repo, 'rev-parse', 'HEAD'), head);
    assert.equal(runner.seen.length, 1, '第二次不得再跑验证或合并');
  });

  test('已合未记：恢复提示、不二次合并、不冒记完成', async () => {
    const fx = await haReady();
    await fx.workspace.mergeToTarget({
      missionId: fx.missionId,
      projectRoot: fx.repo,
      branch: fx.prepared.branch,
      expectedBaseRevision: fx.prepared.baseRevision,
    });
    assert.equal(git(fx.repo, 'show', 'HEAD:a.txt'), 'mission');
    const head = git(fx.repo, 'rev-parse', 'HEAD');
    const result = await release(fx.platform, fx.missionId, fx.repo);
    assert.equal(result.status, 'awaiting_review');
    assert.match(result.reason ?? '', /未记完成/);
    assert.equal(git(fx.repo, 'rev-parse', 'HEAD'), head);
    const view = await fx.platform.getMissionView(fx.missionId);
    assert.equal(view.finalReview, undefined);
    const again = await release(fx.platform, fx.missionId, fx.repo);
    assert.match(again.reason ?? '', /禁止自动重合/);
    assert.equal(fx.runner.seen.length, 0);
  });

  test('已 completed 的重复调用不重复验证或写报告', async () => {
    const fx = await haReady();
    const first = await release(fx.platform, fx.missionId, fx.repo);
    assert.equal(first.status, 'completed');
    const seen = fx.runner.seen.length;
    const events = (await fx.platform.getActivity(fx.missionId)).length;
    const second = await release(fx.platform, fx.missionId, fx.repo);
    assert.equal(second.status, 'completed');
    assert.equal(second.mergedInto, first.mergedInto);
    assert.equal(fx.runner.seen.length, seen);
    assert.equal((await fx.platform.getActivity(fx.missionId)).length, events);
  });

  test('runner 期间推进目标：验证绿也不得 completed，unsafe 禁止再合', async () => {
    const runner = {
      seen: [] as string[][],
      async run(input: { argv: readonly string[]; cwd: string }) {
        runner.seen.push([...input.argv]);
        writeFileSync(join(input.cwd, 'during.txt'), 'x\n');
        git(input.cwd, 'add', '-A');
        git(input.cwd, 'commit', '-q', '-m', 'advance during verify');
        return { exitCode: 0, timedOut: false, durationMs: 1, output: 'ok' };
      },
    };
    const fx = await haReady({ runner: runner as ReturnType<typeof scriptedRunner> });
    const result = await release(fx.platform, fx.missionId, fx.repo);
    assert.equal(result.status, 'awaiting_review');
    assert.match(result.reason ?? '', /禁止自动重合/);
    const view = await fx.platform.getMissionView(fx.missionId);
    assert.equal(view.finalReview, undefined);
    const events = await fx.platform.getActivity(fx.missionId);
    const unsafe = events.find((event) => event.kind === 'final_review.ha_unsafe');
    assert.equal((unsafe?.data as { reason?: string } | undefined)?.reason, 'advanced_during_verify');
    const head = git(fx.repo, 'rev-parse', 'HEAD');
    const again = await release(fx.platform, fx.missionId, fx.repo);
    assert.equal(again.status, 'awaiting_review');
    assert.match(again.reason ?? '', /禁止自动重合/);
    assert.equal(git(fx.repo, 'rev-parse', 'HEAD'), head);
    assert.equal(runner.seen.length, 1, '第二次不得再跑验证或合并');
  });

  test('runner 期间切换 checkout：验证绿也不得 completed，unsafe 禁止再合', async () => {
    const runner = {
      seen: [] as string[][],
      async run(input: { argv: readonly string[]; cwd: string }) {
        runner.seen.push([...input.argv]);
        git(input.cwd, 'checkout', '-q', '-b', 'diverted');
        return { exitCode: 0, timedOut: false, durationMs: 1, output: 'ok' };
      },
    };
    const fx = await haReady({ runner: runner as ReturnType<typeof scriptedRunner> });
    const result = await release(fx.platform, fx.missionId, fx.repo);
    assert.equal(result.status, 'awaiting_review');
    assert.match(result.reason ?? '', /禁止自动重合/);
    const view = await fx.platform.getMissionView(fx.missionId);
    assert.equal(view.finalReview, undefined);
    const events = await fx.platform.getActivity(fx.missionId);
    const unsafe = events.find((event) => event.kind === 'final_review.ha_unsafe');
    assert.equal((unsafe?.data as { reason?: string } | undefined)?.reason, 'advanced_during_verify');
    git(fx.repo, 'checkout', '-q', 'auto/plan-x');
    const again = await release(fx.platform, fx.missionId, fx.repo);
    assert.equal(again.status, 'awaiting_review');
    assert.match(again.reason ?? '', /禁止自动重合/);
    assert.equal(runner.seen.length, 1, '第二次不得再跑验证或合并');
  });

  test('git reset 抛错后重建平台再次放行仍被禁止', async () => {
    const fx = await haReady({ runner: scriptedRunner([1]) });
    fx.workspace.resetTarget = async () => {
      throw new Error('simulated git reset failure');
    };
    const first = await release(fx.platform, fx.missionId, fx.repo);
    assert.equal(first.status, 'awaiting_review');
    assert.match(first.reason ?? '', /禁止自动重合/);
    const view = await fx.platform.getMissionView(fx.missionId);
    assert.equal(view.finalReview, undefined);
    const events = await fx.platform.getActivity(fx.missionId);
    const unsafe = events.find((event) => event.kind === 'final_review.ha_unsafe');
    assert.equal((unsafe?.data as { reason?: string } | undefined)?.reason, 'rollback_failed');
    const rebuilt = rebuildPlatform(fx);
    const again = await release(rebuilt, fx.missionId, fx.repo);
    assert.equal(again.status, 'awaiting_review');
    assert.match(again.reason ?? '', /禁止自动重合/);
    assert.equal(fx.runner.seen.length, 1, '重建后不得再跑验证或合并');
  });
});
