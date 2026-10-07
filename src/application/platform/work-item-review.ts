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
  workOrderContentHash,
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
  if (uncovered.length === 0) return;
  // 没装配覆盖仓储就只看回执：这一支必须与 B4 逐字一致，不能因为多了一种
  // 覆盖来源而放宽。
  if (!ctx.changeCoverages) {
    throw uncoveredError(uncovered);
  }
  const covered = await coveredBySnapshotChangeIds(ctx, mission, item, submittedAttemptId);
  const still = uncovered.filter((changeId) => !covered.has(changeId));
  if (still.length > 0) throw uncoveredError(still);
}

function uncoveredError(changeIds: readonly string[]): PlatformRuleError {
  return new PlatformRuleError(
    'ACCEPT_CHANGES_UNCOVERED',
    `有 compatible 变更这次提交没覆盖，不能 accept：${changeIds.join(', ')}`,
  );
}

/**
 * 本次交卷快照里记的工单修订号。
 *
 * 为什么不读 item.order.orderRevision：那只是**当前**修订号，协调者可以在交卷后
 * 再修订一次，于是「照旧工单交的结果」会被当成「照新工单跑过」。事件是当时写的，
 * 只有它回答这次提交跑的是哪一轮。
 */
async function submittedOrderRevision(
  ctx: PlatformContext,
  mission: Mission,
  submittedAttemptId: string,
): Promise<string | undefined> {
  const events = await ctx.activity.list(mission.id);
  const submitted = events.find(
    (row) => row.kind === 'execution_result.submitted' && row.attemptId === submittedAttemptId,
  );
  const data: unknown = submitted?.data;
  // data 是 unknown：不收窄就取字段，会把交卷以外的事件形状也算成有修订号。
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const revision = (data as { orderRevision?: unknown }).orderRevision;
  return typeof revision === 'string' ? revision : undefined;
}

/**
 * 本次交卷快照已经覆盖掉的 changeId。门禁与写 verified 共用这一个判定：
 * 两边各写一套，迟早在「哪些算覆盖」上分岔，然后门禁放行、写入却什么都不写。
 *
 * 两条都得对：修订号对上说明「跑的是那一轮」，内容哈希对上说明「那一轮的正文
 * 就是现在这份」。缺任一条都不算覆盖——没有匹配记录一律当没覆盖，不猜。
 */
async function coveredBySnapshotChangeIds(
  ctx: PlatformContext,
  mission: Mission,
  item: WorkItem,
  submittedAttemptId: string,
): Promise<ReadonlySet<string>> {
  if (!ctx.changeCoverages || !item.order) return new Set<string>();
  const revision = await submittedOrderRevision(ctx, mission, submittedAttemptId);
  if (revision === undefined || revision !== item.order.orderRevision) return new Set<string>();
  const rows = await ctx.changeCoverages.listByMission(mission.id);
  const hash = workOrderContentHash(item.order);
  const out = new Set<string>();
  for (const row of rows) {
    if (row.workItemId !== item.id) continue;
    if (row.orderRevision !== revision) continue;
    if (row.workOrderHash !== hash) continue;
    out.add(row.changeId);
  }
  return out;
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
  // 快照覆盖只在回执没命中时才可能补上缺的那一条；回执命中的照旧，多余的查询就免了。
  let coveredBySnapshot: ReadonlySet<string> | undefined;
  for (const impact of mine) {
    const hash = diffContentHash(impact.workOrderDiff);
    // 用覆盖用的那条回执的代次：verified 记的是「这一代照这份 diff 跑过并被验收」。
    const cover = findCoveringReceipt(impact, receipts, submittedAttemptId);
    // 覆盖来源：回执 = 执行者 ack 说照跑了；coverage = 协调者声明这一轮正文里已经有了。
    // 回执优先——它证明的是「跑过」，coverage 只证明「正文里有」。两者不可互换，
    // 写进事件就是为了事后能看出这份 verified 依据的是哪一种。
    let coverageSource: 'receipt' | 'coverage' = 'receipt';
    if (!cover) {
      coveredBySnapshot ??= await coveredBySnapshotChangeIds(ctx, mission, item, submittedAttemptId);
      if (!coveredBySnapshot.has(impact.changeId)) continue;
      coverageSource = 'coverage';
    }
    const record: VerifiedChangeRecord = {
      changeId: impact.changeId,
      missionId: mission.id,
      workItemId: item.id,
      attemptId: submittedAttemptId,
      // 快照路径拿不到回执行：改用这条 impact 自己的代次，写 0 或新执行者的代次
      // 都会让「哪一代认过这份 diff」答不上来。
      claimGeneration: cover ? cover.claimGeneration : impact.claimGeneration,
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
        // 只有 coverage 路径多这一格：回执路径的事件 data 被既有 observed-deepEqual
        // 钉住了，加一格就会把「这一份是照回执写的」谎报成一个新形状。
        ...(coverageSource === 'coverage' ? { coverageSource } : {}),
      },
      item.id,
      submittedAttemptId,
    );
  }
}
