import { readFileSync } from "node:fs";

/**
 * R4 (spec: watchdog-detects-stale-runtime-but-never-recovers): the watchdog
 * is the SOLE writer of these state files; the server only reads and passes
 * them through on /api/system/health. Single writer → single source of truth
 * for the "auto-rebuild disabled" fact (no second derivation, no drift).
 *
 *   - COAGENTHUB_AUTO_REBUILD_STATE (default /tmp/coagenthub-watchdog-auto-rebuild-state)
 *     single-line JSON: {"disabled":true,"disabledAt":"...","reason":"..."}
 *     — written while the watchdog's rolling-window failure count is at/above
 *     threshold, removed once the runtime is fresh again.
 *   - COAGENTHUB_STALL_STATE_FILE (default /tmp/coagenthub-watchdog-stall-state)
 *     single-line JSON: {"stalledRounds":N,"lastRoundAt":"...","notified":bool}
 *     — stale rounds blocked by in-flight tasks (the R2 escalation fact).
 *
 * Unreadable/missing files report the "not disabled / not stalled" state —
 * the health probe must never 500 because of a state file.
 */

export interface AutoRebuildState {
  disabled: boolean;
  disabledAt: string | null;
  reason: string | null;
}

export interface StaleStallState {
  stalledRounds: number;
  lastRoundAt: string | null;
  notified: boolean;
}

const DEFAULT_STATE_FILE = "/tmp/coagenthub-watchdog-auto-rebuild-state";
const DEFAULT_STALL_FILE = "/tmp/coagenthub-watchdog-stall-state";

function envPath(raw: string | undefined, fallback: string): string {
  return raw && raw.trim().length > 0 ? raw : fallback;
}

function readSingleLineJson(path: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : 0;
}

/** Read the auto-rebuild disabled fact; absent/corrupt file → not disabled. */
export function getAutoRebuildState(): AutoRebuildState {
  const file = envPath(
    process.env.COAGENTHUB_AUTO_REBUILD_STATE,
    DEFAULT_STATE_FILE,
  );
  const json = readSingleLineJson(file);
  if (!json || json.disabled !== true) {
    return { disabled: false, disabledAt: null, reason: null };
  }
  return {
    disabled: true,
    disabledAt: asString(json.disabledAt),
    reason: asString(json.reason),
  };
}

/** Read the stale-stall fact; absent/corrupt file → not stalled. */
export function getStaleStallState(): StaleStallState {
  const file = envPath(
    process.env.COAGENTHUB_STALL_STATE_FILE,
    DEFAULT_STALL_FILE,
  );
  const json = readSingleLineJson(file);
  if (!json) {
    return { stalledRounds: 0, lastRoundAt: null, notified: false };
  }
  return {
    stalledRounds: asInt(json.stalledRounds),
    lastRoundAt: asString(json.lastRoundAt),
    notified: json.notified === true,
  };
}
