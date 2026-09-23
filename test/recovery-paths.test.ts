/**
 * 通路：出了岔子之后能不能接着走完。
 *
 * 前面验的都是顺风顺水的那条线。这里验的是四条"回头路"：
 *   1. L2 打回 L1，重发的工单要带上「这次要避开什么」
 *   2. L3 打回 L2，重跑时协调者要知道自己为什么被打回
 *   3. 协调者升级 L3，L3 答复之后重跑要能接着往下走
 *   4. 落地之后工作区要回收
 *
 * 三条都跑在 ScriptedRuntime 上——这台机器不需要装 pi。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Orchestrator } from '../src/application/orchestrator.ts';
import { Platform } from '../src/application/platform.ts';
import { GitWorktreeManager, InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { makeIssuer } from '../src/main.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';
import type { WorkspaceManager } from '../src/application/workspace.ts';

const CONTRACT = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: ['不许放宽断言'],
};

const ORDER = {
  objective: '改 a.txt',
  allowedScope: ['a.txt'],
  requiredBehaviour: 'a.txt 变成 mission',
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

/** S11.1：completed 必须有证据撑着 —— 平台会拦下没证据的提交。 */
const EVIDENCE = {
  kind: 'test' as const,
  summary: 'node --test 全绿',
  command: 'node --test',
  exitCode: 0,
};

const RESULT = {
  outcome: 'completed' as const,
  summary: '做完了',
  changedFiles: ['a.txt'],
  evidenceIds: [],
  notes: '无',
};

const DELIVER = {
  outcome: 'delivered' as const,
  summary: '交付',
  acceptanceEvidence: ['证据'],
  memoryDelta: [],
  openRisks: [],
};

const servers: Server[] = [];
const dirs: string[] = [];
after(() => {
  for (const server of servers) server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function harness(
  coordinator: ScriptedRuntime,
  executor: ScriptedRuntime,
  workspace: WorkspaceManager = new InPlaceWorkspaceManager(),
) {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    workspace,
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
  });
  const tokens = new RunTokenRegistry();
  const server = createApi({ platform, tokens, deliveries });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const makeOrchestrator = () =>
    new Orchestrator({
      platform,
      tokens: makeIssuer(platform, tokens),
      baseUrl,
      workspace,
      coordinator: { runtime: coordinator, candidates: [{ endpoint: 'l', profileId: 'c' }] },
      executor: { runtime: executor, candidates: [{ endpoint: 'l', profileId: 'e' }] },
    });
  return { platform, deliveries, makeOrchestrator };
}

describe('L2 打回 L1：重发的工单带上「这次要避开什么」', () => {
  test('第一次被 reject，第二次的工单里能读到 previousRequiredChanges', async () => {
    const coordinator = new ScriptedRuntime({
      'coordinator:-:0': {
        steps: [
          { tool: 'coagent_update_plan', body: PLAN },
          { tool: 'coagent_create_work_item', body: { title: 'W', ...ORDER } },
          { tool: 'coagent_dispatch_work_item', body: { workItemIds: ['W-1'] } },
        ],
      },
      // 第一次验收：打回，并写清楚要改什么
      'coordinator:-:1': {
        steps: [
          { tool: 'coagent_get_mission', body: {} },
          {
            tool: 'coagent_review_execution_result',
            body: {
              workItemId: 'W-1',
              verdict: 'reject', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'fail' as const })),
              reasons: ['证据里没有退出码，测试没真跑'],
              requiredChanges: ['把 verification 里的命令实际执行，并交上未接管道的退出码'],
            },
          },
          { tool: 'coagent_dispatch_work_item', body: { workItemIds: ['W-1'] } },
        ],
      },
      // 第二次验收：通过并交卷
      'coordinator:-:2': {
        steps: [
          { tool: 'coagent_get_mission', body: {} },
          {
            tool: 'coagent_review_execution_result',
            body: { workItemId: 'W-1', verdict: 'accept', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })), reasons: ['这次有退出码了'], requiredChanges: [] },
          },
          { tool: 'coagent_submit_mission_result', body: DELIVER },
        ],
      },
    });

    const executor = new ScriptedRuntime({
      'executor:W-1:0': {
        steps: [
          { tool: 'coagent_get_work_order', body: {} },
          { tool: 'coagent_submit_evidence', body: EVIDENCE },
          { tool: 'coagent_submit_execution_result', body: RESULT },
        ],
      },
      'executor:W-1:1': {
        steps: [
          { tool: 'coagent_get_work_order', body: {} },
          { tool: 'coagent_submit_evidence', body: EVIDENCE },
          { tool: 'coagent_submit_execution_result', body: RESULT },
        ],
      },
    });

    const { platform, makeOrchestrator } = await harness(coordinator, executor);
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const result = await makeOrchestrator().runMission('M1', { projectRoot: process.cwd() });

    assert.deepEqual(result, { kind: 'awaiting_l3_review' });

    // 第二次取工单时，平台把上一次的 requiredChanges 带了进去。
    const secondOrder = executor.transcript.filter(
      (entry) => entry.key === 'executor:W-1:1' && entry.tool === 'coagent_get_work_order',
    );
    assert.equal(secondOrder.length, 1);
    assert.deepEqual(
      (secondOrder[0].json as { previousRequiredChanges: string[] }).previousRequiredChanges,
      ['把 verification 里的命令实际执行，并交上未接管道的退出码'],
      '重发的工单必须带上这次要避开什么——不然重发的和上一张逐字相同',
    );

    const view = await platform.getMissionView('M1');
    assert.equal(view.workItems[0].attempts, 2, '同一工作项两次尝试');
    assert.equal(view.workItems[0].status, 'accepted');
  });
});

