/**
 * E2：独立检视快照在文件 / PG 仓储的往返。验收 8。
 * 验收 2：持久仓储写入阻塞原因后重开仍可查询。
 * PG 不可用时 skip 并写明「未验证」，不能静默当通过。
 * 不替换 process.stdout.write。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { FileActivityLog, FileProjectRepository, FileStateStore } from '../src/application/file-store.ts';
import { FixedClock, SequentialIds } from '../src/application/in-memory.ts';
import { PgActivityLog, PgProjectRepository, PgStateStore } from '../src/application/pg-store.ts';
import { Platform, PlatformRuleError } from '../src/application/platform.ts';
import { ensureTestDatabase } from './helpers/pg.ts';
import { Project } from '../src/kernel/index.ts';
import type { MissionContract, MissionSnapshot, UsedProfile, WorkOrder } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '存储往返',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const ORDER: WorkOrder = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
};

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function seedReviewed(project: Project): void {
  const mission = project.createMission({
    id: 'M-store',
    contract: CONTRACT,
    executionMode: 'high_assurance',
  });
  mission.startExecuting();
  const coord = mission.startCoordinatorAttempt();
  coord.recordProfile({ profileId: 'coord-a', endpoint: 'local' });
  coord.succeed();
  const item = mission.createWorkItem({ id: 'W-1', title: '改 foo', order: ORDER });
  item.dispatch();
  const exec = item.startAttempt();
  exec.recordProfile({ profileId: 'exec-a', endpoint: 'local' });
  exec.succeed();
  item.submit(
    {
      outcome: 'completed',
      summary: 'ok',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: '',
    },
    exec.id,
  );
  item.review('accept', {
    attemptId: coord.id,
    submittedAttemptId: exec.id,
    reasons: ['ok'],
    requiredChanges: [],
    acceptanceResults: [{ criterion: 'foo() === 1', status: 'pass', evidence: 'ok' }],
    authority: { kind: 'validator', reportId: 'VR-1', policyRevision: 1 },
  });
  mission.recordResult({
    outcome: 'delivered',
    summary: '交付',
    acceptanceEvidence: ['ok'],
    memoryDelta: [],
    openRisks: [],
  });
  mission.submitForReview();
  const attempt = mission.startIndependentReviewerAttempt({
    contractRevision: mission.contractRevision,
    reviewedCommit: 'deadbeef',
    l2Fingerprint: 'fp-1',
    l2ReviewRefs: [{ workItemId: 'W-1', submittedAttemptId: exec.id }],
    validationReportId: 'VR-1',
  });
  attempt.recordProfile({ profileId: 'ir-a', endpoint: 'local' });
  mission.recordIndependentReview(attempt.id, {
    reviewerProfileId: 'ir-a',
    contractRevision: mission.contractRevision,
    reviewedCommit: 'deadbeef',
    l2ReviewRefs: [{ workItemId: 'W-1', submittedAttemptId: exec.id }],
    l2Fingerprint: 'fp-1',
    validationReportId: 'VR-1',
    verdict: 'pass',
    reasons: ['齐'],
    recordedAt: '2026-01-01T00:00:00.000Z',
  });
}

function seedAwaitingDelivered(
  project: Project,
  opts: { missionId: string; coordProfile?: UsedProfile | null },
): void {
  const mission = project.createMission({
    id: opts.missionId,
    contract: CONTRACT,
    executionMode: 'high_assurance',
  });
  mission.startExecuting();
  const coord = mission.startCoordinatorAttempt();
  if (opts.coordProfile !== null) {
    coord.recordProfile(opts.coordProfile ?? { profileId: 'coord-a', endpoint: 'local' });
  }
  coord.succeed();
  const item = mission.createWorkItem({ id: 'W-1', title: '改 foo', order: ORDER });
  item.dispatch();
  const exec = item.startAttempt();
  exec.recordProfile({ profileId: 'exec-a', endpoint: 'local' });
  exec.succeed();
  item.submit(
    {
      outcome: 'completed',
      summary: 'ok',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: '',
    },
    exec.id,
  );
  item.review('accept', {
    attemptId: coord.id,
    submittedAttemptId: exec.id,
    reasons: ['ok'],
    requiredChanges: [],
    acceptanceResults: [{ criterion: 'foo() === 1', status: 'pass', evidence: 'ok' }],
    authority: { kind: 'validator', reportId: 'VR-1', policyRevision: 1 },
  });
  mission.recordResult({
    outcome: 'delivered',
    summary: '交付',
    acceptanceEvidence: ['ok'],
    memoryDelta: [],
    openRisks: [],
  });
  mission.submitForReview();
}

describe('文件仓储：独立检视快照', () => {
  test('新快照读写后保留完整记录；旧快照缺字段恢复为空', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-e2-store-'));
    temps.push(dir);
    const path = join(dir, 'state.json');
    const store = new FileStateStore(path);
    const repo = new FileProjectRepository(store);
    const project = await repo.ensure('P');
    seedReviewed(project);
    await repo.save(project);

    const reopened = new FileProjectRepository(new FileStateStore(path));
    const again = await reopened.get('P');
    const mission = again?.missions.find((row) => row.id === 'M-store');
    assert.ok(mission);
    assert.equal(mission.independentReviewerAttempts.length, 1);
    assert.equal(mission.independentReviewerAttempts[0]?.kind, 'independent_reviewer');
    assert.equal(mission.independentReviews.length, 1);
    assert.equal(mission.independentReviews[0]?.verdict, 'pass');
    assert.equal(mission.independentReviews[0]?.reviewerProfileId, 'ir-a');
    assert.equal(mission.independentReviews[0]?.reviewedCommit, 'deadbeef');
    assert.equal(mission.independentReviewOpen?.attemptId, mission.independentReviewerAttempts[0]?.id);

    const legacyPath = join(dir, 'legacy.json');
    const legacyMission: MissionSnapshot = {
      id: 'M-old',
      projectId: 'P-old',
      status: 'awaiting_review',
      contractRevision: 1,
      planRevision: 0,
      escalations: [],
      workItems: [],
      coordinatorAttempts: [],
      coordinatorSeq: 0,
    };
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        projects: [{ id: 'P-old', missions: [legacyMission] }],
        deliveries: [],
        events: [],
        idCounters: {},
      }),
      'utf8',
    );
    const legacy = await new FileProjectRepository(new FileStateStore(legacyPath)).get('P-old');
    const old = legacy?.missions[0];
    assert.ok(old);
    assert.deepEqual(old.independentReviewerAttempts, []);
    assert.deepEqual(old.independentReviews, []);
    assert.equal(old.independentReviewBlockReason, undefined);
    assert.equal(old.independentReviewOpen, undefined);
  });
});

describe('PG 仓储：独立检视快照', () => {
  test('新快照经 PG 读写后保留完整记录；不可用时记未验证', async (t) => {
    const dsn = await ensureTestDatabase('e2reviewer');
    if (!dsn) {
      t.skip('未验证：没有可用的 Postgres');
      return;
    }
    const store = await PgStateStore.open({ connectionString: dsn });
    try {
      await store.pool.query('TRUNCATE projects');
      // open 时已把库里的旧快照读进内存；只清表不清内存的话，上一轮留下的 M-store 会让这一轮建单撞重。
      await store.refresh();
      const repo = new PgProjectRepository(store);
      const project = await repo.ensure('P-pg');
      seedReviewed(project);
      await repo.save(project);

      const other = await PgStateStore.open({ connectionString: dsn });
      try {
        const read = await new PgProjectRepository(other).get('P-pg');
        const mission = read?.missions.find((row) => row.id === 'M-store');
        assert.ok(mission);
        assert.equal(mission.independentReviewerAttempts.length, 1);
        assert.equal(mission.independentReviews[0]?.verdict, 'pass');
        assert.equal(mission.independentReviews[0]?.reviewerAttemptId, mission.independentReviewerAttempts[0]?.id);
      } finally {
        await other.close();
      }
    } finally {
      await store.close();
    }
  });
});

/**
 * 三种开不出检视的情形各占一个 Project：同一 Project 同一时刻只能有一条未到终态的改动型
 * Mission（kernel 不变式），三条挤在一个 Project 里，第二条连 startExecuting 都过不去。
 */
