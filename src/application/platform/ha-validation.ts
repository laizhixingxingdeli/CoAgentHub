import type { Mission, WaitReason } from '../../kernel/index.ts';
import { PlatformRuleError, type PlatformContext } from './context.ts';
import * as independentReview from './independent-review.ts';

export async function haReviewHold(ctx: PlatformContext, 
    mission: Mission,
  ): Promise<'pending_dispatch' | 'in_review' | 'pending_release' | 'fault'> {
    // 结论一旦记下，这条 Attempt 不再算在审。生产 hop 的 finally 仍负责收尾吊销。
    const reviewing = mission.independentReviewerAttempts.some(
      (row) =>
        row.status === 'in_progress' &&
        !mission.independentReviews.some((rec) => rec.reviewerAttemptId === row.id),
    );
    if (reviewing) return 'in_review';
    if (mission.independentReviewBlockReason) return 'fault';
    if (
      mission.waitReason === 'no_available_agent' ||
      mission.waitReason === 'platform_unreachable' ||
      mission.waitReason === 'attempt_limit_reached'
    ) {
      return 'fault';
    }
    const detail = mission.waitDetail ?? '';
    if (detail.startsWith('HA 确定性验证') || detail.startsWith('HA 独立检视故障')) {
      return 'fault';
    }
    const pass = await independentReview.effectiveIndependentReviewPass(ctx, mission.id);
    if (pass) return 'pending_release';
    return 'pending_dispatch';
  }

export async function runHaDeterministicValidation(ctx: PlatformContext, setWaitReason: (missionId: string, reason: WaitReason | undefined, detail?: string) => Promise<void>, 
    missionId: string,
    _cwd: string,
  ): Promise<{ reportId: string; passed: boolean; reviewedCommit: string }> {
    const { mission } = await ctx.locate(missionId);
    if (mission.executionMode !== 'high_assurance') {
      throw new PlatformRuleError(
        'HA_VALIDATION_MODE_REQUIRED',
        '确定性验证只跑 high_assurance Mission。',
      );
    }
    if (mission.status !== 'awaiting_review' || mission.result?.outcome !== 'delivered') {
      throw new PlatformRuleError(
        'HA_VALIDATION_NOT_READY',
        '须在 delivered 且 awaiting_review 之后跑确定性验证。',
      );
    }
    const validation = ctx.validation;
    if (!validation) {
      throw new PlatformRuleError(
        'VALIDATION_DEPS_REQUIRED',
        'HA 确定性验证需要注入 validation.engine 与 reports。',
      );
    }
    // 不信调用方 cwd：命令必须跑在从 workspaceRef / worktree 解析出的 Mission 工作区。
    const trustedCwd = independentReview.missionWorkspaceCwd(ctx, mission);
    const projectRoot = mission.workspaceRef?.projectRoot;
    const baseRevision = mission.workspaceRef?.baseRevision;
    if (!trustedCwd || !projectRoot || !baseRevision) {
      throw new PlatformRuleError(
        'VALIDATION_WORKSPACE_REQUIRED',
        `Mission ${mission.id} 缺少可核实的工作区（workspaceRef/worktree），不跑 engine。`,
      );
    }
    const reviewedCommit = await independentReview.missionReviewedCommit(ctx, mission);
    const l2 = independentReview.l2ReviewSnapshot(ctx, mission);
    const active = mission.workItems.filter((item) => item.status !== 'retired');
    const frozenCommands = independentReview.frozenHaCommands(ctx, mission);
    const existingMeta = await independentReview.currentHaValidationReport(ctx, 
      mission.id,
      reviewedCommit,
      l2.fingerprint,
      mission.contractRevision,
    );
    if (existingMeta) {
      const existing = await validation.reports.get(existingMeta.id);
      if (existing && existing.missionId === mission.id) {
        if (
          !independentReview.haReuseMatches(ctx, 
            existingMeta,
            existing,
            active.map((item) => item.id),
            frozenCommands,
          )
        ) {
          throw new PlatformRuleError(
            'HA_VALIDATION_STALE',
            '已有 HA 报告的工作项覆盖或冻结命令与当前不符，拒绝复用。',
          );
        }
        return { reportId: existing.id, passed: existing.passed, reviewedCommit };
      }
    }
    const allowedScope = [...new Set(active.flatMap((item) => [...(item.order?.allowedScope ?? [])]))];
    const commands = active.flatMap((item) =>
      (item.order?.validation?.commands ?? []).map((command) => ({
        argv: [...command.argv],
        timeoutMs: command.timeoutMs,
        cwd: trustedCwd,
      })),
    );
    const hasForbidden = active.some((item) => item.order?.validation?.forbiddenPaths !== undefined);
    const forbiddenPaths = hasForbidden
      ? [...new Set(active.flatMap((item) => [...(item.order?.validation?.forbiddenPaths ?? [])]))]
      : undefined;
    let diffSize: { maxChangedFiles?: number; maxChangedLines?: number } | undefined;
    for (const item of active) {
      const size = item.order?.validation?.diffSize;
      if (!size) continue;
      diffSize ??= {};
      if (size.maxChangedFiles !== undefined) {
        diffSize.maxChangedFiles =
          diffSize.maxChangedFiles === undefined
            ? size.maxChangedFiles
            : Math.min(diffSize.maxChangedFiles, size.maxChangedFiles);
      }
      if (size.maxChangedLines !== undefined) {
        diffSize.maxChangedLines =
          diffSize.maxChangedLines === undefined
            ? size.maxChangedLines
            : Math.min(diffSize.maxChangedLines, size.maxChangedLines);
      }
    }
    const result = await validation.engine.validate({
      missionId: mission.id,
      projectRoot,
      baseRevision,
      allowedScope,
      commands,
      ...(forbiddenPaths !== undefined ? { forbiddenPaths } : {}),
      ...(diffSize !== undefined ? { diffSize } : {}),
    });
    const headAfter = await independentReview.missionReviewedCommit(ctx, mission);
    if (headAfter !== reviewedCommit) {
      throw new PlatformRuleError(
        'HA_VALIDATION_HEAD_CHANGED',
        '确定性验证运行期间工作区 HEAD 已变化，不产出有效报告。',
      );
    }
    await ctx.tx(async () => {
      const { mission: live } = await ctx.locate(missionId);
      await validation.reports.save(result.report);
      await ctx.event(
        live,
        'validation.reported',
        {
          reportId: result.report.id,
          passed: result.report.passed,
          purpose: 'ha_deterministic',
          reviewedCommit,
          l2Fingerprint: l2.fingerprint,
          contractRevision: live.contractRevision,
          workItemIds: active.map((item) => item.id),
          commands: frozenCommands,
        },
      );
    });
    if (!result.report.passed) {
      await setWaitReason(
        missionId,
        'waiting_l3',
        `HA 确定性验证未通过（报告 ${result.report.id}），不能开独立检视。`,
      );
    }
    return { reportId: result.report.id, passed: result.report.passed, reviewedCommit };
  }
