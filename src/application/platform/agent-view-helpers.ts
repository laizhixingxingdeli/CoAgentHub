import type { Mission, WorkItem, EscalationBody, ValidationReport, WorkOrder, EvidenceRecord, ExecutionResultBody } from '../../kernel/index.ts';
import type { ActivityEvent } from '../ports.ts';
import type { BoundWorkItem, WorkItemIndexEntry } from '../context-builder.ts';
import type { ValidationReportView, ValidationReportCommandView, CriteriaFailureDiagnostic, AgentWorkItemIndexEntry, AgentEscalationAnswer, AgentWorkItemEvidenceSummary, AgentWorkItemSubmissionSummary, AgentWorkItemView } from './types.ts';
import { redactSecrets, redactSecretsDeep } from '../redact.ts';

function answeredQaForWorkItem(
  mission: Mission,
  item: WorkItem,
): { question: string; answer: string; answeredAt: string } | undefined {
  const attemptIds = new Set(item.attempts.map((attempt) => attempt.id));
  let latest: Readonly<EscalationBody> | undefined;
  for (const escalation of mission.escalations) {
    if (escalation.answer && escalation.answeredAt && attemptIds.has(escalation.attemptId)) {
      latest = escalation;
    }
  }
  if (!latest?.answer || !latest.answeredAt) return undefined;
  return {
    question: latest.question,
    answer: latest.answer,
    answeredAt: latest.answeredAt,
  };
}

/**
 * 派回执行者的可见理由：工单视图与开跑简报共用这一份投影，两处不能各算各的。
 *
 * 为什么不能只取 `item.reviews.at(-1)`：工作项被 reject 后重做、又被 accept，最后
 * 一条评审是 accept，其 requiredChanges 是空的。这时 L3 再打回整个 Mission 重派，
 * 执行者读到的「上次要改什么」是空——真正该先看的打回理由一条也没到它手上。
 * 倒着找**最近一次 reject** 既保住旧的「重派带上要改什么」语义，又不会被随后的
 * accept 抹掉。
 *
 * L3 理由只在当前 finalReview 是 send_back 时带（Mission 每次 send_back 都覆盖
 * finalReview，所以同轮多次打回自然只剩最新一条）。它**不**要求本项有 reject：
 * 「已验收的工作项被 L3 打回重派」正是本投影要救的场景，那时 reviews 里只有 accept。
 */
export function priorGuidanceForWorkItem(
  mission: Mission,
  item: WorkItem,
): {
  previousRequiredChanges?: readonly string[];
  l3SendBackReasons?: readonly string[];
  question?: string;
  answer?: string;
  answeredAt?: string;
} {
  const latestReject = [...item.reviews]
    .reverse()
    .find((review) => review.verdict === 'reject');
  const finalReview = mission.finalReview;
  const answered = answeredQaForWorkItem(mission, item);
  return {
    ...(latestReject ? { previousRequiredChanges: latestReject.requiredChanges } : {}),
    ...(finalReview?.verdict === 'send_back' && finalReview.reasons.length > 0
      ? { l3SendBackReasons: finalReview.reasons }
      : {}),
    ...(answered ?? {}),
  };
}

/* ===================== 协调者简报：工作项索引 + 上一跳增量 ===================== */

/** 上一跳以来的新情况摘要里，单条摘要的最大字符数；超长显式截断，不放输出全文。 */
const SINCE_LAST_HOP_SUMMARY_CAP = 200;

/**
 * 协调者索引条目：与 context-builder 的 WorkItemIndexEntry 同形，另带机器验证简版。
 *
 * 简版以**可选键**留在对象里：context-builder 把整份内容哈希进 bundle，多出来的
 * 键就是内容的一部分——所以没报告的工作项一定不带这个键，否则索引的指纹会变。
 */
type CoordinatorWorkItemIndexEntry = WorkItemIndexEntry & {
  readonly validationReport?: ValidationReportView;
};

/**
 * 增量条目：短摘要文本，外加可选的机器验证简版。
 * 简版只在「上一跳之后真的新记了 validation.reported」时才出现——它回答的是
 * “这次新验了什么”，而不是“历史上验过什么”。
 */
type CoordinatorSinceLastHopEntry = readonly {
  readonly summary: string;
  readonly validationReport?: ValidationReportView;
}[];

