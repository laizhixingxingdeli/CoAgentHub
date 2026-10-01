/**
 * 方案驱动——按方案逐个推进功能点，无人值守。
 *
 * 每个功能点：现做分类 → 建 Mission → 跑到它停下 → 交卷了就走机器 L3（合进集成
 * 分支、在合并结果上验证、红则回滚）→ 没合进去就开一张升级单等检视者 → 照决定
 * 处置 → 下一个。撞到停止条件（未解决累计、墙钟、检视者叫停、集成分支不安全、升级单到上限）
 * 就停，并把原因写进方案运行记录。
 *
 * **权限分得很死。** 检视者只能在四个动作里选（可答复单另可 answer）；合进集成分支只凭机器 L3 的
 * 确定性证据；HA 禁止副作用未证明安全时不建单，合格 HA 跑到待放行后挂起，
 * 本项不放行。这个驱动方自己不做任何判断——它只把各方的结论按规则串起来。
 *
 * 失败的 Mission 怎么收：方案还要往下跑，就放弃它（放名额、留分支）——不放的话
 * 它一直占着项目的改动名额，后面的功能一个都派发不了；方案停了就原样留着，
 * 第二天人还有「看一眼再合」的余地。
 */

import { KernelError } from '../kernel/index.ts';
import type { ComplexityAssessment, MissionContract, OriginChannel, WaitReason, WorkOrder } from '../kernel/index.ts';
import { ClassifiedMissionInputError } from './classified-mission-intake.ts';
import type { MissionRunOutcome } from './orchestrator.ts';
import type { HaReleaseDecision, PlanRun, PlanRunStop } from './plan-run.ts';
import { decideRoute, type RoutingDecision, type RoutingProposal } from './plan-routing.ts';
import type { ClassificationResult } from './task-classifier.ts';
import { featureContract, type PlanFeatureSpec, type PlanSpec } from './plan-spec.ts';
import { PlatformRuleError } from './platform.ts';

/**
 * 探针说「这条 waiting 等得到头」的结构化证明。
 *
 * **刻意不给「project_busy 就是自己占名额」这种从字样推出来的结论。** 同一个
 * reason 既可能是本 Mission 自己另一个在途工作项占着名额（该等），也可能是别的
 * Mission 在改代码（等不到头）。分不出来就会白等一整晚，或者把自己的 Mission
 * 当成失败开单——所以探针必须自己去队列 / 占位记录里查出属于本 Mission 的证据，
 * 查不到就返回 undefined。
 */
export type WaitEligibility =
  /** 本 Mission 自己的 Hop 在退避：availableAt 到点重试同一条即可。 */
  | { readonly kind: 'own_backoff'; readonly availableAt: string }
  /**
   * 本 Mission 自己占着改动名额（自己另一个在途工作项）：只能短轮询复核，
   * 不猜它什么时候完工——猜一个到期就等成了赌。
   */
  | { readonly kind: 'capacity'; readonly nextPollAt: string }
  /** 该角色**全部**候选都在冷却（已证明没有可用的同角色候选）：最早到期即重试时刻。 */
  | { readonly kind: 'role_cooldown'; readonly earliestUntil: string };

