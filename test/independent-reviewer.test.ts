/**
 * E3a：HA 主链顺序、有效 pass 口径、停在待放行。
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
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
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
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';
import type { WorkspaceManager } from '../src/application/workspace.ts';
import type { TaskFacts } from '../src/application/task-classifier.ts';

const CONTRACT: MissionContract = {
  intent: 'HA 独立检视',
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

function haFacts(): TaskFacts {
  return {
    mutationSideEffect: true,
    readOnlyProven: false,
    highAssurance: {
      productionDeployRelease: false,
      externalPaidOp: false,
      destructiveData: false,
      credentialsPermissionsSecurity: true,
      schemaPublicApiPersistenceCompat: true,
      unrecoverableExternalSideEffect: false,
    },
    standardFloor: {
      publicInterface: true,
      buildSystemOrDependency: false,
      multipleDomainModules: true,
      acceptanceNotCheckableUpfront: false,
      rootCauseOrCompetingDesigns: false,
    },
  };
}

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

function passingValidation(ids: SequentialIds) {
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

async function harness() {
  const clock = new FixedClock();
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const projects = new InMemoryProjectRepository();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const workspace = stubWorkspace();
  const validation = passingValidation(ids);
  const platform = new Platform({
    projects,
    deliveries,
    activity,
    clock,
    ids,
    workspace,
    validation,
  });
  const tokens = new RunTokenRegistry();
  const server: Server = createApi({ platform, tokens, deliveries });
  await listenLoopback(server, 0);
  servers.push(server);
  const addr = server.address() as AddressInfo;
  const root = mkdtempSync(join(tmpdir(), 'coagent-e3a-ir-'));
  temps.push(root);
  return {
    platform,
    activity,
    projects,
    tokens,
    workspace,
    validation,
    ids,
    root,
    baseUrl: `http://127.0.0.1:${addr.port}`,
  };
}

const PLAN_BODY = PLAN;

async function seedReviewed(h: Awaited<ReturnType<typeof harness>>) {
  const project = await h.projects.ensure('P');
  project.createMission({
    id: 'M-ha',
    contract: CONTRACT,
    executionMode: 'high_assurance',
  });
  await h.projects.save(project);
  const prepared = await h.workspace.prepare('M-ha', h.root);
  await h.platform.recordWorkspace('M-ha', {
    projectRoot: h.root,
    branch: prepared.branch,
    baseRevision: prepared.baseRevision,
  });
  const coord = await h.platform.startCoordinatorAttempt('M-ha', {
    profileId: 'coord-a',
    endpoint: 'local',
  });
  await h.platform.updatePlan('M-ha', coord.attemptId, PLAN_BODY);
  const { workItemId } = await h.platform.createWorkItem('M-ha', coord.attemptId, {
    title: '改 foo',
    order: ORDER,
  });
  await h.platform.dispatchWorkItems('M-ha', coord.attemptId, [workItemId]);
  const exec = await h.platform.startExecutorAttempt('M-ha', workItemId, {
    profileId: 'exec-a',
    endpoint: 'local',
  });
  await h.platform.submitEvidence('M-ha', exec.attemptId, {
    kind: 'test',
    summary: '绿',
    command: 'node --test',
    exitCode: 0,
  });
  await h.platform.submitExecutionResult('M-ha', exec.attemptId, {
    outcome: 'completed',
    summary: '改好了',
    changedFiles: ['src/foo.ts'],
    evidenceIds: [],
    notes: '无',
  });
  await h.platform.finishAttempt('M-ha', exec.attemptId, { endedBy: 'structured_submit' });
  await h.platform.reviewExecutionResult('M-ha', coord.attemptId, {
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
  await h.platform.submitMissionResult('M-ha', coord.attemptId, {
    outcome: 'delivered',
    summary: '交付',
    acceptanceEvidence: [],
    memoryDelta: [],
    openRisks: [],
  });
  await h.platform.finishAttempt('M-ha', coord.attemptId, { endedBy: 'structured_submit' });
  return { workItemId, coordAttemptId: coord.attemptId };
}

describe('E3a 独立检视主链与有效 pass', () => {
  test('HA 执行可观察 Contract→coordinator→executor→L2→确定性验证→独立检视', async () => {
    const h = await harness();
    await h.platform.createClassifiedMission({
      projectId: 'P',
      missionId: 'M-seq',
      contract: CONTRACT,
      facts: haFacts(),
    });
    const orch = new Orchestrator({
      platform: h.platform,
      tokens: makeIssuer(h.platform, h.tokens),
      baseUrl: h.baseUrl,
      workspace: h.workspace,
      coordinator: {
        runtime: new ScriptedRuntime(COORDINATOR_HAPPY),
        candidates: [{ endpoint: 'local', profileId: 'coord-a' }],
      },
      executor: {
        runtime: new ScriptedRuntime(EXECUTOR_HAPPY),
        candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
      },
      independentReviewer: {
        runtime: new ScriptedRuntime(IR_PASS),
        candidates: [{ endpoint: 'local', profileId: 'ir-a' }],
      },
    });
    const outcome = await orch.runMission('M-seq', { projectRoot: h.root, maxRounds: 8 });
    assert.equal(outcome.kind, 'awaiting_l3_review');
    const hops = orch.hops.map((row) => row.role);
    assert.deepEqual(hops, ['coordinator', 'executor', 'coordinator', 'independent_reviewer']);
    const events = await h.activity.list('M-seq');
    const kinds = events.map((e) => e.kind);
    const created = kinds.indexOf('mission.created');
    const routed = kinds.indexOf('mission.routed');
    const review = kinds.indexOf('review.recorded');
    const submitted = kinds.indexOf('mission_result.submitted');
    const reported = kinds.findIndex(
      (k, i) =>
        k === 'validation.reported' &&
        (events[i]!.data as { purpose?: string }).purpose === 'ha_deterministic',
    );
    const ir = kinds.indexOf('independent_review.recorded');
    assert.ok(created >= 0 && routed > created);
    assert.ok(review > routed);
    assert.ok(submitted > review);
    assert.ok(reported > submitted, '确定性验证在 L2 交卷之后');
    assert.ok(ir > reported, '独立检视在确定性验证之后');
    const view = await h.platform.getMissionView('M-seq');
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.executionMode, 'high_assurance');
    assert.equal(view.haReviewHold, 'pending_release');
    assert.equal(view.finalReview, undefined);
    const pass = await h.platform.effectiveIndependentReviewPass('M-seq');
    assert.equal(pass?.verdict, 'pass');
  });

  test('缺报告不能记录有效 pass', async () => {
    const h = await harness();
    await seedReviewed(h);
    await assert.rejects(
      () =>
        h.platform.startIndependentReviewerAttempt('M-ha', [
          { profileId: 'ir-a', endpoint: 'local' },
        ]),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'INDEPENDENT_REVIEW_HA_REPORT_MISSING',
    );
    const view = await h.platform.getMissionView('M-ha');
    assert.equal(view.independentReviewerAttemptIds.length, 0);
    assert.equal(await h.platform.effectiveIndependentReviewPass('M-ha'), undefined);
    assert.equal(view.status, 'awaiting_review');
  });

  test('没有完整 L2 不能记录有效 pass', async () => {
    const h = await harness();
    const project = await h.projects.ensure('P');
    project.createMission({
      id: 'M-l2',
      contract: CONTRACT,
      executionMode: 'high_assurance',
    });
    await h.projects.save(project);
    const prepared = await h.workspace.prepare('M-l2', h.root);
    await h.platform.recordWorkspace('M-l2', {
      projectRoot: h.root,
      branch: prepared.branch,
      baseRevision: prepared.baseRevision,
    });
    const coord = await h.platform.startCoordinatorAttempt('M-l2', {
      profileId: 'coord-a',
      endpoint: 'local',
    });
    await h.platform.updatePlan('M-l2', coord.attemptId, PLAN_BODY);
    const { workItemId } = await h.platform.createWorkItem('M-l2', coord.attemptId, {
      title: '改 foo',
      order: { ...ORDER, acceptance: [] },
    });
    await h.platform.dispatchWorkItems('M-l2', coord.attemptId, [workItemId]);
    const exec = await h.platform.startExecutorAttempt('M-l2', workItemId, {
      profileId: 'exec-a',
      endpoint: 'local',
    });
    await h.platform.submitEvidence('M-l2', exec.attemptId, {
      kind: 'test',
      summary: '绿',
      command: 'node --test',
      exitCode: 0,
    });
    await h.platform.submitExecutionResult('M-l2', exec.attemptId, {
      outcome: 'completed',
      summary: '改好了',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: '无',
    });
    await h.platform.finishAttempt('M-l2', exec.attemptId, { endedBy: 'structured_submit' });
    await h.platform.reviewExecutionResult('M-l2', coord.attemptId, {
      workItemId,
      verdict: 'accept',
      reasons: ['没有逐条'],
      requiredChanges: [],
    });
    await h.platform.submitMissionResult('M-l2', coord.attemptId, {
      outcome: 'delivered',
      summary: '交付',
      acceptanceEvidence: [],
      memoryDelta: [],
      openRisks: [],
    });
    await h.platform.finishAttempt('M-l2', coord.attemptId, { endedBy: 'structured_submit' });
    await h.platform.runHaDeterministicValidation('M-l2', h.root);
    const started = await h.platform.startIndependentReviewerAttempt('M-l2', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    await assert.rejects(
      () =>
        h.platform.submitIndependentReview('M-l2', started.attemptId, {
          verdict: 'pass',
          reasons: ['缺逐条也想过'],
        }),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'INDEPENDENT_REVIEW_L2_MISSING',
    );
  });

  test('同一证据下最新 send_back 不得回退到更早 pass', async () => {
    const h = await harness();
    await seedReviewed(h);
    await h.platform.runHaDeterministicValidation('M-ha', h.root);
    const first = await h.platform.startIndependentReviewerAttempt('M-ha', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    await h.platform.submitIndependentReview('M-ha', first.attemptId, {
      verdict: 'pass',
      reasons: ['先过'],
    });
    await h.platform.finishAttempt('M-ha', first.attemptId, { endedBy: 'structured_submit' });
    assert.equal((await h.platform.effectiveIndependentReviewPass('M-ha'))?.verdict, 'pass');
    const second = await h.platform.startIndependentReviewerAttempt('M-ha', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    await h.platform.submitIndependentReview('M-ha', second.attemptId, {
      verdict: 'send_back',
      reasons: ['还要改'],
    });
    await h.platform.finishAttempt('M-ha', second.attemptId, { endedBy: 'structured_submit' });
    assert.equal(await h.platform.effectiveIndependentReviewPass('M-ha'), undefined);
    const view = await h.platform.getMissionView('M-ha');
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.finalReview, undefined);
    assert.equal(view.independentReviews.at(-1)?.verdict, 'send_back');
  });

  test('契约、HEAD、L2 或报告变化后旧 pass 失效', async () => {
    const h = await harness();
    await seedReviewed(h);
    await h.platform.runHaDeterministicValidation('M-ha', h.root);
    const first = await h.platform.startIndependentReviewerAttempt('M-ha', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    await h.platform.submitIndependentReview('M-ha', first.attemptId, {
      verdict: 'pass',
      reasons: ['当时齐'],
    });
    await h.platform.finishAttempt('M-ha', first.attemptId, { endedBy: 'structured_submit' });
    assert.ok(await h.platform.effectiveIndependentReviewPass('M-ha'));

    await h.platform.reviseContract('M-ha', { ...CONTRACT, intent: 'HA 独立检视（改了）' });
    assert.equal(await h.platform.effectiveIndependentReviewPass('M-ha'), undefined, '契约变了');

    const h2 = await harness();
    await seedReviewed(h2);
    await h2.platform.runHaDeterministicValidation('M-ha', h2.root);
    const p2 = await h2.platform.startIndependentReviewerAttempt('M-ha', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    await h2.platform.submitIndependentReview('M-ha', p2.attemptId, {
      verdict: 'pass',
      reasons: ['当时齐'],
    });
    await h2.platform.finishAttempt('M-ha', p2.attemptId, { endedBy: 'structured_submit' });
    h2.workspace.setHead('commit-b');
    assert.equal(await h2.platform.effectiveIndependentReviewPass('M-ha'), undefined, 'HEAD 变了');

    const h3 = await harness();
    const seeded = await seedReviewed(h3);
    await h3.platform.runHaDeterministicValidation('M-ha', h3.root);
    const p3 = await h3.platform.startIndependentReviewerAttempt('M-ha', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    await h3.platform.submitIndependentReview('M-ha', p3.attemptId, {
      verdict: 'pass',
      reasons: ['当时齐'],
    });
    await h3.platform.finishAttempt('M-ha', p3.attemptId, { endedBy: 'structured_submit' });
    await h3.platform.finalizeMission('M-ha', {
      verdict: 'send_back',
      reasons: ['L2 要重做'],
    });
    const coord2 = await h3.platform.startCoordinatorAttempt('M-ha', {
      profileId: 'coord-a',
      endpoint: 'local',
    });
    await h3.platform.dispatchWorkItems('M-ha', coord2.attemptId, [seeded.workItemId]);
    await h3.platform.finishAttempt('M-ha', coord2.attemptId, { endedBy: 'structured_submit' });
    assert.equal(await h3.platform.effectiveIndependentReviewPass('M-ha'), undefined, 'L2 变了');

    const h4 = await harness();
    await seedReviewed(h4);
    const v1 = await h4.platform.runHaDeterministicValidation('M-ha', h4.root);
    const p4 = await h4.platform.startIndependentReviewerAttempt('M-ha', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    await h4.platform.submitIndependentReview('M-ha', p4.attemptId, {
      verdict: 'pass',
      reasons: ['当时齐'],
    });
    await h4.platform.finishAttempt('M-ha', p4.attemptId, { endedBy: 'structured_submit' });
    const still = await h4.platform.effectiveIndependentReviewPass('M-ha');
    assert.ok(still);
    const extra = await h4.validation.engine.validate({ missionId: 'M-ha' });
    await h4.validation.reports.save(extra.report);
    await h4.activity.append({
      projectId: 'P',
      missionId: 'M-ha',
      kind: 'validation.reported',
      data: {
        reportId: extra.report.id,
        passed: true,
        purpose: 'ha_deterministic',
        reviewedCommit: still.reviewedCommit,
        l2Fingerprint: still.l2Fingerprint,
        contractRevision: still.contractRevision,
        workItemIds: still.l2ReviewRefs.map((row) => row.workItemId),
      },
    });
    assert.notEqual(extra.report.id, v1.reportId);
    assert.equal(await h4.platform.effectiveIndependentReviewPass('M-ha'), undefined, '报告变了');
  });

  test('pass 只停在 awaiting_review，不记 FinalReview', async () => {
    const h = await harness();
    await seedReviewed(h);
    await h.platform.runHaDeterministicValidation('M-ha', h.root);
    const started = await h.platform.startIndependentReviewerAttempt('M-ha', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    await h.platform.submitIndependentReview('M-ha', started.attemptId, {
      verdict: 'pass',
      reasons: ['齐'],
    });
    const view = await h.platform.getMissionView('M-ha');
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.finalReview, undefined);
    assert.equal(view.haReviewHold, 'pending_release');
    assert.equal((await h.platform.effectiveIndependentReviewPass('M-ha'))?.verdict, 'pass');
  });

  test('没有 HA 确定性事件时不得用 L2 报告开审或认 pass', async () => {
    const h = await harness();
    await seedReviewed(h);
    const extra = await h.validation.engine.validate({ missionId: 'M-ha' });
    await h.validation.reports.save(extra.report);
    await h.activity.append({
      projectId: 'P',
      missionId: 'M-ha',
      kind: 'validation.reported',
      data: {
        reportId: extra.report.id,
        passed: true,
        purpose: 'validator',
      },
    });
    await assert.rejects(
      () =>
        h.platform.startIndependentReviewerAttempt('M-ha', [
          { profileId: 'ir-a', endpoint: 'local' },
        ]),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'INDEPENDENT_REVIEW_HA_REPORT_MISSING',
    );
    assert.equal(
      (await h.platform.getMissionView('M-ha')).independentReviewerAttemptIds.length,
      0,
    );
    assert.equal(await h.platform.effectiveIndependentReviewPass('M-ha'), undefined);
  });

  test('确定性验证期间 HEAD 变化则拒绝，不产出有效 HA 报告', async () => {
    const h = await harness();
    await seedReviewed(h);
    const original = h.validation.engine.validate.bind(h.validation.engine);
    h.validation.engine.validate = async (input) => {
      h.workspace.setHead('commit-during');
      return original(input);
    };
    await assert.rejects(
      () => h.platform.runHaDeterministicValidation('M-ha', h.root),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'HA_VALIDATION_HEAD_CHANGED',
    );
    const events = await h.activity.list('M-ha');
    assert.equal(
      events.filter(
        (event) =>
          event.kind === 'validation.reported' &&
          (event.data as { purpose?: string } | undefined)?.purpose === 'ha_deterministic',
      ).length,
      0,
    );
    assert.equal(await h.platform.effectiveIndependentReviewPass('M-ha'), undefined);
  });

  test('复用 HA 报告时工作项覆盖或冻结命令不匹配则拒绝', async () => {
    const h = await harness();
    await seedReviewed(h);
    await h.platform.runHaDeterministicValidation('M-ha', h.root);
    const events = await h.activity.list('M-ha');
    const ha = [...events].reverse().find(
      (event) =>
        event.kind === 'validation.reported' &&
        (event.data as { purpose?: string } | undefined)?.purpose === 'ha_deterministic',
    );
    assert.ok(ha);
    const data = ha!.data as {
      reportId: string;
      passed: boolean;
      purpose: string;
      reviewedCommit: string;
      l2Fingerprint: string;
      contractRevision: number;
      workItemIds: string[];
      commands: { argv: string[]; timeoutMs: number }[];
    };
    await h.activity.append({
      projectId: 'P',
      missionId: 'M-ha',
      kind: 'validation.reported',
      data: {
        ...data,
        workItemIds: ['W-not-active'],
      },
    });
    await assert.rejects(
      () => h.platform.runHaDeterministicValidation('M-ha', h.root),
      (err: unknown) => err instanceof PlatformRuleError && err.code === 'HA_VALIDATION_STALE',
    );

    const h2 = await harness();
    await seedReviewed(h2);
    await h2.platform.runHaDeterministicValidation('M-ha', h2.root);
    const events2 = await h2.activity.list('M-ha');
    const ha2 = [...events2].reverse().find(
      (event) =>
        event.kind === 'validation.reported' &&
        (event.data as { purpose?: string } | undefined)?.purpose === 'ha_deterministic',
    );
    assert.ok(ha2);
    const data2 = ha2!.data as {
      reportId: string;
      passed: boolean;
      purpose: string;
      reviewedCommit: string;
      l2Fingerprint: string;
      contractRevision: number;
      workItemIds: string[];
      commands: { argv: string[]; timeoutMs: number }[];
    };
    await h2.activity.append({
      projectId: 'P',
      missionId: 'M-ha',
      kind: 'validation.reported',
      data: {
        ...data2,
        commands: [{ argv: ['echo', 'tampered'], timeoutMs: 1 }],
      },
    });
    await assert.rejects(
      () => h2.platform.runHaDeterministicValidation('M-ha', h2.root),
      (err: unknown) => err instanceof PlatformRuleError && err.code === 'HA_VALIDATION_STALE',
    );
  });
});
