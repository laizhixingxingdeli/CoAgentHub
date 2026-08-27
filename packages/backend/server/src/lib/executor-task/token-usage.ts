import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type TokenUsageReason = "unsupported" | "unavailable";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  totalTokens: number;
  source: string;
}

export interface TokenUsageResult {
  tokenUsage: TokenUsage | null;
  reason?: TokenUsageReason;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
}

export interface TokenUsageCollectionInput {
  executorKey: string;
  executorPid?: number;
  taskId?: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  stdout?: string;
  homeDir?: string;
}

function nonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function readUsageObject(value: unknown): UsageTotals | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const inputTokens = nonNegativeNumber(
    row.input_tokens ?? row.inputTokens ?? row.input,
  );
  const outputTokens = nonNegativeNumber(
    row.output_tokens ??
      row.outputTokens ??
      row.output ??
      row.completion_tokens,
  );
  const cachedReadTokens = nonNegativeNumber(
    row.cached_input_tokens ??
      row.cachedInputTokens ??
      row.cached_input ??
      row.cached_tokens ??
      row.cachedTokens ??
      row.cache_read_input_tokens ??
      row.cacheReadInputTokens,
  );
  const cachedCreationTokens = nonNegativeNumber(
    row.cache_creation_input_tokens ?? row.cacheCreationInputTokens,
  );
  const cachedInputTokens =
    cachedReadTokens === undefined && cachedCreationTokens === undefined
      ? undefined
      : (cachedReadTokens ?? 0) + (cachedCreationTokens ?? 0);
  const explicitTotal = nonNegativeNumber(row.total_tokens ?? row.totalTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: cachedInputTokens ?? 0,
    totalTokens:
      explicitTotal ?? inputTokens + (cachedInputTokens ?? 0) + outputTokens,
  };
}

function addTotals(target: UsageTotals, value: UsageTotals): void {
  target.inputTokens += value.inputTokens;
  target.outputTokens += value.outputTokens;
  target.cachedInputTokens += value.cachedInputTokens;
  target.totalTokens += value.totalTokens;
}

function finishTotals(totals: UsageTotals, source: string): TokenUsage {
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    ...(totals.cachedInputTokens > 0
      ? { cachedInputTokens: totals.cachedInputTokens }
      : {}),
    totalTokens: totals.totalTokens,
    source,
  };
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function inWindow(value: unknown, start: number, end: number): boolean {
  const timestamp = timestampMs(value);
  return (
    timestamp !== undefined &&
    timestamp >= start - 5_000 &&
    timestamp <= end + 5_000
  );
}

function recordMatches(
  record: Record<string, unknown>,
  input: TokenUsageCollectionInput,
  start: number,
  end: number,
): boolean {
  const recordPid = nonNegativeNumber(
    record.pid ?? record.process_id ?? record.processId,
  );
  if (
    input.executorPid !== undefined &&
    recordPid !== undefined &&
    recordPid !== input.executorPid
  ) {
    return false;
  }
  return record.cwd === input.cwd && inWindow(record.timestamp, start, end);
}

function parseJsonLines(text: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // CLI logs can contain warnings beside JSONL; ignore non-JSON lines.
    }
  }
  return rows;
}

function tokenUsageFromCodexJsonl(text: string): TokenUsage | undefined {
  let latest: UsageTotals | undefined;
  for (const row of parseJsonLines(text)) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const payload = (record.payload ?? record) as Record<string, unknown>;
    // Real `codex exec --json` output reports token usage under `turn.completed`
    // events (verified against captured stdout). The previously-assumed
    // `token_count` type never appears in actual output, which is why every
    // coordinator run was recorded as `unavailable`. Take the last such record.
    if (payload.type !== "turn.completed") continue;
    const usage = readUsageObject(payload.usage);
    if (usage) latest = usage;
  }
  return latest ? finishTotals(latest, "codex-stdout-jsonl") : undefined;
}

/** Extract the final assistant text from `codex exec --json` output. */
export function extractCodexExecText(text: string): string | undefined {
  const messages: string[] = [];
  for (const row of parseJsonLines(text)) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const payload = (record.payload ?? record) as Record<string, unknown>;
    if (payload.type !== "message" || payload.role !== "assistant") continue;
    const content = Array.isArray(payload.content) ? payload.content : [];
    const parts = content
      .filter((part): part is Record<string, unknown> =>
        Boolean(part && typeof part === "object"),
      )
      .filter(
        (part) => part.type === "output_text" && typeof part.text === "string",
      )
      .map((part) => part.text as string);
    if (parts.length > 0) messages.push(parts.join("\n"));
  }
  return messages.at(-1);
}

