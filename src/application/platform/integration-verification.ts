import { PlatformRuleError, type PlatformContext } from './context.ts';
import type { Mission, ValidationReport, ValidationCheckResult } from '../../kernel/index.ts';
import { VALIDATION_POLICY_REVISION } from '../validation/engine.ts';
import { redactSecrets } from '../redact.ts';

export async function runIntegrationMergeVerify(ctx: PlatformContext, landMemory: (mission: Mission) => Promise<void>, input: {
    readonly mission: Mission;
    readonly projectRoot: string;
    readonly integrationBranch: string;
    readonly verification: readonly { readonly argv: readonly string[]; readonly timeoutMs: number }[];
  }): Promise<
    | { kind: 'merge_failed'; reason?: string; anchor: string }
    | {
        kind: 'verify_failed';
        mergedInto: string;
        report: ValidationReport;
        anchor: string;
        reset: { ok: boolean; reason?: string };
      }
    | { kind: 'verified'; mergedInto: string; report: ValidationReport; anchor: string }
    | {
        kind: 'advanced_during_verify';
        mergedInto: string;
        report: ValidationReport;
        anchor: string;
        checkout?: string;
        head: string;
      }
  > {
    const workspace = ctx.workspace;
    const runner = ctx.validation?.commandRunner;
    const reports = ctx.validation?.reports;
    if (!workspace?.resetTarget || !runner || !reports) {
      throw new PlatformRuleError(
        'MACHINE_FINALIZE_UNAVAILABLE',
        '没注入 commandRunner / reports / resetTarget，不能做合并结果验证。',
      );
    }
    const { mission, projectRoot, integrationBranch, verification } = input;
    const anchor = await workspace.targetHead(projectRoot);
    await ctx.event(mission, 'final_review.integration_anchor', {
      integrationBranch,
      anchor,
    });
    const ref = mission.workspaceRef;
    if (!ref) {
      throw new PlatformRuleError('NO_WORKSPACE_REF', `Mission ${mission.id} 没记下分支信息。`);
    }
    // 补入独立文档队列，代码合并不等待文档批准。
    await landMemory(mission);
    const merged = await workspace.mergeToTarget({
      missionId: mission.id,
      projectRoot,
      branch: ref.branch,
      expectedBaseRevision: ref.baseRevision,
      message: `merge(mission): ${mission.id} ${mission.contract.intent.split(/[。！？.!?\n]/u)[0].slice(0, 60)}`,
    });
    if (!merged.ok) {
      return { kind: 'merge_failed', reason: merged.reason, anchor };
    }
    const mergedInto = merged.mergedInto ?? (await workspace.targetHead(projectRoot));
    await ctx.event(mission, 'final_review.merge_applied', {
      integrationBranch,
      mergedInto,
      anchor,
    });

    const startedAt = ctx.clock.now().toISOString();
    const checks: ValidationCheckResult[] = [];
    for (const command of verification) {
      const at = ctx.clock.now().toISOString();
      const result = await runner.run({
        argv: command.argv,
        cwd: projectRoot,
        timeoutMs: command.timeoutMs,
      });
      checks.push(
        Object.freeze({
          kind: 'command' as const,
          passed: result.exitCode === 0 && !result.timedOut,
          startedAt: at,
          endedAt: ctx.clock.now().toISOString(),
          summary: `${command.argv.join(' ')} → ${result.timedOut ? 'timeout' : String(result.exitCode)}`,
          command: Object.freeze({
            argv: Object.freeze([...command.argv]),
            cwd: projectRoot,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            outputTail: redactSecrets(result.output).slice(-2000),
          }),
        }),
      );
    }
    const passed = checks.every((check) => check.passed);
    const report: ValidationReport = Object.freeze({
      id: ctx.ids.next('IVAL'),
      policyRevision: VALIDATION_POLICY_REVISION,
      missionId: mission.id,
      startedAt,
      endedAt: ctx.clock.now().toISOString(),
      passed,
      checks: Object.freeze(checks),
    });
    await reports.save(report);
    await ctx.event(mission, 'final_review.integration_verified', {
      reportId: report.id,
      passed,
      mergedInto,
    });
    if (!passed) {
      let reset: { ok: boolean; reason?: string };
      try {
        reset = await workspace.resetTarget({
          projectRoot,
          toRevision: anchor,
          expectedHead: mergedInto,
        });
      } catch (error) {
        // git reset 抛错不能当未处理异常溜走：当次必须留下可持久识别的
        // rollback_failed，重建平台后再放行才能继续拦住。
        reset = {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      return { kind: 'verify_failed', mergedInto, report, anchor, reset };
    }
    // 验证绿了还不能签字：runner 期间第三方可能已推进目标或切走 checkout。
    // checkout 仍是目标分支、HEAD 仍是本次合并提交（合并结果未被替换），缺一不签 FinalReview。
    const checkoutNow =
      typeof workspace.currentBranch === 'function'
        ? await workspace.currentBranch(projectRoot)
        : undefined;
    const headNow = await workspace.targetHead(projectRoot);
    if (checkoutNow !== integrationBranch || headNow !== mergedInto) {
      return {
        kind: 'advanced_during_verify',
        mergedInto,
        report,
        anchor,
        checkout: checkoutNow,
        head: headNow,
      };
    }
    return { kind: 'verified', mergedInto, report, anchor };
  }
