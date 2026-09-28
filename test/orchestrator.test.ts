/**
 * 调度器的端到端：一整条 Mission 由平台自己走完，没有人按按钮。
 *
 * 全程跑在 ScriptedRuntime 上——**这台机器不需要装 pi**。这就是
 * "为别的 agent 预留"的判据：端口有第二个实现，而且用例测试跑在它上面。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
  SystemClock,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Orchestrator, inRunBackoffWaitMs } from '../src/application/orchestrator.ts';
import { MissionRunner } from '../src/application/mission-runner.ts';
import { Platform, PlatformRuleError } from '../src/application/platform.ts';
import { makeIssuer } from '../src/main.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { FileCandidateCircuitRepository, FileStateStore } from '../src/application/file-store.ts';
import type { AgentRuntime, CandidateCircuitRepository, QueuedHopCapacityRepository } from '../src/application/ports.ts';
import type { CandidateCircuit } from '../src/application/candidate-circuit.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import {
  claimHop,
  claimHopWithCandidate,
  completeHop,
  decideCapacityClaim,
  hopCapacityLimits,
  hopIdempotencyKey,
  renewHop,
  reportHopFailure,
  type HopCapacityLimits,
  type QueuedHop,
} from '../src/application/durable-scheduler.ts';
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
import type { WorkspaceManager } from '../src/application/workspace.ts';
import { createMemoryFencedTransaction } from './helpers/fenced-transaction.ts';

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

/**
 * 每个用例起一套自己的平台 + server。
 *
 * 不要用 Proxy 共享一个 server 去转发到当前平台实例：领域对象大量使用 `#`
 * 私有字段，经 Proxy 调用时 `this` 是 Proxy 而不是实例，私有字段访问会直接
 * 抛 TypeError —— 而调度器会把它归成"上游失败"，症状完全对不上原因。
 */
async function harness(runtimes: { coordinator: AgentRuntime; executor: AgentRuntime }, candidateCircuits?: CandidateCircuitRepository, attemptWallClockMs?: number) {
  const clock = new FixedClock();
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    workspace: new InPlaceWorkspaceManager(),
    activity,
    clock,
    ids,
  });
  const tokens = new RunTokenRegistry();
  const server: Server = createApi({ platform, tokens, deliveries });
  await listenLoopback(server, 0);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);

  const pools = {
    coordinator: {
      runtime: runtimes.coordinator,
      candidates: [{ endpoint: 'local' as const, profileId: 'coordinator-a' }],
    },
    executor: {
      runtime: runtimes.executor,
      candidates: [
        { endpoint: 'local' as const, profileId: 'exec-a' },
        { endpoint: 'local' as const, profileId: 'exec-b' },
      ],
    },
  };

  return {
    platform,
    activity,
    tokens,
    deliveries,
    baseUrl,
    makeOrchestrator: () =>
      new Orchestrator({
        platform,
        tokens: makeIssuer(platform, tokens),
        baseUrl,
        workspace: new InPlaceWorkspaceManager(),
        coordinator: pools.coordinator,
        candidateCircuits,
        attemptWallClockMs,
        executor: pools.executor,
      }),
    makeRunner: () =>
      new MissionRunner({
        platform,
        tokens: makeIssuer(platform, tokens),
        baseUrl,
        workspace: new InPlaceWorkspaceManager(),
        coordinator: pools.coordinator,
        candidateCircuits,
        attemptWallClockMs,
        executor: pools.executor,
      }),
  };
}

/** Count real exec-a Agent starts. Optional gate holds wait after start so a probe stays half_open. */
function trackExecAStarts(
  inner: AgentRuntime,
  starts: { execA: number },
  hold?: { gate: Promise<void>; onStart: () => void },
): AgentRuntime {
  return {
    kind: inner.kind,
    start: async (spec) => {
      const run = await inner.start(spec);
      if (spec.role !== 'executor' || spec.profile.profileId !== 'exec-a') return run;
      starts.execA += 1;
      hold?.onStart();
      if (!hold) return run;
      return {
        resumeRef: run.resumeRef,
        on: (handler) => run.on(handler),
        abort: (reason) => run.abort(reason),
        wait: async () => {
          await hold.gate;
          return run.wait();
        },
      };
    },
  };
}

const circuitDirectories: string[] = [];
function candidateCircuitRepository(): CandidateCircuitRepository {
  const directory = mkdtempSync(join(tmpdir(), 'orchestrator-circuit-'));
  circuitDirectories.push(directory);
  return new FileCandidateCircuitRepository(new FileStateStore(join(directory, 'state.json')));
}

const servers: Server[] = [];
let current: Awaited<ReturnType<typeof harness>>;

after(() => {
  for (const server of servers) server.close();
  for (const directory of circuitDirectories) rmSync(directory, { recursive: true, force: true });
});

