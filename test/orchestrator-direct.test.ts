/**
 * direct coordinationMode 的编排器接缝：**无 pending 时绝不起 agent**。
 *
 * 这里不用 HTTP server、不用 ScriptedRuntime：两条 role 的 runtime.start 都直接抛。
 * 断言能过就说明整条路径根本没走到「启动模型」那一步——不是靠脚本表恰好没被消费。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Project } from '../src/kernel/index.ts';
import type { MissionContract } from '../src/kernel/index.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform } from '../src/application/platform.ts';
import { Orchestrator } from '../src/application/orchestrator.ts';
import type { WorkspaceManager, PreparedWorkspace } from '../src/application/workspace.ts';
import type { AgentRuntime, AgentRunSpec } from '../src/application/ports.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { makeIssuer } from '../src/main.ts';

const CONTRACT: MissionContract = {
  intent: 'fix',
  acceptance: ['ok'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

/** 只回答 prepare 的最小工作区；prepare 次数由测试自己数。 */
function countingWorkspace(counter: { prepares: number }): WorkspaceManager {
  const prepared: PreparedWorkspace = {
    cwd: process.cwd(),
    branch: 'test',
    targetBranch: 'test',
    baseRevision: 'test',
  };
  return {
    async prepare() {
      counter.prepares += 1;
      return prepared;
    },
    async head() {
      return 'test';
    },
    async targetHead() {
      return 'test';
    },
    async rollback() {
      /* noop */
    },
    async mergeToTarget() {
      return { ok: true, mergedInto: 'test' };
    },
    async diff() {
      return { stat: '', files: [] };
    },
    async release() {
      /* noop */
    },
  };
}

/** 一被启动就失败：能跑到这里就说明「没有起模型」这条没成立。 */
function neverStart(starts: string[]): AgentRuntime {
  return {
    kind: 'never',
    async start(spec: AgentRunSpec) {
      starts.push(`${spec.role}:${spec.attemptId}`);
      throw new Error(`runtime.start 不该被调用（${spec.role}）`);
    },
  };
}

