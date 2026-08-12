import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  applyTheme,
  resolveTheme,
  THEME_KEY,
  ThemeToggle,
} from "./theme-toggle";

function renderToggle() {
  return render(
    <SidebarProvider>
      <ThemeToggle />
    </SidebarProvider>,
  );
}

beforeEach(() => {
  document.documentElement.classList.remove("dark");
  localStorage.clear();
  // jsdom 无原生 matchMedia:stub 系统浅色偏好(use-mobile 会 add/removeEventListener)
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});

afterEach(() => {
  document.documentElement.classList.remove("dark");
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("ThemeToggle 主题切换 (ticket 21)", () => {
  it("点击切换按钮:翻转 <html> 的 dark class 并写入 localStorage", () => {
    renderToggle();
    // 初始浅色:按钮提示切到深色
    expect(
      screen.getByRole("button", { name: "切换深色模式" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "切换深色模式" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");

    fireEvent.click(screen.getByRole("button", { name: "切换深色模式" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
  });

  it("初始为深色时按钮显示浅色入口,点击切回浅色", () => {
    document.documentElement.classList.add("dark");
    localStorage.setItem(THEME_KEY, "dark");
    renderToggle();

    fireEvent.click(screen.getByRole("button", { name: "切换深色模式" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
  });
});

describe("resolveTheme / applyTheme (ticket 21)", () => {
  it("resolveTheme:localStorage 有值则尊重,无值跟随系统", () => {
    localStorage.setItem(THEME_KEY, "dark");
    expect(resolveTheme()).toBe("dark");
    localStorage.setItem(THEME_KEY, "light");
    expect(resolveTheme()).toBe("light");
    // 无值:系统偏好(mock 为浅色)
    localStorage.removeItem(THEME_KEY);
    expect(resolveTheme()).toBe("light");
  });

  it("系统偏好深色且无存储值时 resolveTheme 返回 dark", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn() }),
    );
    expect(resolveTheme()).toBe("dark");
  });

  it("applyTheme 翻转 class 并按需持久化", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");

    applyTheme("light", false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    // persist=false 时不写 localStorage(保持上一次写入的 dark)
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
  });
});
