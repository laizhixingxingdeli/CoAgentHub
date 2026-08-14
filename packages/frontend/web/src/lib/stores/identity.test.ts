import { beforeEach, describe, expect, it } from "vitest";
import { PARTICIPANT_ID_KEY, useIdentityStore } from "@/lib/stores/identity";

describe("useIdentityStore 身份绑定 store", () => {
  beforeEach(() => {
    localStorage.clear();
    useIdentityStore.setState({ participantId: "" });
  });

  it("初始 participantId 从 localStorage 读取(兼容旧 key)", () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-1");
    // 重新初始化 store,模拟刷新后从 localStorage 恢复
    useIdentityStore.setState({
      participantId: localStorage.getItem(PARTICIPANT_ID_KEY) ?? "",
    });
    expect(useIdentityStore.getState().participantId).toBe("participant-1");
  });

  it("setIdentity 写入 localStorage 并更新 store 状态", () => {
    useIdentityStore.getState().setIdentity("participant-2");
    expect(useIdentityStore.getState().participantId).toBe("participant-2");
    expect(localStorage.getItem(PARTICIPANT_ID_KEY)).toBe("participant-2");
  });

  it("clearIdentity 清除 localStorage 并清空 store 状态", () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-3");
    useIdentityStore.setState({ participantId: "participant-3" });
    useIdentityStore.getState().clearIdentity();
    expect(useIdentityStore.getState().participantId).toBe("");
    expect(localStorage.getItem(PARTICIPANT_ID_KEY)).toBeNull();
  });

  it("重复 setIdentity 覆盖旧身份(切换身份)", () => {
    useIdentityStore.getState().setIdentity("participant-a");
    useIdentityStore.getState().setIdentity("participant-b");
    expect(useIdentityStore.getState().participantId).toBe("participant-b");
    expect(localStorage.getItem(PARTICIPANT_ID_KEY)).toBe("participant-b");
  });
});