const COORDINATOR_HAPPY: ScriptTable = {
  // 第 0 轮：规划 + 建工作项 + 派发
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
  // 第 1 轮：被唤醒做验收，然后交卷
  'coordinator:-:1': {
    steps: [
      { tool: 'coagent_get_mission', body: {} },
      {
        tool: 'coagent_review_execution_result',
        body: {
          workItemId: 'W-1',
          verdict: 'accept', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })),
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

describe('调度器：整条 Mission 自己走完', () => {
  test('正常主链：规划 → 派发 → 执行 → 验收 → 交卷', async () => {
    current = await harness({
      coordinator: new ScriptedRuntime(COORDINATOR_HAPPY),
      executor: new ScriptedRuntime(EXECUTOR_HAPPY),
    });
    await current.platform.createMission({
      projectId: 'P',
      missionId: 'M-happy',
      contract: CONTRACT,
    });

    const orchestrator = current.makeOrchestrator();
    const result = await orchestrator.runMission('M-happy', { projectRoot: process.cwd() });

    // 调度器只把 Mission 送到 L3 门口 —— 改动还没落地。
    assert.deepEqual(result, { kind: 'awaiting_l3_review' });
    assert.equal((await current.platform.getMissionView('M-happy')).status, 'awaiting_review');

    // L3 放行之后才算完成。
    const finalized = await current.platform.finalizeMission('M-happy', {
      verdict: 'merge',
      reasons: ['契约的验收标准逐条对上了'],
      projectRoot: process.cwd(),
    });
    assert.equal(finalized.status, 'completed');

    const view = await current.platform.getMissionView('M-happy');
    assert.equal(view.workItems.length, 1);
    assert.equal(view.workItems[0].status, 'accepted');
    assert.equal(view.planRevision, 1);
    assert.equal(view.result?.outcome, 'delivered');

    // 三跳：协调者规划 → 执行者 → 协调者验收。
    assert.deepEqual(
      orchestrator.hops.map((h) => `${h.role}:${h.endedBy}`),
      ['coordinator:structured_submit', 'executor:structured_submit', 'coordinator:structured_submit'],
    );
  });

  test('上游失败换下一个候选；同一工作项两次尝试', async () => {
    const executor = new ScriptedRuntime({
      // 第一个候选：配额没了
      'executor:W-1:0': { steps: [], upstreamFailure: '403 需要充值' },
      // 第二个候选：正常跑完
      'executor:W-1:1': EXECUTOR_HAPPY['executor:W-1'],
    });
    const circuits = candidateCircuitRepository();
    current = await harness({ coordinator: new ScriptedRuntime(COORDINATOR_HAPPY), executor }, circuits);
    await current.platform.createMission({
      projectId: 'P',
      missionId: 'M-failover',
      contract: CONTRACT,
    });

    const orchestrator = current.makeOrchestrator();
    const result = await orchestrator.runMission('M-failover', { projectRoot: process.cwd() });
    assert.deepEqual(result, { kind: 'awaiting_l3_review' });
    await current.platform.finalizeMission('M-failover', {
      verdict: 'merge',
      reasons: ['ok'],
      projectRoot: process.cwd(),
    });

    const executorHops = orchestrator.hops.filter((h) => h.role === 'executor');
    assert.equal(executorHops.length, 2, '换过一次候选');
    assert.equal(executorHops[0].endedBy, 'upstream_failure');
    assert.equal(executorHops[0].profile.profileId, 'exec-a');
    assert.equal(executorHops[1].profile.profileId, 'exec-b', '第二次用的是池里下一个');
    const recorded = await circuits.get('exec-a');
    assert.equal(recorded.state, 'open');
    if (recorded.state === 'open') {
      assert.equal(recorded.failureClass, 'quota');
      assert.ok(Date.parse(recorded.openUntil) > Date.now());
    }

    const view = await current.platform.getMissionView('M-failover');
    assert.equal(view.workItems[0].attempts, 2, '同一工作项两次尝试');
    assert.equal(view.workItems[0].status, 'accepted', '第一次失败不等于工作项失败');
  });

  test('持久 Hop 的平台不可达保留原熔断记录且不轮换候选', async () => {
    const scripted = new ScriptedRuntime({ 'executor:W-1': { steps: [] } });
    const platformUnavailable: AgentRuntime = {
      kind: scripted.kind,
      start: async (spec) => {
        const run = await scripted.start(spec);
        if (spec.role !== 'executor' || spec.workItemId !== 'W-1' || spec.profile.profileId !== 'exec-a') return run;
        return {
          resumeRef: run.resumeRef,
          on: (handler) => run.on(handler),
          abort: (reason) => run.abort(reason),
          wait: async () => ({ ...await run.wait(), endedBy: 'platform_unreachable' as const }),
        };
      },
    };
    const circuits = candidateCircuitRepository();
    current = await harness({ coordinator: new ScriptedRuntime(COORDINATOR_HAPPY), executor: platformUnavailable }, circuits);
    await current.platform.createMission({ projectId: 'P', missionId: 'M-platform-unreachable', contract: CONTRACT });
    const before = await circuits.get('exec-a');
    const orchestrator = current.makeOrchestrator();
    await orchestrator.runMission('M-platform-unreachable', { projectRoot: process.cwd() });
    const executorHops = orchestrator.hops.filter((hop) => hop.role === 'executor');
    assert.equal(executorHops.length, 1);
    assert.equal(executorHops[0].profile.profileId, 'exec-a');
    assert.equal(executorHops[0].endedBy, 'platform_unreachable');
    assert.deepEqual(await circuits.get('exec-a'), before);
    assert.equal(executorHops.some((hop) => hop.profile.profileId === 'exec-b'), false, 'Q 未启动');
  });

  test('无分类 upstream_failure 持久熔断为 unknown 但不轮换候选', async () => {
    const executor = new ScriptedRuntime({ 'executor:W-1': { steps: [], upstreamFailure: 'upstream unavailable' } });
    const circuits = candidateCircuitRepository();
    current = await harness({ coordinator: new ScriptedRuntime(COORDINATOR_HAPPY), executor }, circuits);
    await current.platform.createMission({ projectId: 'P', missionId: 'M-unknown-upstream', contract: CONTRACT });
    const orchestrator = current.makeOrchestrator();
    await orchestrator.runMission('M-unknown-upstream', { projectRoot: process.cwd() });
    const executorHops = orchestrator.hops.filter((hop) => hop.role === 'executor');
    assert.equal(executorHops.length, 1);
    assert.equal(executorHops[0].profile.profileId, 'exec-a');
    assert.equal(executorHops[0].endedBy, 'upstream_failure');
    const recorded = await circuits.get('exec-a');
    assert.equal(recorded.state, 'open');
    if (recorded.state === 'open') {
      assert.equal(recorded.failureClass, 'unknown');
      assert.ok(Date.parse(recorded.openUntil) > Date.now());
    }
    assert.equal(executorHops.some((hop) => hop.profile.profileId === 'exec-b'), false, 'Q 未启动');
  });

  test('普通执行结果失败不触发候选熔断轮换', async () => {
    const executor = new ScriptedRuntime({ 'executor:W-1': { steps: [{ tool: 'coagent_get_work_order', body: {} }] } });
    const circuits = candidateCircuitRepository();
    current = await harness({ coordinator: new ScriptedRuntime(COORDINATOR_HAPPY), executor }, circuits);
    await current.platform.createMission({ projectId: 'P', missionId: 'M-ordinary-failure', contract: CONTRACT });
    const orchestrator = current.makeOrchestrator();
    await orchestrator.runMission('M-ordinary-failure', { projectRoot: process.cwd() });
    const executorHops = orchestrator.hops.filter((hop) => hop.role === 'executor');
    assert.ok(executorHops.length > 0, '发生真实 executor Hop');
    assert.ok(executorHops.every((hop) => hop.profile.profileId === 'exec-a'));
    assert.ok(executorHops.every((hop) => hop.endedBy === 'no_structured_result'));
    assert.deepEqual(await circuits.get('exec-a'), { profileId: 'exec-a', state: 'closed' });
    assert.equal(executorHops.some((hop) => hop.profile.profileId === 'exec-b'), false, 'Q 未启动');
  });

  test('持久候选熔断记录五种真实 Hop 失败分类及未来截止', async () => {
    const scenarios = [
      ['quota', 'HTTP 429 quota exceeded', 'quota'],
      ['auth', '401 Unauthorized', 'auth'],
      ['upstream-5xx', 'HTTP 503 Service Unavailable', 'upstream_5xx'],
      ['local-adapter', 'adapter initialization failed', 'local_adapter_error'],
    ] as const;
    for (const [name, message, expectedClass] of scenarios) {
      const executor = new ScriptedRuntime({ 'executor:W-1': name === 'local-adapter'
        ? { steps: [], connectionError: message }
        : { steps: [], upstreamFailure: message } });
      const circuits = candidateCircuitRepository();
      current = await harness({ coordinator: new ScriptedRuntime(COORDINATOR_HAPPY), executor }, circuits);
      const missionId = `M-circuit-${name}`;
      await current.platform.createMission({ projectId: 'P', missionId, contract: CONTRACT });
      const orchestrator = current.makeOrchestrator();
      await orchestrator.runMission(missionId, { projectRoot: process.cwd() });
      const executorHop = orchestrator.hops.find((hop) => hop.role === 'executor');
      assert.ok(executorHop, `${name} has an executor Hop`);
      assert.equal(executorHop.endedBy, 'upstream_failure', `${name} Hop classification remains distinct`);
      const recorded = await circuits.get('exec-a');
      assert.equal(recorded.state, 'open', `${name} opens P circuit`);
      if (recorded.state === 'open') {
        assert.equal(recorded.failureClass, expectedClass);
        assert.ok(Date.parse(recorded.openUntil) > Date.now());
      }
    }

    const scripted = new ScriptedRuntime({ 'executor:W-1': { steps: [] } });
    const killedIdleRuntime: AgentRuntime = {
      kind: scripted.kind,
      start: async (spec) => {
        const run = await scripted.start(spec);
        if (spec.role !== 'executor' || spec.workItemId !== 'W-1' || spec.profile.profileId !== 'exec-a') return run;
        return {
          resumeRef: run.resumeRef,
          on: (handler) => run.on(handler),
          abort: (reason) => run.abort(reason),
          wait: async () => ({ ...await run.wait(), endedBy: 'killed_idle' as const }),
        };
      },
    };
    const circuits = candidateCircuitRepository();
    current = await harness({ coordinator: new ScriptedRuntime(COORDINATOR_HAPPY), executor: killedIdleRuntime }, circuits);
    await current.platform.createMission({ projectId: 'P', missionId: 'M-circuit-killed-idle', contract: CONTRACT });
    const orchestrator = current.makeOrchestrator();
    await orchestrator.runMission('M-circuit-killed-idle', { projectRoot: process.cwd() });
    const executorHop = orchestrator.hops.find((hop) => hop.role === 'executor');
    assert.ok(executorHop, 'killed_idle scenario has an executor Hop');
    assert.equal(executorHop.endedBy, 'killed_idle');
    const recorded = await circuits.get('exec-a');
    assert.equal(recorded.state, 'open');
    if (recorded.state === 'open') {
      assert.equal(recorded.failureClass, 'killed_idle');
      assert.ok(Date.parse(recorded.openUntil) > Date.now());
    }
  });

  test('两个 MissionRunner 共用持久仓储：到期 P 只探测一次，成功关闭后可再启动', async () => {
    const circuits = candidateCircuitRepository();
    await circuits.open({
      profileId: 'exec-a',
      failureClass: 'quota',
      openUntil: new Date(Date.now() - 60_000).toISOString(),
    });

    const starts = { execA: 0 };
    let releaseProbe = () => {};
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let signalExecAStart = () => {};
    const execAStarted = new Promise<void>((resolve) => {
      signalExecAStart = resolve;
    });

    const winnerEnv = await harness({
      coordinator: new ScriptedRuntime(COORDINATOR_HAPPY),
      executor: trackExecAStarts(new ScriptedRuntime(EXECUTOR_HAPPY), starts, {
        gate: probeGate,
        onStart: () => signalExecAStart(),
      }),
    }, circuits);
    const loserEnv = await harness({
      coordinator: new ScriptedRuntime(COORDINATOR_HAPPY),
      executor: trackExecAStarts(new ScriptedRuntime(EXECUTOR_HAPPY), starts),
    }, circuits);
    await winnerEnv.platform.createMission({
      projectId: 'P',
      missionId: 'M-dual-winner',
      contract: CONTRACT,
    });
    await loserEnv.platform.createMission({
      projectId: 'P',
      missionId: 'M-dual-loser',
      contract: CONTRACT,
    });

    const winner = winnerEnv.makeRunner();
    const loser = loserEnv.makeRunner();
    const winnerDone = winner.run('M-dual-winner', { projectRoot: process.cwd() });
    try {
      await execAStarted;

      const loserResult = await loser.run('M-dual-loser', { projectRoot: process.cwd() });
      assert.notEqual(loserResult.outcome.kind, 'stalled');
      const probing = await circuits.get('exec-a');
      assert.equal(probing.state, 'half_open', '探测未完成时持久记录仍是 half_open');
      assert.equal(starts.execA, 1, '重叠尝试到期 P 时 Agent 启动 P 恰好一次');
      assert.equal(
        loserResult.hops.filter((hop) => hop.role === 'executor' && hop.profile.profileId === 'exec-a').length,
        0,
        '输家没有 exec-a Hop',
      );
      assert.ok(
        loserResult.hops.some((hop) => hop.role === 'executor' && hop.profile.profileId === 'exec-b'),
        '输家可以转 exec-b',
      );

      releaseProbe();
      const winnerResult = await winnerDone;
      assert.deepEqual(winnerResult.outcome, { kind: 'awaiting_l3_review' });
      assert.equal((await circuits.get('exec-a')).state, 'closed');
      assert.ok(
        winnerResult.hops.some((hop) => hop.role === 'executor' && hop.profile.profileId === 'exec-a' && hop.endedBy === 'structured_submit'),
      );

      const thirdEnv = await harness({
        coordinator: new ScriptedRuntime(COORDINATOR_HAPPY),
        executor: trackExecAStarts(new ScriptedRuntime(EXECUTOR_HAPPY), starts),
      }, circuits);
      await thirdEnv.platform.createMission({
        projectId: 'P',
        missionId: 'M-dual-again',
        contract: CONTRACT,
      });
      const thirdResult = await thirdEnv.makeRunner().run('M-dual-again', { projectRoot: process.cwd() });
      assert.ok(
        thirdResult.hops.some((hop) => hop.role === 'executor' && hop.profile.profileId === 'exec-a'),
        '关闭后第三次真实 Runner 再次启动 exec-a',
      );
      assert.equal(starts.execA, 2);
    } finally {
      releaseProbe();
    }
  });

  test('到期 open 的 P 被真实 Runner 领取后上游失败重新 open', async () => {
    const circuits = candidateCircuitRepository();
    const expiredUntil = new Date(Date.now() - 60_000).toISOString();
    await circuits.open({
      profileId: 'exec-a',
      failureClass: 'quota',
      openUntil: expiredUntil,
    });
    const before = await circuits.get('exec-a');
    assert.equal(before.state, 'open');

    const scripted = new ScriptedRuntime({
      'executor:W-1': { steps: [], upstreamFailure: 'HTTP 503 Service Unavailable' },
    });
    const executor: AgentRuntime = {
      kind: scripted.kind,
      start: async (spec) => {
        const run = await scripted.start(spec);
        if (spec.role !== 'executor' || spec.profile.profileId !== 'exec-a') return run;
        return {
          resumeRef: run.resumeRef,
          on: (handler) => run.on(handler),
          abort: (reason) => run.abort(reason),
          wait: async () => {
            const probing = await circuits.get('exec-a');
            assert.equal(probing.state, 'half_open', '领取后探测中应为 half_open');
            return run.wait();
          },
        };
      },
    };

    current = await harness({ coordinator: new ScriptedRuntime(COORDINATOR_HAPPY), executor }, circuits);
    await current.platform.createMission({
      projectId: 'P',
      missionId: 'M-probe-reopen-5xx',
      contract: CONTRACT,
    });
    const result = await current.makeRunner().run('M-probe-reopen-5xx', { projectRoot: process.cwd() });
    const pHop = result.hops.find((hop) => hop.role === 'executor' && hop.profile.profileId === 'exec-a');
    assert.ok(pHop, 'P 发生真实 executor Hop');
    assert.equal(pHop.endedBy, 'upstream_failure');
    const recorded = await circuits.get('exec-a');
    assert.equal(recorded.state, 'open');
    if (recorded.state === 'open') {
      assert.equal(recorded.failureClass, 'upstream_5xx');
      assert.ok(Date.parse(recorded.openUntil) > Date.now(), '新截止必须在未来');
      assert.notEqual(recorded.openUntil, expiredUntil, '新截止不等于原过期截止');
    }
  });

  test('到期 open 的 P 被真实 Runner 领取后平台不可达逐字段恢复且不换 Q', async () => {
    const circuits = candidateCircuitRepository();
    await circuits.open({
      profileId: 'exec-a',
      failureClass: 'quota',
      openUntil: new Date(Date.now() - 60_000).toISOString(),
    });
    const before = await circuits.get('exec-a');
    assert.equal(before.state, 'open');

    const scripted = new ScriptedRuntime({ 'executor:W-1': { steps: [] } });
    const platformUnavailable: AgentRuntime = {
      kind: scripted.kind,
      start: async (spec) => {
        const run = await scripted.start(spec);
        if (spec.role !== 'executor' || spec.workItemId !== 'W-1' || spec.profile.profileId !== 'exec-a') return run;
        return {
          resumeRef: run.resumeRef,
          on: (handler) => run.on(handler),
          abort: (reason) => run.abort(reason),
          wait: async () => {
            const probing = await circuits.get('exec-a');
            assert.equal(probing.state, 'half_open', '领取后探测中应为 half_open');
            return { ...await run.wait(), endedBy: 'platform_unreachable' as const };
          },
        };
      },
    };

    current = await harness({
      coordinator: new ScriptedRuntime(COORDINATOR_HAPPY),
      executor: platformUnavailable,
    }, circuits);
    await current.platform.createMission({
      projectId: 'P',
      missionId: 'M-probe-unreachable-restore',
      contract: CONTRACT,
    });
    const result = await current.makeRunner().run('M-probe-unreachable-restore', { projectRoot: process.cwd() });
    const executorHops = result.hops.filter((hop) => hop.role === 'executor');
    assert.equal(executorHops.length, 1);
    assert.equal(executorHops[0].profile.profileId, 'exec-a');
    assert.equal(executorHops[0].endedBy, 'platform_unreachable');
    assert.deepEqual(await circuits.get('exec-a'), before, '最终 P 记录须逐字段等于领取前 open');
    assert.equal(executorHops.some((hop) => hop.profile.profileId === 'exec-b'), false, '同轮无 exec-b Hop');
  });

  test('候选全挂：停下来说清楚是「在等」而不是「失败了」', async () => {
    const executor = new ScriptedRuntime({
      'executor:W-1': { steps: [], upstreamFailure: '全都限流' },
    });
    current = await harness({ coordinator: new ScriptedRuntime(COORDINATOR_HAPPY), executor });
    await current.platform.createMission({
      projectId: 'P',
      missionId: 'M-dead',
      contract: CONTRACT,
    });

    const result = await current.makeOrchestrator().runMission('M-dead', { projectRoot: process.cwd() });
    // 候选全在冷却 ≠ 实现出错。两者处置不同：这个等一会儿重跑就行，
    // 所以它是 waiting 而不是 stalled。
    assert.equal(result.kind, 'waiting');
    assert.equal((result as { reason: string }).reason, 'no_available_agent');
    assert.match((result as { detail: string }).detail, /冷却/);

    // 停机原因要落到 Mission 上，界面才看得见。
    const view = await current.platform.getMissionView('M-dead');
    assert.equal(view.waitReason, 'no_available_agent');
  });

  test('「跑完没提交」不换模型再赌一次', async () => {
    // 协调者两轮都什么也不提交。候选只有一个，所以换候选不可能发生；
    // 要验的是调度器**不会**把它当上游失败去轮换，而是停下来。
    const coordinator = new ScriptedRuntime({
      'coordinator:-': { steps: [{ tool: 'coagent_get_mission', body: {} }] },
    });
    current = await harness({ coordinator, executor: new ScriptedRuntime(EXECUTOR_HAPPY) });
    await current.platform.createMission({
      projectId: 'P',
      missionId: 'M-silent',
      contract: CONTRACT,
    });

    const orchestrator = current.makeOrchestrator();
    const result = await orchestrator.runMission('M-silent', { projectRoot: process.cwd() });

    assert.equal(result.kind, 'stalled');
    assert.match((result as { reason: string }).reason, /没有做任何结构化提交/);
    assert.equal(orchestrator.hops.length, 2, '连着两次就停，不要一直烧');
    for (const hop of orchestrator.hops) {
      assert.equal(hop.endedBy, 'no_structured_result');
    }
  });

  test('平台守卫在真实 HTTP 上生效：没 Plan 建工作项会被拒', async () => {
    const coordinator = new ScriptedRuntime({
      'coordinator:-:0': {
        steps: [
          { tool: 'coagent_get_mission', body: {} },
          // 故意跳过 update_plan
          { tool: 'coagent_create_work_item', body: { title: 'W', ...ORDER }, expectFailure: true },
          { tool: 'coagent_update_plan', body: PLAN },
          { tool: 'coagent_create_work_item', body: { title: 'W', ...ORDER } },
          {
            tool: 'coagent_dispatch_work_item',
            body: (previous) => ({ workItemIds: [previous.workItemId] }),
          },
        ],
      },
      'coordinator:-:1': COORDINATOR_HAPPY['coordinator:-:1'],
    });
    current = await harness({ coordinator, executor: new ScriptedRuntime(EXECUTOR_HAPPY) });
    await current.platform.createMission({
      projectId: 'P',
      missionId: 'M-guard',
      contract: CONTRACT,
    });

    const result = await current.makeOrchestrator().runMission('M-guard', { projectRoot: process.cwd() });
    assert.deepEqual(result, { kind: 'awaiting_l3_review' });

    const rejected = coordinator.transcript.find(
      (entry) => entry.tool === 'coagent_create_work_item' && entry.status === 409,
    );
    assert.ok(rejected, '没 Plan 的那次必须被平台挡下');
    assert.equal((rejected.json as { error: string }).error, 'PLAN_REQUIRED');
  });
});

const CAP_NOW = '2026-01-01T00:00:00.000Z';

function capLimits(overrides: Partial<HopCapacityLimits> = {}): HopCapacityLimits {
  return hopCapacityLimits({ global: 8, project: 8, role: 8, runtime: 8, profile: 8, ...overrides });
}

function memoryCapacityRepo(rows: QueuedHop[]): QueuedHopCapacityRepository {
  return {
    async enqueue(hop) {
      const existing = rows.find((row) => row.idempotencyKey === hop.idempotencyKey);
      if (existing) return { ...existing };
      rows.push({ ...hop });
      return { ...hop };
    },
    async get(id) {
      const row = rows.find((item) => item.id === id);
      return row ? { ...row } : undefined;
    },
    async list() {
      return rows.map((row) => ({ ...row }));
    },
    async claim(id, owner, now, until) {
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return undefined;
      const updated = claimHop(rows[index]!, owner, now, until);
      if (updated) rows[index] = updated;
      return updated ? { ...updated } : undefined;
    },
    async renew(id, owner, generation, now, until) {
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return undefined;
      const updated = renewHop(rows[index]!, owner, generation, now, until);
      if (updated) rows[index] = updated;
      return updated ? { ...updated } : undefined;
    },
    async complete(id, owner, generation, now) {
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return undefined;
      const updated = completeHop(rows[index]!, owner, generation, now);
      if (updated) rows[index] = updated;
      return updated ? { ...updated } : undefined;
    },
    async reportFailure(input) {
      const index = rows.findIndex((row) => row.id === input.id);
      if (index < 0) return undefined;
      const current = rows[index]!;
      const updated = reportHopFailure(current, input);
      if (!updated) return undefined;
      if (updated !== current) rows[index] = updated;
      return updated.lastFailure
        ? { ...updated, lastFailure: { ...updated.lastFailure } }
        : { ...updated };
    },
    async claimAvailable(input) {
      const decision = decideCapacityClaim(rows, input.now, input.limits, input.eligible);
      if (decision.kind !== 'select') return decision;
      const updated = claimHopWithCandidate(
        decision.hop,
        input.owner,
        input.now,
        input.leaseUntil,
        decision.candidate,
      );
      if (!updated) return { kind: 'empty' as const };
      const index = rows.findIndex((row) => row.id === updated.id);
      if (index >= 0) rows[index] = updated;
      return { kind: 'claimed' as const, hop: { ...updated } };
    },
  };
}

function queuedCompetitor(overrides: Partial<QueuedHop> & Pick<QueuedHop, 'id'>): QueuedHop {
  return {
    projectId: 'P',
    missionId: 'M-ahead',
    workItemId: '-',
    role: 'coordinator',
    priority: 0,
    availableAt: CAP_NOW,
    attemptCount: 0,
    maxAttempts: 3,
    idempotencyKey: overrides.id,
    status: 'queued',
    runtimeKind: 'scripted',
    profileId: 'coordinator-a',
    createdAt: '2025-12-01T00:00:00.000Z',
    updatedAt: '2025-12-01T00:00:00.000Z',
    ...overrides,
  };
}

function occupyingLease(overrides: Partial<QueuedHop> & Pick<QueuedHop, 'id'>): QueuedHop {
  return {
    projectId: 'P',
    missionId: 'M-hold',
    workItemId: '-',
    role: 'executor',
    priority: 1,
    availableAt: CAP_NOW,
    attemptCount: 0,
    maxAttempts: 3,
    idempotencyKey: overrides.id,
    status: 'claimed',
    owner: 'holder',
    leaseUntil: '2026-01-01T01:00:00.000Z',
    claimGeneration: 1,
    runtimeKind: 'scripted',
    profileId: 'qwen',
    createdAt: CAP_NOW,
    updatedAt: CAP_NOW,
    ...overrides,
  };
}

function trackingStarts(
  inner: AgentRuntime,
  log: { role: string; profileId: string; missionId?: string }[],
): AgentRuntime {
  return {
    kind: inner.kind,
    start: async (spec) => {
      log.push({ role: spec.role, profileId: spec.profile.profileId, missionId: spec.missionId });
      return inner.start(spec);
    },
  };
}

const COORDINATOR_TOUCH: ScriptTable = {
  'coordinator:-:0': { steps: [{ tool: 'coagent_get_mission', body: {} }] },
};

function attachCapacityOrchestrator(
  env: Awaited<ReturnType<typeof capacityHarness>>,
  opts: {
    queuedHops: QueuedHopCapacityRepository;
    hopClock: FixedClock;
    hopCapacityLimits?: HopCapacityLimits;
    owner: string;
    starts: { role: string; profileId: string; missionId?: string }[];
    coordinatorCandidates?: { endpoint: 'local'; profileId: string }[];
    coordinatorScript?: ScriptTable;
  },
) {
  return new Orchestrator({
    platform: env.platform,
    tokens: makeIssuer(env.platform, env.tokens),
    baseUrl: env.baseUrl,
    workspace: new InPlaceWorkspaceManager(),
    coordinator: {
      runtime: trackingStarts(
        new ScriptedRuntime(opts.coordinatorScript ?? COORDINATOR_TOUCH),
        opts.starts,
      ),
      candidates: opts.coordinatorCandidates ?? [{ endpoint: 'local', profileId: 'coordinator-a' }],
    },
    executor: {
      runtime: trackingStarts(new ScriptedRuntime(EXECUTOR_HAPPY), opts.starts),
      candidates: [
        { endpoint: 'local', profileId: 'exec-a' },
        { endpoint: 'local', profileId: 'exec-b' },
      ],
    },
    queuedHops: opts.queuedHops,
    hopClock: opts.hopClock,
    hopLeaseMs: 60_000,
    hopCapacityLimits: opts.hopCapacityLimits,
    owner: opts.owner,
  });
}

async function capacityHarness(opts: {
  coordinator: AgentRuntime;
  executor: AgentRuntime;
  coordinatorCandidates?: { endpoint: 'local'; profileId: string }[];
  executorCandidates?: { endpoint: 'local'; profileId: string }[];
  executorMaxAttempts?: number;
  independentReviewer?: { runtime: AgentRuntime; candidates: { endpoint: 'local'; profileId: string }[] };
  queuedHops: QueuedHopCapacityRepository;
  hopClock: { now(): Date };
  hopLeaseMs?: number;
  hopCapacityLimits?: HopCapacityLimits;
  inRunBackoffWaitMs?: number;
  attemptWallClockMs?: number;
  owner?: string;
  candidateCircuits?: CandidateCircuitRepository;
}) {
  const clock = new FixedClock(CAP_NOW);
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    workspace: new InPlaceWorkspaceManager(),
    activity,
    clock,
    ids,
    transaction: createMemoryFencedTransaction(opts.queuedHops),
  });
  const tokens = new RunTokenRegistry();
  const server: Server = createApi({ platform, tokens, deliveries });
  await listenLoopback(server, 0);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);
  const deps = {
    platform,
    tokens: makeIssuer(platform, tokens),
    baseUrl,
    workspace: new InPlaceWorkspaceManager(),
    coordinator: {
      runtime: opts.coordinator,
      candidates: opts.coordinatorCandidates ?? [{ endpoint: 'local' as const, profileId: 'coordinator-a' }],
    },
    executor: {
      runtime: opts.executor,
      candidates: opts.executorCandidates ?? [
        { endpoint: 'local' as const, profileId: 'exec-a' },
        { endpoint: 'local' as const, profileId: 'exec-b' },
      ],
      maxAttempts: opts.executorMaxAttempts,
    },
    independentReviewer: opts.independentReviewer,
    queuedHops: opts.queuedHops,
    hopClock: opts.hopClock,
    hopLeaseMs: opts.hopLeaseMs ?? 60_000,
    hopCapacityLimits: opts.hopCapacityLimits,
    inRunBackoffWaitMs: opts.inRunBackoffWaitMs,
    attemptWallClockMs: opts.attemptWallClockMs,
    owner: opts.owner ?? 'runner-cap',
    candidateCircuits: opts.candidateCircuits,
  };
  return {
    platform,
    tokens,
    baseUrl,
    makeOrchestrator: () => new Orchestrator(deps),
  };
}

