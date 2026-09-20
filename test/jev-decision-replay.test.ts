/**
 * Phase 1 fixed-sample replay：内存 fake transport 对 Jev adapter 做
 * 确定性、无网络的 固定输入 → wire → 规范化答案/错误 回放。
 *
 * 样本为只读表驱动常量；不依赖 fixture 目录、真实网络或 shadow runner。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

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
import type { DecisionAnswerSet, DecisionRequest } from '../src/application/ports.ts';

const RISK_CRITERIA = PRE_DISPATCH_V1.questions
  .find((q) => q.id === 'semantic_risk')!
  .orderedLevels.map((l) => `${l.label}: ${l.rubric}`);

const QUESTION_IDS = [
  'task_type',
  'semantic_risk',
  'work_order_ambiguous',
  'preferred_executor',
] as const;

const QUESTION_TYPES = {
  task_type: 'choice',
  semantic_risk: 'score',
  work_order_ambiguous: 'noul',
  preferred_executor: 'choice',
} as const;

function riskLegend(): Record<string, string> {
  return {
    '0': RISK_CRITERIA[0]!,
    '1': RISK_CRITERIA[1]!,
    '2': RISK_CRITERIA[2]!,
    '3': RISK_CRITERIA[3]!,
  };
}

/** 固定合法 response（可覆盖单题）。 */
function fixedValidResponse(
  overrides?: Partial<JevSystemOneResponse['answers']>,
): JevSystemOneResponse {
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
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

class ReplayTransport implements JevSystemOneTransport {
  readonly captured: JevSystemOneRequest[] = [];
  private readonly response: JevSystemOneResponse | (() => JevSystemOneResponse);

  constructor(response: JevSystemOneResponse | (() => JevSystemOneResponse)) {
    this.response = response;
  }

  async systemOne(request: JevSystemOneRequest): Promise<JevSystemOneResponse> {
    this.captured.push(structuredClone(request));
    return typeof this.response === 'function' ? this.response() : this.response;
  }
}

function assertStableWireShape(req: JevSystemOneRequest): void {
  assert.equal(req.model, 'jev-latest');
  assert.equal(req.state.schemaVersion, DECISION_STATE_SCHEMA_VERSION);
  assert.equal(req.state.hook, 'PRE_DISPATCH');

  for (const id of QUESTION_IDS) {
    assert.ok(id in req.questions, `missing question ${id}`);
    assert.equal(req.questions[id].type, QUESTION_TYPES[id]);
  }
  assert.deepEqual(Object.keys(req.questions).sort(), [...QUESTION_IDS].sort());
}

function assertNoOpaqueInWire(req: JevSystemOneRequest, forbidden: readonly string[]): void {
  const wireJson = JSON.stringify(req);
  for (const s of forbidden) {
    assert.equal(wireJson.includes(s), false, `opaque/secret leaked into wire: ${s}`);
  }
}

/* ------------------------------ fixed corpus ------------------------------ */

const SECRET_CANDIDATE = 'Bearer tok-replay-xyz';
const OPAQUE_NOTE = 'api_key=should-not-leak-replay';
const UNKNOWN_FACT_VALUE = 'v-secret-leak-replay';

interface SuccessReplayCase {
  readonly name: string;
  readonly request: DecisionRequest;
  readonly response: JevSystemOneResponse;
  readonly expectedWireFacts: readonly { readonly key: string; readonly value: string }[];
  readonly expectedPreferredCriteria: readonly string[];
  readonly expectedAnswers: DecisionAnswerSet['answers'];
  readonly forbiddenInWire: readonly string[];
}

const SUCCESS_CASES: readonly SuccessReplayCase[] = [
  {
    name: 'no-facts success',
    request: {
      hook: 'PRE_DISPATCH',
      projectId: 'replay-p',
      missionId: 'replay-m',
      workItemId: 'replay-w',
    },
    response: fixedValidResponse(),
    expectedWireFacts: [],
    expectedPreferredCriteria: [PREFERRED_EXECUTOR_NONE_OPTION],
    expectedAnswers: {
      task_type: { kind: 'choice', option: 'bugfix' },
      preferred_executor: { kind: 'choice', option: PREFERRED_EXECUTOR_NONE_OPTION },
      work_order_ambiguous: { kind: 'score', value: 0.25, scale: 'noul' },
      semantic_risk: { kind: 'score', value: 1.6, scale: 'ordinal4.v1' },
    },
    forbiddenInWire: [],
  },
  {
    name: 'candidate/minimization success',
    request: {
      hook: 'PRE_DISPATCH',
      projectId: 'replay-p',
      missionId: 'replay-m',
      workItemId: 'replay-w',
      facts: [
        { key: CANDIDATE_EXECUTOR_FACT_KEY, value: '  exec-a  ' },
        { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'exec-b' },
        { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'exec-a' },
        { key: CANDIDATE_EXECUTOR_FACT_KEY, value: SECRET_CANDIDATE },
        { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'none' },
        { key: CANDIDATE_EXECUTOR_FACT_KEY, value: '   ' },
        { key: 'opaque_key', value: UNKNOWN_FACT_VALUE },
        { key: 'note', value: OPAQUE_NOTE },
      ],
    },
    response: fixedValidResponse({
      preferred_executor: {
        type: 'choice',
        choice: 'exec-a',
        confidence: 0.85,
        probabilities: { 'exec-a': 0.85, [PREFERRED_EXECUTOR_NONE_OPTION]: 0.15 },
      },
    }),
    // wire state.facts 保留安全 candidate（trim 后），含重复次序中的安全项
    expectedWireFacts: [
      { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'exec-a' },
      { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'exec-b' },
      { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'exec-a' },
    ],
    expectedPreferredCriteria: ['exec-a', 'exec-b', PREFERRED_EXECUTOR_NONE_OPTION],
    expectedAnswers: {
      task_type: { kind: 'choice', option: 'bugfix' },
      preferred_executor: { kind: 'choice', option: 'exec-a' },
      work_order_ambiguous: { kind: 'score', value: 0.25, scale: 'noul' },
      semantic_risk: { kind: 'score', value: 1.6, scale: 'ordinal4.v1' },
    },
    forbiddenInWire: [
      SECRET_CANDIDATE,
      'Bearer',
      UNKNOWN_FACT_VALUE,
      OPAQUE_NOTE,
      'opaque_key',
    ],
  },
];

interface RejectReplayCase {
  readonly name: string;
  readonly request: DecisionRequest;
  readonly response: JevSystemOneResponse;
}

const REJECT_CASES: readonly RejectReplayCase[] = [
  {
    name: 'invalid response missing preferred_executor',
    request: {
      hook: 'PRE_DISPATCH',
      projectId: 'replay-p',
      missionId: 'replay-m',
    },
    response: (() => {
      const r = fixedValidResponse();
      const { preferred_executor: _, ...rest } = r.answers;
      return {
        ...r,
        answers: rest as JevSystemOneResponse['answers'],
      };
    })(),
  },
  {
    name: 'invalid response risk out of range',
    request: {
      hook: 'PRE_DISPATCH',
      projectId: 'replay-p',
      missionId: 'replay-m',
    },
    response: fixedValidResponse({
      semantic_risk: {
        type: 'score',
        score: 3.5,
        confidence: 0.8,
        probabilities: {},
        legend: riskLegend(),
      },
    }),
  },
];

describe('Jev decision fixed replay corpus', () => {
  for (const sample of SUCCESS_CASES) {
    test(`${sample.name}: wire + answers + double replay deepEqual`, async () => {
      const transport = new ReplayTransport(sample.response);
      const provider = new JevDecisionProvider({ transport });

      const first = await provider.decide(sample.request);
      const second = await provider.decide(sample.request);

      assert.equal(transport.captured.length, 2);
      assert.deepEqual(transport.captured[0], transport.captured[1]);
      assert.deepEqual(first, second);
      assert.deepEqual(first.answers, sample.expectedAnswers);
      assert.equal(Object.keys(first.answers).length, 4);
      assert.equal('usage' in first, false);
      assert.equal('model' in first, false);

      const wire = transport.captured[0]!;
      assertStableWireShape(wire);
      assert.deepEqual(wire.state.facts, sample.expectedWireFacts);
      assert.deepEqual(
        Object.keys(wire.questions.preferred_executor.criteria),
        sample.expectedPreferredCriteria,
      );
      assert.deepEqual(
        Object.keys(wire.questions.task_type.criteria),
        [...TASK_TYPE_OPTIONS],
      );
      assert.deepEqual(wire.questions.semantic_risk.criteria, RISK_CRITERIA);

      // risk raw 1.6 保持 ordinal4.v1
      assert.equal(first.answers.semantic_risk.kind, 'score');
      if (first.answers.semantic_risk.kind === 'score') {
        assert.equal(first.answers.semantic_risk.value, 1.6);
        assert.equal(first.answers.semantic_risk.scale, 'ordinal4.v1');
      }
      assert.equal(first.answers.work_order_ambiguous.kind, 'score');
      if (first.answers.work_order_ambiguous.kind === 'score') {
        assert.equal(first.answers.work_order_ambiguous.scale, 'noul');
      }

      assertNoOpaqueInWire(wire, sample.forbiddenInWire);
    });
  }

  for (const sample of REJECT_CASES) {
    test(`${sample.name}: decide rejects with no partial answers`, async () => {
      const transport = new ReplayTransport(sample.response);
      const provider = new JevDecisionProvider({ transport });

      let thrown: unknown;
      try {
        await provider.decide(sample.request);
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof Error, 'expected reject');
      assert.match(thrown.message, /JevDecisionProvider/);

      // 稳定拒绝：再放一次同样 throw
      await assert.rejects(() => provider.decide(sample.request), /JevDecisionProvider/);

      // transport 已收到 wire，但调用方得不到部分 answers
      assert.equal(transport.captured.length, 2);
      assertStableWireShape(transport.captured[0]!);
      assert.deepEqual(transport.captured[0], transport.captured[1]);
    });
  }
});
