/**
 * 平台用例层 —— coagent_* 工具背后的真实实现。
 *
 * 工具的 handler（住在各个 runtime 适配包里）只负责把结构化参数转发到这里。
 * 规则写在这一层而不是 prompt 里：**能用工具层挡住的，就不要指望模型记得住。**
 */

import { randomUUID } from 'node:crypto';
import {
  InvariantViolationError,
  isPromotionTriggerCode,
} from '../kernel/index.ts';
import type {
  Attempt,
  AttemptEndReason,
  AttemptKind,
  BlockedRecord,
  EscalationBody,
  EvidenceRecord,
  ExecutionResultBody,
  FinalReview,
  FinalReviewAuthority,
  Mission,
  MissionContract,
  MissionExecutionMode,
  MissionResultBody,
  OriginChannel,
  PlanBody,
  Project,
  PromotionRecord,
  PromotionStatus,
  PromotionTokenUsageSnapshot,
  PromotionTriggerCode,
  PromotionUnknownDimension,
  PromotionUsageSnapshot,
  PromotionWorkspaceRevision,
  ReviewAuthority,
  ReviewRecord,
  RunKind,
  TokenUsage,
  UsedProfile,
  ValidationReport,
  WaitReason,
  WorkItem,
  WorkOrder,
  WorkspaceRef,
} from '../kernel/index.ts';
import type { ActivityLog, Clock, DecisionProvider, IdGenerator, ProjectRepository } from './ports.ts';
import type { DeliveryRepository } from './delivery.ts';
import type { WorkspaceManager } from './workspace.ts';
import type { ArtifactStore } from './artifact-store.ts';
import { InlineArtifactStore } from './artifact-store.ts';
import {
  applyMemoryDelta,
  plannedMemoryFiles,
  readProjectMemory,
  writeVibe,
} from './project-memory.ts';
import { runDecisionShadow } from './decision-shadow-runner.ts';
import {
  assertNoCallerRouteOverride,
  ClassifiedMissionInputError,
  parseComplexityAssessmentStrict,
  parseTaskFactsStrict,
} from './classified-mission-intake.ts';
import { classifyTask, type ClassificationResult } from './task-classifier.ts';
import {
  anyHardAuthoritativeExceeded,
  budgetThresholdCrossings,
  buildBudgetUsageSnapshot,
  countAuthoritativeCommands,
  countAuthoritativeRounds,
  evaluateExecutionBudget,
  formatHardBudgetExceededDetail,
  hardExceededVerdicts,
  projectAuthoritativeWallClockMs,
  type BudgetEvaluation,
  type BudgetUsageSnapshot,
} from './budget-usage.ts';

/**
 * Lightweight 机器验收依赖（结构类型，避免 platform 直接耦合 validation 模块路径）。
 * engine / reports 由装配层注入；Standard 路径不读这组。
 */
export interface PlatformValidationDeps {
  readonly engine: {
    readonly validate: (input: {
      readonly missionId: string;
      readonly baseRevision: string;
      readonly projectRoot: string;
      readonly workItemId?: string;
      readonly attemptId?: string;
      readonly allowedScope: readonly string[];
      readonly commands: readonly {
        readonly argv: readonly string[];
        readonly cwd: string;
        readonly timeoutMs: number;
      }[];
      /** 仅从 frozen WorkOrder.validation 拷贝；缺省 = 检查不在 force。 */
      readonly forbiddenPaths?: readonly string[];
      readonly diffSize?: {
        readonly maxChangedFiles?: number;
        readonly maxChangedLines?: number;
      };
    }) => Promise<{
      readonly report: ValidationReport;
      readonly authority?: Extract<ReviewAuthority, { kind: 'validator' }>;
    }>;
  };
  readonly reports: {
    save(report: ValidationReport): Promise<void>;
    get(reportId: string): Promise<ValidationReport | undefined>;
  };
}

/** 平台规则被违反（区别于领域流转错误）。 */
export class PlatformRuleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlatformRuleError';
    this.code = code;
  }
}

export interface PlatformDeps {
  projects: ProjectRepository;
  deliveries: DeliveryRepository;
  /** 落地改动要用。不配就只能做 send_back / abandon。 */
  workspace?: WorkspaceManager;
  /** 大日志/大 diff 外置。不配就全内联（状态文件会变大）。 */
  artifacts?: ArtifactStore;
  activity: ActivityLog;
  clock: Clock;
  ids: IdGenerator;
  /**
   * 可选 DecisionProvider。仅用于 PRE_DISPATCH shadow 审计：
   * 不注入则完全跳过；注入后信号/失败也不影响真实 dispatch。
   */
  decisionProvider?: DecisionProvider;
  /**
   * Lightweight 机器验收依赖（成组 optional）。
   * Standard 路径不读这组；缺省时 validateAndAcceptLightweightWorkItem fail-closed。
   */
  validation?: PlatformValidationDeps;
}

export interface CreateMissionInput {
  projectId: string;
  missionId?: string;
  contract: MissionContract;
  /** 结果最终回到哪里。缺省表示无人认领——结果仍会进收件箱，只是没有收件人。 */
  origin?: OriginChannel;
}

/**
 * Classified Mission 入口：facts/assessment + Contract + 可选 explicit WorkOrder。
 * caller **不得**传 executionMode / runKind / ClassificationResult 等 route override。
 * 平台内部 strict parse + classifyTask 决定路由。
 */
export interface CreateClassifiedMissionInput {
  projectId: string;
  missionId?: string;
  contract: MissionContract;
  origin?: OriginChannel;
  /** 结构化 facts；由 strict parser 校验。 */
  facts: unknown;
  /** 可选六维评估；缺省不传。 */
  assessment?: unknown;
  /**
   * explicit WorkOrder。lightweight 必填；standard 禁止；
   * query/HA 路径到不了创建。
   */
  workOrder?: WorkOrder;
}

export interface CreateClassifiedMissionResult {
  missionId: string;
  workItemId?: string;
  classification: ClassificationResult;
}

export class Platform {
  #projects: ProjectRepository;
  #activity: ActivityLog;
  #ids: IdGenerator;
  #deliveries: DeliveryRepository;
  #workspace: WorkspaceManager | undefined;
  #artifacts: ArtifactStore;
  #clock: Clock;
  #decisionProvider: DecisionProvider | undefined;
  #validation: PlatformValidationDeps | undefined;

  constructor(deps: PlatformDeps) {
    this.#projects = deps.projects;
    this.#activity = deps.activity;
    this.#ids = deps.ids;
    this.#deliveries = deps.deliveries;
    this.#workspace = deps.workspace;
    this.#artifacts = deps.artifacts ?? new InlineArtifactStore();
    this.#clock = deps.clock;
    this.#decisionProvider = deps.decisionProvider;
    this.#validation = deps.validation;
  }

  /* =============================== L3 面 =============================== */

  async createMission(input: CreateMissionInput): Promise<{ missionId: string }> {
    const project = await this.#ensureProject(input.projectId);
    const missionId = input.missionId ?? this.#ids.next('M');
    const mission = project.createMission({
      id: missionId,
      contract: input.contract,
      origin: input.origin,
    });
    await this.#projects.save(project);
    await this.#event(mission, 'mission.created', { contractRevision: mission.contractRevision });
    return { missionId };
  }

  /**
   * Fast Lane / Standard classified 入口。
   *
   * 顺序：assert override → strict parse → classify → route guards
   * （**先于** ensureProject / id 分配，拒绝路径不留空 Project）→ 创建 → 单次 save → 审计。
   * executionMode / runKind **只**取 classifier.recommended。
   */
  async createClassifiedMission(
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
      throw new PlatformRuleError(
        'HIGH_ASSURANCE_NOT_AVAILABLE',
        '分类结果为 high_assurance：本阶段不可用，不创建 Mission。',
      );
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
    } else {
      // 防御：classifier 合同外的 mode
      throw new PlatformRuleError(
        'UNSUPPORTED_ROUTE',
        `不支持的 executionMode：${String(mode)}`,
      );
    }

    // ---- 通过 guards 后才 ensure / 分配 id / 创建 ----
    const project = await this.#ensureProject(input.projectId);
    const missionId = input.missionId ?? this.#ids.next('M');

    let mission: Mission;
    let workItemId: string | undefined;

