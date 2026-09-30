/**
 * BUDGET-001-S5: authoritative budget gates + 70/90/100 + LW budget promotion.
 *
 * Covers plan §8 matrix as far as applicable. changedFiles stays unknown
 * (no trusted Workspace.diff wired into runMission — deliberate).
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
import {
  anyHardAuthoritativeExceeded,
  budgetThresholdCrossings,
  evaluateExecutionBudget,
  hardExceededVerdicts,
  verdictFor,
  type BudgetEvaluation,
} from '../src/application/budget-usage.ts';
import { Orchestrator } from '../src/application/orchestrator.ts';
import { Platform, PlatformRuleError } from '../src/application/platform.ts';
import { makeIssuer } from '../src/main.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';
import type { ExecutionBudget, MissionContract, WorkOrder } from '../src/kernel/index.ts';
import {
  ValidationEngine,
} from '../src/application/validation/engine.ts';
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
import type { ChangedPathReader, CommandRunner } from '../src/application/validation/ports.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: ['不得改 Contract'],
};

const ORDER: WorkOrder = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
  validation: {
    commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }],
  },
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

function sampleBudget(over: Partial<ExecutionBudget> = {}): ExecutionBudget {
  return {
    maxAttempts: 10,
    maxRounds: 10,
    maxWallClockMs: 3_600_000,
    ...over,
  };
}

function fakeRunner(
  impl: CommandRunner['run'] = async () => ({
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    output: 'ok',
  }),
): CommandRunner {
  return { run: impl };
}

function fakePaths(files: readonly string[] = ['src/foo.ts']): ChangedPathReader {
  return {
    async listChanged() {
      return files;
    },
  };
}

async function harness(opts?: {
  coordinator?: ScriptedRuntime;
  executor?: ScriptedRuntime;
  lightweight?: boolean;
}) {
  const clock = new FixedClock('2026-06-01T12:00:00.000Z');
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const projects = new InMemoryProjectRepository();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const reports = new InMemoryValidationReportRepository();
  const engine = new ValidationEngine({
    clock,
    ids: new SequentialIds(),
    commandRunner: fakeRunner(),
    changedPathReader: fakePaths(),
  });
  const workspace = new InPlaceWorkspaceManager();
  const platform = new Platform({
    projects,
    deliveries,
    workspace,
    activity,
    clock,
    ids,
    validation: { engine, reports },
  });
  const tokens = new RunTokenRegistry();
  const server: Server = createApi({ platform, tokens, deliveries });
  await listenLoopback(server, 0);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);

  const coordinatorRt =
    opts?.coordinator ??
    (opts?.lightweight ? new ScriptedRuntime({}) : new ScriptedRuntime(COORDINATOR_HAPPY));
  const executorRt = opts?.executor ?? new ScriptedRuntime(EXECUTOR_HAPPY);

  return {
    platform,
    activity,
    projects,
    clock,
    makeOrchestrator: (pool?: { maxAttempts?: number }) =>
      new Orchestrator({
        platform,
        tokens: makeIssuer(platform, tokens),
        baseUrl,
        workspace,
        coordinator: {
          runtime: coordinatorRt,
          candidates: [{ endpoint: 'local', profileId: 'coordinator-a' }],
          maxAttempts: pool?.maxAttempts,
        },
        executor: {
          runtime: executorRt,
          candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
          maxAttempts: pool?.maxAttempts,
        },
      }),
  };
}

async function seedStandard(
  projects: InMemoryProjectRepository,
  opts: {
    missionId?: string;
    budget?: ExecutionBudget;
  } = {},
): Promise<string> {
  const missionId = opts.missionId ?? 'M-std';
  const project = await projects.ensure('P');
  project.createMission({
    id: missionId,
    contract: CONTRACT,
    executionMode: 'standard',
    runKind: 'mutation',
    origin: { clientType: 'cli', conversationRef: 'local-cli' },
    executionBudget: opts.budget,
  });
  await projects.save(project);
  return missionId;
}

async function seedLightweight(
  projects: InMemoryProjectRepository,
  opts: {
    missionId?: string;
    budget?: ExecutionBudget;
    withWorkItem?: boolean;
  } = {},
): Promise<string> {
  const missionId = opts.missionId ?? 'M-lw';
  const project = await projects.ensure('P');
  project.createMission({
    id: missionId,
    contract: CONTRACT,
    executionMode: 'lightweight',
    runKind: 'mutation',
    origin: { clientType: 'cli', conversationRef: 'local-cli' },
    executionBudget: opts.budget,
  });
  if (opts.withWorkItem !== false) {
    const mission = project.missions.find((m) => m.id === missionId)!;
    mission.createWorkItem({ id: 'W-1', title: '修 foo', order: ORDER });
  }
  await projects.save(project);
  return missionId;
}

function thresholdEvents(events: readonly { kind: string; data?: unknown }[]) {
  return events.filter((e) => e.kind === 'mission.budget.threshold');
}

function promotedEvents(events: readonly { kind: string; data?: unknown }[]) {
  return events.filter((e) => e.kind === 'mission.promoted');
}

describe('budgetThresholdCrossings (pure)', () => {
  test('limit 0 => only 100; multi-band jump emits 70 and 90', () => {
    const zero = evaluateExecutionBudget(
      sampleBudget({ maxAttempts: 0, maxRounds: 5, maxWallClockMs: 1 }),
      {
        missionId: 'm',
        capturedAt: 't',
        attemptCount: 0,
        roundCount: 0,
        wallClockMs: 0,
      },
    );
    const zc = budgetThresholdCrossings(zero).filter((c) => c.dimension === 'attempts');
    assert.deepEqual(
      zc.map((c) => c.threshold),
      [100],
    );

    const mid = evaluateExecutionBudget(
      sampleBudget({ maxAttempts: 10, maxInputTokens: 100 }),
      {
        missionId: 'm',
        capturedAt: 't',
        attemptCount: 1,
        roundCount: 0,
        wallClockMs: 0,
        tokenAggregate: { inputTokens: 95, outputTokens: 0, totalTokens: 95 },
        costAggregate: 0,
      },
    );
    const tok = budgetThresholdCrossings(mid).filter((c) => c.dimension === 'inputTokens');
    assert.deepEqual(
      tok.map((c) => c.threshold),
      [70, 90],
    );
    assert.equal(anyHardAuthoritativeExceeded(mid), false);
  });

  test('soft exceeded is not hard', () => {
    const ev = evaluateExecutionBudget(
      sampleBudget({ maxTotalTokens: 10 }),
      {
        missionId: 'm',
        capturedAt: 't',
        attemptCount: 0,
        roundCount: 0,
        wallClockMs: 0,
        tokenAggregate: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
        costAggregate: 0,
      },
    );
    assert.equal(verdictFor(ev, 'totalTokens').status, 'exceeded');
    assert.equal(anyHardAuthoritativeExceeded(ev), false);
    assert.equal(hardExceededVerdicts(ev).length, 0);
    const soft100 = budgetThresholdCrossings(ev).filter(
      (c) => c.dimension === 'totalTokens' && c.threshold === 100,
    );
    assert.equal(soft100.length, 1);
    assert.equal(soft100[0]!.class, 'soft');
  });
});

describe('BUDGET-001-S5 gates', () => {
  test('1. no budget => behavior matches prior happy path (heuristic stalls unchanged)', async () => {
    const h = await harness();
    const missionId = await seedStandard(h.projects, { missionId: 'M-nobudget' });
    const orch = h.makeOrchestrator();
    const result = await orch.runMission(missionId, { projectRoot: process.cwd() });
    assert.deepEqual(result, { kind: 'awaiting_l3_review' });
    const events = await h.activity.list(missionId);
    assert.equal(thresholdEvents(events).length, 0);
    assert.equal(promotedEvents(events).length, 0);
    const view = await h.platform.getMissionView(missionId);
    assert.equal(view.waitReason, undefined);
  });

  test('2. maxAttempts:0 Standard PRE => waiting execution_budget_exceeded, zero hops', async () => {
    const h = await harness();
    const missionId = await seedStandard(h.projects, {
      missionId: 'M-zero-att',
      budget: sampleBudget({ maxAttempts: 0 }),
    });
    const orch = h.makeOrchestrator();
    const result = await orch.runMission(missionId, { projectRoot: process.cwd() });
    assert.equal(result.kind, 'waiting');
    assert.equal((result as { reason: string }).reason, 'execution_budget_exceeded');
    assert.equal(orch.hops.length, 0);
    const events = await h.activity.list(missionId);
    assert.equal(
      events.filter((e) => e.kind === 'orchestration.round.started').length,
      0,
    );
    assert.equal(events.filter((e) => e.kind === 'attempt.started').length, 0);
    const view = await h.platform.getMissionView(missionId);
    assert.equal(view.waitReason, 'execution_budget_exceeded');
    assert.match(view.waitDetail ?? '', /attempts/);
  });

  test('2b. maxAttempts:0 LW PRE => promote then Standard wait; zero hops', async () => {
    const h = await harness({ lightweight: true });
    const missionId = await seedLightweight(h.projects, {
      missionId: 'M-lw-zero',
      budget: sampleBudget({ maxAttempts: 0 }),
    });
    const orch = h.makeOrchestrator();
    const result = await orch.runMission(missionId, { projectRoot: process.cwd() });
    assert.equal(result.kind, 'waiting');
    assert.equal((result as { reason: string }).reason, 'execution_budget_exceeded');
    assert.equal(orch.hops.length, 0);
    const events = await h.activity.list(missionId);
    const promoted = promotedEvents(events);
    assert.equal(promoted.length, 1);
    assert.equal((promoted[0]!.data as { triggerCode: string }).triggerCode, 'budget_exceeded');
    const view = await h.platform.getMissionView(missionId);
    assert.equal(view.executionMode, 'standard');
    assert.equal(view.waitReason, 'execution_budget_exceeded');
    assert.equal(view.promotions.length, 1);
    assert.equal(view.promotions[0]!.triggerCode, 'budget_exceeded');
    assert.match(view.promotions[0]!.triggerRule, /^hard:/);
  });

  test('3. attempts used==limit stops next PRE without extra Attempt', async () => {
    const h = await harness();
    const missionId = await seedStandard(h.projects, {
      missionId: 'M-att-eq',
      budget: sampleBudget({ maxAttempts: 1 }),
    });
    // First run: one coordinator hop consumes the single attempt, then POST may
    // not yet exceed if used==1 and we compare used>=limit after hop — POST stops.
    const orch = h.makeOrchestrator();
    const first = await orch.runMission(missionId, {
      projectRoot: process.cwd(),
      maxRounds: 4,
    });
    // After first coordinator attempt, used=1 >= limit=1 => hard wait on POST or next PRE.
    assert.equal(first.kind, 'waiting');
    assert.equal((first as { reason: string }).reason, 'execution_budget_exceeded');
    const view = await h.platform.getMissionView(missionId);
    assert.equal(view.coordinatorAttemptIds.length, 1);
    // Second run must not create another attempt.
    const orch2 = h.makeOrchestrator();
    const second = await orch2.runMission(missionId, { projectRoot: process.cwd() });
    assert.equal(second.kind, 'waiting');
    assert.equal((second as { reason: string }).reason, 'execution_budget_exceeded');
    assert.equal(orch2.hops.length, 0);
    const view2 = await h.platform.getMissionView(missionId);
    assert.equal(view2.coordinatorAttemptIds.length, 1);
  });

  test('4. rounds used>=maxRounds does not recordOrchestrationRoundStarted', async () => {
    const h = await harness();
    const missionId = await seedStandard(h.projects, {
      missionId: 'M-rounds',
      budget: sampleBudget({ maxRounds: 1, maxAttempts: 20 }),
    });
    const orch = h.makeOrchestrator();
    // First loop: PRE ok (0 rounds), records 1 round, hop runs, POST ok on rounds
    // (1 < not exceeded if maxRounds is 1 → used 1 >= 1 exceeded on POST).
    const first = await orch.runMission(missionId, { projectRoot: process.cwd(), maxRounds: 5 });
    const events1 = await h.activity.list(missionId);
    const rounds1 = events1.filter((e) => e.kind === 'orchestration.round.started').length;
    assert.ok(rounds1 >= 1);
    // If still waiting on attempts/other, force re-entry with rounds already at limit.
    const orch2 = h.makeOrchestrator();
    await orch2.runMission(missionId, { projectRoot: process.cwd(), maxRounds: 5 });
    const events2 = await h.activity.list(missionId);
    const rounds2 = events2.filter((e) => e.kind === 'orchestration.round.started').length;
    // No additional round beyond what PRE allows when already at/over maxRounds.
    // After first successful round start, subsequent PRE sees roundCount>=1 with maxRounds=1.
    assert.equal(rounds2, rounds1);
    void first;
  });

  test('5+6. non-reported tokens / missing cost => no soft threshold, no promotion', async () => {
    const h = await harness();
    const missionId = await seedStandard(h.projects, {
      missionId: 'M-soft-unk',
      budget: sampleBudget({
        maxInputTokens: 1,
        maxCost: 0.001,
        maxAttempts: 50,
        maxRounds: 50,
      }),
    });
    // Authoritative unknown usage (quality unknown / missing cost) must not
    // emit soft token/cost thresholds or promote.
    const a = await h.platform.startCoordinatorAttempt(missionId, {
      endpoint: 'local',
      profileId: 'c',
    });
    await h.platform.finishAttempt(missionId, a.attemptId, {
      endedBy: 'no_structured_result',
      usage: {
        input: 999,
        output: 999,
        cacheRead: 0,
        cacheWrite: 0,
        total: 1998,
        // cost omitted
        quality: 'unknown',
      },
    });
    const { evaluation, snapshot } = await h.platform.evaluateMissionBudget(missionId);
    assert.equal('tokenAggregate' in snapshot, false);
    assert.equal('costAggregate' in snapshot, false);
    assert.equal(verdictFor(evaluation, 'inputTokens').status, 'unknown');
    assert.equal(verdictFor(evaluation, 'cost').status, 'unknown');
    assert.equal(anyHardAuthoritativeExceeded(evaluation), false);
    await h.platform.recordBudgetThresholdEvents(missionId, evaluation);
    const events = await h.activity.list(missionId);
    for (const e of thresholdEvents(events)) {
      const dim = (e.data as { dimension: string }).dimension;
      assert.notEqual(dim, 'inputTokens');
      assert.notEqual(dim, 'outputTokens');
      assert.notEqual(dim, 'totalTokens');
      assert.notEqual(dim, 'cost');
    }
    assert.equal(promotedEvents(events).length, 0);
    await assert.rejects(
      () => h.platform.promoteLightweightForBudgetExceeded(missionId),
      (err: unknown) =>
        err instanceof PlatformRuleError &&
        (err.code === 'LIGHTWEIGHT_MODE_REQUIRED' ||
          err.code === 'BUDGET_NOT_AUTHORITATIVELY_EXCEEDED'),
    );
  });

  test('7. maxCommands known 0 vs omitted unknown', async () => {
    const h = await harness();
    const missionId = await seedStandard(h.projects, {
      missionId: 'M-cmd',
      budget: sampleBudget({ maxCommands: 0, maxAttempts: 0 }),
    });
    // maxAttempts:0 hard-stops first; evaluateMissionBudget still exposes commands.
    const { evaluation, snapshot } = await h.platform.evaluateMissionBudget(missionId);
    // No attempts and no tracking facts => commandCount known 0.
    assert.equal(snapshot.commandCount, 0);
    assert.equal(verdictFor(evaluation, 'commands').status, 'exceeded');

    // With only maxCommands and honest progress path without tracking → after
    // attempts exist without command cover, commands become unknown.
    const missionId2 = await seedStandard(h.projects, {
      missionId: 'M-cmd2',
      budget: sampleBudget({ maxCommands: 1, maxAttempts: 50, maxRounds: 50 }),
    });
    const orch = h.makeOrchestrator();
    await orch.runMission(missionId2, { projectRoot: process.cwd(), maxRounds: 1 });
    const ev2 = await h.platform.evaluateMissionBudget(missionId2);
    // After attempt.started without command tracking cover → unknown commands.
    if (ev2.snapshot.attemptCount > 0) {
      assert.equal('commandCount' in ev2.snapshot, false);
      assert.equal(verdictFor(ev2.evaluation, 'commands').status, 'unknown');
    }
  });

  test('8. 70 then 90 each once; rerun does not duplicate', async () => {
    const h = await harness();
    const missionId = await seedStandard(h.projects, {
      missionId: 'M-thr',
      budget: sampleBudget({ maxAttempts: 10 }),
    });
    // Seed synthetic attempts via platform start/finish is heavy; drive via evaluate+record.
    // Simulate usage by recording thresholds from crafted evaluation path:
    // Use real attempts by running one hop then manually record with elevated limits...
    // Simpler: call recordBudgetThresholdEvents twice with a fabricated evaluation
    // through evaluate after creating attempts with known counts.
    const project = await h.projects.get('P');
    const mission = project!.missions.find((m) => m.id === missionId)!;
    // No attempts yet: 0/10 => no 70.
    let { evaluation } = await h.platform.evaluateMissionBudget(missionId);
    await h.platform.recordBudgetThresholdEvents(missionId, evaluation);
    assert.equal(thresholdEvents(await h.activity.list(missionId)).length, 0);

    // Create 7 coordinator attempts by starting/finishing via platform API surface.
    for (let i = 0; i < 7; i += 1) {
      const a = await h.platform.startCoordinatorAttempt(missionId, {
        endpoint: 'local',
        profileId: 'c',
      });
      await h.platform.finishAttempt(missionId, a.attemptId, {
        endedBy: 'no_structured_result',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
          quality: 'unknown',
        },
      });
    }
    ({ evaluation } = await h.platform.evaluateMissionBudget(missionId));
    assert.equal(verdictFor(evaluation, 'attempts').used, 7);
    await h.platform.recordBudgetThresholdEvents(missionId, evaluation);
    let thr = thresholdEvents(await h.activity.list(missionId));
    assert.equal(thr.filter((e) => (e.data as { threshold: number }).threshold === 70).length, 1);
    assert.equal(thr.filter((e) => (e.data as { threshold: number }).threshold === 90).length, 0);

    // Push to 9/10.
    for (let i = 0; i < 2; i += 1) {
      const a = await h.platform.startCoordinatorAttempt(missionId, {
        endpoint: 'local',
        profileId: 'c',
      });
      await h.platform.finishAttempt(missionId, a.attemptId, {
        endedBy: 'no_structured_result',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
          quality: 'unknown',
        },
      });
    }
    ({ evaluation } = await h.platform.evaluateMissionBudget(missionId));
    await h.platform.recordBudgetThresholdEvents(missionId, evaluation);
    thr = thresholdEvents(await h.activity.list(missionId));
    assert.equal(thr.filter((e) => (e.data as { threshold: number }).threshold === 70).length, 1);
    assert.equal(thr.filter((e) => (e.data as { threshold: number }).threshold === 90).length, 1);

    // Rerun emit: still once each.
    await h.platform.recordBudgetThresholdEvents(missionId, evaluation);
    thr = thresholdEvents(await h.activity.list(missionId));
    assert.equal(thr.filter((e) => (e.data as { threshold: number }).threshold === 70).length, 1);
    assert.equal(thr.filter((e) => (e.data as { threshold: number }).threshold === 90).length, 1);
    void mission;
  });

  test('9. soft 100%: threshold event, mission continues (no wait)', async () => {
    // Soft limits alone never stop. Use high hard limits + soft maxTotalTokens:0
    // with empty attempts (tokenAggregate 0) => soft 100, hard ok.
    const h = await harness();
    const missionId = await seedStandard(h.projects, {
      missionId: 'M-soft100',
      budget: sampleBudget({
        maxAttempts: 50,
        maxRounds: 50,
        maxTotalTokens: 0,
      }),
    });
    const orch = h.makeOrchestrator();
    const result = await orch.runMission(missionId, { projectRoot: process.cwd() });
    assert.deepEqual(result, { kind: 'awaiting_l3_review' });
    const events = await h.activity.list(missionId);
    const soft = thresholdEvents(events).filter(
      (e) =>
        (e.data as { dimension: string; threshold: number; class: string }).dimension ===
          'totalTokens' &&
        (e.data as { threshold: number }).threshold === 100 &&
        (e.data as { class: string }).class === 'soft',
    );
    assert.ok(soft.length >= 1);
    const view = await h.platform.getMissionView(missionId);
    assert.notEqual(view.waitReason, 'execution_budget_exceeded');
  });

  test('10. hard 100% Standard: waiting/execution_budget_exceeded, no mission.promoted', async () => {
    const h = await harness();
    const missionId = await seedStandard(h.projects, {
      missionId: 'M-hard-std',
      budget: sampleBudget({ maxAttempts: 0 }),
    });
    const orch = h.makeOrchestrator();
    const result = await orch.runMission(missionId, { projectRoot: process.cwd() });
    assert.equal(result.kind, 'waiting');
    assert.equal((result as { reason: string }).reason, 'execution_budget_exceeded');
    const events = await h.activity.list(missionId);
    assert.equal(promotedEvents(events).length, 0);
  });

  test('11. hard 100% LW: mission.promoted + standard + no budget waitReason after promote when still hard → wait after; mode flipped', async () => {
    // maxRounds:0 with known 0 rounds: hard exceeded at PRE, promote, then Standard waits.
    const h = await harness({ lightweight: true });
    const missionId = await seedLightweight(h.projects, {
      missionId: 'M-lw-hard',
      budget: sampleBudget({ maxRounds: 0, maxAttempts: 50 }),
    });
    const orch = h.makeOrchestrator();
    const result = await orch.runMission(missionId, { projectRoot: process.cwd() });
    const events = await h.activity.list(missionId);
    const promoted = promotedEvents(events);
    assert.equal(promoted.length, 1);
    assert.equal((promoted[0]!.data as { triggerCode: string }).triggerCode, 'budget_exceeded');
    const view = await h.platform.getMissionView(missionId);
    assert.equal(view.executionMode, 'standard');
    // After promote, Standard PRE still sees rounds exceeded → wait.
    assert.equal(result.kind, 'waiting');
    assert.equal((result as { reason: string }).reason, 'execution_budget_exceeded');
  });

  test('11b. internal promote alone flips mode, leaves waitReason clear; residual hard still gates hop', async () => {
    const h = await harness({ lightweight: true });
    const missionId = await seedLightweight(h.projects, {
      missionId: 'M-lw-api',
      budget: sampleBudget({ maxAttempts: 0, maxRounds: 50 }),
    });
    const out = await h.platform.promoteLightweightForBudgetExceeded(missionId);
    assert.equal(out.changed, true);
    assert.equal(out.promotion.triggerCode, 'budget_exceeded');
    assert.match(out.promotion.triggerRule, /^hard:attempts/);
    let view = await h.platform.getMissionView(missionId);
    assert.equal(view.executionMode, 'standard');
    assert.equal(view.waitReason, undefined);

    // Residual hard exceed: Standard runMission must wait, not create hops.
    const orch = h.makeOrchestrator();
    const result = await orch.runMission(missionId, { projectRoot: process.cwd() });
    assert.equal(result.kind, 'waiting');
    assert.equal((result as { reason: string }).reason, 'execution_budget_exceeded');
    assert.equal(orch.hops.length, 0);
    view = await h.platform.getMissionView(missionId);
    assert.equal(view.executionMode, 'standard');
  });

  test('12. public API hand-filled budget_exceeded still fails, no mutation', async () => {
    const h = await harness({ lightweight: true });
    const missionId = await seedLightweight(h.projects, {
      missionId: 'M-pub',
      budget: sampleBudget({ maxAttempts: 0 }),
    });
    await assert.rejects(
      () =>
        h.platform.promoteMissionToStandard(missionId, {
          code: 'budget_exceeded',
          rule: 'hard:attempts',
        }),
      (err: unknown) => {
        assert.ok(err instanceof PlatformRuleError);
        assert.equal(err.code, 'BUDGET_PROMOTION_NOT_READY');
        return true;
      },
    );
    const view = await h.platform.getMissionView(missionId);
    assert.equal(view.executionMode, 'lightweight');
    assert.equal(view.promotions.length, 0);
  });

  test('12b. internal promote rejects when not authoritatively hard-exceeded', async () => {
    const h = await harness({ lightweight: true });
    const missionId = await seedLightweight(h.projects, {
      missionId: 'M-noex',
      budget: sampleBudget({ maxAttempts: 100 }),
    });
    await assert.rejects(
      () => h.platform.promoteLightweightForBudgetExceeded(missionId),
      (err: unknown) => {
        assert.ok(err instanceof PlatformRuleError);
        assert.equal(err.code, 'BUDGET_NOT_AUTHORITATIVELY_EXCEEDED');
        return true;
      },
    );
  });

  test('13. pool attempt_limit_reached vs budget: budget label wins when already over', async () => {
    const h = await harness();
    const missionId = await seedStandard(h.projects, {
      missionId: 'M-vs-pool',
      budget: sampleBudget({ maxAttempts: 0 }),
    });
    // pool maxAttempts:1 would also stop, but budget PRE fires first with zero hops.
    const orch = h.makeOrchestrator({ maxAttempts: 1 });
    const result = await orch.runMission(missionId, { projectRoot: process.cwd() });
    assert.equal(result.kind, 'waiting');
    assert.equal((result as { reason: string }).reason, 'execution_budget_exceeded');
    assert.notEqual((result as { reason: string }).reason, 'attempt_limit_reached');
  });

  test('changedFiles remains unknown without trusted diff in runMission', async () => {
    const h = await harness();
    const missionId = await seedStandard(h.projects, {
      missionId: 'M-files',
      budget: sampleBudget({ maxChangedFiles: 0, maxAttempts: 50, maxRounds: 50 }),
    });
    const { evaluation, snapshot } = await h.platform.evaluateMissionBudget(missionId);
    assert.equal('changedFileCount' in snapshot, false);
    assert.equal(verdictFor(evaluation, 'changedFiles').status, 'unknown');
    // Must not hard-stop on changedFiles alone.
    const orch = h.makeOrchestrator();
    const result = await orch.runMission(missionId, { projectRoot: process.cwd() });
    assert.deepEqual(result, { kind: 'awaiting_l3_review' });
  });

  // 旧不变式：HA 调度前 stalled、不进预算路径、不记 round。E3a 删了那段，HA 与 Standard 同走预算闸。
  test('HA 与 Standard 走同一预算路径：maxAttempts:0 同样 waiting，不晋升', async () => {
    const h = await harness();
    const stdId = await seedStandard(h.projects, {
      missionId: 'M-std-b0',
      budget: sampleBudget({ maxAttempts: 0 }),
    });
    const project = await h.projects.ensure('P');
    project.createMission({
      id: 'M-ha-b',
      contract: CONTRACT,
      executionMode: 'high_assurance',
      runKind: 'mutation',
      origin: { clientType: 'cli', conversationRef: 'local-cli' },
      executionBudget: sampleBudget({ maxAttempts: 0 }),
    });
    await h.projects.save(project);

    const stdOrch = h.makeOrchestrator();
    const stdResult = await stdOrch.runMission(stdId, { projectRoot: process.cwd() });
    const haOrch = h.makeOrchestrator();
    const haResult = await haOrch.runMission('M-ha-b', { projectRoot: process.cwd() });

    assert.equal(stdResult.kind, 'waiting');
    assert.equal((stdResult as { reason: string }).reason, 'execution_budget_exceeded');
    assert.equal(haResult.kind, stdResult.kind);
    assert.equal(
      (haResult as { reason: string }).reason,
      (stdResult as { reason: string }).reason,
    );
    assert.equal(stdOrch.hops.length, 0);
    assert.equal(haOrch.hops.length, 0);

    const stdEvents = await h.activity.list(stdId);
    const haEvents = await h.activity.list('M-ha-b');
    assert.equal(
      haEvents.filter((e) => e.kind === 'orchestration.round.started').length,
      stdEvents.filter((e) => e.kind === 'orchestration.round.started').length,
    );
    assert.equal(thresholdEvents(haEvents).length, thresholdEvents(stdEvents).length);
    assert.equal(promotedEvents(haEvents).length, promotedEvents(stdEvents).length);
    assert.equal(promotedEvents(haEvents).length, 0);

    const stdView = await h.platform.getMissionView(stdId);
    const haView = await h.platform.getMissionView('M-ha-b');
    assert.equal(haView.waitReason, stdView.waitReason);
    assert.equal(stdView.executionMode, 'standard');
    assert.equal(haView.executionMode, 'high_assurance');
  });
});

describe('BUDGET-001-S5 source boundaries', () => {
  test('public surfaces reject caller budget_exceeded; no HTTP budget promote', () => {
    const platformSrc = readFileSync(join(root, 'src/application/platform.ts'), 'utf8');
    assert.match(platformSrc, /promoteLightweightForBudgetExceeded/);
    assert.match(platformSrc, /BUDGET_PROMOTION_NOT_READY/);
    assert.match(platformSrc, /BUDGET_NOT_AUTHORITATIVELY_EXCEEDED/);

    const serverSrc = readFileSync(join(root, 'src/api/server.ts'), 'utf8');
    assert.doesNotMatch(serverSrc, /promoteLightweightForBudgetExceeded|evaluateMissionBudget/);

    const orchSrc = readFileSync(join(root, 'src/application/orchestrator.ts'), 'utf8');
    assert.match(orchSrc, /enforceAuthoritativeBudget|execution_budget_exceeded/);
    // Heuristics preserved.
    assert.match(orchSrc, /maxRounds \?\? 12/);
    assert.match(orchSrc, /ATTEMPT_WALL_CLOCK_MS|30 \* 60 \* 1000/);
  });

  test('WaitReason UI tables include execution_budget_exceeded', () => {
    for (const file of ['src/web/narrate.js', 'src/api/web.ts']) {
      const src = readFileSync(join(root, file), 'utf8');
      assert.match(src, /execution_budget_exceeded/);
    }
  });
});

// type-only silence
void (null as unknown as BudgetEvaluation);
