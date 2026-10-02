import type { Mission, MissionContract } from '../../kernel/index.ts';
import type { ActivityEvent } from '../ports.ts';
import type { RunSummary, MissionSummary, MissionView, AgentMissionView, WorkOrderView, AgentWorkItemView, AgentWorkItemSubmissionSummary, ValidationReportView } from './types.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import { elapsedMs, sumUsage, combine } from './usage-helpers.ts';
import { priorGuidanceForWorkItem, agentWorkItemIndex, agentEscalationAnswers, buildAgentWorkItemView } from './agent-view-helpers.ts';
import { plannedMemoryFiles, readProjectMemory } from '../project-memory.ts';
import { redactSecrets } from '../redact.ts';

interface ViewDeps {
  workItemValidationReportViews(mission: Mission, events?: readonly ActivityEvent[]): Promise<Map<string, ValidationReportView>>;
  haReviewHold(mission: Mission): Promise<MissionView['haReviewHold']>;
}

  /**
   * 同一个任务的所有运行，按开始时间排。
   *
   * 这是"可比较"的读出口：一次运行一行，带上它花了多少、跑了多久、几跳、
   * 各跳因为什么结束、最后是什么结果。回答的是「这次改动到底让它变好了没有」——
   * 而在这之前，这个问题只能靠手写 SQL 去比两条碰巧相似的 Mission。
   */
export async function listRuns(ctx: PlatformContext, missionId: string): Promise<RunSummary[]> {
    const { mission, project } = await ctx.locate(missionId);
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

      const events = await ctx.activity.list(m.id);
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
        // 白名单：只数人亲签。authority === 'human'，或旧记录没标 authority（undefined）。
        // 不能用「不等于 machine/plan/reviewer」的黑名单——authority:'unknown' 也会混进人类分母。
        // 检视者代签、夜跑机器放行、方案放弃都不是人亲签。
        const l3Authority = data?.authority;
        if (
          (event.kind === 'final_review.send_back' ||
            event.kind === 'final_review.merged' ||
            event.kind === 'final_review.abandoned') &&
          (l3Authority === 'human' || l3Authority === undefined)
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

  /**
   * 项目长期知识（S09.2 的 coagent_get_project_context）。
   *
   * 给协调者看的是**架构约束 + Capability 索引**，不是把所有 Spec 全文
   * 倒给它。S10.4：只传最小充分上下文；需要哪份再按 slug 取。
   */
export async function getProjectContext(ctx: PlatformContext, missionId: string, slug?: string) {
    const { mission } = await ctx.locate(missionId);
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

  /** 项目清单（S12.2 的 getProjects）。 */
export async function listProjects(ctx: PlatformContext) {
    const rows = [];
    for (const project of await ctx.projects.list()) {
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
            ...m.independentReviewerAttempts,
            ...m.workItems.flatMap((w) => w.attempts),
          ]).map((a) => a.usage),
        ),
      });
    }
    return rows;
  }

  /** 所有 Mission 的概览，给列表页用。 */
