/**
 * createDecisionProvider：OFF 零 env 读取；SHADOW 装配 Jev transport + provider。
 * createPostExecutionEvaluator（J2）：同一套 env 与传输，POST 请求外形与超时。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDecisionProvider,
  createPostExecutionEvaluator,
} from '../src/application/decision-provider-factory.ts';
import {
  CANDIDATE_EXECUTOR_FACT_KEY,
  POST_EXECUTION_V1,
  POST_EXECUTION_V1_QUESTION_IDS,
  PREFERRED_EXECUTOR_NONE_OPTION,
  PRE_DISPATCH_V1,
} from '../src/application/decision-question-registry.ts';
import type { DecisionRequest } from '../src/application/ports.ts';
import { FixedClock, InMemoryActivityLog } from '../src/application/in-memory.ts';
import { buildPostExecutionState } from '../src/application/post-execution-state.ts';
import { projectPostExecutionStateForRemote } from '../src/application/post-execution-remote-input.ts';
import {
  DEFAULT_POST_EXECUTION_REMOTE_BUDGET,
  recordPostExecutionShadow,
} from '../src/application/post-execution-shadow.ts';
import type { PostExecutionStateInput } from '../src/application/post-execution-state.ts';

const RISK_CRITERIA = PRE_DISPATCH_V1.questions
  .find((q) => q.id === 'semantic_risk')!
  .orderedLevels.map((l) => `${l.label}: ${l.rubric}`);

function riskLegend(): Record<string, string> {
  return {
    '0': RISK_CRITERIA[0]!,
    '1': RISK_CRITERIA[1]!,
    '2': RISK_CRITERIA[2]!,
    '3': RISK_CRITERIA[3]!,
  };
}

function validJevBody(): string {
  return JSON.stringify({
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
    },
    usage: { input_tokens: 1, output_tokens: 2 },
  });
}

function baseRequest(): DecisionRequest {
  return {
    hook: 'PRE_DISPATCH',
    projectId: 'p-1',
    missionId: 'm-1',
    workItemId: 'w-1',
    facts: [{ key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'exec-a' }],
  };
}

/** Proxy env：访问敏感 key 即抛，用于证明 OFF 路径未读取。 */
function touchSensitiveEnv(base: Record<string, string | undefined> = {}): {
  env: Record<string, string | undefined>;
  touched: string[];
} {
  const touched: string[] = [];
  const sensitive = new Set([
    'TYPESAFE_API_KEY',
    'COAGENT_DECISION_TIMEOUT_MS',
    'COAGENT_DECISION_MAX_BODY_BYTES',
    'COAGENT_DECISION_MODEL',
    'TYPESAFE_BASE_URL',
  ]);
  const env = new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && sensitive.has(prop)) {
        touched.push(prop);
        throw new Error(`forbidden env read: ${prop}`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { env, touched };
}

describe('createDecisionProvider OFF', () => {
  test('mode=off：返回 undefined，且不读 API key / timeout / body / model', () => {
    const { env, touched } = touchSensitiveEnv({
      TYPESAFE_API_KEY: 'should-not-read',
      COAGENT_DECISION_TIMEOUT_MS: '999',
      COAGENT_DECISION_MAX_BODY_BYTES: '1',
      COAGENT_DECISION_MODEL: 'x',
    });
    let fetchCalls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('fetch must not run');
    };

    const provider = createDecisionProvider({ mode: 'off', env, fetch });
    assert.equal(provider, undefined);
    assert.deepEqual(touched, []);
    assert.equal(fetchCalls, 0);
  });
});

