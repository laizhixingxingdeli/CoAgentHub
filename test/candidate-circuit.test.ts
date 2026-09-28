import test from 'node:test';
import assert from 'node:assert/strict';
import { claimCandidateProbe, closedCandidateCircuit, openCandidateCircuit, resolveCandidateProbe, validateClaimCandidateProbe, validateOpenCandidateCircuit, validateResolveCandidateProbe, type CandidateCircuit } from '../src/application/candidate-circuit.ts';

const opened: CandidateCircuit = { profileId: 'p1', state: 'open', failureClass: 'timeout', openUntil: '2030-01-01T00:00:00.000Z' };

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
