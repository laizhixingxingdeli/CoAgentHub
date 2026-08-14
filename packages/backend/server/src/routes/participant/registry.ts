import { zValidator } from "@hono/zod-validator";
import {
  groupMember as groupMemberTable,
  groupMessage as groupMessageTable,
  groups as groupsTable,
  participant as participantTable,
} from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import db, { type DataBase } from "@server/lib/database";
import { participantIdentity } from "@server/middleware/participant-identity";
import { desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";

// 注册(公开)与自管理(participantIdentity)并存:POST / 不挂中间件 —— 首次注册
// 必须先于任何身份存在;PATCH / 与 PUT /heartbeat 挂身份声明中间件(全信模型,
// 不再校验持有者 —— 任何声称的身份都可管理任意注册信息)。
const app = new Hono<{ Variables: { db: DataBase; participantId: string } }>();

app.use(async (c, next) => {
  c.set("db", db);
  await next();
});

app
  .post(
    "/",
    describeRoute({
      description: "Register a new participant",
      responses: {
        200: {
          description: "Participant created",
          content: {
            "application/json": {},
          },
        },
      },
    }),
    zValidator(
      "json",
      z.object({
        name: z.string().min(1),
        device: z.string().optional(),
        // 自由能力标签 (ticket 17): 缺省空数组;仅存储,轻量校验放在加成员处。
        capabilities: z.array(z.string()).max(64).optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const input = c.req.valid("json");

      // token 认证已移除(全信模型):不再生成 token。token_hash 列保留(方案 B
      // 再删),插入占位值以满足 NOT NULL;响应不含任何 token 字段。
      const [participant] = await db
        .insert(participantTable)
        .values({
          name: input.name,
          device: input.device ?? null,
          tokenHash: "",
          capabilities: input.capabilities ?? [],
        })
        .returning();

      return c.json({
        id: participant.id,
        name: participant.name,
        device: participant.device,
        capabilities: participant.capabilities,
        createdAt: participant.createdAt,
      });
    },
  )
  .get(
    "/",
    describeRoute({
      description: "List all participants (tokenHash never exposed)",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {},
          },
        },
      },
    }),
    async (c) => {
      const db = c.get("db");
      const participants = await db
        .select({
          id: participantTable.id,
          name: participantTable.name,
          device: participantTable.device,
          capabilities: participantTable.capabilities,
          lastSeen: participantTable.lastSeen,
          createdAt: participantTable.createdAt,
        })
        .from(participantTable)
        .orderBy(desc(participantTable.createdAt));
      return c.json(participants);
    },
  )
  .patch(
    "/:id",
    participantIdentity,
    describeRoute({
      description:
        "Update a participant's registration (name/device); full-trust model — any claimed identity may patch any participant",
      responses: {
        200: {
          description: "Updated participant (tokenHash never exposed)",
          content: {
            "application/json": {},
          },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    zValidator(
      "json",
      z
        .object({
          name: z.string().min(1).optional(),
          // null 表示清空(与注册时 device 缺省归一为 null 一致)。
          device: z.string().nullable().optional(),
          // 自由能力标签 (ticket 17): 与注册同语义,逗号输入前端转数组后提交。
          capabilities: z.array(z.string()).max(64).optional(),
        })
        .refine(
          (v) =>
            v.name !== undefined ||
            v.device !== undefined ||
            v.capabilities !== undefined,
          { message: "at least one field to update is required" },
        ),
    ),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");

      // 全信模型:不再校验「持有者即本人」——任何声称的身份都可管理任意
      // participant 的注册信息。

      const patch: {
        name?: string;
        device?: string | null;
        capabilities?: string[];
      } = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.device !== undefined) patch.device = input.device ?? null;
      if (input.capabilities !== undefined) {
        patch.capabilities = input.capabilities;
      }

      const [updated] = await db
        .update(participantTable)
        .set(patch)
        .where(eq(participantTable.id, id))
        .returning({
          id: participantTable.id,
          name: participantTable.name,
          device: participantTable.device,
          capabilities: participantTable.capabilities,
          lastSeen: participantTable.lastSeen,
          createdAt: participantTable.createdAt,
        });
      if (!updated) {
        throw new BizError(BizCodeEnum.ParticipantNotFound);
      }

      return c.json(updated);
    },
  )
  .put(
    "/:id/heartbeat",
    participantIdentity,
    describeRoute({
      description:
        "Report presence: mark a participant online (writes last_seen)",
      responses: {
        200: {
          description: "lastSeen updated",
          content: {
            "application/json": {},
          },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");

      // 全信模型:不再校验「持有者即本人」,任何声称的身份都可上报心跳。

      const [updated] = await db
        .update(participantTable)
        .set({ lastSeen: new Date() })
        .where(eq(participantTable.id, id))
        .returning({ lastSeen: participantTable.lastSeen });
      if (!updated) {
        throw new BizError(BizCodeEnum.ParticipantNotFound);
      }

      return c.json({ lastSeen: updated.lastSeen });
    },
  )
  // 删除 participant(公开,局域网信任模型,与 POST / 注册一致):用于清掉旧身份 —
  // 重启桥后旧 participant 名(executor-bridge 等)仍在库里,需用此接口删除。participant
  // 是群成员关系(group_members)与消息(group_message)的外键父表,故在同一
  // 事务里先清其成员关系与消息(closure 行随消息级联删除),再删 participant 行。
  // 两类引用无法清理、会在删除时触发外键约束报错,先预检并返回明确的 409:
  //   - 该 participant 建过群(groups.created_by → participant.id);
  //   - 其他 participant 的消息以该 participant 的消息为父(parent_id 引用其消息)。
  .delete(
    "/:id",
    describeRoute({
      description:
        "Delete an participant by id (public, LAN trust model). Memberships and messages sent by the participant are removed in the same transaction so the foreign-key references do not block the deletion. Returns 409 if the participant created a group or its messages are referenced as parents by other messages",
      responses: {
        200: {
          description: "Participant deleted",
          content: {
            "application/json": {},
          },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");

      const deleted = await db.transaction(async (tx) => {
        // 建过群的 participant 不能删:groups.created_by 无 onDelete 动作,且群是
        // 被保留的数据,不会随身份删除。给出明确错误而不是裸 500。
        const [createdGroup] = await tx
          .select({ id: groupsTable.id })
          .from(groupsTable)
          .where(eq(groupsTable.createdBy, id))
          .limit(1);
        if (createdGroup) {
          throw new BizError(
            BizCodeEnum.Conflict,
            `participant 建过群(${createdGroup.id}),无法删除;请先移除/移交该群`,
          );
        }
        // 其他 participant 的消息以该 participant 的消息为父:删消息会违反 parent_id
        // 外键(无 onDelete 动作),预检并报 409。
        const [parentedChild] = await tx
          .select({ id: groupMessageTable.id })
          .from(groupMessageTable)
          .where(
            eq(
              groupMessageTable.parentId,
              sql`(select id from ${groupMessageTable} where sender_id = ${id} limit 1)`,
            ),
          )
          .limit(1);
        if (parentedChild) {
          throw new BizError(
            BizCodeEnum.Conflict,
            "该 participant 的消息被其他消息引用为父消息,无法删除",
          );
        }
        await tx
          .delete(groupMessageTable)
          .where(eq(groupMessageTable.senderId, id));
        await tx
          .delete(groupMemberTable)
          .where(eq(groupMemberTable.participantId, id));
        const [removed] = await tx
          .delete(participantTable)
          .where(eq(participantTable.id, id))
          .returning({ id: participantTable.id, name: participantTable.name });
        return removed;
      });
      if (!deleted) {
        throw new BizError(BizCodeEnum.ParticipantNotFound);
      }

      return c.json({ success: true, id: deleted.id, name: deleted.name });
    },
  );

export default app;
