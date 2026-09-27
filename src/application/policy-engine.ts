/**
 * 声明式授权判定。
 *
 * 为什么独立成纯函数：认证（解析凭据）和授权（这个身份能不能做这件事）混在
 * 入口里时，拒绝理由会随调用点分叉，HA 放行也会变成 CLI 字符串约定。
 * 不读时钟、不碰存储——过期是调用方已经认定的输入，TTL 策略不属于这里。
 */

export const POLICY_REASON = {
  ALLOWED: 'ALLOWED',
  PRINCIPAL_MISSING: 'PRINCIPAL_MISSING',
  PRINCIPAL_EXPIRED: 'PRINCIPAL_EXPIRED',
  PRINCIPAL_UNKNOWN_ROLE: 'PRINCIPAL_UNKNOWN_ROLE',
  ACTION_UNKNOWN: 'ACTION_UNKNOWN',
  ACTION_DENIED: 'ACTION_DENIED',
  BINDING_MISMATCH: 'BINDING_MISMATCH',
  HA_SIDE_EFFECT_DENIED: 'HA_SIDE_EFFECT_DENIED',
  HA_MACHINE_FINALIZE_DENIED: 'HA_MACHINE_FINALIZE_DENIED',
} as const;

export type PolicyReasonCode = (typeof POLICY_REASON)[keyof typeof POLICY_REASON];

export interface PolicyReason {
  readonly code: PolicyReasonCode;
  readonly detail: string;
}

export interface PolicyVerdict {
  readonly decision: 'allow' | 'deny';
  readonly reason: PolicyReason;
}

export type PrincipalKind =
  | 'user'
  | 'reviewer'
  | 'runner'
  | 'coordinator'
  | 'executor'
  | 'independent_reviewer';

export type PolicyPrincipal =
  | { readonly status: 'missing' }
  | { readonly status: 'expired' }
  | {
      readonly status: 'ok';
      /** 运行时可能是未知角色；未知一律 deny，不默许放行。 */
      readonly kind: string;
      readonly id: string;
      /** user 才有意义：operator | viewer。其它 kind 忽略。 */
      readonly role?: string;
      readonly missionId?: string;
      readonly attemptId?: string;
      readonly workItemId?: string;
    };

export type ActionScope = 'mission' | 'workItem' | 'attempt' | 'pool' | 'inbox' | 'finalize';

export interface PolicyAction {
  readonly scope: ActionScope;
  readonly name: string;
}

export interface PolicyContext {
  readonly missionId?: string;
  readonly attemptId?: string;
  readonly workItemId?: string;
}

export interface PolicyHaSideEffects {
  readonly productionDeployRelease?: boolean;
  readonly externalPaidOp?: boolean;
  readonly unrecoverableExternalSideEffect?: boolean;
  readonly destructiveData?: boolean;
}

export interface PolicyState {
  readonly executionMode?: 'lightweight' | 'standard' | 'high_assurance';
  readonly haSideEffects?: PolicyHaSideEffects;
}

export interface PolicyInput {
  readonly principal: PolicyPrincipal;
  readonly action: PolicyAction;
  readonly context?: PolicyContext;
  readonly state?: PolicyState;
}

/** 已存在动作的稳定名字。未列入的 name 一律 ACTION_UNKNOWN。 */
export const POLICY_ACTION = {
  missionRead: { scope: 'mission', name: 'read' },
  missionCreate: { scope: 'mission', name: 'create' },
  missionCreateClassified: { scope: 'mission', name: 'createClassified' },
  missionRevise: { scope: 'mission', name: 'revise' },
  missionPause: { scope: 'mission', name: 'pause' },
  missionResume: { scope: 'mission', name: 'resume' },
  missionCancel: { scope: 'mission', name: 'cancel' },
  missionAnswerEscalation: { scope: 'mission', name: 'answerEscalation' },
  workItemCreate: { scope: 'workItem', name: 'create' },
  workItemRetire: { scope: 'workItem', name: 'retire' },
  workItemDispatch: { scope: 'workItem', name: 'dispatch' },
  workItemReview: { scope: 'workItem', name: 'review' },
  workItemGetOrder: { scope: 'workItem', name: 'getOrder' },
  attemptStartCoordinator: { scope: 'attempt', name: 'startCoordinator' },
  attemptStartExecutor: { scope: 'attempt', name: 'startExecutor' },
  attemptStartIndependentReviewer: { scope: 'attempt', name: 'startIndependentReviewer' },
  attemptFinish: { scope: 'attempt', name: 'finish' },
  attemptGetBrief: { scope: 'attempt', name: 'getBrief' },
  attemptGetDetail: { scope: 'attempt', name: 'getDetail' },
  attemptUpdateFindings: { scope: 'attempt', name: 'updateFindings' },
  attemptUpdatePlan: { scope: 'attempt', name: 'updatePlan' },
  attemptEscalate: { scope: 'attempt', name: 'escalate' },
  attemptSubmitMissionResult: { scope: 'attempt', name: 'submitMissionResult' },
  attemptGetContext: { scope: 'attempt', name: 'getContext' },
  attemptSubmitEvidence: { scope: 'attempt', name: 'submitEvidence' },
  attemptSubmitExecutionResult: { scope: 'attempt', name: 'submitExecutionResult' },
  attemptReportBlocked: { scope: 'attempt', name: 'reportBlocked' },
  attemptGetReviewBundle: { scope: 'attempt', name: 'getReviewBundle' },
  attemptSubmitIndependentReview: { scope: 'attempt', name: 'submitIndependentReview' },
  poolList: { scope: 'pool', name: 'list' },
  poolAdd: { scope: 'pool', name: 'add' },
  inboxRead: { scope: 'inbox', name: 'read' },
  inboxAck: { scope: 'inbox', name: 'ack' },
  finalizeHuman: { scope: 'finalize', name: 'human' },
  finalizeMachine: { scope: 'finalize', name: 'machine' },
  finalizePlan: { scope: 'finalize', name: 'plan' },
  finalizeReviewer: { scope: 'finalize', name: 'reviewer' },
  /** HA 受控放行：仍是 reviewer Principal，与旧 reviewer 入口分开，避免旧入口被当成已授权。 */
  finalizeHaReviewer: { scope: 'finalize', name: 'haReviewer' },
} as const satisfies Record<string, PolicyAction>;

