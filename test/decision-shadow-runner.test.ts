/**
 * PRE_DISPATCH shadow runner：只审计、不写 kernel、失败不传播。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
import { PRE_DISPATCH_V1 } from '../src/application/decision-question-registry.ts';
import { FixedClock, InMemoryActivityLog } from '../src/application/in-memory.ts';
import { NoopDecisionProvider } from '../src/application/noop-decision-provider.ts';
import type {
  ActivityEvent,
  ActivityLog,
  Clock,
  DecisionAnswerSet,
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

function defaultClock(): FixedClock {
  return new FixedClock(new Date('2026-03-20T12:00:00.000Z'));
}

/** 每次 now() 弹出队列中下一个时间点（脚本化 latency）。 */
function scriptedClock(times: readonly Date[]): Clock {
  let i = 0;
  return {
    now(): Date {
      const t = times[Math.min(i, times.length - 1)]!;
      i += 1;
      return t;
    },
  };
}

function capturingProvider(
  answers: Readonly<Record<string, DecisionSignal>>,
  sink: { request?: DecisionRequest },
  meta?: DecisionAnswerSet['meta'],
): DecisionProvider {
  return {
    kind: 'capture',
    async decide(request: DecisionRequest): Promise<DecisionAnswerSet> {
      sink.request = request;
      return meta !== undefined ? { answers, meta } : { answers };
    },
  };
}

function assertShadowCommon(data: DecisionShadowEventData, workItemIds: readonly string[]) {
  assert.equal(data.mode, 'shadow');
  assert.equal(data.questionSetId, PRE_DISPATCH_V1.id);
  assert.equal(typeof data.latencyMs, 'number');
  assert.ok(Number.isFinite(data.latencyMs));
  assert.ok(data.latencyMs >= 0);
  assert.deepEqual(data.baselineAction, { kind: 'dispatch', workItemIds: [...workItemIds] });
  assert.deepEqual(data.effectiveAction, data.baselineAction);
  assert.equal('hypotheticalAction' in data, false);
  assert.deepEqual(data.baselineAction, data.effectiveAction);
}