export interface PlanDriverDeps {
  readonly store: {
    read(): PlanRun | undefined;
    update<T>(mutate: (run: PlanRun) => T): Promise<T>;
  };
  /** 外层已认证的恢复映射；不在驱动内重新核验其资格。 */
  readonly resumeMissions?: Readonly<Record<string, string>>;
  readonly platform: {
    /** 恢复已有 Mission；普通票无需提供此能力。 */
    resumeMission?(missionId: string): Promise<{ paused: boolean }>;
    recordStandardFallbackRoute?(
      missionId: string,
      input: { classification: ClassificationResult; fallbackReason: string; assessment?: ComplexityAssessment },
    ): Promise<void>;
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
    getMissionView(missionId: string): Promise<{
      status: string;
      executionMode?: string;
      haReviewHold?: 'pending_dispatch' | 'in_review' | 'pending_release' | 'fault';
      workspaceRef?: { readonly targetBranch?: string };
      finalReview?: { readonly mergedInto?: string };
      waitDetail?: string;
      parked?: boolean;
      parkReason?: string;
      independentReviews?: readonly {
        readonly reviewedCommit: string;
        readonly verdict: string;
        readonly reviewerAttemptId: string;
        readonly validationReportId?: string;
      }[];
    }>;
    effectiveIndependentReviewPass(missionId: string): Promise<
      | { readonly reviewedCommit: string; readonly reviewerAttemptId: string; readonly validationReportId?: string; readonly verdict: string }
      | undefined
    >;
    finalizeMissionByHaAuthority(
      missionId: string,
      input: {
        readonly reviewerId: string;
        readonly confirmedBy: string;
        readonly projectRoot?: string;
        readonly reasons?: readonly string[];
        readonly verification?: readonly { readonly argv: readonly string[]; readonly timeoutMs: number }[];
      },
    ): Promise<{ status: string; mergedInto?: string; reportId?: string; reason?: string; rolledBackTo?: string }>;
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
    /** 持锁答复协调者提问；对接平台原方法，不另开一条 Mission。 */
    answerEscalation(
      missionId: string,
      answer: string,
    ): Promise<{ question: string; answer: string }>;
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
  ) => Promise<
    | { ok: true; proposal: RoutingProposal }
    | { ok: false; reason: string; haForbiddenUnproven?: readonly string[] }
  >;
  /**
   * 每个功能开跑前再核一次项目仓（还在集成分支上、工作区干净）。开跑前检查只在
   * 启动时做一次；夜里有东西把仓库切回 master 的话，下一条 Mission 会从 master
   * 分叉，要等它整条跑完、机器 L3 去合时才被拦下——那一条的钱就白花了。
   */
  readonly checkRepo?: () => Promise<readonly string[]>;
  readonly projectRoot: string;
  readonly now: () => string;
  readonly sleep: (ms: number) => Promise<void>;
  /**
   * 可选：判一条 waiting 是不是「本 Mission 在运行内等得到头」。缺省不等待，
   * 照旧开升级单——没有证明就等，等于把整晚押在一条猜出来的原因上。
   * 生产接线（从队列行里取证据）留给后续票，这里只认结构化证明。
   */
  readonly waitEligibility?: (input: {
    readonly missionId: string;
    readonly reason: WaitReason;
    readonly detail: string;
    /** 仅当本次 waiting 确由该角色的候选拿不出人时随附；缺席表示非候选故障。 */
    readonly candidateRole?: Extract<MissionRunOutcome, { kind: 'waiting' }>['candidateRole'];
  }) => Promise<WaitEligibility | undefined>;
  readonly log: (line: string) => void;
  /** 等决定时多久看一次记录。缺省 15 秒——检视者 20 分钟才醒一次，看勤了也没用。 */
  readonly pollMs?: number;
}

type Landing =
  | { readonly kind: 'merged' }
  | { readonly kind: 'failed'; readonly failure: string }
  | { readonly kind: 'unsafe'; readonly detail: string }
  | { readonly kind: 'ha_pending' }
  | { readonly kind: 'awaiting_answer'; readonly question: string };

