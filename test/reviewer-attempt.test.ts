/**
 * E2：独立检视 Attempt 的领域与平台路径。
 * 验收 1、2、4、5、6。不替换 process.stdout.write。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform, PlatformRuleError } from '../src/application/platform.ts';
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
import type { WorkspaceManager } from '../src/application/workspace.ts';
import type {
  MissionContract,
  UsedProfile,
  ValidationReport,
  WorkOrder,
} from '../src/kernel/index.ts';
import { Project } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: 'HA 独立检视夹具',
  acceptance: ['证据齐'],
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

const REPORT: ValidationReport = {
  id: 'VR-1',
  policyRevision: 1,
  missionId: 'M-ha',
  workItemId: 'W-1',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:00:01.000Z',
  passed: true,
  checks: [],
};

class MutableHeadWorkspace implements WorkspaceManager {
  headValue = 'commit-aaa';

  async prepare(_missionId: string, projectRoot: string) {
    return {
      cwd: projectRoot,
      branch: '(in-place)',
      targetBranch: '(in-place)',
      baseRevision: this.headValue,
    };
  }

  async head(): Promise<string> {
    return this.headValue;
  }

  async targetHead(): Promise<string> {
    return this.headValue;
  }

  async rollback(): Promise<void> {}

  async mergeToTarget(): Promise<{ ok: true; mergedInto: string }> {
    return { ok: true, mergedInto: 'in-place' };
  }

  async diff(): Promise<{ stat: string; files: string[] }> {
    return { stat: '', files: [] };
  }

  async release(): Promise<void> {}
}

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-e2-'));
  temps.push(dir);
  return dir;
}

function seedDeliveredHa(
  project: Project,
  opts: {
    missionId?: string;
    coordProfile?: UsedProfile | null;
    execProfile?: UsedProfile | null;
    reportId?: string;
    projectRoot: string;
    /** 缺省完整 L2；负例用来造缺 review / 缺逐条 / 错 reviewAttemptId。 */
    l2?: 'complete' | 'missing_review' | 'missing_acceptance' | 'wrong_review_attempt';
  },
) {
  const missionId = opts.missionId ?? 'M-ha';
  // 这里测的是 E2 的检视机制（独立性、记录绑定、打回、HEAD 复核），用 L2 的 validator 报告作引用。
  // E3a 起 HA 开审只认当前 HEAD 上的 HA 确定性报告、不回退 L2 报告，那条路径由
  // test/independent-reviewer.test.ts 覆盖；这里改用 standard，机制照测，不和 HA 的新闸打架。
  const mission = project.createMission({
    id: missionId,
    contract: CONTRACT,
    executionMode: 'standard',
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
  if (opts.execProfile !== null) {
    exec.recordProfile(opts.execProfile ?? { profileId: 'exec-a', endpoint: 'local' });
  }
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
  if (opts.l2 === 'missing_review') {
    item.review('accept');
  } else if (opts.l2 === 'missing_acceptance') {
    item.review('accept', {
      attemptId: coord.id,
      submittedAttemptId: exec.id,
      reasons: ['ok'],
      requiredChanges: [],
      authority: {
        kind: 'validator',
        reportId: opts.reportId ?? 'VR-1',
        policyRevision: 1,
      },
    });
  } else if (opts.l2 === 'wrong_review_attempt') {
    item.review('accept', {
      attemptId: 'review-wrong',
      submittedAttemptId: exec.id,
      reasons: ['ok'],
      requiredChanges: [],
      acceptanceResults: ORDER.acceptance.map((criterion) => ({
        criterion,
        status: 'pass',
        evidence: 'node --test 退出码 0',
      })),
      authority: {
        kind: 'validator',
        reportId: opts.reportId ?? 'VR-1',
        policyRevision: 1,
      },
    });
  } else {
    item.review('accept', {
      attemptId: coord.id,
      submittedAttemptId: exec.id,
      reasons: ['ok'],
      requiredChanges: [],
      acceptanceResults: ORDER.acceptance.map((criterion) => ({
        criterion,
        status: 'pass',
        evidence: 'node --test 退出码 0',
      })),
      authority: {
        kind: 'validator',
        reportId: opts.reportId ?? 'VR-1',
        policyRevision: 1,
      },
    });
  }
  mission.recordResult({
    outcome: 'delivered',
    summary: '交付',
    acceptanceEvidence: ['ok'],
    memoryDelta: [],
    openRisks: [],
  });
  mission.submitForReview();
  mission.recordWorkspace({
    projectRoot: opts.projectRoot,
    branch: `mission/${missionId}`,
    baseRevision: 'base',
  });
  return mission;
}

async function harness(opts?: { head?: string }) {
  const clock = new FixedClock();
  const projects = new InMemoryProjectRepository();
  const reports = new InMemoryValidationReportRepository();
  const workspace = new MutableHeadWorkspace();
  if (opts?.head) workspace.headValue = opts.head;
  const platform = new Platform({
    projects,
    deliveries: new InMemoryDeliveryRepository(clock, new SequentialIds()),
    activity: new InMemoryActivityLog(clock),
    clock,
    ids: new SequentialIds(),
    workspace,
    validation: {
      engine: {
        async validate() {
          throw new Error('E2 测试不跑 ValidationEngine');
        },
      },
      reports,
    },
  });
  const root = tempRoot();
  const project = await projects.ensure('P');
  return { platform, projects, project, reports, workspace, root };
}

describe('独立检视 Attempt：开牌与独立性', () => {
  test('验收1：awaiting_review + delivered 能从独立候选开 Attempt，profileId 与历史协调者执行者都不同', async () => {
    const { platform, project, reports, root } = await harness();
    seedDeliveredHa(project, { projectRoot: root });
    await reports.save({ ...REPORT, missionId: 'M-ha' });
    const opened = await platform.startIndependentReviewerAttempt('M-ha', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    assert.equal(opened.profileId, 'ir-a');
    const view = await platform.getMissionView('M-ha');
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.independentReviewerAttemptIds.length, 1);
    const detail = await platform.getAttemptDetail('M-ha', opened.attemptId);
    assert.equal(detail.kind, 'independent_reviewer');
    assert.equal(detail.profile?.profileId, 'ir-a');
    assert.notEqual(detail.profile?.profileId, 'coord-a');
    assert.notEqual(detail.profile?.profileId, 'exec-a');
  });

  test('验收2：无候选时不开 Attempt，保持 awaiting_review，原因可查询，不回落协调者', async () => {
    const { platform, project, root } = await harness();
    seedDeliveredHa(project, { projectRoot: root });
    await assert.rejects(
      () => platform.startIndependentReviewerAttempt('M-ha', []),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'INDEPENDENT_REVIEW_NO_CANDIDATES',
    );
    const view = await platform.getMissionView('M-ha');
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.independentReviewerAttemptIds.length, 0);
    assert.equal(view.independentReviewBlockReason, 'no_candidates');
    assert.ok(view.independentReviewBlockDetail);
  });

  test('验收2：候选全部冲突时不开，不拿协调者自审', async () => {
    const { platform, project, root } = await harness();
    seedDeliveredHa(project, { projectRoot: root });
    await assert.rejects(
      () =>
        platform.startIndependentReviewerAttempt('M-ha', [
          { profileId: 'coord-a', endpoint: 'local' },
          { profileId: 'exec-a', endpoint: 'local' },
        ]),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'INDEPENDENT_REVIEW_ALL_CONFLICT',
    );
    const view = await platform.getMissionView('M-ha');
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.independentReviewBlockReason, 'all_candidates_conflict');
    assert.equal(view.independentReviewerAttemptIds.length, 0);
  });

  test('验收2：历史参与 Attempt 缺 profileId 时不开', async () => {
    const { platform, project, root } = await harness();
    seedDeliveredHa(project, { projectRoot: root, coordProfile: null });
    await assert.rejects(
      () =>
        platform.startIndependentReviewerAttempt('M-ha', [
          { profileId: 'ir-a', endpoint: 'local' },
        ]),
      (err: unknown) =>
        err instanceof PlatformRuleError &&
        err.code === 'INDEPENDENT_REVIEW_HISTORY_MISSING_PROFILE',
    );
    const view = await platform.getMissionView('M-ha');
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.independentReviewBlockReason, 'history_missing_profile');
  });
});

