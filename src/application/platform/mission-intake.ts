import type { ComplexityAssessment, Mission } from '../../kernel/index.ts';
import type { CreateMissionInput, CreateClassifiedMissionInput, CreateClassifiedMissionResult } from './types.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import { assertNoCallerRouteOverride, parseComplexityAssessmentStrict, parseTaskFactsStrict } from '../classified-mission-intake.ts';
import { classifyTask, type ClassificationResult } from '../task-classifier.ts';
type IntakeCallbacks = { createMission: (input: CreateMissionInput) => Promise<{ missionId: string }>; recordWorkspace: (missionId: string, ref: { projectRoot?: string; branch: string; baseRevision: string; targetBranch?: string }) => Promise<void> };

export async function recordStandardFallbackRoute(ctx: PlatformContext, callbacks: IntakeCallbacks, 
    missionId: string,
    input: {
      classification: ClassificationResult;
      fallbackReason: string;
      assessment?: ComplexityAssessment;
    },
  ): Promise<void> {
    return ctx.tx(async () => {
      const { mission } = await ctx.locate(missionId);
      if (mission.executionMode !== 'standard' || mission.runKind !== 'mutation') {
        throw new PlatformRuleError(
          'STANDARD_FALLBACK_ROUTE_FORBIDDEN',
          '分类回落路由事件仅适用于普通 Standard mutation Mission。',
        );
      }
      if (typeof input.fallbackReason !== 'string' || input.fallbackReason.trim().length === 0) {
        throw new PlatformRuleError('EMPTY_FALLBACK_REASON', 'fallbackReason 不能为空。');
      }
      if ((await ctx.activity.list(missionId)).some((event) => event.kind === 'mission.routed')) {
        throw new PlatformRuleError('DUPLICATE_MISSION_ROUTE', 'Mission 已有 mission.routed 事件。');
      }
      const { classification } = input;
      const routedData: Record<string, unknown> = {
        recommended: classification.recommended,
        confidence: classification.confidence,
        facts: classification.facts,
        unknowns: classification.unknowns,
        criticalUnknowns: classification.criticalUnknowns,
        reasons: classification.reasons,
        fallbackReason: input.fallbackReason,
      };
      if (classification.assessmentRef !== undefined) {
        routedData.assessmentRef = classification.assessmentRef;
      }
      if (input.assessment !== undefined) {
        routedData.assessmentReasons = input.assessment.reasons;
      }
      await ctx.event(mission, 'mission.routed', routedData);
    });
  }

/**
 * 把这一版契约的验收口径原文留一份。
 *
 * 为什么在调用点外面做成一个函数：留档必须与 Mission 的创建 / 换代落在同一个
 * 事务里，而「同一个事务」靠的是 caller 已经开好的那个 ctx.tx——这里再包一层
 * 事务，失败时回滚的就只有留档自己，Mission 照建，等于留了一条对不上任何
 * Mission 的孤证。
 *
 * 为什么缺席直接 return 而不是抛错：留档是记录能力，不是规则。没有仓储就
 * 建不了 Mission，等于把「能不能问得出原文」和「能不能干活」焊死，而后者
 * 才是平台该保证的。
 *
 * 为什么 acceptance 原样不 trim：它是契约里逐条写下的口径，改写 caller 的文本
 * 等于篡改契约。
 */
export async function recordContractAcceptance(
  ctx: PlatformContext,
  missionId: string,
  contractRevision: number,
  acceptance: readonly string[],
): Promise<void> {
  if (ctx.contractHistories === undefined) return;
  await ctx.contractHistories.append({
    missionId,
    contractRevision,
    acceptance: [...acceptance],
    at: ctx.clock.now().toISOString(),
  });
}

export async function createMission(ctx: PlatformContext, input: CreateMissionInput): Promise<{ missionId: string }> {
    const project = await ctx.ensureProject(input.projectId);
    const missionId = input.missionId ?? ctx.ids.next('M');
    const mission = project.createMission({
      id: missionId,
      contract: input.contract,
      origin: input.origin,
    });
    await ctx.projects.save(project);
    await ctx.event(mission, 'mission.created', { contractRevision: mission.contractRevision });
    await recordContractAcceptance(ctx, mission.id, mission.contractRevision, mission.contract.acceptance);
    return { missionId };
  }

