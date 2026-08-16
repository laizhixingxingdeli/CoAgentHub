import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { zValidator } from "@hono/zod-validator";
import {
  groupMember as groupMemberTable,
  groups as groupsTable,
} from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import type { DataBase } from "@server/lib/database";
import { and, count, desc, eq, ilike, sql } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";

/**
 * 群本体子路由:创建 / 列表(分页+搜索)/ 详情 / 改名与绑定项目 / 归档 /
 * 恢复 / 软删。挂在 /api/groups 下(与拆分的 members/messages/tasks 子路由
 * 并列,API 路径与响应形状与拆分前完全一致)。
 */

const app = new Hono<{ Variables: { db: DataBase; participantId: string } }>();

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
  );

export default app;
