import { create } from "zustand";

/** lg+ 右栏开合的持久化键(收起后刷新保持)。 */
export const CONTEXT_PANEL_OPEN_KEY = "coagenthub.contextPanelOpen";

type ContextPanelState = {
  /** lg+ 右栏是否展开(持久化);<lg 时仅反映偏好,驱动标题栏图标。 */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** <lg overlay 抽屉是否打开(临时,不持久化)。 */
  overlayOpen: boolean;
  setOverlayOpen: (open: boolean) => void;
};

export function readStoredPanelOpen(): boolean {
  if (typeof localStorage === "undefined") {
    return true;
  }
  // 默认展开(lg+ 常驻);用户收起后持久化,刷新后保持。
  return localStorage.getItem(CONTEXT_PANEL_OPEN_KEY) !== "false";
}

/**
 * 右栏上下文面板开合 store(单例)。原先由 GroupContextPanelProvider
 * (context)承载的开合状态集中到这里:标题栏「面板」开关与右栏面板共享
 * 同一份状态,持久化 key 与迁移前一致(coagenthub.contextPanelOpen)。
 */
export const useContextPanelStore = create<ContextPanelState>((set) => ({
  open: readStoredPanelOpen(),
  setOpen: (open) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(CONTEXT_PANEL_OPEN_KEY, String(open));
    }
    set({ open });
  },
  overlayOpen: false,
  setOverlayOpen: (overlayOpen) => set({ overlayOpen }),
}));