    if (mode === 'standard') {
      mission = project.createMission({
        id: missionId,
        contract: input.contract,
        origin: input.origin,
        executionMode: 'standard',
        runKind: 'mutation',
        ...(assessment !== undefined ? { complexityAssessment: assessment } : {}),
      });
    } else {
      // lightweight：原子 Mission + 唯一 Frozen WorkItem
      const workOrder = input.workOrder!;
      const initialId = this.#ids.next('W');
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

    await this.#projects.save(project);

    await this.#event(mission, 'mission.created', {
      contractRevision: mission.contractRevision,
      executionMode: mission.executionMode,
      runKind: mission.runKind,
      classified: true,
    });

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
    await this.#event(mission, 'mission.routed', routedData);

    if (workItemId !== undefined) {
      const item = mission.workItem(workItemId);
      await this.#event(
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

  /**
   * 再跑一遍同一个任务。
   *
   * **另起一条 Mission，契约一字不改地抄过来**，而不是把原来那条洗干净重用。
   * 理由是"能比较"：每次运行要有自己那份 attempt、用量、耗时、结束原因，
   * 横着摆才看得出"换了协调者模型之后便宜了没有"。洗掉重用会把上一次的
   * 记录抹了，而那正是要比的东西。
   *
   * 抄的是**当前生效的契约**（可能已经改到 r2/r3），不是 r1：重跑的意思是
   * "照现在的要求再来一次"。
   *
   * 不碰任何不变量：它就是一次普通的 createMission。同 Project 的改动名额
   * 仍然一次只给一条——想并行跑多个配置的话，那条限制要单独拆（它现在把
   * "正在改代码"和"会把改动合回去"混成了一件事），不在这里顺手改。
   */
  async rerunMission(
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
    const { mission, project } = await this.#locate(missionId);
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
    const created = await this.createMission({
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
      await this.recordWorkspace(created.missionId, {
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

  /**
   * 同一个任务的所有运行，按开始时间排。
   *
   * 这是"可比较"的读出口：一次运行一行，带上它花了多少、跑了多久、几跳、
   * 各跳因为什么结束、最后是什么结果。回答的是「这次改动到底让它变好了没有」——
   * 而在这之前，这个问题只能靠手写 SQL 去比两条碰巧相似的 Mission。
   */
  async listRuns(missionId: string): Promise<RunSummary[]> {
    const { mission, project } = await this.#locate(missionId);
    const root = mission.origin?.rerunOf ?? missionId;
    const runs = project.missions.filter((m) => m.id === root || m.origin?.rerunOf === root);
    return Promise.all(runs.map(async (m) => {
      const attempts = [
        ...m.coordinatorAttempts,
        ...m.workItems.flatMap((item) => item.attempts),
      ];
      const endedBy: Record<string, number> = {};
      for (const attempt of attempts) {
        const key = attempt.endedBy ?? 'in_progress';
        endedBy[key] = (endedBy[key] ?? 0) + 1;
      }

      const events = await this.#activity.list(m.id);
      const createdAt = events.find((event) => event.kind === 'mission.created')?.at;
      const firstExecutionResultAt = events.find(
        (event) => event.kind === 'execution_result.submitted',
      )?.at;

      let l2Reviews = 0;
      let l2Rejects = 0;
      let l3Reviews = 0;
      let l3SendBacks = 0;
      let validatorRuns = 0;
      let validatorFailures = 0;
      for (const event of events) {
        const data =
          event.data != null && typeof event.data === 'object' && !Array.isArray(event.data)
            ? event.data as Record<string, unknown>
            : undefined;
        if (event.kind === 'review.recorded' && data?.authority !== 'validator') {
          l2Reviews += 1;
          if (data?.verdict === 'reject') l2Rejects += 1;
        }
        if (
          event.kind === 'final_review.send_back' ||
          event.kind === 'final_review.merged' ||
          event.kind === 'final_review.abandoned'
        ) {
          l3Reviews += 1;
          if (event.kind === 'final_review.send_back') l3SendBacks += 1;
        }
        if (event.kind === 'validation.reported' && typeof data?.passed === 'boolean') {
          validatorRuns += 1;
          if (data.passed === false) validatorFailures += 1;
        }
      }

      const promotion = m.promotions[0];
      return {
        missionId: m.id,
        isOriginal: m.id === root,
        status: m.status,
        outcome: m.result?.outcome,
        contractRevision: m.contractRevision,
        entryMode: promotion?.fromMode ?? m.executionMode,
        currentMode: m.executionMode,
        promotionTrigger: promotion?.triggerCode,
        baseRevision: m.workspaceRef?.baseRevision,
        firstExecutionResultMs: elapsedMs(createdAt, firstExecutionResultAt),
        totalDurationMs:
          m.status === 'completed' || m.status === 'blocked'
            ? elapsedMs(createdAt, m.updatedAt)
            : undefined,
        l2Reviews,
        l2Rejects,
        l3Reviews,
        l3SendBacks,
        validatorRuns,
        validatorFailures,
        coordinatorHops: m.coordinatorAttempts.length,
        executorHops: m.workItems.reduce((n, item) => n + item.attempts.length, 0),
        workItems: m.workItems.length,
        usage: sumUsage(m),
        endedBy,
      };
    }));
  }

  async reviseContract(
    missionId: string,
    contract: MissionContract,
  ): Promise<{ contractRevision: number }> {
    const { mission } = await this.#locate(missionId);
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
    await this.#event(mission, 'contract.revised', { contractRevision, status: mission.status });
    return { contractRevision };
  }

  /* ========================= Attempt 生命周期 ========================= */

  async startCoordinatorAttempt(
    missionId: string,
    profile?: UsedProfile,
  ): Promise<{ attemptId: string }> {
    const { mission } = await this.#locate(missionId);
    const attempt = mission.startCoordinatorAttempt();
    if (profile) attempt.recordProfile(profile);
    await this.#event(mission, 'attempt.started', { kind: 'coordinator', profile }, undefined, attempt.id);
    return { attemptId: attempt.id };
  }

  async startExecutorAttempt(
    missionId: string,
    workItemId: string,
    profile?: UsedProfile,
  ): Promise<{ attemptId: string }> {
    const { mission, item } = await this.#locateItem(missionId, workItemId);
    // 提交结果 ≠ 尝试结束。调度器必须在 finally 里 finishAttempt，否则运行时
    // 进程一崩，这个工作项就永远开不了下一次尝试。把这种卡死报成看得懂的话，
    // 而不是一句泛泛的不变量冲突。
    const stuck = item.attempts.find((a) => a.status === 'in_progress');
    if (stuck) {
      throw new PlatformRuleError(
        'ATTEMPT_STILL_RUNNING',
        `工作项 ${workItemId} 上的 attempt ${stuck.id} 还是 in_progress：` +
          '上一次尝试没有被收尾。先 finishAttempt 再开新的。',
      );
    }
    const attempt = item.startAttempt();
    if (profile) attempt.recordProfile(profile);
    await this.#event(
      mission,
      'attempt.started',
      { kind: 'executor', profile },
      workItemId,
      attempt.id,
    );
    return { attemptId: attempt.id };
  }

  /**
   * 结束一次尝试。
   *
   * `no_structured_result` 与 `upstream_failure` 都记为失败，但**分别记原因**：
   * 上游失败允许换候选重试，"跑完却没提交"不允许——换一个再赌一次只会
   * 烧配额，不产生新信息。调度器据此分流。
   */
  async finishAttempt(
    missionId: string,
    attemptId: string,
    outcome: {
      endedBy: AttemptEndReason;
      usage?: TokenUsage;
      failureMessage?: string;
      /** 运行时留下的续跑句柄。落库才能跨进程续上。 */
      resumeRef?: string;
      /** 这一跳的原始输出（尾部）。Timeline 第三层用。 */
      output?: string;
      /** 这一跳调过的工具名序列。Timeline 第二层用。 */
      toolCalls?: readonly string[];
      /** 运行时实际解析到的身份（S13.3）。 */
      resolvedProfile?: {
        readonly revision: string;
        readonly resolved: readonly { readonly key: string; readonly value: string }[];
      };
    },
  ): Promise<void> {
    const { mission } = await this.#locate(missionId);
    const attempt = mission.attempt(attemptId);
    if (!attempt) {
      throw new PlatformRuleError('UNKNOWN_ATTEMPT', `attempt ${attemptId} 不存在`);
    }
    if (outcome.usage) attempt.recordUsage(outcome.usage);
    if (outcome.resumeRef) attempt.recordResumeRef(outcome.resumeRef);
    // 把运行时报回来的实际身份并进开跑时记的那份（S13.3）。
    // 开跑时只知道 profileId —— 它指向什么，只有跑完了适配层才说得出来。
    if (outcome.resolvedProfile && attempt.profile) {
      attempt.recordProfile({
        ...attempt.profile,
        revision: outcome.resolvedProfile.revision,
        resolved: outcome.resolvedProfile.resolved,
      });
    }
    if (outcome.output) {
      // 大输出外置：状态是一次整份写出去的，把几十万字符塞进去会让
      // **每一次工具调用**都变慢。
      const blob = this.#artifacts.put(outcome.output);
      attempt.appendOutput(blob.inline ?? `${blob.preview ?? ''}
…（共 ${blob.bytes} 字节，完整内容见 artifact:${blob.ref}）`);
      if (blob.ref) attempt.recordOutputRef(blob.ref);
    }
    for (const name of outcome.toolCalls ?? []) {
      attempt.recordToolCall(name, new Date().toISOString());
    }
    attempt.recordEndReason(outcome.endedBy);
    if (attempt.status === 'in_progress') {
      if (outcome.endedBy === 'structured_submit') attempt.succeed();
      else attempt.fail(outcome.failureMessage ?? outcome.endedBy);
    }
    await this.#event(
      mission,
      'attempt.ended',
      {
        endedBy: outcome.endedBy,
        failureMessage: outcome.failureMessage,
        usage: attempt.usage,
        retriable: outcome.endedBy === 'upstream_failure',
      },
      attempt.workItemId,
      attemptId,
    );
  }

  /**
   * 给一次在途尝试续租。
   *
   * 调度器按固定间隔打。心跳落到状态里，别的进程才看得见"这条还有人在跑"——
   * 没有它，启动收敛只能靠"我刚起来"来猜，而那个前提在多进程下是错的。
   *
   * 找不到 attempt 或它已经收过尾就静默返回：心跳是尽力而为的旁路信号，
   * 不该让一次收尾竞态把整跳搞失败。
   */
  async beatAttempt(missionId: string, attemptId: string, owner?: string): Promise<void> {
    const { mission, project } = await this.#locate(missionId);
    const attempt = mission.attempt(attemptId);
    if (!attempt || attempt.status !== 'in_progress') return;
    attempt.beat(this.#clock.now().toISOString(), owner);
    // **必须落盘。** 心跳的全部作用就是让*别的进程*看见它；只改内存对象的话，
    // 别的进程读到的仍然是"从没心跳过"，于是照样把它判死。
    await this.#projects.save(project);
  }

  /**
   * L3 作废一个工作项（S14.6 里的 cancel-replace）。
   *
   * 场景：契约改了，协调者照新契约另拆了一批工单，旧的那些还挂在 dispatched 上。
   * 不作废的话调度器会把它们也跑一遍——做的是明确不要的那件事，还要花一次
   * 执行者的钱。实测撞到过。
   *
   * 复用 blocked 而不是新造状态：它的含义本来就是"这张工单不成立，需要有人
   * 处理"，与这里完全吻合。**不为每种原因新造互斥状态**是 S06.1 的要求，
   * 区分靠 blocked 记录里写的是谁作废的。
   */
  async retireWorkItem(
    missionId: string,
    workItemId: string,
    reason: string,
  ): Promise<{ status: string }> {
    const { mission, item } = await this.#locateItem(missionId, workItemId);
    // 挡两种：已经作废过的，和**已经验收过的**。
    //
    // accepted 不让作废是刻意的：那件事做过、也被验收过了，作废等于抹掉这段
    // 记录（"想反悔"不是作废的理由）。契约改了让它变得多余的话，诚实的说法
    // 是"它在旧契约下被验收过"。
    //
    // 但 blocked 与 rejected **必须**能作废。早先这两个也被挡着，理由写的是
    // "不需要作废"——那句话是错的：它们都会拦着 Mission 交卷。实测 W5 撞上过，
    // 被打回又被新工单取代的那张既不能再验收（没有新结果）也不能作废，卡死。
    if (item.status === 'retired' || item.status === 'accepted') {
      throw new PlatformRuleError(
        'NOT_RETIRABLE',
        item.status === 'retired'
          ? `工作项 ${workItemId} 已经作废过了。`
          : `工作项 ${workItemId} 已经验收通过，不能作废——那是在改历史。`,
      );
    }
    // 走 retire 而不是 recordBlocked：blocked 的含义是"这张工单不成立、
    // 需要有人去改"，会拦住交卷；retired 的含义是"不用做了"，不该拦。
    item.retire(reason);
    await this.#event(mission, 'work_item.retired', { reason }, workItemId);
    return { status: item.status };
  }

  /**
   * 记下 Mission 为什么停着（S06.1 的第二条轴）。
   *
   * 同样是 executing，"正在跑"和"候选全在冷却"是两回事；界面上分不出来，
   * 人就只能去翻日志。清掉传 undefined。
   */
  async setWaitReason(
    missionId: string,
    reason: WaitReason | undefined,
    detail?: string,
  ): Promise<void> {
    const { mission } = await this.#locate(missionId);
    // detail 变了也要写：同一个 no_available_agent，"卡在 exec-a" 和
    // "卡在 exec-d" 对排障的人是两条不同的信息。
    if (mission.waitReason === reason && mission.waitDetail === detail) return;
    mission.setWaitReason(reason, detail);
    await this.#event(mission, reason ? 'mission.waiting' : 'mission.resumed', {
      reason,
      detail,
    });
  }

  /* =========================== 取消 / 暂停 =========================== */

  /**
   * 叫停一条 Mission（S12.2 / S14.5）。
   *
   * v1 只做"停止后续调度"：在途的 attempt 由调度器的 finally 正常收尾。
   * **不处理取消与 failover 之间那个微秒级的竞态**——那需要 fencing token，
   * 文档已经明确推迟。真撞上了的后果是多跑完一跳，不会破坏状态。
   */
  async cancelMission(missionId: string, reason?: string): Promise<{ status: string }> {
    const { mission } = await this.#locate(missionId);
    mission.cancel();
    await this.#event(mission, 'mission.cancelled', { reason });
    await this.#releaseWorkspace(missionId, mission.workspaceRef?.projectRoot);
    return { status: mission.status };
  }

  /** 暂停：调度器不再碰它，但阶段保持原样。 */
  async pauseMission(missionId: string): Promise<{ paused: boolean }> {
    const { mission } = await this.#locate(missionId);
    mission.pause();
    await this.#event(mission, 'mission.paused', {});
    return { paused: mission.isPaused };
  }

  async resumeMission(missionId: string): Promise<{ paused: boolean }> {
    const { mission } = await this.#locate(missionId);
    mission.resume();
    await this.#event(mission, 'mission.resumed_from_pause', {});
    return { paused: mission.isPaused };
  }

  /**
   * 项目长期知识（S09.2 的 coagent_get_project_context）。
   *
   * 给协调者看的是**架构约束 + Capability 索引**，不是把所有 Spec 全文
   * 倒给它。S10.4：只传最小充分上下文；需要哪份再按 slug 取。
   */
  async getProjectContext(missionId: string, slug?: string) {
    const { mission } = await this.#locate(missionId);
    const root = mission.workspaceRef?.projectRoot;
    if (!root) {
      return { available: false, note: '这条 Mission 还没有工作区，读不到项目记忆。' };
    }
    const memory = readProjectMemory(root, mission.projectId);
    if (!memory.exists) {
      return {
        available: false,
        note: `${root} 里还没有 .coagent/ —— 这个项目没有长期记忆可读。`,
      };
    }
    if (slug) {
      const doc =
        memory.specs.find((s) => s.slug === slug) ??
        memory.decisions.find((d) => d.slug === slug);
      return doc
        ? { available: true, slug, title: doc.title, body: doc.body }
        : {
            available: false,
            note: `没有 ${slug}。现有的：${[...memory.specs, ...memory.decisions].map((d) => d.slug).join(', ') || '（空）'}`,
          };
    }
    return {
      available: true,
      projectName: memory.projectName,
      projectProfile: memory.projectProfile,
      // 只给索引，正文按需取——把所有 Spec 全文塞进每一轮对话是纯浪费。
      specs: memory.specs.map((s) => ({ slug: s.slug, title: s.title })),
      decisions: memory.decisions.map((d) => ({ slug: d.slug, title: d.title })),
    };
  }

  /* ============================== 读模型 ============================== */

  /** 项目清单（S12.2 的 getProjects）。 */
  async listProjects() {
    const rows = [];
    for (const project of await this.#projects.list()) {
      rows.push({
        projectId: project.id,
        missions: project.missions.length,
        // 谁占着改动名额——一眼看出这个项目现在能不能派新活。
        mutating: project.missions.find((m) => m.isMutating)?.id,
        // 项目级用量（S11.5）。花了多少钱是项目层面的问题，
        // 要人挨个 Mission 点进去自己加，等于没提供。
        usage: combine(
          project.missions.flatMap((m) => [
            ...m.coordinatorAttempts,
            ...m.workItems.flatMap((w) => w.attempts),
          ]).map((a) => a.usage),
        ),
      });
    }
    return rows;
  }

  /**
   * 用量聚合（S11.5）。
   *
   * 四个维度：Project / Mission / Role / 运行时身份。最后一个是按 attempt 上
   * 冻结的**事实键**分组的——适配层填的是 provider / model，所以"按 Provider
   * 聚合""按 Model 聚合"都落在这里，而这一层不用认识这两个词，接第二个
   * agent 时也不用改。
   *
   * 只统计**冻结过身份**的 attempt：没冻的（老数据、或运行时没报）归进
   * `unattributed`，而不是摊到某个身份上——摊给谁都是编的。
   */
  async getUsage(filter?: { projectId?: string; missionId?: string }): Promise<UsageReport> {
    const byProject = new Map<string, TokenUsage[]>();
    const byMission = new Map<string, TokenUsage[]>();
    const byRole = new Map<string, TokenUsage[]>();
    // 键值对不能拼成一个字符串再切回来——模型名里出现分隔符就散架了。
    const byFact = new Map<string, { key: string; value: string; list: TokenUsage[] }>();
    const all: TokenUsage[] = [];
    let unattributed = 0;

    for (const project of await this.#projects.list()) {
      if (filter?.projectId && project.id !== filter.projectId) continue;
      for (const mission of project.missions) {
        if (filter?.missionId && mission.id !== filter.missionId) continue;
        const attempts: Attempt[] = [
          ...mission.coordinatorAttempts,
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

  /** 所有 Mission 的概览，给列表页用。 */
  async listMissions(): Promise<MissionSummary[]> {
    const rows: MissionSummary[] = [];
    for (const project of await this.#projects.list()) {
      for (const mission of project.missions) {
        rows.push({
          missionId: mission.id,
          projectId: mission.projectId,
          status: mission.status,
          waitReason: mission.waitReason,
          waitDetail: mission.waitDetail,
          updatedAt: mission.updatedAt,
          paused: mission.isPaused,
          isMutating: mission.isMutating,
          intent: mission.contract?.intent ?? '',
          workItems: mission.workItems.length,
          accepted: mission.workItems.filter((item) => item.status === 'accepted').length,
          openEscalations: mission.openEscalations.length,
          usage: sumUsage(mission),
        });
      }
    }
    return rows;
  }

  /**
   * 单次 Attempt 的明细：证据 + 原始输出（Timeline 第三层，S11.3）。
   *
   * 单独一个口而不是塞进 MissionView：输出可以很长，列表页不该为了显示
   * 一行状态就把它全拉过来。
   */
  async getAttemptDetail(missionId: string, attemptId: string) {
    const { mission } = await this.#locate(missionId);
    const attempt = mission.attempt(attemptId);
    if (!attempt) {
      throw new PlatformRuleError('UNKNOWN_ATTEMPT', `attempt ${attemptId} 不存在`);
    }
    return {
      attemptId: attempt.id,
      kind: attempt.kind,
      workItemId: attempt.workItemId,
      status: attempt.status,
      endedBy: attempt.endedBy,
      failReason: attempt.failReason,
      usage: attempt.usage,
      profile: attempt.profile,
      evidence: attempt.evidence,
      // 外置的取回来给人看——界面不该要求人再手动拼一次路径。
      output: attempt.outputRef
        ? (this.#artifacts.get(attempt.outputRef) ?? attempt.output)
        : attempt.output,
      outputRef: attempt.outputRef,
      toolActivity: attempt.toolActivity,
    };
  }

  /** Mission 的事件流，给 Timeline 用。 */
  async getActivity(missionId: string) {
    // 不存在就报错，别返回空数组糊弄——空 Timeline 和不存在的 Mission
    // 在界面上长得一模一样。
    await this.#locate(missionId);
    return this.#activity.list(missionId);
  }

  /* ============================ L2 协调者面 ============================ */

  async getMissionView(missionId: string): Promise<MissionView> {
    const { mission, project } = await this.#locate(missionId);
    // 谁挡着我。要 Project 才算得出来，所以在这一层补，不放进 viewOf。
    const holder = project.missions.find((m) => m.id !== mission.id && m.isMutating);
    return { ...viewOf(mission), blockedByMission: holder?.id };
  }

  /**
   * 开跑简报（S09.1 [MUST]）。
   *
   * 文档要求托管 agent **启动时直接获得** Role / Project / Contract 或 Work Order /
   * cwd / Project Rules / ContextRefs / 工具表 / ExecutionProfile。先前只有
   * 角色 prompt 是启动就给的，其余全靠 agent 自己调工具取——代价是实的：
   *
   *   - 每一跳都白花一轮工具调用去取本来就该给它的东西；
   *   - **执行者可能从头到尾没见过架构红线**。它的工具表里没有
   *     coagent_get_project_context，红线只有在协调者把它抄进工单时才到得了它手上，
   *     而红线是"项目不可协商的东西"。
   *
   * 按角色给不同的东西：协调者要契约与规划，执行者要工单。两边都要红线。
   */
  async getStartupBrief(
    missionId: string,
    attemptId: string,
  ): Promise<{
    role: AttemptKind;
    projectId: string;
    missionId: string;
    status: string;
    /** 架构红线。两个角色都要——它是项目层面不可协商的东西。 */
    projectRules?: string;
    /**
     * 这台机器上会咬人的地方。**平台知道自己跑在什么系统上，agent 不知道。**
     *
     * 实测 P1：协调者写探针用了 `cat > /tmp/probe.mjs`，没成，接着 `pwd && ls`
     * 自己诊断、改用工作区相对路径——处理得很好，但那一个来回是白花的。
     * Windows 上 Git Bash 的 `/tmp` 和 Node 的 `/tmp` 不是同一个目录。
     *
     * 只说**会静默出错**的那几条。环境里的常识不用讲，讲多了就没人读了。
     */
    environmentNotes?: readonly string[];
    contract?: Readonly<MissionContract>;
    contractRevision?: number;
    plan?: Readonly<PlanBody>;
    planRevision?: number;
    workItem?: { id: string; title: string; order?: Readonly<WorkOrder> };
    /** L3 打回的理由。被打回之后重跑时，这是最该先看到的东西。 */
    finalReview?: Readonly<FinalReview>;
  }> {
    const { mission } = await this.#locate(missionId);
    const attempt = mission.attempt(attemptId);
    if (!attempt) {
      throw new PlatformRuleError('UNKNOWN_ATTEMPT', `attempt ${attemptId} 不存在`);
    }

    // 红线从项目记忆里读。读不到就是没有，不是错误——不是每个项目都写了。
    let projectRules: string | undefined;
    const root = mission.workspaceRef?.projectRoot;
    if (root) {
      try {
        projectRules = readProjectMemory(root, mission.projectId).projectProfile;
      } catch {
        projectRules = undefined;
      }
    }

    const base = {
      role: attempt.kind,
      projectId: mission.projectId,
      missionId: mission.id,
      status: mission.status,
      projectRules,
      environmentNotes: environmentNotes(),
    };

    if (attempt.kind === 'executor') {
      const item = attempt.workItemId ? mission.workItem(attempt.workItemId) : undefined;
      // 执行者只给工单，不给契约——它不能重新定义目标，给了只会诱导它去改。
      return {
        ...base,
        workItem: item
          ? { id: item.id, title: item.title, order: item.order }
          : undefined,
      };
    }

    return {
      ...base,
      contract: mission.contract,
      contractRevision: mission.contractRevision,
      plan: mission.plan,
      planRevision: mission.planRevision,
      finalReview: mission.finalReview,
    };
  }

  /**
   * 只读契约（S09.2 的 coagent_get_contract）。
   *
   * 和 getMissionView 分开的理由是**成本**：调查阶段协调者要反复回看验收标准
   * 和红线，而整个 MissionView 带着全部工作项、尝试、时间线——每看一眼红线
   * 就得连着几千 token 一起读进去。契约本身只有几行。
   */
  async getContract(missionId: string): Promise<{
    contract: Readonly<MissionContract> | undefined;
    contractRevision: number;
  }> {
    const { mission } = await this.#locate(missionId);
    return { contract: mission.contract, contractRevision: mission.contractRevision };
  }

  /**
   * 只更新调查发现（S09.2 的 coagent_update_findings）。
   *
   * 落到同一份 Plan 上，但**不要求协调者把整份规划重写一遍**：调查途中它
   * 往往只是多知道了一件事，方向和决策都还没定。逼它连带重填 direction /
   * decisions，要么它编一个，要么它干脆不记——两种都比没有这个口更糟。
   */
  async updateFindings(
    missionId: string,
    attemptId: string,
    findings: string,
    rejectedHypotheses?: readonly string[],
  ): Promise<{ planRevision: number }> {
    const { mission } = await this.#requireAttempt(missionId, attemptId, 'coordinator');
    const previous = mission.plan;
    const planRevision = mission.updatePlan({
      findings,
      // 其余字段沿用上一版：这个口的语义是"只补发现"，不是"把没填的清空"。
      rejectedHypotheses: [...(rejectedHypotheses ?? previous?.rejectedHypotheses ?? [])],
      decisions: [...(previous?.decisions ?? [])],
      direction: previous?.direction ?? '',
      risks: [...(previous?.risks ?? [])],
    });
    await this.#event(
      mission,
      'plan.updated',
      { planRevision, findingsOnly: true },
      undefined,
      attemptId,
    );
    return { planRevision };
  }

  async updatePlan(
    missionId: string,
    attemptId: string,
    plan: PlanBody,
  ): Promise<{ planRevision: number }> {
    const { mission } = await this.#requireAttempt(missionId, attemptId, 'coordinator');
    const planRevision = mission.updatePlan(plan);
    await this.#event(mission, 'plan.updated', { planRevision }, undefined, attemptId);
    return { planRevision };
  }

  /**
   * 创建工作项。**没有 Plan 就拒绝** —— 会话可能被压缩或换人接手，
   * 只有写回平台的结论才是权威。这条用工具层强制，不靠提示。
   */
  async createWorkItem(
    missionId: string,
    attemptId: string,
    input: { title: string; order: WorkOrder; workItemId?: string },
  ): Promise<{ workItemId: string }> {
    const { mission } = await this.#requireAttempt(missionId, attemptId, 'coordinator');
    if (mission.planRevision === 0) {
      throw new PlatformRuleError(
        'PLAN_REQUIRED',
        '还没有 Plan：先把调查结论写回平台（update_plan），再创建工作项。',
      );
    }
    const workItemId = input.workItemId ?? this.#ids.next('W');
    mission.createWorkItem({ id: workItemId, title: input.title, order: input.order });
    await this.#event(mission, 'work_item.created', { title: input.title }, workItemId, attemptId);
    return { workItemId };
  }

  /**
   * Lightweight 进程内：无 Coordinator/Plan 创建恰好一个 frozen WorkItem。
   * 不 startExecuting、不占 mutation slot、不建 Plan/Coordinator Attempt。
   * 仅供进程内 Orchestrator 调用；不进 HTTP/tools。
   * order.validation 可缺省/commands 可空（表示只跑 changed-paths）；规范化交给 WorkItem 构造器。
   */
  async createLightweightWorkItem(
    missionId: string,
    input: { readonly order: WorkOrder; readonly title?: string; readonly workItemId?: string },
  ): Promise<{ workItemId: string }> {
    const { mission } = await this.#locate(missionId);
    this.#requireLightweightMutationLane(mission);

    if (mission.status !== 'investigating' && mission.status !== 'planning') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_BAD_STATUS',
        `Lightweight create 要求 mission.status=investigating|planning，当前是 ${mission.status}。`,
      );
    }
    if (mission.coordinatorAttempts.length !== 0) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_COORDINATOR_FORBIDDEN',
        'Lightweight create 要求 coordinatorAttempts 为空（零 Coordinator）。',
      );
    }
    if (mission.workItems.length !== 0) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_SINGLE_WORK_ITEM',
        'Lightweight Mission 恰好只能有一个 WorkItem；已有 WorkItem，拒绝再建。',
      );
    }

    const title = input.title ?? input.order.objective;
    const workItemId = input.workItemId ?? this.#ids.next('W');
    // WorkItem 构造器 strict normalize/freeze validation；create 不另验 commands 非空。
    mission.createWorkItem({ id: workItemId, title, order: input.order });
    await this.#event(
      mission,
      'work_item.created',
      { title, executionMode: 'lightweight' },
      workItemId,
      // attemptId 留空：无 Coordinator reviewer。
    );
    return { workItemId };
  }

  /**
   * Lightweight 进程内：占用 Project mutation slot 并 dispatch 唯一 WorkItem。
   * 复用 Standard 的 slot 规则；slot 后、dispatch 前 observational PRE_DISPATCH shadow
   *（无 attemptId，失败不阻断）。
   */
  async dispatchLightweightWorkItem(
    missionId: string,
    workItemId: string,
  ): Promise<{ dispatched: string }> {
    const { mission, project } = await this.#locate(missionId);
    this.#requireLightweightMutationLane(mission);

    if (mission.coordinatorAttempts.length !== 0) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_COORDINATOR_FORBIDDEN',
        'Lightweight dispatch 要求 coordinatorAttempts 仍为空。',
      );
    }

    const item = mission.workItem(workItemId);
    if (!item) {
      throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${workItemId} 不存在`);
    }
    if (mission.workItems.length !== 1 || mission.workItems[0]?.id !== workItemId) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_SINGLE_WORK_ITEM',
        'Lightweight dispatch 要求该 WorkItem 是 mission 唯一 WorkItem。',
      );
    }
    if (item.status !== 'created') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_NOT_DISPATCHABLE',
        `工作项 ${workItemId} 当前是 ${item.status}，Lightweight 只能从 created 派发。`,
      );
    }

    // 与 Standard 相同顺序：mutation-slot → shadow → item.dispatch。
    await this.#acquireMutationSlotForDispatch(mission, project);

    // PRE_DISPATCH shadow：observational；provider/activity 失败不阻断 dispatch。
    // attemptId 省略——绝不伪造 Coordinator attempt。
    if (this.#decisionProvider) {
      await runDecisionShadow({
        provider: this.#decisionProvider,
        activity: this.#activity,
        clock: this.#clock,
        stateInput: {
          hook: 'PRE_DISPATCH',
          projectId: mission.projectId,
          missionId: mission.id,
          workItemId,
        },
        workItemIds: [workItemId],
      });
    }

    item.dispatch();
    await this.#event(
      mission,
      'work_item.dispatched',
      { ids: [workItemId], executionMode: 'lightweight' },
      workItemId,
      // attemptId 留空
    );
    return { dispatched: workItemId };
  }

  /**
   * Lightweight 进程内：对 submitted WorkItem 跑注入的 validation.engine，
   * **先持久化 ValidationReport**，通过且 authority/linkage 一致后再 accept。
   * cwd 由 trusted WorkspaceManager.prepare() 注入；调用方不得传 report/authority/linkage。
   * order 必须存在；commands 缺省视为 []（仍跑 changed-paths）。
   */
  async validateAndAcceptLightweightWorkItem(input: {
    readonly missionId: string;
    readonly workItemId: string;
    readonly cwd: string;
  }): Promise<{ reportId: string; passed: boolean; status: string }> {
    const { mission, item } = await this.#locateItem(input.missionId, input.workItemId);
    this.#requireLightweightMutationLane(mission);

    if (!this.#validation) {
      throw new PlatformRuleError(
        'VALIDATION_DEPS_REQUIRED',
        'Lightweight 验收需要注入 PlatformDeps.validation（engine + reports）。',
      );
    }

    if (item.status !== 'submitted') {
      throw new PlatformRuleError(
        'VALIDATION_NOT_SUBMITTED',
        `工作项 ${item.id} 当前是 ${item.status}，只能对 submitted 做机器验收。`,
      );
    }

    const submittedAttemptId = item.submittedAttemptId;
    if (!submittedAttemptId) {
      throw new PlatformRuleError(
        'VALIDATION_SUBMITTED_ATTEMPT_REQUIRED',
        `工作项 ${item.id} 缺少 submittedAttemptId，拒绝机器验收。`,
      );
    }

    const order = item.order;
    if (!order) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_ORDER_REQUIRED',
        `工作项 ${item.id} 缺少 order，不跑 engine。`,
      );
    }
    // empty / absent validation.commands 合法：只跑 changed-paths。
    const commands = order.validation?.commands ?? [];
    // VAL-002：forbiddenPaths / diffSize 仅从 frozen order 拷贝；缺省 = 不在 force。
    // 不得从 ExecutionBudget / promotion / prose 填默认值。
    const forbiddenPaths = order.validation?.forbiddenPaths;
    const diffSize = order.validation?.diffSize;

    const projectRoot = mission.workspaceRef?.projectRoot;
    const baseRevision = mission.workspaceRef?.baseRevision;
    if (!projectRoot || !baseRevision) {
      throw new PlatformRuleError(
        'VALIDATION_WORKSPACE_REQUIRED',
        `Mission ${mission.id} 缺少 workspaceRef.projectRoot/baseRevision，不跑 engine。`,
      );
    }

    if (typeof input.cwd !== 'string' || input.cwd.trim().length === 0) {
      throw new PlatformRuleError(
        'VALIDATION_CWD_REQUIRED',
        'Lightweight 验收要求非空 cwd（trusted WorkspaceManager.prepare().cwd）。',
      );
    }
    const trustedCwd = input.cwd.trim();

    // ValidationInput 只能由 Platform 绑定；每个 command 的 cwd 强制覆盖成 trusted cwd。
    const result = await this.#validation.engine.validate({
      missionId: mission.id,
      workItemId: item.id,
      attemptId: submittedAttemptId,
      projectRoot,
      baseRevision,
      allowedScope: [...order.allowedScope],
      commands: commands.map((c) => ({
        argv: [...c.argv],
        timeoutMs: c.timeoutMs,
        cwd: trustedCwd,
      })),
      ...(forbiddenPaths !== undefined ? { forbiddenPaths: [...forbiddenPaths] } : {}),
      ...(diffSize !== undefined
        ? {
            diffSize: {
              ...(diffSize.maxChangedFiles !== undefined
                ? { maxChangedFiles: diffSize.maxChangedFiles }
                : {}),
              ...(diffSize.maxChangedLines !== undefined
                ? { maxChangedLines: diffSize.maxChangedLines }
                : {}),
            },
          }
        : {}),
    });

    // append-only：必须先于任何 review / accept。
    await this.#validation.reports.save(result.report);

    await this.#event(
      mission,
      'validation.reported',
      {
        reportId: result.report.id,
        passed: result.report.passed,
        submittedAttemptId,
      },
      item.id,
      // ActivityEvent.attemptId 不要冒充 reviewer
    );

    if (result.report.passed === false) {
      // failed report 已保存；不 accept / reject，item 保持 submitted。
      return { reportId: result.report.id, passed: false, status: item.status };
    }

    const authority = result.authority;
    const report = result.report;
    const mismatch =
      !authority ||
      authority.kind !== 'validator' ||
      authority.reportId !== report.id ||
      authority.policyRevision !== report.policyRevision ||
      report.missionId !== mission.id ||
      report.workItemId !== item.id ||
      report.attemptId !== submittedAttemptId;

    if (mismatch) {
      // 报告保留，item 仍 submitted。
      throw new PlatformRuleError(
        'VALIDATION_AUTHORITY_MISMATCH',
        `ValidationReport ${report.id} 通过，但 authority/linkage 与 WorkItem 不一致，拒绝 accept。`,
      );
    }

    item.review('accept', {
      submittedAttemptId,
      authority,
      reasons: [`ValidationReport ${report.id} passed`],
      requiredChanges: [],
    });

    await this.#event(
      mission,
      'review.recorded',
      {
        verdict: 'accept',
        authority: 'validator',
        reportId: report.id,
        reasons: [`ValidationReport ${report.id} passed`],
      },
      item.id,
      // ActivityEvent.attemptId 留空
    );

    return { reportId: report.id, passed: true, status: item.status };
  }

  /**
   * Lightweight 进程内：唯一 accepted WorkItem + durable validator report
   * 通过后，derive MissionResult 并 submitForReview（不 complete）。
   * 仅供进程内 Orchestrator；不绑 HTTP/tools。
   */
  async submitLightweightMissionForReview(
    missionId: string,
  ): Promise<{ status: 'awaiting_review'; reportId: string }> {
    const { mission } = await this.#locate(missionId);
    // Guard 顺序：先校验后 mutation。
    this.#requireLightweightMutationLane(mission);

    if (mission.coordinatorAttempts.length !== 0) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_COORDINATOR_FORBIDDEN',
        'Lightweight submit-for-review 要求 coordinatorAttempts 为空。',
      );
    }
    if (mission.status !== 'executing') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_BAD_STATUS',
        `Lightweight submit-for-review 要求 mission.status=executing，当前是 ${mission.status}。`,
      );
    }
    if (mission.workItems.length !== 1) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_SINGLE_WORK_ITEM',
        `Lightweight submit-for-review 要求恰好一个 WorkItem，当前 ${mission.workItems.length} 个。`,
      );
    }

    const item = mission.workItems[0]!;
    if (item.status !== 'accepted') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_NOT_ACCEPTED',
        `工作项 ${item.id} 当前是 ${item.status}，需要 accepted 才能交卷。`,
      );
    }

    const executionResult = item.executionResult;
    if (!executionResult || executionResult.outcome !== 'completed') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_EXECUTION_NOT_COMPLETED',
        `工作项 ${item.id} 缺少 outcome=completed 的 executionResult。`,
      );
    }

    const submittedAttemptId = item.submittedAttemptId;
    if (!submittedAttemptId || submittedAttemptId.trim().length === 0) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_SUBMITTED_ATTEMPT_REQUIRED',
        `工作项 ${item.id} 缺少 submittedAttemptId。`,
      );
    }

    const lastReview = item.reviews.at(-1);
    if (!lastReview) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_REVIEW_REQUIRED',
        `工作项 ${item.id} 没有 review 记录。`,
      );
    }
    if (lastReview.authority?.kind !== 'validator') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_VALIDATOR_AUTHORITY_REQUIRED',
        `工作项 ${item.id} last review 不是 validator authority。`,
      );
    }
    if (lastReview.submittedAttemptId !== submittedAttemptId) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_SUBMITTED_ATTEMPT_MISMATCH',
        `review.submittedAttemptId 与 item.submittedAttemptId 不一致。`,
      );
    }

    if (!this.#validation) {
      throw new PlatformRuleError(
        'VALIDATION_DEPS_REQUIRED',
        'Lightweight submit-for-review 需要注入 PlatformDeps.validation（engine + reports）。',
      );
    }

    const authority = lastReview.authority;
    // 重新读 durable report；不信任内存里的 authority  alone。
    const report = await this.#validation.reports.get(authority.reportId);
    if (!report) {
      throw new PlatformRuleError(
        'VALIDATION_REPORT_MISSING',
        `ValidationReport ${authority.reportId} 不存在，拒绝交卷。`,
      );
    }
    if (report.passed !== true) {
      throw new PlatformRuleError(
        'VALIDATION_REPORT_NOT_PASSED',
        `ValidationReport ${report.id} passed=false，拒绝交卷。`,
      );
    }
    if (report.policyRevision !== authority.policyRevision) {
      throw new PlatformRuleError(
        'VALIDATION_POLICY_MISMATCH',
        `ValidationReport ${report.id} policyRevision 与 authority 不一致。`,
      );
    }
    if (
      report.missionId !== mission.id ||
      report.workItemId !== item.id ||
      report.attemptId !== submittedAttemptId
    ) {
      throw new PlatformRuleError(
        'VALIDATION_LINKAGE_MISMATCH',
        `ValidationReport ${report.id} mission/workItem/attempt 与当前对象不一致。`,
      );
    }

    // Platform 内部 derive；不解析 notes，不接受 caller body。
    const body: MissionResultBody = {
      outcome: 'delivered',
      summary: executionResult.summary,
      acceptanceEvidence: [`validation-report:${report.id}`],
      memoryDelta: [],
      openRisks: [],
    };

    mission.recordResult(body);
    mission.submitForReview();

    await this.#event(
      mission,
      'mission_result.submitted',
      {
        outcome: 'delivered',
        missionStatus: 'awaiting_review',
        executionMode: 'lightweight',
        reportId: report.id,
      },
      // ActivityEvent.attemptId 省略：无 Coordinator
    );

    const delivery = await this.#deliveries.create({
      missionId: mission.id,
      projectId: mission.projectId,
      recipient: mission.origin?.conversationRef ?? mission.origin?.clientType ?? 'unknown',
      outcome: 'delivered',
      summary: body.summary,
    });
    await this.#event(
      mission,
      'delivery.created',
      { deliveryId: delivery.id },
      // 无 fake attemptId
    );

    return { status: 'awaiting_review', reportId: report.id };
  }

  async dispatchWorkItems(
    missionId: string,
    attemptId: string,
    workItemIds: readonly string[],
  ): Promise<{ dispatched: readonly string[] }> {
    const { mission, project } = await this.#requireAttempt(missionId, attemptId, 'coordinator');
    if (workItemIds.length === 0) {
      throw new PlatformRuleError('EMPTY_DISPATCH', '没有指定任何工作项。');
    }
    const items = workItemIds.map((id) => {
      const item = mission.workItem(id);
      if (!item) throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${id} 不存在`);
      return item;
    });
    // 先全部校验再统一改状态：被拒绝的调用不留下半套流转。
    for (const item of items) {
      const dispatchable = ['created', 'rejected', 'blocked', 'accepted'];
      if (!dispatchable.includes(item.status)) {
        throw new PlatformRuleError(
          'NOT_DISPATCHABLE',
          `工作项 ${item.id} 当前是 ${item.status}，不能派发`,
        );
      }
    }
    // Standard 调用顺序保持原样：先 startExecuting/处理 PROJECT_BUSY，
    // 再 PRE_DISPATCH shadow，再 item.dispatch。
    await this.#acquireMutationSlotForDispatch(mission, project);

    // PRE_DISPATCH shadow：确认硬规则全部通过之后、真实 dispatch 之前。
    // 信号 / provider 失败 / shadow append 失败都不改变后续 item.dispatch。
    if (this.#decisionProvider) {
      const soleWorkItemId = workItemIds.length === 1 ? workItemIds[0] : undefined;
      await runDecisionShadow({
        provider: this.#decisionProvider,
        activity: this.#activity,
        clock: this.#clock,
        stateInput: {
          hook: 'PRE_DISPATCH',
          projectId: mission.projectId,
          missionId: mission.id,
          attemptId,
          ...(soleWorkItemId !== undefined ? { workItemId: soleWorkItemId } : {}),
        },
        workItemIds: [...workItemIds],
      });
    }

    for (const item of items) item.dispatch();
    await this.#event(mission, 'work_item.dispatched', { ids: [...workItemIds] }, undefined, attemptId);
    return { dispatched: [...workItemIds] };
  }

  async reviewExecutionResult(
    missionId: string,
    attemptId: string,
    input: {
      workItemId: string;
      verdict: 'accept' | 'reject';
      reasons: readonly string[];
      requiredChanges: readonly string[];
    },
  ): Promise<{ status: string }> {
    const { mission } = await this.#requireAttempt(missionId, attemptId, 'coordinator');
    const item = mission.workItem(input.workItemId);
    if (!item) {
      throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${input.workItemId} 不存在`);
    }
    if (!item.hasResult) {
      throw new PlatformRuleError(
        'NO_RESULT',
        `${input.workItemId} 还没有执行结果，无法验收。`,
      );
    }
    // 打回却说不出要改什么，下一张工单就会和上一张逐字相同。
    if (input.verdict === 'reject' && input.requiredChanges.length === 0) {
      throw new PlatformRuleError(
        'REJECT_NEEDS_CHANGES',
        'reject 必须给出 requiredChanges，否则重发的工单与上一次没有可见差异。',
      );
    }
    const record: Omit<ReviewRecord, 'verdict'> = {
      attemptId,
      reasons: [...input.reasons],
      requiredChanges: [...input.requiredChanges],
    };
    item.review(input.verdict, record);
    await this.#event(
      mission,
      'review.recorded',
      { verdict: input.verdict, reasons: record.reasons },
      input.workItemId,
      attemptId,
    );
    return { status: item.status };
  }

  async escalateToL3(
    missionId: string,
    attemptId: string,
    body: Omit<EscalationBody, 'attemptId'>,
  ): Promise<void> {
    const { mission } = await this.#requireAttempt(missionId, attemptId, 'coordinator');
    mission.recordEscalation({ ...body, attemptId });
    await this.#event(mission, 'escalated', { question: body.question }, undefined, attemptId);
    // 升级只写进平台是不够的：L3 不盯着数据库看。进收件箱才叫升级。
    const delivery = await this.#deliveries.create({
      missionId: mission.id,
      projectId: mission.projectId,
      recipient: mission.origin?.conversationRef ?? mission.origin?.clientType ?? 'unknown',
      outcome: 'escalated',
      summary: `${body.question}

为什么需要 L3：${body.why}`,
    });
    await this.#event(mission, 'delivery.created', { deliveryId: delivery.id }, undefined, attemptId);
  }

  /**
   * 交卷。**还有没验收的工作项就拒绝** —— 这是 dry-run 里暴露的缺口：
   * 只有一个工作项时不会出事，多个时协调者可能在还没验完就交卷。
   */
  async submitMissionResult(
    missionId: string,
    attemptId: string,
    body: MissionResultBody,
  ): Promise<void> {
    const { mission } = await this.#requireAttempt(missionId, attemptId, 'coordinator');
    if (body.outcome === 'delivered') {
      // 作废掉的不算"没做完"——它是被判定为不用做了，拦着交卷没有道理。
      // 早先只认 accepted，于是任何作废过工作项的 Mission 都永远交不了卷，
      // 只能改用 outcome=blocked 绕过去——那等于对外宣称任务失败了。
      const unfinished = mission.workItems.filter(
        (item) => item.status !== 'accepted' && item.status !== 'retired',
      );
      if (unfinished.length > 0) {
        throw new PlatformRuleError(
          'WORK_ITEMS_UNFINISHED',
          `还有未验收的工作项：${unfinished.map((i) => `${i.id}(${i.status})`).join(', ')}。` +
            '每一张都要么验收通过、要么作废（coagent_retire_work_item）之后才能交卷；' +
            '确实交不出来就用 outcome=blocked。',
        );
      }
    }
    mission.recordResult(body);
    // **交卷 ≠ 完成。** 改动还躺在未合并的分支上，要等 L3 最终检视。
    // 名额也继续握着——这时候放掉，下一条 Mission 就会从看不见这些改动的
    // 基线上分叉。
    mission.submitForReview();
    await this.#event(
      mission,
      'mission_result.submitted',
      { outcome: body.outcome, missionStatus: mission.status },
      undefined,
      attemptId,
    );
    const delivery = await this.#deliveries.create({
      missionId: mission.id,
      projectId: mission.projectId,
      recipient: mission.origin?.conversationRef ?? mission.origin?.clientType ?? 'unknown',
      outcome: body.outcome,
      summary: body.summary,
    });
    await this.#event(mission, 'delivery.created', { deliveryId: delivery.id }, undefined, attemptId);
  }

  /** 记录本 Mission 的分支与基线。调度器开好工作区之后调一次。 */
  async recordWorkspace(
    missionId: string,
    ref: { projectRoot?: string; branch: string; baseRevision: string },
  ): Promise<void> {
    const { mission } = await this.#locate(missionId);
    mission.recordWorkspace(ref);
  }

  /**
   * Trusted orchestration round-start fact (BUDGET-001-S2).
   *
   * Append-only ActivityLog event via the private trusted path. No Mission
   * snapshot counter, no caller-authored ActivityEvent payload, no HTTP/tool surface.
   * Orchestrator records this once per runMission loop iteration after preflight
   * gates and before any Lightweight / Executor / Coordinator hop.
   */
  async recordOrchestrationRoundStarted(missionId: string): Promise<void> {
    const { mission } = await this.#locate(missionId);
    await this.#event(mission, 'orchestration.round.started', { schemaVersion: 1 });
  }

  /**
   * Authoritative Mission budget evaluation (BUDGET-001-S5).
   *
   * Assembles usage from durable attempts + activity projections only.
   * Does not invent zeros for unknown rounds/wall/commands; does not supply
   * changedFiles unless a trusted diff list is passed (Orchestrator leaves it
   * omitted when Workspace.diff is not wired into the loop).
   */
  async evaluateMissionBudget(
    missionId: string,
    opts?: { readonly changedFiles?: readonly string[] },
  ): Promise<{
    readonly budgetPresent: boolean;
    readonly snapshot: BudgetUsageSnapshot;
    readonly evaluation: BudgetEvaluation;
  }> {
    const { mission } = await this.#locate(missionId);
    const capturedAt = this.#clock.now().toISOString();
    const attempts = [
      ...mission.coordinatorAttempts,
      ...mission.workItems.flatMap((item) => item.attempts),
    ];
    const activity = await this.#activity.list(missionId);

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

  /**
   * Durable once-per-dimension/threshold budget warnings (BUDGET-001-S5).
   *
   * Scans activity for existing `mission.budget.threshold` v1 rows so reruns
   * do not re-emit. unknown / not_in_force dimensions never emit.
   */
  async recordBudgetThresholdEvents(
    missionId: string,
    evaluation: BudgetEvaluation,
  ): Promise<void> {
    const { mission } = await this.#locate(missionId);
    const activity = await this.#activity.list(missionId);
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
      await this.#event(mission, 'mission.budget.threshold', {
        schemaVersion: 1,
        dimension: crossing.dimension,
        threshold: crossing.threshold,
        limit: crossing.limit,
        used: crossing.used,
        class: crossing.class,
      });
    }
  }

  /**
   * Platform-internal LW→Standard promotion after *this* process re-evaluates
   * authoritative hard budget exceedance (BUDGET-001-S5).
   *
   * Not a public caller-authored `budget_exceeded` path — see
   * {@link promoteMissionToStandard}, which still rejects that code.
   */
  async promoteLightweightForBudgetExceeded(
    missionId: string,
  ): Promise<{ changed: boolean; promotion: Readonly<PromotionRecord> }> {
    const { mission } = await this.#locate(missionId);

    if (mission.executionMode === 'standard' && mission.promotions.length === 1) {
      const existing = mission.promotions[0]!;
      if (existing.triggerCode === 'budget_exceeded') {
        return { changed: false, promotion: existing };
      }
    }

    if (mission.executionMode !== 'lightweight') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_MODE_REQUIRED',
        `promoteLightweightForBudgetExceeded 需要 executionMode=lightweight，当前是 ${mission.executionMode}。`,
      );
    }

    const { evaluation } = await this.evaluateMissionBudget(missionId);
    if (!anyHardAuthoritativeExceeded(evaluation)) {
      throw new PlatformRuleError(
        'BUDGET_NOT_AUTHORITATIVELY_EXCEEDED',
        '权威硬预算未 exceeded，拒绝 budget_exceeded promotion。',
      );
    }

    const dims = hardExceededVerdicts(evaluation).map((d) => d.dimension);
    const rule = `hard:${dims.join(',')}`;
    return this.#commitPromotionToStandard(missionId, {
      code: 'budget_exceeded',
      rule,
    });
  }

  /** Detail string for Standard hard-budget wait (hard exceeded dims only). */
  formatExecutionBudgetExceededDetail(evaluation: BudgetEvaluation): string {
    return formatHardBudgetExceededDetail(evaluation);
  }

  /**
   * Trusted command-tracking cover (BUDGET-001-S4).
   *
   * Recorded when a Mission attempt receives runtime.capabilities v1 before any
   * tool.started. Envelope carries attemptId. No caller-authored payload.
   */
  async recordCommandTrackingEnabled(missionId: string, attemptId: string): Promise<void> {
    const { mission } = await this.#locate(missionId);
    await this.#event(
      mission,
      'runtime.command_tracking.enabled',
      { schemaVersion: 1 },
      undefined,
      attemptId,
    );
  }

  /**
   * Trusted command-start fact (BUDGET-001-S4).
   *
   * Adapter-classified activityClass === 'command' with a stable callId.
   * Hub never classifies by tool name. Envelope carries attemptId.
   */
  async recordCommandStarted(missionId: string, attemptId: string, callId: string): Promise<void> {
    const { mission } = await this.#locate(missionId);
    await this.#event(
      mission,
      'runtime.command.started',
      { schemaVersion: 1, callId },
      undefined,
      attemptId,
    );
  }

  /**
   * Trusted command-tracking breach (BUDGET-001-S4).
   *
   * Written when an attempt already covered by v1 later sees a missing/illegal
   * activityClass or an empty command callId — so projection fails closed to
   * unknown instead of undercounting.
   */
  async recordCommandTrackingInvalid(missionId: string, attemptId: string): Promise<void> {
    const { mission } = await this.#locate(missionId);
    await this.#event(
      mission,
      'runtime.command_tracking.invalid',
      { schemaVersion: 1 },
      undefined,
      attemptId,
    );
  }

  /**
   * L3 答复一条升级。
   *
   * 升级之后调度器是停着的（再叫协调者只会让它再升级一次）。答复落库之后
   * 协调者下一轮就能在 coagent_get_mission 里看到它，据此继续。
   */
  async answerEscalation(
    missionId: string,
    answer: string,
  ): Promise<{ question: string; answer: string }> {
    const { mission } = await this.#locate(missionId);
    if (mission.openEscalations.length === 0) {
      throw new PlatformRuleError('NO_OPEN_ESCALATION', `Mission ${missionId} 没有待答复的升级。`);
    }
    const answered = mission.answerEscalation(answer, new Date().toISOString());
    await this.#event(mission, 'escalation.answered', { question: answered.question, answer });
    return { question: answered.question, answer };
  }

  /**
   * 给 L3 看的改动摘要。没有工作区管理或没动过代码时返回空。
   *
   * `pendingMemory` 是**这份 diff 里看不到、但会跟它同一次提交落地**的文件。
   * 记忆文件是 merge 那一刻才写进 worktree 的，检视时还不存在；不把它们
   * 单独报出来，L3 就是在一份不完整的清单上签字。实测 P1 因此落了三个
   * 没人看过的文件，其中 VIBE.md 连 memoryDelta 里都没有。
   */
  async getMissionDiff(
    missionId: string,
  ): Promise<{ stat: string; files: string[]; pendingMemory: string[] }> {
    const { mission } = await this.#locate(missionId);
    const ref = mission.workspaceRef;
    const pendingMemory = plannedMemoryFiles(mission.result?.memoryDelta ?? []);
    if (!this.#workspace || !ref) {
      return { stat: '（没有工作区信息）', files: [], pendingMemory };
    }
    const diff = await this.#workspace.diff(missionId, ref.baseRevision, ref.projectRoot);
    return { ...diff, pendingMemory };
  }

  /**
   * L3 最终检视。
   *
   *   merge      —— 核对目标 HEAD 没变过之后落地，Mission 完成，名额释放
   *   send_back  —— 交回协调者重做，名额不放（分支上的改动还在）
   *   abandon    —— 放弃，名额释放
   *
   * 目标 HEAD 变过就**不合**：那意味着底下的代码动了，直接合进去等于拿一份
   * 过时的基线覆盖别人。这时候 Mission 转 blocked，交回协调者重新同步。
   */
  /**
   * 公开最终检视入口。**只发人类权威。**
   *
   * 机器权威必须来自跑过合并后验证的可信内部路径——同 `promoteMissionToStandard`
   * 拒绝 `budget_exceeded` 的纪律：能从外面写一个 kind 上去，权威就等于没有。
   */
  async finalizeMission(
    missionId: string,
    input: {
      verdict: 'merge' | 'send_back' | 'abandon';
      reasons: readonly string[];
      projectRoot?: string;
      /** 只接受 human；principalId 有就记，没有就记「人，不知道是谁」。 */
      authority?: { kind: 'human'; principalId?: string };
    },
  ): Promise<{ status: string; mergedInto?: string; reason?: string }> {
    const rawKind = (input as { authority?: { kind?: unknown } }).authority?.kind;
    if (rawKind !== undefined && rawKind !== 'human') {
      throw new PlatformRuleError(
        'FINAL_REVIEW_AUTHORITY_FORBIDDEN',
        `公开 finalizeMission 只能发 human 权威，收到 ${String(rawKind)}。` +
          '机器放行必须走跑过合并后验证的内部路径。',
      );
    }
    const authority: FinalReviewAuthority = Object.freeze(
      input.authority?.principalId !== undefined
        ? { kind: 'human' as const, principalId: input.authority.principalId }
        : { kind: 'human' as const },
    );
    const { mission } = await this.#locate(missionId);
    if (mission.status !== 'awaiting_review') {
      throw new PlatformRuleError(
        'NOT_AWAITING_REVIEW',
        `Mission ${missionId} 现在是 ${mission.status}，没有在等最终检视。`,
      );
    }
    if (input.verdict === 'send_back' && input.reasons.length === 0) {
      throw new PlatformRuleError(
        'SEND_BACK_NEEDS_REASONS',
        '打回必须写清楚为什么，否则协调者只会原样再交一次。',
      );
    }

    if (input.verdict === 'send_back') {
      mission.sendBackToPlanning({ verdict: 'send_back', reasons: [...input.reasons], authority });
      await this.#event(mission, 'final_review.send_back', { reasons: input.reasons });
      return { status: mission.status };
    }

    if (input.verdict === 'abandon') {
      mission.block({ verdict: 'abandon', reasons: [...input.reasons], authority });
      await this.#event(mission, 'final_review.abandoned', { reasons: input.reasons });
      await this.#releaseWorkspace(missionId, mission.workspaceRef?.projectRoot ?? input.projectRoot);
      return { status: mission.status };
    }

    // merge
    let mergedInto: string | undefined;
    if (mission.hasMutated) {
      const ref = mission.workspaceRef;
      if (!ref) {
        throw new PlatformRuleError(
          'NO_WORKSPACE_REF',
          `Mission ${missionId} 动过代码但没记下分支信息，无法落地。`,
        );
      }
      // projectRoot 优先用调用方给的，其次用 Mission 自己记下的那个。
      const projectRoot = input.projectRoot ?? ref.projectRoot;
      if (!this.#workspace || !projectRoot) {
        throw new PlatformRuleError(
          'NO_WORKSPACE_MANAGER',
          '要落地改动必须知道项目仓库在哪，且平台要配了工作区管理。',
        );
      }
      // 批准的长期知识写进 **Mission 自己的 worktree**，跟代码同一次 merge
      // 落地。分两次提交的话，"代码进去了文档没进去"就会发生——而且没人会发现。
      const proposals = mission.result?.memoryDelta ?? [];
      if (proposals.length > 0 && ref.branch !== '(in-place)') {
        const worktreeRoot = this.#workspace.worktreePath?.(missionId, ref.projectRoot);
        if (worktreeRoot) {
          const written = applyMemoryDelta(worktreeRoot, proposals);
          // 传 projectId：worktree 的目录名是 Mission ID，
          // 靠它兜底会让 VIBE.md 的标题变成 Mission 名。
          const vibe = writeVibe(worktreeRoot, mission.projectId);
          await this.#event(mission, 'memory.applied', { written: [...written, vibe] });
        }
      }

      const outcome = await this.#workspace.mergeToTarget({
        missionId,
        projectRoot,
        branch: ref.branch,
        expectedBaseRevision: ref.baseRevision,
      });
      if (!outcome.ok) {
        // 落不了地不算完成，也不该假装完成。转 blocked，原因说清楚。
        mission.block({ verdict: 'merge', reasons: [outcome.reason ?? '合并失败'], authority });
        await this.#event(mission, 'final_review.merge_failed', { reason: outcome.reason });
        return { status: mission.status, reason: outcome.reason };
      }
      mergedInto = outcome.mergedInto;
    }

    mission.complete({
      verdict: 'merge',
      reasons: [...input.reasons],
      mergedInto,
      mergedAt: new Date().toISOString(),
      authority,
    });
    await this.#event(mission, 'final_review.merged', { mergedInto, reasons: input.reasons });
    await this.#releaseWorkspace(missionId, mission.workspaceRef?.projectRoot ?? input.projectRoot);
    return { status: mission.status, mergedInto };
  }

  /* ============================ L1 执行者面 ============================ */

  async getWorkOrder(missionId: string, workItemId: string): Promise<WorkOrderView> {
    const { mission, item } = await this.#locateItem(missionId, workItemId);
    if (!item.order) {
      throw new PlatformRuleError('NO_WORK_ORDER', `工作项 ${workItemId} 没有工单正文。`);
    }
    const contract = mission.contract;
    return {
      workItemId: item.id,
      title: item.title,
      status: item.status,
      order: item.order,
      missionIntent: contract?.intent ?? '',
      guardrails: contract?.guardrails ?? [],
      /** 被打回重做时，上一次的 requiredChanges 必须带下去。 */
      previousRequiredChanges: item.reviews.at(-1)?.requiredChanges ?? [],
    };
  }

/**
   * 解析工单里的 ContextRef（S09.3 的 coagent_get_context）。
   *
   * 工单只给**引用**，正文按需取——把所有引用的内容都塞进工单，
   * 执行者的上下文一半是它可能根本不看的东西。
   */
  async getContext(
    missionId: string,
    attemptId: string,
    ref: string,
  ): Promise<{ found: boolean; kind?: string; body?: string; note?: string }> {
    const { mission, attempt } = await this.#requireAttempt(missionId, attemptId, 'executor');
    const item = attempt.workItemId ? mission.workItem(attempt.workItemId) : undefined;
    const declared = item?.order?.contextRefs ?? [];

    // 只让它取工单里声明过的引用。不限制的话，"最小充分上下文"就没有意义了。
    const match = declared.find((entry) =>
      typeof entry === 'string' ? entry === ref : entry.ref === ref,
    );
    if (!match) {
      const list = declared
        .map((entry) => (typeof entry === 'string' ? entry : entry.ref))
        .join('、');
      return {
        found: false,
        note: `工单里没有声明 ${ref}。可取的是：${list || '（无）'}。` +
          '需要别的东西说明工单给的上下文不够——用 coagent_report_blocked 交回去。',
      };
    }

    const kind = typeof match === 'string' ? 'file' : match.kind;
    if (kind === 'living_spec' || kind === 'adr') {
      const doc = (await this.getProjectContext(missionId, ref)) as {
        available: boolean;
        body?: string;
        note?: string;
      };
      return doc.available
        ? { found: true, kind, body: doc.body }
        : { found: false, note: doc.note };
    }
    if (kind === 'contract') {
      return { found: true, kind, body: JSON.stringify(mission.contract, null, 2) };
    }
    if (kind === 'previous_result') {
      const other = mission.workItem(ref);
      return other?.hasResult
        ? { found: true, kind, body: JSON.stringify(other.executionResult, null, 2) }
        : { found: false, note: `${ref} 还没有执行结果。` };
    }
    // file / artifact / decision：路径类的东西自己用 read 工具读，
    // 平台不代读——那只会多一条会读到错文件的路径。
    return {
      found: true,
      kind,
      note: `这是一个 ${kind} 引用：${ref}。用 read/grep 直接读它。`,
    };
  }

  async submitEvidence(
    missionId: string,
    attemptId: string,
    evidence: Omit<EvidenceRecord, 'id' | 'attemptId'>,
  ): Promise<{ evidenceId: string }> {
    const { mission, attempt } = await this.#requireAttempt(missionId, attemptId, 'executor');
    const evidenceId = this.#ids.next('E');
    attempt.addEvidence({ ...evidence, id: evidenceId, attemptId });
    await this.#event(
      mission,
      'evidence.submitted',
      { evidenceId, kind: evidence.kind, exitCode: evidence.exitCode },
      attempt.workItemId,
      attemptId,
    );
    return { evidenceId };
  }

  async submitExecutionResult(
    missionId: string,
    attemptId: string,
    body: ExecutionResultBody,
  ): Promise<{ status: string }> {
    const { mission, attempt } = await this.#requireAttempt(missionId, attemptId, 'executor');
    const workItemId = attempt.workItemId;
    if (!workItemId) {
      throw new PlatformRuleError('ATTEMPT_NOT_BOUND', `attempt ${attemptId} 没有绑定工作项`);
    }
    const item = mission.workItem(workItemId);
    if (!item) {
      throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${workItemId} 不存在`);
    }
    // S11.1 [MUST]：「已完成」必须有证据撑着。
    //
    // 挡在工具层而不是只写进 prompt——这正是本层存在的理由：能用工具层挡住的，
    // 就不要指望模型记得住。不挡的话，一句没有任何验证支撑的 completed 会一路
    // 走到 L2 验收面前，而那时它看起来和真做完了一模一样。
    //
    // 只卡 completed：blocked / failed 本来就是"没做成"，要求它们举证等于
    // 逼模型为了交卷去编一条。
    if (body.outcome === 'completed' && attempt.evidence.length === 0) {
      throw new PlatformRuleError(
        'NO_EVIDENCE',
        '提交 completed 之前必须先用 coagent_submit_evidence 提交至少一条证据：' +
          '跑过的命令与退出码、测试结果、diff 摘要都算。' +
          '没跑过的不要提交；确实做不完就交 blocked 或用 coagent_report_blocked。',
      );
    }
    // 提交只到 submitted。执行者没有任何通向 accepted 的路（不变量 A）。
    // 把 executionResult 绑到**实际提交它的** executor attempt（只读 provenance，
    // 供后续平台内验收报告绑定；本变更不接线、不改 review 面）。
    item.submit(body, attemptId);
    await this.#event(
      mission,
      'execution_result.submitted',
      { outcome: body.outcome, changedFiles: body.changedFiles.length },
      workItemId,
      attemptId,
    );
    return { status: item.status };
  }

  async reportBlocked(
    missionId: string,
    attemptId: string,
    body: Omit<BlockedRecord, 'attemptId'>,
  ): Promise<void> {
    const { mission, attempt } = await this.#requireAttempt(missionId, attemptId, 'executor');
    const workItemId = attempt.workItemId;
    if (!workItemId) {
      throw new PlatformRuleError('ATTEMPT_NOT_BOUND', `attempt ${attemptId} 没有绑定工作项`);
    }
    const item = mission.workItem(workItemId);
    if (!item) {
      throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${workItemId} 不存在`);
    }
    item.recordBlocked({ ...body, attemptId });
    await this.#event(mission, 'blocked.reported', { reason: body.reason }, workItemId, attemptId);
  }

  /* ================================ 内部 ================================ */

  /**
   * 派发前占用 Project mutation slot（不变量 C）。
   * Standard 与 Lightweight 共用；调用方负责其后的 shadow / item.dispatch 顺序。
   */
  async #acquireMutationSlotForDispatch(mission: Mission, project: Project): Promise<void> {
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
          await this.#event(mission, 'mission.waiting', { reason: 'project_busy' });
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

  /** Lightweight mutation lane 共用前置：mode + runKind。 */
  #requireLightweightMutationLane(mission: Mission): void {
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

  /**
   * Lightweight → Standard 可信升级入口（PROMO-001）。
   *
   * **仅进程内**：不接受完整 PromotionRecord / evidence / usage / HEAD 等 caller audit JSON；
   * 全部从 trusted state 构造。产品/API/agent tools 本单不新增 route。
   *
   * `budget_exceeded` 仍拒绝 caller 手填——权威硬耗尽只能走
   * {@link promoteLightweightForBudgetExceeded}（Platform 自检求值后发放）。
   */
  async promoteMissionToStandard(
    missionId: string,
    trigger: { readonly code: PromotionTriggerCode; readonly rule: string },
  ): Promise<{ changed: boolean; promotion: Readonly<PromotionRecord> }> {
    const rule = typeof trigger?.rule === 'string' ? trigger.rule.trim() : '';
    if (!rule) {
      throw new PlatformRuleError(
        'INVALID_PROMOTION_TRIGGER',
        'promoteMissionToStandard 要求非空 trigger.rule。',
      );
    }
    if (!isPromotionTriggerCode(trigger?.code)) {
      throw new PlatformRuleError(
        'INVALID_PROMOTION_TRIGGER',
        `非法 promotion trigger code：${String(trigger?.code)}`,
      );
    }
    // 公开入口永不接受 caller 自拟 budget_exceeded（BUDGET-001-S5）。
    if (trigger.code === 'budget_exceeded') {
      throw new PlatformRuleError(
        'BUDGET_PROMOTION_NOT_READY',
        'budget_exceeded 不得由调用方手填；仅 Platform 在权威硬超限自检后内部发放。',
      );
    }

    return this.#commitPromotionToStandard(missionId, {
      code: trigger.code,
      rule,
    });
  }

  /**
   * Shared LW→Standard commit after trigger validation.
   * Used by public non-budget triggers and internal budget hard-exceed path.
   */
  async #commitPromotionToStandard(
    missionId: string,
    trigger: { readonly code: PromotionTriggerCode; readonly rule: string },
  ): Promise<{ changed: boolean; promotion: Readonly<PromotionRecord> }> {
    const rule = trigger.rule.trim();
    const { mission, project } = await this.#locate(missionId);

    // 已 standard + 既有 promotion：按 trigger code/rule 幂等匹配，不重采样。
    if (mission.executionMode === 'standard' && mission.promotions.length === 1) {
      const existing = mission.promotions[0]!;
      if (existing.triggerCode === trigger.code && existing.triggerRule === rule) {
        return { changed: false, promotion: existing };
      }
      throw new PlatformRuleError(
        'PROMOTION_ALREADY_APPLIED',
        `Mission ${missionId} 已升级为 standard，拒绝不同 trigger。`,
      );
    }

    const fromStatus = mission.status as PromotionStatus;
    const toStatus: 'investigating' | 'planning' =
      mission.status === 'executing' ? 'planning' : (fromStatus as 'investigating' | 'planning');

    const record: PromotionRecord = {
      // 审计身份只由 Platform 生成；不接受 caller 自带 id。
      id: this.#ids.next('promo'),
      fromMode: 'lightweight',
      toMode: 'standard',
      triggerCode: trigger.code,
      triggerRule: rule,
      at: this.#clock.now().toISOString(),
      fromStatus,
      toStatus,
      consumedUsage: buildPromotionUsageSnapshot(mission),
      evidenceIds: collectPromotionEvidenceIds(mission),
      validationReportIds: await collectPromotionValidationReportIds(
        mission,
        this.#activity,
      ),
      workspaceRevision: await this.#derivePromotionWorkspaceRevision(mission),
      workItemIdsSnapshot: mission.workItems.map((item) => item.id),
    };

    const result = mission.promoteToStandard(record);
    if (!result.changed) {
      return result;
    }

    // promotion snapshot 独立于 API 外层 persist 也要落盘。
    await this.#projects.save(project);
    await this.#event(mission, 'mission.promoted', {
      id: result.promotion.id,
      oldMode: result.promotion.fromMode,
      newMode: result.promotion.toMode,
      triggerCode: result.promotion.triggerCode,
      triggerRule: result.promotion.triggerRule,
      consumedUsage: result.promotion.consumedUsage,
      evidenceIds: result.promotion.evidenceIds,
      validationReportIds: result.promotion.validationReportIds,
      workspaceRevision: result.promotion.workspaceRevision,
      workItemIdsSnapshot: result.promotion.workItemIdsSnapshot,
      fromStatus: result.promotion.fromStatus,
      toStatus: result.promotion.toStatus,
    });
    return result;
  }

  /**
   * 升级瞬间 workspace HEAD 的可信推导。
   * 禁止用 workspaceRef.baseRevision 冒充 current HEAD。
   */
  async #derivePromotionWorkspaceRevision(
    mission: Mission,
  ): Promise<PromotionWorkspaceRevision> {
    const projectRoot = mission.workspaceRef?.projectRoot;
    if (!this.#workspace || !mission.workspaceRef || !projectRoot) {
      return { kind: 'unknown' };
    }
    const cwd =
      this.#workspace.worktreePath?.(mission.id, projectRoot) ?? projectRoot;
    try {
      const head = await this.#workspace.head(cwd);
      const revision = typeof head === 'string' ? head.trim() : '';
      if (!revision) return { kind: 'unknown' };
      return { kind: 'head', revision };
    } catch {
      return { kind: 'unknown' };
    }
  }

  /**
   * 回收 worktree 目录。**只摘目录，不删分支** —— 改动是 Mission 的产出，
   * 分支留着才查得到。失败不致命：留个目录比中断收尾好。
   */
  async #releaseWorkspace(missionId: string, projectRoot?: string): Promise<void> {
    if (!this.#workspace || !projectRoot) return;
    await this.#workspace.release(missionId, projectRoot).catch(() => undefined);
  }

  async #ensureProject(projectId: string) {
    return this.#projects.ensure(projectId);
  }

  async #locate(missionId: string): Promise<{ mission: Mission; project: Project }> {
    for (const project of await this.#projects.list()) {
      const mission = project.missions.find((m) => m.id === missionId);
      // 也把 Project 带出来：不变量 C 的报错要点名"被谁占着"，
      // 那个信息只有在兄弟 Mission 里找得到。
      if (mission) return { mission, project };
    }
    throw new PlatformRuleError('UNKNOWN_MISSION', `mission ${missionId} 不存在`);
  }

  async #locateItem(
    missionId: string,
    workItemId: string,
  ): Promise<{ mission: Mission; item: WorkItem }> {
    const { mission } = await this.#locate(missionId);
    const item = mission.workItem(workItemId);
    if (!item) {
      throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${workItemId} 不存在`);
    }
    return { mission, item };
  }

  /**
   * 校验调用方身份。
   *
   * 工具面只是第一道闸：HTTP 端点是可达的，所以"执行者不得改 Plan"这条
   * 必须在这里再挡一次——按 attempt 的 kind 判定，而不是相信调用方自称。
   */
  async #requireAttempt(
    missionId: string,
    attemptId: string,
    kind: AttemptKind,
  ): Promise<{ mission: Mission; project: Project; attempt: Attempt }> {
    const { mission, project } = await this.#locate(missionId);
    const attempt = mission.attempt(attemptId);
    if (!attempt) {
      throw new PlatformRuleError('UNKNOWN_ATTEMPT', `attempt ${attemptId} 不存在`);
    }
    if (attempt.kind !== kind) {
      throw new PlatformRuleError(
        'WRONG_ROLE',
        `这个动作只允许 ${kind} 调用，attempt ${attemptId} 是 ${attempt.kind}。`,
      );
    }
    if (attempt.status !== 'in_progress') {
      throw new PlatformRuleError(
        'ATTEMPT_NOT_ACTIVE',
        `attempt ${attemptId} 已经是 ${attempt.status}，不能再提交。`,
      );
    }
    return { mission, project, attempt };
  }

  async #event(
    mission: Mission,
    kind: string,
    data: unknown,
    workItemId?: string,
    attemptId?: string,
  ): Promise<void> {
    // 每记一条事件就顺手更新"最后动过"。放在这一个地方，
    // 而不是散在十几个用例里——散着写一定会漏，而漏掉的那条在界面上
    // 表现成"这个 Mission 好像停了"。
    const at = this.#clock.now().toISOString();
    mission.touch(at);
    await this.#activity.append({
      projectId: mission.projectId,
      missionId: mission.id,
      workItemId,
      attemptId,
      kind,
      data,
      // ---- Envelope 公共语义（S10.3）----
      protocolVersion: PROTOCOL_VERSION,
      // 用 UUID 而不是发号器：messageId 只需要唯一，不需要连续。
      // 走发号器的话，每记一条事件都要占一个号段位——号段用尽时
      // 一次**记日志**会把正经操作顶失败，代价和收益完全不成比例。
      messageId: randomUUID(),
      // 因果链：同一条 Mission 的事件串在一起，而每条事件由哪一跳引发
      // 则看 causationId。没有这两个，"为什么会有这一步"只能靠时间戳猜。
      correlationId: mission.id,
      causationId: attemptId,
      contractRevision: mission.contractRevision,
      planRevision: mission.planRevision,
    });
  }
}

