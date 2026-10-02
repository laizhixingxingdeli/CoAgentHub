import type { UsedProfile, AttemptEndReason, TokenUsage } from '../../kernel/index.ts';
import type { ContextMetricsV1 } from '../ports.ts';
import type { QueueClaimIdentity } from './types.ts';
import { PlatformContext, PlatformRuleError, ATTEMPT_STARTED_KIND } from './context.ts';
import { redactSecrets } from '../redact.ts';
import { collectAttemptLiveTail, mergeAttemptOutput } from '../live.ts';
import { sanitizeAttemptContextMetrics, activityDataHasContextMetrics } from './context-metrics.ts';

export function queuedAttemptStartedData<T extends { readonly kind: string }>(
  base: T,
  claim?: QueueClaimIdentity,
): T | (T & { readonly queue: true }) {
  return claim ? { ...base, queue: true } : base;
}

export async function startCoordinatorAttempt(ctx: PlatformContext, 
    missionId: string,
    profile?: UsedProfile,
    claim?: QueueClaimIdentity,
  ): Promise<{ attemptId: string }> {
    const { mission } = await ctx.locate(missionId);
    const attempt = mission.startCoordinatorAttempt();
    if (profile) attempt.recordProfile(profile);
    await ctx.event(
      mission,
      ATTEMPT_STARTED_KIND,
      queuedAttemptStartedData({ kind: 'coordinator', profile }, claim),
      undefined,
      attempt.id,
    );
    return { attemptId: attempt.id };
  }

export async function startExecutorAttempt(ctx: PlatformContext, 
    missionId: string,
    workItemId: string,
    profile?: UsedProfile,
    claim?: QueueClaimIdentity,
  ): Promise<{ attemptId: string }> {
    const { mission, item } = await ctx.locateItem(missionId, workItemId);
    // 提交结果 ≠ 尝试结束。调度器必须在 finally 里 finishAttempt，否则运行时
    // 进程一崩，这个工作项就永远开不了下一次尝试。把这种卡死报成看得懂的话，
    // 而不是一句泛泛的不变量冲突。
    const stuck = item.attempts.find((a) => a.status === 'in_progress');
    if (stuck) {
      throw new PlatformRuleError(
        'ATTEMPT_STILL_RUNNING',
        `工作项 ${workItemId} 上的 attempt ${stuck.id} 还是 in_progress：` +
          '上一次尝试没有被收尾。先 finishAttempt 再开新的。',
      );
    }
    const attempt = item.startAttempt();
    if (profile) attempt.recordProfile(profile);
    await ctx.event(
      mission,
      ATTEMPT_STARTED_KIND,
      queuedAttemptStartedData({ kind: 'executor', profile }, claim),
      workItemId,
      attempt.id,
    );
    return { attemptId: attempt.id };
  }

