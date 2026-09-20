/**
 * POST_EXECUTION Jev mapper 离线 replay：固定 state → request 两次 deepEqual；
 * 合法 response → 四 answers + meta；invalid matrix 全 throw。
 * 无 transport / 网络 / DecisionProvider。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildJevPostExecutionRequest,
  mapJevPostExecutionResponse,
  type JevPostExecutionQuestions,
  type JevPostExecutionResponse,
} from '../src/application/jev-post-execution-mapper.ts';
import {
  POST_EXECUTION_V1,
  POST_EXECUTION_V1_QUESTION_IDS,
  PRE_DISPATCH_V1,
} from '../src/application/decision-question-registry.ts';
import { buildPostExecutionState } from '../src/application/post-execution-state.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const mapperSrcPath = join(root, 'src', 'application', 'jev-post-execution-mapper.ts');

const QUESTION_IDS = [...POST_EXECUTION_V1_QUESTION_IDS] as const;

const FIXED_STATE = buildPostExecutionState({
  workOrder: {
    objective: 'fix login flake',
    constraints: Object.freeze(['no schema change']),
    acceptanceCriteria: Object.freeze(['tests green']),
  },
  executorResult: {
    status: 'completed',
    summary: 'patched retry',
    claimedEvidence: {
      evidenceIds: Object.freeze(['ev-1']),
      summaries: Object.freeze([
        Object.freeze({ id: 'ev-1', kind: 'test', summary: 'unit ok' }),
      ]),
    },
  },
  fileChanges: {
    files: Object.freeze(['src/a.ts']),
  },
  evidence: [
    { id: 'b1', kind: 'build', exitCode: 0, summary: 'build ok' },
    { id: 't1', kind: 'test', exitCode: 0 },
  ],
  execution: { toolCount: 2 },
});

const MODEL = 'jev-post-replay-model';

function postRiskCriteriaFromRegistry(): readonly string[] {
  const q = POST_EXECUTION_V1.questions.find((item) => item.id === 'semantic_risk');
  assert.ok(q && q.kind === 'score');
  return q.orderedLevels.map((l) => `${l.label}: ${l.rubric}`);
}

function preRiskCriteriaFromRegistry(): readonly string[] {
  const q = PRE_DISPATCH_V1.questions.find((item) => item.id === 'semantic_risk');
  assert.ok(q && q.kind === 'score');
  return q.orderedLevels.map((l) => `${l.label}: ${l.rubric}`);
}

function riskLegend(criteria: readonly string[]): Record<string, string> {
  return {
    '0': criteria[0]!,
    '1': criteria[1]!,
    '2': criteria[2]!,
    '3': criteria[3]!,
  };
}

function fixedValidResponse(
  overrides?: Partial<JevPostExecutionResponse['answers']>,
): JevPostExecutionResponse {
  const criteria = postRiskCriteriaFromRegistry();
  return {
    model: '  jev-resolved-post  ',
    answers: {
      objective_satisfied: { type: 'noul', noul: 0.9 },
      evidence_sufficient: { type: 'noul', noul: 0.75 },
      scope_deviation: { type: 'noul', noul: 0.1 },
      semantic_risk: {
        type: 'score',
        score: 1.25,
        confidence: 0.88,
        probabilities: { '0': 0.1, '1': 0.6, '2': 0.2, '3': 0.1 },
        legend: riskLegend(criteria),
      },
      ...overrides,
    },
    usage: { input_tokens: 11, output_tokens: 22 },
  };
}

describe('buildJevPostExecutionRequest', () => {
  test('fixed state: two builds deepEqual; state same reference', () => {
    const a = buildJevPostExecutionRequest(FIXED_STATE, MODEL);
    const b = buildJevPostExecutionRequest(FIXED_STATE, MODEL);
    assert.deepEqual(a, b);
    assert.equal(a.state, FIXED_STATE);
    assert.equal(b.state, FIXED_STATE);
    assert.equal(a.model, MODEL);
  });

  test('model required: blank/whitespace throw; no default jev-latest', () => {
    assert.throws(() => buildJevPostExecutionRequest(FIXED_STATE, ''), /model/);
    assert.throws(() => buildJevPostExecutionRequest(FIXED_STATE, '   '), /model/);
    const req = buildJevPostExecutionRequest(FIXED_STATE, '  custom-m  ');
    assert.equal(req.model, 'custom-m');
    assert.notEqual(req.model, 'jev-latest');
  });

  test('questions exact keys/order; noul no criteria; risk from registry = PRE risk', () => {
    const req = buildJevPostExecutionRequest(FIXED_STATE, MODEL);
    assert.deepEqual(Object.keys(req.questions), [...QUESTION_IDS]);

    for (const id of [
      'objective_satisfied',
      'evidence_sufficient',
      'scope_deviation',
    ] as const) {
      const q = req.questions[id];
      assert.equal(q.type, 'noul');
      assert.equal('criteria' in q, false);
      const spec = POST_EXECUTION_V1.questions.find((item) => item.id === id)!;
      assert.equal(q.instructions, spec.purpose);
    }

    const risk = req.questions.semantic_risk;
    assert.equal(risk.type, 'score');
    assert.ok(risk.type === 'score');
    const postCriteria = postRiskCriteriaFromRegistry();
    const preCriteria = preRiskCriteriaFromRegistry();
    assert.deepEqual([...risk.criteria], [...postCriteria]);
    assert.deepEqual([...risk.criteria], [...preCriteria]);
    const postSpec = POST_EXECUTION_V1.questions.find((q) => q.id === 'semantic_risk')!;
    assert.equal(risk.instructions, postSpec.purpose);
  });
});

describe('mapJevPostExecutionResponse', () => {
  test('valid response → four answers + meta exact; no wire confidence/legend leak', () => {
    const req = buildJevPostExecutionRequest(FIXED_STATE, MODEL);
    const response = fixedValidResponse();
    const out = mapJevPostExecutionResponse(response, req.questions);

    assert.deepEqual(out.answers, {
      objective_satisfied: { kind: 'score', value: 0.9, scale: 'noul' },
      evidence_sufficient: { kind: 'score', value: 0.75, scale: 'noul' },
      scope_deviation: { kind: 'score', value: 0.1, scale: 'noul' },
      semantic_risk: { kind: 'score', value: 1.25, scale: 'ordinal4.v1' },
    });
    assert.deepEqual(out.meta, {
      resolvedModel: 'jev-resolved-post',
      usage: { inputTokens: 11, outputTokens: 22 },
    });

    const json = JSON.stringify(out);
    assert.equal(json.includes('confidence'), false);
    assert.equal(json.includes('probabilities'), false);
    assert.equal(json.includes('"legend"'), false);
  });

  test('invalid matrix: missing/extra/range/type/legend/model/usage/PASS', () => {
    const req = buildJevPostExecutionRequest(FIXED_STATE, MODEL);
    const qs = req.questions;
    const criteria = postRiskCriteriaFromRegistry();

    const cases: { name: string; mutate: (r: JevPostExecutionResponse) => unknown }[] = [
      {
        name: 'missing key',
        mutate: (r) => {
          const { objective_satisfied: _, ...rest } = r.answers;
          return { ...r, answers: rest };
        },
      },
      {
        name: 'extra key',
        mutate: (r) => ({
          ...r,
          answers: { ...r.answers, bonus: { type: 'noul', noul: 0.5 } },
        }),
      },
      {
        name: 'noul < 0',
        mutate: (r) => ({
          ...r,
          answers: {
            ...r.answers,
            objective_satisfied: { type: 'noul', noul: -0.01 },
          },
        }),
      },
      {
        name: 'noul > 1',
        mutate: (r) => ({
          ...r,
          answers: {
            ...r.answers,
            evidence_sufficient: { type: 'noul', noul: 1.01 },
          },
        }),
      },
      {
        name: 'noul NaN',
        mutate: (r) => ({
          ...r,
          answers: {
            ...r.answers,
            scope_deviation: { type: 'noul', noul: Number.NaN },
          },
        }),
      },
      {
        name: 'risk > 3',
        mutate: (r) => ({
          ...r,
          answers: {
            ...r.answers,
            semantic_risk: {
              type: 'score',
              score: 3.01,
              legend: riskLegend(criteria),
            },
          },
        }),
      },
      {
        name: 'risk NaN',
        mutate: (r) => ({
          ...r,
          answers: {
            ...r.answers,
            semantic_risk: {
              type: 'score',
              score: Number.NaN,
              legend: riskLegend(criteria),
            },
          },
        }),
      },
      {
        name: 'legend mismatch',
        mutate: (r) => ({
          ...r,
          answers: {
            ...r.answers,
            semantic_risk: {
              type: 'score',
              score: 1,
              legend: {
                '0': 'WRONG',
                '1': criteria[1]!,
                '2': criteria[2]!,
                '3': criteria[3]!,
              },
            },
          },
        }),
      },
      {
        name: 'legend missing key',
        mutate: (r) => ({
          ...r,
          answers: {
            ...r.answers,
            semantic_risk: {
              type: 'score',
              score: 1,
              legend: {
                '0': criteria[0]!,
                '1': criteria[1]!,
                '2': criteria[2]!,
              },
            },
          },
        }),
      },
      {
        name: 'legend extra key',
        mutate: (r) => ({
          ...r,
          answers: {
            ...r.answers,
            semantic_risk: {
              type: 'score',
              score: 1,
              legend: {
                ...riskLegend(criteria),
                '4': 'extra',
              },
            },
          },
        }),
      },
      {
        name: 'wrong type noul as score',
        mutate: (r) => ({
          ...r,
          answers: {
            ...r.answers,
            objective_satisfied: {
              type: 'score',
              score: 0.5,
              legend: riskLegend(criteria),
            } as never,
          },
        }),
      },
      {
        name: 'wrong type risk as noul',
        mutate: (r) => ({
          ...r,
          answers: {
            ...r.answers,
            semantic_risk: { type: 'noul', noul: 0.5 } as never,
          },
        }),
      },
      {
        name: 'model blank',
        mutate: (r) => ({ ...r, model: '   ' }),
      },
      {
        name: 'usage negative',
        mutate: (r) => ({
          ...r,
          usage: { input_tokens: -1, output_tokens: 1 },
        }),
      },
      {
        name: 'usage NaN',
        mutate: (r) => ({
          ...r,
          usage: { input_tokens: 1, output_tokens: Number.NaN },
        }),
      },
      {
        name: 'PASS string as answer',
        mutate: (r) => ({
          ...r,
          answers: {
            ...r.answers,
            objective_satisfied: 'PASS' as never,
          },
        }),
      },
    ];

    for (const c of cases) {
      const base = fixedValidResponse();
      const bad = c.mutate(base) as JevPostExecutionResponse;
      assert.throws(
        () => mapJevPostExecutionResponse(bad, qs as JevPostExecutionQuestions),
        undefined,
        c.name,
      );
    }
  });
});

describe('source guard: jev-post-execution-mapper', () => {
  test('no provider/transport/platform/runner/main/kernel; no fetch/http/apiKey', () => {
    const src = readFileSync(mapperSrcPath, 'utf8');
    const forbidden = [
      'jev-decision-provider',
      'jev-system-one-http-transport',
      'decision-shadow-runner',
      'platform',
      '/main',
      'kernel',
      'fetch(',
      'http://',
      'https://',
      'apiKey',
      'api_key',
      'DecisionProvider',
    ];
    for (const token of forbidden) {
      assert.equal(src.includes(token), false, `forbidden token in mapper: ${token}`);
    }
    assert.match(src, /from '\.\/decision-question-registry\.ts'/);
    assert.match(src, /from '\.\/post-execution-state\.ts'/);
    assert.match(src, /from '\.\/ports\.ts'/);
  });
});
