import type { ValidationReport, WorkOrder } from '../../kernel/index.ts';
import { PlatformRuleError, type PlatformContext } from './context.ts';

/**
 * Standard 工作项验证基线事件。
 *
 * 事件流是台账，之后还要翻译给用户看（时间线文案），名字只在本文件写一次，
 * 不散着拼字符串。
 */
const VALIDATION_BASELINE_EVENT_KIND = 'work_item.validation_baseline_recorded';

/**
 * validation.reported 事件的写入数据。
 *
 * 除了报告引用，还必须带上**当时那版工单**的命令规格与 allowedScope：报告本身不存
 * timeoutMs，覆写 shortages 也不记命令，少了这两份原文，事后就无法判断「同一件事重
 * 跑一遍」还是「换了命令」。留给 reportReuseSpecMatches 做全等比对。
 *
 * argv / allowedScope 全部拷新数组：事件写进 append-only 台账就是历史快照，事后改
 * 入参还能改动它就等于台账可以被追溯地篡改。
 */
export function validationReportedData(
  report: Pick<ValidationReport, 'id' | 'passed'>,
  submittedAttemptId: string,
  order: WorkOrder,
): {
  reportId: string;
  passed: boolean;
  submittedAttemptId: string;
  commands: { argv: string[]; timeoutMs: number }[];
  allowedScope: string[];
} {
  const commands = order.validation?.commands ?? [];
  return {
    reportId: report.id,
    passed: report.passed,
    submittedAttemptId,
    commands: commands.map((command) => ({
      argv: [...command.argv],
      timeoutMs: command.timeoutMs,
    })),
    allowedScope: [...order.allowedScope],
  };
}

export async function recordStandardValidationBaseline(ctx: PlatformContext, input: {
    readonly missionId: string;
    readonly workItemId: string;
    readonly head: string;
  }): Promise<{ recorded: true }> {
    const head = input.head.trim();
    if (head.length === 0) {
      throw new PlatformRuleError(
        'VALIDATION_BASELINE_REQUIRED',
        '验证基线必须是 trusted workspace HEAD，不接受空值。',
      );
    }
    await ctx.tx(async () => {
      const { mission, item } = await ctx.locateItem(input.missionId, input.workItemId);
      await ctx.event(mission, VALIDATION_BASELINE_EVENT_KIND, { head }, item.id);
    });
    return { recorded: true };
  }

export async function workItemValidationBaseline(ctx: PlatformContext, 
    missionId: string,
    workItemId: string,
  ): Promise<string | undefined> {
    const events = await ctx.activity.list(missionId);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!;
      if (event.kind !== VALIDATION_BASELINE_EVENT_KIND) continue;
      if (event.workItemId !== workItemId) continue;
      const data = event.data;
      if (data == null || typeof data !== 'object' || Array.isArray(data)) continue;
      const head = (data as { head?: unknown }).head;
      if (typeof head !== 'string' || head.trim().length === 0) continue;
      return head.trim();
    }
    return undefined;
  }

export async function submittedAttemptReportId(ctx: PlatformContext, 
    missionId: string,
    workItemId: string,
    submittedAttemptId: string,
  ): Promise<string | undefined> {
    const events = await ctx.activity.list(missionId);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!;
      if (event.kind !== 'validation.reported') continue;
      if (event.workItemId !== workItemId) continue;
      const data = event.data;
      if (data == null || typeof data !== 'object' || Array.isArray(data)) continue;
      const row = data as { reportId?: unknown; submittedAttemptId?: unknown };
      if (row.submittedAttemptId !== submittedAttemptId) continue;
      if (typeof row.reportId !== 'string' || row.reportId.length === 0) continue;
      return row.reportId;
    }
    return undefined;
  }

