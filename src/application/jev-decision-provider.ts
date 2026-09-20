/**
 * Jev System One —— DecisionProvider 适配器（PRE_DISPATCH only）。
 *
 * 只做 wire 映射：buildDecisionState → transport.systemOne → DecisionAnswerSet。
 * 不发网络请求、不带 auth/retry、不写 kernel。
 */

import {
  CANDIDATE_EXECUTOR_FACT_KEY,
  PREFERRED_EXECUTOR_NONE_OPTION,
  PRE_DISPATCH_V1,
  TASK_TYPE_OPTIONS,
  type OrderedLevel,
} from './decision-question-registry.ts';
import { buildDecisionState, type DecisionState } from './decision-state-builder.ts';
import type {
  DecisionAnswerSet,
  DecisionProvider,
  DecisionRequest,
  DecisionSignal,
} from './ports.ts';

const DEFAULT_MODEL = 'jev-latest';

const QUESTION_IDS = [
  'task_type',
  'semantic_risk',
  'work_order_ambiguous',
  'preferred_executor',
] as const;

type QuestionId = (typeof QUESTION_IDS)[number];

/* ------------------------------ System One wire ------------------------------ */

export type JevSystemOneChoiceCriteria = Readonly<Record<string, string | null>>;

export type JevSystemOneQuestion =
  | {
      readonly type: 'choice';
      readonly instructions: string;
      readonly criteria: JevSystemOneChoiceCriteria;
    }
  | {
      readonly type: 'score';
      readonly instructions: string;
      /** 有序描述列表（LABEL: rubric）；位置即 0..n-1 分位。 */
      readonly criteria: readonly string[];
    }
  | {
      readonly type: 'noul';
      readonly instructions: string;
    };

export type JevSystemOneQuestions = Readonly<Record<QuestionId, JevSystemOneQuestion>>;

export interface JevSystemOneRequest {
  readonly state: DecisionState;
  readonly questions: JevSystemOneQuestions;
  readonly model: string;
}

/** index-keyed map，例如 {'0':'LOW: ...','1':'MEDIUM: ...'} */
export type JevSystemOneScoreLegend = Readonly<Record<string, string>>;

