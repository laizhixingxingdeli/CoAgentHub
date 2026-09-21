/**
 * 独立、纯应用层、确定性 TaskClassifier。
 *
 * 只消费已经结构化的 facts + 可选 ComplexityAssessment，输出路由建议与解释。
 * 不创建/修改 Mission、不改 executionMode、不调用 Decision/Jev/Runtime、
 * 不解析自由文本、不实现 ExecutionBudget。
 */

import type {
  ComplexityAssessment,
  MissionExecutionMode,
  RunKind,
} from '../kernel/index.ts';

export type Tri = true | false | 'unknown';

export interface TaskFacts {
  readonly mutationSideEffect: Tri;
  readonly readOnlyProven: Tri;
  readonly highAssurance: {
    readonly productionDeployRelease: Tri;
    readonly externalPaidOp: Tri;
    readonly destructiveData: Tri;
    readonly credentialsPermissionsSecurity: Tri;
    readonly schemaPublicApiPersistenceCompat: Tri;
    readonly unrecoverableExternalSideEffect: Tri;
  };
  readonly standardFloor: {
    readonly publicInterface: Tri;
    readonly buildSystemOrDependency: Tri;
    readonly multipleDomainModules: Tri;
    readonly acceptanceNotCheckableUpfront: Tri;
    readonly rootCauseOrCompetingDesigns: Tri;
  };
}

export interface ClassifyTaskInput {
  readonly facts: TaskFacts;
  readonly assessment?: Readonly<ComplexityAssessment>;
}

export type RecommendedRoute =
  | { readonly runKind: 'query'; readonly executionMode: null }
  | { readonly runKind: 'mutation'; readonly executionMode: MissionExecutionMode };

export type ClassifierConfidence = 'high' | 'medium' | 'low';

export interface ClassificationResult {
  readonly recommended: RecommendedRoute;
  readonly confidence: ClassifierConfidence;
  readonly facts: TaskFacts;
  readonly unknowns: readonly string[];
  readonly criticalUnknowns: readonly string[];
  readonly reasons: readonly string[];
  readonly assessmentRef?: {
    readonly scoreSum: number;
    readonly decidedBy: ComplexityAssessment['decidedBy'];
  };
}

/** highAssurance 字段，稳定顺序（dotted path 后缀）。 */
const HA_KEYS = [
  'productionDeployRelease',
  'externalPaidOp',
  'destructiveData',
  'credentialsPermissionsSecurity',
  'schemaPublicApiPersistenceCompat',
  'unrecoverableExternalSideEffect',
] as const;

/** standardFloor 字段，稳定顺序。 */
const SF_KEYS = [
  'publicInterface',
  'buildSystemOrDependency',
  'multipleDomainModules',
  'acceptanceNotCheckableUpfront',
  'rootCauseOrCompetingDesigns',
] as const;

const MODE_RANK: Record<MissionExecutionMode, number> = {
  lightweight: 0,
  standard: 1,
  high_assurance: 2,
};

function modeAtLeast(
  floor: MissionExecutionMode,
  raised: MissionExecutionMode,
): MissionExecutionMode {
  return MODE_RANK[raised] > MODE_RANK[floor] ? raised : floor;
}

function scoreToMode(sum: number): MissionExecutionMode {
  if (sum >= 9) return 'high_assurance';
  if (sum >= 6) return 'standard';
  return 'lightweight';
}

function assessmentScoreSum(assessment: Readonly<ComplexityAssessment>): number {
  return (
    assessment.goalUncertainty +
    assessment.changeScope +
    assessment.operationalRisk +
    assessment.verificationDifficulty +
    assessment.coordinationNeed +
    assessment.recoveryDifficulty
  );
}

function collectUnknowns(facts: TaskFacts): {
  unknowns: string[];
  criticalUnknowns: string[];
} {
  const unknowns: string[] = [];
  const criticalUnknowns: string[] = [];

  // 稳定顺序：mutationSideEffect → readOnlyProven → HA.* → standardFloor.*
  if (facts.mutationSideEffect === 'unknown') {
    unknowns.push('mutationSideEffect');
    criticalUnknowns.push('mutationSideEffect');
  }
  if (facts.readOnlyProven === 'unknown') {
    unknowns.push('readOnlyProven');
  }

  for (const key of HA_KEYS) {
    if (facts.highAssurance[key] === 'unknown') {
      const path = `highAssurance.${key}`;
      unknowns.push(path);
      criticalUnknowns.push(path);
    }
  }

  for (const key of SF_KEYS) {
    if (facts.standardFloor[key] === 'unknown') {
      unknowns.push(`standardFloor.${key}`);
    }
  }

  return { unknowns, criticalUnknowns };
}

function anyHaTrue(facts: TaskFacts): boolean {
  for (const key of HA_KEYS) {
    if (facts.highAssurance[key] === true) return true;
  }
  return false;
}

function haTruePaths(facts: TaskFacts): string[] {
  const out: string[] = [];
  for (const key of HA_KEYS) {
    if (facts.highAssurance[key] === true) {
      out.push(`highAssurance.${key}`);
    }
  }
  return out;
}

