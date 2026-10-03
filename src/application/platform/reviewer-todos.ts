import type { Mission } from '../../kernel/index.ts';
import type { ActivityEvent } from '../ports.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import { listDocumentProposals } from './document-queue.ts';

export type ReviewerTodoKind = 'question' | 'diagnostic' | 'cost_cap' | 'checkpoint' | 'result' | 'documentation';
export interface ReviewerTodo {
  id: string;
  projectId: string;
  missionId: string;
  kind: ReviewerTodoKind;
  title: string;
  at: string;
  blocking: boolean;
  state: 'open' | 'acknowledged' | 'waiting_user';
  notify: boolean;
}
export interface ReviewerTodoDecision {
  action: 'acknowledge' | 'wait_user' | 'reopen';
  reviewer: string;
  reason: string;
}

function sourceTodos(mission: Mission, events: readonly ActivityEvent[]): ReviewerTodo[] {
  const rows: ReviewerTodo[] = [];
  const add = (suffix: string, kind: ReviewerTodoKind, title: string, at: string, blocking: boolean) => {
    rows.push({ id: `${mission.id}:${suffix}`, projectId: mission.projectId, missionId: mission.id,
      kind, title, at, blocking, state: 'open', notify: true });
  };
  const queueFailure = events.filter((event) => event.kind === 'mission.queue_failed').at(-1);
  if (queueFailure && mission.isPaused) add(`queue_failure:${events.lastIndexOf(queueFailure)}`, 'diagnostic', String((queueFailure.data as { reason?: string }).reason ?? 'Mission 队列启动失败'), queueFailure.at, true);
  mission.escalations.forEach((entry, index) => {
    if (entry.answeredAt) return;
    const opened = events.filter((event) => event.kind === 'escalation.opened')[index];
    const diagnostic = opened?.data && typeof opened.data === 'object'
      && (opened.data as { criteriaFailure?: boolean }).criteriaFailure === true;
    const kind = entry.platformGate?.kind === 'cost_cap' ? 'cost_cap'
      : entry.platformGate?.kind === 'work_item_checkpoint' ? 'checkpoint'
      : diagnostic ? 'diagnostic' : 'question';
    add(`escalation:${index}`, kind, entry.question, opened?.at ?? mission.updatedAt ?? '', true);
  });
  const submission = events.filter((event) => event.kind === 'mission_result.submitted').at(-1);
  if (mission.result && submission) {
    // messageId / attemptId 固定于那次提交，确认不因其它活动更新而失效。
    const ref = submission.messageId ?? submission.attemptId ?? submission.at;
    add(`result:${ref}`, 'result', mission.result.summary, submission.at, mission.status === 'awaiting_review');
  }
  return rows;
}

function applyDecisions(rows: ReviewerTodo[], mission: Mission, events: readonly ActivityEvent[]): void {
  const states = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== 'reviewer.todo_decided' || !event.data || typeof event.data !== 'object') continue;
    const data = event.data as { todoId?: string; action?: string };
    if (data.todoId && data.action) states.set(data.todoId, data.action);
  }
  for (const row of rows) {
    const action = states.get(row.id);
    if (action === 'acknowledge') row.state = 'acknowledged';
    if (action === 'wait_user' && (mission.isParked || row.kind === 'documentation')) row.state = 'waiting_user';
    if (mission.isParked && [...states.values()].includes('wait_user') && row.state === 'open') row.state = 'waiting_user';
    row.notify = row.state === 'open';
  }
}

/** 从领域与持久事件重建待办；读取不消费 Delivery。 */
export async function listReviewerTodos(ctx: PlatformContext, projectId?: string): Promise<ReviewerTodo[]> {
  const rows: ReviewerTodo[] = [];
  for (const project of await ctx.projects.list()) {
    if (projectId && project.id !== projectId) continue;
    for (const mission of project.missions) {
      const events = await ctx.activity.list(mission.id);
      const current = sourceTodos(mission, events);
      applyDecisions(current, mission, events);
      rows.push(...current);
    }
  }
  for (const proposal of await listDocumentProposals(ctx, projectId)) {
    if (proposal.state === 'withdrawn' || proposal.state === 'committed') continue;
    const row: ReviewerTodo = { id: `${proposal.id}:revision:${proposal.revision}`, projectId: proposal.projectId, missionId: proposal.missionId,
      kind: 'documentation', title: proposal.title, at: proposal.at, blocking: false,
      state: proposal.state === 'approved' ? 'acknowledged' : 'open', notify: proposal.state !== 'approved' };
    const { mission } = await ctx.locate(proposal.missionId);
    applyDecisions([row], mission, await ctx.activity.list(mission.id));
    rows.push(row);
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}

export async function decideReviewerTodo(ctx: PlatformContext,
  park: (missionId: string, input: { reviewer: string; reason: string }) => Promise<unknown>,
  todoId: string, input: ReviewerTodoDecision): Promise<ReviewerTodo> {
  if (!['acknowledge', 'wait_user', 'reopen'].includes(input.action)
      || typeof input.reviewer !== 'string' || !input.reviewer.trim()
      || typeof input.reason !== 'string' || !input.reason.trim()) {
    throw new PlatformRuleError('INVALID_TODO_DECISION', '待办操作需要有效 action、reviewer 和 reason。');
  }
  const row = (await listReviewerTodos(ctx)).find((entry) => entry.id === todoId);
  if (!row) throw new PlatformRuleError('REVIEWER_TODO_NOT_FOUND', '待办已解决或不存在，请刷新。');
  const { mission } = await ctx.locate(row.missionId);
  if (input.action === 'acknowledge' && row.state === 'acknowledged') return row;
  if (input.action === 'reopen' && mission.isParked && row.kind !== 'documentation') {
    throw new PlatformRuleError('TODO_MISSION_PARKED', '请先经 parked-resume 同步基线并恢复 Mission，再重开待办。');
  }
  if (input.action === 'wait_user' && row.kind !== 'documentation') await park(mission.id, input);
  // park 可能保存后重建聚合，重新定位再记事件，避免旧对象覆盖。
  const current = await ctx.locate(mission.id);
  await ctx.event(current.mission, 'reviewer.todo_decided', { todoId, ...input,
    reviewer: input.reviewer.trim(), reason: input.reason.trim() });
  return (await listReviewerTodos(ctx)).find((entry) => entry.id === todoId)!;
}
