/**
 * 孤儿探测名额回收。
 *
 * half_open 熔断的探测名额在领取后是持久化的：只有 probe 成功（resolveProbe → closed）或失败
 * （→ open）才会归还。如果领了名额的那次运行被中断（进程被杀、服务重启、托管运行没有走完收尾），
 * 名额就永远停在「已领取」上——之后没有任何 half_open 的探针会被领走，候选一直被隔离在
 * half_open 上，既不恢复也不重开。
 *
 * 判据只有一条：连续观察满 2 分钟，队列里始终没有该 profile 的活租约。用进程内的首次观察时刻
 * 计时，而不是存储字段——不能为了这个回收器改存储结构（工单明确不许新增字段/方法）。代价是
 * 服务重启后重新计时；这可以接受，因为回收本就是为了兜底重启这类中断。
 *
 * 不新开定时器：挂到 RetryWakeScheduler 现有 tick 的收尾钩子上，且每 30 秒才真正读一次仓储，
 * 免得每一拍（默认 5 秒）都对每个 profile 查一次熔断与整张队列。
 */

import { activeLeaseForProfile, type QueuedHop } from '../durable-scheduler.ts';

/** 连续观察满这么久才复位。 */
const PROBE_ORPHAN_MS = 120_000;
/** 两次真正判定之间的最短间隔。 */
const PROBE_RECLAIM_EVAL_MS = 30_000;
const PROBE_RECLAIM_ACTOR = 'platform:probe-reclaim';
const PROBE_RECLAIM_REASON = 'half_open probe claimed with no active lease for 2 minutes';

export interface ProbeWatch {
  readonly profileId: string;
  readonly firstSeenMs: number;
}

/** 只取判定需要的字段：熔断的完整联合类型在这里不重要，未领取的 half_open 与 open/closed 同样不碰。 */
export interface ProbeCircuitView {
  readonly profileId: string;
  readonly state: string;
  readonly probeClaimed?: boolean;
}

export interface DecideProbeReclaimInput {
  readonly nowMs: number;
  readonly watches: readonly ProbeWatch[];
  readonly circuits: readonly ProbeCircuitView[];
  readonly hops: readonly QueuedHop[];
  readonly nowIso: string;
}

export interface ProbeReclaimDecision {
  readonly resetProfileIds: readonly string[];
  readonly watches: readonly ProbeWatch[];
}

/**
 * 纯函数：eligible 是「已领取名额的 half_open 且队列里没有该 profile 的活租约」。
 * 观察表只保留仍然 eligible 的项，所以状态变了、租约出现了、或这次不在 circuits 里的记录都会
 * 被丢掉——不这么做的话，一个 profile 短暂出现活租约后旧计时还在，下一拍就会立刻误复位。
 * 不复位的记录一律沿用原 firstSeenMs，重新计时会让「连续观察」名存实亡。
 */
export function decideProbeReclaim(input: DecideProbeReclaimInput): ProbeReclaimDecision {
  const seenAt = new Map<string, number>();
  for (const watch of input.watches) seenAt.set(watch.profileId, watch.firstSeenMs);

  const eligible = new Set<string>();
  for (const circuit of input.circuits) {
    if (circuit.state !== 'half_open' || circuit.probeClaimed !== true) continue;
    if (activeLeaseForProfile(input.hops, circuit.profileId, input.nowIso) !== undefined) continue;
    eligible.add(circuit.profileId);
  }

  const resetProfileIds: string[] = [];
  const watches: ProbeWatch[] = [];
  for (const profileId of eligible) {
    const firstSeenMs = seenAt.get(profileId);
    if (firstSeenMs === undefined) {
      watches.push({ profileId, firstSeenMs: input.nowMs });
      continue;
    }
    if (input.nowMs - firstSeenMs >= PROBE_ORPHAN_MS) {
      resetProfileIds.push(profileId);
      continue;
    }
    watches.push({ profileId, firstSeenMs });
  }

  // 字典序由调用方（断言与人工排查）依赖，别交给 Set 的插入顺序。
  resetProfileIds.sort();
  watches.sort((a, b) => (a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0));
  return { resetProfileIds, watches };
}

export interface ProbeReclaimDeps {
  listProfiles(): Promise<readonly string[]>;
  getCircuit(profileId: string): Promise<ProbeCircuitView>;
  listHops(): Promise<readonly QueuedHop[]>;
  reset(input: { profileId: string; actor: string; at: string; reason: string }): Promise<unknown>;
  warn(error: unknown): void;
  now?: () => number;
}

/**
 * 薄壳：把 decide 的结果落到仓储上。watches / lastEvalMs 只在进程内，不写存储——
 * 这是这个回收器的设计前提（见文件头）。
 */
export class ProbeReclaim {
  readonly #deps: ProbeReclaimDeps;
  #watches: readonly ProbeWatch[] = [];
  #lastEvalMs = Number.NEGATIVE_INFINITY;

  constructor(deps: ProbeReclaimDeps) {
    this.#deps = deps;
  }

  async tick(nowMs?: number): Promise<void> {
    const now = nowMs ?? this.#deps.now?.() ?? Date.now();
    if (now - this.#lastEvalMs < PROBE_RECLAIM_EVAL_MS) return;
    // 先记时刻再读仓储：读失败也照样节流 30 秒，否则仓储一挂就会每拍重试一次。
    this.#lastEvalMs = now;

    const profileIds = await this.#deps.listProfiles();
    const circuits: ProbeCircuitView[] = [];
    for (const profileId of profileIds) circuits.push(await this.#deps.getCircuit(profileId));
    const hops = await this.#deps.listHops();

    const decision = decideProbeReclaim({
      nowMs: now,
      watches: this.#watches,
      circuits,
      hops,
      nowIso: new Date(now).toISOString(),
    });

    for (const profileId of decision.resetProfileIds) {
      try {
        await this.#deps.reset({
          profileId,
          actor: PROBE_RECLAIM_ACTOR,
          at: new Date(now).toISOString(),
          reason: PROBE_RECLAIM_REASON,
        });
      } catch (error) {
        // 单个 profile 复位失败不拖累其它 profile；也照常从观察表里去掉，
        // 否则下一拍立刻再 reset 一次，失败会变成 reset 风暴。下一轮重新观察 2 分钟。
        this.#deps.warn(error);
      }
    }
    this.#watches = decision.watches;
  }
}