export async function listMissions(ctx: PlatformContext, ): Promise<MissionSummary[]> {
    const rows: MissionSummary[] = [];
    for (const project of await ctx.projects.list()) {
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
          ...planRunListFields(mission),
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
export async function getAttemptDetail(ctx: PlatformContext, missionId: string, attemptId: string) {
    const { mission } = await ctx.locate(missionId);
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
        ? (ctx.artifacts.get(attempt.outputRef) ?? attempt.output)
        : attempt.output,
      outputRef: attempt.outputRef,
      toolActivity: attempt.toolActivity,
    };
  }

  /** Mission 的事件流，给 Timeline 用。 */
export async function getActivity(ctx: PlatformContext, missionId: string) {
    // 不存在就报错，别返回空数组糊弄——空 Timeline 和不存在的 Mission
    // 在界面上长得一模一样。
    await ctx.locate(missionId);
    return ctx.activity.list(missionId);
  }

export async function getMissionView(ctx: PlatformContext, deps: ViewDeps, missionId: string): Promise<MissionView> {
    const { mission, project } = await ctx.locate(missionId);
    // 谁挡着我。要 Project 才算得出来，所以在这一层补，不放进 viewOf。
    const holder = project.missions.find((m) => m.id !== mission.id && m.isMutating);
    const view = {
      ...viewOf(mission, await deps.workItemValidationReportViews(mission)),
      blockedByMission: holder?.id,
    };
    if (mission.executionMode === 'high_assurance' && mission.status === 'awaiting_review') {
      return { ...view, haReviewHold: await deps.haReviewHold(mission) };
    }
    return view;
  }

  /**
   * agent 专用紧凑 Mission 视图：契约 + 完整规划 + 工作项索引 + 升级问答摘要，
   * 不含工单正文、执行结果或评审正文。网页 getMissionView 不受影响（不改动它）。
   * 只读投影，不写任何状态。
   */
export async function getAgentMissionView(ctx: PlatformContext, deps: ViewDeps, missionId: string): Promise<AgentMissionView> {
    const { mission } = await ctx.locate(missionId);
    return {
      missionId: mission.id,
      projectId: mission.projectId,
      status: mission.status,
      executionMode: mission.executionMode,
      runKind: mission.runKind,
      updatedAt: mission.updatedAt,
      contractRevision: mission.contractRevision,
      planRevision: mission.planRevision,
      contract: mission.contract,
      plan: mission.plan,
      workItemIndex: agentWorkItemIndex(mission, await deps.workItemValidationReportViews(mission)),
      escalations: agentEscalationAnswers(mission),
      openEscalations: mission.openEscalations.length,
    };
  }

  /**
   * 只读契约（S09.2 的 coagent_get_contract）。
   *
   * 和 getMissionView 分开的理由是**成本**：调查阶段协调者要反复回看验收标准
   * 和红线，而整个 MissionView 带着全部工作项、尝试、时间线——每看一眼红线
   * 就得连着几千 token 一起读进去。契约本身只有几行。
   */
export async function getContract(ctx: PlatformContext, missionId: string): Promise<{
    contract: Readonly<MissionContract> | undefined;
    contractRevision: number;
  }> {
    const { mission } = await ctx.locate(missionId);
    return { contract: mission.contract, contractRevision: mission.contractRevision };
  }

  /**
   * 给 L3 看的改动摘要。没有工作区管理或没动过代码时返回空。
   *
   * `pendingMemory` 是**这份 diff 里看不到、但会跟它同一次提交落地**的文件。
   * 记忆文件是 merge 那一刻才写进 worktree 的，检视时还不存在；不把它们
   * 单独报出来，L3 就是在一份不完整的清单上签字。实测 P1 因此落了三个
   * 没人看过的文件，其中 VIBE.md 连 memoryDelta 里都没有。
   */
export async function getMissionDiff(ctx: PlatformContext, 
    missionId: string,
  ): Promise<{ stat: string; files: string[]; pendingMemory: string[] }> {
    const { mission } = await ctx.locate(missionId);
    const ref = mission.workspaceRef;
    const pendingMemory = plannedMemoryFiles(mission.result?.memoryDelta ?? []);
    if (!ctx.workspace || !ref) {
      return { stat: '（没有工作区信息）', files: [], pendingMemory };
    }
    const diff = await ctx.workspace.diff(missionId, ref.baseRevision, ref.projectRoot);
    return { ...diff, pendingMemory };
  }

export async function getWorkOrder(ctx: PlatformContext, missionId: string, workItemId: string): Promise<WorkOrderView> {
    const { mission, item } = await ctx.locateItem(missionId, workItemId);
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
      // 打回理由与问答都是事后补的，不能写进冻结 order；缺省不带键。
      ...priorGuidanceForWorkItem(mission, item),
    };
  }

  /**
   * agent 专用单项详情：沿用 #locateItem 的 UNKNOWN_WORK_ITEM 规则（不存在即抛）。
   * 返回工单及 orderRevision、历次执行结果证据摘要（脱敏截尾）与评审信息。
   * 单项序列化 UTF-8 不超过 20 KB，超长显式标记 truncated。只读投影，不写状态。
   */
export async function getAgentWorkItem(ctx: PlatformContext, deps: ViewDeps, missionId: string, workItemId: string): Promise<AgentWorkItemView> {
    const { mission, item } = await ctx.locateItem(missionId, workItemId);
    // 取该工作项全部 execution_result.submitted 事件，保留原时间顺序，
    // 仅提取事件里实际存的 outcome / changedFiles(数量) / orderRevision / at。
    // 旧提交正文未被持久化、不可恢复，只留元数据并标「旧正文未保存」；
    // 最新一次正文经 item.executionResult 仍可取，不臆造。
    const events = await ctx.activity.list(missionId);
    const submittedEvents = events
      .filter((e) => e.workItemId === workItemId && e.kind === 'execution_result.submitted')
      .map((e) => e as ActivityEvent);
    const lastIndex = submittedEvents.length - 1;
    const submissionSummaries: AgentWorkItemSubmissionSummary[] = submittedEvents.map((e, i) => {
      const data = e.data as { outcome?: string; changedFiles?: number; orderRevision?: string } | undefined;
      const isLatest = i === lastIndex;
      return {
        at: e.at,
        outcome: data?.outcome,
        changedFiles: data?.changedFiles,
        orderRevision: data?.orderRevision,
        isLatest,
        // 只有最新一次有完整全文（经 executionResult 取），旧正文未保存、不可恢复。
        note: isLatest ? undefined : '旧正文未保存',
      };
    });
    return buildAgentWorkItemView(
      item,
      item.order?.orderRevision,
      item.order,
      item.executionResult ?? undefined,
      submissionSummaries,
      (await deps.workItemValidationReportViews(mission, events)).get(item.id),
    );
  }

