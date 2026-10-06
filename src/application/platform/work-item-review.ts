import type { AcceptanceResult, Mission, WorkItem, ReviewRecord } from '../../kernel/index.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import { checkAcceptanceResults } from './work-order-helpers.ts';
import { criteriaList } from './agent-view-helpers.ts';
import { requireLightweightReviewReport } from './lightweight-submission.ts';
import { commitPromotionToStandard } from './promotion.ts';
import { getAgentValidationReport } from './validation-report-views.ts';
import { CHANGE_RECEIPT_RECORDED_KIND } from './change-receipt.ts';
import {
  diffContentHash,
  findCoveringReceipt,
  uncoveredCompatibleChangeIds,
  type VerifiedChangeRecord,
} from '../change-receipt.ts';

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
    // 打回时的返回值要取自 Mission，而判据只能是进来时的车道。
    const fromLightweight = mission.executionMode === 'lightweight';
    // 快车道下 accept 之前先确认：这次提交确有一份机器通过的报告，且没有被规模闸按住。
    // 不查的话，协调者可以凭一句“看了没问题”把一次没跑过验收、或改动已经超规模的提交
    // 判成 accept——后面的交卷就再也拦不住了。
    if (fromLightweight) {
      await requireLightweightReviewReport(ctx, mission, item);
    }
    // 门禁必须在 item.review 之前：工作项一经流转到 accepted 再发现变更没覆盖，
    // 就只剩「撤一次验收」这条路，而验收记录是不可变事实。拒绝必须无副作用。
    if (input.verdict === 'accept') {
      await requireCoveredChanges(ctx, mission, item);
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
    // accept 已经落定才轮到写 verified：先有「验收过了」这个事实，再补「哪条变更
    // 因此有了机器依据」。反过来写会让一次本该被拒的 accept 也留下回执。
    if (input.verdict === 'accept') {
      await recordVerifiedReceipts(ctx, mission, attemptId, item);
    }

    // 快车道打回之后，去处由整条 Mission 说了算，不由工作项说了算：
    // 正常晋升会把 Mission 摆回 planning（协调者还能在同一 attempt 里接着规划），
    // 但若 AC1 已经判停，Mission 停在那个停态上——写死 planning 会把「已停」谎报成
    // 「还在规划」，协调者会继续在同一 attempt 里发工单。
    // accept 不走这条路：它没动 Mission，返回工作项自己的 accepted 才是这一跳的真相。
    if (fromLightweight && input.verdict === 'reject') {
      return { status: mission.status };
    }
    return { status: item.status };
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

/**
 * accept 门禁：本工作项还有 compatible 变更没被本次提交覆盖时拒。
 *
 * 为什么要挡：放行就等于承认一次「照着改了但跑的不是那份 diff」的提交。回执是
 * 不可变事实，事后补一条会让人误以为当时就跑了那份工单。
 *
 * 为什么返回 void 而不是结果：这里只判「能不能 accept」，覆盖清单由写回执那一步
 * 自己再算一遍——两边共用一个函数算出来的 ids，避免门禁与写入对「哪些算覆盖」
 * 产生分歧。
 */
async function requireCoveredChanges(ctx: PlatformContext, mission: Mission, item: WorkItem): Promise<void> {
  const submittedAttemptId = item.submittedAttemptId;
  if (!ctx.changeImpacts || !ctx.changeReceipts || submittedAttemptId === undefined) return;
  // list 已经按层滤过、字段也齐，交给纯函数换算就可以，不必再投影一遍。
  const [impacts, receipts] = await Promise.all([
    ctx.changeImpacts.listByMission(mission.id),
    ctx.changeReceipts.listByMission(mission.id),
  ]);
  const uncovered = uncoveredCompatibleChangeIds({
    impacts,
    receipts,
    workItemId: item.id,
    submittedAttemptId,
  });
  if (uncovered.length > 0) {
    throw new PlatformRuleError(
      'ACCEPT_CHANGES_UNCOVERED',
      `有 compatible 变更这次提交没覆盖，不能 accept：${uncovered.join(', ')}`,
    );
  }
}

/**
 * accept 通过后，为已被本次提交覆盖的 compatible 变更写 verified 回执。
 *
 * 没有本次提交的通过报告就一条都不写、也不抛：缺机器验收不等于这次交付不合格
 * （快车道之外本就可以人工验收），但绝不能拿一份对不上这次提交的报告当依据。
 */
async function recordVerifiedReceipts(
  ctx: PlatformContext,
  mission: Mission,
  reviewAttemptId: string,
  item: WorkItem,
): Promise<void> {
  const submittedAttemptId = item.submittedAttemptId;
  if (!ctx.changeImpacts || !ctx.changeReceipts || submittedAttemptId === undefined) return;
  const report = await getAgentValidationReport(ctx, mission.id, item.id);
  if (!report || report.passed !== true) return;
  const [impacts, receipts] = await Promise.all([
    ctx.changeImpacts.listByMission(mission.id),
    ctx.changeReceipts.listByMission(mission.id),
  ]);
  const mine = impacts
    .filter((row) => row.workItemId === item.id && row.decision === 'compatible')
    .sort((a, b) => (a.changeId < b.changeId ? -1 : a.changeId > b.changeId ? 1 : 0));
  for (const impact of mine) {
    const hash = diffContentHash(impact.workOrderDiff);
    // 用覆盖用的那条回执的代次：verified 记的是「这一代照这份 diff 跑过并被验收」。
    const cover = findCoveringReceipt(impact, receipts, submittedAttemptId);
    if (!cover) continue;
    const record: VerifiedChangeRecord = {
      changeId: impact.changeId,
      missionId: mission.id,
      workItemId: item.id,
      attemptId: submittedAttemptId,
      claimGeneration: cover.claimGeneration,
      layer: 'verified',
      at: ctx.clock.now().toISOString(),
      contentHash: hash,
      sourceAttemptId: reviewAttemptId,
      reportId: report.id,
    };
    // 幂等重放不重复发事件：事件是「记下了一条」，重复发会让回放看到两条记录。
    if (!(await ctx.changeReceipts.recordVerified(record))) continue;
    await ctx.event(
      mission,
      CHANGE_RECEIPT_RECORDED_KIND,
      {
        changeId: impact.changeId,
        layer: 'verified',
        workItemId: item.id,
        attemptId: submittedAttemptId,
        sourceAttemptId: reviewAttemptId,
        reportId: report.id,
        contentHash: hash,
      },
      item.id,
      submittedAttemptId,
    );
  }
}