describe('direct coordinationMode：planning 无 pending', () => {
  test('返回 waiting/waiting_l3，且一个模型都没起；direct + high_assurance 在 prepare 之前拒绝', async () => {
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const projects = new InMemoryProjectRepository();
    const activity = new InMemoryActivityLog(clock);
    const deliveries = new InMemoryDeliveryRepository(clock, ids);
    const platform = new Platform({ projects, deliveries, activity, clock, ids });

    const starts: string[] = [];
    const counter = { prepares: 0 };
    const workspace = countingWorkspace(counter);
    const tokens = new RunTokenRegistry();

    const orchestrator = new Orchestrator({
      platform,
      tokens: makeIssuer(platform, tokens),
      // 绝不启动 runtime，所以这个地址永远不会被连。
      baseUrl: 'http://127.0.0.1:1',
      workspace,
      coordinator: {
        runtime: neverStart(starts),
        candidates: [{ endpoint: 'local', profileId: 'c' }],
      },
      executor: {
        runtime: neverStart(starts),
        candidates: [{ endpoint: 'local', profileId: 'e' }],
      },
    });

    await platform.createMission({
      projectId: 'p',
      missionId: 'm',
      coordinationMode: 'direct',
      contract: CONTRACT,
    });

    const outcome = await orchestrator.runMission('m', { projectRoot: process.cwd() });
    assert.equal(outcome.kind, 'waiting');
    assert.equal(
      outcome.kind === 'waiting' ? outcome.reason : undefined,
      'waiting_l3',
    );

    const view = await platform.getMissionView('m');
    assert.deepEqual(view.coordinatorAttemptIds, []);
    assert.deepEqual(view.workItems, []);
    assert.equal(view.waitReason, 'waiting_l3');
    assert.deepEqual(starts, []);

    // ---- direct + high_assurance：不是合法的直接控制组合 ----
    // 用 Project.restore 装配出来（正常入口不会创建这种组合）。
    const seeded = Project.create({ id: 'p2' });
    seeded.createMission({ id: 'm2', coordinationMode: 'direct', contract: CONTRACT });
    const snapshot = seeded.toSnapshot();
    (snapshot.missions[0] as { executionMode?: string }).executionMode = 'high_assurance';
    await projects.save(Project.restore(snapshot));

    const preparesBefore = counter.prepares;
    const rejected = await orchestrator.runMission('m2', { projectRoot: process.cwd() });
    assert.equal(rejected.kind, 'stalled');
    assert.match(rejected.kind === 'stalled' ? rejected.reason : '', /direct/);
    // 在动工作区之前就停：没有多 prepare 一次。
    assert.equal(counter.prepares, preparesBefore);
    assert.deepEqual(starts, []);

    // ---- 同一个 runner 接着跑 hierarchical：direct 标志必须已被重置 ----
    // 不重置的话 #runHop 的协调者保护会静默拦掉这一跳，而人只会看到
    // 「等待主控」——看起来像正常的两层模式。这里就靠起始记录露馅。
    await platform.createMission({ projectId: 'p', missionId: 'm-hier', contract: CONTRACT });
    const hier = await orchestrator.runMission('m-hier', { projectRoot: process.cwd() });
    // 这一跳注定起不来（runtime 一启动就抛），所以结果不重要；
    // 要看的是「有没有去起」。
    assert.ok(hier.kind === 'waiting' || hier.kind === 'blocked');
    assert.ok(
      starts.some((entry) => entry.startsWith('coordinator:')),
      `hierarchical Mission 必须真的去起协调者模型（direct 标志未重置会拦住它；实际：${starts.join(',')}）`,
    );
  });

  test('direct executor 提交后真实验证并停回主控，每次 start 只跑一张派发单', async () => {
    const { ValidationEngine } = await import('../src/application/validation/engine.ts');
    const { InMemoryValidationReportRepository } = await import('../src/application/validation/report-repository.ts');
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const projects = new InMemoryProjectRepository();
    const activity = new InMemoryActivityLog(clock);
    const deliveries = new InMemoryDeliveryRepository(clock, ids);
    const reports = new InMemoryValidationReportRepository();
    // 本例要走到交卷后的检查点，所以补一个不做任何存档的 checkpoint。
    const workspace: WorkspaceManager = {
      ...countingWorkspace({ prepares: 0 }),
      async checkpoint() {
        return [];
      },
    };
    // 冻结命令的退出码由用例控制：先跑绿（只跑第一张派发单），再跑红（第二张）。
    let commandExit = 0;
    const engine = new ValidationEngine({
      clock, ids: new SequentialIds(),
      commandRunner: { async run() { return { exitCode: commandExit, timedOut: false, durationMs: 1, output: 'ok' }; } },
      changedPathReader: { async listChanged() { return ['src/foo.ts']; } },
    });
    const platform = new Platform({ projects, deliveries, activity, clock, ids, workspace, validation: { engine, reports } });
    await platform.createMission({ projectId: 'p', missionId: 'm-positive', coordinationMode: 'direct', contract: CONTRACT });
    const controller = await platform.startCoordinatorAttempt('m-positive');
    await platform.updatePlan('m-positive', controller.attemptId, { findings: 'f', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] });
    await platform.submitContractCheck('m-positive', controller.attemptId, { verdict: 'ok', summary: 'checked' });
    const order = { objective: 'fix', allowedScope: ['src/foo.ts'], requiredBehaviour: 'ok', constraints: [], acceptance: ['ok'], verification: ['node --test'], doNot: [], contextRefs: [], validation: { commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }] } };
    await platform.createWorkItem('m-positive', controller.attemptId, { title: 'one', workItemId: 'W-one', order });
    await platform.createWorkItem('m-positive', controller.attemptId, { title: 'two', workItemId: 'W-two', order });
    await platform.dispatchWorkItems('m-positive', controller.attemptId, ['W-one', 'W-two']);
    await platform.finishAttempt('m-positive', controller.attemptId, { endedBy: 'structured_submit' });
    const starts: string[] = [];
    const executor: AgentRuntime = {
      kind: 'direct-test',
      async start(spec) {
        starts.push(spec.workItemId!);
        const result = (async () => {
          await platform.submitEvidence(spec.missionId, spec.attemptId, { kind: 'test', summary: 'ok', command: 'node --test', exitCode: 0 });
          await platform.submitExecutionResult(spec.missionId, spec.attemptId, { outcome: 'completed', summary: 'done', changedFiles: ['src/foo.ts'], evidenceIds: [], notes: '' });
          return { endedBy: 'structured_submit' as const, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, quality: 'reported' as const } };
        })();
        return { resumeRef: undefined, on() { return () => {}; }, async abort() {}, wait() { return result; } };
      },
    };
    const tokens = new RunTokenRegistry();
    const runner = new Orchestrator({ platform, tokens: makeIssuer(platform, tokens), baseUrl: 'http://127.0.0.1:1', workspace,
      coordinator: { runtime: neverStart(starts), candidates: [{ endpoint: 'local', profileId: 'c' }] },
      executor: { runtime: executor, candidates: [{ endpoint: 'local', profileId: 'e' }] },
    });
    const outcome = await runner.runMission('m-positive', { projectRoot: process.cwd() });
    assert.equal(outcome.kind, 'waiting');
    assert.equal(outcome.kind === 'waiting' ? outcome.reason : '', 'waiting_l3');
    assert.deepEqual(starts, ['W-one']);
    const view = await platform.getMissionView('m-positive');
    assert.equal(view.workItems.find(w => w.id === 'W-one')?.status, 'submitted');
    assert.equal(view.workItems.find(w => w.id === 'W-two')?.status, 'dispatched');
    assert.deepEqual(view.coordinatorAttemptIds, [controller.attemptId]);
    const event = (await platform.getActivity('m-positive')).find(e => e.kind === 'validation.reported' && e.workItemId === 'W-one');
    assert.ok(event);
    const report = await platform.getValidationReport('m-positive', (event.data as { reportId: string }).reportId);
    assert.equal(report?.passed, true);
    const item = (await projects.get('p'))!.missions.find(m => m.id === 'm-positive')!.workItem('W-one')!;
    assert.equal(report?.attemptId, item.submittedAttemptId);

    // ---- 第二次 start：同一 runner 接着跑第二张派发单，命令这次是红的 ----
    // direct 不自动返工：验证不过也停在 waiting_l3，工单仍是 submitted，协调者不被叫起来。
    commandExit = 1;
    const outcome2 = await runner.runMission('m-positive', { projectRoot: process.cwd() });
    assert.equal(outcome2.kind, 'waiting');
    assert.equal(outcome2.kind === 'waiting' ? outcome2.reason : '', 'waiting_l3');
    assert.deepEqual(starts, ['W-one', 'W-two']);
    const view2 = await platform.getMissionView('m-positive');
    assert.equal(view2.workItems.find(w => w.id === 'W-one')?.status, 'submitted');
    assert.equal(view2.workItems.find(w => w.id === 'W-two')?.status, 'submitted');
    assert.deepEqual(view2.coordinatorAttemptIds, [controller.attemptId]);
    const events2 = (await platform.getActivity('m-positive')).filter(
      (e): e is typeof e & { data: { reportId: string } } =>
        e.kind === 'validation.reported' && e.workItemId === 'W-two',
    );
    const latest2 = events2[events2.length - 1];
    assert.ok(latest2, '第二张派发单必须留下真实的 validation.reported');
    const report2 = await platform.getValidationReport('m-positive', latest2.data.reportId);
    assert.ok(report2);
    assert.equal(report2.passed, false);
    assert.equal(report2.workItemId, 'W-two');
    const item2 = (await projects.get('p'))!.missions.find(m => m.id === 'm-positive')!.workItem('W-two')!;
    assert.equal(item2.status, 'submitted');
    assert.equal(report2.attemptId, item2.submittedAttemptId);

    // ---- 第三次 start：两张都已 submitted，只补验、不返工、不再起协调者 ----
    const startsBeforeThird = [...starts];
    const reportedBeforeThird = (await platform.getActivity('m-positive')).filter(
      e => e.kind === 'validation.reported' && e.workItemId === 'W-two',
    ).length;
    const outcome3 = await runner.runMission('m-positive', { projectRoot: process.cwd() });
    assert.equal(outcome3.kind, 'waiting');
    assert.equal(outcome3.kind === 'waiting' ? outcome3.reason : '', 'waiting_l3');
    // 没有新的执行者跳，也没有协调者跳（starts 里的 coordinator 条目会露馅）。
    assert.deepEqual(starts, startsBeforeThird);
    assert.deepEqual(starts, ['W-one', 'W-two']);
    const view3 = await platform.getMissionView('m-positive');
    assert.equal(view3.workItems.find(w => w.id === 'W-one')?.status, 'submitted');
    assert.equal(view3.workItems.find(w => w.id === 'W-two')?.status, 'submitted');
    assert.deepEqual(view3.coordinatorAttemptIds, [controller.attemptId]);
    // 同一次提交的报告幂等：不因为重跑换一份新报告。
    const events3 = (await platform.getActivity('m-positive')).filter(
      e => e.kind === 'validation.reported' && e.workItemId === 'W-two',
    );
    assert.equal(events3.length, reportedBeforeThird);
    assert.equal((events3[events3.length - 1]!.data as { reportId: string }).reportId, report2.id);

    assert.ok(!starts.some((entry) => entry.startsWith('coordinator:')));

    // ---- 人工主控请求 accept 也不行：红报告不能被忽略 ----
    await assert.rejects(
      platform.performDirectControl('m-positive', 'test-host', {
        action: 'review',
        workItemId: 'W-two',
        verdict: 'accept',
        reasons: ['人为尝试忽略红报告'],
        requiredChanges: [],
        acceptanceResults: [{ criterion: 'ok', status: 'pass' }],
      }),
      (e: unknown) => (e as { code?: string }).code === 'DIRECT_ACCEPT_REPORT_NOT_PASSED',
    );
    const view4 = await platform.getMissionView('m-positive');
    assert.equal(view4.workItems.find(w => w.id === 'W-two')?.status, 'submitted');
    assert.deepEqual(starts, ['W-one', 'W-two']);
  });
});
