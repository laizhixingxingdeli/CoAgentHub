/**
 * PROMO-001：Lightweight → Standard trusted promotion foundation。
 *
 * 守住：
 *   - Platform 仅进程内入口；caller 只传 trigger code/rule
 *   - usage / evidence / validation / HEAD 全部从 trusted state 采样
 *   - budget_exceeded 在 BUDGET-001 前拒绝
 *   - 成功 save + 恰好一条 mission.promoted；幂等不重发
 *   - 不丢 WorkItems / Attempts / evidence / workspace
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform, PlatformRuleError } from '../src/application/platform.ts';
import type { WorkspaceManager } from '../src/application/workspace.ts';
import type {
  MissionContract,
  PromotionRecord,
  PromotionTriggerCode,
  ReviewRecord,
  TokenUsage,
  WorkOrder,
} from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: ['不加依赖'],
  nonGoals: ['不重构 Y'],
  guardrails: ['不得改 Contract'],
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
  validation: {
    commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }],
  },
};

function harness(opts?: { workspace?: WorkspaceManager }) {
  const clock = new FixedClock('2026-06-01T12:00:00.000Z');
  const activity = new InMemoryActivityLog(clock);
  const projects = new InMemoryProjectRepository();
  const ids = new SequentialIds();
  const platform = new Platform({
    projects,
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    activity,
    clock,
    ids,
    ...(opts?.workspace ? { workspace: opts.workspace } : {}),
  });
  return { platform, activity, projects, ids, clock };
}

async function createLightweight(
  projects: InMemoryProjectRepository,
  opts: {
    projectId?: string;
    missionId?: string;
    status?: 'investigating' | 'planning' | 'executing';
  } = {},
) {
  const projectId = opts.projectId ?? 'P';
  const missionId = opts.missionId ?? 'M-promo';
  const project = await projects.ensure(projectId);
  const mission = project.createMission({
    id: missionId,
    contract: CONTRACT,
    executionMode: 'lightweight',
    runKind: 'mutation',
  });
  if (opts.status === 'planning') mission.startPlanning();
  if (opts.status === 'executing') mission.startExecuting();
  await projects.save(project);
  return { projectId, missionId, mission };
}

function fakeWorkspace(opts: {
  head?: string | (() => Promise<string>);
  worktreePath?: string;
  throwHead?: boolean;
}): WorkspaceManager {
  return {
    async prepare() {
      return {
        cwd: opts.worktreePath ?? '/wt',
        branch: 'mission/x',
        baseRevision: 'BASE-SHOULD-NOT-APPEAR',
        targetBranch: 'main',
      };
    },
    async head() {
      if (opts.throwHead) throw new Error('git failed');
      if (typeof opts.head === 'function') return opts.head();
      return opts.head ?? 'HEAD-NOW';
    },
    async targetHead() {
      return 'target';
    },
    async rollback() {},
    async mergeToTarget() {
      return { ok: true as const, mergedInto: 'main' };
    },
    async diff() {
      return { stat: '', files: [] };
    },
    async release() {},
    worktreePath: opts.worktreePath
      ? () => opts.worktreePath
      : undefined,
  } as WorkspaceManager;
}

function codeOf(e: unknown): string | undefined {
  return (e as { code?: string } | undefined)?.code;
}

describe('Platform.promoteMissionToStandard', () => {
  test('trusted promote from investigating/planning/executing；MissionView.promotions 可见', async () => {
    for (const status of ['investigating', 'planning', 'executing'] as const) {
      const h = harness();
      const { missionId } = await createLightweight(h.projects, {
        missionId: `M-${status}`,
        status,
      });

      const out = await h.platform.promoteMissionToStandard(missionId, {
        code: 'design_decision',
        rule: `promote from ${status}`,
      });
      assert.equal(out.changed, true);
      assert.equal(out.promotion.fromStatus, status);
      assert.equal(
        out.promotion.toStatus,
        status === 'executing' ? 'planning' : status,
      );

      const view = await h.platform.getMissionView(missionId);
      assert.equal(view.executionMode, 'standard');
      assert.equal(view.status, status === 'executing' ? 'planning' : status);
      assert.equal(view.promotions.length, 1);
      assert.equal(view.promotions[0]!.triggerCode, 'design_decision');
      assert.equal(view.promotions[0]!.triggerRule, `promote from ${status}`);

      if (status === 'executing') {
        assert.equal(view.isMutating, true);
      }
    }
  });

  test('attempt usage + evidence 汇总正确；cost 不伪造；unknown dimensions 稳定', async () => {
    const h = harness();
    const { missionId, projectId } = await createLightweight(h.projects);
    const { workItemId } = await h.platform.createLightweightWorkItem(missionId, {
      order: ORDER,
    });
    await h.platform.dispatchLightweightWorkItem(missionId, workItemId);
    const { attemptId } = await h.platform.startExecutorAttempt(missionId, workItemId);

    await h.platform.submitEvidence(missionId, attemptId, {
      kind: 'test',
      summary: 'green',
      command: 'node --test',
      exitCode: 0,
    });
    await h.platform.submitEvidence(missionId, attemptId, {
      kind: 'diff',
      summary: 'changed foo',
    });

    // 直接在聚合上写 reported usage（Platform 无独立 recordUsage 入口时）。
    const project = await h.projects.get(projectId);
    assert.ok(project);
    const mission = project.missions.find((m) => m.id === missionId)!;
    const attempt = mission.attempt(attemptId)!;
    const usage: TokenUsage = {
      input: 100,
      output: 40,
      cacheRead: 10,
      cacheWrite: 5,
      total: 155,
      cost: 9.99,
      quality: 'reported',
    };
    attempt.recordUsage(usage);
    await h.projects.save(project);

    const out = await h.platform.promoteMissionToStandard(missionId, {
      code: 'changed_files_gt_3',
      rule: 'files > 3',
    });

    assert.equal(typeof out.promotion.id, 'string');
    assert.ok(out.promotion.id.length > 0);
    assert.equal(out.promotion.consumedUsage.attemptCount, 1);
    assert.ok(out.promotion.consumedUsage.tokenUsage);
    assert.deepEqual(out.promotion.consumedUsage.tokenUsage, {
      input: 100,
      output: 40,
      cacheRead: 10,
      cacheWrite: 5,
      total: 155,
      quality: 'reported',
    });
    assert.equal('cost' in out.promotion.consumedUsage.tokenUsage!, false);
    assert.equal(out.promotion.consumedUsage.budgetAuthoritative, false);
    assert.deepEqual(out.promotion.consumedUsage.dimensionsUnknown, [
      'cost',
      'wallClockMs',
      'rounds',
      'changedFiles',
      'commands',
      'budgetRemaining',
    ]);
    assert.deepEqual(out.promotion.evidenceIds, [
      attempt.evidence[0]!.id,
      attempt.evidence[1]!.id,
    ]);
  });

  test('mixed reported + unknown usage：只累加 known；tokens 进 dimensionsUnknown', async () => {
    const h = harness();
    const { missionId, projectId } = await createLightweight(h.projects, {
      missionId: 'M-mixed',
    });
    const { workItemId } = await h.platform.createLightweightWorkItem(missionId, {
      order: ORDER,
    });
    await h.platform.dispatchLightweightWorkItem(missionId, workItemId);
    const a1 = await h.platform.startExecutorAttempt(missionId, workItemId);

    const project = await h.projects.get(projectId);
    assert.ok(project);
    const mission = project.missions.find((m) => m.id === missionId)!;
    const attempt1 = mission.attempt(a1.attemptId)!;
    attempt1.recordUsage({
      input: 50,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      total: 60,
      quality: 'reported',
    });
    // 第二条 attempt 保持默认 unknown usage（EMPTY_USAGE）。
    const item = mission.workItem(workItemId)!;
    // 先结束 a1 才能再开 attempt。
    attempt1.succeed();
    const attempt2 = item.startAttempt();
    assert.equal(attempt2.usage.quality, 'unknown');
    await h.projects.save(project);

    const out = await h.platform.promoteMissionToStandard(missionId, {
      code: 'changed_files_gt_3',
      rule: 'mixed usage',
    });
    assert.equal(out.promotion.consumedUsage.attemptCount, 2);
    assert.deepEqual(out.promotion.consumedUsage.tokenUsage, {
      input: 50,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      total: 60,
      quality: 'reported',
    });
    assert.ok(out.promotion.consumedUsage.dimensionsUnknown.includes('tokens'));
  });

  test('validator ReviewRecord reportId 进入 validationReportIds', async () => {
    const h = harness();
    const { missionId, projectId } = await createLightweight(h.projects);
    const { workItemId } = await h.platform.createLightweightWorkItem(missionId, {
      order: ORDER,
    });
    await h.platform.dispatchLightweightWorkItem(missionId, workItemId);
    const { attemptId } = await h.platform.startExecutorAttempt(missionId, workItemId);
    await h.platform.submitEvidence(missionId, attemptId, {
      kind: 'test',
      summary: 'ok',
      exitCode: 0,
    });
    await h.platform.submitExecutionResult(missionId, attemptId, {
      outcome: 'completed',
      summary: 'done',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: '',
    });

    const project = await h.projects.get(projectId);
    assert.ok(project);
    const mission = project.missions.find((m) => m.id === missionId)!;
    const item = mission.workItem(workItemId)!;
    const review: Omit<ReviewRecord, 'verdict'> = {
      submittedAttemptId: attemptId,
      authority: {
        kind: 'validator',
        reportId: 'VR-trusted-1',
        policyRevision: 1,
      },
      reasons: ['machine pass'],
      requiredChanges: [],
    };
    item.review('accept', review);
    await h.projects.save(project);

    const out = await h.platform.promoteMissionToStandard(missionId, {
      code: 'validator_failure_unrepairable',
      rule: 'validator path',
    });
    assert.deepEqual(out.promotion.validationReportIds, ['VR-trusted-1']);
  });

  test('lightweight validation.reported 失败 reportId 计入 promotion（无 ReviewRecord）', async () => {
    const h = harness();
    const { missionId, projectId } = await createLightweight(h.projects);

    // 模拟 Lightweight validate 失败：只落 trusted validation.reported，不写 ReviewRecord。
    await h.activity.append({
      projectId,
      missionId,
      workItemId: 'w-light-fail',
      kind: 'validation.reported',
      data: {
        reportId: 'VR-fail-no-review',
        passed: false,
        submittedAttemptId: 'a-fail',
      },
    });

    const project = await h.projects.get(projectId);
    assert.ok(project);
    const mission = project.missions.find((m) => m.id === missionId)!;
    assert.equal(
      mission.workItems.reduce((n, item) => n + item.reviews.length, 0),
      0,
      '无 ReviewRecord 时仍须从 validation.reported 收集',
    );

    const out = await h.platform.promoteMissionToStandard(missionId, {
      code: 'validator_failure_unrepairable',
      rule: 'failed validation without review record',
    });
    assert.deepEqual(out.promotion.validationReportIds, ['VR-fail-no-review']);
  });

  test('workspace head 可信推导；throw/缺 manager/缺 root => unknown；不用 baseRevision', async () => {
    {
      const ws = fakeWorkspace({
        head: 'CURRENT-HEAD-999',
        worktreePath: '/worktrees/M-head',
      });
      const h = harness({ workspace: ws });
      const { missionId } = await createLightweight(h.projects, { missionId: 'M-head' });
      await h.platform.recordWorkspace(missionId, {
        projectRoot: '/proj',
        branch: 'mission/M-head',
        baseRevision: 'BASE-SHOULD-NOT-APPEAR',
      });
      const out = await h.platform.promoteMissionToStandard(missionId, {
        code: 'new_public_interface',
        rule: 'export added',
      });
      assert.deepEqual(out.promotion.workspaceRevision, {
        kind: 'head',
        revision: 'CURRENT-HEAD-999',
      });
    }

    {
      const ws = fakeWorkspace({ throwHead: true, worktreePath: '/wt' });
      const h = harness({ workspace: ws });
      const { missionId } = await createLightweight(h.projects, { missionId: 'M-throw' });
      await h.platform.recordWorkspace(missionId, {
        projectRoot: '/proj',
        branch: 'mission/M-throw',
        baseRevision: 'BASE-X',
      });
      const out = await h.platform.promoteMissionToStandard(missionId, {
        code: 'new_dependency',
        rule: 'dep',
      });
      assert.deepEqual(out.promotion.workspaceRevision, { kind: 'unknown' });
    }

    {
      const h = harness(); // no workspace manager
      const { missionId } = await createLightweight(h.projects, { missionId: 'M-nows' });
      await h.platform.recordWorkspace(missionId, {
        projectRoot: '/proj',
        branch: 'mission/M-nows',
        baseRevision: 'BASE-Y',
      });
      const out = await h.platform.promoteMissionToStandard(missionId, {
        code: 'persistence_format_change',
        rule: 'schema',
      });
      assert.deepEqual(out.promotion.workspaceRevision, { kind: 'unknown' });
    }

    {
      const ws = fakeWorkspace({ head: 'SHOULD-NOT-READ' });
      const h = harness({ workspace: ws });
      const { missionId } = await createLightweight(h.projects, { missionId: 'M-noroots' });
      // workspaceRef without projectRoot
      await h.platform.recordWorkspace(missionId, {
        branch: 'mission/M-noroots',
        baseRevision: 'BASE-Z',
      });
      const out = await h.platform.promoteMissionToStandard(missionId, {
        code: 'top_level_modules_gt_2',
        rule: 'modules',
      });
      assert.deepEqual(out.promotion.workspaceRevision, { kind: 'unknown' });
    }
  });

  test('budget_exceeded pre-BUDGET rejected before mutation/event', async () => {
    const h = harness();
    const { missionId, projectId } = await createLightweight(h.projects);
    await assert.rejects(
      () =>
        h.platform.promoteMissionToStandard(missionId, {
          code: 'budget_exceeded',
          rule: 'tokens > max',
        }),
      (err: unknown) => {
        assert.ok(err instanceof PlatformRuleError);
        assert.equal(err.code, 'BUDGET_PROMOTION_NOT_READY');
        return true;
      },
    );
    const project = await h.projects.get(projectId);
    const mission = project!.missions.find((m) => m.id === missionId)!;
    assert.equal(mission.executionMode, 'lightweight');
    assert.equal(mission.promotions.length, 0);
    const events = await h.activity.list(missionId);
    assert.equal(events.filter((e) => e.kind === 'mission.promoted').length, 0);
  });

  test('empty rule / invalid code rejected before mutation', async () => {
    const h = harness();
    const { missionId, projectId } = await createLightweight(h.projects);

    await assert.rejects(
      () =>
        h.platform.promoteMissionToStandard(missionId, {
          code: 'design_decision',
          rule: '   ',
        }),
      (err: unknown) => codeOf(err) === 'INVALID_PROMOTION_TRIGGER',
    );
    await assert.rejects(
      () =>
        h.platform.promoteMissionToStandard(missionId, {
          code: 'not_real' as PromotionTriggerCode,
          rule: 'x',
        }),
      (err: unknown) => codeOf(err) === 'INVALID_PROMOTION_TRIGGER',
    );

    const project = await h.projects.get(projectId);
    const mission = project!.missions.find((m) => m.id === missionId)!;
    assert.equal(mission.executionMode, 'lightweight');
    assert.equal(mission.promotions.length, 0);
  });

  test('successful call saves then emits one mission.promoted；retry 幂等无第二事件', async () => {
    const h = harness();
    const { missionId, projectId } = await createLightweight(h.projects, {
      missionId: 'M-evt',
    });

    const first = await h.platform.promoteMissionToStandard(missionId, {
      code: 'invalid_premise',
      rule: 'premise broken',
    });
    assert.equal(first.changed, true);

    // save 已落盘：重新 get 仍可见
    const reloaded = await h.projects.get(projectId);
    const live = reloaded!.missions.find((m) => m.id === missionId)!;
    assert.equal(live.executionMode, 'standard');
    assert.equal(live.promotions.length, 1);

    const events1 = await h.activity.list(missionId);
    const promoted1 = events1.filter((e) => e.kind === 'mission.promoted');
    assert.equal(promoted1.length, 1);
    const data = promoted1[0]!.data as Record<string, unknown>;
    assert.equal(promoted1[0]!.attemptId, undefined);
    assert.equal(typeof data.id, 'string');
    assert.ok((data.id as string).length > 0);
    assert.equal(data.id, first.promotion.id);
    assert.equal(data.oldMode, 'lightweight');
    assert.equal(data.newMode, 'standard');
    assert.equal(data.triggerCode, 'invalid_premise');
    assert.equal(data.triggerRule, 'premise broken');
    assert.ok(data.consumedUsage);
    assert.ok(Array.isArray(data.evidenceIds));
    assert.ok(Array.isArray(data.validationReportIds));
    assert.ok(data.workspaceRevision);
    assert.ok(Array.isArray(data.workItemIdsSnapshot));
    assert.equal(data.fromStatus, 'investigating');
    assert.equal(data.toStatus, 'investigating');
    assert.equal('attemptId' in data, false);

    const second = await h.platform.promoteMissionToStandard(missionId, {
      code: 'invalid_premise',
      rule: 'premise broken',
    });
    assert.equal(second.changed, false);
    assert.equal(second.promotion, live.promotions[0]);
    assert.equal(second.promotion.id, first.promotion.id);

    const events2 = await h.activity.list(missionId);
    assert.equal(events2.filter((e) => e.kind === 'mission.promoted').length, 1);
  });

  test('different trigger after promotion rejects；history stays one', async () => {
    const h = harness();
    const { missionId } = await createLightweight(h.projects, { missionId: 'M-diff' });
    await h.platform.promoteMissionToStandard(missionId, {
      code: 'design_decision',
      rule: 'first',
    });
    await assert.rejects(
      () =>
        h.platform.promoteMissionToStandard(missionId, {
          code: 'new_dependency',
          rule: 'second',
        }),
      (err: unknown) => codeOf(err) === 'PROMOTION_ALREADY_APPLIED',
    );
    const view = await h.platform.getMissionView(missionId);
    assert.equal(view.promotions.length, 1);
    assert.equal(view.promotions[0]!.triggerRule, 'first');
  });

  test('all-unknown usage omits tokenUsage and lists tokens dimension', async () => {
    const h = harness();
    const { missionId } = await createLightweight(h.projects, { missionId: 'M-unk' });
    const { workItemId } = await h.platform.createLightweightWorkItem(missionId, {
      order: ORDER,
    });
    await h.platform.dispatchLightweightWorkItem(missionId, workItemId);
    await h.platform.startExecutorAttempt(missionId, workItemId);

    const out = await h.platform.promoteMissionToStandard(missionId, {
      code: 'executor_ambiguity',
      rule: 'unclear',
    });
    assert.equal(out.promotion.consumedUsage.attemptCount, 1);
    assert.equal(out.promotion.consumedUsage.tokenUsage, undefined);
    assert.deepEqual(out.promotion.consumedUsage.dimensionsUnknown, [
      'tokens',
      'cost',
      'wallClockMs',
      'rounds',
      'changedFiles',
      'commands',
      'budgetRemaining',
    ]);
    assert.deepEqual(out.promotion.workItemIdsSnapshot, [workItemId]);
  });
});
