import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStateStore, FileCandidateCircuitRepository } from '../src/application/file-store.ts';
import { PgStateStore, PgCandidateCircuitRepository } from '../src/application/pg-store.ts';
import { ensureTestDatabase } from './helpers/pg.ts';

const deadline = '2030-01-01T00:00:00.000Z';
const now = '2030-01-01T00:00:00.000Z';
const replacement = '2030-01-02T00:00:00.000Z';

async function exercise(repo: FileCandidateCircuitRepository | PgCandidateCircuitRepository, suffix: string) {
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

test('Postgres candidate circuits persist and arbitrate claims across connections', async (t) => {
  const connectionString = await ensureTestDatabase('candidate_circuit_storage');
  if (!connectionString) { t.skip('Postgres unavailable; candidate circuit PG integration not verified'); return; }
  const first = await PgStateStore.open({ connectionString });
  const second = await PgStateStore.open({ connectionString });
  try {
    await first.pool.query('TRUNCATE candidate_circuits');
    await first.pool.query(`INSERT INTO candidate_circuits (profile_id, state, failure_class, open_until, probe_claimed)
      VALUES ('legacy-iso-pg', 'open', 'timeout', $1::timestamptz, false)`, [deadline]);
    const repo = new PgCandidateCircuitRepository(first);
    const otherConnection = new PgCandidateCircuitRepository(second);
    await first.pool.query('TRUNCATE candidate_circuit_reset_events');
    await exercise(repo, 'pg');
    assert.deepEqual(await repo.get('legacy-iso-pg'), { profileId: 'legacy-iso-pg', state: 'open', failureClass: 'timeout', openUntil: deadline });
    await repo.open({ profileId: 'quota-null-pg', failureClass: 'quota', openUntil: null });
    assert.deepEqual(await repo.get('quota-null-pg'), { profileId: 'quota-null-pg', state: 'open', failureClass: 'quota', openUntil: null });
    assert.equal(await repo.tryClaimProbe({ profileId: 'quota-null-pg', now: '9999-01-01T00:00:00.000Z' }), false);
    await repo.reset({ profileId: 'quota-null-pg', actor: 'operator', at: now, reason: 'recharged' });
    await repo.open({ profileId: 'reset-open-pg', failureClass: 'quota', openUntil: null });
    await repo.open({ profileId: 'reset-half-pg', failureClass: 'timeout', openUntil: deadline });
    assert.equal(await repo.tryClaimProbe({ profileId: 'reset-half-pg', now }), true);
    const pgResetRace = await Promise.allSettled([
      repo.reset({ profileId: 'reset-open-pg', actor: 'one', at: now, reason: 'manual' }),
      otherConnection.reset({ profileId: 'reset-open-pg', actor: 'two', at: now, reason: 'manual' }),
    ]);
    assert.equal(pgResetRace.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(pgResetRace.filter((result) => result.status === 'rejected').length, 1);
    await repo.reset({ profileId: 'reset-half-pg', actor: 'operator', at: now, reason: 'verified' });
    const eventCountBefore = (await repo.listResetEvents()).length;
    const circuitBefore = await repo.get('persist-pg');
    await PgStateStore.open({ connectionString }).then(async (restarted) => {
      try {
        assert.deepEqual(await new PgCandidateCircuitRepository(restarted).get('persist-pg'), circuitBefore);
        assert.equal((await new PgCandidateCircuitRepository(restarted).listResetEvents()).length, eventCountBefore);
      } finally { await restarted.close(); }
    });
    await assert.rejects(otherConnection.reset({ profileId: 'quota-null-pg', actor: 'second', at: now, reason: 'race' }));
    assert.equal((await new PgCandidateCircuitRepository(second).listResetEvents('quota-null-pg')).length, 1);
    await repo.open({ profileId: 'persist-pg', failureClass: 'timeout', openUntil: deadline });
    await repo.open({ profileId: 'race-pg', failureClass: 'timeout', openUntil: deadline });
    assert.deepEqual(await Promise.all([repo.tryClaimProbe({ profileId: 'race-pg', now }), otherConnection.tryClaimProbe({ profileId: 'race-pg', now })]), [true, false]);
    assert.equal(await otherConnection.tryClaimProbe({ profileId: 'race-pg', now }), false);
    const reopened = new PgCandidateCircuitRepository(second);
    assert.deepEqual(await reopened.get('persist-pg'), { profileId: 'persist-pg', state: 'open', failureClass: 'timeout', openUntil: deadline });
    assert.deepEqual(await reopened.get('other-pg'), { profileId: 'other-pg', state: 'open', failureClass: 'quota', openUntil: deadline });
    assert.deepEqual(await reopened.get('race-pg'), { profileId: 'race-pg', state: 'half_open', failureClass: 'timeout', openUntil: deadline, probeClaimed: true });
  } finally { await first.close(); await second.close(); }
});
