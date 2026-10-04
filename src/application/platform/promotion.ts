import { isPromotionTriggerCode } from '../../kernel/index.ts';
import type { Mission, Attempt, PromotionRecord, PromotionStatus, PromotionTriggerCode, PromotionWorkspaceRevision } from '../../kernel/index.ts';
import type { ActivityLog } from '../ports.ts';
import { PlatformRuleError, type PlatformContext } from './context.ts';
import { buildPromotionUsageSnapshot } from './usage-helpers.ts';
import * as budgetUsage from './budget-usage.ts';
import { anyHardAuthoritativeExceeded, hardExceededVerdicts } from '../budget-usage.ts';
import { lightweightGateTrigger } from '../promotion/lightweight-gate.ts';

export async function promoteLightweightForBudgetExceeded(ctx: PlatformContext, 
    missionId: string,
  ): Promise<{ changed: boolean; promotion: Readonly<PromotionRecord> }> {
    const { mission } = await ctx.locate(missionId);

    if (mission.executionMode === 'standard' && mission.promotions.length === 1) {
      const existing = mission.promotions[0]!;
      if (existing.triggerCode === 'budget_exceeded') {
        return { changed: false, promotion: existing };
      }
    }

    if (mission.executionMode !== 'lightweight') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_MODE_REQUIRED',
        `promoteLightweightForBudgetExceeded 需要 executionMode=lightweight，当前是 ${mission.executionMode}。`,
      );
    }

    const { evaluation } = await budgetUsage.evaluateMissionBudget(ctx, missionId);
    if (!anyHardAuthoritativeExceeded(evaluation)) {
      throw new PlatformRuleError(
        'BUDGET_NOT_AUTHORITATIVELY_EXCEEDED',
        '权威硬预算未 exceeded，拒绝 budget_exceeded promotion。',
      );
    }

    const dims = hardExceededVerdicts(evaluation).map((d) => d.dimension);
    const rule = `hard:${dims.join(',')}`;
    return commitPromotionToStandard(ctx, missionId, {
      code: 'budget_exceeded',
      rule,
    });
  }

export async function promoteLightweightAfterValidation(ctx: PlatformContext, requireLightweightMutationLane: (mission: Mission) => void, 
    missionId: string,
    reportId: string,
  ): Promise<{ changed: boolean; promotion: Readonly<PromotionRecord> }> {
    const { mission } = await ctx.locate(missionId);
    requireLightweightMutationLane(mission);
    if (!ctx.validation) {
      throw new PlatformRuleError(
        'VALIDATION_DEPS_REQUIRED',
        'Lightweight 自动升级要读验收报告，需要注入 PlatformDeps.validation（engine + reports）。',
      );
    }
    const report = await ctx.validation.reports.get(reportId);
    if (!report || report.missionId !== mission.id) {
      throw new PlatformRuleError(
        'PROMOTION_REPORT_MISMATCH',
        `ValidationReport ${reportId} 不存在或不属于 Mission ${mission.id}。`,
      );
    }
    const item = mission.workItem(report.workItemId);
    if (!item || item.status !== 'submitted' || item.submittedAttemptId !== report.attemptId) {
      throw new PlatformRuleError(
        'PROMOTION_REPORT_STALE',
        `ValidationReport ${reportId} 不是工作项 ${report.workItemId} 当前这次提交的报告` +
          `（工作项 ${item?.status ?? '不存在'}，当前提交 ${item?.submittedAttemptId ?? '无'}，报告 ${report.attemptId}）。`,
      );
    }
    const trigger = lightweightGateTrigger(report);
    if (!trigger) {
      throw new PlatformRuleError(
        'NO_PROMOTION_TRIGGER',
        `ValidationReport ${reportId} 通过且改动在轻量规模内，没有升级的理由。`,
      );
    }
    return commitPromotionToStandard(ctx, mission.id, trigger);
  }

export async function promoteMissionToStandard(ctx: PlatformContext, 
    missionId: string,
    trigger: { readonly code: PromotionTriggerCode; readonly rule: string },
  ): Promise<{ changed: boolean; promotion: Readonly<PromotionRecord> }> {
    const rule = typeof trigger?.rule === 'string' ? trigger.rule.trim() : '';
    if (!rule) {
      throw new PlatformRuleError(
        'INVALID_PROMOTION_TRIGGER',
        'promoteMissionToStandard 要求非空 trigger.rule。',
      );
    }
    if (!isPromotionTriggerCode(trigger?.code)) {
      throw new PlatformRuleError(
        'INVALID_PROMOTION_TRIGGER',
        `非法 promotion trigger code：${String(trigger?.code)}`,
      );
    }
    // 公开入口永不接受 caller 自拟 budget_exceeded（BUDGET-001-S5）。
    if (trigger.code === 'budget_exceeded') {
      throw new PlatformRuleError(
        'BUDGET_PROMOTION_NOT_READY',
        'budget_exceeded 不得由调用方手填；仅 Platform 在权威硬超限自检后内部发放。',
      );
    }

    return commitPromotionToStandard(ctx, missionId, {
      code: trigger.code,
      rule,
    });
  }

