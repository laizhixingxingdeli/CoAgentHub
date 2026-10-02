import type { Mission, WorkItem, EscalationBody } from '../../kernel/index.ts';
import type { CriteriaFailureDiagnostic, QueueClaimIdentity } from './types.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import { escalationDeliveryKey } from '../delivery.ts';
import { criteriaList, criteriaFailureStopFor, criteriaFailureQuestion, criteriaFailureWhy, hasOpenDiagnosticEscalation, readDiagnosticCriteria } from './agent-view-helpers.ts';

export async function submitContractCheck(
  ctx: PlatformContext,
    missionId: string,
    attemptId: string,
    input: { verdict: 'ok' | 'issues'; summary: string; issues?: readonly string[] },
    claim?: QueueClaimIdentity,
  ): Promise<{ contractRevision: number; verdict: 'ok' | 'issues' }> {
    // 单事务命令（C2）：核对事件、升级、投递一起提交，或者一个都不落。
    return ctx.attemptWrite(missionId, attemptId, claim, async () => {
      const { mission } = await ctx.requireAttempt(missionId, attemptId, 'coordinator');
      if (input.verdict !== 'ok' && input.verdict !== 'issues') {
        throw new PlatformRuleError(
          'CONTRACT_CHECK_VERDICT_INVALID',
          `verdict 只能是 ok 或 issues，收到 ${String(input.verdict)}。`,
        );
      }
      // 空结论等于没核对：压缩后重读事件只看得到「核对过」三个字。
      const summary = input.summary?.trim() ?? '';
      if (summary.length === 0) {
        throw new PlatformRuleError(
          'CONTRACT_CHECK_SUMMARY_REQUIRED',
          'summary 不能为空：核对结论必须写清查了什么、结论是什么。',
        );
      }
      const issues = (input.issues ?? []).map((issue) => issue.trim());
      if (input.verdict === 'issues' && (issues.length === 0 || issues.some((issue) => issue.length === 0))) {
        throw new PlatformRuleError(
          'CONTRACT_CHECK_ISSUES_REQUIRED',
          'verdict=issues 时必须给出非空的 issues，且每项都要写清是哪条验收/输入对不上。',
        );
      }
      const contractRevision = mission.contractRevision;
      let escalationIndex: number | undefined;
      if (input.verdict === 'issues') {
        // 复用既有升级与投递：另写一条路会变成两次升级、两封信。
        await recordEscalationAndDeliver(ctx, mission, {
          attemptId,
          question:
            `契约核对发现问题（r${contractRevision}），需要 L3 裁决：\n` +
            issues.map((issue) => `- ${issue}`).join('\n'),
          why: `协调者开工前核对契约发现问题：${summary}`,
          optionsConsidered: [
            '按现契约直接派工（对不上的那条执行者必然卡住）',
            '由协调者自行修订契约（契约只由 L3 修订，越权）',
            '升级给 L3 修订契约后再派工',
          ],
        });
        escalationIndex = mission.escalations.length - 1;
      }
      await ctx.event(
        mission,
        'contract_check.submitted',
        {
          contractRevision,
          verdict: input.verdict,
          summary,
          ...(input.verdict === 'issues' ? { issues, escalationIndex } : {}),
        },
        undefined,
        attemptId,
      );
      return { contractRevision, verdict: input.verdict };
    });
  }

export async function escalateToL3(
  ctx: PlatformContext,
    missionId: string,
    attemptId: string,
    body: Omit<EscalationBody, 'attemptId'>,
  ): Promise<void> {
    const { mission } = await ctx.requireAttempt(missionId, attemptId, 'coordinator');
    await recordEscalationAndDeliver(ctx, mission, { ...body, attemptId });
  }

export async function recordEscalationAndDeliver(
  ctx: PlatformContext,
    mission: Mission,
    body: EscalationBody,
    diagnostic?: CriteriaFailureDiagnostic,
  ): Promise<void> {
    mission.recordEscalation(body);
    // 第几次升级：每一次都要进收件箱，重建同一次的投递不会多一条。
    const escalationIndex = mission.escalations.length - 1;
    await ctx.event(
      mission,
      'escalated',
      // 诊断卡多带两格：身份 + 它管哪条标准。普通升级不该被迫知道自己不是诊断卡。
      diagnostic === undefined
        ? { question: body.question }
        : { question: body.question, criteriaFailure: true, criteria: [diagnostic.criterion] },
      undefined,
      body.attemptId,
    );
    // 升级只写进平台是不够的：L3 不盯着数据库看。进收件箱才叫升级。
    const delivery = await ctx.deliveries.create({
      missionId: mission.id,
      projectId: mission.projectId,
      recipient: mission.origin?.conversationRef ?? mission.origin?.clientType ?? 'unknown',
      outcome: 'escalated',
      idempotencyKey: escalationDeliveryKey(escalationIndex),
      summary: `${body.question}

为什么需要 L3：${body.why}`,
    });
    await ctx.event(mission, 'delivery.created', { deliveryId: delivery.id }, undefined, body.attemptId);
  }

