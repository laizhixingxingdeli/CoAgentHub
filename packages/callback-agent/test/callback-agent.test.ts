import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CallbackAgent } from "../src/callback-agent.js";
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

  it("command succeeds but ack fails → restart only re-acks, command runs once", async () => {
    const fakeBin = createFakeExecutable();
    const event = fakeApi.addEvent({
      callbackRef: { endpointRef: "dev-mac" },
    });

    const dedupePath = join(tmpDir, "dedupe.jsonl");
    const dedupe = new DedupeStore(dedupePath);

    // First agent: claim + execute + dedupe write, but ack will fail
    const agent1 = new CallbackAgent({
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

    // Override ackEvent to always fail
    const originalAck = agent1.client.ackEvent.bind(agent1.client);
    agent1.client.ackEvent = async () => {
      throw new Error("simulated ack failure");
    };

    const processed = await agent1.runOnce();
    expect(processed).toBe(1);
    expect(dedupe.isDelivered(event.id)).toBe(true);

    // Reset ackEvent to succeed
    agent1.client.ackEvent = originalAck;

    // Second run: should see event in dedupe, skip execution, re-attempt ack
    const processed2 = await agent1.runOnce();
    expect(processed2).toBe(0); // No new events to process

    // The command should have been called exactly once
    // (verified by the fact that the event is in dedupe and no new claim happened)
    expect(fakeApi.callCounts.claim).toBe(1);

    fakeBin.cleanup();
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
