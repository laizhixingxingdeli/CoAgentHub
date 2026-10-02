import type { Mission, WorkItem } from '../../kernel/index.ts';
import type { PlatformContext } from './context.ts';
import type { StandardAutoRedispatchResult, StandardAutoRedispatchHandoff } from './types.ts';
import { STANDARD_AUTO_REDISPATCH_EVENT_KIND, STANDARD_AUTO_REDISPATCH_LIMIT, autoRedispatchEventsFor, submissionPrecedesPromotion, autoRedispatchSummary, failedValidationSummary, standardAutoRedispatchHandoff, type StandardAutoRedispatchReason } from './redispatch-helpers.ts';
import { hasOpenDiagnosticEscalation } from './agent-view-helpers.ts';
import { submittedAttemptReportId } from './standard-validation.ts';

export async function autoRedispatchStandardWorkItem(ctx: PlatformContext, input: {
    readonly missionId: string;
    readonly workItemId: string;
  }): Promise<StandardAutoRedispatchResult> {
    const { mission, item } = await ctx.locateItem(input.missionId, input.workItemId);
    // 只有还停在 submitted 的这一次交卷才谈得上回退：已经续派过（现为 dispatched）、
    // 已被 L2 评审、从未交卷，一律 no-op。编排器重启后重复调用必须是无害的。
    if (item.status !== 'submitted') {
      return { redispatched: false, reason: 'not_submitted' };
    }
    // 停派期间不自动续派，且返回「没续派」而非抛错：编排器内部路径崩掉会把一次本该
    // 交给 L2 的交付变成一跳失败。
    const events0 = await ctx.activity.list(mission.id);
    if (hasOpenDiagnosticEscalation(mission, events0)) {
      return { redispatched: false, reason: 'criteria_failure_stopped' };
    }
    const submittedAttemptId = item.submittedAttemptId;
    if (!submittedAttemptId) {
      return { redispatched: false, reason: 'no_auto_reason' };
    }
    const events = await ctx.activity.list(mission.id);
    // 升级前 Lightweight 那一跳的提交保留给 L2：它不是这一次 Standard 的交付，
    // 自动续派会把它从协调者手里抢走（见 submissionPrecedesPromotion）。
    if (submissionPrecedesPromotion(events, item.id, submittedAttemptId)) {
      return { redispatched: false, reason: 'no_auto_reason' };
    }
    const prior = autoRedispatchEventsFor(events, item.id);
    // 同一次提交已经续派过：只可能是重放。再退一次会把刚派出去的工单又打回来。
    if (prior.some((row) => row.attemptId === submittedAttemptId)) {
      return { redispatched: false, reason: 'already_redispatched' };
    }
    const auto = await standardAutoRedispatchReason(ctx, mission, item, submittedAttemptId);
    if (!auto) {
      return { redispatched: false, reason: 'no_auto_reason' };
    }
    // 次数从事件流读，不从内存：重启之后内存里什么都没有，事件流还在。
    const count =
      Math.max(0, ...prior.filter((row) => row.reason === auto.reason).map((row) => row.count)) + 1;
    if (count > STANDARD_AUTO_REDISPATCH_LIMIT) {
      // 第三次：原样留在 submitted，连同各次报告与交接说明一起交给 L2。
      return { redispatched: false, reason: 'limit_reached' };
    }
    // 内核里没有 submitted -> dispatched 这条路（不变量 A：submitted 只能被评审），
    // 所以先无记录地 reject 回到 rejected，再 dispatch。**不带 record 是关键**。
    item.review('reject');
    item.dispatch();
    const handoff = standardAutoRedispatchHandoff(item, {
      reason: auto.reason,
      attemptId: submittedAttemptId,
      count,
      summary: auto.summary,
      ...(auto.reportId !== undefined ? { reportId: auto.reportId } : {}),
    });
    // attemptId 留空：写这条的是平台，不是执行者、也不是 reviewer。原提交 attemptId
    // 记在 data 里——它才是这次回退的依据。
    await ctx.event(
      mission,
      STANDARD_AUTO_REDISPATCH_EVENT_KIND,
      {
        reason: auto.reason,
        attemptId: submittedAttemptId,
        count,
        summary: auto.summary,
        ...(auto.reportId !== undefined ? { reportId: auto.reportId } : {}),
      },
      item.id,
    );
    return { redispatched: true, reason: auto.reason, handoff };
  }

export async function standardAutoRedispatchReason(ctx: PlatformContext, 
    mission: Mission,
    item: WorkItem,
    submittedAttemptId: string,
  ): Promise<
    { reason: StandardAutoRedispatchReason; summary: string; reportId?: string } | undefined
  > {
    const result = item.executionResult;
    if (!result) return undefined;
    if (result.outcome === 'partial') {
      // 执行者自己说只做了一半：上轮说明就是他写的 summary，原样交接给下一跳。
      return { reason: 'partial', summary: autoRedispatchSummary(result.summary) };
    }
    if (result.outcome !== 'completed') return undefined;
    const reports = ctx.validation?.reports;
    if (!reports) return undefined;
    // 报告必须已落盘、且绑定**当前这一次**提交：一次已经修好的交付若被按旧提交的
    // 失败报告退回，执行者会去改一个早就不存在的问题。
    const reportId = await submittedAttemptReportId(ctx, mission.id, item.id, submittedAttemptId);
    if (!reportId) return undefined;
    const report = await reports.get(reportId);
    if (!report) return undefined;
    if (report.missionId !== mission.id) return undefined;
    if (report.workItemId !== undefined && report.workItemId !== item.id) return undefined;
    if (report.attemptId !== submittedAttemptId) return undefined;
    if (report.passed) return undefined; // 机器跑绿：那是 L2 的验收材料，不自动回退
    return {
      reason: 'validation_failed',
      reportId: report.id,
      summary: failedValidationSummary(report),
    };
  }

export async function getStandardAutoRedispatchHandoff(ctx: PlatformContext, 
    missionId: string,
    workItemId: string,
  ): Promise<StandardAutoRedispatchHandoff | undefined> {
    const { mission, item } = await ctx.locateItem(missionId, workItemId);
    const rows = autoRedispatchEventsFor(await ctx.activity.list(mission.id), item.id);
    const last = rows.at(-1);
    if (!last) return undefined;
    return standardAutoRedispatchHandoff(item, last);
  }
