import { PlatformRuleError, type PlatformContext } from './context.ts';
import { queuedExecutionConfig } from './mission-queue.ts';
import type { Mission, FinalReviewAuthority, IndependentReviewRecord, ValidationReport } from '../../kernel/index.ts';
import type { WorkspaceManager } from '../workspace.ts';
import { HA_AUTHORITY_CODE, matchHaRelease, type HaAuthorityConfig } from '../ha-authority-config.ts';
import { POLICY_ACTION, type evaluatePolicy } from '../policy-engine.ts';

interface HaFinalizationDeps {
  assertFinalizePolicy(input: Parameters<typeof evaluatePolicy>[0], haHumanMessage: string): void;
  reviewerAuthority(
    reviewerId: unknown,
    confirmedBy: unknown,
  ): Extract<FinalReviewAuthority, { kind: 'reviewer' }>;
  haWorktreePaths(
    workspace: WorkspaceManager,
    projectRoot: string,
  ): Promise<readonly string[]>;
  loadHaAuthority(
    repoRoot: string,
    worktreePaths: readonly string[],
  ): Promise<HaAuthorityConfig>;
  isForbiddenMaster(branch: string): boolean;
  wrapHaAuthorityError(error: unknown): PlatformRuleError;
  haUnsafe(
    missionId: string,
  ): Promise<{ reason: string } | undefined>;
  haUnsafeHint(reason: string): string;
  haMissionAlreadyInHead(
    workspace: WorkspaceManager,
    projectRoot: string,
    missionBranch: string,
    baseRevision: string,
    headNow: string,
  ): Promise<boolean>;
  markHaUnsafe(
    mission: Mission,
    reason: 'merged_unrecorded' | 'rollback_failed' | 'third_party_advanced' | 'advanced_during_verify',
    extra: { head?: string; anchor?: string; reportId?: string },
  ): Promise<void>;
  planLevelCommands(mission: Mission): { argv: string[]; timeoutMs: number }[];
  explicitHaCommands(
    missionId: string,
    commands: readonly { readonly argv: readonly string[]; readonly timeoutMs: number }[],
  ): { argv: string[]; timeoutMs: number }[];
  runIntegrationMergeVerify(input: {
    readonly mission: Mission;
    readonly projectRoot: string;
    readonly integrationBranch: string;
    readonly verification: readonly { readonly argv: readonly string[]; readonly timeoutMs: number }[];
  }): Promise<
    | { kind: 'merge_failed'; reason?: string; anchor: string }
    | {
        kind: 'verify_failed';
        mergedInto: string;
        report: ValidationReport;
        anchor: string;
        reset: { ok: boolean; reason?: string };
      }
    | { kind: 'verified'; mergedInto: string; report: ValidationReport; anchor: string }
    | {
        kind: 'advanced_during_verify';
        mergedInto: string;
        report: ValidationReport;
        anchor: string;
        checkout?: string;
        head: string;
      }
  >;
  effectiveIndependentReviewPass(
    missionId: string,
  ): Promise<IndependentReviewRecord | undefined>;
}

