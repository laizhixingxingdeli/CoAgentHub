/**
 * 失败上限与候选冷却（S07.4 / S07.5 / S14.4）。
 *
 * 要防的是一种很具体的浪费：候选池里五个 agent，一张前提就错的工单会把
 * 五个全烧一遍才停 —— **每一次都产生不了新信息**。上限和冷却都是为了
 * 让"没戏了"这件事早一点、而且明确地发生。
 */

import { after, describe, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
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
import type { WorkspaceManager } from '../src/application/workspace.ts';
import { makeIssuer } from '../src/main.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ExecutionProfile } from '../src/application/ports.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

const CONTRACT = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const ORDER = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
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

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

async function harness(
  executor: ScriptedRuntime,
  executorPool: { candidates: ExecutionProfile[]; maxAttempts?: number; cooldownMs?: number },
  workspace: WorkspaceManager = new InPlaceWorkspaceManager(),
) {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const workspaceManager = workspace;
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    workspace: workspaceManager,
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
  });
  const tokens = new RunTokenRegistry();
  const server = createApi({ platform, tokens, deliveries });
  await listenLoopback(server, 0);
  servers.push(server);

  const orchestrator = new Orchestrator({
    platform,
    tokens: makeIssuer(platform, tokens),
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    workspace: workspaceManager,
    coordinator: {
      runtime: new ScriptedRuntime(PLAN_AND_DISPATCH),
      candidates: [{ endpoint: 'l', profileId: 'coord' }],
    },
    executor: { runtime: executor, ...executorPool },
  });
  return { platform, orchestrator };
}

/** 五个候选，全都上游失败。 */
function allFailing(): ScriptedRuntime {
  return new ScriptedRuntime({
    'executor:W-1': { steps: [], upstreamFailure: '429 限流' },
  });
}

const FIVE: ExecutionProfile[] = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
  endpoint: 'l',
  profileId: `exec-${id}`,
}));

