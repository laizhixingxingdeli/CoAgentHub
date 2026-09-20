/**
 * Remote Decision input sanitizer —— default-deny facts projection.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizeDecisionStateForRemote } from '../src/application/decision-remote-input.ts';
import { CANDIDATE_EXECUTOR_FACT_KEY } from '../src/application/decision-question-registry.ts';
import {
  buildDecisionState,
  DECISION_STATE_SCHEMA_VERSION,
  type DecisionState,
} from '../src/application/decision-state-builder.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

function baseState(
  facts: DecisionState['facts'] = [],
): DecisionState {
  return buildDecisionState({
    hook: 'PRE_DISPATCH',
    projectId: 'p-1',
    missionId: 'm-1',
    workItemId: 'w-1',
    attemptId: 'a-1',
    facts,
  });
}

describe('sanitizeDecisionStateForRemote', () => {
  test('identity fields 原样；facts 新数组且不 mutate 输入', () => {
    const rawFacts = [
      { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'exec-a' },
      { key: 'opaque', value: 'keep-in-builder-only' },
    ];
    const state = baseState(rawFacts);
    const out = sanitizeDecisionStateForRemote(state);

    assert.equal(out.schemaVersion, DECISION_STATE_SCHEMA_VERSION);
    assert.equal(out.hook, 'PRE_DISPATCH');
    assert.equal(out.projectId, 'p-1');
    assert.equal(out.missionId, 'm-1');
    assert.equal(out.workItemId, 'w-1');
    assert.equal(out.attemptId, 'a-1');

    assert.notEqual(out.facts, state.facts);
    assert.deepEqual(state.facts, rawFacts);
    assert.deepEqual(out.facts, [{ key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'exec-a' }]);
  });

  test('unknown key 全 drop', () => {
    const out = sanitizeDecisionStateForRemote(
      baseState([
        { key: 'secret_blob', value: 'x' },
        { key: 'note', value: 'y' },
        { key: 'candidate_executor', value: 'almost' },
      ]),
    );
    assert.deepEqual(out.facts, []);
  });

  test('合法 candidate 保留并 trim', () => {
    const out = sanitizeDecisionStateForRemote(
      baseState([{ key: CANDIDATE_EXECUTOR_FACT_KEY, value: '  exec-z  ' }]),
    );
    assert.deepEqual(out.facts, [{ key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'exec-z' }]);
  });

  test('空白与字面 none drop', () => {
    const out = sanitizeDecisionStateForRemote(
      baseState([
        { key: CANDIDATE_EXECUTOR_FACT_KEY, value: '   ' },
        { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'none' },
        { key: CANDIDATE_EXECUTOR_FACT_KEY, value: '  none  ' },
        { key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'keep-me' },
      ]),
    );
    assert.deepEqual(out.facts, [{ key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'keep-me' }]);
  });

  test('secret-like PEM header drop', () => {
    const out = sanitizeDecisionStateForRemote(
      baseState([
        {
          key: CANDIDATE_EXECUTOR_FACT_KEY,
          value: '-----BEGIN RSA PRIVATE KEY-----\nMIIE',
        },
      ]),
    );
    assert.deepEqual(out.facts, []);
  });

  test('secret-like Bearer drop', () => {
    const out = sanitizeDecisionStateForRemote(
      baseState([{ key: CANDIDATE_EXECUTOR_FACT_KEY, value: 'Bearer sk-live-abc' }]),
    );
    assert.deepEqual(out.facts, []);
  });

  test('secret-like JWT-like eyJ drop', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature';
    const out = sanitizeDecisionStateForRemote(
      baseState([{ key: CANDIDATE_EXECUTOR_FACT_KEY, value: jwt }]),
    );
    assert.deepEqual(out.facts, []);
  });

  test('secret-like api_key= / apikey= / token= / cookie= drop', () => {
    const samples = [
      'api_key=sk-123',
      'API_KEY=sk-123',
      'apikey=xyz',
      'token=abc',
      'Cookie=session',
      'cookie=sid',
    ];
    for (const value of samples) {
      const out = sanitizeDecisionStateForRemote(
        baseState([{ key: CANDIDATE_EXECUTOR_FACT_KEY, value }]),
      );
      assert.deepEqual(out.facts, [], `expected drop for ${value}`);
    }
  });

  test('注释声明 remote default-deny 而非通用 DLP', () => {
    const source = readFileSync(
      join(root, 'src', 'application', 'decision-remote-input.ts'),
      'utf8',
    );
    assert.match(source, /default-deny/);
    assert.match(source, /not a general DLP/i);
  });
});

describe('StateBuilder 仍保留任意 opaque fact（provider-neutral）', () => {
  test('显式 opaque fact 原值保留', () => {
    const state = buildDecisionState({
      hook: 'PRE_DISPATCH',
      projectId: 'p',
      missionId: 'm',
      facts: [
        { key: 'anything', value: 'api_key=should-stay-in-builder' },
        { key: CANDIDATE_EXECUTOR_FACT_KEY, value: '  raw  ' },
      ],
    });
    assert.deepEqual(state.facts, [
      { key: 'anything', value: 'api_key=should-stay-in-builder' },
      { key: CANDIDATE_EXECUTOR_FACT_KEY, value: '  raw  ' },
    ]);
  });
});
