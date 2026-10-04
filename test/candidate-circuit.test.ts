import test from 'node:test';
import assert from 'node:assert/strict';
import { claimCandidateProbe, classifyCandidateFailure, closedCandidateCircuit, openCandidateCircuit, resolveQuotaResetTime, resolveCandidateLastFailure, resolveCandidateProbe, validateClaimCandidateProbe, validateOpenCandidateCircuit, validateResolveCandidateProbe, type CandidateCircuit } from '../src/application/candidate-circuit.ts';

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
  for (const message of [
    "xai API error (403): You have run out of credits or need a Grok subscription",
    "CREDITS exhausted",
    "Need a Subscription",
    "BILLING hold",
    "spending limit reached",
    "usage limit exceeded",
    "usage_limit exceeded",
    "insufficient balance",
    "insufficient_quota",
    "余额不足",
    "欠费"
  ]) assert.deepEqual(classifyCandidateFailure('upstream_failure', message), quota, message);
  for (const message of [
    "403",
    "forbidden",
    "HTTP 403 Forbidden"
  ]) assert.deepEqual(classifyCandidateFailure('upstream_failure', message), unknown, message);

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

test('quota circuits can remain open indefinitely and reset time parsing uses explicit inputs', () => {
  const forever = openCandidateCircuit({ profileId: 'p1', failureClass: 'quota', openUntil: null });
  assert.equal(forever.openUntil, null);
  assert.equal(claimCandidateProbe(forever, '2030-01-01T00:00:00.000Z'), undefined);
  assert.throws(() => openCandidateCircuit({ profileId: 'p1', failureClass: 'auth', openUntil: null }));
  const now = '2030-01-01T00:00:00.000Z';
  const cases: Array<[Parameters<typeof resolveQuotaResetTime>[0], string]> = [
    [{ now, headers: { 'Retry-After': '60' } }, '2030-01-01T00:01:00.000Z'],
    [{ now, headers: { 'retry-after': 'Tue, 01 Jan 2030 00:01:00 GMT' } }, '2030-01-01T00:01:00.000Z'],
    [{ now, headers: { 'x-ratelimit-reset': '1893456060' } }, '2030-01-01T00:01:00.000Z'],
    [{ now, headers: { 'x-ratelimit-reset': '1893456060000' } }, '2030-01-01T00:01:00.000Z'],
    [{ now, message: 'try again in 2 minutes' }, '2030-01-01T00:02:00.000Z'],
    [{ now, message: 'try again in 3 小时' }, '2030-01-01T03:00:00.000Z'],
    [{ now, message: 'Resets at 2030-01-02T00:00:00.000Z' }, '2030-01-02T00:00:00.000Z'],
    [{ now, message: '重置于 2030-01-02T00:00:00.000Z' }, '2030-01-02T00:00:00.000Z'],
    [{ now, message: '(QUOTA RESETS AT 2030-01-02T00:00:00.000Z)' }, '2030-01-02T00:00:00.000Z'],
  ];
  for (const [input, expected] of cases) assert.equal(resolveQuotaResetTime(input), expected);
  assert.equal(resolveQuotaResetTime({ now, message: 'resets at yesterday' }), null);
  assert.equal(resolveQuotaResetTime({ now, headers: { 'Retry-After': '0' } }), null);
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
