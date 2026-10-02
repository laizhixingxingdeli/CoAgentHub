import type { MissionContract, WaitReason } from '../../kernel/index.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
type AnswerEscalation = (missionId: string, answer: string) => Promise<{ question: string; answer: string }>;

export async function reviseContract(ctx: PlatformContext, answerEscalation: AnswerEscalation, 
    missionId: string,
    contract: MissionContract,
  ): Promise<{ contractRevision: number }> {
    const { mission } = await ctx.locate(missionId);
    const contractRevision = mission.reviseContract(contract);
    // 契约改了，之前那份交卷、以及**已经派出去的工单**，都是照着旧契约做的。
    // 一律退回规划，让协调者拿着新契约重新判断（S14.6：compatible / replan /
    // cancel-replace 是 L2 的判断，不是平台的）。
    //
    // 早先只在 awaiting_review 时退回。实测中途改需求时踩到了：Mission 还在
    // executing，工单已经派出去，调度器照样先跑执行者——等 L2 被叫醒时，
    // 按旧契约做的东西已经做完了。钱花了，而且做的是明确不要的那件事。
    if (mission.status === 'executing' || mission.status === 'awaiting_review') {
      mission.sendBackToPlanning({
        verdict: 'send_back',
        reasons: [`Contract 已更新到 r${contractRevision}，需要按新契约重新核对`],
      });
    }
    await ctx.event(mission, 'contract.revised', { contractRevision, status: mission.status });
    return { contractRevision };
  }


export async function setWaitReason(ctx: PlatformContext, answerEscalation: AnswerEscalation, 
    missionId: string,
    reason: WaitReason | undefined,
    detail?: string,
  ): Promise<void> {
    const { mission } = await ctx.locate(missionId);
    // detail 变了也要写：同一个 no_available_agent，"卡在 exec-a" 和
    // "卡在 exec-d" 对排障的人是两条不同的信息。
    if (mission.waitReason === reason && mission.waitDetail === detail) return;
    mission.setWaitReason(reason, detail);
    await ctx.event(mission, reason ? 'mission.waiting' : 'mission.resumed', {
      reason,
      detail,
    });
  }


export async function cancelMission(ctx: PlatformContext, answerEscalation: AnswerEscalation, missionId: string, reason?: string): Promise<{ status: string }> {
    const { mission } = await ctx.locate(missionId);
    mission.cancel();
    await ctx.event(mission, 'mission.cancelled', { reason });
    await ctx.releaseWorkspace(missionId, mission.workspaceRef?.projectRoot);
    return { status: mission.status };
  }


export async function pauseMission(ctx: PlatformContext, answerEscalation: AnswerEscalation, missionId: string): Promise<{ paused: boolean }> {
    const { mission } = await ctx.locate(missionId);
    mission.pause();
    await ctx.event(mission, 'mission.paused', {});
    return { paused: mission.isPaused };
  }


export async function parkMission(ctx: PlatformContext, answerEscalation: AnswerEscalation, 
    missionId: string,
    input: { reason: string; reviewer: string },
  ): Promise<{ parked: boolean; reason: string }> {
    return ctx.tx(async () => {
      const { mission } = await ctx.locate(missionId);
      const reason = input?.reason?.trim();
      const reviewer = input?.reviewer?.trim();
      if (!reason || !reviewer) throw new PlatformRuleError('INVALID_PARK_REQUEST', 'park 需要非空 reason 与 reviewer。');
      if (mission.isParked) return { parked: true, reason: mission.parkReason ?? reason };
      if (mission.status === 'completed' || mission.status === 'cancelled' || mission.status === 'failed') {
        throw new PlatformRuleError('MISSION_TERMINAL', `Mission ${missionId} 已终态，不能 park。`);
      }
      const ref = mission.workspaceRef;
      const workspace = ctx.workspace;
      const cwd = ref?.projectRoot && workspace?.worktreePath?.(mission.id, ref.projectRoot);
      if (!workspace || !ref?.projectRoot || !ref.branch || ref.branch === '(in-place)' || !cwd || cwd === ref.projectRoot) {
        throw new PlatformRuleError('TRUSTED_WORKSPACE_REQUIRED', 'park 修改中的 Mission 需要可信隔离 workspace。');
      }
      const accepted = mission.workItems.filter((item) => item.status === 'accepted');
      const authorized = new Set<string>();
      for (const item of accepted) {
        const paths = item.order?.allowedScope;
        if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== 'string' || !path.trim())) {
          throw new PlatformRuleError('CHECKPOINT_SCOPE_REQUIRED', `已验收工作项 ${item.id} 缺少冻结的 allowedScope。`);
        }
        for (const path of paths) authorized.add(path);
      }
      if (accepted.length > 0) {
        if (!workspace.checkpoint) {
          throw new PlatformRuleError('TRUSTED_WORKSPACE_REQUIRED', 'park 已验收成果需要 checkpoint 能力。');
        }
        await workspace.checkpoint(cwd, mission.id, 'park', [...authorized].sort());
      } else {
        if (!workspace.assertMissionWorktreeClean) {
          throw new PlatformRuleError('TRUSTED_WORKSPACE_REQUIRED', '零验收项 park 需要 Mission worktree 洁净检查能力。');
        }
        await workspace.assertMissionWorktreeClean(mission.id, ref.projectRoot);
      }
      mission.park(reason);
      await ctx.event(mission, 'mission.parked', { reason, reviewer, checkpointedWorkItems: accepted.map((item) => item.id) });
      return { parked: true, reason };
    });
  }