function freezeFacts(facts: TaskFacts): TaskFacts {
  return Object.freeze({
    mutationSideEffect: facts.mutationSideEffect,
    readOnlyProven: facts.readOnlyProven,
    highAssurance: Object.freeze({ ...facts.highAssurance }),
    standardFloor: Object.freeze({ ...facts.standardFloor }),
  });
}

/**
 * 对结构化 facts（+ 可选 assessment）做确定性路由建议。
 * 不修改入参；不写 Mission / Decision / Budget。
 */
export function classifyTask(input: ClassifyTaskInput): ClassificationResult {
  const facts = input.facts;
  const assessment = input.assessment;

  const { unknowns, criticalUnknowns } = collectUnknowns(facts);
  const reasons: string[] = [];

  const haTrue = anyHaTrue(facts);
  const haTrues = haTruePaths(facts);

  // critical HA/mutation unknowns => at least Standard, never Query
  const isQuery =
    facts.readOnlyProven === true &&
    facts.mutationSideEffect === false &&
    !haTrue &&
    criticalUnknowns.length === 0;

  let recommended: RecommendedRoute;
  let assessmentRef: ClassificationResult['assessmentRef'];

  if (isQuery) {
    // 1. query/mutation decision
    reasons.push(
      'query: readOnlyProven=true and mutationSideEffect=false with no highAssurance=true and no critical unknowns',
    );
    recommended = Object.freeze({
      runKind: 'query' as const satisfies RunKind,
      executionMode: null,
    });
    // assessment 对 query 无抬升作用；若传入仅作 ref 记录
    if (assessment !== undefined) {
      const sum = assessmentScoreSum(assessment);
      assessmentRef = Object.freeze({
        scoreSum: sum,
        decidedBy: assessment.decidedBy,
      });
      reasons.push(
        `assessment scoreSum=${sum} noted; score cannot create or alter query`,
      );
    }
  } else {
    // ---- mutation path ----
    // 1. query/mutation decision
    if (
      facts.readOnlyProven === true &&
      facts.mutationSideEffect === false &&
      haTrue
    ) {
      reasons.push(
        'mutation: inconsistent read-only proof with highAssurance=true (fail-closed)',
      );
    } else {
      reasons.push('mutation: not proven read-only query');
    }

    // 2. HA true triggers
    for (const path of haTrues) {
      reasons.push(`highAssurance true: ${path}`);
    }

    // 3. critical unknowns
    for (const path of criticalUnknowns) {
      reasons.push(`critical unknown: ${path}`);
    }

    // 4. standard true/unknown triggers
    for (const key of SF_KEYS) {
      const v = facts.standardFloor[key];
      if (v === true) {
        reasons.push(`standardFloor true: standardFloor.${key}`);
      } else if (v === 'unknown') {
        reasons.push(`standardFloor unknown: standardFloor.${key}`);
      }
    }

    // Floor from facts (precedence): HA true > critical unknown > standard floor
    let floor: MissionExecutionMode | null = null;
    if (haTrue) {
      floor = 'high_assurance';
    } else if (criticalUnknowns.length > 0) {
      floor = 'standard';
    } else {
      let sfHit = false;
      for (const key of SF_KEYS) {
        const v = facts.standardFloor[key];
        if (v === true || v === 'unknown') {
          sfHit = true;
          break;
        }
      }
      if (sfHit) floor = 'standard';
    }

    // 5. score / no-assessment — may raise, never downgrade
    let mode: MissionExecutionMode;
    if (assessment !== undefined) {
      const sum = assessmentScoreSum(assessment);
      const scoreMode = scoreToMode(sum);
      assessmentRef = Object.freeze({
        scoreSum: sum,
        decidedBy: assessment.decidedBy,
      });
      reasons.push(`assessment scoreSum=${sum} => ${scoreMode}`);

      if (floor === null) {
        mode = scoreMode;
      } else {
        mode = modeAtLeast(floor, scoreMode);
        // 6. score-not-downgrade note when relevant
        if (MODE_RANK[scoreMode] < MODE_RANK[floor]) {
          reasons.push(
            `score does not downgrade floor: floor=${floor}, score=${scoreMode}`,
          );
        }
      }
    } else {
      reasons.push('no assessment: fail-closed without score raise');
      mode = floor ?? 'standard';
    }

    recommended = Object.freeze({
      runKind: 'mutation' as const satisfies RunKind,
      executionMode: mode,
    });
  }

  // Confidence
  let confidence: ClassifierConfidence;
  if (unknowns.length === 0) {
    confidence = 'high';
  } else if (criticalUnknowns.length === 0) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  const result: ClassificationResult = {
    recommended,
    confidence,
    facts: freezeFacts(facts),
    unknowns: Object.freeze([...unknowns]),
    criticalUnknowns: Object.freeze([...criticalUnknowns]),
    reasons: Object.freeze([...reasons]),
  };

  if (assessmentRef !== undefined) {
    return Object.freeze({ ...result, assessmentRef });
  }
  return Object.freeze(result);
}
