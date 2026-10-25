import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface L3SessionBinding {
  sessionId: string;
  cwd: string;
  inboxScope: "recipient" | "all";
  recipient?: string;
  source?: string;
  updatedAt: string;
}

type QueuedLedger = {
  ids: string[];
};

/**
 * Registration outcome for one SessionStart.
 *
 * - `created`: first binding in this data dir, it also became the active default.
 * - `refreshed`: this session already held the active default and refreshed it.
 * - `inactive`: this session is registered but another session keeps the active
 *   default, so delivery routing did not move.
 */
export type BindingRegistration = "created" | "refreshed" | "inactive";

export type BindingRegistrationResult = {
  registration: BindingRegistration;
  activeSessionId?: string;
};

/**
 * Fixed error codes for the health file. Never derived from an error message:
 * a platform response body, a notification or a credential must not land here.
 */
const HEALTH_ERROR_CODES = ["poll_failed"] as const;
export type BridgeErrorCode = (typeof HEALTH_ERROR_CODES)[number];

/** Error class names that may be recorded; anything else is dropped. */
const ERROR_NAME_ALLOWLIST = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
] as const;
export type BridgeErrorName = (typeof ERROR_NAME_ALLOWLIST)[number];

/**
 * Local bridge health. Counts, timestamps and a status only: no delivery bodies,
 * no summaries, no credentials, and no free-form error text.
 */
export interface L3BridgeHealth {
  status: "starting" | "ok" | "degraded";
  updatedAt: string;
  polls: number;
  deliveredTotal: number;
  consecutiveFailures: number;
  lastPollStartedAt?: string;
  lastPollSucceededAt?: string;
  lastDeliveryAt?: string;
  lastError?: { at: string; code: BridgeErrorCode; name?: BridgeErrorName };
}

const ACTIVE_FILE = "active.json";
const REGISTRY_DIRNAME = "l3-bindings";
const HEALTH_FILENAME = "l3-bridge-health.json";

export function pluginDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured =
    env.PLUGIN_DATA?.trim() || env.COAGENTHUB_PLUGIN_DATA?.trim();
  return resolve(configured || join(homedir(), ".codex", "coagenthub-v5"));
}

/** Legacy single-file binding. Still read for compatibility with old installs. */
export function bindingPath(dataDir: string): string {
  return join(dataDir, "l3-binding.json");
}

export function bindingRegistryDir(dataDir: string): string {
  return join(dataDir, REGISTRY_DIRNAME);
}

/**
 * Per-session binding file name. The session id is hashed so an arbitrary id
 * (slashes, dots, unicode, case-insensitive file systems) can never escape the
 * registry directory or collide through path normalization.
 */
export function sessionBindingFileName(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId, "utf8").digest("hex");
  return `${digest.slice(0, 32)}.json`;
}

export function sessionBindingPath(dataDir: string, sessionId: string): string {
  return join(bindingRegistryDir(dataDir), sessionBindingFileName(sessionId));
}

export function activeBindingPath(dataDir: string): string {
  return join(bindingRegistryDir(dataDir), ACTIVE_FILE);
}

export function daemonPidPath(dataDir: string): string {
  return join(dataDir, "l3-bridge.pid");
}

export function queuedLedgerPath(dataDir: string): string {
  return join(dataDir, "l3-queued.json");
}

export function bridgeLogPath(dataDir: string): string {
  return join(dataDir, "l3-bridge.log");
}

export function bridgeHealthPath(dataDir: string): string {
  return join(dataDir, HEALTH_FILENAME);
}

/**
 * Explicit write: register this session, mirror the legacy single file and make
 * it the active default. SessionStart must not use this (see
 * `registerSessionBinding`); it exists for callers that really mean
 * "this is the binding".
 */
export function writeBinding(dataDir: string, binding: L3SessionBinding): void {
  writeSessionBinding(dataDir, binding);
  setActiveSession(dataDir, binding.sessionId);
}

/** Legacy single-file write only, for old deployments and migration tests. */
export function writeLegacyBinding(
  dataDir: string,
  binding: L3SessionBinding,
): void {
  atomicJsonWrite(bindingPath(dataDir), binding);
}

/**
 * Read the active default binding: the registry entry the active pointer names,
 * else the newest registered session, else the legacy single file.
 */
export function readBinding(dataDir: string): L3SessionBinding | undefined {
  const registered = listSessionBindings(dataDir);
  if (registered.length > 0) return selectPreferredBinding(dataDir, registered);
  return readLegacyBinding(dataDir);
}

