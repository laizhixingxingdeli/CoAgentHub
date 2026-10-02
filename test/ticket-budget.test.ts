/**
 * 票级费用上限与 15 工作项检查点：两条综合场景。
 *
 * 都跑在真实编排跳之间（本机 HTTP + ScriptedRuntime + 真实 Orchestrator），
 * 不读源码文本、不复现纯函数层已有的穷举。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
import { ValidationEngine } from '../src/application/validation/engine.ts';
import type { ChangedPathReader, CommandRunner } from '../src/application/validation/ports.ts';
import { Orchestrator } from '../src/application/orchestrator.ts';
import { Platform } from '../src/application/platform.ts';
import { makeIssuer } from '../src/main.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';
import { evaluateMissionCost } from '../src/application/ticket-budget.ts';
import type { MissionContract, TokenUsage, WorkOrder } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: ['不得改 Contract'],
};

const PLAN = {
  findings: 'foo 一直返回 0',
  rootCause: '初始值写错了',
  rejectedHypotheses: ['不是调用方传错'],
  decisions: ['直接改初始值'],
  direction: '改 src/foo.ts',
  risks: [],
};

const USAGE_10: TokenUsage = {
  input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 10, quality: 'reported',
};
const USAGE_0: TokenUsage = {
  input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0, quality: 'reported',
};

function order(objective: string): WorkOrder {
  return {
    objective,
    allowedScope: ['src/foo.ts'],
    requiredBehaviour: 'foo 返回 1',
    constraints: [],
    acceptance: ['foo() === 1'],
    verification: ['node --test'],
    doNot: [],
    contextRefs: [],
  };
}

/** 执行者标准脚本：读工单 → 交一条证据 → 交结果。usage 显式给，不改默认。 */
function executorScript(workItemId: string, usage: TokenUsage): ScriptTable {
  return {
    [`executor:${workItemId}`]: {
      usage,
      steps: [
        { tool: 'coagent_get_work_order', body: {} },
        { tool: 'coagent_submit_evidence', body: { kind: 'test', summary: 'green', command: 'node --test', exitCode: 0 } },
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
}

function fakeRunner(): CommandRunner {
  return {
    async run() {
      return { exitCode: 0, timedOut: false, durationMs: 1, output: 'ok' };
    },
  };
}

function fakePaths(): ChangedPathReader {
  return {
    async listChanged() {
      return ['src/foo.ts'];
    },
  };
}

/** 内存 Platform + 本机 HTTP + 真实 Orchestrator；projectRoot 是临时目录。 */
async function harness(opts: { coordinator: ScriptTable; executor: ScriptTable; projectRoot: string }) {
  const clock = new FixedClock('2026-06-01T12:00:00.000Z');
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const projects = new InMemoryProjectRepository();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
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
    validation: { engine, reports: new InMemoryValidationReportRepository() },
  });
  const tokens = new RunTokenRegistry();
  const server: Server = createApi({ platform, tokens, deliveries });
  await listenLoopback(server, 0);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const coordinatorRt = new ScriptedRuntime(opts.coordinator);
  const executorRt = new ScriptedRuntime(opts.executor);
  const orchestrator = new Orchestrator({
    platform,
    tokens: makeIssuer(platform, tokens),
    baseUrl,
    workspace,
    coordinator: { runtime: coordinatorRt, candidates: [{ endpoint: 'local', profileId: 'coordinator-a' }] },
    executor: { runtime: executorRt, candidates: [{ endpoint: 'local', profileId: 'exec-a' }] },
  });
  return { platform, deliveries, server, orchestrator, coordinatorRt, executorRt };
}

test('费用到 $10 在下一执行者之前停下并可增额续跑；重跑链与 subscription/free 记 0', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'coagent-cost-'));
  const h = await harness({
    projectRoot,
    coordinator: {},
    executor: { ...executorScript('W-1', USAGE_10), ...executorScript('W-2', USAGE_0) },
  });
  try {
    await h.platform.createMission({ projectId: 'P', missionId: 'M-cost', contract: CONTRACT });
    const { attemptId: coord } = await h.platform.startCoordinatorAttempt('M-cost');
    await h.platform.updatePlan('M-cost', coord, PLAN);
    await h.platform.submitContractCheck('M-cost', coord, { verdict: 'ok', summary: '测试契约已核对' });
    const first = await h.platform.createWorkItem('M-cost', coord, { title: '修 foo', order: order('改 foo'), workItemId: 'W-1' });
    assert.equal(first.workItemId, 'W-1');
    const second = await h.platform.createWorkItem('M-cost', coord, { title: '补测试', order: order('补测试'), workItemId: 'W-2' });
    assert.equal(second.workItemId, 'W-2');
    await h.platform.dispatchWorkItems('M-cost', coord, ['W-1', 'W-2']);
    await h.platform.finishAttempt('M-cost', coord, { endedBy: 'structured_submit' });

    // 第一项花到 $10 == 默认 costCap；第二项还一分没花。
    const seeded = await h.platform.getMissionView('M-cost');
    assert.equal(seeded.workItems.length, 2);
    const run1 = await h.orchestrator.runMission('M-cost', { projectRoot, maxRounds: 1 });
    assert.equal(run1.kind, 'awaiting_l3');
    const after1 = await h.platform.getMissionView('M-cost');
    assert.equal(after1.workItems.find((i) => i.id === 'W-1')?.status, 'submitted');
    assert.equal(after1.workItems.find((i) => i.id === 'W-2')?.status, 'dispatched');
    assert.equal(after1.workItems.find((i) => i.id === 'W-2')?.attempts, 0, '第二项还没起来就被停下了');
    assert.equal(after1.waitReason, 'mission_cost_cap_reached');
    const gates = after1.openEscalations;
    assert.equal(gates.length, 1);
    assert.equal(gates[0]!.platformGate?.kind, 'cost_cap');
    assert.match(gates[0]!.question, /\$10\.00/);
    assert.match(gates[0]!.why, /\$10\.00/);
    assert.match(gates[0]!.why, /executor/);
    assert.match(gates[0]!.why, /exec-a/);
    assert.match(gates[0]!.why, /当前工作项 2 个/);
    assert.match(gates[0]!.why, /最近失败事实：/);
    const deliveriesAfter1 = (await h.deliveries.pending()).length;

    // 重复跑不该再动：没有第二个 agent 起来，升级与投递都不再增加。
    const run2 = await h.orchestrator.runMission('M-cost', { projectRoot, maxRounds: 1 });
    assert.equal(run2.kind, 'awaiting_l3');
    const after2 = await h.platform.getMissionView('M-cost');
    assert.equal(after2.waitReason, 'mission_cost_cap_reached');
    assert.equal(after2.openEscalations.length, 1);
    assert.equal((await h.deliveries.pending()).length, deliveriesAfter1);
    assert.equal(h.executorRt.specs.length, 1, '只起来过 W-1 那一个执行者');

    // 默认 +10 → $20：等待与这张未答复的门禁一起清掉。
    const raised = await h.platform.raiseMissionCostCap('M-cost');
    assert.equal(raised.costCap, 20);
    const afterRaise = await h.platform.getMissionView('M-cost');
    assert.equal(afterRaise.waitReason, undefined);
    assert.deepEqual(afterRaise.openEscalations, []);

    // 同一条 Mission 续跑：这一轮 W-2 真的留下了一次执行尝试与提交结果。
    await h.orchestrator.runMission('M-cost', { projectRoot, maxRounds: 1 });
    const after3 = await h.platform.getMissionView('M-cost');
    const w2 = after3.workItems.find((i) => i.id === 'W-2');
    assert.equal(w2?.attempts, 1);
    assert.ok(w2?.executionResult, 'W-2 提交了执行结果');
    assert.equal(h.executorRt.specs.length, 2);

    // 重跑链与 billing：祖先 + 本票合计；subscription/free 记 0；没设 billing 照报告计。
    const attemptOf = (kind: string, cost: number, billing?: string) => ({
      kind,
      usage: { cost },
      ...(billing === undefined
        ? {}
        : { profile: { id: 'exec-a', resolved: [{ key: 'billing', value: billing }] } }),
    });
    const ancestor = {
      id: 'M-old',
      coordinatorAttempts: [attemptOf('coordinator', 3)],
      independentReviewerAttempts: [],
      workItems: [{ attempts: [attemptOf('executor', 4)] }],
    };
    const self = {
      id: 'M-cost',
      origin: { rerunOf: 'M-old' },
      coordinatorAttempts: [],
      independentReviewerAttempts: [],
      workItems: [{ attempts: [attemptOf('executor', 3)] }],
    };
    const chained = evaluateMissionCost(self, [ancestor, self], 20);
    assert.equal(chained.total, 10);
    assert.deepEqual(chained.missionIds, ['M-cost', 'M-old']);
    assert.equal(chained.reached, false);

    const billed = evaluateMissionCost(
      {
        id: 'M-b',
        coordinatorAttempts: [attemptOf('coordinator', 7, 'subscription')],
        independentReviewerAttempts: [attemptOf('independent_reviewer', 9, 'free')],
        workItems: [{ attempts: [attemptOf('executor', 5)] }],
      },
      [],
    );
    assert.equal(billed.total, 5);
    assert.deepEqual(
      billed.byRole,
      [
        { role: 'coordinator', cost: 0 },
        { role: 'independent_reviewer', cost: 0 },
        { role: 'executor', cost: 5 },
      ],
    );
    assert.deepEqual(
      billed.byCandidate,
      [
        { candidateId: 'exec-a', cost: 0 },
        { candidateId: 'unknown', cost: 5 },
      ],
    );
  } finally {
    h.server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('第 15 个工作项停派发并开可答复升级；批准后解除，第 30 个再次停下', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'coagent-checkpoint-'));
  const h = await harness({ projectRoot, coordinator: {}, executor: {} });
  try {
    await h.platform.createMission({ projectId: 'P', missionId: 'M-cp', contract: CONTRACT });
    const { attemptId: coord } = await h.platform.startCoordinatorAttempt('M-cp');
    await h.platform.updatePlan('M-cp', coord, PLAN);
    await h.platform.submitContractCheck('M-cp', coord, { verdict: 'ok', summary: '测试契约已核对' });

    for (let n = 1; n <= 15; n += 1) {
      const created = await h.platform.createWorkItem('M-cp', coord, { title: `项 ${n}`, order: order(`改 ${n}`) });
      assert.equal(created.workItemId, `W-${n}`);
    }
    const at15 = await h.platform.getMissionView('M-cp');
    assert.equal(at15.workItems.length, 15, '第 15 项照常建出来');
    assert.equal(at15.waitReason, 'work_item_checkpoint');
    assert.equal(at15.openEscalations[0]?.platformGate?.threshold, 15);
    assert.deepEqual(
      await h.platform.dispatchWorkItems('M-cp', coord, ['W-15']),
      { dispatched: [] },
    );
    assert.equal(h.executorRt.specs.length, 0, '检查点期间一个执行者都没起来');

    const answered = await h.platform.answerEscalation('M-cp', '继续');
    assert.match(answered.answer, /继续/);
    const afterAnswer = await h.platform.getMissionView('M-cp');
    assert.equal(afterAnswer.waitReason, undefined);
    assert.deepEqual(afterAnswer.openEscalations, []);
    assert.deepEqual(await h.platform.dispatchWorkItems('M-cp', coord, ['W-15']), {
      dispatched: ['W-15'],
    });

    for (let n = 16; n <= 30; n += 1) {
      await h.platform.createWorkItem('M-cp', coord, { title: `项 ${n}`, order: order(`改 ${n}`) });
    }
    const at30 = await h.platform.getMissionView('M-cp');
    assert.equal(at30.workItems.length, 30);
    assert.equal(at30.waitReason, 'work_item_checkpoint');
    assert.equal(at30.openEscalations[0]?.platformGate?.threshold, 30);
    assert.deepEqual(await h.platform.dispatchWorkItems('M-cp', coord, ['W-30']), {
      dispatched: [],
    });
    assert.equal(h.executorRt.specs.length, 0);
  } finally {
    h.server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
