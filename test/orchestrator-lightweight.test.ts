/**
 * M3-C：Lightweight Orchestrator main chain。
 *
 * 守住：
 *   - MissionView 原样暴露 executionMode / runKind
 *   - 0 / >1 WorkItem stalled，零 Coordinator hop
 *   - happy Fast Lane：dispatch → 唯一 executor hop → validator → awaiting_review
 *   - L3 finalize 后才 completed
 *   - validation fail stalled（含 reportId），不 auto-promote
 *   - accepted crash-recovery seam
 *   - PROJECT_BUSY → waiting，零 Coordinator
 */

import { after, describe, test } from 'node:test';
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
import { Platform, PlatformRuleError } from '../src/application/platform.ts';
import { makeIssuer } from '../src/main.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';
import {
  ValidationEngine,
  VALIDATION_POLICY_REVISION,
} from '../src/application/validation/engine.ts';
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
import type { ChangedPathReader, CommandRunner } from '../src/application/validation/ports.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

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

const EXECUTOR_HAPPY: ScriptTable = {
  'executor:W-1': {
    steps: [
      { tool: 'coagent_get_work_order', body: {} },
      {
        tool: 'coagent_submit_evidence',
        body: {
          kind: 'test',
          summary: 'node --test 全绿',
          command: 'node --test',
          exitCode: 0,
        },
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

const servers: Server[] = [];

after(() => {
  for (const server of servers) server.close();
});

async function harness(opts?: {
  executor?: ScriptedRuntime;
  runner?: CommandRunner;
  paths?: ChangedPathReader;
  /** 不注入 validation（fail-closed 场景） */
  noValidation?: boolean;
}) {
  const clock = new FixedClock('2026-06-01T12:00:00.000Z');
  const activity = new InMemoryActivityLog(clock);
  const projects = new InMemoryProjectRepository();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const reports = new InMemoryValidationReportRepository();
  const engine = new ValidationEngine({
    clock,
    ids: new SequentialIds(),
    commandRunner: opts?.runner ?? fakeRunner(),
    changedPathReader: opts?.paths ?? fakePaths(),
  });
  const workspace = new InPlaceWorkspaceManager();
  const platform = new Platform({
    projects,
    deliveries,
    workspace,
    activity,
    clock,
    ids,
    ...(opts?.noValidation
      ? {}
      : {
          validation: { engine, reports },
        }),
  });
  const tokens = new RunTokenRegistry();
  const server: Server = createApi({ platform, tokens, deliveries });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);

  const executorRuntime = opts?.executor ?? new ScriptedRuntime(EXECUTOR_HAPPY);
  // Coordinator 脚本故意为空：Lightweight 不得触发它。
  const coordinatorRuntime = new ScriptedRuntime({});

  return {
    platform,
    activity,
    projects,
    deliveries,
    reports,
    tokens,
    makeOrchestrator: () =>
      new Orchestrator({
        platform,
        tokens: makeIssuer(platform, tokens),
        baseUrl,
        workspace,
        coordinator: {
          runtime: coordinatorRuntime,
          candidates: [{ endpoint: 'local', profileId: 'coordinator-a' }],
        },
        executor: {
          runtime: executorRuntime,
          candidates: [
            { endpoint: 'local', profileId: 'exec-a' },
            { endpoint: 'local', profileId: 'exec-b' },
          ],
        },
      }),
  };
}

async function seedLightweight(
  projects: InMemoryProjectRepository,
  opts: {
    missionId?: string;
    projectId?: string;
    workItems?: number;
    origin?: { clientType: string; conversationRef?: string };
  } = {},
): Promise<{ missionId: string; projectId: string }> {
  const projectId = opts.projectId ?? 'P';
  const missionId = opts.missionId ?? 'M-lw';
  const project = await projects.ensure(projectId);
  project.createMission({
    id: missionId,
    contract: CONTRACT,
    executionMode: 'lightweight',
    runKind: 'mutation',
    origin: opts.origin ?? { clientType: 'cli', conversationRef: 'local-cli' },
  });
  await projects.save(project);
  return { missionId, projectId };
}

describe('MissionView routing axis', () => {
  test('原样暴露 executionMode / runKind，不从 origin/workItems 猜', async () => {
    const h = await harness();
    const project = await h.projects.ensure('P');
    project.createMission({
      id: 'M-view',
      contract: CONTRACT,
      executionMode: 'high_assurance',
      runKind: 'query',
    });
    await h.projects.save(project);

    const view = await h.platform.getMissionView('M-view');
    assert.equal(view.executionMode, 'high_assurance');
    assert.equal(view.runKind, 'query');
    assert.deepEqual(view.coordinatorAttemptIds, []);
  });
});

describe('Orchestrator High Assurance fail-closed', () => {
  test('high_assurance => stalled 尚未启用；零 hop / 零 coordinator；不进入 executing', async () => {
    const h = await harness();
    const project = await h.projects.ensure('P');
    project.createMission({
      id: 'M-ha',
      contract: CONTRACT,
      executionMode: 'high_assurance',
      runKind: 'mutation',
      origin: { clientType: 'cli', conversationRef: 'local-cli' },
    });
    // 即便已有 Frozen WorkItem，也不得按 Standard 主链跑。
    const mission = project.missions.find((m) => m.id === 'M-ha')!;
    mission.createWorkItem({ id: 'W-ha', title: 'ha seed', order: ORDER });
    await h.projects.save(project);

    const orch = h.makeOrchestrator();
    const result = await orch.runMission('M-ha', { projectRoot: process.cwd() });

    assert.equal(result.kind, 'stalled');
    assert.match(
      (result as { reason: string }).reason,
      /High Assurance|尚未启用|拒绝按 Standard/,
    );
    assert.equal(orch.hops.length, 0);
    const view = await h.platform.getMissionView('M-ha');
    assert.deepEqual(view.coordinatorAttemptIds, []);
    assert.equal(view.status, 'investigating');
    assert.notEqual(view.status, 'executing');
  });
});

describe('Orchestrator Lightweight：WorkItem 数量守卫', () => {
  test('0 WorkItem => stalled，明确缺 Frozen WorkOrder；零 Coordinator', async () => {
    const h = await harness();
    const { missionId } = await seedLightweight(h.projects, { missionId: 'M-zero' });

    const orch = h.makeOrchestrator();
    const result = await orch.runMission(missionId, { projectRoot: process.cwd() });

    assert.equal(result.kind, 'stalled');
    assert.match((result as { reason: string }).reason, /Frozen WorkOrder|trusted routing/);
    assert.equal(orch.hops.length, 0);
    const view = await h.platform.getMissionView(missionId);
    assert.deepEqual(view.coordinatorAttemptIds, []);
    assert.equal(view.status, 'investigating');
  });

  test('>1 WorkItem => stalled；零 Coordinator', async () => {
    const h = await harness();
    const { missionId } = await seedLightweight(h.projects, { missionId: 'M-multi' });
    // 直接 kernel 塞两个（绕过 createLightweight 单条门禁），模拟坏状态。
    const project = await h.projects.get('P');
    assert.ok(project);
    const mission = project.missions.find((m) => m.id === missionId)!;
    mission.createWorkItem({ id: 'W-a', title: 'a', order: ORDER });
    mission.createWorkItem({ id: 'W-b', title: 'b', order: ORDER });
    await h.projects.save(project);

    const orch = h.makeOrchestrator();
    const result = await orch.runMission(missionId, { projectRoot: process.cwd() });

    assert.equal(result.kind, 'stalled');
    assert.match((result as { reason: string }).reason, /一个 WorkItem/);
    assert.equal(orch.hops.filter((x) => x.role === 'coordinator').length, 0);
    assert.deepEqual((await h.platform.getMissionView(missionId)).coordinatorAttemptIds, []);
  });
});

describe('Orchestrator Lightweight：happy Fast Lane', () => {
  test('dispatch → 唯一 executor hop → validator accept → awaiting_review；L3 finalize 才 completed', async () => {
    const h = await harness();
    const { missionId } = await seedLightweight(h.projects, { missionId: 'M-happy' });
    await h.platform.createLightweightWorkItem(missionId, {
      order: ORDER,
      workItemId: 'W-1',
    });

    const orch = h.makeOrchestrator();
    const result = await orch.runMission(missionId, { projectRoot: process.cwd() });

    assert.deepEqual(result, { kind: 'awaiting_l3_review' });

    const view = await h.platform.getMissionView(missionId);
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.executionMode, 'lightweight');
    assert.equal(view.runKind, 'mutation');
    assert.equal(view.workItems.length, 1);
    assert.equal(view.workItems[0]!.status, 'accepted');
    assert.equal(view.result?.outcome, 'delivered');
    assert.equal(view.result?.summary, '改了初始值');
    assert.equal(view.result?.acceptanceEvidence?.length, 1);
    assert.match(view.result!.acceptanceEvidence[0]!, /^validation-report:VR-/);
    assert.deepEqual(view.result?.memoryDelta, []);
    assert.deepEqual(view.result?.openRisks, []);
    assert.deepEqual(view.coordinatorAttemptIds, []);
    assert.ok(view.isMutating, 'awaiting_review 仍占 mutation slot');

    // hops：只能有 executor
    assert.ok(orch.hops.length >= 1);
    assert.ok(orch.hops.every((hop) => hop.role === 'executor'));
    assert.equal(orch.hops.filter((hop) => hop.endedBy === 'structured_submit').length, 1);

    // events：mission_result.submitted + delivery.created 无 fake attemptId
    const events = await h.activity.list(missionId);
    const submitted = events.find((e) => e.kind === 'mission_result.submitted');
    assert.ok(submitted);
    assert.equal(submitted!.attemptId, undefined);
    const submittedData = submitted!.data as {
      outcome: string;
      missionStatus: string;
      executionMode: string;
      reportId: string;
    };
    assert.equal(submittedData.outcome, 'delivered');
    assert.equal(submittedData.missionStatus, 'awaiting_review');
    assert.equal(submittedData.executionMode, 'lightweight');
    assert.match(submittedData.reportId, /^VR-/);
    assert.deepEqual(view.result?.acceptanceEvidence, [
      `validation-report:${submittedData.reportId}`,
    ]);
    const deliveryEv = events.find((e) => e.kind === 'delivery.created');
    assert.ok(deliveryEv);
    assert.equal(deliveryEv!.attemptId, undefined);

    const inbox = await h.deliveries.pending('local-cli');
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]!.outcome, 'delivered');
    assert.equal(inbox[0]!.summary, '改了初始值');

    // last review = validator
    const lastReview = view.workItems[0]!.lastReview;
    assert.equal(lastReview?.authority?.kind, 'validator');
    assert.equal(lastReview?.verdict, 'accept');

    // 未 completed
    assert.notEqual(view.status, 'completed');

    // L3 finalize 后才 completed
    const finalized = await h.platform.finalizeMission(missionId, {
      verdict: 'merge',
      reasons: ['验收标准对上了'],
      projectRoot: process.cwd(),
    });
    assert.equal(finalized.status, 'completed');
    assert.equal((await h.platform.getMissionView(missionId)).status, 'completed');
  });
});

