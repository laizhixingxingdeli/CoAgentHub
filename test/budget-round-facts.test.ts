/**
 * BUDGET-001-S2: durable authoritative orchestration.round.started facts.
 *
 * Covers trusted Platform append, Orchestrator placement (preflight vs hop),
 * rerun accumulation, crash-after-event durability, and no public write surface.
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
import { countAuthoritativeRounds } from '../src/application/budget-usage.ts';
import { Orchestrator } from '../src/application/orchestrator.ts';
import { Platform } from '../src/application/platform.ts';
import { makeIssuer } from '../src/main.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

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
          verdict: 'accept', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })),
          reasons: ['ok'],
          requiredChanges: [],
        },
      },
      {
        tool: 'coagent_submit_mission_result',
        body: {
          outcome: 'delivered',
          summary: '改好了',
          acceptanceEvidence: ['node --test'],
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
        body: { kind: 'test', summary: 'green', command: 'node --test', exitCode: 0 },
      },
      {
        tool: 'coagent_submit_execution_result',
        body: (previous) => ({
          outcome: 'completed',
          summary: 'done',
          changedFiles: ['src/foo.ts'],
          evidenceIds: [previous.evidenceId],
          notes: '无',
        }),
      },
    ],
  },
};

const servers: Server[] = [];

after(() => {
  for (const server of servers) server.close();
});

async function harness(runtimes?: {
  coordinator?: ScriptedRuntime;
  executor?: ScriptedRuntime;
}) {
  const clock = new FixedClock();
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const projects = new InMemoryProjectRepository();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
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
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);

  const coordinatorRt = runtimes?.coordinator ?? new ScriptedRuntime(COORDINATOR_HAPPY);
  const executorRt = runtimes?.executor ?? new ScriptedRuntime(EXECUTOR_HAPPY);

  return {
    platform,
    activity,
    projects,
    makeOrchestrator: () =>
      new Orchestrator({
        platform,
        tokens: makeIssuer(platform, tokens),
        baseUrl,
        workspace: new InPlaceWorkspaceManager(),
        coordinator: {
          runtime: coordinatorRt,
          candidates: [{ endpoint: 'local', profileId: 'coordinator-a' }],
        },
        executor: {
          runtime: executorRt,
          candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
        },
      }),
  };
}

function roundEvents(events: readonly { kind: string; data?: unknown }[]) {
  return events.filter((e) => e.kind === 'orchestration.round.started');
}

describe('BUDGET-001-S2 trusted round-start event', () => {
  test('Platform.recordOrchestrationRoundStarted appends schemaVersion:1 only via trusted path', async () => {
    const h = await harness();
    await h.platform.createMission({ projectId: 'P', missionId: 'M-rec', contract: CONTRACT });
    await h.platform.recordOrchestrationRoundStarted('M-rec');

    const events = await h.platform.getActivity('M-rec');
    const rounds = roundEvents(events);
    assert.equal(rounds.length, 1);
    assert.deepEqual(rounds[0]!.data, { schemaVersion: 1 });
    assert.equal(countAuthoritativeRounds(events).status, 'known');
    assert.equal((countAuthoritativeRounds(events) as { count: number }).count, 1);

    // Mission snapshot must not grow a round counter field.
    const view = await h.platform.getMissionView('M-rec');
    assert.equal('roundCount' in view, false);
    assert.equal('orchestrationRound' in view, false);
  });

  test('happy runMission records one round-start per loop iteration that does work', async () => {
    const h = await harness();
    await h.platform.createMission({ projectId: 'P', missionId: 'M-happy', contract: CONTRACT });
    const orch = h.makeOrchestrator();
    const result = await orch.runMission('M-happy', { projectRoot: process.cwd() });
    assert.deepEqual(result, { kind: 'awaiting_l3_review' });

    const events = await h.platform.getActivity('M-happy');
    const rounds = roundEvents(events);
    // coordinator plan+dispatch, executor hop, coordinator review = 3 loop iterations
    assert.equal(rounds.length, 3);
    for (const r of rounds) {
      assert.deepEqual(r.data, { schemaVersion: 1 });
    }
    // Each round-start precedes attempt activity in that iteration; overall known.
    const projected = countAuthoritativeRounds(events);
    assert.deepEqual(projected, { status: 'known', count: 3 });
  });

  test('rerun accumulation: second runMission appends additional round-start facts', async () => {
    // First run: only one coordinator hop then maxRounds stops mid-flight after dispatch path.
    // Use maxRounds=1 so first call records exactly one round then stalls at limit after hop.
    const h = await harness();
    await h.platform.createMission({ projectId: 'P', missionId: 'M-rerun', contract: CONTRACT });
    const orch = h.makeOrchestrator();

    const first = await orch.runMission('M-rerun', { projectRoot: process.cwd(), maxRounds: 1 });
    assert.equal(first.kind, 'stalled');
    const afterFirst = roundEvents(await h.platform.getActivity('M-rerun'));
    assert.equal(afterFirst.length, 1);

    // Second run continues: remaining hops each add a round fact.
    const second = await orch.runMission('M-rerun', { projectRoot: process.cwd(), maxRounds: 12 });
    assert.deepEqual(second, { kind: 'awaiting_l3_review' });
    const all = await h.platform.getActivity('M-rerun');
    const rounds = roundEvents(all);
    assert.ok(rounds.length >= 3, `expected accumulated rounds >= 3, got ${rounds.length}`);
    assert.deepEqual(countAuthoritativeRounds(all), {
      status: 'known',
      count: rounds.length,
    });
  });

  test('crash-after-event durability: round counts even when hop fails after append', async () => {
    // Runtime hop failures are classified (upstream_failure), not rethrown.
    // Round-start is appended before #runHop — it must remain durable.
    const crashCoord = new ScriptedRuntime({
      'coordinator:-:0': { steps: [], upstreamFailure: 'simulated crash after round recorded' },
    });
    const h = await harness({ coordinator: crashCoord, executor: new ScriptedRuntime({}) });
    await h.platform.createMission({ projectId: 'P', missionId: 'M-crash', contract: CONTRACT });
    const orch = h.makeOrchestrator();

    const outcome = await orch.runMission('M-crash', {
      projectRoot: process.cwd(),
      maxRounds: 2,
    });
    assert.equal(outcome.kind, 'waiting');
    assert.ok(orch.hops.length >= 1);
    assert.equal(orch.hops[0]!.endedBy, 'upstream_failure');

    const events = await h.platform.getActivity('M-crash');
    const rounds = roundEvents(events);
    assert.equal(rounds.length, 1, 'round-start must survive hop failure');
    assert.deepEqual(rounds[0]!.data, { schemaVersion: 1 });
    // attempt.started exists after the round-start => still known, not mixed/legacy
    assert.deepEqual(countAuthoritativeRounds(events), { status: 'known', count: 1 });
    assert.ok(events.some((e) => e.kind === 'attempt.started'));
  });

  test('preflight non-counting: paused / awaiting_review do not record rounds', async () => {
    const h = await harness();

    // paused before any work
    await h.platform.createMission({ projectId: 'P', missionId: 'M-pause', contract: CONTRACT });
    await h.platform.pauseMission('M-pause');
    const pausedOut = await h.makeOrchestrator().runMission('M-pause', {
      projectRoot: process.cwd(),
    });
    assert.equal(pausedOut.kind, 'waiting');
    assert.equal(roundEvents(await h.platform.getActivity('M-pause')).length, 0);

    // awaiting_review: finish happy path then re-enter
    await h.platform.createMission({ projectId: 'P', missionId: 'M-rev', contract: CONTRACT });
    const orch = h.makeOrchestrator();
    const done = await orch.runMission('M-rev', { projectRoot: process.cwd() });
    assert.deepEqual(done, { kind: 'awaiting_l3_review' });
    const before = roundEvents(await h.platform.getActivity('M-rev')).length;
    assert.ok(before >= 1);

    const again = await orch.runMission('M-rev', { projectRoot: process.cwd(), maxRounds: 4 });
    assert.equal(again.kind, 'awaiting_l3_review');
    const after = roundEvents(await h.platform.getActivity('M-rev')).length;
    assert.equal(after, before, 'awaiting_review re-entry must not add rounds');
  });

  // 旧不变式：HA 调度前 stalled、不记 round。E3a 让 HA 走 Standard 主链，round 与 Standard 同记。
  test('HA 与 Standard 一样记 round', async () => {
    const h = await harness();
    await h.platform.createMission({ projectId: 'P', missionId: 'M-std-r', contract: CONTRACT });
    const stdOut = await h.makeOrchestrator().runMission('M-std-r', {
      projectRoot: process.cwd(),
    });
    assert.deepEqual(stdOut, { kind: 'awaiting_l3_review' });
    const stdRounds = roundEvents(await h.platform.getActivity('M-std-r'));
    assert.equal(stdRounds.length, 3);

    // HA 用一套新的 harness：脚本化的协调者 / 执行者是按顺序消费的，和上面的 Standard 共用
    // 同一套的话，脚本已被 Standard 用完，HA 只跑得出一轮，测不到「和 Standard 一样的主链」。
    const hHa = await harness();
    const project = await hHa.projects.ensure('P');
    project.createMission({
      id: 'M-ha',
      contract: CONTRACT,
      executionMode: 'high_assurance',
      runKind: 'mutation',
      origin: { clientType: 'cli', conversationRef: 'local-cli' },
    });
    await hHa.projects.save(project);
    const haOut = await hHa.makeOrchestrator().runMission('M-ha', { projectRoot: process.cwd() });
    // 主链 round 记完后接独立检视；本夹具无独立检视池，结局是 waiting，不是旧的 stalled。
    assert.notEqual(haOut.kind, 'stalled');
    assert.notEqual(haOut.kind, 'delivered');
    const haRounds = roundEvents(await hHa.platform.getActivity('M-ha'));
    assert.equal(haRounds.length, stdRounds.length);
    for (const r of haRounds) {
      assert.deepEqual(r.data, { schemaVersion: 1 });
    }
  });

  test('append failure blocks the round (orchestrator does not hop)', async () => {
    const h = await harness();
    await h.platform.createMission({ projectId: 'P', missionId: 'M-fail', contract: CONTRACT });

    const original = h.platform.recordOrchestrationRoundStarted.bind(h.platform);
    let blocked = false;
    h.platform.recordOrchestrationRoundStarted = async (missionId: string) => {
      blocked = true;
      throw new Error('activity append failed');
      return original(missionId);
    };

    const orch = h.makeOrchestrator();
    await assert.rejects(
      () => orch.runMission('M-fail', { projectRoot: process.cwd(), maxRounds: 2 }),
      /activity append failed/,
    );
    assert.equal(blocked, true);
    assert.equal(orch.hops.length, 0);
    assert.equal(roundEvents(await h.platform.getActivity('M-fail')).length, 0);
  });
});

describe('BUDGET-001-S2 no public write surface', () => {
  test('no HTTP route, agent tool, or caller-authored ActivityEvent input for round-start', () => {
    const serverSrc = readFileSync(join(root, 'src', 'api', 'server.ts'), 'utf8');
    const webSrc = readFileSync(join(root, 'src', 'api', 'web.ts'), 'utf8');
    const platformSrc = readFileSync(join(root, 'src', 'application', 'platform.ts'), 'utf8');
    const orchSrc = readFileSync(join(root, 'src', 'application', 'orchestrator.ts'), 'utf8');

    assert.doesNotMatch(serverSrc, /recordOrchestrationRoundStarted|orchestration\.round\.started/);
    assert.doesNotMatch(webSrc, /recordOrchestrationRoundStarted|orchestration\.round\.started/);

    // Method accepts only missionId — no event payload parameter.
    assert.match(
      platformSrc,
      /async recordOrchestrationRoundStarted\(\s*missionId:\s*string\s*\)/,
    );
    assert.match(
      platformSrc,
      /#event\(\s*mission,\s*'orchestration\.round\.started',\s*\{\s*schemaVersion:\s*1\s*\}/,
    );

    // Orchestrator is the production caller after preflight.
    assert.match(orchSrc, /recordOrchestrationRoundStarted\(missionId\)/);

    // No agent tool name for round recording.
    const runtimeDir = join(root, 'src', 'runtime');
    const scripted = readFileSync(join(runtimeDir, 'scripted.ts'), 'utf8');
    assert.doesNotMatch(scripted, /orchestration\.round|recordOrchestrationRound/);

    // Tools table / handlers must not expose a write for this event.
    const toolHits = [
      readFileSync(join(root, 'src', 'api', 'server.ts'), 'utf8'),
      scripted,
    ].join('\n');
    assert.doesNotMatch(toolHits, /coagent_.*round/i);
  });
});
