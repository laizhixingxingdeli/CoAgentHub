/**
 * E3a：HA 独立检视派发的故障停法。验收 3。
 * 不替换 process.stdout.write。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApi } from '../src/api/server.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Orchestrator } from '../src/application/orchestrator.ts';
import { Platform, PlatformRuleError } from '../src/application/platform.ts';
import { makeIssuer } from '../src/main.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';
import type { WorkspaceManager } from '../src/application/workspace.ts';

const CONTRACT: MissionContract = {
  intent: 'HA 故障夹具',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
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
  validation: { commands: [{ argv: ['node', '--test'], timeoutMs: 1000 }] },
};

const PLAN = {
  findings: 'f',
  rootCause: 'r',
  rejectedHypotheses: [],
  decisions: [],
  direction: 'd',
  risks: [],
};

const IR_PASS: ScriptTable = {
  'independent_reviewer:-': {
    steps: [
      { tool: 'coagent_get_mission_review_bundle', body: {} },
      {
        tool: 'coagent_submit_independent_review',
        body: { verdict: 'pass', reasons: ['L2 与报告齐，当前 HEAD 可放行'] },
      },
    ],
  },
};

const temps: string[] = [];
const servers: Server[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  for (const server of servers) server.close();
});

function stubWorkspace(head = 'commit-a'): WorkspaceManager & { setHead(next: string): void } {
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
    setHead(next: string) {
      current = next;
    },
  };
}

async function passingEngine(ids: SequentialIds) {
  const reports = new InMemoryValidationReportRepository();
  return {
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
}

async function seedHaReviewed(opts: {
  coordProfile?: { profileId: string; endpoint: string } | null;
  execProfile?: { profileId: string; endpoint: string };
  head?: string;
}) {
  const clock = new FixedClock();
  const projects = new InMemoryProjectRepository();
  const ids = new SequentialIds();
  const workspace = stubWorkspace(opts.head ?? 'commit-a');
  const validation = await passingEngine(ids);
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({
    projects,
    deliveries,
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
    workspace,
    validation,
  });
  const project = await projects.ensure('P');
  project.createMission({
    id: 'M-ha',
    contract: CONTRACT,
    executionMode: 'high_assurance',
  });
  await projects.save(project);
  const root = mkdtempSync(join(tmpdir(), 'coagent-e3a-ha-'));
  temps.push(root);
  const prepared = await workspace.prepare('M-ha', root);
  await platform.recordWorkspace('M-ha', {
    projectRoot: root,
    branch: prepared.branch,
    baseRevision: prepared.baseRevision,
  });
  const coord =
    opts.coordProfile === null
      ? await platform.startCoordinatorAttempt('M-ha')
      : await platform.startCoordinatorAttempt(
          'M-ha',
          opts.coordProfile ?? { profileId: 'coord-a', endpoint: 'local' },
        );
  await platform.updatePlan('M-ha', coord.attemptId, PLAN);
  const { workItemId } = await platform.createWorkItem('M-ha', coord.attemptId, {
    title: '改 foo',
    order: ORDER,
  });
  await platform.dispatchWorkItems('M-ha', coord.attemptId, [workItemId]);
  const exec = await platform.startExecutorAttempt(
    'M-ha',
    workItemId,
    opts.execProfile ?? { profileId: 'exec-a', endpoint: 'local' },
  );
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
    acceptanceResults: ORDER.acceptance.map((criterion) => ({
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
    workspace,
    projects,
    tokens: new RunTokenRegistry(),
    root,
    validation,
    deliveries,
  };
}

describe('E3a HA 独立检视故障停法', () => {
  test('缺独立检视候选：awaiting_review，block reason 可见，不自审', async () => {
    const { platform, tokens, root } = await seedHaReviewed({});
    const orch = new Orchestrator({
      platform,
      tokens: makeIssuer(platform, tokens),
      baseUrl: 'http://127.0.0.1:9',
      workspace: stubWorkspace(),
      coordinator: {
        runtime: new ScriptedRuntime({}),
        candidates: [{ endpoint: 'local', profileId: 'coord-a' }],
      },
      executor: {
        runtime: new ScriptedRuntime({}),
        candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
      },
      independentReviewer: {
        runtime: new ScriptedRuntime({}),
        candidates: [],
      },
    });
    const outcome = await orch.runMission('M-ha', { projectRoot: root });
    assert.equal(outcome.kind, 'waiting');
    const view = await platform.getMissionView('M-ha');
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.independentReviewBlockReason, 'no_candidates');
    assert.ok(view.independentReviewBlockDetail);
    assert.equal(view.haReviewHold, 'fault');
    assert.ok(view.waitDetail);
    assert.equal(view.coordinatorAttemptIds.length, 1);
    assert.equal(
      orch.hops.filter((h) => h.role === 'coordinator').length,
      0,
      '待检视阶段不得再派协调者',
    );
  });

  test('历史 profileId 缺失：history_missing_profile，不自审', async () => {
    const { platform, tokens, root } = await seedHaReviewed({ coordProfile: null });
    const orch = new Orchestrator({
      platform,
      tokens: makeIssuer(platform, tokens),
      baseUrl: 'http://127.0.0.1:9',
      workspace: stubWorkspace(),
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
          'independent_reviewer:-': { steps: [] },
        }),
        candidates: [{ endpoint: 'local', profileId: 'ir-a' }],
      },
    });
    const outcome = await orch.runMission('M-ha', { projectRoot: root });
    assert.equal(outcome.kind, 'waiting');
    const view = await platform.getMissionView('M-ha');
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.independentReviewBlockReason, 'history_missing_profile');
    assert.equal(view.haReviewHold, 'fault');
    assert.equal(view.independentReviewerAttemptIds.length, 0);
  });

  test('候选全部冲突：all_candidates_conflict，不自审', async () => {
    const { platform, tokens, root } = await seedHaReviewed({});
    const orch = new Orchestrator({
      platform,
      tokens: makeIssuer(platform, tokens),
      baseUrl: 'http://127.0.0.1:9',
      workspace: stubWorkspace(),
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
          'independent_reviewer:-': { steps: [] },
        }),
        candidates: [
          { endpoint: 'local', profileId: 'coord-a' },
          { endpoint: 'local', profileId: 'exec-a' },
        ],
      },
    });
    const outcome = await orch.runMission('M-ha', { projectRoot: root });
    assert.equal(outcome.kind, 'waiting');
    const view = await platform.getMissionView('M-ha');
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.independentReviewBlockReason, 'all_candidates_conflict');
    assert.equal(view.haReviewHold, 'fault');
    assert.equal(view.independentReviewerAttemptIds.length, 0);
  });

  test('适配器/运行时失败：waitDetail 可见，不自审', async () => {
    const { platform, tokens, root } = await seedHaReviewed({});
    const orch = new Orchestrator({
      platform,
      tokens: makeIssuer(platform, tokens),
      baseUrl: 'http://127.0.0.1:9',
      workspace: stubWorkspace(),
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
    const outcome = await orch.runMission('M-ha', { projectRoot: root });
    assert.equal(outcome.kind, 'waiting');
    const view = await platform.getMissionView('M-ha');
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.haReviewHold, 'fault');
    assert.match(view.waitDetail ?? '', /检视适配器挂了|HA 独立检视故障/);
    assert.equal(view.finalReview, undefined);
    assert.ok(orch.hops.some((h) => h.role === 'independent_reviewer'));
    assert.equal(
      orch.hops.filter((h) => h.role === 'coordinator').length,
      0,
    );
  });

  test('候选非空但发牌口缺失：可见故障、无悬空 Attempt，补发牌口后续跑可开审', async () => {
    const seeded = await seedHaReviewed({});
    const { platform, tokens, root, workspace, deliveries } = seeded;
    const full = makeIssuer(platform, tokens);
    const withoutIr = {
      startCoordinator: full.startCoordinator.bind(full),
      startExecutor: full.startExecutor.bind(full),
      revoke: full.revoke.bind(full),
    };
    const orch = new Orchestrator({
      platform,
      tokens: withoutIr,
      baseUrl: 'http://127.0.0.1:9',
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
        runtime: new ScriptedRuntime({}),
        candidates: [{ endpoint: 'local', profileId: 'ir-a' }],
      },
    });
    const outcome = await orch.runMission('M-ha', { projectRoot: root });
    assert.equal(outcome.kind, 'waiting');
    const view = await platform.getMissionView('M-ha');
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.haReviewHold, 'fault');
    assert.match(view.waitDetail ?? '', /发牌口|独立检视故障/);
    assert.equal(view.independentReviewerAttemptIds.length, 0);
    assert.equal(
      orch.hops.filter((h) => h.role === 'coordinator').length,
      0,
      '待检视阶段不得再派协调者',
    );

    const server: Server = createApi({ platform, tokens, deliveries });
    await listenLoopback(server, 0);
    servers.push(server);
    const addr = server.address() as AddressInfo;
    const orch2 = new Orchestrator({
      platform,
      tokens: full,
      baseUrl: `http://127.0.0.1:${addr.port}`,
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
        runtime: new ScriptedRuntime(IR_PASS),
        candidates: [{ endpoint: 'local', profileId: 'ir-a' }],
      },
    });
    const outcome2 = await orch2.runMission('M-ha', { projectRoot: root });
    assert.equal(outcome2.kind, 'awaiting_l3_review');
    const view2 = await platform.getMissionView('M-ha');
    assert.ok(view2.independentReviewerAttemptIds.length > 0);
    assert.equal(view2.haReviewHold, 'pending_release');
    assert.equal((await platform.effectiveIndependentReviewPass('M-ha'))?.verdict, 'pass');
  });

  test('机器 HA 放行仍 HIGH_ASSURANCE_NEEDS_HUMAN', async () => {
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const projects = new InMemoryProjectRepository();
    const platform = new Platform({
      projects,
      deliveries: new InMemoryDeliveryRepository(clock, ids),
      activity: new InMemoryActivityLog(clock),
      clock,
      ids,
    });
    const project = await projects.ensure('P');
    const mission = project.createMission({
      id: 'M-ha-fin',
      contract: CONTRACT,
      executionMode: 'high_assurance',
    });
    mission.submitForReview();
    await projects.save(project);
    await assert.rejects(
      () =>
        platform.finalizeMissionByMachine('M-ha-fin', {
          integrationBranch: 'master',
          verification: [{ argv: ['node', '--test'], timeoutMs: 1000 }],
        }),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'HIGH_ASSURANCE_NEEDS_HUMAN',
    );
  });
});
