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

async function harness(
  coordinator: ScriptedRuntime,
  executor: ScriptedRuntime,
  options?: { attemptWallClockMs?: number },
) {
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
    attemptWallClockMs: options?.attemptWallClockMs,
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

    // 唤醒语必须把这一轮要验收的**全部**点名。
    //
    // 只说"执行者已经交回结果"的话，验完第一个就交还控制权是完全合理的反应；
    // 而每交还一次就是一轮全新的协调者会话，要把之前的上下文重放一遍。实测
    // 协调者轮次是整条 Mission 开销的主项（走到六轮的那条，协调者占 74%、
    // $16），所以这句话里的数量与 id 是省钱的杠杆，不是措辞。
    const wake = coordinator.instructions[1];
    assert.match(wake, /2 个工作项交回了结果/);
    assert.match(wake, /W-1、W-2/);
    assert.match(wake, /全部验收完/);

    // 协调者**不续跑**上一跳的会话。
    //
    // 曾经每一跳都传 coordinatorResumeRef 接着上一跳往下说。两跳之间隔着一次
    // 执行者运行（实测 13~40 分钟），提示缓存全凉，重放的整段历史按全价重算：
    // W3 的协调者输入逐跳涨 72k→356k→469k→591k→738k→933k，六跳吃掉 74%、$16。
    //
    // 这件事**没有任何外部可见的症状**——续不续跑，界面上一模一样。不钉在这里，
    // 下一个人顺手把 resumeRef 加回去也不会有测试变红。
    assert.deepEqual(
      coordinator.resumeRefs,
      [undefined, undefined],
      '协调者每一跳都该是全新会话',
    );
    // 换来的代价要补偿掉：全新会话必须被告知它不记得上一跳，否则模型会按
    // 「我刚才在做什么」的惯性往下接，而它并没有"刚才"。
    assert.match(wake, /全新的会话/);
    assert.match(wake, /coagent_get_mission/);
    // 开局那一跳没有"上一跳"，说这句只会让人以为前面发生过什么。
    assert.doesNotMatch(coordinator.instructions[0], /全新的会话/);
  });
});

describe('一跳跑太久', () => {
  test('墙钟到点：停下来等人，不冷却候选、不回滚、不换人再烧一遍', async () => {
    // 关键是 hangs 而不是 upstreamFailure：要守的性质是"**一直在产出**的
    // agent 也要被拦下来"。实测 W-785 连续产出 72 分钟，做的是一个后来被
    // 作废的工单，运行时那个静默超时一次都没响。
    const executor = new ScriptedRuntime({ 'executor:W-1': { hangs: true } });
    const { platform, orchestrator } = await harness(
      new ScriptedRuntime(PLAN_AND_DISPATCH),
      executor,
      { attemptWallClockMs: 30 },
    );
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });

    const result = await orchestrator.runMission('M1', { projectRoot: process.cwd() });
    assert.equal(result.kind, 'waiting');
    assert.equal((result as { reason: string }).reason, 'runaway_suspected');

    // 停机原因要能让人直接照做：跑了多久、改动在哪、哪个尝试。
    const detail = (result as { detail: string }).detail;
    assert.match(detail, /工作项 W-1/);
    assert.match(detail, /没有回滚/);
    assert.match(detail, /静默超时不会响/);

    const view = await platform.getMissionView('M1');
    assert.equal(view.waitReason, 'runaway_suspected');
    assert.equal(view.waitDetail, detail, '写回平台的必须是这一句，不是一句泛泛的');

    // **被杀掉的那一跳花的钱要算进账。**
    //
    // 进程被杀就没有结果行，运行时补的是一个全零的 UNKNOWN。照抄下去等于宣称
    // 这一跳没花钱——实测一跳跑了 8 分 50 秒、实时通道里报了几十次用量，
    // 账上是 0，整条 Mission 的用量因此被标成 estimated 而没人知道为什么。
    // 兜底用边跑边收到的最后一次，并把 quality 降成 estimated（那是"最后一次
    // 报告"，不是"跑完的总账"）。
    // 必须断**执行者那一跳自己**的账。断 Mission 合计会被协调者那一跳的
    // 用量盖住：加不加兜底，合计都 >0、quality 都是 estimated——A/B 一验就
    // 发现两边全绿，等于没断。
    const killed = orchestrator.hops.at(-1)?.attemptId as string;
    const detailed = await platform.getAttemptDetail('M1', killed);
    assert.ok(detailed.usage.total > 0, '实时通道里报过用量，这一跳账上不能是 0');
    assert.equal(detailed.usage.quality, 'estimated', '兜底来的数不许冒充精确数');

    // **只跑了一次。** 归成 upstream_failure 的话会冷却候选、回滚工作区、
    // 换下一个候选再跑一遍同样的 30 分钟——三件事全是错的。
    assert.equal(orchestrator.hops.length, 2, '协调者一跳 + 执行者一跳，没有第二个候选');
    assert.deepEqual(
      orchestrator.candidateAvailability().map((c) => c.availability),
      ['available', 'available'],
      '跑太久不是候选的错，不许把它冻进冷却',
    );
  });

  test('交过证据的给一次延长 —— 光看时间分不出"在干活"和"在打转"', async () => {
    // 这一条是首次真实触发误杀之后补的。当时一跳跑满 30 分钟被掐，而它已经
    // 452/452 全绿、正在改注释和函数名。单看墙钟分不出这两种情况；能分出来的
    // 是**平台可见的进展**——被掐那跳是 112 次本地工具调用、零次平台交互。
    const executor = new ScriptedRuntime({
      'executor:W-1': {
        hangsAfterSteps: true,
        steps: [
          { tool: 'coagent_get_work_order', body: {} },
          {
            tool: 'coagent_submit_evidence',
            body: { kind: 'test', summary: '跑过了', command: 'node --test', exitCode: 0 },
          },
        ],
      },
    });
    const { platform, orchestrator } = await harness(
      new ScriptedRuntime(PLAN_AND_DISPATCH),
      executor,
      { attemptWallClockMs: 40 },
    );
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });

    const started = Date.now();
    const result = await orchestrator.runMission('M1', { projectRoot: process.cwd() });
    const elapsed = Date.now() - started;

    // 最终还是会停——延长只给一次，不是无限期放行。
    assert.equal((result as { reason: string }).reason, 'runaway_suspected');
    // 但必须**撑过第一次到点**。没有延长的话第 40 毫秒就被掐了。
    assert.ok(elapsed >= 80, `该等满两个窗口（>=80ms），实际 ${elapsed}ms`);
    assert.match(
      (result as { detail: string }).detail,
      /中途交过证据/,
      '停机原因要说清楚它是"交过东西但没收尾"，还是"什么都没交"——两者处置不同',
    );
  });
});
