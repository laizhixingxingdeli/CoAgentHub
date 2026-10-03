import type { Mission, MissionResultBody, ValidationReport, WorkItem } from '../../kernel/index.ts';
import type { MissionResultCriterion } from '../../kernel/payloads.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import { resultDeliveryKey } from '../delivery.ts';
import { lightweightGateTrigger } from '../promotion/lightweight-gate.ts';

/**
 * 「当前提交有没有一份机器通过的报告」——快车道验收与交卷共用的同一把尺。
 *
 * 两边必须读同一份东西：验收放过的、交卷却读另一份报告，就会出现「协调者说没问题，
 * 交卷凭的是上一跳的报告」。所以报告只从 activity 的 `validation.reported` 事件 +
 * durable reports 读回来，不接受调用方或 review 记录里自带的 id——那些 caller 可控，
 * 旧报告也会混进来。
 */
export async function requireLightweightReviewReport(
  ctx: PlatformContext,
  mission: Mission,
  item: WorkItem,
): Promise<ValidationReport> {
  const submittedAttemptId = item.submittedAttemptId;
  if (!submittedAttemptId || submittedAttemptId.trim().length === 0) {
    throw new PlatformRuleError(
      'LIGHTWEIGHT_SUBMITTED_ATTEMPT_REQUIRED',
      `工作项 ${item.id} 缺少 submittedAttemptId，无法核对机器验收报告。`,
    );
  }
  if (!ctx.validation) {
    throw new PlatformRuleError(
      'VALIDATION_DEPS_REQUIRED',
      'Lightweight 要核对机器验收报告，需要注入 PlatformDeps.validation（engine + reports）。',
    );
  }
  const reported = await currentReportedId(ctx, mission, item.id, submittedAttemptId);
  if (!reported) {
    throw new PlatformRuleError(
      'LIGHTWEIGHT_REPORT_REQUIRED',
      `工作项 ${item.id} 当前这次提交 ${submittedAttemptId} 没有机器验收报告（validation.reported），不能验收或交卷。`,
    );
  }
  const report = await ctx.validation.reports.get(reported);
  if (!report) {
    throw new PlatformRuleError(
      'VALIDATION_REPORT_MISSING',
      `ValidationReport ${reported} 不存在，拒绝验收或交卷。`,
    );
  }
  if (report.passed !== true) {
    throw new PlatformRuleError(
      'VALIDATION_REPORT_NOT_PASSED',
      `ValidationReport ${report.id} passed=false，拒绝验收或交卷。`,
    );
  }
  if (
    report.missionId !== mission.id ||
    report.workItemId !== item.id ||
    report.attemptId !== submittedAttemptId
  ) {
    throw new PlatformRuleError(
      'VALIDATION_LINKAGE_MISMATCH',
      `ValidationReport ${report.id} 的 mission/workItem/attempt 与当前对象不一致（当前提交 ${submittedAttemptId}）。`,
    );
  }
  // 机器过了但改动规模超了：这份报告是「交给协调者」的理由，不是放行的凭据。
  const held = lightweightGateTrigger(report);
  if (held) {
    throw new PlatformRuleError(
      'LIGHTWEIGHT_REPORT_HELD',
      `ValidationReport ${report.id} 触发 ${held.code}（${held.rule}），还没到可以验收或交卷的地步。`,
    );
  }
  return report;
}

/** 倒序找当前这次提交的 validation.reported：同一项可能报过多次，旧的不能算。 */
async function currentReportedId(
  ctx: PlatformContext,
  mission: Mission,
  workItemId: string,
  submittedAttemptId: string,
): Promise<string | undefined> {
  const events = await ctx.activity.list(mission.id);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind !== 'validation.reported') continue;
    if (event.workItemId !== workItemId) continue;
    const data = event.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
    const rec = data as { reportId?: unknown; submittedAttemptId?: unknown };
    if (rec.submittedAttemptId !== submittedAttemptId) continue;
    if (typeof rec.reportId !== 'string' || rec.reportId.length === 0) continue;
    return rec.reportId;
  }
  return undefined;
}

