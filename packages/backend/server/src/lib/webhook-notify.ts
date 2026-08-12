import {
  agent as agentTable,
  type GroupMessage,
  groupMember as groupMemberTable,
} from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { visibleMemberIds } from "@server/lib/group-visibility";
import { eq } from "drizzle-orm";

/** Per-target delivery timeout: short and best-effort only. */
const WEBHOOK_TIMEOUT_MS = 3_000;

/**
 * Full group message row as delivered in webhook / WS / REST payloads — the
 * same shape `GET /:id/messages` returns (incl. `depth`), so a receiver can
 * append it to its view without a follow-up ?after= pull.
 */
export interface GroupMessageFull {
  id: string;
  groupId: string;
  senderId: string;
  parentId: string | null;
  audience: GroupMessage["audience"];
  audienceRef: string | null;
  body: string;
  contentType: string;
  fileRef: GroupMessage["fileRef"];
  createdAt: Date;
  updatedAt: Date | null;
  depth: number;
}

/**
 * Serialized message row — the shape webhook / WS events and the REST GET
 * response deliver over the wire (times as ISO strings).
 */
export interface GroupMessagePayload {
  id: string;
  groupId: string;
  senderId: string;
  parentId: string | null;
  audience: GroupMessage["audience"];
  audienceRef: string | null;
  body: string;
  contentType: string;
  fileRef: GroupMessage["fileRef"];
  createdAt: string;
  updatedAt: string | null;
  depth: number;
}

export interface GroupMessageWebhookEvent {
  type: "group_message";
  groupId: string;
  message: GroupMessagePayload;
}

/**
 * Best-effort fan-out of a new group message to every visible member's
 * webhook URL (agent-groups spec: "Webhook notify"). Never rejects: all
 * failures — the member query, per-target delivery, timeouts — are caught
 * and logged, so the message write path and the HTTP response are never
 * affected. Members without a webhook URL are skipped; the ?after=
 * incremental pull remains the guaranteed fallback, so a lost notification
 * costs nothing.
 */
export async function dispatchGroupMessageWebhooks(
  db: DataBase,
  message: GroupMessageFull,
  groupId: string,
): Promise<void> {
  try {
    const members = await db
      .select({
        agentId: groupMemberTable.agentId,
        roles: groupMemberTable.roles,
        webhookUrl: agentTable.webhookUrl,
      })
      .from(groupMemberTable)
      .innerJoin(agentTable, eq(agentTable.id, groupMemberTable.agentId))
      .where(eq(groupMemberTable.groupId, groupId));

    // Recipients = everyone the message is visible to (same rule the GET
    // endpoint filters by), minus the sender itself — no self-notification.
    const visible = visibleMemberIds(message, members);
    visible.delete(message.senderId);
    const targets = members.filter(
      (m) => m.webhookUrl && visible.has(m.agentId),
    );
    if (targets.length === 0) return;

    const event: GroupMessageWebhookEvent = {
      type: "group_message",
      groupId: message.groupId,
      message: {
        id: message.id,
        groupId: message.groupId,
        senderId: message.senderId,
        parentId: message.parentId,
        audience: message.audience,
        audienceRef: message.audienceRef,
        body: message.body,
        contentType: message.contentType,
        fileRef: message.fileRef,
        createdAt: message.createdAt.toISOString(),
        updatedAt: message.updatedAt ? message.updatedAt.toISOString() : null,
        depth: message.depth,
      },
    };

    const results = await Promise.allSettled(
      targets.map((t) => postWebhook(t.webhookUrl!, event)),
    );
    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        console.warn(
          `[webhook] delivery to ${targets[i].agentId} failed:`,
          result.reason,
        );
      }
    }
  } catch (err) {
    console.warn("[webhook] dispatch failed:", err);
  }
}

async function postWebhook(
  url: string,
  event: GroupMessageWebhookEvent,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`webhook responded ${res.status}`);
  }
}
