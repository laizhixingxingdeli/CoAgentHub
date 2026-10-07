/**
 * COM5 T1 —— 应用层纯时间归因投影（无 I/O、零第三方依赖）。
 *
 * 为什么放在应用层而不是网页层：好几个事实根本不在活动流里——历史 hop 没有认领
 * 时点、T2 之前没有工具结束事件、评审没有区间。这些一律变成 `durationMs: null`
 * 且不被下一条事件或 `now` 闭合。谁在展示层自己算，谁迟早会为了填满界面而造一个
 * 时间事实。重叠、去重、并集是用例规则，所以和 budget-usage.ts 放一起。
 *
 * 显式不采用的做法（会制造时间事实）：
 * - 不用 `usage` / `contextMetrics` 推算毫秒；
 * - 不用 `capturedAt` / 下一事件闭合未结束的工具或等待；
 * - 不读 `mission.waiting` 的 `detail`（自由文本，且里面的 `availableAt` 会被覆盖）；
 * - 不把未分类标成「思考」。
 */

import type { TokenUsage } from '../kernel/index.ts';

/** phase 闭集。任意字符串会变成「什么都能写」，所以固定枚举。 */
export const TIME_PHASE_KINDS = [
  'queue',
  'hop_backoff',
  'schedule_select',
  'agent_run',
  'tool',
  'validation',
  'l2_review',
  'waiting_decision',
  'pause',
  'park',
  'unclassified',
] as const;

export type TimePhaseKind = (typeof TIME_PHASE_KINDS)[number];

export const TIME_ATTRIBUTION_SCHEMA_VERSION = 1;

export type TimeAttributionCoverage = 'complete' | 'partial' | 'unknown';
export type TimePhaseQuality = 'measured' | 'unknown';

/** 活动流里归因需要的字段；是 ActivityEvent 的结构子集，直接传 ActivityEvent[] 即可。 */
export interface TimeAttributionActivityEvent {
  readonly at: string;
  readonly kind: string;
  readonly attemptId?: string;
  readonly workItemId?: string;
  readonly messageId?: string;
  readonly data?: unknown;
}

/** 验证 check 只需要 kind 与起止；`outputTail` 等输出不属于时间归因输入。 */
export interface TimeAttributionValidationCheck {
  readonly kind: string;
  readonly startedAt: string;
  readonly endedAt: string;
}

export interface TimeAttributionValidationReport {
  readonly id: string;
  readonly attemptId?: string;
  readonly workItemId?: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly checks?: readonly TimeAttributionValidationCheck[];
}

/**
 * 历史 hop 事实。刻意不接受 `updatedAt`：它会被认领 / 续租 / 失败反复覆盖，
 * 当认领时点用会得到错误的等待时长。
 */
export interface TimeAttributionHop {
  readonly id: string;
  readonly role?: string;
  readonly workItemId?: string;
  readonly createdAt: string;
  readonly status?: string;
}

export interface TimeAttributionInput {
  readonly activity: readonly TimeAttributionActivityEvent[];
  readonly validationReports?: readonly TimeAttributionValidationReport[];
  readonly hops?: readonly TimeAttributionHop[];
}

export interface TimePhase {
  readonly kind: TimePhaseKind;
  readonly start?: string;
  readonly end?: string;
  /** null 表示未知；未知时不进总占用。 */
  readonly durationMs: number | null;
  readonly attemptId?: string;
  readonly workItemId?: string;
  readonly countedInTotal: boolean;
  /** 与本法相交的其它 kind（只对验证 ↔ 运行双向标注）。 */
  readonly overlaps: readonly string[];
  readonly quality: TimePhaseQuality;
  readonly note?: string;
  /** 只原样带 attempt.ended 的 usage，与毫秒分开呈现。 */
  readonly usage?: TokenUsage;
}

export interface TimeAttribution {
  readonly schemaVersion: 1;
  readonly coverage: TimeAttributionCoverage;
  readonly totalOccupiedMs: number | null;
  readonly phases: readonly TimePhase[];
}

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

function parseTimeMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function setIfAbsent(map: Map<string, number>, key: string, value: number): void {
  if (!map.has(key)) map.set(key, value);
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** 合并半开区间 [start, end]，返回按起点升序的极大不相交集合。 */
function mergeIntervals(intervals: readonly { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .map((i) => ({ start: i.start, end: i.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: { start: number; end: number }[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end;
      continue;
    }
    out.push({ start: cur.start, end: cur.end });
  }
  return out;
}

/** 并集总长，单位毫秒。嵌套区间只算一次。 */
function unionLengthMs(intervals: readonly { start: number; end: number }[]): number {
  return mergeIntervals(intervals).reduce((total, i) => total + (i.end - i.start), 0);
}

/** base 减去若干切割区间，返回剩余的极大不相交区间（按升序）。 */
function subtractIntervals(
  base: { start: number; end: number },
  cuts: readonly { start: number; end: number }[],
): { start: number; end: number }[] {
  const clipped = cuts
    .map((c) => ({ start: Math.max(c.start, base.start), end: Math.min(c.end, base.end) }))
    .filter((c) => c.end > c.start);
  const out: { start: number; end: number }[] = [];
  let cursor = base.start;
  for (const cut of mergeIntervals(clipped)) {
    if (cut.start > cursor) out.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < base.end) out.push({ start: cursor, end: base.end });
  return out;
}

/* ------------------------------------------------------------------ */
/* 内部形状                                                            */
/* ------------------------------------------------------------------ */

interface NormalizedEvent {
  readonly atMs: number;
  readonly kind: string;
  readonly attemptId?: string;
  readonly workItemId?: string;
  readonly data: Record<string, unknown>;
}

interface PhaseExtra {
  readonly attemptId?: string;
  readonly workItemId?: string;
  readonly note?: string;
  readonly usage?: TokenUsage;
}

/** 带数值区间的草稿，便于内部排序、求并集、标重叠，最后才转成 ISO 字符串。 */
interface PhaseDraft {
  readonly kind: TimePhaseKind;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly durationMs: number | null;
  readonly quality: TimePhaseQuality;
  readonly attemptId?: string;
  readonly workItemId?: string;
  readonly note?: string;
  readonly usage?: TokenUsage;
  readonly overlaps: string[];
}

interface AttemptEndFact {
  readonly atMs: number;
  readonly usage: unknown;
}

/** 一跳运行的可信区间；未知时只留起点和原因，绝不猜终点。 */
interface AttemptRun {
  readonly attemptId: string;
  readonly workItemId?: string;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly knownEnd: boolean;
  readonly reason?: string;
  readonly usage?: TokenUsage;
}

interface ToolTrace {
  readonly key: string;
  readonly attemptId?: string;
  readonly callId: string;
  startMs?: number;
  completedMs?: number;
}

/* ------------------------------------------------------------------ */
/* 草稿构造                                                            */
/* ------------------------------------------------------------------ */

function measuredDraft(kind: TimePhaseKind, startMs: number, endMs: number, extra: PhaseExtra): PhaseDraft {
  return {
    kind,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    quality: 'measured',
    overlaps: [],
    attemptId: extra.attemptId,
    workItemId: extra.workItemId,
    note: extra.note,
    usage: extra.usage,
  };
}

function unknownDraft(
  kind: TimePhaseKind,
  extra: PhaseExtra & { startMs?: number; endMs?: number },
): PhaseDraft {
  return {
    kind,
    startMs: extra.startMs,
    endMs: extra.endMs,
    durationMs: null,
    quality: 'unknown',
    overlaps: [],
    attemptId: extra.attemptId,
    workItemId: extra.workItemId,
    note: extra.note,
    usage: extra.usage,
  };
}

/* ------------------------------------------------------------------ */
/* 输入归一化                                                          */
/* ------------------------------------------------------------------ */

/**
 * 相同 messageId 先去重（重连后的重投不第二次计时）；时间不可解析的事件直接
 * 跳过而不是抛错——历史 Mission 缺事件也要能读。
 */
function normalizeActivity(activity: readonly TimeAttributionActivityEvent[]): NormalizedEvent[] {
  const seenMessageIds = new Set<string>();
  const out: NormalizedEvent[] = [];
  for (const raw of activity) {
    const atMs = parseTimeMs(raw.at);
    if (atMs === undefined) continue;
    const messageId = str(raw.messageId);
    if (messageId !== undefined) {
      if (seenMessageIds.has(messageId)) continue;
      seenMessageIds.add(messageId);
    }
    out.push({
      atMs,
      kind: raw.kind,
      attemptId: str(raw.attemptId),
      workItemId: str(raw.workItemId),
      data: asRecord(raw.data),
    });
  }
  out.sort((a, b) => a.atMs - b.atMs);
  return out;
}

/* ------------------------------------------------------------------ */
/* agent_run                                                           */
/* ------------------------------------------------------------------ */

function firstUsage(ends: readonly AttemptEndFact[]): TokenUsage | undefined {
  for (const end of ends) {
    if (end.usage !== null && typeof end.usage === 'object') return end.usage as TokenUsage;
  }
  return undefined;
}

/**
 * 一跳运行的区间。同一 attempt 出现两条**互相矛盾**的 attempt.ended 时不求和，
 * 整票标该跳未知即可——不需要把整个 Mission 打成 unknown。
 */
function projectAttemptRuns(events: readonly NormalizedEvent[]): AttemptRun[] {
  const byId = new Map<string, { starts: number[]; ends: AttemptEndFact[]; workItemId?: string }>();
  const ensure = (attemptId: string) => {
    let state = byId.get(attemptId);
    if (state === undefined) {
      state = { starts: [], ends: [] };
      byId.set(attemptId, state);
    }
    return state;
  };

  for (const event of events) {
    const attemptId = event.attemptId;
    if (attemptId === undefined) continue;
    if (event.kind === 'attempt.started') {
      const state = ensure(attemptId);
      state.starts.push(event.atMs);
      if (state.workItemId === undefined) state.workItemId = event.workItemId;
      continue;
    }
    if (event.kind === 'attempt.ended') {
      const state = ensure(attemptId);
      state.ends.push({ atMs: event.atMs, usage: event.data.usage });
      if (state.workItemId === undefined) state.workItemId = event.workItemId;
    }
  }

  const runs: AttemptRun[] = [];
  for (const [attemptId, state] of byId) {
    const usage = firstUsage(state.ends);
    const starts = uniqueSorted(state.starts);
    const ends = uniqueSorted(state.ends.map((e) => e.atMs));
    const base = { attemptId, workItemId: state.workItemId, usage };

    if (starts.length === 0) {
      runs.push({ ...base, knownEnd: false, reason: '缺少 attempt.started，运行时长未知' });
      continue;
    }
    const startMs = starts[0]!;
    if (starts.length > 1) {
      runs.push({ ...base, startMs, knownEnd: false, reason: '同一 attempt 出现多个 attempt.started，运行时长未知' });
      continue;
    }
    if (ends.length === 0) {
      runs.push({ ...base, startMs, knownEnd: false, reason: '缺少 attempt.ended，运行时长未知' });
      continue;
    }
    if (ends.length > 1) {
      runs.push({
        ...base,
        startMs,
        knownEnd: false,
        reason: '同一 attempt 出现互相矛盾的 attempt.ended，不求和，运行时长未知',
      });
      continue;
    }
    const endMs = ends[0]!;
    if (endMs < startMs) {
      runs.push({ ...base, startMs, knownEnd: false, reason: 'attempt.ended 早于 attempt.started，运行时长未知' });
      continue;
    }
    runs.push({ ...base, startMs, endMs, knownEnd: true });
  }
  return runs;
}

function buildAgentRunPhases(runs: readonly AttemptRun[]): PhaseDraft[] {
  return runs.map((run) => {
    const extra: PhaseExtra = { attemptId: run.attemptId, workItemId: run.workItemId, usage: run.usage };
    if (run.knownEnd && run.startMs !== undefined && run.endMs !== undefined) {
      return measuredDraft('agent_run', run.startMs, run.endMs, extra);
    }
    return unknownDraft('agent_run', { ...extra, startMs: run.startMs, note: run.reason });
  });
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/**
 * 工具开始 = `runtime.command.started`，结束 = `runtime.tool.completed`。
 * started / completed **分别**按 attemptId + callId 去重：重连重投不会第二次计时。
 * 只完成没有开始，或只有开始没有完成，都标未知，不用下一事件闭合。
 */
function collectTools(events: readonly NormalizedEvent[]): ToolTrace[] {
  const byKey = new Map<string, ToolTrace>();
  const ensure = (attemptId: string | undefined, callId: string): ToolTrace => {
    const key = `${attemptId ?? ''}\u0000${callId}`;
    let trace = byKey.get(key);
    if (trace === undefined) {
      trace = { key, attemptId, callId };
      byKey.set(key, trace);
    }
    return trace;
  };

  for (const event of events) {
    if (event.kind === 'runtime.command.started') {
      const callId = str(event.data.callId);
      if (callId === undefined) continue;
      const trace = ensure(event.attemptId, callId);
      if (trace.startMs === undefined) trace.startMs = event.atMs;
      continue;
    }
    if (event.kind === 'runtime.tool.completed') {
      const callId = str(event.data.callId);
      if (callId === undefined) continue;
      const trace = ensure(event.attemptId, callId);
      if (trace.completedMs === undefined) trace.completedMs = event.atMs;
    }
  }

  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function isKnownTool(trace: ToolTrace): boolean {
  return trace.startMs !== undefined && trace.completedMs !== undefined && trace.completedMs >= trace.startMs;
}

function buildToolPhases(tools: readonly ToolTrace[]): PhaseDraft[] {
  return tools.map((trace) => {
    const extra: PhaseExtra = { attemptId: trace.attemptId };
    if (isKnownTool(trace)) return measuredDraft('tool', trace.startMs!, trace.completedMs!, extra);
    if (trace.startMs !== undefined && trace.completedMs !== undefined) {
      return unknownDraft('tool', { ...extra, startMs: trace.startMs, note: '工具结束早于开始，时长未知' });
    }
    if (trace.startMs !== undefined) {
      return unknownDraft('tool', {
        ...extra,
        startMs: trace.startMs,
        note: '缺少 runtime.tool.completed，工具时长未知',
      });
    }
    if (trace.completedMs !== undefined) {
      return unknownDraft('tool', {
        ...extra,
        endMs: trace.completedMs,
        note: '只有工具完成事件，缺 runtime.command.started，时长未知',
      });
    }
    return unknownDraft('tool', { ...extra, note: '工具事件时间缺失，时长未知' });
  });
}

/* ------------------------------------------------------------------ */
/* 未分类：agent_run 减已知工具并集                                     */
/* ------------------------------------------------------------------ */

/**
 * 未分类不额外加总（它本来就落在 agent_run 里，总占用取并集）。
 * 任一相关工具时长未知，这段剩余也未知——不标成「思考」，也不用 usage 推算。
 * 不减去验证窗：验证是运行之外的另一条事实。
 */
function buildUnclassifiedPhases(runs: readonly AttemptRun[], tools: readonly ToolTrace[]): PhaseDraft[] {
  const out: PhaseDraft[] = [];
  for (const run of runs) {
    const related = tools.filter((t) => t.attemptId !== undefined && t.attemptId === run.attemptId);
    const extra: PhaseExtra = { attemptId: run.attemptId, workItemId: run.workItemId };

    if (!run.knownEnd || run.startMs === undefined || run.endMs === undefined) {
      out.push(
        unknownDraft('unclassified', { ...extra, startMs: run.startMs, note: 'agent_run 时长未知，未分类时长未知' }),
      );
      continue;
    }
    if (related.some((t) => !isKnownTool(t))) {
      out.push(
        unknownDraft('unclassified', { ...extra, startMs: run.startMs, note: '相关工具时长未知，未分类时长未知' }),
      );
      continue;
    }
    const cuts = related.filter(isKnownTool).map((t) => ({ start: t.startMs!, end: t.completedMs! }));
    for (const segment of subtractIntervals({ start: run.startMs, end: run.endMs }, cuts)) {
      out.push(measuredDraft('unclassified', segment.start, segment.end, extra));
    }
  }
  return out;
}
/* ------------------------------------------------------------------ */
/* 排队与退避                                                          */
/* ------------------------------------------------------------------ */

/** queue 严格两事件配 hopId；只有 legacy createdAt 时只显示入队时点，等待时长未知。 */
function buildQueuePhases(events: readonly NormalizedEvent[], hops: readonly TimeAttributionHop[]): PhaseDraft[] {
  const enqueuedAt = new Map<string, number>();
  const claimedAt = new Map<string, number>();
  for (const event of events) {
    if (event.kind === 'hop.enqueued') {
      const hopId = str(event.data.hopId);
      if (hopId !== undefined) setIfAbsent(enqueuedAt, hopId, event.atMs);
      continue;
    }
    if (event.kind === 'hop.claimed') {
      const hopId = str(event.data.hopId);
      if (hopId !== undefined) setIfAbsent(claimedAt, hopId, event.atMs);
    }
  }

  const out: PhaseDraft[] = [];
  for (const hopId of new Set([...enqueuedAt.keys(), ...claimedAt.keys()])) {
    const start = enqueuedAt.get(hopId);
    const end = claimedAt.get(hopId);
    if (start !== undefined && end !== undefined) {
      if (end >= start) {
        out.push(measuredDraft('queue', start, end, { note: '入队 → 认领，按 hop.enqueued/hop.claimed 配对' }));
      } else {
        out.push(unknownDraft('queue', { startMs: start, note: '认领早于入队，等待时长未知' }));
      }
      continue;
    }
    if (start !== undefined) {
      out.push(unknownDraft('queue', { startMs: start, note: '缺 hop.claimed，等待时长未知' }));
      continue;
    }
    out.push(unknownDraft('queue', { endMs: end, note: '只有 hop.claimed，缺 hop.enqueued，等待起点未知' }));
  }

  for (const hop of hops) {
    if (enqueuedAt.has(hop.id) || claimedAt.has(hop.id)) continue;
    const createdMs = parseTimeMs(hop.createdAt);
    if (createdMs === undefined) continue;
    out.push(
      unknownDraft('queue', {
        startMs: createdMs,
        workItemId: hop.workItemId,
        note: '历史 hop 认领时点未持久化（updatedAt 会被覆盖，不当认领），等待时长未知',
      }),
    );
  }
  return out;
}

/**
 * 有 hop.backoff 事件就用它的 failedAt/availableAt；否则仅当 mission.waiting
 * reason=project_busy 到下一条 mission.resumed 时，把这段墙钟标为退避等待。
 * note 写明不采用 detail 里的 availableAt（会被后一次失败覆盖）。
 */
function buildBackoffPhases(events: readonly NormalizedEvent[]): PhaseDraft[] {
  const fromEvents: PhaseDraft[] = [];
  for (const event of events) {
    if (event.kind !== 'hop.backoff') continue;
    const failedMs = parseTimeMs(event.data.failedAt);
    const availableMs = parseTimeMs(event.data.availableAt);
    if (failedMs === undefined || availableMs === undefined || availableMs < failedMs) {
      fromEvents.push(
        unknownDraft('hop_backoff', { startMs: failedMs, note: 'hop.backoff 时间字段缺失或倒序，退避时长未知' }),
      );
      continue;
    }
    fromEvents.push(measuredDraft('hop_backoff', failedMs, availableMs, { note: '按 hop.backoff 的 failedAt/availableAt' }));
  }
  if (fromEvents.length > 0) return fromEvents;
  return pairPhases(
    events,
    (e) => e.kind === 'mission.waiting' && str(e.data.reason) === 'project_busy',
    ['mission.resumed'],
    'hop_backoff',
    'detail 里的 availableAt 会被后一次失败覆盖，不采用；按 project_busy waiting → resumed 配对',
  );
}

/* ------------------------------------------------------------------ */
/* 调度 / 验证 / 评审                                                   */
/* ------------------------------------------------------------------ */

/** schedule_select = round.started → 下一次 attempt.started；含选候选与冲突查询，不能再拆。 */
function buildScheduleSelectPhases(events: readonly NormalizedEvent[]): PhaseDraft[] {
  const out: PhaseDraft[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (event.kind !== 'orchestration.round.started') continue;
    let next: NormalizedEvent | undefined;
    for (let j = i + 1; j < events.length; j += 1) {
      if (events[j]!.kind === 'attempt.started') {
        next = events[j]!;
        break;
      }
    }
    const note = '含选候选与冲突查询，不能再拆';
    if (next === undefined) {
      out.push(unknownDraft('schedule_select', { startMs: event.atMs, note: `缺少下一次 attempt.started；${note}` }));
      continue;
    }
    out.push(measuredDraft('schedule_select', event.atMs, next.atMs, { note }));
  }
  return out;
}

function buildValidationPhases(reports: readonly TimeAttributionValidationReport[]): PhaseDraft[] {
  const out: PhaseDraft[] = [];
  for (const report of reports) {
    const checkKinds = [
      ...new Set((report.checks ?? []).map((c) => str(c.kind)).filter((k): k is string => k !== undefined)),
    ];
    const note = checkKinds.length > 0 ? `检查：${checkKinds.join('、')}` : undefined;
    const extra: PhaseExtra = { attemptId: report.attemptId, workItemId: report.workItemId, note };
    const startedMs = parseTimeMs(report.startedAt);
    const endedMs = parseTimeMs(report.endedAt);
    if (startedMs === undefined || endedMs === undefined || endedMs < startedMs) {
      out.push(unknownDraft('validation', { ...extra, startMs: startedMs, note: '验证窗时间字段缺失或倒序，时长未知' }));
      continue;
    }
    out.push(measuredDraft('validation', startedMs, endedMs, extra));
  }
  return out;
}

/** 只有 review.recorded 时点，没有评审区间；禁止用协调者 attempt 墙钟冒充。 */
function buildReviewPhases(events: readonly NormalizedEvent[]): PhaseDraft[] {
  const out: PhaseDraft[] = [];
  for (const event of events) {
    if (event.kind !== 'review.recorded') continue;
    out.push(
      unknownDraft('l2_review', {
        startMs: event.atMs,
        attemptId: event.attemptId,
        workItemId: event.workItemId,
        note: '只有评审时点，评审时长未知',
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 等待 / 暂停 / 搁置                                                   */
/* ------------------------------------------------------------------ */

type StartPredicate = (event: NormalizedEvent) => boolean;

/**
 * 通用成对事件配对：每个开始事件配它之后第一条未被消费的结束事件；缺结束则
 * 时长未知，绝不把 `now` 算进去冒充已结束。
 */
function pairPhases(
  events: readonly NormalizedEvent[],
  isStart: StartPredicate,
  endKinds: readonly string[],
  kind: TimePhaseKind,
  note: string,
): PhaseDraft[] {
  const consumed = new Set<number>();
  const out: PhaseDraft[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const start = events[i]!;
    if (!isStart(start)) continue;
    let endIndex = -1;
    for (let j = 0; j < events.length; j += 1) {
      if (consumed.has(j)) continue;
      const candidate = events[j]!;
      if (!endKinds.includes(candidate.kind)) continue;
      if (candidate.atMs < start.atMs) continue;
      endIndex = j;
      break;
    }
    if (endIndex === -1) {
      out.push(
        unknownDraft(kind, {
          startMs: start.atMs,
          attemptId: start.attemptId,
          workItemId: start.workItemId,
          note: `缺少结束事件，时长未知（${note}）`,
        }),
      );
      continue;
    }
    consumed.add(endIndex);
    const end = events[endIndex]!;
    out.push(
      measuredDraft(kind, start.atMs, end.atMs, {
        attemptId: start.attemptId,
        workItemId: start.workItemId,
        note,
      }),
    );
  }
  return out;
}

function buildWaitingDecisionPhases(events: readonly NormalizedEvent[]): PhaseDraft[] {
  return [
    ...pairPhases(
      events,
      (e) => e.kind === 'mission.waiting' && str(e.data.reason) !== 'project_busy',
      ['mission.resumed'],
      'waiting_decision',
      '按 mission.waiting → mission.resumed 配对',
    ),
    ...pairPhases(events, (e) => e.kind === 'escalated', ['escalation.answered'], 'waiting_decision', '升级 → 答复'),
    ...pairPhases(
      events,
      (e) => e.kind === 'mission_result.submitted',
      ['final_review.merged', 'final_review.send_back', 'final_review.abandoned'],
      'waiting_decision',
      '终审提交 → L3 决定',
    ),
  ];
}

function buildPausePhases(events: readonly NormalizedEvent[]): PhaseDraft[] {
  return pairPhases(events, (e) => e.kind === 'mission.paused', ['mission.resumed_from_pause'], 'pause', '暂停 → 恢复');
}

function buildParkPhases(events: readonly NormalizedEvent[]): PhaseDraft[] {
  return pairPhases(
    events,
    (e) => e.kind === 'mission.parked',
    ['mission.resumed_from_park', 'mission.resume_sync_conflict'],
    'park',
    '搁置 → 恢复',
  );
}

/* ------------------------------------------------------------------ */
/* 重叠与输出                                                          */
/* ------------------------------------------------------------------ */

/** 验证 ↔ 运行双向标 overlaps，让「哪里重叠了」在界面上可读。 */
function markValidationOverlaps(drafts: readonly PhaseDraft[]): void {
  const validations = drafts.filter((d) => d.kind === 'validation' && d.quality === 'measured');
  const runs = drafts.filter((d) => d.kind === 'agent_run' && d.quality === 'measured');
  const add = (draft: PhaseDraft, other: string) => {
    if (!draft.overlaps.includes(other)) draft.overlaps.push(other);
  };
  for (const validation of validations) {
    for (const run of runs) {
      if (validation.startMs! < run.endMs! && run.startMs! < validation.endMs!) {
        add(validation, 'agent_run');
        add(run, 'validation');
      }
    }
  }
}

function compareDrafts(a: PhaseDraft, b: PhaseDraft): number {
  const aStart = a.startMs ?? Number.POSITIVE_INFINITY;
  const bStart = b.startMs ?? Number.POSITIVE_INFINITY;
  if (aStart !== bStart) return aStart - bStart;
  const aEnd = a.endMs ?? Number.POSITIVE_INFINITY;
  const bEnd = b.endMs ?? Number.POSITIVE_INFINITY;
  if (aEnd !== bEnd) return aEnd - bEnd;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return 0;
}

function toPhase(draft: PhaseDraft): TimePhase {
  const phase: {
    kind: TimePhaseKind;
    start?: string;
    end?: string;
    durationMs: number | null;
    attemptId?: string;
    workItemId?: string;
    countedInTotal: boolean;
    overlaps: readonly string[];
    quality: TimePhaseQuality;
    note?: string;
    usage?: TokenUsage;
  } = {
    kind: draft.kind,
    durationMs: draft.durationMs,
    countedInTotal: draft.durationMs !== null,
    overlaps: Object.freeze([...draft.overlaps]),
    quality: draft.quality,
  };
  if (draft.startMs !== undefined) phase.start = isoOf(draft.startMs);
  if (draft.endMs !== undefined) phase.end = isoOf(draft.endMs);
  if (draft.attemptId !== undefined) phase.attemptId = draft.attemptId;
  if (draft.workItemId !== undefined) phase.workItemId = draft.workItemId;
  if (draft.note !== undefined) phase.note = draft.note;
  if (draft.usage !== undefined) phase.usage = draft.usage;
  return Object.freeze(phase);
}

/**
 * 总占用：对已知可计区间取并集。嵌套的工具与未分类本来就落在 agent_run 里，
 * 不额外加总；一条已知区间都没有时为 null（空输入不制造 0）。
 */
function coverageOf(drafts: readonly PhaseDraft[]): TimeAttributionCoverage {
  if (drafts.length === 0) return 'unknown';
  const known = drafts.filter((d) => d.durationMs !== null).length;
  if (known === 0) return 'unknown';
  if (known === drafts.length) return 'complete';
  return 'partial';
}

/**
 * 纯投影：把结构化活动（可选验证报告与 hop 事实）折成阶段耗时与并集总占用。
 * 无 I/O、不抛错——历史缺事件时降级为 unknown/partial，缺项 `durationMs` 为 null。
 */
export function projectTimeAttribution(input: TimeAttributionInput): TimeAttribution {
  const events = normalizeActivity(input.activity ?? []);
  const runs = projectAttemptRuns(events);
  const tools = collectTools(events);

  const drafts: PhaseDraft[] = [
    ...buildQueuePhases(events, input.hops ?? []),
    ...buildBackoffPhases(events),
    ...buildScheduleSelectPhases(events),
    ...buildAgentRunPhases(runs),
    ...buildToolPhases(tools),
    ...buildUnclassifiedPhases(runs, tools),
    ...buildValidationPhases(input.validationReports ?? []),
    ...buildReviewPhases(events),
    ...buildWaitingDecisionPhases(events),
    ...buildPausePhases(events),
    ...buildParkPhases(events),
  ];

  markValidationOverlaps(drafts);
  drafts.sort(compareDrafts);

  const intervals = drafts
    .filter((d) => d.durationMs !== null && d.startMs !== undefined && d.endMs !== undefined)
    .map((d) => ({ start: d.startMs!, end: d.endMs! }));

  return Object.freeze({
    schemaVersion: TIME_ATTRIBUTION_SCHEMA_VERSION,
    coverage: coverageOf(drafts),
    totalOccupiedMs: intervals.length === 0 ? null : unionLengthMs(intervals),
    phases: Object.freeze(drafts.map(toPhase)),
  });
}
  
