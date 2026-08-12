import { zValidator } from "@hono/zod-validator";
import {
  agent as agentTable,
  FileRefInput,
  GROUP_ROLES,
  GroupMessageAudience,
  groupMember as groupMemberTable,
  groupMessageClosure as groupMessageClosureTable,
  groupMessage as groupMessageTable,
  groups as groupsTable,
  TASK_STATUSES,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import { capabilityHint } from "@server/lib/agent-capabilities";
import { maybeHandleControlCommand } from "@server/lib/control";
import type { DataBase } from "@server/lib/database";
import { maybeDispatchExecutorTask } from "@server/lib/executor-task";
import { insertGroupMessage } from "@server/lib/group-message";
import { messageVisibleToMemberSql } from "@server/lib/group-visibility";
import { resolveLocalUser } from "@server/lib/local-agent";
import { dispatchGroupMessageWebhooks } from "@server/lib/webhook-notify";
import { wsHub } from "@server/lib/ws-hub";
import { and, asc, count, desc, eq, gt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";

const app = new Hono<{ Variables: { db: DataBase; agentId: string } }>();

/** Soft-delete placeholder (ticket 22): the row is kept (closure/reply tree stays intact), the body becomes this string. */
const DELETED_MESSAGE_PLACEHOLDER = "[消息已删除]";

/** Max messages returned by one GET /:id/messages page; continue with ?after=. */
const MESSAGE_PAGE_LIMIT = 200;

app
  .post(
    "/",
    describeRoute({
      description: "Create a group; the creator auto-joins as coordinator",
      responses: {
        200: {
          description: "Group created",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "json",
      z.object({
        title: z.string().min(1),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const agentId = c.get("agentId");
      const { title } = c.req.valid("json");

      // db.transaction resolves to the callback's return value.
      const group = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(groupsTable)
          .values({ title, createdBy: agentId })
          .returning();
        // The creator is automatically a member with the coordinator role —
        // inserted in the same transaction so a group can never exist
        // without its coordinator membership.
        await tx.insert(groupMemberTable).values({
          groupId: created.id,
          agentId,
          roles: ["coordinator"],
        });
        return created;
      });

      return c.json(group);
    },
  )
  .get(
    "/",
    describeRoute({
      description:
        "List all groups with member counts (soft-deleted groups are always excluded)",
      responses: {
        200: {
          description: "Successful response",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "query",
      z.object({
        status: z.enum(["active", "archived"]).optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { status } = c.req.valid("query");

      const groups = await db
        .select({
          id: groupsTable.id,
          title: groupsTable.title,
          status: groupsTable.status,
          createdBy: groupsTable.createdBy,
          createdAt: groupsTable.createdAt,
          updatedAt: groupsTable.updatedAt,
          memberCount: count(groupMemberTable.agentId),
        })
        .from(groupsTable)
        .leftJoin(
          groupMemberTable,
          eq(groupMemberTable.groupId, groupsTable.id),
        )
        .where(
          // Soft-deleted groups are hidden from every list: an explicit
          // ?status= filter can only name active/archived, and the unfiltered
          // list excludes deleted rows outright (rows are kept, not purged).
          status
            ? eq(groupsTable.status, status)
            : sql`${groupsTable.status} <> 'deleted'`,
        )
        .groupBy(groupsTable.id)
        .orderBy(desc(groupsTable.createdAt));

      return c.json(groups);
    },
  )
  .get(
    "/:id",
    describeRoute({
      description: "Get a single group's details including its status",
      responses: {
        200: {
          description: "Group details",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }

      return c.json(group);
    },
  )
  .post(
    "/:id/members",
    describeRoute({
      description: "Add a member with per-group roles (idempotent upsert)",
      responses: {
        200: {
          description: "Member added or roles updated",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    zValidator(
      "json",
      z.object({
        agentId: z.string().uuid(),
        // Roles must come from the preset catalog; empty defaults to observer.
        roles: z.array(z.enum(GROUP_ROLES)).default(["observer"]),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const { agentId, roles } = c.req.valid("json");

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      const agent = await db.query.agent.findFirst({
        where: (t, { eq }) => eq(t.id, agentId),
      });
      if (!agent) {
        throw new BizError(BizCodeEnum.AgentNotFound);
      }

      const dedupedRoles =
        roles.length > 0 ? [...new Set(roles)] : ["observer"];
      const [member] = await db
        .insert(groupMemberTable)
        .values({ groupId: id, agentId, roles: dedupedRoles })
        .onConflictDoUpdate({
          target: [groupMemberTable.groupId, groupMemberTable.agentId],
          set: { roles: dedupedRoles },
        })
        .returning();

      // 轻量能力提示 (ticket 17): 已知能力与角色匹配提示,绝不硬性拒绝 —
      // 无提示时为 null,响应形状始终带 capabilityHint 字段。
      const hint = capabilityHint(agent.capabilities, dedupedRoles);

      return c.json({ ...member, capabilityHint: hint });
    },
  )
  .get(
    "/:id/members",
    describeRoute({
      description: "List group members with agent info and in-group roles",
      responses: {
        200: {
          description: "Successful response",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }

      const members = await db
        .select({
          agentId: agentTable.id,
          name: agentTable.name,
          type: agentTable.type,
          device: agentTable.device,
          roles: groupMemberTable.roles,
          joinedAt: groupMemberTable.joinedAt,
        })
        .from(groupMemberTable)
        .innerJoin(agentTable, eq(agentTable.id, groupMemberTable.agentId))
        .where(eq(groupMemberTable.groupId, id))
        .orderBy(asc(groupMemberTable.joinedAt));

      return c.json(members);
    },
  )
  .delete(
    "/:id/members/:agentId",
    describeRoute({
      description:
        "Remove a member from the group (ticket 20). The creator (群主) can never be removed; a missing group or missing membership is a 404.",
      responses: {
        200: {
          description: "Member removed",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "param",
      z.object({ id: z.string().uuid(), agentId: z.string().uuid() }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id, agentId } = c.req.valid("param");

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      // 群主不可被移除:创建者是这个群组的 owner,成员移除不能破坏它。
      if (agentId === group.createdBy) {
        throw new BizError(BizCodeEnum.InvalidRequest, "不能移除群主");
      }
      const member = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.agentId, agentId)),
      });
      if (!member) {
        throw new BizError(BizCodeEnum.MemberNotFound);
      }

      await db
        .delete(groupMemberTable)
        .where(
          and(
            eq(groupMemberTable.groupId, id),
            eq(groupMemberTable.agentId, agentId),
          ),
        );
      return c.json({ success: true });
    },
  )
  .patch(
    "/:id/members/:agentId",
    describeRoute({
      description:
        "Update a member's roles in the group (ticket 20); same dedupe rule as POST /members",
      responses: {
        200: {
          description: "Member roles updated",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "param",
      z.object({ id: z.string().uuid(), agentId: z.string().uuid() }),
    ),
    zValidator(
      "json",
      z.object({
        roles: z.array(z.enum(GROUP_ROLES)).min(1),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id, agentId } = c.req.valid("param");
      const { roles } = c.req.valid("json");

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      const member = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.agentId, agentId)),
      });
      if (!member) {
        throw new BizError(BizCodeEnum.MemberNotFound);
      }

      // 与 POST /members 相同的去重规则:角色集去重后写入,min(1) 已保证非空。
      const dedupedRoles = [...new Set(roles)];
      const [updated] = await db
        .update(groupMemberTable)
        .set({ roles: dedupedRoles })
        .where(
          and(
            eq(groupMemberTable.groupId, id),
            eq(groupMemberTable.agentId, agentId),
          ),
        )
        .returning();
      return c.json(updated);
    },
  )
  .post(
    "/:id/archive",
    describeRoute({
      description: "Archive a group (active -> archived)",
      responses: {
        200: {
          description: "Group archived",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");

      const [group] = await db
        .update(groupsTable)
        .set({ status: "archived" })
        .where(and(eq(groupsTable.id, id), eq(groupsTable.status, "active")))
        .returning();
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }

      return c.json(group);
    },
  )
  .post(
    "/:id/unarchive",
    describeRoute({
      description: "Restore an archived group (archived -> active)",
      responses: {
        200: {
          description: "Group restored",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");

      // Symmetric to archive: only archived groups can be restored; anything
      // else (missing, active, or soft-deleted) yields the same 404 semantics.
      const [group] = await db
        .update(groupsTable)
        .set({ status: "active" })
        .where(and(eq(groupsTable.id, id), eq(groupsTable.status, "archived")))
        .returning();
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }

      return c.json(group);
    },
  )
  .delete(
    "/:id",
    describeRoute({
      description:
        "Soft-delete a group (active|archived -> deleted). Rows are kept — history, memberships and closure rows survive; the group is hidden from listings.",
      responses: {
        200: {
          description: "Group soft-deleted",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");

      // Idempotent-safe guard mirrors archive/unarchive: deleting an already
      // deleted group (or one that never existed) is the same 404.
      const [group] = await db
        .update(groupsTable)
        .set({ status: "deleted" })
        .where(
          and(eq(groupsTable.id, id), sql`${groupsTable.status} <> 'deleted'`),
        )
        .returning();
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }

      return c.json(group);
    },
  )
  .post(
    "/:id/messages",
    describeRoute({
      description:
        "Post a message to a group; sender must be a member. Messages carry a target audience (broadcast | role | agent) and an optional parentId for the thread tree",
      responses: {
        200: {
          description: "Message created with tree depth",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    zValidator(
      "json",
      z
        .object({
          // body 可空:纯文件信令消息允许 body 为空但携带 fileRef。
          body: z.string().optional(),
          parentId: z.string().uuid().optional(),
          audience: GroupMessageAudience.optional(),
          audienceRef: z.string().optional(),
          // 内容类型 (ticket 17): 仅存储不校验 —— 不白名单、不解析;仅拒绝
          // 空串以免绕过 text/plain 默认值。
          contentType: z.string().min(1).optional(),
          // fileRef.expiresAt 可选由客户端传入;服务端缺省补 now + 7d (ticket 17)。
          fileRef: FileRefInput.optional(),
        })
        .refine((v) => (v.body?.trim()?.length ?? 0) > 0 || !!v.fileRef, {
          message: "body or fileRef must be provided",
        }),
    ),
    async (c) => {
      const db = c.get("db");
      const senderId = c.get("agentId");
      const { id } = c.req.valid("param");
      const { body, parentId, audience, audienceRef, contentType, fileRef } =
        c.req.valid("json");

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      // Archive = read-only: an archived (or soft-deleted) group rejects new
      // messages with 400; reading (GET messages / GET members / GET :id)
      // stays open so history remains browsable.
      if (group.status !== "active") {
        throw new BizError(BizCodeEnum.InvalidRequest);
      }
      // The sender must be a group member (any role) to post.
      const membership = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.agentId, senderId)),
      });
      if (!membership) {
        throw new BizError(BizCodeEnum.Forbidden);
      }

      const aud = audience ?? "broadcast";
      if (aud === "role") {
        // audienceRef is the target role name; the preset catalog is the
        // source of truth for legal roles.
        if (
          !audienceRef ||
          !(GROUP_ROLES as readonly string[]).includes(audienceRef)
        ) {
          throw new BizError(BizCodeEnum.InvalidRequest);
        }
      } else if (aud === "agent") {
        // audienceRef must name a member of THIS group.
        if (!audienceRef) {
          throw new BizError(BizCodeEnum.InvalidRequest);
        }
        const target = await db.query.groupMember.findFirst({
          where: (t, { and, eq }) =>
            and(eq(t.groupId, id), eq(t.agentId, audienceRef)),
        });
        if (!target) {
          throw new BizError(BizCodeEnum.InvalidRequest);
        }
      } else if (audienceRef) {
        // broadcast has no reference; a stray one is a client bug.
        throw new BizError(BizCodeEnum.InvalidRequest);
      }

      // Message + closure rows are written atomically (shared helper — the
      // executor runner's status replies reuse the exact same write path so
      // the two cannot drift): self row depth 0, one row per ancestor with
      // depth+1, depth check inside the transaction. A failure rolls back the
      // insert instead of leaving a committed message the client believes
      // failed.
      const full = await insertGroupMessage(db, {
        groupId: id,
        senderId,
        parentId: parentId ?? null,
        audience: aud,
        audienceRef:
          aud === "role" || aud === "agent" ? (audienceRef ?? null) : null,
        body: body ?? "",
        contentType: contentType ?? "text/plain",
        // 服务端必填 (ticket 17): 客户端未传 expiresAt 时默认 now + 7d;
        // 历史 fileRef 元信息随消息永久可见,过期只影响取文件。
        fileRef: fileRef ?? null,
      });

      // Best-effort webhook fan-out, fire-and-forget: never awaited — a slow
      // or dead webhook target must not delay the write path or the response.
      // dispatchGroupMessageWebhooks never rejects (failures are logged), and
      // the ?after= incremental pull remains the guaranteed fallback.
      void dispatchGroupMessageWebhooks(db, full, id);
      // Realtime push (ticket 13): same fire-and-forget semantics — the WS hub
      // catches its own failures, so neither fan-out can block the response.
      void wsHub.broadcastGroupMessage(full);

      // 阶段2-票1:定向到执行器 agent 的消息 → server 直接建 task + spawn
      // (fire-and-forget,与 webhook 扇出同语义;命中与否/幂等/双跑防重都在
      // executor-task 内处理,失败只记日志,绝不阻塞消息响应)。
      if (aud === "agent" && audienceRef) {
        void maybeDispatchExecutorTask(db, {
          groupId: id,
          messageId: full.id,
          senderRoles: membership.roles,
          audienceRef,
          body: body ?? "",
        });
      }
      // 阶段2-票2:控制指令(「停止/stop」「回滚 [taskId]」)识别放 server;
      // fire-and-forget,命中与否/权限/防回环在 control.ts 内处理。定向到
      // 执行器 agent 的消息是任务,控制入口内部会跳过,不重复动作。
      void maybeHandleControlCommand(db, {
        groupId: id,
        senderId,
        senderRoles: membership.roles,
        audience: aud,
        audienceRef: aud === "agent" ? (audienceRef ?? null) : null,
        body: body ?? "",
      });

      return c.json(full);
    },
  )
  .patch(
    "/:id/messages/:messageId",
    describeRoute({
      description:
        "Edit a message body (ticket 22): sender-only, body 1..4000 chars; parentId/audience/depth are immutable. Returns the updated full row",
      responses: {
        200: {
          description: "Message updated",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "param",
      z.object({ id: z.string().uuid(), messageId: z.string().uuid() }),
    ),
    zValidator(
      "json",
      z.object({
        // 编辑只允许改正文;parentId/audience/depth 保持创建时的值。
        body: z
          .string()
          .min(1)
          .max(4000)
          // 删除占位串是软删除标记(与 DELETE 共用),不允许被当作正文写入,
          // 否则一条真实消息会永久显示为「已删除」且无法再编辑。
          .refine((s) => s !== DELETED_MESSAGE_PLACEHOLDER, {
            message: "该正文为删除占位,不可用作消息内容",
          }),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const agentId = c.get("agentId");
      const { id, messageId } = c.req.valid("param");
      const { body } = c.req.valid("json");

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      // 归档/软删群组只读(与 POST 同款守卫):历史可读,但不可再修改。
      if (group.status !== "active") {
        throw new BizError(BizCodeEnum.InvalidRequest);
      }
      // 发送者必须是当前群成员(与 POST 同款守卫):被移出后不能再编辑旧消息。
      const membership = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.agentId, agentId)),
      });
      if (!membership) {
        throw new BizError(BizCodeEnum.Forbidden);
      }
      const [message] = await db
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
        .where(
          and(
            eq(groupMessageTable.id, messageId),
            eq(groupMessageTable.groupId, id),
          ),
        );
      if (!message) {
        throw new BizError(BizCodeEnum.MessageNotFound);
      }
      // 仅发送者本人可编辑自己的消息。
      if (message.senderId !== agentId) {
        throw new BizError(BizCodeEnum.Forbidden);
      }
      // 已软删除的消息不可再编辑:占位 body 是删除标记,改回正文等于复活,
      // 与「删除后不可恢复」的产品契约相悖。
      if (message.body === DELETED_MESSAGE_PLACEHOLDER) {
        throw new BizError(BizCodeEnum.InvalidRequest);
      }

      const now = new Date();
      await db
        .update(groupMessageTable)
        .set({ body, updatedAt: now })
        .where(
          and(
            eq(groupMessageTable.id, messageId),
            eq(groupMessageTable.groupId, id),
          ),
        );
      const updated = { ...message, body, updatedAt: now };
      // Realtime push (ticket 22): same fire-and-forget semantics as POST.
      void wsHub.broadcastGroupMessageUpdated(updated);
      return c.json(updated);
    },
  )
  .delete(
    "/:id/messages/:messageId",
    describeRoute({
      description:
        "Soft-delete a message (ticket 22): body becomes the placeholder so the closure/reply tree stays intact; idempotent — deleting an already-deleted message still succeeds",
      responses: {
        200: {
          description: "Message soft-deleted",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "param",
      z.object({ id: z.string().uuid(), messageId: z.string().uuid() }),
    ),
    async (c) => {
      const db = c.get("db");
      const agentId = c.get("agentId");
      const { id, messageId } = c.req.valid("param");

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      // 归档/软删群组只读(与 POST 同款守卫):历史可读,但不可再修改。
      if (group.status !== "active") {
        throw new BizError(BizCodeEnum.InvalidRequest);
      }
      // 发送者必须是当前群成员(与 POST 同款守卫):被移出后不能再删除旧消息。
      const membership = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.agentId, agentId)),
      });
      if (!membership) {
        throw new BizError(BizCodeEnum.Forbidden);
      }
      const message = await db.query.groupMessage.findFirst({
        where: (t, { and, eq }) => and(eq(t.id, messageId), eq(t.groupId, id)),
      });
      if (!message) {
        throw new BizError(BizCodeEnum.MessageNotFound);
      }
      // 仅发送者本人可删除自己的消息。
      if (message.senderId !== agentId) {
        throw new BizError(BizCodeEnum.Forbidden);
      }
      // 幂等:已是占位 body 说明已软删除,直接成功,不再重复广播。
      if (message.body === DELETED_MESSAGE_PLACEHOLDER) {
        return c.json({ success: true });
      }

      const now = new Date();
      await db
        .update(groupMessageTable)
        .set({ body: DELETED_MESSAGE_PLACEHOLDER, updatedAt: now })
        .where(
          and(
            eq(groupMessageTable.id, messageId),
            eq(groupMessageTable.groupId, id),
          ),
        );
      // Realtime push (ticket 22): the event carries only the id; visibility
      // reuses the message's own audience, so the same members that saw the
      // original get the delete.
      void wsHub.broadcastGroupMessageDeleted({
        id: message.id,
        groupId: message.groupId,
        senderId: message.senderId,
        audience: message.audience,
        audienceRef: message.audienceRef,
      });
      return c.json({ success: true });
    },
  )
  .get(
    "/:id/messages",
    describeRoute({
      description:
        "List messages visibility-filtered for the caller, ordered by receive time; pass ?after=<messageId> for incremental pulls (id > after)",
      responses: {
        200: {
          description: "Visible messages with tree depth",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    zValidator(
      "query",
      z.object({
        after: z.string().uuid().optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const requesterId = c.get("agentId");
      const { id } = c.req.valid("param");
      const { after } = c.req.valid("query");

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      const membership = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.agentId, requesterId)),
      });
      // LAN trust model: reading a group does not require membership. The
      // default Local User counts as human (sees everything) — even when it
      // holds a membership row (e.g. it created the group tokenless and was
      // auto-inserted as coordinator); union keeps that human bypass, so pull
      // matches the WS fan-out. Any other non-member sees broadcast + own.
      const localUserId = await resolveLocalUser(db);
      const requesterRoles =
        requesterId === localUserId
          ? [...(membership?.roles ?? []), "human"]
          : (membership?.roles ?? []);

      // Visibility is pushed into SQL (same rule as the webhook/WS fan-out,
      // see group-visibility.ts) so the ?after= cursor and LIMIT paginate over
      // the *visible* stream instead of fetching everything into JS. The rule:
      // sender always sees own messages; broadcast reaches every member; role
      // reaches members holding that role; agent reaches only the named
      // member; human members bypass the audience rule and see everything.
      const conditions = [
        eq(groupMessageTable.groupId, id),
        messageVisibleToMemberSql(requesterId, requesterRoles),
      ];
      if (after) {
        // Incremental pull: uuidv7 ids are time-ordered, so id > after yields
        // everything the caller has not seen yet. The stream is ordered by the
        // same key the cursor filters on, so cursor and order cannot diverge.
        conditions.push(gt(groupMessageTable.id, after));
      }

      const messages = await db
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
        .where(and(...conditions))
        // uuidv7 ids embed the server receive time, so id order IS receive
        // order — ordering by id keeps the stream consistent with ?after=.
        // Page the visible stream; clients continue with ?after=<lastId>.
        .orderBy(asc(groupMessageTable.id))
        .limit(MESSAGE_PAGE_LIMIT);

      return c.json(messages);
    },
  )
  /* ---------------- 任务(ticket 35):server 为单一状态源,桥是纯执行器客户端 ---------------- */

  .post(
    "/:id/tasks",
    describeRoute({
      description:
        "Create a task for the group (idempotent by message_id — the same message only ever creates one task; duplicates return the existing row)",
      responses: {
        200: {
          description: "Task created or existing task returned",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    zValidator(
      "json",
      z.object({
        messageId: z.string().uuid(),
        executorAgentId: z.string().uuid(),
        checkpointRef: z.string().optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const callerId = c.get("agentId");
      const { id } = c.req.valid("param");
      const { messageId, executorAgentId, checkpointRef } = c.req.valid("json");

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      // 与其它群路由一致的边界:调用者必须是群成员(agent 注册是公开的,
      // 不校验会泄漏任意群的任务数据)。
      const membership = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.agentId, callerId)),
      });
      if (!membership) {
        throw new BizError(BizCodeEnum.Forbidden);
      }
      const executor = await db.query.agent.findFirst({
        where: (t, { eq }) => eq(t.id, executorAgentId),
      });
      if (!executor) {
        throw new BizError(BizCodeEnum.AgentNotFound);
      }

      // Idempotent create: message_id is UNIQUE, so a repeated POST with the
      // same message id returns the existing task instead of a duplicate.
      // ON CONFLICT DO NOTHING keeps the check race-free (concurrent duplicate
      // deliveries fall back to re-reading the winning row, never a 500).
      const [created] = await db
        .insert(taskTable)
        .values({
          groupId: id,
          messageId,
          executorAgentId,
          checkpointRef: checkpointRef ?? null,
        })
        .onConflictDoNothing({ target: taskTable.messageId })
        .returning();
      if (created) {
        return c.json(created);
      }
      const existing = await db.query.task.findFirst({
        where: (t, { eq }) => eq(t.messageId, messageId),
      });
      return c.json(existing);
    },
  )
  .get(
    "/:id/tasks",
    describeRoute({
      description: "List the group's tasks, newest first (createdAt desc)",
      responses: {
        200: {
          description: "Task list",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    async (c) => {
      const db = c.get("db");
      const callerId = c.get("agentId");
      const { id } = c.req.valid("param");

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      // 与 POST /tasks 相同的边界:非成员不可读任务列表(防任意群任务泄漏)。
      const membership = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.agentId, callerId)),
      });
      if (!membership) {
        throw new BizError(BizCodeEnum.Forbidden);
      }

      const tasks = await db.query.task.findMany({
        where: (t, { eq }) => eq(t.groupId, id),
        orderBy: (t, { desc }) => desc(t.createdAt),
      });
      return c.json(tasks);
    },
  )
  .patch(
    "/:id/tasks/:taskId",
    describeRoute({
      description:
        "Update a task (status/diffSummary). Only the task's executor agent identity (token) may update it",
      responses: {
        200: {
          description: "Task updated",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "param",
      z.object({ id: z.string().uuid(), taskId: z.string().uuid() }),
    ),
    zValidator(
      "json",
      z
        .object({
          status: z.enum(TASK_STATUSES).optional(),
          diffSummary: z.unknown().optional(),
          checkpointRef: z.string().optional(),
        })
        .refine(
          (v) =>
            v.status !== undefined ||
            v.diffSummary !== undefined ||
            v.checkpointRef !== undefined,
          { message: "至少提供 status / diffSummary / checkpointRef 之一" },
        ),
    ),
    async (c) => {
      const db = c.get("db");
      const agentId = c.get("agentId");
      const { id, taskId } = c.req.valid("param");
      const { status, diffSummary, checkpointRef } = c.req.valid("json");

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      const task = await db.query.task.findFirst({
        where: (t, { and, eq }) => and(eq(t.id, taskId), eq(t.groupId, id)),
      });
      if (!task) {
        throw new BizError(BizCodeEnum.TaskNotFound);
      }
      // Only the owning executor agent can advance the lifecycle.
      if (task.executorAgentId !== agentId) {
        throw new BizError(BizCodeEnum.Forbidden);
      }
      const [updated] = await db
        .update(taskTable)
        .set({
          ...(status !== undefined ? { status } : {}),
          ...(diffSummary !== undefined ? { diffSummary } : {}),
          ...(checkpointRef !== undefined ? { checkpointRef } : {}),
        })
        .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, id)))
        .returning();
      return c.json(updated);
    },
  );

export default app;