export async function validateStandardWorkItem(ctx: PlatformContext, input: {
    readonly missionId: string;
    readonly workItemId: string;
    readonly cwd: string;
  }): Promise<{ reportId: string; passed: boolean; status: string } | undefined> {
    const { mission, item } = await ctx.locateItem(input.missionId, input.workItemId);
    const order = item.order;
    const commands = order?.validation?.commands ?? [];
    if (!order || commands.length === 0) {
      // 缺 validation.commands：不改变行为。不存空报告、不记 validation.reported。
      return undefined;
    }

    const validation = ctx.validation;
    if (!validation) {
      throw new PlatformRuleError(
        'VALIDATION_DEPS_REQUIRED',
        'Standard 机器验收需要注入 PlatformDeps.validation（engine + reports）。',
      );
    }
    if (item.status !== 'submitted') {
      throw new PlatformRuleError(
        'VALIDATION_NOT_SUBMITTED',
        `工作项 ${item.id} 当前是 ${item.status}，只能对 submitted 跑机器验收。`,
      );
    }
    const submittedAttemptId = item.submittedAttemptId;
    if (!submittedAttemptId) {
      throw new PlatformRuleError(
        'VALIDATION_SUBMITTED_ATTEMPT_REQUIRED',
        `工作项 ${item.id} 缺少 submittedAttemptId，拒绝机器验收。`,
      );
    }

    // 同一次提交已有落盘报告：原样返回，不重跑。重跑会换一个 reportId，
    // 而 L2 手上、时间线上引用的还是旧那份——一次重试就能把有效证据从
    // 「查得到」变成「查不到」。
    const existingReportId = await submittedAttemptReportId(ctx, 
      mission.id,
      item.id,
      submittedAttemptId,
    );
    if (existingReportId) {
      const existing = await validation.reports.get(existingReportId);
      if (existing && existing.missionId === mission.id) {
        return { reportId: existing.id, passed: existing.passed, status: item.status };
      }
    }

    const projectRoot = mission.workspaceRef?.projectRoot;
    if (!projectRoot) {
      throw new PlatformRuleError(
        'VALIDATION_WORKSPACE_REQUIRED',
        `Mission ${mission.id} 缺少 workspaceRef.projectRoot，不跑 engine。`,
      );
    }
    if (typeof input.cwd !== 'string' || input.cwd.trim().length === 0) {
      throw new PlatformRuleError(
        'VALIDATION_CWD_REQUIRED',
        'Standard 机器验收要求非空 cwd（trusted WorkspaceManager.prepare().cwd）。',
      );
    }
    const trustedCwd = input.cwd.trim();

    // 用本工作项自己的基线。没有就 fail-closed：拿 Mission base 顶上等于把别人的
    // 改动算进这条工单，正是这个入口存在要避免的事。
    const baseRevision = await workItemValidationBaseline(ctx, mission.id, item.id);
    if (!baseRevision) {
      throw new PlatformRuleError(
        'VALIDATION_BASELINE_MISSING',
        `工作项 ${item.id} 没有记过验证基线，拒绝用 Mission base 代替。`,
      );
    }

    // VAL-002：forbiddenPaths / diffSize 仅从 frozen order 拷贝；缺省 = 不在 force。
    const forbiddenPaths = order.validation?.forbiddenPaths;
    const diffSize = order.validation?.diffSize;

    const result = await validation.engine.validate({
      missionId: mission.id,
      workItemId: item.id,
      attemptId: submittedAttemptId,
      projectRoot,
      baseRevision,
      allowedScope: [...order.allowedScope],
      commands: commands.map((command) => ({
        argv: [...command.argv],
        timeoutMs: command.timeoutMs,
        cwd: trustedCwd,
      })),
      ...(forbiddenPaths !== undefined ? { forbiddenPaths: [...forbiddenPaths] } : {}),
      ...(diffSize !== undefined
        ? {
            diffSize: {
              ...(diffSize.maxChangedFiles !== undefined
                ? { maxChangedFiles: diffSize.maxChangedFiles }
                : {}),
              ...(diffSize.maxChangedLines !== undefined
                ? { maxChangedLines: diffSize.maxChangedLines }
                : {}),
            },
          }
        : {}),
    });

    // 跑命令可能要几分钟，不能占着事务（与 Lightweight 同理）：跑完再开事务存报告 + 记事件。
    return ctx.tx(async () => {
      // 事务里重取：跑命令那几分钟里活对象可能已经被别处换过。
      const { mission: live, item: liveItem } = await ctx.locateItem(
        input.missionId,
        input.workItemId,
      );
      // append-only 事实先落盘，再记引用它的事件。
      await validation.reports.save(result.report);
      await ctx.event(
        live,
        'validation.reported',
        validationReportedData(result.report, submittedAttemptId, order),
        liveItem.id,
        // attemptId 留空：写这条的是平台，不是执行者，也不是 reviewer。
      );
      // 不 review：passed 与否 item 都留在 submitted，等 L2 裁定。
      return { reportId: result.report.id, passed: result.report.passed, status: liveItem.status };
    });
  }
