import type { Mission, Attempt, TokenUsage, PromotionUsageSnapshot, PromotionUnknownDimension, PromotionTokenUsageSnapshot } from '../../kernel/index.ts';

/** 两个 ISO 时间的非负差；缺失、非法、倒序都保持 unknown，不 clamp 成 0。 */
export function elapsedMs(start: string | undefined, end: string | undefined): number | undefined {
  if (!start || !end) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined;
  return endMs - startMs;
}

/** 聚合用量：**分项相加**，不要只滚一个 total。 */
export function sumUsage(mission: Mission): TokenUsage {
  const all: Attempt[] = [
    ...mission.coordinatorAttempts,
    ...mission.independentReviewerAttempts,
  ];
  for (const item of mission.workItems) all.push(...item.attempts);
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let reported = 0;
  for (const attempt of all) {
    const u = attempt.usage;
    input += u.input;
    output += u.output;
    cacheRead += u.cacheRead;
    cacheWrite += u.cacheWrite;
    cost += u.cost ?? 0;
    if (u.quality === 'reported') reported += 1;
  }
  // 不得伪装精确：一条都没上报就是 unknown，部分上报就是 estimated，
  // 只有全部上报才敢说 reported。在途 attempt 还没上报不该把整体拉成
  // "估算过"——那会让读数看起来比实际更有依据。
  const quality: TokenUsage['quality'] =
    all.length === 0 || reported === 0
      ? 'unknown'
      : reported === all.length
        ? 'reported'
        : 'estimated';
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    cost,
    quality,
  };
}

/**
 * 从 trusted attempts 构造 promotion usage 快照。
 * 只累加 reported/estimated；unknown 永不贡献假 0。
 * 任一 attempt token 事实未知 => dimensionsUnknown 含 tokens。
 * 无任何非 unknown usage => 省略 tokenUsage。
 */
export function buildPromotionUsageSnapshot(mission: Mission): PromotionUsageSnapshot {
  const attempts: Attempt[] = [
    ...mission.coordinatorAttempts,
    ...mission.independentReviewerAttempts,
  ];
  for (const item of mission.workItems) attempts.push(...item.attempts);
  const attemptCount = attempts.length;

  const baseUnknown: PromotionUnknownDimension[] = [
    'cost',
    'wallClockMs',
    'rounds',
    'changedFiles',
    'commands',
    'budgetRemaining',
  ];

  const known = attempts.filter(
    (a) => a.usage.quality === 'reported' || a.usage.quality === 'estimated',
  );
  const hasUnknownTokens =
    attemptCount === 0 || known.length < attemptCount;

  const dimensionsUnknown: PromotionUnknownDimension[] = hasUnknownTokens
    ? ['tokens', ...baseUnknown]
    : [...baseUnknown];

  if (known.length === 0) {
    return {
      attemptCount,
      dimensionsUnknown,
      budgetAuthoritative: false,
    };
  }

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reported = 0;
  for (const attempt of known) {
    const u = attempt.usage;
    input += u.input;
    output += u.output;
    cacheRead += u.cacheRead;
    cacheWrite += u.cacheWrite;
    if (u.quality === 'reported') reported += 1;
  }
  const quality: PromotionTokenUsageSnapshot['quality'] =
    reported === known.length ? 'reported' : 'estimated';
  const tokenUsage: PromotionTokenUsageSnapshot = {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    quality,
  };
  return {
    attemptCount,
    tokenUsage,
    dimensionsUnknown,
    budgetAuthoritative: false,
  };
}

/** 往分组里塞一条。 */
export function push(map: Map<string, TokenUsage[]>, key: string, usage: TokenUsage): void {
  const list = map.get(key);
  if (list) list.push(usage);
  else map.set(key, [usage]);
}

/**
 * 合并若干条用量。
 *
 * quality 的规则和 sumUsage 一致，而且**必须一致**：同一个数在 Mission 页
 * 标"已上报"、在用量页标"估算"，人只会不信这两个数。
 */
export function combine(list: readonly TokenUsage[]): TokenUsage {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let reported = 0;
  for (const u of list) {
    input += u.input;
    output += u.output;
    cacheRead += u.cacheRead;
    cacheWrite += u.cacheWrite;
    cost += u.cost ?? 0;
    if (u.quality === 'reported') reported += 1;
  }
  const quality: TokenUsage['quality'] =
    list.length === 0 || reported === 0
      ? 'unknown'
      : reported === list.length
        ? 'reported'
        : 'estimated';
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    cost,
    quality,
  };
}