describe('runDecisionShadow — 成功路径', () => {
  test('noop provider 空包：append decision.shadow，data 含必填字段与 answers:{}', async () => {
    const clock = defaultClock();
    const activity = new InMemoryActivityLog(clock);
    const sink: { request?: DecisionRequest } = {};
    const provider = capturingProvider({}, sink);

    const outcome = await runDecisionShadow({
      provider,
      activity,
      clock,
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
    assert.ok(data.quality === 'success' && 'answers' in data);
    assert.deepEqual(data.answers, {});
    assert.equal('signal' in data, false);
    assertShadowCommon(data, ['w-a', 'w-b']);
    assert.equal('resolvedModel' in data, false);
    assert.equal('usage' in data, false);
  });

  test('choice：命名 answers 原样写入 data', async () => {
    const clock = defaultClock();
    const activity = new InMemoryActivityLog(clock);
    const answers: Readonly<Record<string, DecisionSignal>> = {
      'q.route': { kind: 'choice', option: 'prefer-a' },
    };
    const sink: { request?: DecisionRequest } = {};

    const outcome = await runDecisionShadow({
      provider: capturingProvider(answers, sink),
      activity,
      clock,
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
    assert.deepEqual(data.answers, answers);
    assert.deepEqual(data.ids.workItemIds, ['w-1']);
    assert.equal(data.ids.workItemId, 'w-1');
    assertShadowCommon(data, ['w-1']);
  });

  test('score：命名 answers 原样写入 data', async () => {
    const clock = defaultClock();
    const activity = new InMemoryActivityLog(clock);
    const answers: Readonly<Record<string, DecisionSignal>> = {
      'q.score': { kind: 'score', value: 0.75, scale: 'unit' },
    };

    const outcome = await runDecisionShadow({
      provider: {
        kind: 'scorer',
        async decide(): Promise<DecisionAnswerSet> {
          return { answers };
        },
      },
      activity,
      clock,
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
    assert.deepEqual(data.answers, answers);
    assert.equal(data.ids.attemptId, 'a-1');
    assert.deepEqual(data.ids.workItemIds, []);
    assertShadowCommon(data, []);
  });

  test('多命名 answers：一次 decide 保留多个 question id', async () => {
    const clock = defaultClock();
    const activity = new InMemoryActivityLog(clock);
    const answers: Readonly<Record<string, DecisionSignal>> = {
      'q.route': { kind: 'choice', option: 'a' },
      'q.confidence': { kind: 'score', value: 0.4 },
      'q.hold': { kind: 'noop' },
    };

    const outcome = await runDecisionShadow({
      provider: capturingProvider(answers, {}),
      activity,
      clock,
      stateInput: baseStateInput(),
      workItemIds: ['w-1'],
    });
    assert.deepEqual(outcome, { recorded: true, quality: 'success' });
    const data = (await activity.list('m-1'))[0]!.data as DecisionShadowEventData;
    assert.ok(data.quality === 'success');
    assert.deepEqual(data.answers, answers);
  });

  test('NoopDecisionProvider 集成：quality=success 且 answers={}', async () => {
    const clock = defaultClock();
    const activity = new InMemoryActivityLog(clock);
    const outcome = await runDecisionShadow({
      provider: new NoopDecisionProvider(),
      activity,
      clock,
      stateInput: baseStateInput(),
      workItemIds: ['w-x'],
    });
    assert.deepEqual(outcome, { recorded: true, quality: 'success' });
    const data = (await activity.list('m-1'))[0]!.data as DecisionShadowEventData;
    assert.equal(data.providerKind, 'noop');
    assert.ok(data.quality === 'success');
    assert.deepEqual(data.answers, {});
  });
});

describe('runDecisionShadow — telemetry (HOPT-09-B)', () => {
  test('scripted clock success：latencyMs=37；meta model/usage 进入 event', async () => {
    const t0 = new Date('2026-03-20T12:00:00.100Z');
    const t1 = new Date('2026-03-20T12:00:00.137Z');
    const clock = scriptedClock([t0, t1]);
    const activity = new InMemoryActivityLog(new FixedClock(t0));
    const usage = { inputTokens: 11, outputTokens: 7 };

    const outcome = await runDecisionShadow({
      provider: {
        kind: 'meta-ok',
        async decide(): Promise<DecisionAnswerSet> {
          return {
            answers: { q: { kind: 'noop' } },
            meta: { resolvedModel: 'model-x', usage },
          };
        },
      },
      activity,
      clock,
      stateInput: baseStateInput(),
      workItemIds: ['w-1'],
    });

    assert.deepEqual(outcome, { recorded: true, quality: 'success' });
    const data = (await activity.list('m-1'))[0]!.data as DecisionShadowEventData;
    assert.equal(data.quality, 'success');
    assert.equal(data.latencyMs, 37);
    assert.ok(data.quality === 'success');
    assert.equal(data.resolvedModel, 'model-x');
    assert.deepEqual(data.usage, usage);
    assertShadowCommon(data, ['w-1']);
  });

  test('provider throw：latencyMs=45；provider_error 无 answers/model/usage/error', async () => {
    const t0 = new Date('2026-03-20T12:00:00.200Z');
    const t1 = new Date('2026-03-20T12:00:00.245Z');
    const clock = scriptedClock([t0, t1]);
    const activity = new InMemoryActivityLog(new FixedClock(t0));
    const secret = 'super-secret-token-do-not-log';

    const outcome = await runDecisionShadow({
      provider: {
        kind: 'boom',
        async decide(): Promise<DecisionAnswerSet> {
          throw new Error(`provider exploded with ${secret}`);
        },
      },
      activity,
      clock,
      stateInput: baseStateInput(),
      workItemIds: ['w-9'],
    });

    assert.deepEqual(outcome, { recorded: true, quality: 'provider_error' });
    const data = (await activity.list('m-1'))[0]!.data as DecisionShadowEventData;
    assert.equal(data.quality, 'provider_error');
    assert.equal(data.latencyMs, 45);
    assert.equal('answers' in data, false);
    assert.equal('resolvedModel' in data, false);
    assert.equal('usage' in data, false);
    assert.equal('error' in data, false);
    assertShadowCommon(data, ['w-9']);
    const raw = JSON.stringify(data);
    assert.equal(raw.includes(secret), false);
  });

  test('clock 负差钳 0', async () => {
    const t0 = new Date('2026-03-20T12:00:00.300Z');
    const t1 = new Date('2026-03-20T12:00:00.250Z');
    const clock = scriptedClock([t0, t1]);
    const activity = new InMemoryActivityLog(new FixedClock(t0));

    await runDecisionShadow({
      provider: new NoopDecisionProvider(),
      activity,
      clock,
      stateInput: baseStateInput(),
      workItemIds: [],
    });

    const data = (await activity.list('m-1'))[0]!.data as DecisionShadowEventData;
    assert.equal(data.latencyMs, 0);
  });

  test('小数毫秒 round：10.4→10、10.6→11', async () => {
    // Date 只能存整数 ms；用 getTime 差值模拟 round 规则可达路径
    const base = Date.parse('2026-03-20T12:00:00.000Z');
    {
      const clock = scriptedClock([new Date(base), new Date(base + 10.4)]);
      // Date constructor truncates sub-ms; force via Object with getTime
      const clockFrac: Clock = {
        now(): Date {
          return clock.now();
        },
      };
      // Use custom clock returning Dates whose getTime is fractional via override
      let n = 0;
      const fracClock: Clock = {
        now(): Date {
          const ms = n === 0 ? base : base + 10.4;
          n += 1;
          return {
            getTime() {
              return ms;
            },
          } as Date;
        },
      };
      const activity = new InMemoryActivityLog(new FixedClock(new Date(base)));
      await runDecisionShadow({
        provider: new NoopDecisionProvider(),
        activity,
        clock: fracClock,
        stateInput: baseStateInput(),
        workItemIds: [],
      });
      const data = (await activity.list('m-1'))[0]!.data as DecisionShadowEventData;
      assert.equal(data.latencyMs, Math.round(10.4));
      void clockFrac;
    }
    {
      let n = 0;
      const fracClock: Clock = {
        now(): Date {
          const ms = n === 0 ? base : base + 10.6;
          n += 1;
          return {
            getTime() {
              return ms;
            },
          } as Date;
        },
      };
      const activity = new InMemoryActivityLog(new FixedClock(new Date(base)));
      await runDecisionShadow({
        provider: new NoopDecisionProvider(),
        activity,
        clock: fracClock,
        stateInput: baseStateInput(),
        workItemIds: [],
      });
      const data = (await activity.list('m-1'))[0]!.data as DecisionShadowEventData;
      assert.equal(data.latencyMs, Math.round(10.6));
    }
  });

  test('调用后 mutate workItemIds：ids 与 action 不变；baseline/effective frozen deepEqual', async () => {
    const clock = defaultClock();
    const activity = new InMemoryActivityLog(clock);
    const workItemIds = ['w-1', 'w-2'];
    await runDecisionShadow({
      provider: new NoopDecisionProvider(),
      activity,
      clock,
      stateInput: baseStateInput(),
      workItemIds,
    });
    workItemIds.push('w-mutated');
    const data = (await activity.list('m-1'))[0]!.data as DecisionShadowEventData;
    assert.deepEqual(data.ids.workItemIds, ['w-1', 'w-2']);
    assert.deepEqual(data.baselineAction.workItemIds, ['w-1', 'w-2']);
    assert.deepEqual(data.effectiveAction.workItemIds, ['w-1', 'w-2']);
    assert.deepEqual(data.baselineAction, data.effectiveAction);
    assert.throws(() => {
      (data.baselineAction as { kind: string }).kind = 'x';
    });
    assert.throws(() => {
      (data.baselineAction.workItemIds as string[]).push('x');
    });
    assert.throws(() => {
      (data.effectiveAction.workItemIds as string[]).push('x');
    });
  });

  test('provider 无 meta：省略 resolvedModel/usage keys', async () => {
    const clock = defaultClock();
    const activity = new InMemoryActivityLog(clock);
    await runDecisionShadow({
      provider: capturingProvider({}, {}),
      activity,
      clock,
      stateInput: baseStateInput(),
      workItemIds: ['w-1'],
    });
    const data = (await activity.list('m-1'))[0]!.data as DecisionShadowEventData;
    assert.ok(data.quality === 'success');
    assert.equal('resolvedModel' in data, false);
    assert.equal('usage' in data, false);
  });

  test('append fail：recorded=false；quality 仍 success', async () => {
    const clock = defaultClock();
    const activity: ActivityLog = {
      async append(): Promise<void> {
        throw new Error('disk full');
      },
      async list(): Promise<readonly ActivityEvent[]> {
        return [];
      },
    };
    const outcome = await runDecisionShadow({
      provider: new NoopDecisionProvider(),
      activity,
      clock,
      stateInput: baseStateInput(),
      workItemIds: ['w-1'],
    });
    assert.deepEqual(outcome, {
      recorded: false,
      quality: 'success',
      reason: 'activity_append_failed',
    });
  });
});

describe('runDecisionShadow — 失败吞没', () => {
  test('provider throw：不向调用方抛；append quality=provider_error；无 answers / 无堆栈', async () => {
    const clock = defaultClock();
    const activity = new InMemoryActivityLog(clock);
    const secret = 'super-secret-token-do-not-log';
    const provider: DecisionProvider = {
      kind: 'boom',
      async decide(): Promise<DecisionAnswerSet> {
        throw new Error(`provider exploded with ${secret}\nSTACK_LINE_1\nSTACK_LINE_2`);
      },
    };

    let thrown: unknown;
    let outcome: Awaited<ReturnType<typeof runDecisionShadow>> | undefined;
    try {
      outcome = await runDecisionShadow({
        provider,
        activity,
        clock,
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
    assert.equal('answers' in data, false);
    assert.equal('signal' in data, false);
    assert.equal('error' in data, false);
    assert.equal(typeof data.latencyMs, 'number');

    const raw = JSON.stringify(events[0]);
    assert.equal(raw.includes(secret), false);
    assert.equal(raw.includes('STACK_LINE'), false);
    assert.equal(raw.includes('provider exploded'), false);
  });

  test('provider reject：同样吞没为 provider_error', async () => {
    const clock = defaultClock();
    const activity = new InMemoryActivityLog(clock);
    const provider: DecisionProvider = {
      kind: 'reject',
      decide(_request: DecisionRequest): Promise<DecisionAnswerSet> {
        return Promise.reject(new Error('async fail'));
      },
    };

    const outcome = await runDecisionShadow({
      provider,
      activity,
      clock,
      stateInput: baseStateInput(),
      workItemIds: [],
    });
    assert.deepEqual(outcome, { recorded: true, quality: 'provider_error' });
    const data = (await activity.list('m-1'))[0]!.data as DecisionShadowEventData;
    assert.equal(data.quality, 'provider_error');
    assert.equal('answers' in data, false);
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
        clock: defaultClock(),
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
      async decide(): Promise<DecisionAnswerSet> {
        throw new Error('nope');
      },
    };

    const outcome = await runDecisionShadow({
      provider,
      activity,
      clock: defaultClock(),
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
    const clock = defaultClock();
    const activity = new InMemoryActivityLog(clock);
    const workItemIds = ['w-1', 'w-2'];
    await runDecisionShadow({
      provider: new NoopDecisionProvider(),
      activity,
      clock,
      stateInput: baseStateInput(),
      workItemIds,
    });
    workItemIds.push('w-mutated');
    const data = (await activity.list('m-1'))[0]!.data as DecisionShadowEventData;
    assert.deepEqual(data.ids.workItemIds, ['w-1', 'w-2']);
  });

  test('N>1：state 无 workItemId 时 request 也不带；ids.workItemIds 仍完整', async () => {
    const sink: { request?: DecisionRequest } = {};
    const clock = defaultClock();
    const activity = new InMemoryActivityLog(clock);
    await runDecisionShadow({
      provider: capturingProvider({}, sink),
      activity,
      clock,
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
  test('runner 只依赖 StateBuilder / registry 与 ports；不拉领域实体 / 仓储 / platform', () => {
    const path = join(root, 'src', 'application', 'decision-shadow-runner.ts');
    const source = readFileSync(path, 'utf8');
    const fromSpecs = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    assert.deepEqual(fromSpecs.sort(), [
      './decision-question-registry.ts',
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
      assert.doesNotMatch(clause, /DecisionRecord|\bJev\b/);
    }
  });

  test('除 platform 入口与 platform/ 模块外其它生产路径仍不接线 shadow runner', () => {
    // HOPT-04-B：platform 边界（入口 platform.ts + platform/ 下模块）是唯一允许的生产接线。
    const allowed = new Set<string>([
      'src/application/decision-shadow-runner.ts',
      'src/application/platform.ts',
    ]);
    const platformDir = join(root, 'src', 'application', 'platform');
    if (existsSync(platformDir)) {
      for (const f of walkTs(platformDir)) allowed.add(relPosix(f));
    }
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
