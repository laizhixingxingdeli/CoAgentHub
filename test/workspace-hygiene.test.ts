/**
 * 工作区卫生（P0：验证与检查点闭环）——真 git worktree 上的端到端。
 *
 * 案例（MiRing-V0-probe）：验证命令在 Mission 工作区里改文件（构建改写文档、安装脚本追加记录），
 * 发生在执行者的检查点之后，没人收口；下一张工单交卷时被检查点以「越界」拒掉。
 * 这里守三件事：授权范围内的验证副作用被收口提交；范围外的改动原样保留并在下一张工单
 * 开跑前被拦下（不启动执行者、说清来源）；范围内的残留被并入并留记录。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { Orchestrator } from '../src/application/orchestrator.ts';
import { PLATFORM_BLOCKED_EVENT_KIND, Platform } from '../src/application/platform.ts';
import { makeIssuer } from '../src/main.ts';
import { GitWorktreeManager } from '../src/application/workspace.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';
import type { AgentRunSpec, AgentRuntime } from '../src/application/ports.ts';
import { ValidationEngine } from '../src/application/validation/engine.ts';
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
import { WorkspaceChangedPathReader } from '../src/application/validation/workspace-changed-path-reader.ts';
import type { CommandRunner } from '../src/application/validation/ports.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: ['不得改 Contract'],
};

const PLAN = {
  findings: 'foo 一直返回 0',
  rootCause: '初始值写错了',
  rejectedHypotheses: [],
  decisions: ['直接改初始值'],
  direction: '改 src/foo.ts',
  risks: [],
};

function order(allowedScope: string[], withValidation = false): WorkOrder {
  return {
    objective: '改一下',
    allowedScope,
    requiredBehaviour: '照做',
    constraints: [],
    acceptance: ['做完'],
    verification: ['node --test'],
    doNot: [],
    contextRefs: [],
    ...(withValidation ? { validation: { commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }] } } : {}),
  };
}

const pass = (criterion: string) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' });

/** 执行者脚本：读工单、交证据、交结果。写文件由外面的 withEffects 做（脚本只会调平台工具）。 */
function executorScript(changedFiles: string[]): ScriptTable[string] {
  return {
    steps: [
      { tool: 'coagent_get_work_order', body: {} },
      { tool: 'coagent_submit_evidence', body: { kind: 'test', summary: '全绿', command: 'node --test', exitCode: 0 } },
      {
        tool: 'coagent_submit_execution_result',
        body: (previous) => ({
          outcome: 'completed',
          summary: '做完了',
          changedFiles,
          evidenceIds: [previous.evidenceId],
          notes: '无',
        }),
      },
    ],
  };
}

function withEffects(inner: ScriptedRuntime, effects: (spec: AgentRunSpec) => void): AgentRuntime {
  return {
    kind: inner.kind,
    start: async (spec) => {
      effects(spec);
      return inner.start(spec);
    },
  };
}

const dirs: string[] = [];
const servers: Server[] = [];

after(() => {
  for (const server of servers) server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'workspace-hygiene-'));
  dirs.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'src', 'foo.ts'), 'export const foo = 0;\n');
  writeFileSync(join(root, 'src', 'bar.ts'), 'export const bar = 0;\n');
  writeFileSync(join(root, 'docs', 'log.md'), '# log\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

async function harness(opts: {
  coordinatorScripts: ScriptTable;
  executorScripts: ScriptTable;
  effects?: (spec: AgentRunSpec) => void;
  runner?: CommandRunner;
}) {
  const clock = new FixedClock('2026-06-01T12:00:00.000Z');
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const workspace = new GitWorktreeManager();
  const engine = new ValidationEngine({
    clock,
    ids: new SequentialIds(),
    commandRunner: opts.runner ?? { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 1, output: '' }) },
    changedPathReader: new WorkspaceChangedPathReader(workspace),
  });
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    workspace,
    activity,
    clock,
    ids,
    validation: { engine, reports: new InMemoryValidationReportRepository() },
  });
  const tokens = new RunTokenRegistry();
  const server: Server = createApi({ platform, tokens, deliveries });
  await listenLoopback(server, 0);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);
  const coordinatorRuntime = new ScriptedRuntime(opts.coordinatorScripts);
  const executorInner = new ScriptedRuntime(opts.executorScripts);
  return {
    platform,
    activity,
    workspace,
    coordinatorRuntime,
    executorRuntime: executorInner,
    orchestrator: new Orchestrator({
      platform,
      tokens: makeIssuer(platform, tokens),
      baseUrl,
      workspace,
      coordinator: {
        runtime: coordinatorRuntime,
        candidates: [{ endpoint: 'local', profileId: 'coordinator-a' }],
      },
      executor: {
        runtime: opts.effects ? withEffects(executorInner, opts.effects) : executorInner,
        candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
      },
    }),
  };
}

