import { hcWithType } from "@laizhixingxingdeli/server/hc";

/** localStorage key holding the bound participant id (identity declaration). */
export const PARTICIPANT_ID_KEY = "coagenthub.agentId";

// 兼容说明:localStorage key 的字符串值保留旧名("coagenthub.agentId",
// participant 为 agent 的旧名)。旧 token key("coagenthub.participantToken")
// 不再读写 —— token 认证已移除(局域网全信模型),旧浏览器里残留的 token
// 值不会参与任何请求头。

/**
 * Headers for the current browser session. The web viewer acts as a human
 * participant: when an identity has been bound (localStorage), it is sent as
 * `X-Participant-Id: <uuid>` so the identity middleware treats requests as
 * that participant. Read per request so a save/clear in the UI takes effect
 * immediately.
 */
export function participantIdentityHeaders(): Record<string, string> {
  if (typeof localStorage === "undefined") {
    return {};
  }
  const id = localStorage.getItem(PARTICIPANT_ID_KEY);
  return id ? { "X-Participant-Id": id } : {};
}

const apiClient = hcWithType("/api", {
  headers: () => participantIdentityHeaders(),
  init: { credentials: "include" },
});

export default apiClient;
