/**
 * 取消 / 暂停（S12.2、S14.5）与分叉基线过期（S05.3、S14.7）。
 *
 * 这三条的共同点是：**都要在花钱之前停下来**。
 * 基线过期那条尤其——照旧基线干出来的东西落地时会被拦，而那时候
 * 钱已经花完了。在派发之前发现，代价小得多。
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
import type { WorkspaceManager } from '../src/application/workspace.ts';

const CONTRACT = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
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

const PLAN_AND_DISPATCH = {
  'coordinator:-:0': {
    steps: [
      { tool: 'coagent_update_plan', body: PLAN },
      { tool: 'coagent_create_work_item', body: { title: 'W', ...ORDER } },
      { tool: 'coagent_dispatch_work_item', body: { workItemIds: ['W-1'] } },
    ],
  },
  'coordinator:-': { steps: [{ tool: 'coagent_get_mission', body: {} }] },
};

const EXECUTOR_OK = {
  'executor:W-1': {
    steps: [
      { tool: 'coagent_get_work_order', body: {} },
      {
        // S11.1：completed 必须有证据撑着，平台会拦下没证据的提交。
        tool: 'coagent_submit_evidence',
        body: { kind: 'test', summary: 'node --test 全绿', command: 'node --test', exitCode: 0 },
      },
      {
        tool: 'coagent_submit_execution_result',
        body: {
          outcome: 'completed' as const,
          summary: 's',
          changedFiles: ['a.txt'],
          evidenceIds: [],
          notes: '无',
        },
      },
    ],
  },
};

const servers: Server[] = [];
const dirs: string[] = [];
after(() => {
  for (const server of servers) server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * options.platform 让调用方**复用同一份状态另起一个 Orchestrator**——
 * 这正是 CLI 的真实形态：一次运行一个进程，状态在库里，调度器是新的。
 */
