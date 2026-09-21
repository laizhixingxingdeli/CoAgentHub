/**
 * Classified Mission intake：严格 schema 边界。
 *
 * 只解析/验证 caller 提交的 facts / assessment，**不分类**。
 * 路由规则唯一来源仍是 `classifyTask()`。
 */

import type { ComplexityAssessment } from '../kernel/index.ts';
import type { TaskFacts, Tri } from './task-classifier.ts';

/** caller 路由输入不合法（缺 key / 多 key / 类型错 / 试图覆盖 route）。 */
export class ClassifiedMissionInputError extends Error {
  readonly code = 'BAD_ROUTING_INPUT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ClassifiedMissionInputError';
  }
}

const FACTS_KEYS = [
  'mutationSideEffect',
  'readOnlyProven',
  'highAssurance',
  'standardFloor',
] as const;

const HA_KEYS = [
  'productionDeployRelease',
  'externalPaidOp',
  'destructiveData',
  'credentialsPermissionsSecurity',
  'schemaPublicApiPersistenceCompat',
  'unrecoverableExternalSideEffect',
] as const;

const SF_KEYS = [
  'publicInterface',
  'buildSystemOrDependency',
  'multipleDomainModules',
  'acceptanceNotCheckableUpfront',
  'rootCauseOrCompetingDesigns',
] as const;

const ASSESSMENT_KEYS = [
  'goalUncertainty',
  'changeScope',
  'operationalRisk',
  'verificationDifficulty',
  'coordinationNeed',
  'recoveryDifficulty',
  'reasons',
  'decidedBy',
  'assessedAt',
] as const;

const ASSESSMENT_DIM_KEYS = [
  'goalUncertainty',
  'changeScope',
  'operationalRisk',
  'verificationDifficulty',
  'coordinationNeed',
  'recoveryDifficulty',
] as const;

const DECIDED_BY = new Set(['rule', 'user', 'coordinator']);

/** caller 不得用这些根键绕过 classifier。 */
const CALLER_ROUTE_OVERRIDE_KEYS = [
  'executionMode',
  'runKind',
  'recommended',
  'recommendedRoute',
  'classification',
  'route',
] as const;

function bad(detail: string): never {
  throw new ClassifiedMissionInputError(detail);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const want = [...expected].sort();
  if (actual.length !== want.length || actual.some((k, i) => k !== want[i])) {
    bad(
      `${label} keys must be exactly [${want.join(', ')}]; got [${actual.join(', ')}]`,
    );
  }
}

function parseTri(value: unknown, path: string): Tri {
  if (value === true || value === false || value === 'unknown') return value;
  bad(`${path} must be true | false | "unknown"`);
}

function parseHa(value: unknown): TaskFacts['highAssurance'] {
  if (!isPlainObject(value)) bad('facts.highAssurance must be an object');
  assertExactKeys(value, HA_KEYS, 'facts.highAssurance');
  return Object.freeze({
    productionDeployRelease: parseTri(value.productionDeployRelease, 'facts.highAssurance.productionDeployRelease'),
    externalPaidOp: parseTri(value.externalPaidOp, 'facts.highAssurance.externalPaidOp'),
    destructiveData: parseTri(value.destructiveData, 'facts.highAssurance.destructiveData'),
    credentialsPermissionsSecurity: parseTri(
      value.credentialsPermissionsSecurity,
      'facts.highAssurance.credentialsPermissionsSecurity',
    ),
    schemaPublicApiPersistenceCompat: parseTri(
      value.schemaPublicApiPersistenceCompat,
      'facts.highAssurance.schemaPublicApiPersistenceCompat',
    ),
    unrecoverableExternalSideEffect: parseTri(
      value.unrecoverableExternalSideEffect,
      'facts.highAssurance.unrecoverableExternalSideEffect',
    ),
  });
}

