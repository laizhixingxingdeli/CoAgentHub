import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { v7 as uuidv7 } from "uuid";
import { timeColumns } from "../utils/columns.js";
import { agent } from "./agent.js";

/**
 * Preset role catalog assigned per group membership (agent-groups spec:
 * "Identity & roles"). One agent may hold multiple roles, and the same agent
 * can hold different roles in different groups.
 */
export const GROUP_ROLES = [
  "human", // the user; sees everything, can publish commands
  "coordinator", // dispatches tasks, decides review adoption, owns groups
  "reviewer", // inspects task drafts, replies with corrections
  "executor", // executes the final task, posts results
  "observer", // read-only monitoring of a group
  "specialist", // domain expert (e.g. model-training agent)
] as const;
export type GroupRole = (typeof GROUP_ROLES)[number];

/**
 * Groups — one task's shared context, superseding the single-user
 * conversation. Table name is plural ("groups") because `group` is a
 * PostgreSQL reserved keyword.
 */
export const groups = pgTable("groups", {
  id: uuid("id").primaryKey().$defaultFn(uuidv7),
  title: text("title").notNull(), // task name
  // active | archived | deleted — the lifecycle is active -> archived
  // (archive) / archived -> active (unarchive); deleted is a soft-delete
  // terminal state (rows are kept, groups are hidden from lists).
  status: text("status").notNull().default("active"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => agent.id),
  ...timeColumns("both"),
});

/** Group membership: per-group role assignment, one row per (group, agent). */
export const groupMember = pgTable(
  "group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agent.id),
    roles: text("roles").array().notNull(),
    // 群内分工说明(角色解绑):描述该 agent 在本群的分工,定向调度时拼进任务书。
    prompt: text("prompt"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.agentId] })],
);

export const Group = createSelectSchema(groups);
export type Group = typeof groups.$inferSelect;
export const NewGroup = createInsertSchema(groups);
export type NewGroup = typeof groups.$inferInsert;

export const GroupMember = createSelectSchema(groupMember);
export type GroupMember = typeof groupMember.$inferSelect;
export const NewGroupMember = createInsertSchema(groupMember);
export type NewGroupMember = typeof groupMember.$inferInsert;