/**
 * Envelope 协议版本（S10.3）。
 *
 * 和 API_VERSION 分开：客户端接口和事件信封是两个会各自演进的东西，
 * 绑在一起就等于任何一边动了都要让另一边跟着升版本。
 */
export const PROTOCOL_VERSION = 'cdp/1';

/* ================================ 读模型 ================================ */

export interface MissionView {
  missionId: string;
  projectId: string;
  status: string;
  /** 创建时选定的执行保障档位；只读，不从 origin/workItems 推断。 */
  executionMode: MissionExecutionMode;
  /** 创建时选定的运行种类；只读，与 executionMode 正交。 */
  runKind: RunKind;
  /** Lightweight→Standard 升级历史（只读）；便于观测面显示原模式/当前模式/升级原因。 */
  promotions: readonly PromotionRecord[];
  /** 为什么停着。undefined = 没停。 */
  waitReason: WaitReason | undefined;
  waitDetail: string | undefined;
  updatedAt: string | undefined;
  paused: boolean;
  isMutating: boolean;
  /**
   * 同 Project 里**别的**哪条 Mission 正占着改动名额（不变量 C）。没有就是
   * undefined；自己占着也是 undefined —— 这一格回答的是"谁挡着我"。
   *
   * 有它，调度器才能在**花钱之前**停下来。原先只有 dispatchWorkItems 会撞上
   * PROJECT_BUSY，而那是在协调者调查完、规划完、拆完工作项之后——实测 P2
   * 因此花掉 $0.70 才被告知名额被占，而占着它的是一条早就死掉的测量跑。
   */
  blockedByMission: string | undefined;
  contractRevision: number;
  contract: MissionContract | undefined;
  planRevision: number;
  plan: PlanBody | undefined;
  workItems: {
    id: string;
    title: string;
    status: string;
    hasResult: boolean;
    attempts: number;
    attemptIds: string[];
    lastReview?: ReviewRecord;
    /**
     * 工单正文。**这是 L2 交给 L1 的那封信**——目标、范围、怎么验证、
     * 什么算做完。观测面要让人看到 agent 之间到底传了什么，缺了它就只剩
     * 一个标题，而"为什么它做成了这样"全在这份正文里。
     */
    order?: WorkOrder;
    /** L1 交回的那封信：做完了什么、动了哪些文件、有什么要说的。 */
    executionResult?: ExecutionResultBody;
  }[];
  result: MissionResultBody | undefined;
  /** 升级次数。调度器据此判断「该停下来等 L3 了」。 */
  escalations: number;
  /** 未答复的升级。有就说明在等 L3，不该再叫协调者。 */
  openEscalations: EscalationBody[];
  escalationLog: EscalationBody[];
  /**
   * 这条 Mission 从哪来。调度器据此认出**重跑**（rerunOf 有值）——重跑的起点
   * 是钉住的，按定义处在"基线 ≠ 目标分支当前位置"的状态，不该被派发前的
   * 过期闸拦下。
   */
  origin: OriginChannel | undefined;
  coordinatorResumeRef: string | undefined;
  coordinatorAttemptIds: string[];
  finalReview: FinalReview | undefined;
  workspaceRef: WorkspaceRef | undefined;
  usage: TokenUsage;
}

