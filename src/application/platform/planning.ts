import type { PlanBody } from '../../kernel/index.ts';
import type { PlatformContext } from './context.ts';

export async function updateFindings(
  ctx: PlatformContext,
    missionId: string,
    attemptId: string,
    findings: string,
    rejectedHypotheses?: readonly string[],
  ): Promise<{ planRevision: number }> {
    const { mission } = await ctx.requireAttempt(missionId, attemptId, 'coordinator');
    const previous = mission.plan;
    const accumulatedFindings = previous?.findings
      ? `${previous.findings}\n\n—— 第 ${mission.planRevision + 1} 次补充\n${findings}`
      : findings;
    const accumulatedHypotheses = rejectedHypotheses === undefined
      ? [...(previous?.rejectedHypotheses ?? [])]
      : [...new Set([...(previous?.rejectedHypotheses ?? []), ...rejectedHypotheses])];
    const planRevision = mission.updatePlan({
      findings: accumulatedFindings,
      // 其余字段沿用上一版：这个口的语义是"只补发现"，不是"把没填的清空"。
      rootCause: previous?.rootCause,
      rejectedHypotheses: accumulatedHypotheses,
      decisions: [...(previous?.decisions ?? [])],
      direction: previous?.direction ?? '',
      risks: [...(previous?.risks ?? [])],
    });
    await ctx.event(
      mission,
      'plan.updated',
      { planRevision, findingsOnly: true },
      undefined,
      attemptId,
    );
    return { planRevision };
  }

export async function updatePlan(
  ctx: PlatformContext,
    missionId: string,
    attemptId: string,
    plan: PlanBody,
  ): Promise<{ planRevision: number }> {
    const { mission } = await ctx.requireAttempt(missionId, attemptId, 'coordinator');
    const planRevision = mission.updatePlan(plan);
    await ctx.event(mission, 'plan.updated', { planRevision }, undefined, attemptId);
    return { planRevision };
  }