export async function drivePlan(plan: PlanSpec, deps: PlanDriverDeps): Promise<PlanRunStop> {
  // 入选名单在进驱动之前已经筛过（selectPlanCandidates）；这里只跑记录里的功能，
  // 不再看源 status / dependsOn——否则筛选口径会有两份，检查说不可跑正式启动却派活。
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
      const runningFeature = run.features.find((item) => item.status === 'running');
      if (!runningFeature && run.parkedMissions.length > 0) {
        let resumed: { featureId: string; missionId: string } | undefined;
        for (const parked of run.parkedMissions) {
          const parkedFeature = run.features.find((item) => item.missionIds.includes(parked.missionId));
          if (parkedFeature?.status !== 'suspended') continue;
          const view = await deps.platform.getMissionView(parked.missionId);
          if (view.parked === false) {
            const featureId = await deps.store.update((r) => r.resumeParkedMission(parked.missionId));
            resumed = { featureId, missionId: parked.missionId };
            break;
          }
        }
        if (resumed) {
          const feature = specs.get(resumed.featureId);
          if (!feature) throw new Error(`方案运行里有功能点 ${resumed.featureId}，方案文件里却没有。`);
          await runFeature(plan, run, feature, 1, deps, resumed.missionId);
          continue;
        }
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
      const parkedFeatures = new Set(run.escalations
        .filter((item) => item.resolution?.kind === 'parked')
        .map((item) => item.featureId));
      const blockedDependency = feature.dependsOn?.find((id) => parkedFeatures.has(id));
      if (blockedDependency) {
        await deps.store.update((r) => r.suspendFeature(
          feature.id,
          `依赖功能 ${blockedDependency} 对应的 Mission 已挂起，不能派发。`,
        ));
        continue;
      }
      await runFeature(plan, run, feature, next.missionIds.length + 1, deps);
    }
  } catch (error) {
    const stopped = deps.store.read()?.stopped;
    if (stopped?.reason === 'service_shutdown') return stopped;
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
  existingMissionId?: string,
): Promise<void> {
  const restoredMissionId = attempt === 1 ? deps.resumeMissions?.[feature.id] : undefined;
  const missionId = existingMissionId ?? restoredMissionId ?? (attempt === 1 ? `${run.id}-${feature.id}` : `${run.id}-${feature.id}-r${attempt}`);
  if (requireRun(deps).stopped) return;
  if (existingMissionId) {
    deps.log(`${feature.id} ▶ ${existingMissionId}（续跑已解挂 Mission）`);
  } else if (restoredMissionId) {
    await deps.store.update((r) => r.startFeature(feature.id, restoredMissionId));
    deps.log(`${feature.id} ▶ ${restoredMissionId}（恢复自上一次方案运行）`);
    if (!deps.platform.resumeMission) throw new Error('恢复已有 Mission 时缺少 platform.resumeMission 接口。');
    await deps.platform.resumeMission(restoredMissionId);
    if (requireRun(deps).stopped) return;
    const resumedAt = deps.now();
    if (wallClockReached(run, resumedAt)) {
      await deps.store.update((r) => r.checkStop(resumedAt));
      return;
    }
  } else {
  // 分类是尽力而为：有安全的回落（Standard），它自己出错不该拖垮整晚。
  const proposal = await deps.proposeRoute(feature).catch((error: unknown) => ({
    ok: false as const,
    reason: `分类员出错：${error instanceof Error ? error.message : String(error)}`,
  }));
  // 分类本身是一整次只读会话，可能跑过墙钟：到点了就不再建 Mission。功能还没
  // 开跑，checkStop 不会动它，它保持「没轮到」。
  if (requireRun(deps).stopped) return;
  const afterRoute = deps.now();
  if (wallClockReached(run, afterRoute)) {
    await deps.store.update((r) => r.checkStop(afterRoute));
    return;
  }
  const route = decideRoute(
    proposal.ok ? proposal.proposal : undefined,
    feature,
    proposal.ok ? undefined : proposal.reason,
    proposal.ok ? [] : proposal.haForbiddenUnproven,
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
    const forbidden = route.reason.startsWith('high_assurance 禁止副作用未证明为 false：');
    const explanation = forbidden
      ? `触发字段：${route.reason.slice('high_assurance 禁止副作用未证明为 false：'.length)}。依据：${[
          ...(feature.why ? [`why: ${feature.why}`] : []),
          ...(feature.constraints?.length ? [`constraints: ${feature.constraints.join('；')}`] : []),
        ].join('；') || '方案未提供 why/constraints 原文。'}`
      : '';
    const guidance = forbidden
      ? `${explanation}。请修改契约，明确不删除、不改写、不迁移数据后重跑；如确需副作用，须由用户决定，HAOFF1 当前关闭，不能立即放行。此处挂起发生在 Mission 建立前，不能审批。仅当以后形成真实 pending_release 且已有真实 Mission、审查提交、独立检视及报告等材料时，才可使用：node src/l3.ts plan approve <真实missionId> --run <记录> --feature <id> --commit <提交> --review <attempt> --report <报告> --target <分支> --as <检视者> --confirmed-by <确认者>。`
      : '';
    const needsDecision = guidance ? `${route.needsDecision} ${guidance}` : route.needsDecision;
    deps.log(`${feature.id} ⏸ ${route.reason}：不建 Mission，挂起等人。${guidance ? ` ${guidance}` : ''}`);
    await deps.store.update((r) => r.suspendFeature(feature.id, needsDecision));
    return;
  }
  const created = await createMission(plan, run, feature, missionId, route, deps);
  if (requireRun(deps).stopped) return;
  if (created.kind === 'ha_denied') {
    deps.log(`${feature.id} ⏸ HA 建单被拒：${created.reason}；不回落 Standard。`);
    await deps.store.update((r) => r.suspendFeature(feature.id, created.needsDecision));
    return;
  }
  if (requireRun(deps).stopped) return;
  await deps.store.update((r) => r.startFeature(feature.id, missionId));
  deps.log(`${feature.id} ▶ ${missionId}`);
  }

  const wallClockDeadline = new Date(
    Date.parse(run.startedAt) + run.stopConditions.wallClockMs,
  ).toISOString();
  // 协调者提问可当场答复：answer 后续跑同一条，不能退回 drivePlan 另开 -rN。
  for (;;) {
  const outcome = await deps.runMission(missionId, { wallClockDeadline });
  if (requireRun(deps).stopped) return;
  const retry = await waitForEligibleRetry(feature, missionId, outcome, deps);
  if (retry === 'stopped') return;
  if (retry === 'retry') continue;
  const landing = await land(plan, missionId, outcome, deps);

  if (landing.kind === 'ha_pending') {
    const openedAt = deps.now();
    if (wallClockReached(run, openedAt)) {
      await deps.store.update((r) => r.checkStop(openedAt));
      return;
    }
    const pass = await deps.platform.effectiveIndependentReviewPass(missionId);
    if (!pass || pass.verdict !== 'pass' || !pass.validationReportId) {
      const failure = `HA 待放行却没有当前有效的独立检视 pass（Mission ${missionId}）。`;
      await failAndEscalate(feature, missionId, failure, run, deps);
      return;
    }
    const deadline = new Date(
      Date.parse(openedAt) + run.stopConditions.escalationTimeoutMs,
    ).toISOString();
    await deps.store.update((r) => r.openHaRelease({
      featureId: feature.id,
      missionId,
      reviewedCommit: pass.reviewedCommit,
      attemptId: pass.reviewerAttemptId,
      validationReportId: pass.validationReportId!,
      reviewerId: r.reviewer,
      integrationBranch: r.integrationBranch,
      openedAt,
      deadline,
      verification: plan.integrationVerification.map((command) => ({
        command: command.argv.join(' '),
        timeoutMs: command.timeoutMs,
      })),
    }));
    deps.log(`${feature.id} HA 待放行记录已开：Mission ${missionId}，所审提交 ${pass.reviewedCommit}，截止 ${deadline}。`);
    const decision = await waitForHaRelease(feature.id, missionId, deps);
    if (!decision) return;
    if (decision.kind === 'approve') {
      const released = await releaseApproved(plan, feature, missionId, deps);
      if (released.kind === 'stopped') return;
      if (released.kind === 'unsafe') {
        deps.log(`${feature.id} ✗ ${released.detail}`);
        await deps.store.update((r) => r.halt('unsafe', released.detail, deps.now()));
        return;
      }
      if (released.kind === 'failed') {
        await failAndEscalate(feature, missionId, released.failure, run, deps);
        return;
      }
      deps.log(`${feature.id} ✓ HA 受控合入 ${released.mergedInto}`);
      try {
        await deps.store.update((r) => r.markMerged(feature.id));
      } catch (error) {
        const detail = `HA 已合入 ${released.mergedInto}，方案记录没写上 merged；要人工核对，禁止重合。`;
        await deps.store.update((r) => {
          if (!r.stopped) r.halt('unsafe', detail, deps.now());
        }).catch(() => undefined);
        throw error;
      }
      return;
    }
    const failure =
      decision.kind === 'send_back'
        ? `HA 待放行被检视者打回（${decision.reason ?? ''}），签字人 ${decision.by ?? '?'}（经 ${decision.confirmedBy ?? '?'} 确认），Mission ${missionId}。`
        : decision.kind === 'expired'
          ? `HA 待放行到截止（${deadline}）没人定，Mission ${missionId}，所审提交 ${pass.reviewedCommit}。`
          : `HA 待放行记录失效：${decision.reason ?? ''}（Mission ${missionId}）。`;
    await failAndEscalate(feature, missionId, failure, run, deps);
    return;
  }
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
  if (landing.kind === 'awaiting_answer') {
    const next = await handleAwaitingAnswer(feature, missionId, landing.question, run, deps);
    if (next === 'continue') continue;
    return;
  }
  await failAndEscalate(feature, missionId, landing.failure, run, deps);
  return;
  }
}

