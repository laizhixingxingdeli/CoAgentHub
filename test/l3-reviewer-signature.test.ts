/**
 * l3 merge / send-back / abandon 的检视者签名。
 *
 * 校验必须发生在构建平台之前：写命令会拿排他锁并跑启动收敛，可能改状态文件。
 * 用真子进程、临时目录、真 git，不在本仓库上跑。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPersistentPlatform } from '../src/main.ts';
import { GitWorktreeManager } from '../src/application/workspace.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

const L3 = fileURLToPath(new URL('../src/l3.ts', import.meta.url));

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

function l3(statePath: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [L3, ...args, '--state', statePath], { encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

async function driveToReview(
  platform: {
    createMission: (input: { projectId: string; missionId: string; contract: MissionContract }) => Promise<unknown>;
    recordWorkspace: (missionId: string, ref: { projectRoot?: string; branch: string; baseRevision: string }) => Promise<unknown>;
    startCoordinatorAttempt: (missionId: string) => Promise<{ attemptId: string }>;
    updatePlan: (missionId: string, attemptId: string, plan: typeof PLAN) => Promise<unknown>;
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
    acceptanceResults: ORDER.acceptance.map((criterion) => ({
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

async function fixtureAwaitingReview(missionId: string, options?: { executionMode?: 'high_assurance'; bait?: boolean }) {
  const repo = tempRepo();
  const dir = mkdtempSync(join(tmpdir(), 'coagent-l3-rev-'));
  dirs.push(dir);
  const statePath = join(dir, 'state.json');
  // 不传显式根：跟 l3 子进程一样落在 <repo>/.coagent-worktrees。
  // 另开临时根的话，CLI 默认管理器找不到未提交改动，merge --no-ff 合进空分支，HEAD 仍是 base。
  const workspace = new GitWorktreeManager();
  const built = await buildPersistentPlatform(statePath, { workspace, reconcile: false });
  if (options?.executionMode) {
    const project = await built.projects.ensure('P');
    project.createMission({ id: missionId, contract: CONTRACT, executionMode: options.executionMode });
    await built.projects.save(project);
  } else {
    await built.platform.createMission({ projectId: 'P', missionId, contract: CONTRACT });
  }
  await driveToReview(built.platform, workspace, repo, missionId);
  if (options?.bait) {
    await built.platform.createMission({ projectId: 'P-bait', missionId: 'M-bait', contract: CONTRACT });
    await built.platform.startCoordinatorAttempt('M-bait');
  }
  built.persist();
  return { repo, statePath, missionId };
}

function patchAuthority(statePath: string, missionId: string, authority: unknown | 'delete') {
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
    projects: { missions: { id: string; finalReview?: { authority?: unknown } }[] }[];
  };
  const mission = state.projects.flatMap((project) => project.missions).find((item) => item.id === missionId);
  assert.ok(mission?.finalReview, '要有 finalReview 才能改权威');
  if (authority === 'delete') delete mission.finalReview.authority;
  else mission.finalReview.authority = authority;
  writeFileSync(statePath, JSON.stringify(state));
}

describe('l3 终审：成对身份参数', () => {
  test('三种命令同时带 --as --confirmed-by 都写成 reviewer；trim；confirmedAt 是 ISO', async () => {
    const commands: Array<{ args: string[]; status: string; verdict: string }> = [
      { args: ['merge'], status: 'completed', verdict: 'merge' },
      { args: ['send-back', '--reason', '再改'], status: 'planning', verdict: 'send_back' },
      { args: ['abandon', '--reason', '不做了'], status: 'blocked', verdict: 'abandon' },
    ];
    for (const command of commands) {
      const { repo, statePath, missionId } = await fixtureAwaitingReview('M1');
      const { status, out } = l3(
        statePath,
        command.args[0]!,
        missionId,
        ...command.args.slice(1),
        '--as',
        '  claude  ',
        '--confirmed-by',
        '  echo  ',
        '--repo',
        repo,
      );
      assert.equal(status, 0, out);
      const revived = await buildPersistentPlatform(statePath, { reconcile: false });
      const view = await revived.platform.getMissionView(missionId);
      assert.equal(view.status, command.status);
      assert.equal(view.finalReview?.verdict, command.verdict);
      const authority = view.finalReview?.authority;
      assert.equal(authority?.kind, 'reviewer');
      if (authority?.kind === 'reviewer') {
        assert.equal(authority.reviewerId, 'claude');
        assert.equal(authority.confirmedBy, 'echo');
        assert.match(authority.confirmedAt, /^\d{4}-\d{2}-\d{2}T.+/);
      }
      const events = await revived.platform.getActivity(missionId);
      const kind =
        command.verdict === 'merge'
          ? 'final_review.merged'
          : command.verdict === 'send_back'
            ? 'final_review.send_back'
            : 'final_review.abandoned';
      const reviewEvent = events.find((event) => event.kind === kind);
      assert.equal((reviewEvent?.data as { authority?: string } | undefined)?.authority, 'reviewer');
      // 与 human 合并用例同一条落地断言：合进去才算闸没变。
      if (command.verdict === 'merge') {
        assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'mission');
      } else {
        assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'base');
      }
    }
  });

  test('两参数都不带时三种命令仍写 {kind:human}，合并闸照旧', async () => {
    const { repo, statePath, missionId } = await fixtureAwaitingReview('M1');
    const { status, out } = l3(statePath, 'merge', missionId, '--reason', 'ok', '--repo', repo);
    assert.equal(status, 0, out);
    const revived = await buildPersistentPlatform(statePath, { reconcile: false });
    const view = await revived.platform.getMissionView(missionId);
    assert.equal(view.status, 'completed');
    assert.deepEqual(view.finalReview?.authority, { kind: 'human' });
    assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'mission');
  });

  test('不带身份的 send-back / abandon 仍写 human', async () => {
    for (const [verb, expected] of [
      ['send-back', 'planning'],
      ['abandon', 'blocked'],
    ] as const) {
      const { repo, statePath, missionId } = await fixtureAwaitingReview('M1');
      const { status, out } = l3(statePath, verb, missionId, '--reason', '再改', '--repo', repo);
      assert.equal(status, 0, out);
      const revived = await buildPersistentPlatform(statePath, { reconcile: false });
      const view = await revived.platform.getMissionView(missionId);
      assert.equal(view.status, expected);
      assert.deepEqual(view.finalReview?.authority, { kind: 'human' });
      assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'base');
    }
  });
});

describe('l3 终审：校验在构建平台之前', () => {
  test('只给一侧、缺值、空白、超长均非零退出；状态字节与 HEAD 不变', async () => {
    const { repo, statePath, missionId } = await fixtureAwaitingReview('M1', { bait: true });
    const beforeState = readFileSync(statePath);
    const beforeHead = git(repo, 'rev-parse', 'HEAD');
    const cases: Array<{ args: string[]; why: RegExp }> = [
      { args: ['--as', 'claude'], why: /--confirmed-by/ },
      { args: ['--confirmed-by', 'echo'], why: /--as/ },
      { args: ['--as', '--confirmed-by', 'echo'], why: /--as 缺参数值/ },
      { args: ['--as', 'claude', '--confirmed-by'], why: /--confirmed-by 缺参数值/ },
      { args: ['--as', '   ', '--confirmed-by', 'echo'], why: /空白/ },
      { args: ['--as', 'claude', '--confirmed-by', '   '], why: /空白/ },
      { args: ['--as', 'x'.repeat(129), '--confirmed-by', 'echo'], why: /128/ },
      { args: ['--as', 'claude', '--confirmed-by', 'y'.repeat(129)], why: /128/ },
    ];
    for (const command of ['merge', 'send-back', 'abandon'] as const) {
      for (const item of cases) {
        const extra = command === 'merge' ? [] : ['--reason', 'x'];
        const { status, out } = l3(statePath, command, missionId, ...extra, ...item.args, '--repo', repo);
        assert.notEqual(status, 0, `${command} ${item.args.join(' ')} 应失败：${out}`);
        assert.match(out, item.why, out);
        assert.equal(readFileSync(statePath).equals(beforeState), true, `${command} 改了状态文件字节`);
        assert.equal(git(repo, 'rev-parse', 'HEAD'), beforeHead);
      }
    }
    const revived = await buildPersistentPlatform(statePath, { reconcile: false });
    assert.equal((await revived.platform.getMissionView(missionId)).status, 'awaiting_review');
    const bait = await revived.platform.getMissionView('M-bait');
    assert.equal(bait.status, 'investigating');
  });
});

describe('l3 终审：HA Mission', () => {
  // E3a 起 HA 的放行只走受控终审（E3b：外置常设授权 + 当前有效的独立检视 pass + 合并后验证）。
  // 在那之前，带两个身份的旧 reviewer merge 也不能合 HA——两个 CLI 字符串证明不了授权。
  test('带两个身份的检视者 merge 对 HA 也被拒，状态与 HEAD 不变', async () => {
    const { repo, statePath, missionId } = await fixtureAwaitingReview('M-HA', {
      executionMode: 'high_assurance',
    });
    const beforeState = readFileSync(statePath);
    const beforeHead = git(repo, 'rev-parse', 'HEAD');
    const { status, out } = l3(
      statePath,
      'merge',
      missionId,
      '--as',
      'claude',
      '--confirmed-by',
      'echo',
      '--repo',
      repo,
    );
    assert.notEqual(status, 0, out);
    assert.match(out, /high_assurance/);
    assert.equal(readFileSync(statePath).equals(beforeState), true);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), beforeHead);
    const revived = await buildPersistentPlatform(statePath, { reconcile: false });
    const view = await revived.platform.getMissionView(missionId);
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.finalReview, undefined);
  });

  test('不带确认人被拒且不改变状态', async () => {
    const { repo, statePath, missionId } = await fixtureAwaitingReview('M-HA', {
      executionMode: 'high_assurance',
      bait: true,
    });
    const beforeState = readFileSync(statePath);
    const beforeHead = git(repo, 'rev-parse', 'HEAD');
    const { status, out } = l3(statePath, 'merge', missionId, '--as', 'claude', '--repo', repo);
    assert.notEqual(status, 0, out);
    assert.match(out, /--confirmed-by/);
    assert.equal(readFileSync(statePath).equals(beforeState), true);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), beforeHead);
  });
});

describe('l3 show：四类权威与未记录', () => {
  test('human / reviewer / machine / plan / 未记录 都能看出来', async () => {
    const { repo, statePath, missionId } = await fixtureAwaitingReview('M-show');
    const merged = l3(statePath, 'merge', missionId, '--repo', repo);
    assert.equal(merged.status, 0, merged.out);

    const human = l3(statePath, 'show', missionId);
    assert.equal(human.status, 0, human.out);
    assert.match(human.out, /【最终检视】merge/);
    assert.match(human.out, /权威：人/);
    assert.doesNotMatch(human.out, /主体：/);
    assert.doesNotMatch(human.out, /未记录/);

    patchAuthority(statePath, missionId, { kind: 'human', principalId: 'echo' });
    const named = l3(statePath, 'show', missionId);
    assert.match(named.out, /权威：人/);
    assert.match(named.out, /主体：echo/);

    patchAuthority(statePath, missionId, {
      kind: 'reviewer',
      reviewerId: 'claude',
      confirmedBy: 'echo',
      confirmedAt: '2026-09-25T12:00:00.000Z',
    });
    const reviewer = l3(statePath, 'show', missionId);
    assert.match(reviewer.out, /权威：检视者/);
    assert.match(reviewer.out, /检视者：claude/);
    assert.match(reviewer.out, /确认人：echo/);
    assert.match(reviewer.out, /确认于：2026-09-25T12:00:00.000Z/);

    patchAuthority(statePath, missionId, {
      kind: 'machine',
      integrationReportId: 'IVAL-9',
      policyRevision: 1,
    });
    const machine = l3(statePath, 'show', missionId);
    assert.match(machine.out, /权威：机器/);
    assert.match(machine.out, /集成报告：IVAL-9/);

    patchAuthority(statePath, missionId, { kind: 'plan', planRunId: 'PLAN-x', escalationId: 'E-1' });
    const plan = l3(statePath, 'show', missionId);
    assert.match(plan.out, /权威：方案/);
    assert.match(plan.out, /方案运行：PLAN-x/);
    assert.match(plan.out, /升级单：E-1/);

    patchAuthority(statePath, missionId, 'delete');
    const legacy = l3(statePath, 'show', missionId);
    assert.match(legacy.out, /权威：未记录/);
    assert.doesNotMatch(legacy.out, /权威：人/);
  });
});

describe('l3 show：HA 子态与阻塞原因', () => {
  test('show 看得到待派发、waitDetail、独立检视阻塞原因与细节', async () => {
    const { statePath, missionId } = await fixtureAwaitingReview('M-HA-show', {
      executionMode: 'high_assurance',
    });
    const pending = l3(statePath, 'show', missionId);
    assert.equal(pending.status, 0, pending.out);
    assert.match(pending.out, /待派发/);

    const revived = await buildPersistentPlatform(statePath, { reconcile: false });
    await assert.rejects(() => revived.platform.startIndependentReviewerAttempt(missionId, []));
    await revived.platform.setWaitReason(
      missionId,
      'waiting_l3',
      'HA 独立检视故障：没有独立检视候选',
    );
    revived.persist();

    const fault = l3(statePath, 'show', missionId);
    assert.equal(fault.status, 0, fault.out);
    assert.match(fault.out, /故障/);
    assert.match(fault.out, /HA 独立检视故障：没有独立检视候选/);
    // 夹具的历史 Attempt 没记 profileId：独立性先卡在「无法证明」，阻塞原因是它而不是缺候选。
    assert.match(fault.out, /history_missing_profile/);
    assert.match(fault.out, /缺 profileId/);
  });
});