/**
 * 把上一段 coordinator 结束之后的活动，按事件原序压成一条条短摘要。
 *
 * 只列「有的才列」：证据提交、卡住报告、升级答复、L3 最终决定各自独立判断；
 * 同一类多次出现就各列一条。不放输出全文——摘要里只留脱敏后的概要，
 * 避免把几十万字符的输出又搬回协调者上下文。
 */
function summarizeSinceLastHop(
  mission: Mission,
  events: readonly ActivityEvent[],
  validationReports: ReadonlyMap<string, ValidationReportView>,
): CoordinatorSinceLastHopEntry {
  const entries: { summary: string; validationReport?: ValidationReportView }[] = [];
  const push = (summary: string, validationReport?: ValidationReportView): void => {
    entries.push({
      summary: capString(redactSecrets(summary), SINCE_LAST_HOP_SUMMARY_CAP),
      ...(validationReport !== undefined ? { validationReport } : {}),
    });
  };
  for (const event of events) {
    switch (event.kind) {
      case 'execution_result.submitted': {
        const data = event.data as
          | { outcome?: string; changedFiles?: number; orderRevision?: string }
          | undefined;
        const workItemId = event.workItemId;
        const title = workItemId ? mission.workItem(workItemId)?.title : undefined;
        const latest = workItemId
          ? mission.workItem(workItemId)?.attempts.at(-1)?.evidence.at(-1)
          : undefined;
        const evidenceNote = latest
          ? `最近证据：${latest.kind}${latest.summary ? '：' + latest.summary : ''}`
          : '（无已存证据）';
        push(
          `提交[${title ?? workItemId ?? '?'}] ${data?.outcome ?? '?'} ` +
            `改动${data?.changedFiles ?? '?'}个文件 工单修订${data?.orderRevision ?? '?'}；${evidenceNote}`,
        );
        break;
      }
      case 'blocked.reported': {
        const data = event.data as { reason?: string; orderRevision?: string } | undefined;
        push(`卡住报告：${data?.reason ?? '（无理由）'}（工单修订${data?.orderRevision ?? '?'}，待协调者处理）`);
        break;
      }
      case 'escalation.answered': {
        const data = event.data as { question?: string; answer?: string } | undefined;
        push(`升级答复：${data?.question ?? '（无问题）'} → ${data?.answer ?? '（无答复）'}`);
        break;
      }
      case 'validation.reported': {
        // 机器验收是平台自己跑出来的：协调者上一跳之后才出现的这一条，正是它这一跳
        // 要看的「新情况」。报告 map 以 workItemId 为键（见 #workItemValidationReportViews），
        // 不是 workItemId+attempt 的复合键，所以这里只能按 workItemId 取。
        // 取到的必须是**当前**提交的那一份：拿旧提交的事件去取，会把新交卷的报告
        // 误挂到旧事件上——串了一份 append-only 报告比没有更糟。对不上（比如 HA 的
        // 整 Mission 验证，或报告还没落盘）就只留一行文字，不造简版。
        const data = event.data as { submittedAttemptId?: unknown } | undefined;
        const workItemId = event.workItemId;
        const item = workItemId !== undefined ? mission.workItem(workItemId) : undefined;
        const title = item?.title;
        const submittedAttemptId =
          typeof data?.submittedAttemptId === 'string' ? data.submittedAttemptId : undefined;
        const report =
          item !== undefined &&
          submittedAttemptId !== undefined &&
          submittedAttemptId === item.submittedAttemptId
            ? validationReports.get(item.id)
            : undefined;
        push(
          `机器验证[${title ?? workItemId ?? '?'}]：${
            report === undefined ? '（报告不在本次增量里）' : report.passed ? 'passed' : 'failed'
          }`,
          report,
        );
        break;
      }
      case 'final_review.send_back':
      case 'final_review.abandoned':
      case 'final_review.merged':
      case 'final_review.merge_failed':
      case 'final_review.ha_unsafe':
      case 'final_review.ha_authorized':
      case 'final_review.integration_anchor':
      case 'final_review.integration_verified':
      case 'final_review.merge_applied': {
        const data = (event.data ?? {}) as Record<string, unknown>;
        const reasons = Array.isArray(data.reasons) ? data.reasons.join('；') : '';
        push(`L3 最终决定[${event.kind.replace('final_review.', '')}]${reasons ? '：' + reasons : ''}`);
        break;
      }
      default:
        break;
    }
  }
  return entries;
}