type ApprovedReleaseResult =
  | { readonly kind: 'merged'; readonly mergedInto: string }
  | { readonly kind: 'failed'; readonly failure: string }
  | { readonly kind: 'unsafe'; readonly detail: string }
  | { readonly kind: 'stopped' };

async function releaseApproved(
  plan: PlanSpec,
  feature: PlanFeatureSpec,
  missionId: string,
  deps: PlanDriverDeps,
): Promise<ApprovedReleaseResult> {
  let run = requireRun(deps);
  if (run.stopped) return { kind: 'stopped' };
  let now = deps.now();
  if (wallClockReached(run, now)) {
    await deps.store.update((r) => r.checkStop(now));
    return { kind: 'stopped' };
  }
  const release = run.haReleases.find(
    (item) => item.featureId === feature.id && item.missionId === missionId,
  );
  if (!release || release.decision?.kind !== 'approve') {
    throw new Error(`HA 放行决定不变式被破坏（${feature.id}/${missionId}）。`);
  }
  const decision = release.decision;
  const currentFeature = run.feature(feature.id);
  if (
    !currentFeature ||
    currentFeature.status !== 'running' ||
    currentFeature.missionIds.at(-1) !== release.missionId ||
    release.missionId !== missionId
  ) {
    throw new Error(
      `HA 放行决定不变式被破坏：功能 ${feature.id} 的 Mission ${missionId} ` +
      `与待放行记录 Mission ${release.missionId} 不匹配或功能状态不是 running。`,
    );
  }
  const view = await deps.platform.getMissionView(missionId);
  if (view.status === 'completed') {
    return {
      kind: 'unsafe',
      detail: `Mission ${missionId} 已 completed，但不是本次放行合入；要人工核对，禁止自动重合。`,
    };
  }
  if (
    view.status !== 'awaiting_review' ||
    view.executionMode !== 'high_assurance' ||
    view.haReviewHold !== 'pending_release'
  ) {
    return {
      kind: 'failed',
      failure:
        `HA approve 绑定的 Mission ${missionId} 现状不符（status=${view.status}, ` +
        `executionMode=${view.executionMode ?? '缺失'}, haReviewHold=${view.haReviewHold ?? '缺失'}），未合并。`,
    };
  }
  if (view.workspaceRef?.targetBranch !== run.integrationBranch) {
    return {
      kind: 'failed',
      failure:
        `HA approve 目标不符：当前 ${view.workspaceRef?.targetBranch ?? '缺失'}，` +
        `方案目标 ${run.integrationBranch}（Mission ${missionId}），未合并。`,
    };
  }
  const currentPass = await deps.platform.effectiveIndependentReviewPass(missionId);
  if (
    !currentPass || currentPass.verdict !== 'pass' ||
    currentPass.reviewedCommit !== release.reviewedCommit ||
    currentPass.reviewerAttemptId !== release.attemptId ||
    currentPass.validationReportId !== release.validationReportId
  ) {
    const current = currentPass
      ? `${currentPass.verdict}，提交 ${currentPass.reviewedCommit}，attempt ${currentPass.reviewerAttemptId}，报告 ${currentPass.validationReportId ?? '缺失'}`
      : '没有有效 pass';
    return {
      kind: 'failed',
      failure:
        `HA approve 所钉证据（提交 ${release.reviewedCommit}，attempt ${release.attemptId}，` +
        `报告 ${release.validationReportId}）与现状不符：${current}；未合并。`,
    };
  }
  run = requireRun(deps);
  if (run.stopped) return { kind: 'stopped' };
  now = deps.now();
  if (wallClockReached(run, now)) {
    await deps.store.update((r) => r.checkStop(now));
    return { kind: 'stopped' };
  }
  const reason = `PlanRun ${run.id}：${decision.by} 经 ${decision.confirmedBy} 确认，于 ${decision.at} 放行所钉提交 ${release.reviewedCommit}。`;
  let result: Awaited<ReturnType<PlanDriverDeps['platform']['finalizeMissionByHaAuthority']>>;
  try {
    result = await deps.platform.finalizeMissionByHaAuthority(missionId, {
      reviewerId: decision.by!,
      confirmedBy: decision.confirmedBy!,
      projectRoot: deps.projectRoot,
      verification: plan.integrationVerification,
      reasons: [reason],
    });
  } catch (error) {
    if (error instanceof PlatformRuleError) {
      if (error.code === 'HA_DETACHED_HEAD' || error.code === 'HA_TARGET_MISMATCH') {
        return { kind: 'unsafe', detail: `项目仓不在方案集成分支上，HA 受控放行被拒（${error.code}）：${error.message}` };
      }
      return { kind: 'failed', failure: `HA 受控放行被平台拒绝（${error.code}）：${error.message}；未合并。` };
    }
    return {
      kind: 'unsafe',
      detail:
        `HA 受控放行结果不明：${error instanceof Error ? error.message : String(error)}；` +
        '合并可能已落地。人工核对锚点、当前 HEAD 与集成报告，禁止自动重合。',
    };
  }
  if (result.status === 'completed') {
    if (typeof result.mergedInto !== 'string' || result.mergedInto.trim() === '') {
      return { kind: 'unsafe', detail: `HA 平台报告 Mission ${missionId} 已完成但缺 mergedInto；人工核对，禁止自动重合。` };
    }
    const after = await deps.platform.getMissionView(missionId);
    if (
      after.status === 'completed' &&
      after.finalReview?.mergedInto === result.mergedInto &&
      after.workspaceRef?.targetBranch === run.integrationBranch
    ) {
      return { kind: 'merged', mergedInto: result.mergedInto };
    }
    return { kind: 'unsafe', detail: `HA 平台报告已合入 ${result.mergedInto}，但 Mission 终态 / finalReview / 目标不匹配；人工核对，禁止自动重合。` };
  }
  if (result.rolledBackTo) {
    return {
      kind: 'failed',
      failure:
        `HA 合入后方案级验证红了（Mission ${missionId}，报告 ${result.reportId ?? '?'}），` +
        `已退回 ${result.rolledBackTo.slice(0, 12)}；未标 merged。`,
    };
  }
  if (result.reportId) {
    return { kind: 'unsafe', detail: `HA 合入验证未安全收尾（报告 ${result.reportId}）：${result.reason ?? '原因缺失'}。` };
  }
  if (result.reason?.includes('禁止自动重合')) {
    return { kind: 'unsafe', detail: `HA 平台标记 unsafe：${result.reason}` };
  }
  return { kind: 'failed', failure: `HA 合并失败：${result.reason ?? '（没给原因）'}；集成分支没动。` };
}