export interface MissionSummary {
  missionId: string;
  projectId: string;
  status: string;
  waitReason: WaitReason | undefined;
  waitDetail: string | undefined;
  updatedAt: string | undefined;
  paused: boolean;
  isMutating: boolean;
  intent: string;
  workItems: number;
  accepted: number;
  openEscalations: number;
  usage: TokenUsage;
}

export interface WorkOrderView {
  workItemId: string;
  title: string;
  status: string;
  order: WorkOrder;
  missionIntent: string;
  guardrails: readonly string[];
  previousRequiredChanges: readonly string[];
}

/**
 * 这台机器上会**静默**咬人的地方。
 *
 * 判准只有一条：**出错的时候没有声音**。会报错的东西 agent 自己撞一次就知道了，
 * 写进简报只是噪音；而下面这些不报错、只是悄悄做了另一件事——那种要提前说。
 *
 * 按平台分：在 Linux 上讲 Windows 的坑同样是噪音。
 */
function environmentNotes(): string[] {
  if (process.platform !== 'win32') return [];
  return [
    'Windows：bash 的 `/tmp` 和 Node 的 `/tmp` **不是同一个目录**（前者在 ' +
      '%LOCALAPPDATA%\\Temp，后者是 C:\\tmp）。要落临时文件就用工作区里的相对路径，' +
      '跨这两者传文件必须用绝对路径——弄错不会报错，只会读到一个旧文件或空文件。',
    'Windows：Git Bash 里没有 `pgrep`。`if ! pgrep -f x` 这类判据**恒为真**，' +
      '不会报"命令不存在"，只会让你以为进程已经没了。判进程死活用 tasklist，' +
      '或者干脆改判产物（文件 mtime、库里的记录）。',
  ];
}

