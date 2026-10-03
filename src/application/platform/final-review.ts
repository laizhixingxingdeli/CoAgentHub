import { PlatformRuleError, type PlatformContext } from './context.ts';
import type { Mission, FinalReviewAuthority } from '../../kernel/index.ts';
import { evaluatePolicy, POLICY_ACTION, POLICY_REASON } from '../policy-engine.ts';
import { applyMemoryDelta, writeVibe } from '../project-memory.ts';

export function assertFinalizePolicy(
  input: Parameters<typeof evaluatePolicy>[0],
  haHumanMessage: string,
): void {
  const verdict = evaluatePolicy(input);
  if (verdict.decision === 'allow') return;
  if (verdict.reason.code === POLICY_REASON.HA_MACHINE_FINALIZE_DENIED) {
    throw new PlatformRuleError('HIGH_ASSURANCE_NEEDS_HUMAN', haHumanMessage);
  }
  throw new PlatformRuleError('POLICY_DENIED', verdict.reason.detail);
}

export async function finalizeMission(ctx: PlatformContext, 
    missionId: string,
    input: {
      verdict: 'merge' | 'send_back' | 'abandon';
      reasons: readonly string[];
      projectRoot?: string;
      /** 只接受 human；principalId 有就记，没有就记「人，不知道是谁」。 */
      authority?: { kind: 'human'; principalId?: string };
    },
  ): Promise<{ status: string; mergedInto?: string; reason?: string }> {
    assertFinalizePolicy(
      {
        principal: {
          status: 'ok',
          kind: 'user',
          id: input.authority?.principalId ?? 'human',
          role: 'operator',
        },
        action: POLICY_ACTION.finalizeHuman,
        context: { missionId },
      },
      `Mission ${missionId} 是 high_assurance：合并永远要人放行，机器 L3 不碰。`,
    );
    // L3（C4）：send_back / abandon 是短命令，状态与事件一起提交。merge 带 git 合并这一外部副作用，不包：
    // 合并成功后提交丢了，重放会因为目标分支已前移判合并失败——要可重入的合并检测（见规格）。
    if (input.verdict === 'merge') return finalizeMissionInternal(ctx, missionId, input);
    return ctx.tx(() => finalizeMissionInternal(ctx, missionId, input));
  }

export async function finalizeMissionByReviewer(ctx: PlatformContext, 
    missionId: string,
    input: {
      verdict: 'merge' | 'send_back' | 'abandon';
      reasons: readonly string[];
      projectRoot?: string;
      reviewerId: string;
      confirmedBy: string;
    },
  ): Promise<{ status: string; mergedInto?: string; reason?: string }> {
    const authority = reviewerAuthority(ctx, input.reviewerId, input.confirmedBy);
    assertFinalizePolicy(
      {
        principal: { status: 'ok', kind: 'reviewer', id: authority.reviewerId },
        action: POLICY_ACTION.finalizeReviewer,
        context: { missionId },
      },
      `Mission ${missionId} 是 high_assurance：合并永远要人放行，机器 L3 不碰。`,
    );
    const body = {
      verdict: input.verdict,
      reasons: input.reasons,
      projectRoot: input.projectRoot,
      authority,
    };
    if (input.verdict === 'merge') return applyFinalReview(ctx, missionId, body);
    return ctx.tx(() => applyFinalReview(ctx, missionId, body));
  }

export function reviewerAuthority(ctx: PlatformContext, 
    reviewerId: unknown,
    confirmedBy: unknown,
  ): Extract<FinalReviewAuthority, { kind: 'reviewer' }> {
    return Object.freeze({
      kind: 'reviewer' as const,
      reviewerId: requireReviewerIdentity(ctx, reviewerId, 'reviewerId'),
      confirmedBy: requireReviewerIdentity(ctx, confirmedBy, 'confirmedBy'),
      confirmedAt: ctx.clock.now().toISOString(),
    });
  }

export function requireReviewerIdentity(ctx: PlatformContext, value: unknown, field: string): string {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed.length < 1 || trimmed.length > 128) {
      throw new PlatformRuleError(
        'REVIEWER_IDENTITY_INVALID',
        `${field} 经 trim 后必须是 1 到 128 个字符。`,
      );
    }
    return trimmed;
  }

export async function finalizeMissionInternal(ctx: PlatformContext, 
    missionId: string,
    input: {
      verdict: 'merge' | 'send_back' | 'abandon';
      reasons: readonly string[];
      projectRoot?: string;
      /** 只接受 human；principalId 有就记，没有就记「人，不知道是谁」。 */
      authority?: { kind: 'human'; principalId?: string };
    },
  ): Promise<{ status: string; mergedInto?: string; reason?: string }> {
    const rawKind = (input as { authority?: { kind?: unknown } }).authority?.kind;
    if (rawKind !== undefined && rawKind !== 'human') {
      throw new PlatformRuleError(
        'FINAL_REVIEW_AUTHORITY_FORBIDDEN',
        `公开 finalizeMission 只能发 human 权威，收到 ${String(rawKind)}。` +
          '机器放行必须走跑过合并后验证的内部路径。',
      );
    }
    const authority: FinalReviewAuthority = Object.freeze(
      input.authority?.principalId !== undefined
        ? { kind: 'human' as const, principalId: input.authority.principalId }
        : { kind: 'human' as const },
    );
    return applyFinalReview(ctx, missionId, {
      verdict: input.verdict,
      reasons: input.reasons,
      projectRoot: input.projectRoot,
      authority,
    });
  }