/**
 * 从活动原序里找到「上一个结束的 coordinator 跳」，取其 attempt.ended 事件。
 * 用 attemptId 是否落在 mission.coordinatorAttempts 里判断角色，并严格用
 * 序列位置（而非相同时间戳）定位——同一秒内多事件是常态，靠时间戳会错配。
 */
function previousCoordinatorEndEvent(
  mission: Mission,
  currentAttemptId: string,
  events: readonly ActivityEvent[],
): ActivityEvent | undefined {
  const coordIds = new Set(mission.coordinatorAttempts.map((a) => a.id));
  const endedCoord = events.filter(
    (e) => e.kind === 'attempt.ended' && e.attemptId !== undefined && coordIds.has(e.attemptId),
  );
  // 最后一个不是当前这一跳的 coordinator 结束事件，就是「上一跳」。
  const prev = endedCoord.filter((e) => e.attemptId !== currentAttemptId).at(-1);
  return prev;
}

export function coordinatorStartupSources(
  mission: Mission,
  attemptId: string,
  events: readonly ActivityEvent[],
  validationReports: ReadonlyMap<string, ValidationReportView>,
): {
  workItemsIndex: readonly CoordinatorWorkItemIndexEntry[];
  sinceLastHop: CoordinatorSinceLastHopEntry;
} {
  const index: readonly CoordinatorWorkItemIndexEntry[] = agentWorkItemIndex(
    mission,
    validationReports,
  ).map((entry) => ({
    id: entry.id,
    title: entry.title,
    status: entry.status,
    attempts: entry.attempts,
    lastReviewVerdict: entry.lastReviewVerdict,
    criteria: entry.criteria,
    ...(entry.validationReport !== undefined ? { validationReport: entry.validationReport } : {}),
  }));
  const prevEnd = previousCoordinatorEndEvent(mission, attemptId, events);
  if (!prevEnd) {
    return { workItemsIndex: index, sinceLastHop: [] };
  }
  const prevIndex = events.findIndex((e) => e === prevEnd);
  const after = events.slice(prevIndex + 1);
  return { workItemsIndex: index, sinceLastHop: summarizeSinceLastHop(mission, after, validationReports) };
}

export function boundWorkItemForExecutor(mission: Mission, item: WorkItem): BoundWorkItem {
  return {
    id: item.id,
    title: item.title,
    order: item.order,
    ...priorGuidanceForWorkItem(mission, item),
  };
}

/* ===================== agent 专用只读投影（不写状态） ===================== */

/** 单项序列化后允许的最大 UTF-8 字节数；超长显式标记 truncated。 */
const MAX_AGENT_WORK_ITEM_BYTES = 20 * 1024;







/** 失败命令输出保留的尾巴长度；与 MissionView.submittedEvidence 同一口径。 */
const VALIDATION_REPORT_OUTPUT_TAIL = 1000;

/** 验证简版索引键：workItemId + 提交 attempt。id 里不可能有 NUL，键不会撞。 */
export function validationReportKey(workItemId: string, submittedAttemptId: string): string {
  return `${workItemId}\u0000${submittedAttemptId}`;
}

/**
 * ValidationReport → 只读简版。
 *
 * 输出先 redactSecrets 再 slice(-1000)：顺序反了会把截出来的尾巴里的 token
 * 明文露出去。
 */
export function validationReportView(report: ValidationReport): ValidationReportView {
  const commands: ValidationReportCommandView[] = [];
  for (const check of report.checks) {
    if (check.kind !== 'command') continue;
    const command = check.command;
    const tail = command?.outputTail;
    const outputTail =
      check.passed || tail === undefined
        ? undefined
        : redactSecrets(tail).slice(-VALIDATION_REPORT_OUTPUT_TAIL);
    commands.push({
      passed: check.passed,
      durationMs: command?.durationMs ?? 0,
      ...(outputTail !== undefined ? { outputTail } : {}),
    });
  }
  const changed = report.checks.find((check) => check.kind === 'changed-paths');
  const changedPaths = changed?.changedPaths;
  return {
    reportId: report.id,
    passed: report.passed,
    commands,
    ...(changed !== undefined && changedPaths !== undefined
      ? {
          changedPaths: {
            passed: changed.passed,
            violations: changedPaths.violations.map((path) => redactSecrets(path)),
          },
        }
      : {}),
  };
}