/**
 * 同一个任务的一次运行。listRuns 的行。
 *
 * 刻意**不含**"哪个模型跑的"：那是候选池的事，一条 Mission 里不同跳可能
 * 用了不同候选。要按配置归因，看各 attempt 上冻住的 resolvedProfile。
 */
export interface RunSummary {
  missionId: string;
  /** 是不是最初那一条（其余都是它的重跑）。 */
  isOriginal: boolean;
  status: string;
  /** 交卷结论；还没交卷就是 undefined。 */
  outcome: string | undefined;
  contractRevision: number;
  /** 进入本次运行时的 lane；晋升后仍保留 lightweight，避免被当前 standard 覆盖。 */
  entryMode: MissionExecutionMode;
  /** 当前 lane。发生过 lightweight → standard 晋升时与 entryMode 不同。 */
  currentMode: MissionExecutionMode;
  /** 可信 PromotionRecord 的触发原因；没有晋升就是 undefined。 */
  promotionTrigger: PromotionTriggerCode | undefined;
  /** 用于判断两次运行是否同一 Git 起点；历史没记录就 unknown。 */
  baseRevision: string | undefined;
  /** mission.created → 第一条 execution_result.submitted；缺任一可信时间即 unknown。 */
  firstExecutionResultMs: number | undefined;
  /** 仅终态：mission.created → 最后状态事件时间；历史缺时间即 unknown。 */
  totalDurationMs: number | undefined;
  /** Standard L2 review 计数；validator authority 不混进来。 */
  l2Reviews: number;
  l2Rejects: number;
  /** L3 最终检视决策计数与 send_back 次数。 */
  l3Reviews: number;
  l3SendBacks: number;
  /** 机器 Validator 的真实 report 次数/失败次数。 */
  validatorRuns: number;
  validatorFailures: number;
  coordinatorHops: number;
  executorHops: number;
  workItems: number;
  usage: TokenUsage;
  /** 各跳的结束原因分布。**分类的价值就在这一格**：以前全是 upstream_failure。 */
  endedBy: Record<string, number>;
}

