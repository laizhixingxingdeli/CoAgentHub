// 纯求值：给定Mission（含其rerun祖先链）与全部Mission列表，算真实费用与角色/候选归因。
// 无I/O、无存储、无时钟、无运行时依赖；costCap由调用者第三参给，与Mission.costCap getter解耦。

export interface AttemptCostInput {
  readonly kind: string;
  readonly usage: { readonly cost?: number };
  readonly profile?: {
    readonly id?: string;
    readonly profileId?: string;
    readonly resolved?: readonly { readonly key: string; readonly value: string }[];
  };
}

export interface MissionCostInput {
  readonly id: string;
  readonly origin?: { readonly rerunOf?: string };
  readonly coordinatorAttempts: readonly AttemptCostInput[];
  readonly independentReviewerAttempts: readonly AttemptCostInput[];
  readonly workItems: readonly { readonly attempts: readonly AttemptCostInput[] }[];
}

export interface MissionCostResult {
  readonly total: number;
  readonly costCap?: number;
  readonly reached: boolean;
  readonly byRole: readonly { readonly role: string; readonly cost: number }[];
  readonly byCandidate: readonly { readonly candidateId: string; readonly cost: number }[];
  readonly missionIds: readonly string[];
}

// 单个attempt应计入的费用：subscription/free据协议记0（不是缺失）；
// 其余只认有限非负usage.cost，缺失/非数/负数不猜价，返回NaN由调用方跳过。
function attemptCost(attempt: AttemptCostInput): number {
  const billing = attempt.profile?.resolved?.find((fact) => fact.key === 'billing')?.value;
  if (billing === 'subscription' || billing === 'free') return 0;
  const cost = attempt.usage.cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : NaN;
}

// 沿origin.rerunOf爬祖先链；循环或找不到祖先都明确抛错，不静默漏计。
function collectMissionChain(
  mission: MissionCostInput,
  missions: readonly MissionCostInput[],
): MissionCostInput[] {
  const chain: MissionCostInput[] = [];
  const seen = new Set<string>();
  let cursor: MissionCostInput | undefined = mission;
  while (cursor) {
    if (seen.has(cursor.id)) throw new Error(`rerun cycle at ${cursor.id}`);
    seen.add(cursor.id);
    chain.push(cursor);
    const nextId = cursor.origin?.rerunOf;
    cursor = nextId ? missions.find((m) => m.id === nextId) : undefined;
    if (nextId && !cursor) throw new Error(`missing rerun ancestor ${nextId}`);
  }
  return chain;
}

export function evaluateMissionCost(
  mission: MissionCostInput,
  missions: readonly MissionCostInput[],
  costCap?: number,
): MissionCostResult {
  const chain = collectMissionChain(mission, missions);
  const byRole = new Map<string, number>();
  const byCandidate = new Map<string, number>();
  let total = 0;
  for (const m of chain) {
    const attempts = [
      ...m.coordinatorAttempts,
      ...m.independentReviewerAttempts,
      ...m.workItems.flatMap((item) => item.attempts),
    ];
    for (const a of attempts) {
      const cost = attemptCost(a);
      if (!Number.isFinite(cost)) continue;
      total += cost;
      byRole.set(a.kind, (byRole.get(a.kind) ?? 0) + cost);
      const candidate = a.profile?.id ?? a.profile?.profileId ?? 'unknown';
      byCandidate.set(candidate, (byCandidate.get(candidate) ?? 0) + cost);
    }
  }
  const validCap = typeof costCap === 'number' && Number.isFinite(costCap) && costCap > 0;
  return {
    total,
    costCap: validCap ? costCap : undefined,
    reached: validCap && total >= (costCap as number),
    byRole: [...byRole].map(([role, cost]) => ({ role, cost })),
    byCandidate: [...byCandidate].map(([candidateId, cost]) => ({ candidateId, cost })),
    missionIds: chain.map((m) => m.id),
  };
}