/** 工单 criteria 的投影：有序号给副本，缺省或空数组给 `'—'`。 */
function projectCriteria(order: WorkOrder | undefined): readonly number[] | '—' {
  return order !== undefined && order.criteria !== undefined && order.criteria.length > 0
    ? [...order.criteria]
    : '—';
}

/** 统计视图：去重后的序号数组，`'—'` 给空数组。与给人看的 projectCriteria 分开。 */
export function criteriaList(order: WorkOrder | undefined): readonly number[] {
  const raw = order?.criteria;
  if (raw === undefined) return [];
  return [...new Set(raw.filter((n) => Number.isInteger(n)))];
}




/**
 * 一个事件对某条标准的意义：一次失败（带理由原文）或一次通过。都只认**当前契约修订**
 * 且带 criteria 元数据的事件：契约一改序号就指向另一批标准，没这套元数据的历史事件
 * 只能靠猜它服务哪条标准。
 */
type CriteriaSignal =
  | { readonly pass: false; readonly criteria: readonly number[]; readonly reason: string }
  | { readonly pass: true; readonly criteria: readonly number[] };

function isFailureEvent(event: ActivityEvent, data: Record<string, unknown>): boolean {
  if (event.kind === 'work_item.retired' || event.kind === 'blocked.reported') return true;
  // review 只有 reject 算、submitted 只有 blocked 算：partial 会被机器回退退回执行者。
  if (event.kind === 'review.recorded') return data.verdict === 'reject';
  if (event.kind === 'execution_result.submitted') return data.outcome === 'blocked';
  return false;
}

/** 失败理由原文。调用前已确认这是一次失败事件。 */
function failureReasonText(event: ActivityEvent, data: Record<string, unknown>): string {
  // review 的 reasons 原文照抄：协调者逐条写的东西，压成一句会丢掉他要改什么。
  if (event.kind === 'review.recorded') {
    return Array.isArray(data.reasons) ? (data.reasons as unknown[]).map(String).join('；') : '';
  }
  if (typeof data.reason === 'string') return data.reason;
  if (typeof data.blockedReason === 'string') return data.blockedReason;
  return event.kind;
}

function signalFor(event: ActivityEvent, revision: number): CriteriaSignal | undefined {
  const data = (event.data ?? {}) as Record<string, unknown>;
  if (data.contractRevision !== revision) return undefined;
  if (!Array.isArray(data.criteria)) return undefined;
  const criteria = criteriaList({ criteria: data.criteria as number[] } as WorkOrder);
  if (criteria.length === 0) return undefined;
  if (event.kind === 'review.recorded' && data.verdict === 'accept') return { pass: true, criteria };
  if (!isFailureEvent(event, data)) return undefined;
  return { pass: false, criteria, reason: failureReasonText(event, data) };
}

/**
 * 从事件流重放「同一条标准上连续几个不同工作项没过」。计数不能活在进程内存里——
 * 重启之后内存空了而事件还在。
 */
export function criteriaFailureStopFor(
  events: readonly ActivityEvent[],
  revision: number,
  criteria: readonly number[],
): CriteriaFailureDiagnostic | undefined {
  // 每条标准各自一条链：「A 上失败、B 上通过」不能把 A 的账算到 B 上。
  const chains = new Map<number, { ids: string[]; reasons: string[] }>();
  for (const event of events) {
    if (event.kind === 'escalation.answered') {
      // 诊断卡被答复：L3 已经给了方向，再拦着等于让他把同一句话再说一遍。
      const data = event.data as
        | { criteriaFailureReset?: unknown; criteria?: unknown; contractRevision?: unknown }
        | undefined;
      if (data?.criteriaFailureReset === true && Array.isArray(data.criteria) && data.contractRevision === revision) {
        for (const n of criteriaList({ criteria: data.criteria as number[] } as WorkOrder)) chains.delete(n);
      }
      continue;
    }
    const signal = signalFor(event, revision);
    if (!signal || event.workItemId === undefined) continue;
    for (const n of signal.criteria) {
      if (signal.pass) {
        // 通过即清零：这条标准上已经有人做成了，之前那串失败是旧事。
        chains.delete(n);
        continue;
      }
      const chain = chains.get(n) ?? { ids: [], reasons: [] };
      // 同一工作项重复失败只占一个位置：一张工单栽三次说明的是工单有问题。
      if (!chain.ids.includes(event.workItemId)) {
        chain.ids.push(event.workItemId);
        chain.reasons.push(signal.reason);
      }
      chains.set(n, chain);
    }
  }
  // 只看这次失败牵动的那几条：别的标准攒够三个是别的一张卡。
  for (const n of criteria) {
    const chain = chains.get(n);
    if (chain && chain.ids.length >= 3) {
      return { criterion: n, workItemIds: [...chain.ids], reasons: [...chain.reasons] };
    }
  }
  return undefined;
}

