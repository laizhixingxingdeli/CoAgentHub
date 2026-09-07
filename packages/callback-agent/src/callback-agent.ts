import { unlinkSync } from "node:fs";
import { CompletionEventClient } from "./api.js";
import {
  CommandDriverError,
  createEventFile,
  executeCommand,
} from "./command-driver.js";
import type {
  CallbackAgentConfig,
  CommandDriver,
  CompletionEvent,
  InboxItem,
} from "./config.js";
import { DedupeStore } from "./dedupe.js";
import type { Logger } from "./logger.js";

export interface CallbackAgentOptions {
  config: CallbackAgentConfig;
  dedupeStore?: DedupeStore;
  apiClient?: CompletionEventClient;
  logger?: Logger;
}

export type AgentState = "idle" | "polling" | "processing" | "stopped";

/**
 * Generic Callback Agent — polls the participant completion-event inbox,
 * claims events, executes the matching command driver, and acks.
 *
 * Lifecycle per event:
 *   1. claim event (atomic lease via core API)
 *   2. look up endpoint config by callbackRef.endpointRef
 *   3. resolve placeholders, write event file, execute command (shell:false)
 *   4. on success: atomically write to local dedupe store THEN ack
 *   5. on failure: call core fail API (no local dedupe write)
 *
 * Crash safety: if the process dies between local dedupe write and ack,
 * the next run sees eventId in the dedupe store and re-claims a fresh lease
 * and re-acks (it never re-executes the command).
 */
export class CallbackAgent {
  private readonly config: CallbackAgentConfig;
  readonly client: CompletionEventClient;
  private readonly dedupe: DedupeStore;
  private readonly logger: Logger;
  private state: AgentState = "idle";

  constructor(options: CallbackAgentOptions) {
    this.config = options.config;
    this.client =
      options.apiClient ??
      new CompletionEventClient(this.config.apiBase, this.config.participantId);
    this.dedupe =
      options.dedupeStore ??
      new DedupeStore("/tmp/callback-agent-dedupe.jsonl");
    this.logger = options.logger ?? consoleLogger();
  }

  /** Run a single poll → process cycle. Returns the number of events processed. */
  async runOnce(): Promise<number> {
    this.state = "polling";
    const events = await this.listClaimableEvents();
    if (events.length === 0) {
      this.state = "idle";
      return 0;
    }

    this.state = "processing";
    let processed = 0;
    for (const event of events) {
      const didProcess = await this.processEvent(event);
      if (didProcess) processed++;
    }
    this.state = "idle";
    return processed;
  }

