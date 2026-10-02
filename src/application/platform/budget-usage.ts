import type { Attempt, TokenUsage } from '../../kernel/index.ts';
import type { UsageReport } from './types.ts';
import type { PlatformContext } from './context.ts';
import { push, combine } from './usage-helpers.ts';
import { budgetThresholdCrossings, buildBudgetUsageSnapshot, countAuthoritativeCommands, countAuthoritativeRounds, evaluateExecutionBudget, projectAuthoritativeWallClockMs, type BudgetEvaluation, type BudgetUsageSnapshot } from '../budget-usage.ts';

export async function getUsage(ctx: PlatformContext, filter?: { projectId?: string; missionId?: string }): Promise<UsageReport> {
    const byProject = new Map<string, TokenUsage[]>();
    const byMission = new Map<string, TokenUsage[]>();
    const byRole = new Map<string, TokenUsage[]>();
    // 键值对不能拼成一个字符串再切回来——模型名里出现分隔符就散架了。
    const byFact = new Map<string, { key: string; value: string; list: TokenUsage[] }>();
    const all: TokenUsage[] = [];
    let unattributed = 0;

    for (const project of await ctx.projects.list()) {
      if (filter?.projectId && project.id !== filter.projectId) continue;
      for (const mission of project.missions) {
        if (filter?.missionId && mission.id !== filter.missionId) continue;
        const attempts: Attempt[] = [
          ...mission.coordinatorAttempts,
          ...mission.independentReviewerAttempts,
          ...mission.workItems.flatMap((item) => item.attempts),
        ];
        for (const attempt of attempts) {
          const usage = attempt.usage;
          all.push(usage);
          push(byProject, project.id, usage);
          push(byMission, mission.id, usage);
          push(byRole, attempt.kind, usage);
          const facts = attempt.profile?.resolved;
          if (!facts || facts.length === 0) {
            unattributed += 1;
            continue;
          }
          for (const fact of facts) {
            const composite = JSON.stringify([fact.key, fact.value]);
            const bucket = byFact.get(composite) ?? { key: fact.key, value: fact.value, list: [] };
            bucket.list.push(usage);
            byFact.set(composite, bucket);
          }
        }
      }
    }

    const rows = (map: Map<string, TokenUsage[]>) =>
      [...map].map(([key, list]) => ({ key, attempts: list.length, usage: combine(list) }));

    return {
      total: combine(all),
      attempts: all.length,
      unattributed,
      byProject: rows(byProject),
      byMission: rows(byMission),
      byRole: rows(byRole),
      byFact: [...byFact.values()].map(({ key, value, list }) => ({
        key,
        value,
        attempts: list.length,
        usage: combine(list),
      })),
    };
  }

export async function evaluateMissionBudget(ctx: PlatformContext, 
    missionId: string,
    opts?: { readonly changedFiles?: readonly string[] },
  ): Promise<{
    readonly budgetPresent: boolean;
    readonly snapshot: BudgetUsageSnapshot;
    readonly evaluation: BudgetEvaluation;
  }> {
    const { mission } = await ctx.locate(missionId);
    const capturedAt = ctx.clock.now().toISOString();
    const attempts = [
      ...mission.coordinatorAttempts,
      ...mission.workItems.flatMap((item) => item.attempts),
    ];
    const activity = await ctx.activity.list(missionId);

    const snapInput: {
      missionId: string;
      capturedAt: string;
      attempts: typeof attempts;
      roundCount?: number;
      wallClockMs?: number;
      commandCount?: number;
      changedFiles?: readonly string[];
    } = {
      missionId,
      capturedAt,
      attempts,
    };

    const rounds = countAuthoritativeRounds(activity);
    if (rounds.status === 'known') snapInput.roundCount = rounds.count;

    const wall = projectAuthoritativeWallClockMs(activity, capturedAt);
    if (wall.status === 'known') snapInput.wallClockMs = wall.ms;

    const commands = countAuthoritativeCommands(activity);
    if (commands.status === 'known') snapInput.commandCount = commands.count;

    if (opts && Object.prototype.hasOwnProperty.call(opts, 'changedFiles') && opts.changedFiles !== undefined) {
      snapInput.changedFiles = opts.changedFiles;
    }

    const snapshot = buildBudgetUsageSnapshot(snapInput);
    const evaluation = evaluateExecutionBudget(mission.executionBudget, snapshot);
    return Object.freeze({
      budgetPresent: mission.executionBudget !== undefined,
      snapshot,
      evaluation,
    });
  }

export async function recordBudgetThresholdEvents(ctx: PlatformContext, 
    missionId: string,
    evaluation: BudgetEvaluation,
  ): Promise<void> {
    const { mission } = await ctx.locate(missionId);
    const activity = await ctx.activity.list(missionId);
    const seen = new Set<string>();
    for (const event of activity) {
      if (event.kind !== 'mission.budget.threshold') continue;
      const data = event.data;
      if (data == null || typeof data !== 'object' || Array.isArray(data)) continue;
      const row = data as {
        schemaVersion?: unknown;
        dimension?: unknown;
        threshold?: unknown;
      };
      if (row.schemaVersion !== 1) continue;
      if (typeof row.dimension !== 'string' || typeof row.threshold !== 'number') continue;
      seen.add(`${row.dimension}:${row.threshold}`);
    }

    for (const crossing of budgetThresholdCrossings(evaluation)) {
      const key = `${crossing.dimension}:${crossing.threshold}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await ctx.event(mission, 'mission.budget.threshold', {
        schemaVersion: 1,
        dimension: crossing.dimension,
        threshold: crossing.threshold,
        limit: crossing.limit,
        used: crossing.used,
        class: crossing.class,
      });
    }
  }
