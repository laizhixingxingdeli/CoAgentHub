/**
 * 确定性 TaskClassifier：结构化 facts + 可选 assessment → 路由建议。
 *
 * 守住的硬边界：
 *   - 不 createMission / 不写 complexityAssessment / 不 set executionMode
 *   - 不调用 Decision / Jev / Runtime / ExecutionBudget
 *   - score 永不单独创造 query
 *   - missing assessment 不当作全 0
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { ComplexityAssessment } from '../src/kernel/index.ts';
import {
  classifyTask,
  type TaskFacts,
  type Tri,
} from '../src/application/task-classifier.ts';

const FALSE: Tri = false;
const TRUE: Tri = true;
const UNKNOWN: Tri = 'unknown';

function allFalseHa(): TaskFacts['highAssurance'] {
  return {
    productionDeployRelease: FALSE,
    externalPaidOp: FALSE,
    destructiveData: FALSE,
    credentialsPermissionsSecurity: FALSE,
    schemaPublicApiPersistenceCompat: FALSE,
    unrecoverableExternalSideEffect: FALSE,
  };
}

function allFalseSf(): TaskFacts['standardFloor'] {
  return {
    publicInterface: FALSE,
    buildSystemOrDependency: FALSE,
    multipleDomainModules: FALSE,
    acceptanceNotCheckableUpfront: FALSE,
    rootCauseOrCompetingDesigns: FALSE,
  };
}

function facts(overrides: {
  mutationSideEffect?: Tri;
  readOnlyProven?: Tri;
  highAssurance?: Partial<TaskFacts['highAssurance']>;
  standardFloor?: Partial<TaskFacts['standardFloor']>;
} = {}): TaskFacts {
  return {
    mutationSideEffect: overrides.mutationSideEffect ?? FALSE,
    readOnlyProven: overrides.readOnlyProven ?? FALSE,
    highAssurance: { ...allFalseHa(), ...overrides.highAssurance },
    standardFloor: { ...allFalseSf(), ...overrides.standardFloor },
  };
}

/** 用均匀分布构造目标 scoreSum（每维 0|1|2，和 0–12）。 */
function assessmentForSum(
  sum: number,
  decidedBy: ComplexityAssessment['decidedBy'] = 'rule',
): ComplexityAssessment {
  assert.ok(sum >= 0 && sum <= 12);
  const dims: Array<0 | 1 | 2> = [0, 0, 0, 0, 0, 0];
  let remain = sum;
  for (let i = 0; i < 6 && remain > 0; i++) {
    const take = Math.min(2, remain) as 0 | 1 | 2;
    dims[i] = take;
    remain -= take;
  }
  return {
    goalUncertainty: dims[0]!,
    changeScope: dims[1]!,
    operationalRisk: dims[2]!,
    verificationDifficulty: dims[3]!,
    coordinationNeed: dims[4]!,
    recoveryDifficulty: dims[5]!,
    reasons: [`synthetic sum=${sum}`],
    decidedBy,
    assessedAt: '2026-03-21T12:00:00.000Z',
  };
}

describe('classifyTask — normal routes', () => {
  test('proven read-only + mutation=false + all floors false => query/null/high', () => {
    const result = classifyTask({
      facts: facts({ readOnlyProven: TRUE, mutationSideEffect: FALSE }),
    });
    assert.deepEqual(result.recommended, { runKind: 'query', executionMode: null });
    assert.equal(result.confidence, 'high');
    assert.equal(result.unknowns.length, 0);
    assert.equal(result.criticalUnknowns.length, 0);
    assert.equal(result.assessmentRef, undefined);
    assert.ok(result.reasons[0]?.startsWith('query:'));
  });

  test('local mutation, floors false, no assessment => mutation/standard/high', () => {
    const result = classifyTask({
      facts: facts({ mutationSideEffect: TRUE, readOnlyProven: FALSE }),
    });
    assert.deepEqual(result.recommended, {
      runKind: 'mutation',
      executionMode: 'standard',
    });
    assert.equal(result.confidence, 'high');
    assert.equal(result.assessmentRef, undefined);
    assert.ok(result.reasons.some((r) => r.includes('no assessment')));
  });

  test('local mutation + score 4 => lightweight', () => {
    const result = classifyTask({
      facts: facts({ mutationSideEffect: TRUE }),
      assessment: assessmentForSum(4),
    });
    assert.deepEqual(result.recommended, {
      runKind: 'mutation',
      executionMode: 'lightweight',
    });
    assert.equal(result.confidence, 'high');
    assert.deepEqual(result.assessmentRef, { scoreSum: 4, decidedBy: 'rule' });
  });

  test('score 7 => standard; score 10 => high_assurance', () => {
    const s7 = classifyTask({
      facts: facts({ mutationSideEffect: TRUE }),
      assessment: assessmentForSum(7),
    });
    assert.equal(s7.recommended.executionMode, 'standard');
    assert.equal(s7.assessmentRef?.scoreSum, 7);

    const s10 = classifyTask({
      facts: facts({ mutationSideEffect: TRUE }),
      assessment: assessmentForSum(10, 'user'),
    });
    assert.equal(s10.recommended.executionMode, 'high_assurance');
    assert.deepEqual(s10.assessmentRef, { scoreSum: 10, decidedBy: 'user' });
  });
});

