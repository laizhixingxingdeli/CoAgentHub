/**
 * 方案驱动——按方案逐个推进功能点，无人值守。
 *
 * 每个功能点：现做分类 → 建 Mission → 跑到它停下 → 交卷了就走机器 L3（合进集成
 * 分支、在合并结果上验证、红则回滚）→ 没合进去就开一张升级单等检视者 → 照决定
 * 处置 → 下一个。撞到停止条件（未解决累计、墙钟、检视者叫停、集成分支不安全）
 * 就停，并把原因写进方案运行记录。
 *
 * **权限分得很死。** 检视者只能在四个动作里选；合进集成分支只凭机器 L3 的
 * 确定性证据；high_assurance 永远要人。这个驱动方自己不做任何判断——它只把
 * 各方的结论按规则串起来。
 *
 * 失败的 Mission 怎么收：方案还要往下跑，就放弃它（放名额、留分支）——不放的话
 * 它一直占着项目的改动名额，后面的功能一个都派发不了；方案停了就原样留着，
 * 第二天人还有「看一眼再合」的余地。
 */

import { KernelError } from '../kernel/index.ts';
import type { MissionContract, OriginChannel, WorkOrder } from '../kernel/index.ts';
import { ClassifiedMissionInputError } from './classified-mission-intake.ts';
import type { MissionRunOutcome } from './orchestrator.ts';
import type { PlanRun, PlanRunStop } from './plan-run.ts';
import { decideRoute, type RoutingDecision, type RoutingProposal } from './plan-routing.ts';
import { featureContract, type PlanFeatureSpec, type PlanSpec } from './plan-spec.ts';
import { PlatformRuleError } from './platform.ts';

export interface PlanDriverDeps {
  readonly store: {
    read(): PlanRun | undefined;
    update<T>(mutate: (run: PlanRun) => T): Promise<T>;
  };
  readonly platform: {
    createMission(input: {
      projectId: string;
      missionId: string;
      contract: MissionContract;
      origin?: OriginChannel;
    }): Promise<{ missionId: string }>;
    createClassifiedMission(input: {
      projectId: string;
      missionId?: string;
      contract: MissionContract;
      origin?: OriginChannel;
      facts: unknown;
      assessment?: unknown;
      workOrder?: WorkOrder;
    }): Promise<{ missionId: string }>;
    getMissionView(missionId: string): Promise<{ status: string }>;
    finalizeMissionByMachine(
      missionId: string,
      input: {
        integrationBranch: string;
        verification: readonly { argv: readonly string[]; timeoutMs: number }[];
        projectRoot?: string;
      },
    ): Promise<{ status: string; mergedInto?: string; reportId?: string; reason?: string; rolledBackTo?: string }>;
    abandonMissionForPlan(
      missionId: string,
      input: { planRunId: string; escalationId: string; reasons: readonly string[]; projectRoot?: string },
    ): Promise<{ status: string }>;
  };
  /**
   * 跑一条 Mission 直到它停下（交卷 / 卡住 / 等人）。`wallClockDeadline` 是方案
   * 墙钟的到点时刻：接线层到点要把在途的 Mission 暂停，编排器在下一轮开头停下。
   */
  readonly runMission: (
    missionId: string,
    context: { wallClockDeadline: string },
  ) => Promise<MissionRunOutcome>;
  /** 只读协调者现做分类。读不懂就说为什么，驱动方回落 Standard。 */
  readonly proposeRoute: (
    feature: PlanFeatureSpec,
  ) => Promise<{ ok: true; proposal: RoutingProposal } | { ok: false; reason: string }>;
  /**
   * 每个功能开跑前再核一次项目仓（还在集成分支上、工作区干净）。开跑前检查只在
   * 启动时做一次；夜里有东西把仓库切回 master 的话，下一条 Mission 会从 master
   * 分叉，要等它整条跑完、机器 L3 去合时才被拦下——那一条的钱就白花了。
   */
  readonly checkRepo?: () => Promise<readonly string[]>;
  readonly projectRoot: string;
  readonly now: () => string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  /** 等决定时多久看一次记录。缺省 15 秒——检视者 20 分钟才醒一次，看勤了也没用。 */
  readonly pollMs?: number;
}

type Landing =
  | { readonly kind: 'merged' }
  | { readonly kind: 'failed'; readonly failure: string }
  | { readonly kind: 'unsafe'; readonly detail: string };