export function readLegacyBinding(
  dataDir: string,
): L3SessionBinding | undefined {
  return parseBinding(readJson(bindingPath(dataDir)));
}

export function readSessionBinding(
  dataDir: string,
  sessionId: string,
): L3SessionBinding | undefined {
  const parsed = parseBinding(readJson(sessionBindingPath(dataDir, sessionId)));
  return parsed && parsed.sessionId === sessionId ? parsed : undefined;
}

/** Register (or refresh) one session without touching the active default. */
export function writeSessionBinding(
  dataDir: string,
  binding: L3SessionBinding,
): void {
  atomicJsonWrite(sessionBindingPath(dataDir, binding.sessionId), binding);
}

/**
 * Register a SessionStart. The first registered session becomes the active
 * default; a different session joining later is registered but does not steal
 * the active default, and refreshing the same session keeps it.
 */
export function registerSessionBinding(
  dataDir: string,
  binding: L3SessionBinding,
): BindingRegistrationResult {
  // Resolve (and if needed migrate) the active default first, so a legacy file
  // naming this very session is reported as a refresh rather than a new binding.
  const activeSessionId = resolveActiveSessionId(dataDir);
  const existing = readSessionBinding(dataDir, binding.sessionId);

  writeSessionBinding(dataDir, binding);

  if (activeSessionId && activeSessionId !== binding.sessionId) {
    return { registration: existing ? "refreshed" : "inactive", activeSessionId };
  }

  if (activeSessionId === binding.sessionId) {
    // Same-session refresh: keep the active default and re-mirror the legacy file.
    setActiveSession(dataDir, binding.sessionId);
    return {
      registration: existing ? "refreshed" : "created",
      activeSessionId: binding.sessionId,
    };
  }

  // No active default yet: the first SessionStart to create the pointer wins, so
  // two chats starting at the same moment cannot each claim it.
  if (claimActiveSession(dataDir, binding)) {
    return {
      registration: existing ? "refreshed" : "created",
      activeSessionId: binding.sessionId,
    };
  }

  const winner = readActiveSessionId(dataDir);
  return {
    registration: existing ? "refreshed" : "inactive",
    activeSessionId: winner,
  };
}

/** Exclusive create of the active pointer; false means another session won. */
function claimActiveSession(
  dataDir: string,
  binding: L3SessionBinding,
): boolean {
  const path = activeBindingPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  try {
    const fd = openSync(path, "wx");
    try {
      writeFileSync(
        fd,
        `${JSON.stringify(
          { sessionId: binding.sessionId, updatedAt: new Date().toISOString() },
          null,
          2,
        )}
`,
        "utf8",
      );
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  // Keep the legacy single file pointing at the session that actually receives.
  atomicJsonWrite(bindingPath(dataDir), binding);
  return true;
}

/**
 * The active default, migrating a legacy single-file install on first use: an
 * old-style binding is the session currently receiving, so it is seeded into
 * the registry instead of being silently replaced by the next chat.
 */
function resolveActiveSessionId(dataDir: string): string | undefined {
  const pointer = readActiveSessionId(dataDir);
  if (pointer && readSessionBinding(dataDir, pointer)) return pointer;

  const registered = listSessionBindings(dataDir);
  if (registered.length > 0) {
    // A stale pointer (session removed) must not freeze the active default.
    const fallback = registered[0];
    setActiveSession(dataDir, fallback.sessionId);
    return fallback.sessionId;
  }

  const legacy = readLegacyBinding(dataDir);
  if (!legacy) return undefined;
  writeSessionBinding(dataDir, legacy);
  setActiveSession(dataDir, legacy.sessionId);
  return legacy.sessionId;
}

/**
 * Write the binding and make it the active default. This is the explicit
 * activation/takeover entry point used by `COAGENTHUB_BINDING_TAKEOVER=1`.
 */
export function activateSessionBinding(
  dataDir: string,
  binding: L3SessionBinding,
): void {
  writeSessionBinding(dataDir, binding);
  setActiveSession(dataDir, binding.sessionId);
}

/** Point the active default at an already registered session. */
export function setActiveSession(dataDir: string, sessionId: string): boolean {
  const binding = readSessionBinding(dataDir, sessionId);
  if (!binding) return false;
  atomicJsonWrite(activeBindingPath(dataDir), {
    sessionId,
    updatedAt: new Date().toISOString(),
  });
  // Mirror the active default into the legacy single file so an older build or
  // an external reader still sees the session that actually receives.
  atomicJsonWrite(bindingPath(dataDir), binding);
  return true;
}

/** Explicit activation by session id, for hooks/tools that already know it. */
export function activateSession(dataDir: string, sessionId: string): boolean {
  return setActiveSession(dataDir, sessionId);
}

export function readActiveSessionId(dataDir: string): string | undefined {
  const value = readJson(activeBindingPath(dataDir));
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && sessionId.trim() !== ""
    ? sessionId
    : undefined;
}

export function listSessionBindings(dataDir: string): L3SessionBinding[] {
  let names: string[];
  try {
    names = readdirSync(bindingRegistryDir(dataDir));
  } catch {
    return [];
  }

  const bySession = new Map<string, L3SessionBinding>();
  for (const name of names) {
    if (name === ACTIVE_FILE || !name.endsWith(".json")) continue;
    const parsed = parseBinding(
      readJson(join(bindingRegistryDir(dataDir), name)),
    );
    if (!parsed) continue;
    const previous = bySession.get(parsed.sessionId);
    if (!previous || previous.updatedAt < parsed.updatedAt) {
      bySession.set(parsed.sessionId, parsed);
    }
  }

  return [...bySession.values()].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId),
  );
}

