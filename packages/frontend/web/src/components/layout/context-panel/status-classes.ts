/** Shared status badge classes. All colors resolve to the --status-* tokens. */
export const TASK_STATUS_CLASS = {
  queued: "border-status-queued bg-status-queued/10 text-status-queued",
  running: "border-status-running bg-status-running/10 text-status-running",
  done: "border-status-done bg-status-done/10 text-status-done",
  failed: "border-status-failed bg-status-failed/10 text-status-failed",
  cancelled:
    "border-status-cancelled bg-status-cancelled/10 text-status-cancelled",
} as const;

export const LAYER_STATUS_CLASS = {
  ...TASK_STATUS_CLASS,
  pending: "border-muted-foreground/30 bg-muted/50 text-muted-foreground",
  "na-declared": "border-border bg-muted text-muted-foreground",
  "na-no-reviewer": "border-border bg-muted text-muted-foreground",
} as const;
