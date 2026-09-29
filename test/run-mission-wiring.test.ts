/**
 * Mission 内部编排入口的接线：注入既有平台即可跑，不另建平台、不另听端口。
 *
 * CLI（run-mission.ts）仍自己装配、接续、过滤候选、回连和打结果；
 * 本文件守的是抽出来的那一层，不是把 CLI 再测一遍。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
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
import { inRunBackoffWaitMs } from '../src/application/orchestrator.ts';
import { missionRunOptions } from '../src/run-mission.ts';
import { buildPersistentPlatform } from '../src/main.ts';
import { Platform, PlatformRuleError, type QueueClaimIdentity } from '../src/application/platform.ts';
import { makeIssuer } from '../src/main.ts';
import { FileQueuedHopRepository } from '../src/application/file-store.ts';
import { LockBusyError } from '../src/application/lock.ts';
import {
  DEFAULT_HOP_CAPACITY_LIMITS,
  type HopCapacityLimits,
  type QueuedHop,
} from '../src/application/durable-scheduler.ts';
import type { QueuedHopRepository } from '../src/application/ports.ts';
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

function countingQueuedHops(rows: QueuedHop[] = []): QueuedHopRepository & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async enqueue(hop) {
      calls.push('enqueue');
      rows.push(hop);
      return hop;
    },
    async get(id) {
      calls.push('get');
      return rows.find((row) => row.id === id);
    },
    async list() {
      calls.push('list');
      return [...rows];
    },
    async claim() {
      calls.push('claim');
      return undefined;
    },
    async renew() {
      calls.push('renew');
      return undefined;
    },
    async complete() {
      calls.push('complete');
      return undefined;
    },
  };
}

function capacityRunnerDeps(
  runtime: ScriptedRuntime,
  queuedHops: QueuedHopRepository,
  hopCapacityLimits?: HopCapacityLimits,
) {
  return {
    platform: {} as Platform,
    tokens: { revoke() {} } as unknown as RunTokenIssuer,
    baseUrl: 'http://127.0.0.1:9',
    workspace: new InPlaceWorkspaceManager(),
    queuedHops,
    coordinator: { runtime, candidates: [] },
    executor: { runtime, candidates: [] },
    ...(hopCapacityLimits ? { hopCapacityLimits } : {}),
  };
}

describe('MissionRunner 五维 hopCapacityLimits 构造校验', () => {
  test('省略时构造成功，缺省值交给编排器',
    () => {
      const runtime = new ScriptedRuntime({});
      const queuedHops = countingQueuedHops();
      assert.doesNotThrow(() => new MissionRunner(capacityRunnerDeps(runtime, queuedHops)));
      assert.doesNotThrow(
        () => new MissionRunner(capacityRunnerDeps(runtime, queuedHops, DEFAULT_HOP_CAPACITY_LIMITS)),
      );
      assert.equal(queuedHops.calls.length, 0);
      assert.equal(runtime.specs.length, 0);
    },
  );

  test('inRunBackoffWaitMs 省略为 0；负数、小数、NaN、Infinity 在构造时抛', () => {
    const runtime = new ScriptedRuntime({});
    const queuedHops = countingQueuedHops();
    assert.equal(inRunBackoffWaitMs(), 0);
    assert.doesNotThrow(() => new MissionRunner(capacityRunnerDeps(runtime, queuedHops)));
    assert.doesNotThrow(
      () => new MissionRunner({ ...capacityRunnerDeps(runtime, queuedHops), inRunBackoffWaitMs: 0 }),
    );
    assert.doesNotThrow(
      () => new MissionRunner({ ...capacityRunnerDeps(runtime, queuedHops), inRunBackoffWaitMs: 120_000 }),
    );
    for (const value of [-1, 1.5, Number.NaN, Infinity]) {
      const hops = countingQueuedHops();
      const agent = new ScriptedRuntime({});
      assert.throws(
        () => new MissionRunner({ ...capacityRunnerDeps(agent, hops), inRunBackoffWaitMs: value }),
        /non-negative safe integer/,
      );
      assert.deepEqual(hops.calls, []);
      assert.equal(agent.specs.length, 0);
    }
  });

  test('每维 0、负数、小数、NaN、Infinity 在构造时抛，不改队列、不调 runtime.start', () => {
    const invalid = [0, -1, 1.5, Number.NaN, Infinity];
    const dimensions = ['global', 'project', 'role', 'runtime', 'profile'] as const;
    for (const dim of dimensions) {
      for (const value of invalid) {
        const runtime = new ScriptedRuntime({});
        const hop = sampleQueuedHop({ id: `h-${dim}-${String(value)}` });
        const queuedHops = countingQueuedHops([hop]);
        const limits = { ...DEFAULT_HOP_CAPACITY_LIMITS, [dim]: value };
        assert.throws(
          () => new MissionRunner(capacityRunnerDeps(runtime, queuedHops, limits)),
          /positive safe integer/,
        );
        assert.deepEqual(queuedHops.calls, [], `${dim}=${String(value)} 不得访问队列`);
        assert.equal(runtime.specs.length, 0, `${dim}=${String(value)} 不得调用 runtime.start`);
      }
    }
  });
});

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

test('文件平台重建后，持久 open 熔断阻止未到期协调者候选启动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-mission-circuit-'));
  temps.push(dir);
  const statePath = join(dir, 'state.json');
  const first = await buildPersistentPlatform(statePath, { workspace: new InPlaceWorkspaceManager() });
  await first.platform.createMission({ projectId: 'P', missionId: 'M-circuit', contract: CONTRACT });
  const openUntil = new Date(Date.now() + 60_000).toISOString();
  const opened = await first.candidateCircuits.open({
    profileId: 'P', failureClass: 'rate_limit', now: new Date().toISOString(), openUntil,
  });
  assert.equal(opened.state, 'open');
  first.persist();

  const rebuilt = await buildPersistentPlatform(statePath, { workspace: new InPlaceWorkspaceManager() });
  const persisted = await rebuilt.candidateCircuits.get('P');
  assert.deepEqual(persisted, opened, '重建仓储读到原 open 记录');
  const tokens = rebuilt.tokens;
  const server: Server = createApi({ platform: rebuilt.platform, tokens, deliveries: rebuilt.deliveries });
  await listenLoopback(server, 0);
  servers.push(server);
  const address = server.address() as AddressInfo;
  const runtime = new ScriptedRuntime({});
  const runner = new MissionRunner({
    platform: rebuilt.platform,
    tokens: makeIssuer(rebuilt.platform, tokens),
    baseUrl: `http://127.0.0.1:${address.port}`,
    workspace: new InPlaceWorkspaceManager(),
    candidateCircuits: rebuilt.candidateCircuits,
    queuedHops: rebuilt.queuedHops,
    coordinator: { runtime, candidates: [{ endpoint: 'local', profileId: 'P' }] },
    executor: { runtime: new ScriptedRuntime({}), candidates: [] },
  });
  await runner.run('M-circuit', { projectRoot: dir });
  assert.equal(runtime.specs.length, 0, '未到期 open 候选未启动 Agent');
  assert.deepEqual(await rebuilt.candidateCircuits.get('P'), persisted);
  rebuilt.releaseLock();
});

function sampleQueuedHop(overrides: Partial<QueuedHop> = {}): QueuedHop {
  return {
    id: 'h-persist',
    projectId: 'P',
    missionId: 'M-queue',
    workItemId: 'W-1',
    role: 'executor',
    priority: 1,
    availableAt: '2020-01-01T00:00:00.000Z',
    attemptCount: 0,
    maxAttempts: 2,
    idempotencyKey: 'key-persist',
    status: 'queued',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('文件平台 queuedHops 与 store 同源，重建后仍在', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-mission-queue-'));
  temps.push(dir);
  const statePath = join(dir, 'state.json');
  const first = await buildPersistentPlatform(statePath, { workspace: new InPlaceWorkspaceManager() });
  assert.equal(first.queuedHops.constructor.name, 'FileQueuedHopRepository');
  assert.ok(first.queuedHops instanceof FileQueuedHopRepository);
  const hop = await first.queuedHops.enqueue(sampleQueuedHop());
  first.persist();
  const throughStore = new FileQueuedHopRepository(first.store);
  assert.deepEqual(await throughStore.get(hop.id), hop);

  const rebuilt = await buildPersistentPlatform(statePath, {
    workspace: new InPlaceWorkspaceManager(),
    reconcile: false,
  });
  assert.ok(rebuilt.queuedHops instanceof FileQueuedHopRepository);
  assert.deepEqual(await rebuilt.queuedHops.get(hop.id), hop);
  assert.equal((await rebuilt.queuedHops.list())[0]?.status, 'queued');
  first.releaseLock();
  rebuilt.releaseLock();
});

test('文件版第二进程拿不到状态排他锁时不领取 Hop、不启动 Agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-mission-lock-'));
  temps.push(dir);
  const statePath = join(dir, 'state.json');
  const first = await buildPersistentPlatform(statePath, {
    workspace: new InPlaceWorkspaceManager(),
    exclusive: { what: 'holder' },
  });
  await first.platform.createMission({ projectId: 'P', missionId: 'M-lock', contract: CONTRACT });
  const hop = await first.queuedHops.enqueue(sampleQueuedHop({ id: 'h-lock', missionId: 'M-lock', idempotencyKey: 'key-lock' }));
  first.persist();

  const runtime = new ScriptedRuntime({});
  await assert.rejects(
    () => buildPersistentPlatform(statePath, {
      workspace: new InPlaceWorkspaceManager(),
      exclusive: { what: 'second' },
    }),
    (error: unknown) => error instanceof LockBusyError,
  );
  assert.equal((await first.queuedHops.get(hop.id))?.status, 'queued');
  assert.equal(runtime.specs.length, 0, '拿不到锁时未构造 Runner，不启动 Agent');

  const mission = join(dir, 'mission.json');
  writeFileSync(mission, JSON.stringify({ projectId: 'P', missionId: 'M-lock', contract: CONTRACT }));
  const spawned = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      'src/run-mission.ts',
      mission,
      '--cwd',
      dir,
      '--state',
      statePath,
      '--in-place',
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      env: { ...process.env, COAGENT_AGENT_ENV_PASSTHROUGH: '-' },
      timeout: 20_000,
    },
  );
  assert.notEqual(spawned.status, 0, `${spawned.stdout}${spawned.stderr}`);
  assert.match(`${spawned.stdout}${spawned.stderr}`, /平台正被另一个进程占用/);
  assert.equal((await first.queuedHops.get(hop.id))?.status, 'queued');
  assert.equal(runtime.specs.length, 0);
  first.releaseLock();
});

function countingTerminalReview(platform: Platform) {
  const counts = { machine: 0, abandon: 0 };
  const machine = platform.finalizeMissionByMachine.bind(platform);
  const abandon = platform.abandonMissionForPlan.bind(platform);
  platform.finalizeMissionByMachine = (async (...args: Parameters<Platform['finalizeMissionByMachine']>) => {
    counts.machine += 1;
    return machine(...args);
  }) as Platform['finalizeMissionByMachine'];
  platform.abandonMissionForPlan = (async (...args: Parameters<Platform['abandonMissionForPlan']>) => {
    counts.abandon += 1;
    return abandon(...args);
  }) as Platform['abandonMissionForPlan'];
  return counts;
}

async function executorQueueRow(queuedHops: { get(id: string): Promise<QueuedHop | undefined>; list(): Promise<readonly QueuedHop[]> }) {
  const listed = (await queuedHops.list()).filter((row) => row.role === 'executor');
  assert.equal(listed.length, 1);
  const got = await queuedHops.get(listed[0]!.id);
  assert.ok(got);
  assert.deepEqual(got, listed[0]);
  return got!;
}

test('文件平台注入真实 MissionRunner：上游失败进持久退避，到期再失败死信，重入不多计', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-mission-fail-queue-'));
  temps.push(dir);
  const statePath = join(dir, 'state.json');
  const hopNow = new Date().toISOString();
  const hopClock = new FixedClock(hopNow);
  const built = await buildPersistentPlatform(statePath, {
    workspace: new InPlaceWorkspaceManager(),
  });
  try {
    assert.ok(built.queuedHops instanceof FileQueuedHopRepository);
    await built.platform.createMission({
      projectId: 'P',
      missionId: 'M-fail-queue',
      contract: CONTRACT,
    });
    const tokens = built.tokens;
    const server: Server = createApi({
      platform: built.platform,
      tokens,
      deliveries: built.deliveries,
    });
    await listenLoopback(server, 0);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const terminal = countingTerminalReview(built.platform);
    const coordinatorRuntime = new ScriptedRuntime(COORDINATOR_HAPPY);
    const executorRuntime = new ScriptedRuntime({
      'executor:W-1': { steps: [], upstreamFailure: 'HTTP 503 Service Unavailable' },
    });
    // 与 src/run-mission.ts 相同注入 built.queuedHops / candidateCircuits。
    // 队列退避 1s，默认候选熔断 5min：若不把池冷却压到可行，到期重领会被伪装成 no_available_agent。
    const runner = new MissionRunner({
      platform: built.platform,
      tokens: makeIssuer(built.platform, tokens),
      baseUrl: `http://127.0.0.1:${address.port}`,
      workspace: new InPlaceWorkspaceManager(),
      candidateCircuits: built.candidateCircuits,
      queuedHops: built.queuedHops,
      hopClock,
      coordinator: {
        runtime: coordinatorRuntime,
        candidates: [{ endpoint: 'local', profileId: 'coord-a' }],
        cooldownMs: 0,
      },
      executor: {
        runtime: executorRuntime,
        candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
        maxAttempts: 2,
        cooldownMs: 0,
      },
    });
    const projectRoot = dir;

    const first = await runner.run('M-fail-queue', { projectRoot });
    assert.equal(first.outcome.kind, 'waiting');
    if (first.outcome.kind === 'waiting') {
      assert.equal(first.outcome.reason, 'project_busy');
      assert.match(first.outcome.detail, /退避/);
    }
    const hop = await executorQueueRow(built.queuedHops);
    assert.equal(hop.status, 'retry_wait');
    assert.equal(hop.attemptCount, 1);
    assert.ok(hop.lastFailure);
    assert.ok(Date.parse(hop.availableAt) > Date.parse(hop.lastFailure.at));
    assert.equal(hop.lastFailure.classification, 'upstream_5xx');
    assert.equal(hop.lastFailure.disposition, 'retry_then_dead_letter');
    assert.equal(hop.lastFailure.retryable, true);
    built.persist();
    const throughStore = new FileQueuedHopRepository(built.store);
    assert.deepEqual(await throughStore.get(hop.id), hop);
    const view1 = await built.platform.getMissionView('M-fail-queue');
    assert.notEqual(view1.status, 'completed');
    assert.equal(view1.workItems[0]?.attempts, 1);
    const execStarts1 = executorRuntime.specs.length;
    assert.equal(execStarts1, 1);
    const firstFailure = { ...hop.lastFailure };
    const firstAvailableAt = hop.availableAt;
    assert.equal(terminal.machine, 0);
    assert.equal(terminal.abandon, 0);

    const early = await runner.run('M-fail-queue', { projectRoot });
    assert.equal(early.outcome.kind, 'waiting');
    if (early.outcome.kind === 'waiting') {
      assert.equal(early.outcome.reason, 'project_busy');
      assert.match(early.outcome.detail, /退避/);
    }
    const duringBackoff = await executorQueueRow(built.queuedHops);
    assert.equal(duringBackoff.id, hop.id);
    assert.equal(duringBackoff.status, 'retry_wait');
    assert.equal(duringBackoff.attemptCount, 1);
    assert.equal(duringBackoff.availableAt, firstAvailableAt);
    assert.equal(duringBackoff.lastFailure?.attemptId, firstFailure.attemptId);
    assert.equal(duringBackoff.lastFailure?.claimGeneration, firstFailure.claimGeneration);
    assert.equal(duringBackoff.lastFailure?.at, firstFailure.at);
    assert.equal(duringBackoff.lastFailure?.classification, firstFailure.classification);
    assert.equal(duringBackoff.lastFailure?.disposition, firstFailure.disposition);
    assert.equal(duringBackoff.lastFailure?.retryable, firstFailure.retryable);
    assert.deepEqual(duringBackoff.lastFailure, firstFailure);
    assert.equal(executorRuntime.specs.length, execStarts1, '退避期间不得启动新 Agent');
    assert.equal((await built.platform.getMissionView('M-fail-queue')).workItems[0]?.attempts, 1);
    assert.equal(terminal.machine, 0);
    assert.equal(terminal.abandon, 0);

    hopClock.advance(Date.parse(hop.availableAt) - Date.parse(hopNow));
    const second = await runner.run('M-fail-queue', { projectRoot });
    assert.equal(second.outcome.kind, 'waiting');
    if (second.outcome.kind === 'waiting') {
      assert.equal(second.outcome.reason, 'attempt_limit_reached');
      assert.match(second.outcome.detail, /死信/);
    }
    const dead = await executorQueueRow(built.queuedHops);
    assert.equal(dead.id, hop.id);
    assert.equal(dead.status, 'dead_letter');
    assert.equal(dead.attemptCount, 2);
    assert.equal(executorRuntime.specs.length, execStarts1 + 1);
    assert.notEqual((await built.platform.getMissionView('M-fail-queue')).status, 'completed');
    built.persist();
    assert.equal((await throughStore.get(dead.id))?.status, 'dead_letter');
    assert.equal(terminal.machine, 0);
    assert.equal(terminal.abandon, 0);

    const again = await runner.run('M-fail-queue', { projectRoot });
    assert.equal(again.outcome.kind, 'waiting');
    if (again.outcome.kind === 'waiting') {
      assert.equal(again.outcome.reason, 'attempt_limit_reached');
      assert.notEqual(again.outcome.reason, 'no_available_agent');
      assert.match(again.outcome.detail, /死信/);
    }
    const stillDead = await executorQueueRow(built.queuedHops);
    assert.equal(stillDead.id, hop.id);
    assert.equal(stillDead.status, 'dead_letter');
    assert.equal(stillDead.attemptCount, 2);
    assert.equal(executorRuntime.specs.length, execStarts1 + 1, '死信后不得再启动 Agent');
    assert.notEqual((await built.platform.getMissionView('M-fail-queue')).status, 'completed');
    assert.equal(terminal.machine, 0, '受控失败不得调用机器终审');
    assert.equal(terminal.abandon, 0, '受控失败不得自动放弃 Mission');
  } finally {
    built.releaseLock();
  }
});

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
    assert.match(runner, /queuedHops\?:/);
    assert.match(runner, /hopCapacityLimits\?:/);
    assert.match(runner, /hopCapacityLimits\(deps\.hopCapacityLimits\)/);
    assert.match(runner, /inRunBackoffWaitMs\?:/);
    assert.match(runner, /inRunBackoffWaitMs\(deps\.inRunBackoffWaitMs\)/);
    const ctorAt = runner.indexOf('constructor(deps: MissionRunnerDeps)');
    const hopCapAt = runner.indexOf('hopCapacityLimits(deps.hopCapacityLimits)');
    const waitAt = runner.indexOf('inRunBackoffWaitMs(deps.inRunBackoffWaitMs)');
    const orchAt = runner.indexOf('new Orchestrator(this.#deps)');
    assert.ok(ctorAt >= 0 && hopCapAt > ctorAt && hopCapAt < orchAt, '容量归一化必须在构造时、交给编排器之前');
    assert.ok(waitAt > ctorAt && waitAt < orchAt, '运行内退避上限必须在构造时校验');
  });

  test('源码：CLI 仍自行装配、接续、过滤候选、回连并输出', () => {
    const cli = src('run-mission.ts');
    assert.match(cli, /new MissionRunner\(/);
    assert.match(cli, /new MissionRunner\(\{[\s\S]*?candidateCircuits,/);
    assert.match(cli, /new MissionRunner\(\{[\s\S]*?queuedHops,/);
    assert.match(cli, /new MissionRunner\(\{[\s\S]*?inRunBackoffWaitMs:\s*120_000/);
    assert.match(cli, /candidateCircuits, queuedHops \} = built/);
    assert.doesNotMatch(cli, /--hop-capacity|--capacity-global|--capacity-project|--capacity-role|--capacity-runtime|--capacity-profile/);
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
    assert.match(cli, /--max-rounds <1-100>/);
    assert.match(cli, /parseMaxRounds\(/);
    assert.match(cli, /maxRounds/);
  });

  test('max-rounds 选项组装：显式值传递，缺省不覆盖 orchestrator 默认值', () => {
    assert.deepEqual(missionRunOptions('/work/project', 30), {
      projectRoot: '/work/project',
      maxRounds: 30,
    });
    assert.deepEqual(missionRunOptions('/work/project', undefined), {
      projectRoot: '/work/project',
    });
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

    // 非队列化夹具不注入 queuedHops：接线不得改变原行为。
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

test('非法 max-rounds 在读取 mission 与创建状态/锁前失败', () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-mission-rounds-'));
  const mission = join(dir, 'mission.json');
  const state = join(dir, 'state.json');
  writeFileSync(mission, '{"projectId":"P","missionId":"M","contract":{}}');
  try {
    for (const flagArgs of [['--max-rounds', '0'], ['--max-rounds']]) {
      const result = spawnSync(process.execPath, [
        '--experimental-strip-types', 'src/run-mission.ts', mission, '--state', state, ...flagArgs,
      ], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /--max-rounds/);
      assert.match(result.stderr, /1–100/);
      assert.equal(existsSync(state), false);
      assert.equal(existsSync(join(dir, '.lock-state.json')), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
      startCoordinator: (missionId, profile, claim) => inner.startCoordinator(missionId, profile, claim),
      startExecutor: (missionId, workItemId, profile, claim) =>
        inner.startExecutor(missionId, workItemId, profile, claim),
      async startIndependentReviewer(missionId, candidates = [], claim) {
        const started = await inner.startIndependentReviewer!(missionId, candidates, claim);
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

async function postAgentJson(
  base: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: { error?: string } }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-coagent-run': token } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: (await res.json()) as { error?: string } };
}

describe('生产入口 makeIssuer 队列领取身份', () => {
  test('源码：run-mission 经共用 makeIssuer 发牌', () => {
    assert.match(src('run-mission.ts'), /tokens:\s*makeIssuer\(platform,\s*tokens\)/);
  });

  test('三类 start 把真实领取身份交给 Platform 并冻结进 token；失租 finish 拒绝；请求体不能自述身份；非队列不变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-mission-claim-'));
    temps.push(dir);
    const built = await buildPersistentPlatform(join(dir, 'state.json'), {
      workspace: new InPlaceWorkspaceManager(),
    });
    const server: Server = createApi({
      platform: built.platform,
      tokens: built.tokens,
      deliveries: built.deliveries,
    });
    await listenLoopback(server, 0);
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const hops = built.queuedHops;
      assert.ok(hops instanceof FileQueuedHopRepository);
      const now = new Date().toISOString();
      const lease = new Date(Date.now() + 60_000).toISOString();
      await hops.enqueue({
        id: 'h-claim',
        projectId: 'P',
        missionId: 'M-claim',
        workItemId: '-',
        role: 'coordinator',
        priority: 1,
        availableAt: now,
        attemptCount: 0,
        maxAttempts: 2,
        idempotencyKey: 'run-mission-claim',
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      });
      const claimed = await hops.claim('h-claim', 'owner', now, lease);
      assert.equal(claimed?.claimGeneration, 1);
      const live: QueueClaimIdentity = { id: 'h-claim', owner: 'owner', claimGeneration: 1 };

      await built.platform.createMission({
        projectId: 'P',
        missionId: 'M-claim',
        contract: CONTRACT,
      });
      await built.platform.createMission({
        projectId: 'P',
        missionId: 'M-nq',
        contract: CONTRACT,
      });

      const startClaims: Array<{ role: string; claim: QueueClaimIdentity | undefined }> = [];
      const origCoord = built.platform.startCoordinatorAttempt.bind(built.platform);
      built.platform.startCoordinatorAttempt = (async (missionId, profile, claim) => {
        startClaims.push({ role: 'coordinator', claim });
        return origCoord(missionId, profile, claim);
      }) as Platform['startCoordinatorAttempt'];
      const origExec = built.platform.startExecutorAttempt.bind(built.platform);
      built.platform.startExecutorAttempt = (async (missionId, workItemId, profile, claim) => {
        startClaims.push({ role: 'executor', claim });
        return origExec(missionId, workItemId, profile, claim);
      }) as Platform['startExecutorAttempt'];
      const origIr = built.platform.startIndependentReviewerAttempt.bind(built.platform);
      built.platform.startIndependentReviewerAttempt = (async (missionId, candidates, claim) => {
        startClaims.push({ role: 'independent_reviewer', claim });
        return origIr(missionId, candidates, claim);
      }) as Platform['startIndependentReviewerAttempt'];

      const issuer = makeIssuer(built.platform, built.tokens);
      const profile = { endpoint: 'local' as const, profileId: 'coord-a' };
      const queued = await issuer.startCoordinator('M-claim', profile, live);
      const frozen = built.tokens.resolve(queued.token);
      assert.deepEqual(frozen?.claim, live);
      assert.equal(Object.isFrozen(frozen?.claim), true);
      assert.equal(await built.platform.attemptRequiresQueueClaim('M-claim', queued.attemptId), true);
      assert.deepEqual(
        startClaims.find((row) => row.role === 'coordinator' && row.claim !== undefined)?.claim,
        live,
      );

      const unmarked = await issuer.startCoordinator('M-nq', profile);
      assert.equal(built.tokens.resolve(unmarked.token)?.claim, undefined);
      assert.equal(await built.platform.attemptRequiresQueueClaim('M-nq', unmarked.attemptId), false);

      await assert.rejects(() => issuer.startExecutor('M-claim', 'W-missing', profile, live));
      await assert.rejects(() =>
        issuer.startIndependentReviewer!('M-claim', [{ profileId: 'ir-a', endpoint: 'local' }], live),
      );
      assert.deepEqual(
        startClaims.find((row) => row.role === 'executor')?.claim,
        live,
      );
      assert.deepEqual(
        startClaims.find((row) => row.role === 'independent_reviewer')?.claim,
        live,
      );

      const later = new Date(Date.now() + 120_000).toISOString();
      const taken = await hops.claim(live.id, 'next', lease, later);
      assert.equal(taken?.claimGeneration, 2);
      await assert.rejects(
        () => built.platform.finishAttempt('M-claim', queued.attemptId, { endedBy: 'structured_submit' }, live),
        (error: unknown) => error instanceof PlatformRuleError && error.code === 'CLAIM_FENCE_REJECTED',
      );
      assert.equal(
        (await built.projects.get('P'))!.missions.find((m) => m.id === 'M-claim')!.coordinatorAttempts[0]!.status,
        'in_progress',
      );
      assert.equal(built.tokens.resolve(queued.token)?.attemptId, queued.attemptId);

      const spoofed = await postAgentJson(
        baseUrl,
        `/api/missions/M-claim/attempts/${queued.attemptId}/finish`,
        { endedBy: 'structured_submit', owner: 'next', claimGeneration: 2, id: live.id },
        queued.token,
      );
      assert.notEqual(spoofed.status, 200);
      assert.equal(spoofed.json.error, 'CLAIM_FENCE_REJECTED');
      assert.equal(
        (await built.projects.get('P'))!.missions.find((m) => m.id === 'M-claim')!.coordinatorAttempts[0]!.status,
        'in_progress',
      );

      await built.platform.finishAttempt('M-nq', unmarked.attemptId, { endedBy: 'structured_submit' });
      assert.notEqual(
        (await built.projects.get('P'))!.missions.find((m) => m.id === 'M-nq')!.coordinatorAttempts[0]!.status,
        'in_progress',
      );
    } finally {
      built.releaseLock();
    }
  });

  test('MissionRunner 队列 hop 开牌与 finally finish 带同一领取身份；非队列不带 claim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-mission-orch-claim-'));
    temps.push(dir);
    const queuedBuilt = await buildPersistentPlatform(join(dir, 'state-q.json'), {
      workspace: new InPlaceWorkspaceManager(),
    });
    const plainBuilt = await buildPersistentPlatform(join(dir, 'state-nq.json'), {
      workspace: new InPlaceWorkspaceManager(),
    });
    const qServer: Server = createApi({
      platform: queuedBuilt.platform,
      tokens: queuedBuilt.tokens,
      deliveries: queuedBuilt.deliveries,
    });
    const nqServer: Server = createApi({
      platform: plainBuilt.platform,
      tokens: plainBuilt.tokens,
      deliveries: plainBuilt.deliveries,
    });
    await listenLoopback(qServer, 0);
    await listenLoopback(nqServer, 0);
    servers.push(qServer, nqServer);
    try {
      const finishes: Array<QueueClaimIdentity | undefined> = [];
      const origFinish = queuedBuilt.platform.finishAttempt.bind(queuedBuilt.platform);
      queuedBuilt.platform.finishAttempt = (async (missionId, attemptId, outcome, claim) => {
        finishes.push(claim);
        return origFinish(missionId, attemptId, outcome, claim);
      }) as Platform['finishAttempt'];

      await queuedBuilt.platform.createMission({
        projectId: 'P',
        missionId: 'M-orch',
        contract: CONTRACT,
      });
      const qRunner = new MissionRunner({
        platform: queuedBuilt.platform,
        tokens: makeIssuer(queuedBuilt.platform, queuedBuilt.tokens),
        baseUrl: `http://127.0.0.1:${(qServer.address() as AddressInfo).port}`,
        workspace: new InPlaceWorkspaceManager(),
        queuedHops: queuedBuilt.queuedHops,
        owner: 'runner-claim',
        coordinator: {
          runtime: new ScriptedRuntime({
            'coordinator:-:0': { steps: [{ tool: 'coagent_get_mission', body: {} }] },
          }),
          candidates: [{ endpoint: 'local', profileId: 'coord-a' }],
        },
        executor: {
          runtime: new ScriptedRuntime({}),
          candidates: [],
        },
      });
      await qRunner.run('M-orch', { projectRoot: dir, maxRounds: 1 });
      const queuedFinishes = finishes.filter((row): row is QueueClaimIdentity => row !== undefined);
      assert.ok(queuedFinishes.length >= 1);
      assert.ok(
        queuedFinishes.every(
          (row) => row.owner === 'runner-claim' && row.claimGeneration === 1 && row.id.length > 0,
        ),
      );

      const nqFinishes: Array<QueueClaimIdentity | undefined> = [];
      const origNq = plainBuilt.platform.finishAttempt.bind(plainBuilt.platform);
      plainBuilt.platform.finishAttempt = (async (missionId, attemptId, outcome, claim) => {
        nqFinishes.push(claim);
        return origNq(missionId, attemptId, outcome, claim);
      }) as Platform['finishAttempt'];
      await plainBuilt.platform.createMission({
        projectId: 'P',
        missionId: 'M-plain',
        contract: CONTRACT,
      });
      const nqRunner = new MissionRunner({
        platform: plainBuilt.platform,
        tokens: makeIssuer(plainBuilt.platform, plainBuilt.tokens),
        baseUrl: `http://127.0.0.1:${(nqServer.address() as AddressInfo).port}`,
        workspace: new InPlaceWorkspaceManager(),
        owner: 'runner-claim',
        coordinator: {
          runtime: new ScriptedRuntime({
            'coordinator:-:0': { steps: [{ tool: 'coagent_get_mission', body: {} }] },
          }),
          candidates: [{ endpoint: 'local', profileId: 'coord-a' }],
        },
        executor: {
          runtime: new ScriptedRuntime({}),
          candidates: [],
        },
      });
      await nqRunner.run('M-plain', { projectRoot: dir, maxRounds: 1 });
      assert.ok(nqFinishes.length >= 1);
      assert.ok(nqFinishes.every((row) => row === undefined));
    } finally {
      queuedBuilt.releaseLock();
      plainBuilt.releaseLock();
    }
  });
});

describe('L3 主写在持锁常驻服务时转发', () => {
  test('startServer 持锁时 l3 pause 成功，run-mission 仍拿不到锁', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'l3-loopback-wire-'));
    temps.push(dir);
    const statePath = join(dir, 'state.json');
    const seeded = await buildPersistentPlatform(statePath, {
      workspace: new InPlaceWorkspaceManager(),
      reconcile: false,
      exclusive: { what: 'seed' },
    });
    await seeded.platform.createMission({
      projectId: 'P',
      missionId: 'M-pause',
      contract: CONTRACT,
    });
    seeded.persist();
    seeded.releaseLock();

    const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
    const live = spawn(process.execPath, [MAIN], {
      env: {
        ...process.env,
        COAGENT_STORE: 'file',
        COAGENT_STATE: statePath,
        PORT: '0',
        COAGENT_RECONCILE_INTERVAL_MS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let liveErr = '';
    live.stderr?.on('data', (chunk) => {
      liveErr += String(chunk);
    });
    await new Promise<void>((resolve, reject) => {
      let started = false;
      const timer = setTimeout(() => {
        if (!started) reject(new Error(`常驻服务启动超时：${liveErr}`));
      }, 20_000);
      live.stdout?.on('data', (chunk) => {
        if (started) return;
        if (String(chunk).includes('平台已启动')) {
          started = true;
          clearTimeout(timer);
          resolve();
        }
      });
      live.once('exit', (code) => {
        if (!started) {
          clearTimeout(timer);
          reject(new Error(`常驻服务提前退出 ${String(code)}：${liveErr}`));
        }
      });
    });
    try {
      const L3 = fileURLToPath(new URL('../src/l3.ts', import.meta.url));
      const paused = spawnSync(process.execPath, [L3, 'pause', 'M-pause', '--state', statePath], {
        encoding: 'utf8',
        timeout: 20_000,
      });
      assert.equal(paused.status, 0, `${paused.stdout}${paused.stderr}`);
      assert.match(`${paused.stdout}${paused.stderr}`, /已暂停/);

      const mission = join(dir, 'mission.json');
      writeFileSync(mission, JSON.stringify({ projectId: 'P', missionId: 'M-pause', contract: CONTRACT }));
      const spawned = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          'src/run-mission.ts',
          mission,
          '--cwd',
          dir,
          '--state',
          statePath,
          '--in-place',
        ],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          encoding: 'utf8',
          env: { ...process.env, COAGENT_AGENT_ENV_PASSTHROUGH: '-' },
          timeout: 20_000,
        },
      );
      assert.notEqual(spawned.status, 0, `${spawned.stdout}${spawned.stderr}`);
      assert.match(`${spawned.stdout}${spawned.stderr}`, /平台正被另一个进程占用/);
    } finally {
      await new Promise<void>((done) => {
        live.once('exit', () => done());
        live.kill();
        setTimeout(() => {
          live.kill('SIGKILL');
          done();
        }, 3000);
      });
    }
  });
});