describe('调度器：持久五维容量租约守住 Agent 启动',
  () => {
    test('构造时拒绝非法上限，缺队列夹具不碰容量仓储',
      () => {
        const base = {
          platform: {} as Platform,
          tokens: {
            startCoordinator: async () => ({ attemptId: 'a', token: 't' }),
            startExecutor: async () => ({ attemptId: 'a', token: 't' }),
            revoke() {},
          },
          baseUrl: 'http://127.0.0.1:9',
          workspace: new InPlaceWorkspaceManager(),
          coordinator: {
            runtime: new ScriptedRuntime({}),
            candidates: [{ endpoint: 'local' as const, profileId: 'c' }],
          },
          executor: {
            runtime: new ScriptedRuntime({}),
            candidates: [{ endpoint: 'local' as const, profileId: 'e' }],
          },
        };
        assert.throws(
          () =>
            new Orchestrator({
              ...base,
              hopCapacityLimits: { global: 0, project: 2, role: 4, runtime: 4, profile: 2 },
            }),
          /positive safe integer/,
        );
        const orch = new Orchestrator(base);
        assert.ok(orch);
      });

    test('五维 runtime 满额不启动，完成或过期后可继续',
      async () => {
        const rows: QueuedHop[] = [
          occupyingLease({ id: 'hold-rt', runtimeKind: 'scripted', profileId: 'other' }),
        ];
        const queuedHops = memoryCapacityRepo(rows);
        const hopClock = new FixedClock(CAP_NOW);
        const starts: { role: string; profileId: string }[] = [];
        const env = await capacityHarness({
          coordinator: trackingStarts(new ScriptedRuntime(COORDINATOR_HAPPY), starts),
          executor: trackingStarts(new ScriptedRuntime(EXECUTOR_HAPPY), starts),
          queuedHops,
          hopClock,
          hopCapacityLimits: capLimits({ runtime: 1 }),
        });
        await env.platform.createMission({ projectId: 'P', missionId: 'M-rt', contract: CONTRACT });
        const blocked = await env.makeOrchestrator().runMission('M-rt', { projectRoot: process.cwd() });
        assert.equal(blocked.kind, 'waiting');
        assert.equal((blocked as { reason: string }).reason, 'project_busy');
        assert.match((blocked as { detail: string }).detail, /容量/);
        assert.equal(starts.length, 0);
        const ours = (await queuedHops.list()).find((row) => row.missionId === 'M-rt');
        assert.equal(ours?.status, 'queued');
        assert.equal(ours?.runtimeKind, undefined);
        assert.equal(rows.find((row) => row.id === 'hold-rt')?.status, 'claimed');

        const finished = completeHop(
          rows.find((row) => row.id === 'hold-rt')!,
          'holder',
          1,
          CAP_NOW,
        );
        assert.ok(finished);
        const holdIndex = rows.findIndex((row) => row.id === 'hold-rt');
        rows[holdIndex] = finished!;

        starts.length = 0;
        const afterComplete = await env.makeOrchestrator().runMission('M-rt', {
          projectRoot: process.cwd(),
        });
        assert.deepEqual(afterComplete, { kind: 'awaiting_l3_review' });
        assert.ok(starts.some((row) => row.role === 'coordinator'));
        assert.ok(starts.some((row) => row.role === 'executor'));

        const expRows: QueuedHop[] = [
          occupyingLease({
            id: 'hold-exp',
            runtimeKind: 'scripted',
            profileId: 'other',
            leaseUntil: '2026-01-01T00:00:01.000Z',
          }),
        ];
        const expRepo = memoryCapacityRepo(expRows);
        const expClock = new FixedClock(CAP_NOW);
        const expStarts: { role: string; profileId: string }[] = [];
        const expEnv = await capacityHarness({
          coordinator: trackingStarts(new ScriptedRuntime(COORDINATOR_HAPPY), expStarts),
          executor: trackingStarts(new ScriptedRuntime(EXECUTOR_HAPPY), expStarts),
          queuedHops: expRepo,
          hopClock: expClock,
          hopCapacityLimits: capLimits({ runtime: 1 }),
        });
        await expEnv.platform.createMission({ projectId: 'P', missionId: 'M-exp', contract: CONTRACT });
        const stillBlocked = await expEnv.makeOrchestrator().runMission('M-exp', {
          projectRoot: process.cwd(),
        });
        assert.equal(stillBlocked.kind, 'waiting');
        assert.equal(expStarts.length, 0);
        expClock.advance(2000);
        const afterExpire = await expEnv.makeOrchestrator().runMission('M-exp', {
          projectRoot: process.cwd(),
        });
        assert.deepEqual(afterExpire, { kind: 'awaiting_l3_review' });
        assert.ok(expStarts.length > 0);
      });

    test('公平跳过满额候选；阻塞者仍 queued 且 runtime.start 未调用',
      async () => {
        const rows: QueuedHop[] = [
          occupyingLease({
            id: 'hold-a',
            role: 'executor',
            runtimeKind: 'scripted',
            profileId: 'exec-a',
          }),
        ];
        const queuedHops = memoryCapacityRepo(rows);
        const starts: { role: string; profileId: string }[] = [];
        const env = await capacityHarness({
          coordinator: trackingStarts(new ScriptedRuntime(COORDINATOR_HAPPY), starts),
          executor: trackingStarts(new ScriptedRuntime(EXECUTOR_HAPPY), starts),
          queuedHops,
          hopClock: new FixedClock(CAP_NOW),
          hopCapacityLimits: capLimits({ profile: 1 }),
        });
        await env.platform.createMission({ projectId: 'P', missionId: 'M-skip', contract: CONTRACT });
        const result = await env.makeOrchestrator().runMission('M-skip', { projectRoot: process.cwd() });
        assert.deepEqual(result, { kind: 'awaiting_l3_review' });
        assert.equal(
          starts.filter((row) => row.role === 'executor' && row.profileId === 'exec-a').length,
          0,
        );
        assert.ok(starts.some((row) => row.role === 'executor' && row.profileId === 'exec-b'));
        const execHop = (await queuedHops.list()).find(
          (row) => row.missionId === 'M-skip' && row.role === 'executor',
        );
        assert.equal(execHop?.profileId, 'exec-b');
        assert.equal(execHop?.runtimeKind, 'scripted');
        assert.equal(rows.find((row) => row.id === 'hold-a')?.status, 'claimed');
        assert.equal(rows.find((row) => row.id === 'hold-a')?.profileId, 'exec-a');

        const waitRows: QueuedHop[] = [
          occupyingLease({ id: 'hold-all', runtimeKind: 'scripted', profileId: 'coordinator-a' }),
        ];
        const waitRepo = memoryCapacityRepo(waitRows);
        const waitStarts: { role: string; profileId: string }[] = [];
        const waitEnv = await capacityHarness({
          coordinator: trackingStarts(new ScriptedRuntime(COORDINATOR_HAPPY), waitStarts),
          executor: trackingStarts(new ScriptedRuntime(EXECUTOR_HAPPY), waitStarts),
          queuedHops: waitRepo,
          hopClock: new FixedClock(CAP_NOW),
          hopCapacityLimits: capLimits({ profile: 1 }),
        });
        await waitEnv.platform.createMission({
          projectId: 'P',
          missionId: 'M-wait',
          contract: CONTRACT,
        });
        const waiting = await waitEnv.makeOrchestrator().runMission('M-wait', {
          projectRoot: process.cwd(),
        });
        assert.equal(waiting.kind, 'waiting');
        assert.match((waiting as { detail: string }).detail, /容量/);
        assert.equal(waitStarts.length, 0);
        const blocked = (await waitRepo.list()).find((row) => row.missionId === 'M-wait');
        assert.equal(blocked?.status, 'queued');
      });

    test('失败换候选不得拿 A 的租约启动 B',
      async () => {
        const rows: QueuedHop[] = [];
        const queuedHops = memoryCapacityRepo(rows);
        const executor = new ScriptedRuntime({
          'executor:W-1:0': { steps: [], upstreamFailure: '403 需要充值' },
          'executor:W-1:1': EXECUTOR_HAPPY['executor:W-1'],
        });
        const starts: { role: string; profileId: string }[] = [];
        const env = await capacityHarness({
          coordinator: trackingStarts(new ScriptedRuntime(COORDINATOR_HAPPY), starts),
          executor: {
            kind: executor.kind,
            start: async (spec) => {
              starts.push({ role: spec.role, profileId: spec.profile.profileId });
              if (spec.role === 'executor') {
                const live = (await queuedHops.list()).filter(
                  (row) =>
                    row.missionId === spec.missionId &&
                    row.role === 'executor' &&
                    row.status === 'claimed',
                );
                assert.ok(live.length > 0, '启动前必须有持久租约');
                for (const hop of live) {
                  assert.equal(hop.profileId, spec.profile.profileId, '不得用 A 的租约启动 B');
                  assert.equal(hop.runtimeKind, 'scripted');
                }
              }
              return executor.start(spec);
            },
          },
          queuedHops,
          hopClock: new FixedClock(CAP_NOW),
          hopCapacityLimits: capLimits(),
        });
        await env.platform.createMission({
          projectId: 'P',
          missionId: 'M-fail',
          contract: CONTRACT,
        });
        const result = await env.makeOrchestrator().runMission('M-fail', { projectRoot: process.cwd() });
        assert.equal(result.kind, 'waiting');
        if (result.kind === 'waiting') {
          assert.equal(result.reason, 'project_busy');
          assert.match(result.detail, /退避/);
        }
        const execStarts = starts.filter((row) => row.role === 'executor');
        assert.deepEqual(
          execStarts.map((row) => row.profileId),
          ['exec-a'],
        );
        const execHops = (await queuedHops.list()).filter(
          (row) => row.missionId === 'M-fail' && row.role === 'executor',
        );
        assert.equal(execHops.length, 1, '失败不得另开槽启动 B');
        assert.equal(execHops[0]?.profileId, 'exec-a');
        assert.equal(execHops[0]?.status, 'retry_wait');
        assert.equal(execHops[0]?.attemptCount, 1);
      });

    test('项目名额：协调者可入，executor 平台闸门仍是 PROJECT_BUSY',
      async () => {
        const rows: QueuedHop[] = [];
        const queuedHops = memoryCapacityRepo(rows);
        const hopClock = new FixedClock(CAP_NOW);
        const planAndDispatch: ScriptTable = {
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
        };
        const env = await capacityHarness({
          coordinator: new ScriptedRuntime(planAndDispatch),
          executor: new ScriptedRuntime({}),
          queuedHops,
          hopClock,
          hopCapacityLimits: capLimits(),
        });
        await env.platform.createMission({ projectId: 'P', missionId: 'A', contract: CONTRACT });
        await env.platform.createMission({ projectId: 'P', missionId: 'B', contract: CONTRACT });
        await env.makeOrchestrator().runMission('A', { projectRoot: process.cwd(), maxRounds: 1 });
        assert.equal((await env.platform.getMissionView('A')).isMutating, true);

        const bStarts: { role: string; profileId: string }[] = [];
        const bOrch = new Orchestrator({
          platform: env.platform,
          tokens: makeIssuer(env.platform, env.tokens),
          baseUrl: env.baseUrl,
          workspace: new InPlaceWorkspaceManager(),
          coordinator: {
            runtime: trackingStarts(new ScriptedRuntime(planAndDispatch), bStarts),
            candidates: [{ endpoint: 'local', profileId: 'coordinator-a' }],
          },
          executor: {
            runtime: trackingStarts(new ScriptedRuntime({}), bStarts),
            candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
          },
          queuedHops,
          hopClock,
          hopCapacityLimits: capLimits(),
          owner: 'runner-b',
        });
        const outcome = await bOrch.runMission('B', { projectRoot: process.cwd(), maxRounds: 2 });
        assert.equal(outcome.kind, 'waiting');
        assert.equal((outcome as { reason: string }).reason, 'project_busy');
        assert.doesNotMatch((outcome as { detail: string }).detail, /容量/);
        assert.ok(bStarts.some((row) => row.role === 'coordinator'));
        assert.equal(bStarts.filter((row) => row.role === 'executor').length, 0);
        const bView = await env.platform.getMissionView('B');
        assert.equal(bView.planRevision, 1);
        assert.equal(bView.isMutating, false);
        assert.equal(bView.workItems[0]?.status, 'created');
        assert.equal(bView.waitReason, 'project_busy');
        assert.match(bView.waitDetail ?? '', /A/);
        assert.doesNotMatch(bView.waitDetail ?? '', /容量/);
      });

    test('HA 独立检视占位与 startIndependentReviewer 返回的候选一致',
      async () => {
        const hopClock = new FixedClock(CAP_NOW);
        const rows: QueuedHop[] = [
          occupyingLease({
            id: 'hold-ir',
            role: 'independent_reviewer',
            runtimeKind: 'scripted',
            profileId: 'ir-a',
          }),
        ];
        const queuedHops = memoryCapacityRepo(rows);
        const clock = new FixedClock(CAP_NOW);
        const projects = new InMemoryProjectRepository();
        const ids = new SequentialIds();
        const reports = new InMemoryValidationReportRepository();
        const workspace: WorkspaceManager = {
          async prepare(_missionId, projectRoot) {
            return {
              cwd: projectRoot,
              branch: 'mission/M-ha',
              targetBranch: 'master',
              baseRevision: 'commit-a',
            };
          },
          async head() { return 'commit-a'; },
          async targetHead() { return 'commit-a'; },
          worktreePath(_missionId, projectRoot) { return projectRoot; },
          async rollback() {},
          async mergeToTarget() { return { ok: true, mergedInto: 'commit-a' }; },
          async diff() { return { stat: '', files: [] }; },
          async release() {},
        };
        const validation = {
          reports,
          engine: {
            async validate(input: { missionId: string }) {
              const id = ids.next('VR');
              const report = {
                id,
                policyRevision: 1,
                missionId: input.missionId,
                startedAt: CAP_NOW,
                endedAt: CAP_NOW,
                passed: true,
                checks: [
                  {
                    kind: 'command' as const,
                    passed: true,
                    startedAt: CAP_NOW,
                    endedAt: CAP_NOW,
                    summary: 'ok',
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
        const deliveries = new InMemoryDeliveryRepository(clock, ids);
        const platform = new Platform({
          projects,
          deliveries,
          activity: new InMemoryActivityLog(clock),
          clock,
          ids,
          workspace,
          validation,
          transaction: createMemoryFencedTransaction(queuedHops),
        });
        const project = await projects.ensure('P');
        project.createMission({
          id: 'M-ha',
          contract: {
            ...CONTRACT,
            acceptance: ['foo() === 1'],
          },
          executionMode: 'high_assurance',
        });
        await projects.save(project);
        const root = mkdtempSync(join(tmpdir(), 'coagent-w59-ha-'));
        const prepared = await workspace.prepare('M-ha', root);
        await platform.recordWorkspace('M-ha', {
          projectRoot: root,
          branch: prepared.branch,
          baseRevision: prepared.baseRevision,
        });
        const haOrder = {
          ...ORDER,
          validation: { commands: [{ argv: ['node', '--test'], timeoutMs: 1000 }] },
        };
        const coord = await platform.startCoordinatorAttempt('M-ha', {
          profileId: 'coord-a',
          endpoint: 'local',
        });
        await platform.updatePlan('M-ha', coord.attemptId, PLAN);
        const { workItemId } = await platform.createWorkItem('M-ha', coord.attemptId, {
          title: '修 foo',
          order: haOrder,
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
          acceptanceResults: haOrder.acceptance.map((criterion) => ({
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

        const tokens = new RunTokenRegistry();
        const server: Server = createApi({ platform, tokens, deliveries });
        await listenLoopback(server, 0);
        servers.push(server);
        const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const irStarts: { role: string; profileId: string }[] = [];
        const irRuntime = trackingStarts(
          new ScriptedRuntime({
            'independent_reviewer:-': {
              steps: [
                { tool: 'coagent_get_mission_review_bundle', body: {} },
                {
                  tool: 'coagent_submit_independent_review',
                  body: { verdict: 'pass', reasons: ['齐'] },
                },
              ],
            },
          }),
          irStarts,
        );
        const orch = new Orchestrator({
          platform,
          tokens: makeIssuer(platform, tokens),
          baseUrl,
          workspace,
          coordinator: {
            runtime: new ScriptedRuntime({}),
            candidates: [{ endpoint: 'local', profileId: 'coord-a' }],
          },
          executor: {
            runtime: new ScriptedRuntime({}),
            candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
          },
          independentReviewer: {
            runtime: irRuntime,
            candidates: [
              { endpoint: 'local', profileId: 'ir-a' },
              { endpoint: 'local', profileId: 'ir-b' },
            ],
          },
          queuedHops,
          hopClock,
          hopCapacityLimits: capLimits({ profile: 1 }),
          owner: 'runner-ha',
        });
        const outcome = await orch.runMission('M-ha', { projectRoot: root });
        assert.equal(outcome.kind, 'awaiting_l3_review');
        assert.deepEqual(irStarts, [{ role: 'independent_reviewer', profileId: 'ir-b', missionId: 'M-ha' }]);
        const irHop = (await queuedHops.list()).find(
          (row) => row.missionId === 'M-ha' && row.role === 'independent_reviewer',
        );
        assert.equal(irHop?.profileId, 'ir-b');
        assert.equal(irHop?.runtimeKind, 'scripted');
        assert.notEqual(irHop?.profileId, 'ir-a');
        rmSync(root, { recursive: true, force: true });
      });

    test('runtime.start 抛错后须释放 A 的租约再按 B 的身份领取，且不得无限换票',
      async () => {
        const rows: QueuedHop[] = [];
        const queuedHops = memoryCapacityRepo(rows);
        const happy = new ScriptedRuntime(EXECUTOR_HAPPY);
        const starts: { role: string; profileId: string }[] = [];
        let aStartCalls = 0;
        const env = await capacityHarness({
          coordinator: trackingStarts(new ScriptedRuntime(COORDINATOR_HAPPY), starts),
          executor: {
            kind: happy.kind,
            start: async (spec) => {
              starts.push({ role: spec.role, profileId: spec.profile.profileId });
              if (spec.role === 'executor' && spec.profile.profileId === 'exec-a') {
                aStartCalls += 1;
                const live = (await queuedHops.list()).filter(
                  (row) =>
                    row.missionId === spec.missionId &&
                    row.role === 'executor' &&
                    row.status === 'claimed',
                );
                assert.equal(live.length, 1);
                assert.equal(live[0]?.profileId, 'exec-a');
                throw new Error('403 需要充值');
              }
              throw new Error(`不得启动另一候选 ${spec.profile.profileId}`);
            },
          },
          queuedHops,
          hopClock: new FixedClock(CAP_NOW),
          hopCapacityLimits: capLimits(),
        });
        await env.platform.createMission({
          projectId: 'P',
          missionId: 'M-throw',
          contract: CONTRACT,
        });
        const result = await env.makeOrchestrator().runMission('M-throw', {
          projectRoot: process.cwd(),
        });
        assert.equal(result.kind, 'waiting');
        assert.equal(aStartCalls, 1, '抛错不得反复替换同一候选');
        const execStarts = starts.filter((row) => row.role === 'executor');
        assert.deepEqual(
          execStarts.map((row) => row.profileId),
          ['exec-a'],
        );
        const execHops = (await queuedHops.list()).filter(
          (row) => row.missionId === 'M-throw' && row.role === 'executor',
        );
        assert.equal(execHops.length, 1, '失败不得另开槽，不得无限换票');
        assert.equal(execHops[0]?.profileId, 'exec-a');
        assert.equal(execHops[0]?.status, 'retry_wait');
        assert.equal(execHops[0]?.attemptCount, 1);
      });

    test('优先级与同级 FIFO 按 H→A→B 实际领取启动，阻塞 A→B→A 释放后继续',
      async () => {
        const coordKey = (missionId: string) =>
          hopIdempotencyKey({
            missionId,
            role: 'coordinator',
            workItemId: '-',
            contractRevision: 1,
            attemptCycle: 0,
          });
        const fifoRows: QueuedHop[] = [
          queuedCompetitor({
            id: 'H',
            missionId: 'M-H',
            priority: 50,
            createdAt: '2025-12-01T00:00:00.000Z',
            idempotencyKey: coordKey('M-H'),
            runtimeKind: 'scripted',
            profileId: 'coordinator-a',
          }),
          queuedCompetitor({
            id: 'A',
            missionId: 'M-A',
            priority: 0,
            createdAt: '2025-12-15T00:00:00.000Z',
            idempotencyKey: coordKey('M-A'),
            runtimeKind: 'scripted',
            profileId: 'coordinator-a',
          }),
          queuedCompetitor({
            id: 'B',
            missionId: 'M-B',
            priority: 0,
            createdAt: '2025-12-31T00:00:00.000Z',
            idempotencyKey: coordKey('M-B'),
            runtimeKind: 'scripted',
            profileId: 'coordinator-a',
          }),
        ];
        const fifoRepo = memoryCapacityRepo(fifoRows);
        const hopClock = new FixedClock(CAP_NOW);
        const fifoEnv = await capacityHarness({
          coordinator: new ScriptedRuntime(COORDINATOR_TOUCH),
          executor: new ScriptedRuntime(EXECUTOR_HAPPY),
          queuedHops: fifoRepo,
          hopClock,
          hopCapacityLimits: capLimits(),
          owner: 'runner-seq',
        });
        for (const missionId of ['M-H', 'M-A', 'M-B'] as const) {
          await fifoEnv.platform.createMission({ projectId: 'P', missionId, contract: CONTRACT });
        }
        const startsH: { role: string; profileId: string; missionId?: string }[] = [];
        const startsA: { role: string; profileId: string; missionId?: string }[] = [];
        const startsB: { role: string; profileId: string; missionId?: string }[] = [];
        const orchH = attachCapacityOrchestrator(fifoEnv, {
          queuedHops: fifoRepo, hopClock, hopCapacityLimits: capLimits(), owner: 'runner-H', starts: startsH,
        });
        const orchA = attachCapacityOrchestrator(fifoEnv, {
          queuedHops: fifoRepo, hopClock, hopCapacityLimits: capLimits(), owner: 'runner-A', starts: startsA,
        });
        const orchB = attachCapacityOrchestrator(fifoEnv, {
          queuedHops: fifoRepo, hopClock, hopCapacityLimits: capLimits(), owner: 'runner-B', starts: startsB,
        });
        const firstB = await orchB.runMission('M-B', { projectRoot: process.cwd(), maxRounds: 1 });
        assert.equal(firstB.kind, 'waiting');
        assert.equal(startsB.length, 0);
        assert.equal(fifoRows.find((row) => row.id === 'H')?.status, 'queued');
        assert.equal(fifoRows.find((row) => row.id === 'A')?.status, 'queued');
        assert.equal(fifoRows.find((row) => row.id === 'B')?.status, 'queued');

        await orchH.runMission('M-H', { projectRoot: process.cwd(), maxRounds: 1 });
        assert.deepEqual(
          startsH.filter((row) => row.role === 'coordinator').map((row) => row.missionId),
          ['M-H'],
        );
        assert.equal(fifoRows.find((row) => row.id === 'H')?.status, 'completed');
        assert.equal(fifoRows.find((row) => row.id === 'A')?.status, 'queued');
        assert.equal(fifoRows.find((row) => row.id === 'B')?.status, 'queued');

        await orchA.runMission('M-A', { projectRoot: process.cwd(), maxRounds: 1 });
        assert.deepEqual(
          startsA.filter((row) => row.role === 'coordinator').map((row) => row.missionId),
          ['M-A'],
        );
        assert.equal(fifoRows.find((row) => row.id === 'A')?.status, 'completed');
        assert.equal(fifoRows.find((row) => row.id === 'B')?.status, 'queued');

        await orchB.runMission('M-B', { projectRoot: process.cwd(), maxRounds: 1 });
        assert.deepEqual(
          startsB.filter((row) => row.role === 'coordinator').map((row) => row.missionId),
          ['M-B'],
        );
        assert.equal(fifoRows.find((row) => row.id === 'B')?.status, 'completed');

        const skipRows: QueuedHop[] = [
          occupyingLease({
            id: 'hold-a',
            role: 'coordinator',
            runtimeKind: 'scripted',
            profileId: 'coordinator-a',
          }),
          queuedCompetitor({
            id: 'A-blocked',
            missionId: 'M-block-A',
            role: 'coordinator',
            priority: 0,
            createdAt: '2025-12-01T00:00:00.000Z',
            idempotencyKey: coordKey('M-block-A'),
            runtimeKind: 'scripted',
            profileId: 'coordinator-a',
          }),
        ];
        const skipRepo = memoryCapacityRepo(skipRows);
        const blockClock = new FixedClock(CAP_NOW);
        const skipEnv = await capacityHarness({
          coordinator: new ScriptedRuntime(COORDINATOR_TOUCH),
          executor: new ScriptedRuntime(EXECUTOR_HAPPY),
          queuedHops: skipRepo,
          hopClock: blockClock,
          hopCapacityLimits: capLimits({ profile: 1 }),
          owner: 'runner-block',
        });
        await skipEnv.platform.createMission({ projectId: 'P', missionId: 'M-block-A', contract: CONTRACT });
        await skipEnv.platform.createMission({ projectId: 'P', missionId: 'M-block-B', contract: CONTRACT });
        const blockStartsA: { role: string; profileId: string; missionId?: string }[] = [];
        const blockStartsB: { role: string; profileId: string; missionId?: string }[] = [];
        const orchBlockA = attachCapacityOrchestrator(skipEnv, {
          queuedHops: skipRepo, hopClock: blockClock, hopCapacityLimits: capLimits({ profile: 1 }),
          owner: 'runner-block-A', starts: blockStartsA,
        });
        const orchBlockB = attachCapacityOrchestrator(skipEnv, {
          queuedHops: skipRepo, hopClock: blockClock, hopCapacityLimits: capLimits({ profile: 1 }),
          owner: 'runner-block-B', starts: blockStartsB,
          coordinatorCandidates: [{ endpoint: 'local', profileId: 'coordinator-b' }],
        });
        const blockedA = await orchBlockA.runMission('M-block-A', { projectRoot: process.cwd(), maxRounds: 1 });
        assert.equal(blockedA.kind, 'waiting');
        assert.equal(blockStartsA.length, 0);
        assert.equal(skipRows.find((row) => row.id === 'A-blocked')?.status, 'queued');

        await orchBlockB.runMission('M-block-B', { projectRoot: process.cwd(), maxRounds: 1 });
        assert.deepEqual(
          blockStartsB.filter((row) => row.role === 'coordinator').map((row) => row.missionId),
          ['M-block-B'],
        );
        assert.equal(blockStartsB[0]?.profileId, 'coordinator-b');
        assert.equal(skipRows.find((row) => row.id === 'A-blocked')?.status, 'queued');
        assert.equal(skipRows.find((row) => row.id === 'hold-a')?.status, 'claimed');

        const holdIdx = skipRows.findIndex((row) => row.id === 'hold-a');
        const released = completeHop(skipRows[holdIdx]!, 'holder', 1, CAP_NOW);
        assert.ok(released);
        skipRows[holdIdx] = released!;
        await orchBlockA.runMission('M-block-A', { projectRoot: process.cwd(), maxRounds: 1 });
        assert.deepEqual(
          blockStartsA.filter((row) => row.role === 'coordinator').map((row) => row.missionId),
          ['M-block-A'],
        );
        assert.equal(skipRows.find((row) => row.id === 'A-blocked')?.status, 'completed');

        const lowRows: QueuedHop[] = [
          queuedCompetitor({
            id: 'H-high',
            missionId: 'M-high',
            priority: 50,
            createdAt: '2025-12-01T00:00:00.000Z',
            runtimeKind: 'scripted',
            profileId: 'other',
          }),
        ];
        const lowRepo = memoryCapacityRepo(lowRows);
        const lowStarts: { role: string; profileId: string }[] = [];
        const lowEnv = await capacityHarness({
          coordinator: trackingStarts(new ScriptedRuntime(COORDINATOR_HAPPY), lowStarts),
          executor: trackingStarts(new ScriptedRuntime(EXECUTOR_HAPPY), lowStarts),
          queuedHops: lowRepo,
          hopClock: new FixedClock(CAP_NOW),
          hopCapacityLimits: capLimits(),
          owner: 'runner-low',
        });
        await lowEnv.platform.createMission({
          projectId: 'P',
          missionId: 'M-low',
          contract: CONTRACT,
        });
        const lowOutcome = await lowEnv.makeOrchestrator().runMission('M-low', {
          projectRoot: process.cwd(),
        });
        assert.equal(lowOutcome.kind, 'waiting');
        assert.equal(lowStarts.length, 0);
        assert.equal((await lowRepo.list()).find((row) => row.missionId === 'M-low')?.status, 'queued');
        assert.equal(lowRows.find((row) => row.id === 'H-high')?.status, 'queued');
      });

    test('list 与 claimAvailable 之间占用变化不得领走外 hop、不得留下 stranded 租约',
      async () => {
        const coordKey = (missionId: string) =>
          hopIdempotencyKey({
            missionId,
            role: 'coordinator',
            workItemId: '-',
            contractRevision: 1,
            attemptCycle: 0,
          });
        const rows: QueuedHop[] = [
          queuedCompetitor({
            id: 'F-foreign',
            missionId: 'M-foreign',
            priority: 50,
            createdAt: '2025-12-01T00:00:00.000Z',
            idempotencyKey: coordKey('M-foreign'),
            runtimeKind: 'scripted',
            profileId: 'coordinator-a',
          }),
          occupyingLease({
            id: 'hold-race',
            role: 'coordinator',
            runtimeKind: 'scripted',
            profileId: 'coordinator-a',
          }),
        ];
        const inner = memoryCapacityRepo(rows);
        let flipped = false;
        const queuedHops: QueuedHopCapacityRepository = {
          enqueue: (hop) => inner.enqueue(hop),
          get: (id) => inner.get(id),
          list: () => inner.list(),
          claim: (id, owner, now, until) => inner.claim(id, owner, now, until),
          renew: (id, owner, generation, now, until) => inner.renew(id, owner, generation, now, until),
          complete: (id, owner, generation, now) => inner.complete(id, owner, generation, now),
          async claimAvailable(input) {
            if (!flipped) {
              flipped = true;
              const idx = rows.findIndex((row) => row.id === 'hold-race');
              const finished = completeHop(rows[idx]!, 'holder', 1, CAP_NOW);
              assert.ok(finished);
              rows[idx] = finished!;
            }
            return inner.claimAvailable(input);
          },
        };
        const starts: { role: string; profileId: string; missionId?: string }[] = [];
        const env = await capacityHarness({
          coordinator: trackingStarts(new ScriptedRuntime(COORDINATOR_TOUCH), starts),
          executor: trackingStarts(new ScriptedRuntime(EXECUTOR_HAPPY), starts),
          coordinatorCandidates: [{ endpoint: 'local', profileId: 'coordinator-b' }],
          queuedHops,
          hopClock: new FixedClock(CAP_NOW),
          hopCapacityLimits: capLimits({ profile: 1 }),
          owner: 'runner-race',
        });
        await env.platform.createMission({ projectId: 'P', missionId: 'M-race', contract: CONTRACT });
        await env.makeOrchestrator().runMission('M-race', { projectRoot: process.cwd(), maxRounds: 1 });
        const foreign = rows.find((row) => row.id === 'F-foreign');
        assert.equal(foreign?.status, 'queued');
        assert.equal(foreign?.owner, undefined);
        assert.ok(!starts.some((row) => row.missionId === 'M-foreign'));
        const ours = (await queuedHops.list()).find((row) => row.missionId === 'M-race');
        assert.notEqual(ours?.id, 'F-foreign');
        assert.equal(
          rows.filter((row) => row.owner === 'runner-race' && row.id === 'F-foreign').length,
          0,
        );

        const fillRows: QueuedHop[] = [
          queuedCompetitor({
            id: 'F-low',
            missionId: 'M-low-foreign',
            priority: 0,
            createdAt: '2026-06-01T00:00:00.000Z',
            idempotencyKey: coordKey('M-low-foreign'),
            runtimeKind: 'scripted',
            profileId: 'coordinator-a',
          }),
        ];
        const fillInner = memoryCapacityRepo(fillRows);
        let filled = false;
        const fillRepo: QueuedHopCapacityRepository = {
          enqueue: (hop) => fillInner.enqueue(hop),
          get: (id) => fillInner.get(id),
          list: () => fillInner.list(),
          claim: (id, owner, now, until) => fillInner.claim(id, owner, now, until),
          renew: (id, owner, generation, now, until) => fillInner.renew(id, owner, generation, now, until),
          complete: (id, owner, generation, now) => fillInner.complete(id, owner, generation, now),
          async claimAvailable(input) {
            if (!filled) {
              filled = true;
              fillRows.push(
                occupyingLease({
                  id: 'hold-fill',
                  role: 'coordinator',
                  runtimeKind: 'scripted',
                  profileId: 'coordinator-a',
                }),
              );
            }
            return fillInner.claimAvailable(input);
          },
        };
        const fillStarts: { role: string; profileId: string; missionId?: string }[] = [];
        const fillEnv = await capacityHarness({
          coordinator: trackingStarts(new ScriptedRuntime(COORDINATOR_TOUCH), fillStarts),
          executor: trackingStarts(new ScriptedRuntime(EXECUTOR_HAPPY), fillStarts),
          queuedHops: fillRepo,
          hopClock: new FixedClock(CAP_NOW),
          hopCapacityLimits: capLimits({ profile: 1 }),
          owner: 'runner-fill',
        });
        await fillEnv.platform.createMission({ projectId: 'P', missionId: 'M-fill', contract: CONTRACT });
        const fillOutcome = await fillEnv.makeOrchestrator().runMission('M-fill', {
          projectRoot: process.cwd(),
          maxRounds: 1,
        });
        assert.equal(fillOutcome.kind, 'waiting');
        assert.equal(fillStarts.length, 0);
        assert.equal(fillRows.find((row) => row.id === 'F-low')?.status, 'queued');
        assert.equal(fillRows.find((row) => row.id === 'F-low')?.owner, undefined);
        const fillOurs = (await fillRepo.list()).find((row) => row.missionId === 'M-fill');
        assert.equal(fillOurs?.status, 'queued');
        assert.equal(fillOurs?.owner, undefined);
        assert.equal(fillRows.find((row) => row.id === 'hold-fill')?.status, 'claimed');
        assert.equal(fillRows.find((row) => row.owner === 'runner-fill'), undefined);
      });
  });

describe('调度器：失败 Attempt 持久退避与死信', () => {
  const failingExecutor = () =>
    new ScriptedRuntime({
      'executor:W-1': { steps: [], upstreamFailure: 'HTTP 503 Service Unavailable' },
    });

  test('一次可重试失败进入 retry_wait；提前重入无新 Attempt；到期同槽再领后第二次死信',
    async () => {
      const rows: QueuedHop[] = [];
      const queuedHops = memoryCapacityRepo(rows);
      const hopClock = new FixedClock(CAP_NOW);
      const starts: { role: string; profileId: string }[] = [];
      const env = await capacityHarness({
        coordinator: trackingStarts(new ScriptedRuntime(COORDINATOR_HAPPY), starts),
        executor: trackingStarts(failingExecutor(), starts),
        executorMaxAttempts: 2,
        queuedHops,
        hopClock,
        hopCapacityLimits: capLimits(),
      });
      await env.platform.createMission({ projectId: 'P', missionId: 'M-retry', contract: CONTRACT });
      const first = await env.makeOrchestrator().runMission('M-retry', { projectRoot: process.cwd() });
      assert.equal(first.kind, 'waiting');
      if (first.kind === 'waiting') {
        assert.equal(first.reason, 'project_busy');
        assert.match(first.detail, /退避/);
      }
      const afterFirst = (await queuedHops.list()).filter((row) => row.role === 'executor');
      assert.equal(afterFirst.length, 1);
      const hop = afterFirst[0]!;
      assert.equal(hop.status, 'retry_wait');
      assert.equal(hop.attemptCount, 1);
      assert.ok(Date.parse(hop.availableAt) > Date.parse(hop.lastFailure!.at));
      assert.equal(hop.lastFailure?.classification, 'upstream_5xx');
      const view1 = await env.platform.getMissionView('M-retry');
      assert.notEqual(view1.status, 'completed');
      assert.equal(view1.workItems[0]?.attempts, 1);
      const execStarts1 = starts.filter((row) => row.role === 'executor').length;

      const early = await env.makeOrchestrator().runMission('M-retry', { projectRoot: process.cwd() });
      assert.equal(early.kind, 'waiting');
      if (early.kind === 'waiting') {
        assert.equal(early.reason, 'project_busy');
        assert.match(early.detail, /退避/);
      }
      assert.equal((await queuedHops.list()).filter((row) => row.role === 'executor').length, 1);
      assert.equal((await queuedHops.list()).find((row) => row.role === 'executor')?.attemptCount, 1);
      assert.equal(starts.filter((row) => row.role === 'executor').length, execStarts1);
      assert.equal((await env.platform.getMissionView('M-retry')).workItems[0]?.attempts, 1);

      hopClock.advance(Date.parse(hop.availableAt) - Date.parse(CAP_NOW));
      const second = await env.makeOrchestrator().runMission('M-retry', { projectRoot: process.cwd() });
      assert.equal(second.kind, 'waiting');
      if (second.kind === 'waiting') {
        assert.equal(second.reason, 'attempt_limit_reached');
        assert.match(second.detail, /死信/);
      }
      const afterSecond = (await queuedHops.list()).filter((row) => row.role === 'executor');
      assert.equal(afterSecond.length, 1);
      assert.equal(afterSecond[0]?.status, 'dead_letter');
      assert.equal(afterSecond[0]?.attemptCount, 2);
      assert.equal((await queuedHops.get(afterSecond[0]!.id))?.status, 'dead_letter');
      assert.equal(starts.filter((row) => row.role === 'executor').length, execStarts1 + 1);
      assert.notEqual((await env.platform.getMissionView('M-retry')).status, 'completed');

      const cooled = env.makeOrchestrator();
      const again = await cooled.runMission('M-retry', { projectRoot: process.cwd() });
      assert.equal(again.kind, 'waiting');
      if (again.kind === 'waiting') {
        assert.equal(again.reason, 'attempt_limit_reached');
        assert.notEqual(again.reason, 'no_available_agent');
      }
      assert.equal((await queuedHops.list()).filter((row) => row.role === 'executor').length, 1);
      assert.equal(starts.filter((row) => row.role === 'executor').length, execStarts1 + 1);
    });

  test('候选冷却不能掩盖退避等待；同一失败重入不多计数', async () => {
    const rows: QueuedHop[] = [];
    const queuedHops = memoryCapacityRepo(rows);
    const hopClock = new FixedClock(CAP_NOW);
    const starts: { role: string; profileId: string }[] = [];
    const env = await capacityHarness({
      coordinator: trackingStarts(new ScriptedRuntime(COORDINATOR_HAPPY), starts),
      executor: trackingStarts(failingExecutor(), starts),
      executorCandidates: [{ endpoint: 'local', profileId: 'exec-a' }],
      executorMaxAttempts: 2,
      queuedHops,
      hopClock,
      hopCapacityLimits: capLimits(),
    });
    await env.platform.createMission({ projectId: 'P', missionId: 'M-cool', contract: CONTRACT });
    const orch = env.makeOrchestrator();
    const first = await orch.runMission('M-cool', { projectRoot: process.cwd() });
    assert.equal(first.kind, 'waiting');
    if (first.kind === 'waiting') assert.match(first.detail, /退避/);
    assert.equal((await queuedHops.list()).find((row) => row.role === 'executor')?.attemptCount, 1);
    const reentry = await orch.runMission('M-cool', { projectRoot: process.cwd() });
    assert.equal(reentry.kind, 'waiting');
    if (reentry.kind === 'waiting') {
      assert.equal(reentry.reason, 'project_busy');
      assert.notEqual(reentry.reason, 'no_available_agent');
      assert.match(reentry.detail, /退避/);
    }
    const exec = (await queuedHops.list()).filter((row) => row.role === 'executor');
    assert.equal(exec.length, 1);
    assert.equal(exec[0]?.attemptCount, 1);
    assert.equal(exec[0]?.status, 'retry_wait');
    assert.equal(starts.filter((row) => row.role === 'executor').length, 1);
  });

  test('规则错误无自动重试；platform_unreachable 不报告且等待原因不同', async () => {
    const ruleRows: QueuedHop[] = [];
    const ruleQueue = memoryCapacityRepo(ruleRows);
    const hopClock = new FixedClock(CAP_NOW);
    const happy = new ScriptedRuntime(EXECUTOR_HAPPY);
    const ruleEnv = await capacityHarness({
      coordinator: new ScriptedRuntime(COORDINATOR_HAPPY),
      executor: {
        kind: happy.kind,
        start: async (spec) => {
          if (spec.role === 'executor') {
            throw new PlatformRuleError('PLAN_REQUIRED', '没 Plan 不能建工作项');
          }
          return happy.start(spec);
        },
      },
      executorMaxAttempts: 3,
      queuedHops: ruleQueue,
      hopClock,
      hopCapacityLimits: capLimits(),
    });
    await ruleEnv.platform.createMission({ projectId: 'P', missionId: 'M-rule', contract: CONTRACT });
    const ruleOutcome = await ruleEnv.makeOrchestrator().runMission('M-rule', { projectRoot: process.cwd() });
    assert.equal(ruleOutcome.kind, 'waiting');
    if (ruleOutcome.kind === 'waiting') {
      assert.equal(ruleOutcome.reason, 'attempt_limit_reached');
      assert.match(ruleOutcome.detail, /死信/);
    }
    const ruleHop = (await ruleQueue.list()).find((row) => row.role === 'executor');
    assert.equal(ruleHop?.status, 'dead_letter');
    assert.equal(ruleHop?.attemptCount, 1);
    assert.equal(ruleHop?.lastFailure?.retryable, false);
    assert.equal(ruleHop?.lastFailure?.classification, 'rule');
    assert.notEqual((await ruleEnv.platform.getMissionView('M-rule')).status, 'completed');

    const unreachableRows: QueuedHop[] = [];
    const inner = memoryCapacityRepo(unreachableRows);
    let reports = 0;
    const unreachableQueue: QueuedHopCapacityRepository = {
      enqueue: (hop) => inner.enqueue(hop),
      get: (id) => inner.get(id),
      list: () => inner.list(),
      claim: (id, owner, now, until) => inner.claim(id, owner, now, until),
      renew: (id, owner, generation, now, until) => inner.renew(id, owner, generation, now, until),
      complete: (id, owner, generation, now) => inner.complete(id, owner, generation, now),
      reportFailure: async (input) => {
        reports += 1;
        return inner.reportFailure!(input);
      },
      claimAvailable: (input) => inner.claimAvailable(input),
    };
    const scripted = new ScriptedRuntime({ 'executor:W-1': { steps: [] } });
    const unreachableEnv = await capacityHarness({
      coordinator: new ScriptedRuntime(COORDINATOR_HAPPY),
      executor: {
        kind: scripted.kind,
        start: async (spec) => {
          const run = await scripted.start(spec);
          if (spec.role !== 'executor') return run;
          return {
            resumeRef: run.resumeRef,
            on: (handler) => run.on(handler),
            abort: (reason) => run.abort(reason),
            wait: async () => ({ ...await run.wait(), endedBy: 'platform_unreachable' as const }),
          };
        },
      },
      queuedHops: unreachableQueue,
      hopClock: new FixedClock(CAP_NOW),
      hopCapacityLimits: capLimits(),
    });
    await unreachableEnv.platform.createMission({
      projectId: 'P',
      missionId: 'M-unreach',
      contract: CONTRACT,
    });
    const unreachableOutcome = await unreachableEnv.makeOrchestrator().runMission('M-unreach', {
      projectRoot: process.cwd(),
    });
    assert.equal(unreachableOutcome.kind, 'waiting');
    if (unreachableOutcome.kind === 'waiting') {
      assert.equal(unreachableOutcome.reason, 'platform_unreachable');
    }
    assert.equal(reports, 0);
    const unreachHop = (await unreachableQueue.list()).find((row) => row.role === 'executor');
    assert.notEqual(unreachHop?.status, 'retry_wait');
    assert.notEqual(unreachHop?.status, 'dead_letter');
    assert.notEqual((await unreachableEnv.platform.getMissionView('M-unreach')).status, 'completed');
    assert.notEqual(ruleOutcome.kind === 'waiting' ? ruleOutcome.reason : '', 'platform_unreachable');
  });

  test('运行内退避上限构造校验：缺省 0，非法值抛错', () => {
    assert.equal(inRunBackoffWaitMs(), 0);
    assert.equal(inRunBackoffWaitMs(undefined), 0);
    assert.equal(inRunBackoffWaitMs(0), 0);
    assert.equal(inRunBackoffWaitMs(120_000), 120_000);
    for (const value of [-1, 1.5, Number.NaN, Infinity, -Infinity]) {
      assert.throws(() => inRunBackoffWaitMs(value), /non-negative safe integer/);
    }
  });

  test('killed_idle：同次运行等待后同键重领 Q，P/Q 各一次且 attemptCount 不清零',
    async () => {
      await assertSameRunSwap('killed_idle');
    });

  test('quota：同次运行等待后同键重领 Q，P/Q 各一次且 attemptCount 不清零',
    async () => {
      await assertSameRunSwap('quota');
    });

  test('unknown 不启动 Q；仍记队列失败',
    async () => {
      const rows: QueuedHop[] = [];
      const queuedHops = memoryCapacityRepo(rows);
      const starts: { role: string; profileId: string }[] = [];
      const executor = new ScriptedRuntime({
        'executor:W-1:0': { steps: [], upstreamFailure: 'upstream unavailable' },
        'executor:W-1:1': EXECUTOR_HAPPY['executor:W-1'],
      });
      const env = await capacityHarness({
        coordinator: trackingStarts(new ScriptedRuntime(COORDINATOR_HAPPY), starts),
        executor: trackingStarts(executor, starts),
        queuedHops,
        hopClock: new SystemClock(),
        hopCapacityLimits: capLimits(),
        inRunBackoffWaitMs: 120_000,
        candidateCircuits: candidateCircuitRepository(),
      });
      await env.platform.createMission({ projectId: 'P', missionId: 'M-unknown-wait', contract: CONTRACT });
      const outcome = await env.makeOrchestrator().runMission('M-unknown-wait', { projectRoot: process.cwd() });
      assert.equal(outcome.kind, 'waiting');
      if (outcome.kind === 'waiting') {
        assert.equal(outcome.reason, 'project_busy');
        assert.match(outcome.detail, /退避/);
      }
      const execStarts = starts.filter((row) => row.role === 'executor');
      assert.deepEqual(execStarts.map((row) => row.profileId), ['exec-a']);
      const execHops = (await queuedHops.list()).filter((row) => row.role === 'executor');
      assert.equal(execHops.length, 1);
      assert.equal(execHops[0]?.status, 'retry_wait');
      assert.equal(execHops[0]?.attemptCount, 1);
      assert.equal(execHops[0]?.lastFailure?.classification, 'unknown');
    });

  test('退避超过上限时返回 waiting，不启动 Q',
    async () => {
      const rows: QueuedHop[] = [];
      const queuedHops = memoryCapacityRepo(rows);
      const starts: { role: string; profileId: string }[] = [];
      const executor = new ScriptedRuntime({
        'executor:W-1:0': { steps: [], upstreamFailure: '403 需要充值' },
        'executor:W-1:1': EXECUTOR_HAPPY['executor:W-1'],
      });
      const env = await capacityHarness({
        coordinator: trackingStarts(new ScriptedRuntime(COORDINATOR_HAPPY), starts),
        executor: trackingStarts(executor, starts),
        queuedHops,
        hopClock: new FixedClock(CAP_NOW),
        hopCapacityLimits: capLimits(),
        inRunBackoffWaitMs: 500,
      });
      await env.platform.createMission({ projectId: 'P', missionId: 'M-cap', contract: CONTRACT });
      const outcome = await env.makeOrchestrator().runMission('M-cap', { projectRoot: process.cwd() });
      assert.equal(outcome.kind, 'waiting');
      if (outcome.kind === 'waiting') {
        assert.equal(outcome.reason, 'project_busy');
        assert.match(outcome.detail, /退避/);
      }
      assert.deepEqual(
        starts.filter((row) => row.role === 'executor').map((row) => row.profileId),
        ['exec-a'],
      );
      const hop = (await queuedHops.list()).find((row) => row.role === 'executor');
      assert.equal(hop?.status, 'retry_wait');
      assert.equal(hop?.attemptCount, 1);
    });

  test('退避越过 Mission 墙钟截止时返回 waiting，不启动 Q',
    async () => {
      const rows: QueuedHop[] = [];
      const queuedHops = memoryCapacityRepo(rows);
      const starts: { role: string; profileId: string }[] = [];
      const executor = new ScriptedRuntime({
        'executor:W-1:0': { steps: [], upstreamFailure: '403 需要充值' },
        'executor:W-1:1': EXECUTOR_HAPPY['executor:W-1'],
      });
      const env = await capacityHarness({
        coordinator: trackingStarts(new ScriptedRuntime(COORDINATOR_HAPPY), starts),
        executor: trackingStarts(executor, starts),
        queuedHops,
        hopClock: new FixedClock(CAP_NOW),
        hopCapacityLimits: capLimits(),
        inRunBackoffWaitMs: 120_000,
        attemptWallClockMs: 800,
      });
      await env.platform.createMission({ projectId: 'P', missionId: 'M-wall', contract: CONTRACT });
      const outcome = await env.makeOrchestrator().runMission('M-wall', { projectRoot: process.cwd() });
      assert.equal(outcome.kind, 'waiting');
      if (outcome.kind === 'waiting') {
        assert.equal(outcome.reason, 'project_busy');
        assert.match(outcome.detail, /退避/);
      }
      assert.deepEqual(
        starts.filter((row) => row.role === 'executor').map((row) => row.profileId),
        ['exec-a'],
      );
      const hop = (await queuedHops.list()).find((row) => row.role === 'executor');
      assert.equal(hop?.status, 'retry_wait');
      assert.equal(hop?.attemptCount, 1);
    });

  test('maxRounds=1：P 失败等待后同次运行不启动 Q，attemptCount 不清零',
    async () => {
      const rows: QueuedHop[] = [];
      const queuedHops = memoryCapacityRepo(rows);
      const starts: { role: string; profileId: string }[] = [];
      const executor = new ScriptedRuntime({
        'executor:W-1:0': { steps: [], upstreamFailure: '403 需要充值' },
        'executor:W-1:1': EXECUTOR_HAPPY['executor:W-1'],
      });
      const env = await capacityHarness({
        coordinator: trackingStarts(new ScriptedRuntime(COORDINATOR_HAPPY), starts),
        executor: trackingStarts(executor, starts),
        queuedHops,
        hopClock: new SystemClock(),
        hopCapacityLimits: capLimits(),
        inRunBackoffWaitMs: 120_000,
        candidateCircuits: candidateCircuitRepository(),
      });
      await env.platform.createMission({ projectId: 'P', missionId: 'M-rounds', contract: CONTRACT });
      const orch = env.makeOrchestrator();
      const dispatched = await orch.runMission('M-rounds', {
        projectRoot: process.cwd(),
        maxRounds: 1,
      });
      assert.equal(dispatched.kind, 'stalled');
      assert.deepEqual(
        starts.filter((row) => row.role === 'executor').map((row) => row.profileId),
        [],
      );
      const began = Date.now();
      const outcome = await orch.runMission('M-rounds', {
        projectRoot: process.cwd(),
        maxRounds: 1,
      });
      assert.ok(Date.now() - began >= 1_000, '必须真实等到退避到期');
      assert.notEqual(outcome.kind, 'awaiting_l3_review');
      assert.deepEqual(
        starts.filter((row) => row.role === 'executor').map((row) => row.profileId),
        ['exec-a'],
      );
      const execHops = (await queuedHops.list()).filter((row) => row.role === 'executor');
      assert.equal(execHops.length, 1);
      assert.equal(execHops[0]?.status, 'retry_wait');
      assert.equal(execHops[0]?.attemptCount, 1);
      assert.equal(execHops[0]?.lastFailure?.classification, 'quota');
    });

  test('inRunBackoffWaitMs>0：死信返回 attempt_limit_reached，不启动 Q',
    async () => {
      const rows: QueuedHop[] = [];
      const queuedHops = memoryCapacityRepo(rows);
      const starts: { role: string; profileId: string }[] = [];
      const env = await capacityHarness({
        coordinator: trackingStarts(new ScriptedRuntime(COORDINATOR_HAPPY), starts),
        executor: trackingStarts(
          new ScriptedRuntime({
            'executor:W-1:0': { steps: [], upstreamFailure: '403 需要充值' },
            'executor:W-1:1': EXECUTOR_HAPPY['executor:W-1'],
          }),
          starts,
        ),
        executorMaxAttempts: 1,
        queuedHops,
        hopClock: new SystemClock(),
        hopCapacityLimits: capLimits(),
        inRunBackoffWaitMs: 120_000,
        candidateCircuits: candidateCircuitRepository(),
      });
      await env.platform.createMission({ projectId: 'P', missionId: 'M-dead', contract: CONTRACT });
      const outcome = await env.makeOrchestrator().runMission('M-dead', { projectRoot: process.cwd() });
      assert.equal(outcome.kind, 'waiting');
      if (outcome.kind === 'waiting') {
        assert.equal(outcome.reason, 'attempt_limit_reached');
        assert.match(outcome.detail, /死信/);
      }
      assert.deepEqual(
        starts.filter((row) => row.role === 'executor').map((row) => row.profileId),
        ['exec-a'],
      );
      const hop = (await queuedHops.list()).find((row) => row.role === 'executor');
      assert.equal(hop?.status, 'dead_letter');
      assert.equal(hop?.attemptCount, 1);
      assert.equal(hop?.lastFailure?.retryable, true);
    });

  test('inRunBackoffWaitMs>0：规则错误保持 do_not_retry，不启动 Q',
    async () => {
      const rows: QueuedHop[] = [];
      const queuedHops = memoryCapacityRepo(rows);
      const starts: { role: string; profileId: string }[] = [];
      const happy = new ScriptedRuntime(EXECUTOR_HAPPY);
      const env = await capacityHarness({
        coordinator: trackingStarts(new ScriptedRuntime(COORDINATOR_HAPPY), starts),
        executor: trackingStarts(
          {
            kind: happy.kind,
            start: async (spec) => {
              if (spec.role === 'executor') {
                throw new PlatformRuleError('PLAN_REQUIRED', '没 Plan 不能建工作项');
              }
              return happy.start(spec);
            },
          },
          starts,
        ),
        executorMaxAttempts: 3,
        queuedHops,
        hopClock: new SystemClock(),
        hopCapacityLimits: capLimits(),
        inRunBackoffWaitMs: 120_000,
      });
      await env.platform.createMission({ projectId: 'P', missionId: 'M-rule-wait', contract: CONTRACT });
      const outcome = await env.makeOrchestrator().runMission('M-rule-wait', { projectRoot: process.cwd() });
      assert.equal(outcome.kind, 'waiting');
      if (outcome.kind === 'waiting') {
        assert.equal(outcome.reason, 'attempt_limit_reached');
        assert.match(outcome.detail, /死信/);
      }
      assert.deepEqual(
        starts.filter((row) => row.role === 'executor').map((row) => row.profileId),
        ['exec-a'],
      );
      const hop = (await queuedHops.list()).find((row) => row.role === 'executor');
      assert.equal(hop?.status, 'dead_letter');
      assert.equal(hop?.attemptCount, 1);
      assert.equal(hop?.lastFailure?.retryable, false);
      assert.equal(hop?.lastFailure?.classification, 'rule');
      assert.equal(hop?.lastFailure?.disposition, 'do_not_retry');
      assert.notEqual((await env.platform.getMissionView('M-rule-wait')).status, 'completed');
    });
});

async function assertSameRunSwap(kind: 'killed_idle' | 'quota'): Promise<void> {
  const rows: QueuedHop[] = [];
  const queuedHops = memoryCapacityRepo(rows);
  const starts: { role: string; profileId: string }[] = [];
  const failing =
    kind === 'quota'
      ? { steps: [], upstreamFailure: '403 需要充值' }
      : { steps: [] };
  const inner = new ScriptedRuntime({
    'executor:W-1:0': failing,
    'executor:W-1:1': EXECUTOR_HAPPY['executor:W-1'],
  });
  const executor: AgentRuntime =
    kind === 'killed_idle'
      ? {
          kind: inner.kind,
          start: async (spec) => {
            const run = await inner.start(spec);
            if (spec.role !== 'executor' || spec.profile.profileId !== 'exec-a') return run;
            return {
              resumeRef: run.resumeRef,
              on: (handler) => run.on(handler),
              abort: (reason) => run.abort(reason),
              wait: async () => ({ ...await run.wait(), endedBy: 'killed_idle' as const }),
            };
          },
        }
      : inner;
  const env = await capacityHarness({
    coordinator: trackingStarts(new ScriptedRuntime(COORDINATOR_HAPPY), starts),
    executor: trackingStarts(executor, starts),
    queuedHops,
    hopClock: new SystemClock(),
    hopCapacityLimits: capLimits(),
    inRunBackoffWaitMs: 120_000,
    candidateCircuits: candidateCircuitRepository(),
  });
  await env.platform.createMission({
    projectId: 'P',
    missionId: `M-swap-${kind}`,
    contract: CONTRACT,
  });
  const began = Date.now();
  const orch = env.makeOrchestrator();
  const result = await orch.runMission(`M-swap-${kind}`, { projectRoot: process.cwd() });
  assert.ok(Date.now() - began >= 1_000, '必须真实等到退避到期，不能用固定 now 配立即返回的 sleep');
  assert.equal(result.kind, 'awaiting_l3_review');
  await env.platform.finalizeMission(`M-swap-${kind}`, {
    verdict: 'merge',
    reasons: ['ok'],
    projectRoot: process.cwd(),
  });
  assert.equal((await env.platform.getMissionView(`M-swap-${kind}`)).status, 'completed');
  const execStarts = starts.filter((row) => row.role === 'executor');
  assert.deepEqual(execStarts.map((row) => row.profileId), ['exec-a', 'exec-b']);
  const execHops = (await queuedHops.list()).filter((row) => row.role === 'executor');
  assert.equal(execHops.length, 1, '必须同键重领，不得另开槽');
  assert.equal(execHops[0]?.status, 'completed');
  assert.equal(execHops[0]?.attemptCount, 1, 'attemptCount 不得因换候选清零');
  assert.equal(execHops[0]?.lastFailure?.classification, kind === 'quota' ? 'quota' : 'killed_idle');
  const executorRecords = orch.hops.filter((hop) => hop.role === 'executor');
  assert.equal(executorRecords.length, 2);
  assert.equal(executorRecords[0]?.profile.profileId, 'exec-a');
  assert.equal(executorRecords[1]?.profile.profileId, 'exec-b');
}
