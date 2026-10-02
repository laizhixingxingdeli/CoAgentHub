import type { Mission, MissionResultBody } from '../../kernel/index.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import { resultDeliveryKey } from '../delivery.ts';

export async function submitLightweightMissionForReview(
  ctx: PlatformContext,
  requireLightweightMutationLane: (mission: Mission) => void,
    missionId: string,
  ): Promise<{ status: 'awaiting_review'; reportId: string }> {
    const { mission } = await ctx.locate(missionId);
    // Guard 顺序：先校验后 mutation。
    requireLightweightMutationLane(mission);

    if (mission.coordinatorAttempts.length !== 0) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_COORDINATOR_FORBIDDEN',
        'Lightweight submit-for-review 要求 coordinatorAttempts 为空。',
      );
    }
    if (mission.status !== 'executing') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_BAD_STATUS',
        `Lightweight submit-for-review 要求 mission.status=executing，当前是 ${mission.status}。`,
      );
    }
    if (mission.workItems.length !== 1) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_SINGLE_WORK_ITEM',
        `Lightweight submit-for-review 要求恰好一个 WorkItem，当前 ${mission.workItems.length} 个。`,
      );
    }

    const item = mission.workItems[0]!;
    if (item.status !== 'accepted') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_NOT_ACCEPTED',
        `工作项 ${item.id} 当前是 ${item.status}，需要 accepted 才能交卷。`,
      );
    }

    const executionResult = item.executionResult;
    if (!executionResult || executionResult.outcome !== 'completed') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_EXECUTION_NOT_COMPLETED',
        `工作项 ${item.id} 缺少 outcome=completed 的 executionResult。`,
      );
    }

    const submittedAttemptId = item.submittedAttemptId;
    if (!submittedAttemptId || submittedAttemptId.trim().length === 0) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_SUBMITTED_ATTEMPT_REQUIRED',
        `工作项 ${item.id} 缺少 submittedAttemptId。`,
      );
    }

    const lastReview = item.reviews.at(-1);
    if (!lastReview) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_REVIEW_REQUIRED',
        `工作项 ${item.id} 没有 review 记录。`,
      );
    }
    if (lastReview.authority?.kind !== 'validator') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_VALIDATOR_AUTHORITY_REQUIRED',
        `工作项 ${item.id} last review 不是 validator authority。`,
      );
    }
    if (lastReview.submittedAttemptId !== submittedAttemptId) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_SUBMITTED_ATTEMPT_MISMATCH',
        `review.submittedAttemptId 与 item.submittedAttemptId 不一致。`,
      );
    }

    if (!ctx.validation) {
      throw new PlatformRuleError(
        'VALIDATION_DEPS_REQUIRED',
        'Lightweight submit-for-review 需要注入 PlatformDeps.validation（engine + reports）。',
      );
    }

    const authority = lastReview.authority;
    // 重新读 durable report；不信任内存里的 authority  alone。
    const report = await ctx.validation.reports.get(authority.reportId);
    if (!report) {
      throw new PlatformRuleError(
        'VALIDATION_REPORT_MISSING',
        `ValidationReport ${authority.reportId} 不存在，拒绝交卷。`,
      );
    }
    if (report.passed !== true) {
      throw new PlatformRuleError(
        'VALIDATION_REPORT_NOT_PASSED',
        `ValidationReport ${report.id} passed=false，拒绝交卷。`,
      );
    }
    if (report.policyRevision !== authority.policyRevision) {
      throw new PlatformRuleError(
        'VALIDATION_POLICY_MISMATCH',
        `ValidationReport ${report.id} policyRevision 与 authority 不一致。`,
      );
    }
    if (
      report.missionId !== mission.id ||
      report.workItemId !== item.id ||
      report.attemptId !== submittedAttemptId
    ) {
      throw new PlatformRuleError(
        'VALIDATION_LINKAGE_MISMATCH',
        `ValidationReport ${report.id} mission/workItem/attempt 与当前对象不一致。`,
      );
    }

    // Platform 内部 derive；不解析 notes，不接受 caller body。
    const body: MissionResultBody = {
      outcome: 'delivered',
      summary: executionResult.summary,
      acceptanceEvidence: [`validation-report:${report.id}`],
      memoryDelta: [],
      openRisks: [],
    };

    mission.recordResult(body);
    mission.submitForReview();

    await ctx.event(
      mission,
      'mission_result.submitted',
      {
        outcome: 'delivered',
        missionStatus: 'awaiting_review',
        executionMode: 'lightweight',
        reportId: report.id,
      },
      // ActivityEvent.attemptId 省略：无 Coordinator
    );

    const delivery = await ctx.deliveries.create({
      missionId: mission.id,
      projectId: mission.projectId,
      recipient: mission.origin?.conversationRef ?? mission.origin?.clientType ?? 'unknown',
      outcome: 'delivered',
      // 没有协调者：这一次交卷由那份验收报告唯一确定。
      idempotencyKey: resultDeliveryKey(report.id),
      summary: body.summary,
    });
    await ctx.event(
      mission,
      'delivery.created',
      { deliveryId: delivery.id },
      // 无 fake attemptId
    );

    return { status: 'awaiting_review', reportId: report.id };
  }