export async function drivePlan(plan: PlanSpec, deps: PlanDriverDeps): Promise<PlanRunStop> {
  const specs = new Map(plan.features.map((feature) => [feature.id, feature]));
  try {
    for (;;) {
      const run = requireRun(deps);
      if (run.stopped) return run.stopped;
      const now = deps.now();
      if (wallClockReached(run, now)) {
        await deps.store.update((r) => r.checkStop(now));
        continue;
      }
      const next = run.nextPending();
      if (!next) {
        await deps.store.update((r) => r.finish(now));
        continue;
      }
      const feature = specs.get(next.featureId);
      if (!feature) {
        throw new Error(`方案运行里有功能点 ${next.featureId}，方案文件里却没有。`);
      }
      await runFeature(plan, run, feature, next.missionIds.length + 1, deps);
    }
  } catch (error) {
    // 崩溃处置：记下原因、停在 crashed，再往外抛。不在这里试图续跑——
    // 猜错了续跑，比停下来等人看更糟。
    const detail = error instanceof Error ? error.message : String(error);
    await deps.store
      .update((r) => {
        if (!r.stopped) r.halt('crashed', detail, deps.now());
      })
      .catch(() => undefined);
    throw error;
  }
}

async function runFeature(
  plan: PlanSpec,
  run: PlanRun,
  feature: PlanFeatureSpec,
  attempt: number,
  deps: PlanDriverDeps,
): Promise<void> {
  const missionId = attempt === 1 ? `${run.id}-${feature.id}` : `${run.id}-${feature.id}-r${attempt}`;
  // 分类是尽力而为：有安全的回落（Standard），它自己出错不该拖垮整晚。
  const proposal = await deps.proposeRoute(feature).catch((error: unknown) => ({
    ok: false as const,
    reason: `分类员出错：${error instanceof Error ? error.message : String(error)}`,
  }));
  // 分类本身是一整次只读会话，可能跑过墙钟：到点了就不再建 Mission。功能还没
  // 开跑，checkStop 不会动它，它保持「没轮到」。
  const afterRoute = deps.now();
  if (wallClockReached(run, afterRoute)) {
    await deps.store.update((r) => r.checkStop(afterRoute));
    return;
  }
  const route = decideRoute(
    proposal.ok ? proposal.proposal : undefined,
    feature,
    proposal.ok ? undefined : proposal.reason,
  );
  if (route.kind !== 'needs_human') {
    const problems = (await deps.checkRepo?.()) ?? [];
    if (problems.length > 0) {
      const detail = `开跑 ${feature.id} 前核对项目仓没过：${problems.join('；')}`;
      deps.log(`${feature.id} ✗ ${detail}`);
      await deps.store.update((r) => r.halt('unsafe', detail, deps.now()));
      return;
    }
  }
  if (route.kind === 'needs_human') {
    deps.log(`${feature.id} ⏸ ${route.reason}：不建 Mission，挂起等人。`);
    await deps.store.update((r) => r.suspendFeature(feature.id, route.needsDecision));
    return;
  }
  await createMission(plan, run, feature, missionId, route, deps);
  await deps.store.update((r) => r.startFeature(feature.id, missionId));
  deps.log(`${feature.id} ▶ ${missionId}`);

  const wallClockDeadline = new Date(
    Date.parse(run.startedAt) + run.stopConditions.wallClockMs,
  ).toISOString();
  const outcome = await deps.runMission(missionId, { wallClockDeadline });
  const landing = await land(plan, missionId, outcome, deps);

  if (landing.kind === 'merged') {
    deps.log(`${feature.id} ✓ 合入 ${plan.integrationBranch}`);
    await deps.store.update((r) => r.markMerged(feature.id));
    return;
  }
  if (landing.kind === 'unsafe') {
    deps.log(`${feature.id} ✗ ${landing.detail}`);
    await deps.store.update((r) => r.halt('unsafe', landing.detail, deps.now()));
    return;
  }
  // 墙钟已经到了（多半正是它被暂停了）：今晚没人会定这张单，不开。停下，
  // 跑着的功能由 checkStop 挂起并写明要人定什么。
  const afterRun = deps.now();
  if (wallClockReached(run, afterRun)) {
    deps.log(`${feature.id} ⏸ 墙钟到点：${landing.failure}`);
    await deps.store.update((r) => r.checkStop(afterRun));
    return;
  }

  const question =
    `${feature.id}「${feature.title}」没能合进集成分支：${landing.failure} ` +
    '选一个：隔离重跑（另开一条从头来）/ 跳过 / 重划剩余范围（点名依赖它的功能一并删掉）/ 停。';
  const escalation = await deps.store.update((r) =>
    r.openEscalation({ featureId: feature.id, missionId, failure: landing.failure, question }, deps.now()),
  );
  deps.log(`${feature.id} ⚑ 升级单 ${escalation.id}（${escalation.deadline} 截止）：${landing.failure}`);
  await waitForResolution(escalation.id, deps);
  await settle(missionId, escalation.id, deps);
}