test('真实 Orchestrator 成功交回 A 后按冻结授权创建 Git 检查点', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'failover-orchestrator-checkpoint-'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const worktreeRoot = join(tempRoot, '.coagent-worktrees');
  try {
    git(tempRoot, 'init', '-q');
    git(tempRoot, 'config', 'user.name', 'test');
    git(tempRoot, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(tempRoot, 'seed.txt'), 'base');
    git(tempRoot, 'add', 'seed.txt');
    git(tempRoot, 'commit', '-qm', 'initial');

    const executor = new ScriptedRuntime({
      'executor:W-1': {
        steps: [
          { tool: 'coagent_get_work_order', body: {} },
          { tool: 'coagent_submit_evidence', body: { kind: 'test', summary: 'A changed src/foo.ts', command: 'test fixture', exitCode: 0 } },
          {
            tool: 'coagent_submit_execution_result',
            body: (previous) => ({
              outcome: 'completed', summary: 'A changed foo', changedFiles: ['src/foo.ts'],
              evidenceIds: [previous.evidenceId], notes: '无',
            }),
          },
        ],
      },
    });
    const runtime = {
      kind: executor.kind,
      supportsQuery: executor.supportsQuery,
      start: async (spec: Parameters<typeof executor.start>[0]) => {
        if (spec.role === 'executor') {
          mkdirSync(join(spec.cwd, 'src'), { recursive: true });
          writeFileSync(join(spec.cwd, 'src/foo.ts'), 'export const foo = 1;\\n');
        }
        return executor.start(spec);
      },
    };
    const { platform, orchestrator } = await harness(runtime, {
      candidates: [{ endpoint: 'l', profileId: 'exec-a' }],
    }, new GitWorktreeManager());
    const missionId = 'M-checkpoint-A';
    await platform.createMission({ projectId: 'P', missionId, contract: CONTRACT });
    const result = await orchestrator.runMission(missionId, { projectRoot: tempRoot, maxRounds: 2 });

    const missionWorktree = join(worktreeRoot, missionId);
    const executorHop = orchestrator.hops.find((hop) => hop.role === 'executor');
    assert.ok(
      executorHop?.endedBy === 'structured_submit',
      `expected executor:structured_submit; hops=${JSON.stringify(orchestrator.hops)}, result=${JSON.stringify(result)}`,
    );
    assert.equal(git(missionWorktree, 'log', '-1', '--format=%s'), `mission(${missionId}): W-1 检查点`);
    assert.equal(git(missionWorktree, 'show', 'HEAD:src/foo.ts'), 'export const foo = 1;\\n');
    assert.equal(git(tempRoot, 'log', '-1', '--format=%s'), 'initial');
    assert.deepEqual(ORDER.allowedScope, ['src/foo.ts']);
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('检查点 A 在回滚 B 半成品后仍保留', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'failover-checkpoint-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: tempRoot, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(tempRoot, 'a.txt'), 'base');
    git('add', 'a.txt');
    git('commit', '-qm', 'initial');
    writeFileSync(join(tempRoot, 'a.txt'), 'A');

    await new GitWorktreeManager().checkpoint(tempRoot, 'M', 'W-A', ['a.txt']);
    assert.equal(git('log', '-1', '--format=%s'), 'mission(M): W-A 检查点');
    assert.equal(readFileSync(join(tempRoot, 'a.txt'), 'utf8'), 'A');
    const checkpointHead = git('rev-parse', 'HEAD');

    writeFileSync(join(tempRoot, 'b.txt'), 'B');
    await new GitWorktreeManager().rollback(tempRoot, checkpointHead);
    assert.equal(git('rev-parse', 'HEAD'), checkpointHead);
    assert.equal(readFileSync(join(tempRoot, 'a.txt'), 'utf8'), 'A');
    assert.equal(existsSync(join(tempRoot, 'b.txt')), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('尝试上限', () => {
  test('到上限就停，不会把整个候选池烧完', async () => {
    const { platform, orchestrator } = await harness(allFailing(), {
      candidates: FIVE,
      maxAttempts: 2,
    });
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });

    const result = await orchestrator.runMission('M1', {
      projectRoot: process.cwd(),
      maxRounds: 4,
    });

    const executorHops = orchestrator.hops.filter((h) => h.role === 'executor');
    assert.equal(executorHops.length, 2, `上限是 2，实际烧了 ${executorHops.length} 个候选`);
    assert.equal(result.kind, 'waiting');
    assert.equal((result as { reason: string }).reason, 'attempt_limit_reached');
    // 报错要说明「继续换没用」，不然人会手动再点一遍。
    assert.match((result as { detail: string }).detail, /烧配额|不会产生新信息/);
  });

  test('缺省上限是 3', async () => {
    const { platform, orchestrator } = await harness(allFailing(), { candidates: FIVE });
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await orchestrator.runMission('M1', { projectRoot: process.cwd(), maxRounds: 4 });
    assert.equal(orchestrator.hops.filter((h) => h.role === 'executor').length, 3);
  });
});

describe('候选冷却', () => {
  test('上游失败过的候选进入冷却，可用性看得见', async () => {
    const { platform, orchestrator } = await harness(allFailing(), {
      candidates: FIVE,
      maxAttempts: 2,
      cooldownMs: 60_000,
    });
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await orchestrator.runMission('M1', { projectRoot: process.cwd(), maxRounds: 4 });

    const availability = orchestrator.candidateAvailability();
    const cooling = availability.filter((c) => c.availability === 'cooldown');
    assert.equal(cooling.length, 2, '烧过的那两个该在冷却');
    assert.ok(cooling.every((c) => c.until), '冷却要带到期时间，不然不知道什么时候能重试');
    // 没碰过的还是可用的。
    assert.ok(availability.some((c) => c.profileId === 'exec-e' && c.availability === 'available'));
  });

  test('候选全在冷却 = no_available_agent，而且是「在等」不是「失败」', async () => {
    const { platform, orchestrator } = await harness(allFailing(), {
      candidates: [FIVE[0]],
      maxAttempts: 5,
      cooldownMs: 60_000,
    });
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });

    const result = await orchestrator.runMission('M1', {
      projectRoot: process.cwd(),
      maxRounds: 4,
    });
    assert.equal(result.kind, 'waiting');
    assert.equal((result as { reason: string }).reason, 'no_available_agent');
    assert.match((result as { detail: string }).detail, /冷却/);

    // 停机原因落到 Mission 上，界面才看得见「为什么不动」。
    const view = await platform.getMissionView('M1');
    assert.equal(view.waitReason, 'no_available_agent');
    // **枚举不够**：它只说明"停了"，说不出停在谁身上。那句具体的话是调度器
    // 算出来的，不跟着状态一起存，常驻界面（另一个进程）就永远拿不到——
    // 人又得回去翻日志，而分两条轴就是为了免掉这一步。
    assert.match(view.waitDetail ?? '', /冷却/);
    assert.match(view.waitDetail ?? '', /exec-a/, '卡在哪个候选上要点名');
  });

  test('重新跑起来时清掉上次的停机原因', async () => {
    const { platform, orchestrator } = await harness(allFailing(), {
      candidates: [FIVE[0]],
      maxAttempts: 1,
      cooldownMs: 1,
    });
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await orchestrator.runMission('M1', { projectRoot: process.cwd(), maxRounds: 3 });
    assert.ok((await platform.getMissionView('M1')).waitReason);

    await new Promise((done) => setTimeout(done, 20)); // 让冷却过期
    await orchestrator.runMission('M1', { projectRoot: process.cwd(), maxRounds: 1 });
    // 跑起来那一刻就该清掉，否则界面上一直挂着旧原因。
    const events = await platform.getActivity('M1');
    assert.ok(
      events.some((e) => e.kind === 'mission.resumed'),
      '又动起来了要有一条 resumed，界面据此把旧原因抹掉',
    );
  });
});

