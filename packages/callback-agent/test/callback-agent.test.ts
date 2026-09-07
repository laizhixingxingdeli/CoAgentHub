import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CallbackAgent } from "../src/callback-agent.js";
import type { InboxItem } from "../src/config.js";
import { DedupeStore } from "../src/dedupe.js";
import type { Logger } from "../src/logger.js";
import { FakeCompletionApi } from "./fake-api.js";
import {
  createFailingExecutable,
  createFakeExecutable,
} from "./fake-executable.js";

function silentLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/** Captures log calls per level so tests can assert on what was logged. */
function captureLogger() {
  const info: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  const logger: Logger = {
    info: (m) => info.push(m ?? ""),
    warn: (m) => warn.push(m ?? ""),
    error: (m) => error.push(m ?? ""),
  };
  return { info, warn, error, logger };
}

/**
 * Cross-platform countable executable. Returns the path to a helper `.mjs`
 * that appends one "x" line to a side-count file on every invocation and
 * exits 0. It is driven as `node <helperPath>` (executable = process.execPath,
 * helper as the first arg) — a bare shebang script cannot be spawned directly
 * on Windows (EFTYPE), so the helper is never the executable itself. The spec
 * allows "fake-executable 或等价的可计数替身".
 */
function createCountingExecutable(name: string, dir: string): string {
  const binPath = join(dir, name);
  const countPath = `${binPath}.count`;
  const script = [
    "#!/usr/bin/env node",
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(countPath)}, "x\\n");`,
    "process.exit(0);",
    "",
  ].join("\n");
  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);
  return binPath;
}

/** Number of times the counting executable actually ran (reads the trace file). */
function readCount(binPath: string): number {
  try {
    const content = readFileSync(`${binPath}.count`, "utf-8");
    return content.split("\n").filter((line) => line === "x").length;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("CallbackAgent integration", () => {
  let fakeApi: FakeCompletionApi;
  let baseUrl: string;
  let tmpDir: string;

  beforeEach(async () => {
    fakeApi = new FakeCompletionApi();
    baseUrl = await fakeApi.start();
    tmpDir = mkdtempSync(join(tmpdir(), "coagenthub-callback-test-"));
  });

  afterEach(async () => {
    await fakeApi.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs list → claim → command → local dedupe → ack", async () => {
    const fakeBin = createFakeExecutable();
    const event = fakeApi.addEvent({
      callbackRef: { endpointRef: "dev-mac", sessionRef: "session-123" },
    });

    const dedupePath = join(tmpDir, "dedupe.jsonl");
    const dedupe = new DedupeStore(dedupePath);
    const agent = new CallbackAgent({
      config: {
        apiBase: baseUrl,
        participantId: fakeApi.participantId,
        consumerId: "test-consumer",
        pollIntervalMs: 100,
        leaseMs: 30000,
        endpoints: {
          "dev-mac": {
            driver: {
              driver: "command",
              executable: fakeBin.path,
              args: ["exec", "resume", "--json", "{sessionRef}", "{message}"],
            },
          },
        },
      },
      dedupeStore: dedupe,
      logger: silentLogger(),
    });

    const processed = await agent.runOnce();
    expect(processed).toBe(1);

    // Event should be delivered
    const updatedEvent = fakeApi.getEvent(event.id);
    expect(updatedEvent?.state).toBe("delivered");

    // Dedupe store should have the eventId
    expect(dedupe.isDelivered(event.id)).toBe(true);

    // API call counts
    expect(fakeApi.callCounts.list).toBe(1);
    expect(fakeApi.callCounts.claim).toBe(1);
    expect(fakeApi.callCounts.ack).toBe(1);
    expect(fakeApi.callCounts.fail).toBe(0);

    // Fake executable should have been invoked with correct argv
    const argv = fakeBin.getArgv();
    expect(argv).toContain("exec");
    expect(argv).toContain("resume");
    expect(argv).toContain("--json");
    expect(argv).toContain("session-123"); // {sessionRef} resolved
    // {message} resolves to the JSON message
    const messageIdx = argv.indexOf("--json");
    expect(messageIdx).toBeGreaterThan(-1);

    fakeBin.cleanup();
  });

  it("two agents competing: only one gets the lease", async () => {
    const fakeBin = createFakeExecutable();
    const _event = fakeApi.addEvent({
      callbackRef: { endpointRef: "dev-mac" },
    });

    const dedupePath1 = join(tmpDir, "dedupe1.jsonl");
    const dedupePath2 = join(tmpDir, "dedupe2.jsonl");
    const agent1 = new CallbackAgent({
      config: {
        apiBase: baseUrl,
        participantId: fakeApi.participantId,
        consumerId: "consumer-1",
        pollIntervalMs: 100,
        leaseMs: 30000,
        endpoints: {
          "dev-mac": {
            driver: {
              driver: "command",
              executable: fakeBin.path,
              args: ["{message}"],
            },
          },
        },
      },
      dedupeStore: new DedupeStore(dedupePath1),
      logger: silentLogger(),
    });
    const agent2 = new CallbackAgent({
      config: {
        apiBase: baseUrl,
        participantId: fakeApi.participantId,
        consumerId: "consumer-2",
        pollIntervalMs: 100,
        leaseMs: 30000,
        endpoints: {
          "dev-mac": {
            driver: {
              driver: "command",
              executable: fakeBin.path,
              args: ["{message}"],
            },
          },
        },
      },
      dedupeStore: new DedupeStore(dedupePath2),
      logger: silentLogger(),
    });

    // Both try to process the same event
    const [p1, p2] = await Promise.all([agent1.runOnce(), agent2.runOnce()]);

    // Only one should have processed the event
    expect(p1 + p2).toBe(1);

    // Only one ack
    expect(fakeApi.callCounts.ack).toBe(1);

    fakeBin.cleanup();
  });

  it("command succeeds but ack fails → restart re-claims & re-acks to delivered, command runs once", async () => {
    const countingBin = createCountingExecutable("count-exec.mjs", tmpDir);
    const event = fakeApi.addEvent({
      callbackRef: { endpointRef: "dev-mac" },
    });

    const dedupePath = join(tmpDir, "dedupe.jsonl");
    const dedupe = new DedupeStore(dedupePath);

    // First agent: claim + execute + dedupe write, but ack will fail.
    // Short lease so the crashed agent's lease expires before the restart's
    // next poll (real deployments: the lease is long and plenty of wall-clock
    // time passes between the crash and the restart).
    const agent1 = new CallbackAgent({
      config: {
        apiBase: baseUrl,
        participantId: fakeApi.participantId,
        consumerId: "test-consumer",
        pollIntervalMs: 100,
        leaseMs: 200,
        endpoints: {
          "dev-mac": {
            driver: {
              driver: "command",
              executable: process.execPath,
              args: [countingBin],
            },
          },
        },
      },
      dedupeStore: dedupe,
      logger: silentLogger(),
    });

    // Make every ack fail (simulates a network drop / server 5xx between the
    // dedupe write and the ack).
    agent1.client.ackEvent = async () => {
      throw new Error("simulated ack failure");
    };

    const processed = await agent1.runOnce();
    expect(processed).toBe(1);
    expect(dedupe.isDelivered(event.id)).toBe(true);
    // The command actually ran exactly once (assert the trace, not a flag)
    expect(readCount(countingBin)).toBe(1);

    // Restart: a fresh agent resumes the same participant with the same
    // dedupe store. The old leaseToken is gone with the dead process, so the
    // dedupe-hit path must claim a FRESH lease rather than reuse one. Wait for
    // the crashed agent's short lease to expire first, so the event is listed
    // again on this poll (the lease is only listed back once it has lapsed).
    await sleep(400);
    const agent2 = new CallbackAgent({
      config: {
        apiBase: baseUrl,
        participantId: fakeApi.participantId,
        consumerId: "test-consumer",
        pollIntervalMs: 100,
        leaseMs: 200,
        endpoints: {
          "dev-mac": {
            driver: {
              driver: "command",
              executable: process.execPath,
              args: [countingBin],
            },
          },
        },
      },
      dedupeStore: dedupe,
      logger: silentLogger(),
    });

    const processed2 = await agent2.runOnce();
    expect(processed2).toBe(1); // dedupe hit → re-claim + re-ack = processed

    // Final artifact: the event reached delivered on the fake API
    expect(fakeApi.getEvent(event.id)?.state).toBe("delivered");
    // Round 2 produced exactly one extra claim (the re-claim)
    expect(fakeApi.callCounts.claim).toBe(2);
    // Round 2 produced at least one ack
    expect(fakeApi.callCounts.ack).toBeGreaterThanOrEqual(1);
    // The command did NOT run a second time
    expect(readCount(countingBin)).toBe(1);
  });

  it("dedupe hit + claim 409 → skipped, no command/ack/fail, not counted as processed, warn logged", async () => {
    const countingBin = createCountingExecutable("count-exec-409.mjs", tmpDir);
    const event = fakeApi.addEvent({
      callbackRef: { endpointRef: "dev-mac" },
    });

    const dedupePath = join(tmpDir, "dedupe409.jsonl");
    const dedupe = new DedupeStore(dedupePath);
    // The command already ran in an earlier (crashed) process: seed the dedupe
    // store WITHOUT executing the command in this test.
    await dedupe.write(event.id);

    const { warn, logger } = captureLogger();
    const agent = new CallbackAgent({
      config: {
        apiBase: baseUrl,
        participantId: fakeApi.participantId,
        consumerId: "test-consumer",
        pollIntervalMs: 100,
        leaseMs: 30000,
        endpoints: {
          "dev-mac": {
            driver: {
              driver: "command",
              executable: process.execPath,
              args: [countingBin],
            },
          },
        },
      },
      dedupeStore: dedupe,
      logger,
    });

    // Server reports the event as not claimable (409)
    agent.client.claimEvent = async () => {
      throw new Error("claimEvent failed: 409 CONFLICT");
    };

    const processed = await agent.runOnce();

    // Not counted as processed
    expect(processed).toBe(0);
    // No command execution
    expect(readCount(countingBin)).toBe(0);
    // No ack, no fail, and no claim reached the server
    expect(fakeApi.callCounts.ack).toBe(0);
    expect(fakeApi.callCounts.fail).toBe(0);
    expect(fakeApi.callCounts.claim).toBe(0);
    // Event stays claimable pending — will be retried on the next poll
    expect(fakeApi.getEvent(event.id)?.state).toBe("pending");
    // A warn was logged naming the event
    expect(warn.some((m) => m.includes(event.id))).toBe(true);
  });

  it("dedupe hit + claim ok but re-ack exhausts retries → not processed, command not re-run, warn logged, event stays leased", async () => {
    const eventId = crypto.randomUUID();
    const countingBin = createCountingExecutable(
      "count-exec-ackfail.mjs",
      tmpDir,
    );

    const dedupePath = join(tmpDir, "dedupe-ackfail.jsonl");
    const dedupe = new DedupeStore(dedupePath);
    // The command already ran in an earlier (crashed) process: seed the
    // dedupe store WITHOUT executing the command in this test.
    await dedupe.write(eventId);

    const { warn, logger } = captureLogger();
    const agent = new CallbackAgent({
      config: {
        apiBase: baseUrl,
        participantId: fakeApi.participantId,
        consumerId: "test-consumer",
        pollIntervalMs: 100,
        leaseMs: 30000,
        endpoints: {},
      },
      dedupeStore: dedupe,
      logger,
    });

    // The event exists on the fake server; the re-claim below goes through
    // the real claim route (only ack is stubbed to fail).
    fakeApi.addEvent({ id: eventId, callbackRef: { endpointRef: "dev-mac" } });
    const inboxItem: InboxItem = {
      schemaVersion: 1,
      type: "coagenthub.task.completed",
      eventId,
      dispatcherParticipantId: fakeApi.participantId,
      dispatcherSessionId: null,
      callbackRef: { endpointRef: "dev-mac" },
      task: {
        groupId: "group-1",
        taskId: "task-1",
        status: "done",
        specRef: null,
        specHash: null,
        diffSummary: null,
        outputTail: null,
      },
      state: "pending",
      attempts: 0,
    };

    // Every re-ack attempt fails; the re-claim itself succeeds via the
    // (unstubbed) fake API, which hands out a fresh lease.
    agent.client.ackEvent = async () => {
      throw new Error("simulated ack failure");
    };

    // Direct processEvent call — no list / runOnce involved.
    const didProcess = await agent.processEvent(inboxItem);

    // Not counted as processed (re-ack did not confirm delivery)
    expect(didProcess).toBe(false);
    // Command was NOT re-executed (the whole point of the dedupe guard)
    expect(readCount(countingBin)).toBe(0);
    // A warn naming the event was logged
    expect(warn.some((m) => m.includes(eventId))).toBe(true);
    // The event is still leased by the fresh claim — no ack/fail was sent to
    // the server, so it stays claimable (after lease expiry) for the next poll
    const updatedEvent = fakeApi.getEvent(eventId);
    expect(updatedEvent?.state).toBe("leased");
    expect(updatedEvent?.attempts).toBe(0);
    expect(fakeApi.callCounts.ack).toBe(0);
    expect(fakeApi.callCounts.fail).toBe(0);
  });

  it("command non-zero exit → fail called, no local dedupe write", async () => {
    const fakeBin = createFailingExecutable(1);
    const event = fakeApi.addEvent({
      callbackRef: { endpointRef: "dev-mac" },
    });

    const dedupePath = join(tmpDir, "dedupe.jsonl");
    const dedupe = new DedupeStore(dedupePath);
    const agent = new CallbackAgent({
      config: {
        apiBase: baseUrl,
        participantId: fakeApi.participantId,
        consumerId: "test-consumer",
        pollIntervalMs: 100,
        leaseMs: 30000,
        endpoints: {
          "dev-mac": {
            driver: {
              driver: "command",
              executable: fakeBin.path,
              args: ["{message}"],
            },
          },
        },
      },
      dedupeStore: dedupe,
      logger: silentLogger(),
    });

    const processed = await agent.runOnce();
    expect(processed).toBe(1);

    // Event should be pending (retryable), not delivered
    const updatedEvent = fakeApi.getEvent(event.id);
    expect(updatedEvent?.state).toBe("pending");
    expect(updatedEvent?.attempts).toBe(1);

    // Dedupe store should NOT have the eventId
    expect(dedupe.isDelivered(event.id)).toBe(false);

    // Fail should have been called
    expect(fakeApi.callCounts.fail).toBe(1);
    expect(fakeApi.callCounts.ack).toBe(0);

    fakeBin.cleanup();
  });

  it("command timeout → fail called", async () => {
    // Create a fake executable that sleeps longer than the timeout
    const fakeBin = createFakeExecutable("fake-slow.sh");
    // Override the script to sleep
    const fs = await import("node:fs");
    fs.writeFileSync(fakeBin.path, `#!/bin/sh\nsleep 10\n`);
    fs.chmodSync(fakeBin.path, 0o755);

    const event = fakeApi.addEvent({
      callbackRef: { endpointRef: "dev-mac" },
    });

    const dedupePath = join(tmpDir, "dedupe.jsonl");
    const dedupe = new DedupeStore(dedupePath);
    const agent = new CallbackAgent({
      config: {
        apiBase: baseUrl,
        participantId: fakeApi.participantId,
        consumerId: "test-consumer",
        pollIntervalMs: 100,
        leaseMs: 30000,
        endpoints: {
          "dev-mac": {
            driver: {
              driver: "command",
              executable: fakeBin.path,
              args: ["{message}"],
              timeoutMs: 500, // 500ms timeout
            },
          },
        },
      },
      dedupeStore: dedupe,
      logger: silentLogger(),
    });

    const processed = await agent.runOnce();
    expect(processed).toBe(1);

    // Event should be pending (retryable)
    const updatedEvent = fakeApi.getEvent(event.id);
    expect(updatedEvent?.state).toBe("pending");
    expect(updatedEvent?.attempts).toBe(1);

    // Fail should have been called
    expect(fakeApi.callCounts.fail).toBe(1);

    fakeBin.cleanup();
  });

  it("unknown endpoint → fail called", async () => {
    const event = fakeApi.addEvent({
      callbackRef: { endpointRef: "unknown-endpoint" },
    });

    const dedupePath = join(tmpDir, "dedupe.jsonl");
    const dedupe = new DedupeStore(dedupePath);
    const agent = new CallbackAgent({
      config: {
        apiBase: baseUrl,
        participantId: fakeApi.participantId,
        consumerId: "test-consumer",
        pollIntervalMs: 100,
        leaseMs: 30000,
        endpoints: {},
      },
      dedupeStore: dedupe,
      logger: silentLogger(),
    });

    const processed = await agent.runOnce();
    expect(processed).toBe(1);

    // Event should be pending (retryable)
    const updatedEvent = fakeApi.getEvent(event.id);
    expect(updatedEvent?.state).toBe("pending");
    expect(updatedEvent?.attempts).toBe(1);

    // Fail should have been called
    expect(fakeApi.callCounts.fail).toBe(1);
  });

  it("missing endpointRef → fail called", async () => {
    const event = fakeApi.addEvent({
      callbackRef: { sessionRef: "session-123" }, // no endpointRef
    });

    const dedupePath = join(tmpDir, "dedupe.jsonl");
    const dedupe = new DedupeStore(dedupePath);
    const agent = new CallbackAgent({
      config: {
        apiBase: baseUrl,
        participantId: fakeApi.participantId,
        consumerId: "test-consumer",
        pollIntervalMs: 100,
        leaseMs: 30000,
        endpoints: {},
      },
      dedupeStore: dedupe,
      logger: silentLogger(),
    });

    const processed = await agent.runOnce();
    expect(processed).toBe(1);

    // Event should be pending (retryable)
    const updatedEvent = fakeApi.getEvent(event.id);
    expect(updatedEvent?.state).toBe("pending");
    expect(updatedEvent?.attempts).toBe(1);

    // Fail should have been called
    expect(fakeApi.callCounts.fail).toBe(1);
  });
});
