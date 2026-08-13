/**
 * 消息域服务(架构债清理):消息的列表查询 / 编辑 / 软删 / 写入编排的纯 db
 * 逻辑,从 routes/group/registry.ts 与 lib/group-message.ts 平移至此。
 *
 * 全部函数都是纯 db 函数(参数显式,不依赖 Hono 上下文);zod 校验、权限
 * 门槛与响应编排仍留在路由层。返回形状与 GET /:id/messages 完全一致
 * (含 depth),行为与原路由实现逐字等价。
 */

import {
  type FileRefInput,
  type GroupMessageAudience,
  groupMessageClosure as groupMessageClosureTable,
  groupMessage as groupMessageTable,
} from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import type { DataBase } from "@server/lib/database";
import { messageVisibleToMemberSql } from "@server/lib/group-visibility";
import type { GroupMessageFull } from "@server/lib/webhook-notify";
import { and, asc, eq, gt, ilike, ne, sql } from "drizzle-orm";

/** Soft-delete placeholder (ticket 22): the row is kept (closure/reply tree stays intact), the body becomes this string. */
export const DELETED_MESSAGE_PLACEHOLDER = "[消息已删除]";

/** Max messages returned by one GET /:id/messages page; continue with ?after=. */
const MESSAGE_PAGE_LIMIT = 200;

/** Max thread depth (ticket 15): a reply mounting past depth 64 is rejected. */
export const MAX_REPLY_DEPTH = 64;

/** 服务端缺省有效期:now + 7d (ticket 17),与路由原逻辑一致。 */
const DEFAULT_FILE_EXPIRES_IN_MS = 7 * 24 * 60 * 60 * 1000;

/** 与 GET /:id/messages 返回形状一致的全量消息行(含 depth 子查询)。 */
const messageFullColumns = {
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
};

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
      .select(messageFullColumns)
      .from(groupMessageTable)
      .where(eq(groupMessageTable.id, created.id));
    return fullRow;
  });
}

export interface ListVisibleMessagesOptions {
  /** Incremental pull cursor (uuidv7 ids are time-ordered): id > after. */
  after?: string;
  /** 正文关键词搜索;空串视为无搜索,LIKE 通配符(%、_)按字面转义。 */
  q?: string;
  /** 分页大小,缺省 LIMIT 200(与原路由 MESSAGE_PAGE_LIMIT 一致)。 */
  limit?: number;
}

/**
 * 列表查询:可见性 SQL(与 webhook/WS 扇出同一套规则,见 group-visibility.ts)
 * + ?after= 增量游标 + q 关键词 + LIMIT,整体下推到 SQL,翻页发生在
 * *可见* 流上而不是全量拉到 JS 再过滤。
 */
export async function listVisibleMessages(
  db: DataBase,
  groupId: string,
  requesterId: string,
  roles: string[],
  options: ListVisibleMessagesOptions = {},
): Promise<GroupMessageFull[]> {
  const { after, q, limit = MESSAGE_PAGE_LIMIT } = options;

  const conditions = [
    eq(groupMessageTable.groupId, groupId),
    messageVisibleToMemberSql(requesterId, roles),
  ];
  if (after) {
    // Incremental pull: uuidv7 ids are time-ordered, so id > after yields
    // everything the caller has not seen yet. The stream is ordered by the
    // same key the cursor filters on, so cursor and order cannot diverge.
    conditions.push(gt(groupMessageTable.id, after));
  }
  if (q) {
    // Keyword search: body ILIKE %q% on top of the visibility filter. LIKE
    // wildcards (%, _) are backslash-escaped so `100%` matches literally;
    // the escape is applied to the pattern only, never to user input at the
    // SQL level (drizzle binds the pattern as a parameter). Empty string is
    // treated as "no search" — behavior identical to the pre-search route.
    const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    conditions.push(ilike(groupMessageTable.body, `%${escaped}%`));
  }

  return (
    db
      .select(messageFullColumns)
      .from(groupMessageTable)
      .where(and(...conditions))
      // uuidv7 ids embed the server receive time, so id order IS receive
      // order — ordering by id keeps the stream consistent with ?after=.
      // Page the visible stream; clients continue with ?after=<lastId>.
      .orderBy(asc(groupMessageTable.id))
      .limit(limit)
  );
}

/**
 * 编辑正文(PATCH /:id/messages/:messageId):仅 UPDATE body + updatedAt 并
 * 返回全量行(含 depth)。发送者/状态/占位串等校验由路由完成后再调用。
 */
export async function updateMessageBody(
  db: DataBase,
  groupId: string,
  messageId: string,
  body: string,
): Promise<GroupMessageFull> {
  const now = new Date();
  await db
    .update(groupMessageTable)
    .set({ body, updatedAt: now })
    .where(
      and(
        eq(groupMessageTable.id, messageId),
        eq(groupMessageTable.groupId, groupId),
      ),
    );
  const [updated] = await db
    .select(messageFullColumns)
    .from(groupMessageTable)
    .where(
      and(
        eq(groupMessageTable.id, messageId),
        eq(groupMessageTable.groupId, groupId),
      ),
    );
  return updated;
}

/**
 * 软删除(DELETE /:id/messages/:messageId):body 置为占位符,行与闭包树
 * 保持完整(不触碰 closure 行)。幂等 — 已软删除的消息不会重复写,
 * 返回 false,路由据此跳过重复广播。
 */
export async function softDeleteMessage(
  db: DataBase,
  groupId: string,
  messageId: string,
): Promise<boolean> {
  const now = new Date();
  const [updated] = await db
    .update(groupMessageTable)
    .set({ body: DELETED_MESSAGE_PLACEHOLDER, updatedAt: now })
    .where(
      and(
        eq(groupMessageTable.id, messageId),
        eq(groupMessageTable.groupId, groupId),
        ne(groupMessageTable.body, DELETED_MESSAGE_PLACEHOLDER),
      ),
    )
    .returning();
  return updated !== undefined;
}
