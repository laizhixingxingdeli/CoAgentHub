import type { Mission, ValidationReport, WorkOrderValidationCommand } from '../../kernel/index.ts';
import type { ActivityEvent } from '../ports.ts';
import { PlatformRuleError, type PlatformContext } from './context.ts';
import type { ValidationReportView } from './types.ts';
import { validationReportKey, validationReportView } from './agent-view-helpers.ts';
import { normalizePath } from '../validation/engine.ts';

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

/**
 * 从一条 validation.reported 事件里取报告引用。
 *
 * 只看事件自己带的归属：event.missionId / workItemId / data.submittedAttemptId 三个
 * 全对得上才算「这次提交被验收过」。event.attemptId 不参与——写这条事件的是平台而
 * 不是执行者（standard-validation 故意留空），拿它判归属会永远判不出结果。
 */
function referencedReportId(
  event: ActivityEvent,
  missionId: string,
  workItemId: string,
  submittedAttemptId: string,
): string | undefined {
  if (event.kind !== 'validation.reported') return undefined;
  if (event.missionId !== missionId) return undefined;
  if (event.workItemId !== workItemId) return undefined;
  const data = event.data;
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const row = data as { reportId?: unknown; submittedAttemptId?: unknown };
  if (row.submittedAttemptId !== submittedAttemptId) return undefined;
  if (typeof row.reportId !== 'string' || row.reportId.length === 0) return undefined;
  return row.reportId;
}

/**
 * 协调者读「本工单当前提交」的完整机器验证报告。
 *
 * 为什么必须走「事件引用 → 报告」两步：报告 id 是 append-only 的自增事实，谁都可
 * 以猜。直接用 id 取，等于给协调者一个跨 Mission / 跨工单扫报告的入口；先要求活动
 * 流里有一条**这次提交**的 validation.reported 引用它，才有归属可言。
 *
 * 为什么只看当前 submittedAttemptId：旧提交的报告挂在旧 evidence 上，重派一次之后
 * 若退回旧报告，协调者会拿着上一跳的结果判定这一跳过了。旧事件在、当前没有来源时
 * 必须回 undefined，不能回退。
 *
 * 为什么报告自身字段还要再核一遍：事件是人（平台）写的，报告也是人（engine）写的，
 * 两边都不出错才成对。缺字段按失败处理——有一份归属不明的报告比没有更糟。
 */
export async function getAgentValidationReport(
  ctx: PlatformContext,
  missionId: string,
  workItemId: string,
  reportId?: string,
): Promise<ValidationReport | undefined> {
  // locate + mission.workItem 而不是 locateItem：查不到就当作没有报告。
  // locateItem 那句点名了 workItemId 的 UNKNOWN_WORK_ITEM，会让这个口变成
  // 「别的 Mission 有没有这个 id 的工单」的探测器。
  const { mission } = await ctx.locate(missionId);
  const item = mission.workItem(workItemId);
  const submittedAttemptId = item?.submittedAttemptId;
  if (submittedAttemptId === undefined) return undefined;
  const reports = ctx.validation?.reports;
  if (!reports) return undefined;

  const events = await ctx.activity.list(missionId);
  let referenced = reportId;
  if (referenced === undefined) {
    // 倒序：同一提交重跑了机器验收时，最新那份才是这次交付的依据。
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const candidate = referencedReportId(events[i]!, missionId, workItemId, submittedAttemptId);
      if (candidate !== undefined) {
        referenced = candidate;
        break;
      }
    }
  } else {
    // 显式 id 也必须被当前提交的某条引用事件认下：不认就直接没有。
    const known = events.some(
      (event) =>
        referencedReportId(event, missionId, workItemId, submittedAttemptId) === referenced,
    );
    if (!known) return undefined;
  }
  if (referenced === undefined) return undefined;

  const report = await reports.get(referenced);
  if (!report) return undefined;
  if (report.missionId !== missionId) return undefined;
  if (report.workItemId !== workItemId) return undefined;
  if (report.attemptId !== submittedAttemptId) return undefined;
  // 原报告整份交出去，不走简版投影：取的这一步已经验过归属，
  // 再裁一次只会把成功命令的长 outputTail 裁掉——那正是协调者要看的东西。
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

