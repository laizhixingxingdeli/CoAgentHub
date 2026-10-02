import type { Mission, PromotionTriggerCode } from '../../kernel/index.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import { lightweightGateTrigger } from '../promotion/lightweight-gate.ts';

export async function validateAndAcceptLightweightWorkItem(
  ctx: PlatformContext,
  requireLightweightMutationLane: (mission: Mission) => void,input: {
    readonly missionId: string;
    readonly workItemId: string;
    readonly cwd: string;
  }): Promise<{ reportId: string; passed: boolean; status: string; held?: PromotionTriggerCode }> {
    const { mission, item } = await ctx.locateItem(input.missionId, input.workItemId);
    requireLightweightMutationLane(mission);

    if (!ctx.validation) {
      throw new PlatformRuleError(
        'VALIDATION_DEPS_REQUIRED',
        'Lightweight 验收需要注入 PlatformDeps.validation（engine + reports）。',
      );
    }

    if (item.status !== 'submitted') {
      throw new PlatformRuleError(
        'VALIDATION_NOT_SUBMITTED',
        `工作项 ${item.id} 当前是 ${item.status}，只能对 submitted 做机器验收。`,
      );
    }

    const submittedAttemptId = item.submittedAttemptId;
    if (!submittedAttemptId) {
      throw new PlatformRuleError(
        'VALIDATION_SUBMITTED_ATTEMPT_REQUIRED',
        `工作项 ${item.id} 缺少 submittedAttemptId，拒绝机器验收。`,
      );
    }

    const order = item.order;
    if (!order) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_ORDER_REQUIRED',
        `工作项 ${item.id} 缺少 order，不跑 engine。`,
      );
    }
    // empty / absent validation.commands 合法：只跑 changed-paths。
    const commands = order.validation?.commands ?? [];
    // VAL-002：forbiddenPaths / diffSize 仅从 frozen order 拷贝；缺省 = 不在 force。
    // 不得从 ExecutionBudget / promotion / prose 填默认值。
    const forbiddenPaths = order.validation?.forbiddenPaths;
    const diffSize = order.validation?.diffSize;

    const projectRoot = mission.workspaceRef?.projectRoot;
    const baseRevision = mission.workspaceRef?.baseRevision;
    if (!projectRoot || !baseRevision) {
      throw new PlatformRuleError(
        'VALIDATION_WORKSPACE_REQUIRED',
        `Mission ${mission.id} 缺少 workspaceRef.projectRoot/baseRevision，不跑 engine。`,
      );
    }

    if (typeof input.cwd !== 'string' || input.cwd.trim().length === 0) {
      throw new PlatformRuleError(
        'VALIDATION_CWD_REQUIRED',
        'Lightweight 验收要求非空 cwd（trusted WorkspaceManager.prepare().cwd）。',
      );
    }
    const trustedCwd = input.cwd.trim();

    // ValidationInput 只能由 Platform 绑定；每个 command 的 cwd 强制覆盖成 trusted cwd。
    const result = await ctx.validation.engine.validate({
      missionId: mission.id,
      workItemId: item.id,
      attemptId: submittedAttemptId,
      projectRoot,
      baseRevision,
      allowedScope: [...order.allowedScope],
      commands: commands.map((c) => ({
        argv: [...c.argv],
        timeoutMs: c.timeoutMs,
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

    // 跑完验收命令之后才开事务（C4）：跑命令可能要几分钟，不能占着事务。
    // 报告、validation.reported、validator accept 一起提交；报告是 append-only 事实，authority 对不上时
    // 照旧保留——拒绝在事务里只做标记，提交之后再抛。
    const validation = ctx.validation;
    const committed = await ctx.tx(async () => {
      // 事务里重取：跑命令那几分钟里，活对象可能已经被别处换过。
      const { mission: live, item: liveItem } = await ctx.locateItem(input.missionId, input.workItemId);

      // append-only：必须先于任何 review / accept。
      await validation.reports.save(result.report);

      await ctx.event(
        live,
        'validation.reported',
        {
          reportId: result.report.id,
          passed: result.report.passed,
          submittedAttemptId,
        },
        liveItem.id,
        // ActivityEvent.attemptId 不要冒充 reviewer
      );

      if (result.report.passed === false) {
        // failed report 已保存；不 accept / reject，item 保持 submitted。
        return { kind: 'failed' as const, status: liveItem.status };
      }

      // §4.3：实际改动超出 Lightweight 的规模（>3 文件 / >2 顶层目录）时，机器验收过了也不放行。
      // 一旦 accept，升级到 Standard 之后 L2 就没东西可审了——大改动会绕过评审。
      // 留在 submitted，由 promoteLightweightAfterValidation 凭这份报告升级。
      const held = lightweightGateTrigger(result.report);
      if (held) {
        return { kind: 'held' as const, status: liveItem.status, held: held.code };
      }

      const authority = result.authority;
      const report = result.report;
      const mismatch =
        !authority ||
        authority.kind !== 'validator' ||
        authority.reportId !== report.id ||
        authority.policyRevision !== report.policyRevision ||
        report.missionId !== live.id ||
        report.workItemId !== liveItem.id ||
        report.attemptId !== submittedAttemptId;

      if (mismatch) {
        // 报告保留，item 仍 submitted：提交之后再抛。
        return { kind: 'mismatch' as const, status: liveItem.status };
      }

      liveItem.review('accept', {
        submittedAttemptId,
        authority,
        reasons: [`ValidationReport ${report.id} passed`],
        requiredChanges: [],
      });

      await ctx.event(
        live,
        'review.recorded',
        {
          verdict: 'accept',
          authority: 'validator',
          reportId: report.id,
          reasons: [`ValidationReport ${report.id} passed`],
        },
        liveItem.id,
        // ActivityEvent.attemptId 留空
      );

      return { kind: 'accepted' as const, status: liveItem.status };
    });

    if (committed.kind === 'failed') {
      return { reportId: result.report.id, passed: false, status: committed.status };
    }
    if (committed.kind === 'held') {
      return { reportId: result.report.id, passed: true, status: committed.status, held: committed.held };
    }
    if (committed.kind === 'mismatch') {
      throw new PlatformRuleError(
        'VALIDATION_AUTHORITY_MISMATCH',
        `ValidationReport ${result.report.id} 通过，但 authority/linkage 与 WorkItem 不一致，拒绝 accept。`,
      );
    }

    return { reportId: result.report.id, passed: true, status: committed.status };
  }
