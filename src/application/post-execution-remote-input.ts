/**
 * POST_EXECUTION remote projection: pure offline truncation / budgeting.
 * Application-layer only; no I/O side effects.
 */

import type { PostExecutionState } from './post-execution-state.ts';

export type PostExecutionRemoteBudget = {
  readonly maxTotalBytes: number;
  readonly maxObjectiveBytes: number;
  readonly maxConstraintItems: number;
  readonly maxConstraintItemBytes: number;
  readonly maxAcceptanceItems: number;
  readonly maxAcceptanceItemBytes: number;
  readonly maxSummaryBytes: number;
  readonly maxEvidenceIds: number;
  readonly maxEvidenceSummaries: number;
  readonly maxEvidenceSummaryBytes: number;
  readonly maxFiles: number;
};

export type PostExecutionRemoteTruncation = {
  readonly applied: boolean;
  readonly omittedFields: readonly string[];
  readonly originalBytes: number;
  readonly emittedBytes: number;
};

export type PostExecutionRemoteState = {
  readonly schemaVersion: PostExecutionState['schemaVersion'];
  readonly workOrder: PostExecutionState['workOrder'];
  readonly executorResult: PostExecutionState['executorResult'];
  readonly fileChanges: PostExecutionState['fileChanges'];
  readonly verification: PostExecutionState['verification'];
  readonly execution: PostExecutionState['execution'];
  readonly truncation: PostExecutionRemoteTruncation;
};

const BUDGET_KEYS = [
  'maxTotalBytes',
  'maxObjectiveBytes',
  'maxConstraintItems',
  'maxConstraintItemBytes',
  'maxAcceptanceItems',
  'maxAcceptanceItemBytes',
  'maxSummaryBytes',
  'maxEvidenceIds',
  'maxEvidenceSummaries',
  'maxEvidenceSummaryBytes',
  'maxFiles',
] as const;

const PATH_OBJECTIVE = 'workOrder.objective';
const PATH_CONSTRAINTS = 'workOrder.constraints';
const PATH_ACCEPTANCE = 'workOrder.acceptanceCriteria';
const PATH_SUMMARY = 'executorResult.summary';
const PATH_EVIDENCE_IDS = 'executorResult.claimedEvidence.evidenceIds';
const PATH_SUMMARIES = 'executorResult.claimedEvidence.summaries';
const PATH_FILES = 'fileChanges.files';

/** Stable omittedFields order when first recorded. */
const OMIT_ORDER = [
  PATH_OBJECTIVE,
  PATH_CONSTRAINTS,
  PATH_ACCEPTANCE,
  PATH_SUMMARY,
  PATH_EVIDENCE_IDS,
  PATH_SUMMARIES,
  PATH_FILES,
] as const;

type Working = {
  objective: string;
  constraints: string[];
  acceptance: string[];
  status: PostExecutionState['executorResult']['status'];
  summary: string;
  evidenceIds: string[];
  summaries: { id: string; kind: string; summary: string }[] | undefined;
  files: string[];
  unavailableFields: PostExecutionState['fileChanges']['unavailableFields'];
  verification: PostExecutionState['verification'];
  execution: PostExecutionState['execution'];
  schemaVersion: PostExecutionState['schemaVersion'];
};

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** UTF-8 safe prefix truncation by code points (no broken surrogates). */
function truncateUtf8Prefix(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(s) <= maxBytes) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const b = utf8Bytes(ch);
    if (used + b > maxBytes) break;
    out += ch;
    used += b;
  }
  return out;
}

function assertPositiveIntBudget(budget: PostExecutionRemoteBudget): void {
  if (budget === null || typeof budget !== 'object' || Array.isArray(budget)) {
    throw new TypeError('budget must be a plain object');
  }
  for (const key of BUDGET_KEYS) {
    const v = (budget as Record<string, unknown>)[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || Number.isNaN(v)) {
      throw new TypeError(`budget.${key} must be a positive integer`);
    }
  }
}

function cloneVerification(
  v: PostExecutionState['verification'],
): PostExecutionState['verification'] {
  const cloneBucket = (b: PostExecutionState['verification']['build']) =>
    Object.freeze({
      status: b.status,
      source: b.source,
      failedChecks: Object.freeze(
        b.failedChecks.map((f) => {
          const o: { kind: string; evidenceId?: string; exitCode?: number } = {
            kind: f.kind,
          };
          if (f.evidenceId !== undefined) o.evidenceId = f.evidenceId;
          if (f.exitCode !== undefined) o.exitCode = f.exitCode;
          return Object.freeze(o);
        }),
      ),
    });
  return Object.freeze({
    build: cloneBucket(v.build),
    tests: cloneBucket(v.tests),
    lint: cloneBucket(v.lint),
    typecheck: cloneBucket(v.typecheck),
  });
}