export async function createClassifiedMission(ctx: PlatformContext, callbacks: IntakeCallbacks, 
    input: CreateClassifiedMissionInput,
  ): Promise<CreateClassifiedMissionResult> {
    assertNoCallerRouteOverride(input as unknown);

    const facts = parseTaskFactsStrict(input.facts);
    const assessment = parseComplexityAssessmentStrict(input.assessment);
    const classification = classifyTask({
      facts,
      ...(assessment !== undefined ? { assessment } : {}),
    });

    const { recommended } = classification;
    const hasWorkOrder = input.workOrder !== undefined && input.workOrder !== null;

    // ---- route guards（不建 Mission / 不 ensure Project）----
    if (recommended.runKind === 'query') {
      throw new PlatformRuleError(
        'QUERY_ROUTE_REQUIRED',
        '分类结果为 query：本入口不创建 Mission；请走 Query 路径（M3D-3）。',
      );
    }

    const mode = recommended.executionMode;
    if (mode === 'high_assurance') {
      const flagged = haForbiddenSideEffects(facts.highAssurance);
      if (flagged.length > 0) {
        throw new PlatformRuleError(
          'HA_SIDE_EFFECT_DENIED',
          `带外部副作用的 HA（${flagged.join(', ')}）首版一律拒绝，不创建 Mission。`,
        );
      }
      if (hasWorkOrder) {
        throw new PlatformRuleError(
          'HIGH_ASSURANCE_WORK_ORDER_FORBIDDEN',
          'high_assurance 路由禁止携带 Lightweight workOrder。',
        );
      }
    }

    if (mode === 'standard') {
      if (hasWorkOrder) {
        throw new PlatformRuleError(
          'STANDARD_WORK_ORDER_FORBIDDEN',
          'standard 路由禁止携带 workOrder（避免 Fast Lane 单混入 Standard）。',
        );
      }
    } else if (mode === 'lightweight') {
      if (!hasWorkOrder) {
        throw new PlatformRuleError(
          'LIGHTWEIGHT_WORK_ORDER_REQUIRED',
          'lightweight 路由必须提供 explicit workOrder。',
        );
      }
    } else if (mode !== 'high_assurance') {
      // HA 的副作用/workOrder 已在上面守卫过；这里不能再当未知 mode 拒掉。
      throw new PlatformRuleError(
        'UNSUPPORTED_ROUTE',
        `不支持的 executionMode：${String(mode)}`,
      );
    }

    // ---- 通过 guards 后才 ensure / 分配 id / 创建 ----
    const project = await ctx.ensureProject(input.projectId);
    const missionId = input.missionId ?? ctx.ids.next('M');

    let mission: Mission;
    let workItemId: string | undefined;

    if (mode === 'standard' || mode === 'high_assurance') {
      mission = project.createMission({
        id: missionId,
        contract: input.contract,
        origin: input.origin,
        executionMode: mode,
        runKind: 'mutation',
        ...(assessment !== undefined ? { complexityAssessment: assessment } : {}),
      });
    } else {
      // lightweight：原子 Mission + 唯一 Frozen WorkItem
      const workOrder = input.workOrder!;
      const initialId = ctx.ids.next('W');
      const { mission: created, workItem } = project.createMissionWithInitialWorkItem({
        id: missionId,
        contract: input.contract,
        origin: input.origin,
        executionMode: 'lightweight',
        runKind: 'mutation',
        ...(assessment !== undefined ? { complexityAssessment: assessment } : {}),
        initialWorkItem: {
          id: initialId,
          title: workOrder.objective,
          order: workOrder,
        },
      });
      mission = created;
      workItemId = workItem.id;
    }

    await ctx.projects.save(project);

    await ctx.event(mission, 'mission.created', {
      contractRevision: mission.contractRevision,
      executionMode: mission.executionMode,
      runKind: mission.runKind,
      classified: true,
    });
    // 分类入口不走 createMission，留档得在这里再记一次：漏了它，从
    // createClassifiedMission 进来的 Mission 就永远问不出第 1 版写了什么。
    await recordContractAcceptance(ctx, mission.id, mission.contractRevision, mission.contract.acceptance);

    const routedData: Record<string, unknown> = {
      recommended: classification.recommended,
      confidence: classification.confidence,
      facts: classification.facts,
      unknowns: classification.unknowns,
      criticalUnknowns: classification.criticalUnknowns,
      reasons: classification.reasons,
    };
    if (classification.assessmentRef !== undefined) {
      routedData.assessmentRef = classification.assessmentRef;
    }
    await ctx.event(mission, 'mission.routed', routedData);

    if (workItemId !== undefined) {
      const item = mission.workItem(workItemId);
      await ctx.event(
        mission,
        'work_item.created',
        { title: item?.title ?? input.workOrder!.objective, executionMode: 'lightweight' },
        workItemId,
        // 无 Coordinator attemptId
      );
    }

    return {
      missionId,
      ...(workItemId !== undefined ? { workItemId } : {}),
      classification,
    };
  }

