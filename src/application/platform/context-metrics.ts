import { CONTEXT_METRICS_BRIEF_SOURCES, CONTEXT_METRICS_TOOL_KINDS } from '../ports.ts';
import type { ContextMetricsBriefSource, ContextMetricsBriefSourceEntry, ContextMetricsCoverage, ContextMetricsReadBucketV1, ContextMetricsToolBucketV1, ContextMetricsToolKind, ContextMetricsV1 } from '../ports.ts';

/**
 * 单份摘要上限。再大就不是摘要——把正文/路径塞进来会打穿 Activity。
 * 用字节而不是字符：非 ASCII 观测值按 UTF-8 计才和落盘一致。
 */
const CONTEXT_METRICS_MAX_JSON_BYTES = 32 * 1024;
/** 与固定六源一一对应；多了就是在枚举别的来源名。 */
const CONTEXT_METRICS_MAX_SOURCE_BUCKETS = CONTEXT_METRICS_BRIEF_SOURCES.length;
/** 固定工具类别各至多一条。 */
const CONTEXT_METRICS_MAX_TOOL_BUCKETS = CONTEXT_METRICS_TOOL_KINDS.length;
/** 读文件去重桶。再多就是在枚举工作区。 */
const CONTEXT_METRICS_MAX_READ_BUCKETS = 64;
/** 非负有界整数。不挡的话 Infinity / 1e100 也会被当成观测事实。 */
const CONTEXT_METRICS_MAX_INT = 1_000_000_000;
const CONTEXT_METRICS_DIGEST_RE = /^[0-9a-f]{64}$/;
const CONTEXT_METRICS_COVERAGE = new Set<string>(['complete', 'partial', 'unknown']);
const CONTEXT_METRICS_BRIEF_SOURCE_SET: ReadonlySet<string> = new Set(CONTEXT_METRICS_BRIEF_SOURCES);
const CONTEXT_METRICS_TOOL_KIND_SET: ReadonlySet<string> = new Set(CONTEXT_METRICS_TOOL_KINDS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function objectKeysAre(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

/**
 * 分类事实投影：只保留 true / 'unknown' 叶子，丢弃 false 叶子；
 * 嵌套对象递归处理并保留父级标签（否则 false 占满的子树会被当成一整块丢掉，
 * 而同级的 true 父标签失去上下文）。非对象、非布尔/unknown 的值原样丢弃。
 */
export function keepTrueOrUnknownLeaves(value: unknown): unknown {
  if (value === true || value === 'unknown') return value;
  if (value === false) return undefined;
  if (isPlainObject(value)) {
    const nested = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => [key, keepTrueOrUnknownLeaves(child)])
        .filter(([, child]) => child !== undefined),
    );
    return Object.keys(nested).length > 0 ? nested : undefined;
  }
  return undefined;
}

function boundedNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > CONTEXT_METRICS_MAX_INT) {
    return undefined;
  }
  return value;
}

function sha256Hex(value: unknown): string | undefined {
  return typeof value === 'string' && CONTEXT_METRICS_DIGEST_RE.test(value) ? value : undefined;
}

function utf8JsonBytes(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return undefined;
  }
}

function sanitizeBriefSource(value: unknown): ContextMetricsBriefSourceEntry | undefined {
  if (!isPlainObject(value) || !objectKeysAre(value, new Set(['source', 'estimatedTokens', 'truncated']))) {
    return undefined;
  }
  const source = value.source;
  if (typeof source !== 'string' || !CONTEXT_METRICS_BRIEF_SOURCE_SET.has(source)) return undefined;
  if (typeof value.truncated !== 'boolean') return undefined;
  const entry: {
    source: ContextMetricsBriefSource;
    truncated: boolean;
    estimatedTokens?: number;
  } = { source: source as ContextMetricsBriefSource, truncated: value.truncated };
  if (Object.prototype.hasOwnProperty.call(value, 'estimatedTokens')) {
    const tokens = boundedNonNegativeInt(value.estimatedTokens);
    if (tokens === undefined) return undefined;
    entry.estimatedTokens = tokens;
  }
  return entry;
}

function sanitizeBrief(value: unknown): ContextMetricsV1['brief'] | undefined {
  if (!isPlainObject(value) || !objectKeysAre(value, new Set(['renderedUtf8Bytes', 'sources']))) {
    return undefined;
  }
  const renderedUtf8Bytes = boundedNonNegativeInt(value.renderedUtf8Bytes);
  if (renderedUtf8Bytes === undefined || !Array.isArray(value.sources)) return undefined;
  if (value.sources.length > CONTEXT_METRICS_MAX_SOURCE_BUCKETS) return undefined;
  const sources: ContextMetricsBriefSourceEntry[] = [];
  const seen = new Set<string>();
  for (const item of value.sources) {
    const entry = sanitizeBriefSource(item);
    if (!entry || seen.has(entry.source)) return undefined;
    seen.add(entry.source);
    sources.push(entry);
  }
  return { renderedUtf8Bytes, sources };
}