async function createMission(
  plan: PlanSpec,
  run: PlanRun,
  feature: PlanFeatureSpec,
  missionId: string,
  route: Exclude<RoutingDecision, { kind: 'needs_human' }>,
  deps: PlanDriverDeps,
): Promise<{ readonly kind: 'created' } | { readonly kind: 'ha_denied'; readonly reason: string; readonly needsDecision: string }> {
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
      return { kind: 'created' };
    } catch (error) {
      // 同一份事实，平台分类器与这里的结论不会不同；会被拒的是工单本身的形状
      // （kernel 严格校验）。被拒的建单不留半截，照老路建 Standard 即可。
      // HA 安全拒绝绝不能走这条回落：普通 createMission 会绕开 HA 闸。
      if (
        !(error instanceof PlatformRuleError) &&
        !(error instanceof ClassifiedMissionInputError) &&
        !(error instanceof KernelError)
      ) {
        throw error;
      }
      if (route.classification.recommended.executionMode === 'high_assurance') {
        return {
          kind: 'ha_denied',
          reason: error.message,
          needsDecision:
            `平台拒绝 HA 建单（${error.message}）：不回落 Standard。` +
            `要你定：亲自主导 ${feature.id}，还是改事实后重排进方案？`,
        };
      }
      deps.log(`${feature.id} 按分类建单被拒（${error.message}），回落 Standard。`);
    }
  } else {
    deps.log(`${feature.id} 回落 Standard：${route.reason}`);
  }
  await deps.platform.createMission({ projectId: plan.projectId, missionId, contract, origin });
  if (route.kind === 'standard_fallback' && route.classification) {
    await deps.platform.recordStandardFallbackRoute?.(missionId, {
      classification: route.classification,
      fallbackReason: route.reason,
      ...(route.assessment ? { assessment: route.assessment } : {}),
    });
  }
  return { kind: 'created' };
}

