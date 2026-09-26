/**
 * Mission 内部编排入口的接线：注入既有平台即可跑，不另建平台、不另听端口。
 *
 * CLI（run-mission.ts）仍自己装配、接续、过滤候选、回连和打结果；
 * 本文件守的是抽出来的那一层，不是把 CLI 再测一遍。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { MissionRunner } from '../src/application/mission-runner.ts';
import { Platform } from '../src/application/platform.ts';
import { makeIssuer } from '../src/main.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import type { WorkspaceManager } from '../src/application/workspace.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
import type { LiveOutput } from '../src/application/live.ts';
import type { RunTokenIssuer } from '../src/application/token-issuer.ts';

const CONTRACT = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: ['不得改 Contract'],
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
  findings: 'foo 一直返回 0',
  rootCause: '初始值写错了',
  rejectedHypotheses: ['不是调用方传错'],
  decisions: ['直接改初始值'],
  direction: '改 src/foo.ts',
  risks: [],
};

const COORDINATOR_HAPPY: ScriptTable = {
  'coordinator:-:0': {
    steps: [
      { tool: 'coagent_get_mission', body: {} },
      { tool: 'coagent_update_plan', body: PLAN },
      { tool: 'coagent_create_work_item', body: { title: '修 foo', ...ORDER } },
      {
        tool: 'coagent_dispatch_work_item',
        body: (previous) => ({ workItemIds: [previous.workItemId] }),
      },
    ],
  },
  'coordinator:-:1': {
    steps: [
      { tool: 'coagent_get_mission', body: {} },
      {
        tool: 'coagent_review_execution_result',
        body: {
          workItemId: 'W-1',
          verdict: 'accept',
          acceptanceResults: ORDER.acceptance.map((criterion) => ({
            criterion,
            status: 'pass' as const,
            evidence: '测试替身：逐条核过',
          })),
          reasons: ['自己复跑过 node --test，退出码 0'],
          requiredChanges: [],
        },
      },
      {
        tool: 'coagent_submit_mission_result',
        body: {
          outcome: 'delivered',
          summary: '改好了并验证过',
          acceptanceEvidence: ['node --test 退出码 0'],
          memoryDelta: [],
          openRisks: [],
        },
      },
    ],
  },
};

const EXECUTOR_HAPPY: ScriptTable = {
  'executor:W-1': {
    steps: [
      { tool: 'coagent_get_work_order', body: {} },
      {
        tool: 'coagent_submit_evidence',
        body: { kind: 'test', summary: 'node --test 全绿', command: 'node --test', exitCode: 0 },
      },
      {
        tool: 'coagent_submit_execution_result',
        body: (previous) => ({
          outcome: 'completed',
          summary: '改了初始值',
          changedFiles: ['src/foo.ts'],
          evidenceIds: [previous.evidenceId],
          notes: '无',
        }),
      },
    ],
  },
};

const servers: Server[] = [];
const temps: string[] = [];
after(() => {
  for (const server of servers) server.close();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

function src(rel: string): string {
  return readFileSync(join(srcRoot, rel), 'utf8');
}

async function existingPlatform() {
  const clock = new FixedClock();
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const projects = new InMemoryProjectRepository();
  const platform = new Platform({
    projects,
    deliveries,
    workspace: new InPlaceWorkspaceManager(),
    activity,
    clock,
    ids,
  });
  const tokens = new RunTokenRegistry();
  const server: Server = createApi({ platform, tokens, deliveries });
  await listenLoopback(server, 0);
  servers.push(server);
  const addr = server.address() as AddressInfo;
  return {
    platform,
    projects,
    tokens,
    server,
    port: addr.port,
    baseUrl: `http://127.0.0.1:${addr.port}`,
  };
}

describe('内部入口：注入既有依赖即可跑，不另建平台或监听', () => {
  test('源码：入口不创建平台、不 listen、不拿锁', () => {
    const runner = src('application/mission-runner.ts');
    // 守的是 import / 调用，不是注释里提到这些词。
    assert.doesNotMatch(runner, /from ['"]\.\.\/api\//);
    assert.doesNotMatch(runner, /from ['"]\.\/loopback-listen\.ts['"]/);
    assert.doesNotMatch(runner, /from ['"]\.\.\/main\.ts['"]/);
    assert.doesNotMatch(runner, /from ['"]\.\/lock\.ts['"]/);
    assert.doesNotMatch(runner, /buildPersistentPlatform\s*\(/);
    assert.doesNotMatch(runner, /buildPgPlatform\s*\(/);
    assert.doesNotMatch(runner, /buildPlatform\s*\(/);
    assert.doesNotMatch(runner, /startServer\s*\(/);
    assert.doesNotMatch(runner, /acquireLock\s*\(/);
    assert.doesNotMatch(runner, /createApi\s*\(/);
    assert.doesNotMatch(runner, /listenLoopback\s*\(/);
    assert.doesNotMatch(runner, /\.listen\s*\(/);
    assert.doesNotMatch(runner, /createMission\s*\(/);
    assert.doesNotMatch(runner, /createClassifiedMission\s*\(/);
    assert.match(runner, /independentReviewer\?:/);
  });

  test('源码：CLI 仍自行装配、接续、过滤候选、回连并输出', () => {
    const cli = src('run-mission.ts');
    assert.match(cli, /new MissionRunner\(/);
    assert.match(cli, /runner\.run\(/);
    assert.match(cli, /createApi\(/);
    assert.match(cli, /listenLoopback\(/);
    assert.match(cli, /loadPoolOrSeed\(/);
    assert.match(cli, /exclusive:\s*\{\s*what:/);
    assert.match(cli, /platform\.createMission\(/);
    assert.match(cli, /platform\.createClassifiedMission\(/);
    assert.match(cli, /Mission \$\{spec\.missionId\} 已存在/);
    assert.match(cli, /--coordinator/);
    assert.match(cli, /--executor/);
    assert.match(cli, /--independent-reviewer/);
    assert.match(cli, /candidates: coordinatorPool\.map/);
    assert.match(cli, /candidates: executorPool\.map/);
    assert.match(cli, /independentReviewer:/);
    assert.match(cli, /server\.close\(\)/);
    assert.match(cli, /releaseLock\(\)/);
    assert.match(cli, /Mission 结果：/);
    // 默认 CLI 参数行为：用法字符串仍在，不把装配挪进内部入口。
    assert.match(cli, /--cwd/);
    assert.match(cli, /--adapter/);
    assert.match(cli, /--in-place/);
    assert.match(cli, /--accept-stale-base/);
  });

  test('注入既有 Platform / issuer / 回环 baseUrl / workspace / 候选，同一实例上跑完一条', async () => {
    const built = await existingPlatform();
    const listeningBefore = built.server.listening;
    const portBefore = built.port;
    assert.equal(listeningBefore, true);

    await built.platform.createMission({
      projectId: 'P',
      missionId: 'M-inject',
      contract: CONTRACT,
    });

    const runner = new MissionRunner({
      platform: built.platform,
      tokens: makeIssuer(built.platform, built.tokens),
      baseUrl: built.baseUrl,
      workspace: new InPlaceWorkspaceManager(),
      coordinator: {
        runtime: new ScriptedRuntime(COORDINATOR_HAPPY),
        candidates: [{ endpoint: 'local', profileId: 'coordinator-a' }],
      },
      executor: {
        runtime: new ScriptedRuntime(EXECUTOR_HAPPY),
        candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
      },
    });

    const ran = await runner.run('M-inject', { projectRoot: process.cwd() });

    assert.deepEqual(ran.outcome, { kind: 'awaiting_l3_review' });
    // 证据必须落在注入的那份平台上——另建第二份的话这里是空的。
    const view = await built.platform.getMissionView('M-inject');
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.workItems.length, 1);
    assert.equal(view.workItems[0].status, 'accepted');
    assert.deepEqual(
      ran.hops.map((h) => `${h.role}:${h.endedBy}`),
      ['coordinator:structured_submit', 'executor:structured_submit', 'coordinator:structured_submit'],
    );

    // 入口没有另起监听：原来的口还在、端口没换。
    assert.equal(built.server.listening, true);
    const addr = built.server.address() as AddressInfo;
    assert.equal(addr.port, portBefore);
    const health = await fetch(`${built.baseUrl}/api/health`);
    assert.equal(health.status, 200);
  });

  test('makeIssuer 为独立候选发牌；成功与失败都吊销；重启不复用旧 token', async () => {
    const built = await existingPlatform();
    const issuer = makeIssuer(built.platform, built.tokens);
    assert.equal(typeof issuer.startIndependentReviewer, 'function');

    await assert.rejects(() =>
      issuer.startIndependentReviewer!('M-missing', [{ profileId: 'ir-a', endpoint: 'local' }]),
    );
    // 失败路径没有发出可解析的 token：registry 仍是空的。
    assert.equal(built.tokens.resolve('nope'), undefined);

    const issued = built.tokens.issue({
      missionId: 'M-tok',
      attemptId: 'A-fake',
      role: 'independent_reviewer',
    });
    assert.ok(built.tokens.resolve(issued.token));
    issuer.revoke(issued.token);
    assert.equal(built.tokens.resolve(issued.token), undefined, '成功路径吊销');

    const again = built.tokens.issue({
      missionId: 'M-tok',
      attemptId: 'A-fake-2',
      role: 'independent_reviewer',
    });
    assert.notEqual(again.token, issued.token, '重启续跑不会重复使用旧 token');
    issuer.revoke(again.token);
    assert.equal(built.tokens.resolve(again.token), undefined, '失败后同样吊销');
    assert.equal((built.server.address() as AddressInfo).port, built.port);
  });
});

const HA_ORDER = {
  ...ORDER,
  validation: { commands: [{ argv: ['node', '--test'], timeoutMs: 1000 }] },
};

const IR_PASS: ScriptTable = {
  'independent_reviewer:-': {
    steps: [
      { tool: 'coagent_get_mission_review_bundle', body: {} },
      {
        tool: 'coagent_submit_independent_review',
        body: { verdict: 'pass', reasons: ['齐'] },
      },
    ],
  },
};

function stubHaWorkspace(head = 'commit-a'): WorkspaceManager {
  let current = head;
  return {
    async prepare(_missionId, projectRoot) {
      return {
        cwd: projectRoot,
        branch: 'mission/M',
        targetBranch: 'master',
        baseRevision: current,
      };
    },
    async head() {
      return current;
    },
    async targetHead() {
      return current;
    },
    worktreePath(_missionId, projectRoot) {
      return projectRoot;
    },
    async rollback() {},
    async mergeToTarget() {
      return { ok: true, mergedInto: current };
    },
    async diff() {
      return { stat: '', files: [] };
    },
    async release() {},
  };
}

function capturingIssuer(
  platform: Platform,
  tokens: RunTokenRegistry,
): { issuer: RunTokenIssuer; issued: string[] } {
  const inner = makeIssuer(platform, tokens);
  const issued: string[] = [];
  return {
    issued,
    issuer: {
      startCoordinator: (missionId, profile) => inner.startCoordinator(missionId, profile),
      startExecutor: (missionId, workItemId, profile) =>
        inner.startExecutor(missionId, workItemId, profile),
      async startIndependentReviewer(missionId, candidates = []) {
        const started = await inner.startIndependentReviewer!(missionId, candidates);
        issued.push(started.token);
        return started;
      },
      revoke(token) {
        inner.revoke(token);
      },
    },
  };
}

async function seedHaForRunner() {
  const clock = new FixedClock();
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const projects = new InMemoryProjectRepository();
  const workspace = stubHaWorkspace();
  const reports = new InMemoryValidationReportRepository();
  const validation = {
    reports,
    engine: {
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
              summary: 'node --test → 0',
              command: {
                argv: ['node', '--test'],
                cwd: '/tmp',
                exitCode: 0,
                timedOut: false,
                durationMs: 1,
                outputTail: 'ok',
              },
            },
          ],
        };
        return {
          report,
          authority: { kind: 'validator' as const, reportId: id, policyRevision: 1 },
        };
      },
    },
  };
  const platform = new Platform({
    projects,
    deliveries,
    workspace,
    activity,
    clock,
    ids,
    validation,
  });
  const tokens = new RunTokenRegistry();
  const server: Server = createApi({ platform, tokens, deliveries });
  await listenLoopback(server, 0);
  servers.push(server);
  const addr = server.address() as AddressInfo;
  const project = await projects.ensure('P');
  project.createMission({
    id: 'M-ha',
    contract: CONTRACT,
    executionMode: 'high_assurance',
  });
  await projects.save(project);
  const root = mkdtempSync(join(tmpdir(), 'coagent-e3a-runner-'));
  temps.push(root);
  const prepared = await workspace.prepare('M-ha', root);
  await platform.recordWorkspace('M-ha', {
    projectRoot: root,
    branch: prepared.branch,
    baseRevision: prepared.baseRevision,
  });
  const coord = await platform.startCoordinatorAttempt('M-ha', {
    profileId: 'coord-a',
    endpoint: 'local',
  });
  await platform.updatePlan('M-ha', coord.attemptId, PLAN);
  const { workItemId } = await platform.createWorkItem('M-ha', coord.attemptId, {
    title: '改 foo',
    order: HA_ORDER,
  });
  await platform.dispatchWorkItems('M-ha', coord.attemptId, [workItemId]);
  const exec = await platform.startExecutorAttempt('M-ha', workItemId, {
    profileId: 'exec-a',
    endpoint: 'local',
  });
  await platform.submitEvidence('M-ha', exec.attemptId, {
    kind: 'test',
    summary: '绿',
    command: 'node --test',
    exitCode: 0,
  });
  await platform.submitExecutionResult('M-ha', exec.attemptId, {
    outcome: 'completed',
    summary: '改好了',
    changedFiles: ['src/foo.ts'],
    evidenceIds: [],
    notes: '无',
  });
  await platform.finishAttempt('M-ha', exec.attemptId, { endedBy: 'structured_submit' });
  await platform.reviewExecutionResult('M-ha', coord.attemptId, {
    workItemId,
    verdict: 'accept',
    acceptanceResults: HA_ORDER.acceptance.map((criterion) => ({
      criterion,
      status: 'pass' as const,
      evidence: '测试替身：逐条核过',
    })),
    reasons: ['复跑过'],
    requiredChanges: [],
  });
  await platform.submitMissionResult('M-ha', coord.attemptId, {
    outcome: 'delivered',
    summary: '交付',
    acceptanceEvidence: [],
    memoryDelta: [],
    openRisks: [],
  });
  await platform.finishAttempt('M-ha', coord.attemptId, { endedBy: 'structured_submit' });
  return {
    platform,
    tokens,
    workspace,
    root,
    baseUrl: `http://127.0.0.1:${addr.port}`,
  };
}

describe('E3a MissionRunner 独立检视 token 生命周期', () => {
  test('成功路径吊销；新建 registry 后旧 token 不可用', async () => {
    const seeded = await seedHaForRunner();
    const { issuer, issued } = capturingIssuer(seeded.platform, seeded.tokens);
    const runner = new MissionRunner({
      platform: seeded.platform,
      tokens: issuer,
      baseUrl: seeded.baseUrl,
      workspace: seeded.workspace,
      coordinator: {
        runtime: new ScriptedRuntime({}),
        candidates: [{ endpoint: 'local', profileId: 'coord-a' }],
      },
      executor: {
        runtime: new ScriptedRuntime({}),
        candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
      },
      independentReviewer: {
        runtime: new ScriptedRuntime(IR_PASS),
        candidates: [{ endpoint: 'local', profileId: 'ir-a' }],
      },
    });
    const ran = await runner.run('M-ha', { projectRoot: seeded.root });
    assert.equal(ran.outcome.kind, 'awaiting_l3_review');
    assert.equal(issued.length, 1);
    assert.equal(seeded.tokens.resolve(issued[0]!), undefined, '成功后吊销');
    const restarted = new RunTokenRegistry();
    assert.equal(restarted.resolve(issued[0]!), undefined, '重启后旧 token 不可用');
  });

  test('运行时失败也吊销', async () => {
    const seeded = await seedHaForRunner();
    const { issuer, issued } = capturingIssuer(seeded.platform, seeded.tokens);
    const runner = new MissionRunner({
      platform: seeded.platform,
      tokens: issuer,
      baseUrl: seeded.baseUrl,
      workspace: seeded.workspace,
      coordinator: {
        runtime: new ScriptedRuntime({}),
        candidates: [{ endpoint: 'local', profileId: 'coord-a' }],
      },
      executor: {
        runtime: new ScriptedRuntime({}),
        candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
      },
      independentReviewer: {
        runtime: new ScriptedRuntime({
          'independent_reviewer:-': { upstreamFailure: '检视适配器挂了' },
        }),
        candidates: [{ endpoint: 'local', profileId: 'ir-a' }],
      },
    });
    const ran = await runner.run('M-ha', { projectRoot: seeded.root });
    assert.equal(ran.outcome.kind, 'waiting');
    assert.equal(issued.length, 1);
    assert.equal(seeded.tokens.resolve(issued[0]!), undefined, '运行时失败后吊销');
  });

  test('finishAttempt 抛错仍吊销', async () => {
    const seeded = await seedHaForRunner();
    const original = seeded.platform.finishAttempt.bind(seeded.platform);
    seeded.platform.finishAttempt = (async (missionId, attemptId, outcome) => {
      await original(missionId, attemptId, outcome);
      throw new Error('finishAttempt 失败');
    }) as Platform['finishAttempt'];
    const { issuer, issued } = capturingIssuer(seeded.platform, seeded.tokens);
    const runner = new MissionRunner({
      platform: seeded.platform,
      tokens: issuer,
      baseUrl: seeded.baseUrl,
      workspace: seeded.workspace,
      coordinator: {
        runtime: new ScriptedRuntime({}),
        candidates: [{ endpoint: 'local', profileId: 'coord-a' }],
      },
      executor: {
        runtime: new ScriptedRuntime({}),
        candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
      },
      independentReviewer: {
        runtime: new ScriptedRuntime({
          'independent_reviewer:-': { upstreamFailure: '检视适配器挂了' },
        }),
        candidates: [{ endpoint: 'local', profileId: 'ir-a' }],
      },
    });
    const ran = await runner.run('M-ha', { projectRoot: seeded.root });
    assert.equal(ran.outcome.kind, 'waiting');
    assert.equal(issued.length, 1);
    assert.equal(seeded.tokens.resolve(issued[0]!), undefined, '收尾失败后仍吊销');
  });

  test('live.finish 抛错仍吊销', async () => {
    const seeded = await seedHaForRunner();
    const live: LiveOutput = {
      async append() {},
      async since() {
        return [];
      },
      async finish() {
        throw new Error('live.finish 失败');
      },
    };
    const { issuer, issued } = capturingIssuer(seeded.platform, seeded.tokens);
    const runner = new MissionRunner({
      platform: seeded.platform,
      tokens: issuer,
      live,
      baseUrl: seeded.baseUrl,
      workspace: seeded.workspace,
      coordinator: {
        runtime: new ScriptedRuntime({}),
        candidates: [{ endpoint: 'local', profileId: 'coord-a' }],
      },
      executor: {
        runtime: new ScriptedRuntime({}),
        candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
      },
      independentReviewer: {
        runtime: new ScriptedRuntime({
          'independent_reviewer:-': { upstreamFailure: '检视适配器挂了' },
        }),
        candidates: [{ endpoint: 'local', profileId: 'ir-a' }],
      },
    });
    const ran = await runner.run('M-ha', { projectRoot: seeded.root });
    assert.equal(ran.outcome.kind, 'waiting');
    assert.equal(issued.length, 1);
    assert.equal(seeded.tokens.resolve(issued[0]!), undefined, 'live.finish 失败后仍吊销');
  });
});