/** 两个 ISO 时间的非负差；缺失、非法、倒序都保持 unknown，不 clamp 成 0。 */
function elapsedMs(start: string | undefined, end: string | undefined): number | undefined {
  if (!start || !end) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined;
  return endMs - startMs;
}

/** 聚合用量：**分项相加**，不要只滚一个 total。 */
function sumUsage(mission: Mission): TokenUsage {
  const all: Attempt[] = [...mission.coordinatorAttempts];
  for (const item of mission.workItems) all.push(...item.attempts);
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let reported = 0;
  for (const attempt of all) {
    const u = attempt.usage;
    input += u.input;
    output += u.output;
    cacheRead += u.cacheRead;
    cacheWrite += u.cacheWrite;
    cost += u.cost ?? 0;
    if (u.quality === 'reported') reported += 1;
  }
  // 不得伪装精确：一条都没上报就是 unknown，部分上报就是 estimated，
  // 只有全部上报才敢说 reported。在途 attempt 还没上报不该把整体拉成
  // "估算过"——那会让读数看起来比实际更有依据。
  const quality: TokenUsage['quality'] =
    all.length === 0 || reported === 0
      ? 'unknown'
      : reported === all.length
        ? 'reported'
        : 'estimated';
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    cost,
    quality,
  };
}

