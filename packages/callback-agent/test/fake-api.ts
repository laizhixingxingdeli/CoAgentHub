import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

interface FakeEvent {
  id: string;
  taskId: string;
  groupId: string;
  callbackRef: {
    platform?: string;
    endpointRef?: string;
    sessionRef?: string;
  } | null;
  state: "pending" | "leased" | "delivered" | "dead";
  attempts: number;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  task: {
    status: string;
    specRef: string | null;
    specHash: string | null;
    diffSummary: unknown;
    outputTail: unknown;
  };
}

/**
 * In-memory fake of the CoAgentHub task-completion-events API.
 * Used in callback-agent integration tests.
 */
export class FakeCompletionApi {
  private events: FakeEvent[] = [];
  private server: Server | null = null;
  private port = 0;
  public participantId = randomUUID();
  public callCounts = { list: 0, claim: 0, ack: 0, fail: 0 };

  /** Add a pending event to the fake inbox */
  addEvent(Partial: Partial<FakeEvent> & { id?: string }): FakeEvent {
    const event: FakeEvent = {
      id: Partial.id ?? randomUUID(),
      taskId: Partial.taskId ?? randomUUID(),
      groupId: Partial.groupId ?? randomUUID(),
      callbackRef: Partial.callbackRef ?? null,
      state: "pending",
      attempts: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      task: Partial.task ?? {
        status: "done",
        specRef: null,
        specHash: null,
        diffSummary: null,
        outputTail: null,
      },
    };
    this.events.push(event);
    return event;
  }

  /** Start the fake HTTP server */
  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      readBody(req).then((rawBody) => {
        this.handleRequest(req, res, rawBody);
      });
    });

    return new Promise((resolve) => {
      this.server?.listen(0, "127.0.0.1", () => {
        const addr = this.server?.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        resolve(`http://127.0.0.1:${this.port}`);
      });
    });
  }

  private handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    rawBody: string,
  ): void {
    const url = new URL(req.url ?? "/", `http://localhost`);
    const path = url.pathname;

    // Route: GET /api/participants/:id/task-completion-events
    if (req.method === "GET" && path.includes("task-completion-events")) {
      this.callCounts.list++;
      const now = Date.now();
      const claimable = this.events.filter(
        (e) =>
          (e.state === "pending" &&
            (e.leaseExpiresAt === null || e.leaseExpiresAt <= now)) ||
          (e.state === "leased" &&
            e.leaseExpiresAt !== null &&
            e.leaseExpiresAt <= now),
      );
      const events = claimable.map((e) => this.toEnvelope(e));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ events }));
      return;
    }

    // Route: POST /api/participants/:id/task-completion-events/:eventId/claim
    const claimMatch = path.match(/\/task-completion-events\/([^/]+)\/claim$/);
    if (req.method === "POST" && claimMatch) {
      this.callCounts.claim++;
      const eventId = claimMatch[1];
      const body = JSON.parse(rawBody || "{}");
      const event = this.events.find((e) => e.id === eventId);
      const now = Date.now();

      if (
        !event ||
        (event.state === "leased" &&
          event.leaseExpiresAt !== null &&
          event.leaseExpiresAt > now)
      ) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: "CONFLICT", message: "not claimable" }));
        return;
      }

      const leaseToken = randomUUID();
      event.state = "leased";
      event.leaseToken = leaseToken;
      event.leaseExpiresAt = now + (body.leaseMs ?? 30000);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ leaseToken, event: this.toEnvelope(event) }));
      return;
    }

    // Route: POST /api/participants/:id/task-completion-events/:eventId/ack
    const ackMatch = path.match(/\/task-completion-events\/([^/]+)\/ack$/);
    if (req.method === "POST" && ackMatch) {
      this.callCounts.ack++;
      const eventId = ackMatch[1];
      const body = JSON.parse(rawBody || "{}");
      const event = this.events.find((e) => e.id === eventId);

      if (!event || event.leaseToken !== body.leaseToken) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ code: "CONFLICT", message: "leaseToken mismatch" }),
        );
        return;
      }

      event.state = "delivered";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, eventId }));
      return;
    }

    // Route: POST /api/participants/:id/task-completion-events/:eventId/fail
    const failMatch = path.match(/\/task-completion-events\/([^/]+)\/fail$/);
    if (req.method === "POST" && failMatch) {
      this.callCounts.fail++;
      const eventId = failMatch[1];
      const body = JSON.parse(rawBody || "{}");
      const event = this.events.find((e) => e.id === eventId);

      if (!event || event.leaseToken !== body.leaseToken) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ code: "CONFLICT", message: "leaseToken mismatch" }),
        );
        return;
      }

      event.attempts++;
      event.state = event.attempts >= 10 ? "dead" : "pending";
      event.leaseToken = null;
      event.leaseExpiresAt = null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, eventId }));
      return;
    }

    res.writeHead(404);
    res.end();
  }

  /** Stop the fake server */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server?.close(() => resolve());
    });
  }

  /** Get event by id (for assertions) */
  getEvent(id: string): FakeEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  /** All events (for assertions) */
  allEvents(): FakeEvent[] {
    return [...this.events];
  }

  private toEnvelope(e: FakeEvent) {
    return {
      schemaVersion: 1,
      type: "coagenthub.task.completed",
      eventId: e.id,
      dispatcherParticipantId: this.participantId,
      dispatcherSessionId: null,
      callbackRef: e.callbackRef,
      task: {
        groupId: e.groupId,
        taskId: e.taskId,
        status: e.task.status,
        specRef: e.task.specRef,
        specHash: e.task.specHash,
        diffSummary: e.task.diffSummary,
        outputTail: e.task.outputTail,
      },
      state: e.state,
      attempts: e.attempts,
    };
  }
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf-8")));
    req.on("end", () => resolve(body));
  });
}
