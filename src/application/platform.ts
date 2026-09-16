/**
 * 平台用例层 —— coagent_* 工具背后的真实实现。
 *
 * 工具的 handler（住在各个 runtime 适配包里）只负责把结构化参数转发到这里。
 * 规则写在这一层而不是 prompt 里：**能用工具层挡住的，就不要指望模型记得住。**
 */

import { randomUUID } from 'node:crypto';
import { InvariantViolationError } from '../kernel/index.ts';
import type {
  Attempt,
  AttemptEndReason,
  AttemptKind,
  BlockedRecord,
  EscalationBody,
  EvidenceRecord,
  ExecutionResultBody,
  FinalReview,
  Mission,
  MissionContract,
  MissionResultBody,
  OriginChannel,
  PlanBody,
  Project,
  ReviewRecord,
  TokenUsage,
  UsedProfile,
  WaitReason,
  WorkItem,
  WorkOrder,
  WorkspaceRef,
} from '../kernel/index.ts';
import type { ActivityLog, Clock, IdGenerator, ProjectRepository } from './ports.ts';
import type { DeliveryRepository } from './delivery.ts';
import type { WorkspaceManager } from './workspace.ts';
import type { ArtifactStore } from './artifact-store.ts';
import { InlineArtifactStore } from './artifact-store.ts';
import { applyMemoryDelta, readProjectMemory, writeVibe } from './project-memory.ts';

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
}

export interface CreateMissionInput {
  projectId: string;
  missionId?: string;
  contract: MissionContract;
  /** 结果最终回到哪里。缺省表示无人认领——结果仍会进收件箱，只是没有收件人。 */
  origin?: OriginChannel;
}

export class Platform {
  #projects: ProjectRepository;
  #activity: ActivityLog;
  #ids: IdGenerator;
  #deliveries: DeliveryRepository;
  #workspace: WorkspaceManager | undefined;
  #artifacts: ArtifactStore;
  #clock: Clock;

  constructor(deps: PlatformDeps) {
    this.#projects = deps.projects;
    this.#activity = deps.activity;
    this.#ids = deps.ids;
    this.#deliveries = deps.deliveries;
    this.#workspace = deps.workspace;
    this.#artifacts = deps.artifacts ?? new InlineArtifactStore();
    this.#clock = deps.clock;
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

  async reviseContract(
    missionId: string,
    contract: MissionContract,
  ): Promise<{ contractRevision: number }> {
    const { mission } = await this.#locate(missionId);
    const contractRevision = mission.reviseContract(contract);
    // 契约改了，之前那份交卷就是照着旧契约做的——不能再按它放行。
    // 退回规划，让协调者拿着新契约重新判断。
    if (mission.status === 'awaiting_review') {
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
      constitution: memory.constitution,
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
    const { mission } = await this.#locate(missionId);
    return viewOf(mission);
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
        projectRules = readProjectMemory(root, mission.projectId).constitution;
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
      const unfinished = mission.workItems.filter((item) => item.status !== 'accepted');
      if (unfinished.length > 0) {
        throw new PlatformRuleError(
          'WORK_ITEMS_UNFINISHED',
          `还有未验收的工作项：${unfinished.map((i) => `${i.id}(${i.status})`).join(', ')}。` +
            '全部 accepted 之后才能交卷；确实交不出来就用 outcome=blocked。',
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

  /** 给 L3 看的改动摘要。没有工作区管理或没动过代码时返回空。 */
  async getMissionDiff(missionId: string): Promise<{ stat: string; files: string[] }> {
    const { mission } = await this.#locate(missionId);
    const ref = mission.workspaceRef;
    if (!this.#workspace || !ref) return { stat: '（没有工作区信息）', files: [] };
    return this.#workspace.diff(missionId, ref.baseRevision);
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
  async finalizeMission(
    missionId: string,
    input: { verdict: 'merge' | 'send_back' | 'abandon'; reasons: readonly string[]; projectRoot?: string },
  ): Promise<{ status: string; mergedInto?: string; reason?: string }> {
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
      mission.sendBackToPlanning({ verdict: 'send_back', reasons: [...input.reasons] });
      await this.#event(mission, 'final_review.send_back', { reasons: input.reasons });
      return { status: mission.status };
    }

    if (input.verdict === 'abandon') {
      mission.block({ verdict: 'abandon', reasons: [...input.reasons] });
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
        const worktreeRoot = this.#workspace.worktreePath?.(missionId);
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
        mission.block({ verdict: 'merge', reasons: [outcome.reason ?? '合并失败'] });
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
    item.submit(body);
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
  /** 为什么停着。undefined = 没停。 */
  waitReason: WaitReason | undefined;
  waitDetail: string | undefined;
  updatedAt: string | undefined;
  paused: boolean;
  isMutating: boolean;
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
  }[];
  result: MissionResultBody | undefined;
  /** 升级次数。调度器据此判断「该停下来等 L3 了」。 */
  escalations: number;
  /** 未答复的升级。有就说明在等 L3，不该再叫协调者。 */
  openEscalations: EscalationBody[];
  escalationLog: EscalationBody[];
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

function viewOf(mission: Mission): MissionView {
  return {
    missionId: mission.id,
    projectId: mission.projectId,
    status: mission.status,
    waitReason: mission.waitReason,
    waitDetail: mission.waitDetail,
    updatedAt: mission.updatedAt,
    paused: mission.isPaused,
    isMutating: mission.isMutating,
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
    })),
    result: mission.result,
    escalations: mission.escalations.length,
    openEscalations: [...mission.openEscalations],
    escalationLog: [...mission.escalations],
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
