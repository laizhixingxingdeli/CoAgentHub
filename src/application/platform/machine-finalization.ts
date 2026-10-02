import { PlatformRuleError, type PlatformContext } from './context.ts';
import { assertFinalizePolicy, landMemory } from './final-review.ts';
import { runIntegrationMergeVerify } from './integration-verification.ts';
import { POLICY_ACTION } from '../policy-engine.ts';

export async function finalizeMissionByMachine(ctx: PlatformContext, 
    missionId: string,
    input: {
      readonly integrationBranch: string;
      readonly verification: readonly {
        readonly argv: readonly string[];
        readonly timeoutMs: number;
      }[];
      readonly projectRoot?: string;
    },
  ): Promise<{
    status: string;
    mergedInto?: string;
    reportId?: string;
    reason?: string;
    rolledBackTo?: string;
  }> {
    const { mission } = await ctx.locate(missionId);
    if (mission.status !== 'awaiting_review') {
      throw new PlatformRuleError(
        'NOT_AWAITING_REVIEW',
        `Mission ${missionId} 现在是 ${mission.status}，没有在等最终检视。`,
      );
    }
    // 自动合的范围只有 lightweight + standard。高保证路径的合并必须由人放行——
    // 今天建不出这种 Mission，但门口的规则不能靠「上游恰好建不出来」来守。
    // 判定收拢到 PolicyEngine，错误码仍是 HIGH_ASSURANCE_NEEDS_HUMAN。
    assertFinalizePolicy(
      {
        principal: { status: 'ok', kind: 'runner', id: 'platform' },
        action: POLICY_ACTION.finalizeMachine,
        context: { missionId },
        state: { executionMode: mission.executionMode },
      },
      `Mission ${missionId} 是 high_assurance：合并永远要人放行，机器 L3 不碰。`,
    );
    if (input.verification.length === 0) {
      throw new PlatformRuleError(
        'MACHINE_FINALIZE_NEEDS_VERIFICATION',
        '机器放行必须有方案级集成命令。空命令表 = 没有新证据，那就只是把 ' +
          'validator 那份报告又数了一遍。',
      );
    }
    const runner = ctx.validation?.commandRunner;
    const reports = ctx.validation?.reports;
    if (!runner || !reports) {
      throw new PlatformRuleError(
        'MACHINE_FINALIZE_UNAVAILABLE',
        '没注入 commandRunner / reports，机器放行不可用。不退化成不验直接合。',
      );
    }
    const projectRoot = input.projectRoot ?? mission.workspaceRef?.projectRoot;
    if (!ctx.workspace || !projectRoot) {
      throw new PlatformRuleError('NO_WORKSPACE_MANAGER', '机器放行要知道项目仓库在哪。');
    }
    const workspace = ctx.workspace;
    if (!workspace.currentBranch || !workspace.resetTarget) {
      throw new PlatformRuleError(
        'MACHINE_FINALIZE_UNAVAILABLE',
        '工作区管理不支持 currentBranch / resetTarget，机器放行不可用。',
      );
    }

    // 1. 钉分支
    const branch = await workspace.currentBranch(projectRoot);
    if (branch !== input.integrationBranch) {
      throw new PlatformRuleError(
        'INTEGRATION_BRANCH_MISMATCH',
        `项目仓现在在 ${branch ?? '(detached)'}，不是方案声明的 ${input.integrationBranch}。` +
          '拒绝合并——合错分支比不合更糟。',
      );
    }

    const outcome = await runIntegrationMergeVerify(ctx, (mission) => landMemory(ctx, mission), {
      mission,
      projectRoot,
      integrationBranch: input.integrationBranch,
      verification: input.verification,
    });
    if (outcome.kind === 'merge_failed') {
      // 合不进去和验证红了是一回事：机器判不了，不等于这条完了。留在
      // awaiting_review 等人（或方案的检视者）处置。原先这里转 blocked 并记
      // { kind: 'human' }——一条机器路径冒签了人的权威，而且 blocked 是终态，
      // 人第二天想看一眼再合都没门。
      mission.setWaitReason(
        'waiting_l3',
        `机器合并失败：${outcome.reason ?? '（没给原因）'} 集成分支没动，等人处置。`,
      );
      await ctx.event(mission, 'final_review.merge_failed', {
        reason: outcome.reason,
        authority: 'machine',
      });
      await ctx.event(mission, 'mission.waiting', { reason: 'waiting_l3' });
      return { status: mission.status, reason: outcome.reason };
    }
    if (outcome.kind === 'verify_failed') {
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
        reason: outcome.reset.ok ? '集成验证未通过，已回滚' : '集成验证未通过，且回滚失败',
        ...(outcome.reset.ok ? { rolledBackTo: outcome.anchor } : {}),
      };
    }
    if (outcome.kind === 'advanced_during_verify') {
      // 与 HA 共用复核：绿之后 checkout / HEAD 已不是本次合并结果时，不能记 completed。
      mission.setWaitReason(
        'waiting_l3',
        `集成验证期间目标被推进或 checkout 被切换（报告 ${outcome.report.id}）；未签字。` +
          '不能把这次验证当成仍对着受授权的合并结果。',
      );
      await ctx.event(mission, 'mission.waiting', {
        reason: 'waiting_l3',
        reportId: outcome.report.id,
        advancedDuringVerify: true,
      });
      return {
        status: mission.status,
        reportId: outcome.report.id,
        reason: '集成验证期间目标被推进或 checkout 被切换，未放行',
      };
    }

    mission.complete({
      verdict: 'merge',
      reasons: [`集成验证通过（报告 ${outcome.report.id}）`],
      mergedInto: outcome.mergedInto,
      mergedAt: ctx.clock.now().toISOString(),
      authority: Object.freeze({
        kind: 'machine' as const,
        integrationReportId: outcome.report.id,
        policyRevision: outcome.report.policyRevision,
      }),
    });
    await ctx.event(mission, 'final_review.merged', {
      mergedInto: outcome.mergedInto,
      authority: 'machine',
      reportId: outcome.report.id,
    });
    await ctx.releaseWorkspace(missionId, projectRoot);
    return { status: mission.status, mergedInto: outcome.mergedInto, reportId: outcome.report.id };
  }
