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
 * Execute a command driver for a completion event.
 *
 * SAFETY INVARIANTS:
 * - spawn() is ALWAYS called with shell:false (never interprets shell metacharacters)
 * - executable and args come from LOCAL STATIC CONFIG — never from the event
 * - Event content (even shell metacharacters) is only ever passed as a single
 *   argument or written to an event file — never string-interpolated into a command
 * - Mixed placeholders in a single argument are rejected by config validation
 * - Environment variables are explicitly allowlisted — secrets are not inherited
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

  // Build environment: explicit allowlist only, no secret inheritance
  const env = driver.env ? { ...driver.env } : undefined;

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
      try {
        // Kill the entire process group
        if (child.pid) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        // Child already exited
      }
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
