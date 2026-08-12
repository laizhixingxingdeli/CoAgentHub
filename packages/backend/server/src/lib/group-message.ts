/**
 * 群消息写入(阶段2-票1 抽取):POST /groups/:id/messages 与 server 内嵌
 * 执行器的状态回传共用同一套「消息 + closure 闭包」写入逻辑,避免两处漂移。
 *
 * 只做写入本身(group 状态/成员/audience 等校验仍在路由层),返回与 GET
 * /messages 一致的全量行(含 depth),调用方自行决定 webhook/WS 扇出。
 */

import {
  type FileRefInput,
  type GroupMessageAudience,
  groupMessageClosure as groupMessageClosureTable,
  groupMessage as groupMessageTable,
} from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import type { DataBase } from "@server/lib/database";
import type { GroupMessageFull } from "@server/lib/webhook-notify";
import { eq, sql } from "drizzle-orm";

/** Max thread depth (ticket 15): a reply mounting past depth 64 is rejected. */
export const MAX_REPLY_DEPTH = 64;

/** 服务端缺省有效期:now + 7d (ticket 17),与路由原逻辑一致。 */
const DEFAULT_FILE_EXPIRES_IN_MS = 7 * 24 * 60 * 60 * 1000;

export interface InsertGroupMessageInput {
  groupId: string;
  senderId: string;
  parentId?: string | null;
  audience: GroupMessageAudience;
  /** role 值时=角色名;agent 值时=agentId;broadcast 时传 null。 */
  audienceRef: string | null;
  body: string;
  contentType: string;
  fileRef?: FileRefInput | null;
}

/**
 * 插入一条群消息 + closure 行(同一事务,含自引用 depth 0 与父链 depth+1),
 * 并返回带 depth 的全量行。parentId 缺失/跨群 → 400;挂载深度超限 → 400
 * (事务内检查,拒绝会回滚消息插入,不留半成品)。
 */
export async function insertGroupMessage(
  db: DataBase,
  input: InsertGroupMessageInput,
): Promise<GroupMessageFull> {
  const {
    groupId,
    senderId,
    parentId,
    audience,
    audienceRef,
    body,
    contentType,
  } = input;

  return db.transaction(async (tx) => {
    // A reply's parent must exist and live in the same group.
    let parent: typeof groupMessageTable.$inferSelect | undefined;
    if (parentId) {
      parent = await tx.query.groupMessage.findFirst({
        where: (t, { and, eq: eqFn }) =>
          and(eqFn(t.id, parentId!), eqFn(t.groupId, groupId)),
      });
      if (!parent) {
        throw new BizError(BizCodeEnum.InvalidRequest);
      }
    }

    // fileRef 服务端补默认过期时间(now + 7d),落库的 fileRef 永远带有效期。
    const fileRef = input.fileRef
      ? {
          ...input.fileRef,
          expiresAt:
            input.fileRef.expiresAt ??
            new Date(Date.now() + DEFAULT_FILE_EXPIRES_IN_MS).toISOString(),
        }
      : null;

    const [created] = await tx
      .insert(groupMessageTable)
      .values({
        groupId,
        senderId,
        parentId: parentId ?? null,
        audience,
        audienceRef:
          audience === "role" || audience === "agent" ? audienceRef : null,
        body,
        contentType,
        fileRef,
      })
      .returning();

    const ancestorRows = parent
      ? await tx
          .select({
            ancestorId: groupMessageClosureTable.ancestorId,
            depth: groupMessageClosureTable.depth,
          })
          .from(groupMessageClosureTable)
          .where(eq(groupMessageClosureTable.descendantId, parent.id))
      : [];
    // Max reply depth (ticket 15): check inside the transaction so a rejection
    // rolls back the message insert too — no partial writes.
    if (parent) {
      const parentDepth = ancestorRows.reduce(
        (max, row) => Math.max(max, row.depth),
        0,
      );
      if (parentDepth + 1 > MAX_REPLY_DEPTH) {
        throw new BizError(
          BizCodeEnum.InvalidRequest,
          "超过最大回复深度,请开新根",
        );
      }
    }
    await tx.insert(groupMessageClosureTable).values([
      {
        groupId,
        ancestorId: created.id,
        descendantId: created.id,
        depth: 0,
      },
      ...ancestorRows.map((a) => ({
        groupId,
        ancestorId: a.ancestorId,
        descendantId: created.id,
        depth: a.depth + 1,
      })),
    ]);

    const [fullRow] = await tx
      .select({
        id: groupMessageTable.id,
        groupId: groupMessageTable.groupId,
        senderId: groupMessageTable.senderId,
        parentId: groupMessageTable.parentId,
        audience: groupMessageTable.audience,
        audienceRef: groupMessageTable.audienceRef,
        body: groupMessageTable.body,
        contentType: groupMessageTable.contentType,
        fileRef: groupMessageTable.fileRef,
        createdAt: groupMessageTable.createdAt,
        updatedAt: groupMessageTable.updatedAt,
        depth: sql<number>`(
          select max(${groupMessageClosureTable.depth})
          from ${groupMessageClosureTable}
          where ${groupMessageClosureTable.descendantId} = ${groupMessageTable.id}
        )`,
      })
      .from(groupMessageTable)
      .where(eq(groupMessageTable.id, created.id));
    return fullRow;
  });
}