describe('Orchestrator Lightweight：validation fail', () => {
  test('report 已保存、item submitted、Mission executing、stalled 含 reportId；无 coordinator', async () => {
    const h = await harness({
      runner: fakeRunner(async () => ({
        exitCode: 1,
        timedOut: false,
        durationMs: 1,
        output: 'FAIL',
      })),
    });
    const { missionId } = await seedLightweight(h.projects, { missionId: 'M-fail' });
    await h.platform.createLightweightWorkItem(missionId, {
      order: ORDER,
      workItemId: 'W-1',
    });

    const orch = h.makeOrchestrator();
    const result = await orch.runMission(missionId, { projectRoot: process.cwd() });

    assert.equal(result.kind, 'stalled');
    assert.match((result as { reason: string }).reason, /ValidationReport VR-/);
    assert.match((result as { reason: string }).reason, /未通过/);
    assert.match((result as { reason: string }).reason, /自动升级尚未启用/);

    const view = await h.platform.getMissionView(missionId);
    assert.equal(view.status, 'executing');
    assert.equal(view.workItems[0]!.status, 'submitted');
    assert.equal(view.result, undefined);
    assert.deepEqual(view.coordinatorAttemptIds, []);
    assert.equal(orch.hops.filter((x) => x.role === 'coordinator').length, 0);

    const reportId = ((result as { reason: string }).reason.match(/VR-\d+/) ?? [])[0];
    assert.ok(reportId);
    const stored = await h.reports.get(reportId);
    assert.ok(stored);
    assert.equal(stored!.passed, false);
  });
});

