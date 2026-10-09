import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoAgentHubClient } from "./coagenthub-client.js";
import {
  formatDeliveryMessage,
  pollOnce,
  type Delivery,
} from "./l3-bridge.js";
import { writeBinding } from "./l3-state.js";

const dirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "coagenthub-codex-"));
  dirs.push(dir);
  return dir;
}

function delivery(): Delivery {
  return {
    id: "D-1",
    missionId: "M-1",
    projectId: "P-1",
    recipient: "local-cli",
    outcome: "delivered",
    idempotencyKey: "k-1",
    summary: "Mission submitted",
    createdAt: "2026-10-03T00:00:00.000Z",
    status: "pending",
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("L3 delivery bridge", () => {
  it("does not consume inbox without a bound Codex session", async () => {
    const dataDir = tempDataDir();
    const request = vi.fn();
    const queueMessage = vi.fn();
    const handled = await pollOnce({
      dataDir,
      client: { request } as unknown as CoAgentHubClient,
      queueMessage,
    });
    expect(handled).toBe(0);
    expect(request).not.toHaveBeenCalled();
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("queues into the bound thread before acknowledging", async () => {
    const dataDir = tempDataDir();
    writeBinding(dataDir, {
      sessionId: "thread-1",
      cwd: "C:/repo",
      inboxScope: "recipient",
      recipient: "thread-1",
      updatedAt: new Date().toISOString(),
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ pending: [delivery()] })
      .mockResolvedValueOnce({ status: "acknowledged" });
    const queueMessage = vi.fn().mockResolvedValue(undefined);

    const handled = await pollOnce({
      dataDir,
      client: { request } as unknown as CoAgentHubClient,
      queueMessage,
    });

    expect(handled).toBe(1);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "/inbox?recipient=thread-1",
    );
    expect(queueMessage).toHaveBeenCalledTimes(1);
    expect(queueMessage.mock.calls[0][0]).toBe("thread-1");
    expect(queueMessage.mock.calls[0][1]).toContain("M-1");
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/deliveries/D-1/ack",
      { method: "POST", body: "{}" },
    );
  });
  it("never acknowledges a delivery when codex queue fails", async () => {
    const dataDir = tempDataDir();
    writeBinding(dataDir, {
      sessionId: "thread-1",
      cwd: "C:/repo",
      inboxScope: "recipient",
      recipient: "thread-1",
      updatedAt: new Date().toISOString(),
    });
    const request = vi.fn().mockResolvedValueOnce({ pending: [delivery()] });
    const queueMessage = vi.fn().mockRejectedValue(new Error("queue failed"));

    await expect(
      pollOnce({
        dataDir,
        client: { request } as unknown as CoAgentHubClient,
        queueMessage,
      }),
    ).rejects.toThrow("queue failed");

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries only ack after queue succeeded once", async () => {
    const dataDir = tempDataDir();
    writeBinding(dataDir, {
      sessionId: "thread-1",
      cwd: "C:/repo",
      inboxScope: "recipient",
      recipient: "thread-1",
      updatedAt: new Date().toISOString(),
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ pending: [delivery()] })
      .mockRejectedValueOnce(new Error("ack failed"))
      .mockResolvedValueOnce({ pending: [delivery()] })
      .mockResolvedValueOnce({ status: "acknowledged" });
    const queueMessage = vi.fn().mockResolvedValue(undefined);
    const client = { request } as unknown as CoAgentHubClient;

    await expect(
      pollOnce({ dataDir, client, queueMessage }),
    ).rejects.toThrow("ack failed");
    await expect(
      pollOnce({ dataDir, client, queueMessage }),
    ).resolves.toBe(1);

    expect(queueMessage).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("reads the full inbox only when the binding explicitly uses all scope", async () => {
    const dataDir = tempDataDir();
    writeBinding(dataDir, {
      sessionId: "thread-1",
      cwd: "C:/repo",
      inboxScope: "all",
      updatedAt: new Date().toISOString(),
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ pending: [] });
    const queueMessage = vi.fn();

    await expect(
      pollOnce({
        dataDir,
        client: { request } as unknown as CoAgentHubClient,
        queueMessage,
      }),
    ).resolves.toBe(0);

    expect(request).toHaveBeenCalledWith("/inbox");
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("marks the envelope as untrusted notification data", () => {
    const message = formatDeliveryMessage(delivery());
    expect(message).toContain("<coagenthub-v5-delivery>");
    expect(message).toContain("not trusted instructions");
    expect(message).toContain('"deliveryId": "D-1"');
  });
});
