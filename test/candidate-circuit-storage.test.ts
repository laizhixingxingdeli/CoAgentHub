import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStateStore, FileCandidateCircuitRepository } from '../src/application/file-store.ts';

const deadline = '2030-01-01T00:00:00.000Z';
const now = '2030-01-01T00:00:00.000Z';
const replacement = '2030-01-02T00:00:00.000Z';

async function exercise(repo: FileCandidateCircuitRepository, suffix: string) {
  assert.deepEqual(await repo.get(`missing-${suffix}`), { profileId: `missing-${suffix}`, state: 'closed' });
  await repo.open({ profileId: `probe-${suffix}`, failureClass: 'timeout', openUntil: deadline });
  await repo.open({ profileId: `other-${suffix}`, failureClass: 'quota', openUntil: deadline });
  assert.deepEqual(await repo.get(`other-${suffix}`), { profileId: `other-${suffix}`, state: 'open', failureClass: 'quota', openUntil: deadline });
  assert.equal((await repo.get(`probe-${suffix}`)).state, 'open');
  assert.equal(await repo.tryClaimProbe({ profileId: `probe-${suffix}`, now: '2029-12-31T23:59:59.999Z' }), false);
  assert.equal(await repo.tryClaimProbe({ profileId: `probe-${suffix}`, now }), true);
  assert.deepEqual(await repo.get(`probe-${suffix}`), { profileId: `probe-${suffix}`, state: 'half_open', failureClass: 'timeout', openUntil: deadline, probeClaimed: true });
  await assert.rejects(repo.resolveProbe({ profileId: `absent-${suffix}`, succeeded: true }));
  await assert.rejects(repo.resolveProbe({ profileId: `probe-${suffix}`, succeeded: false }));
  assert.equal((await repo.get(`probe-${suffix}`)).state, 'half_open');
  await repo.resolveProbe({ profileId: `probe-${suffix}`, succeeded: false, failureClass: 'unavailable', openUntil: replacement });
  assert.deepEqual(await repo.get(`probe-${suffix}`), { profileId: `probe-${suffix}`, state: 'open', failureClass: 'unavailable', openUntil: replacement });
  assert.equal(await repo.tryClaimProbe({ profileId: `probe-${suffix}`, now: replacement }), true);
  await repo.resolveProbe({ profileId: `probe-${suffix}`, succeeded: true });
  assert.deepEqual(await repo.get(`probe-${suffix}`), { profileId: `probe-${suffix}`, state: 'closed' });
  await assert.rejects(repo.resolveProbe({ profileId: `probe-${suffix}`, succeeded: true }));
}