describe('classifyTask — overrides / precedence', () => {
  const haKeys = [
    'productionDeployRelease',
    'externalPaidOp',
    'destructiveData',
    'credentialsPermissionsSecurity',
    'schemaPublicApiPersistenceCompat',
    'unrecoverableExternalSideEffect',
  ] as const;

  for (const key of haKeys) {
    test(`HA ${key}=true + score 0 => high_assurance`, () => {
      const result = classifyTask({
        facts: facts({
          mutationSideEffect: TRUE,
          highAssurance: { [key]: TRUE },
        }),
        assessment: assessmentForSum(0),
      });
      assert.equal(result.recommended.runKind, 'mutation');
      assert.equal(result.recommended.executionMode, 'high_assurance');
      assert.ok(
        result.reasons.some((r) => r === `highAssurance true: highAssurance.${key}`),
      );
      // score cannot downgrade HA floor
      assert.ok(
        result.reasons.some((r) => r.includes('does not downgrade floor')),
      );
    });
  }

  test('HA true + standard true => high_assurance', () => {
    const result = classifyTask({
      facts: facts({
        mutationSideEffect: TRUE,
        highAssurance: { destructiveData: TRUE },
        standardFloor: { publicInterface: TRUE },
      }),
      assessment: assessmentForSum(3),
    });
    assert.equal(result.recommended.executionMode, 'high_assurance');
  });

  test('standard true + score 4 => standard (no downgrade)', () => {
    const result = classifyTask({
      facts: facts({
        mutationSideEffect: TRUE,
        standardFloor: { multipleDomainModules: TRUE },
      }),
      assessment: assessmentForSum(4),
    });
    assert.equal(result.recommended.executionMode, 'standard');
    assert.ok(result.reasons.some((r) => r.includes('does not downgrade floor')));
  });

  test('standard true + score 10 => high_assurance (raise)', () => {
    const result = classifyTask({
      facts: facts({
        mutationSideEffect: TRUE,
        standardFloor: { buildSystemOrDependency: TRUE },
      }),
      assessment: assessmentForSum(10),
    });
    assert.equal(result.recommended.executionMode, 'high_assurance');
    assert.equal(
      result.reasons.some((r) => r.includes('does not downgrade floor')),
      false,
    );
  });

  test('readOnlyProven true + mutation=false + HA true => mutation/high_assurance fail-closed', () => {
    const result = classifyTask({
      facts: facts({
        readOnlyProven: TRUE,
        mutationSideEffect: FALSE,
        highAssurance: { externalPaidOp: TRUE },
      }),
    });
    assert.deepEqual(result.recommended, {
      runKind: 'mutation',
      executionMode: 'high_assurance',
    });
    assert.equal(result.confidence, 'high');
    assert.ok(result.reasons[0]?.includes('inconsistent'));
  });
});