describe('createDecisionProvider SHADOW', () => {
  test('默认超时 1500ms：上游 1 秒才回照样成功（E3：冷调用 730–1342ms，800 会误杀）', async () => {
    const fetch: typeof globalThis.fetch = async (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(new Response(validJevBody(), { status: 200, headers: { 'content-type': 'application/json' } })),
          1000,
        );
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const provider = createDecisionProvider({ mode: 'shadow', env: { TYPESAFE_API_KEY: 'k' }, fetch });
    assert.ok(provider);
    const result = await provider.decide(baseRequest());
    assert.ok(result.answers.task_type, '1 秒回来的答案不该被默认超时掐掉');
  });

  test('缺 TYPESAFE_API_KEY：throw，不 fetch', () => {
    let fetchCalls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('no');
    };
    assert.throws(
      () => createDecisionProvider({ mode: 'shadow', env: {}, fetch }),
      /TYPESAFE_API_KEY/,
    );
    assert.throws(
      () =>
        createDecisionProvider({
          mode: 'shadow',
          env: { TYPESAFE_API_KEY: '   ' },
          fetch,
        }),
      /TYPESAFE_API_KEY/,
    );
    assert.equal(fetchCalls, 0);
  });

  test('非法 timeout / body env：throw，不 fetch', () => {
    let fetchCalls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('no');
    };
    assert.throws(
      () =>
        createDecisionProvider({
          mode: 'shadow',
          env: {
            TYPESAFE_API_KEY: 'k',
            COAGENT_DECISION_TIMEOUT_MS: '0',
          },
          fetch,
        }),
      /COAGENT_DECISION_TIMEOUT_MS/,
    );
    assert.throws(
      () =>
        createDecisionProvider({
          mode: 'shadow',
          env: {
            TYPESAFE_API_KEY: 'k',
            COAGENT_DECISION_TIMEOUT_MS: 'abc',
          },
          fetch,
        }),
      /COAGENT_DECISION_TIMEOUT_MS/,
    );
    assert.throws(
      () =>
        createDecisionProvider({
          mode: 'shadow',
          env: {
            TYPESAFE_API_KEY: 'k',
            COAGENT_DECISION_TIMEOUT_MS: '60001',
          },
          fetch,
        }),
      /COAGENT_DECISION_TIMEOUT_MS/,
    );
    assert.throws(
      () =>
        createDecisionProvider({
          mode: 'shadow',
          env: {
            TYPESAFE_API_KEY: 'k',
            COAGENT_DECISION_MAX_BODY_BYTES: '-1',
          },
          fetch,
        }),
      /COAGENT_DECISION_MAX_BODY_BYTES/,
    );
    assert.throws(
      () =>
        createDecisionProvider({
          mode: 'shadow',
          env: {
            TYPESAFE_API_KEY: 'k',
            COAGENT_DECISION_MAX_BODY_BYTES: String(11 * 1024 * 1024),
          },
          fetch,
        }),
      /COAGENT_DECISION_MAX_BODY_BYTES/,
    );
    assert.equal(fetchCalls, 0);
  });

  test('valid：fake fetch → provider.decide；kind=jev-system-one', async () => {
    let fetchCalls = 0;
    let lastUrl = '';
    const fetch: typeof globalThis.fetch = async (input, init) => {
      fetchCalls += 1;
      lastUrl = String(input);
      assert.equal(init?.method, 'POST');
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, 'Bearer test-key-xyz');
      return new Response(validJevBody(), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const provider = createDecisionProvider({
      mode: 'shadow',
      env: {
        TYPESAFE_API_KEY: '  test-key-xyz  ',
        COAGENT_DECISION_MODEL: 'jev-custom-shadow',
      },
      fetch,
    });
    assert.ok(provider);
    assert.equal(provider!.kind, 'jev-system-one');

    const result = await provider!.decide(baseRequest());
    assert.equal(fetchCalls, 1);
    assert.match(lastUrl, /systemone/);
    assert.equal(result.answers.task_type?.kind, 'choice');
    if (result.answers.task_type?.kind === 'choice') {
      assert.equal(result.answers.task_type.option, 'bugfix');
    }
  });
});

/* ------------------------------ POST_EXECUTION（J2） ------------------------------ */

const POST_INPUT: PostExecutionStateInput = {
  workOrder: { objective: '改 foo', constraints: ['不要：别动 bar'], acceptanceCriteria: ['foo() === 1'] },
  executorResult: {
    status: 'completed',
    summary: '改了初始值',
    claimedEvidence: { evidenceIds: ['E-1'], summaries: [{ id: 'E-1', kind: 'test', summary: 'node --test 全绿' }] },
  },
  fileChanges: { files: ['src/foo.ts'] },
  evidence: [{ id: 'E-1', kind: 'test', exitCode: 0, summary: 'node --test 全绿' }],
  execution: { toolCount: 3 },
};

function remoteState() {
  return projectPostExecutionStateForRemote(buildPostExecutionState(POST_INPUT), DEFAULT_POST_EXECUTION_REMOTE_BUDGET);
}

