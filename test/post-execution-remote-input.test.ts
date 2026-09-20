/**
 * POST remote truncation (offline) spot-checks.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPostExecutionState } from '../src/application/post-execution-state.ts';
import {
  projectPostExecutionStateForRemote,
  type PostExecutionRemoteBudget,
} from '../src/application/post-execution-remote-input.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const remoteSrcPath = join(root, 'src', 'application', 'post-execution-remote-input.ts');

function generousBudget(over: Partial<PostExecutionRemoteBudget> = {}): PostExecutionRemoteBudget {
  return {
    maxTotalBytes: 100_000,
    maxObjectiveBytes: 10_000,
    maxConstraintItems: 100,
    maxConstraintItemBytes: 10_000,
    maxAcceptanceItems: 100,
    maxAcceptanceItemBytes: 10_000,
    maxSummaryBytes: 10_000,
    maxEvidenceIds: 100,
    maxEvidenceSummaries: 100,
    maxEvidenceSummaryBytes: 10_000,
    maxFiles: 100,
    ...over,
  };
}

function sampleState() {
  return buildPostExecutionState({
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
    evidence: [{ id: 't1', kind: 'test', exitCode: 0 }],
    execution: { toolCount: 2 },
  });
}

describe('projectPostExecutionStateForRemote', () => {
  test('small state under caps: business fields unchanged, applied=false', () => {
    const state = sampleState();
    const remote = projectPostExecutionStateForRemote(state, generousBudget());

    assert.equal(remote.schemaVersion, state.schemaVersion);
    assert.equal(remote.workOrder.objective, state.workOrder.objective);
    assert.deepEqual([...remote.workOrder.constraints], [...state.workOrder.constraints]);
    assert.deepEqual(
      [...remote.workOrder.acceptanceCriteria],
      [...state.workOrder.acceptanceCriteria],
    );
    assert.equal(remote.executorResult.status, state.executorResult.status);
    assert.equal(remote.executorResult.summary, state.executorResult.summary);
    assert.deepEqual(
      [...remote.executorResult.claimedEvidence.evidenceIds],
      [...state.executorResult.claimedEvidence.evidenceIds],
    );
    assert.deepEqual(
      remote.executorResult.claimedEvidence.summaries,
      state.executorResult.claimedEvidence.summaries,
    );
    assert.deepEqual([...remote.fileChanges.files], [...state.fileChanges.files]);
    assert.deepEqual(remote.verification, state.verification);
    assert.deepEqual(remote.execution, state.execution);

    assert.equal(remote.truncation.applied, false);
    assert.deepEqual([...remote.truncation.omittedFields], []);
    const originalBytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
    assert.equal(remote.truncation.originalBytes, originalBytes);
    const emitted = Buffer.byteLength(JSON.stringify(remote), 'utf8');
    assert.equal(remote.truncation.emittedBytes, emitted);
    // remote truncation meta may make emitted > original — allowed
    assert.ok(remote.truncation.emittedBytes > 0);
  });

  test('long unicode truncated on UTF-8 budget without replacement char', () => {
    const emoji = '😀'.repeat(20); // 4 bytes each
    const state = buildPostExecutionState({
      workOrder: {
        objective: emoji,
        constraints: [],
        acceptanceCriteria: [],
      },
      executorResult: {
        status: 'partial',
        summary: 's',
        claimedEvidence: { evidenceIds: [] },
      },
      fileChanges: { files: [] },
    });
    const maxObjectiveBytes = 10; // not multiple of 4 necessarily
    const remote = projectPostExecutionStateForRemote(
      state,
      generousBudget({ maxObjectiveBytes }),
    );
    assert.equal(remote.truncation.applied, true);
    assert.ok(remote.truncation.omittedFields.includes('workOrder.objective'));
    assert.ok(!remote.workOrder.objective.includes('\uFFFD'));
    assert.ok(Buffer.byteLength(remote.workOrder.objective, 'utf8') <= maxObjectiveBytes);
    // full code points only
    for (const ch of remote.workOrder.objective) {
      assert.equal(ch, '😀');
    }
  });

  test('array over items keeps prefix and marks path', () => {
    const state = buildPostExecutionState({
      workOrder: {
        objective: 'o',
        constraints: ['c1', 'c2', 'c3', 'c4'],
        acceptanceCriteria: ['a1', 'a2', 'a3'],
      },
      executorResult: {
        status: 'completed',
        summary: 'sum',
        claimedEvidence: {
          evidenceIds: ['e1', 'e2', 'e3'],
          summaries: [
            { id: 'e1', kind: 'test', summary: 's1' },
            { id: 'e2', kind: 'test', summary: 's2' },
            { id: 'e3', kind: 'test', summary: 's3' },
          ],
        },
      },
      fileChanges: { files: ['f1', 'f2', 'f3'] },
    });
    const remote = projectPostExecutionStateForRemote(
      state,
      generousBudget({
        maxConstraintItems: 2,
        maxAcceptanceItems: 1,
        maxEvidenceIds: 2,
        maxEvidenceSummaries: 1,
        maxFiles: 2,
      }),
    );
    assert.deepEqual([...remote.workOrder.constraints], ['c1', 'c2']);
    assert.deepEqual([...remote.workOrder.acceptanceCriteria], ['a1']);
    assert.deepEqual([...remote.executorResult.claimedEvidence.evidenceIds], ['e1', 'e2']);
    assert.equal(remote.executorResult.claimedEvidence.summaries?.length, 1);
    assert.deepEqual([...remote.fileChanges.files], ['f1', 'f2']);
    assert.equal(remote.truncation.applied, true);
    assert.ok(remote.truncation.omittedFields.includes('workOrder.constraints'));
    assert.ok(remote.truncation.omittedFields.includes('workOrder.acceptanceCriteria'));
    assert.ok(
      remote.truncation.omittedFields.includes('executorResult.claimedEvidence.evidenceIds'),
    );
    assert.ok(
      remote.truncation.omittedFields.includes('executorResult.claimedEvidence.summaries'),
    );
    assert.ok(remote.truncation.omittedFields.includes('fileChanges.files'));
  });

  test('total pressure drops files/summaries before WorkOrder core', () => {
    const longPad = 'x'.repeat(400);
    const state = buildPostExecutionState({
      workOrder: {
        objective: 'KEEP-OBJECTIVE',
        constraints: ['KEEP-CONSTRAINT'],
        acceptanceCriteria: ['KEEP-ACCEPT'],
      },
      executorResult: {
        status: 'completed',
        summary: 'KEEP-SUMMARY-' + longPad,
        claimedEvidence: {
          evidenceIds: ['id-a', 'id-b'],
          summaries: [
            { id: 'id-a', kind: 'test', summary: 'sum-a-' + longPad },
            { id: 'id-b', kind: 'test', summary: 'sum-b-' + longPad },
          ],
        },
      },
      fileChanges: {
        files: ['file-a.ts', 'file-b.ts', 'file-c.ts'],
      },
    });

    const base = projectPostExecutionStateForRemote(state, generousBudget());
    const need = base.truncation.emittedBytes;
    // Cut bulk low-priority payload but leave skeleton + WorkOrder intact
    const maxTotal = need - 600;
    assert.ok(maxTotal > 900, 'fixture must leave room above skeleton');

    const remote = projectPostExecutionStateForRemote(
      state,
      generousBudget({ maxTotalBytes: maxTotal }),
    );

    assert.equal(remote.workOrder.objective, 'KEEP-OBJECTIVE');
    assert.deepEqual([...remote.workOrder.constraints], ['KEEP-CONSTRAINT']);
    assert.deepEqual([...remote.workOrder.acceptanceCriteria], ['KEEP-ACCEPT']);
    assert.ok(remote.fileChanges.files.length < state.fileChanges.files.length);
    assert.ok(
      (remote.executorResult.claimedEvidence.summaries?.length ?? 0) <=
        (state.executorResult.claimedEvidence.summaries?.length ?? 0),
    );
    assert.ok(remote.truncation.omittedFields.includes('fileChanges.files'));
    assert.ok(remote.truncation.emittedBytes <= maxTotal);
  });

  test('tighter total can trim constraints/acceptance/objective after bulk gone', () => {
    const state = buildPostExecutionState({
      workOrder: {
        objective: 'OBJ-' + 'Z'.repeat(200),
        constraints: ['C1-long-' + 'c'.repeat(40), 'C2', 'C3'],
        acceptanceCriteria: ['A1-long-' + 'a'.repeat(40), 'A2'],
      },
      executorResult: {
        status: 'completed',
        summary: 'S',
        claimedEvidence: { evidenceIds: [] },
      },
      fileChanges: { files: [] },
    });
    const full = projectPostExecutionStateForRemote(state, generousBudget());
    const maxTotal = full.truncation.emittedBytes - 80;
    assert.ok(maxTotal > 850);
    const remote = projectPostExecutionStateForRemote(
      state,
      generousBudget({ maxTotalBytes: maxTotal }),
    );
    assert.equal(typeof remote.workOrder.objective, 'string');
    assert.ok('objective' in remote.workOrder);
    assert.ok(
      remote.workOrder.objective.length < state.workOrder.objective.length ||
        remote.workOrder.constraints.length < state.workOrder.constraints.length ||
        remote.workOrder.acceptanceCriteria.length <
          state.workOrder.acceptanceCriteria.length,
    );
    assert.ok(remote.truncation.emittedBytes <= maxTotal);
  });

  test('emittedBytes exact and never over total', () => {
    const longPad = 'y'.repeat(300);
    const state = buildPostExecutionState({
      workOrder: {
        objective: 'obj-' + longPad,
        constraints: ['c-' + longPad],
        acceptanceCriteria: ['a-' + longPad],
      },
      executorResult: {
        status: 'completed',
        summary: 'sum-' + longPad,
        claimedEvidence: {
          evidenceIds: ['e1', 'e2'],
          summaries: [
            { id: 'e1', kind: 'test', summary: 's1-' + longPad },
            { id: 'e2', kind: 'test', summary: 's2-' + longPad },
          ],
        },
      },
      fileChanges: { files: ['f1.ts', 'f2.ts', 'f3.ts'] },
    });
    const full = projectPostExecutionStateForRemote(state, generousBudget());
    const fullBytes = full.truncation.emittedBytes;
    for (const total of [fullBytes, fullBytes - 400, fullBytes - 800, 2500, 1800]) {
      const remote = projectPostExecutionStateForRemote(
        state,
        generousBudget({ maxTotalBytes: total }),
      );
      const json = JSON.stringify(remote);
      assert.equal(remote.truncation.emittedBytes, Buffer.byteLength(json, 'utf8'));
      assert.ok(remote.truncation.emittedBytes <= total);
    }
  });

  test('impossible budget throws budget too small', () => {
    const state = sampleState();
    assert.throws(
      () =>
        projectPostExecutionStateForRemote(
          state,
          generousBudget({ maxTotalBytes: 1 }),
        ),
      (err: unknown) =>
        err instanceof Error && err.message === 'budget too small',
    );
  });

  test('invalid budget throws', () => {
    const state = sampleState();
    assert.throws(() =>
      projectPostExecutionStateForRemote(state, generousBudget({ maxFiles: 0 })),
    );
    assert.throws(() =>
      projectPostExecutionStateForRemote(state, generousBudget({ maxFiles: -1 })),
    );
    assert.throws(() =>
      projectPostExecutionStateForRemote(state, generousBudget({ maxFiles: 1.5 })),
    );
    assert.throws(() =>
      projectPostExecutionStateForRemote(state, generousBudget({ maxFiles: Number.NaN })),
    );
  });

  test('deterministic same input+budget', () => {
    const state = sampleState();
    const b = generousBudget({ maxTotalBytes: 2500, maxFiles: 1 });
    const a = projectPostExecutionStateForRemote(state, b);
    const c = projectPostExecutionStateForRemote(state, b);
    assert.deepEqual(a, c);
    assert.equal(JSON.stringify(a), JSON.stringify(c));
  });

  test('input not mutated', () => {
    const state = sampleState();
    const before = JSON.stringify(state);
    const filesRef = state.fileChanges.files;
    projectPostExecutionStateForRemote(
      state,
      generousBudget({ maxFiles: 1, maxObjectiveBytes: 3 }),
    );
    assert.equal(JSON.stringify(state), before);
    assert.equal(state.fileChanges.files, filesRef);
  });

  test('output deeply frozen', () => {
    const remote = projectPostExecutionStateForRemote(sampleState(), generousBudget());
    assert.ok(Object.isFrozen(remote));
    assert.ok(Object.isFrozen(remote.workOrder));
    assert.ok(Object.isFrozen(remote.workOrder.constraints));
    assert.ok(Object.isFrozen(remote.truncation));
    assert.ok(Object.isFrozen(remote.truncation.omittedFields));
  });

  test('source guard: only post-execution-state type import; no forbidden modules', () => {
    const src = readFileSync(remoteSrcPath, 'utf8');
    assert.match(src, /from '\.\/post-execution-state\.ts'/);
    assert.doesNotMatch(
      src,
      /from ['"][^'"]*(provider|transport|platform|runner|jev|sanitizer)/i,
    );
    assert.doesNotMatch(src, /\bfetch\s*\(/);
    assert.doesNotMatch(src, /from ['"]node:http/);
    assert.doesNotMatch(src, /from ['"].*post-execution-offline/);
  });
});