describe('classifyTask — unknowns / confidence', () => {
  test('HA destructiveData unknown + score1 => mutation/standard/low + critical path', () => {
    const result = classifyTask({
      facts: facts({
        mutationSideEffect: TRUE,
        highAssurance: { destructiveData: UNKNOWN },
      }),
      assessment: assessmentForSum(1),
    });
    assert.equal(result.recommended.runKind, 'mutation');
    assert.equal(result.recommended.executionMode, 'standard');
    assert.equal(result.confidence, 'low');
    assert.deepEqual(result.criticalUnknowns, ['highAssurance.destructiveData']);
    assert.ok(result.unknowns.includes('highAssurance.destructiveData'));
    assert.ok(
      result.reasons.some((r) => r === 'critical unknown: highAssurance.destructiveData'),
    );
    assert.ok(result.reasons.some((r) => r.includes('does not downgrade floor')));
  });

  test('readOnlyProven true + mutation=false + HA destructiveData unknown => never query', () => {
    const result = classifyTask({
      facts: facts({
        readOnlyProven: TRUE,
        mutationSideEffect: FALSE,
        highAssurance: { destructiveData: UNKNOWN },
      }),
      assessment: assessmentForSum(1),
    });
    assert.deepEqual(result.recommended, {
      runKind: 'mutation',
      executionMode: 'standard',
    });
    assert.equal(result.confidence, 'low');
    assert.deepEqual(result.criticalUnknowns, ['highAssurance.destructiveData']);
    assert.ok(result.unknowns.includes('highAssurance.destructiveData'));
    assert.notEqual(result.recommended.runKind, 'query');
    assert.ok(
      result.reasons.some((r) => r === 'critical unknown: highAssurance.destructiveData'),
    );
  });

  test('mutationSideEffect unknown => mutation/standard/low', () => {
    const result = classifyTask({
      facts: facts({ mutationSideEffect: UNKNOWN, readOnlyProven: FALSE }),
    });
    assert.deepEqual(result.recommended, {
      runKind: 'mutation',
      executionMode: 'standard',
    });
    assert.equal(result.confidence, 'low');
    assert.deepEqual(result.criticalUnknowns, ['mutationSideEffect']);
  });

  test('readOnlyProven unknown + mutation=false => mutation, never query', () => {
    const result = classifyTask({
      facts: facts({ readOnlyProven: UNKNOWN, mutationSideEffect: FALSE }),
    });
    assert.equal(result.recommended.runKind, 'mutation');
    assert.notEqual(result.recommended.executionMode, null);
    assert.equal(result.confidence, 'medium'); // readOnlyProven unknown is not critical
    assert.deepEqual(result.unknowns, ['readOnlyProven']);
    assert.deepEqual(result.criticalUnknowns, []);
  });

  test('standardFloor.publicInterface unknown + score2 => standard/medium', () => {
    const result = classifyTask({
      facts: facts({
        mutationSideEffect: TRUE,
        standardFloor: { publicInterface: UNKNOWN },
      }),
      assessment: assessmentForSum(2),
    });
    assert.equal(result.recommended.executionMode, 'standard');
    assert.equal(result.confidence, 'medium');
    assert.deepEqual(result.unknowns, ['standardFloor.publicInterface']);
    assert.deepEqual(result.criticalUnknowns, []);
    assert.ok(
      result.reasons.some(
        (r) => r === 'standardFloor unknown: standardFloor.publicInterface',
      ),
    );
  });

  test('HA unknown + score10 => high_assurance/low', () => {
    const result = classifyTask({
      facts: facts({
        mutationSideEffect: TRUE,
        highAssurance: { productionDeployRelease: UNKNOWN },
      }),
      assessment: assessmentForSum(10),
    });
    assert.equal(result.recommended.executionMode, 'high_assurance');
    assert.equal(result.confidence, 'low');
    assert.deepEqual(result.criticalUnknowns, [
      'highAssurance.productionDeployRelease',
    ]);
  });

  test('unknown paths stable dotted order', () => {
    const result = classifyTask({
      facts: facts({
        mutationSideEffect: UNKNOWN,
        readOnlyProven: UNKNOWN,
        highAssurance: {
          unrecoverableExternalSideEffect: UNKNOWN,
          destructiveData: UNKNOWN,
        },
        standardFloor: {
          rootCauseOrCompetingDesigns: UNKNOWN,
          publicInterface: UNKNOWN,
        },
      }),
    });
    assert.deepEqual(result.unknowns, [
      'mutationSideEffect',
      'readOnlyProven',
      'highAssurance.destructiveData',
      'highAssurance.unrecoverableExternalSideEffect',
      'standardFloor.publicInterface',
      'standardFloor.rootCauseOrCompetingDesigns',
    ]);
    assert.deepEqual(result.criticalUnknowns, [
      'mutationSideEffect',
      'highAssurance.destructiveData',
      'highAssurance.unrecoverableExternalSideEffect',
    ]);
    assert.equal(result.confidence, 'low');
  });
});

