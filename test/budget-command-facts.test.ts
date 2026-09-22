/**
 * BUDGET-001-S4: durable authoritative runtime.command_* facts.
 *
 * Covers trusted Platform append, Orchestrator ingest (v1 + activityClass),
 * live Timeline regression, crash-after-start durability, zero-command hops,
 * scripted default legacy-unknown, and no public write surface.
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
import { countAuthoritativeCommands } from '../src/application/budget-usage.ts';
import { InMemoryLiveOutput } from '../src/application/live.ts';
import { Orchestrator } from '../src/application/orchestrator.ts';
import { Platform } from '../src/application/platform.ts';
import type { ActivityEvent, ActivityLog } from '../src/application/ports.ts';
import { makeIssuer } from '../src/main.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';

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

/** Default scripted tables — no v1 opt-in (legacy uncovered). */
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

/** Explicit v1 fixtures — activityClass never inferred from tool name. */
const COORDINATOR_V1: ScriptTable = {
  'coordinator:-:0': {
    commandActivityClassification: 'v1',
    steps: [
      { tool: 'coagent_get_mission', body: {}, activityClass: 'other' },
      { tool: 'coagent_update_plan', body: PLAN, activityClass: 'other' },
      {
        tool: 'coagent_create_work_item',
        body: { title: '修 foo', ...ORDER },
        activityClass: 'other',
      },
      {
        tool: 'shell_run',
        callId: 'cmd-coord-1',
        activityClass: 'command',
        body: {},
        expectFailure: true,
      },
      {
        tool: 'coagent_dispatch_work_item',
        body: (previous) => ({ workItemIds: [previous.workItemId] }),
        activityClass: 'other',
      },
    ],
  },
  'coordinator:-:1': {
    commandActivityClassification: 'v1',
    steps: [
      { tool: 'coagent_get_mission', body: {}, activityClass: 'other' },
      {
        tool: 'coagent_review_execution_result',
        body: {
          workItemId: 'W-1',
          verdict: 'accept',
          reasons: ['ok'],
          requiredChanges: [],
        },
        activityClass: 'other',
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
        activityClass: 'other',
      },
    ],
  },
};

const EXECUTOR_V1: ScriptTable = {
  'executor:W-1': {
    commandActivityClassification: 'v1',
    steps: [
      { tool: 'coagent_get_work_order', body: {}, activityClass: 'other' },
      {
        tool: 'proc_exec',
        callId: 'cmd-exec-1',
        activityClass: 'command',
        body: {},
        expectFailure: true,
      },
      {
        tool: 'proc_exec',
        callId: 'cmd-exec-2',
        activityClass: 'command',
        body: {},
        expectFailure: true,
      },
      // duplicate callId must not double-write
      {
        tool: 'proc_exec',
        callId: 'cmd-exec-1',
        activityClass: 'command',
        body: {},
        expectFailure: true,
      },
      {
        tool: 'coagent_submit_evidence',
        body: { kind: 'test', summary: 'green', command: 'node --test', exitCode: 0 },
        activityClass: 'other',
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
        activityClass: 'other',
      },
    ],
  },
};

const servers: Server[] = [];

after(() => {
  for (const server of servers) server.close();
});

const COMMAND_FACT_KINDS = new Set([
  'runtime.command_tracking.enabled',
  'runtime.command.started',
  'runtime.command_tracking.invalid',
]);

/** Delayed ActivityLog proving durable command appends are serial (not concurrent). */
class SerialProbeActivityLog implements ActivityLog {
  readonly events: ActivityEvent[] = [];
  readonly commandPhases: { phase: 'start' | 'end'; kind: string }[] = [];
  maxInFlight = 0;
  #inFlight = 0;
  #clock: FixedClock;
  #delayMs: number;

  constructor(clock: FixedClock, delayMs = 30) {
    this.#clock = clock;
    this.#delayMs = delayMs;
  }

