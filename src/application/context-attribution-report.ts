/**
 * 只读逐 Attempt 归因投影。
 *
 * 不走 FileStateStore / Platform / 简报装配：那些入口会 hydrate、写审计、甚至
 * 收敛 Attempt。这里只吃已经解析好的 version:1 JSON，缺什么就标 unknown/partial，
 * 绝不把未见信号填成 0，也不把 Bundle 估算写进模型用量。
 *
 * 输出是白名单：多一个字段就会把 event.data / resumeRef / 路径带出去。
 */

export const CONTEXT_ATTRIBUTION_ERROR_CODE = 'CONTEXT_ATTRIBUTION_INPUT_ERROR';

/** Attempt.recordToolCall 的尾部上限；满了就不知道真实次数，不能把 200 当总数。 */
export const TOOL_ACTIVITY_TAIL_MAX = 200;

export const CONTEXT_ATTRIBUTION_REASONS = Object.freeze({
  NO_ATTRIBUTABLE_EVENTS: 'no_attributable_events',
  TOOL_ACTIVITY_MISSING: 'tool_activity_missing',
  TOOL_ACTIVITY_TAIL_CAPPED: 'tool_activity_tail_capped',
  USAGE_MISSING: 'usage_missing',
  TRUNCATION_AUDIT_ABSENT: 'truncation_audit_absent',
  TRUNCATION_AUDIT_INCOMPLETE: 'truncation_audit_incomplete',
  LIVE_DATA_INCOMPLETE: 'live_data_incomplete',
  ARCHIVE_PACKAGE_MISSING: 'archive_package_missing',
  ARCHIVE_INTEGRITY_UNVERIFIED: 'archive_integrity_unverified',
  ARCHIVE_INDEX_MISMATCH: 'archive_index_mismatch',
});

export type ContextAttributionReason =
  (typeof CONTEXT_ATTRIBUTION_REASONS)[keyof typeof CONTEXT_ATTRIBUTION_REASONS];

export type SignalCoverage = 'complete' | 'partial' | 'unknown';

export type ContextAttributionRole = 'coordinator' | 'executor' | 'independent_reviewer';

export type ContextAttributionStatus = 'in_progress' | 'succeeded' | 'failed';

export type ContextAttributionUsageQuality = 'reported' | 'estimated' | 'unknown';

/** 合法用量。缺字段或 quality 不可信时整段省略，不造零。 */
export interface ContextAttributionUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
  readonly quality: Exclude<ContextAttributionUsageQuality, 'unknown'>;
}

export interface ContextAttributionToolCount {
  readonly name: string;
  readonly count: number;
}

/** 仅来自已落盘的 context.truncated；不是模型 token，也不是节省量。 */
export interface ContextAttributionTruncation {
  readonly budget: number;
  readonly estimatedBefore: number;
  readonly estimatedAfter: number;
}

export interface ContextAttributionRow {
  readonly missionId: string;
  readonly attemptId: string;
  readonly role: ContextAttributionRole;
  readonly status: ContextAttributionStatus;
  readonly usage?: ContextAttributionUsage;
  readonly usageCoverage: SignalCoverage;
  readonly toolCounts: readonly ContextAttributionToolCount[];
  readonly toolCoverage: SignalCoverage;
  readonly truncation?: ContextAttributionTruncation;
  readonly truncationCoverage: SignalCoverage;
  readonly reasons: readonly ContextAttributionReason[];
}

export interface ContextAttributionReport {
  readonly version: 1;
  readonly rows: readonly ContextAttributionRow[];
  readonly liveCoverage: SignalCoverage;
  readonly archiveCoverage: SignalCoverage;
  readonly reasons: readonly ContextAttributionReason[];
}

export class ContextAttributionInputError extends Error {
  readonly code: string;
  constructor() {
    super(CONTEXT_ATTRIBUTION_ERROR_CODE);
    this.name = 'ContextAttributionInputError';
    this.code = CONTEXT_ATTRIBUTION_ERROR_CODE;
  }
}

const ROLES = new Set<ContextAttributionRole>([
  'coordinator',
  'executor',
  'independent_reviewer',
]);
const STATUSES = new Set<ContextAttributionStatus>(['in_progress', 'succeeded', 'failed']);
const USAGE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const;
const CONTEXT_TRUNCATED_KIND = 'context.truncated';
/** 与 file-store 归档 id 同形：过不了的当夹带，整行丢掉而不是原样吐出去。 */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_TOOL_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const UNTRUSTED_TOOL_NAME = 'untrusted';