/** 收集全部 attempts 的 evidence id，去重且保持出现顺序。 */
function collectPromotionEvidenceIds(mission: Mission): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const attempts: Attempt[] = [...mission.coordinatorAttempts];
  for (const item of mission.workItems) attempts.push(...item.attempts);
  for (const attempt of attempts) {
    for (const ev of attempt.evidence) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      ids.push(ev.id);
    }
  }
  return ids;
}

/**
 * 收集 promotion 审计用 validation reportId，去重保序。
 * 来源（既有可信状态，不另造审计入口）：
 *   1) WorkItem.reviews 中 validator authority.reportId
 *   2) activity `validation.reported` 事件 data.reportId
 *      （Lightweight 失败只落 report+事件、不写 ReviewRecord 时仍须计入）
 */
async function collectPromotionValidationReportIds(
  mission: Mission,
  activity: ActivityLog,
): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (reportId: unknown): void => {
    if (typeof reportId !== 'string' || reportId.length === 0) return;
    if (seen.has(reportId)) return;
    seen.add(reportId);
    ids.push(reportId);
  };

  for (const item of mission.workItems) {
    for (const review of item.reviews) {
      const authority = review.authority;
      if (!authority || authority.kind !== 'validator') continue;
      push(authority.reportId);
    }
  }

  const events = await activity.list(mission.id);
  for (const event of events) {
    if (event.kind !== 'validation.reported') continue;
    const data = event.data;
    if (data == null || typeof data !== 'object' || Array.isArray(data)) continue;
    push((data as { reportId?: unknown }).reportId);
  }

  return ids;
}