  async append(event: Omit<ActivityEvent, 'at'>): Promise<void> {
    const isCommandFact = COMMAND_FACT_KINDS.has(event.kind);
    if (isCommandFact) {
      this.#inFlight += 1;
      this.maxInFlight = Math.max(this.maxInFlight, this.#inFlight);
      this.commandPhases.push({ phase: 'start', kind: event.kind });
      await new Promise<void>((r) => setTimeout(r, this.#delayMs));
    }
    this.events.push(
      Object.freeze({ ...event, at: this.#clock.now().toISOString() }) as ActivityEvent,
    );
    if (isCommandFact) {
      this.commandPhases.push({ phase: 'end', kind: event.kind });
      this.#inFlight -= 1;
    }
  }

  async list(missionId: string): Promise<readonly ActivityEvent[]> {
    return this.events.filter((e) => e.missionId === missionId);
  }
}

/** Fail only command.started appends — enabled + recovery invalid still land. */
class FailStartedActivityLog implements ActivityLog {
  readonly events: ActivityEvent[] = [];
  #clock: FixedClock;
  startedAttempts = 0;

  constructor(clock: FixedClock) {
    this.#clock = clock;
  }

  async append(event: Omit<ActivityEvent, 'at'>): Promise<void> {
    if (event.kind === 'runtime.command.started') {
      this.startedAttempts += 1;
      throw new Error('simulated durable command.started write failure');
    }
    this.events.push(
      Object.freeze({ ...event, at: this.#clock.now().toISOString() }) as ActivityEvent,
    );
  }

  async list(missionId: string): Promise<readonly ActivityEvent[]> {
    return this.events.filter((e) => e.missionId === missionId);
  }
}

async function harness(opts?: {
  coordinator?: ScriptedRuntime;
  executor?: ScriptedRuntime;
  live?: InMemoryLiveOutput;
  activity?: ActivityLog;
}) {
  const clock = new FixedClock();
  const activity = opts?.activity ?? new InMemoryActivityLog(clock);
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);

  const coordinatorRt = opts?.coordinator ?? new ScriptedRuntime(COORDINATOR_HAPPY);
  const executorRt = opts?.executor ?? new ScriptedRuntime(EXECUTOR_HAPPY);
  const live = opts?.live;

  return {
    platform,
    activity,
    live,
    makeOrchestrator: () =>
      new Orchestrator({
        platform,
        tokens: makeIssuer(platform, tokens),
        baseUrl,
        workspace: new InPlaceWorkspaceManager(),
        live,
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

function commandKinds(events: readonly { kind: string; data?: unknown; attemptId?: string }[]) {
  return events.filter(
    (e) =>
      e.kind === 'runtime.command_tracking.enabled' ||
      e.kind === 'runtime.command.started' ||
      e.kind === 'runtime.command_tracking.invalid',
  );
}

describe('BUDGET-001-S4 trusted command facts', () => {
  test('Platform record methods append schemaVersion:1 with attemptId via trusted path', async () => {
    const h = await harness();
    await h.platform.createMission({ projectId: 'P', missionId: 'M-rec', contract: CONTRACT });
    await h.platform.recordCommandTrackingEnabled('M-rec', 'A-1');
    await h.platform.recordCommandStarted('M-rec', 'A-1', 'call-9');
    await h.platform.recordCommandTrackingInvalid('M-rec', 'A-1');

    const events = await h.platform.getActivity('M-rec');
    const cmds = commandKinds(events);
    assert.equal(cmds.length, 3);
    assert.equal(cmds[0]!.kind, 'runtime.command_tracking.enabled');
    assert.equal(cmds[0]!.attemptId, 'A-1');
    assert.deepEqual(cmds[0]!.data, { schemaVersion: 1 });
    assert.equal(cmds[1]!.kind, 'runtime.command.started');
    assert.equal(cmds[1]!.attemptId, 'A-1');
    assert.deepEqual(cmds[1]!.data, { schemaVersion: 1, callId: 'call-9' });
    assert.equal(cmds[2]!.kind, 'runtime.command_tracking.invalid');
    assert.equal(cmds[2]!.attemptId, 'A-1');
    assert.deepEqual(cmds[2]!.data, { schemaVersion: 1 });
  });

  test('Orchestrator + v1 fixture emits enabled + command.started; projection known', async () => {
    const live = new InMemoryLiveOutput();
    const h = await harness({
      coordinator: new ScriptedRuntime(COORDINATOR_V1),
      executor: new ScriptedRuntime(EXECUTOR_V1),
      live,
    });
    await h.platform.createMission({ projectId: 'P', missionId: 'M-v1', contract: CONTRACT });
    const orch = h.makeOrchestrator();
    const result = await orch.runMission('M-v1', { projectRoot: process.cwd() });
    assert.deepEqual(result, { kind: 'awaiting_l3_review' });

    const events = await h.platform.getActivity('M-v1');
    const enabled = events.filter((e) => e.kind === 'runtime.command_tracking.enabled');
    const started = events.filter((e) => e.kind === 'runtime.command.started');
    const invalid = events.filter((e) => e.kind === 'runtime.command_tracking.invalid');

    // 3 hops (coord plan, exec, coord review) each get enabled
    assert.equal(enabled.length, 3);
    for (const e of enabled) {
      assert.deepEqual(e.data, { schemaVersion: 1 });
      assert.ok(typeof e.attemptId === 'string' && e.attemptId.length > 0);
    }
    // coord cmd-coord-1 + exec cmd-exec-1 + cmd-exec-2 (duplicate callId ignored)
    assert.equal(started.length, 3);
    const callIds = started.map((e) => (e.data as { callId: string }).callId).sort();
    assert.deepEqual(callIds, ['cmd-coord-1', 'cmd-exec-1', 'cmd-exec-2']);
    assert.equal(invalid.length, 0);

    const projected = countAuthoritativeCommands(events);
    assert.deepEqual(projected, { status: 'known', count: 3 });
  });

  test('zero-command v1 hop: enabled, no started, projection 0 for that cover', async () => {
    const zeroCoord: ScriptTable = {
      'coordinator:-:0': {
        commandActivityClassification: 'v1',
        steps: [
          { tool: 'coagent_get_mission', body: {}, activityClass: 'other' },
          {
            tool: 'coagent_escalate_to_l3',
            body: { question: 'need human' },
            activityClass: 'other',
          },
        ],
      },
    };
    const h = await harness({
      coordinator: new ScriptedRuntime(zeroCoord),
      executor: new ScriptedRuntime({}),
    });
    await h.platform.createMission({ projectId: 'P', missionId: 'M-zero', contract: CONTRACT });
    const outcome = await h.makeOrchestrator().runMission('M-zero', {
      projectRoot: process.cwd(),
      maxRounds: 2,
    });
    // Escalate ends the loop awaiting L3; kind name may be awaiting_l3 or waiting depending on path.
    assert.ok(
      outcome.kind === 'waiting' || outcome.kind === 'awaiting_l3',
      `unexpected outcome ${outcome.kind}`,
    );

    const events = await h.platform.getActivity('M-zero');
    assert.equal(events.filter((e) => e.kind === 'runtime.command_tracking.enabled').length, 1);
    assert.equal(events.filter((e) => e.kind === 'runtime.command.started').length, 0);
    assert.equal(events.filter((e) => e.kind === 'runtime.command_tracking.invalid').length, 0);
    assert.deepEqual(countAuthoritativeCommands(events), { status: 'known', count: 0 });
  });

  test('live Timeline tool chunks remain kind:tool with name/detail text (regression)', async () => {
    const live = new InMemoryLiveOutput();
    // Single hop with detail-bearing classification via custom runtime is hard in ScriptedRuntime
    // (no detail field). Name-only path must still match historical live chip text.
    const h = await harness({
      coordinator: new ScriptedRuntime({
        'coordinator:-:0': {
          commandActivityClassification: 'v1',
          steps: [
            { tool: 'coagent_get_mission', body: {}, activityClass: 'other' },
            {
              tool: 'coagent_escalate_to_l3',
              body: { question: 'q' },
              activityClass: 'other',
            },
          ],
        },
      }),
      executor: new ScriptedRuntime({}),
      live,
    });
    await h.platform.createMission({ projectId: 'P', missionId: 'M-live', contract: CONTRACT });
    await h.makeOrchestrator().runMission('M-live', { projectRoot: process.cwd(), maxRounds: 2 });

    const chunks = await live.since('M-live');
    const tools = chunks.filter((c) => c.kind === 'tool');
    assert.ok(tools.length >= 2, `expected live tool chips, got ${tools.length}`);
    assert.ok(tools.some((c) => c.text === 'coagent_get_mission'));
    assert.ok(tools.some((c) => c.text === 'coagent_escalate_to_l3'));
    // No capabilities leak into live stream as tool/text chips.
    assert.equal(
      chunks.filter((c) => (c.text ?? '').includes('runtime.capabilities')).length,
      0,
    );
  });

  test('crash after command.started still projects that start', async () => {
    // Steps run (command.started durable), then hop ends without structured submit.
    // maxRounds:1 so a follow-up uncovered attempt cannot poison the projection.
    const recordThenFail = new ScriptedRuntime({
      'coordinator:-:0': {
        commandActivityClassification: 'v1',
        steps: [
          {
            tool: 'local_cmd',
            callId: 'survived-cmd',
            activityClass: 'command',
            body: {},
            expectFailure: true,
          },
        ],
      },
    });
    const h = await harness({
      coordinator: recordThenFail,
      executor: new ScriptedRuntime({}),
    });
    await h.platform.createMission({ projectId: 'P', missionId: 'M-crash', contract: CONTRACT });
    const orch = h.makeOrchestrator();
    const outcome = await orch.runMission('M-crash', {
      projectRoot: process.cwd(),
      maxRounds: 1,
    });
    assert.ok(outcome.kind === 'waiting' || outcome.kind === 'stalled', outcome.kind);

    const events = await h.platform.getActivity('M-crash');
    const started = events.filter((e) => e.kind === 'runtime.command.started');
    assert.equal(started.length, 1);
    assert.deepEqual(started[0]!.data, { schemaVersion: 1, callId: 'survived-cmd' });
    assert.equal(events.filter((e) => e.kind === 'runtime.command_tracking.enabled').length, 1);
    assert.ok(events.some((e) => e.kind === 'attempt.started'));
    assert.deepEqual(countAuthoritativeCommands(events), { status: 'known', count: 1 });
  });

  test('run.wait rejection after capability + command.started still flushes durable facts', async () => {
    // tool.started is emitted, then the HTTP call fails and wait() rejects (not a normal
    // no_structured_result return). Durable enabled + started must still be awaited.
    const rejectAfterStart = new ScriptedRuntime({
      'coordinator:-:0': {
        commandActivityClassification: 'v1',
        steps: [
          {
            tool: 'not_a_real_platform_tool',
            callId: 'flush-on-reject',
            activityClass: 'command',
            body: {},
            // no expectFailure: !res.ok throws inside wait() after tool.started emit
          },
        ],
      },
    });
    const h = await harness({
      coordinator: rejectAfterStart,
      executor: new ScriptedRuntime({}),
    });
    await h.platform.createMission({ projectId: 'P', missionId: 'M-wait-rej', contract: CONTRACT });
    const orch = h.makeOrchestrator();
    const outcome = await orch.runMission('M-wait-rej', {
      projectRoot: process.cwd(),
      maxRounds: 1,
    });
    assert.ok(outcome.kind === 'waiting' || outcome.kind === 'stalled', outcome.kind);

    const events = await h.platform.getActivity('M-wait-rej');
    assert.equal(events.filter((e) => e.kind === 'runtime.command_tracking.enabled').length, 1);
    const started = events.filter((e) => e.kind === 'runtime.command.started');
    assert.equal(started.length, 1);
    assert.deepEqual(started[0]!.data, { schemaVersion: 1, callId: 'flush-on-reject' });
    assert.ok(events.some((e) => e.kind === 'attempt.started'));
    assert.deepEqual(countAuthoritativeCommands(events), { status: 'known', count: 1 });
  });

  test('durable command writes are serial: enabled completes before later started/invalid begin', async () => {
    const probe = new SerialProbeActivityLog(new FixedClock(), 25);
    const h = await harness({
      activity: probe,
      coordinator: new ScriptedRuntime({
        'coordinator:-:0': {
          commandActivityClassification: 'v1',
          steps: [
            {
              tool: 'cmd_a',
              callId: 'serial-1',
              activityClass: 'command',
              body: {},
              expectFailure: true,
            },
            {
              tool: 'cmd_b',
              callId: 'serial-2',
              activityClass: 'command',
              body: {},
              expectFailure: true,
            },
            // missing activityClass after cover → invalid (still after both started enqueues)
            { tool: 'coagent_get_mission', body: {} },
            {
              tool: 'coagent_escalate_to_l3',
              body: { question: 'q' },
              activityClass: 'other',
            },
          ],
        },
      }),
      executor: new ScriptedRuntime({}),
    });
    await h.platform.createMission({ projectId: 'P', missionId: 'M-serial', contract: CONTRACT });
    await h.makeOrchestrator().runMission('M-serial', {
      projectRoot: process.cwd(),
      maxRounds: 1,
    });

    // Never concurrent: each append finishes before the next begins.
    assert.equal(probe.maxInFlight, 1);
    const starts = probe.commandPhases.filter((p) => p.phase === 'start').map((p) => p.kind);
    assert.deepEqual(starts, [
      'runtime.command_tracking.enabled',
      'runtime.command.started',
      'runtime.command.started',
      'runtime.command_tracking.invalid',
    ]);
    // Strict alternation start/end of the same kind ⇒ prior completed before next began.
    for (let i = 0; i < probe.commandPhases.length; i += 2) {
      const a = probe.commandPhases[i]!;
      const b = probe.commandPhases[i + 1]!;
      assert.equal(a.phase, 'start');
      assert.equal(b.phase, 'end');
      assert.equal(a.kind, b.kind);
    }

    const events = await h.platform.getActivity('M-serial');
    const cmds = commandKinds(events);
    assert.equal(cmds[0]!.kind, 'runtime.command_tracking.enabled');
    assert.equal(cmds[1]!.kind, 'runtime.command.started');
    assert.equal((cmds[1]!.data as { callId: string }).callId, 'serial-1');
    assert.equal(cmds[2]!.kind, 'runtime.command.started');
    assert.equal((cmds[2]!.data as { callId: string }).callId, 'serial-2');
    assert.equal(cmds[3]!.kind, 'runtime.command_tracking.invalid');
    assert.equal(countAuthoritativeCommands(events).status, 'unknown');
  });

  test('partial durable write failure after enabled: recovery invalid; projection unknown', async () => {
    const failing = new FailStartedActivityLog(new FixedClock());
    const h = await harness({
      activity: failing,
      coordinator: new ScriptedRuntime({
        'coordinator:-:0': {
          commandActivityClassification: 'v1',
          steps: [
            {
              tool: 'local_cmd',
              callId: 'partial-fail-cmd',
              activityClass: 'command',
              body: {},
              expectFailure: true,
            },
            {
              tool: 'coagent_escalate_to_l3',
              body: { question: 'q' },
              activityClass: 'other',
            },
          ],
        },
      }),
      executor: new ScriptedRuntime({}),
    });
    await h.platform.createMission({ projectId: 'P', missionId: 'M-partial', contract: CONTRACT });
    const outcome = await h.makeOrchestrator().runMission('M-partial', {
      projectRoot: process.cwd(),
      maxRounds: 1,
    });
    // Write failure surfaces as hop failure taxonomy (waiting/stalled), not silent success.
    assert.ok(outcome.kind === 'waiting' || outcome.kind === 'stalled', outcome.kind);

    assert.ok(failing.startedAttempts >= 1, 'command.started append was attempted');
    const events = await h.platform.getActivity('M-partial');
    assert.equal(events.filter((e) => e.kind === 'runtime.command_tracking.enabled').length, 1);
    assert.equal(events.filter((e) => e.kind === 'runtime.command.started').length, 0);
    assert.equal(events.filter((e) => e.kind === 'runtime.command_tracking.invalid').length, 1);
    // enabled then recovery invalid — fail closed, never known short count
    assert.equal(countAuthoritativeCommands(events).status, 'unknown');
  });

  test('scripted default stays legacy unknown (no v1 opt-in)', async () => {
    const h = await harness();
    await h.platform.createMission({ projectId: 'P', missionId: 'M-legacy', contract: CONTRACT });
    const result = await h.makeOrchestrator().runMission('M-legacy', {
      projectRoot: process.cwd(),
    });
    assert.deepEqual(result, { kind: 'awaiting_l3_review' });

    const events = await h.platform.getActivity('M-legacy');
    assert.equal(commandKinds(events).length, 0);
    assert.equal(countAuthoritativeCommands(events).status, 'unknown');
  });

  test('enabled + missing activityClass => invalid (undercount trap)', async () => {
    const bad: ScriptTable = {
      'coordinator:-:0': {
        commandActivityClassification: 'v1',
        steps: [
          // no activityClass while v1 enabled
          { tool: 'coagent_get_mission', body: {} },
          {
            tool: 'coagent_escalate_to_l3',
            body: { question: 'q' },
            activityClass: 'other',
          },
        ],
      },
    };
    const h = await harness({
      coordinator: new ScriptedRuntime(bad),
      executor: new ScriptedRuntime({}),
    });
    await h.platform.createMission({ projectId: 'P', missionId: 'M-inv', contract: CONTRACT });
    await h.makeOrchestrator().runMission('M-inv', { projectRoot: process.cwd(), maxRounds: 2 });

    const events = await h.platform.getActivity('M-inv');
    assert.ok(events.some((e) => e.kind === 'runtime.command_tracking.enabled'));
    assert.ok(events.some((e) => e.kind === 'runtime.command_tracking.invalid'));
    assert.equal(events.filter((e) => e.kind === 'runtime.command.started').length, 0);
    assert.equal(countAuthoritativeCommands(events).status, 'unknown');
  });
});

describe('BUDGET-001-S4 no public write surface', () => {
  test('no HTTP route, agent tool, or caller-authored ActivityEvent input for command facts', () => {
    const serverSrc = readFileSync(join(root, 'src', 'api', 'server.ts'), 'utf8');
    const webSrc = readFileSync(join(root, 'src', 'api', 'web.ts'), 'utf8');
    const platformSrc = readFileSync(join(root, 'src', 'application', 'platform.ts'), 'utf8');
    const orchSrc = readFileSync(join(root, 'src', 'application', 'orchestrator.ts'), 'utf8');
    const querySrc = readFileSync(join(root, 'src', 'application', 'query-run.ts'), 'utf8');

    assert.doesNotMatch(
      serverSrc,
      /recordCommandTrackingEnabled|recordCommandStarted|recordCommandTrackingInvalid|runtime\.command/,
    );
    assert.doesNotMatch(
      webSrc,
      /recordCommandTrackingEnabled|recordCommandStarted|recordCommandTrackingInvalid|runtime\.command/,
    );

    assert.match(platformSrc, /async recordCommandTrackingEnabled\(missionId: string, attemptId: string\)/);
    assert.match(
      platformSrc,
      /async recordCommandStarted\(missionId: string, attemptId: string, callId: string\)/,
    );
    assert.match(platformSrc, /async recordCommandTrackingInvalid\(missionId: string, attemptId: string\)/);

    assert.match(orchSrc, /recordCommandTrackingEnabled\(/);
    assert.match(orchSrc, /recordCommandStarted\(/);
    assert.match(orchSrc, /recordCommandTrackingInvalid\(/);

    // QueryRunner must not subscribe Mission command accounting.
    assert.doesNotMatch(querySrc, /runtime\.command|recordCommand|activityClass|command_tracking/);

    const scripted = readFileSync(join(root, 'src', 'runtime', 'scripted.ts'), 'utf8');
    assert.doesNotMatch(scripted, /recordCommand/);

    // Hub must never classify by tool name in orchestrator/platform/budget-usage.
    assert.doesNotMatch(orchSrc, /activityClass\s*===\s*['\"]bash['\"]|name\s*===\s*['\"]bash['\"]/);
    assert.doesNotMatch(orchSrc, /powershell/);
    const budgetSrc = readFileSync(join(root, 'src', 'application', 'budget-usage.ts'), 'utf8');
    assert.doesNotMatch(budgetSrc, /\bbash\b|\bpowershell\b/);
  });
});