const BLOCK_CASES = [
  { projectId: 'P-block-nocand', missionId: 'M-nocand', coordProfile: undefined },
  { projectId: 'P-block-conflict', missionId: 'M-conflict', coordProfile: undefined },
  { projectId: 'P-block-noprofile', missionId: 'M-noprofile', coordProfile: null },
] as const;

describe('文件仓储：验收2 阻塞原因持久化', () => {
  test('拒绝开检视后重开仓储，原因仍是 no_candidates / all_candidates_conflict / history_missing_profile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-e2-block-'));
    temps.push(dir);
    const path = join(dir, 'state.json');
    const store = new FileStateStore(path);
    const repo = new FileProjectRepository(store);
    const clock = new FixedClock();
    const platform = new Platform({
      projects: repo,
      deliveries: new InMemoryDeliveryRepository(clock, new SequentialIds()),
      activity: new FileActivityLog(store, clock),
      clock,
      ids: new SequentialIds(),
      transaction: store,
    });
    for (const { projectId, missionId, coordProfile } of BLOCK_CASES) {
      const project = await repo.ensure(projectId);
      seedAwaitingDelivered(project, { missionId, coordProfile });
      await repo.save(project);
    }

    await assert.rejects(
      () => platform.startIndependentReviewerAttempt('M-nocand', []),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'INDEPENDENT_REVIEW_NO_CANDIDATES',
    );
    await assert.rejects(
      () =>
        platform.startIndependentReviewerAttempt('M-conflict', [
          { profileId: 'coord-a', endpoint: 'local' },
          { profileId: 'exec-a', endpoint: 'local' },
        ]),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'INDEPENDENT_REVIEW_ALL_CONFLICT',
    );
    await assert.rejects(
      () =>
        platform.startIndependentReviewerAttempt('M-noprofile', [
          { profileId: 'ir-a', endpoint: 'local' },
        ]),
      (err: unknown) =>
        err instanceof PlatformRuleError &&
        err.code === 'INDEPENDENT_REVIEW_HISTORY_MISSING_PROFILE',
    );

    const reopened = new FileProjectRepository(new FileStateStore(path));
    const readBack = async (projectId: string, missionId: string) =>
      (await reopened.get(projectId))?.missions.find((row) => row.id === missionId);
    const nocand = await readBack('P-block-nocand', 'M-nocand');
    const conflict = await readBack('P-block-conflict', 'M-conflict');
    const noprofile = await readBack('P-block-noprofile', 'M-noprofile');
    assert.equal(nocand?.status, 'awaiting_review');
    assert.equal(nocand?.independentReviewBlockReason, 'no_candidates');
    assert.equal(nocand?.independentReviewerAttempts.length, 0);
    assert.equal(conflict?.independentReviewBlockReason, 'all_candidates_conflict');
    assert.equal(noprofile?.independentReviewBlockReason, 'history_missing_profile');
  });
});