describe('独立检视结论', () => {
  test('验收4：pass 持久记录含绑定字段；缺报告不能 pass', async () => {
    const { platform, project, reports, root } = await harness();
    seedDeliveredHa(project, { projectRoot: root });
    const opened = await platform.startIndependentReviewerAttempt('M-ha', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    await assert.rejects(
      () =>
        platform.submitIndependentReview('M-ha', opened.attemptId, {
          verdict: 'pass',
          reasons: ['看起来齐'],
        }),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'INDEPENDENT_REVIEW_REPORT_MISSING',
    );
    await reports.save({ ...REPORT, missionId: 'M-ha' });
    const { recorded } = await platform.submitIndependentReview('M-ha', opened.attemptId, {
      verdict: 'pass',
      reasons: ['证据齐、结论可交'],
    });
    assert.equal(recorded.missionId, 'M-ha');
    assert.equal(recorded.reviewerAttemptId, opened.attemptId);
    assert.equal(recorded.reviewerProfileId, 'ir-a');
    assert.equal(recorded.contractRevision, 1);
    assert.equal(recorded.reviewedCommit, 'commit-aaa');
    assert.equal(recorded.validationReportId, 'VR-1');
    assert.ok(recorded.l2ReviewRefs.length > 0);
    assert.equal(recorded.verdict, 'pass');
    assert.deepEqual(recorded.reasons, ['证据齐、结论可交']);
    assert.ok(recorded.recordedAt);
  });

  test('验收4：引用不属本 Mission 的报告不能 pass', async () => {
    const { platform, project, reports, root } = await harness();
    seedDeliveredHa(project, { projectRoot: root, reportId: 'VR-other' });
    await reports.save({ ...REPORT, id: 'VR-other', missionId: 'M-other' });
    const opened = await platform.startIndependentReviewerAttempt('M-ha', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    await assert.rejects(
      () =>
        platform.submitIndependentReview('M-ha', opened.attemptId, {
          verdict: 'pass',
          reasons: ['错报告'],
        }),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'INDEPENDENT_REVIEW_REPORT_MISSING',
    );
  });

  test('验收4：缺 ReviewRecord 时拒收 pass', async () => {
    const { platform, project, reports, root } = await harness();
    seedDeliveredHa(project, { projectRoot: root, l2: 'missing_review' });
    await reports.save({ ...REPORT, missionId: 'M-ha' });
    const opened = await platform.startIndependentReviewerAttempt('M-ha', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    await assert.rejects(
      () =>
        platform.submitIndependentReview('M-ha', opened.attemptId, {
          verdict: 'pass',
          reasons: ['没有真实 L2 review 也想 pass'],
        }),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'INDEPENDENT_REVIEW_L2_MISSING',
    );
  });

  test('验收4：缺逐条 acceptanceResults 时拒收 pass', async () => {
    const { platform, project, reports, root } = await harness();
    seedDeliveredHa(project, { projectRoot: root, l2: 'missing_acceptance' });
    await reports.save({ ...REPORT, missionId: 'M-ha' });
    const opened = await platform.startIndependentReviewerAttempt('M-ha', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    await assert.rejects(
      () =>
        platform.submitIndependentReview('M-ha', opened.attemptId, {
          verdict: 'pass',
          reasons: ['缺逐条结果也想 pass'],
        }),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'INDEPENDENT_REVIEW_L2_MISSING',
    );
  });

  test('验收4：错 reviewAttemptId 时拒收 pass', async () => {
    const { platform, project, reports, root } = await harness();
    seedDeliveredHa(project, { projectRoot: root, l2: 'wrong_review_attempt' });
    await reports.save({ ...REPORT, missionId: 'M-ha' });
    const opened = await platform.startIndependentReviewerAttempt('M-ha', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    await assert.rejects(
      () =>
        platform.submitIndependentReview('M-ha', opened.attemptId, {
          verdict: 'pass',
          reasons: ['reviewAttemptId 对不上也想 pass'],
        }),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'INDEPENDENT_REVIEW_L2_MISSING',
    );
  });

  test('验收5：send_back 不改 L2，也不流转 planning / completed', async () => {
    const { platform, project, root } = await harness();
    const mission = seedDeliveredHa(project, { projectRoot: root });
    const before = mission.workItem('W-1')!.reviews.length;
    const opened = await platform.startIndependentReviewerAttempt('M-ha', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    await platform.submitIndependentReview('M-ha', opened.attemptId, {
      verdict: 'send_back',
      reasons: ['缺一份对照'],
    });
    const view = await platform.getMissionView('M-ha');
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.finalReview, undefined);
    assert.equal(mission.workItem('W-1')!.reviews.length, before);
    assert.equal(view.independentReviews[0]?.verdict, 'send_back');
    const pass = await platform.effectiveIndependentReviewPass('M-ha');
    assert.equal(pass, undefined);
  });

  test('验收5：HEAD 变化后旧 pass 不再有效；revision 变化同样失效', async () => {
    const { platform, project, reports, workspace, root } = await harness();
    seedDeliveredHa(project, { projectRoot: root });
    await reports.save({ ...REPORT, missionId: 'M-ha' });
    const opened = await platform.startIndependentReviewerAttempt('M-ha', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    await platform.submitIndependentReview('M-ha', opened.attemptId, {
      verdict: 'pass',
      reasons: ['当时齐'],
    });
    assert.ok(await platform.effectiveIndependentReviewPass('M-ha'));
    workspace.headValue = 'commit-bbb';
    assert.equal(await platform.effectiveIndependentReviewPass('M-ha'), undefined);
    assert.equal((await platform.getMissionView('M-ha')).status, 'awaiting_review');

    const h2 = await harness();
    const m2 = seedDeliveredHa(h2.project, { projectRoot: h2.root });
    await h2.reports.save({ ...REPORT, missionId: 'M-ha' });
    const o2 = await h2.platform.startIndependentReviewerAttempt('M-ha', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    await h2.platform.submitIndependentReview('M-ha', o2.attemptId, {
      verdict: 'pass',
      reasons: ['当时齐'],
    });
    m2.reviseContract({ ...CONTRACT, intent: '改过的契约' });
    assert.equal(await h2.platform.effectiveIndependentReviewPass('M-ha'), undefined);
    assert.equal((await h2.platform.getMissionView('M-ha')).status, 'awaiting_review');
  });

  test('验收5：开 Attempt 后 HEAD 变化则拒收 pass', async () => {
    const { platform, project, reports, workspace, root } = await harness();
    seedDeliveredHa(project, { projectRoot: root });
    await reports.save({ ...REPORT, missionId: 'M-ha' });
    const opened = await platform.startIndependentReviewerAttempt('M-ha', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    workspace.headValue = 'commit-bbb';
    await assert.rejects(
      () =>
        platform.submitIndependentReview('M-ha', opened.attemptId, {
          verdict: 'pass',
          reasons: ['HEAD 已经变了还想 pass'],
        }),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'INDEPENDENT_REVIEW_HEAD_CHANGED',
    );
  });

  test('验收6：重复提交不得覆盖；并发开第二张牌被拒', async () => {
    const { platform, project, reports, root } = await harness();
    seedDeliveredHa(project, { projectRoot: root });
    await reports.save({ ...REPORT, missionId: 'M-ha' });
    const opened = await platform.startIndependentReviewerAttempt('M-ha', [
      { profileId: 'ir-a', endpoint: 'local' },
    ]);
    await assert.rejects(
      () =>
        platform.startIndependentReviewerAttempt('M-ha', [
          { profileId: 'ir-b', endpoint: 'local' },
        ]),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'INDEPENDENT_REVIEW_CONCURRENT',
    );
    const first = await platform.submitIndependentReview('M-ha', opened.attemptId, {
      verdict: 'send_back',
      reasons: ['先记下'],
    });
    await assert.rejects(
      () =>
        platform.submitIndependentReview('M-ha', opened.attemptId, {
          verdict: 'pass',
          reasons: ['想覆盖'],
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return (err as { code?: string }).code === 'INDEPENDENT_REVIEW_ALREADY_RECORDED';
      },
    );
    const view = await platform.getMissionView('M-ha');
    assert.equal(view.independentReviews.length, 1);
    assert.equal(view.independentReviews[0]?.verdict, first.recorded.verdict);
  });
});
