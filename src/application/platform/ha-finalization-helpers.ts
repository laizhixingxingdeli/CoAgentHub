import { PlatformRuleError, type PlatformContext } from './context.ts';
import type { Mission } from '../../kernel/index.ts';
import type { WorkspaceManager } from '../workspace.ts';
import { loadHaAuthorityConfig, HaAuthorityError, HA_AUTHORITY_CODE, HA_AUTHORITY_ENV, type HaAuthorityConfig } from '../ha-authority-config.ts';

export async function loadHaAuthority(ctx: PlatformContext, 
    repoRoot: string,
    worktreePaths: readonly string[],
  ): Promise<HaAuthorityConfig> {
    try {
      return await loadHaAuthorityConfig({
        filePath: ctx.haAuthorityFile ?? process.env[HA_AUTHORITY_ENV],
        repoRoot,
        worktreePaths,
      });
    } catch (error) {
      throw wrapHaAuthorityError(ctx, error);
    }
  }

export async function haMissionAlreadyInHead(ctx: PlatformContext, 
    workspace: WorkspaceManager,
    projectRoot: string,
    missionBranch: string,
    baseRevision: string,
    headNow: string,
  ): Promise<boolean> {
    if (typeof workspace.revisionIsAncestor !== 'function') return false;
    const isAncestor = workspace.revisionIsAncestor.bind(workspace);
    const contained = await isAncestor(projectRoot, missionBranch, headNow);
    if (!contained) return false;
    const stillAtBaseline =
      (await isAncestor(projectRoot, missionBranch, baseRevision)) &&
      (await isAncestor(projectRoot, baseRevision, missionBranch));
    return !stillAtBaseline;
  }

export async function haWorktreePaths(ctx: PlatformContext, 
    workspace: WorkspaceManager,
    projectRoot: string,
  ): Promise<readonly string[]> {
    if (typeof workspace.listWorktreePaths !== 'function') {
      throw new PlatformRuleError(
        HA_AUTHORITY_CODE.WORKTREE_UNRESOLVABLE,
        'HA 放行拒绝（HA_AUTHORITY_WORKTREE_UNRESOLVABLE）：无法枚举 worktree。',
      );
    }
    try {
      const listed = await workspace.listWorktreePaths(projectRoot);
      if (!listed || listed.length === 0) {
        throw new Error('empty');
      }
      return listed;
    } catch {
      throw new PlatformRuleError(
        HA_AUTHORITY_CODE.WORKTREE_UNRESOLVABLE,
        'HA 放行拒绝（HA_AUTHORITY_WORKTREE_UNRESOLVABLE）：无法可靠枚举 worktree。',
      );
    }
  }

export function wrapHaAuthorityError(ctx: PlatformContext, error: unknown): PlatformRuleError {
    if (error instanceof HaAuthorityError) {
      return new PlatformRuleError(error.code, error.message);
    }
    if (error instanceof PlatformRuleError) return error;
    return new PlatformRuleError(
      HA_AUTHORITY_CODE.INVALID_FIELDS,
      'HA 放行拒绝（HA_AUTHORITY_INVALID_FIELDS）：授权配置不可用。',
    );
  }

export async function haUnsafe(ctx: PlatformContext, 
    missionId: string,
  ): Promise<{ reason: string } | undefined> {
    const events = await ctx.activity.list(missionId);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!;
      if (event.kind !== 'final_review.ha_unsafe') continue;
      const data = event.data;
      if (data == null || typeof data !== 'object' || Array.isArray(data)) continue;
      const reason = (data as { reason?: unknown }).reason;
      if (typeof reason === 'string' && reason.trim() !== '') return { reason };
      return { reason: 'unsafe' };
    }
    return undefined;
  }

