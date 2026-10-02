import { PlatformRuleError, type PlatformContext } from './context.ts';
import { InvariantViolationError, type Mission, type Project } from '../../kernel/index.ts';

export async function acquireMutationSlotForDispatch(ctx: PlatformContext, mission: Mission, project: Project): Promise<void> {
    // 派发 = 这个 Mission 要开始改代码了，此刻占用 Project 的改动名额。
    // 不变量 C 在这里才真正生效：同 Project 的第二个 Mission 走到这一步会被
    // 挡下，而不是等到两边都改完才发现冲突。放在改 WorkItem 状态之前，
    // 被拒绝的派发不留下半套流转。
    if (!mission.isMutating) {
      try {
        mission.startExecuting();
      } catch (error) {
        if (error instanceof InvariantViolationError && error.code === 'CONCURRENT_MUTATING_MISSION') {
          // 记下停机原因：这不是"失败"，是排队。调度器据此让这条 Mission
          // 先歇着去跑别的，而不是当成出错。
          // 点名占着名额的是谁。只说"忙"的话，人下一步只能挨个 Mission 去翻。
          const holder = project.missions.find((m) => m.id !== mission.id && m.isMutating);
          mission.setWaitReason(
            'project_busy',
            holder
              ? `${holder.id} 正占着 ${mission.projectId} 的改动名额（${holder.status}）。` +
                '它落地或被放弃之后，这条会自动接上。'
              : undefined,
          );
          await ctx.event(mission, 'mission.waiting', { reason: 'project_busy' });
          throw new PlatformRuleError(
            'PROJECT_BUSY',
            `本 Project 已经有别的 Mission 在改代码了。可以继续调查和规划，` +
              `但要等它结束才能派发实现任务。`,
          );
        }
        throw error;
      }
    } else if (mission.status !== 'executing') {
      // 已经占着改动名额、但阶段被退回过（L3 改契约、或 L2 自己退回规划）。
      //
      // 名额不用重新占，**阶段却必须重新推到 executing**：调度器只在这个
      // 阶段跑执行者。少了这一步，重新派发出去的工单永远不会被执行——
      // 而界面上看它就是"已派发"，看不出为什么不动。实测踩到过一次死锁。
      mission.startExecuting();
    }
  }

export function requireLightweightMutationLane(ctx: PlatformContext, mission: Mission): void {
    if (mission.executionMode !== 'lightweight') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_MODE_REQUIRED',
        `需要 executionMode=lightweight，当前是 ${mission.executionMode}。`,
      );
    }
    if (mission.runKind !== 'mutation') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_RUN_KIND_REQUIRED',
        `需要 runKind=mutation，当前是 ${mission.runKind}。`,
      );
    }
  }