function cloneExecution(e: PostExecutionState['execution']): PostExecutionState['execution'] {
  const toolCount =
    typeof e.toolCount === 'number'
      ? e.toolCount
      : Object.freeze({ unavailable: true as const });
  return Object.freeze({
    toolCount,
    errorCount: Object.freeze({ unavailable: true as const }),
    retryCount: Object.freeze({ unavailable: true as const }),
  });
}

function toWorking(state: PostExecutionState): Working {
  const summaries = state.executorResult.claimedEvidence.summaries;
  return {
    schemaVersion: state.schemaVersion,
    objective: state.workOrder.objective,
    constraints: [...state.workOrder.constraints],
    acceptance: [...state.workOrder.acceptanceCriteria],
    status: state.executorResult.status,
    summary: state.executorResult.summary,
    evidenceIds: [...state.executorResult.claimedEvidence.evidenceIds],
    summaries:
      summaries === undefined
        ? undefined
        : summaries.map((s) => ({ id: s.id, kind: s.kind, summary: s.summary })),
    files: [...state.fileChanges.files],
    unavailableFields: state.fileChanges.unavailableFields,
    verification: cloneVerification(state.verification),
    execution: cloneExecution(state.execution),
  };
}

function markOmitted(set: Set<string>, path: string): void {
  set.add(path);
}

function orderedOmitted(set: Set<string>): string[] {
  return OMIT_ORDER.filter((p) => set.has(p));
}

function applyPerFieldCaps(
  w: Working,
  budget: PostExecutionRemoteBudget,
  omitted: Set<string>,
): void {
  const obj2 = truncateUtf8Prefix(w.objective, budget.maxObjectiveBytes);
  if (obj2 !== w.objective) {
    markOmitted(omitted, PATH_OBJECTIVE);
    w.objective = obj2;
  }

  let constraints = w.constraints;
  if (constraints.length > budget.maxConstraintItems) {
    constraints = constraints.slice(0, budget.maxConstraintItems);
    markOmitted(omitted, PATH_CONSTRAINTS);
  }
  const cOut: string[] = [];
  for (let i = 0; i < constraints.length; i++) {
    const t = truncateUtf8Prefix(constraints[i]!, budget.maxConstraintItemBytes);
    if (t !== constraints[i]) markOmitted(omitted, PATH_CONSTRAINTS);
    cOut.push(t);
  }
  w.constraints = cOut;

  let acceptance = w.acceptance;
  if (acceptance.length > budget.maxAcceptanceItems) {
    acceptance = acceptance.slice(0, budget.maxAcceptanceItems);
    markOmitted(omitted, PATH_ACCEPTANCE);
  }
  const aOut: string[] = [];
  for (let i = 0; i < acceptance.length; i++) {
    const t = truncateUtf8Prefix(acceptance[i]!, budget.maxAcceptanceItemBytes);
    if (t !== acceptance[i]) markOmitted(omitted, PATH_ACCEPTANCE);
    aOut.push(t);
  }
  w.acceptance = aOut;

  const sum2 = truncateUtf8Prefix(w.summary, budget.maxSummaryBytes);
  if (sum2 !== w.summary) {
    markOmitted(omitted, PATH_SUMMARY);
    w.summary = sum2;
  }

  if (w.evidenceIds.length > budget.maxEvidenceIds) {
    w.evidenceIds = w.evidenceIds.slice(0, budget.maxEvidenceIds);
    markOmitted(omitted, PATH_EVIDENCE_IDS);
  }

  if (w.summaries !== undefined) {
    let sums = w.summaries;
    if (sums.length > budget.maxEvidenceSummaries) {
      sums = sums.slice(0, budget.maxEvidenceSummaries);
      markOmitted(omitted, PATH_SUMMARIES);
    }
    const sOut: { id: string; kind: string; summary: string }[] = [];
    for (const s of sums) {
      const t = truncateUtf8Prefix(s.summary, budget.maxEvidenceSummaryBytes);
      if (t !== s.summary) markOmitted(omitted, PATH_SUMMARIES);
      sOut.push({ id: s.id, kind: s.kind, summary: t });
    }
    w.summaries = sOut;
  }

  if (w.files.length > budget.maxFiles) {
    w.files = w.files.slice(0, budget.maxFiles);
    markOmitted(omitted, PATH_FILES);
  }
}

/**
 * Fixed key order for deterministic JSON.stringify.
 */
function buildRemoteObject(
  w: Working,
  truncation: {
    applied: boolean;
    omittedFields: readonly string[];
    originalBytes: number;
    emittedBytes: number;
  },
): Record<string, unknown> {
  const claimed: Record<string, unknown> = {
    evidenceIds: w.evidenceIds,
  };
  if (w.summaries !== undefined) {
    claimed.summaries = w.summaries.map((s) => ({
      id: s.id,
      kind: s.kind,
      summary: s.summary,
    }));
  }

  return {
    schemaVersion: w.schemaVersion,
    workOrder: {
      objective: w.objective,
      constraints: w.constraints,
      acceptanceCriteria: w.acceptance,
    },
    executorResult: {
      status: w.status,
      summary: w.summary,
      claimedEvidence: claimed,
    },
    fileChanges: {
      files: w.files,
      unavailableFields: [...w.unavailableFields],
    },
    verification: w.verification,
    execution: w.execution,
    truncation: {
      applied: truncation.applied,
      omittedFields: [...truncation.omittedFields],
      originalBytes: truncation.originalBytes,
      emittedBytes: truncation.emittedBytes,
    },
  };
}