async function createMission(
  plan: PlanSpec,
  run: PlanRun,
  feature: PlanFeatureSpec,
  missionId: string,
  route: Exclude<RoutingDecision, { kind: 'needs_human' }>,
  deps: PlanDriverDeps,
): Promise<void> {
  const contract = featureContract(plan, feature);
  const origin: OriginChannel = { clientType: 'plan-run', conversationRef: `plan-run:${run.id}` };
  if (route.kind === 'classified') {
    try {
      await deps.platform.createClassifiedMission({
        projectId: plan.projectId,
        missionId,
        contract,
        origin,
        facts: route.facts,
        ...(route.assessment ? { assessment: route.assessment } : {}),
        ...(route.workOrder ? { workOrder: route.workOrder } : {}),
      });
      deps.log(`${feature.id} 分类为 ${route.classification.recommended.executionMode ?? 'query'}`);
      return;
    } catch (error) {
      // 同一份事实，平台分类器与这里的结论不会不同；会被拒的是工单本身的形状
      // （kernel 严格校验）。被拒的建单不留半截，照老路建 Standard 即可。
      if (
        !(error instanceof PlatformRuleError) &&
        !(error instanceof ClassifiedMissionInputError) &&
        !(error instanceof KernelError)
      ) {
        throw error;
      }
      deps.log(`${feature.id} 按分类建单被拒（${error.message}），回落 Standard。`);
    }
  } else {
    deps.log(`${feature.id} 回落 Standard：${route.reason}`);
  }
  await deps.platform.createMission({ projectId: plan.projectId, missionId, contract, origin });
}

/** 这条 Mission 停下之后，能不能合进集成分支；合不进去是为什么。 */
async function land(
  plan: PlanSpec,
  missionId: string,
  outcome: MissionRunOutcome,
  deps: PlanDriverDeps,
): Promise<Landing> {
  switch (outcome.kind) {
    case 'awaiting_l3_review':
      break;
    case 'delivered':
      // 跑之前刚建的 Mission 不该已经 completed；真是的话它已经落地过了。
      return { kind: 'merged' };
    case 'blocked':
      return { kind: 'failed', failure: `Mission 走不下去了：${outcome.reason}` };
    case 'awaiting_l3':
      return { kind: 'failed', failure: `协调者升级给 L3 的问题夜里没人答：${outcome.question}` };
    case 'waiting':
      return { kind: 'failed', failure: `Mission 停在 ${outcome.reason}：${outcome.detail}` };
    case 'stalled':
      return { kind: 'failed', failure: `Mission 卡住了：${outcome.reason}` };
  }

  let result: Awaited<ReturnType<PlanDriverDeps['platform']['finalizeMissionByMachine']>>;
  try {
    result = await deps.platform.finalizeMissionByMachine(missionId, {
      integrationBranch: plan.integrationBranch,
      verification: plan.integrationVerification,
      projectRoot: deps.projectRoot,
    });
  } catch (error) {
    if (error instanceof PlatformRuleError && error.code === 'INTEGRATION_BRANCH_MISMATCH') {
      // 分支被切走了：再往下合，就是往错的分支上合。
      return { kind: 'unsafe', detail: `项目仓被切离了集成分支：${error.message}` };
    }
    throw error;
  }
  if (result.status === 'completed') return { kind: 'merged' };
  if (result.reportId && !result.rolledBackTo) {
    return {
      kind: 'unsafe',
      detail:
        `集成验证红且回滚失败（报告 ${result.reportId}）：集成分支上留着一个没验过的合并，` +
        `不能再往上叠。${result.reason ?? ''}`,
    };
  }
  if (result.rolledBackTo) {
    return {
      kind: 'failed',
      failure:
        `合进集成分支后方案级验证红了（报告 ${result.reportId ?? '?'}），` +
        `已退回 ${result.rolledBackTo.slice(0, 12)}。`,
    };
  }
  return { kind: 'failed', failure: `机器合并失败：${result.reason ?? '（没给原因）'}` };
}