export type JevSystemOneAnswer =
  | {
      readonly type: 'choice';
      readonly choice: string;
      readonly confidence: number;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | {
      readonly type: 'score';
      readonly score: number;
      readonly confidence: number;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly legend: JevSystemOneScoreLegend;
    }
  | {
      readonly type: 'noul';
      readonly noul: number;
    };

export type JevSystemOneAnswers = Readonly<Record<QuestionId, JevSystemOneAnswer>>;

export interface JevSystemOneUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface JevSystemOneResponse {
  readonly model: string;
  readonly answers: JevSystemOneAnswers;
  readonly usage: JevSystemOneUsage;
}

export interface JevSystemOneTransport {
  systemOne(request: JevSystemOneRequest): Promise<JevSystemOneResponse>;
}

export interface JevDecisionProviderOptions {
  readonly transport: JevSystemOneTransport;
  readonly model?: string;
}

/* ------------------------------ helpers ------------------------------ */

function fail(message: string): never {
  throw new Error(`JevDecisionProvider: ${message}`);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function extractCandidateExecutorIds(
  facts: readonly { readonly key: string; readonly value: string }[] | undefined,
): readonly string[] {
  if (facts === undefined || facts.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const fact of facts) {
    if (fact.key !== CANDIDATE_EXECUTOR_FACT_KEY) continue;
    const id = fact.value.trim();
    if (id === '' || id === PREFERRED_EXECUTOR_NONE_OPTION) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function choiceCriteria(options: readonly string[]): JevSystemOneChoiceCriteria {
  const criteria: Record<string, null> = {};
  for (const option of options) {
    criteria[option] = null;
  }
  return criteria;
}

function semanticRiskCriteria(levels: readonly OrderedLevel[]): readonly string[] {
  return levels.map((level) => `${level.label}: ${level.rubric}`);
}

function buildQuestions(candidateIds: readonly string[]): JevSystemOneQuestions {
  const preferredOptions = [...candidateIds, PREFERRED_EXECUTOR_NONE_OPTION];

  let taskTypeInstructions = '任务类型归类';
  let semanticRiskInstructions = '语义风险等级';
  let ambiguousInstructions = '是否存在两种以上明显不同的合理实现';
  let preferredInstructions = '偏好执行者（候选集合 + none）';
  let riskLevels: readonly OrderedLevel[] = [];

  for (const q of PRE_DISPATCH_V1.questions) {
    if (q.id === 'task_type') taskTypeInstructions = q.purpose;
    else if (q.id === 'semantic_risk') {
      semanticRiskInstructions = q.purpose;
      riskLevels = q.orderedLevels;
    } else if (q.id === 'work_order_ambiguous') ambiguousInstructions = q.purpose;
    else if (q.id === 'preferred_executor') preferredInstructions = q.purpose;
  }

  return {
    task_type: {
      type: 'choice',
      instructions: taskTypeInstructions,
      criteria: choiceCriteria(TASK_TYPE_OPTIONS),
    },
    semantic_risk: {
      type: 'score',
      instructions: semanticRiskInstructions,
      criteria: semanticRiskCriteria(riskLevels),
    },
    work_order_ambiguous: {
      type: 'noul',
      instructions: ambiguousInstructions,
    },
    preferred_executor: {
      type: 'choice',
      instructions: preferredInstructions,
      criteria: choiceCriteria(preferredOptions),
    },
  };
}

function assertExactAnswerKeys(answers: unknown): asserts answers is JevSystemOneAnswers {
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    fail('answers must be an object');
  }
  const keys = Object.keys(answers as object);
  const expected = new Set<string>(QUESTION_IDS);
  if (keys.length !== QUESTION_IDS.length) {
    fail(`answers must have exactly ${QUESTION_IDS.length} keys`);
  }
  for (const key of keys) {
    if (!expected.has(key)) fail(`answers has unexpected key "${key}"`);
  }
  for (const id of QUESTION_IDS) {
    if (!(id in (answers as object))) fail(`answers missing key "${id}"`);
  }
}

function mapTaskType(raw: JevSystemOneAnswer): DecisionSignal {
  if (raw.type !== 'choice') fail('task_type must be type choice');
  const option = raw.choice;
  if (typeof option !== 'string' || !(TASK_TYPE_OPTIONS as readonly string[]).includes(option)) {
    fail(`task_type choice out of range: ${String(option)}`);
  }
  return { kind: 'choice', option };
}

function mapPreferredExecutor(
  raw: JevSystemOneAnswer,
  allowed: ReadonlySet<string>,
): DecisionSignal {
  if (raw.type !== 'choice') fail('preferred_executor must be type choice');
  const option = raw.choice;
  if (typeof option !== 'string' || !allowed.has(option)) {
    fail(`preferred_executor choice out of range: ${String(option)}`);
  }
  return { kind: 'choice', option };
}

function mapWorkOrderAmbiguous(raw: JevSystemOneAnswer): DecisionSignal {
  if (raw.type !== 'noul') fail('work_order_ambiguous must be type noul');
  const value = raw.noul;
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    fail(`work_order_ambiguous noul out of range: ${String(value)}`);
  }
  return { kind: 'score', value, scale: 'noul' };
}

function mapSemanticRisk(
  raw: JevSystemOneAnswer,
  sentCriteria: readonly string[],
): DecisionSignal {
  if (raw.type !== 'score') fail('semantic_risk must be type score');
  const value = raw.score;
  if (!isFiniteNumber(value) || value < 0 || value > 3) {
    fail(`semantic_risk score out of range: ${String(value)}`);
  }
  const legend = raw.legend;
  if (legend === null || typeof legend !== 'object' || Array.isArray(legend)) {
    fail('semantic_risk legend must be an object');
  }
  // 必须恰好 keys 0..3（与本次发送的 4 个 score criteria 对齐）
  if (sentCriteria.length !== 4) {
    fail('semantic_risk sent criteria must have length 4');
  }
  const legendKeys = Object.keys(legend);
  if (legendKeys.length !== 4) {
    fail('semantic_risk legend must have exactly keys 0,1,2,3');
  }
  for (let i = 0; i < 4; i++) {
    const key = String(i);
    if (!(key in legend)) {
      fail(`semantic_risk legend missing key "${key}"`);
    }
    if (legend[key] !== sentCriteria[i]) {
      fail(`semantic_risk legend mismatch at key "${key}"`);
    }
  }
  for (const key of legendKeys) {
    if (key !== '0' && key !== '1' && key !== '2' && key !== '3') {
      fail(`semantic_risk legend has unexpected key "${key}"`);
    }
  }
  return { kind: 'score', value, scale: 'ordinal4.v1' };
}

function mapAnswers(
  answers: JevSystemOneAnswers,
  questions: JevSystemOneQuestions,
  preferredAllowed: ReadonlySet<string>,
): DecisionAnswerSet['answers'] {
  const riskQ = questions.semantic_risk;
  if (riskQ.type !== 'score') fail('internal: semantic_risk question not score');

  return {
    task_type: mapTaskType(answers.task_type),
    preferred_executor: mapPreferredExecutor(answers.preferred_executor, preferredAllowed),
    work_order_ambiguous: mapWorkOrderAmbiguous(answers.work_order_ambiguous),
    semantic_risk: mapSemanticRisk(answers.semantic_risk, riskQ.criteria),
  };
}

/* ------------------------------ provider ------------------------------ */

export class JevDecisionProvider implements DecisionProvider {
  readonly kind = 'jev-system-one';

  private readonly transport: JevSystemOneTransport;
  private readonly model: string;

  constructor(options: JevDecisionProviderOptions) {
    this.transport = options.transport;
    this.model = options.model ?? DEFAULT_MODEL;
  }

  async decide(request: DecisionRequest): Promise<DecisionAnswerSet> {
    if (request.hook !== 'PRE_DISPATCH') {
      fail(`unsupported hook "${request.hook}"`);
    }

    const state = buildDecisionState({
      hook: request.hook,
      projectId: request.projectId,
      missionId: request.missionId,
      ...(request.workItemId !== undefined ? { workItemId: request.workItemId } : {}),
      ...(request.attemptId !== undefined ? { attemptId: request.attemptId } : {}),
      facts: request.facts,
    });

    const candidateIds = extractCandidateExecutorIds(request.facts);
    const preferredAllowed = new Set<string>([
      ...candidateIds,
      PREFERRED_EXECUTOR_NONE_OPTION,
    ]);
    const questions = buildQuestions(candidateIds);

    const wireRequest: JevSystemOneRequest = {
      state,
      questions,
      model: this.model,
    };

    let response: JevSystemOneResponse;
    try {
      response = await this.transport.systemOne(wireRequest);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fail(`transport rejected: ${message}`);
    }

    if (response === null || typeof response !== 'object' || Array.isArray(response)) {
      fail('response must be an object');
    }
    assertExactAnswerKeys(response.answers);

    const answers = mapAnswers(response.answers, questions, preferredAllowed);
    return { answers };
  }
}