export async function finalizeMissionByHaAuthority(ctx: PlatformContext, deps: HaFinalizationDeps, 
    missionId: string,
    input: {
      readonly reviewerId: string;
      readonly confirmedBy: string;
      readonly projectRoot?: string;
      readonly reasons?: readonly string[];
      readonly verification?: readonly { readonly argv: readonly string[]; readonly timeoutMs: number }[];
    },
  ): Promise<{
    status: string;
    mergedInto?: string;
    reportId?: string;
    reason?: string;
    rolledBackTo?: string;
  }> {
    const { mission } = await ctx.locate(missionId);
    const queueConfig = await queuedExecutionConfig(ctx, missionId);
    if (queueConfig) input = { ...input, projectRoot: queueConfig.projectRoot, verification: queueConfig.verification };
    if (mission.executionMode !== 'high_assurance') {
      throw new PlatformRuleError(
        'HA_RELEASE_MODE_REQUIRED',
        `Mission ${missionId} 不是 high_assurance，不能走受控放行。`,
      );
    }
    if (mission.status === 'completed') {
      // 已完成的重复调用不得再验、再写报告，也不二次合并。
      return {
        status: mission.status,
        mergedInto: mission.finalReview?.mergedInto,
      };
    }
    if (mission.status !== 'awaiting_review') {
      throw new PlatformRuleError(
        'NOT_AWAITING_REVIEW',
        `Mission ${missionId} 现在是 ${mission.status}，没有在等最终检视。`,
      );
    }

    const authority = deps.reviewerAuthority(input.reviewerId, input.confirmedBy);
    deps.assertFinalizePolicy(
      {
        principal: { status: 'ok', kind: 'reviewer', id: authority.reviewerId },
        action: POLICY_ACTION.finalizeHaReviewer,
        context: { missionId },
        state: { executionMode: mission.executionMode },
      },
      `Mission ${missionId} 是 high_assurance：合并永远要人放行，机器 L3 不碰。`,
    );

    const projectRoot = input.projectRoot ?? mission.workspaceRef?.projectRoot;
    if (!ctx.workspace || !projectRoot) {
      throw new PlatformRuleError('NO_WORKSPACE_MANAGER', 'HA 放行要知道项目仓库在哪。');
    }
    const workspace = ctx.workspace;
    if (!workspace.currentBranch || !workspace.resetTarget || !workspace.listWorktreePaths) {
      throw new PlatformRuleError(
        'HA_RELEASE_UNAVAILABLE',
        '工作区管理不支持 currentBranch / resetTarget / listWorktreePaths，HA 放行不可用。',
      );
    }

    const worktreePaths = await deps.haWorktreePaths(workspace, projectRoot);
    const config = await deps.loadHaAuthority(projectRoot, worktreePaths);
    const registered = config.reviewers.find((row) => row.reviewerId === authority.reviewerId);
    if (!registered) {
      throw new PlatformRuleError(
        HA_AUTHORITY_CODE.REVIEWER_UNREGISTERED,
        'HA 放行拒绝（HA_AUTHORITY_REVIEWER_UNREGISTERED）：检视者未登记。',
      );
    }
    if (registered.confirmedBy !== authority.confirmedBy) {
      throw new PlatformRuleError(
        HA_AUTHORITY_CODE.CONFIRMED_BY_MISMATCH,
        'HA 放行拒绝（HA_AUTHORITY_CONFIRMED_BY_MISMATCH）：确认主体与登记值不一致。',
      );
    }

    const checkout = await workspace.currentBranch(projectRoot);
    if (!checkout) {
      throw new PlatformRuleError(
        'HA_DETACHED_HEAD',
        `Mission ${missionId} 项目仓是 detached HEAD，拒绝合并。`,
      );
    }
    const persistedTarget = mission.workspaceRef?.targetBranch;
    if (typeof persistedTarget !== 'string' || persistedTarget.trim() === '') {
      throw new PlatformRuleError(
        'HA_TARGET_MISSING',
        `Mission ${missionId} 没有可信的历史目标分支，拒绝用当前 checkout 倒填。`,
      );
    }
    if (deps.isForbiddenMaster(checkout) || deps.isForbiddenMaster(persistedTarget)) {
      throw new PlatformRuleError(
        HA_AUTHORITY_CODE.MASTER_FORBIDDEN,
        'HA 放行拒绝（HA_AUTHORITY_MASTER_FORBIDDEN）：master 不能作为常设代行目标。',
      );
    }
    if (checkout !== persistedTarget) {
      throw new PlatformRuleError(
        'HA_TARGET_MISMATCH',
        `当前 checkout（${checkout}）与 Mission 目标（${persistedTarget}）不一致，拒绝合并。`,
      );
    }
    try {
      matchHaRelease(config, {
        reviewerId: authority.reviewerId,
        confirmedBy: authority.confirmedBy,
        branch: persistedTarget,
      });
    } catch (error) {
      throw deps.wrapHaAuthorityError(error);
    }

    const unsafe = await deps.haUnsafe(missionId);
    if (unsafe) {
      return {
        status: mission.status,
        reason: deps.haUnsafeHint(unsafe.reason),
      };
    }

    const ref = mission.workspaceRef;
    if (!ref) {
      throw new PlatformRuleError('NO_WORKSPACE_REF', `Mission ${missionId} 没记下分支信息。`);
    }
    const headNow = await workspace.targetHead(projectRoot);
    if (headNow !== ref.baseRevision) {
      // revisionIsAncestor(ancestor, descendant) ↔ git merge-base --is-ancestor，
      // 不能把参数反了。「已合未记」要求 Mission 分支尖已在目标 HEAD 里，
      // 且那个尖不能还停在分叉基线——执行者改动常常还在 worktree
      // 未提交，分支仍等于基线；目标独自前进时基线仍是 HEAD 的祖先，
      // 那是旧基线，不是已合。git 失败时函数返 false，走旧基线拒绝（fail-closed），
      // 不会进合并。
      const alreadyMerged = await deps.haMissionAlreadyInHead(
        workspace,
        projectRoot,
        ref.branch,
        ref.baseRevision,
        headNow,
      );
      if (alreadyMerged) {
        await deps.markHaUnsafe(mission, 'merged_unrecorded', {
          head: headNow,
          anchor: ref.baseRevision,
        });
        return {
          status: mission.status,
          reason: deps.haUnsafeHint('merged_unrecorded'),
        };
      }
      throw new PlatformRuleError(
        'HA_STALE_BASELINE',
        `Mission ${missionId} 的分叉基线已过期，拒绝在任何 Git 合并前放行。`,
      );
    }

    const pass = await deps.effectiveIndependentReviewPass(missionId);
    if (!pass) {
      throw new PlatformRuleError(
        'HA_NO_EFFECTIVE_PASS',
        `Mission ${missionId} 没有当前有效的独立检视 pass，拒绝合并。`,
      );
    }

    const verification = input.verification === undefined
      ? deps.planLevelCommands(mission)
      : deps.explicitHaCommands(mission.id, input.verification);
    const runner = ctx.validation?.commandRunner;
    const reports = ctx.validation?.reports;
    if (!runner || !reports) {
      throw new PlatformRuleError(
        'MACHINE_FINALIZE_UNAVAILABLE',
        '没注入 commandRunner / reports，HA 放行不可用。不退化成不验直接合。',
      );
    }

    const outcome = await deps.runIntegrationMergeVerify({
      mission,
      projectRoot,
      integrationBranch: persistedTarget,
      verification,
    });
    if (outcome.kind === 'merge_failed') {
      mission.setWaitReason(
        'waiting_l3',
        `HA 合并失败：${outcome.reason ?? '（没给原因）'} 集成分支没动，等人处置。`,
      );
      await ctx.event(mission, 'final_review.merge_failed', {
        reason: outcome.reason,
        authority: 'reviewer',
      });
      await ctx.event(mission, 'mission.waiting', { reason: 'waiting_l3' });
      return { status: mission.status, reason: outcome.reason };
    }
    if (outcome.kind === 'verify_failed') {
      if (!outcome.reset.ok) {
        const thirdParty = outcome.reset.reason?.includes('期间有别的提交');
        await deps.markHaUnsafe(mission, thirdParty ? 'third_party_advanced' : 'rollback_failed', {
          head: outcome.mergedInto,
          anchor: outcome.anchor,
          reportId: outcome.report.id,
        });
      }
      mission.setWaitReason(
        'waiting_l3',
        `集成验证未通过（报告 ${outcome.report.id}）；` +
          (outcome.reset.ok
            ? `已退回 ${outcome.anchor.slice(0, 12)}，等人处置。`
            : `**退回失败**：${outcome.reset.reason} 集成分支上留着一个没验过的合并。`),
      );
      await ctx.event(mission, 'mission.waiting', {
        reason: 'waiting_l3',
        reportId: outcome.report.id,
        rolledBack: outcome.reset.ok,
      });
      return {
        status: mission.status,
        reportId: outcome.report.id,
        reason: outcome.reset.ok
          ? '集成验证未通过，已回滚'
          : deps.haUnsafeHint(outcome.reset.reason?.includes('期间有别的提交')
              ? 'third_party_advanced'
              : 'rollback_failed'),
        ...(outcome.reset.ok ? { rolledBackTo: outcome.anchor } : {}),
      };
    }
    if (outcome.kind === 'advanced_during_verify') {
      await deps.markHaUnsafe(mission, 'advanced_during_verify', {
        head: outcome.head,
        anchor: outcome.anchor,
        reportId: outcome.report.id,
      });
      mission.setWaitReason(
        'waiting_l3',
        `集成验证期间目标被推进或 checkout 被切换（报告 ${outcome.report.id}）；未签字。请人工核对锚点、当前 HEAD 与集成报告。`,
      );
      await ctx.event(mission, 'mission.waiting', {
        reason: 'waiting_l3',
        reportId: outcome.report.id,
        advancedDuringVerify: true,
      });
      return {
        status: mission.status,
        reportId: outcome.report.id,
        reason: deps.haUnsafeHint('advanced_during_verify'),
      };
    }

    const reasons =
      input.reasons && input.reasons.length > 0
        ? [...input.reasons]
        : [`HA 受控放行验证通过（报告 ${outcome.report.id}）`];
    mission.complete({
      verdict: 'merge',
      reasons,
      mergedInto: outcome.mergedInto,
      mergedAt: ctx.clock.now().toISOString(),
      authority,
    });
    await ctx.event(mission, 'final_review.merged', {
      mergedInto: outcome.mergedInto,
      authority: 'reviewer',
      reportId: outcome.report.id,
    });
    await ctx.event(mission, 'final_review.ha_authorized', {
      source: config.source,
      integrationReportId: outcome.report.id,
      reviewerId: registered.reviewerId,
      confirmedBy: registered.confirmedBy,
      integrationBranch: persistedTarget,
      mergedInto: outcome.mergedInto,
    });
    await ctx.releaseWorkspace(missionId, projectRoot);
    return {
      status: mission.status,
      mergedInto: outcome.mergedInto,
      reportId: outcome.report.id,
    };
  }