function isIntegrationTargetMoved(reason: string | undefined): boolean {
  return typeof reason === 'string' && /目标被推进|checkout 被切换|被切走/.test(reason);
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
      return { kind: 'awaiting_answer', question: outcome.question };
    case 'waiting':
      return { kind: 'failed', failure: `Mission 停在 ${outcome.reason}：${outcome.detail}` };
    case 'stalled':
      return { kind: 'failed', failure: `Mission 卡住了：${outcome.reason}` };
  }

  const view = await deps.platform.getMissionView(missionId);
  if (requireRun(deps).stopped) return { kind: 'unsafe', detail: '' };
  if (view.executionMode === 'high_assurance' || view.haReviewHold) {
    if (view.haReviewHold === 'pending_release') {
      return { kind: 'ha_pending' };
    }
    return {
      kind: 'failed',
      failure:
        view.waitDetail ??
        `HA 独立检视未到待放行（${view.haReviewHold ?? view.status}）`,
    };
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
    if (isIntegrationTargetMoved(result.reason)) {
      return {
        kind: 'unsafe',
        detail:
          `验证通过后集成分支被推进 / 被切走，已停（报告 ${result.reportId}）。` +
          `不能再往上叠。${result.reason ?? ''}`,
      };
    }
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

/** 只有这两类 waiting 值得探一次资格：名额被占、没有可用候选。其余（等 L3 答复、
 * 基线过期、墙钟）要么等不到头，要么探针也证明不了，照旧走原升级处置。 */
function isRetryEligibleWaitReason(reason: WaitReason): boolean {
  return reason === 'project_busy' || reason === 'no_available_agent';
}

/**
 * 角色全冷却最多等这一刻钟。再长就不是「马上就好」，而是真缺人；拿整晚去等一个
 * 可能变不回来的冷却，不如照旧开单让人看。
 */
const MAX_ROLE_COOLDOWN_WAIT_MS = 15 * 60_000;

/**
 * 这条 waiting 是不是本 Mission 在**本次循环内**等得到头的？是就睡到点，续跑同一条；
 * 否则交回 land 走原升级处置。
 *
 * 三种等得到头：本 Mission 自己另一个在途工作项占着改动名额（capacity）、自己的
 * Hop 在退避（own_backoff）、该角色候选全在短冷却（role_cooldown）。这三种开升级单
 * 只是自己挡自己（第 32 波 PLAT3 的 E-4）。
 *
 * **归属与冷却只认探针给的结构化证据。** `project_busy` 这几个字既可能是自己占着
 * 名额，也可能是别的 Mission 在改代码，光看字样分不出来；猜错了要么白等一整晚，
 * 要么把自己的 Mission 当失败开单。所以没有探针 / 探针说不知道，一律走原路。
 *
 * 等待期间每轮先读 stopped、再看墙钟：墙钟到点就 checkStop 并停手，**不再调用**
 * 下一次 runMission——在途的那条交给 checkStop 挂起，第二天人还能看一眼。
 */
async function waitForEligibleRetry(
  feature: PlanFeatureSpec,
  missionId: string,
  outcome: MissionRunOutcome,
  deps: PlanDriverDeps,
): Promise<'retry' | 'stopped' | 'land'> {
  if (outcome.kind !== 'waiting') return 'land';
  if (!isRetryEligibleWaitReason(outcome.reason)) return 'land';
  const probe = deps.waitEligibility;
  if (!probe) return 'land';
  const eligibility = await probe(
    outcome.candidateRole !== undefined
      ? { missionId, reason: outcome.reason, detail: outcome.detail, candidateRole: outcome.candidateRole }
      : { missionId, reason: outcome.reason, detail: outcome.detail },
  );
  if (!eligibility) return 'land';
  const now = deps.now();
  let dueAt = Number.NaN;
  switch (eligibility.kind) {
    case 'own_backoff':
      dueAt = Date.parse(eligibility.availableAt);
      break;
    case 'capacity':
      dueAt = Date.parse(eligibility.nextPollAt);
      break;
    case 'role_cooldown':
      dueAt = Date.parse(eligibility.earliestUntil);
      // 超出这一刻钟的冷却不是「马上就好」，不拿运行去等。
      if (dueAt > Date.parse(now) + MAX_ROLE_COOLDOWN_WAIT_MS) return 'land';
      break;
  }
  // 日期读不懂（废字符串）时当没有证明：宁可开单让人看，也别拿坏数据空等。
  if (!Number.isFinite(dueAt)) return 'land';
  deps.log(
    `${feature.id} ⏳ ${outcome.reason}：${describeWaitEligibility(eligibility)}，续跑 ${missionId}，不开升级单。`,
  );
  const pollMs = deps.pollMs ?? 15_000;
  for (;;) {
    const current = requireRun(deps);
    if (current.stopped) return 'stopped';
    const round = deps.now();
    if (wallClockReached(current, round)) {
      await deps.store.update((r) => r.checkStop(round));
      return 'stopped';
    }
    const remaining = dueAt - Date.parse(round);
    if (remaining <= 0) return 'retry';
    const untilWallClock =
      Date.parse(current.startedAt) + current.stopConditions.wallClockMs - Date.parse(round);
    // 睡到三者最近的：到点复核、轮询太细没意义、墙钟到点前必须醒。
    await deps.sleep(Math.max(1, Math.min(pollMs, remaining, untilWallClock)));
  }
}

function describeWaitEligibility(eligibility: WaitEligibility): string {
  switch (eligibility.kind) {
    case 'own_backoff':
      return `本 Mission 自己的 Hop 退避到 ${eligibility.availableAt}`;
    case 'capacity':
      return `本 Mission 自己占着改动名额，${eligibility.nextPollAt} 再复核`;
    case 'role_cooldown':
      return `该角色候选全在冷却，最早 ${eligibility.earliestUntil} 到期`;
  }
}

/**
 * 仅 awaiting_l3 开可答复单。answer：不放弃、不新 Mission、不占 rerun，
 * 墙钟检查后再答复一次并续跑同一条；其余动作/过期走原 settle。
 */
async function handleAwaitingAnswer(
  feature: PlanFeatureSpec,
  missionId: string,
  question: string,
  run: PlanRun,
  deps: PlanDriverDeps,
): Promise<'continue' | 'done'> {
  const afterRun = deps.now();
  if (wallClockReached(run, afterRun)) {
    deps.log(`${feature.id} ⏸ 墙钟到点：协调者提问未答复：${question}`);
    await deps.store.update((r) => r.checkStop(afterRun));
    return 'done';
  }
  const failure = `协调者向 L3 提问：${question}`;
  const escalation = await deps.store.update((r) =>
    r.openEscalation(
      { featureId: feature.id, missionId, failure, question, answerable: true },
      deps.now(),
    ),
  );
  if (!escalation) {
    deps.log(`${feature.id} ✗ 升级单到上限：${failure}`);
    return 'done';
  }
  deps.log(`${feature.id} ⚑ 升级单 ${escalation.id}（${escalation.deadline} 截止）：${failure}`);
  await waitForResolution(escalation.id, deps);
  const current = requireRun(deps);
  if (current.stopped) return 'done';
  const resolved = current.escalations.find((item) => item.id === escalation.id);
  const resolution = resolved?.resolution;
  if (resolution?.kind === 'decided' && resolution.action === 'answer') {
    const now = deps.now();
    if (wallClockReached(current, now)) {
      await deps.store.update((r) => r.checkStop(now));
      return 'done';
    }
    await deps.platform.answerEscalation(missionId, resolution.answer);
    deps.log(`${feature.id} ↩ 检视者答复了 ${escalation.id}，续跑 ${missionId}`);
    return 'continue';
  }
  await settle(missionId, escalation.id, deps);
  return 'done';
}

/** 所有失败共用原升级尾巴，避免 HA 与普通失败的开单和收尾语义分叉。 */
async function failAndEscalate(
  feature: PlanFeatureSpec,
  missionId: string,
  failure: string,
  run: PlanRun,
  deps: PlanDriverDeps,
): Promise<void> {
  // 墙钟已经到了（多半正是它被暂停了）：今晚没人会定这张单，不开。停下，
  // 跑着的功能由 checkStop 挂起并写明要人定什么。
  const afterRun = deps.now();
  if (wallClockReached(run, afterRun)) {
    deps.log(`${feature.id} ⏸ 墙钟到点：${failure}`);
    await deps.store.update((r) => r.checkStop(afterRun));
    return;
  }
  const question =
    `${feature.id}「${feature.title}」没能合进集成分支：${failure} ` +
    '选一个：隔离重跑（另开一条从头来）/ 跳过 / 重划剩余范围（点名依赖它的功能一并删掉）/ 停。';
  const escalation = await deps.store.update((r) =>
    r.openEscalation({ featureId: feature.id, missionId, failure, question }, deps.now()),
  );
  // 到上限：规则已挂起并停下。再 wait / settle 会空等或把失败 Mission 放弃掉。
  if (!escalation) {
    deps.log(`${feature.id} ✗ 升级单到上限：${failure}`);
    return;
  }
  deps.log(`${feature.id} ⚑ 升级单 ${escalation.id}（${escalation.deadline} 截止）：${failure}`);
  await waitForResolution(escalation.id, deps);
  await settle(missionId, escalation.id, deps);
}

/** 等待 HA 决定；墙钟先于决定与截止，因为到点后即使已有决定也不再执行。 */
async function waitForHaRelease(
  featureId: string,
  missionId: string,
  deps: PlanDriverDeps,
): Promise<HaReleaseDecision | undefined> {
  const pollMs = deps.pollMs ?? 15_000;
  for (;;) {
    const run = requireRun(deps);
    if (run.stopped) return undefined;
    const now = deps.now();
    if (wallClockReached(run, now)) {
      await deps.store.update((r) => r.checkStop(now));
      continue;
    }
    const release = run.haReleases.find((item) => item.featureId === featureId && item.missionId === missionId);
    if (!release) throw new Error(`驱动开立的 HA 待放行记录不见了（${featureId}/${missionId}）。`);
    if (release.decision) return release.decision;
    if (Date.parse(now) >= Date.parse(release.deadline)) {
      await deps.store
        .update((r) => r.expireHaRelease(featureId, now))
        .catch(tolerate('HA_RELEASE_REJECTED', 'PLAN_RUN_STOPPED'));
      continue;
    }
    const untilDeadline = Date.parse(release.deadline) - Date.parse(now);
    const untilWallClock = Date.parse(run.startedAt) + run.stopConditions.wallClockMs - Date.parse(now);
    await deps.sleep(Math.max(1, Math.min(pollMs, untilDeadline, untilWallClock)));
  }
}

/** 等到单子有了结论（决定 / 过期），或者方案停了。 */
async function waitForResolution(escalationId: string, deps: PlanDriverDeps): Promise<void> {
  const pollMs = deps.pollMs ?? 15_000;
  for (;;) {
    const run = requireRun(deps);
    const escalation = run.escalations.find((e) => e.id === escalationId);
    if (!escalation) throw new Error(`升级单 ${escalationId} 不见了。`);
    if (run.stopped || escalation.resolution) return;
    const mission = await deps.platform.getMissionView(escalation.missionId);
    if (mission.parked) {
      const reason = mission.parkReason ?? 'Mission 已由检视者挂起。';
      await deps.store.update((r) => r.parkMission(escalation.missionId, reason, deps.now()));
      return;
    }
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
  // 方案停了（叫停 / 未解决到顶 / 墙钟 / 升级单到上限）：原样留给人，第二天还能看一眼再合。
  if (run.stopped) return;
  const view = await deps.platform.getMissionView(missionId);
  if (view.parked || view.status === 'completed' || view.status === 'blocked') return;
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
