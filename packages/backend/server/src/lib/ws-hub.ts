import type { Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import {
  agent as agentTable,
  groupMember as groupMemberTable,
} from "@laizhixingxingdeli/database/schema";
import { hashAgentToken } from "@server/lib/agent-token";
import db from "@server/lib/database";
import { visibleMemberIds } from "@server/lib/group-visibility";
import { resolveLocalUser } from "@server/lib/local-agent";
import type { GroupMessageFull } from "@server/lib/group-message";
import { eq } from "drizzle-orm";
import { WebSocket, WebSocketServer } from "ws";

/**
 * WebSocket realtime push hub (agent-groups-live T13). Exposes `/api/ws` on
 * the existing http.Server via the `upgrade` event; a connection authenticates
 * with `?token=<agentToken>` (the same SHA-256 agents-table lookup the
 * agentAuth middleware uses — a WS handshake cannot carry an Authorization
 * header). Connections are grouped by agentId (one agent may hold several),
 * and new group messages are fan-out to exactly the members the
 * group-visibility rule marks as seeing the message — including the sender,
 * so the web UI can echo without a pull.
 *
 * A heartbeat sweeps zombies: every interval the hub pings; a connection that
 * did not answer the previous ping is terminated.
 *
 * Broadcasts never reject: the member query and per-socket failures are
 * caught and logged, mirroring webhook-notify, so the message write path and
 * the HTTP response are never affected.
 */
export interface WsHubOptions {
  /** Ping interval; a connection missing the previous pong is terminated. */
  heartbeatIntervalMs?: number;
}

/** A socket bound to its authenticated agent after the upgrade handshake. */
type AuthedWebSocket = WebSocket & { agentId?: string; isAlive?: boolean };

const WS_PATH = "/api/ws";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export class WsHub {
  private readonly conns = new Map<string, Set<AuthedWebSocket>>();
  private readonly attached = new Set<HttpServer>();
  private wss: WebSocketServer | null = null;
  private readonly heartbeatIntervalMs: number;
  // Started lazily on first attach, stopped by closeAll — the hub can be torn
  // down and re-attached without leaking timers.
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: WsHubOptions = {}) {
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  /**
   * Attach the hub to the http.Server returned by @hono/node-server's serve().
   * Idempotent per server. Only `/api/ws` upgrades are handled; anything else
   * is destroyed (nothing else in this process upgrades).
   */
  handleUpgrade(server: HttpServer): void {
    if (this.attached.has(server)) return;
    this.attached.add(server);
    this.startHeartbeat();

    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== WS_PATH) {
        socket.destroy();
        return;
      }
      const token = url.searchParams.get("token");
      // LAN trust model: no token → the default Local User (matches
      // middleware/agent-auth.ts); a present-but-invalid token → 401.
      const identity = token
        ? resolveAgentId(token)
        : resolveLocalUser(db).catch(() => null);
      identity
        .then((agentId) => {
          if (!agentId) {
            rejectUpgrade(socket, 401);
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) =>
            this.register(ws, agentId),
          );
        })
        .catch((err) => {
          console.warn("[ws] auth lookup failed:", err);
          rejectUpgrade(socket, 401);
        });
    });
  }

  /** Fan-out a freshly stored message (ticket 13): the sender is included so
   * the web UI gets the echo without a pull. */
  async broadcastGroupMessage(message: GroupMessageFull): Promise<void> {
    await this.fanOut(message, (m) =>
      JSON.stringify({
        type: "group_message",
        groupId: m.groupId,
        message: serializeGroupMessage(m),
      }),
    );
  }

  /** Fan-out a body edit (ticket 22): the event carries the updated full row. */
  async broadcastGroupMessageUpdated(message: GroupMessageFull): Promise<void> {
    await this.fanOut(message, (m) =>
      JSON.stringify({
        type: "group_message_updated",
        groupId: m.groupId,
        message: serializeGroupMessage(m),
      }),
    );
  }

  /** Fan-out a soft delete (ticket 22): the event carries only the id — the
   * receiver marks the placeholder locally. Visibility uses the message's own
   * audience, so the exact same members that saw the original get the delete. */
  async broadcastGroupMessageDeleted(
    message: Pick<
      GroupMessageFull,
      "id" | "groupId" | "senderId" | "audience" | "audienceRef"
    >,
  ): Promise<void> {
    await this.fanOut(message, (m) =>
      JSON.stringify({
        type: "group_message_deleted",
        groupId: m.groupId,
        messageId: m.id,
      }),
    );
  }

  /**
   * Shared fan-out: query the group's members, keep the visibility-filtered
   * set, and deliver `buildEvent(message)` to every connected socket in it.
   * Fire-and-forget: never rejects — the member query and per-socket failures
   * are caught and logged, so the write path and the HTTP response are never
   * affected.
   */
  private async fanOut<
    T extends Pick<
      GroupMessageFull,
      "id" | "groupId" | "senderId" | "audience" | "audienceRef"
    >,
  >(message: T, buildEvent: (m: T) => string): Promise<void> {
    // No listeners at all — the common headless case — skip the member query
    // entirely; it could never deliver anything.
    if (this.conns.size === 0) return;
    try {
      const members = await db
        .select({
          agentId: groupMemberTable.agentId,
          roles: groupMemberTable.roles,
        })
        .from(groupMemberTable)
        .where(eq(groupMemberTable.groupId, message.groupId));
      const visible = visibleMemberIds(message, members);
      const localUserId = await resolveLocalUser(db);
      // LAN trust model: the default Local User is a human observer — it
      // receives every message even without a membership row. When it IS a
      // member it is already in `visible`, so only deliver the extra copy
      // then — otherwise the same event goes to the same socket twice.
      if (visible.size === 0 && !this.conns.has(localUserId)) return;

      const event = buildEvent(message);
      const deliver = (agentId: string) => {
        const sockets = this.conns.get(agentId);
        if (!sockets) return;
        for (const ws of sockets) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(event, (err) => {
              if (err) {
                console.warn(
                  `[ws] send to agent ${agentId} failed:`,
                  err.message,
                );
              }
            });
          }
        }
      };

      for (const agentId of visible) {
        deliver(agentId);
      }
      if (!visible.has(localUserId)) {
        deliver(localUserId);
      }
    } catch (err) {
      console.warn("[ws] fanOut failed:", err);
    }
  }

  /** Number of live connections, optionally scoped to one agent (tests/ops). */
  connectionCount(agentId?: string): number {
    if (agentId) return this.conns.get(agentId)?.size ?? 0;
    let total = 0;
    for (const sockets of this.conns.values()) total += sockets.size;
    return total;
  }

  /** Terminate every connection and clear the registry (tests / shutdown). */
  closeAll(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const sockets of this.conns.values()) {
      for (const ws of sockets) {
        ws.removeAllListeners("close");
        ws.removeAllListeners("error");
        ws.terminate();
      }
    }
    this.conns.clear();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    // unref'd: the heartbeat must never keep the process (or a test runner)
    // alive by itself.
    this.heartbeatTimer = setInterval(
      () => this.sweepDeadConnections(),
      this.heartbeatIntervalMs,
    );
    this.heartbeatTimer.unref?.();
  }

  private register(ws: AuthedWebSocket, agentId: string): void {
    ws.agentId = agentId;
    ws.isAlive = true;
    let sockets = this.conns.get(agentId);
    if (!sockets) {
      sockets = new Set();
      this.conns.set(agentId, sockets);
    }
    sockets.add(ws);
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("close", () => this.unregister(ws));
    ws.on("error", (err) => {
      console.warn(`[ws] connection error for agent ${agentId}:`, err.message);
    });
  }

  private unregister(ws: AuthedWebSocket): void {
    const agentId = ws.agentId;
    if (!agentId) return;
    const sockets = this.conns.get(agentId);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size === 0) this.conns.delete(agentId);
  }

  private sweepDeadConnections(): void {
    for (const sockets of this.conns.values()) {
      for (const ws of sockets) {
        if (ws.readyState !== WebSocket.OPEN) {
          // Half-open / closing: the close event cleans the registry; a
          // terminate here is the backstop.
          ws.terminate();
          continue;
        }
        if (!ws.isAlive) {
          // Missed the previous ping → zombie (e.g. a LAN drop that no TCP
          // FIN carried). Terminate; close → unregister.
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }
  }
}

async function resolveAgentId(token: string): Promise<string | null> {
  const matches = await db
    .select({ id: agentTable.id })
    .from(agentTable)
    .where(eq(agentTable.tokenHash, hashAgentToken(token)))
    .limit(1);
  return matches[0]?.id ?? null;
}

/** Complete the handshake with a non-101 response and close the socket. */
function rejectUpgrade(socket: Duplex, status: number): void {
  const reason = status === 401 ? "Unauthorized" : "Bad Request";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
}

/** Dates serialize to ISO strings so every consumer sees the same shape. */
function serializeGroupMessage(message: GroupMessageFull) {
  return {
    id: message.id,
    groupId: message.groupId,
    senderId: message.senderId,
    parentId: message.parentId,
    audience: message.audience,
    audienceRef: message.audienceRef,
    body: message.body,
    contentType: message.contentType,
    fileRef: message.fileRef,
    createdAt: toIso(message.createdAt),
    updatedAt: message.updatedAt ? toIso(message.updatedAt) : null,
    depth: message.depth,
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Process-wide singleton — the route layer broadcasts through this. */
export const wsHub = new WsHub();