/**
 * 从 trusted attempts 构造 promotion usage 快照。
 * 只累加 reported/estimated；unknown 永不贡献假 0。
 * 任一 attempt token 事实未知 => dimensionsUnknown 含 tokens。
 * 无任何非 unknown usage => 省略 tokenUsage。
 */
function buildPromotionUsageSnapshot(mission: Mission): PromotionUsageSnapshot {
  const attempts: Attempt[] = [...mission.coordinatorAttempts];
  for (const item of mission.workItems) attempts.push(...item.attempts);
  const attemptCount = attempts.length;

  const baseUnknown: PromotionUnknownDimension[] = [
    'cost',
    'wallClockMs',
    'rounds',
    'changedFiles',
    'commands',
    'budgetRemaining',
  ];

  const known = attempts.filter(
    (a) => a.usage.quality === 'reported' || a.usage.quality === 'estimated',
  );
  const hasUnknownTokens =
    attemptCount === 0 || known.length < attemptCount;

  const dimensionsUnknown: PromotionUnknownDimension[] = hasUnknownTokens
    ? ['tokens', ...baseUnknown]
    : [...baseUnknown];

  if (known.length === 0) {
    return {
      attemptCount,
      dimensionsUnknown,
      budgetAuthoritative: false,
    };
  }

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reported = 0;
  for (const attempt of known) {
    const u = attempt.usage;
    input += u.input;
    output += u.output;
    cacheRead += u.cacheRead;
    cacheWrite += u.cacheWrite;
    if (u.quality === 'reported') reported += 1;
  }
  const quality: PromotionTokenUsageSnapshot['quality'] =
    reported === known.length ? 'reported' : 'estimated';
  const tokenUsage: PromotionTokenUsageSnapshot = {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    quality,
  };
  return {
    attemptCount,
    tokenUsage,
    dimensionsUnknown,
    budgetAuthoritative: false,
  };
}

function viewOf(mission: Mission): MissionView {
  return {
    missionId: mission.id,
    projectId: mission.projectId,
    status: mission.status,
    executionMode: mission.executionMode,
    runKind: mission.runKind,
    promotions: mission.promotions,
    waitReason: mission.waitReason,
    waitDetail: mission.waitDetail,
    updatedAt: mission.updatedAt,
    paused: mission.isPaused,
    isMutating: mission.isMutating,
    // 只有 getMissionView 那一层算得出来（要看兄弟 Mission）。这里给 undefined
    // 而不是省略：省略会让类型上是可选的东西在运行时变成"没查过"和"查了没有"
    // 分不开。
    blockedByMission: undefined,
    contractRevision: mission.contractRevision,
    contract: mission.contract,
    planRevision: mission.planRevision,
    plan: mission.plan,
    workItems: mission.workItems.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      hasResult: item.hasResult,
      // 拆它时的规划版本（S05.2）。和 Mission 当前的 planRevision 不同
      // 就说明规划在它之后改过——检视时这是必须看得见的。
      planRevision: item.planRevision,
      attempts: item.attempts.length,
      attemptIds: item.attempts.map((a) => a.id),
      lastReview: item.reviews.at(-1),
      // 两封信的正文。观测面要回答"这两个 agent 之间到底传了什么"，
      // 光有 title 和一个 hasResult 布尔量回答不了。
      order: item.order,
      executionResult: item.executionResult,
    })),
    result: mission.result,
    escalations: mission.escalations.length,
    openEscalations: [...mission.openEscalations],
    escalationLog: [...mission.escalations],
    origin: mission.origin,
    coordinatorResumeRef: mission.latestCoordinatorResumeRef(),
    coordinatorAttemptIds: mission.coordinatorAttempts.map((a) => a.id),
    finalReview: mission.finalReview,
    workspaceRef: mission.workspaceRef,
    usage: sumUsage(mission),
  };
}

export { InvariantViolationError };

/** 往分组里塞一条。 */
function push(map: Map<string, TokenUsage[]>, key: string, usage: TokenUsage): void {
  const list = map.get(key);
  if (list) list.push(usage);
  else map.set(key, [usage]);
}

/**
 * 合并若干条用量。
 *
 * quality 的规则和 sumUsage 一致，而且**必须一致**：同一个数在 Mission 页
 * 标"已上报"、在用量页标"估算"，人只会不信这两个数。
 */
function combine(list: readonly TokenUsage[]): TokenUsage {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let reported = 0;
  for (const u of list) {
    input += u.input;
    output += u.output;
    cacheRead += u.cacheRead;
    cacheWrite += u.cacheWrite;
    cost += u.cost ?? 0;
    if (u.quality === 'reported') reported += 1;
  }
  const quality: TokenUsage['quality'] =
    list.length === 0 || reported === 0
      ? 'unknown'
      : reported === list.length
        ? 'reported'
        : 'estimated';
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    cost,
    quality,
  };
}

/** 一个分组维度上的一行。 */
export interface UsageBucket {
  key: string;
  attempts: number;
  usage: TokenUsage;
}

/** 用量报表（S11.5）。 */
export interface UsageReport {
  total: TokenUsage;
  attempts: number;
  /**
   * 没冻结过身份、因而进不了 byFact 的 attempt 数。
   *
   * 单列出来而不是摊给某个身份：摊给谁都是编的，而这个数本身就是信号——
   * 它不为零就说明有一批 attempt 的归因是缺的。
   */
  unattributed: number;
  byProject: UsageBucket[];
  byMission: UsageBucket[];
  byRole: UsageBucket[];
  /** 按运行时报回来的事实分组。适配层填 provider / model，所以这一项覆盖了两者。 */
  byFact: { key: string; value: string; attempts: number; usage: TokenUsage }[];
}