export async function finishAttempt(ctx: PlatformContext, 
    missionId: string,
    attemptId: string,
    outcome: {
      endedBy: AttemptEndReason;
      usage?: TokenUsage;
      failureMessage?: string;
      /** 运行时留下的续跑句柄。落库才能跨进程续上。 */
      resumeRef?: string;
      /** 这一跳的原始输出（尾部）。Timeline 第三层用。 */
      output?: string;
      /** 这一跳调过的工具名序列。Timeline 第二层用。 */
      toolCalls?: readonly string[];
      /** 运行时实际解析到的身份（S13.3）。 */
      resolvedProfile?: {
        readonly revision: string;
        readonly resolved: readonly { readonly key: string; readonly value: string }[];
      };
      contextMetrics?: unknown;
    },
  ): Promise<void> {
    // 失败原文与输出尾部都会落盘、进界面：agent 打过 `env` 的话，本机的 key 就在里面。
    const failureMessage =
      outcome.failureMessage !== undefined ? redactSecrets(outcome.failureMessage) : undefined;
    const { mission } = await ctx.locate(missionId);
    const attempt = mission.attempt(attemptId);
    if (!attempt) {
      throw new PlatformRuleError('UNKNOWN_ATTEMPT', `attempt ${attemptId} 不存在`);
    }
    // 已终态再收尾仍走旧副作用（用量/输出），但不得再写一份采集成功事实。
    const alreadyTerminal = attempt.status !== 'in_progress';
    // 必须在 live.finish 之前取（编排器先 finishAttempt 再裁剪缓冲）。
    // 已终态不再取尾：否则重复收尾会把同一段 appendOutput 无限接上。
    let liveTail: string | undefined;
    if (ctx.live && !alreadyTerminal) {
      try {
        liveTail = await collectAttemptLiveTail(ctx.live, missionId, attemptId);
      } catch {
        // 实时通道读失败不能挡收尾，否则 attempt 卡在 in_progress。
      }
    }
    const merged = mergeAttemptOutput(outcome.output, liveTail);
    const output = merged !== undefined ? redactSecrets(merged) : undefined;
    if (outcome.usage) attempt.recordUsage(outcome.usage);
    if (outcome.resumeRef) attempt.recordResumeRef(outcome.resumeRef);
    // 把运行时报回来的实际身份并进开跑时记的那份（S13.3）。
    // 开跑时只知道 profileId —— 它指向什么，只有跑完了适配层才说得出来。
    if (outcome.resolvedProfile && attempt.profile) {
      attempt.recordProfile({
        ...attempt.profile,
        revision: outcome.resolvedProfile.revision,
        resolved: outcome.resolvedProfile.resolved,
      });
    }
    if (output) {
      // 大输出外置：状态是一次整份写出去的，把几十万字符塞进去会让
      // **每一次工具调用**都变慢。
      const blob = ctx.artifacts.put(output);
      attempt.appendOutput(blob.inline ?? `${blob.preview ?? ''}
…（共 ${blob.bytes} 字节，完整内容见 artifact:${blob.ref}）`);
      if (blob.ref) attempt.recordOutputRef(blob.ref);
    }
    for (const name of outcome.toolCalls ?? []) {
      attempt.recordToolCall(name, new Date().toISOString());
    }
    attempt.recordEndReason(outcome.endedBy);
    if (attempt.status === 'in_progress') {
      if (outcome.endedBy === 'structured_submit') attempt.succeed();
      else attempt.fail(failureMessage ?? outcome.endedBy);
    }
    let contextMetrics: ContextMetricsV1 | undefined;
    if (!alreadyTerminal) {
      contextMetrics = sanitizeAttemptContextMetrics(outcome.contextMetrics);
      if (contextMetrics !== undefined) {
        const prior = await ctx.activity.list(missionId);
        if (
          prior.some(
            (event) =>
              event.kind === 'attempt.ended' &&
              event.attemptId === attemptId &&
              activityDataHasContextMetrics(event.data),
          )
        ) {
          contextMetrics = undefined;
        }
      }
    }
    await ctx.event(
      mission,
      'attempt.ended',
      {
        endedBy: outcome.endedBy,
        failureMessage,
        usage: attempt.usage,
        retriable: outcome.endedBy === 'upstream_failure',
        ...(contextMetrics !== undefined ? { contextMetrics } : {}),
      },
      attempt.workItemId,
      attemptId,
    );
  }

export async function beatAttempt(ctx: PlatformContext, missionId: string, attemptId: string, owner?: string): Promise<void> {
    const { mission, project } = await ctx.locate(missionId);
    const attempt = mission.attempt(attemptId);
    if (!attempt || attempt.status !== 'in_progress') return;
    attempt.beat(ctx.clock.now().toISOString(), owner);
    // **必须落盘。** 心跳的全部作用就是让*别的进程*看见它；只改内存对象的话，
    // 别的进程读到的仍然是"从没心跳过"，于是照样把它判死。
    await ctx.projects.save(project);
  }