export async function requireNoOpenDiagnosticEscalation(
  ctx: PlatformContext,mission: Mission): Promise<void> {
    if (!hasOpenDiagnosticEscalation(mission, await ctx.activity.list(mission.id))) return;
    throw new PlatformRuleError(
      'CRITERIA_FAILURE_STOPPED',
      '有未答复的「同一条验收标准连续三个工作项没通过」诊断卡，已停派：请先答复那张卡（或修订工单）再派发。',
    );
  }

export async function criteriaFailureStop(
  ctx: PlatformContext,mission: Mission, item: WorkItem): Promise<void> {
    const criteria = criteriaList(item.order);
    if (criteria.length === 0) return; // 没有关联标准，不参与统计
    const events = await ctx.activity.list(mission.id);
    const stopped = criteriaFailureStopFor(events, mission.contractRevision, criteria);
    if (!stopped) return;
    // 已有未答复诊断卡就不再开（第二张只会让人不知道该答哪张）。普通升级不抑制：
    // 不能让一张提问卡抵掉停派。
    if (hasOpenDiagnosticEscalation(mission, events)) return;
    await recordEscalationAndDeliver(ctx, 
      mission,
      {
        // Mission 级诊断卡：它谈的是这条标准，不是某个执行者的一跳。
        attemptId: stopped.workItemIds[0] ?? '',
        question: criteriaFailureQuestion(mission, stopped),
        why: criteriaFailureWhy(stopped, events),
        optionsConsidered: [],
      },
      stopped,
    );
  }

export async function answerEscalation(
  ctx: PlatformContext,
    missionId: string,
    answer: string,
  ): Promise<{ question: string; answer: string }> {
    const { mission } = await ctx.locate(missionId);
    if (mission.openEscalations.length === 0) {
      throw new PlatformRuleError('NO_OPEN_ESCALATION', `Mission ${missionId} 没有待答复的升级。`);
    }
    const answered = mission.answerEscalation(answer, new Date().toISOString());
    // 诊断卡被答复就把连续失败清零：L3 已看过并给了方向。清零元数据落在事件里——
    // 回放时认它，不能靠读内存或猜文本。
    const history = await ctx.activity.list(mission.id);
    const diagnostic = readDiagnosticCriteria(history, answered.question);
    await ctx.event(mission, 'escalation.answered', {
      question: answered.question,
      answer,
      ...(diagnostic === undefined
        ? {}
        : { criteriaFailureReset: true, criteria: [...diagnostic], contractRevision: mission.contractRevision }),
    });
    // 停派期间不重派：否则编排器会把 L3 刚停下的工单再送出去。
    if (diagnostic === undefined) {
      await redispatchLightweightBlockedAfterAnswer(ctx, mission, answered);
    }
    return { question: answered.question, answer };
  }

export async function redispatchLightweightBlockedAfterAnswer(
  ctx: PlatformContext,
    mission: Mission,
    answered: Readonly<EscalationBody>,
  ): Promise<void> {
    if (mission.executionMode !== 'lightweight') return;
    const events = await ctx.activity.list(mission.id);
    // 不派：所答的是诊断卡（答复只解闸，重派得由协调者修订工单后走正式入口），或还有
    // 别的未答复诊断卡——停派对所有派发入口生效。 
    if (readDiagnosticCriteria(events, answered.question) !== undefined) return;
    if (hasOpenDiagnosticEscalation(mission, events)) return;
    const attempt = mission.attempt(answered.attemptId);
    const workItemId = attempt?.workItemId;
    if (!workItemId) return;
    const item = mission.workItem(workItemId);
    if (!item || item.status !== 'blocked') return;
    item.dispatch();
    await ctx.event(
      mission,
      'work_item.redispatched',
      { ids: [workItemId], reason: 'escalation_answered' },
      workItemId,
      answered.attemptId,
    );
  }
