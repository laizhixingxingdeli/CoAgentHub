/**
 * POST_EXECUTION 离线投影状态（纯函数）。
 *
 * 不读 Mission / WorkItem / Attempt / Platform。
 * 仅把显式 DTO 投影为 PostExecutionState shape。
 */

const SCHEMA_VERSION = 'post_execution_v1' as const;

const FILE_CHANGE_UNAVAILABLE = Object.freeze([
  'addedLines',
  'removedLines',
  'outsideDeclaredScope',
] as const);

const ALLOWED_ROOT_KEYS = Object.freeze([
  'workOrder',
  'executorResult',
  'fileChanges',
  'evidence',
  'execution',
] as const);

export type ExecutorResultStatus = 'completed' | 'partial';

export type CheckStatus = 'passed' | 'failed' | 'not_run';

export type ClaimedEvidenceSummary = {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
};

export type PostExecutionEvidenceInput = {
  readonly id: string;
  readonly kind: string;
  readonly exitCode?: number;
  readonly summary?: string;
};

export type PostExecutionStateInput = {
  readonly workOrder: {
    readonly objective: string;
    readonly constraints: readonly string[];
    readonly acceptanceCriteria: readonly string[];
  };
  readonly executorResult: {
    readonly status: ExecutorResultStatus;
    readonly summary: string;
    readonly claimedEvidence: {
      readonly evidenceIds: readonly string[];
      readonly summaries?: readonly ClaimedEvidenceSummary[];
    };
  };
  readonly fileChanges: {
    readonly files: readonly string[];
  };
  readonly evidence?: readonly PostExecutionEvidenceInput[];
  readonly execution?: {
    readonly toolCount?: unknown;
  };
};

export type FailedCheck = {
  readonly kind: string;
  readonly evidenceId?: string;
  readonly exitCode?: number;
};

export type VerificationBucket = {
  readonly status: CheckStatus;
  readonly source: 'evidence_projection';
  readonly failedChecks: readonly FailedCheck[];
};

export type CountField = number | { readonly unavailable: true };

export type PostExecutionState = {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly workOrder: {
    readonly objective: string;
    readonly constraints: readonly string[];
    readonly acceptanceCriteria: readonly string[];
  };
  readonly executorResult: {
    readonly status: ExecutorResultStatus;
    readonly summary: string;
    readonly claimedEvidence: {
      readonly evidenceIds: readonly string[];
      readonly summaries?: readonly ClaimedEvidenceSummary[];
    };
  };
  readonly fileChanges: {
    readonly files: readonly string[];
    readonly unavailableFields: readonly [
      'addedLines',
      'removedLines',
      'outsideDeclaredScope',
    ];
  };
  readonly verification: {
    readonly build: VerificationBucket;
    readonly tests: VerificationBucket;
    readonly lint: VerificationBucket;
    readonly typecheck: VerificationBucket;
  };
  readonly execution: {
    readonly toolCount: CountField;
    readonly errorCount: { readonly unavailable: true };
    readonly retryCount: { readonly unavailable: true };
  };
  readonly truncation: {
    readonly applied: false;
    readonly omittedFields: readonly [];
  };
};

function rejectUnknownKeys(
  value: object,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`unknown ${label} field: ${key}`);
    }
  }
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) {
    // Still freeze nested if array/object contents may be mutable refs we own.
  }
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
    return Object.freeze(value) as T;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    freezeDeep(v);
  }
  return Object.freeze(value as object) as T;
}

function copyStrings(xs: readonly string[]): readonly string[] {
  return Object.freeze([...xs]);
}

function projectClaimedSummaries(
  summaries: readonly ClaimedEvidenceSummary[] | undefined,
): readonly ClaimedEvidenceSummary[] | undefined {
  if (summaries === undefined) return undefined;
  return Object.freeze(
    summaries.map((s) =>
      Object.freeze({
        id: s.id,
        kind: s.kind,
        summary: s.summary,
      }),
    ),
  );
}

type CheckKind = 'build' | 'test' | 'lint' | 'typecheck';

function projectCheck(
  evidence: readonly PostExecutionEvidenceInput[],
  kind: CheckKind,
): VerificationBucket {
  const matched = evidence.filter((e) => e.kind === kind);
  if (matched.length === 0) {
    return Object.freeze({
      status: 'not_run' as const,
      source: 'evidence_projection' as const,
      failedChecks: Object.freeze([] as FailedCheck[]),
    });
  }

  const withCode = matched.filter((e) => typeof e.exitCode === 'number');
  if (withCode.length === 0) {
    return Object.freeze({
      status: 'not_run' as const,
      source: 'evidence_projection' as const,
      failedChecks: Object.freeze([] as FailedCheck[]),
    });
  }

  const failures = withCode.filter((e) => e.exitCode !== 0);
  if (failures.length > 0) {
    return Object.freeze({
      status: 'failed' as const,
      source: 'evidence_projection' as const,
      failedChecks: Object.freeze(
        failures.map((e) =>
          Object.freeze({
            kind: e.kind,
            evidenceId: e.id,
            exitCode: e.exitCode as number,
          }),
        ),
      ),
    });
  }

  // 至少一个 exitCode=0 且无非 0
  return Object.freeze({
    status: 'passed' as const,
    source: 'evidence_projection' as const,
    failedChecks: Object.freeze([] as FailedCheck[]),
  });
}

