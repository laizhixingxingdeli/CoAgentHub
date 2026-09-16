/**
 * 基础功能：不该打转的地方不许打转。
 *
 * 这两条路径在真机上还没撞过，但从调度器的循环条件看得出来有问题：
 *
 *   - 执行者报 blocked 之后，工作项还留在 dispatched → 调度器会立刻再派一个
 *     执行者，再报一次 blocked，直到轮次上限。**换个人做同一张不成立的工单
 *     不会有任何新信息，只会烧配额。**
 *   - 协调者升级给 L3 之后，没有在途工作项 → 调度器把协调者再叫起来，
 *     它再升级一次，同样打转。
 *
 * 先写测试把它们钉住，再改。
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
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { makeIssuer } from '../src/main.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';

const CONTRACT = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
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
  findings: 'f',
  rejectedHypotheses: [],
  decisions: [],
  direction: 'd',
  risks: [],
};

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

async function harness(coordinator: ScriptedRuntime, executor: ScriptedRuntime) {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const activity = new InMemoryActivityLog(clock);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    workspace: new InPlaceWorkspaceManager(),
    activity,
    clock,
    ids,
  });
  const tokens = new RunTokenRegistry();
  const server = createApi({ platform, tokens, deliveries });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const orchestrator = new Orchestrator({
    platform,
    tokens: makeIssuer(platform, tokens),
    baseUrl,
    workspace: new InPlaceWorkspaceManager(),
    coordinator: { runtime: coordinator, candidates: [{ endpoint: 'l', profileId: 'c' }] },
    executor: { runtime: executor, candidates: [{ endpoint: 'l', profileId: 'e' }] },
  });
  return { platform, deliveries, orchestrator };
}

/** 协调者：规划 → 建工作项 → 派发。之后每次被唤醒都只看一眼。 */
const PLAN_AND_DISPATCH: ScriptTable = {
  'coordinator:-:0': {
    steps: [
      { tool: 'coagent_update_plan', body: PLAN },
      { tool: 'coagent_create_work_item', body: { title: 'W', ...ORDER } },
      {
        tool: 'coagent_dispatch_work_item',
        body: (previous) => ({ workItemIds: [previous.workItemId] }),
      },
    ],
  },
  // 被叫醒之后什么也不提交——模拟「协调者没想好怎么办」。
  'coordinator:-': { steps: [{ tool: 'coagent_get_mission', body: {} }] },
};

describe('执行者报 blocked 之后不许原地再派一个人', () => {
  test('工作项离开 dispatched，控制权回到协调者', async () => {
    const executor = new ScriptedRuntime({
      'executor:W-1': {
        steps: [
          { tool: 'coagent_get_work_order', body: {} },
          {
            tool: 'coagent_report_blocked',
            body: {
              reason: '工单说改 src/foo.ts，但这个文件不存在',
              whatWasTried: ['ls src/', 'grep -r foo'],
              needsFromUpstream: '确认真正的文件路径',
            },
          },
        ],
      },
    });
    const { platform, orchestrator } = await harness(
      new ScriptedRuntime(PLAN_AND_DISPATCH),
      executor,
    );
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });

    const result = await orchestrator.runMission('M1', {
      projectRoot: process.cwd(),
      maxRounds: 6,
    });

    const view = await platform.getMissionView('M1');
    assert.notEqual(
      view.workItems[0].status,
      'dispatched',
      'blocked 之后还留在 dispatched，调度器会一直派新人做同一张不成立的工单',
    );

    // 关键判据：执行者只被叫了一次。
    const executorHops = orchestrator.hops.filter((h) => h.role === 'executor');
    assert.equal(executorHops.length, 1, `执行者被反复调用了 ${executorHops.length} 次`);
    assert.equal(result.kind, 'stalled', '协调者没处理，最终该停下来交给人');
  });
});