async function eventsOf(h: Awaited<ReturnType<typeof harness>>, missionId: string, kind: string) {
  return (await h.activity.list(missionId)).filter((event) => event.kind === kind);
}

describe('验证后收口：授权范围内的副作用提交，下一张工单不被污染', () => {
  test('验证追加授权文件 → 平台收口提交；W-2 的检查点不再撞上残留', async () => {
    const repo = gitRepo();
    // 验证命令（安装脚本 / 构建）往授权的 docs/log.md 追加一行，就像 W-620 的安装验证。
    const runner: CommandRunner = {
      run: async ({ cwd }) => {
        appendFileSync(join(cwd, 'docs', 'log.md'), 'installed on device\n');
        return { exitCode: 0, timedOut: false, durationMs: 1, output: 'ok' };
      },
    };
    const h = await harness({
      runner,
      coordinatorScripts: {
        'coordinator:-:0': {
          steps: [
            { tool: 'coagent_get_mission', body: {} },
            { tool: 'coagent_update_plan', body: PLAN },
            { tool: 'coagent_create_work_item', body: { title: '装', ...order(['src/foo.ts', 'docs/log.md'], true) } },
            { tool: 'coagent_submit_contract_check', body: { verdict: 'ok', summary: '已核对' } },
            { tool: 'coagent_dispatch_work_item', body: (previous) => ({ workItemIds: [previous.workItemId] }) },
          ],
        },
        'coordinator:-:1': {
          steps: [
            { tool: 'coagent_get_mission', body: {} },
            {
              tool: 'coagent_review_execution_result',
              body: { workItemId: 'W-1', verdict: 'accept', reasons: ['验证通过'], requiredChanges: [], acceptanceResults: [pass('做完')] },
            },
            { tool: 'coagent_create_work_item', body: { title: '改 bar', ...order(['src/bar.ts']) } },
            { tool: 'coagent_dispatch_work_item', body: (previous) => ({ workItemIds: [previous.workItemId] }) },
          ],
        },
        'coordinator:-:2': { steps: [{ tool: 'coagent_get_mission', body: {} }] },
      },
      executorScripts: {
        'executor:W-1': executorScript(['src/foo.ts', 'docs/log.md']),
        'executor:W-2': executorScript(['src/bar.ts']),
      },
      effects: (spec) => {
        if (spec.workItemId === 'W-1') writeFileSync(join(spec.cwd, 'src', 'foo.ts'), 'export const foo = 1;\n');
        if (spec.workItemId === 'W-2') writeFileSync(join(spec.cwd, 'src', 'bar.ts'), 'export const bar = 1;\n');
      },
    });
    await h.platform.createMission({ projectId: 'P', missionId: 'M-settle', contract: CONTRACT });
    await h.orchestrator.runMission('M-settle', { projectRoot: repo, maxRounds: 5 });

    const view = await h.platform.getMissionView('M-settle');
    const status = Object.fromEntries(view.workItems.map((item) => [item.id, item.status]));
    assert.equal(status['W-1'], 'accepted');
    assert.equal(status['W-2'], 'submitted', 'W-2 没有被 W-1 验证留下的残留拦在检查点');
    assert.equal(view.waitReason, undefined);

    const worktree = h.workspace.worktreePath('M-settle', repo);
    assert.equal(git(worktree, 'status', '--porcelain'), '', '收口之后工作区干净');
    const settled = await eventsOf(h, 'M-settle', 'workspace.validation_settled');
    assert.equal(settled.length, 1);
    assert.deepEqual((settled[0]!.data as { committed: string[] }).committed, ['docs/log.md']);
    assert.match(git(worktree, 'log', '--format=%s'), /W-1 验证副作用检查点/);
    assert.match(git(worktree, 'log', '-p', '--', 'docs/log.md'), /installed on device/);
  });
});