describe('classifyTask — contract', () => {
  test('no assessment => no assessmentRef', () => {
    const result = classifyTask({
      facts: facts({ mutationSideEffect: TRUE }),
    });
    assert.equal('assessmentRef' in result && result.assessmentRef !== undefined, false);
    assert.equal(result.assessmentRef, undefined);
  });

  test('result has no budget field', () => {
    const result = classifyTask({
      facts: facts({ readOnlyProven: TRUE, mutationSideEffect: FALSE }),
    });
    assert.equal('budget' in result, false);
    assert.equal('executionBudget' in result, false);
  });

  test('score 0-2 never makes query without explicit read-only proof', () => {
    for (const sum of [0, 1, 2]) {
      const result = classifyTask({
        facts: facts({
          mutationSideEffect: FALSE,
          readOnlyProven: FALSE,
        }),
        assessment: assessmentForSum(sum),
      });
      assert.equal(
        result.recommended.runKind,
        'mutation',
        `score ${sum} must not create query`,
      );
    }
  });

  test('score alone cannot create query even if floors false and mutation false', () => {
    // readOnlyProven not true → never query, regardless of score
    const result = classifyTask({
      facts: facts({
        mutationSideEffect: FALSE,
        readOnlyProven: FALSE,
      }),
      assessment: assessmentForSum(0),
    });
    assert.equal(result.recommended.runKind, 'mutation');
  });

  test('does not mutate caller facts or assessment', () => {
    const f = facts({
      mutationSideEffect: TRUE,
      standardFloor: { publicInterface: TRUE },
    });
    const a = assessmentForSum(4);
    const fSnap = JSON.stringify(f);
    const aSnap = JSON.stringify(a);
    classifyTask({ facts: f, assessment: a });
    assert.equal(JSON.stringify(f), fSnap);
    assert.equal(JSON.stringify(a), aSnap);
  });

  test('assessmentRef only scoreSum + decidedBy', () => {
    const result = classifyTask({
      facts: facts({ mutationSideEffect: TRUE }),
      assessment: assessmentForSum(6, 'coordinator'),
    });
    assert.ok(result.assessmentRef);
    assert.deepEqual(Object.keys(result.assessmentRef).sort(), [
      'decidedBy',
      'scoreSum',
    ]);
    assert.equal(result.assessmentRef.decidedBy, 'coordinator');
    assert.equal(result.assessmentRef.scoreSum, 6);
  });

  test('returned arrays are frozen copies', () => {
    const result = classifyTask({
      facts: facts({
        mutationSideEffect: UNKNOWN,
        highAssurance: { destructiveData: UNKNOWN },
      }),
    });
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.unknowns));
    assert.ok(Object.isFrozen(result.criticalUnknowns));
    assert.ok(Object.isFrozen(result.reasons));
    assert.ok(Object.isFrozen(result.recommended));
    assert.throws(() => {
      (result.unknowns as string[]).push('x');
    });
  });
});

describe('classifyTask — isolation (no wiring / Decision / Budget)', () => {
  test('source does not import Decision, semantic_risk, task_type, Mission, Platform, Orchestrator, ExecutionBudget', () => {
    const path = fileURLToPath(
      new URL('../src/application/task-classifier.ts', import.meta.url),
    );
    const source = readFileSync(path, 'utf8');
    const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]!);
    assert.deepEqual(
      specifiers,
      ['../kernel/index.ts'],
      'only kernel type import allowed',
    );
    // strip block + line comments then assert no forbidden wiring symbols
    const body = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const needle of [
      'DecisionProvider',
      'decision-mode',
      'decision-provider',
      'semantic_risk',
      'task_type',
      'ExecutionBudget',
      'createMission',
      'Orchestrator',
      'Platform',
      'ValidationEngine',
      'jev-',
    ]) {
      assert.equal(
        body.includes(needle),
        false,
        `task-classifier must not reference ${needle}`,
      );
    }
    // MissionExecutionMode / ComplexityAssessment are allowed kernel types;
    // Mission class / value import is not.
    assert.doesNotMatch(body, /\bMission\b/);
    assert.doesNotMatch(body, /\bExecutionBudget\b/);
  });

  test('module surface exports classifyTask only as runtime entry', async () => {
    const mod = await import('../src/application/task-classifier.ts');
    assert.equal(typeof mod.classifyTask, 'function');
    assert.equal('createMission' in mod, false);
    assert.equal('ExecutionBudget' in mod, false);
  });
});

describe('classifyTask — reasons order', () => {
  test('stable order: decision → HA → critical → standard → score → no-downgrade', () => {
    const result = classifyTask({
      facts: facts({
        mutationSideEffect: UNKNOWN,
        highAssurance: {
          destructiveData: TRUE,
          credentialsPermissionsSecurity: UNKNOWN,
        },
        standardFloor: { publicInterface: TRUE, multipleDomainModules: UNKNOWN },
      }),
      assessment: assessmentForSum(2),
    });

    const reasons = result.reasons;
    const idx = (pred: (r: string) => boolean): number => {
      const i = reasons.findIndex(pred);
      assert.ok(i >= 0, `missing reason matching ${pred}`);
      return i;
    };

    const iDecision = idx((r) => r.startsWith('mutation:'));
    const iHa = idx((r) => r.startsWith('highAssurance true:'));
    const iCrit = idx((r) => r.startsWith('critical unknown:'));
    const iSf = idx((r) => r.startsWith('standardFloor '));
    const iScore = idx((r) => r.startsWith('assessment scoreSum='));
    const iNoDown = idx((r) => r.includes('does not downgrade floor'));

    assert.ok(iDecision < iHa);
    assert.ok(iHa < iCrit);
    assert.ok(iCrit < iSf);
    assert.ok(iSf < iScore);
    assert.ok(iScore < iNoDown);
  });
});