describe('Orchestrator Lightweight：accepted crash-recovery', () => {
  test('accepted 状态可直接 submitForReview', async () => {
    const h = await harness();
    const { missionId } = await seedLightweight(h.projects, { missionId: 'M-rec' });
    const { workItemId } = await h.platform.createLightweightWorkItem(missionId, {
      order: ORDER,
      workItemId: 'W-1',
    });
    await h.platform.dispatchLightweightWorkItem(missionId, workItemId);
    await h.platform.recordWorkspace(missionId, {
      projectRoot: process.cwd(),
      branch: '(in-place)',
      baseRevision: 'base',
    });
    const { attemptId: exec } = await h.platform.startExecutorAttempt(missionId, workItemId);
    await h.platform.submitEvidence(missionId, exec, {
      kind: 'test',
      summary: 'ok',
      command: 't',
      exitCode: 0,
    });
    await h.platform.submitExecutionResult(missionId, exec, {
      outcome: 'completed',
      summary: '从 crash 恢复',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: '',
    });
    await h.platform.finishAttempt(missionId, exec, { endedBy: 'structured_submit' });
    const validated = await h.platform.validateAndAcceptLightweightWorkItem({
      missionId,
      workItemId,
      cwd: process.cwd(),
    });
    assert.equal(validated.passed, true);
    assert.equal(validated.status, 'accepted');
    // 模拟 crash：不调用 submitForReview，让 Orchestrator 从 accepted 接上。
    assert.equal((await h.platform.getMissionView(missionId)).status, 'executing');

    const orch = h.makeOrchestrator();
    const result = await orch.runMission(missionId, { projectRoot: process.cwd() });
    assert.deepEqual(result, { kind: 'awaiting_l3_review' });
    const view = await h.platform.getMissionView(missionId);
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.result?.summary, '从 crash 恢复');
    assert.equal(orch.hops.filter((x) => x.role === 'coordinator').length, 0);
  });
});