export async function submitLightweightMissionForReview(
  ctx: PlatformContext,
  requireLightweightMutationLane: (mission: Mission) => void,
    missionId: string,
  ): Promise<{ status: 'awaiting_review'; reportId: string }> {
    const { mission } = await ctx.locate(missionId);
    // Guard 顺序：先校验后 mutation。
    requireLightweightMutationLane(mission);

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
        `工作项 ${item.id} 没有 review 记录。交卷要有协调者的验收结论。`,
      );
    }
    if (lastReview.verdict !== 'accept') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_REVIEW_NOT_ACCEPT',
        `工作项 ${item.id} 最后一次 review 是 ${lastReview.verdict}，只有 accept 才能交卷。`,
      );
    }
    // 机器验收报告不写 review 记录（W-442 之后只有报告 + validation.reported），
    // 所以「这次是谁验的」只剩 attemptId 可查：它必须是 Mission 里真实存在的
    // 协调者 attempt。缺了或不是协调者，说明这条结论不是 L2 下的。
    const reviewer = lastReview.attemptId ? mission.attempt(lastReview.attemptId) : undefined;
    if (!reviewer || reviewer.kind !== 'coordinator') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_COORDINATOR_REVIEW_REQUIRED',
        `工作项 ${item.id} 的 accept 不是 Mission 的协调者 attempt 下的（${lastReview.attemptId ?? '无 attemptId'}），拒绝交卷。`,
      );
    }
    if (lastReview.submittedAttemptId !== submittedAttemptId) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_SUBMITTED_ATTEMPT_MISMATCH',
        `review.submittedAttemptId 与 item.submittedAttemptId 不一致：这份 accept 验的是上一次提交。`,
      );
    }

    // 与协调者验收入口同一把尺；不从 review 记录里取 report。
    const report = await requireLightweightReviewReport(ctx, mission, item);

    // Platform 内部 derive；不解析 notes，不接受 caller body。
    const body: MissionResultBody = {
      outcome: 'delivered',
      summary: executionResult.summary,
      acceptanceEvidence: [`validation-report:${report.id}`],
      memoryDelta: [],
      openRisks: [],
      criteria: criteriaFromL2Acceptance(mission, lastReview.acceptanceResults, report.id, lastReview.attemptId ?? '未知'),
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
        criteria: body.criteria,
      },
      // 交卷由这次交卷的协调者 attempt 引发：事件要能追回是谁验的。
      // 第 4 参是 workItemId：交卷是整份 Mission 的事，不落到某个工作项上，
      // 塞 lastReview.attemptId 进去会让 workItemId 变成一个 attempt id。
      undefined,
      lastReview.attemptId,
    );

    const delivery = await ctx.deliveries.create({
      missionId: mission.id,
      projectId: mission.projectId,
      recipient: mission.origin?.conversationRef ?? mission.origin?.clientType ?? 'unknown',
      outcome: 'delivered',
      // 这一次交卷由那份机器报告唯一确定：同一份报告重复交卷不重复投递。
      idempotencyKey: resultDeliveryKey(report.id),
      summary: body.summary,
    });
    await ctx.event(
      mission,
      'delivery.created',
      { deliveryId: delivery.id },
      // 与 mission_result.submitted 同源；不另造 attemptId。
      undefined,
      lastReview.attemptId,
    );

    return { status: 'awaiting_review', reportId: report.id };
  }

/**
 * L2 验收结论 → 契约 1-based 序号的逐条 criteria。
 *
 * 快车道就一个工单，工单自身也没有 criteria 投影，所以序号按整份契约展开——
 * 覆盖的契约标准一条都不能漏。
 *
 * 为什么不做「第 i 条工单结果 → 第 i 条契约标准」的位置映射：工单的
 * acceptanceResults 只保证与**工单自己**的 acceptance 一条对一条（见
 * checkAcceptanceResults），与契约 acceptance 既不保证条数相同、也不保证语义
 * 按位置对应。按位置投影会把「工单第三条」当成「契约第三条」，L3 看到的就是
 * 一份看似逐条核对、实则张冠李戴的结论。所以这里改成整份工单结论的聚合：
 * 全部 pass 才把覆盖到的契约标准全判 pass，否则全判 unverified——宁可都写
 * 未验证，也不替 L3 拍板某一条过了。
 *
 * 全 pass 时即使条数与契约不同也照样全契约 pass：快车道只有这一跳，L2 把整
 * 份工单都判过了，覆盖的契约就是都验过了；反过来，只要有一条 unverified /
 * not_applicable / fail，或者干脆没给结论（undefined 或空数组），整份契约就
 * 没有任何一条能算验过。
 */
function criteriaFromL2Acceptance(
  mission: Mission,
  acceptanceResults: readonly { readonly status: string }[] | undefined,
  reportId: string,
  l2AttemptId: string,
): readonly MissionResultCriterion[] {
  const total = mission.contract?.acceptance.length ?? 0;
  const results = acceptanceResults ?? [];
  // 空数组 / undefined 不得伪装成「全部通过」：没有结论等于没验。
  const allPassed = results.length > 0 && results.every((r) => r.status === 'pass');
  const notPassed = results.filter((r) => r.status !== 'pass').map((r) => r.status);
  const wholeOrderVerdict = allPassed
    ? `整份工单 ${results.length} 条验收全部 pass`
    : results.length === 0
      ? '工单验收结果缺失（undefined 或空数组），整份工单没有任何一条判 pass'
      : `整份工单 ${results.length} 条里有 ${notPassed.length} 条不是 pass（${notPassed.join('、')}）`;

  return Array.from({ length: total }, (_, i) => {
    const index = i + 1;
    if (allPassed) {
      return {
        index,
        status: 'pass' as const,
        evidence:
          `契约验收标准 ${index}：${wholeOrderVerdict}，L2 attempt ${l2AttemptId} 对整份工单判过；` +
          `机器报告 ${reportId} 对当前提交通过。工单结果与契约不按位置对应，结论取自整份工单。`,
      };
    }
    return {
      index,
      status: 'unverified' as const,
      evidence:
        `契约验收标准 ${index}：${wholeOrderVerdict}，L2 attempt ${l2AttemptId} 未把整份工单判过；` +
        `机器报告 ${reportId}。不按工单结果的位置映射这一条，快车道只有这一跳，未验证 / 不适用不得按通过交卷。`,
    };
  });
}
