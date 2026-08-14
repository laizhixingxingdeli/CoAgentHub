import { beforeEach, describe, expect, it } from "vitest";
import {
  CONTEXT_PANEL_OPEN_KEY,
  useContextPanelStore,
} from "@/lib/stores/context-panel";

describe("useContextPanelStore 右栏开合 store", () => {
  beforeEach(() => {
    localStorage.clear();
    useContextPanelStore.setState({ open: true, overlayOpen: false });
  });

  it("初始 open 默认展开(localStorage 无记录时)", () => {
    expect(useContextPanelStore.getState().open).toBe(true);
    expect(useContextPanelStore.getState().overlayOpen).toBe(false);
  });

  it("初始 open 尊重 localStorage 持久化的收起状态", () => {
    localStorage.setItem(CONTEXT_PANEL_OPEN_KEY, "false");
    useContextPanelStore.setState({
      open: localStorage.getItem(CONTEXT_PANEL_OPEN_KEY) !== "false",
    });
    expect(useContextPanelStore.getState().open).toBe(false);
  });

  it("setOpen 更新状态并持久化到 localStorage", () => {
    useContextPanelStore.getState().setOpen(false);
    expect(useContextPanelStore.getState().open).toBe(false);
    expect(localStorage.getItem(CONTEXT_PANEL_OPEN_KEY)).toBe("false");

    useContextPanelStore.getState().setOpen(true);
    expect(useContextPanelStore.getState().open).toBe(true);
    expect(localStorage.getItem(CONTEXT_PANEL_OPEN_KEY)).toBe("true");
  });

  it("setOverlayOpen 仅更新临时状态,不写 localStorage", () => {
    useContextPanelStore.getState().setOverlayOpen(true);
    expect(useContextPanelStore.getState().overlayOpen).toBe(true);
    expect(localStorage.getItem(CONTEXT_PANEL_OPEN_KEY)).toBeNull();

    useContextPanelStore.getState().setOverlayOpen(false);
    expect(useContextPanelStore.getState().overlayOpen).toBe(false);
  });
});
