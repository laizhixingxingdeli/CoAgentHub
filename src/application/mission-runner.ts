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
import type { Platform } from './platform.ts';
import type { RunTokenIssuer } from './token-issuer.ts';
import type { WorkspaceManager } from './workspace.ts';

export interface MissionRunnerDeps {
  readonly platform: Platform;
  readonly tokens: RunTokenIssuer;
  /** 已在听的回环 API。入口本身不 listen、不 createApi。 */
  readonly baseUrl: string;
  readonly workspace: WorkspaceManager;
  readonly coordinator: RolePool;
  readonly executor: RolePool;
  readonly live?: LiveOutput;
  readonly acceptStaleBase?: boolean;
  readonly attemptWallClockMs?: number;
  readonly owner?: string;
}

export interface MissionRunnerResult {
  readonly outcome: MissionRunOutcome;
  readonly hops: readonly HopRecord[];
  readonly workspace: Orchestrator['workspace'];
}

export class MissionRunner {
  readonly #deps: MissionRunnerDeps;

  constructor(deps: MissionRunnerDeps) {
    this.#deps = deps;
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
