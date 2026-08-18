import type { Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import {
  groupMember as groupMemberTable,
  participant as participantTable,
  type TaskStatus,
} from "@laizhixingxingdeli/database/schema";
import db from "@server/lib/database";
import {
  type ParticipantType,
  visibleMemberIds,
} from "@server/lib/group-visibility";
import { resolveLocalUser } from "@server/lib/local-participant";
import type { GroupMessageFull } from "@server/lib/services/message-service";
import { eq } from "drizzle-orm";
import { WebSocket, WebSocketServer } from "ws";

/**
 * WebSocket realtime push hub (participant-groups-live T13). Exposes `/api/ws` on
 * the existing http.Server via the `upgrade` event; a connection declares its
 * identity with `?participantId=<uuid>` (the same identity resolution the
 * participantIdentity middleware uses — a WS handshake cannot carry headers).
 * Missing/unknown id → the default Local User; no token validation (LAN
 * full-trust model). Connections are grouped by participantId (one participant
 * may hold several), and new group messages are fan-out to exactly the members
 * the group-visibility rule marks as seeing the message — including the sender,
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

/** A socket bound to its declared participant after the upgrade handshake. */
type IdentifiedWebSocket = WebSocket & {
  participantId?: string;
  isAlive?: boolean;
};

/**
 * task_status_changed 事件可选 task 字段的载荷形状(与任务面板行同形状,
 * 日期已序列化为 ISO 字符串;updatedAt 可空 — 新行未更新前为 null;
 * diffSummary 为 jsonb 对象或 null)。
 */
export interface TaskStatusChangedTask {
  id: string;
  status: string;
  executorParticipantId: string;
  executorKey: string | null;
  brief: string | null;
  diffSummary: Record<string, unknown> | null;
  // 规范驱动下发:事件透传 specRef/specHash(任务详情同源);老任务为 null。
  specRef: string | null;
  specHash: string | null;
  // 任务下发者信息(Part A):事件透传给插件(定向通知用);老任务为 null。
  dispatcherParticipantId: string | null;
  dispatcherSessionId: string | null;
  createdAt: string;
  updatedAt: string | null;
  retryCount: number;
}

const WS_PATH = "/api/ws";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export class WsHub {
  private readonly conns = new Map<string, Set<IdentifiedWebSocket>>();
  /** 群成员短缓存:fanOut 高频调用(tail 输出/状态推送)时避免每条消息都查库。
   *  TTL 到期自动失效;成员增删改通过 invalidateGroupMembers 主动失效。 */
  private readonly memberCache = new Map<
    string,
    { expiresAt: number; members: { participantId: string; roles: string[] }[] }
  >();
  private readonly MEMBER_CACHE_TTL_MS = 30_000;
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
      const claimedId = url.searchParams.get("participantId");
      // LAN full-trust model: a claimed identity is used when it exists;
      // missing/unknown id → the default Local User (matches
      // middleware/participant-identity.ts). No token validation, no 401.
      const resolveIdentity = claimedId
        ? resolveClaimedParticipant(claimedId).then(
            (id) => id ?? resolveLocalUser(db),
          )
        : resolveLocalUser(db);
      resolveIdentity
        .then((participantId) => {
          if (!participantId) {
            rejectUpgrade(socket, 401);
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) =>
            this.register(ws, participantId),
          );
        })
        .catch((err) => {
          console.warn("[ws] identity lookup failed:", err);
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
   * Fan-out a live task output chunk (feature: 实时进度): the running executor's
   * stdout/stderr chunk is pushed to the group so the task panel can stream it
   * without polling. Treated like a broadcast message for visibility — every
   * member that sees the group gets the chunk.
   */
  async broadcastTaskOutput(
    groupId: string,
    taskId: string,
    chunk: string,
  ): Promise<void> {
    await this.fanOut(
      {
        id: taskId,
        groupId,
        senderId: "",
        audience: "broadcast" as const,
        audienceRef: null,
      },
      () =>
        JSON.stringify({
          type: "task_output",
          groupId,
          taskId,
          chunk,
        }),
    );
  }

  /**
   * Fan-out a no-progress alert (feature: 无进展提醒): a running task has been
   * silent past stallAlertMinutes — the task panel marks that row with a
   * warning style (yellow, not a failure). Broadcast visibility like task_output.
   */
  async broadcastTaskStallAlert(
    groupId: string,
    taskId: string,
  ): Promise<void> {
    await this.fanOut(
      {
        id: taskId,
        groupId,
        senderId: "",
        audience: "broadcast" as const,
        audienceRef: null,
      },
      () =>
        JSON.stringify({
          type: "task_stall_alert",
          groupId,
          taskId,
        }),
    );
  }

  /**
   * Fan-out a task status transition (feature: 任务状态实时推送): queued /
   * running / done / failed / cancelled 变化时推给该任务所属群的订阅者,让
   * 插件/前端免轮询感知任务生命周期。与 task_output 同界(broadcast 可见性),
   * 只推给该群的成员。task 字段可选:传入时为完整任务详情快照(与任务面板行
   * 同形状,日期已序列化为 ISO 字符串),不传则仅带 groupId/taskId/status。
   */
  async broadcastTaskStatusChanged(
    groupId: string,
    taskId: string,
    status: TaskStatus,
    task?: TaskStatusChangedTask,
  ): Promise<void> {
    await this.fanOut(
      {
        id: taskId,
        groupId,
        senderId: "",
        audience: "broadcast" as const,
        audienceRef: null,
      },
      () =>
        JSON.stringify({
          type: "task_status_changed",
          groupId,
          taskId,
          status,
          ...(task ? { task } : {}),
        }),
    );
  }
  /** 取群成员(短缓存):fanOut 高频调用时避免每条消息都查 group_members。 */
  private async getGroupMembers(
    groupId: string,
  ): Promise<{ participantId: string; roles: string[] }[]> {
    const cached = this.memberCache.get(groupId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.members;
    }
    const members = await db
      .select({
        participantId: groupMemberTable.participantId,
        roles: groupMemberTable.roles,
      })
      .from(groupMemberTable)
      .where(eq(groupMemberTable.groupId, groupId));
    this.memberCache.set(groupId, {
      expiresAt: Date.now() + this.MEMBER_CACHE_TTL_MS,
      members,
    });
    return members;
  }

  /** 成员增删改后主动失效该群成员缓存(路由层调用),避免 TTL 内推送错人。 */
  invalidateGroupMembers(groupId: string): void {
    this.memberCache.delete(groupId);
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
      const members = await this.getGroupMembers(message.groupId);
      const localUserId = await resolveLocalUser(db);
      // LAN trust model: the default Local User is a human observer — type
      // =human bypasses the audience rule, so it receives every message even
      // without a membership row. Mark it in the participant-type map so the
      // visibility rule (single source, group-visibility.ts) includes it;
      // when it IS a member it is already in `visible`, so only deliver the
      // extra copy then — otherwise the same event goes to the same socket twice.
      const participantTypeById = new Map<string, ParticipantType>([
        [localUserId, "human"],
      ]);
      const visible = visibleMemberIds(message, members, participantTypeById);
      if (visible.size === 0 && !this.conns.has(localUserId)) return;

      const event = buildEvent(message);
      const deliver = (participantId: string) => {
        const sockets = this.conns.get(participantId);
        if (!sockets) return;
        for (const ws of sockets) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(event, (err) => {
              if (err) {
                console.warn(
                  `[ws] send to participant ${participantId} failed:`,
                  err.message,
                );
              }
            });
          }
        }
      };

      for (const participantId of visible) {
        deliver(participantId);
      }
      if (!visible.has(localUserId)) {
        deliver(localUserId);
      }
    } catch (err) {
      console.warn("[ws] fanOut failed:", err);
    }
  }

  /** Number of live connections, optionally scoped to one participant (tests/ops). */
  connectionCount(participantId?: string): number {
    if (participantId) return this.conns.get(participantId)?.size ?? 0;
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

  private register(ws: IdentifiedWebSocket, participantId: string): void {
    ws.participantId = participantId;
    ws.isAlive = true;
    let sockets = this.conns.get(participantId);
    if (!sockets) {
      sockets = new Set();
      this.conns.set(participantId, sockets);
    }
    sockets.add(ws);
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("close", () => this.unregister(ws));
    ws.on("error", (err) => {
      console.warn(
        `[ws] connection error for participant ${participantId}:`,
        err.message,
      );
    });
  }

  private unregister(ws: IdentifiedWebSocket): void {
    const participantId = ws.participantId;
    if (!participantId) return;
    const sockets = this.conns.get(participantId);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size === 0) this.conns.delete(participantId);
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

async function resolveClaimedParticipant(
  claimedId: string,
): Promise<string | null> {
  const matches = await db
    .select({ id: participantTable.id })
    .from(participantTable)
    .where(eq(participantTable.id, claimedId))
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
