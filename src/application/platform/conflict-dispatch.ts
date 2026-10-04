import type { PlatformContext } from './context.ts';

export async function recordConflictDispatchBarrier(ctx: PlatformContext, 
    missionId: string,
    conflictFiles: readonly string[],
  ): Promise<readonly string[]> {
    return ctx.tx(async () => {
      const { mission } = await ctx.locate(missionId);
      const events = await ctx.activity.list(missionId);
      let barrier: readonly string[] | undefined;
      for (const event of events) {
        if (event.kind === 'mission.conflict_dispatch_barrier') {
          const data = event.data as { workItemIds?: unknown };
          barrier = Array.isArray(data.workItemIds) ? data.workItemIds as string[] : [];
        } else if (event.kind === 'mission.conflict_dispatch_cleared') {
          barrier = undefined;
        }
      }
      if (conflictFiles.length === 0) {
        if (barrier !== undefined) await ctx.event(mission, 'mission.conflict_dispatch_cleared', {});
        return [];
      }
      if (barrier !== undefined) return [...barrier];
      const workItemIds = mission.workItems.filter((item) => item.status === 'dispatched').map((item) => item.id);
      await ctx.event(mission, 'mission.conflict_dispatch_barrier', {
        conflictFiles: [...conflictFiles],
        workItemIds,
      });
      return workItemIds;
    });
  }
