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
  /**
   * 影响判断专属发牌（可选能力）。
   *
   * 只为一条已确认变更开一次 coordinator Attempt，并把 purpose=impact /
   * changeId / workItemId / claim 一起冻进牌里。changeId 只来自这里——
   * 它是牌上身份的一部分，不是调用方可以补填的字段。
   *
   * 未装配这个能力时**整个方法缺省**，而不是返回一个普通 coordinator 牌：
   * 普通牌没有 changeId 绑定，拿它去调专属动作会过不了校核，于是调用方
   * 会以为「平台坏了」而不是「这里没装配」。缺省让调用方能先问再调。
   */
  startImpactCoordinator?(
    missionId: string,
    changeId: string,
    profile?: { profileId: string; endpoint: string; reasoning?: string },
    claim?: QueueClaimIdentity,
  ): Promise<{ attemptId: string; token: string }>;
  revoke(token: string): void;
}
