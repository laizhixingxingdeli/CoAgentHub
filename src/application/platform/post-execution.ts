import type { Mission } from '../../kernel/index.ts';
import type { PlatformContext } from './context.ts';
import { POST_EXECUTION_SHADOW_EVENT_KIND, postExecutionInputFrom, recordPostExecutionShadow } from '../post-execution-shadow.ts';

export async function runPostExecutionShadow(ctx: PlatformContext, missionId: string, workItemId: string): Promise<void> {
    const evaluator = ctx.postExecutionEvaluator;
    if (!evaluator || !ctx.decisionHooks.has('POST_EXECUTION')) return;
    try {
      const { mission } = await ctx.locate(missionId);
      const item = mission.workItem(workItemId);
      const submittedAttemptId = item?.submittedAttemptId;
      const order = item?.order;
      const result = item?.executionResult;
      if (!item || (item.status !== 'submitted' && item.status !== 'accepted') || !submittedAttemptId || !order || !result) return;
      // 一次交卷只问一次：崩溃后接着跑会把同一次提交再验一遍，这时不再多花一次付费调用。
      const events = await ctx.activity.list(missionId);
      if (events.some((e) => e.kind === POST_EXECUTION_SHADOW_EVENT_KIND && shadowAttemptOf(e.data) === submittedAttemptId)) return;
      const attempt = item.attempts.find((a) => a.id === submittedAttemptId);
      const trustedFiles = await trustedChangedFiles(ctx, mission);
      const { input, filesSource } = postExecutionInputFrom({
        order,
        result,
        evidence: attempt?.evidence ?? [],
        ...(trustedFiles ? { trustedFiles } : {}),
        ...(attempt ? { toolActivityCount: attempt.toolActivity.length } : {}),
      });
      await recordPostExecutionShadow(
        { evaluator, activity: ctx.activity, clock: ctx.clock },
        { projectId: mission.projectId, missionId, workItemId, submittedAttemptId, input, filesSource },
      );
    } catch {
      // shadow 从不影响主流程。
    }
  }

export async function trustedChangedFiles(ctx: PlatformContext, mission: Mission): Promise<readonly string[] | undefined> {
    const ref = mission.workspaceRef;
    if (!ctx.workspace || typeof ctx.workspace.worktreePath !== 'function') return undefined;
    if (!ref?.projectRoot || !ref.baseRevision) return undefined;
    try {
      return (await ctx.workspace.diff(mission.id, ref.baseRevision, ref.projectRoot)).files;
    } catch {
      return undefined;
    }
  }

/** decision.post_execution 事件问的是哪一次提交；读不出来就当不是（宁可多问一次，不漏问）。 */
function shadowAttemptOf(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const ids = (data as { ids?: unknown }).ids;
  if (ids === null || typeof ids !== 'object') return undefined;
  const id = (ids as { submittedAttemptId?: unknown }).submittedAttemptId;
  return typeof id === 'string' ? id : undefined;
}