export async function resumeParkedMission(ctx: PlatformContext, answerEscalation: AnswerEscalation, 
    missionId: string,
    input: { reason: string; reviewer: string; answer?: string },
  ): Promise<{ parked: boolean; conflictFiles: string[]; targetHead: string }> {
    const reason = input?.reason?.trim();
    const reviewer = input?.reviewer?.trim();
    if (!reason || !reviewer) throw new PlatformRuleError('INVALID_PARK_REQUEST', '续跑需要非空 reason 与 reviewer。');
    const { mission, project } = await ctx.locate(missionId);
    if (!mission.isParked) throw new PlatformRuleError('MISSION_NOT_PARKED', `Mission ${missionId} 未挂起。`);
    if (input.answer !== undefined) {
      if (typeof input.answer !== 'string' || !input.answer.trim()) {
        throw new PlatformRuleError('INVALID_ESCALATION_ANSWER', '升级答复不能为空。');
      }
      if (mission.openEscalations.length === 0) {
        throw new PlatformRuleError('NO_OPEN_ESCALATION', `Mission ${missionId} 没有待答复的升级。`);
      }
    }
    const holder = project.missions.find((m) => m.id !== mission.id && m.isMutating);
    if (holder) throw new PlatformRuleError('PROJECT_BUSY', `Mission ${holder.id} 占用项目改动名额。`);
    const ref = mission.workspaceRef;
    const workspace = ctx.workspace;
    const cwd = ref?.projectRoot && workspace?.worktreePath?.(mission.id, ref.projectRoot);
    if (!workspace?.syncMissionWithTarget || !workspace.worktreePath || !ref?.projectRoot || !ref.branch ||
        ref.branch === '(in-place)' || !cwd || cwd === ref.projectRoot || !ref.targetBranch || ref.targetBranch === '(in-place)') {
      throw new PlatformRuleError('TRUSTED_WORKSPACE_REQUIRED', '续跑需要可信 Mission worktree 与目标分支。');
    }
    const synced = await workspace.syncMissionWithTarget({ missionId, projectRoot: ref.projectRoot, targetBranch: ref.targetBranch });
    await ctx.tx(async () => {
      const current = await ctx.locate(missionId);
      current.mission.recordWorkspace({ ...current.mission.workspaceRef!, baseRevision: synced.targetHead });
      if (synced.conflictFiles.length) {
        current.mission.unpark();
        await ctx.event(current.mission, 'mission.resume_sync_conflict', {
          reason, reviewer, conflictFiles: synced.conflictFiles, baseRevision: synced.targetHead,
        });
      } else {
        current.mission.unpark();
        await ctx.event(current.mission, 'mission.resumed_from_park', { reason, reviewer, baseRevision: synced.targetHead });
      }
      if (input.answer?.trim()) await answerEscalation(missionId, input.answer.trim());
    });
    return { parked: false, conflictFiles: synced.conflictFiles, targetHead: synced.targetHead };
  }


export async function resumeMission(ctx: PlatformContext, answerEscalation: AnswerEscalation, missionId: string): Promise<{ paused: boolean }> {
    const { mission } = await ctx.locate(missionId);
    mission.resume();
    await ctx.event(mission, 'mission.resumed_from_pause', {});
    return { paused: mission.isPaused };
  }

