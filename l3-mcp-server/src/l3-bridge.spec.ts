import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoAgentHubClient } from "./coagenthub-client.js";
import {
  formatDeliveryMessage,
  pollOnce,
  type Delivery,
} from "./l3-bridge.js";
import {
  activateSessionBinding,
  bridgeHealthPath,
  getBridgeHealth,
  recordPollFailure,
  writeBinding,
  writeLegacyBinding,
} from "./l3-state.js";

const dirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "coagenthub-codex-"));
  dirs.push(dir);
  return dir;
}

function delivery(overrides: Partial<Delivery> = {}): Delivery {
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
    ...overrides,
  };
}

function bind(
  dataDir: string,
  sessionId: string,
  recipient = sessionId,
  inboxScope: "recipient" | "all" = "recipient",
) {
  const binding = {
    sessionId,
    cwd: "C:/repo",
    inboxScope,
    ...(recipient ? { recipient } : {}),
    updatedAt: new Date().toISOString(),
  };
  writeBinding(dataDir, binding);
  return binding;
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
    bind(dataDir, "thread-1");
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
    expect(request).toHaveBeenNthCalledWith(1, "/inbox?recipient=thread-1");
    expect(queueMessage).toHaveBeenCalledTimes(1);
    expect(queueMessage.mock.calls[0][0]).toBe("thread-1");
    expect(queueMessage.mock.calls[0][1]).toContain("M-1");
    expect(request).toHaveBeenNthCalledWith(2, "/deliveries/D-1/ack", {
      method: "POST",
      body: "{}",
    });
  });

  it("never acknowledges a delivery when codex queue fails", async () => {
    const dataDir = tempDataDir();
    bind(dataDir, "thread-1");
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
    bind(dataDir, "thread-1");
    const request = vi
      .fn()
      .mockResolvedValueOnce({ pending: [delivery()] })
      .mockRejectedValueOnce(new Error("ack failed"))
      .mockResolvedValueOnce({ pending: [delivery()] })
      .mockResolvedValueOnce({ status: "acknowledged" });
    const queueMessage = vi.fn().mockResolvedValue(undefined);
    const client = { request } as unknown as CoAgentHubClient;

    await expect(pollOnce({ dataDir, client, queueMessage })).rejects.toThrow(
      "ack failed",
    );
    await expect(pollOnce({ dataDir, client, queueMessage })).resolves.toBe(1);

    expect(queueMessage).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("reads the full inbox only when the binding explicitly uses all scope", async () => {
    const dataDir = tempDataDir();
    bind(dataDir, "thread-1", "", "all");
    const request = vi.fn().mockResolvedValueOnce({ pending: [] });
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

  // Two chats are registered. Each delivery must reach the session registered
  // for its recipient, and nothing may be queued twice.
  it("routes each delivery to the session registered for its recipient", async () => {
    const dataDir = tempDataDir();
    bind(dataDir, "session-A");
    bind(dataDir, "session-B");
    // An explicit activation makes B the active default; routing must still be
    // per recipient rather than "the newest chat gets everything".
    activateSessionBinding(dataDir, {
      sessionId: "session-B",
      cwd: "C:/repo",
      inboxScope: "recipient",
      recipient: "session-B",
      updatedAt: new Date().toISOString(),
    });

    const request = vi.fn(async (path: string) => {
      if (path === "/inbox?recipient=session-A") {
        return { pending: [delivery({ id: "D-A", recipient: "session-A" })] };
      }
      if (path === "/inbox?recipient=session-B") {
        return { pending: [delivery({ id: "D-B", recipient: "session-B" })] };
      }
      return { status: "acknowledged" };
    });
    const queueMessage = vi.fn().mockResolvedValue(undefined);

    const handled = await pollOnce({
      dataDir,
      client: { request } as unknown as CoAgentHubClient,
      queueMessage,
    });

    expect(handled).toBe(2);
    expect(queueMessage).toHaveBeenCalledTimes(2);
    expect(queueMessage.mock.calls).toEqual([
      ["session-A", expect.stringContaining("D-A")],
      ["session-B", expect.stringContaining("D-B")],
    ]);
    expect(request).toHaveBeenCalledWith("/deliveries/D-A/ack", {
      method: "POST",
      body: "{}",
    });
    expect(request).toHaveBeenCalledWith("/deliveries/D-B/ack", {
      method: "POST",
      body: "{}",
    });
  });

  // A fixed recipient is a hard filter: another session's binding, even the
  // active default, must not make the bridge consume somebody else's inbox.
  it("honours a fixed recipient and ignores the legacy default of another session", async () => {
    const dataDir = tempDataDir();
    bind(dataDir, "session-B");
    // Old deployment style file pointing at a different session.
    writeLegacyBinding(dataDir, {
      sessionId: "session-A",
      cwd: "C:/repo",
      inboxScope: "recipient",
      recipient: "session-A",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });

    const request = vi.fn(async (path: string) => {
      if (path === "/inbox?recipient=session-B") {
        return { pending: [delivery({ id: "D-B", recipient: "session-B" })] };
      }
      return { status: "acknowledged" };
    });
    const queueMessage = vi.fn().mockResolvedValue(undefined);

    const handled = await pollOnce({
      dataDir,
      client: { request } as unknown as CoAgentHubClient,
      recipient: "session-B",
      queueMessage,
    });

    expect(handled).toBe(1);
    expect(request).toHaveBeenNthCalledWith(1, "/inbox?recipient=session-B");
    expect(queueMessage.mock.calls).toEqual([
      ["session-B", expect.stringContaining("D-B")],
    ]);

    // A fixed recipient with no registered session consumes nothing at all.
    const unregistered = vi.fn();
    await expect(
      pollOnce({
        dataDir,
        client: { request: unregistered } as unknown as CoAgentHubClient,
        recipient: "session-C",
        queueMessage,
      }),
    ).resolves.toBe(0);
    expect(unregistered).not.toHaveBeenCalled();
  });

  // All-scope reads the whole inbox once, but still hands each delivery to the
  // session registered for it; only an unclaimed one goes to the explicit
  // all-scope reviewer, and nothing is queued twice.
  it("routes an all-scope inbox per recipient without duplicates", async () => {
    const dataDir = tempDataDir();
    bind(dataDir, "session-A");
    bind(dataDir, "session-B", "", "all");

    const request = vi.fn(async (path: string) => {
      if (path === "/inbox") {
        return {
          pending: [
            delivery({ id: "D-A", recipient: "session-A" }),
            delivery({ id: "D-B", recipient: "session-B" }),
            delivery({ id: "D-X", recipient: "someone-else" }),
          ],
        };
      }
      return { status: "acknowledged" };
    });
    const queueMessage = vi.fn().mockResolvedValue(undefined);

    await expect(
      pollOnce({
        dataDir,
        client: { request } as unknown as CoAgentHubClient,
        queueMessage,
      }),
    ).resolves.toBe(3);

    // One inbox request, one queue call per delivery, no duplicate fan-out.
    expect(request.mock.calls.filter(([path]) => path === "/inbox")).toHaveLength(1);
    expect(queueMessage.mock.calls).toEqual([
      ["session-A", expect.stringContaining("D-A")],
      ["session-B", expect.stringContaining("D-B")],
      ["session-B", expect.stringContaining("D-X")],
    ]);
  });

  it("keeps working for a legacy single-file deployment", async () => {
    const dataDir = tempDataDir();
    writeLegacyBinding(dataDir, {
      sessionId: "legacy-thread",
      cwd: "C:/repo",
      inboxScope: "recipient",
      recipient: "legacy-thread",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        pending: [delivery({ id: "D-L", recipient: "legacy-thread" })],
      })
      .mockResolvedValueOnce({ status: "acknowledged" });
    const queueMessage = vi.fn().mockResolvedValue(undefined);

    await expect(
      pollOnce({
        dataDir,
        client: { request } as unknown as CoAgentHubClient,
        queueMessage,
      }),
    ).resolves.toBe(1);

    expect(request).toHaveBeenNthCalledWith(
      1,
      "/inbox?recipient=legacy-thread",
    );
    expect(queueMessage.mock.calls[0][0]).toBe("legacy-thread");
  });

  it("records counts and status in the health file without faking a success after a failure", async () => {
    const dataDir = tempDataDir();
    bind(dataDir, "thread-1");
    // A failure that carries credentials and a response body must not leak into
    // the health file or into the query result.
    const canary = "secret=CANARY-9f3a2b https://user:password@host/ notice-body";
    const request = vi
      .fn()
      .mockResolvedValueOnce({ pending: [delivery()] })
      .mockResolvedValueOnce({ status: "acknowledged" })
      .mockRejectedValueOnce(new Error(canary));
    const client = { request } as unknown as CoAgentHubClient;
    const queueMessage = vi.fn().mockResolvedValue(undefined);

    await pollOnce({ dataDir, client, queueMessage });
    const ok = getBridgeHealth(dataDir);
    expect(ok).toMatchObject({
      status: "ok",
      polls: 1,
      deliveredTotal: 1,
      consecutiveFailures: 0,
    });
    expect(ok.lastPollSucceededAt).toBeTruthy();
    expect(ok.lastDeliveryAt).toBeTruthy();

    await expect(pollOnce({ dataDir, client, queueMessage })).rejects.toThrow(
      canary,
    );
    const degraded = getBridgeHealth(dataDir);
    expect(degraded).toMatchObject({
      status: "degraded",
      polls: 2,
      deliveredTotal: 1,
      consecutiveFailures: 1,
    });
    // The old success must not be re-stamped by a failed poll.
    expect(degraded.lastPollSucceededAt).toBe(ok.lastPollSucceededAt);
    expect(degraded.lastDeliveryAt).toBe(ok.lastDeliveryAt);
    // A fixed code plus an allow-listed error name, never the message text.
    expect(degraded.lastError?.code).toBe("poll_failed");
    expect(degraded.lastError?.name).toBe("Error");
    expect(degraded.lastError).not.toHaveProperty("message");

    const stored = readFileSync(bridgeHealthPath(dataDir), "utf8");
    for (const text of [stored, JSON.stringify(degraded)]) {
      expect(text).not.toContain("CANARY-9f3a2b");
      expect(text).not.toContain("secret=");
      expect(text).not.toContain("user:password");
      expect(text).not.toContain("password@host");
      expect(text).not.toContain("notice-body");
      expect(text).not.toContain(canary);
      // No delivery body is stored either.
      expect(text).not.toContain("Mission submitted");
    }
  });

  // An old health file stored a free-form message; it must be normalised to the
  // fixed code instead of being echoed back or kept on disk.
  it("normalises a legacy health error message instead of re-emitting it", () => {
    const dataDir = tempDataDir();
    const canary = "secret=CANARY-9f3a2b https://user:password@host/ notice-body";
    writeFileSync(
      bridgeHealthPath(dataDir),
      JSON.stringify({
        status: "degraded",
        updatedAt: "2026-10-01T00:00:00.000Z",
        polls: 4,
        deliveredTotal: 2,
        consecutiveFailures: 1,
        lastPollSucceededAt: "2026-09-30T23:00:00.000Z",
        lastError: { at: "2026-10-01T00:00:00.000Z", message: canary },
      }),
      "utf8",
    );

    const health = getBridgeHealth(dataDir);
    expect(health).toMatchObject({
      status: "degraded",
      polls: 4,
      deliveredTotal: 2,
      consecutiveFailures: 1,
    });
    expect(health.lastError).toEqual({
      at: "2026-10-01T00:00:00.000Z",
      code: "poll_failed",
    });
    expect(JSON.stringify(health)).not.toContain("CANARY-9f3a2b");

    // A subsequent failure rewrites the file without the legacy text.
    recordPollFailure(dataDir, new Error(canary), {
      at: "2026-10-01T01:00:00.000Z",
    });
    const stored = readFileSync(bridgeHealthPath(dataDir), "utf8");
    expect(stored).not.toContain("CANARY-9f3a2b");
    expect(stored).not.toContain("user:password");
    expect(stored).not.toContain("notice-body");
    expect(getBridgeHealth(dataDir).lastError).toEqual({
      at: "2026-10-01T01:00:00.000Z",
      code: "poll_failed",
      name: "Error",
    });
  });
});