describe('L3 打回 L2：重跑时协调者知道自己为什么被打回', () => {
  test('send_back 之后重跑，唤醒语里带着 L3 的理由', async () => {
    const coordinator = new ScriptedRuntime({
      'coordinator:-:0': {
        steps: [
          { tool: 'coagent_update_plan', body: PLAN },
          { tool: 'coagent_create_work_item', body: { title: 'W', ...ORDER } },
          { tool: 'coagent_dispatch_work_item', body: { workItemIds: ['W-1'] } },
        ],
      },
      'coordinator:-:1': {
        steps: [
          { tool: 'coagent_get_mission', body: {} },
          {
            tool: 'coagent_review_execution_result',
            body: { workItemId: 'W-1', verdict: 'accept', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })), reasons: ['ok'], requiredChanges: [] },
          },
          { tool: 'coagent_submit_mission_result', body: DELIVER },
        ],
      },
      // 被 L3 打回之后这一轮：重新规划，再交一次
      'coordinator:-:2': {
        steps: [
          { tool: 'coagent_get_mission', body: {} },
          { tool: 'coagent_update_plan', body: { ...PLAN, direction: '按 L3 的意见换个方向' } },
          { tool: 'coagent_submit_mission_result', body: { ...DELIVER, summary: '按 L3 意见改过了' } },
        ],
      },
    });
    const executor = new ScriptedRuntime({
      'executor:W-1': {
        steps: [
          { tool: 'coagent_get_work_order', body: {} },
          { tool: 'coagent_submit_evidence', body: EVIDENCE },
          { tool: 'coagent_submit_execution_result', body: RESULT },
        ],
      },
    });

    const { platform, makeOrchestrator } = await harness(coordinator, executor);
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });

    const first = await makeOrchestrator().runMission('M1', { projectRoot: process.cwd() });
    assert.deepEqual(first, { kind: 'awaiting_l3_review' });

    // L3 打回。
    await platform.finalizeMission('M1', {
      verdict: 'send_back',
      reasons: ['实现越过了架构边界：新增了一个持久化层'],
    });
    assert.equal((await platform.getMissionView('M1')).status, 'planning');

    // **换一个 orchestrator 重跑** —— 模拟 run-mission 重新执行一次。
    const second = await makeOrchestrator().runMission('M1', { projectRoot: process.cwd() });
    assert.deepEqual(second, { kind: 'awaiting_l3_review' });

    // 协调者拿到的是"你被打回了，理由是……"，不是一句泛泛的开始。
    const woken = coordinator.instructions.at(-1) ?? '';
    assert.match(woken, /打回/);
    assert.match(woken, /架构边界/);
    assert.doesNotMatch(woken, /^开始这个 Mission/);

    const view = await platform.getMissionView('M1');
    assert.equal(view.planRevision, 2, '协调者重新规划过');
    assert.equal(view.result?.summary, '按 L3 意见改过了');
  });
});

