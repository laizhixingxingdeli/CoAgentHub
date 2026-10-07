import type { ValidationReport } from '../../kernel/index.ts';
import type { ActivityEvent } from '../ports.ts';
import type {
  TimeAttribution,
  TimeAttributionHop,
  TimeAttributionValidationReport,
} from '../time-attribution.ts';
import { projectTimeAttribution } from '../time-attribution.ts';
import type { PlatformContext } from './context.ts';

/**
 * GET 任务详情读模型里的时间归因投影（COM5 T4）。
 *
 * 为什么单独一个模块、并且在 Platform 上与 getMissionView 分居：这张投影要从
 * `validation.reported` 的引用去报告仓储另取起止，还要读本 Mission 的 hop 行。
 * 把这两步塞进 getMissionView，等于让**每一个**只想知道状态的调用方（列表页、
 * 调度器、协调者取契约）都多读一次报告仓储；而这些调用方根本不画时间线。
 * 所以由页面那条 GET 自己拼装，getMissionView 一个字节都不动。
 *
 * 为什么只做白名单映射：报告里的 `outputTail` 是命令原文（含退出码与输出），
 * 它不属于时间归因输入。整份报告直接透传，就会随页面载荷、日志或 HTTP 响应
 * 一起离开平台——而这条链路是只读观测面，没有理由带命令正文。
 *
 * 为什么读 hop 时不带 `updatedAt`：它会被认领、续租、失败反复覆盖，当认领时点
 * 用会得出错误的等待时长（见 time-attribution.ts 的 TimeAttributionHop 注释）。
 */

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `validation.reported` 引用过的报告 id，按出现顺序去重。 */
function referencedReportIds(events: readonly ActivityEvent[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'validation.reported') continue;
    const reportId = str(asRecord(event.data).reportId);
    if (reportId === undefined || seen.has(reportId)) continue;
    seen.add(reportId);
    out.push(reportId);
  }
  return out;
}

function toValidationReport(report: ValidationReport): TimeAttributionValidationReport {
  const checks = report.checks.map((check) => ({
    kind: check.kind,
    startedAt: check.startedAt,
    endedAt: check.endedAt,
  }));
  const mapped: {
    id: string;
    startedAt: string;
    endedAt: string;
    checks: readonly { kind: string; startedAt: string; endedAt: string }[];
    attemptId?: string;
    workItemId?: string;
  } = {
    id: report.id,
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    checks,
  };
  if (report.attemptId !== undefined) mapped.attemptId = report.attemptId;
  if (report.workItemId !== undefined) mapped.workItemId = report.workItemId;
  return mapped;
}

/**
 * 报告要靠活动流里的引用才认领：报告 id 是 append-only 的自增事实，谁都能猜，
 * 只看 id 取等于给观测面开了一个跨 Mission 扫报告的入口。认领之后再核一遍
 * `report.missionId`：两边都对上才属于这条 Mission。
 *
 * 没装配 `validation.reports` 就当作没有报告（不是错误）：观测面在精简装配下
 * 仍要能出页面，只是这一格标未知。
 */
async function collectValidationReports(
  ctx: PlatformContext,
  missionId: string,
  events: readonly ActivityEvent[],
): Promise<TimeAttributionValidationReport[]> {
  const reports = ctx.validation?.reports;
  if (!reports) return [];
  const out: TimeAttributionValidationReport[] = [];
  for (const reportId of referencedReportIds(events)) {
    const report = await reports.get(reportId);
    if (!report || report.missionId !== missionId) continue;
    out.push(toValidationReport(report));
  }
  return out;
}

async function collectHops(ctx: PlatformContext, missionId: string): Promise<TimeAttributionHop[]> {
  const rows = (await ctx.queuedHops?.list()) ?? [];
  return rows
    .filter((hop) => hop.missionId === missionId)
    .map((hop) => ({
      id: hop.id,
      role: hop.role,
      workItemId: hop.workItemId,
      createdAt: hop.createdAt,
      status: hop.status,
    }));
}

/**
 * 只读：读活动流、按引用取报告起止、读本 Mission 的 hop，交给纯投影。
 * 不写任何状态，不用当前时间闭合任何阶段。
 */
export async function getTimeAttribution(
  ctx: PlatformContext,
  missionId: string,
): Promise<TimeAttribution> {
  await ctx.locate(missionId);
  const events = await ctx.activity.list(missionId);
  const validationReports = await collectValidationReports(ctx, missionId, events);
  const hops = await collectHops(ctx, missionId);
  return projectTimeAttribution({ activity: events, validationReports, hops });
}