/** 事件里那条命令规格的形状：只认 argv + timeoutMs，多出来的字段一律忽略。 */
type ReuseCommandSpec = { readonly argv?: unknown; readonly timeoutMs?: unknown };

function readCommandSpecs(value: unknown): ReuseCommandSpec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ReuseCommandSpec[] = [];
  for (const raw of value) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    out.push(raw as ReuseCommandSpec);
  }
  return out;
}

/** argv 逐元素全等（长度与顺序都在内）。 */
function sameArgv(a: unknown, b: readonly string[] | readonly unknown[]): boolean {
  if (!Array.isArray(a)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (typeof a[i] !== 'string') return false;
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameCommands(
  eventCommands: readonly ReuseCommandSpec[],
  orderCommands: readonly WorkOrderValidationCommand[],
): boolean {
  if (eventCommands.length !== orderCommands.length) return false;
  for (let i = 0; i < eventCommands.length; i += 1) {
    const event = eventCommands[i]!;
    const order = orderCommands[i]!;
    if (typeof event.timeoutMs !== 'number') return false;
    if (event.timeoutMs !== order.timeoutMs) return false;
    if (!sameArgv(event.argv, order.argv)) return false;
  }
  return true;
}

/**
 * 判断一份已落盘的机器验收报告，其命令与范围是否仍是**当前这版工单**那一套。
 *
 * 全部按全等判，不做任何语义推断（不看机器名、Node 版本、cwd）：差异意味着「换了
 * 一件事」，不明确归类成「差不多」就能复用，否则覆写后的旧证据会被当成新工单的
 * 证据用。
 *
 * 报告侧的两处形状：
 * - command 检查项按出现顺序，argv 必须与工单命令序列全等（报告不存 timeoutMs）。
 * - changed-paths 检查项恰好一条，其 allowedScope 是 engine 已规范化的，所以工单
 *   侧要过一遍 normalizePath 才能比——写 `./src/foo.ts` 和写 `src/foo.ts` 是同一个
 *   范围，不算换了工单。
 *
 * 事件侧缺 commands / allowedScope（老事件）直接 false：猜不出就等于不能复用。
 */
export function reportReuseSpecMatches(input: {
  readonly eventData: unknown;
  readonly report: ValidationReport;
  readonly orderAllowedScope: readonly string[];
  readonly orderCommands: readonly WorkOrderValidationCommand[];
}): boolean {
  const data = input.eventData;
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return false;
  const event = data as { commands?: unknown; allowedScope?: unknown };
  const eventCommands = readCommandSpecs(event.commands);
  if (eventCommands === undefined) return false;
  if (!Array.isArray(event.allowedScope)) return false;
  if (!sameCommands(eventCommands, input.orderCommands)) return false;

  const eventScope = event.allowedScope;
  const orderScope = input.orderAllowedScope;
  if (eventScope.length !== orderScope.length) return false;
  for (let i = 0; i < eventScope.length; i += 1) {
    if (typeof eventScope[i] !== 'string') return false;
    if (eventScope[i] !== orderScope[i]) return false;
  }

  const reportCommandArgvs: string[][] = [];
  let changedPathsAllowed: readonly string[] | undefined;
  for (const check of input.report.checks) {
    if (check.kind === 'command') {
      const argv = check.command?.argv;
      if (argv === undefined) return false;
      reportCommandArgvs.push([...argv]);
      continue;
    }
    if (check.kind === 'changed-paths') {
      // 0 条或多于 1 条都说明这份报告不是按本工单的范围跑出来的。
      if (changedPathsAllowed !== undefined) return false;
      const allowed = check.changedPaths?.allowedScope;
      if (allowed === undefined) return false;
      changedPathsAllowed = allowed;
    }
  }
  if (changedPathsAllowed === undefined) return false;

  if (reportCommandArgvs.length !== input.orderCommands.length) return false;
  for (let i = 0; i < reportCommandArgvs.length; i += 1) {
    if (!sameArgv(reportCommandArgvs[i]!, input.orderCommands[i]!.argv)) return false;
  }

  const normalizedOrderScope = orderScope.map(normalizePath);
  if (changedPathsAllowed.length !== normalizedOrderScope.length) return false;
  for (let i = 0; i < changedPathsAllowed.length; i += 1) {
    if (changedPathsAllowed[i] !== normalizedOrderScope[i]) return false;
  }
  return true;
}
