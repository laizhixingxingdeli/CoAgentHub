import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandDriver, CompletionEvent } from "./config.js";
import { buildCompletionMessage } from "./envelope.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandDriverContext {
  event: CompletionEvent;
  /** Resolved absolute path to a temp file containing the message */
  eventFilePath: string;
  /** callbackRef.sessionRef for placeholder resolution */
  sessionRef?: string;
}

/**
 * Hardcoded minimal env keys copied from the parent when present.
 * This list is intentionally NOT configurable — a config knob would re-open
 * unrestricted inheritance. Each key is required for a bare executable to run:
 *
 * - PATH: locate the executable and shared dynamic loaders
 * - HOME: Unix tools resolve user dirs / config (~)
 * - USERPROFILE, HOMEDRIVE, HOMEPATH: Windows home equivalents
 * - SYSTEMROOT / WINDIR: Windows native image loader and system DLLs
 * - TEMP / TMP: scratch dirs used by runtimes and CLIs
 * - LANG / LC_ALL / LC_CTYPE: locale for CLI message/encoding behavior
 * - PATHEXT: Windows executable-extension resolution
 * - COMSPEC: Windows occasionally needed by native tooling
 */
export const MINIMAL_CHILD_ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATHEXT",
  "COMSPEC",
] as const;

/**
 * Build the child process env as an explicit allowlist (never `undefined`,
 * which would make Node inherit the full parent env including secrets).
 *
 * Layers (later wins):
 * 1. Hardcoded minimal set from the parent (see MINIMAL_CHILD_ENV_KEYS)
 * 2. `inheritEnv` — named keys copied from the parent when present
 * 3. `env` — explicit key/value pairs from local static config
 */
export function buildChildEnv(
  driverEnv?: Record<string, string>,
  inheritEnv?: string[],
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of MINIMAL_CHILD_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }

  // Windows stores env names case-insensitively; Node may expose "Path".
  // Ensure the child always sees a canonical PATH when any variant exists.
  if (env.PATH === undefined && process.env.Path !== undefined) {
    env.PATH = process.env.Path;
  }
  if (env.SYSTEMROOT === undefined && process.env.SystemRoot !== undefined) {
    env.SYSTEMROOT = process.env.SystemRoot;
  }

  if (inheritEnv) {
    for (const key of inheritEnv) {
      const val = process.env[key];
      if (val !== undefined) env[key] = val;
    }
  }

  if (driverEnv) {
    for (const [key, value] of Object.entries(driverEnv)) {
      env[key] = value;
    }
  }

  return env;
}

/**
 * Execute a command driver for a completion event.
 *
 * SAFETY INVARIANTS:
 * - spawn() is ALWAYS called with shell:false (never interprets shell metacharacters)
 * - executable and args come from LOCAL STATIC CONFIG — never from the event
 * - Event content (even shell metacharacters) is only ever passed as a single
 *   argument or written to an event file — never string-interpolated into a command
 * - Mixed placeholders in a single argument are rejected by config validation
 * - Child env is an explicit allowlist (minimal hardcoded set + optional
 *   inheritEnv names + optional env key/values). spawn() is never called with
 *   env: undefined, so the parent process env is never inherited wholesale.
 */
export async function executeCommand(
  driver: CommandDriver,
  ctx: CommandDriverContext,
): Promise<CommandResult> {
  const { event, eventFilePath, sessionRef } = ctx;

  // Resolve placeholders in args
  const message = buildCompletionMessage(event);
  const resolvedArgs = driver.args.map((arg) =>
    resolvePlaceholder(arg, message, eventFilePath, sessionRef),
  );

  // Explicit allowlist only — never pass undefined (Node would inherit all secrets).
  const env = buildChildEnv(driver.env, driver.inheritEnv);

  const timeoutMs = driver.timeoutMs ?? 60_000;

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let killed = false;

    let child: ChildProcess;
    try {
      child = spawn(driver.executable, resolvedArgs, {
        shell: false, // SAFETY: never shell-interpret
        env,
        // Prevent child from inheriting parent's stdio / file descriptors
        stdio: ["ignore", "pipe", "pipe"],
        // Detach so we can kill the process group on timeout
        detached: true,
      });
    } catch (err) {
      reject(new CommandDriverError("spawn error", err));
      return;
    }

    const timer = setTimeout(() => {
      killed = true;
      killChildTree(child);
    }, timeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf-8");
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new CommandDriverError("spawn error", err));
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (killed) {
        resolve({
          exitCode: -1,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          timedOut: true,
        });
        return;
      }
      resolve({
        exitCode: code ?? (signal ? 1 : 0),
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        timedOut: false,
      });
    });
  });
}

/**
 * Resolve a single argument placeholder.
 * - `{sessionRef}` → callbackRef.sessionRef (or empty string if absent)
 * - `{message}` → full JSON completion message
 * - `{eventFile}` → absolute path to temp file containing the message
 * - Static strings pass through unchanged
 */
function resolvePlaceholder(
  arg: string,
  message: string,
  eventFilePath: string,
  sessionRef?: string,
): string {
  switch (arg) {
    case "{sessionRef}":
      return sessionRef ?? "";
    case "{message}":
      return message;
    case "{eventFile}":
      return eventFilePath;
    default:
      return arg; // static string
  }
}

/**
 * Create a temp file with the completion message content.
 * Returns the absolute path. Caller is responsible for cleanup.
 */
export function createEventFile(event: CompletionEvent): string {
  const message = buildCompletionMessage(event);
  const filePath = join(tmpdir(), `coagenthub-callback-${randomUUID()}.json`);
  writeFileSync(filePath, message, "utf-8");
  return filePath;
}

/** Truncate output for logging (prevent log flooding). */
export function truncate(str: string, maxChars = 2000): string {
  if (str.length <= maxChars) return str;
  return `${str.slice(0, maxChars)}... [truncated, ${str.length} chars total]`;
}

/**
 * Kill a spawned child (and its tree). Unix uses the negative-pid process-group
 * form from `detached: true`; Windows has no POSIX process groups, so we use
 * `taskkill /T` and fall back to `child.kill()`.
 */
function killChildTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      killer.on("error", () => {
        try {
          child.kill();
        } catch {
          // already exited
        }
      });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Child already exited
    }
  }
}

/** Error class for command driver failures. */
export class CommandDriverError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CommandDriverError";
  }
}

export { unlinkSync };
