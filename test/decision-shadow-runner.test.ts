/**
 * PRE_DISPATCH shadow runner：只审计、不写 kernel、失败不传播。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DECISION_SHADOW_EVENT_KIND,
  runDecisionShadow,
  type DecisionShadowEventData,
} from '../src/application/decision-shadow-runner.ts';
import {
  DECISION_STATE_SCHEMA_VERSION,
  EMPTY_DECISION_STATE_FACTS,
} from '../src/application/decision-state-builder.ts';
import { FixedClock, InMemoryActivityLog } from '../src/application/in-memory.ts';
import { NoopDecisionProvider } from '../src/application/noop-decision-provider.ts';
import type {
  ActivityEvent,
  ActivityLog,
  DecisionProvider,
  DecisionRequest,
  DecisionSignal,
} from '../src/application/ports.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function relPosix(abs: string): string {
  return relative(root, abs).split('\\').join('/');
}

function baseStateInput() {
  return {
    hook: 'PRE_DISPATCH' as const,
    projectId: 'p-1',
    missionId: 'm-1',
  };
}

function capturingProvider(
  signal: DecisionSignal,
  sink: { request?: DecisionRequest },
): DecisionProvider {
  return {
    kind: 'capture',
    async decide(request: DecisionRequest): Promise<DecisionSignal> {
      sink.request = request;
      return signal;
    },
  };
}

describe('runDecisionShadow — 成功路径', () => {
  test('noop：append decision.shadow，data 含必填字段与 signal', async () => {
    const clock = new FixedClock(new Date('2026-03-20T12:00:00.000Z'));
    const activity = new InMemoryActivityLog(clock);
    const sink: { request?: DecisionRequest } = {};
    const provider = capturingProvider({ kind: 'noop' }, sink);

    const outcome = await runDecisionShadow({
      provider,
      activity,
      stateInput: baseStateInput(),
      workItemIds: ['w-a', 'w-b'],
    });

    assert.deepEqual(outcome, { recorded: true, quality: 'success' });
    assert.ok(sink.request);
    assert.deepEqual(sink.request, {
      hook: 'PRE_DISPATCH',
      projectId: 'p-1',
      missionId: 'm-1',
      facts: EMPTY_DECISION_STATE_FACTS,
    });
    // audit workItemIds 不得进入 DecisionRequest
    assert.equal('workItemIds' in sink.request!, false);

    const events = await activity.list('m-1');
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.kind, DECISION_SHADOW_EVENT_KIND);
    assert.equal(event.projectId, 'p-1');
    assert.equal(event.missionId, 'm-1');

    const data = event.data as DecisionShadowEventData;
    assert.equal(data.schemaVersion, DECISION_STATE_SCHEMA_VERSION);
    assert.equal(data.hook, 'PRE_DISPATCH');
    assert.equal(data.providerKind, 'capture');
    assert.equal(data.quality, 'success');
    assert.deepEqual(data.ids, {
      projectId: 'p-1',
      missionId: 'm-1',
      workItemIds: ['w-a', 'w-b'],
    });
    assert.ok(data.quality === 'success' && 'signal' in data);
    assert.deepEqual(data.signal, { kind: 'noop' });
  });

  test('choice：signal 原样写入 data', async () => {
    const activity = new InMemoryActivityLog(new FixedClock(new Date('2026-03-20T12:00:00.000Z')));
    const signal: DecisionSignal = { kind: 'choice', option: 'prefer-a' };
    const sink: { request?: DecisionRequest } = {};

    const outcome = await runDecisionShadow({
      provider: capturingProvider(signal, sink),
      activity,
      stateInput: {
        ...baseStateInput(),
        workItemId: 'w-1',
        facts: [{ key: 'route', value: 'a' }],
      },
      workItemIds: ['w-1'],
    });

    assert.equal(outcome.recorded, true);
    assert.equal(outcome.quality, 'success');
    assert.deepEqual(sink.request, {
      hook: 'PRE_DISPATCH',
      projectId: 'p-1',
      missionId: 'm-1',
      workItemId: 'w-1',
      facts: [{ key: 'route', value: 'a' }],
    });

    const event = (await activity.list('m-1'))[0]!;
    assert.equal(event.workItemId, 'w-1');
    const data = event.data as DecisionShadowEventData;
    assert.equal(data.quality, 'success');
    assert.ok(data.quality === 'success');
    assert.deepEqual(data.signal, signal);
    assert.deepEqual(data.ids.workItemIds, ['w-1']);
    assert.equal(data.ids.workItemId, 'w-1');
  });

  test('score：signal 原样写入 data', async () => {
    const activity = new InMemoryActivityLog(new FixedClock(new Date('2026-03-20T12:00:00.000Z')));
    const signal: DecisionSignal = { kind: 'score', value: 0.75, scale: 'unit' };

    const outcome = await runDecisionShadow({
      provider: {
        kind: 'scorer',
        async decide(): Promise<DecisionSignal> {
          return signal;
        },
      },
      activity,
      stateInput: {
        ...baseStateInput(),
        attemptId: 'a-1',
      },
      workItemIds: [],
    });

    assert.deepEqual(outcome, { recorded: true, quality: 'success' });
    const data = (await activity.list('m-1'))[0]!.data as DecisionShadowEventData;
    assert.equal(data.providerKind, 'scorer');
    assert.equal(data.quality, 'success');
    assert.ok(data.quality === 'success');
    assert.deepEqual(data.signal, signal);
    assert.equal(data.ids.attemptId, 'a-1');
    assert.deepEqual(data.ids.workItemIds, []);
  });

  test('NoopDecisionProvider 集成：quality=success 且 signal.kind=noop', async () => {
    const activity = new InMemoryActivityLog(new FixedClock(new Date('2026-03-20T12:00:00.000Z')));
    const outcome = await runDecisionShadow({
      provider: new NoopDecisionProvider(),
      activity,
      stateInput: baseStateInput(),
      workItemIds: ['w-x'],
    });
    assert.deepEqual(outcome, { recorded: true, quality: 'success' });
    const data = (await activity.list('m-1'))[0]!.data as DecisionShadowEventData;
    assert.equal(data.providerKind, 'noop');
    assert.ok(data.quality === 'success');
    assert.deepEqual(data.signal, { kind: 'noop' });
  });
});

describe('runDecisionShadow — 失败吞没', () => {
  test('provider throw：不向调用方抛；append quality=provider_error；无 signal / 无堆栈', async () => {
    const activity = new InMemoryActivityLog(new FixedClock(new Date('2026-03-20T12:00:00.000Z')));
    const secret = 'super-secret-token-do-not-log';
    const provider: DecisionProvider = {
      kind: 'boom',
      async decide(): Promise<DecisionSignal> {
        throw new Error(`provider exploded with ${secret}\nSTACK_LINE_1\nSTACK_LINE_2`);
      },
    };

    let thrown: unknown;
    let outcome: Awaited<ReturnType<typeof runDecisionShadow>> | undefined;
    try {
      outcome = await runDecisionShadow({
        provider,
        activity,
        stateInput: baseStateInput(),
        workItemIds: ['w-1', 'w-2'],
      });
    } catch (err) {
      thrown = err;
    }

    assert.equal(thrown, undefined);
    assert.deepEqual(outcome, { recorded: true, quality: 'provider_error' });

    const events = await activity.list('m-1');
    assert.equal(events.length, 1);
    const data = events[0]!.data as DecisionShadowEventData;
    assert.equal(data.quality, 'provider_error');
    assert.equal(data.providerKind, 'boom');
    assert.equal(data.hook, 'PRE_DISPATCH');
    assert.equal(data.schemaVersion, DECISION_STATE_SCHEMA_VERSION);
    assert.deepEqual(data.ids.workItemIds, ['w-1', 'w-2']);
    assert.equal('signal' in data, false);

    const raw = JSON.stringify(events[0]);
    assert.equal(raw.includes(secret), false);
    assert.equal(raw.includes('STACK_LINE'), false);
    assert.equal(raw.includes('provider exploded'), false);
  });

  test('provider reject：同样吞没为 provider_error', async () => {
    const activity = new InMemoryActivityLog(new FixedClock(new Date('2026-03-20T12:00:00.000Z')));
    const provider: DecisionProvider = {
      kind: 'reject',
      decide(_request: DecisionRequest): Promise<DecisionSignal> {
        return Promise.reject(new Error('async fail'));
      },
    };

    const outcome = await runDecisionShadow({
      provider,
      activity,
      stateInput: baseStateInput(),
      workItemIds: [],
    });
    assert.deepEqual(outcome, { recorded: true, quality: 'provider_error' });
    const data = (await activity.list('m-1'))[0]!.data as DecisionShadowEventData;
    assert.equal(data.quality, 'provider_error');
    assert.equal('signal' in data, false);
  });

  test('activity.append throw：不向调用方抛；返回 audit 未写入 outcome；不另写持久化', async () => {
    const events: ActivityEvent[] = [];
    const activity: ActivityLog = {
      async append(): Promise<void> {
        throw new Error('disk full');
      },
      async list(): Promise<readonly ActivityEvent[]> {
        return events;
      },
    };

    let thrown: unknown;
    let outcome: Awaited<ReturnType<typeof runDecisionShadow>> | undefined;
    try {
      outcome = await runDecisionShadow({
        provider: new NoopDecisionProvider(),
        activity,
        stateInput: baseStateInput(),
        workItemIds: ['w-1'],
      });
    } catch (err) {
      thrown = err;
    }

    assert.equal(thrown, undefined);
    assert.deepEqual(outcome, {
      recorded: false,
      quality: 'success',
      reason: 'activity_append_failed',
    });
    assert.equal(events.length, 0);
  });

  test('provider 失败且 activity.append 也失败：仍不抛；quality 保留 provider_error', async () => {
    const activity: ActivityLog = {
      async append(): Promise<void> {
        throw new Error('log down');
      },
      async list(): Promise<readonly ActivityEvent[]> {
        return [];
      },
    };
    const provider: DecisionProvider = {
      kind: 'boom',
      async decide(): Promise<DecisionSignal> {
        throw new Error('nope');
      },
    };

    const outcome = await runDecisionShadow({
      provider,
      activity,
      stateInput: baseStateInput(),
      workItemIds: [],
    });
    assert.deepEqual(outcome, {
      recorded: false,
      quality: 'provider_error',
      reason: 'activity_append_failed',
    });
  });
});

describe('runDecisionShadow — 请求形状与边界', () => {
  test('audit workItemIds 是副本：调用方事后改动不影响已写入 data', async () => {
    const activity = new InMemoryActivityLog(new FixedClock(new Date('2026-03-20T12:00:00.000Z')));
    const workItemIds = ['w-1', 'w-2'];
    await runDecisionShadow({
      provider: new NoopDecisionProvider(),
      activity,
      stateInput: baseStateInput(),
      workItemIds,
    });
    workItemIds.push('w-mutated');
    const data = (await activity.list('m-1'))[0]!.data as DecisionShadowEventData;
    assert.deepEqual(data.ids.workItemIds, ['w-1', 'w-2']);
  });

  test('N>1：state 无 workItemId 时 request 也不带；ids.workItemIds 仍完整', async () => {
    const sink: { request?: DecisionRequest } = {};
    const activity = new InMemoryActivityLog(new FixedClock(new Date('2026-03-20T12:00:00.000Z')));
    await runDecisionShadow({
      provider: capturingProvider({ kind: 'noop' }, sink),
      activity,
      stateInput: baseStateInput(),
      workItemIds: ['w-1', 'w-2', 'w-3'],
    });
    assert.equal('workItemId' in sink.request!, false);
    const data = (await activity.list('m-1'))[0]!.data as DecisionShadowEventData;
    assert.deepEqual(data.ids.workItemIds, ['w-1', 'w-2', 'w-3']);
    assert.equal('workItemId' in data.ids, false);
  });
});

describe('HOPT-04-A shadow runner 源码边界', () => {
  test('runner 只依赖 StateBuilder 与 ports；不拉领域实体 / 仓储 / platform', () => {
    const path = join(root, 'src', 'application', 'decision-shadow-runner.ts');
    const source = readFileSync(path, 'utf8');
    const fromSpecs = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    assert.deepEqual(fromSpecs.sort(), [
      './decision-state-builder.ts',
      './ports.ts',
    ]);
    for (const spec of fromSpecs) {
      assert.doesNotMatch(spec, /kernel/i);
      assert.doesNotMatch(spec, /platform/i);
      assert.doesNotMatch(spec, /(mission|work-item|attempt)\.ts$/i);
    }
    const importClauses = [...source.matchAll(/^\s*import\b[^;]*;/gm)].map((m) => m[0]!);
    for (const clause of importClauses) {
      assert.doesNotMatch(clause, /ProjectRepository/);
      assert.doesNotMatch(clause, /\bMission\b/);
      assert.doesNotMatch(clause, /\bWorkItem\b/);
      assert.doesNotMatch(clause, /\bAttempt\b/);
      assert.doesNotMatch(clause, /DecisionRecord|QuestionRegistry|\bJev\b/);
    }
  });

  test('除 platform.ts 外其它生产路径仍不接线 shadow runner', () => {
    // HOPT-04-B：platform.dispatchWorkItems 是唯一允许的生产接线。
    const allowed = new Set([
      'src/application/decision-shadow-runner.ts',
      'src/application/platform.ts',
    ]);
    for (const file of walkTs(join(root, 'src'))) {
      const rel = relPosix(file);
      if (allowed.has(rel)) continue;
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(
        source,
        /runDecisionShadow|decision-shadow-runner|DECISION_SHADOW_EVENT_KIND/,
        `${rel}: 不得接线 shadow runner（唯一允许：platform.ts）`,
      );
    }
  });
});