const KNOWN_ACTIONS = new Set(
  Object.values(POLICY_ACTION).map((action) => actionKey(action)),
);

type RoleKey =
  | 'user:operator'
  | 'user:viewer'
  | 'reviewer'
  | 'runner'
  | 'coordinator'
  | 'executor'
  | 'independent_reviewer';

const PRINCIPAL_KINDS = new Set<string>([
  'user',
  'reviewer',
  'runner',
  'coordinator',
  'executor',
  'independent_reviewer',
]);

/**
 * 允许矩阵。只覆盖已经存在的入口；不在表里的组合是 ACTION_DENIED。
 * 不把「将来 HA 可能要开」的格子先写成 allow。
 */
const ALLOWED: ReadonlySet<string> = new Set([
  // —— user / operator：控制面写 + 敏感读 ——
  cell('user:operator', POLICY_ACTION.missionRead),
  cell('user:operator', POLICY_ACTION.missionCreate),
  cell('user:operator', POLICY_ACTION.missionCreateClassified),
  cell('user:operator', POLICY_ACTION.missionRevise),
  cell('user:operator', POLICY_ACTION.missionPause),
  cell('user:operator', POLICY_ACTION.missionResume),
  cell('user:operator', POLICY_ACTION.missionCancel),
  cell('user:operator', POLICY_ACTION.missionAnswerEscalation),
  cell('user:operator', POLICY_ACTION.attemptStartCoordinator),
  cell('user:operator', POLICY_ACTION.attemptStartExecutor),
  cell('user:operator', POLICY_ACTION.attemptStartIndependentReviewer),
  cell('user:operator', POLICY_ACTION.attemptFinish),
  cell('user:operator', POLICY_ACTION.attemptGetDetail),
  cell('user:operator', POLICY_ACTION.poolList),
  cell('user:operator', POLICY_ACTION.poolAdd),
  cell('user:operator', POLICY_ACTION.inboxRead),
  cell('user:operator', POLICY_ACTION.inboxAck),
  cell('user:operator', POLICY_ACTION.finalizeHuman),
  // —— user / viewer：只读 ——
  cell('user:viewer', POLICY_ACTION.missionRead),
  cell('user:viewer', POLICY_ACTION.attemptGetDetail),
  cell('user:viewer', POLICY_ACTION.poolList),
  cell('user:viewer', POLICY_ACTION.inboxRead),
  // —— reviewer：旧签名终审 + HA 受控放行（授权仍由外置配置在入口核对） ——
  cell('reviewer', POLICY_ACTION.finalizeReviewer),
  cell('reviewer', POLICY_ACTION.finalizeHaReviewer),
  // —— runner：编排自身（机器终审、方案放弃） ——
  cell('runner', POLICY_ACTION.finalizeMachine),
  cell('runner', POLICY_ACTION.finalizePlan),
  // —— coordinator：Run Token 绑定的 Mission / Attempt ——
  cell('coordinator', POLICY_ACTION.missionRead),
  cell('coordinator', POLICY_ACTION.workItemCreate),
  cell('coordinator', POLICY_ACTION.workItemRetire),
  cell('coordinator', POLICY_ACTION.workItemDispatch),
  cell('coordinator', POLICY_ACTION.workItemReview),
  cell('coordinator', POLICY_ACTION.attemptGetBrief),
  cell('coordinator', POLICY_ACTION.attemptUpdateFindings),
  cell('coordinator', POLICY_ACTION.attemptUpdatePlan),
  cell('coordinator', POLICY_ACTION.attemptEscalate),
  cell('coordinator', POLICY_ACTION.attemptSubmitMissionResult),
  cell('coordinator', POLICY_ACTION.attemptGetContext),
  // —— executor：Run Token 绑定的 Mission / Attempt / WorkItem ——
  cell('executor', POLICY_ACTION.missionRead),
  cell('executor', POLICY_ACTION.workItemGetOrder),
  cell('executor', POLICY_ACTION.attemptGetBrief),
  cell('executor', POLICY_ACTION.attemptGetContext),
  cell('executor', POLICY_ACTION.attemptSubmitEvidence),
  cell('executor', POLICY_ACTION.attemptSubmitExecutionResult),
  cell('executor', POLICY_ACTION.attemptReportBlocked),
  // —— independent_reviewer：Run Token 绑定的 Mission / Attempt；与终审 reviewer 分开 ——
  cell('independent_reviewer', POLICY_ACTION.attemptGetReviewBundle),
  cell('independent_reviewer', POLICY_ACTION.attemptSubmitIndependentReview),
]);