describe('Orchestrator Lightweight：PROJECT_BUSY', () => {
  test('返回 waiting/project_busy，零 Coordinator', async () => {
    const h = await harness();
    // 先让另一条 Mission 占着 mutation slot
    const project = await h.projects.ensure('P');
    project.createMission({
      id: 'M-holder',
      contract: CONTRACT,
      executionMode: 'standard',
      runKind: 'mutation',
    });
    await h.projects.save(project);
    const { attemptId: coord } = await h.platform.startCoordinatorAttempt('M-holder');
    await h.platform.updatePlan('M-holder', coord, {
      findings: 'f',
      rejectedHypotheses: [],
      decisions: [],
      direction: 'd',
      risks: [],
    });
    const { workItemId: holderW } = await h.platform.createWorkItem('M-holder', coord, {
      title: 'holder',
      order: ORDER,
    });
    await h.platform.dispatchWorkItems('M-holder', coord, [holderW]);
    assert.equal((await h.platform.getMissionView('M-holder')).isMutating, true);

    const { missionId } = await seedLightweight(h.projects, {
      missionId: 'M-busy',
      projectId: 'P',
    });
    await h.platform.createLightweightWorkItem(missionId, {
      order: ORDER,
      workItemId: 'W-1',
    });

    const orch = h.makeOrchestrator();
    const result = await orch.runMission(missionId, { projectRoot: process.cwd() });
    assert.equal(result.kind, 'waiting');
    assert.equal((result as { reason: string }).reason, 'project_busy');
    assert.equal(orch.hops.length, 0);
    assert.deepEqual((await h.platform.getMissionView(missionId)).coordinatorAttemptIds, []);
  });
});