export async function markHaUnsafe(ctx: PlatformContext, 
    mission: Mission,
    reason: 'merged_unrecorded' | 'rollback_failed' | 'third_party_advanced' | 'advanced_during_verify',
    extra: { head?: string; anchor?: string; reportId?: string },
  ): Promise<void> {
    await ctx.event(mission, 'final_review.ha_unsafe', {
      reason,
      ...extra,
      hint: haUnsafeHint(ctx, reason),
    });
  }

export function haUnsafeHint(ctx: PlatformContext, reason: string): string {
    if (reason === 'merged_unrecorded') {
      return (
        'HA 合并已落到目标分支但 Mission 未记完成。' +
        '请人工核对锚点、当前 HEAD 与集成报告后再处置；禁止自动重合。'
      );
    }
    if (reason === 'third_party_advanced') {
      return (
        '集成分支在验证期间被第三方推进，未回滚。' +
        '请人工核对锚点、当前 HEAD 与集成报告后再处置；禁止自动重合。'
      );
    }
    if (reason === 'advanced_during_verify') {
      return (
        '集成验证期间目标分支被推进或 checkout 被切换，未签字。' +
        '请人工核对锚点、当前 HEAD 与集成报告后再处置；禁止自动重合。'
      );
    }
    return (
      'HA 验证未通过且回滚失败，集成分支可能不安全。' +
      '请人工核对锚点、当前 HEAD 与集成报告后再处置；禁止自动重合。'
    );
  }

export function explicitHaCommands(ctx: PlatformContext, 
    missionId: string,
    commands: readonly { readonly argv: readonly string[]; readonly timeoutMs: number }[],
  ): { argv: string[]; timeoutMs: number }[] {
    const invalid = (): never => {
      throw new PlatformRuleError(
        'HA_VERIFICATION_REQUIRED',
        `Mission ${missionId} 的显式验证命令非法，拒绝合并。`,
      );
    };
    if (!Array.isArray(commands) || commands.length === 0) invalid();
    return commands.map((command) => {
      if (!command || !Array.isArray(command.argv) || command.argv.length === 0 ||
          command.argv.some((part) => typeof part !== 'string' || part.trim() === '') ||
          !Number.isInteger(command.timeoutMs) || command.timeoutMs <= 0) invalid();
      return { argv: [...command.argv], timeoutMs: command.timeoutMs };
    });
  }

export function planLevelCommands(ctx: PlatformContext, mission: Mission): { argv: string[]; timeoutMs: number }[] {
    const out: { argv: string[]; timeoutMs: number }[] = [];
    const seen = new Set<string>();
    for (const item of mission.workItems) {
      if (item.status === 'retired') continue;
      for (const command of item.order?.validation?.commands ?? []) {
        if (
          !Array.isArray(command.argv) ||
          command.argv.length === 0 ||
          command.argv.some((part) => typeof part !== 'string' || part.trim() === '')
        ) {
          throw new PlatformRuleError(
            'HA_VERIFICATION_REQUIRED',
            `Mission ${mission.id} 的冻结验证命令非法，拒绝合并。`,
          );
        }
        if (typeof command.timeoutMs !== 'number' || !Number.isFinite(command.timeoutMs) || command.timeoutMs <= 0) {
          throw new PlatformRuleError(
            'HA_VERIFICATION_REQUIRED',
            `Mission ${mission.id} 的冻结验证命令 timeoutMs 非法，拒绝合并。`,
          );
        }
        const argv = [...command.argv];
        const key = JSON.stringify([argv, command.timeoutMs]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ argv, timeoutMs: command.timeoutMs });
      }
    }
    if (out.length === 0) {
      throw new PlatformRuleError(
        'HA_VERIFICATION_REQUIRED',
        `Mission ${mission.id} 没有非空方案级验证命令，拒绝合并。`,
      );
    }
    return out;
  }

export function isForbiddenMaster(ctx: PlatformContext, branch: string): boolean {
    const trimmed = branch.trim();
    return trimmed === 'master' || trimmed === 'refs/heads/master';
  }