const HA_SIDE_EFFECT_FLAGS = [
  'productionDeployRelease',
  'externalPaidOp',
  'unrecoverableExternalSideEffect',
  'destructiveData',
] as const;

/** agent 工具 → 已存在动作。请求体里的角色字段不参与这张表。 */
export const AGENT_TOOL_ACTION: Readonly<Record<string, PolicyAction>> = {
  coagent_get_mission: POLICY_ACTION.missionRead,
  coagent_get_contract: POLICY_ACTION.missionRead,
  coagent_get_project_context: POLICY_ACTION.missionRead,
  coagent_update_findings: POLICY_ACTION.attemptUpdateFindings,
  coagent_update_plan: POLICY_ACTION.attemptUpdatePlan,
  coagent_create_work_item: POLICY_ACTION.workItemCreate,
  coagent_retire_work_item: POLICY_ACTION.workItemRetire,
  coagent_dispatch_work_item: POLICY_ACTION.workItemDispatch,
  coagent_review_execution_result: POLICY_ACTION.workItemReview,
  coagent_escalate_to_l3: POLICY_ACTION.attemptEscalate,
  coagent_submit_mission_result: POLICY_ACTION.attemptSubmitMissionResult,
  coagent_get_work_order: POLICY_ACTION.workItemGetOrder,
  coagent_get_context: POLICY_ACTION.attemptGetContext,
  coagent_submit_evidence: POLICY_ACTION.attemptSubmitEvidence,
  coagent_submit_execution_result: POLICY_ACTION.attemptSubmitExecutionResult,
  coagent_report_blocked: POLICY_ACTION.attemptReportBlocked,
  coagent_get_mission_review_bundle: POLICY_ACTION.attemptGetReviewBundle,
  coagent_submit_independent_review: POLICY_ACTION.attemptSubmitIndependentReview,
};

export function evaluatePolicy(input: PolicyInput): PolicyVerdict {
  const principal = input.principal;
  if (principal.status === 'missing') {
    return deny(POLICY_REASON.PRINCIPAL_MISSING, '身份缺失或未知，默认拒绝。');
  }
  if (principal.status === 'expired') {
    return deny(POLICY_REASON.PRINCIPAL_EXPIRED, '身份已过期，默认拒绝。');
  }
  if (principal.status !== 'ok' || !PRINCIPAL_KINDS.has(principal.kind)) {
    return deny(POLICY_REASON.PRINCIPAL_UNKNOWN_ROLE, `未知角色 ${String((principal as { kind?: unknown }).kind)}，默认拒绝。`);
  }
  if (principal.kind === 'user') {
    if (principal.role !== 'operator' && principal.role !== 'viewer') {
      return deny(
        POLICY_REASON.PRINCIPAL_UNKNOWN_ROLE,
        `未知控制面角色 ${String(principal.role)}，默认拒绝。`,
      );
    }
  }

  if (!KNOWN_ACTIONS.has(actionKey(input.action))) {
    return deny(
      POLICY_REASON.ACTION_UNKNOWN,
      `未知动作 ${input.action.scope}.${input.action.name}，默认拒绝。`,
    );
  }

  const sideEffects = flaggedHaSideEffects(input.state?.haSideEffects);
  if (sideEffects.length > 0 && isHaSideEffectRestricted(input.action)) {
    return deny(
      POLICY_REASON.HA_SIDE_EFFECT_DENIED,
      `带外部副作用的 HA（${sideEffects.join(', ')}）首版一律拒绝。`,
    );
  }

  if (
    input.action.scope === 'finalize' &&
    input.action.name === 'machine' &&
    input.state?.executionMode === 'high_assurance'
  ) {
    return deny(
      POLICY_REASON.HA_MACHINE_FINALIZE_DENIED,
      'high_assurance 不得由机器 L3 放行。',
    );
  }

  const role = roleKey(principal);
  if (!role) {
    return deny(POLICY_REASON.PRINCIPAL_UNKNOWN_ROLE, '无法归入已知 Principal，默认拒绝。');
  }
  if (!ALLOWED.has(cell(role, input.action))) {
    return deny(
      POLICY_REASON.ACTION_DENIED,
      `${role} 不能执行 ${input.action.scope}.${input.action.name}。`,
    );
  }

  if (bindingMismatch(principal, input.action, input.context)) {
    return deny(
      POLICY_REASON.BINDING_MISMATCH,
      'Principal 与 Mission / Attempt / WorkItem 绑定不一致。',
    );
  }

  return allow(`${role} 允许 ${input.action.scope}.${input.action.name}。`);
}