/** CLI 对原始 package 字节算出来的完整性；纯投影没有字节时不要传，覆盖只能 partial。 */
export interface ContextAttributionArchiveIntegrity {
  readonly bytes: number;
  readonly sha256: string;
}

interface ArchiveRef {
  readonly projectId: string;
  readonly missionId: string;
  readonly bytes: number | undefined;
  readonly sha256: string | undefined;
}

type AttemptSource = 'live' | 'archive';

interface NormalizedAttempt {
  readonly missionId: string;
  readonly attemptId: string;
  readonly role: ContextAttributionRole;
  readonly status: ContextAttributionStatus;
  readonly usage: unknown;
  readonly toolActivity: unknown;
  readonly source: AttemptSource;
}

interface TruncationAudit {
  readonly budget: number;
  readonly estimatedBefore: number;
  readonly estimatedAfter: number;
}

interface DedupedEvent {
  readonly missionId: string;
  readonly attemptId: string;
  readonly kind: string;
  readonly data: unknown;
}

export function buildContextAttributionReport(
  state: unknown,
  archivePackages: readonly unknown[] = [],
  archiveIntegrity: readonly unknown[] = [],
): ContextAttributionReport {
  const live = parseLiveState(state);
  const packages = archivePackages.map(parseArchivePackage);

  const seenAttemptKeys = new Set<string>();
  const attempts: NormalizedAttempt[] = [];
  ingestMissions(live.missions, seenAttemptKeys, attempts, 'live');

  const provided: ProvidedArchive[] = [];
  for (let i = 0; i < packages.length; i += 1) {
    const pkg = packages[i]!;
    ingestMissions([pkg.mission], seenAttemptKeys, attempts, 'archive');
    provided.push({
      projectId: pkg.projectId,
      missionId: pkg.missionId,
      integrity: parseIntegrity(archiveIntegrity[i]),
    });
  }

  const events = dedupeEvents([...live.events, ...packages.flatMap((pkg) => pkg.events)]);
  const truncByAttempt = collectTruncation(events);
  const eventAttempts = new Set(events.map((event) => attemptKey(event.missionId, event.attemptId)));

  const rows = attempts
    .map((attempt) => projectRow(attempt, truncByAttempt, eventAttempts, live.incomplete))
    .sort(compareRows);

  const reportReasons: ContextAttributionReason[] = [];
  const liveCoverage = live.incomplete ? 'partial' : 'complete';
  if (live.incomplete) reportReasons.push(CONTEXT_ATTRIBUTION_REASONS.LIVE_DATA_INCOMPLETE);

  const archive = archiveCoverageOf(live.archiveRefs, live.archiveIndexInvalid, provided);
  reportReasons.push(...archive.reasons);

  return Object.freeze({
    version: 1 as const,
    rows: Object.freeze(rows),
    liveCoverage,
    archiveCoverage: archive.coverage,
    reasons: Object.freeze(uniqReasons(reportReasons)),
  });
}

interface ProvidedArchive {
  readonly projectId: string;
  readonly missionId: string;
  readonly integrity: ContextAttributionArchiveIntegrity | undefined;
}

function parseLiveState(state: unknown): {
  missions: unknown[];
  events: unknown[];
  archiveRefs: ArchiveRef[];
  incomplete: boolean;
  archiveIndexInvalid: boolean;
} {
  if (!isPlainObject(state) || state.version !== 1 || !Array.isArray(state.projects)) {
    throw new ContextAttributionInputError();
  }
  let incomplete = false;
  const missions: unknown[] = [];
  for (const project of state.projects) {
    if (!isPlainObject(project)) {
      incomplete = true;
      continue;
    }
    if (!Array.isArray(project.missions)) {
      incomplete = true;
      continue;
    }
    for (const mission of project.missions) missions.push(mission);
  }

  let events: unknown[] = [];
  if (!Object.prototype.hasOwnProperty.call(state, 'events')) {
    incomplete = true;
  } else if (!Array.isArray(state.events)) {
    incomplete = true;
  } else {
    events = state.events;
  }

  const archiveRefs: ArchiveRef[] = [];
  let archiveIndexInvalid = false;
  if (Object.prototype.hasOwnProperty.call(state, 'archivedMissions')) {
    if (!Array.isArray(state.archivedMissions)) {
      incomplete = true;
      archiveIndexInvalid = true;
    } else {
      for (const ref of state.archivedMissions) {
        if (!isPlainObject(ref)) {
          incomplete = true;
          archiveIndexInvalid = true;
          continue;
        }
        const projectId = safeId(ref.projectId);
        const missionId = safeId(ref.missionId);
        if (!projectId || !missionId) {
          incomplete = true;
          archiveIndexInvalid = true;
          continue;
        }
        const integrity = parseIntegrity(ref);
        archiveRefs.push({
          projectId,
          missionId,
          bytes: integrity?.bytes,
          sha256: integrity?.sha256,
        });
      }
    }
  }

  return { missions, events, archiveRefs, incomplete, archiveIndexInvalid };
}

