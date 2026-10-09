import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  clearDeadDaemonPid,
  pidIsAlive,
  pluginDataDir,
  readDaemonPid,
} from "./l3-state.js";
import {
  bindSessionStart,
  type SessionStartInput,
} from "./session-binding.js";

const input = await readStdin();
const dataDir = pluginDataDir();

try {
  const scope =
    process.env.COAGENTHUB_INBOX_SCOPE?.trim().toLowerCase() === "all"
      ? "all"
      : "recipient";
  const recipient =
    process.env.COAGENTHUB_INBOX_RECIPIENT?.trim() || undefined;
  const result = bindSessionStart(input, dataDir, {
    inboxScope: scope,
    ...(recipient ? { recipient } : {}),
  });
  if (result.bound && process.env.COAGENTHUB_L3_BRIDGE !== "0") {
    ensureBridge(dataDir);
  }
  emitContext(result.context);
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      systemMessage: `CoAgentHub v5 L3 binding failed: ${safeError(error)}`,
    }),
  );
}

function ensureBridge(dataDir: string): void {
  clearDeadDaemonPid(dataDir);
  const pid = readDaemonPid(dataDir);
  if (pid && pidIsAlive(pid)) return;

  const here = dirname(fileURLToPath(import.meta.url));
  const daemon = join(here, "l3-daemon.js");
  const child = spawn(process.execPath, [daemon], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      PLUGIN_DATA: dataDir,
    },
  });
  child.unref();
}

async function readStdin(): Promise<SessionStartInput> {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const normalized = raw.replace(/^\uFEFF/u, "").trim();
  if (!normalized) return {};
  const value = JSON.parse(normalized) as unknown;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as SessionStartInput)
    : {};
}

function emitContext(additionalContext: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    }),
  );
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1000)
    : String(error).slice(0, 1000);
}
