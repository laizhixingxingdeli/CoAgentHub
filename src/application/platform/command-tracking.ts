import type { PlatformContext } from './context.ts';

export async function recordCommandTrackingEnabled(ctx: PlatformContext, missionId: string, attemptId: string): Promise<void> {
    const { mission } = await ctx.locate(missionId);
    await ctx.event(
      mission,
      'runtime.command_tracking.enabled',
      { schemaVersion: 1 },
      undefined,
      attemptId,
    );
  }

export async function recordCommandStarted(ctx: PlatformContext, missionId: string, attemptId: string, callId: string): Promise<void> {
    const { mission } = await ctx.locate(missionId);
    await ctx.event(
      mission,
      'runtime.command.started',
      { schemaVersion: 1, callId },
      undefined,
      attemptId,
    );
  }

export async function recordCommandTrackingInvalid(ctx: PlatformContext, missionId: string, attemptId: string): Promise<void> {
    const { mission } = await ctx.locate(missionId);
    await ctx.event(
      mission,
      'runtime.command_tracking.invalid',
      { schemaVersion: 1 },
      undefined,
      attemptId,
    );
  }
