import { hcWithType } from "@laizhixingxingdeli/server/hc";

/** localStorage key holding the bound agent token. */
export const AGENT_TOKEN_KEY = "coagenthub.agentToken";
/** localStorage key holding the bound agent id (for "my" bubble styling). */
export const AGENT_ID_KEY = "coagenthub.agentId";

/**
 * Headers for the current browser session. The web viewer acts as a human
 * agent: when a token has been bound (localStorage), it is sent as
 * `Authorization: Bearer <token>` so agentAuth-protected group APIs work.
 * Read per request so a save/clear in the UI takes effect immediately.
 */
export function agentAuthHeaders(): Record<string, string> {
  if (typeof localStorage === "undefined") {
    return {};
  }
  const token = localStorage.getItem(AGENT_TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const apiClient = hcWithType("/api", {
  headers: () => agentAuthHeaders(),
  init: { credentials: "include" },
});

export default apiClient;
