import { create } from "zustand";

/**
 * localStorage key holding the bound participant id (identity declaration).
 *
 * 兼容说明:localStorage key 的字符串值保留旧名("coagenthub.agentId",
 * participant 为 agent 的旧名)。旧 token key("coagenthub.participantToken")
 * 不再读写 —— token 认证已移除(局域网全信模型),旧浏览器里残留的 token
 * 值不会参与任何请求头。
 */
export const PARTICIPANT_ID_KEY = "coagenthub.agentId";

type IdentityState = {
  /** 当前绑定的 participant id;空串表示未绑定。 */
  participantId: string;
  /** 绑定身份:写入 localStorage(同一 key)并更新 store 状态。 */
  setIdentity: (participantId: string) => void;
  /** 清除身份:删除 localStorage 记录并清空 store 状态。 */
  clearIdentity: () => void;
};

function readStoredParticipantId(): string {
  if (typeof localStorage === "undefined") {
    return "";
  }
  return localStorage.getItem(PARTICIPANT_ID_KEY) ?? "";
}

/**
 * 身份绑定 store(单例,无需跨实例同步)。持久化 key 与迁移前完全一致,
 * 因此旧浏览器里已绑定的身份在引入 store 后依然生效。api-client 的
 * participantIdentityHeaders 保留「按请求读取 localStorage」的原实现,
 * 由本 store 的 setIdentity/clearIdentity 驱动写入 —— 切换/清除后请求头
 * 立即生效,测试语义不变。
 */
export const useIdentityStore = create<IdentityState>((set) => ({
  participantId: readStoredParticipantId(),
  setIdentity: (participantId) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(PARTICIPANT_ID_KEY, participantId);
    }
    set({ participantId });
  },
  clearIdentity: () => {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(PARTICIPANT_ID_KEY);
    }
    set({ participantId: "" });
  },
}));