describe('平台不可达 ≠ 上游失败', () => {
  // 这条是实测出来的：整个套件循环跑 8 遍，第 7 遍偶发地红了一次——
  // 端口抢占导致一次 `fetch failed`，被当成"上游限流"，于是好端端的候选
  // 被冻进冷却，Mission 停在 no_available_agent。换一个候选照样连不上，
  // 冷却在这里只有副作用没有作用。
  const unreachable = () =>
    new ScriptedRuntime({
      'executor:W-1': { steps: [], connectionError: 'fetch failed' },
    });

  test('连不上平台不冷却候选 —— 换一个也连不上，冻它是纯误伤', async () => {
    const { platform, orchestrator } = await harness(unreachable(), {
      candidates: FIVE,
      maxAttempts: 2,
      cooldownMs: 60_000,
    });
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await orchestrator.runMission('M1', { projectRoot: process.cwd(), maxRounds: 4 });

    const cooling = orchestrator
      .candidateAvailability()
      .filter((c) => c.availability === 'cooldown');
    assert.deepEqual(cooling, [], '平台侧故障不该记在候选头上');
  });

  test('只烧一个候选就停 —— 不逐个重试同一个平台', async () => {
    const { platform, orchestrator } = await harness(unreachable(), {
      candidates: FIVE,
      maxAttempts: 5,
    });
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const result = await orchestrator.runMission('M1', {
      projectRoot: process.cwd(),
      maxRounds: 4,
    });

    assert.equal(orchestrator.hops.filter((h) => h.role === 'executor').length, 1);
    assert.equal(result.kind, 'waiting');
    assert.equal((result as { reason: string }).reason, 'platform_unreachable');
    // 报错要把人指向平台，不是指向候选池。指错方向就会去手动加候选。
    assert.match((result as { detail: string }).detail, /平台/);
  });

  test('对照组：真正的上游失败照旧冷却', async () => {
    const { platform, orchestrator } = await harness(allFailing(), {
      candidates: FIVE,
      maxAttempts: 2,
      cooldownMs: 60_000,
    });
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await orchestrator.runMission('M1', { projectRoot: process.cwd(), maxRounds: 4 });
    assert.equal(
      orchestrator.candidateAvailability().filter((c) => c.availability === 'cooldown').length,
      2,
      '这一半不能因为上面那条改动而失效',
    );
  });
});
