/**
 * 调度器需要的发牌口。
 *
 * 单独抽出来，是为了不让用例层依赖 HTTP 层的 RunTokenRegistry —— 应用层
 * 不该知道 token 是怎么存的，只需要"开一次 attempt，换一张牌，用完吊销"。
 */

import type { QueueClaimIdentity } from './platform.ts';

export interface RunTokenIssuer {
  startCoordinator(
    missionId: string,
    profile?: { profileId: string; endpoint: string; reasoning?: string },
    claim?: QueueClaimIdentity,
  ): Promise<{ attemptId: string; token: string }>;
  startExecutor(
    missionId: string,
    workItemId: string,
    profile?: { profileId: string; endpoint: string; reasoning?: string },
    claim?: QueueClaimIdentity,
  ): Promise<{ attemptId: string; token: string }>;
  /**
   * 按 E2 独立性规则从独立候选里开 Attempt 并发牌。
   * 不强制：未实现时编排器把 HA 检视记成故障，不得改用协调者 token。
   */
  startIndependentReviewer?(
    missionId: string,
    candidates?: readonly { profileId: string; endpoint: string; reasoning?: string }[],
    claim?: QueueClaimIdentity,
  ): Promise<{ attemptId: string; token: string; profileId: string }>;
  revoke(token: string): void;
}
