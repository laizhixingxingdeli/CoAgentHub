/**
 * Visibility routing — the single source of truth for who may see a group
 * message. Two representations of the same rule live here:
 *
 *  - `isMessageVisibleToMember` (JS) — used where messages are already in
 *    memory (webhook/WS fan-out, per-member filtering).
 *  - `messageVisibleToMemberSql` (SQL) — used to push the filter into the
 *    database for list queries, so pagination happens over the *visible*
 *    stream instead of fetching everything and filtering in JS.
 *
 * A message is visible to a member iff:
 *   - the member is the sender (always sees own messages), or
 *   - the member holds the `human` role (the user watches everything), or
 *   - audience = broadcast, or
 *   - audience = role and audienceRef ∈ member's roles in this group, or
 *   - audience = participant and audienceRef = member's id.
 *
 * `visibility-sql.test.ts` asserts both representations agree on the same data.
 */

import { groupMessage as groupMessageTable } from "@laizhixingxingdeli/database/schema";
import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";

export interface GroupMessageView {
  senderId: string;
  audience: "broadcast" | "role" | "participant";
  audienceRef: string | null;
}

export interface GroupMemberView {
  participantId: string;
  roles: string[];
}

export function isMessageVisibleToMember(
  message: GroupMessageView,
  member: GroupMemberView,
): boolean {
  if (member.participantId === message.senderId) return true;
  if (member.roles.includes("human")) return true;
  switch (message.audience) {
    case "broadcast":
      return true;
    case "role":
      return (
        message.audienceRef !== null &&
        member.roles.includes(message.audienceRef)
      );
    case "participant":
      return message.audienceRef === member.participantId;
    default:
      return false;
  }
}

/**
 * SQL predicate equivalent to `isMessageVisibleToMember` for one requester.
 * `roles` are the requester's roles inside the group (already loaded by the
 * route); when the requester is `human` the predicate is simply true.
 */
export function messageVisibleToMemberSql(
  participantId: string,
  roles: string[],
): SQL | undefined {
  if (roles.includes("human")) {
    return sql`true`;
  }
  return or(
    eq(groupMessageTable.senderId, participantId),
    eq(groupMessageTable.audience, "broadcast"),
    and(
      eq(groupMessageTable.audience, "role"),
      inArray(groupMessageTable.audienceRef, roles),
    ),
    and(
      eq(groupMessageTable.audience, "participant"),
      eq(groupMessageTable.audienceRef, participantId),
    ),
  );
}

/** The set of member ids to whom `message` is visible, per the rule above. */
export function visibleMemberIds(
  message: GroupMessageView,
  members: GroupMemberView[],
): Set<string> {
  const ids = new Set<string>();
  for (const member of members) {
    if (isMessageVisibleToMember(message, member)) {
      ids.add(member.participantId);
    }
  }
  return ids;
}