describe('Platform.submitLightweightMissionForReview guards', () => {
  async function upToAccepted(h: Awaited<ReturnType<typeof harness>>, missionId = 'M-sub') {
    await seedLightweight(h.projects, { missionId });
    const { workItemId } = await h.platform.createLightweightWorkItem(missionId, {
      order: ORDER,
      workItemId: 'W-1',
    });
    await h.platform.dispatchLightweightWorkItem(missionId, workItemId);
    await h.platform.recordWorkspace(missionId, {
      projectRoot: process.cwd(),
      branch: '(in-place)',
      baseRevision: 'base',
    });
    const { attemptId: exec } = await h.platform.startExecutorAttempt(missionId, workItemId);
    await h.platform.submitEvidence(missionId, exec, {
      kind: 'test',
      summary: 'ok',
      command: 't',
      exitCode: 0,
    });
    await h.platform.submitExecutionResult(missionId, exec, {
      outcome: 'completed',
      summary: '改好了',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: '',
    });
    await h.platform.finishAttempt(missionId, exec, { endedBy: 'structured_submit' });
    const out = await h.platform.validateAndAcceptLightweightWorkItem({
      missionId,
      workItemId,
      cwd: process.cwd(),
    });
    assert.equal(out.passed, true);
    return { missionId, workItemId, reportId: out.reportId, exec };
  }

  test('happy：derived MissionResult 精确；events 无 fake attemptId', async () => {
    const h = await harness();
    const { missionId, reportId } = await upToAccepted(h, 'M-ok');
    const out = await h.platform.submitLightweightMissionForReview(missionId);
    assert.equal(out.status, 'awaiting_review');
    assert.equal(out.reportId, reportId);

    const view = await h.platform.getMissionView(missionId);
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.result?.outcome, 'delivered');
    assert.equal(view.result?.summary, '改好了');
    assert.deepEqual(view.result?.acceptanceEvidence, [`validation-report:${reportId}`]);
    assert.deepEqual(view.result?.memoryDelta, []);
    assert.deepEqual(view.result?.openRisks, []);

    const events = await h.activity.list(missionId);
    const submitted = events.filter((e) => e.kind === 'mission_result.submitted').at(-1);
    assert.ok(submitted);
    assert.equal(submitted!.attemptId, undefined);
    assert.equal((submitted!.data as { reportId: string }).reportId, reportId);
    assert.equal((submitted!.data as { executionMode: string }).executionMode, 'lightweight');
    const delivery = events.filter((e) => e.kind === 'delivery.created').at(-1);
    assert.ok(delivery);
    assert.equal(delivery!.attemptId, undefined);
  });

  test('missing report / passed=false / policy mismatch / linkage mismatch / non-validator / attempt mismatch => 不写 result，保持 executing', async () => {
    // missing report：accept 后把 report 从 repo 里拿不回来——用 fake reports 包一层
    {
      const clock = new FixedClock('2026-06-01T12:00:00.000Z');
      const activity = new InMemoryActivityLog(clock);
      const projects = new InMemoryProjectRepository();
      const ids = new SequentialIds();
      const deliveries = new InMemoryDeliveryRepository(clock, ids);
      const realReports = new InMemoryValidationReportRepository();
      const engine = new ValidationEngine({
        clock,
        ids: new SequentialIds(),
        commandRunner: fakeRunner(),
        changedPathReader: fakePaths(),
      });
      // get 永远返回 undefined → missing report
      const reports = {
        async save(r: Parameters<InMemoryValidationReportRepository['save']>[0]) {
          await realReports.save(r);
        },
        async get() {
          return undefined;
        },
      };
      const platform = new Platform({
        projects,
        deliveries,
        workspace: new InPlaceWorkspaceManager(),
        activity,
        clock,
        ids,
        validation: { engine, reports },
      });
      await seedLightweight(projects, { missionId: 'M-miss' });
      const { workItemId } = await platform.createLightweightWorkItem('M-miss', {
        order: ORDER,
        workItemId: 'W-1',
      });
      await platform.dispatchLightweightWorkItem('M-miss', workItemId);
      await platform.recordWorkspace('M-miss', {
        projectRoot: process.cwd(),
        branch: '(in-place)',
        baseRevision: 'base',
      });
      const { attemptId: exec } = await platform.startExecutorAttempt('M-miss', workItemId);
      await platform.submitEvidence('M-miss', exec, {
        kind: 'test',
        summary: 'ok',
        command: 't',
        exitCode: 0,
      });
      await platform.submitExecutionResult('M-miss', exec, {
        outcome: 'completed',
        summary: 's',
        changedFiles: ['src/foo.ts'],
        evidenceIds: [],
        notes: '',
      });
      await platform.finishAttempt('M-miss', exec, { endedBy: 'structured_submit' });
      // validateAndAccept 会 save 但 get 在 submit 时 miss
      await platform.validateAndAcceptLightweightWorkItem({
        missionId: 'M-miss',
        workItemId,
        cwd: process.cwd(),
      });
      await assert.rejects(
        () => platform.submitLightweightMissionForReview('M-miss'),
        (e: unknown) => (e as PlatformRuleError).code === 'VALIDATION_REPORT_MISSING',
      );
      const view = await platform.getMissionView('M-miss');
      assert.equal(view.status, 'executing');
      assert.equal(view.result, undefined);
    }

    // passed=false：直接 kernel 造 accepted + fake validator review，report 存 failed
    {
      const h = await harness();
      await seedLightweight(h.projects, { missionId: 'M-pf' });
      const { workItemId } = await h.platform.createLightweightWorkItem('M-pf', {
        order: ORDER,
        workItemId: 'W-1',
      });
      await h.platform.dispatchLightweightWorkItem('M-pf', workItemId);
      await h.platform.recordWorkspace('M-pf', {
        projectRoot: process.cwd(),
        branch: '(in-place)',
        baseRevision: 'base',
      });
      const { attemptId: exec } = await h.platform.startExecutorAttempt('M-pf', workItemId);
      await h.platform.submitEvidence('M-pf', exec, {
        kind: 'test',
        summary: 'ok',
        command: 't',
        exitCode: 0,
      });
      await h.platform.submitExecutionResult('M-pf', exec, {
        outcome: 'completed',
        summary: 's',
        changedFiles: ['src/foo.ts'],
        evidenceIds: [],
        notes: '',
      });
      await h.platform.finishAttempt('M-pf', exec, { endedBy: 'structured_submit' });

      // 手工 accept with validator authority 指向 failed report
      const project = await h.projects.get('P');
      const mission = project!.missions.find((m) => m.id === 'M-pf')!;
      const item = mission.workItem(workItemId)!;
      const failedReport = {
        id: 'VR-failed',
        policyRevision: VALIDATION_POLICY_REVISION,
        missionId: 'M-pf',
        workItemId,
        attemptId: exec,
        startedAt: 't0',
        endedAt: 't1',
        passed: false,
        checks: [],
      };
      await h.reports.save(failedReport as never);
      item.review('accept', {
        submittedAttemptId: exec,
        authority: {
          kind: 'validator',
          reportId: 'VR-failed',
          policyRevision: VALIDATION_POLICY_REVISION,
        },
        reasons: ['forced'],
        requiredChanges: [],
      });
      await h.projects.save(project!);

      await assert.rejects(
        () => h.platform.submitLightweightMissionForReview('M-pf'),
        (e: unknown) => (e as PlatformRuleError).code === 'VALIDATION_REPORT_NOT_PASSED',
      );
      assert.equal((await h.platform.getMissionView('M-pf')).status, 'executing');
      assert.equal((await h.platform.getMissionView('M-pf')).result, undefined);
    }

    // policy mismatch
    {
      const h = await harness();
      const { missionId, workItemId, exec } = await upToAccepted(h, 'M-pol');
      const project = await h.projects.get('P');
      const mission = project!.missions.find((m) => m.id === missionId)!;
      const item = mission.workItem(workItemId)!;
      // 覆盖 last review 的 policyRevision
      const goodReportId = item.reviews.at(-1)!.authority!
        .kind === 'validator'
        ? (item.reviews.at(-1)!.authority as { reportId: string }).reportId
        : '';
      // 重新塞一个 policy 不匹配的 review——但 item 已 accepted，不能再 review。
      // 改为：改 durable report 的 policy 不可行（immutable）。
      // 用 restore 路径：直接改 reviews 数组不可行（private）。
      // 策略：在 accept 前用 fake engine 返回 authority.policyRevision 与 report 不一致——
      // 那条路 validateAndAccept 会 throw。所以对 submit 的 policy guard，
      // 手工构造 accepted + 写入 mismatched authority via kernel restore 太重。
      // 改为存一份 report，authority 指向它但 policy 不同——通过直接操作 snapshot。
      const snap = mission.toSnapshot();
      const wi = snap.workItems.find((w) => w.id === workItemId)!;
      wi.reviews = [
        {
          verdict: 'accept',
          submittedAttemptId: exec,
          authority: {
            kind: 'validator',
            reportId: goodReportId,
            policyRevision: VALIDATION_POLICY_REVISION + 99,
          },
          reasons: ['x'],
          requiredChanges: [],
        },
      ];
      // 用 Project restore 太复杂；改用独立 Platform + 手工 item.review 在 submitted 上
      // —— 上面 passed=false 已覆盖 durable re-read。policy 用 fake reports.get 返回不同 policy。
      void snap;
      void wi;
    }

    // policy mismatch via reports.get 返回不同 policyRevision
    {
      const clock = new FixedClock('2026-06-01T12:00:00.000Z');
      const activity = new InMemoryActivityLog(clock);
      const projects = new InMemoryProjectRepository();
      const ids = new SequentialIds();
      const deliveries = new InMemoryDeliveryRepository(clock, ids);
      const real = new InMemoryValidationReportRepository();
      const engine = new ValidationEngine({
        clock,
        ids: new SequentialIds(),
        commandRunner: fakeRunner(),
        changedPathReader: fakePaths(),
      });
      const reports = {
        async save(r: Parameters<InMemoryValidationReportRepository['save']>[0]) {
          await real.save(r);
        },
        async get(id: string) {
          const r = await real.get(id);
          if (!r) return undefined;
          return { ...r, policyRevision: r.policyRevision + 1 };
        },
      };
      const platform = new Platform({
        projects,
        deliveries,
        workspace: new InPlaceWorkspaceManager(),
        activity,
        clock,
        ids,
        validation: { engine, reports },
      });
      await seedLightweight(projects, { missionId: 'M-pol2' });
      const { workItemId } = await platform.createLightweightWorkItem('M-pol2', {
        order: ORDER,
        workItemId: 'W-1',
      });
      await platform.dispatchLightweightWorkItem('M-pol2', workItemId);
      await platform.recordWorkspace('M-pol2', {
        projectRoot: process.cwd(),
        branch: '(in-place)',
        baseRevision: 'base',
      });
      const { attemptId: exec } = await platform.startExecutorAttempt('M-pol2', workItemId);
      await platform.submitEvidence('M-pol2', exec, {
        kind: 'test',
        summary: 'ok',
        command: 't',
        exitCode: 0,
      });
      await platform.submitExecutionResult('M-pol2', exec, {
        outcome: 'completed',
        summary: 's',
        changedFiles: ['src/foo.ts'],
        evidenceIds: [],
        notes: '',
      });
      await platform.finishAttempt('M-pol2', exec, { endedBy: 'structured_submit' });
      await platform.validateAndAcceptLightweightWorkItem({
        missionId: 'M-pol2',
        workItemId,
        cwd: process.cwd(),
      });
      await assert.rejects(
        () => platform.submitLightweightMissionForReview('M-pol2'),
        (e: unknown) => (e as PlatformRuleError).code === 'VALIDATION_POLICY_MISMATCH',
      );
      assert.equal((await platform.getMissionView('M-pol2')).status, 'executing');
      assert.equal((await platform.getMissionView('M-pol2')).result, undefined);
    }

    // linkage mismatch (missionId)
    {
      const clock = new FixedClock('2026-06-01T12:00:00.000Z');
      const activity = new InMemoryActivityLog(clock);
      const projects = new InMemoryProjectRepository();
      const ids = new SequentialIds();
      const deliveries = new InMemoryDeliveryRepository(clock, ids);
      const real = new InMemoryValidationReportRepository();
      const engine = new ValidationEngine({
        clock,
        ids: new SequentialIds(),
        commandRunner: fakeRunner(),
        changedPathReader: fakePaths(),
      });
      const reports = {
        async save(r: Parameters<InMemoryValidationReportRepository['save']>[0]) {
          await real.save(r);
        },
        async get(id: string) {
          const r = await real.get(id);
          if (!r) return undefined;
          return { ...r, missionId: 'OTHER-MISSION' };
        },
      };
      const platform = new Platform({
        projects,
        deliveries,
        workspace: new InPlaceWorkspaceManager(),
        activity,
        clock,
        ids,
        validation: { engine, reports },
      });
      await seedLightweight(projects, { missionId: 'M-link' });
      const { workItemId } = await platform.createLightweightWorkItem('M-link', {
        order: ORDER,
        workItemId: 'W-1',
      });
      await platform.dispatchLightweightWorkItem('M-link', workItemId);
      await platform.recordWorkspace('M-link', {
        projectRoot: process.cwd(),
        branch: '(in-place)',
        baseRevision: 'base',
      });
      const { attemptId: exec } = await platform.startExecutorAttempt('M-link', workItemId);
      await platform.submitEvidence('M-link', exec, {
        kind: 'test',
        summary: 'ok',
        command: 't',
        exitCode: 0,
      });
      await platform.submitExecutionResult('M-link', exec, {
        outcome: 'completed',
        summary: 's',
        changedFiles: ['src/foo.ts'],
        evidenceIds: [],
        notes: '',
      });
      await platform.finishAttempt('M-link', exec, { endedBy: 'structured_submit' });
      await platform.validateAndAcceptLightweightWorkItem({
        missionId: 'M-link',
        workItemId,
        cwd: process.cwd(),
      });
      await assert.rejects(
        () => platform.submitLightweightMissionForReview('M-link'),
        (e: unknown) => (e as PlatformRuleError).code === 'VALIDATION_LINKAGE_MISMATCH',
      );
      assert.equal((await platform.getMissionView('M-link')).result, undefined);
      assert.equal((await platform.getMissionView('M-link')).status, 'executing');
    }

    // last review non-validator：用 Standard coordinator review 路径造 accepted
    {
      const h = await harness({ noValidation: true });
      // standard mission for coordinator review
      await h.platform.createMission({
        projectId: 'P-std',
        missionId: 'M-coord-rev',
        contract: CONTRACT,
      });
      // Can't easily use submitLightweight on standard. Instead:
      // create lightweight, force coordinator-style review via kernel after submit.
      await seedLightweight(h.projects, { missionId: 'M-nv', projectId: 'P-nv' });
      // need validation for nothing — we'll kernel-review
      const project = await h.projects.get('P-nv');
      const mission = project!.missions.find((m) => m.id === 'M-nv')!;
      // 手工推到 accepted with coordinator authority
      const item = mission.createWorkItem({ id: 'W-1', title: 't', order: ORDER });
      item.dispatch();
      mission.startExecuting();
      const attempt = item.startAttempt();
      item.submit(
        {
          outcome: 'completed',
          summary: 's',
          changedFiles: ['src/foo.ts'],
          evidenceIds: [],
          notes: '',
        },
        attempt.id,
      );
      item.review('accept', {
        attemptId: 'coord-1',
        submittedAttemptId: attempt.id,
        authority: { kind: 'coordinator', attemptId: 'coord-1' },
        reasons: ['ok'],
        requiredChanges: [],
      });
      await h.projects.save(project!);

      // 需要 validation deps
      const h2 = await harness();
      // 把状态迁到 h2 不现实；直接在 h 上注入 validation 再测
      // 重新用带 validation 的 harness + kernel 路径
    }

    {
      const h = await harness();
      await seedLightweight(h.projects, { missionId: 'M-nv2' });
      const project = await h.projects.get('P');
      const mission = project!.missions.find((m) => m.id === 'M-nv2')!;
      const item = mission.createWorkItem({ id: 'W-1', title: 't', order: ORDER });
      item.dispatch();
      mission.startExecuting();
      const attempt = item.startAttempt();
      item.submit(
        {
          outcome: 'completed',
          summary: 's',
          changedFiles: ['src/foo.ts'],
          evidenceIds: [],
          notes: '',
        },
        attempt.id,
      );
      item.review('accept', {
        attemptId: 'coord-1',
        submittedAttemptId: attempt.id,
        authority: { kind: 'coordinator', attemptId: 'coord-1' },
        reasons: ['ok'],
        requiredChanges: [],
      });
      await h.projects.save(project!);

      await assert.rejects(
        () => h.platform.submitLightweightMissionForReview('M-nv2'),
        (e: unknown) =>
          (e as PlatformRuleError).code === 'LIGHTWEIGHT_VALIDATOR_AUTHORITY_REQUIRED',
      );
      assert.equal((await h.platform.getMissionView('M-nv2')).status, 'executing');
      assert.equal((await h.platform.getMissionView('M-nv2')).result, undefined);
    }

    // submittedAttemptId mismatch
    {
      const h = await harness();
      await seedLightweight(h.projects, { missionId: 'M-sam' });
      const project = await h.projects.get('P');
      const mission = project!.missions.find((m) => m.id === 'M-sam')!;
      const item = mission.createWorkItem({ id: 'W-1', title: 't', order: ORDER });
      item.dispatch();
      mission.startExecuting();
      const attempt = item.startAttempt();
      item.submit(
        {
          outcome: 'completed',
          summary: 's',
          changedFiles: ['src/foo.ts'],
          evidenceIds: [],
          notes: '',
        },
        attempt.id,
      );
      await h.reports.save({
        id: 'VR-sam',
        policyRevision: VALIDATION_POLICY_REVISION,
        missionId: 'M-sam',
        workItemId: 'W-1',
        attemptId: attempt.id,
        startedAt: 't0',
        endedAt: 't1',
        passed: true,
        checks: [],
      } as never);
      item.review('accept', {
        submittedAttemptId: 'OTHER-ATTEMPT',
        authority: {
          kind: 'validator',
          reportId: 'VR-sam',
          policyRevision: VALIDATION_POLICY_REVISION,
        },
        reasons: ['ok'],
        requiredChanges: [],
      });
      await h.projects.save(project!);

      await assert.rejects(
        () => h.platform.submitLightweightMissionForReview('M-sam'),
        (e: unknown) =>
          (e as PlatformRuleError).code === 'LIGHTWEIGHT_SUBMITTED_ATTEMPT_MISMATCH',
      );
      assert.equal((await h.platform.getMissionView('M-sam')).status, 'executing');
      assert.equal((await h.platform.getMissionView('M-sam')).result, undefined);
    }
  });
});
