import type { AcceptanceResult, Mission, WorkItem, ReviewRecord } from '../../kernel/index.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import { checkAcceptanceResults } from './work-order-helpers.ts';
import { criteriaList } from './agent-view-helpers.ts';
import { requireLightweightReviewReport } from './lightweight-submission.ts';
import { commitPromotionToStandard } from './promotion.ts';

export async function reviewExecutionResult(
  ctx: PlatformContext,
  criteriaFailureStop: (mission: Mission, item: WorkItem) => Promise<void>,
    missionId: string,
    attemptId: string,
    input: {
      workItemId: string;
      verdict: 'accept' | 'reject';
      reasons: readonly string[];
      requiredChanges: readonly string[];
      /** 工单 acceptance 逐条的结论（方案 §11）；工单有验收标准时必填。 */
      acceptanceResults?: readonly AcceptanceResult[];
    },
  ): Promise<{ status: string }> {
    const { mission } = await ctx.requireAttempt(missionId, attemptId, 'coordinator');
    const item = mission.workItem(input.workItemId);
    if (!item) {
      throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${input.workItemId} 不存在`);
    }
    if (!item.hasResult) {
      throw new PlatformRuleError(
        'NO_RESULT',
        `${input.workItemId} 还没有执行结果，无法验收。`,
      );
    }
    // 打回却说不出要改什么，下一张工单就会和上一张逐字相同。
    if (input.verdict === 'reject' && input.requiredChanges.length === 0) {
      throw new PlatformRuleError(
        'REJECT_NEEDS_CHANGES',
        'reject 必须给出 requiredChanges，否则重发的工单与上一次没有可见差异。',
      );
    }
    const acceptanceResults = checkAcceptanceResults(item.id, item.order?.acceptance ?? [], input.acceptanceResults);
    if (input.verdict === 'accept' && acceptanceResults?.some((r) => r.status === 'fail')) {
      // 内核也挡这一条；在这里先挡是为了给协调者一句能照做的话。
      throw new PlatformRuleError(
        'ACCEPT_WITH_FAILED_CRITERION',
        '有验收标准判为 fail 却给了 accept：没过的那条要么改判，要么 reject 并在 requiredChanges 里写清要改什么。',
      );
    }
    // 晋升会把 executionMode 改成 standard，所以先把「这一跳是从快车道进来的」存下来：
    // 返回值要说 planning，而判据只能是进来时的车道。
    const fromLightweight = mission.executionMode === 'lightweight';
    // 快车道下 accept 之前先确认：这次提交确有一份机器通过的报告，且没有被规模闸按住。
    // 不查的话，协调者可以凭一句“看了没问题”把一次没跑过验收、或改动已经超规模的提交
    // 判成 accept——后面的交卷就再也拦不住了。
    if (fromLightweight) {
      await requireLightweightReviewReport(ctx, mission, item);
    }
    const record: Omit<ReviewRecord, 'verdict'> = {
      attemptId,
      reasons: [...input.reasons],
      requiredChanges: [...input.requiredChanges],
      ...(acceptanceResults ? { acceptanceResults } : {}),
      // 交卷时要凭这一条核实这份结论验的是不是当前这次提交（工单被重做后提交会换）。
      ...(item.submittedAttemptId ? { submittedAttemptId: item.submittedAttemptId } : {}),
    };
    item.review(input.verdict, record);
    await ctx.event(
      mission,
      'review.recorded',
      {
        verdict: input.verdict,
        reasons: record.reasons,
        // accept 也要记：回放时它用来把这条标准上的连续失败清零。
        // 快车道工单不写 criteria，缺省得按整份契约展开，否则这一跳的成败进不了 AC1 计数。
        criteria: criteriaList(item.order, mission),
        contractRevision: mission.contractRevision,
        ...(acceptanceResults
          ? {
              acceptance: tallyAcceptance(acceptanceResults),
              unverified: acceptanceResults.filter((r) => r.status === 'unverified').map((r) => r.criterion),
            }
          : {}),
      },
      input.workItemId,
      attemptId,
    );
    // 只统计 L2 的 reject：机器自动回退不发 review.recorded，也就不进连续失败计数。
    if (input.verdict === 'reject') {
      // 快车道的 reject 没有第二条路可走：它没有返工通道，打回之后只能交回协调者。
      // 内部晋升（不是公开工具入口）到 standard，且保持当前协调者 attempt 在途——
      // 于是同一工具 session 立刻能 updatePlan，不用重新起一跳。
      if (fromLightweight) {
        await commitPromotionToStandard(ctx, mission.id, {
          code: 'coordinator_rejected',
          rule: l2RejectRule(input),
        });
      }
      await criteriaFailureStop(mission, item);
    }
    // 快车道打回之后整条 Mission 回到 planning：工作项自己的状态（rejected）不代表
    // 这一跳的去处——协调者还能在同一 attempt 里接着规划。
    return { status: fromLightweight ? 'planning' : item.status };
  }

function tallyAcceptance(results: readonly AcceptanceResult[]): Record<AcceptanceResult['status'], number> {
  const tally = { pass: 0, fail: 0, unverified: 0, not_applicable: 0 };
  for (const r of results) tally[r.status] += 1;
  return tally;
}

/** 晋升记录里的那句原因照抄协调者的 requiredChanges：协调者要看懂这一跳为什么变慢了。 */
function l2RejectRule(input: { readonly reasons: readonly string[]; readonly requiredChanges: readonly string[] }): string {
  const reasons = input.reasons.filter((r) => r.trim().length > 0);
  const changes = input.requiredChanges.filter((r) => r.trim().length > 0);
  return (
    `L2 验收打回：${reasons.join('；') || '（未给理由）'}。` +
    `要改：${changes.join('；') || '（未列改动）'}。`
  );
}
