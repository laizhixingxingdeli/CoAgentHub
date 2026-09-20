/**
 * PostExecutionState：离线 DTO 投影形状与边界。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPostExecutionState,
  type PostExecutionStateInput,
} from '../src/application/post-execution-state.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const stateSrcPath = join(root, 'src', 'application', 'post-execution-state.ts');

function baseInput(over: Partial<PostExecutionStateInput> = {}): PostExecutionStateInput {
  return {
    workOrder: {
      objective: 'fix login flake',
      constraints: Object.freeze(['no schema change']),
      acceptanceCriteria: Object.freeze(['tests green']),
    },
    executorResult: {
      status: 'completed',
      summary: 'patched retry',
      claimedEvidence: {
        evidenceIds: Object.freeze(['ev-1']),
        summaries: Object.freeze([
          Object.freeze({ id: 'ev-1', kind: 'test', summary: 'unit ok' }),
        ]),
      },
    },
    fileChanges: {
      files: Object.freeze(['src/a.ts']),
    },
    ...over,
  };
}

describe('buildPostExecutionState', () => {
  test('full DTO projection shape', () => {
    const state = buildPostExecutionState(
      baseInput({
        evidence: [
          { id: 'b1', kind: 'build', exitCode: 0, summary: 'build ok' },
          { id: 't1', kind: 'test', exitCode: 0 },
          { id: 'tc1', kind: 'typecheck', exitCode: 0 },
        ],
        execution: { toolCount: 3 },
      }),
    );

    assert.equal(state.schemaVersion, 'post_execution_v1');
    assert.equal(state.workOrder.objective, 'fix login flake');
    assert.deepEqual([...state.workOrder.constraints], ['no schema change']);
    assert.deepEqual([...state.workOrder.acceptanceCriteria], ['tests green']);
    assert.equal(state.executorResult.status, 'completed');
    assert.equal(state.executorResult.summary, 'patched retry');
    assert.deepEqual([...state.executorResult.claimedEvidence.evidenceIds], ['ev-1']);
    assert.deepEqual(state.executorResult.claimedEvidence.summaries, [
      { id: 'ev-1', kind: 'test', summary: 'unit ok' },
    ]);
    assert.deepEqual([...state.fileChanges.files], ['src/a.ts']);
    assert.deepEqual([...state.fileChanges.unavailableFields], [
      'addedLines',
      'removedLines',
      'outsideDeclaredScope',
    ]);
    assert.equal(state.verification.build.status, 'passed');
    assert.equal(state.verification.tests.status, 'passed');
    assert.equal(state.verification.lint.status, 'not_run');
    assert.equal(state.verification.typecheck.status, 'passed');
    assert.equal(state.verification.build.source, 'evidence_projection');
    assert.equal(state.execution.toolCount, 3);
    assert.deepEqual(state.execution.errorCount, { unavailable: true });
    assert.deepEqual(state.execution.retryCount, { unavailable: true });
    assert.deepEqual(state.truncation, { applied: false, omittedFields: [] });
  });

  test('unknown root / nested fields rejected', () => {
    assert.throws(
      () =>
        buildPostExecutionState({
          ...baseInput(),
          missionId: 'm1',
        } as PostExecutionStateInput),
      TypeError,
    );
    assert.throws(
      () =>
        buildPostExecutionState({
          ...baseInput(),
          workOrder: {
            objective: 'x',
            constraints: [],
            acceptanceCriteria: [],
            title: 'no',
          } as PostExecutionStateInput['workOrder'],
        }),
      TypeError,
    );
  });

  test('inputs not mutated; returned structure frozen', () => {
    const constraints = ['c1'];
    const files = ['f.ts'];
    const evidenceIds = ['e1'];
    const evidence = [{ id: 'e1', kind: 'build', exitCode: 0 }];
    const input = baseInput({
      workOrder: {
        objective: 'o',
        constraints,
        acceptanceCriteria: ['a'],
      },
      executorResult: {
        status: 'partial',
        summary: 's',
        claimedEvidence: { evidenceIds },
      },
      fileChanges: { files },
      evidence,
    });
    const state = buildPostExecutionState(input);
    constraints.push('hack');
    files.push('hack.ts');
    evidenceIds.push('hack');
    evidence.push({ id: 'x', kind: 'test', exitCode: 1 });
    assert.deepEqual([...state.workOrder.constraints], ['c1']);
    assert.deepEqual([...state.fileChanges.files], ['f.ts']);
    assert.deepEqual([...state.executorResult.claimedEvidence.evidenceIds], ['e1']);
    assert.throws(() => {
      (state.fileChanges.files as string[]).push('no');
    }, TypeError);
    assert.throws(() => {
      (state as { schemaVersion: string }).schemaVersion = 'x';
    }, TypeError);
  });

  test('absent evidence -> build/tests/lint/typecheck not_run', () => {
    const state = buildPostExecutionState(baseInput());
    assert.equal(state.verification.build.status, 'not_run');
    assert.equal(state.verification.tests.status, 'not_run');
    assert.equal(state.verification.lint.status, 'not_run');
    assert.equal(state.verification.typecheck.status, 'not_run');
    assert.deepEqual([...state.verification.build.failedChecks], []);
  });

  test('test exit 1 -> tests failed + failedChecks; build 0 passed; typecheck independent', () => {
    const state = buildPostExecutionState(
      baseInput({
        evidence: [
          { id: 't-fail', kind: 'test', exitCode: 1 },
          { id: 'b-ok', kind: 'build', exitCode: 0 },
          { id: 'tc-fail', kind: 'typecheck', exitCode: 2 },
        ],
      }),
    );
    assert.equal(state.verification.tests.status, 'failed');
    assert.deepEqual(state.verification.tests.failedChecks, [
      { kind: 'test', evidenceId: 't-fail', exitCode: 1 },
    ]);
    assert.equal(state.verification.build.status, 'passed');
    assert.equal(state.verification.typecheck.status, 'failed');
    assert.deepEqual(state.verification.typecheck.failedChecks, [
      { kind: 'typecheck', evidenceId: 'tc-fail', exitCode: 2 },
    ]);
    assert.equal(state.verification.lint.status, 'not_run');
  });

  test('typecheck evidence does not become lint', () => {
    const state = buildPostExecutionState(
      baseInput({
        evidence: [{ id: 'tc', kind: 'typecheck', exitCode: 0 }],
      }),
    );
    assert.equal(state.verification.typecheck.status, 'passed');
    assert.equal(state.verification.lint.status, 'not_run');
  });

  test('evidence without exitCode only -> not_run', () => {
    const state = buildPostExecutionState(
      baseInput({
        evidence: [{ id: 'b', kind: 'build', summary: 'ran' }],
      }),
    );
    assert.equal(state.verification.build.status, 'not_run');
  });

  test('evidenceId only does not invent summary/output on claimed path', () => {
    const state = buildPostExecutionState(
      baseInput({
        executorResult: {
          status: 'completed',
          summary: 'done',
          claimedEvidence: { evidenceIds: ['only-id'] },
        },
      }),
    );
    assert.equal(state.executorResult.claimedEvidence.summaries, undefined);
    assert.deepEqual([...state.executorResult.claimedEvidence.evidenceIds], ['only-id']);
    const json = JSON.stringify(state.executorResult);
    assert.equal(json.includes('"output"'), false);
    assert.equal(json.includes('"command"'), false);
  });

  test('toolCount unknown does not become 0; error/retry unavailable', () => {
    const a = buildPostExecutionState(baseInput({ execution: {} }));
    assert.deepEqual(a.execution.toolCount, { unavailable: true });
    const b = buildPostExecutionState(baseInput({ execution: { toolCount: -1 } }));
    assert.deepEqual(b.execution.toolCount, { unavailable: true });
    const c = buildPostExecutionState(baseInput({ execution: { toolCount: 1.5 } }));
    assert.deepEqual(c.execution.toolCount, { unavailable: true });
    const d = buildPostExecutionState(baseInput());
    assert.deepEqual(d.execution.toolCount, { unavailable: true });
    assert.deepEqual(d.execution.errorCount, { unavailable: true });
    assert.deepEqual(d.execution.retryCount, { unavailable: true });
  });

  test('fileChanges unavailableFields exact three; truncation false/[]', () => {
    const state = buildPostExecutionState(baseInput());
    assert.deepEqual([...state.fileChanges.unavailableFields], [
      'addedLines',
      'removedLines',
      'outsideDeclaredScope',
    ]);
    assert.equal(state.truncation.applied, false);
    assert.deepEqual([...state.truncation.omittedFields], []);
  });

  test('source guard: no kernel/platform/provider/Jev/runner imports', () => {
    const source = readFileSync(stateSrcPath, 'utf8');
    const importLines = source
      .split('\n')
      .filter((line) => /\bfrom\s+'/.test(line) || /\bimport\s*\(/.test(line));
    assert.equal(importLines.length, 0, 'module must have zero imports');
    assert.doesNotMatch(source, /\bfrom\s+'\.\.\/kernel/);
    assert.doesNotMatch(source, /\bfrom\s+'\.\/platform/);
    assert.doesNotMatch(source, /\bDecisionProvider\b/);
    assert.doesNotMatch(source, /\bJev\b/);
    assert.doesNotMatch(source, /decision-shadow-runner/);
    assert.doesNotMatch(source, /\bPASS\b|\bRETRY\b|\bFAIL\b/);
  });
});
