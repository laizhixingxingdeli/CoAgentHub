/**
 * 流水线（S07.1）。
 *
 * 要证明的只有两件事：
 *   1. 同一 Project 的第二条 Mission **可以并发调查与规划**
 *   2. 但它**不能同时改代码** —— 撞上名额就让位，而不是当成失败
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
import { runPipeline } from '../src/application/pipeline.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { makeIssuer } from '../src/main.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

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

async function harness() {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    workspace: new InPlaceWorkspaceManager(),
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
  });
  const tokens = new RunTokenRegistry();
  const server = createApi({ platform, tokens, deliveries });
  await listenLoopback(server, 0);
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /**
   * 每条 Mission 一个 orchestrator：冷却表挂在实例上，共用的话
   * A 把候选烧进冷却会连带挡住 B。
   */
  const make = (coordinator: ScriptedRuntime, executor: ScriptedRuntime) => () =>
    new Orchestrator({
      platform,
      tokens: makeIssuer(platform, tokens),
      baseUrl,
      workspace: new InPlaceWorkspaceManager(),
      coordinator: { runtime: coordinator, candidates: [{ endpoint: 'l', profileId: 'c' }] },
      executor: { runtime: executor, candidates: [{ endpoint: 'l', profileId: 'e' }] },
    });

  return { platform, make };
}

/** 只调查和规划，不派发 —— 模拟"在等名额时做点不冲突的事"。 */
const INVESTIGATE_ONLY = {
  'coordinator:-': {
    steps: [
      { tool: 'coagent_get_mission', body: {} },
      { tool: 'coagent_update_plan', body: PLAN },
    ],
  },
};

/** 规划 + 派发，会去抢改动名额。 */
function planAndDispatch() {
  return {
    'coordinator:-:0': {
      steps: [
        { tool: 'coagent_update_plan', body: PLAN },
        { tool: 'coagent_create_work_item', body: { title: 'W', ...ORDER } },
        { tool: 'coagent_submit_contract_check', body: { verdict: 'ok', summary: '测试契约已核对' } },
        { tool: 'coagent_dispatch_work_item', body: (previous) => ({ workItemIds: [previous.workItemId] }) },
      ],
    },
    'coordinator:-': { steps: [{ tool: 'coagent_get_mission', body: {} }] },
  };
}

describe('流水线', () => {
  test('A 在改代码时，B 照样能调查和规划', async () => {
    const { platform, make } = await harness();
    await platform.createMission({ projectId: 'P', missionId: 'A', contract: CONTRACT });
    await platform.createMission({ projectId: 'P', missionId: 'B', contract: CONTRACT });

    const results = await runPipeline(
      [
        { missionId: 'A', options: { projectRoot: process.cwd(), maxRounds: 1 } },
        { missionId: 'B', options: { projectRoot: process.cwd(), maxRounds: 1 } },
      ],
      (id) =>
        id === 'A'
          ? make(new ScriptedRuntime(planAndDispatch()), new ScriptedRuntime({}))()
          : make(new ScriptedRuntime(INVESTIGATE_ONLY), new ScriptedRuntime({}))(),
      { maxRetries: 0 },
    );

    assert.equal(results.length, 2);
    // A 占了名额去改代码。
    assert.equal((await platform.getMissionView('A')).isMutating, true);
    // B 同时完成了规划——**这就是流水线**：等名额的时候不是干等着。
    assert.equal((await platform.getMissionView('B')).planRevision, 1);
    assert.equal((await platform.getMissionView('B')).isMutating, false);
  });

  test('B 想派发时撞上名额 —— 让位，不是失败', async () => {
    const { platform, make } = await harness();
    await platform.createMission({ projectId: 'P', missionId: 'A', contract: CONTRACT });
    await platform.createMission({ projectId: 'P', missionId: 'B', contract: CONTRACT });

    // 先让 A 占住名额。
    await make(new ScriptedRuntime(planAndDispatch()), new ScriptedRuntime({}))().runMission(
      'A',
      { projectRoot: process.cwd(), maxRounds: 1 },
    );
    assert.equal((await platform.getMissionView('A')).isMutating, true);

    const [result] = await runPipeline(
      [{ missionId: 'B', options: { projectRoot: process.cwd(), maxRounds: 2 } }],
      () => make(new ScriptedRuntime(planAndDispatch()), new ScriptedRuntime({}))(),
      { maxRetries: 1 },
    );

    assert.equal(result.outcome.kind, 'waiting');
    assert.equal((result.outcome as { reason: string }).reason, 'project_busy');
    assert.ok(result.yielded >= 1, '撞上名额要让位重试，而不是一次就判死');

    // 停机原因落到 Mission 上，界面能说清楚「在排队」而不是「出错了」。
    const blocked = await platform.getMissionView('B');
    assert.equal(blocked.waitReason, 'project_busy');
    // 而且要点名占着名额的是谁。只说「忙」的话，人下一步只能挨个翻。
    assert.match(blocked.waitDetail ?? '', /\bA\b/);
    // B 的工作项没有被改成 dispatched——被拒绝的派发不留下半套流转。
    assert.equal((await platform.getMissionView('B')).workItems[0].status, 'created');
  });

  test('让位有上限，不会一直空转烧钱', async () => {
    const { platform, make } = await harness();
    await platform.createMission({ projectId: 'P', missionId: 'A', contract: CONTRACT });
    await platform.createMission({ projectId: 'P', missionId: 'B', contract: CONTRACT });
    await make(new ScriptedRuntime(planAndDispatch()), new ScriptedRuntime({}))().runMission(
      'A',
      { projectRoot: process.cwd(), maxRounds: 1 },
    );

    const [result] = await runPipeline(
      [{ missionId: 'B', options: { projectRoot: process.cwd(), maxRounds: 2 } }],
      () => make(new ScriptedRuntime(planAndDispatch()), new ScriptedRuntime({}))(),
      { maxRetries: 2 },
    );
    // maxRetries=2 表示首轮之外再试 2 次，所以最多跑 3 轮、让位 3 次。
    // 关键是**有上限**：每一轮空转都是真的在调 agent 花钱。
    assert.equal(result.yielded, 3, '到上限就停');
  });

  test('不同 Project 之间互不让位', async () => {
    const { platform, make } = await harness();
    await platform.createMission({ projectId: 'P1', missionId: 'A', contract: CONTRACT });
    await platform.createMission({ projectId: 'P2', missionId: 'B', contract: CONTRACT });

    const results = await runPipeline(
      [
        { missionId: 'A', options: { projectRoot: process.cwd(), maxRounds: 1 } },
        { missionId: 'B', options: { projectRoot: process.cwd(), maxRounds: 1 } },
      ],
      (id) =>
        make(
          new ScriptedRuntime(planAndDispatch()),
          new ScriptedRuntime({}),
        )(),
      { maxRetries: 0 },
    );

    for (const result of results) assert.equal(result.yielded, 0);
    assert.equal((await platform.getMissionView('A')).isMutating, true);
    assert.equal((await platform.getMissionView('B')).isMutating, true);
  });
});
