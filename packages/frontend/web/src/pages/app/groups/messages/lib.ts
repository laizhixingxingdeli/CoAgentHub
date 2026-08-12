import {
  type Audience,
  GROUP_ROLES,
  type Member,
  type TaskStatusKind,
} from "./types";

export function taskStatusKind(body: string): TaskStatusKind {
  if (/^✅/.test(body)) return "done";
  if (/^❌/.test(body)) return "failed";
  if (/^🛑/.test(body)) return "cancelled";
  return "running";
}

export const TASK_STATUS_CLASSES: Record<TaskStatusKind, string> = {
  done: "border-emerald-300/60 bg-emerald-500/10 text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-500/15 dark:text-emerald-300",
  failed:
    "border-red-300/60 bg-red-500/10 text-red-800 dark:border-red-700/60 dark:bg-red-500/15 dark:text-red-300",
  running:
    "border-sky-300/60 bg-sky-500/10 text-sky-800 dark:border-sky-700/60 dark:bg-sky-500/15 dark:text-sky-300",
  cancelled:
    "border-amber-300/60 bg-amber-500/10 text-amber-800 dark:border-amber-700/60 dark:bg-amber-500/15 dark:text-amber-300",
};

type AudienceResolution = {
  audience: Audience;
  audienceRef?: string;
};

/** Human-friendly byte size: B / KB / MB / GB (1 KB = 1024 B). */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0
    ? `${value} ${units[unit]}`
    : `${value.toFixed(1)} ${units[unit]}`;
}

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

/** Local calendar-day key (YYYY-M-D) — messages sharing it belong to one day section. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Day-separator label (ticket 21): 今天 / 昨天 / 2026/8/10 for older days. */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfDay = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
  ).getTime();
  const diffDays = Math.round((startOfToday - startOfDay) / 86_400_000);
  if (diffDays === 0) {
    return "今天";
  }
  if (diffDays === 1) {
    return "昨天";
  }
  return d.toLocaleDateString("zh-CN");
}

/**
 * Resolve the audience a composed body will be delivered to (ticket 18):
 * - `@<成员 name>` (a group member; names may contain spaces) → `agent` +
 *   `audienceRef=<agentId>`
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
        return { audience: "agent", audienceRef: m.agentId };
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
  kind: "role" | "agent";
};
