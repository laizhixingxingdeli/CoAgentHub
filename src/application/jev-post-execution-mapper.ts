/**
 * Jev System One —— POST_EXECUTION 离线 request/response 映射（纯函数）。
 *
 * 不接 live adapter、不调用 transport、不发网络。
 * request.state 原样携带 PostExecutionState；questions 仅从 POST_EXECUTION_V1 构造。
 */

import {
  POST_EXECUTION_V1,
  POST_EXECUTION_V1_QUESTION_IDS,
  type OrderedLevel,
} from './decision-question-registry.ts';
import type { PostExecutionState } from './post-execution-state.ts';
import type {
  DecisionAnswerMeta,
  DecisionAnswerSet,
  DecisionSignal,
} from './ports.ts';

const QUESTION_IDS = POST_EXECUTION_V1_QUESTION_IDS;

type QuestionId = (typeof QUESTION_IDS)[number];

/* ------------------------------ System One wire (POST) ------------------------------ */

export type JevPostExecutionQuestion =
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

export type JevPostExecutionQuestions = Readonly<Record<QuestionId, JevPostExecutionQuestion>>;

export interface JevPostExecutionRequest {
  readonly state: PostExecutionState;
  readonly questions: JevPostExecutionQuestions;
  readonly model: string;
}

/** index-keyed map，例如 {'0':'LOW: ...','1':'MEDIUM: ...'} */
export type JevPostExecutionScoreLegend = Readonly<Record<string, string>>;

export type JevPostExecutionAnswer =
  | {
      readonly type: 'score';
      readonly score: number;
      readonly confidence?: number;
      readonly probabilities?: Readonly<Record<string, number>>;
      readonly legend: JevPostExecutionScoreLegend;
    }
  | {
      readonly type: 'noul';
      readonly noul: number;
    };

export type JevPostExecutionAnswers = Readonly<Record<QuestionId, JevPostExecutionAnswer>>;

export interface JevPostExecutionUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface JevPostExecutionResponse {
  readonly model: string;
  readonly answers: JevPostExecutionAnswers;
  readonly usage: JevPostExecutionUsage;
}

/* ------------------------------ helpers ------------------------------ */

function fail(message: string): never {
  throw new Error(`JevPostExecutionMapper: ${message}`);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function semanticRiskCriteria(levels: readonly OrderedLevel[]): readonly string[] {
  return levels.map((level) => `${level.label}: ${level.rubric}`);
}

function buildQuestions(): JevPostExecutionQuestions {
  let objectiveInstructions = '';
  let evidenceInstructions = '';
  let scopeInstructions = '';
  let semanticRiskInstructions = '';
  let riskLevels: readonly OrderedLevel[] = [];

  for (const q of POST_EXECUTION_V1.questions) {
    if (q.id === 'objective_satisfied') objectiveInstructions = q.purpose;
    else if (q.id === 'evidence_sufficient') evidenceInstructions = q.purpose;
    else if (q.id === 'scope_deviation') scopeInstructions = q.purpose;
    else if (q.id === 'semantic_risk') {
      semanticRiskInstructions = q.purpose;
      riskLevels = q.orderedLevels;
    }
  }

  return {
    objective_satisfied: {
      type: 'noul',
      instructions: objectiveInstructions,
    },
    evidence_sufficient: {
      type: 'noul',
      instructions: evidenceInstructions,
    },
    scope_deviation: {
      type: 'noul',
      instructions: scopeInstructions,
    },
    semantic_risk: {
      type: 'score',
      instructions: semanticRiskInstructions,
      criteria: semanticRiskCriteria(riskLevels),
    },
  };
}

function assertExactAnswerKeys(answers: unknown): asserts answers is JevPostExecutionAnswers {
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

function mapNoul(raw: JevPostExecutionAnswer, id: QuestionId): DecisionSignal {
  if (raw.type !== 'noul') fail(`${id} must be type noul`);
  const value = raw.noul;
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    fail(`${id} noul out of range: ${String(value)}`);
  }
  return { kind: 'score', value, scale: 'noul' };
}

function mapSemanticRisk(
  raw: JevPostExecutionAnswer,
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
  answers: JevPostExecutionAnswers,
  questions: JevPostExecutionQuestions,
): DecisionAnswerSet['answers'] {
  const riskQ = questions.semantic_risk;
  if (riskQ.type !== 'score') fail('internal: semantic_risk question not score');

  return {
    objective_satisfied: mapNoul(answers.objective_satisfied, 'objective_satisfied'),
    evidence_sufficient: mapNoul(answers.evidence_sufficient, 'evidence_sufficient'),
    scope_deviation: mapNoul(answers.scope_deviation, 'scope_deviation'),
    semantic_risk: mapSemanticRisk(answers.semantic_risk, riskQ.criteria),
  };
}

function mapMeta(response: JevPostExecutionResponse): DecisionAnswerMeta {
  const model = response.model;
  if (typeof model !== 'string' || model.trim() === '') {
    fail('response.model must be a non-empty trimmed string');
  }
  const resolvedModel = model.trim();

  const usage = response.usage;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    fail('response.usage must be an object');
  }
  const inputTokens = (usage as JevPostExecutionUsage).input_tokens;
  const outputTokens = (usage as JevPostExecutionUsage).output_tokens;
  if (!isFiniteNumber(inputTokens) || inputTokens < 0) {
    fail(`response.usage.input_tokens invalid: ${String(inputTokens)}`);
  }
  if (!isFiniteNumber(outputTokens) || outputTokens < 0) {
    fail(`response.usage.output_tokens invalid: ${String(outputTokens)}`);
  }

  return {
    resolvedModel,
    usage: { inputTokens, outputTokens },
  };
}

/* ------------------------------ public API ------------------------------ */

/**
 * 构造 POST_EXECUTION System One request。
 * `model` 由 caller 必传；trim 后非空，否则 throw。无默认 model。
 * `state` 原样引用传入的 PostExecutionState（不重新投影）。
 */
export function buildJevPostExecutionRequest(
  state: PostExecutionState,
  model: string,
): JevPostExecutionRequest {
  if (typeof model !== 'string' || model.trim() === '') {
    throw new Error('JevPostExecutionMapper: model must be a non-empty trimmed string');
  }
  return {
    state,
    questions: buildQuestions(),
    model: model.trim(),
  };
}

/**
 * 将 System One response 映射为 DecisionAnswerSet。
 * 四 key 全量校验；type/range/legend 任一失败则 throw，无 partial。
 * 不把 wire confidence/probabilities/legend 暴露到 DecisionAnswerSet。
 */
export function mapJevPostExecutionResponse(
  response: JevPostExecutionResponse,
  sentQuestions: JevPostExecutionQuestions,
): DecisionAnswerSet {
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    fail('response must be an object');
  }
  assertExactAnswerKeys(response.answers);

  const answers = mapAnswers(response.answers, sentQuestions);
  const meta = mapMeta(response);
  return { answers, meta };
}
