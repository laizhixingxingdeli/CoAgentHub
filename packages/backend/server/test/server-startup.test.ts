import { EventEmitter } from "node:events";
import type { Server as HttpServer } from "node:http";
import { describe, expect, it } from "vitest";
import { startServer } from "@server/lib/server-startup";

class FakeServer extends EventEmitter {
  listenedPort: number | undefined;

  listen(port: number) {
    this.listenedPort = port;
    return this;
  }
}

function fakeServer() {
  return new FakeServer() as unknown as HttpServer;
}

describe("server startup ordering", () => {
  it("does not run database cleanup when the port is occupied", async () => {
    const port = 31_001;
    const server = fakeServer();
    let recovered = 0;

    const startup = startServer({
      fetch: () => new Response("ok"),
      port,
      serverFactory: () => server,
      recoverInterruptedTasks: async () => {
        recovered += 1;
      },
      ensureExecutorParticipants: async () => undefined,
    });
    queueMicrotask(() =>
      server.emit("error", {
        code: "EADDRINUSE",
        message: "address already in use",
      }),
    );

    await expect(startup).rejects.toThrow(`port ${port} is already in use`);

    expect(recovered).toBe(0);
  });

  it("runs cleanup after successfully acquiring the port", async () => {
    const port = 31_002;
    const server = fakeServer();
    const calls: string[] = [];
    const startup = startServer({
      fetch: () => new Response("ok"),
      port,
      serverFactory: () => server,
      recoverInterruptedTasks: async () => {
        calls.push("recover");
      },
      ensureExecutorParticipants: async () => {
        calls.push("ensure");
      },
    });
    queueMicrotask(() => server.emit("listening"));
    await startup;

    expect(calls).toEqual(["recover", "ensure"]);
    expect((server as unknown as FakeServer).listenedPort).toBe(port);
  });

  it("boots without ensureExecutorParticipants (built-ins are no longer auto-registered)", async () => {
    const port = 31_003;
    const server = fakeServer();
    let recovered = 0;

    const startup = startServer({
      fetch: () => new Response("ok"),
      port,
      serverFactory: () => server,
      recoverInterruptedTasks: async () => {
        recovered += 1;
      },
      // ensureExecutorParticipants intentionally omitted — matches
      // production wiring in index.ts.
    });
    queueMicrotask(() => server.emit("listening"));
    await startup;

    expect(recovered).toBe(1);
    expect((server as unknown as FakeServer).listenedPort).toBe(port);
  });
});