function validPostBody(): string {
  const risk = POST_EXECUTION_V1.questions.find((q) => q.id === 'semantic_risk')!;
  const criteria = risk.kind === 'score' ? risk.orderedLevels.map((l) => `${l.label}: ${l.rubric}`) : [];
  return JSON.stringify({
    model: 'jev-1.13.0',
    answers: {
      objective_satisfied: { type: 'noul', noul: 0.9 },
      evidence_sufficient: { type: 'noul', noul: 0.7 },
      scope_deviation: { type: 'noul', noul: 0.1 },
      semantic_risk: {
        type: 'score',
        score: 1.2,
        confidence: 0.8,
        probabilities: { '0': 0.1, '1': 0.6, '2': 0.2, '3': 0.1 },
        legend: { '0': criteria[0]!, '1': criteria[1]!, '2': criteria[2]!, '3': criteria[3]! },
      },
    },
    usage: { input_tokens: 1200, output_tokens: 40 },
  });
}

describe('createPostExecutionEvaluator（J2）', () => {
  test('mode=off：undefined，且不读 API key / timeout / body / model', () => {
    const { env, touched } = touchSensitiveEnv({ TYPESAFE_API_KEY: 'should-not-read', COAGENT_DECISION_MODEL: 'x' });
    const evaluator = createPostExecutionEvaluator({
      mode: 'off',
      env,
      fetch: async () => {
        throw new Error('fetch must not run');
      },
    });
    assert.equal(evaluator, undefined);
    assert.deepEqual(touched, []);
  });

  test('shadow 缺 key：throw，与 PRE 同一条错误', () => {
    assert.throws(() => createPostExecutionEvaluator({ mode: 'shadow', env: {} }), /TYPESAFE_API_KEY/);
  });

  test('shadow：同一端点与 key，发 {state, questions, model}；答案映射成 POST 四题 + 模型与用量', async () => {
    let sent: { url: string; auth: string; body: Record<string, any> } | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      sent = {
        url: String(input),
        auth: (init?.headers as Record<string, string>).Authorization!,
        body: JSON.parse(String(init?.body)),
      };
      return new Response(validPostBody(), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const evaluator = createPostExecutionEvaluator({
      mode: 'shadow',
      env: { TYPESAFE_API_KEY: ' post-key ', COAGENT_DECISION_MODEL: 'jev-custom' },
      fetch,
    });
    assert.ok(evaluator);
    assert.equal(evaluator.kind, 'jev-system-one');

    const result = await evaluator.evaluate(remoteState());
    assert.ok(sent);
    assert.match(sent.url, /systemone/);
    assert.equal(sent.auth, 'Bearer post-key');
    assert.equal(sent.body.model, 'jev-custom');
    assert.deepEqual(Object.keys(sent.body.questions), [...POST_EXECUTION_V1_QUESTION_IDS]);
    assert.deepEqual(sent.body.state.fileChanges.files, ['src/foo.ts']);
    assert.equal(sent.body.state.execution.toolCount, 3);
    assert.deepEqual(Object.keys(result.answers).sort(), [...POST_EXECUTION_V1_QUESTION_IDS].sort());
    assert.equal(result.meta?.resolvedModel, 'jev-1.13.0');
    assert.deepEqual(result.meta?.usage, { inputTokens: 1200, outputTokens: 40 });
  });

  test('超时（COAGENT_DECISION_TIMEOUT_MS 与 PRE 共用）：evaluate 拒绝；shadow 只记 provider_error、不抛', async () => {
    const fetch: typeof globalThis.fetch = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const evaluator = createPostExecutionEvaluator({
      mode: 'shadow',
      env: { TYPESAFE_API_KEY: 'k', COAGENT_DECISION_TIMEOUT_MS: '50' },
      fetch,
    });
    assert.ok(evaluator);
    await assert.rejects(() => evaluator.evaluate(remoteState()));

    const activity = new InMemoryActivityLog(new FixedClock());
    await recordPostExecutionShadow(
      { evaluator, activity, clock: new FixedClock() },
      {
        projectId: 'P',
        missionId: 'M',
        workItemId: 'W-1',
        submittedAttemptId: 'W-1.exec-0',
        input: POST_INPUT,
        filesSource: 'workspace_diff',
      },
    );
    const events = await activity.list('M');
    assert.equal(events.length, 1);
    assert.equal((events[0]!.data as { quality: string }).quality, 'provider_error');
  });
});