export async function applyFinalReview(ctx: PlatformContext, 
    missionId: string,
    input: {
      verdict: 'merge' | 'send_back' | 'abandon';
      reasons: readonly string[];
      projectRoot?: string;
      authority: FinalReviewAuthority;
    },
  ): Promise<{ status: string; mergedInto?: string; reason?: string }> {
    const authority = input.authority;
    const tag = (data: Record<string, unknown>) =>
      authority.kind === 'reviewer' ? { ...data, authority: 'reviewer' as const } : data;
    const { mission } = await ctx.locate(missionId);
    if (mission.status !== 'awaiting_review') {
      throw new PlatformRuleError(
        'NOT_AWAITING_REVIEW',
        `Mission ${missionId} 现在是 ${mission.status}，没有在等最终检视。`,
      );
    }
    if (input.verdict === 'merge' && mission.executionMode === 'high_assurance') {
      throw new PlatformRuleError(
        'HIGH_ASSURANCE_MERGE_NOT_AVAILABLE',
        `Mission ${missionId} 是 high_assurance：本项不开放合并。`,
      );
    }
    if (input.verdict === 'send_back' && input.reasons.length === 0) {
      throw new PlatformRuleError(
        'SEND_BACK_NEEDS_REASONS',
        '打回必须写清楚为什么，否则协调者只会原样再交一次。',
      );
    }

    if (input.verdict === 'send_back') {
      mission.sendBackToPlanning({ verdict: 'send_back', reasons: [...input.reasons], authority });
      await ctx.event(mission, 'final_review.send_back', tag({ reasons: input.reasons }));
      return { status: mission.status };
    }

    if (input.verdict === 'abandon') {
      mission.block({ verdict: 'abandon', reasons: [...input.reasons], authority });
      await ctx.event(mission, 'final_review.abandoned', tag({ reasons: input.reasons }));
      await ctx.releaseWorkspace(missionId, mission.workspaceRef?.projectRoot ?? input.projectRoot);
      return { status: mission.status };
    }

    // merge
    let mergedInto: string | undefined;
    if (mission.hasMutated) {
      const ref = mission.workspaceRef;
      if (!ref) {
        throw new PlatformRuleError(
          'NO_WORKSPACE_REF',
          `Mission ${missionId} 动过代码但没记下分支信息，无法落地。`,
        );
      }
      // projectRoot 优先用调用方给的，其次用 Mission 自己记下的那个。
      const projectRoot = input.projectRoot ?? ref.projectRoot;
      if (!ctx.workspace || !projectRoot) {
        throw new PlatformRuleError(
          'NO_WORKSPACE_MANAGER',
          '要落地改动必须知道项目仓库在哪，且平台要配了工作区管理。',
        );
      }
      await landMemory(ctx, mission);

      const outcome = await ctx.workspace.mergeToTarget({
        missionId,
        projectRoot,
        branch: ref.branch,
        expectedBaseRevision: ref.baseRevision,
        message: `merge(mission): ${missionId} ${mission.contract.intent.split(/[。！？.!?\n]/u)[0].slice(0, 60)}`,
      });
      if (!outcome.ok) {
        // 落不了地不算完成，也不该假装完成。转 blocked，原因说清楚。
        mission.block({ verdict: 'merge', reasons: [outcome.reason ?? '合并失败'], authority });
        await ctx.event(mission, 'final_review.merge_failed', tag({ reason: outcome.reason }));
        return { status: mission.status, reason: outcome.reason };
      }
      mergedInto = outcome.mergedInto;
    }

    mission.complete({
      verdict: 'merge',
      reasons: [...input.reasons],
      mergedInto,
      mergedAt: new Date().toISOString(),
      authority,
    });
    await ctx.event(mission, 'final_review.merged', tag({ mergedInto, reasons: input.reasons }));
    await ctx.releaseWorkspace(missionId, mission.workspaceRef?.projectRoot ?? input.projectRoot);
    return { status: mission.status, mergedInto };
  }

export async function landMemory(ctx: PlatformContext, mission: Mission): Promise<void> {
    const ref = mission.workspaceRef;
    const proposals = mission.result?.memoryDelta ?? [];
    if (!ref || proposals.length === 0 || ref.branch === '(in-place)') return;
    const worktreeRoot = ctx.workspace?.worktreePath?.(mission.id, ref.projectRoot);
    if (!worktreeRoot) return;
    const written = applyMemoryDelta(worktreeRoot, proposals);
    // 传 projectId：worktree 的目录名是 Mission ID，
    // 靠它兜底会让 VIBE.md 的标题变成 Mission 名。
    const vibe = writeVibe(worktreeRoot, mission.projectId);
    await ctx.event(mission, 'memory.applied', { written: [...written, vibe] });
  }
