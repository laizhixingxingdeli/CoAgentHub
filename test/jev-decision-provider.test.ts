/**
 * JevDecisionProvider：System One wire 映射 + shadow 集成 + 源码边界。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  JevDecisionProvider,
  type JevSystemOneRequest,
  type JevSystemOneResponse,
  type JevSystemOneTransport,
} from '../src/application/jev-decision-provider.ts';
import {
  CANDIDATE_EXECUTOR_FACT_KEY,
  PREFERRED_EXECUTOR_NONE_OPTION,
  PRE_DISPATCH_V1,
  TASK_TYPE_OPTIONS,
} from '../src/application/decision-question-registry.ts';
import { DECISION_STATE_SCHEMA_VERSION } from '../src/application/decision-state-builder.ts';
import { runDecisionShadow } from '../src/application/decision-shadow-runner.ts';
import type { ActivityEvent, ActivityLog, DecisionRequest } from '../src/application/ports.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

const RISK_CRITERIA = PRE_DISPATCH_V1.questions
  .find((q) => q.id === 'semantic_risk')!
  .orderedLevels.map((l) => `${l.label}: ${l.rubric}`);

function baseRequest(
  facts?: DecisionRequest['facts'],
): DecisionRequest {
  return {
    hook: 'PRE_DISPATCH',
    projectId: 'p-1',
    missionId: 'm-1',
    workItemId: 'w-1',
    ...(facts !== undefined ? { facts } : {}),
  };
}

function riskLegend(
  criteria: readonly string[] = RISK_CRITERIA,
): Record<string, string> {
  return {
    '0': criteria[0]!,
    '1': criteria[1]!,
    '2': criteria[2]!,
    '3': criteria[3]!,
  };
}

function validAnswers(overrides?: Partial<JevSystemOneResponse['answers']>): JevSystemOneResponse {
  return {
    model: 'jev-latest',
    answers: {
      task_type: {
        type: 'choice',
        choice: 'bugfix',
        confidence: 0.9,
        probabilities: { bugfix: 0.9 },
      },
      semantic_risk: {
        type: 'score',
        score: 1.6,
        confidence: 0.8,
        probabilities: { '0': 0.1, '1': 0.5, '2': 0.3, '3': 0.1 },
        legend: riskLegend(),
      },
      work_order_ambiguous: { type: 'noul', noul: 0.25 },
      preferred_executor: {
        type: 'choice',
        choice: PREFERRED_EXECUTOR_NONE_OPTION,
        confidence: 0.7,
        probabilities: { [PREFERRED_EXECUTOR_NONE_OPTION]: 0.7 },
      },
      ...overrides,
    },
    usage: { input_tokens: 1, output_tokens: 2 },
  };
}

class CaptureTransport implements JevSystemOneTransport {
  lastRequest: JevSystemOneRequest | undefined;
  response: JevSystemOneResponse | (() => Promise<JevSystemOneResponse>) = validAnswers();
  rejectWith: Error | undefined;

  async systemOne(request: JevSystemOneRequest): Promise<JevSystemOneResponse> {
    this.lastRequest = request;
    if (this.rejectWith) throw this.rejectWith;
    if (typeof this.response === 'function') return this.response();
    return this.response;
  }
}

describe('JevDecisionProvider wire request', () => {
  test('kind / default model / state.schemaVersion / 四 question type+criteria', async () => {
    const transport = new CaptureTransport();
    const provider = new JevDecisionProvider({ transport });
    assert.equal(provider.kind, 'jev-system-one');

    await provider.decide(baseRequest());

    const req = transport.lastRequest!;
    assert.equal(req.model, 'jev-latest');
    assert.equal(req.state.schemaVersion, DECISION_STATE_SCHEMA_VERSION);
    assert.equal(req.state.hook, 'PRE_DISPATCH');
    assert.equal(req.state.projectId, 'p-1');
    assert.equal(req.state.missionId, 'm-1');

    assert.equal(req.questions.task_type.type, 'choice');
    assert.deepEqual(
      Object.keys(req.questions.task_type.criteria),
      [...TASK_TYPE_OPTIONS],
    );
    for (const v of Object.values(req.questions.task_type.criteria)) {
      assert.equal(v, null);
    }

    assert.equal(req.questions.semantic_risk.type, 'score');
    assert.deepEqual(req.questions.semantic_risk.criteria, RISK_CRITERIA);

    assert.equal(req.questions.work_order_ambiguous.type, 'noul');
    assert.equal(
      req.questions.work_order_ambiguous.instructions,
      PRE_DISPATCH_V1.questions.find((q) => q.id === 'work_order_ambiguous')!.purpose,
    );

    assert.equal(req.questions.preferred_executor.type, 'choice');
    assert.deepEqual(Object.keys(req.questions.preferred_executor.criteria), [
      PREFERRED_EXECUTOR_NONE_OPTION,
    ]);
  });

  test('model 可注入覆盖', async () => {
    const transport = new CaptureTransport();
    const provider = new JevDecisionProvider({ transport, model: 'jev-custom' });
    await provider.decide(baseRequest());
    assert.equal(transport.lastRequest!.model, 'jev-custom');
  });

  test('候选 trim + 首次去重 + none；空白与字面 none 丢弃；wire facts 仅 sanitized candidate', async () => {
    const transport = new CaptureTransport();
    const provider = new JevDecisionProvider({ transport });
    const facts = [
      { key: CANDIDATE_EXECUTOR_FACT_KEY, value: '  exec-a  ' },
      { key: 'opaque_key', value: 'opaque-leak-value' },
      { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'exec-b' },
      { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'exec-a' },
      { key: CANDIDATE_EXECUTOR_FACT_KEY, value: '   ' },
      { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'none' },
      { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'exec-b' },
    ];
    await provider.decide(baseRequest(facts));

    assert.deepEqual(Object.keys(transport.lastRequest!.questions.preferred_executor.criteria), [
      'exec-a',
      'exec-b',
      PREFERRED_EXECUTOR_NONE_OPTION,
    ]);
    // remote default-deny: only trimmed candidate_executor_id on wire state
    assert.deepEqual(transport.lastRequest!.state.facts, [
      { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'exec-a' },
      { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'exec-b' },
      { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'exec-a' },
      { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'exec-b' },
    ]);
    const wireJson = JSON.stringify(transport.lastRequest);
    assert.equal(wireJson.includes('opaque_key'), false);
    assert.equal(wireJson.includes('opaque-leak-value'), false);
  });

  test('无候选时 preferred_executor 仅 none；unknown facts 不进 wire', async () => {
    const transport = new CaptureTransport();
    const provider = new JevDecisionProvider({ transport });
    await provider.decide(baseRequest([{ key: 'k', value: 'v-secret-leak' }]));
    assert.deepEqual(Object.keys(transport.lastRequest!.questions.preferred_executor.criteria), [
      PREFERRED_EXECUTOR_NONE_OPTION,
    ]);
    assert.deepEqual(transport.lastRequest!.state.facts, []);
    const wireJson = JSON.stringify(transport.lastRequest);
    assert.equal(wireJson.includes('v-secret-leak'), false);
    assert.equal(wireJson.includes('"k"'), false);
  });

  test('secret-like raw candidate 不进 wire state 也不进 preferred criteria', async () => {
    const transport = new CaptureTransport();
    const provider = new JevDecisionProvider({ transport });
    const leak = 'Bearer tok-xyz';
    await provider.decide(
      baseRequest([
        { key: CANDIDATE_EXECUTOR_FACT_KEY, value: leak },
        { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'safe-exec' },
        { key: 'note', value: 'api_key=should-not-leak' },
      ]),
    );
    assert.deepEqual(Object.keys(transport.lastRequest!.questions.preferred_executor.criteria), [
      'safe-exec',
      PREFERRED_EXECUTOR_NONE_OPTION,
    ]);
    assert.deepEqual(transport.lastRequest!.state.facts, [
      { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'safe-exec' },
    ]);
    const wireJson = JSON.stringify(transport.lastRequest);
    assert.equal(wireJson.includes(leak), false);
    assert.equal(wireJson.includes('Bearer'), false);
    assert.equal(wireJson.includes('api_key=should-not-leak'), false);
  });

  test('非 PRE_DISPATCH hook throw', async () => {
    const provider = new JevDecisionProvider({ transport: new CaptureTransport() });
    await assert.rejects(
      () =>
        provider.decide({
          hook: 'POST_EXECUTION',
          projectId: 'p',
          missionId: 'm',
        }),
      /unsupported hook/,
    );
  });
});

describe('JevDecisionProvider response mapping', () => {
  test('valid response → 四 named answers；risk 原样 + ordinal4.v1；noul 映射', async () => {
    const transport = new CaptureTransport();
    transport.response = validAnswers({
      preferred_executor: {
        type: 'choice',
        choice: 'exec-a',
        confidence: 0.85,
        probabilities: { 'exec-a': 0.85, [PREFERRED_EXECUTOR_NONE_OPTION]: 0.15 },
      },
    });
    const provider = new JevDecisionProvider({ transport });
    const result = await provider.decide(
      baseRequest([{ key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'exec-a' }]),
    );

    assert.deepEqual(result.answers, {
      task_type: { kind: 'choice', option: 'bugfix' },
      preferred_executor: { kind: 'choice', option: 'exec-a' },
      work_order_ambiguous: { kind: 'score', value: 0.25, scale: 'noul' },
      semantic_risk: { kind: 'score', value: 1.6, scale: 'ordinal4.v1' },
    });
    assert.equal(Object.keys(result.answers).length, 4);
    // wire response.model / usage → meta；confidence 等不进 answers/meta
    assert.deepEqual(result.meta, {
      resolvedModel: 'jev-latest',
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    assert.equal('usage' in result, false);
    assert.equal('model' in result, false);
    assert.equal('confidence' in (result.meta ?? {}), false);
  });

  test('meta.resolvedModel 来自 wire response.model，非请求 model', async () => {
    const transport = new CaptureTransport();
    transport.response = { ...validAnswers(), model: 'wire-resolved-v2' };
    const provider = new JevDecisionProvider({ transport, model: 'request-guess' });
    const result = await provider.decide(baseRequest());
    assert.equal(transport.lastRequest!.model, 'request-guess');
    assert.equal(result.meta?.resolvedModel, 'wire-resolved-v2');
  });
});

describe('JevDecisionProvider invalid matrix', () => {
  async function expectThrow(
    response: JevSystemOneResponse | (() => Promise<JevSystemOneResponse>),
    facts?: DecisionRequest['facts'],
  ): Promise<void> {
    const transport = new CaptureTransport();
    transport.response = response;
    const provider = new JevDecisionProvider({ transport });
    await assert.rejects(() => provider.decide(baseRequest(facts)));
  }

  test('missing answer key', async () => {
    const r = validAnswers();
    const { preferred_executor: _, ...rest } = r.answers;
    await expectThrow({
      ...r,
      answers: rest as JevSystemOneResponse['answers'],
    });
  });

  test('extra answer key', async () => {
    const r = validAnswers();
    await expectThrow({
      ...r,
      answers: {
        ...r.answers,
        bonus: { type: 'choice', choice: 'x' },
      } as JevSystemOneResponse['answers'],
    });
  });

  test('bad type task_type', async () => {
    await expectThrow(
      validAnswers({
        task_type: { type: 'noul', noul: 0.5 } as JevSystemOneResponse['answers']['task_type'],
      }),
    );
  });

  test('bad choice task_type', async () => {
    await expectThrow(
      validAnswers({
        task_type: {
          type: 'choice',
          choice: 'not-a-type',
          confidence: 0.5,
          probabilities: { 'not-a-type': 0.5 },
        },
      }),
    );
  });

  test('bad choice preferred_executor', async () => {
    await expectThrow(
      validAnswers({
        preferred_executor: {
          type: 'choice',
          choice: 'ghost',
          confidence: 0.5,
          probabilities: { ghost: 0.5 },
        },
      }),
    );
  });

  test('noul below 0', async () => {
    await expectThrow(
      validAnswers({
        work_order_ambiguous: { type: 'noul', noul: -0.01 },
      }),
    );
  });

  test('noul above 1', async () => {
    await expectThrow(
      validAnswers({
        work_order_ambiguous: { type: 'noul', noul: 1.01 },
      }),
    );
  });

  test('noul non-finite', async () => {
    await expectThrow(
      validAnswers({
        work_order_ambiguous: { type: 'noul', noul: Number.NaN },
      }),
    );
  });

  test('risk below 0', async () => {
    await expectThrow(
      validAnswers({
        semantic_risk: {
          type: 'score',
          score: -0.1,
          confidence: 0.8,
          probabilities: {},
          legend: riskLegend(),
        },
      }),
    );
  });

  test('risk above 3', async () => {
    await expectThrow(
      validAnswers({
        semantic_risk: {
          type: 'score',
          score: 3.1,
          confidence: 0.8,
          probabilities: {},
          legend: riskLegend(),
        },
      }),
    );
  });

  test('legend value mismatch', async () => {
    const bad = riskLegend();
    bad['0'] = 'WRONG';
    await expectThrow(
      validAnswers({
        semantic_risk: {
          type: 'score',
          score: 1,
          confidence: 0.8,
          probabilities: {},
          legend: bad,
        },
      }),
    );
  });

  test('legend missing key', async () => {
    const bad = riskLegend();
    delete bad['2'];
    await expectThrow(
      validAnswers({
        semantic_risk: {
          type: 'score',
          score: 1,
          confidence: 0.8,
          probabilities: {},
          legend: bad,
        },
      }),
    );
  });

  test('legend extra key', async () => {
    const bad = { ...riskLegend(), '4': 'EXTRA' };
    await expectThrow(
      validAnswers({
        semantic_risk: {
          type: 'score',
          score: 1,
          confidence: 0.8,
          probabilities: {},
          legend: bad,
        },
      }),
    );
  });

  test('transport reject', async () => {
    const transport = new CaptureTransport();
    transport.rejectWith = new Error('upstream down');
    const provider = new JevDecisionProvider({ transport });
    await assert.rejects(() => provider.decide(baseRequest()), /transport rejected/);
  });

  test('empty model', async () => {
    await expectThrow({ ...validAnswers(), model: '' });
  });

  test('whitespace-only model', async () => {
    await expectThrow({ ...validAnswers(), model: '   ' });
  });

  test('usage input_tokens NaN', async () => {
    await expectThrow({
      ...validAnswers(),
      usage: { input_tokens: Number.NaN, output_tokens: 1 },
    });
  });

  test('usage output_tokens Infinity', async () => {
    await expectThrow({
      ...validAnswers(),
      usage: { input_tokens: 1, output_tokens: Number.POSITIVE_INFINITY },
    });
  });

  test('usage negative tokens', async () => {
    await expectThrow({
      ...validAnswers(),
      usage: { input_tokens: -1, output_tokens: 2 },
    });
  });

  test('missing usage field', async () => {
    const r = validAnswers();
    const { usage: _u, ...rest } = r;
    await expectThrow(rest as JevSystemOneResponse);
  });
});

describe('JevDecisionProvider + runDecisionShadow', () => {
  function memoryLog(): ActivityLog & { events: ActivityEvent[] } {
    const events: ActivityEvent[] = [];
    return {
      events,
      async append(event) {
        events.push({ ...event, at: 't0' } as ActivityEvent);
      },
      async list() {
        return events;
      },
    };
  }

  test('valid → success data.answers', async () => {
    const transport = new CaptureTransport();
    const provider = new JevDecisionProvider({ transport });
    const activity = memoryLog();
    const outcome = await runDecisionShadow({
      provider,
      activity,
      clock: { now: () => new Date('2026-03-20T12:00:00.000Z') },
      stateInput: {
        hook: 'PRE_DISPATCH',
        projectId: 'p-1',
        missionId: 'm-1',
      },
      workItemIds: ['w-1'],
    });
    assert.equal(outcome.recorded, true);
    assert.equal(outcome.quality, 'success');
    const data = activity.events[0]!.data as {
      quality: string;
      answers: Record<string, unknown>;
    };
    assert.equal(data.quality, 'success');
    assert.ok(data.answers);
    assert.equal(Object.keys(data.answers).length, 4);
  });

  test('transport reject → provider_error 且无 answers', async () => {
    const transport = new CaptureTransport();
    transport.rejectWith = new Error('boom');
    const provider = new JevDecisionProvider({ transport });
    const activity = memoryLog();
    const outcome = await runDecisionShadow({
      provider,
      activity,
      clock: { now: () => new Date('2026-03-20T12:00:00.000Z') },
      stateInput: {
        hook: 'PRE_DISPATCH',
        projectId: 'p-1',
        missionId: 'm-1',
      },
      workItemIds: [],
    });
    assert.equal(outcome.quality, 'provider_error');
    const data = activity.events[0]!.data as Record<string, unknown>;
    assert.equal(data.quality, 'provider_error');
    assert.equal('answers' in data, false);
  });
});

describe('JevDecisionProvider source guard', () => {
  test('adapter 无 fetch/http/https/apiKey/baseURL/Authorization/@typesafe-ai', () => {
    const source = readFileSync(
      join(root, 'src', 'application', 'jev-decision-provider.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /\bfetch\b/);
    assert.doesNotMatch(source, /\bhttps?\b/i);
    assert.doesNotMatch(source, /apiKey/i);
    assert.doesNotMatch(source, /baseURL/);
    assert.doesNotMatch(source, /Authorization/);
    assert.doesNotMatch(source, /@typesafe-ai/);
  });
});