function measureEmitted(
  w: Working,
  applied: boolean,
  omittedFields: readonly string[],
  originalBytes: number,
): { bytes: number; obj: Record<string, unknown> } {
  let emittedBytes = 0;
  let obj: Record<string, unknown> = buildRemoteObject(w, {
    applied,
    omittedFields,
    originalBytes,
    emittedBytes,
  });
  for (let i = 0; i < 16; i++) {
    const json = JSON.stringify(obj);
    const bytes = utf8Bytes(json);
    if (bytes === emittedBytes) {
      return { bytes, obj };
    }
    emittedBytes = bytes;
    obj = buildRemoteObject(w, {
      applied,
      omittedFields,
      originalBytes,
      emittedBytes,
    });
  }
  const json = JSON.stringify(obj);
  return { bytes: utf8Bytes(json), obj };
}

function canReduce(w: Working): boolean {
  if (w.files.length > 0) return true;
  if (w.summaries !== undefined && w.summaries.length > 0) return true;
  if (w.evidenceIds.length > 0) return true;
  if (w.summary.length > 0) return true;
  if (w.constraints.length > 0) return true;
  if (w.acceptance.length > 0) return true;
  if (w.objective.length > 0) return true;
  return false;
}

/**
 * Total-budget phase: drop/shrink lowest priority first.
 * Priority (drop first): files → summaries → evidenceIds → summary → constraints → acceptance → objective
 */
function shrinkStringField(s: string): string {
  const cur = utf8Bytes(s);
  if (cur <= 0) return '';
  // Prefer large steps so metadata growth is amortized.
  const next = Math.max(0, Math.floor(cur * 0.5));
  let t = truncateUtf8Prefix(s, next);
  if (t === s) t = truncateUtf8Prefix(s, Math.max(0, cur - 1));
  if (t.length > 0 && utf8Bytes(t) >= cur) t = '';
  return t;
}

function reduceOnce(w: Working, omitted: Set<string>): void {
  // Drop whole low-priority collections first (stable priority order).
  if (w.files.length > 0) {
    w.files = [];
    markOmitted(omitted, PATH_FILES);
    return;
  }
  if (w.summaries !== undefined && w.summaries.length > 0) {
    w.summaries = [];
    markOmitted(omitted, PATH_SUMMARIES);
    return;
  }
  if (w.evidenceIds.length > 0) {
    w.evidenceIds = [];
    markOmitted(omitted, PATH_EVIDENCE_IDS);
    return;
  }
  if (w.summary.length > 0) {
    w.summary = shrinkStringField(w.summary);
    markOmitted(omitted, PATH_SUMMARY);
    return;
  }
  if (w.constraints.length > 0) {
    w.constraints = [];
    markOmitted(omitted, PATH_CONSTRAINTS);
    return;
  }
  if (w.acceptance.length > 0) {
    w.acceptance = [];
    markOmitted(omitted, PATH_ACCEPTANCE);
    return;
  }
  if (w.objective.length > 0) {
    w.objective = shrinkStringField(w.objective);
    markOmitted(omitted, PATH_OBJECTIVE);
    return;
  }
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
    return Object.freeze(value) as T;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    freezeDeep(v);
  }
  return Object.freeze(value as object) as T;
}

function materialize(obj: Record<string, unknown>): PostExecutionRemoteState {
  return freezeDeep(obj) as unknown as PostExecutionRemoteState;
}

/**
 * Project PostExecutionState into a remote-safe truncated snapshot under budget.
 * Pure; does not mutate input; deep-freezes output.
 */
export function projectPostExecutionStateForRemote(
  state: PostExecutionState,
  budget: PostExecutionRemoteBudget,
): PostExecutionRemoteState {
  assertPositiveIntBudget(budget);

  if (state === null || typeof state !== 'object') {
    throw new TypeError('state must be an object');
  }

  const originalBytes = utf8Bytes(JSON.stringify(state));
  const omitted = new Set<string>();
  const w = toWorking(state);

  applyPerFieldCaps(w, budget, omitted);

  // Total budget loop
  for (;;) {
    const omittedFields = orderedOmitted(omitted);
    const applied = omittedFields.length > 0;
    const measured = measureEmitted(w, applied, omittedFields, originalBytes);
    if (measured.bytes <= budget.maxTotalBytes) {
      return materialize(measured.obj);
    }
    if (!canReduce(w)) {
      throw new Error('budget too small');
    }
    reduceOnce(w, omitted);
  }
}