export function principalFromControl(
  resolved: { readonly id: string; readonly role: string } | { readonly status: 'expired' } | undefined,
): PolicyPrincipal {
  if (!resolved) return { status: 'missing' };
  if ('status' in resolved && resolved.status === 'expired') return { status: 'expired' };
  return { status: 'ok', kind: 'user', id: resolved.id, role: resolved.role };
}

export function principalFromRun(run: {
  readonly role: 'coordinator' | 'executor' | 'independent_reviewer';
  readonly missionId: string;
  readonly attemptId: string;
  readonly workItemId?: string;
}): PolicyPrincipal {
  // id 用 attemptId：token 本身是凭据，不能进判定记录。
  return {
    status: 'ok',
    kind: run.role,
    id: run.attemptId,
    missionId: run.missionId,
    attemptId: run.attemptId,
    ...(run.workItemId !== undefined ? { workItemId: run.workItemId } : {}),
  };
}

function allow(detail: string): PolicyVerdict {
  return { decision: 'allow', reason: { code: POLICY_REASON.ALLOWED, detail } };
}

function deny(code: PolicyReasonCode, detail: string): PolicyVerdict {
  return { decision: 'deny', reason: { code, detail } };
}

function actionKey(action: PolicyAction): string {
  return `${action.scope}.${action.name}`;
}

function cell(role: RoleKey, action: PolicyAction): string {
  return `${role}|${actionKey(action)}`;
}

function roleKey(principal: Extract<PolicyPrincipal, { status: 'ok' }>): RoleKey | undefined {
  if (principal.kind === 'user') {
    if (principal.role === 'operator' || principal.role === 'viewer') {
      return `user:${principal.role}`;
    }
    return undefined;
  }
  if (
    principal.kind === 'reviewer' ||
    principal.kind === 'runner' ||
    principal.kind === 'coordinator' ||
    principal.kind === 'executor' ||
    principal.kind === 'independent_reviewer'
  ) {
    return principal.kind;
  }
  return undefined;
}

function flaggedHaSideEffects(flags: PolicyHaSideEffects | undefined): string[] {
  if (!flags) return [];
  return HA_SIDE_EFFECT_FLAGS.filter((key) => flags[key] === true);
}

function isHaSideEffectRestricted(action: PolicyAction): boolean {
  if (action.scope === 'finalize') return true;
  return action.scope === 'mission' && action.name === 'createClassified';
}

function bindingMismatch(
  principal: Extract<PolicyPrincipal, { status: 'ok' }>,
  action: PolicyAction,
  context: PolicyContext | undefined,
): boolean {
  if (
    principal.kind !== 'coordinator' &&
    principal.kind !== 'executor' &&
    principal.kind !== 'independent_reviewer'
  ) {
    return false;
  }
  if (!needsResourceBinding(action)) return false;
  const ctx = context ?? {};
  if (mismatch(principal.missionId, ctx.missionId)) return true;
  if (mismatch(principal.attemptId, ctx.attemptId)) return true;
  if (principal.kind === 'executor' && actionBindsWorkItem(action)) {
    if (mismatch(principal.workItemId, ctx.workItemId)) return true;
  }
  return false;
}

function needsResourceBinding(action: PolicyAction): boolean {
  return action.scope === 'mission' || action.scope === 'workItem' || action.scope === 'attempt';
}

function actionBindsWorkItem(action: PolicyAction): boolean {
  return action.scope === 'workItem' || action.scope === 'attempt';
}

function mismatch(bound: string | undefined, requested: string | undefined): boolean {
  // 两边都缺：无法证明匹配。一边缺、一边有：也不匹配。
  if (bound === undefined || requested === undefined) return true;
  return bound !== requested;
}