function walkFiles(root: string, suffix: string, maxFiles = 2_000): string[] {
  const result: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 5 || result.length >= maxFiles) return;
    let entries: Array<{
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }>;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(suffix)) result.push(path);
      if (result.length >= maxFiles) return;
    }
  };
  visit(root, 0);
  return result;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function collectClaude(
  input: TokenUsageCollectionInput,
): TokenUsage | undefined {
  const start = Date.parse(input.startedAt);
  const end = Date.parse(input.endedAt);
  const totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
  };
  let count = 0;
  const matchingFiles = new Set<string>();
  for (const file of walkFiles(
    join(input.homeDir ?? homedir(), ".claude", "projects"),
    ".jsonl",
  )) {
    for (const row of parseJsonLines(readText(file) ?? "")) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      if (!recordMatches(record, input, start, end)) continue;
      const message = record.message as Record<string, unknown> | undefined;
      const usage = readUsageObject(message?.usage);
      if (usage) {
        addTotals(totals, usage);
        count += 1;
        matchingFiles.add(file);
      }
    }
  }
  return count > 0 && matchingFiles.size === 1
    ? finishTotals(totals, "claude-jsonl")
    : undefined;
}

function collectCodeBuddy(
  input: TokenUsageCollectionInput,
): TokenUsage | undefined {
  const start = Date.parse(input.startedAt);
  const end = Date.parse(input.endedAt);
  const totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
  };
  let count = 0;
  const matchingFiles = new Set<string>();
  for (const file of walkFiles(
    join(input.homeDir ?? homedir(), ".codebuddy", "projects"),
    ".jsonl",
  )) {
    for (const row of parseJsonLines(readText(file) ?? "")) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      if (!recordMatches(record, input, start, end)) continue;
      const usage = readUsageObject(record.usage);
      if (usage) {
        addTotals(totals, usage);
        count += 1;
        matchingFiles.add(file);
      }
    }
  }
  return count > 0 && matchingFiles.size === 1
    ? finishTotals(totals, "codebuddy-jsonl")
    : undefined;
}

function collectAtomCode(
  input: TokenUsageCollectionInput,
): TokenUsage | undefined {
  const start = Date.parse(input.startedAt);
  const end = Date.parse(input.endedAt);
  const namedMatches: TokenUsage[] = [];
  const fallbackMatches: TokenUsage[] = [];
  for (const file of walkFiles(
    join(input.homeDir ?? homedir(), ".atomcode", "sessions"),
    ".meta",
  )) {
    const raw = readText(file);
    if (!raw) continue;
    try {
      const session = JSON.parse(raw) as Record<string, unknown>;
      const sessionName = session.name;
      const ticketPrefix =
        typeof sessionName === "string" &&
        sessionName.startsWith("/tmp/coagenthub-ticket-")
          ? sessionName.slice("/tmp/coagenthub-ticket-".length)
          : undefined;
      const isTaskTicketMatch =
        input.taskId !== undefined &&
        ticketPrefix !== undefined &&
        ticketPrefix.length > 0 &&
        input.taskId.startsWith(ticketPrefix);
      const created = timestampMs(session.created_at);
      const updated = timestampMs(session.updated_at);
      if (!isTaskTicketMatch) {
        if (
          session.working_dir !== input.cwd ||
          created === undefined ||
          updated === undefined
        )
          continue;
        if (created > end + 5_000 || updated < start - 5_000) continue;
        const sessionPid = nonNegativeNumber(
          session.pid ?? session.process_id ?? session.processId,
        );
        if (
          input.executorPid !== undefined &&
          sessionPid !== undefined &&
          sessionPid !== input.executorPid
        ) {
          continue;
        }
      }
      const totals: UsageTotals = {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
      };
      const stats = Array.isArray(session.turn_stats) ? session.turn_stats : [];
      for (const stat of stats) {
        if (!stat || typeof stat !== "object") continue;
        const modelUsage = (stat as Record<string, unknown>).model_usage;
        if (!Array.isArray(modelUsage)) continue;
        for (const model of modelUsage) {
          const tokens =
            model && typeof model === "object"
              ? (model as Record<string, unknown>).tokens
              : undefined;
          const usage = readUsageObject(tokens);
          if (usage) addTotals(totals, usage);
        }
      }
      if (totals.totalTokens > 0) {
        const matches = isTaskTicketMatch ? namedMatches : fallbackMatches;
        matches.push(finishTotals(totals, "atomcode-session-meta"));
      }
    } catch {
      // Ignore a session that is being written while the task ends.
    }
  }
  if (namedMatches.length > 0) {
    return namedMatches.length === 1 ? namedMatches[0] : undefined;
  }
  return fallbackMatches.length === 1 ? fallbackMatches[0] : undefined;
}