/**
 * 一个工作项「每次是怎么没的」。取**所有** attempt.ended 而不是最后一次：只报最后一条
 * L3 就看不见较早那次上游失败。只从事件读、不做字符串匹配：failureMessage 是给人读的
 * 一句话，照它猜等于把判定挂在措辞上。
 */
function attemptOutcomeFor(events: readonly ActivityEvent[], workItemId: string): string {
  const ended = events.filter((e) => e.kind === 'attempt.ended' && e.workItemId === workItemId);
  if (ended.length === 0) return '未知（该工作项没有记录到已结束的尝试）';
  const labels: Record<string, string> = {
    upstream_failure: '上游失败（upstream_failure）',
    killed_idle: '被空闲闸掐掉（killed_idle）',
    killed_wall_clock: '被墙钟闸掐掉（killed_wall_clock）',
    quota: '额度用完（quota）',
  };
  return ended
    .map((event) => {
      const data = (event.data ?? {}) as { endedBy?: string; failureMessage?: string };
      const suffix = event.attemptId === undefined ? '' : `（${event.attemptId}）`;
      const label = data.endedBy !== undefined ? (labels[data.endedBy] ?? data.endedBy) : '未记录';
      // failureMessage 是执行者/运行时的原文，可能带 key：进卡之前必须过一遍脱敏。
      const detail = data.failureMessage !== undefined ? redactSecrets(data.failureMessage) : undefined;
      return detail ? `${label}${suffix}：${detail}` : `${label}${suffix}`;
    })
    .join('；');
}

function criteriaText(mission: Mission, criterion: number): string {
  return mission.contract?.acceptance[criterion - 1] ?? '（当前契约没有这一条标准）';
}

/** 卡的正文。标准原文从当前契约取：只写序号等于让 L3 去翻契约。 */
export function criteriaFailureQuestion(mission: Mission, diagnostic: CriteriaFailureDiagnostic): string {
  const lines = diagnostic.workItemIds.map((id, i) => `  ${i + 1}. ${id}：${diagnostic.reasons[i] ?? '（无理由记录）'}`);
  return [
    `验收标准 ${diagnostic.criterion}「${criteriaText(mission, diagnostic.criterion)}」上，`,
    `已经有 ${diagnostic.workItemIds.length} 个不同工作项连续没通过（${diagnostic.workItemIds.join('、')}）。`,
    '这条标准是不是写错了、还是拆得不对？请答复给个方向：',
    ...lines,
  ].join('\n');
}

export function criteriaFailureWhy(diagnostic: CriteriaFailureDiagnostic, events: readonly ActivityEvent[]): string {
  const outcomes = diagnostic.workItemIds.map(
    (id, i) => `  ${i + 1}. ${id} 的结束原因：${attemptOutcomeFor(events, id)}`,
  );
  return [
    `同一条验收标准连续 ${diagnostic.workItemIds.length} 个工作项没通过（打回 / 作废 / 卡住都算），已停派等待答复。`,
    ...outcomes,
  ].join('\n');
}

/** 有没有未答复的诊断卡。只看状态不够：已答复的卡仍留在 mission.escalations 里。 */
export function hasOpenDiagnosticEscalation(mission: Mission, events: readonly ActivityEvent[]): boolean {
  const open = new Set(mission.openEscalations.map((e) => e.question));
  if (open.size === 0) return false;
  return events.some((event) => {
    if (event.kind !== 'escalated') return false;
    const data = event.data as { question?: unknown; criteriaFailure?: unknown } | undefined;
    return data?.criteriaFailure === true && typeof data.question === 'string' && open.has(data.question);
  });
}

