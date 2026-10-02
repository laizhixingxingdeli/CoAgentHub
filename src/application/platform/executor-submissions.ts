import type { Mission, WorkItem, EscalationBody, EvidenceRecord, ExecutionResultBody, BlockedRecord } from '../../kernel/index.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import { criteriaList } from './agent-view-helpers.ts';

export async function submitEvidence(
  ctx: PlatformContext,
  criteriaFailureStop: (mission: Mission, item: WorkItem) => Promise<void>,
  recordEscalationAndDeliver: (mission: Mission, body: EscalationBody) => Promise<void>,
    missionId: string,
    attemptId: string,
    evidence: Omit<EvidenceRecord, 'id' | 'attemptId'>,
  ): Promise<{ evidenceId: string }> {
    const { mission, attempt } = await ctx.requireAttempt(missionId, attemptId, 'executor');
    const evidenceId = ctx.ids.next('E');
    attempt.addEvidence({ ...evidence, id: evidenceId, attemptId });
    await ctx.event(
      mission,
      'evidence.submitted',
      { evidenceId, kind: evidence.kind, exitCode: evidence.exitCode },
      attempt.workItemId,
      attemptId,
    );
    return { evidenceId };
  }

export async function submitExecutionResult(
  ctx: PlatformContext,
  criteriaFailureStop: (mission: Mission, item: WorkItem) => Promise<void>,
  recordEscalationAndDeliver: (mission: Mission, body: EscalationBody) => Promise<void>,
    missionId: string,
    attemptId: string,
    body: ExecutionResultBody,
  ): Promise<{ status: string }> {
    const { mission, attempt } = await ctx.requireAttempt(missionId, attemptId, 'executor');
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
    // blocked 才取理由原文：partial 会被机器回退退回执行者，计进连续失败等于数两遍。
    const blockedReason =
      body.outcome === 'blocked' ? `${body.summary}\n${body.notes}` : undefined;
    item.submit(body, attemptId);
    await ctx.event(
      mission,
      'execution_result.submitted',
      {
        outcome: body.outcome,
        changedFiles: body.changedFiles.length,
        // 记当时工单修订号：重派门禁据此判断「未修订是否原样重派」，
        // 不另造事件种类、不依赖当前状态（修订后当前会变大）。
        orderRevision: item.order?.orderRevision ?? 'r1',
        // 关联标准与当时契约修订：统计只回放带这两个的事件。
        criteria: criteriaList(item.order),
        contractRevision: mission.contractRevision,
        ...(blockedReason !== undefined ? { blockedReason } : {}),
      },
      workItemId,
      attemptId,
    );
    if (blockedReason !== undefined) await criteriaFailureStop(mission, item);
    return { status: item.status };
  }

export async function reportBlocked(
  ctx: PlatformContext,
  criteriaFailureStop: (mission: Mission, item: WorkItem) => Promise<void>,
  recordEscalationAndDeliver: (mission: Mission, body: EscalationBody) => Promise<void>,
    missionId: string,
    attemptId: string,
    body: Omit<BlockedRecord, 'attemptId'>,
  ): Promise<void> {
    const { mission, attempt } = await ctx.requireAttempt(missionId, attemptId, 'executor');
    const workItemId = attempt.workItemId;
    if (!workItemId) {
      throw new PlatformRuleError('ATTEMPT_NOT_BOUND', `attempt ${attemptId} 没有绑定工作项`);
    }
    const item = mission.workItem(workItemId);
    if (!item) {
      throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${workItemId} 不存在`);
    }
    item.recordBlocked({ ...body, attemptId });
    await ctx.event(
      mission,
      'blocked.reported',
      {
        reason: body.reason,
        // 记当时工单修订号：重派门禁据此判断「未修订是否原样重派」，
        // 不另造事件种类、不依赖当前状态。
        orderRevision: item.order?.orderRevision ?? 'r1',
        // 同上：关联标准与当时契约修订。
        criteria: criteriaList(item.order),
        contractRevision: mission.contractRevision,
      },
      workItemId,
      attemptId,
    );
    // 先判「这条标准是不是已连续三个工作项没过」：轻量提问升级照旧，两者互不吞掉。
    await criteriaFailureStop(mission, item);
    // Lightweight 没有协调者：执行者提问只能走 Mission 升级，否则 L3 看不到。
    // Standard 和空白需求不是提问，保持只记 blocked。
    const needs = typeof body.needsFromUpstream === 'string' ? body.needsFromUpstream : '';
    if (mission.executionMode === 'lightweight' && needs.trim() !== '') {
      await recordEscalationAndDeliver(mission, {
        attemptId,
        question: body.needsFromUpstream,
        why: body.reason,
        optionsConsidered: [...(body.whatWasTried ?? [])],
      });
    }
  }