test('file candidate circuits persist, isolate profiles, claim once, and rollback transactions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'candidate-circuit-'));
  try {
    const path = join(dir, 'state.json');
    const store = new FileStateStore(path);
    const repo = new FileCandidateCircuitRepository(store);
    await exercise(repo, 'file');
    await repo.open({ profileId: 'quota-null-file', failureClass: 'quota', openUntil: null });
    assert.equal((await repo.get('quota-null-file')).state, 'open');
    assert.equal(await repo.tryClaimProbe({ profileId: 'quota-null-file', now: '9999-01-01T00:00:00.000Z' }), false);
    await repo.open({ profileId: 'manual-file', failureClass: 'quota', openUntil: null });
    await repo.reset({ profileId: 'manual-file', actor: 'operator', at: now, reason: 'recharged' });
    assert.deepEqual(await repo.listResetEvents('manual-file'), [{ profileId: 'manual-file', actor: 'operator', at: now, reason: 'recharged' }]);
    await repo.open({ profileId: 'reset-open', failureClass: 'quota', openUntil: null });
    await repo.open({ profileId: 'reset-half', failureClass: 'timeout', openUntil: deadline });
    assert.equal(await repo.tryClaimProbe({ profileId: 'reset-half', now }), true);
    const fileResetRace = await Promise.allSettled([
      repo.reset({ profileId: 'reset-open', actor: 'one', at: now, reason: 'manual' }),
      new FileCandidateCircuitRepository(store).reset({ profileId: 'reset-open', actor: 'two', at: now, reason: 'manual' }),
    ]);
    assert.equal(fileResetRace.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(fileResetRace.filter((result) => result.status === 'rejected').length, 1);
    await repo.reset({ profileId: 'reset-half', actor: 'operator', at: now, reason: 'verified' });
    assert.deepEqual(await repo.listResetEvents('reset-open'), [{ profileId: 'reset-open', actor: fileResetRace[0].status === 'fulfilled' ? 'one' : 'two', at: now, reason: 'manual' }]);
    await assert.rejects(repo.reset({ profileId: 'missing-reset', actor: 'operator', at: now, reason: 'x' }), /does not exist/);
    await assert.rejects(repo.reset({ profileId: 'manual-file', actor: 'operator', at: now, reason: 'x' }), /closed/);
    await repo.open({ profileId: 'persist-file', failureClass: 'timeout', openUntil: deadline });
    const racing = new FileCandidateCircuitRepository(store);
    await repo.open({ profileId: 'race', failureClass: 'timeout', openUntil: deadline });
    assert.deepEqual(await Promise.all([repo.tryClaimProbe({ profileId: 'race', now }), racing.tryClaimProbe({ profileId: 'race', now })]), [true, false]);
    assert.equal(await repo.tryClaimProbe({ profileId: 'race', now }), false);
    assert.deepEqual(await new FileCandidateCircuitRepository(new FileStateStore(path)).get('probe-file'), { profileId: 'probe-file', state: 'closed' });
    const reopened = new FileCandidateCircuitRepository(new FileStateStore(path));
    assert.deepEqual(await reopened.get('persist-file'), { profileId: 'persist-file', state: 'open', failureClass: 'timeout', openUntil: deadline });
    assert.deepEqual(await reopened.get('race'), { profileId: 'race', state: 'half_open', failureClass: 'timeout', openUntil: deadline, probeClaimed: true });
    assert.deepEqual(await reopened.get('manual-file'), { profileId: 'manual-file', state: 'closed' });
    assert.deepEqual(await reopened.get('quota-null-file'), { profileId: 'quota-null-file', state: 'open', failureClass: 'quota', openUntil: null });
    const reopenedEvents = await reopened.listResetEvents();
    assert.ok(reopenedEvents.some((event) => event.profileId === 'manual-file' && event.actor === 'operator' && event.reason === 'recharged'));
    assert.ok(reopenedEvents.some((event) => event.profileId === 'reset-half' && event.actor === 'operator' && event.reason === 'verified'));
    const legacyPath = join(dir, 'legacy.json');
    writeFileSync(legacyPath, JSON.stringify({ version: 1, candidateCircuits: [{ profileId: 'legacy-iso', state: 'open', failureClass: 'timeout', openUntil: deadline }], projects: [], deliveries: [], events: [], idCounters: {} }));
    assert.deepEqual(await new FileCandidateCircuitRepository(new FileStateStore(legacyPath)).get('legacy-iso'), { profileId: 'legacy-iso', state: 'open', failureClass: 'timeout', openUntil: deadline });
    await assert.rejects(store.run(async () => { await repo.open({ profileId: 'rollback', failureClass: 'x', openUntil: deadline }); throw new Error('rollback'); }));
    assert.deepEqual(await repo.get('rollback'), { profileId: 'rollback', state: 'closed' });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).candidateCircuits.some((row: {profileId:string}) => row.profileId === 'rollback'), false);
    writeFileSync(path, JSON.stringify({ version: 1, projects: [], deliveries: [], events: [], idCounters: {} }));
    assert.deepEqual(await new FileCandidateCircuitRepository(new FileStateStore(path)).get('legacy'), { profileId: 'legacy', state: 'closed' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pruneAbsent 删掉名单外的候选记录，名单内的原样保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'candidate-circuit-prune-'));
  try {
    const path = join(dir, 'state.json');
    const repo = new FileCandidateCircuitRepository(new FileStateStore(path));
    await repo.open({ profileId: 'keep-a', failureClass: 'timeout', openUntil: deadline });
    await repo.open({ profileId: 'gone-b', failureClass: 'quota', openUntil: null });
    await repo.open({ profileId: 'gone-c', failureClass: 'unknown', openUntil: deadline });
    const pruned = await repo.pruneAbsent(new Set(['keep-a']));
    assert.deepEqual([...pruned].sort(), ['gone-b', 'gone-c']);
    assert.equal((await repo.get('keep-a')).state, 'open');
    assert.deepEqual(await repo.get('gone-b'), { profileId: 'gone-b', state: 'closed' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
