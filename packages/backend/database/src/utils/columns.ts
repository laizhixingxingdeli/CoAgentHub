import { timestamp } from "drizzle-orm/pg-core";

type CreatedAt = ReturnType<typeof makeCreatedAt>;
type UpdatedAt = ReturnType<typeof makeUpdatedAt>;

function makeCreatedAt() {
  return timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
}

function makeUpdatedAt() {
  return timestamp("updated_at", { withTimezone: true }).$onUpdate(
    () => new Date(),
  );
}

/**
 * Standard audit timestamps for a table.
 * - "create-only": only `created_at` (immutable rows)
 * - "update-only": only `updated_at`
 * - "both" (default): both columns, with `updated_at` refreshed on update
 */
export function timeColumns(mode: "both"): {
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
};
export function timeColumns(mode: "create-only"): { createdAt: CreatedAt };
export function timeColumns(mode: "update-only"): { updatedAt: UpdatedAt };
export function timeColumns(
  mode: "both" | "create-only" | "update-only" = "both",
) {
  const createdAt = makeCreatedAt();
  const updatedAt = makeUpdatedAt();
  if (mode === "create-only") return { createdAt };
  if (mode === "update-only") return { updatedAt };
  return { createdAt, updatedAt };
}
