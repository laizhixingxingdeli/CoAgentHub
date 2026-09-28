import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileProjectRepository, FileQueuedHopRepository, FileStateStore } from '../src/application/file-store.ts';
import { holdsCurrentClaim, type ClaimFence, type QueuedHop } from '../src/application/durable-scheduler.ts';
import { Project } from '../src/kernel/index.ts';

const NOW = '2025-01-01T00:00:00Z';
const LEASE = '2025-01-01T00:00:10Z';
const LATER = '2025-01-01T00:00:20Z';

function queuedHop(overrides: Partial<QueuedHop> = {}): QueuedHop {
  return {
    id: 'h1',
    projectId: 'p',
    missionId: 'm',
    workItemId: 'w',
    role: 'executor',
    priority: 1,
    availableAt: NOW,
    attemptCount: 0,
    maxAttempts: 2,
    idempotencyKey: 'fence-key',
    status: 'queued',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function claimedHop(overrides: Partial<QueuedHop> = {}): QueuedHop {
  return queuedHop({
    status: 'claimed',
    owner: 'owner',
    leaseUntil: LEASE,
    claimGeneration: 1,
    ...overrides,
  });
}

test('holdsCurrentClaim accepts only a live claimed hop with matching owner and generation', () => {
  const hop = claimedHop();
  const fence: ClaimFence = { id: hop.id, owner: 'owner', claimGeneration: 1, now: NOW };
  assert.equal(holdsCurrentClaim(hop, fence), true);
  assert.equal(holdsCurrentClaim(undefined, fence), false);
  assert.equal(holdsCurrentClaim(hop, { ...fence, id: 'other' }), false);
  assert.equal(holdsCurrentClaim(hop, { ...fence, owner: 'intruder' }), false);
  assert.equal(holdsCurrentClaim(hop, { ...fence, claimGeneration: 0 }), false);
  assert.equal(holdsCurrentClaim(hop, { ...fence, now: LEASE }), false);
  assert.equal(holdsCurrentClaim(hop, { ...fence, now: '2025-01-01T00:00:10.001Z' }), false);
  assert.equal(holdsCurrentClaim({ ...hop, status: 'queued' }, fence), false);
  assert.equal(holdsCurrentClaim({ ...hop, status: 'completed' }, fence), false);
  assert.equal(holdsCurrentClaim({ ...hop, leaseUntil: undefined }, fence), false);
});

test('file fenced command commits test project writes for a live matching claim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hop-fence-ok-'));
  try {
    const path = join(dir, 'state.json');
    const store = new FileStateStore(path);
    const repo = new FileQueuedHopRepository(store);
    const projects = new FileProjectRepository(store);
    await repo.enqueue(queuedHop());
    const claimed = await repo.claim('h1', 'owner', NOW, LEASE);
    assert.equal(claimed?.claimGeneration, 1);
    const queueBefore = await repo.get('h1');
    await store.runFenced({ id: 'h1', owner: 'owner', claimGeneration: 1, now: NOW }, async () => {
      const project = Project.create({ id: 'P-fence' });
      await projects.save(project);
    });
    assert.equal((await projects.get('P-fence'))?.id, 'P-fence');
    assert.deepEqual(await repo.get('h1'), queueBefore);
    const reopened = new FileStateStore(path);
    assert.equal((await new FileProjectRepository(reopened).get('P-fence'))?.id, 'P-fence');
    assert.deepEqual(await new FileQueuedHopRepository(reopened).get('h1'), queueBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file fenced command rejects stale generation, wrong owner, expired lease, and missing hop without mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hop-fence-reject-'));
  try {
    const path = join(dir, 'state.json');
    const store = new FileStateStore(path);
    const repo = new FileQueuedHopRepository(store);
    const projects = new FileProjectRepository(store);
    await repo.enqueue(queuedHop());
    const claimed = await repo.claim('h1', 'owner', NOW, LEASE);
    assert.ok(claimed);
    const seed = Project.create({ id: 'P-seed' });
    await projects.save(seed);
    const queueBefore = structuredClone(await repo.get('h1'));
    const diskBefore = readFileSync(path);
    const projectBefore = JSON.stringify((await projects.get('P-seed'))!.toSnapshot());

    const writeInCallback = async () => {
      (await projects.get('P-seed'))!.createMission({
        id: 'M-no',
        contract: { intent: 'x', acceptance: ['a'], constraints: [], nonGoals: [], guardrails: [] },
      });
      await projects.save((await projects.get('P-seed'))!);
      await projects.save(Project.create({ id: 'P-rejected' }));
    };

    const rejects = [
      { id: 'h1', owner: 'owner', claimGeneration: 0, now: NOW },
      { id: 'h1', owner: 'intruder', claimGeneration: 1, now: NOW },
      { id: 'h1', owner: 'owner', claimGeneration: 1, now: LEASE },
      { id: 'missing', owner: 'owner', claimGeneration: 1, now: NOW },
    ] as const;
    for (const fence of rejects) {
      await assert.rejects(store.runFenced(fence, writeInCallback), /claim fence rejected/);
      assert.deepEqual(await repo.get('h1'), queueBefore);
      assert.equal(JSON.stringify((await projects.get('P-seed'))!.toSnapshot()), projectBefore);
      assert.equal(await projects.get('P-rejected'), undefined);
      assert.deepEqual(readFileSync(path), diskBefore);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reclaim after expiry strictly increases generation; reopen still rejects the old generation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hop-fence-reclaim-'));
  try {
    const path = join(dir, 'state.json');
    const store = new FileStateStore(path);
    const repo = new FileQueuedHopRepository(store);
    const projects = new FileProjectRepository(store);
    await repo.enqueue(queuedHop());
    const first = await repo.claim('h1', 'owner', NOW, LEASE);
    assert.equal(first?.claimGeneration, 1);
    const taken = await repo.claim('h1', 'next', LEASE, LATER);
    assert.equal(taken?.claimGeneration, 2);
    assert.ok((taken?.claimGeneration ?? 0) > (first?.claimGeneration ?? 0));

    await assert.rejects(
      store.runFenced({ id: 'h1', owner: 'owner', claimGeneration: 1, now: LEASE }, async () => {
        await projects.save(Project.create({ id: 'P-stale' }));
      }),
      /claim fence rejected/,
    );
    assert.equal(await projects.get('P-stale'), undefined);
    assert.equal((await repo.get('h1'))?.claimGeneration, 2);

    await store.runFenced({ id: 'h1', owner: 'next', claimGeneration: 2, now: LEASE }, async () => {
      await projects.save(Project.create({ id: 'P-live' }));
    });
    assert.equal((await projects.get('P-live'))?.id, 'P-live');

    const reopened = new FileStateStore(path);
    const reopenedRepo = new FileQueuedHopRepository(reopened);
    const reopenedProjects = new FileProjectRepository(reopened);
    assert.equal((await reopenedRepo.get('h1'))?.claimGeneration, 2);
    await assert.rejects(
      reopened.runFenced({ id: 'h1', owner: 'next', claimGeneration: 1, now: LEASE }, async () => {
        await reopenedProjects.save(Project.create({ id: 'P-old-gen' }));
      }),
      /claim fence rejected/,
    );
    assert.equal(await reopenedProjects.get('P-old-gen'), undefined);
    await reopened.runFenced({ id: 'h1', owner: 'next', claimGeneration: 2, now: LEASE }, async () => {
      await reopenedProjects.save(Project.create({ id: 'P-reopen' }));
    });
    assert.equal((await reopenedProjects.get('P-reopen'))?.id, 'P-reopen');
    assert.equal((await reopenedProjects.get('P-live'))?.id, 'P-live');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nested fenced rejection rolls back the enclosing command transaction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hop-fence-nested-'));
  try {
    const path = join(dir, 'state.json');
    const store = new FileStateStore(path);
    const repo = new FileQueuedHopRepository(store);
    const projects = new FileProjectRepository(store);
    await repo.enqueue(queuedHop());
    await repo.claim('h1', 'owner', NOW, LEASE);
    await projects.save(Project.create({ id: 'P-outer' }));
    const diskBefore = readFileSync(path);
    const queueBefore = structuredClone(await repo.get('h1'));

    await assert.rejects(
      store.run(async () => {
        const live = (await projects.get('P-outer'))!;
        live.createMission({
          id: 'M-nested',
          contract: { intent: 'x', acceptance: ['a'], constraints: [], nonGoals: [], guardrails: [] },
        });
        await projects.save(live);
        await store.runFenced({ id: 'h1', owner: 'owner', claimGeneration: 99, now: NOW }, async () => {
          await projects.save(Project.create({ id: 'P-inner' }));
        });
      }),
      /claim fence rejected/,
    );

    assert.deepEqual(readFileSync(path), diskBefore);
    assert.deepEqual(await repo.get('h1'), queueBefore);
    assert.equal((await projects.get('P-outer'))!.missions.length, 0);
    assert.equal(await projects.get('P-inner'), undefined);

    await assert.rejects(
      store.runFenced({ id: 'h1', owner: 'owner', claimGeneration: 1, now: NOW }, async () => {
        await store.run(async () => {
          await projects.save(Project.create({ id: 'P-throw' }));
          throw new Error('callback failed');
        });
      }),
      /callback failed/,
    );
    assert.equal(await projects.get('P-throw'), undefined);
    assert.deepEqual(await repo.get('h1'), queueBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
