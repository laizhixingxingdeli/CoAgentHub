import test from 'node:test';
import assert from 'node:assert/strict';
import { claimCandidateProbe, classifyCandidateFailure, closedCandidateCircuit, openCandidateCircuit, resolveCandidateLastFailure, resolveCandidateProbe, validateClaimCandidateProbe, validateOpenCandidateCircuit, validateResolveCandidateProbe, type CandidateCircuit } from '../src/application/candidate-circuit.ts';

const opened: CandidateCircuit = { profileId: 'p1', state: 'open', failureClass: 'timeout', openUntil: '2030-01-01T00:00:00.000Z' };

test('candidate failures are classified conservatively with explicit failover decisions', () => {
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'HTTP 429 quota exceeded'), { failureClass: 'quota', failover: true });
  assert.deepEqual(classifyCandidateFailure('upstream_failure', '401 Unauthorized'), { failureClass: 'auth', failover: true });
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'HTTP 503 Service Unavailable'), { failureClass: 'upstream_5xx', failover: true });
  assert.deepEqual(classifyCandidateFailure('killed_idle'), { failureClass: 'killed_idle', failover: true });
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'adapter connection reset', true), { failureClass: 'local_adapter_error', failover: false });
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'HTTP 429 quota exceeded', true), { failureClass: 'quota', failover: true });
  assert.deepEqual(classifyCandidateFailure('upstream_failure', '401 Unauthorized', true), { failureClass: 'auth', failover: true });
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'HTTP 503 Service Unavailable', true), { failureClass: 'upstream_5xx', failover: true });
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'adapter connection reset; HTTP 503 Service Unavailable', true), { failureClass: 'local_adapter_error', failover: false });
  assert.deepEqual(classifyCandidateFailure('upstream_failure', '403 需要充值'), { failureClass: 'quota', failover: true });
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'econnrefused'), { failureClass: 'unknown', failover: false });
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'fetch failed', true), { failureClass: 'local_adapter_error', failover: false });

  assert.equal(classifyCandidateFailure('structured_submit'), undefined);
  assert.equal(classifyCandidateFailure('no_structured_result'), undefined);
  assert.equal(classifyCandidateFailure('platform_unreachable', 'HTTP 429 quota'), undefined);
  assert.equal(classifyCandidateFailure('platform_unreachable', 'HTTP 503'), undefined);
  assert.equal(classifyCandidateFailure('killed_wall_clock'), undefined);
  assert.equal(classifyCandidateFailure('cancelled'), undefined);
  assert.equal(classifyCandidateFailure('interrupted'), undefined);
  assert.deepEqual(classifyCandidateFailure('upstream_failure'), { failureClass: 'unknown', failover: false });
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'ordinary execution failed'), { failureClass: 'unknown', failover: false });
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'unrecognized runtime exception', true), { failureClass: 'unknown', failover: false });
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'request failed', true), { failureClass: 'unknown', failover: false });
});

test('no-status-code upstream temp faults classify as upstream_5xx; local adapter/quota/auth keep priority', () => {
  const five = { failureClass: 'upstream_5xx', failover: true };
  const phrases = [
    'Error Code null: Internal error during token generation',
    'INTERNAL ERROR DURING TOKEN GENERATION',
    'internal error during token generation',
    'internal error',
    'Internal Error',
    'INTERNAL ERROR',
    'overloaded',
    'Overloaded',
    'the model is OVERLOADED',
    'temporarily unavailable',
    'Temporarily Unavailable',
    'TEMPORARILY UNAVAILABLE',
  ];
  for (const message of phrases) {
    assert.deepEqual(classifyCandidateFailure('upstream_failure', message), five, message);
    assert.deepEqual(classifyCandidateFailure('upstream_failure', message, true), five, `${message} fromRuntimeException`);
  }
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'HTTP 503 Service Unavailable'), five);
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'HTTP 502 bad gateway'), five);
  assert.deepEqual(
    classifyCandidateFailure('upstream_failure', 'adapter connection reset; Internal error during token generation', true),
    { failureClass: 'local_adapter_error', failover: false },
  );
  assert.deepEqual(
    classifyCandidateFailure('upstream_failure', 'econnrefused internal error', true),
    { failureClass: 'local_adapter_error', failover: false },
  );
  assert.deepEqual(
    classifyCandidateFailure('upstream_failure', 'fetch failed; temporarily unavailable', true),
    { failureClass: 'local_adapter_error', failover: false },
  );
  assert.deepEqual(
    classifyCandidateFailure('upstream_failure', 'HTTP 429 quota exceeded; internal error', true),
    { failureClass: 'quota', failover: true },
  );
  assert.deepEqual(
    classifyCandidateFailure('upstream_failure', '401 Unauthorized; overloaded', true),
    { failureClass: 'auth', failover: true },
  );
});

test('upstream billing and credit signals classify as quota; 403 or forbidden alone do not', () => {
  const quota = { failureClass: 'quota', failover: true };
  const unknown = { failureClass: 'unknown', failover: false };
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'xai API error (403): You have run out of credits or need a Grok subscription'), quota);
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'CREDITS exhausted'), quota);
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'Need a Subscription'), quota);
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'BILLING hold'), quota);
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'spending limit reached'), quota);
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'usage limit exceeded'), quota);
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'usage_limit exceeded'), quota);
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'insufficient balance'), quota);
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'insufficient_quota'), quota);
  assert.deepEqual(classifyCandidateFailure('upstream_failure', '余额不足'), quota);
  assert.deepEqual(classifyCandidateFailure('upstream_failure', '欠费'), quota);
  assert.deepEqual(classifyCandidateFailure('upstream_failure', '403'), unknown);
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'forbidden'), unknown);
  assert.deepEqual(classifyCandidateFailure('upstream_failure', 'HTTP 403 Forbidden'), unknown);
});

