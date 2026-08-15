import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { zValidator } from "@hono/zod-validator";
import {
  FileRefInput,
  GROUP_ROLES,
  GroupMessageAudienceInput,
  groupMember as groupMemberTable,
  groups as groupsTable,
  participant as participantTable,
  TASK_STATUSES,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import { maybeHandleControlCommand } from "@server/lib/control";
import type { DataBase } from "@server/lib/database";
import {
  maybeDispatchExecutorTask,
  notifyTaskStatusChanged,
  refreshA2AActivity,
  taskOutputTail,
} from "@server/lib/executor-task";
import type { ParticipantType } from "@server/lib/group-visibility";
import { resolveLocalUser } from "@server/lib/local-participant";
import { capabilityHint } from "@server/lib/participant-capabilities";
import {
  DELETED_MESSAGE_PLACEHOLDER,
  insertGroupMessage,
  listVisibleMessages,
  softDeleteMessage,
  updateMessageBody,
} from "@server/lib/services/message-service";
import { wsHub } from "@server/lib/ws-hub";
import { and, asc, count, desc, eq, ilike, sql } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";

const app = new Hono<{ Variables: { db: DataBase; participantId: string } }>();

/**
 * 归档/软删群只读守卫:非 active 群的一切写操作返回 403 + 原因(历史仍可读,
 * GET 端点不做此检查)。返回群行供调用方复用,避免二次查询。
 */
async function assertGroupWritable(
  db: DataBase,
  groupId: string,
): Promise<typeof groupsTable.$inferSelect> {
  const group = await db.query.groups.findFirst({
    where: (t, { eq }) => eq(t.id, groupId),
  });
  if (!group) {
    throw new BizError(BizCodeEnum.GroupNotFound);
  }
  if (group.status !== "active") {
    throw new BizError(
      BizCodeEnum.Forbidden,
      group.status === "archived" ? "群已归档,只读" : "群已删除,只读",
    );
  }
  return group;
}

// 消息域的占位串/分页等常量已随逻辑迁入 @server/lib/services/message-service。

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
      const participantId = c.get("participantId");
      const { title } = c.req.valid("json");

      // db.transaction resolves to the callback's return value.
      const group = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(groupsTable)
          .values({ title, createdBy: participantId })
          .returning();
        // The creator is automatically a member with the coordinator role —
        // inserted in the same transaction so a group can never exist
        // without its coordinator membership.
        await tx.insert(groupMemberTable).values({
          groupId: created.id,
          participantId,
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
        "List groups with member counts (soft-deleted groups are always excluded); supports ?limit=&offset= pagination and returns { items, total }",
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
        // 群列表搜索(enhancement):标题关键词,LIKE 通配符(%、_)按字面转义;
        // 空串视为无搜索。上限 100 字符防止超长模式串。
        q: z.string().max(100).optional(),
        // 分页:limit 缺省时不截断(返回全量);提供时上限 100、非法值回退默认 20。
        // offset 缺省为 0,非法值回退 0。total 为满足 status/q 过滤条件的总数。
        limit: z.coerce.number().int().min(1).max(100).catch(20).optional(),
        offset: z.coerce.number().int().min(0).catch(0).optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { status, q, limit, offset } = c.req.valid("query");

      const conditions = [
        // Soft-deleted groups are hidden from every list: an explicit
        // ?status= filter can only name active/archived, and the unfiltered
        // list excludes deleted rows outright (rows are kept, not purged).
        status
          ? eq(groupsTable.status, status)
          : sql`${groupsTable.status} <> 'deleted'`,
      ];
      if (q) {
        // Keyword search: title ILIKE %q% on top of the status filter. LIKE
        // wildcards (%, _) are backslash-escaped so `100%` matches literally;
        // the escape is applied to the pattern only, never to user input at the
        // SQL level (drizzle binds the pattern as a parameter). Empty string is
        // treated as "no search" — behavior identical to the pre-search route.
        const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        conditions.push(ilike(groupsTable.title, `%${escaped}%`));
      }

      // total 只受 status/q 过滤影响,与分页无关:独立计数(不带 join,
      // 否则成员 join 会让带多成员的群被重复计数)。
      const [{ total }] = await db
        .select({ total: count() })
        .from(groupsTable)
        .where(and(...conditions));

      const query = db
        .select({
          id: groupsTable.id,
          title: groupsTable.title,
          status: groupsTable.status,
          createdBy: groupsTable.createdBy,
          createdAt: groupsTable.createdAt,
          updatedAt: groupsTable.updatedAt,
          projectPath: groupsTable.projectPath,
          memberCount: count(groupMemberTable.participantId),
        })
        .from(groupsTable)
        .leftJoin(
          groupMemberTable,
          eq(groupMemberTable.groupId, groupsTable.id),
        )
        .where(and(...conditions))
        .groupBy(groupsTable.id)
        .orderBy(desc(groupsTable.createdAt));
      // 不带 limit 参数时行为与旧版一致:返回全量(不截断)。
      const groups =
        limit !== undefined
          ? await query.limit(limit).offset(offset ?? 0)
          : await query;
      return c.json({ items: groups, total });
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
  .patch(
    "/:id",
    describeRoute({
      description:
        "Update a group: bind/clear the project path (projectPath; empty/null clears, non-empty must be an existing absolute directory) and/or rename it (title)",
      responses: {
        200: {
          description: "Group updated",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    zValidator(
      "json",
      z
        .object({
          title: z.string().min(1).max(200).optional(),
          projectPath: z.string().nullable().optional(),
        })
        .refine((v) => v.title !== undefined || v.projectPath !== undefined, {
          message: "at least one field to update is required",
        }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const { title, projectPath } = c.req.valid("json");

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }

      const patch: { title?: string; projectPath?: string | null } = {};
      if (title !== undefined) patch.title = title;
      if (projectPath !== undefined) {
        // 空串视作清空绑定(null);非空值必须是存在的绝对目录路径。
        const path = projectPath === "" ? null : projectPath;
        if (path !== null) {
          const valid =
            isAbsolute(path) &&
            existsSync(path) &&
            statSync(path).isDirectory();
          if (!valid) {
            throw new BizError(
              BizCodeEnum.InvalidRequest,
              `projectPath 必须是存在的绝对目录路径:${path}`,
            );
          }
        }
        patch.projectPath = path;
      }

      const [updated] = await db
        .update(groupsTable)
        .set(patch)
        .where(eq(groupsTable.id, id))
        .returning();
      return c.json(updated);
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
        participantId: z.string().uuid(),
        // Roles must come from the preset catalog; empty defaults to observer.
        roles: z.array(z.enum(GROUP_ROLES)).default(["observer"]),
        // 群内分工说明(角色解绑):描述该 participant 在本群的分工,可空。
        prompt: z.string().max(1000).optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const { participantId, roles, prompt } = c.req.valid("json");

      // 归档/软删群组只读:成员管理随群只读(与消息同款守卫)。
      await assertGroupWritable(db, id);
      const participant = await db.query.participant.findFirst({
        where: (t, { eq }) => eq(t.id, participantId),
      });
      if (!participant) {
        throw new BizError(BizCodeEnum.ParticipantNotFound);
      }

      const dedupedRoles =
        roles.length > 0 ? [...new Set(roles)] : ["observer"];
      const [member] = await db
        .insert(groupMemberTable)
        .values({
          groupId: id,
          participantId,
          roles: dedupedRoles,
          ...(prompt !== undefined ? { prompt } : {}),
        })
        .onConflictDoUpdate({
          target: [groupMemberTable.groupId, groupMemberTable.participantId],
          set: {
            roles: dedupedRoles,
            // prompt 未提供时保持既有值,避免幂等 upsert 清掉已有分工说明。
            ...(prompt !== undefined ? { prompt } : {}),
          },
        })
        .returning();

      // 轻量能力提示 (ticket 17): 已知能力与角色匹配提示,绝不硬性拒绝 —
      // 无提示时为 null,响应形状始终带 capabilityHint 字段。
      const hint = capabilityHint(participant.capabilities, dedupedRoles);

      return c.json({ ...member, capabilityHint: hint });
    },
  )
  .get(
    "/:id/members",
    describeRoute({
      description:
        "List group members with participant info and in-group roles",
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
          participantId: participantTable.id,
          name: participantTable.name,
          device: participantTable.device,
          roles: groupMemberTable.roles,
          prompt: groupMemberTable.prompt,
          joinedAt: groupMemberTable.joinedAt,
        })
        .from(groupMemberTable)
        .innerJoin(
          participantTable,
          eq(participantTable.id, groupMemberTable.participantId),
        )
        .where(eq(groupMemberTable.groupId, id))
        .orderBy(asc(groupMemberTable.joinedAt));

      return c.json(members);
    },
  )
  .delete(
    "/:id/members/:participantId",
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
      z.object({ id: z.string().uuid(), participantId: z.string().uuid() }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id, participantId } = c.req.valid("param");

      // 归档/软删群组只读:成员管理随群只读(与消息同款守卫)。
      const group = await assertGroupWritable(db, id);
      // 群主不可被移除:创建者是这个群组的 owner,成员移除不能破坏它。
      if (participantId === group.createdBy) {
        throw new BizError(BizCodeEnum.InvalidRequest, "不能移除群主");
      }
      const member = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.participantId, participantId)),
      });
      if (!member) {
        throw new BizError(BizCodeEnum.MemberNotFound);
      }

      await db
        .delete(groupMemberTable)
        .where(
          and(
            eq(groupMemberTable.groupId, id),
            eq(groupMemberTable.participantId, participantId),
          ),
        );
      return c.json({ success: true });
    },
  )
  .patch(
    "/:id/members/:participantId",
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
      z.object({ id: z.string().uuid(), participantId: z.string().uuid() }),
    ),
    zValidator(
      "json",
      z
        .object({
          roles: z.array(z.enum(GROUP_ROLES)).min(1).optional(),
          // 群内分工说明(角色解绑):可单独更新 prompt,也可与 roles 一起。
          prompt: z.string().max(1000).optional(),
        })
        .refine((v) => v.roles !== undefined || v.prompt !== undefined, {
          message: "至少提供 roles 或 prompt 之一",
        }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id, participantId } = c.req.valid("param");
      const { roles, prompt } = c.req.valid("json");

      // 归档/软删群组只读:成员管理随群只读(与消息同款守卫)。
      await assertGroupWritable(db, id);
      const member = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.participantId, participantId)),
      });
      if (!member) {
        throw new BizError(BizCodeEnum.MemberNotFound);
      }

      // 与 POST /members 相同的去重规则:角色集去重后写入,min(1) 已保证非空。
      const dedupedRoles =
        roles !== undefined ? [...new Set(roles)] : undefined;
      const [updated] = await db
        .update(groupMemberTable)
        .set({
          ...(dedupedRoles !== undefined ? { roles: dedupedRoles } : {}),
          ...(prompt !== undefined ? { prompt } : {}),
        })
        .where(
          and(
            eq(groupMemberTable.groupId, id),
            eq(groupMemberTable.participantId, participantId),
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
        "Post a message to a group; sender must be a member. Messages carry a target audience (broadcast | role | participant) and an optional parentId for the thread tree",
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
          // 输入上限(P0):发送 body 最多 8000 字符,防止局域网内一条超大
          // 请求打爆内存(编辑接口为 4000,见 PATCH /:id/messages/:messageId)。
          body: z.string().max(8000).optional(),
          parentId: z.string().uuid().optional(),
          // 兼容旧值:接受历史 audience "agent"(术语改名前的旧值,外部执行器
          // CLI 可能仍发送),归一为 "participant" 后存储与校验。
          audience: GroupMessageAudienceInput.optional(),
          audienceRef: z.string().optional(),
          // 内容类型 (ticket 17): 仅存储不校验 —— 不白名单、不解析;仅拒绝
          // 空串以免绕过 text/plain 默认值。
          contentType: z.string().min(1).optional(),
          // fileRef.expiresAt 可选由客户端传入;服务端缺省补 now + 7d (ticket 17)。
          // 输入上限(P0):name ≤255、fetchUrl ≤2048,超限校验返回 400。
          fileRef: FileRefInput.extend({
            name: z.string().min(1).max(255),
            fetchUrl: z.string().url().max(2048),
          }).optional(),
        })
        .refine((v) => (v.body?.trim()?.length ?? 0) > 0 || !!v.fileRef, {
          message: "body or fileRef must be provided",
        }),
    ),
    async (c) => {
      const db = c.get("db");
      const senderId = c.get("participantId");
      const { id } = c.req.valid("param");
      const { body, parentId, audience, audienceRef, contentType, fileRef } =
        c.req.valid("json");

      // Archive = read-only: an archived (or soft-deleted) group rejects new
      // messages with 403 + reason; reading (GET messages / GET members /
      // GET :id) stays open so history remains browsable.
      await assertGroupWritable(db, id);
      // The sender must be a group member (any role) to post.
      const membership = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.participantId, senderId)),
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
      } else if (aud === "participant") {
        // audienceRef must name a member of THIS group.
        if (!audienceRef) {
          throw new BizError(BizCodeEnum.InvalidRequest);
        }
        const target = await db.query.groupMember.findFirst({
          where: (t, { and, eq }) =>
            and(eq(t.groupId, id), eq(t.participantId, audienceRef)),
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
          aud === "role" || aud === "participant"
            ? (audienceRef ?? null)
            : null,
        body: body ?? "",
        contentType: contentType ?? "text/plain",
        // 服务端必填 (ticket 17): 客户端未传 expiresAt 时默认 now + 7d;
        // 历史 fileRef 元信息随消息永久可见,过期只影响取文件。
        fileRef: fileRef ?? null,
      });

      // Realtime push (ticket 13): fire-and-forget — the WS hub catches its
      // own failures, so the fan-out cannot block the response; the ?after=
      // incremental pull remains the guaranteed fallback.
      void wsHub.broadcastGroupMessage(full);

      // 第1层(A2A 进度信号):执行器 participant 在本群发的消息 → 刷新同群 running
      // 的 A2A 任务最近活跃时间,顺延无进展超时(纯内存同步操作,不阻塞响应;
      // 消息可以是普通广播消息,无需新协议)。
      refreshA2AActivity(id, senderId);

      // 阶段2-票1:定向到执行器 participant 的消息 → server 直接建 task + spawn
      // (fire-and-forget;命中与否/幂等/双跑防重都在 executor-task 内处理,
      // 失败只记日志,绝不阻塞消息响应)。
      if (aud === "participant" && audienceRef) {
        void maybeDispatchExecutorTask(db, {
          groupId: id,
          messageId: full.id,
          senderRoles: membership.roles,
          audienceRef,
          body: body ?? "",
        }).catch((err) => console.warn("[executor] 后台调度失败(忽略):", err));
      }
      // 阶段2-票2:控制指令(「停止/stop」「回滚 [taskId]」)识别放 server;
      // fire-and-forget,命中与否/权限/防回环在 control.ts 内处理。定向到
      // 执行器 participant 的消息是任务,控制入口内部会跳过,不重复动作。
      void maybeHandleControlCommand(db, {
        groupId: id,
        senderId,
        senderRoles: membership.roles,
        audience: aud,
        audienceRef: aud === "participant" ? (audienceRef ?? null) : null,
        body: body ?? "",
      }).catch((err) => console.warn("[control] 后台指令处理失败(忽略):", err));

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
      const participantId = c.get("participantId");
      const { id, messageId } = c.req.valid("param");
      const { body } = c.req.valid("json");

      // 归档/软删群组只读(与 POST 同款守卫):历史可读,但不可再修改。
      await assertGroupWritable(db, id);
      // 发送者必须是当前群成员(与 POST 同款守卫):被移出后不能再编辑旧消息。
      const membership = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.participantId, participantId)),
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
      // 仅发送者本人可编辑自己的消息。
      if (message.senderId !== participantId) {
        throw new BizError(BizCodeEnum.Forbidden);
      }
      // 已软删除的消息不可再编辑:占位 body 是删除标记,改回正文等于复活,
      // 与「删除后不可恢复」的产品契约相悖。
      if (message.body === DELETED_MESSAGE_PLACEHOLDER) {
        throw new BizError(BizCodeEnum.InvalidRequest);
      }

      // 编辑写入在 message-service 内完成(仅 UPDATE + 返回全量行);
      // 发送者/群状态/占位串等校验已在上方完成,错误码与响应结构不变。
      const updated = await updateMessageBody(db, id, messageId, body);
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
      const participantId = c.get("participantId");
      const { id, messageId } = c.req.valid("param");

      // 归档/软删群组只读(与 POST 同款守卫):历史可读,但不可再修改。
      await assertGroupWritable(db, id);
      // 发送者必须是当前群成员(与 POST 同款守卫):被移出后不能再删除旧消息。
      const membership = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.participantId, participantId)),
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
      if (message.senderId !== participantId) {
        throw new BizError(BizCodeEnum.Forbidden);
      }

      // 软删除(占位符 + 保持闭包)在 message-service 内完成,返回是否真的
      // 执行了删除:幂等场景(已删过)不再重复广播,响应结构均为 success。
      const deleted = await softDeleteMessage(db, id, messageId);
      if (deleted) {
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
      }
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
        // 消息搜索(enhancement):正文关键词,LIKE 通配符(%、_)按字面转义;
        // 空串视为无搜索。上限 200 字符防止超长模式串。
        q: z.string().max(200).optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const requesterId = c.get("participantId");
      const { id } = c.req.valid("param");
      const { after, q } = c.req.valid("query");

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      const membership = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.participantId, requesterId)),
      });
      // LAN trust model: reading a group does not require membership. The
      // default Local User counts as human (sees everything) — even when it
      // holds a membership row (e.g. it created the group tokenless and was
      // auto-inserted as coordinator); participantType keeps that human bypass,
      // so pull matches the WS fan-out. Any other non-member sees broadcast + own.
      const localUserId = await resolveLocalUser(db);
      const participantType: ParticipantType | undefined =
        requesterId === localUserId ? "human" : undefined;
      const requesterRoles = membership?.roles ?? [];

      // 可见性 SQL(与 webhook/WS 扇出同一套规则)+ ?after= 增量游标 +
      // q 关键词 + LIMIT 整体在 message-service 内完成,翻页发生在
      // *可见* 流上;路由只做响应编排。
      const messages = await listVisibleMessages(
        db,
        id,
        requesterId,
        requesterRoles,
        {
          after,
          q,
          participantType,
        },
      );

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
        executorParticipantId: z.string().uuid(),
        checkpointRef: z.string().optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const callerId = c.get("participantId");
      const { id } = c.req.valid("param");
      const { messageId, executorParticipantId, checkpointRef } =
        c.req.valid("json");

      // 归档/软删群组只读:不能发新任务(与消息/成员同款守卫)。
      await assertGroupWritable(db, id);
      // 与其它群路由一致的边界:调用者必须是群成员(participant 注册是公开的,
      // 不校验会泄漏任意群的任务数据)。
      const membership = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.participantId, callerId)),
      });
      if (!membership) {
        throw new BizError(BizCodeEnum.Forbidden);
      }
      const executor = await db.query.participant.findFirst({
        where: (t, { eq }) => eq(t.id, executorParticipantId),
      });
      if (!executor) {
        throw new BizError(BizCodeEnum.ParticipantNotFound);
      }

      // 任务书快照:从触发消息取 body 原文写入 brief(消息后续编辑/软删除
      // 不影响已触发任务语义);消息不存在时留空(可空列)。
      const triggerMessage = await db.query.groupMessage.findFirst({
        where: (t, { eq }) => eq(t.id, messageId),
      });

      // Idempotent create: message_id is UNIQUE, so a repeated POST with the
      // same message id returns the existing task instead of a duplicate.
      // ON CONFLICT DO NOTHING keeps the check race-free (concurrent duplicate
      // deliveries fall back to re-reading the winning row, never a 500).
      const [created] = await db
        .insert(taskTable)
        .values({
          groupId: id,
          messageId,
          executorParticipantId,
          checkpointRef: checkpointRef ?? null,
          brief: triggerMessage?.body ?? null,
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
    zValidator(
      "query",
      z.object({
        // 实时输出:仅 includeOutput=1 时返回 outputTail(控制响应大小)。
        includeOutput: z.enum(["1", "0", "true", "false"]).optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const { includeOutput } = c.req.valid("query");
      const wantOutput = includeOutput === "1" || includeOutput === "true";

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      // LAN trust model(与 GET /messages 一致):读任务列表不需要成员身份,
      // 仅要求群存在;写操作(POST/PATCH)仍走各自权限边界。
      const tasks = await db.query.task.findMany({
        where: (t, { eq }) => eq(t.groupId, id),
        orderBy: (t, { desc }) => desc(t.createdAt),
      });
      // 实时进度:includeOutput=1 时给每个任务附 outputTail(running 任务 =
      // 内存缓冲;已完成任务 = diffSummary.outputTail 回填或留空)。
      if (!wantOutput) {
        return c.json(tasks);
      }
      const withOutput = tasks.map((task) => {
        const buffered = taskOutputTail(task.id);
        const summary =
          typeof task.diffSummary === "object" && task.diffSummary !== null
            ? (task.diffSummary as Record<string, unknown>)
            : undefined;
        const backfilled =
          summary && typeof summary.outputTail === "string"
            ? summary.outputTail
            : undefined;
        const outputTail = buffered ?? backfilled ?? undefined;
        return outputTail === undefined ? task : { ...task, outputTail };
      });
      return c.json(withOutput);
    },
  )
  .get(
    "/:id/tasks/:taskId",
    describeRoute({
      description:
        "Get a single task's full details (optionally with outputTail via ?includeOutput=1)",
      responses: {
        200: {
          description: "Task details",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "param",
      z.object({ id: z.string().uuid(), taskId: z.string().uuid() }),
    ),
    zValidator(
      "query",
      z.object({
        // 实时输出:仅 includeOutput=1 时返回 outputTail(控制响应大小)。
        includeOutput: z.enum(["1", "0", "true", "false"]).optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id, taskId } = c.req.valid("param");
      const { includeOutput } = c.req.valid("query");
      const wantOutput = includeOutput === "1" || includeOutput === "true";

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
      // 只返回任务详情约定字段(不泄露 attempts/a2aContextId 等内部列)。
      const detail: Record<string, unknown> = {
        id: task.id,
        groupId: task.groupId,
        messageId: task.messageId,
        executorParticipantId: task.executorParticipantId,
        executorKey: task.executorKey,
        brief: task.brief,
        status: task.status,
        checkpointRef: task.checkpointRef,
        retryCount: task.retryCount,
        diffSummary: task.diffSummary,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      };
      // 实时进度:includeOutput=1 时附 outputTail(running 任务 = 内存缓冲;
      // 已完成任务 = diffSummary.outputTail 回填或留空)。
      if (wantOutput) {
        const buffered = taskOutputTail(task.id);
        const summary =
          typeof task.diffSummary === "object" && task.diffSummary !== null
            ? (task.diffSummary as Record<string, unknown>)
            : undefined;
        const backfilled =
          summary && typeof summary.outputTail === "string"
            ? summary.outputTail
            : undefined;
        detail.outputTail = buffered ?? backfilled ?? null;
      }
      return c.json(detail);
    },
  )
  .patch(
    "/:id/tasks/:taskId",
    describeRoute({
      description:
        "Update a task (status/diffSummary by the owning executor; brief by the group's coordinator/human while the task is queued)",
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
          // 任务书快照:仅群 coordinator/human 可在任务 queued 时修改
          // (角色/状态判断在 handler,此处只做格式约束;执行器本人保持只读)。
          brief: z.string().min(1).max(4000).optional(),
        })
        .passthrough()
        .refine(
          (v) =>
            v.status !== undefined ||
            v.diffSummary !== undefined ||
            v.checkpointRef !== undefined ||
            v.brief !== undefined,
          { message: "至少提供 status / diffSummary / checkpointRef / brief 之一" },
        ),
    ),
    async (c) => {
      const db = c.get("db");
      const participantId = c.get("participantId");
      const { id, taskId } = c.req.valid("param");
      const { status, diffSummary, checkpointRef, brief } = c.req.valid("json");

      // 归档/软删群组只读:不能改任务状态(与 POST /tasks 同款守卫)。
      await assertGroupWritable(db, id);
      const task = await db.query.task.findFirst({
        where: (t, { and, eq }) => and(eq(t.id, taskId), eq(t.groupId, id)),
      });
      if (!task) {
        throw new BizError(BizCodeEnum.TaskNotFound);
      }
      const isExecutor = task.executorParticipantId === participantId;
      const wantsBrief = brief !== undefined;
      const wantsLifecycle =
        status !== undefined ||
        diffSummary !== undefined ||
        checkpointRef !== undefined;

      if (wantsBrief) {
        // 任务书快照对执行器本人保持只读(与旧 superRefine 行为一致)。
        if (isExecutor) {
          throw new BizError(
            BizCodeEnum.InvalidRequest,
            "brief 为只读字段,不可通过 PATCH 修改",
          );
        }
        // 仅群 coordinator/human 可在任务排队中修改任务书。
        const membership = await db.query.groupMember.findFirst({
          where: (t, { and, eq }) =>
            and(eq(t.groupId, id), eq(t.participantId, participantId)),
        });
        const roles = membership?.roles ?? [];
        if (!roles.includes("coordinator") && !roles.includes("human")) {
          throw new BizError(BizCodeEnum.Forbidden);
        }
        if (task.status !== "queued") {
          throw new BizError(BizCodeEnum.Conflict, "仅排队中的任务可修改任务书");
        }
      }
      // 生命周期字段(status/diffSummary/checkpointRef)仍仅执行器本人可改。
      if (wantsLifecycle && !isExecutor) {
        throw new BizError(BizCodeEnum.Forbidden);
      }
      const [updated] = await db
        .update(taskTable)
        .set({
          ...(status !== undefined ? { status } : {}),
          ...(diffSummary !== undefined ? { diffSummary } : {}),
          ...(checkpointRef !== undefined ? { checkpointRef } : {}),
          ...(brief !== undefined ? { brief } : {}),
        })
        .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, id)))
        .returning();
      // 外部执行器客户端通过 PATCH 推进状态 → 同样推送 task_status_changed
      // (仅当 status 实际变更时;否则订阅者会收到无变化的重复事件)。
      if (updated && status !== undefined && updated.status !== task.status) {
        await notifyTaskStatusChanged(
          db,
          updated.id,
          updated.groupId,
          status,
          updated,
        );
      }
      return c.json(updated);
    },
  );

export default app;
