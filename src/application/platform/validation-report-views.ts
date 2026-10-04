import type { Mission, ValidationReport } from '../../kernel/index.ts';
import type { ActivityEvent } from '../ports.ts';
import { PlatformRuleError, type PlatformContext } from './context.ts';
import type { ValidationReportView } from './types.ts';
import { validationReportKey, validationReportView } from './agent-view-helpers.ts';

export async function getValidationReport(ctx: PlatformContext, 
    missionId: string,
    reportId: string,
  ): Promise<ValidationReport | undefined> {
    await ctx.locate(missionId);
    if (!ctx.validation) {
      throw new PlatformRuleError(
        'VALIDATION_DEPS_REQUIRED',
        '读 ValidationReport 需要注入 PlatformDeps.validation.reports。',
      );
    }
    const report = await ctx.validation.reports.get(reportId);
    if (!report || report.missionId !== missionId) return undefined;
    return report;
  }

export async function workItemValidationReportViews(ctx: PlatformContext, 
    mission: Mission,
    events?: readonly ActivityEvent[],
  ): Promise<Map<string, ValidationReportView>> {
    const out = new Map<string, ValidationReportView>();
    const reports = ctx.validation?.reports;
    if (!reports) return out;
    if (!mission.workItems.some((item) => item.submittedAttemptId !== undefined)) return out;
    const reportIdByKey = new Map<string, string>();
    for (const event of events ?? (await ctx.activity.list(mission.id))) {
      if (event.kind !== 'validation.reported' || event.workItemId === undefined) continue;
      const data = event.data;
      if (data == null || typeof data !== 'object' || Array.isArray(data)) continue;
      const row = data as { reportId?: unknown; submittedAttemptId?: unknown };
      if (typeof row.reportId !== 'string' || row.reportId.length === 0) continue;
      // HA 的整 Mission 验证没有 submittedAttemptId（也不是某一条工作项的提交），跳过。
      if (typeof row.submittedAttemptId !== 'string' || row.submittedAttemptId.length === 0) continue;
      // 正序扫、后写盖前写：留下的是同一组键里最后（最新）那条。
      reportIdByKey.set(validationReportKey(event.workItemId, row.submittedAttemptId), row.reportId);
    }
    for (const item of mission.workItems) {
      const submittedAttemptId = item.submittedAttemptId;
      if (submittedAttemptId === undefined) continue;
      const reportId = reportIdByKey.get(validationReportKey(item.id, submittedAttemptId));
      if (reportId === undefined) continue;
      const report = await reports.get(reportId);
      if (!report || report.missionId !== mission.id) continue;
      if (report.workItemId !== undefined && report.workItemId !== item.id) continue;
      if (report.attemptId !== undefined && report.attemptId !== submittedAttemptId) continue;
      out.set(item.id, validationReportView(report));
    }
    return out;
  }
