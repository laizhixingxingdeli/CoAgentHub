import { useEffect, useState } from "react";
import type { TaskStatusKind } from "./types";

/** Format elapsed time without exposing raw milliseconds or timestamps. */
export function formatDurationMs(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Calculate an elapsed duration from ISO timestamps. */
export function formatDuration(
  startedAt: string,
  endedAt?: string | null,
  now = Date.now(),
): string {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : now;
  return formatDurationMs(
    Number.isFinite(start) && Number.isFinite(end) ? end - start : 0,
  );
}

/** Re-render once per second while a running duration is visible. */
export function useLiveNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

// 状态色接 index.css 的 --color-status-* token(票 2)。Tailwind v4 对
// @theme 注册的自定义 color 支持 /opacity 修饰符(color-mix),且 .dark 块已
// 配对深色值,故组件层不再写 dark: 前缀。
export const TASK_STATUS_CLASSES: Record<TaskStatusKind, string> = {
  done: "border-status-done/60 bg-status-done/10 text-status-done",
  failed: "border-status-failed/60 bg-status-failed/10 text-status-failed",
  running: "border-status-running/60 bg-status-running/10 text-status-running",
  cancelled:
    "border-status-cancelled/60 bg-status-cancelled/10 text-status-cancelled",
};

/**
 * Ticket 32 humane timestamps (local time):
 * - today → `HH:MM` (17:26)
 * - yesterday → `昨天 HH:MM`
 * - earlier this year → `M月D日 HH:MM` (8月10日 09:30)
 * - any earlier year → `YYYY年M月D日`
 */
export function formatMessageTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const diffDays = Math.round((startOfToday - startOfDay) / 86_400_000);
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
  if (diffDays <= 0) {
    return hhmm;
  }
  if (diffDays === 1) {
    return `昨天 ${hhmm}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