function parseArchivePackage(value: unknown): {
  projectId: string;
  missionId: string;
  mission: unknown;
  events: unknown[];
} {
  if (!isPlainObject(value) || value.version !== 1) throw new ContextAttributionInputError();
  const projectId = safeId(value.projectId);
  const missionId = safeId(value.missionId);
  if (!projectId || !missionId) throw new ContextAttributionInputError();
  if (!isPlainObject(value.mission)) throw new ContextAttributionInputError();
  if (!Array.isArray(value.events)) throw new ContextAttributionInputError();
  const missionIdOnMission = value.mission.id;
  if (typeof missionIdOnMission === 'string' && missionIdOnMission !== missionId) {
    throw new ContextAttributionInputError();
  }
  const mission = { ...value.mission, id: missionId, projectId };
  return { projectId, missionId, mission, events: value.events };
}

function ingestMissions(
  missions: readonly unknown[],
  seenAttemptKeys: Set<string>,
  out: NormalizedAttempt[],
  source: AttemptSource,
): void {
  for (const mission of missions) {
    if (!isPlainObject(mission)) continue;
    const missionId = safeId(mission.id);
    if (!missionId) continue;
    collectAttempts(missionId, 'coordinator', mission.coordinatorAttempts, seenAttemptKeys, out, source);
    collectAttempts(
      missionId,
      'independent_reviewer',
      mission.independentReviewerAttempts,
      seenAttemptKeys,
      out,
      source,
    );
    if (!Array.isArray(mission.workItems)) continue;
    for (const item of mission.workItems) {
      if (!isPlainObject(item)) continue;
      collectAttempts(missionId, 'executor', item.attempts, seenAttemptKeys, out, source);
    }
  }
}

function collectAttempts(
  missionId: string,
  expectedRole: ContextAttributionRole,
  raw: unknown,
  seenAttemptKeys: Set<string>,
  out: NormalizedAttempt[],
  source: AttemptSource,
): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) return;
  for (const attempt of raw) {
    if (!isPlainObject(attempt)) continue;
    const attemptId = safeId(attempt.id);
    if (!attemptId) continue;
    const role = parseRole(attempt.kind) ?? expectedRole;
    if (role !== expectedRole) continue;
    const status = parseStatus(attempt.status);
    if (!status) continue;
    const key = `${missionId}\0${role}\0${attemptId}`;
    if (seenAttemptKeys.has(key)) continue;
    seenAttemptKeys.add(key);
    out.push({
      missionId,
      attemptId,
      role,
      status,
      usage: attempt.usage,
      toolActivity: attempt.toolActivity,
      source,
    });
  }
}

function projectRow(
  attempt: NormalizedAttempt,
  truncByAttempt: ReadonlyMap<string, TruncationAudit>,
  eventAttempts: ReadonlySet<string>,
  liveIncomplete: boolean,
): ContextAttributionRow {
  const reasons: ContextAttributionReason[] = [];
  const usage = parseUsage(attempt.usage);
  const usageCoverage: SignalCoverage = usage ? 'complete' : 'unknown';
  if (!usage) reasons.push(CONTEXT_ATTRIBUTION_REASONS.USAGE_MISSING);

  const tools = parseToolCounts(attempt.toolActivity);
  let toolCoverage: SignalCoverage;
  if (tools === undefined) {
    toolCoverage = 'unknown';
    reasons.push(CONTEXT_ATTRIBUTION_REASONS.TOOL_ACTIVITY_MISSING);
  } else if (tools.capped) {
    toolCoverage = 'partial';
    reasons.push(CONTEXT_ATTRIBUTION_REASONS.TOOL_ACTIVITY_TAIL_CAPPED);
  } else {
    toolCoverage = 'complete';
  }

  const attributed = eventAttempts.has(attemptKey(attempt.missionId, attempt.attemptId));
  if (!attributed) reasons.push(CONTEXT_ATTRIBUTION_REASONS.NO_ATTRIBUTABLE_EVENTS);

  const truncation = truncByAttempt.get(attemptKey(attempt.missionId, attempt.attemptId));
  // live 事件流不完整时不能把见到的那条 context.truncated 当成全量审计。
  const liveEventsUnproven = liveIncomplete && attempt.source === 'live';
  let truncationCoverage: SignalCoverage;
  if (!truncation) {
    truncationCoverage = 'unknown';
    reasons.push(CONTEXT_ATTRIBUTION_REASONS.TRUNCATION_AUDIT_ABSENT);
    if (liveEventsUnproven) reasons.push(CONTEXT_ATTRIBUTION_REASONS.LIVE_DATA_INCOMPLETE);
  } else if (liveEventsUnproven) {
    truncationCoverage = 'partial';
    reasons.push(CONTEXT_ATTRIBUTION_REASONS.TRUNCATION_AUDIT_INCOMPLETE);
    reasons.push(CONTEXT_ATTRIBUTION_REASONS.LIVE_DATA_INCOMPLETE);
  } else {
    truncationCoverage = 'complete';
  }

  const row: ContextAttributionRow = {
    missionId: attempt.missionId,
    attemptId: attempt.attemptId,
    role: attempt.role,
    status: attempt.status,
    ...(usage ? { usage } : {}),
    usageCoverage,
    toolCounts: Object.freeze(tools?.counts ?? []),
    toolCoverage,
    ...(truncation ? { truncation } : {}),
    truncationCoverage,
    reasons: Object.freeze(uniqReasons(reasons)),
  };
  return Object.freeze(row);
}

