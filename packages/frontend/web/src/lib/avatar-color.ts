/**
 * Shared stable-color palette for round avatars (ticket 32 → 33). 10 static
 * class groups written as complete literal strings so Tailwind's scanner sees
 * every class (no dynamic class names). Each group is one high-contrast hue
 * with a darker shade for dark mode.
 */
export const PARTICIPANT_COLORS: string[] = [
  "bg-rose-500 text-white dark:bg-rose-600",
  "bg-orange-500 text-white dark:bg-orange-600",
  "bg-amber-500 text-white dark:bg-amber-600",
  "bg-emerald-500 text-white dark:bg-emerald-600",
  "bg-teal-500 text-white dark:bg-teal-600",
  "bg-sky-500 text-white dark:bg-sky-600",
  "bg-indigo-500 text-white dark:bg-indigo-600",
  "bg-violet-500 text-white dark:bg-violet-600",
  "bg-fuchsia-500 text-white dark:bg-fuchsia-600",
  "bg-slate-500 text-white dark:bg-slate-600",
];

/**
 * Stable per-id avatar color: a 31-multiplier hash over the id picks one
 * palette entry — the same id always keeps the same color, different ids
 * spread over the palette. Used for message sender avatars (ticket 32,
 * exposed as `participantColor` from the messages page) and the sidebar's group
 * avatar (ticket 33).
 */
export function colorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return PARTICIPANT_COLORS[hash % PARTICIPANT_COLORS.length];
}
