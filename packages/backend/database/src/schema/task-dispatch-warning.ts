import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";
import { groups } from "./group.js";
import { participant } from "./participant.js";
import { task } from "./task.js";

/**
 * Durable self-dispatch warning inbox entries. One self-dispatch task can warn
 * every reviewer in its group; the task itself owns the full audit context.
 */
export const taskDispatchWarning = pgTable(
  "task_dispatch_warning",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    taskId: uuid("task_id")
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    recipientParticipantId: uuid("recipient_participant_id")
      .notNull()
      .references(() => participant.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.taskId, t.recipientParticipantId),
    index().on(t.recipientParticipantId, t.createdAt),
  ],
);

export type TaskDispatchWarning = typeof taskDispatchWarning.$inferSelect;