/** Registered binding for a Delivery recipient, preferring the active default. */
export function readBindingForRecipient(
  dataDir: string,
  recipient: string,
): L3SessionBinding | undefined {
  const registered = listSessionBindings(dataDir);
  const pool =
    registered.length > 0
      ? registered
      : ([readLegacyBinding(dataDir)].filter(Boolean) as L3SessionBinding[]);
  return selectPreferredBinding(
    dataDir,
    pool.filter((binding) => bindingRecipient(binding) === recipient),
  );
}

export function bindingRecipient(binding: L3SessionBinding): string | undefined {
  return binding.recipient?.trim() || undefined;
}

/**
 * Deterministic pick: the active default when it is a candidate, else the most
 * recently updated one. Never fan out to several sessions.
 */
export function selectPreferredBinding(
  dataDir: string,
  candidates: L3SessionBinding[],
): L3SessionBinding | undefined {
  if (candidates.length === 0) return undefined;
  const activeSessionId = readActiveSessionId(dataDir);
  if (activeSessionId) {
    const active = candidates.find((item) => item.sessionId === activeSessionId);
    if (active) return active;
  }
  return [...candidates].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId),
  )[0];
}

export function hasQueuedDelivery(dataDir: string, deliveryId: string): boolean {
  return readQueuedLedger(dataDir).ids.includes(deliveryId);
}

export function rememberQueuedDelivery(dataDir: string, deliveryId: string): void {
  const current = readQueuedLedger(dataDir).ids.filter((id) => id !== deliveryId);
  current.push(deliveryId);
  atomicJsonWrite(queuedLedgerPath(dataDir), { ids: current.slice(-1000) });
}

export function readBridgeHealth(dataDir: string): L3BridgeHealth {
  const value = readJson(bridgeHealthPath(dataDir));
  const row =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const status: L3BridgeHealth["status"] =
    row.status === "ok" || row.status === "degraded" ? row.status : "starting";
  const lastError = parseHealthError(row.lastError);

  return {
    status,
    updatedAt: optionalIso(row.updatedAt) ?? new Date(0).toISOString(),
    polls: nonNegativeInteger(row.polls),
    deliveredTotal: nonNegativeInteger(row.deliveredTotal),
    consecutiveFailures: nonNegativeInteger(row.consecutiveFailures),
    ...withOptional("lastPollStartedAt", optionalIso(row.lastPollStartedAt)),
    ...withOptional("lastPollSucceededAt", optionalIso(row.lastPollSucceededAt)),
    ...withOptional("lastDeliveryAt", optionalIso(row.lastDeliveryAt)),
    ...(lastError ? { lastError } : {}),
  };
}

/** Query function for observability; same data as the health file. */
export function getBridgeHealth(dataDir: string): L3BridgeHealth {
  return readBridgeHealth(dataDir);
}

/**
 * Record one completed poll in a single write (started + outcome together).
 * Counts and timestamps only; no delivery body, summary or credential.
 */