describe('升级：L3 答复之后能接着往下走', () => {
  test('升级即停 → 答复 → 重跑时协调者看到答复并继续', async () => {
    const coordinator = new ScriptedRuntime({
      'coordinator:-:0': {
        steps: [
          { tool: 'coagent_get_mission', body: {} },
          {
            tool: 'coagent_escalate_to_l3',
            body: {
              question: 'Contract 说不许加依赖，但这个需求没有依赖做不了',
              why: '动到了 Contract 的 constraints',
              optionsConsidered: ['自己实现一份', '放宽约束'],
            },
          },
        ],
      },
      'coordinator:-:1': {
        steps: [
          { tool: 'coagent_get_mission', body: {} },
          { tool: 'coagent_update_plan', body: { ...PLAN, direction: '按 L3 的答复：自己实现一份' } },
          { tool: 'coagent_submit_mission_result', body: DELIVER },
        ],
      },
    });

    const { platform, deliveries, makeOrchestrator } = await harness(
      coordinator,
      new ScriptedRuntime({}),
    );
    await platform.createMission({
      projectId: 'P',
      missionId: 'M1',
      contract: CONTRACT,
      origin: { clientType: 'cli', conversationRef: 'l3' },
    });

    const first = await makeOrchestrator().runMission('M1', {
      projectRoot: process.cwd(),
      maxRounds: 5,
    });
    assert.equal(first.kind, 'awaiting_l3');
    assert.equal((await deliveries.pending('l3'))[0].outcome, 'escalated');

    // 没答复之前再跑一次也还是停着——不会自问自答。
    const idle = await makeOrchestrator().runMission('M1', {
      projectRoot: process.cwd(),
      maxRounds: 5,
    });
    assert.equal(idle.kind, 'awaiting_l3');

    // L3 答复。
    await platform.answerEscalation('M1', '自己实现一份，不加依赖。工期可以放宽。');
    assert.equal((await platform.getMissionView('M1')).openEscalations.length, 0);

    const second = await makeOrchestrator().runMission('M1', { projectRoot: process.cwd() });
    assert.deepEqual(second, { kind: 'awaiting_l3_review' });

    const woken = coordinator.instructions.at(-1) ?? '';
    assert.match(woken, /L3 答复了你的升级/);
    assert.match(woken, /自己实现一份/);
    assert.equal((await platform.getMissionView('M1')).planRevision, 1);
  });

  test('没有待答复的升级时 answerEscalation 会被拒绝', async () => {
    const { platform } = await harness(new ScriptedRuntime({}), new ScriptedRuntime({}));
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await assert.rejects(
      () => platform.answerEscalation('M1', '随便答一句'),
      (e: unknown) => (e as { code: string }).code === 'NO_OPEN_ESCALATION',
    );
  });
});

describe('契约中途变更', () => {
  test('在等检视时改契约 → 退回规划，旧的交卷不作数', async () => {
    const { platform } = await harness(new ScriptedRuntime({}), new ScriptedRuntime({}));
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('M1');
    await platform.submitMissionResult('M1', coord.attemptId, DELIVER);
    assert.equal((await platform.getMissionView('M1')).status, 'awaiting_review');

    const revised = await platform.reviseContract('M1', {
      ...CONTRACT,
      intent: '需求变了：还要支持空输入',
    });
    assert.equal(revised.contractRevision, 2);

    const view = await platform.getMissionView('M1');
    assert.equal(view.status, 'planning', '照着旧契约做的那份交卷不能再按它放行');
    assert.match(view.finalReview?.reasons[0] ?? '', /Contract 已更新到 r2/);
  });
});

describe('落地之后回收工作区', () => {
  test('merge 之后 worktree 目录被摘掉，但分支留着', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'coagent-repo-'));
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(repo, worktrees);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'test');
    git(repo, 'config', 'user.email', 'test@local');
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');

    const workspace = new GitWorktreeManager(worktrees);
    const coordinator = new ScriptedRuntime({
      'coordinator:-:0': {
        steps: [
          { tool: 'coagent_update_plan', body: PLAN },
          { tool: 'coagent_create_work_item', body: { title: 'W', ...ORDER } },
          { tool: 'coagent_dispatch_work_item', body: { workItemIds: ['W-1'] } },
        ],
      },
      'coordinator:-:1': {
        steps: [
          { tool: 'coagent_get_mission', body: {} },
          {
            tool: 'coagent_review_execution_result',
            body: { workItemId: 'W-1', verdict: 'accept', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })), reasons: ['ok'], requiredChanges: [] },
          },
          { tool: 'coagent_submit_mission_result', body: DELIVER },
        ],
      },
    });
    const executor = new ScriptedRuntime({
      'executor:W-1': {
        steps: [
          { tool: 'coagent_get_work_order', body: {} },
          { tool: 'coagent_submit_evidence', body: EVIDENCE },
          { tool: 'coagent_submit_execution_result', body: RESULT },
        ],
      },
    });

    const { platform, makeOrchestrator } = await harness(coordinator, executor, workspace);
    await platform.createMission({ projectId: 'P', missionId: 'M-wt', contract: CONTRACT });
    await makeOrchestrator().runMission('M-wt', { projectRoot: repo });

    assert.match(git(repo, 'worktree', 'list'), /M-wt/, '落地前 worktree 还在');

    await platform.finalizeMission('M-wt', { verdict: 'merge', reasons: ['ok'], projectRoot: repo });

    assert.doesNotMatch(git(repo, 'worktree', 'list'), /M-wt/, '落地后 worktree 该被摘掉');
    // 分支留着：改动是 Mission 的产出，要查得到。
    assert.match(git(repo, 'branch', '--list', 'mission/M-wt'), /mission\/M-wt/);
  });
});
