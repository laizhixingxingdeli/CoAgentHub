/**
 * Direct 主控命令的判别联合与入参解析。
 *
 * 只做形状解析：顶层字段白名单、必填项、类型；不发 id、不改 state、不碰业务门禁。
 * WorkOrder 只核必填形状，`validation.commands` 的深层规整交给 kernel 冻结时的 normalize。
 */
import type {
  AcceptanceResult,
  MissionResultBody,
  PlanBody,
  WorkOrder,
} from '../../kernel/index.ts';
import { PlatformRuleError } from './context.ts';

/** direct 主控命令的判别联合。形状固定，新增 action 必须在这里登记。 */
export type DirectControlCommand =
  | { readonly action: 'plan'; readonly plan: PlanBody }
  | {
      readonly action: 'contract_check';
      readonly check: {
        readonly verdict: 'ok' | 'issues';
        readonly summary: string;
        readonly issues?: readonly string[];
      };
    }
  | {
      readonly action: 'create_work_item';
      readonly title: string;
      readonly order: WorkOrder;
      readonly workItemId?: string;
    }
  | {
      readonly action: 'revise_work_order';
      readonly workItemId: string;
      readonly order: WorkOrder;
    }
  | { readonly action: 'dispatch'; readonly workItemIds: readonly string[] }
  | {
      readonly action: 'review';
      readonly workItemId: string;
      readonly verdict: 'accept' | 'reject';
      readonly reasons: readonly string[];
      readonly requiredChanges: readonly string[];
      readonly acceptanceResults?: readonly AcceptanceResult[];
    }
  | { readonly action: 'submit'; readonly result: MissionResultBody };

type PlainObject = Record<string, unknown>;
type Action = DirectControlCommand['action'];

/** 每个 action 允许出现的顶层键。身份与代次字段（actor / attemptId / usage / passed …）都不在表里。 */
const ALLOWED_FIELDS: Readonly<Record<Action, readonly string[]>> = {
  plan: ['action', 'plan'],
  contract_check: ['action', 'check'],
  create_work_item: ['action', 'title', 'order', 'workItemId'],
  revise_work_order: ['action', 'workItemId', 'order'],
  dispatch: ['action', 'workItemIds'],
  review: ['action', 'workItemId', 'verdict', 'reasons', 'requiredChanges', 'acceptanceResults'],
  submit: ['action', 'result'],
};

const ORDER_STRING_FIELDS = ['objective', 'requiredBehaviour'] as const;
const ORDER_STRING_LIST_FIELDS = [
  'allowedScope',
  'constraints',
  'acceptance',
  'verification',
  'doNot',
] as const;

const ACCEPTANCE_STATUSES: readonly string[] = ['pass', 'fail', 'unverified', 'not_applicable'];

/** 与 kernel 的 `ContextRefKind` 对齐；带类型的引用只认这几类。 */
const CONTEXT_REF_KINDS: readonly string[] = [
  'file',
  'living_spec',
  'adr',
  'contract',
  'decision',
  'artifact',
  'previous_result',
];

/** 报错只带字段名，不回显输入值。 */
function fail(field: string): never {
  throw new PlatformRuleError('INVALID_DIRECT_COMMAND', `无效主控命令：${field}`);
}

function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireObject(value: unknown, field: string): PlainObject {
  if (!isPlainObject(value)) fail(field);
  return value;
}

function requireString(value: unknown, field: string, nonEmpty = false): string {
  if (typeof value !== 'string') fail(field);
  if (nonEmpty && value.trim().length === 0) fail(field);
  return value;
}

function requireStringArray(value: unknown, field: string, nonEmpty = false): readonly string[] {
  if (!Array.isArray(value)) fail(field);
  for (const item of value) {
    if (typeof item !== 'string') fail(field);
    if (nonEmpty && item.trim().length === 0) fail(field);
  }
  if (nonEmpty && value.length === 0) fail(field);
  return value as readonly string[];
}

function parsePlan(value: unknown): void {
  const plan = requireObject(value, 'plan');
  requireString(plan.findings, 'plan.findings');
  requireString(plan.direction, 'plan.direction');
  requireStringArray(plan.rejectedHypotheses, 'plan.rejectedHypotheses');
  requireStringArray(plan.decisions, 'plan.decisions');
  requireStringArray(plan.risks, 'plan.risks');
  if (plan.rootCause !== undefined) requireString(plan.rootCause, 'plan.rootCause');
}

function parseCheck(value: unknown): void {
  const check = requireObject(value, 'check');
  if (check.verdict !== 'ok' && check.verdict !== 'issues') fail('check.verdict');
  requireString(check.summary, 'check.summary', true);
  if (check.issues !== undefined) requireStringArray(check.issues, 'check.issues');
}

