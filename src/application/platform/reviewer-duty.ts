import { PlatformContext, PlatformRuleError } from './context.ts';

export const REVIEWER_DUTY_LEASE_MS = 5 * 60_000;
export interface ReviewerDuty {
  projectId: string;
  owner: string;
  generation: number;
  expiresAt: string;
  released: boolean;
  active: boolean;
}
export interface DutyCommand {
  action: 'claim' | 'renew' | 'release' | 'handoff';
  owner: string;
  generation?: number;
  nextOwner?: string;
}

/** 主状态仓储的事务序列化 claim；事件同时承担持久租约，不另设第二写者。 */
export async function getReviewerDuty(ctx: PlatformContext, projectId: string): Promise<ReviewerDuty | undefined> {
  const events = await ctx.activity.all();
  const last = events.filter((event) => event.projectId === projectId && event.kind === 'reviewer.duty_changed').at(-1);
  if (!last) return undefined;
  const row = last.data as Omit<ReviewerDuty, 'active'>;
  return { projectId: row.projectId, owner: row.owner, generation: row.generation, expiresAt: row.expiresAt,
    released: row.released, active: !row.released && Date.parse(row.expiresAt) > ctx.clock.now().getTime() };
}

export async function changeReviewerDuty(ctx: PlatformContext, projectId: string, input: DutyCommand): Promise<ReviewerDuty> {
  if (typeof input.owner !== 'string' || !input.owner.trim() || !['claim', 'renew', 'release', 'handoff'].includes(input.action)) {
    throw new PlatformRuleError('INVALID_DUTY_COMMAND', '值守操作需要非空 owner 和有效 action。');
  }
  const project = await ctx.projects.get(projectId);
  const mission = project?.missions[0];
  if (!mission) throw new PlatformRuleError('DUTY_PROJECT_NOT_READY', '值守项目需要至少一条 Mission 作为持久审计锚点。');
  const previous = await getReviewerDuty(ctx, projectId);
  const owner = input.owner.trim();
  if (input.action === 'claim' && previous?.active) {
    if (previous.owner === owner) return previous;
    throw new PlatformRuleError('REVIEWER_DUTY_BUSY', '项目已有有效值守会话，请由当前会话交接或等待租约到期。');
  }
  if (input.action !== 'claim' && (!previous?.active || previous.owner !== owner || previous.generation !== input.generation)) {
    throw new PlatformRuleError('REVIEWER_DUTY_STALE', '值守租约已失效或代次不符，旧会话不得续约或操作。');
  }
  if (input.action === 'handoff' && (typeof input.nextOwner !== 'string' || !input.nextOwner.trim())) {
    throw new PlatformRuleError('INVALID_DUTY_COMMAND', '交接需要非空 nextOwner。');
  }
  const now = ctx.clock.now().getTime();
  const changed: Omit<ReviewerDuty, 'active'> = { projectId,
    owner: input.action === 'handoff' ? input.nextOwner!.trim() : owner,
    generation: input.action === 'claim' || input.action === 'handoff' ? (previous?.generation ?? 0) + 1 : previous!.generation,
    expiresAt: new Date(input.action === 'release' ? now : now + REVIEWER_DUTY_LEASE_MS).toISOString(),
    released: input.action === 'release' };
  await ctx.event(mission, 'reviewer.duty_changed', { ...changed, action: input.action, changedBy: owner });
  return { ...changed, active: !changed.released };
}

export async function requireReviewerDuty(ctx: PlatformContext, projectId: string, owner: string, generation: number): Promise<void> {
  const current = await getReviewerDuty(ctx, projectId);
  if (!current?.active || current.owner !== owner || current.generation !== generation) {
    throw new PlatformRuleError('REVIEWER_DUTY_STALE', '值守已交接或到期，请退出旧守候。');
  }
}
