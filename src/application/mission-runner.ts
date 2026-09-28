/**
 * 由既有平台实例跑一条 Mission 的内部编排入口。
 *
 * 调用方已经握着 Platform、发牌口、回环 API 的 baseUrl、工作区和候选。
 * 这里不建持久平台、不 listen、不拿锁——那些是 CLI / 观测面的装配。
 * 不这么抽的话，每个入口都会再起一套平台和 API，agent 回连到错的口，
 * 文件锁也会自己和自己打架。
 */

import type { LiveOutput } from './live.ts';
import {
  Orchestrator,
  type HopRecord,
  type MissionRunOutcome,
  type RolePool,
  type RunMissionOptions,
} from './orchestrator.ts';
import { hopCapacityLimits, type HopCapacityLimits } from './durable-scheduler.ts';
import type { CandidateCircuitRepository, Clock, IdGenerator, QueuedHopRepository } from './ports.ts';
import type { Platform } from './platform.ts';
import type { RunTokenIssuer } from './token-issuer.ts';
import type { WorkspaceManager } from './workspace.ts';

/** Parse the optional CLI value while keeping omission distinct from a missing value. */
export function parseMaxRounds(raw: string | undefined, supplied: boolean): number | undefined {
  if (!supplied) return undefined;
  if (raw === undefined || raw.startsWith('--') || !/^\d+$/.test(raw)) {
    throw new Error('--max-rounds must be an integer in the range 1–100');
  }
  const value = Number(raw);
  if (value < 1 || value > 100) {
    throw new Error('--max-rounds must be an integer in the range 1–100');
  }
  return value;
}

export interface MissionRunnerDeps {
  readonly platform: Platform;
  readonly tokens: RunTokenIssuer;
  /** 已在听的回环 API。入口本身不 listen、不 createApi。 */
  readonly baseUrl: string;
  readonly workspace: WorkspaceManager;
  readonly coordinator: RolePool;
  readonly executor: RolePool;
  readonly independentReviewer?: RolePool;
  readonly live?: LiveOutput;
  readonly acceptStaleBase?: boolean;
  readonly attemptWallClockMs?: number;
  readonly owner?: string;
  readonly candidateCircuits?: CandidateCircuitRepository;
  /** Production wiring uses this name; omit to keep pre-queue behaviour. */
  readonly queuedHops?: QueuedHopRepository;
  readonly hopClock?: Clock;
  readonly hopLeaseMs?: number;
  readonly hopIds?: IdGenerator;
  /**
   * 五维并发上限。省略则用代码默认值。必须在构造时归一化：坏值若拖到
   * run() 才抛，队列可能已被领取、Agent 已经启动。
   */
  readonly hopCapacityLimits?: HopCapacityLimits;
}

export interface MissionRunnerResult {
  readonly outcome: MissionRunOutcome;
  readonly hops: readonly HopRecord[];
  readonly workspace: Orchestrator['workspace'];
}

export class MissionRunner {
  readonly #deps: MissionRunnerDeps;

  constructor(deps: MissionRunnerDeps) {
    // 同步校验并写入归一化副本，再交给 Orchestrator。未指定用 hopCapacityLimits()
    // 的默认值。不这么做的话，非法上限会活到第一跳领取。
    this.#deps = {
      ...deps,
      hopCapacityLimits: hopCapacityLimits(deps.hopCapacityLimits),
    };
  }

  async run(missionId: string, options: RunMissionOptions): Promise<MissionRunnerResult> {
    // 每条 Mission 新编排器：冷却表和「连续无提交」按上一跳计，跨 Mission 复用会误判。
    const orchestrator = new Orchestrator(this.#deps);
    const outcome = await orchestrator.runMission(missionId, options);
    return {
      outcome,
      hops: orchestrator.hops,
      workspace: orchestrator.workspace,
    };
  }
}