function parseUsage(value: unknown): ContextAttributionUsage | undefined {
  if (!isPlainObject(value)) return undefined;
  const quality = value.quality;
  if (quality !== 'reported' && quality !== 'estimated') return undefined;
  const out: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    quality: 'reported' | 'estimated';
  } = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, quality };
  for (const field of USAGE_FIELDS) {
    const n = value[field];
    if (!Number.isInteger(n) || (n as number) < 0) return undefined;
    out[field] = n as number;
  }
  return Object.freeze(out);
}

function parseToolCounts(
  value: unknown,
): { counts: ContextAttributionToolCount[]; capped: boolean } | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const tallies = new Map<string, number>();
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const rawName = typeof item.name === 'string' ? item.name : '';
    const name = SAFE_TOOL_RE.test(rawName) ? rawName : UNTRUSTED_TOOL_NAME;
    tallies.set(name, (tallies.get(name) ?? 0) + 1);
  }
  const counts = [...tallies.entries()]
    .sort((a, b) => compareString(a[0], b[0]))
    .map(([name, count]) => Object.freeze({ name, count }));
  return { counts, capped: value.length >= TOOL_ACTIVITY_TAIL_MAX };
}

function collectTruncation(events: readonly DedupedEvent[]): Map<string, TruncationAudit> {
  const out = new Map<string, TruncationAudit>();
  for (const event of events) {
    if (event.kind !== CONTEXT_TRUNCATED_KIND) continue;
    const key = attemptKey(event.missionId, event.attemptId);
    if (out.has(key)) continue;
    const audit = parseTruncation(event.data);
    if (!audit) continue;
    out.set(key, audit);
  }
  return out;
}

function parseTruncation(data: unknown): TruncationAudit | undefined {
  if (!isPlainObject(data)) return undefined;
  const budget = data.budget;
  const estimatedBefore = data.estimatedBefore;
  const estimatedAfter = data.estimatedAfter;
  if (!isFiniteNonNegative(budget) || !isFiniteNonNegative(estimatedBefore) || !isFiniteNonNegative(estimatedAfter)) {
    return undefined;
  }
  return Object.freeze({ budget, estimatedBefore, estimatedAfter });
}

function dedupeEvents(raw: readonly unknown[]): DedupedEvent[] {
  const seenIds = new Set<string>();
  const seenBodies = new Set<string>();
  const out: DedupedEvent[] = [];
  for (const event of raw) {
    if (!isPlainObject(event)) continue;
    const missionId = safeId(event.missionId);
    const attemptId = safeId(event.attemptId);
    if (!missionId || !attemptId || typeof event.kind !== 'string') continue;
    const messageId = typeof event.messageId === 'string' && event.messageId.length > 0 ? event.messageId : undefined;
    if (messageId) {
      if (seenIds.has(messageId)) continue;
      seenIds.add(messageId);
    } else {
      const body = canonicalJson(event);
      if (body === undefined) continue;
      if (seenBodies.has(body)) continue;
      seenBodies.add(body);
    }
    out.push({ missionId, attemptId, kind: event.kind, data: event.data });
  }
  return out;
}

