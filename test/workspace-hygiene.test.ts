/**
 * 工作区卫生（P0：验证与检查点闭环）——真 git worktree 上的端到端。
 *
 * 案例（MiRing-V0-probe）：验证命令在 Mission 工作区里改文件（构建改写文档、安装脚本追加记录），
 * 发生在执行者的检查点之后，没人收口。这里守四件事：授权范围内的验证副作用被收口提交；
 * 范围外的改动（含杂文件、被 .gitignore 忽略的）**移出工作树存档**——不提交也不删除，
 * 存档在工作树之外可找回，并且不再把下一张工单收成 blocked；机器验证照旧点名越界；
 * 范围内的残留被并入并留记录。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { narrateEvent } from '../src/web/narrate.js';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Orchestrator } from '../src/application/orchestrator.ts';
import { HopGuards } from '../src/application/hop-guards.ts';
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

describe('验证留下范围外的改动：移出工作树存档、记来源、不提交、不删除（不静默放行）', () => {
  test('验证命令在授权范围外生成文件：文件不在工作树、没被提交或删除；报告点名它；事件记下是谁的验证留下的', async () => {
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
        'coordinator:-:1': { steps: [{ tool: 'coagent_get_mission', body: {} }] },
      },
      executorScripts: { 'executor:W-1': executorScript(['src/foo.ts']) },
      effects: (spec) => writeFileSync(join(spec.cwd, 'src', 'foo.ts'), 'export const foo = 1;\n'),
    });
    await h.platform.createMission({ projectId: 'P', missionId: 'M-stray', contract: CONTRACT });
    await h.orchestrator.runMission('M-stray', { projectRoot: repo, maxRounds: 2 });

    const worktree = h.workspace.worktreePath('M-stray', repo);
    // 存档：文件不得留在工作树，也不得被提交；存档内容仍找得回。
    assert.equal(existsSync(join(worktree, 'scratch', 'cache.tmp')), false, '范围外的改动已移出工作树');
    assert.equal(git(worktree, 'status', '--porcelain'), '', '存档后工作区干净');
    assert.doesNotMatch(git(worktree, 'log', '--format=%s'), /验证副作用/, '范围外的不自动提交');
    assert.equal(
      git(worktree, 'ls-files', '--', 'scratch/cache.tmp'),
      '',
      '没有被跟踪或提交',
    );

    // 这条存档是执行者交卷时的检查点做的。
    const [archivedEvent] = await eventsOf(h, 'M-stray', 'workspace.scope_archived');
    const archived = archivedEvent!.data as {
      entries: { path: string; archivePath: string; tracked: boolean; source: string; originWorkItemId?: string }[];
    };
    const entry = archived.entries[0]!;
    assert.equal(entry.path, 'scratch/cache.tmp');
    assert.equal(entry.tracked, false);
    assert.equal(entry.source, 'validation', 'scratch/cache.tmp 是验证命令留下的（同一张工单），归给它的验证');
    assert.equal(entry.originWorkItemId, 'W-1');
    // 存档在工作树之外，内容仍是未跟踪、原样移走的那份。
    assert.equal(entry.archivePath.includes(worktree.replace(/\\/g, '/')), false, '存档不在工作树内');
    assert.equal(readFileSync(entry.archivePath, 'utf8'), 'build leftovers\n', '内容可找回');

    const view = await h.platform.getMissionView('M-stray');
    const report = view.workItems.find((item) => item.id === 'W-1')?.validationReport;
    assert.equal(report?.passed, false, '验证在收口之前跑：越界不会被放行');
    assert.deepEqual(report?.changedPaths?.violations, ['scratch/cache.tmp']);

    // narrate 与协调者简报都要看得见这条存档。
    const narrated = narrateEvent({
      kind: 'workspace.scope_archived',
      workItemId: 'W-1',
      data: archivedEvent!.data,
    });
    assert.equal(narrated.untranslated, false);
    assert.equal(narrated.action, '范围外改动已存档');
    assert.match(narrated.detail, /scratch\/cache\.tmp/);

    const { attemptId } = await h.platform.startCoordinatorAttempt('M-stray');
    const brief = await h.platform.getStartupBrief('M-stray', attemptId);
    const since = brief.contextBundle.entries.find((entry) => entry.source === 'since_last_hop')
      ?.content as readonly { summary: string }[] | undefined;
    const summaries = (since ?? []).map((entry) => entry.summary).join('\n');
    assert.match(summaries, /范围外改动已存档/);
    assert.match(summaries, /scratch\/cache\.tmp/);
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

  test('不属于 W-2 范围的残留：移出工作树存档，W-2 照常开跑，不再收成 blocked', async () => {
    const { h, repo, cwd, oldId, nextId } = await dirtyMission('M-dirty', ['src/bar.ts']);
    await h.orchestrator.runMission('M-dirty', { projectRoot: repo, maxRounds: 2 });

    assert.ok(h.executorRuntime.specs.length >= 1, '不再拦在花钱之前：执行者照常启动');
    const view = await h.platform.getMissionView('M-dirty');
    assert.notEqual(view.workItems.find((item) => item.id === nextId)?.status, 'blocked', '不再把工单收成 blocked');
    // 没有以「工作区不干净」为名的停机事件。
    const blocked = await eventsOf(h, 'M-dirty', PLATFORM_BLOCKED_EVENT_KIND);
    assert.equal(
      blocked.filter((event) => (event.data as { source?: string }).source === 'workspace_dirty').length,
      0,
    );
    // docs/log.md 在 W-2 范围外：已还原（工作区副本不含那句话），但改动找得回。
    assert.doesNotMatch(readFileSync(join(cwd, 'docs', 'log.md'), 'utf8'), /left by validation/);
    const [archivedEvent] = await eventsOf(h, 'M-dirty', 'workspace.scope_archived');
    const entries = (archivedEvent!.data as { entries: { path: string; archivePath: string; tracked: boolean; source: string; originWorkItemId?: string }[] }).entries;
    const entry = entries.find((candidate) => candidate.path === 'docs/log.md')!;
    assert.equal(entry.tracked, true, '已跟踪文件先存补丁再还原');
    assert.equal(entry.source, 'validation', '来源沿用现有归因：这条是 W-1 的验证留下的');
    assert.equal(entry.originWorkItemId, oldId);
    assert.match(readFileSync(entry.archivePath, 'utf8'), /left by validation/, '补丁能找回那句话');
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

describe('检查点：范围内的照常提交，范围内外的杂文件 / 被忽略文件移出存档不报错', () => {
  test('目录范围提交改动；__pycache__ 与范围外文件不抛、不提交、存档可找回；被忽略文件不提交也不报错', async () => {
    const repo = gitRepo();
    const ws = new GitWorktreeManager();
    const prep = await ws.prepare('M-cp', repo);
    const cwd = prep.cwd;

    // 范围内：src/foo.ts 的修改应当被提交。
    writeFileSync(join(cwd, 'src', 'foo.ts'), 'export const foo = 1;\n');
    // 范围内的杂文件：__pycache__/x.pyc 不提交、移出工作树存档。
    mkdirSync(join(cwd, 'src', '__pycache__'), { recursive: true });
    writeFileSync(join(cwd, 'src', '__pycache__', 'x.pyc'), 'PYC\n');
    // 范围外的未跟踪文件。
    mkdirSync(join(cwd, 'scratch'), { recursive: true });
    writeFileSync(join(cwd, 'scratch', 'cache.tmp'), 'junk\n');

    const archived = await ws.checkpoint(cwd, 'M-cp', 'W-1', ['src/']);
    assert.ok(Array.isArray(archived));
    assert.equal(git(cwd, 'status', '--porcelain'), '', '杂文件与范围外都不在工作树');
    assert.match(git(cwd, 'log', '--format=%s'), /检查点/, '范围内的 src/foo.ts 被提交');
    assert.equal(git(cwd, 'ls-files', '--', 'src/foo.ts'), 'src/foo.ts');
    assert.equal(git(cwd, 'ls-files', '--', 'src/__pycache__/x.pyc'), '', '杂文件没被提交');
    assert.equal(existsSync(join(cwd, 'src', '__pycache__', 'x.pyc')), false, '杂文件已移出工作树');
    const byPath = new Map(archived.map((record) => [record.path, record]));
    assert.equal(readFileSync(byPath.get('src/__pycache__/x.pyc')!.archivePath, 'utf8'), 'PYC\n');
    assert.equal(byPath.get('scratch/cache.tmp')!.tracked, false);
    assert.equal(readFileSync(byPath.get('scratch/cache.tmp')!.archivePath, 'utf8'), 'junk\n');
    assert.equal(byPath.get('src/__pycache__/x.pyc')!.archivePath.includes(cwd.replace(/\\/g, '/')), false, '存档在工作树之外');

    // 被 .gitignore 忽略、不在 git status 里的文件：即使 allowedScope 点了名也不提交、不报错、仍在磁盘。
    writeFileSync(join(cwd, '.gitignore'), 'ignored.tmp\n');
    await ws.checkpoint(cwd, 'M-cp', 'W-1', ['.gitignore']);
    writeFileSync(join(cwd, 'ignored.tmp'), 'skip me\n');
    const second = await ws.checkpoint(cwd, 'M-cp', 'W-1', ['ignored.tmp']);
    assert.deepEqual(second, [], '被忽略文件不存档也不报错');
    assert.equal(existsSync(join(cwd, 'ignored.tmp')), true, '被忽略文件仍留在磁盘');
    assert.equal(git(cwd, 'ls-files', '--', 'ignored.tmp'), '', '没有 git add -f 它');
  });
});

describe('开跑前核对自己出错：放行，不让整次运行崩掉', () => {
  const item = { id: 'W-2', attemptIds: [], order: { allowedScope: ['src/bar.ts'] } } as unknown as Parameters<
    HopGuards['preflightWorkspace']
  >[1];
  const workspace = { dirtyPaths: async () => ['docs/log.md'] } as unknown as ConstructorParameters<typeof HopGuards>[1];

  test('读来源事件失败、收尾失败都按放行处理——最终防线是检查点，这一道不许反过来让运行崩掉', async () => {
    const readFails = {
      attributeWorkspacePaths: async () => {
        throw new Error('活动日志读不出来');
      },
    } as unknown as ConstructorParameters<typeof HopGuards>[0];
    assert.equal(await new HopGuards(readFails, workspace).preflightWorkspace('M', item, 'cwd'), 'ok');

    const blockFails = {
      attributeWorkspacePaths: async () => ({}),
      blockWorkItemForWorkspace: async () => {
        throw new Error('写不进去');
      },
    } as unknown as ConstructorParameters<typeof HopGuards>[0];
    assert.equal(await new HopGuards(blockFails, workspace).preflightWorkspace('M', item, 'cwd'), 'ok');
  });
});