/**
   * 解析工单里的 ContextRef（S09.3 的 coagent_get_context）。
   *
   * 工单只给**引用**，正文按需取——把所有引用的内容都塞进工单，
   * 执行者的上下文一半是它可能根本不看的东西。
   */
export async function getContext(ctx: PlatformContext, 
    missionId: string,
    attemptId: string,
    ref: string,
  ): Promise<{ found: boolean; kind?: string; body?: string; note?: string }> {
    const { mission, attempt } = await ctx.requireAttempt(missionId, attemptId, 'executor');
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
      const doc = (await getProjectContext(ctx, missionId, ref)) as {
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

/**
 * 列表投影：origin.conversationRef 给出 runId，Mission id 必须是
 * `<runId>-<featureId>[-rN]`。对不上就不写——猜错的关联比没有更糟。
 * 功能 id 含 `-rN` 的消歧由 HTTP 层用已知 PlanRun.features.missionIds 覆盖。
 */
function planRunListFields(mission: Mission): { planRunId: string; featureId: string } | Record<string, never> {
  const origin = mission.origin;
  if (!origin || origin.clientType !== 'plan-run') return {};
  const ref = origin.conversationRef;
  if (typeof ref !== 'string' || !ref.startsWith('plan-run:')) return {};
  const planRunId = ref.slice('plan-run:'.length);
  if (planRunId === '' || planRunId.includes('/') || planRunId.includes('\\') || planRunId.includes(':')) {
    return {};
  }
  const prefix = `${planRunId}-`;
  if (!mission.id.startsWith(prefix)) return {};
  const rest = mission.id.slice(prefix.length);
  if (rest === '') return {};
  const rerun = /^(.*)-r([1-9]\d*)$/.exec(rest);
  const featureId = rerun && rerun[1] !== '' ? rerun[1] : rest;
  if (featureId === '') return {};
  return { planRunId, featureId };
}

function viewOf(
  mission: Mission,
  validationReports?: ReadonlyMap<string, ValidationReportView>,
): MissionView {
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
    parked: mission.isParked,
    parkReason: mission.parkReason,
    // 只有 getMissionView 那一层算得出来（要看兄弟 Mission）。这里给 undefined
    // 而不是省略：省略会让类型上是可选的东西在运行时变成"没查过"和"查了没有"
    // 分不开。
    blockedByMission: undefined,
    contractRevision: mission.contractRevision,
    contract: mission.contract,
    planRevision: mission.planRevision,
    plan: mission.plan,
    workItems: mission.workItems.map((item) => {
      const validationReport = validationReports?.get(item.id);
      return {
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
        // submitted：只投影最新提交 attempt（item.submittedAttemptId）的证据，脱敏后再截尾。
        // 先 redactSecrets 再 slice(-1000)——顺序反了会把截出来的尾巴里的 token 明文露出去。
        ...(item.status === 'submitted' && item.submittedAttemptId !== undefined
          ? {
              submittedEvidence: (item.attempts.find((a) => a.id === item.submittedAttemptId)?.evidence ?? []).map(
                (e) => ({
                  command: e.command !== undefined ? redactSecrets(e.command) : undefined,
                  exitCode: e.exitCode,
                  summary: redactSecrets(e.summary),
                  outputTail: (e.output !== undefined ? redactSecrets(e.output) : '').slice(-1000),
                }),
              ),
            }
          : {}),
        // accepted / rejected：只给证据条数和验收结论，不泄露证据输出。
        ...((item.status === 'accepted' || item.status === 'rejected')
          ? {
              reviewSummary: {
                evidenceCount: item.attempts.find((a) => a.id === item.submittedAttemptId)?.evidence.length ?? 0,
                verdict: item.status === 'accepted' ? 'accept' : 'reject',
              },
            }
          : {}),
        // 机器验证简版：与提交严格按 workItemId + 当前 submittedAttemptId 对应，
        // 写读同一份只读投影（见 validationReportView）。
        ...(validationReport !== undefined ? { validationReport } : {}),
        // 两封信的正文。观测面要回答"这两个 agent 之间到底传了什么"，
        // 光有 title 和一个 hasResult 布尔量回答不了。
        order: item.order,
        executionResult: item.executionResult,
      };
    }),
    result: mission.result,
    escalations: mission.escalations.length,
    openEscalations: [...mission.openEscalations],
    escalationLog: [...mission.escalations],
    origin: mission.origin,
    coordinatorResumeRef: mission.latestCoordinatorResumeRef(),
    coordinatorAttemptIds: mission.coordinatorAttempts.map((a) => a.id),
    independentReviewerAttemptIds: mission.independentReviewerAttempts.map((a) => a.id),
    independentReviews: mission.independentReviews,
    independentReviewBlockReason: mission.independentReviewBlockReason,
    independentReviewBlockDetail: mission.independentReviewBlockDetail,
    finalReview: mission.finalReview,
    workspaceRef: mission.workspaceRef,
    usage: sumUsage(mission),
  };
}
