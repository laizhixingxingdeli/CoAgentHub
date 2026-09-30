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
    await repo.open({ profileId: 'persist-file', failureClass: 'timeout', openUntil: deadline });
    const racing = new FileCandidateCircuitRepository(store);
    await repo.open({ profileId: 'race', failureClass: 'timeout', openUntil: deadline });
    assert.deepEqual(await Promise.all([repo.tryClaimProbe({ profileId: 'race', now }), racing.tryClaimProbe({ profileId: 'race', now })]), [true, false]);
    assert.equal(await repo.tryClaimProbe({ profileId: 'race', now }), false);
    assert.deepEqual(await new FileCandidateCircuitRepository(new FileStateStore(path)).get('probe-file'), { profileId: 'probe-file', state: 'closed' });
    const reopened = new FileCandidateCircuitRepository(new FileStateStore(path));
    assert.deepEqual(await reopened.get('persist-file'), { profileId: 'persist-file', state: 'open', failureClass: 'timeout', openUntil: deadline });
    assert.deepEqual(await reopened.get('race'), { profileId: 'race', state: 'half_open', failureClass: 'timeout', openUntil: deadline, probeClaimed: true });
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
    const repo = new PgCandidateCircuitRepository(first);
    const otherConnection = new PgCandidateCircuitRepository(second);
    await exercise(repo, 'pg');
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
