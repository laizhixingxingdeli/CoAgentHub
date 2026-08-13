import { zValidator } from "@hono/zod-validator";
import {
  agent as agentTable,
  groupMember as groupMemberTable,
  groupMessage as groupMessageTable,
  groups as groupsTable,
} from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import { generateAgentToken, hashAgentToken } from "@server/lib/agent-token";
import db, { type DataBase } from "@server/lib/database";
import { agentAuth } from "@server/middleware/agent-auth";
import { desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";

// 注册(公开)与自管理(agentAuth)并存:POST / 不挂鉴权 —— 首次注册必须先于
// token 存在;PATCH / 与 PUT /heartbeat 单独挂 agentAuth,并校验持有者即 :id
// 本人(token 只能管理自己的注册信息)。
const app = new Hono<{ Variables: { db: DataBase; agentId: string } }>();

app.use(async (c, next) => {
  c.set("db", db);
  await next();
});

app
  .post(
    "/",
    describeRoute({
      description: "Register a new agent",
      responses: {
        200: {
          description: "Agent created; token shown exactly once",
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
        type: z.string().min(1), // hermes | atomcode | openclaw | human | custom
        device: z.string().optional(),
        webhookUrl: z.string().url().optional(),
        // 自由能力标签 (ticket 17): 缺省空数组;仅存储,轻量校验放在加成员处。
        capabilities: z.array(z.string()).max(64).optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const input = c.req.valid("json");

      // The token is generated server-side and returned in plaintext exactly
      // once; only its SHA-256 hash is persisted. The response is built
      // field-by-field so tokenHash can never leak into it.
      const token = generateAgentToken();
      const [agent] = await db
        .insert(agentTable)
        .values({
          name: input.name,
          type: input.type,
          device: input.device ?? null,
          tokenHash: hashAgentToken(token),
          webhookUrl: input.webhookUrl ?? null,
          capabilities: input.capabilities ?? [],
        })
        .returning();

      return c.json({
        id: agent.id,
        name: agent.name,
        type: agent.type,
        device: agent.device,
        webhookUrl: agent.webhookUrl,
        capabilities: agent.capabilities,
        createdAt: agent.createdAt,
        token,
      });
    },
  )
  .get(
    "/",
    describeRoute({
      description: "List all agents (tokenHash never exposed)",
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
      const agents = await db
        .select({
          id: agentTable.id,
          name: agentTable.name,
          type: agentTable.type,
          device: agentTable.device,
          webhookUrl: agentTable.webhookUrl,
          capabilities: agentTable.capabilities,
          lastSeen: agentTable.lastSeen,
          createdAt: agentTable.createdAt,
        })
        .from(agentTable)
        .orderBy(desc(agentTable.createdAt));
      return c.json(agents);
    },
  )
  .patch(
    "/:id",
    agentAuth,
    describeRoute({
      description:
        "Update the caller's own registration (name/device/webhookUrl); the token holder may only patch their own agent",
      responses: {
        200: {
          description: "Updated agent (tokenHash never exposed)",
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
          // null 与 webhookUrl 一样表示清空(与注册时 device 缺省归一为 null 一致)。
          device: z.string().nullable().optional(),
          // null 表示清空 webhookUrl。
          webhookUrl: z.string().url().nullable().optional(),
          // 自由能力标签 (ticket 17): 与注册同语义,逗号输入前端转数组后提交。
          capabilities: z.array(z.string()).max(64).optional(),
        })
        .refine(
          (v) =>
            v.name !== undefined ||
            v.device !== undefined ||
            v.webhookUrl !== undefined ||
            v.capabilities !== undefined,
          { message: "at least one field to update is required" },
        ),
    ),
    async (c) => {
      const db = c.get("db");
      const agentId = c.get("agentId");
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");

      // The token holder may only manage their own registration.
      if (agentId !== id) {
        throw new BizError(BizCodeEnum.Forbidden);
      }

      const patch: {
        name?: string;
        device?: string | null;
        webhookUrl?: string | null;
        capabilities?: string[];
      } = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.device !== undefined) patch.device = input.device ?? null;
      if (input.webhookUrl !== undefined) patch.webhookUrl = input.webhookUrl;
      if (input.capabilities !== undefined) {
        patch.capabilities = input.capabilities;
      }

      const [updated] = await db
        .update(agentTable)
        .set(patch)
        .where(eq(agentTable.id, id))
        .returning({
          id: agentTable.id,
          name: agentTable.name,
          type: agentTable.type,
          device: agentTable.device,
          webhookUrl: agentTable.webhookUrl,
          capabilities: agentTable.capabilities,
          lastSeen: agentTable.lastSeen,
          createdAt: agentTable.createdAt,
        });
      if (!updated) {
        throw new BizError(BizCodeEnum.AgentNotFound);
      }

      return c.json(updated);
    },
  )
  .put(
    "/:id/heartbeat",
    agentAuth,
    describeRoute({
      description:
        "Report presence: the token holder marks itself online (writes last_seen)",
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
      const agentId = c.get("agentId");
      const { id } = c.req.valid("param");

      // Only the token holder may report its own presence.
      if (agentId !== id) {
        throw new BizError(BizCodeEnum.Forbidden);
      }

      const [updated] = await db
        .update(agentTable)
        .set({ lastSeen: new Date() })
        .where(eq(agentTable.id, id))
        .returning({ lastSeen: agentTable.lastSeen });
      if (!updated) {
        throw new BizError(BizCodeEnum.AgentNotFound);
      }

      return c.json({ lastSeen: updated.lastSeen });
    },
  )
  // 重置 token(公开,无 agentAuth):与 POST / 注册一致 —— 首次绑定前用户
  // 尚无任何 token,必须能无鉴权取回(ticket 29 局域网信任模型)。库中只存
  // SHA-256 哈希,无法还原明文,故采用「重置」而非「查」:生成新 token →
  // 覆盖存储哈希,明文仅此一次返回;旧 token 立即失效。
  .post(
    "/:id/reset-token",
    describeRoute({
      description:
        "Reset an agent's token: generate a new token, store its hash, and return the plaintext exactly once (old token invalidated)",
      responses: {
        200: {
          description: "New token shown exactly once",
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

      const token = generateAgentToken();
      const [updated] = await db
        .update(agentTable)
        .set({ tokenHash: hashAgentToken(token) })
        .where(eq(agentTable.id, id))
        .returning({ id: agentTable.id, name: agentTable.name });
      if (!updated) {
        throw new BizError(BizCodeEnum.AgentNotFound);
      }

      return c.json({ id: updated.id, name: updated.name, token });
    },
  )
  // 删除 agent(公开,局域网信任模型,与 POST / 注册一致):用于清掉旧身份 —
  // 重启桥后旧 agent 名(executor-bridge 等)仍在库里,需用此接口删除。agent
  // 是群成员关系(group_members)与消息(group_message)的外键父表,故在同一
  // 事务里先清其成员关系与消息(closure 行随消息级联删除),再删 agent 行。
  // 两类引用无法清理、会在删除时触发外键约束报错,先预检并返回明确的 409:
  //   - 该 agent 建过群(groups.created_by → agent.id);
  //   - 其他 agent 的消息以该 agent 的消息为父(parent_id 引用其消息)。
  .delete(
    "/:id",
    describeRoute({
      description:
        "Delete an agent by id (public, LAN trust model). Memberships and messages sent by the agent are removed in the same transaction so the foreign-key references do not block the deletion. Returns 409 if the agent created a group or its messages are referenced as parents by other messages",
      responses: {
        200: {
          description: "Agent deleted",
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
        // 建过群的 agent 不能删:groups.created_by 无 onDelete 动作,且群是
        // 被保留的数据,不会随身份删除。给出明确错误而不是裸 500。
        const [createdGroup] = await tx
          .select({ id: groupsTable.id })
          .from(groupsTable)
          .where(eq(groupsTable.createdBy, id))
          .limit(1);
        if (createdGroup) {
          throw new BizError(
            BizCodeEnum.Conflict,
            `agent 建过群(${createdGroup.id}),无法删除;请先移除/移交该群`,
          );
        }
        // 其他 agent 的消息以该 agent 的消息为父:删消息会违反 parent_id
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
            "该 agent 的消息被其他消息引用为父消息,无法删除",
          );
        }
        await tx
          .delete(groupMessageTable)
          .where(eq(groupMessageTable.senderId, id));
        await tx
          .delete(groupMemberTable)
          .where(eq(groupMemberTable.agentId, id));
        const [removed] = await tx
          .delete(agentTable)
          .where(eq(agentTable.id, id))
          .returning({ id: agentTable.id, name: agentTable.name });
        return removed;
      });
      if (!deleted) {
        throw new BizError(BizCodeEnum.AgentNotFound);
      }

      return c.json({ success: true, id: deleted.id, name: deleted.name });
    },
  );

export default app;