async function harness(
  workspace: WorkspaceManager = new InPlaceWorkspaceManager(),
  options?: { acceptStaleBase?: boolean; platform?: Platform },
) {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform =
    options?.platform ??
    new Platform({
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
  const coordinator = new ScriptedRuntime(PLAN_AND_DISPATCH);
  const executor = new ScriptedRuntime(EXECUTOR_OK);
  const orchestrator = new Orchestrator({
    platform,
    tokens: makeIssuer(platform, tokens),
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    workspace,
    acceptStaleBase: options?.acceptStaleBase,
    coordinator: { runtime: coordinator, candidates: [{ endpoint: 'l', profileId: 'c' }] },
    executor: { runtime: executor, candidates: [{ endpoint: 'l', profileId: 'e' }] },
  });
  return { platform, orchestrator, coordinator, executor };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-stale-'));
  dirs.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@local');
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('暂停 / 恢复', () => {
  test('暂停之后调度器不碰它，而且阶段保持原样', async () => {
    const { platform, orchestrator, coordinator } = await harness();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await orchestrator.runMission('M1', { projectRoot: process.cwd(), maxRounds: 2 });
    const before = await platform.getMissionView('M1');
    const callsBefore = coordinator.instructions.length;

    await platform.pauseMission('M1');
    const result = await orchestrator.runMission('M1', {
      projectRoot: process.cwd(),
      maxRounds: 5,
    });

    assert.equal(result.kind, 'waiting');
    assert.equal(coordinator.instructions.length, callsBefore, '暂停之后不该再叫 agent');
    const paused = await platform.getMissionView('M1');
    assert.equal(paused.paused, true);
    assert.equal(paused.status, before.status, '暂停不该改变阶段——否则恢复时无从下手');
  });

  test('恢复之后能接着跑', async () => {
    const { platform, orchestrator } = await harness();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await platform.pauseMission('M1');
    assert.equal((await orchestrator.runMission('M1', { projectRoot: process.cwd() })).kind, 'waiting');

    await platform.resumeMission('M1');
    const result = await orchestrator.runMission('M1', {
      projectRoot: process.cwd(),
      maxRounds: 4,
    });
    assert.notEqual(result.kind, 'waiting');
    assert.equal((await platform.getMissionView('M1')).planRevision, 1, '恢复之后真的干活了');
  });

  test('终态的 Mission 不能暂停', async () => {
    const { platform } = await harness();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await platform.cancelMission('M1');
    await assert.rejects(() => platform.pauseMission('M1'), /pause/);
  });
});

describe('取消', () => {
  test('取消是终态，释放改动名额，原因看得见', async () => {
    const { platform, orchestrator } = await harness();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await platform.createMission({ projectId: 'P', missionId: 'M2', contract: CONTRACT });
    await orchestrator.runMission('M1', { projectRoot: process.cwd(), maxRounds: 2 });
    assert.equal((await platform.getMissionView('M1')).isMutating, true);

    await platform.cancelMission('M1', '需求取消了');

    const view = await platform.getMissionView('M1');
    assert.equal(view.status, 'blocked');
    assert.equal(view.waitReason, 'cancelled_by_user', '要分得出是「做不下去」还是「不做了」');
    assert.equal(view.isMutating, false, '取消要放名额，否则别的 Mission 永远排不上');

    // 名额放了，M2 现在能派发。
    const { orchestrator: second } = await harness();
    void second;
    const coord = await platform.startCoordinatorAttempt('M2');
    await platform.updatePlan('M2', coord.attemptId, PLAN);
    const { workItemId } = await platform.createWorkItem('M2', coord.attemptId, {
      title: 'W',
      order: ORDER,
    });
    await platform.dispatchWorkItems('M2', coord.attemptId, [workItemId]);
    assert.equal((await platform.getMissionView('M2')).isMutating, true);
  });
});

describe('分叉基线过期（S05.3 / S14.7）', () => {
  test('派发前发现目标分支已经往前走了 —— 停下来，别花钱做合不回去的东西', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);

    const { platform, orchestrator, executor } = await harness(
      new GitWorktreeManager(worktrees),
    );
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });

    // 第一轮：协调者规划 + 派发，工作项变成 dispatched。
    // 用 maxRounds=1 让它在执行者动手之前停下。
    await orchestrator.runMission('M1', { projectRoot: repo, maxRounds: 1 });
    assert.equal((await platform.getMissionView('M1')).workItems[0].status, 'dispatched');
    const executorCallsBefore = executor.instructions.length;

    // 这期间别人往目标分支上提交了东西。
    writeFileSync(join(repo, 'other.txt'), 'someone else\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', '别人的提交');

    const result = await orchestrator.runMission('M1', { projectRoot: repo, maxRounds: 4 });

    assert.equal(result.kind, 'waiting');
    assert.equal((result as { reason: string }).reason, 'base_revision_stale');
    assert.match((result as { detail: string }).detail, /合不回去/);
    assert.equal(
      executor.instructions.length,
      executorCallsBefore,
      '**关键**：发现基线过期就不该再派执行者——那笔钱是白花的',
    );
    assert.equal((await platform.getMissionView('M1')).waitReason, 'base_revision_stale');
  });

  test('基线没变时不打扰', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);

    const { platform, orchestrator } = await harness(new GitWorktreeManager(worktrees));
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const result = await orchestrator.runMission('M1', { projectRoot: repo, maxRounds: 4 });
    assert.notEqual((result as { reason?: string }).reason, 'base_revision_stale');
  });

  test('报过一次之后重跑不再被同一条挡住 —— 人重跑本身就表示「我知道了」', async () => {
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);

    const { platform, orchestrator } = await harness(new GitWorktreeManager(worktrees));
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await orchestrator.runMission('M1', { projectRoot: repo, maxRounds: 1 });

    writeFileSync(join(repo, 'other.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'x');

    const first = await orchestrator.runMission('M1', { projectRoot: repo, maxRounds: 4 });
    assert.equal((first as { reason: string }).reason, 'base_revision_stale');

    // 同一个 orchestrator 再跑：已经提醒过了，不再拦。
    const second = await orchestrator.runMission('M1', { projectRoot: repo, maxRounds: 4 });
    assert.notEqual((second as { reason?: string }).reason, 'base_revision_stale');
  });

  test('换一个进程重跑仍然会被挡 —— 上面那条只在同一个实例里成立', async () => {
    // 这一条补的是上面那条**没覆盖到**的真实形态。上面复用同一个 orchestrator，
    // 于是"报过一次"这件事记在实例字段里；而 CLI 是一次运行一个进程，新进程
    // 把它重置回 false。实测 W5 因此每跑一次都被同一句话挡回去，永远走不下去，
    // 而没有任何测试会红——挡回去看起来就像"它确实过期了"。
    const repo = tempRepo();
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);
    const workspace = new GitWorktreeManager(worktrees);

    const { platform, orchestrator } = await harness(workspace);
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await orchestrator.runMission('M1', { projectRoot: repo, maxRounds: 1 });

    writeFileSync(join(repo, 'other.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'x');

    assert.equal(
      ((await orchestrator.runMission('M1', { projectRoot: repo, maxRounds: 4 })) as {
        reason: string;
      }).reason,
      'base_revision_stale',
    );

    // 新 Orchestrator = 新进程。状态还是那份，但"提醒过了"没了。
    const next = await harness(workspace, { platform });
    const blocked = await next.orchestrator.runMission('M1', { projectRoot: repo, maxRounds: 4 });
    assert.equal(
      (blocked as { reason: string }).reason,
      'base_revision_stale',
      '换进程之后还该挡 —— 否则"提醒"就成了一次性的摆设',
    );
    // 停机原因要告诉人下一步怎么办，不能只说"过期了"。
    assert.match((blocked as { detail: string }).detail, /--accept-stale-base/);

    // 人带着 --accept-stale-base 回来：这才是"我知道了，继续"的真实载体。
    const accepted = await harness(workspace, { platform, acceptStaleBase: true });
    const through = await accepted.orchestrator.runMission('M1', {
      projectRoot: repo,
      maxRounds: 4,
    });
    assert.notEqual((through as { reason?: string }).reason, 'base_revision_stale');
  });
});