describe('PG 仓储：验收2 阻塞原因持久化', () => {
  test('拒绝开检视后重开仓储，原因仍可查询；不可用时记未验证', async (t) => {
    const dsn = await ensureTestDatabase('e2reviewerblock');
    if (!dsn) {
      t.skip('未验证：没有可用的 Postgres');
      return;
    }
    const store = await PgStateStore.open({ connectionString: dsn });
    try {
      await store.pool.query('TRUNCATE projects');
      await store.refresh();
      const repo = new PgProjectRepository(store);
      const clock = new FixedClock();
      const platform = new Platform({
        projects: repo,
        deliveries: new InMemoryDeliveryRepository(clock, new SequentialIds()),
        activity: new PgActivityLog(store, clock),
        clock,
        ids: new SequentialIds(),
        transaction: store,
      });
      for (const { projectId, missionId, coordProfile } of BLOCK_CASES) {
        const project = await repo.ensure(projectId);
        seedAwaitingDelivered(project, { missionId, coordProfile });
        await repo.save(project);
      }

      await assert.rejects(
        () => platform.startIndependentReviewerAttempt('M-nocand', []),
        (err: unknown) =>
          err instanceof PlatformRuleError && err.code === 'INDEPENDENT_REVIEW_NO_CANDIDATES',
      );
      await assert.rejects(
        () =>
          platform.startIndependentReviewerAttempt('M-conflict', [
            { profileId: 'coord-a', endpoint: 'local' },
            { profileId: 'exec-a', endpoint: 'local' },
          ]),
        (err: unknown) =>
          err instanceof PlatformRuleError && err.code === 'INDEPENDENT_REVIEW_ALL_CONFLICT',
      );
      await assert.rejects(
        () =>
          platform.startIndependentReviewerAttempt('M-noprofile', [
            { profileId: 'ir-a', endpoint: 'local' },
          ]),
        (err: unknown) =>
          err instanceof PlatformRuleError &&
          err.code === 'INDEPENDENT_REVIEW_HISTORY_MISSING_PROFILE',
      );

      const other = await PgStateStore.open({ connectionString: dsn });
      try {
        const otherRepo = new PgProjectRepository(other);
        const readBack = async (projectId: string, missionId: string) =>
          (await otherRepo.get(projectId))?.missions.find((row) => row.id === missionId);
        assert.equal(
          (await readBack('P-block-nocand', 'M-nocand'))?.independentReviewBlockReason,
          'no_candidates',
        );
        assert.equal(
          (await readBack('P-block-conflict', 'M-conflict'))?.independentReviewBlockReason,
          'all_candidates_conflict',
        );
        assert.equal(
          (await readBack('P-block-noprofile', 'M-noprofile'))?.independentReviewBlockReason,
          'history_missing_profile',
        );
      } finally {
        await other.close();
      }
    } finally {
      await store.close();
    }
  });
});