function parseSf(value: unknown): TaskFacts['standardFloor'] {
  if (!isPlainObject(value)) bad('facts.standardFloor must be an object');
  assertExactKeys(value, SF_KEYS, 'facts.standardFloor');
  return Object.freeze({
    publicInterface: parseTri(value.publicInterface, 'facts.standardFloor.publicInterface'),
    buildSystemOrDependency: parseTri(
      value.buildSystemOrDependency,
      'facts.standardFloor.buildSystemOrDependency',
    ),
    multipleDomainModules: parseTri(
      value.multipleDomainModules,
      'facts.standardFloor.multipleDomainModules',
    ),
    acceptanceNotCheckableUpfront: parseTri(
      value.acceptanceNotCheckableUpfront,
      'facts.standardFloor.acceptanceNotCheckableUpfront',
    ),
    rootCauseOrCompetingDesigns: parseTri(
      value.rootCauseOrCompetingDesigns,
      'facts.standardFloor.rootCauseOrCompetingDesigns',
    ),
  });
}

/** 严格解析 TaskFacts：exact shape，不分类。 */
export function parseTaskFactsStrict(value: unknown): TaskFacts {
  if (!isPlainObject(value)) bad('facts must be an object');
  assertExactKeys(value, FACTS_KEYS, 'facts');
  return Object.freeze({
    mutationSideEffect: parseTri(value.mutationSideEffect, 'facts.mutationSideEffect'),
    readOnlyProven: parseTri(value.readOnlyProven, 'facts.readOnlyProven'),
    highAssurance: parseHa(value.highAssurance),
    standardFloor: parseSf(value.standardFloor),
  });
}

function parseDim(value: unknown, path: string): 0 | 1 | 2 {
  if (value === 0 || value === 1 || value === 2) return value;
  bad(`${path} must be 0 | 1 | 2`);
}

function parseReasons(value: unknown): readonly string[] {
  if (!Array.isArray(value)) bad('assessment.reasons must be a string[]');
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== 'string') bad(`assessment.reasons[${i}] must be a string`);
    out.push(item);
  }
  return Object.freeze(out);
}

/**
 * 严格解析 ComplexityAssessment。
 * 缺省 / undefined => undefined；提供时 exact keys + 类型。
 */
export function parseComplexityAssessmentStrict(
  value: unknown,
): ComplexityAssessment | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) bad('assessment must be an object when provided');
  assertExactKeys(value, ASSESSMENT_KEYS, 'assessment');

  const decidedBy = value.decidedBy;
  if (typeof decidedBy !== 'string' || !DECIDED_BY.has(decidedBy)) {
    bad('assessment.decidedBy must be "rule" | "user" | "coordinator"');
  }
  if (typeof value.assessedAt !== 'string') {
    bad('assessment.assessedAt must be a string');
  }

  const dims = {
    goalUncertainty: parseDim(value.goalUncertainty, 'assessment.goalUncertainty'),
    changeScope: parseDim(value.changeScope, 'assessment.changeScope'),
    operationalRisk: parseDim(value.operationalRisk, 'assessment.operationalRisk'),
    verificationDifficulty: parseDim(
      value.verificationDifficulty,
      'assessment.verificationDifficulty',
    ),
    coordinationNeed: parseDim(value.coordinationNeed, 'assessment.coordinationNeed'),
    recoveryDifficulty: parseDim(value.recoveryDifficulty, 'assessment.recoveryDifficulty'),
  };

  // 触达 ASSESSMENT_DIM_KEYS 以保持与合同键表一致（防漂移）。
  for (const key of ASSESSMENT_DIM_KEYS) {
    void dims[key];
  }

  return Object.freeze({
    ...dims,
    reasons: parseReasons(value.reasons),
    decidedBy: decidedBy as ComplexityAssessment['decidedBy'],
    assessedAt: value.assessedAt,
  });
}

/**
 * 若 classified input 根对象含任一 caller route override key，直接拒绝。
 * 不静默忽略。
 */
export function assertNoCallerRouteOverride(value: unknown): void {
  if (!isPlainObject(value)) bad('classified mission input must be an object');
  for (const key of CALLER_ROUTE_OVERRIDE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      bad(`caller must not supply route override key "${key}"`);
    }
  }
}
