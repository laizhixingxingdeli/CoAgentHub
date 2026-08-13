import { hcWithType } from "@laizhixingxingdeli/server/hc";

/** localStorage key holding the bound participant token. */
export const PARTICIPANT_TOKEN_KEY = "coagenthub.participantToken";
/** localStorage key holding the bound participant id (for "my" bubble styling). */
export const PARTICIPANT_ID_KEY = "coagenthub.agentId";

// 兼容说明:两个 localStorage key 的字符串值保留旧名("coagenthub.participantToken"/
// "coagenthub.agentId",participant 为 participant 的旧名)—— 改 key 会让已绑定
// 身份的浏览器丢失 token,得不偿失;token 本身兼容(哈希算法未变)。

/**
 * Headers for the current browser session. The web viewer acts as a human
 * participant: when a token has been bound (localStorage), it is sent as
 * `Authorization: Bearer <token>` so participantAuth-protected group APIs
 * work. Read per request so a save/clear in the UI takes effect immediately.
 */
export function participantAuthHeaders(): Record<string, string> {
  if (typeof localStorage === "undefined") {
    return {};
  }
  const token = localStorage.getItem(PARTICIPANT_TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const apiClient = hcWithType("/api", {
  headers: () => participantAuthHeaders(),
  init: { credentials: "include" },
});

export default apiClient;