test('missing circuit is represented as closed', () => {
  const missing: CandidateCircuit = closedCandidateCircuit('p1');
  assert.equal(missing.state, 'closed');
});

test('non-probe open transition can open/reopen from any state', () => {
  const input = { profileId: 'p1', failureClass: 'timeout', openUntil: opened.openUntil };
  assert.deepEqual(openCandidateCircuit(input), opened);
  assert.equal(openCandidateCircuit(input).state, 'open');
  const claimed = claimCandidateProbe(opened, '2030-01-01T00:00:00.000Z')!;
  assert.deepEqual(openCandidateCircuit(input), opened);
  assert.equal(openCandidateCircuit({ ...input, failureClass: 'new-class' }).failureClass, 'new-class');
  assert.notEqual(claimed.state, openCandidateCircuit(input).state);
});

test('probe claim respects strict time boundary and is single-use', () => {
  assert.equal(claimCandidateProbe(opened, '2029-12-31T23:59:59.999Z'), undefined);
  const claimed = claimCandidateProbe(opened, '2030-01-01T00:00:00.000Z');
  assert.equal(claimed?.state, 'half_open');
  assert.equal(claimCandidateProbe(claimed as Extract<CandidateCircuit, {state:'half_open'}>, '2030-01-02T00:00:00.000Z'), undefined);
});

test('claimed probe success closes and failure reopens with new failure data', () => {
  const claimed = claimCandidateProbe(opened, '2030-01-01T00:00:00.000Z')!;
  assert.deepEqual(resolveCandidateProbe(claimed, { profileId: 'p1', succeeded: true }), { profileId: 'p1', state: 'closed' });
  assert.deepEqual(resolveCandidateProbe(claimed, { profileId: 'p1', succeeded: false, failureClass: 'unavailable', openUntil: '2030-01-02T00:00:00.000Z' }), {
    profileId: 'p1', state: 'open', failureClass: 'unavailable', openUntil: '2030-01-02T00:00:00.000Z',
  });
});

test('invalid inputs and unclaimed/repeated resolutions are rejected without changing input state', () => {
  assert.throws(() => validateOpenCandidateCircuit({ profileId: 'p1', failureClass: '', openUntil: 'bad' }));
  assert.throws(() => validateOpenCandidateCircuit({ profileId: ' ', failureClass: 'timeout', openUntil: opened.openUntil }));
  assert.throws(() => validateClaimCandidateProbe({ profileId: 'p1', now: 'bad' }));
  assert.throws(() => validateResolveCandidateProbe({ profileId: 'p1', succeeded: false }));
  const snapshot = structuredClone(opened);
  assert.throws(() => resolveCandidateProbe(opened, { profileId: 'p1', succeeded: true }));
  assert.deepEqual(opened, snapshot);
  const claimed = claimCandidateProbe(opened, '2030-01-01T00:00:00.000Z')!;
  resolveCandidateProbe(claimed, { profileId: 'p1', succeeded: true });
  assert.throws(() => resolveCandidateProbe({ profileId: 'p1', state: 'closed' }, { profileId: 'p1', succeeded: true }));
  assert.deepEqual(claimed, { profileId: 'p1', state: 'half_open', failureClass: 'timeout', openUntil: opened.openUntil, probeClaimed: true });
});

test('closed circuit without hints is unknown; open circuit without time stays class-only',
  () => {
    assert.deepEqual(resolveCandidateLastFailure(closedCandidateCircuit('p1'), []), {
      failureClass: 'unknown',
      at: null,
      source: 'unknown',
      unknownReason: 'no_circuit_or_attempt_failure',
    });
    const open = openCandidateCircuit({
      profileId: 'p1',
      failureClass: 'quota',
      openUntil: '2030-01-01T00:00:00.000Z',
    });
    assert.deepEqual(resolveCandidateLastFailure(open, []), {
      failureClass: 'quota',
      at: null,
      source: 'circuit',
      unknownReason: 'circuit_open_without_failure_time',
    });
    assert.deepEqual(
      resolveCandidateLastFailure(open, [
        { failureClass: 'quota', at: '2026-01-02T00:00:00.000Z', source: 'queue' },
        { failureClass: 'auth', at: '2026-01-03T00:00:00.000Z', source: 'attempt.ended' },
      ]),
      { failureClass: 'quota', at: '2026-01-02T00:00:00.000Z', source: 'queue' },
    );
    assert.deepEqual(
      resolveCandidateLastFailure(closedCandidateCircuit('p1'), [
        { failureClass: 'upstream_5xx', at: '2026-01-01T00:00:00.000Z', source: 'attempt.ended' },
        { failureClass: 'quota', at: '2026-01-04T00:00:00.000Z', source: 'queue' },
      ]),
      { failureClass: 'quota', at: '2026-01-04T00:00:00.000Z', source: 'queue' },
    );
  },
);
