import type { AttemptKind, Mission, MissionContract, PlanBody, FinalReview } from '../../kernel/index.ts';
import type { ActivityEvent } from '../ports.ts';
import type { QueueClaimIdentity, ValidationReportView } from './types.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import { readProjectMemory } from '../project-memory.ts';
import { keepTrueOrUnknownLeaves } from './context-metrics.ts';
import { coordinatorStartupSources, boundWorkItemForExecutor } from './agent-view-helpers.ts';
import { buildContextBundle, projectStartupBriefFields, type BoundWorkItem, type ContractCheck, type ContextBundle } from '../context-builder.ts';

interface StartupDeps {
  workItemValidationReportViews(mission: Mission, events?: readonly ActivityEvent[]): Promise<Map<string, ValidationReportView>>;
}

export async function getStartupBrief(
  ctx: PlatformContext,
  deps: StartupDeps,
    missionId: string,
    attemptId: string,
    budget?: number,
    claim?: QueueClaimIdentity,
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
    workItem?: BoundWorkItem;
    /** L3 打回的理由。被打回之后重跑时，这是最该先看到的东西。 */
    finalReview?: Readonly<FinalReview>;
    /** 当前契约修订的核对结论；无当前修订核对时缺省，旧简报形状不变。 */
    contractCheck?: Readonly<ContractCheck>;
    /** 可追溯的角色视图；旧字段从这里投影，缺省语义保持不变。 */
    contextBundle: ContextBundle;
  }> {
    const { mission } = await ctx.locate(missionId);
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

    if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) {
      throw new PlatformRuleError('INVALID_BUDGET', 'budget 必须是非负安全整数');
    }

    const item =
      attempt.kind === 'executor' && attempt.workItemId
        ? mission.workItem(attempt.workItemId)
        : undefined;
    let classification: string | undefined;
    if (attempt.kind === 'coordinator') {
      const routed = (await ctx.activity.list(missionId)).find(
        (event) => event.kind === 'mission.routed',
      );
      if (routed) {
        const data = routed.data && typeof routed.data === 'object'
          ? (routed.data as Record<string, unknown>)
          : {};
        const factsRaw = data.facts && typeof data.facts === 'object'
          ? (data.facts as Record<string, unknown>)
          : {};
        const facts = Object.fromEntries(
          Object.entries(factsRaw)
            .map(([key, value]) => [key, keepTrueOrUnknownLeaves(value)])
            .filter(([, value]) => value !== undefined),
        );
        const lines = [
          '分类阶段已查明',
          `facts: ${JSON.stringify(facts)}`,
          `unknowns: ${JSON.stringify(data.unknowns ?? [])}`,
          `reasons: ${JSON.stringify(data.reasons ?? [])}`,
        ];
        const assessmentReasons = mission.complexityAssessment?.reasons ?? data.assessmentReasons;
        if (assessmentReasons !== undefined) {
          lines.push(`assessmentReasons: ${JSON.stringify(assessmentReasons)}`);
        }
        if (typeof data.fallbackReason === 'string') {
          lines.push(`fallbackReason: ${data.fallbackReason}`);
        }
        const full = lines.join('\n');
        classification = full.length <= 2000
          ? full
          : `${full.slice(0, 2000 - '（已截断）'.length)}（已截断）`;
      }
    }
    // 读路径仍在这里：构造器只吃显式值，不自己找 Mission。
    //
    // 机器验证简版只进协调者那份：执行者拿到「上一跳机器验收过没过」等于提前知道
    // 自己的东西会被怎么判，而那不是它该看的。
    let briefSources:
      | {
          workItemsIndex: readonly CoordinatorWorkItemIndexEntry[];
          sinceLastHop: CoordinatorSinceLastHopEntry;
        }
      | undefined;
    let contractCheck: Readonly<ContractCheck> | undefined;
    if (attempt.kind === 'coordinator') {
      const events = await ctx.activity.list(missionId);
      briefSources = coordinatorStartupSources(
        mission,
        attemptId,
        events,
        await deps.workItemValidationReportViews(mission, events),
      );
      // 当前修订最近的核对结论：契约改版后旧修订事件被跳过，未重新核对前保持旧简报形状。
      const checkEvent = [...events].reverse().find(
        (event) =>
          event.kind === 'contract_check.submitted' &&
          (event.data as { contractRevision?: number } | undefined)?.contractRevision ===
            mission.contractRevision,
      );
      contractCheck = checkEvent?.data as Readonly<ContractCheck> | undefined;
    }
    const contextBundle = buildContextBundle(
      {
        role: attempt.kind === 'executor' ? 'executor' : 'coordinator',
        projectRules,
        environmentNotes: environmentNotes(),
        contract: mission.contract,
        contractRevision: mission.contractRevision,
        plan: mission.plan,
        planRevision: mission.planRevision,
        workItem: item ? boundWorkItemForExecutor(mission, item) : undefined,
        finalReview: mission.finalReview,
        classification,
        ...(briefSources
          ? {
              workItemsIndex: briefSources.workItemsIndex,
              sinceLastHop: briefSources.sinceLastHop,
            }
          : {}),
        ...(contractCheck ? { contractCheck } : {}),
      },
      budget,
    );

    const report = contextBundle.budgetReport;
    // 只有 omittedSources 非空才是实际裁剪。恰好放下或没给预算时写事件，
    // 审计会把「没裁」说成「裁过」，后续同 Attempt 去重也锁死在假记录上。
    if (report && report.omittedSources.length > 0) {
      await recordContextTruncated(ctx, missionId, attemptId, claim, {
        role: contextBundle.role,
        budget: report.budget,
        estimatedBefore: report.estimatedBefore,
        estimatedAfter: report.estimatedAfter,
        omittedSources: report.omittedSources,
        overflow: report.overflow,
        remainingOverBudget: report.remainingOverBudget,
      });
    }

    return {
      role: attempt.kind,
      projectId: mission.projectId,
      missionId: mission.id,
      status: mission.status,
      ...projectStartupBriefFields(contextBundle),
      contextBundle,
    };
  }

  /**
   * 裁剪审计必须走队列写门禁：不经 #attemptWrite 的话，队列 Attempt 在丢牌后
   * 仍能记一条「已审计」，而控制面其它写已经被 fence 挡住。
   * 落盘失败要抛出去——调用方拿到裁剪简报却没有事件，等于声称已审计。
   */
export async function recordContextTruncated(
  ctx: PlatformContext,
    missionId: string,
    attemptId: string,
    claim: QueueClaimIdentity | undefined,
    data: {
      readonly role: string;
      readonly budget: number;
      readonly estimatedBefore: number;
      readonly estimatedAfter: number;
      readonly omittedSources: readonly string[];
      readonly overflow: boolean;
      readonly remainingOverBudget: number;
    },
  ): Promise<void> {
    await ctx.attemptWrite(missionId, attemptId, claim, async () => {
      const { mission } = await ctx.locate(missionId);
      const events = await ctx.activity.list(missionId);
      const already = events.some(
        (event) => event.kind === 'context.truncated' && event.attemptId === attemptId,
      );
      if (already) return;
      await ctx.event(mission, 'context.truncated', data, undefined, attemptId);
    });
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