  /**
   * Run the poll→process loop until stop() is called.
   * Graceful exit on SIGINT/SIGTERM.
   */
  async run(): Promise<void> {
    this.state = "idle";
    this.logger.info?.(
      `callback-agent started (participant=${this.config.participantId})`,
    );

    let running = true;
    const shutdown = () => {
      this.logger.info?.("callback-agent shutting down...");
      running = false;
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    while (running) {
      try {
        await this.runOnce();
      } catch (err) {
        this.logger.error?.(`poll cycle error: ${formatError(err)}`);
      }
      if (!running) break;
      await sleep(this.config.pollIntervalMs);
    }

    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    this.state = "stopped";
    this.logger.info?.("callback-agent stopped");
  }

  /** Signal the agent to stop after the current cycle. */
  stop(): void {
    this.state = "stopped";
    process.emit("SIGTERM");
  }

  getState(): AgentState {
    return this.state;
  }

  /**
   * Process a single event: claim → execute → dedupe → ack (or fail).
   * @returns true if the event was processed (claimed), false if skipped.
   */
  async processEvent(eventStub: InboxItem): Promise<boolean> {
    const eventId = eventStub.eventId;

    // Dedupe guard: command already ran (crash between dedupe write & ack).
    // Re-claim a FRESH lease and re-ack to drive the event to delivered.
    // Never execute the command again — the premise of this branch is that
    // it already ran successfully.
    if (this.dedupe.isDelivered(eventId)) {
      let leaseToken: string;
      try {
        const claimRes = await this.client.claimEvent(
          eventId,
          this.config.consumerId,
          this.config.leaseMs,
        );
        leaseToken = claimRes.leaseToken;
      } catch (err) {
        // Not claimable (already leased, delivered, or not found). Skip this
        // round — no command, no ack, no fail; retry on next poll.
        this.logger.warn?.(
          `event ${eventId} is in dedupe store but re-claim failed: ${formatError(err)}`,
        );
        return false;
      }
      // Re-ack with the fresh lease token. ackWithRetry never throws; a full
      // retry failure returns false and the next poll re-attempts (dedupe
      // guard already prevents re-execution).
      const acked = await this.ackWithRetry(leaseToken, eventId);
      if (acked) {
        this.logger.info?.(
          `event ${eventId} dedupe hit — re-claimed and re-acknowledged (delivered)`,
        );
        return true;
      }
      this.logger.warn?.(
        `event ${eventId} dedupe hit — re-ack failed, will retry next poll`,
      );
      return false;
    }

    // Step 1: claim the event (atomic lease)
    let leaseToken: string;
    let event: CompletionEvent;
    try {
      const claimRes = await this.client.claimEvent(
        eventId,
        this.config.consumerId,
        this.config.leaseMs,
      );
      leaseToken = claimRes.leaseToken;
      event = claimRes.event;
    } catch (err) {
      this.logger.warn?.(
        `claim failed for event ${eventId}: ${formatError(err)}`,
      );
      return false; // Another consumer got the lease — skip
    }

    // Step 2: look up endpoint config
    const endpointRef = event.callbackRef?.endpointRef;
    if (!endpointRef) {
      this.logger.warn?.(`event ${eventId} has no endpointRef; failing`);
      await this.fail(leaseToken, eventId, "no endpointRef");
      return true;
    }
    const endpointConfig = this.config.endpoints[endpointRef];
    if (!endpointConfig) {
      this.logger.warn?.(
        `unknown endpoint "${endpointRef}" for event ${eventId}; failing`,
      );
      await this.fail(leaseToken, eventId, `unknown endpoint "${endpointRef}"`);
      return true;
    }

    // Step 3: execute command driver
    const driver = endpointConfig.driver;
    if (driver.driver !== "command") {
      this.logger.warn?.(
        `unsupported driver "${driver.driver}" for event ${eventId}; failing`,
      );
      await this.fail(
        leaseToken,
        eventId,
        `unsupported driver "${driver.driver}"`,
      );
      return true;
    }

    const result = await this.executeDriver(driver, event, eventId);

    // Step 4: handle result
    if (result.success) {
      // ATOMIC: write to local dedupe BEFORE ack
      await this.dedupe.write(eventId);
      this.logger.info?.(`event ${eventId} command executed successfully`);
      // Step 5: ack (idempotent — safe to retry if we crash before this)
      await this.ackWithRetry(leaseToken, eventId);
    } else {
      // Failure: call core fail (no local dedupe write)
      await this.fail(leaseToken, eventId, result.error);
    }
    return true;
  }

  /**
   * Execute the command driver for an event.
   */
  private async executeDriver(
    driver: CommandDriver,
    event: CompletionEvent,
    _eventId: string,
  ): Promise<{ success: true } | { success: false; error: string }> {
    const eventFilePath = createEventFile(event);
    const sessionRef = event.callbackRef?.sessionRef;

    try {
      const result = await executeCommand(driver, {
        event,
        eventFilePath,
        sessionRef,
      });

      if (result.timedOut) {
        return {
          success: false,
          error: `command timed out after ${driver.timeoutMs ?? 60_000}ms`,
        };
      }
      if (result.exitCode !== 0) {
        return {
          success: false,
          error: `command exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
        };
      }
      return { success: true };
    } catch (err) {
      if (err instanceof CommandDriverError) {
        return { success: false, error: err.message };
      }
      return { success: false, error: formatError(err) };
    } finally {
      // Clean up temp event file
      try {
        unlinkSync(eventFilePath);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  private async ackWithRetry(
    leaseToken: string,
    eventId: string,
    retries = 3,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.client.ackEvent(eventId, leaseToken);
        this.logger.info?.(`event ${eventId} acknowledged`);
        return true;
      } catch (err) {
        this.logger.warn?.(
          `ack attempt ${attempt}/${retries} failed for event ${eventId}: ${formatError(err)}`,
        );
        if (attempt < retries) await sleep(1000 * attempt);
      }
    }
    // All ack attempts failed — eventId is in dedupe store, so next run will re-ack
    this.logger.error?.(
      `ack failed after ${retries} attempts for event ${eventId}; dedupe store prevents re-execution`,
    );
    return false;
  }

  private async fail(
    leaseToken: string,
    eventId: string,
    error: string,
  ): Promise<void> {
    try {
      const truncated = error.slice(0, 2000);
      await this.client.failEvent(eventId, leaseToken, truncated);
      this.logger.warn?.(
        `event ${eventId} marked as failed: ${truncated.slice(0, 200)}`,
      );
    } catch (err) {
      this.logger.error?.(
        `fail API call failed for event ${eventId}: ${formatError(err)}`,
      );
    }
  }

  private async listClaimableEvents(): Promise<InboxItem[]> {
    try {
      return await this.client.listEvents(undefined, 100);
    } catch (err) {
      this.logger.error?.(`listEvents failed: ${formatError(err)}`);
      return [];
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function consoleLogger(): Logger {
  return {
    info: (msg?: string) => console.log(`[callback-agent] ${msg}`),
    warn: (msg?: string) => console.warn(`[callback-agent] ${msg}`),
    error: (msg?: string) => console.error(`[callback-agent] ${msg}`),
  };
}
