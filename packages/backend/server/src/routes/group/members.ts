import { zValidator } from "@hono/zod-validator";
import {
  GROUP_ROLES,
  groupMember as groupMemberTable,
  participant as participantTable,
} from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import type { DataBase } from "@server/lib/database";
import { resolveLocalUser } from "@server/lib/local-participant";
import { capabilityHint } from "@server/lib/participant-capabilities";
import { insertGroupMessage } from "@server/lib/services/message-service";
import { wsHub } from "@server/lib/ws-hub";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { assertGroupWritable } from "./helpers";

/**
 * 群成员子路由:添加(幂等 upsert)/ 列表 / 移除 / 更新角色与分工。
 * 挂在 /api/groups 下(路径 /:id/members...),与拆分前完全一致。
 */

const app = new Hono<{ Variables: { db: DataBase; participantId: string } }>();

app
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

      // 加群自动发 skill 安装引导:roles 含 executor → 发 coagenthub-executor
      // 安装引导;含 coordinator → 发 coagenthub-coordinator 安装引导;其他角色
      // 不发。fire-and-forget,发送失败只记日志,绝不阻塞成员添加响应。发送者
      // 用 Local User(系统身份),避免需要额外权限。
      const skillMessages: Record<string, string> = {
        executor: `请先安装 coagenthub-executor skill：
1. GET /api/skills/executor 获取内容
2. 写入你的 skills 目录（如 ~/.hermes/skills/coagenthub-executor/SKILL.md）
3. 安装完成后回复「✅ skill 已安装」
未安装前不要领取任务。`,
        coordinator: `请先安装 coagenthub-coordinator skill：
1. GET /api/skills/coordinator 获取内容
2. 写入你的 skills 目录（如 ~/.hermes/skills/coagenthub-coordinator/SKILL.md）
3. 安装完成后回复「✅ skill 已安装」
未初始化前不要下发任务。`,
      };
      void (async () => {
        try {
          const senderId = await resolveLocalUser(db);
          for (const role of dedupedRoles) {
            if (skillMessages[role]) {
              await insertGroupMessage(db, {
                groupId: id,
                senderId,
                audience: "participant",
                audienceRef: participantId,
                body: skillMessages[role],
                contentType: "text/plain",
              });
            }
          }
        } catch (err) {
          console.warn("[members] skill 安装引导发送失败(忽略):", err);
        }
      })();

      wsHub.invalidateGroupMembers(id);

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
      wsHub.invalidateGroupMembers(id);
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
      wsHub.invalidateGroupMembers(id);
      return c.json(updated);
    },
  );

export default app;