export function recordPollSuccess(
  dataDir: string,
  delivered: number,
  options: { startedAt?: string; at?: string } = {},
): void {
  const at = options.at ?? new Date().toISOString();
  const current = readBridgeHealth(dataDir);
  const count = Number.isFinite(delivered) && delivered > 0 ? Math.floor(delivered) : 0;
  atomicJsonWrite(bridgeHealthPath(dataDir), {
    ...current,
    status: "ok",
    updatedAt: at,
    polls: current.polls + 1,
    ...(options.startedAt ? { lastPollStartedAt: options.startedAt } : {}),
    lastPollSucceededAt: at,
    consecutiveFailures: 0,
    deliveredTotal: current.deliveredTotal + count,
    ...(count > 0 ? { lastDeliveryAt: at } : {}),
  });
}

/**
 * A failed poll must never look like a fresh success: the previous
 * `lastPollSucceededAt` / `lastDeliveryAt` are left untouched.
 */
export function recordPollFailure(
  dataDir: string,
  error: unknown,
  options: { startedAt?: string; at?: string } = {},
): void {
  const at = options.at ?? new Date().toISOString();
  const current = readBridgeHealth(dataDir);
  atomicJsonWrite(bridgeHealthPath(dataDir), {
    ...current,
    status: "degraded",
    updatedAt: at,
    polls: current.polls + 1,
    ...(options.startedAt ? { lastPollStartedAt: options.startedAt } : {}),
    consecutiveFailures: current.consecutiveFailures + 1,
    lastError: { at, code: "poll_failed", ...safeErrorName(error) },
  });
}

function parseBinding(value: unknown): L3SessionBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.sessionId !== "string" || typeof row.cwd !== "string") {
    return undefined;
  }
  const inboxScope = row.inboxScope === "all" ? "all" : "recipient";
  const recipient =
    typeof row.recipient === "string" && row.recipient.trim() !== ""
      ? row.recipient
      : inboxScope === "recipient"
        ? row.sessionId
        : undefined;
  return {
    sessionId: row.sessionId,
    cwd: row.cwd,
    inboxScope,
    ...(recipient ? { recipient } : {}),
    ...(typeof row.source === "string" ? { source: row.source } : {}),
    updatedAt:
      typeof row.updatedAt === "string" ? row.updatedAt : new Date(0).toISOString(),
  };
}

/**
 * Normalise a stored error to a fixed code. Legacy files carried a free-form
 * `message`; it is discarded on read, never echoed back to a caller.
 */
function parseHealthError(value: unknown): L3BridgeHealth["lastError"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  return {
    at: optionalIso(row.at) ?? new Date(0).toISOString(),
    code: normalizeErrorCode(row.code),
    ...safeErrorName({ name: row.name }),
  };
}

function normalizeErrorCode(value: unknown): BridgeErrorCode {
  return typeof value === "string" &&
    (HEALTH_ERROR_CODES as readonly string[]).includes(value)
    ? (value as BridgeErrorCode)
    : "poll_failed";
}

function optionalIso(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function withOptional<K extends string>(
  key: K,
  value: string | undefined,
): Record<K, string> | Record<string, never> {
  return (value ? { [key]: value } : {}) as Record<K, string>;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/**
 * Only an allow-listed `name` may be recorded; a message, a stack, a response
 * body or any other string on the error object is never read.
 */
function safeErrorName(
  error: unknown,
): { name?: BridgeErrorName } {
  if (!error || typeof error !== "object") return {};
  let name: unknown;
  try {
    name = (error as { name?: unknown }).name;
  } catch {
    return {};
  }
  return typeof name === "string" &&
    (ERROR_NAME_ALLOWLIST as readonly string[]).includes(name)
    ? { name: name as BridgeErrorName }
    : {};
}

export function readDaemonPid(dataDir: string): number | undefined {
  try {
    const pid = Number(readFileSync(daemonPidPath(dataDir), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function clearDeadDaemonPid(dataDir: string): void {
  const pid = readDaemonPid(dataDir);
  if (pid && pidIsAlive(pid)) return;
  try {
    unlinkSync(daemonPidPath(dataDir));
  } catch {
    // Missing/stale pid file is already clear.
  }
}

function readQueuedLedger(dataDir: string): QueuedLedger {
  const value = readJson(queuedLedgerPath(dataDir));
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ids: [] };
  const ids = (value as { ids?: unknown }).ids;
  return {
    ids: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
  };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function atomicJsonWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    renameSync(temp, path);
  } catch {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      unlinkSync(temp);
    } catch {
      // Best effort cleanup only.
    }
  }
}
