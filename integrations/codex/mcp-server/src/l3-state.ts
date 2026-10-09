import {
  mkdirSync,
  readFileSync,
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

export function pluginDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured =
    env.PLUGIN_DATA?.trim() || env.COAGENTHUB_PLUGIN_DATA?.trim();
  return resolve(configured || join(homedir(), ".codex", "coagenthub-v5"));
}

export function bindingPath(dataDir: string): string {
  return join(dataDir, "l3-binding.json");
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

export function writeBinding(dataDir: string, binding: L3SessionBinding): void {
  atomicJsonWrite(bindingPath(dataDir), binding);
}

export function readBinding(dataDir: string): L3SessionBinding | undefined {
  const value = readJson(bindingPath(dataDir));
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

export function hasQueuedDelivery(dataDir: string, deliveryId: string): boolean {
  return readQueuedLedger(dataDir).ids.includes(deliveryId);
}

export function rememberQueuedDelivery(dataDir: string, deliveryId: string): void {
  const current = readQueuedLedger(dataDir).ids.filter((id) => id !== deliveryId);
  current.push(deliveryId);
  atomicJsonWrite(queuedLedgerPath(dataDir), { ids: current.slice(-1000) });
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
