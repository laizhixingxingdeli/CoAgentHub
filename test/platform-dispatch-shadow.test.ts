/**
 * Platform.dispatchWorkItems PRE_DISPATCH shadow 接线：
 * 可选 decisionProvider；named answers / 失败绝不改变真实 dispatch。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform, PlatformRuleError } from '../src/application/platform.ts';
import {
  DECISION_SHADOW_EVENT_KIND,
  type DecisionShadowEventData,
} from '../src/application/decision-shadow-runner.ts';
import type {
  ActivityEvent,
  ActivityLog,
  DecisionAnswerSet,
  DecisionProvider,
  DecisionRequest,
  DecisionSignal,
} from '../src/application/ports.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: ['不加依赖'],
  nonGoals: ['不重构 Y'],
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
};

const PLAN = {
  findings: '查到了',
  rejectedHypotheses: [] as string[],
  decisions: [] as string[],
  direction: '这么改',
  risks: [] as string[],
};

function makePlatform(decisionProvider?: DecisionProvider, activity?: ActivityLog) {
  const clock = new FixedClock();
  const log = activity ?? new InMemoryActivityLog(clock);
  const projects = new InMemoryProjectRepository();
  const ids = new SequentialIds();
  const platform = new Platform({
    projects,
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    activity: log,
    clock,
    ids,
    ...(decisionProvider ? { decisionProvider } : {}),
  });
  return { platform, activity: log, projects, ids, clock };
}

function capturingProvider(
  answers: Readonly<Record<string, DecisionSignal>> | (() => DecisionAnswerSet),
  sink: { calls: number; request?: DecisionRequest },
): DecisionProvider {
  return {
    kind: 'capture',
    async decide(request: DecisionRequest): Promise<DecisionAnswerSet> {
      sink.calls += 1;
      sink.request = request;
      return typeof answers === 'function' ? answers() : { answers };
    },
  };
}

function throwingProvider(sink: { calls: number }): DecisionProvider {
  return {
    kind: 'throwing',
    async decide(): Promise<DecisionAnswerSet> {
      sink.calls += 1;
      throw new Error('provider boom');
    },
  };
}

/** ActivityLog：仅 decision.shadow 的 append 失败，其它事件正常。 */
class ShadowAppendFailActivityLog implements ActivityLog {
  #inner: InMemoryActivityLog;
  shadowAppends = 0;

  constructor(clock: FixedClock) {
    this.#inner = new InMemoryActivityLog(clock);
  }

  async append(event: Omit<ActivityEvent, 'at'>): Promise<void> {
    if (event.kind === DECISION_SHADOW_EVENT_KIND) {
      this.shadowAppends += 1;
      throw new Error('shadow append failed');
    }
    await this.#inner.append(event);
  }

  async list(missionId: string): Promise<readonly ActivityEvent[]> {
    return this.#inner.list(missionId);
  }
}

async function prepareMission(
  platform: Platform,
  missionId: string,
  projectId = 'P',
): Promise<{ attemptId: string }> {
  await platform.createMission({ projectId, missionId, contract: CONTRACT });
  const { attemptId } = await platform.startCoordinatorAttempt(missionId);
  await platform.updatePlan(missionId, attemptId, PLAN);
  return { attemptId };
}

async function createItem(
  platform: Platform,
  missionId: string,
  attemptId: string,
  title = 'W',
): Promise<string> {
  const { workItemId } = await platform.createWorkItem(missionId, attemptId, {
    title,
    order: ORDER,
  });
  return workItemId;
}

function shadowEvents(events: readonly ActivityEvent[]): ActivityEvent[] {
  return events.filter((e) => e.kind === DECISION_SHADOW_EVENT_KIND);
}

function dispatchedEvents(events: readonly ActivityEvent[]): ActivityEvent[] {
  return events.filter((e) => e.kind === 'work_item.dispatched');
}