/**
 * 这张卡是不是诊断卡；是就返回它管的标准序号。身份只认事件里那个布尔量：
 * EscalationBody 形状已冻结，加不了「我是诊断卡」这一格。question 只用来对上
 * 「是这一张」，不用来猜它的种类。
 */
export function readDiagnosticCriteria(events: readonly ActivityEvent[], question: string): readonly number[] | undefined {
  for (const event of events) {
    if (event.kind !== 'escalated') continue;
    const data = event.data as { question?: unknown; criteriaFailure?: unknown; criteria?: unknown } | undefined;
    if (data?.criteriaFailure !== true || data.question !== question || !Array.isArray(data.criteria)) continue;
    return criteriaList({ criteria: data.criteria as number[] } as WorkOrder);
  }
  return undefined;
}

export function agentWorkItemIndex(
  mission: Mission,
  validationReports?: ReadonlyMap<string, ValidationReportView>,
): readonly AgentWorkItemIndexEntry[] {
  return mission.workItems.map((item) => {
    const validationReport = validationReports?.get(item.id);
    return {
      id: item.id,
      title: item.title,
      status: item.status,
      planRevision: item.planRevision,
      attempts: item.attempts.length,
      attemptIds: item.attempts.map((a) => a.id),
      lastReviewVerdict: item.reviews.at(-1)?.verdict,
      criteria: projectCriteria(item.order),
      ...(validationReport !== undefined ? { validationReport } : {}),
    };
  });
}




export function agentEscalationAnswers(mission: Mission): readonly AgentEscalationAnswer[] {
  return mission.escalations
    .filter((e) => e.answer && e.answeredAt)
    .map((e) => ({ question: e.question, answer: e.answer!, answeredAt: e.answeredAt! }));
}










/**
 * 把一次 attempt 的证据投影成脱敏 + 截尾的摘要。output 一律先 redactSecrets 再截尾——
 * 顺序反了会把截出来的尾巴里的 token 明文露出去。maxTail 控制尾巴长度；summary 过长时按
 * summaryCap 截断、dropCommand 时直接丢弃 command，均为超限时逐步收紧所用。
 */
function agentEvidenceSummary(
  attempts: readonly Readonly<{ id: string; evidence: readonly Readonly<EvidenceRecord>[] }>[],
  maxTail: number,
  opts: { summaryCap?: number; dropCommand?: boolean } = {},
): AgentWorkItemEvidenceSummary[] {
  const out: AgentWorkItemEvidenceSummary[] = [];
  for (const attempt of attempts) {
    for (const e of attempt.evidence) {
      const summary =
        opts.summaryCap !== undefined
          ? capString(redactSecrets(e.summary), opts.summaryCap)
          : redactSecrets(e.summary);
      out.push({
        attemptId: attempt.id,
        kind: e.kind,
        summary,
        command: opts.dropCommand ? undefined : e.command !== undefined ? redactSecrets(e.command) : undefined,
        exitCode: e.exitCode,
        // maxTail=0 必须产出空串：slice(-0) 实际返回整串，会漏掉裁切。
        outputTail: maxTail > 0 ? (e.output !== undefined ? redactSecrets(e.output) : '').slice(-maxTail) : '',
      });
    }
  }
  return out;
}

