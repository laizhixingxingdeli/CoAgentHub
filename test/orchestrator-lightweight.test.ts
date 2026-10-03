/**
 * M3-C：Lightweight Orchestrator main chain。
 *
 * 守住：
 *   - MissionView 原样暴露 executionMode / runKind
 *   - 0 / >1 WorkItem stalled，零 Coordinator hop
 *   - happy Fast Lane：dispatch → 唯一 executor hop → validator → awaiting_review
 *   - L3 finalize 后才 completed
 *   - validation fail → 凭报告自动升级 Standard，协调者接手 L2；升级不成才 stalled
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
import { Project } from '../src/kernel/index.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

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
  /** 缺省是空脚本：Lightweight 一旦叫起协调者就报错。升级场景要给它脚本。 */
  coordinator?: ScriptedRuntime;
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
  await listenLoopback(server, 0);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);

  const executorRuntime = opts?.executor ?? new ScriptedRuntime(EXECUTOR_HAPPY);
  // Coordinator 脚本缺省为空：Lightweight 不得触发它。
  const coordinatorRuntime = opts?.coordinator ?? new ScriptedRuntime({});

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

describe('Orchestrator High Assurance：Standard 式主链', () => {
  // 旧不变式：HA 调度前 stalled（尚未启用 / 拒绝按 Standard），零 hop。E3a 删了那段，HA 走 Standard 主链。
  test('HA 不再以旧理由 stalled；走协调者 hop；不会自己 completed', async () => {
    const h = await harness();
    const project = await h.projects.ensure('P');
    project.createMission({
      id: 'M-std',
      contract: CONTRACT,
      executionMode: 'standard',
      runKind: 'mutation',
      origin: { clientType: 'cli', conversationRef: 'local-cli' },
    });
    project.createMission({
      id: 'M-ha',
      contract: CONTRACT,
      executionMode: 'high_assurance',
      runKind: 'mutation',
      origin: { clientType: 'cli', conversationRef: 'local-cli' },
    });
    // 即便已有 Frozen WorkItem，也走 Standard 式协调者主链（不再因此提前 stalled）。
    const mission = project.missions.find((m) => m.id === 'M-ha')!;
    mission.createWorkItem({ id: 'W-ha', title: 'ha seed', order: ORDER });
    await h.projects.save(project);

    // 本文件 harness 默认协调者脚本为空：Standard 与 HA 都会在协调者 hop 后 waiting。
    const stdOrch = h.makeOrchestrator();
    const stdResult = await stdOrch.runMission('M-std', { projectRoot: process.cwd() });
    const haOrch = h.makeOrchestrator();
    const haResult = await haOrch.runMission('M-ha', { projectRoot: process.cwd() });

    assert.equal(stdResult.kind, 'waiting');
    assert.equal(haResult.kind, stdResult.kind);
    assert.notEqual(haResult.kind, 'stalled');
    assert.notEqual(haResult.kind, 'delivered');
    if ('reason' in haResult && typeof haResult.reason === 'string') {
      assert.doesNotMatch(haResult.reason, /High Assurance|尚未启用|拒绝按 Standard/);
    }
    assert.ok(
      haOrch.hops.some((hop) => hop.role === 'coordinator'),
      'HA 应留下协调者 hop',
    );
    const haView = await h.platform.getMissionView('M-ha');
    assert.ok(haView.coordinatorAttemptIds.length >= 1);
    assert.notEqual(haView.status, 'completed');
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

describe('Orchestrator Lightweight：验收没过 → 自动升级 Standard（§4.3）', () => {
  // E1 实测：执行者改对了、机器验收因一条配置判失败，旧行为停在 stalled 等了 870 秒。
  const failing = () =>
    fakeRunner(async () => ({ exitCode: 1, timedOut: false, durationMs: 1, output: 'FAIL' }));

  const COORDINATOR_L2: ScriptTable = {
    'coordinator:-:0': {
      steps: [
        { tool: 'coagent_get_mission', body: {} },
        {
          tool: 'coagent_review_execution_result',
          body: {
            workItemId: 'W-1',
            verdict: 'accept', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })),
            reasons: ['对照报告复核：失败的是验收命令的环境，改动本身符合工单'],
            requiredChanges: [],
          },
        },
        {
          tool: 'coagent_submit_mission_result',
          body: {
            outcome: 'delivered',
            summary: '升级后由协调者验收',
            acceptanceEvidence: ['L2 复核通过'],
            memoryDelta: [],
            openRisks: [],
          },
        },
      ],
    },
  };

  test('报告存下 → 凭它升级 → 协调者带着原因接手做 L2 → 交卷等 L3', async () => {
    const coordinator = new ScriptedRuntime(COORDINATOR_L2);
    const h = await harness({ runner: failing(), coordinator });
    const { missionId } = await seedLightweight(h.projects, { missionId: 'M-fail' });
    await h.platform.createLightweightWorkItem(missionId, { order: ORDER, workItemId: 'W-1' });

    const orch = h.makeOrchestrator();
    const result = await orch.runMission(missionId, { projectRoot: process.cwd() });

    assert.equal(result.kind, 'awaiting_l3_review');
    const view = await h.platform.getMissionView(missionId);
    assert.equal(view.executionMode, 'standard');
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.promotions.length, 1);
    const promotion = view.promotions[0]!;
    assert.equal(promotion.triggerCode, 'validator_failure_unrepairable');
    const reportId = promotion.triggerRule.match(/VR-\d+/)?.[0];
    assert.ok(reportId, promotion.triggerRule);
    assert.equal((await h.reports.get(reportId!))?.passed, false);

    // 执行者一跳、协调者一跳；协调者被告知这是升级上来的、凭哪份报告。
    assert.equal(orch.hops.filter((x) => x.role === 'executor').length, 1);
    assert.equal(orch.hops.filter((x) => x.role === 'coordinator').length, 1);
    assert.match(coordinator.instructions[0]!, /从 Lightweight 升级上来的/);
    assert.ok(coordinator.instructions[0]!.includes(reportId!));
    // L2 是协调者做的，不是机器。
    assert.equal(view.workItems[0]!.status, 'accepted');
  });

  test('升级不成（报告对不上当前这次提交）才停下，并把两件事都说出来', async () => {
    const h = await harness({ runner: failing() });
    const { missionId } = await seedLightweight(h.projects, { missionId: 'M-fail2' });
    await h.platform.createLightweightWorkItem(missionId, { order: ORDER, workItemId: 'W-1' });
    // 升级时平台读回的报告被改成另一次提交的：平台必须拒绝，编排器必须停下说清楚，不能硬升。
    const realGet = h.reports.get.bind(h.reports);
    h.reports.get = async (id: string) => {
      const report = await realGet(id);
      return report ? { ...report, attemptId: 'W-1.exec-0' } : report;
    };

    const orch = h.makeOrchestrator();
    const result = await orch.runMission(missionId, { projectRoot: process.cwd() });

    assert.equal(result.kind, 'stalled');
    const reason = (result as { reason: string }).reason;
    assert.match(reason, /ValidationReport VR-\d+ 未通过，升级到 Standard 也失败了/);
    assert.match(reason, /不是工作项 W-1 当前这次提交的报告/);
    const view = await h.platform.getMissionView(missionId);
    assert.equal(view.executionMode, 'lightweight');
    assert.equal(orch.hops.filter((x) => x.role === 'coordinator').length, 0);
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
    // M-holder 是 Standard：W-334 门禁要求派发前先落一条当前契约修订的核对结论，
    // 否则它根本占不住 mutation slot，这条用例测的 PROJECT_BUSY 就无从发生。
    await h.platform.submitContractCheck('M-holder', coord, {
      verdict: 'ok',
      summary: '测试契约已核对',
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
  /**
   * 真实 L2 基线：机器验收过了也只到 submitted，accept 是协调者 attempt 下的结论。
   *
   * 不这么搭，测的其实是「机器过了就能交卷」这条已经删掉的老路——交卷守卫要守的
   * 恰恰是「这份 accept 是谁下的、验的是不是当前这次提交」。
   */
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

  /** 真实 L2：在 Mission 自己的协调者 attempt 下 accept，工单验收标准逐条 pass。 */
  async function acceptByRealCoordinator(
    h: Awaited<ReturnType<typeof harness>>,
    missionId: string,
    workItemId: string,
  ): Promise<string> {
    const { attemptId: coord } = await h.platform.startCoordinatorAttempt(missionId);
    await h.platform.reviewExecutionResult(missionId, coord, {
      workItemId,
      verdict: 'accept',
      acceptanceResults: ORDER.acceptance.map((criterion) => ({
        criterion,
        status: 'pass' as const,
        evidence: '测试替身：逐条核过',
      })),
      reasons: ['对照机器报告复核'],
      requiredChanges: [],
    });
    await h.platform.finishAttempt(missionId, coord, { endedBy: 'structured_submit' });
    return coord;
  }

  /**
   * 只坏最后一条 review 的一个字段：把 accepted 的历史经 snapshot 改一处再 restore。
   *
   * 走 restore 而不是再调一次工具，是因为坏掉的结论在真实路径下根本产生不出来
   * （attemptId 只能指向真实 attempt、submittedAttemptId 恒等于当前提交），
   * 只有直接装配历史才造得出这种「别人 / 上一次的 accept」。
   */
  async function breakLastReview(
    h: Awaited<ReturnType<typeof harness>>,
    missionId: string,
    sabotage: (review: Record<string, unknown>) => void,
  ): Promise<void> {
    const project = (await h.projects.get('P'))!;
    const snapshot = project.toSnapshot();
    const mission = snapshot.missions.find((m) => m.id === missionId)!;
    const item = mission.workItems.find((w) => w.id === 'W-1')!;
    const last = item.reviews.at(-1) as Record<string, unknown> | undefined;
    assert.ok(last);
    // 历史里的 review 已被 kernel 冻结：只能整条替换，不能就地改字段。
    const broken = { ...last! };
    sabotage(broken);
    item.reviews = [...item.reviews.slice(0, -1), broken];
    await h.projects.save(Project.restore(snapshot));
  }

  test('happy：derived MissionResult 精确；events 归因真实 L2 attempt', async () => {
    const h = await harness();
    const { missionId, workItemId, reportId } = await upToAccepted(h, 'M-ok');
    // 机器过了 ≠ 验收过了：accept 这一跳归真实协调者，此刻工作项仍是 submitted。
    assert.equal((await h.platform.getMissionView(missionId)).workItems[0]!.status, 'submitted');
    const coord = await acceptByRealCoordinator(h, missionId, workItemId);

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
    // 交卷事件要能追回是谁验的：归因这次真实 L2 的协调者 attempt，不另造 id。
    assert.equal(submitted!.attemptId, coord);
    assert.equal((submitted!.data as { reportId: string }).reportId, reportId);
    assert.equal((submitted!.data as { executionMode: string }).executionMode, 'lightweight');
    const delivery = events.filter((e) => e.kind === 'delivery.created').at(-1);
    assert.ok(delivery);
    assert.equal(delivery!.attemptId, coord);
  });

  test('missing report / passed=false / linkage mismatch / 非协调者 attempt / 提交绑定不符 => 不写 result，保持 executing', async () => {
    // 旧用例里 policyRevision mismatch 与 LIGHTWEIGHT_VALIDATOR_AUTHORITY_REQUIRED
    // 这两项断言已无对应门禁：W-442 之后机器报告不写进 review.authority，
    // requireLightweightReviewReport 只从 durable reports + validation.reported 读回
    // 「当前这次提交」的报告，既不读 authority 也不比 policyRevision。validator 权威
    // 现在由两道真实门禁守住——真实 L2 accept 时的 current-report 门禁，以及交卷时
    // 同一把尺。所以这里不再复现那两个码，也不把所有负例退化成 NOT_ACCEPTED 了事。
    async function expectRejects(
      h: Awaited<ReturnType<typeof harness>>,
      label: string,
      missionId: string,
      code: string,
    ): Promise<void> {
      await assert.rejects(
        () => h.platform.submitLightweightMissionForReview(missionId),
        (e: unknown) => (e as PlatformRuleError).code === code,
        label,
      );
      const view = await h.platform.getMissionView(missionId);
      assert.equal(view.status, 'executing', label);
      assert.equal(view.result, undefined, label);
    }

    const cases: readonly {
      label: string;
      missionId: string;
      code: string;
      /** 只坏一处，其余一律走真实 L2 基线。 */
      breakOne: (h: Awaited<ReturnType<typeof harness>>, missionId: string) => Promise<void>;
    }[] = [
      {
        label: 'missing report',
        missionId: 'M-miss',
        code: 'VALIDATION_REPORT_MISSING',
        breakOne: async (h) => {
          h.reports.get = async () => undefined;
        },
      },
      {
        label: 'passed=false',
        missionId: 'M-pf',
        code: 'VALIDATION_REPORT_NOT_PASSED',
        breakOne: async (h) => {
          // 先绑住原 get：只把 passed 改掉，报告 id / linkage 全留给真实那份。
          const realGet = h.reports.get.bind(h.reports);
          h.reports.get = async (id: string) => {
            const report = await realGet(id);
            return report ? { ...report, passed: false } : report;
          };
        },
      },
      {
        label: 'linkage mismatch',
        missionId: 'M-link',
        code: 'VALIDATION_LINKAGE_MISMATCH',
        breakOne: async (h) => {
          const realGet = h.reports.get.bind(h.reports);
          h.reports.get = async (id: string) => {
            const report = await realGet(id);
            return report ? { ...report, missionId: 'OTHER-MISSION' } : report;
          };
        },
      },
      {
        label: '非协调者 attempt 下的 accept',
        missionId: 'M-nv',
        code: 'LIGHTWEIGHT_COORDINATOR_REVIEW_REQUIRED',
        breakOne: async (h, missionId) => {
          // 这条 accept 记的 attemptId 在 Mission 里压根不存在：它不是这个 Mission
          // 的 L2 下的结论，交卷不能认。
          await breakLastReview(h, missionId, (review) => {
            review.attemptId = 'coord-does-not-exist';
          });
        },
      },
      {
        label: '提交绑定不符',
        missionId: 'M-sam',
        code: 'LIGHTWEIGHT_SUBMITTED_ATTEMPT_MISMATCH',
        breakOne: async (h, missionId) => {
          // accept 验的是上一次提交，不是工作项当前这次。
          await breakLastReview(h, missionId, (review) => {
            review.submittedAttemptId = 'OTHER-ATTEMPT';
          });
        },
      },
    ];

    for (const c of cases) {
      const h = await harness();
      const { missionId, workItemId } = await upToAccepted(h, c.missionId);
      await acceptByRealCoordinator(h, missionId, workItemId);
      await c.breakOne(h, missionId);
      await expectRejects(h, c.label, missionId, c.code);
    }
  });
});

const BLOCK_QUESTION = '确认真正的文件路径';
const BLOCK_REASON = '工单前提不成立';
const BLOCK_TRIED = ['ls src/', '选 A', '选 B'];

const EXECUTOR_BLOCK_QUESTION: ScriptTable = {
  'executor:W-1:0': {
    steps: [
      { tool: 'coagent_get_work_order', body: {} },
      {
        tool: 'coagent_report_blocked',
        body: {
          reason: BLOCK_REASON,
          whatWasTried: BLOCK_TRIED,
          needsFromUpstream: BLOCK_QUESTION,
        },
      },
    ],
  },
  'executor:W-1:1': EXECUTOR_HAPPY['executor:W-1']!,
};

const EXECUTOR_BLOCK_BLANK: ScriptTable = {
  'executor:W-1': {
    steps: [
      { tool: 'coagent_get_work_order', body: {} },
      {
        tool: 'coagent_report_blocked',
        body: {
          reason: '暂时做不了',
          whatWasTried: ['试过了'],
          needsFromUpstream: '   ',
        },
      },
    ],
  },
};

const PLAN = {
  findings: 'f',
  rejectedHypotheses: [],
  decisions: [],
  direction: 'd',
  risks: [],
};

const COORD_PLAN_DISPATCH: ScriptTable = {
  'coordinator:-:0': {
    steps: [
      { tool: 'coagent_update_plan', body: PLAN },
      { tool: 'coagent_create_work_item', body: { title: 'W', ...ORDER } },
      // W-334 门禁：Standard 派发前必须先落一条当前契约修订的核对结论。
      { tool: 'coagent_submit_contract_check', body: { verdict: 'ok', summary: '测试契约已核对' } },
      {
        tool: 'coagent_dispatch_work_item',
        body: (previous) => ({ workItemIds: [previous.workItemId] }),
      },
    ],
  },
  'coordinator:-': { steps: [{ tool: 'coagent_get_mission', body: {} }] },
};

describe('Orchestrator Lightweight：blocked 提问停靠 L3，答复后同单续跑',
  () => {
    test('非空问题：首轮与未答复重跑均 awaiting_l3 原问题，仅一条升级且 WorkItem blocked',
      async () => {
        const h = await harness({
          executor: new ScriptedRuntime(EXECUTOR_BLOCK_QUESTION),
        });
        const { missionId } = await seedLightweight(h.projects, { missionId: 'M-ask' });
        await h.platform.createLightweightWorkItem(missionId, {
          order: ORDER,
          workItemId: 'W-1',
        });

        const orch = h.makeOrchestrator();
        const first = await orch.runMission(missionId, { projectRoot: process.cwd() });
        assert.deepEqual(first, { kind: 'awaiting_l3', question: BLOCK_QUESTION });

        const afterFirst = await h.platform.getMissionView(missionId);
        assert.equal(afterFirst.executionMode, 'lightweight');
        assert.equal(afterFirst.escalations, 1);
        assert.equal(afterFirst.openEscalations.length, 1);
        assert.equal(afterFirst.openEscalations[0]?.question, BLOCK_QUESTION);
        assert.equal(afterFirst.workItems[0]?.status, 'blocked');
        assert.equal(afterFirst.workItems[0]?.id, 'W-1');
        assert.deepEqual(afterFirst.coordinatorAttemptIds, []);
        assert.equal(orch.hops.filter((hop) => hop.role === 'coordinator').length, 0);
        assert.equal(orch.hops.filter((hop) => hop.role === 'executor').length, 1);

        const second = await orch.runMission(missionId, { projectRoot: process.cwd() });
        assert.deepEqual(second, { kind: 'awaiting_l3', question: BLOCK_QUESTION });
        const afterSecond = await h.platform.getMissionView(missionId);
        assert.equal(afterSecond.escalations, 1);
        assert.equal(afterSecond.openEscalations.length, 1);
        assert.equal(afterSecond.workItems[0]?.status, 'blocked');
        assert.deepEqual(afterSecond.coordinatorAttemptIds, []);
        assert.equal(orch.hops.filter((hop) => hop.role === 'executor').length, 1);
        assert.equal(orch.hops.filter((hop) => hop.role === 'coordinator').length, 0);
      },
    );

    test('空白需求保持 stalled 及原原因文本；不出现协调者尝试', async () => {
      const h = await harness({
        executor: new ScriptedRuntime(EXECUTOR_BLOCK_BLANK),
      });
      const { missionId } = await seedLightweight(h.projects, { missionId: 'M-blank' });
      await h.platform.createLightweightWorkItem(missionId, {
        order: ORDER,
        workItemId: 'W-1',
      });

      const orch = h.makeOrchestrator();
      const result = await orch.runMission(missionId, { projectRoot: process.cwd() });
      assert.equal(result.kind, 'stalled');
      assert.equal(
        (result as { reason: string }).reason,
        'Lightweight WorkItem W-1 状态是 blocked，无法继续；绝不回退 Coordinator',
      );

      const view = await h.platform.getMissionView(missionId);
      assert.equal(view.executionMode, 'lightweight');
      assert.equal(view.escalations, 0);
      assert.equal(view.openEscalations.length, 0);
      assert.equal(view.workItems[0]?.status, 'blocked');
      assert.deepEqual(view.coordinatorAttemptIds, []);
      assert.equal(orch.hops.filter((hop) => hop.role === 'coordinator').length, 0);
    });

    test('答复后新 executor attempt 用同一 WorkItem，验收交 L3，全程无协调者',
      async () => {
        const h = await harness({
          executor: new ScriptedRuntime(EXECUTOR_BLOCK_QUESTION),
        });
        const { missionId } = await seedLightweight(h.projects, { missionId: 'M-resume' });
        await h.platform.createLightweightWorkItem(missionId, {
          order: ORDER,
          workItemId: 'W-1',
        });

        const orch = h.makeOrchestrator();
        const asked = await orch.runMission(missionId, { projectRoot: process.cwd() });
        assert.deepEqual(asked, { kind: 'awaiting_l3', question: BLOCK_QUESTION });
        assert.deepEqual((await h.platform.getMissionView(missionId)).coordinatorAttemptIds, []);

        await h.platform.answerEscalation(missionId, '就改 src/foo.ts');
        const afterAnswer = await h.platform.getMissionView(missionId);
        assert.equal(afterAnswer.workItems[0]?.id, 'W-1');
        assert.equal(afterAnswer.workItems[0]?.status, 'dispatched');
        assert.equal(afterAnswer.openEscalations.length, 0);
        assert.deepEqual(afterAnswer.coordinatorAttemptIds, []);

        const resumed = await orch.runMission(missionId, { projectRoot: process.cwd() });
        assert.deepEqual(resumed, { kind: 'awaiting_l3_review' });

        const view = await h.platform.getMissionView(missionId);
        assert.equal(view.status, 'awaiting_review');
        assert.equal(view.executionMode, 'lightweight');
        assert.equal(view.workItems.length, 1);
        assert.equal(view.workItems[0]?.id, 'W-1');
        assert.equal(view.workItems[0]?.status, 'accepted');
        assert.equal(view.workItems[0]?.attempts, 2);
        assert.deepEqual(view.coordinatorAttemptIds, []);
        assert.equal(orch.hops.filter((hop) => hop.role === 'coordinator').length, 0);
        assert.equal(orch.hops.filter((hop) => hop.role === 'executor').length, 2);
        assert.ok(orch.hops.every((hop) => hop.role === 'executor' && hop.workItemId === 'W-1'));
      },
    );

    test('Standard blocked 不自动升级，控制权回到协调者', async () => {
      const coordinator = new ScriptedRuntime(COORD_PLAN_DISPATCH);
      const executor = new ScriptedRuntime({
        'executor:W-1': {
          steps: [
            { tool: 'coagent_get_work_order', body: {} },
            {
              tool: 'coagent_report_blocked',
              body: {
                reason: BLOCK_REASON,
                whatWasTried: BLOCK_TRIED,
                needsFromUpstream: BLOCK_QUESTION,
              },
            },
          ],
        },
      });
      const h = await harness({ coordinator, executor });
      const project = await h.projects.ensure('P');
      project.createMission({
        id: 'M-std-block',
        contract: CONTRACT,
        executionMode: 'standard',
        runKind: 'mutation',
        origin: { clientType: 'cli', conversationRef: 'local-cli' },
      });
      await h.projects.save(project);

      const orch = h.makeOrchestrator();
      const result = await orch.runMission('M-std-block', {
        projectRoot: process.cwd(),
        maxRounds: 6,
      });

      const view = await h.platform.getMissionView('M-std-block');
      assert.equal(view.workItems[0]?.status, 'blocked');
      assert.equal(view.escalations, 0);
      assert.notEqual(result.kind, 'awaiting_l3');
      assert.ok(view.coordinatorAttemptIds.length >= 1);
      assert.equal(orch.hops.filter((hop) => hop.role === 'executor').length, 1);
      assert.ok(orch.hops.some((hop) => hop.role === 'coordinator'));
    });
  },
);
