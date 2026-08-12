import { Moon, Sun } from "lucide-react";
import * as React from "react";
import { SidebarMenuButton } from "@/components/ui/sidebar";

/**
 * Theme switch (ticket 21). The `dark` class on <html> drives the oklch
 * variables in index.css; this component flips the class and persists the
 * choice under `coagenthub.theme`. The same key is read by the inline script in
 * index.html before first paint, so the page never flashes the wrong theme.
 * No stored value → follow the OS preference.
 */
export const THEME_KEY = "coagenthub.theme";

/** Resolve the effective theme: persisted choice wins, else system default. */
export function resolveTheme(): "light" | "dark" {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // localStorage unavailable (private mode) — fall through to system.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Apply a theme to <html> and (optionally) persist it. */
export function applyTheme(theme: "light" | "dark", persist = true): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Non-persistable storage — the in-page switch still works.
    }
  }
}

export function ThemeToggle() {
  // The index.html inline script has already applied the initial class, so the
  // current classList is the source of truth here.
  const [dark, setDark] = React.useState(() =>
    document.documentElement.classList.contains("dark"),
  );

  const toggle = () => {
    const next = !dark;
    setDark(next);
    applyTheme(next ? "dark" : "light");
  };

  return (
    <SidebarMenuButton size="sm" onClick={toggle} aria-label="切换深色模式">
      {dark ? <Sun /> : <Moon />}
      <span>{dark ? "浅色模式" : "深色模式"}</span>
    </SidebarMenuButton>
  );
}