/** 超长字符串按 n 字符截断并注明被裁掉多少，避免静默丢失"这里有内容"的信息。 */
function capString(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…[truncated ${s.length - n} chars]`;
}

/** 工单里会膨胀的长文本字段按 n 字符上限收紧；contextRefs 是取上下文用的结构，保留。 */
function capOrderText(order: WorkOrder, n: number): WorkOrder {
  return {
    ...order,
    objective: capString(order.objective, n),
    requiredBehaviour: capString(order.requiredBehaviour, n),
    constraints: order.constraints.map((s) => capString(s, n)),
    acceptance: order.acceptance.map((s) => capString(s, n)),
    verification: order.verification.map((s) => capString(s, n)),
    doNot: order.doNot.map((s) => capString(s, n)),
  };
}

/** 执行结果里 summary / notes 会膨胀，按 n 字符上限收紧；文件清单保留为有用结构。 */
function capResultText(result: ExecutionResultBody, n: number): ExecutionResultBody {
  return {
    ...result,
    summary: capString(result.summary, n),
    notes: capString(result.notes, n),
  };
}

/**
 * 构造单项视图并按 20 KB 上限收紧：所有外显文本先深层脱敏（redactSecretsDeep），
 * 之后按 UTF-8 实测大小逐级收紧——先裁证据 output 尾巴，再裁证据 summary/command，
 * 再裁工单 / 执行结果 / 评审 / 历史提交摘要的长文本，始终保留 id/status/orderRevision
 * 与有用结构；仍超大时返回仅含索引字段与历史提交摘要的紧凑 truncated 摘要。
 * 每条 return 前都复核 <=20KB。
 */
export function buildAgentWorkItemView(
  item: WorkItem,
  orderRevision: string | undefined,
  order: WorkOrder | undefined,
  executionResult: ExecutionResultBody | undefined,
  submissionSummaries: readonly AgentWorkItemSubmissionSummary[],
  validationReport: ValidationReportView | undefined,
): AgentWorkItemView {
  // 外显文本先统一深层脱敏：order / executionResult / reviews / title 都可能含凭据。
  const redactedTitle = redactSecrets(item.title);
  const redactedOrder = order !== undefined ? redactSecretsDeep(order) : undefined;
  const redactedSubmissionSummaries = submissionSummaries.map((s) => ({
    ...s,
    orderRevision: s.orderRevision !== undefined ? redactSecrets(s.orderRevision) : undefined,
    note: s.note !== undefined ? redactSecrets(s.note) : undefined,
  }));
  const redactedResult = executionResult !== undefined ? redactSecretsDeep(executionResult) : undefined;
  const reviews = item.reviews.map((r) => ({
    verdict: r.verdict,
    reasons: r.reasons.map((t) => redactSecrets(t)),
    requiredChanges: r.requiredChanges.map((t) => redactSecrets(t)),
  }));

  const byteSize = (v: AgentWorkItemView): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

  // 一条候选视图：证据尾巴 maxTail，summary/command/order/result/reviews 的字符上限可选。
  const build = (
    maxTail: number,
    t: { summaryCap?: number; dropCommand: boolean; orderCap?: number; resultCap?: number; reviewCap?: number },
  ): AgentWorkItemView => {
    const evidenceSummary = agentEvidenceSummary(item.attempts, maxTail, {
      summaryCap: t.summaryCap,
      dropCommand: t.dropCommand,
    });
    const cappedOrder =
      t.orderCap !== undefined && redactedOrder !== undefined ? capOrderText(redactedOrder, t.orderCap) : redactedOrder;
    const cappedResult =
      t.resultCap !== undefined && redactedResult !== undefined
        ? capResultText(redactedResult, t.resultCap)
        : redactedResult;
    const cappedReviews =
      t.reviewCap !== undefined
        ? reviews.map((r) => {
            const cap = t.reviewCap as number;
            return {
              verdict: r.verdict,
              reasons: r.reasons.map((s) => capString(s, cap)),
              requiredChanges: r.requiredChanges.map((s) => capString(s, cap)),
            };
          })
        : reviews;
    return {
      workItemId: item.id,
      title: redactedTitle,
      status: item.status,
      orderRevision,
      order: cappedOrder,
      executionResult: cappedResult,
      reviews: cappedReviews,
      evidenceSummary,
      submissionSummaries: redactedSubmissionSummaries,
      criteria: projectCriteria(order),
      ...(validationReport !== undefined ? { validationReport } : {}),
      truncated: false,
    };
  };

  // 完整（1000 字符尾巴、不裁其它字段）若已在上限内，直接返回、未截断。
  const base = build(1000, { dropCommand: false });
  if (byteSize(base) <= MAX_AGENT_WORK_ITEM_BYTES) return base;

  // 逐级收紧：证据尾巴优先，再依次裁 summary/command、工单、执行结果、评审。每级都复核大小。
  const levels: { summaryCap?: number; dropCommand: boolean; orderCap?: number; resultCap?: number; reviewCap?: number }[] = [
    { dropCommand: false },
    { dropCommand: true, summaryCap: 400 },
    { dropCommand: true, summaryCap: 300, orderCap: 300 },
    { dropCommand: true, summaryCap: 200, orderCap: 200, resultCap: 200 },
    { dropCommand: true, summaryCap: 120, orderCap: 120, resultCap: 120, reviewCap: 120 },
  ];
  for (const lvl of levels) {
    for (const mt of [1000, 500, 250, 100, 0]) {
      const candidate = build(mt, lvl);
      if (byteSize(candidate) <= MAX_AGENT_WORK_ITEM_BYTES) return { ...candidate, truncated: true };
    }
  }

  // 仍超大：只保留索引字段与历史提交摘要的紧凑摘要，明确标 truncated。
  // item.id / orderRevision / 标题 / 历史摘要都可能极长或多到撑爆 20KB，必须按 UTF-8
  // 实测逐级缩减文本并省略最早提交，始终 <= 上限才返回，绝不在上限外返回。
  const buildFallback = (
    workItemId: string,
    title: string,
    orderRevision: string | undefined,
    summaries: readonly AgentWorkItemSubmissionSummary[],
    omitted: number,
  ): AgentWorkItemView => ({
    workItemId,
    title,
    status: item.status,
    orderRevision,
    criteria: projectCriteria(order),
    order: undefined,
    executionResult: undefined,
    reviews: [],
    evidenceSummary: [],
    submissionSummaries:
      omitted > 0
        ? [
            ...summaries,
            {
              at: '',
              outcome: undefined,
              changedFiles: undefined,
              orderRevision: undefined,
              isLatest: false,
              note: `另有 ${omitted} 条较早的历史提交摘要已省略（受 20KB 上限约束）`,
            },
          ]
        : summaries,
    truncated: true,
  });

  // 逐级收紧：先压各摘要文本、再删最早提交、再压标题、最后压 id/orderRevision，
  // 每步都以 Buffer.byteLength(JSON.stringify(...),'utf8') 实测复核 <=20KB。
  let idCap = Math.max(0, Math.floor(MAX_AGENT_WORK_ITEM_BYTES / 4));
  let revCap = Math.max(0, Math.floor(MAX_AGENT_WORK_ITEM_BYTES / 4));
  let titleCap = Math.max(0, Math.floor(MAX_AGENT_WORK_ITEM_BYTES / 4));
  let sumCap = Math.max(0, Math.floor(MAX_AGENT_WORK_ITEM_BYTES / 8));
  let summaries = redactedSubmissionSummaries;
  const tryFallback = (): AgentWorkItemView =>
    buildFallback(
      capString(item.id, idCap),
      capString(redactedTitle, titleCap),
      orderRevision !== undefined ? capString(orderRevision, revCap) : undefined,
      summaries.map((s) => ({
        ...s,
        at: capString(s.at, sumCap),
        outcome: s.outcome !== undefined ? capString(s.outcome, sumCap) : undefined,
        orderRevision: s.orderRevision !== undefined ? capString(s.orderRevision, sumCap) : undefined,
        note: s.note !== undefined ? capString(s.note, sumCap) : undefined,
      })),
      redactedSubmissionSummaries.length - summaries.length,
    );
  // 循环每轮都实测整个候选对象大小；收敛到 <= 上限即退出，绝不在上限外返回。
  // 优先级：压摘要文本 -> 删最早一半提交 -> 压标题 -> 压 id/orderRevision。
  let guard = 0;
  while (byteSize(tryFallback()) > MAX_AGENT_WORK_ITEM_BYTES && guard < 10000) {
    guard++;
    if (sumCap > 1) {
      sumCap = Math.max(1, Math.floor(sumCap / 2));
    } else if (summaries.length > 1) {
      // 摘要字段已压到极限仍超，删最早一半（数组末尾为最新，保留最新）。
      summaries = summaries.slice(Math.ceil(summaries.length / 2));
    } else if (titleCap > 1) {
      titleCap = Math.max(1, Math.floor(titleCap / 2));
    } else if (idCap > 1 || revCap > 1) {
      idCap = Math.max(1, Math.floor(idCap / 2));
      revCap = Math.max(1, Math.floor(revCap / 2));
    } else {
      // 一切字段已 clip 到 1 字符、历史也已清空，理论上不可能仍超；兜底跳出。
      break;
    }
  }
  return tryFallback();
}

