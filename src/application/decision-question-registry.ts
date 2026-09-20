/**
 * QuestionRegistry 题集（只读数据）：PRE_DISPATCH + POST_EXECUTION。
 *
 * 不建 class / service / store；不绑定任何 provider 实现。
 * 仅描述「问什么」，不描述「怎么答 / 怎么存」。
 */

export const PRE_DISPATCH_V1_QUESTION_IDS = Object.freeze([
  'task_type',
  'semantic_risk',
  'work_order_ambiguous',
  'preferred_executor',
] as const);

export type PreDispatchV1QuestionId = (typeof PRE_DISPATCH_V1_QUESTION_IDS)[number];

export const POST_EXECUTION_V1_QUESTION_IDS = Object.freeze([
  'objective_satisfied',
  'evidence_sufficient',
  'scope_deviation',
  'semantic_risk',
] as const);

export type PostExecutionV1QuestionId = (typeof POST_EXECUTION_V1_QUESTION_IDS)[number];

/** DecisionRequest.facts 候选输入 key；不是 question id。 */
export const CANDIDATE_EXECUTOR_FACT_KEY = 'candidate_executor_id' as const;

export const TASK_TYPE_OPTIONS = Object.freeze([
  'bugfix',
  'feature',
  'refactor',
  'research',
  'test',
  'config',
  'other',
] as const);

export type TaskTypeOption = (typeof TASK_TYPE_OPTIONS)[number];

export const PREFERRED_EXECUTOR_NONE_OPTION = 'none' as const;

export type PreferredExecutorOptionSource = 'candidate_set_plus_none';

export type QuestionKind = 'choice' | 'score' | 'noul';

export type OrderedLevel = {
  readonly label: string;
  readonly rubric: string;
};

/** semantic_risk 四档有序 label（0..3 位置对齐）。完整 rubric 只在 question.orderedLevels。 */
export const SEMANTIC_RISK_ORDERED_LEVELS = Object.freeze([
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const);

export type SemanticRiskLevel = (typeof SEMANTIC_RISK_ORDERED_LEVELS)[number];

/** PRE 与 POST 的 semantic_risk 共用同一 defs 对象（不复制 rubric）。 */
const SEMANTIC_RISK_LEVEL_DEFS: readonly OrderedLevel[] = Object.freeze([
  Object.freeze({
    label: 'LOW',
    rubric: '局部、易恢复、影响明确：单处改动、范围窄、失败可低成本回滚。',
  }),
  Object.freeze({
    label: 'MEDIUM',
    rubric: '跨多个局部模块，但边界与回滚路径明确；失败可隔离。',
  }),
  Object.freeze({
    label: 'HIGH',
    rubric: '触及公共API、核心流程、共享状态，或明显跨模块协作。',
  }),
  Object.freeze({
    label: 'CRITICAL',
    rubric: '不可逆数据变更、安全与权限边界、广泛架构调整，或生产控制面相关改动。',
  }),
]);

export type PreDispatchQuestionSpec =
  | {
      readonly id: 'task_type';
      readonly kind: 'choice';
      readonly purpose: string;
      readonly options: readonly TaskTypeOption[];
    }
  | {
      readonly id: 'semantic_risk';
      readonly kind: 'score';
      readonly purpose: string;
      readonly orderedLevels: readonly OrderedLevel[];
    }
  | {
      readonly id: 'work_order_ambiguous';
      readonly kind: 'noul';
      readonly purpose: string;
    }
  | {
      readonly id: 'preferred_executor';
      readonly kind: 'choice';
      readonly purpose: string;
      readonly optionSource: PreferredExecutorOptionSource;
    };

export type PostExecutionQuestionSpec =
  | {
      readonly id: 'objective_satisfied';
      readonly kind: 'noul';
      readonly purpose: string;
    }
  | {
      readonly id: 'evidence_sufficient';
      readonly kind: 'noul';
      readonly purpose: string;
    }
  | {
      readonly id: 'scope_deviation';
      readonly kind: 'noul';
      readonly purpose: string;
    }
  | {
      readonly id: 'semantic_risk';
      readonly kind: 'score';
      readonly purpose: string;
      readonly orderedLevels: readonly OrderedLevel[];
    };

/** @deprecated 兼容旧名：PRE 题规格 */
export type DecisionQuestionSpec = PreDispatchQuestionSpec;

export type PreDispatchQuestionRegistry = {
  readonly id: 'PRE_DISPATCH_V1';
  readonly questions: readonly PreDispatchQuestionSpec[];
};

export type PostExecutionQuestionRegistry = {
  readonly id: 'POST_EXECUTION_V1';
  readonly questions: readonly PostExecutionQuestionSpec[];
};

export type QuestionRegistry = PreDispatchQuestionRegistry | PostExecutionQuestionRegistry;

/**
 * 冻结的 PRE_DISPATCH 题集。调用方只读；勿就地改写。
 */
export const PRE_DISPATCH_V1: PreDispatchQuestionRegistry = Object.freeze({
  id: 'PRE_DISPATCH_V1',
  questions: Object.freeze([
    Object.freeze({
      id: 'task_type',
      kind: 'choice',
      purpose: '任务类型归类',
      options: TASK_TYPE_OPTIONS,
    }),
    Object.freeze({
      id: 'semantic_risk',
      kind: 'score',
      purpose: '语义风险等级',
      orderedLevels: SEMANTIC_RISK_LEVEL_DEFS,
    }),
    Object.freeze({
      id: 'work_order_ambiguous',
      kind: 'noul',
      purpose: '是否存在两种以上明显不同的合理实现',
    }),
    Object.freeze({
      id: 'preferred_executor',
      kind: 'choice',
      purpose: '偏好执行者（候选集合 + none）',
      optionSource: 'candidate_set_plus_none',
    }),
  ]),
}) as PreDispatchQuestionRegistry;

/**
 * 冻结的 POST_EXECUTION 题集。调用方只读；勿就地改写。
 * semantic_risk.orderedLevels 与 PRE 为同一对象引用。
 */
export const POST_EXECUTION_V1: PostExecutionQuestionRegistry = Object.freeze({
  id: 'POST_EXECUTION_V1',
  questions: Object.freeze([
    Object.freeze({
      id: 'objective_satisfied',
      kind: 'noul',
      purpose: '执行结果是否满足工作单目标与验收标准',
    }),
    Object.freeze({
      id: 'evidence_sufficient',
      kind: 'noul',
      purpose: '已声明证据是否足以支撑执行结论',
    }),
    Object.freeze({
      id: 'scope_deviation',
      kind: 'noul',
      purpose: '文件变更是否偏离声明范围',
    }),
    Object.freeze({
      id: 'semantic_risk',
      kind: 'score',
      purpose: '本次执行变更的语义风险等级',
      orderedLevels: SEMANTIC_RISK_LEVEL_DEFS,
    }),
  ]),
}) as PostExecutionQuestionRegistry;