/**
 * `contextRefs` 是 `(string | ContextRef)[]`，但 direct 命令只收带类型的对象：
 * 裸字符串没法表达 kind，放进来等于让下游猜。空数组仍合法。
 */
function parseContextRefs(value: unknown): void {
  if (!Array.isArray(value)) fail('order.contextRefs');
  for (const item of value) {
    const ref = requireObject(item, 'order.contextRefs');
    if (typeof ref.kind !== 'string' || !CONTEXT_REF_KINDS.includes(ref.kind)) {
      fail('order.contextRefs.kind');
    }
    requireString(ref.ref, 'order.contextRefs.ref', true);
    if (ref.why !== undefined) requireString(ref.why, 'order.contextRefs.why');
  }
}

function parseOrder(value: unknown): void {
  const order = requireObject(value, 'order');
  for (const field of ORDER_STRING_FIELDS) requireString(order[field], `order.${field}`);
  for (const field of ORDER_STRING_LIST_FIELDS) requireStringArray(order[field], `order.${field}`);
  parseContextRefs(order.contextRefs);
  if (order.validation !== undefined) requireObject(order.validation, 'order.validation');
}

function parseCreateWorkItem(body: PlainObject): void {
  requireString(body.title, 'title', true);
  parseOrder(body.order);
  if (body.workItemId !== undefined) requireString(body.workItemId, 'workItemId', true);
}

function parseReviseWorkOrder(body: PlainObject): void {
  requireString(body.workItemId, 'workItemId', true);
  parseOrder(body.order);
}

function parseDispatch(body: PlainObject): void {
  requireStringArray(body.workItemIds, 'workItemIds', true);
}

function parseAcceptanceResult(value: unknown): void {
  const result = requireObject(value, 'review.acceptanceResults');
  requireString(result.criterion, 'review.acceptanceResults.criterion');
  if (typeof result.status !== 'string' || !ACCEPTANCE_STATUSES.includes(result.status)) {
    fail('review.acceptanceResults.status');
  }
  if (result.evidence !== undefined) requireString(result.evidence, 'review.acceptanceResults.evidence');
  if (result.note !== undefined) requireString(result.note, 'review.acceptanceResults.note');
}

function parseReview(body: PlainObject): void {
  requireString(body.workItemId, 'workItemId');
  if (body.verdict !== 'accept' && body.verdict !== 'reject') fail('verdict');
  requireStringArray(body.reasons, 'reasons');
  const requiredChanges = requireStringArray(body.requiredChanges, 'requiredChanges');
  if (body.verdict === 'reject' && requiredChanges.length === 0) fail('requiredChanges');
  if (body.acceptanceResults !== undefined) {
    if (!Array.isArray(body.acceptanceResults)) fail('review.acceptanceResults');
    for (const result of body.acceptanceResults) parseAcceptanceResult(result);
  }
}

function parseSubmit(body: PlainObject): void {
  const result = requireObject(body.result, 'result');
  if (result.outcome !== 'delivered' && result.outcome !== 'blocked') fail('result.outcome');
  requireString(result.summary, 'result.summary');
  requireStringArray(result.acceptanceEvidence, 'result.acceptanceEvidence');
  requireStringArray(result.openRisks, 'result.openRisks');
  if (!Array.isArray(result.memoryDelta)) fail('result.memoryDelta');
}

/**
 * 解析一条 direct 主控命令。
 *
 * 任何形状问题——未知 action、白名单外的顶层字段、缺必填、类型不符——一律
 * `PlatformRuleError('INVALID_DIRECT_COMMAND')`，消息里只给字段名。
 */
export function parseDirectControlCommand(input: unknown): DirectControlCommand {
  const body = requireObject(input, 'body');
  const action = body.action;
  if (typeof action !== 'string' || !Object.hasOwn(ALLOWED_FIELDS, action)) fail('action');
  const allowed = ALLOWED_FIELDS[action as Action];
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) fail(key);
  }
  switch (action as Action) {
    case 'plan':
      parsePlan(body.plan);
      break;
    case 'contract_check':
      parseCheck(body.check);
      break;
    case 'create_work_item':
      parseCreateWorkItem(body);
      break;
    case 'revise_work_order':
      parseReviseWorkOrder(body);
      break;
    case 'dispatch':
      parseDispatch(body);
      break;
    case 'review':
      parseReview(body);
      break;
    case 'submit':
      parseSubmit(body);
      break;
    default:
      fail('action');
  }
  return input as unknown as DirectControlCommand;
}