describe('Platform.dispatchWorkItems PRE_DISPATCH shadow', () => {
  test('未注入 provider：结果与既有 dispatch 一致，0 decision.shadow，0 decide', async () => {
    const sink = { calls: 0 };
    // 不注入 provider；另造一个带 provider 的对照不需要——直接断言无 shadow。
    const { platform, activity } = makePlatform();
    const { attemptId } = await prepareMission(platform, 'M1');
    const workItemId = await createItem(platform, 'M1', attemptId);

    const result = await platform.dispatchWorkItems('M1', attemptId, [workItemId]);
    assert.deepEqual(result, { dispatched: [workItemId] });

    const view = await platform.getMissionView('M1');
    assert.equal(view.status, 'executing');
    assert.equal(view.workItems[0]?.status, 'dispatched');

    const events = await activity.list('M1');
    assert.equal(shadowEvents(events).length, 0);
    assert.equal(dispatchedEvents(events).length, 1);
    assert.equal(sink.calls, 0);
  });

  test('单 item success：1 decide；request 带 workItemId；shadow + dispatched 都在', async () => {
    const sink = { calls: 0, request: undefined as DecisionRequest | undefined };
    const provider = capturingProvider({}, sink);
    const { platform, activity } = makePlatform(provider);
    const { attemptId } = await prepareMission(platform, 'M1');
    const workItemId = await createItem(platform, 'M1', attemptId);

    const result = await platform.dispatchWorkItems('M1', attemptId, [workItemId]);
    assert.deepEqual(result, { dispatched: [workItemId] });
    assert.equal(sink.calls, 1);
    assert.ok(sink.request);
    assert.equal(sink.request.hook, 'PRE_DISPATCH');
    assert.equal(sink.request.projectId, 'P');
    assert.equal(sink.request.missionId, 'M1');
    assert.equal(sink.request.attemptId, attemptId);
    assert.equal(sink.request.workItemId, workItemId);
    assert.equal('workItemIds' in sink.request, false);

    const events = await activity.list('M1');
    const shadows = shadowEvents(events);
    assert.equal(shadows.length, 1);
    assert.equal(dispatchedEvents(events).length, 1);

    const data = shadows[0]!.data as DecisionShadowEventData;
    assert.equal(data.quality, 'success');
    assert.equal(data.hook, 'PRE_DISPATCH');
    assert.deepEqual(data.ids.workItemIds, [workItemId]);
    assert.equal(data.ids.workItemId, workItemId);
    assert.equal(data.ids.attemptId, attemptId);

    const view = await platform.getMissionView('M1');
    assert.equal(view.workItems[0]?.status, 'dispatched');
  });

  test('多 item success：1 decide；request 不带 workItemId；shadow ids 含整批', async () => {
    const sink = { calls: 0, request: undefined as DecisionRequest | undefined };
    const provider = capturingProvider({}, sink);
    const { platform, activity } = makePlatform(provider);
    const { attemptId } = await prepareMission(platform, 'M1');
    const w1 = await createItem(platform, 'M1', attemptId, 'W1');
    const w2 = await createItem(platform, 'M1', attemptId, 'W2');
    const w3 = await createItem(platform, 'M1', attemptId, 'W3');
    const ids = [w1, w2, w3];

    const result = await platform.dispatchWorkItems('M1', attemptId, ids);
    assert.deepEqual(result, { dispatched: ids });
    assert.equal(sink.calls, 1);
    assert.ok(sink.request);
    assert.equal('workItemId' in sink.request, false);
    assert.equal(sink.request.attemptId, attemptId);

    const events = await activity.list('M1');
    const shadows = shadowEvents(events);
    assert.equal(shadows.length, 1);
    const data = shadows[0]!.data as DecisionShadowEventData;
    assert.deepEqual(data.ids.workItemIds, ids);
    assert.equal('workItemId' in data.ids, false);

    const view = await platform.getMissionView('M1');
    assert.deepEqual(
      view.workItems.map((w) => w.status),
      ['dispatched', 'dispatched', 'dispatched'],
    );
    assert.equal(dispatchedEvents(events).length, 1);
  });

  test('choice / score / noop 信号都不改变 dispatch 结果', async () => {
    const answerPacks: ReadonlyArray<Readonly<Record<string, DecisionSignal>>> = [
      { task_type: { kind: 'choice', option: 'skip-all' } },
      { semantic_risk: { kind: 'score', value: 0.01, scale: 'confidence' } },
      { shadow: { kind: 'noop', reason: 'shadow-only' } },
    ];

    for (const [i, answers] of answerPacks.entries()) {
      const sink = { calls: 0, request: undefined as DecisionRequest | undefined };
      const { platform, activity } = makePlatform(capturingProvider(answers, sink));
      const missionId = `M-sig-${i}`;
      const { attemptId } = await prepareMission(platform, missionId);
      const workItemId = await createItem(platform, missionId, attemptId);

      const result = await platform.dispatchWorkItems(missionId, attemptId, [workItemId]);
      assert.deepEqual(result, { dispatched: [workItemId] });
      assert.equal(sink.calls, 1);

      const view = await platform.getMissionView(missionId);
      assert.equal(view.workItems[0]?.status, 'dispatched');
      assert.equal(view.status, 'executing');

      const events = await activity.list(missionId);
      assert.equal(shadowEvents(events).length, 1);
      assert.equal(dispatchedEvents(events).length, 1);
      const data = shadowEvents(events)[0]!.data as DecisionShadowEventData;
      assert.equal(data.quality, 'success');
      if (data.quality === 'success') {
        assert.deepEqual(data.answers, answers);
      }
    }
  });

  test('provider throw：dispatch 仍成功 + shadow provider_error', async () => {
    const sink = { calls: 0 };
    const { platform, activity } = makePlatform(throwingProvider(sink));
    const { attemptId } = await prepareMission(platform, 'M1');
    const workItemId = await createItem(platform, 'M1', attemptId);

    const result = await platform.dispatchWorkItems('M1', attemptId, [workItemId]);
    assert.deepEqual(result, { dispatched: [workItemId] });
    assert.equal(sink.calls, 1);

    const view = await platform.getMissionView('M1');
    assert.equal(view.workItems[0]?.status, 'dispatched');

    const events = await activity.list('M1');
    assert.equal(dispatchedEvents(events).length, 1);
    const shadows = shadowEvents(events);
    assert.equal(shadows.length, 1);
    const data = shadows[0]!.data as DecisionShadowEventData;
    assert.equal(data.quality, 'provider_error');
    assert.equal('answers' in data, false);
  });

  test('shadow append fail：dispatch 仍成功，其它事件正常', async () => {
    const clock = new FixedClock();
    const activity = new ShadowAppendFailActivityLog(clock);
    const sink = { calls: 0, request: undefined as DecisionRequest | undefined };
    const { platform } = makePlatform(capturingProvider({}, sink), activity);
    const { attemptId } = await prepareMission(platform, 'M1');
    const workItemId = await createItem(platform, 'M1', attemptId);

    const result = await platform.dispatchWorkItems('M1', attemptId, [workItemId]);
    assert.deepEqual(result, { dispatched: [workItemId] });
    assert.equal(sink.calls, 1);
    assert.equal(activity.shadowAppends, 1);

    const view = await platform.getMissionView('M1');
    assert.equal(view.workItems[0]?.status, 'dispatched');

    const events = await activity.list('M1');
    assert.equal(shadowEvents(events).length, 0);
    assert.equal(dispatchedEvents(events).length, 1);
  });

  test('EMPTY_DISPATCH：0 decide、0 decision.shadow', async () => {
    const sink = { calls: 0 };
    const { platform, activity } = makePlatform(throwingProvider(sink));
    const { attemptId } = await prepareMission(platform, 'M1');

    await assert.rejects(
      () => platform.dispatchWorkItems('M1', attemptId, []),
      (e: unknown) => (e as PlatformRuleError).code === 'EMPTY_DISPATCH',
    );
    assert.equal(sink.calls, 0);
    assert.equal(shadowEvents(await activity.list('M1')).length, 0);
  });

  test('UNKNOWN_WORK_ITEM：0 decide、0 decision.shadow', async () => {
    const sink = { calls: 0 };
    const { platform, activity } = makePlatform(throwingProvider(sink));
    const { attemptId } = await prepareMission(platform, 'M1');
    await createItem(platform, 'M1', attemptId);

    await assert.rejects(
      () => platform.dispatchWorkItems('M1', attemptId, ['W-nope']),
      (e: unknown) => (e as PlatformRuleError).code === 'UNKNOWN_WORK_ITEM',
    );
    assert.equal(sink.calls, 0);
    assert.equal(shadowEvents(await activity.list('M1')).length, 0);
  });

  test('NOT_DISPATCHABLE：0 decide、0 decision.shadow', async () => {
    const sink = { calls: 0 };
    const { platform, activity } = makePlatform(throwingProvider(sink));
    const { attemptId } = await prepareMission(platform, 'M1');
    const workItemId = await createItem(platform, 'M1', attemptId);

    // 先成功派发一次，再对已 dispatched 的项再次派发 → NOT_DISPATCHABLE
    await platform.dispatchWorkItems('M1', attemptId, [workItemId]);
    // 清空对第一次成功 shadow 的计数关注：之后再次调用不得再 decide
    const callsAfterFirst = sink.calls;
    assert.equal(callsAfterFirst, 1);

    await assert.rejects(
      () => platform.dispatchWorkItems('M1', attemptId, [workItemId]),
      (e: unknown) => (e as PlatformRuleError).code === 'NOT_DISPATCHABLE',
    );
    assert.equal(sink.calls, callsAfterFirst);
    // 第二次失败不得新增 shadow
    assert.equal(shadowEvents(await activity.list('M1')).length, 1);
  });

  test('PROJECT_BUSY：0 decide、0 decision.shadow，工作项保持 created', async () => {
    const sink = { calls: 0 };
    const { platform, activity } = makePlatform(throwingProvider(sink));
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await platform.createMission({ projectId: 'P', missionId: 'M2', contract: CONTRACT });

    // M1 占名额
    const a1 = await platform.startCoordinatorAttempt('M1');
    await platform.updatePlan('M1', a1.attemptId, PLAN);
    const w1 = await createItem(platform, 'M1', a1.attemptId);
    await platform.dispatchWorkItems('M1', a1.attemptId, [w1]);
    const callsAfterM1 = sink.calls;
    assert.equal(callsAfterM1, 1);

    // M2 被挡
    const a2 = await platform.startCoordinatorAttempt('M2');
    await platform.updatePlan('M2', a2.attemptId, PLAN);
    const w2 = await createItem(platform, 'M2', a2.attemptId);

    await assert.rejects(
      () => platform.dispatchWorkItems('M2', a2.attemptId, [w2]),
      (e: unknown) => (e as PlatformRuleError).code === 'PROJECT_BUSY',
    );
    assert.equal(sink.calls, callsAfterM1, 'PROJECT_BUSY 时不得 decide');

    const view = await platform.getMissionView('M2');
    assert.equal(view.workItems[0]?.status, 'created');
    assert.equal(shadowEvents(await activity.list('M2')).length, 0);
    assert.equal(dispatchedEvents(await activity.list('M2')).length, 0);
  });
});