describe('验证留下范围外的改动：保留、记来源、不提交，验证报告判失败（不静默放行）', () => {
  test('验证命令在授权范围外生成文件：文件原样留着，没有被提交或删除；报告点名它；事件记下是谁的验证留下的', async () => {
    const repo = gitRepo();
    const runner: CommandRunner = {
      run: async ({ cwd }) => {
        mkdirSync(join(cwd, 'scratch'), { recursive: true });
        writeFileSync(join(cwd, 'scratch', 'cache.tmp'), 'build leftovers\n');
        return { exitCode: 0, timedOut: false, durationMs: 1, output: 'ok' };
      },
    };
    const h = await harness({
      runner,
      coordinatorScripts: {
        'coordinator:-:0': {
          steps: [
            { tool: 'coagent_get_mission', body: {} },
            { tool: 'coagent_update_plan', body: PLAN },
            { tool: 'coagent_create_work_item', body: { title: '改 foo', ...order(['src/foo.ts'], true) } },
            { tool: 'coagent_submit_contract_check', body: { verdict: 'ok', summary: '已核对' } },
            { tool: 'coagent_dispatch_work_item', body: (previous) => ({ workItemIds: [previous.workItemId] }) },
          ],
        },
      },
      executorScripts: { 'executor:W-1': executorScript(['src/foo.ts']) },
      effects: (spec) => writeFileSync(join(spec.cwd, 'src', 'foo.ts'), 'export const foo = 1;\n'),
    });
    await h.platform.createMission({ projectId: 'P', missionId: 'M-stray', contract: CONTRACT });
    await h.orchestrator.runMission('M-stray', { projectRoot: repo, maxRounds: 2 });

    const worktree = h.workspace.worktreePath('M-stray', repo);
    assert.equal(readFileSync(join(worktree, 'scratch', 'cache.tmp'), 'utf8'), 'build leftovers\n', '范围外的改动原样保留');
    assert.match(git(worktree, 'status', '--porcelain'), /scratch\//, '没有被提交，也没有被删');
    assert.doesNotMatch(git(worktree, 'log', '--format=%s'), /验证副作用/, '范围外的不自动提交');

    const [settled] = await eventsOf(h, 'M-stray', 'workspace.validation_settled');
    const data = settled!.data as { committed: string[]; left: string[]; reportId?: string };
    assert.deepEqual(data.committed, []);
    assert.deepEqual(data.left, ['scratch/cache.tmp']);
    assert.equal(settled!.workItemId, 'W-1', '记在这张工单名下：之后能查到残留是谁的验证留下的');

    const view = await h.platform.getMissionView('M-stray');
    const report = view.workItems.find((item) => item.id === 'W-1')?.validationReport;
    assert.equal(report?.passed, false, '越界不会被放行');
    assert.deepEqual(report?.changedPaths?.violations, ['scratch/cache.tmp']);
    assert.equal(data.reportId, report?.reportId);
  });
});

describe('开跑前核对工作区：别的工单留下的改动不让新工单背着跑', () => {
  async function dirtyMission(missionId: string, w1Scope: string[]) {
    const repo = gitRepo();
    const h = await harness({
      coordinatorScripts: { 'coordinator:-:0': { steps: [{ tool: 'coagent_get_mission', body: {} }] } },
      executorScripts: { 'executor:W-2': executorScript(w1Scope) },
    });
    await h.platform.createMission({ projectId: 'P', missionId, contract: CONTRACT });
    const { attemptId: coord } = await h.platform.startCoordinatorAttempt(missionId);
    await h.platform.updatePlan(missionId, coord, PLAN);
    // W-1 是留下残留的那张旧单（只需要存在，好让来源事件挂得上）；W-2 才是要被派发的新单。
    const old = await h.platform.createWorkItem(missionId, coord, { title: '旧单', order: order(['docs/log.md']) });
    const next = await h.platform.createWorkItem(missionId, coord, { title: '新单', order: order(w1Scope) });
    await h.platform.submitContractCheck(missionId, coord, { verdict: 'ok', summary: '已核对' });
    await h.platform.dispatchWorkItems(missionId, coord, [next.workItemId]);
    await h.platform.finishAttempt(missionId, coord, { endedBy: 'structured_submit' });
    // 工作区里已经有一份 W-1 验证留下的改动，而且平台记过来源。
    const prepared = await h.workspace.prepare(missionId, repo);
    appendFileSync(join(prepared.cwd, 'docs', 'log.md'), 'left by validation of the old item\n');
    await h.platform.recordValidationSettlement({
      missionId,
      workItemId: old.workItemId,
      committed: [],
      left: ['docs/log.md'],
    });
    return { h, repo, cwd: prepared.cwd, oldId: old.workItemId, nextId: next.workItemId };
  }

  test('不属于 W-2 范围的残留：不启动执行者，W-2 收成 blocked，改动原样保留且说清来源', async () => {
    const { h, repo, cwd, oldId, nextId } = await dirtyMission('M-dirty', ['src/bar.ts']);
    await h.orchestrator.runMission('M-dirty', { projectRoot: repo, maxRounds: 2 });

    assert.equal(h.executorRuntime.specs.length, 0, '拦在花钱之前');
    const view = await h.platform.getMissionView('M-dirty');
    assert.equal(view.workItems.find((item) => item.id === nextId)?.status, 'blocked');
    const [blocked] = await eventsOf(h, 'M-dirty', PLATFORM_BLOCKED_EVENT_KIND);
    const data = blocked!.data as { source: string; paths: string[]; origins: Record<string, { workItemId: string }>; reason: string };
    assert.equal(data.source, 'workspace_dirty');
    assert.deepEqual(data.paths, ['docs/log.md']);
    assert.equal(data.origins['docs/log.md']?.workItemId, oldId);
    assert.match(data.reason, new RegExp(`docs/log\\.md（${oldId} 的验证`));
    assert.equal(
      Object.hasOwn(blocked!.data as object, 'orderRevision'),
      false,
      '卡住的是工作区不是工单正文：残留处理完，原工单不用修订也能再派',
    );
    // 不删、不提交：改动还在，也没有被偷偷带进任何提交。
    assert.match(readFileSync(join(cwd, 'docs', 'log.md'), 'utf8'), /left by validation/);
    assert.match(git(cwd, 'status', '--porcelain'), /docs\/log\.md/);
  });

  test('范围内的残留：并入这张工单，留下来源记录，执行者照常启动', async () => {
    const { h, repo, cwd, oldId } = await dirtyMission('M-adopt', ['docs/log.md']);
    await h.orchestrator.runMission('M-adopt', { projectRoot: repo, maxRounds: 2 });

    assert.equal(h.executorRuntime.specs.length, 1, '恢复单覆盖了残留文件，可以开跑');
    const [adopted] = await eventsOf(h, 'M-adopt', 'workspace.residue_adopted');
    const data = adopted!.data as { paths: string[]; origins: Record<string, { workItemId: string }> };
    assert.deepEqual(data.paths, ['docs/log.md']);
    assert.equal(data.origins['docs/log.md']?.workItemId, oldId);
    // 检查点把它连同这张工单的交付一起提交：工作区干净，残留有了归属。
    assert.equal(git(cwd, 'status', '--porcelain'), '');
    assert.match(git(cwd, 'log', '-1', '--format=%s'), /检查点/);
  });
});