describe('协调者升级 L3 之后不许自问自答', () => {
  test('升级即停，并且 L3 真的收得到', async () => {
    const coordinator = new ScriptedRuntime({
      'coordinator:-': {
        steps: [
          { tool: 'coagent_get_mission', body: {} },
          {
            tool: 'coagent_escalate_to_l3',
            body: {
              question: 'Contract 说不许加依赖，但这个需求没有依赖做不了',
              why: '动到了 Contract 的 constraints',
              optionsConsidered: ['自己实现一份（两周）', '放宽约束'],
            },
          },
        ],
      },
    });
    const { platform, deliveries, orchestrator } = await harness(
      coordinator,
      new ScriptedRuntime({}),
    );
    await platform.createMission({
      projectId: 'P',
      missionId: 'M1',
      contract: CONTRACT,
      origin: { clientType: 'cli', conversationRef: 'l3' },
    });

    const result = await orchestrator.runMission('M1', {
      projectRoot: process.cwd(),
      maxRounds: 6,
    });

    assert.equal(
      orchestrator.hops.length,
      1,
      `升级之后协调者被反复叫起来 ${orchestrator.hops.length} 次，它只会再升级一次`,
    );
    assert.equal(result.kind, 'awaiting_l3');

    // 升级的全部意义是让 L3 知道。不进收件箱等于没升级。
    const pending = await deliveries.pending('l3');
    assert.equal(pending.length, 1, '升级必须进收件箱，否则 L3 永远不知道');
    assert.equal(pending[0].outcome, 'escalated');
  });
});

describe('多工作项', () => {
  test('两个工作项依次执行，全部验收后才交卷', async () => {
    const coordinator = new ScriptedRuntime({
      'coordinator:-:0': {
        steps: [
          { tool: 'coagent_update_plan', body: PLAN },
          { tool: 'coagent_create_work_item', body: { title: 'W1', ...ORDER } },
          { tool: 'coagent_create_work_item', body: { title: 'W2', ...ORDER } },
          { tool: 'coagent_dispatch_work_item', body: { workItemIds: ['W-1', 'W-2'] } },
        ],
      },
      'coordinator:-:1': {
        steps: [
          { tool: 'coagent_get_mission', body: {} },
          // 只验收一个就想交卷 —— 平台必须拦下来。
          {
            tool: 'coagent_review_execution_result',
            body: { workItemId: 'W-1', verdict: 'accept', reasons: ['ok'], requiredChanges: [] },
          },
          {
            tool: 'coagent_submit_mission_result',
            body: {
              outcome: 'delivered',
              summary: '急着交',
              acceptanceEvidence: [],
              memoryDelta: [],
              openRisks: [],
            },
            expectFailure: true,
          },
          {
            tool: 'coagent_review_execution_result',
            body: { workItemId: 'W-2', verdict: 'accept', reasons: ['ok'], requiredChanges: [] },
          },
          {
            tool: 'coagent_submit_mission_result',
            body: {
              outcome: 'delivered',
              summary: '两个都验完了',
              acceptanceEvidence: ['两个工作项各自的证据'],
              memoryDelta: [],
              openRisks: [],
            },
          },
        ],
      },
    });

    const executorSteps = {
      steps: [
        { tool: 'coagent_get_work_order', body: {} },
        {
          // S11.1：completed 必须有证据撑着，平台会拦下没证据的提交。
          tool: 'coagent_submit_evidence',
          body: { kind: 'test', summary: 'node --test 全绿', command: 'node --test', exitCode: 0 },
        },
        {
          tool: 'coagent_submit_execution_result',
          body: {
            outcome: 'completed' as const,
            summary: '做完了',
            changedFiles: ['src/foo.ts'],
            evidenceIds: [],
            notes: '无',
          },
        },
      ],
    };
    const executor = new ScriptedRuntime({
      'executor:W-1': executorSteps,
      'executor:W-2': executorSteps,
    });

    const { platform, orchestrator } = await harness(coordinator, executor);
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });

    const result = await orchestrator.runMission('M1', { projectRoot: process.cwd() });
    assert.deepEqual(result, { kind: 'awaiting_l3_review' });

    const view = await platform.getMissionView('M1');
    assert.equal(view.workItems.length, 2);
    for (const item of view.workItems) assert.equal(item.status, 'accepted');

    // 被拦下的那次交卷确实发生过。
    const blockedSubmit = coordinator.transcript.find(
      (entry) => entry.tool === 'coagent_submit_mission_result' && entry.status === 409,
    );
    assert.ok(blockedSubmit, '只验收一半就交卷必须被拦');
    assert.equal((blockedSubmit.json as { error: string }).error, 'WORK_ITEMS_UNFINISHED');
  });
});
