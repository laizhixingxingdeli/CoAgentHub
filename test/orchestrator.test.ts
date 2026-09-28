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
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Orchestrator } from '../src/application/orchestrator.ts';
import { MissionRunner } from '../src/application/mission-runner.ts';
import { Platform } from '../src/application/platform.ts';
import { makeIssuer } from '../src/main.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { FileCandidateCircuitRepository, FileStateStore } from '../src/application/file-store.ts';
import type { AgentRuntime, CandidateCircuitRepository } from '../src/application/ports.ts';
import type { CandidateCircuit } from '../src/application/candidate-circuit.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

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