/** 等到单子有了结论（决定 / 过期），或者方案停了。 */
async function waitForResolution(escalationId: string, deps: PlanDriverDeps): Promise<void> {
  const pollMs = deps.pollMs ?? 15_000;
  for (;;) {
    const run = requireRun(deps);
    const escalation = run.escalations.find((e) => e.id === escalationId);
    if (!escalation) throw new Error(`升级单 ${escalationId} 不见了。`);
    if (run.stopped || escalation.resolution) return;
    const now = deps.now();
    if (Date.parse(now) >= Date.parse(escalation.deadline)) {
      // 检视者可能恰好在这一刻写下了决定：定的是跳过之类 → 已了结；定的是「停」
      // → 方案已停，expire 先撞上的是 PLAN_RUN_STOPPED。两种都是正常结局，回到
      // 循环开头重读即可。
      await deps.store
        .update((r) => r.expire(escalationId, now))
        .catch(tolerate('ESCALATION_ALREADY_RESOLVED', 'PLAN_RUN_STOPPED'));
      continue;
    }
    if (wallClockReached(run, now)) {
      await deps.store.update((r) => r.checkStop(now));
      continue;
    }
    const untilDeadline = Date.parse(escalation.deadline) - Date.parse(now);
    const untilWallClock = Date.parse(run.startedAt) + run.stopConditions.wallClockMs - Date.parse(now);
    await deps.sleep(Math.max(1, Math.min(pollMs, untilDeadline, untilWallClock)));
  }
}

/** 照结论收尾失败的那条 Mission。 */
async function settle(missionId: string, escalationId: string, deps: PlanDriverDeps): Promise<void> {
  const run = requireRun(deps);
  // 方案停了（叫停 / 未解决到顶 / 墙钟）：原样留给人，第二天还能看一眼再合。
  if (run.stopped) return;
  const view = await deps.platform.getMissionView(missionId);
  if (view.status === 'completed' || view.status === 'blocked') return;
  const escalation = run.escalations.find((e) => e.id === escalationId)!;
  const resolution = escalation.resolution;
  const reason =
    resolution?.kind === 'decided'
      ? `检视者选了 ${resolution.action}：${resolution.reason}`
      : `升级单 ${escalation.id} 到 ${escalation.deadline} 没人定：功能挂起等人，先放掉名额让后面的功能能跑。`;
  await deps.platform.abandonMissionForPlan(missionId, {
    planRunId: run.id,
    escalationId: escalation.id,
    reasons: [reason],
    projectRoot: deps.projectRoot,
  });
}

function wallClockReached(run: PlanRun, now: string): boolean {
  return Date.parse(now) - Date.parse(run.startedAt) >= run.stopConditions.wallClockMs;
}

function requireRun(deps: PlanDriverDeps): PlanRun {
  const run = deps.store.read();
  if (!run) throw new Error('方案运行记录不见了。');
  return run;
}

/** 撞车是正常的（检视者恰好同时定了）；别的错照抛。 */
function tolerate(...codes: string[]) {
  return (error: unknown) => {
    if (error instanceof PlatformRuleError && codes.includes(error.code)) return undefined;
    throw error;
  };
}

/**
 * 跑一件事，到点（`msUntilDeadline` 毫秒后）调一次 `onDeadline`，但不打断它。
 *
 * 给在途 Mission 用：墙钟只在两个功能之间看的话，一条跑了四小时的 Mission 会
 * 把「八小时硬墙钟」拖成十二小时。到点把它暂停，编排器在下一轮开头停下——
 * 不直接杀：正在写的那一跳半途而废，比多跑几分钟更难收拾。跑完了定时器必须
 * 清掉，否则进程要白等到那个时刻才退出。
 */
export async function runWithDeadline<T>(
  task: () => Promise<T>,
  msUntilDeadline: number,
  onDeadline: () => Promise<void>,
): Promise<T> {
  let fired: Promise<void> | undefined;
  const timer = setTimeout(() => {
    fired = onDeadline().catch(() => undefined);
  }, Math.max(0, msUntilDeadline));
  try {
    return await task();
  } finally {
    clearTimeout(timer);
    await fired;
  }
}
