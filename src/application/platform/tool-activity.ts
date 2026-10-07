import type { PlatformContext } from './context.ts';

/**
 * 工具结束事实（COM5 T2）。
 *
 * 为什么单独一个模块而不是并进 command-tracking.ts：命令计数只认适配器
 * 分类过的 `activityClass === 'command'`，是「跑了多少条命令」的门禁事实；
 * 工具结束是无条件的一条结束事实，没有分类可依赖。两件事共用去重键，
 * 很快就会出现「统计工具时长时把一条命令的开始当成工具的开始」这类错误。
 *
 * 刻意**不接受**调用方给的时间戳：`at` 一律由平台落盘时钟给出。回调里
 * 捕获的时间是「事件被收到」的时刻，落盘延迟会让两条事实的时间差不等于
 * 真实耗时；两个都由落盘钟给出时，误差只剩两次落盘延迟之差。
 */

function callIdOf(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const callId = (data as { callId?: unknown }).callId;
  return typeof callId === 'string' && callId.length > 0 ? callId : undefined;
}

export async function recordToolCompleted(
  ctx: PlatformContext,
  missionId: string,
  attemptId: string,
  input: { readonly callId: string; readonly name: string },
): Promise<void> {
  const { mission } = await ctx.locate(missionId);
  // 同一 attemptId + callId 只留一条：适配器重连、重复投递都可能把同一次
  // 结束再报一遍。多写一条不会让界面变丑，只会把「这次工具跑了多久」变成
  // 两条互相矛盾的事实——而工具时长正是这张票要落盘的东西。
  const events = await ctx.activity.list(missionId);
  const duplicate = events.some(
    (event) =>
      event.kind === 'runtime.tool.completed' &&
      event.attemptId === attemptId &&
      callIdOf(event.data) === input.callId,
  );
  if (duplicate) return;
  // workItemId 只从真实 attempt 上取；attempt 不在（旧适配器、直接调用的测试）
  // 时留空，不编一个工作项出来。
  const workItemId = mission.attempt(attemptId)?.workItemId;
  await ctx.event(
    mission,
    'runtime.tool.completed',
    { schemaVersion: 1, callId: input.callId, name: input.name },
    workItemId,
    attemptId,
  );
}