export async function commitPromotionToStandard(ctx: PlatformContext, 
    missionId: string,
    trigger: { readonly code: PromotionTriggerCode; readonly rule: string },
  ): Promise<{ changed: boolean; promotion: Readonly<PromotionRecord> }> {
    const rule = trigger.rule.trim();
    const { mission, project } = await ctx.locate(missionId);

    // 已 standard + 既有 promotion：按 trigger code/rule 幂等匹配，不重采样。
    if (mission.executionMode === 'standard' && mission.promotions.length === 1) {
      const existing = mission.promotions[0]!;
      if (existing.triggerCode === trigger.code && existing.triggerRule === rule) {
        return { changed: false, promotion: existing };
      }
      throw new PlatformRuleError(
        'PROMOTION_ALREADY_APPLIED',
        `Mission ${missionId} 已升级为 standard，拒绝不同 trigger。`,
      );
    }

    const fromStatus = mission.status as PromotionStatus;
    const toStatus: 'investigating' | 'planning' =
      mission.status === 'executing' ? 'planning' : (fromStatus as 'investigating' | 'planning');

    const record: PromotionRecord = {
      // 审计身份只由 Platform 生成；不接受 caller 自带 id。
      id: ctx.ids.next('promo'),
      fromMode: 'lightweight',
      toMode: 'standard',
      triggerCode: trigger.code,
      triggerRule: rule,
      at: ctx.clock.now().toISOString(),
      fromStatus,
      toStatus,
      consumedUsage: buildPromotionUsageSnapshot(mission),
      evidenceIds: collectPromotionEvidenceIds(mission),
      validationReportIds: await collectPromotionValidationReportIds(
        mission,
        ctx.activity,
      ),
      workspaceRevision: await derivePromotionWorkspaceRevision(ctx, mission),
      workItemIdsSnapshot: mission.workItems.map((item) => item.id),
    };

    const result = mission.promoteToStandard(record);
    if (!result.changed) {
      return result;
    }

    // promotion snapshot 独立于 API 外层 persist 也要落盘。
    await ctx.projects.save(project);
    await ctx.event(mission, 'mission.promoted', {
      id: result.promotion.id,
      oldMode: result.promotion.fromMode,
      newMode: result.promotion.toMode,
      triggerCode: result.promotion.triggerCode,
      triggerRule: result.promotion.triggerRule,
      consumedUsage: result.promotion.consumedUsage,
      evidenceIds: result.promotion.evidenceIds,
      validationReportIds: result.promotion.validationReportIds,
      workspaceRevision: result.promotion.workspaceRevision,
      workItemIdsSnapshot: result.promotion.workItemIdsSnapshot,
      fromStatus: result.promotion.fromStatus,
      toStatus: result.promotion.toStatus,
    });
    return result;
  }

export async function derivePromotionWorkspaceRevision(ctx: PlatformContext, 
    mission: Mission,
  ): Promise<PromotionWorkspaceRevision> {
    const projectRoot = mission.workspaceRef?.projectRoot;
    if (!ctx.workspace || !mission.workspaceRef || !projectRoot) {
      return { kind: 'unknown' };
    }
    const cwd =
      ctx.workspace.worktreePath?.(mission.id, projectRoot) ?? projectRoot;
    try {
      const head = await ctx.workspace.head(cwd);
      const revision = typeof head === 'string' ? head.trim() : '';
      if (!revision) return { kind: 'unknown' };
      return { kind: 'head', revision };
    } catch {
      return { kind: 'unknown' };
    }
  }

/** 收集全部 attempts 的 evidence id，去重且保持出现顺序。 */
function collectPromotionEvidenceIds(mission: Mission): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const attempts: Attempt[] = [
    ...mission.coordinatorAttempts,
    ...mission.independentReviewerAttempts,
  ];
  for (const item of mission.workItems) attempts.push(...item.attempts);
  for (const attempt of attempts) {
    for (const ev of attempt.evidence) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      ids.push(ev.id);
    }
  }
  return ids;
}

/**
 * 收集 promotion 审计用 validation reportId，去重保序。
 * 来源（既有可信状态，不另造审计入口）：
 *   1) WorkItem.reviews 中 validator authority.reportId
 *   2) activity `validation.reported` 事件 data.reportId
 *      （Lightweight 失败只落 report+事件、不写 ReviewRecord 时仍须计入）
 */



async function collectPromotionValidationReportIds(
  mission: Mission,
  activity: ActivityLog,
): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (reportId: unknown): void => {
    if (typeof reportId !== 'string' || reportId.length === 0) return;
    if (seen.has(reportId)) return;
    seen.add(reportId);
    ids.push(reportId);
  };

  for (const item of mission.workItems) {
    for (const review of item.reviews) {
      const authority = review.authority;
      if (!authority || authority.kind !== 'validator') continue;
      push(authority.reportId);
    }
  }

  const events = await activity.list(mission.id);
  for (const event of events) {
    if (event.kind !== 'validation.reported') continue;
    const data = event.data;
    if (data == null || typeof data !== 'object' || Array.isArray(data)) continue;
    push((data as { reportId?: unknown }).reportId);
  }

  return ids;
}


