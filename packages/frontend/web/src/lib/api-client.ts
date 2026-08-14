import { hcWithType } from "@laizhixingxingdeli/server/hc";
import { PARTICIPANT_ID_KEY } from "@/lib/stores/identity";

export { PARTICIPANT_ID_KEY } from "@/lib/stores/identity";

/**
 * Headers for the current browser session. The web viewer acts as a human
 * participant: when an identity has been bound, it is sent as
 * `X-Participant-Id: <uuid>` so the identity middleware treats requests as
 * that participant. Read per request from localStorage so a save/clear in
 * the UI takes effect immediately.
 *
 * 读取来源说明:身份写入已迁移到 useIdentityStore(setIdentity/clearIdentity
 * 持久化到同一 key),这里保留按请求读 localStorage 的原实现 —— 由 store 驱动
 * 写入、按请求读取,测试语义不变(直接写 localStorage 的用例也生效)。
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