function projectToolCount(raw: unknown): CountField {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return raw;
  }
  return Object.freeze({ unavailable: true as const });
}

/**
 * 纯投影：显式 DTO → PostExecutionState。
 * 未知根字段抛 TypeError；不持有输入可变引用。
 */
export function buildPostExecutionState(input: PostExecutionStateInput): PostExecutionState {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('buildPostExecutionState input must be a plain object');
  }
  rejectUnknownKeys(input, ALLOWED_ROOT_KEYS, 'PostExecutionStateInput');

  const workOrder = input.workOrder;
  if (workOrder === null || typeof workOrder !== 'object') {
    throw new TypeError('workOrder required');
  }
  rejectUnknownKeys(workOrder, ['objective', 'constraints', 'acceptanceCriteria'], 'workOrder');

  const executorResult = input.executorResult;
  if (executorResult === null || typeof executorResult !== 'object') {
    throw new TypeError('executorResult required');
  }
  rejectUnknownKeys(executorResult, ['status', 'summary', 'claimedEvidence'], 'executorResult');

  const claimed = executorResult.claimedEvidence;
  if (claimed === null || typeof claimed !== 'object') {
    throw new TypeError('claimedEvidence required');
  }
  rejectUnknownKeys(claimed, ['evidenceIds', 'summaries'], 'claimedEvidence');

  const fileChanges = input.fileChanges;
  if (fileChanges === null || typeof fileChanges !== 'object') {
    throw new TypeError('fileChanges required');
  }
  rejectUnknownKeys(fileChanges, ['files'], 'fileChanges');

  if (input.execution !== undefined) {
    if (input.execution === null || typeof input.execution !== 'object') {
      throw new TypeError('execution must be an object');
    }
    rejectUnknownKeys(input.execution, ['toolCount'], 'execution');
  }

  if (input.evidence !== undefined && !Array.isArray(input.evidence)) {
    throw new TypeError('evidence must be an array');
  }

  const evidenceCopy: readonly PostExecutionEvidenceInput[] = Object.freeze(
    (input.evidence ?? []).map((e) => {
      if (e === null || typeof e !== 'object') {
        throw new TypeError('evidence entry must be an object');
      }
      rejectUnknownKeys(e, ['id', 'kind', 'exitCode', 'summary'], 'evidence');
      const out: {
        id: string;
        kind: string;
        exitCode?: number;
        summary?: string;
      } = { id: e.id, kind: e.kind };
      if (typeof e.exitCode === 'number') out.exitCode = e.exitCode;
      if (typeof e.summary === 'string') out.summary = e.summary;
      return Object.freeze(out);
    }),
  );

  const status = executorResult.status;
  if (status !== 'completed' && status !== 'partial') {
    throw new TypeError(`invalid executorResult.status: ${String(status)}`);
  }

  const claimedSummaries = projectClaimedSummaries(claimed.summaries);

  const state: PostExecutionState = {
    schemaVersion: SCHEMA_VERSION,
    workOrder: Object.freeze({
      objective: workOrder.objective,
      constraints: copyStrings(workOrder.constraints),
      acceptanceCriteria: copyStrings(workOrder.acceptanceCriteria),
    }),
    executorResult: Object.freeze({
      status,
      summary: executorResult.summary,
      claimedEvidence: Object.freeze({
        evidenceIds: copyStrings(claimed.evidenceIds),
        ...(claimedSummaries !== undefined ? { summaries: claimedSummaries } : {}),
      }),
    }),
    fileChanges: Object.freeze({
      files: copyStrings(fileChanges.files),
      unavailableFields: FILE_CHANGE_UNAVAILABLE,
    }),
    verification: Object.freeze({
      build: projectCheck(evidenceCopy, 'build'),
      // evidence kind 'test' projects to verification.tests
      tests: projectCheck(evidenceCopy, 'test'),
      // no lint kind in current evidence set => not_run unless kind==='lint'
      lint: projectCheck(evidenceCopy, 'lint'),
      typecheck: projectCheck(evidenceCopy, 'typecheck'),
    }),
    execution: Object.freeze({
      toolCount: projectToolCount(input.execution?.toolCount),
      errorCount: Object.freeze({ unavailable: true as const }),
      retryCount: Object.freeze({ unavailable: true as const }),
    }),
    truncation: Object.freeze({
      applied: false as const,
      omittedFields: Object.freeze([] as const),
    }),
  };

  return freezeDeep(state);
}
