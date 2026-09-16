/**
 * 调度器需要的发牌口。
 *
 * 单独抽出来，是为了不让用例层依赖 HTTP 层的 RunTokenRegistry —— 应用层
 * 不该知道 token 是怎么存的，只需要"开一次 attempt，换一张牌，用完吊销"。
 */

export interface RunTokenIssuer {
  startCoordinator(
    missionId: string,
    profile?: { profileId: string; endpoint: string; reasoning?: string },
  ): Promise<{ attemptId: string; token: string }>;
  startExecutor(
    missionId: string,
    workItemId: string,
    profile?: { profileId: string; endpoint: string; reasoning?: string },
  ): Promise<{ attemptId: string; token: string }>;
  revoke(token: string): void;
}
