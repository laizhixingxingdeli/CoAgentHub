import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { CoAgentHubClient } from "./coagenthub-client.js";
import { pollOnce } from "./l3-bridge.js";
import {
  bridgeLogPath,
  daemonPidPath,
  pidIsAlive,
  pluginDataDir,
} from "./l3-state.js";

const dataDir = pluginDataDir();
const pidFile = daemonPidPath(dataDir);
const logFile = bridgeLogPath(dataDir);
const pollIntervalMs = positiveInteger(
  process.env.COAGENTHUB_INBOX_POLL_MS,
  1_000,
);
const recipient = process.env.COAGENTHUB_INBOX_RECIPIENT?.trim() || undefined;

let running = true;

if (!claimSingleton()) process.exit(0);

process.on("SIGINT", () => {
  running = false;
});
process.on("SIGTERM", () => {
  running = false;
});

try {
  const client = new CoAgentHubClient();
  let retryMs = pollIntervalMs;
  log(`started pid=${process.pid} poll=${pollIntervalMs}ms`);

  while (running) {
    try {
      const handled = await pollOnce({ dataDir, client, recipient });
      if (handled > 0) log(`delivered ${handled} inbox item(s)`);
      retryMs = pollIntervalMs;
    } catch (error) {
      log(`poll failed: ${safeError(error)}`);
      retryMs = Math.min(Math.max(retryMs * 2, 1_000), 10_000);
    }
    if (running) await sleep(retryMs);
  }
} finally {
  releaseSingleton();
  log("stopped");
}

function claimSingleton(): boolean {
  mkdirSync(dirname(pidFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(pidFile, "wx");
      writeFileSync(fd, String(process.pid), "utf8");
      closeSync(fd);
      return true;
    } catch (error) {
      const existing = readPid();
      if (existing && pidIsAlive(existing)) return false;
      try {
        unlinkSync(pidFile);
      } catch {
        if (attempt === 1) throw error;
      }
    }
  }
  return false;
}

function releaseSingleton(): void {
  if (readPid() !== process.pid) return;
  try {
    unlinkSync(pidFile);
  } catch {
    // Process exit is still safe; a stale pid is cleared by the next hook.
  }
}

function readPid(): number | undefined {
  try {
    const value = Number(readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function log(message: string): void {
  try {
    if (statSync(logFile, { throwIfNoEntry: false })?.size && statSync(logFile).size > 1_000_000) {
      writeFileSync(logFile, "", "utf8");
    }
  } catch {
    // Log rotation is best effort.
  }
  try {
    appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // Logging must never stop delivery.
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