export async function rerunMission(ctx: PlatformContext, callbacks: IntakeCallbacks, 
    missionId: string,
    options?: { newMissionId?: string; baseRevision?: string },
  ): Promise<{
    missionId: string;
    rerunOf: string;
    contractRevision: number;
    /** 钉住的分叉基线。源头没记过工作区时为 undefined。 */
    baseRevision: string | undefined;
    /**
     * 源头那次的产出**已经落地进项目了**。
     *
     * 这时候这次重跑不是干净的对照：答案就摆在项目的工作区里，agent 读一眼
     * 就有。实测 P1-single 正是这么干的——它 read 了主仓库的 profile-audit.ts
     * 和 .test.ts，还 git show 了那次交付的提交。**它不是在解题，是在抄**，
     * 而两份记录看上去都完整自洽。
     *
     * 隔离做不到（agent 用绝对路径就能越出 worktree），所以至少要**说出来**：
     * 拿这样一次运行去和源头比成本，比出来的数是假的。
     */
    sourceAlreadyLanded: boolean;
  }> {
    const { mission, project } = await ctx.locate(missionId);
    if (!mission.contract) {
      throw new PlatformRuleError('NO_CONTRACT', `Mission ${missionId} 没有契约，没法重跑。`);
    }
    // 源头永远指向**最初那条**，不形成链：#3 是 #1 的重跑，不是 #2 的重跑。
    // 挂成链的话，"这个任务一共跑过几遍"就得顺着指针爬，而且断一环就散了。
    const root = mission.origin?.rerunOf ?? missionId;
    const runs = project.missions.filter(
      (m) => m.id === root || m.origin?.rerunOf === root,
    ).length;
    const newId = options?.newMissionId ?? `${root}#${runs + 1}`;
    const created = await callbacks.createMission({
      projectId: mission.projectId,
      missionId: newId,
      contract: mission.contract,
      origin: { ...(mission.origin ?? { clientType: 'cli' }), rerunOf: root },
    });

    // **把起点钉死在源头那次的分叉基线上。**
    //
    // 不钉的话，worktree 会从"跑这一次时目标分支的 HEAD"分叉——而源头那次的
    // 产出多半已经合进去了，第二次一开始活儿就是干完的状态。两次运行起点
    // 不同，比出来的成本、耗时、跳数全都没有意义，而且**看不出来哪里不对**：
    // 两条记录都完整、都自洽，只是不可比。
    const base = options?.baseRevision ?? mission.workspaceRef?.baseRevision;
    if (base) {
      await callbacks.recordWorkspace(created.missionId, {
        projectRoot: mission.workspaceRef?.projectRoot,
        branch: `mission/${created.missionId}`,
        baseRevision: base,
      });
    }
    // 字段都自己填齐，别直接把 createMission 的 { missionId } 透传出去：
    // 返回类型写了几个而实际只回一个，类型剥离不检查，调用方拿到的是 undefined。
    // 源头的产出落地过没有。看的是**最初那条**，不是链上任意一条：
    // 答案进没进项目只由它决定。
    const source = project.missions.find((m) => m.id === root) ?? mission;
    return {
      ...created,
      rerunOf: root,
      contractRevision: mission.contractRevision,
      baseRevision: base,
      sourceAlreadyLanded: source.finalReview?.verdict === 'merge',
    };
  }

const HA_FORBIDDEN_SIDE_EFFECTS = [
  'productionDeployRelease',
  'externalPaidOp',
  'unrecoverableExternalSideEffect',
  'destructiveData',
] as const;

/** 无法证明为 false 的禁止副作用：true 与 unknown 都算未证明安全。 */
function haForbiddenSideEffects(ha: {
  readonly productionDeployRelease: unknown;
  readonly externalPaidOp: unknown;
  readonly unrecoverableExternalSideEffect: unknown;
  readonly destructiveData: unknown;
}): string[] {
  return HA_FORBIDDEN_SIDE_EFFECTS.filter((key) => ha[key] !== false);
}
