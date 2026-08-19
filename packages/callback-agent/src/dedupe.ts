import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

/**
 * Atomic local dedupe store for callback-agent.
 *
 * Guarantees:
 * - write() atomically records an eventId BEFORE acking, so a crash between
 *   local write and ack only results in a redundant ack on restart (never
 *   re-executes the command).
 * - isDelivered() checks membership in O(1).
 *
 * Implementation: one eventId per line in a JSONL file.
 * Atomic write = write to tmp + rename (same filesystem, atomic on POSIX).
 */
export class DedupeStore {
  private readonly seen = new Set<string>();
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const content = readFileSync(this.filePath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) this.seen.add(trimmed);
      }
    } catch {
      // Corrupt file — start fresh (command may re-run, but no data loss).
      this.seen.clear();
    }
  }

  /** Returns true if eventId was already recorded as delivered. */
  isDelivered(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  /**
   * Atomically record eventId as delivered.
   * Uses write-to-temp + rename for crash safety.
   */
  async write(eventId: string): Promise<void> {
    if (this.seen.has(eventId)) return;
    this.seen.add(eventId);

    // Append atomically: write new content to temp file, then rename.
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    const lines = [...this.seen];
    writeFileSync(tmpPath, `${lines.join("\n")}\n`, "utf-8");
    renameSync(tmpPath, this.filePath);
  }

  /** Synchronous write variant for signal handlers. */
  writeSync(eventId: string): void {
    if (this.seen.has(eventId)) return;
    this.seen.add(eventId);
    appendFileSync(this.filePath, `${eventId}\n`, "utf-8");
  }

  /** Get all recorded eventIds (for testing/debugging). */
  all(): string[] {
    return [...this.seen];
  }
}
