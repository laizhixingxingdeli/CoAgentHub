import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { v7 as uuidv7 } from "uuid";
import { timeColumns } from "../utils/columns.js";

/**
 * 持久化的执行器配置(接入 Agent 界面, ticket: 网页 @executor 发布):
 * 每一条 = 一个可被定向消息调度的执行器(与 lib/executors.ts 的
 * DEFAULT_EXECUTORS 内置配置合并构成 effectiveExecutors)。
 *
 * 字段约定:
 *  - key: 唯一键,写入 task.executor_key(与内置配置的 key 同语义);
 *  - agent_name: 对应注册到 agent 表的展示名(名字唯一);
 *  - kind: cli=本地 spawn / a2a=经 A2A gateway 远程调用;
 *  - bin: cli 的执行命令(或 a2a 时的占位标识);
 *  - url: a2a 时的 gateway 基地址;
 *  - args: cli 的参数模板(如 ["-y","-p","{ticket}"])。
 * token 不落库、不返回前端:注册 agent 的 token 由 server 后端生成并写入
 * scripts/.executor-agents.json(见 ensureExecutorAgents)。
 */
export const executorConfig = pgTable("executor_config", {
  id: uuid("id").primaryKey().$defaultFn(uuidv7),
  key: text("key").notNull().unique(),
  agentName: text("agent_name").notNull().unique(),
  type: text("type").notNull(), // hermes | atomcode | openclaw | human | custom
  kind: text("kind").notNull().default("cli"), // cli | a2a
  bin: text("bin").notNull(),
  url: text("url"),
  args: jsonb("args").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  label: text("label").notNull(),
  ...timeColumns("both"),
});

export const ExecutorConfig = createSelectSchema(executorConfig);
export type ExecutorConfig = typeof executorConfig.$inferSelect;
export const NewExecutorConfig = createInsertSchema(executorConfig);
export type NewExecutorConfig = typeof executorConfig.$inferInsert;