function sanitizeToolBucket(value: unknown): ContextMetricsToolBucketV1 | undefined {
  if (!isPlainObject(value) || !objectKeysAre(value, new Set(['kind', 'calls', 'returnedUtf8Bytes']))) {
    return undefined;
  }
  const kind = value.kind;
  if (typeof kind !== 'string' || !CONTEXT_METRICS_TOOL_KIND_SET.has(kind)) return undefined;
  const calls = boundedNonNegativeInt(value.calls);
  const returnedUtf8Bytes = boundedNonNegativeInt(value.returnedUtf8Bytes);
  if (calls === undefined || returnedUtf8Bytes === undefined) return undefined;
  return { kind: kind as ContextMetricsToolKind, calls, returnedUtf8Bytes };
}

function sanitizeReadBucket(value: unknown): ContextMetricsReadBucketV1 | undefined {
  if (!isPlainObject(value) || !objectKeysAre(value, new Set(['pathDigest', 'contentDigest', 'repeats']))) {
    return undefined;
  }
  const pathDigest = sha256Hex(value.pathDigest);
  const contentDigest = sha256Hex(value.contentDigest);
  const repeats = boundedNonNegativeInt(value.repeats);
  if (!pathDigest || !contentDigest || repeats === undefined) return undefined;
  return { pathDigest, contentDigest, repeats };
}

export function activityDataHasContextMetrics(data: unknown): boolean {
  return isPlainObject(data) && Object.prototype.hasOwnProperty.call(data, 'contextMetrics');
}

/**
 * 把不可信摘要收成 v1 白名单。失败返回 undefined：调用方仍可收尾，但不得把原字段落盘，
 * 也不得标 complete。错误路径不回显输入——摘要里可能夹着路径/正文/凭据。
 */
export function sanitizeAttemptContextMetrics(input: unknown): ContextMetricsV1 | undefined {
  if (input === undefined) return undefined;
  const rawBytes = utf8JsonBytes(input);
  if (rawBytes === undefined || rawBytes > CONTEXT_METRICS_MAX_JSON_BYTES) return undefined;
  if (!isPlainObject(input) || !objectKeysAre(input, new Set(['version', 'coverage', 'brief', 'tools', 'reads']))) {
    return undefined;
  }
  if (input.version !== 1) return undefined;
  if (typeof input.coverage !== 'string' || !CONTEXT_METRICS_COVERAGE.has(input.coverage)) return undefined;
  const coverage = input.coverage as ContextMetricsCoverage;

  let brief: ContextMetricsV1['brief'] | undefined;
  if (Object.prototype.hasOwnProperty.call(input, 'brief')) {
    brief = sanitizeBrief(input.brief);
    if (brief === undefined) return undefined;
  }
  let tools: ContextMetricsToolBucketV1[] | undefined;
  if (Object.prototype.hasOwnProperty.call(input, 'tools')) {
    if (!Array.isArray(input.tools) || input.tools.length > CONTEXT_METRICS_MAX_TOOL_BUCKETS) return undefined;
    tools = [];
    const seen = new Set<string>();
    for (const item of input.tools) {
      const bucket = sanitizeToolBucket(item);
      if (!bucket || seen.has(bucket.kind)) return undefined;
      seen.add(bucket.kind);
      tools.push(bucket);
    }
  }
  let reads: ContextMetricsReadBucketV1[] | undefined;
  if (Object.prototype.hasOwnProperty.call(input, 'reads')) {
    if (!Array.isArray(input.reads) || input.reads.length > CONTEXT_METRICS_MAX_READ_BUCKETS) return undefined;
    reads = [];
    const seen = new Set<string>();
    for (const item of input.reads) {
      const bucket = sanitizeReadBucket(item);
      if (!bucket) return undefined;
      const key = `${bucket.pathDigest}:${bucket.contentDigest}`;
      if (seen.has(key)) return undefined;
      seen.add(key);
      reads.push(bucket);
    }
  }

  // complete 必须带齐三类观测。缺一块还自称 complete = 不可信，整段丢弃。
  if (coverage === 'complete' && (brief === undefined || tools === undefined || reads === undefined)) {
    return undefined;
  }

  const trusted: {
    version: 1;
    coverage: ContextMetricsCoverage;
    brief?: ContextMetricsV1['brief'];
    tools?: readonly ContextMetricsToolBucketV1[];
    reads?: readonly ContextMetricsReadBucketV1[];
  } = { version: 1, coverage };
  if (brief !== undefined) trusted.brief = brief;
  if (tools !== undefined) trusted.tools = tools;
  if (reads !== undefined) trusted.reads = reads;
  const trustedBytes = utf8JsonBytes(trusted);
  if (trustedBytes === undefined || trustedBytes > CONTEXT_METRICS_MAX_JSON_BYTES) return undefined;
  return trusted;
}