function archiveCoverageOf(
  refs: readonly ArchiveRef[],
  archiveIndexInvalid: boolean,
  provided: readonly ProvidedArchive[],
): { coverage: SignalCoverage; reasons: ContextAttributionReason[] } {
  const reasons: ContextAttributionReason[] = [];
  const indexKeys = new Set<string>();
  const uniqueRefs: ArchiveRef[] = [];
  for (const ref of refs) {
    const key = refKey(ref.projectId, ref.missionId);
    if (indexKeys.has(key)) continue;
    indexKeys.add(key);
    uniqueRefs.push(ref);
  }

  const providedByKey = new Map<string, ProvidedArchive>();
  let extra = false;
  for (const pkg of provided) {
    const key = refKey(pkg.projectId, pkg.missionId);
    if (!indexKeys.has(key)) extra = true;
    if (!providedByKey.has(key)) providedByKey.set(key, pkg);
  }

  if (archiveIndexInvalid) reasons.push(CONTEXT_ATTRIBUTION_REASONS.ARCHIVE_INDEX_MISMATCH);
  if (extra) reasons.push(CONTEXT_ATTRIBUTION_REASONS.ARCHIVE_INDEX_MISMATCH);

  if (uniqueRefs.length === 0) {
    const coverage: SignalCoverage = archiveIndexInvalid || extra ? 'partial' : 'complete';
    return { coverage, reasons: uniqReasons(reasons) };
  }

  let matched = 0;
  let verified = 0;
  let unverifiedPresent = false;
  for (const ref of uniqueRefs) {
    const pkg = providedByKey.get(refKey(ref.projectId, ref.missionId));
    if (!pkg) continue;
    matched += 1;
    if (integrityMatchesIndex(ref, pkg.integrity)) verified += 1;
    else unverifiedPresent = true;
  }

  if (matched < uniqueRefs.length) reasons.push(CONTEXT_ATTRIBUTION_REASONS.ARCHIVE_PACKAGE_MISSING);
  if (unverifiedPresent) reasons.push(CONTEXT_ATTRIBUTION_REASONS.ARCHIVE_INTEGRITY_UNVERIFIED);

  let coverage: SignalCoverage;
  if (verified === uniqueRefs.length && !extra && !archiveIndexInvalid) coverage = 'complete';
  else if (matched === 0) coverage = 'unknown';
  else coverage = 'partial';
  return { coverage, reasons: uniqReasons(reasons) };
}

function parseIntegrity(value: unknown): ContextAttributionArchiveIntegrity | undefined {
  if (!isPlainObject(value)) return undefined;
  const bytes = value.bytes;
  const sha256 = value.sha256;
  if (!Number.isInteger(bytes) || (bytes as number) < 0) return undefined;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  return { bytes: bytes as number, sha256 };
}

function integrityMatchesIndex(
  ref: ArchiveRef,
  integrity: ContextAttributionArchiveIntegrity | undefined,
): boolean {
  if (!integrity || ref.bytes === undefined || ref.sha256 === undefined) return false;
  return integrity.bytes === ref.bytes && integrity.sha256 === ref.sha256;
}

function compareRows(a: ContextAttributionRow, b: ContextAttributionRow): number {
  return (
    compareString(a.missionId, b.missionId) ||
    compareString(a.role, b.role) ||
    compareString(a.attemptId, b.attemptId)
  );
}

function compareString(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function uniqReasons(reasons: readonly ContextAttributionReason[]): ContextAttributionReason[] {
  const seen = new Set<ContextAttributionReason>();
  const out: ContextAttributionReason[] = [];
  for (const reason of reasons) {
    if (seen.has(reason)) continue;
    seen.add(reason);
    out.push(reason);
  }
  return out;
}

function parseRole(value: unknown): ContextAttributionRole | undefined {
  return typeof value === 'string' && ROLES.has(value as ContextAttributionRole)
    ? (value as ContextAttributionRole)
    : undefined;
}

function parseStatus(value: unknown): ContextAttributionStatus | undefined {
  return typeof value === 'string' && STATUSES.has(value as ContextAttributionStatus)
    ? (value as ContextAttributionStatus)
    : undefined;
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ID_RE.test(value) ? value : undefined;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refKey(projectId: string, missionId: string): string {
  return `${projectId}/${missionId}`;
}

function attemptKey(missionId: string, attemptId: string): string {
  return `${missionId}\0${attemptId}`;
}

/**
 * 事件去重用。键排序后再串，避免同内容因插入顺序被当成两条。
 * 循环引用直接放弃：宁可不计，也不把无法序列化的对象当新事件。
 */
function canonicalJson(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v !== null && typeof v === 'object') {
      if (seen.has(v)) return undefined;
      seen.add(v);
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[k] = canon((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  try {
    return JSON.stringify(canon(value));
  } catch {
    return undefined;
  }
}