/**
 * Recursively visit every nested object in a parsed JSON value. Used by the
 * generic fallback to locate a usage record no matter how deep it is nested.
 */
function walkJsonObjects(
  value: unknown,
  visit: (obj: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) walkJsonObjects(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    visit(obj);
    for (const key of Object.keys(obj)) walkJsonObjects(obj[key], visit);
  }
}

/**
 * Generic, CLI-agnostic fallback. Scan every JSONL line of `stdout` and
 * recursively inspect every nested object; any object `readUsageObject` can
 * parse into a real (input+output) usage record is a candidate. We keep the
 * LAST candidate because cumulative totals usually appear in the final event.
 * This deliberately judges by *semantics* (parseable usage) rather than by a
 * fixed `type` or nesting level, so an unknown executor still yields its real
 * accounting instead of `unsupported`.
 */
function collectGenericJsonl(stdout: string): TokenUsage | undefined {
  let latest: UsageTotals | undefined;
  let latestExplicitTotal: number | undefined;
  for (const row of parseJsonLines(stdout)) {
    walkJsonObjects(row, (obj) => {
      const usage = readUsageObject(obj);
      if (usage) {
        latest = usage;
        latestExplicitTotal = nonNegativeNumber(
          obj.total_tokens ?? obj.totalTokens,
        );
      }
    });
  }
  if (!latest) return undefined;
  // Conservative total caliber. OpenAI/Codex-family usage reports `cached_*`
  // and `reasoning_*` as subsets of `input_tokens`/`output_tokens`; adding them
  // again would double-count (this is exactly why the dedicated Codex collector
  // uses input+output). When a source object supplies an explicit
  // `total_tokens`/`totalTokens` we trust it as authoritative; otherwise the
  // safe universal default is total = input + output so we never inflate by
  // re-adding cache/reasoning subsets. For CLIs where cached tokens are
  // strictly additive (Claude/CodeBuddy/AtomCode models) this generic scan may
  // report a lower total than their dedicated collectors — those executors have
  // custom paths, so the scan only runs for unknown keys where the subset
  // assumption is the safest default.
  const totalTokens =
    latestExplicitTotal ?? latest.inputTokens + latest.outputTokens;
  return finishTotals({ ...latest, totalTokens }, "generic-jsonl-scan");
}

/**
 * Collect native CLI accounting at task termination. A missing match is never
 * guessed: callers persist `unavailable` (or `unsupported` for runtimes with
 * no native source) explicitly.
 */
export async function collectTokenUsage(
  input: TokenUsageCollectionInput,
): Promise<TokenUsageResult> {
  if (input.executorKey === "codex") {
    const stdoutUsage = tokenUsageFromCodexJsonl(input.stdout ?? "");
    if (stdoutUsage) return { tokenUsage: stdoutUsage };
    return { tokenUsage: null, reason: "unavailable" };
  }
  const usage =
    input.executorKey === "executor"
      ? collectAtomCode(input)
      : input.executorKey === "codebuddy"
        ? collectCodeBuddy(input)
        : input.executorKey === "claude"
          ? collectClaude(input)
          : undefined;
  if (usage) return { tokenUsage: usage };
  // Generic semantic fallback. The custom branches above are precise
  // accelerators; for every other executor (including the previously
  // `unsupported` reasonix/hermes/win-hermes/reviewer) we scan the whole
  // stdout JSONL and take the last object that readUsageObject can parse as a
  // real usage record — regardless of CLI type or how deeply it is nested.
  const generic = collectGenericJsonl(input.stdout ?? "");
  if (generic) return { tokenUsage: generic };
  if (
    ["reasonix", "hermes", "win-hermes", "reviewer"].includes(input.executorKey)
  ) {
    return { tokenUsage: null, reason: "unsupported" };
  }
  return { tokenUsage: null, reason: "unavailable" };
}
