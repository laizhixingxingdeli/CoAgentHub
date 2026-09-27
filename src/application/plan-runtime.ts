/**
 * 由既有平台实例跑一份已筛选方案的内部入口。
 *
 * 调用方已经握着 Platform、独立 PlanRun 仓储、MissionRunner、可选 runQuery。
 * 这里不建第二份平台、不 listen、不拿主状态锁——那些是 CLI / 观测面的装配。
 * 不这么抽的话，常驻服务和 CLI 会各装一套规则，筛选口径和终审接线会分叉。
 *
 * 候选/HA/机器终审怎么判，全部交给 drivePlan；本文件只建记录并接线。
 */

import type { MissionRunner } from './mission-runner.ts';
import { drivePlan, runWithDeadline, type PlanDriverDeps } from './plan-driver.ts';
import { PlanRun, type PlanRunStop } from './plan-run.ts';
import { buildRoutingPrompt, parseRoutingProposal } from './plan-routing.ts';
import type { PlanCandidateSelection, PlanSpec } from './plan-spec.ts';
import type { ExecutionProfile } from './ports.ts';
import type { RunQueryInput, RunQueryResult } from './query-run.ts';

/** 独立方案运行仓储：create / read / update。不绑文件实现，好让后续 CLI 直接接入。 */
export interface PlanRuntimeStore {
  create(run: PlanRun): Promise<void>;
  read(): PlanRun | undefined;
  update<T>(mutate: (run: PlanRun) => T): Promise<T>;
}

export interface PlanRuntimeDeps {
  readonly store: PlanRuntimeStore;
  readonly projectRoot: string;
  /** 方案驱动用到的那几面；入口不另包一层 Platform。 */
  readonly platform: PlanDriverDeps['platform'];
  /** 每条 Mission：`runner.run(missionId, { projectRoot })`，outcome 交给 drivePlan。 */
  readonly runMission: MissionRunner['run'];
  readonly runQuery?: (input: RunQueryInput) => Promise<RunQueryResult>;
  /** 分类员用的 profile；缺省走 query 自己的默认。 */
  readonly queryProfile?: ExecutionProfile;
  readonly persist: () => Promise<void>;
  /** 墙钟到点：暂停在途 Mission。入口不猜 platform.pauseMission 在不在。 */
  readonly pauseInFlight: (missionId: string) => Promise<void>;
  readonly now: () => string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  readonly runId: string;
  readonly startedAt?: string;
  readonly checkRepo?: () => Promise<readonly string[]>;
  readonly pollMs?: number;
}

async function persistAfter<T>(persist: () => Promise<void>, work: Promise<T>): Promise<T> {
  const result = await work;
  await persist();
  return result;
}

/**
 * 建与 run-plan 相同字段的 PlanRun，再按筛选结果的源顺序驱动。
 * 分类失败 / 没装 query 的回落语义保持原样，好让 CLI 只换装配不换规则。
 */
export async function runPlanOnPlatform(
  plan: PlanSpec,
  selection: PlanCandidateSelection,
  deps: PlanRuntimeDeps,
): Promise<PlanRunStop> {
  const remaining = selection.candidates;
  const startedAt = deps.startedAt ?? deps.now();
  await deps.store.create(
    PlanRun.start({
      id: deps.runId,
      planId: plan.planId,
      projectId: plan.projectId,
      integrationBranch: plan.integrationBranch,
      reviewer: plan.reviewer,
      stopConditions: plan.stopConditions,
      featureIds: remaining.map((feature) => feature.id),
      // 标题抄进记录：早上看交接面不用回头翻方案文件（它到早上可能已经改了）。
      titles: Object.fromEntries(remaining.map((feature) => [feature.id, feature.title])),
      startedAt,
      ...(selection.exclusions.length > 0 ? { sourceExclusions: selection.exclusions } : {}),
    }),
  );

  return drivePlan(plan, {
    store: deps.store,
    projectRoot: deps.projectRoot,
    now: deps.now,
    sleep: deps.sleep,
    log: deps.log,
    ...(deps.checkRepo ? { checkRepo: deps.checkRepo } : {}),
    ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
    platform: {
      createMission: (input) => persistAfter(deps.persist, deps.platform.createMission(input)),
      createClassifiedMission: (input) =>
        persistAfter(deps.persist, deps.platform.createClassifiedMission(input)),
      getMissionView: (missionId) => deps.platform.getMissionView(missionId),
      finalizeMissionByMachine: (missionId, input) =>
        persistAfter(deps.persist, deps.platform.finalizeMissionByMachine(missionId, input)),
      abandonMissionForPlan: (missionId, input) =>
        persistAfter(deps.persist, deps.platform.abandonMissionForPlan(missionId, input)),
    },
    proposeRoute: async (feature) => {
      if (!deps.runQuery) return { ok: false, reason: '分类员不可用（query runtime 没装上）。' };
      const result = await deps.runQuery({
        projectId: plan.projectId,
        source: `plan-run:${deps.runId}:${feature.id}`,
        prompt: buildRoutingPrompt(plan, feature),
        cwd: deps.projectRoot,
        ...(deps.queryProfile ? { profile: deps.queryProfile } : {}),
      });
      await deps.persist();
      if (result.outcome !== 'answered') {
        return { ok: false, reason: `分类员没答上来（${result.outcome}，QueryRun ${result.queryRunId}）。` };
      }
      const parsed = parseRoutingProposal(result.record.output ?? '', new Date().toISOString());
      return parsed.ok ? parsed : {
        ok: false,
        reason: `${parsed.reason}（QueryRun ${result.queryRunId}）`,
        ...(parsed.haForbiddenUnproven ? { haForbiddenUnproven: parsed.haForbiddenUnproven } : {}),
      };
    },
    runMission: async (missionId, { wallClockDeadline }) => {
      try {
        return await runWithDeadline(
          async () => {
            const ran = await deps.runMission(missionId, { projectRoot: deps.projectRoot });
            return ran.outcome;
          },
          Date.parse(wallClockDeadline) - Date.now(),
          async () => {
            deps.log(`墙钟到点：暂停在途的 ${missionId}，下一轮开头停下。`);
            await deps.pauseInFlight(missionId);
            await deps.persist();
          },
        );
      } finally {
        await deps.persist();
      }
    },
  });
}
