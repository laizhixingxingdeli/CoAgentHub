import { useEffect, useState } from "react";
import {
  type Audience,
  GROUP_ROLES,
  type Member,
  type TaskStatusKind,
} from "./types";

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

type AudienceResolution = {
  audience: Audience;
  audienceRef?: string;
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

/**
 * Resolve the audience a composed body will be delivered to (ticket 18):
 * - `@<成员 name>` (a group member; names may contain spaces) → `participant` +
 *   `audienceRef=<participantId>`
 * - `@<角色名>` (GROUP_ROLES) → `role` + `audienceRef=<角色名>`
 * - no mention → `broadcast`
 * - mentions that match no candidate (`@xxx`) are left in the body as plain
 *   text and do not change the audience (stays `broadcast`).
 * The first matched mention wins; scanning is left to right. At each `@` the
 * longest full member name is tried first (case-insensitive, so a manually
 * typed `@CodeBuddy 执行器` — or `@WIN-HERMES` — resolves the same way the
 * mention candidate filter suggests it), then the single-word role token; a
 * member name that is merely a prefix of a longer word (`@win-hermes2`) is
 * not a match, so body text can't be swallowed.
 */
export function resolveAudience(
  body: string,
  members: Member[],
): AudienceResolution {
  // Longest member names first so "@CodeBuddy 执行器" hits the member and
  // not a shorter member/role token covering only "@CodeBuddy".
  const byNameLength = [...members].sort(
    (a, b) => b.name.length - a.name.length,
  );
  const lower = body.toLowerCase();
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== "@") {
      continue;
    }
    const rest = lower.slice(i + 1);
    // 1) full member name (may contain spaces), longest first
    for (const m of byNameLength) {
      const name = m.name.toLowerCase();
      if (!rest.startsWith(name)) {
        continue;
      }
      // Boundary: the name must not be a prefix of a longer word — the char
      // right after it may be whitespace/punctuation/end, but not a word
      // char ("@win-hermes2" is not "@win-hermes").
      const after = body[i + 1 + name.length];
      if (after === undefined || !/\w/.test(after)) {
        return { audience: "participant", audienceRef: m.participantId };
      }
    }
    // 2) single-word role token (roles never contain spaces)
    const token = rest.match(/^[^\s@]+/)?.[0];
    if (token) {
      const role = GROUP_ROLES.find((r) => r.toLowerCase() === token);
      if (role) {
        return { audience: "role", audienceRef: role };
      }
    }
  }
  return { audience: "broadcast" };
}

/**
 * Detect an in-progress mention at the caret: the last `@` before the caret
 * with no whitespace in between. Returns the text range to replace.
 */
export function detectMention(
  body: string,
  caret: number,
): { start: number; query: string } | null {
  if (caret <= 0) {
    return null;
  }
  let j = caret - 1;
  while (j >= 0) {
    const ch = body[j];
    if (/\s/.test(ch)) {
      return null;
    }
    if (ch === "@") {
      return { start: j, query: body.slice(j + 1, caret) };
    }
    j -= 1;
  }
  return null;
}

export type MentionCandidate = {
  token: string;
  kind: "role" | "participant";
};
