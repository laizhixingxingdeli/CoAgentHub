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
 *   - the member's participant type is `human` (the user watches everything;
 *     membership is not required — the Local User may not hold a membership
 *     row), or
 *   - the member is the sender (always sees own messages), or
 *   - the member holds the `human` role (legacy role-based rule), or
 *   - audience = broadcast, or
 *   - audience = role and audienceRef ∈ member's roles in this group, or
 *   - audience = participant and audienceRef = member's id.
 *
 * `participantType` is supplied by the caller (routes / ws-hub): the Local
 * User resolves to `"human"`, everything else is `undefined`. The participant
 * table no longer carries a type column (migration 0006 dropped it), so the
 * type is an identity-level fact the caller already knows — not a stored
 * attribute — and both representations take it as a plain parameter.
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

/** 参与者类型(调用处判定后传入):`human` = 人类观察者,无条件全可见。 */
export type ParticipantType = "human" | "executor" | "custom";

export function isMessageVisibleToMember(
  message: GroupMessageView,
  member: GroupMemberView,
  participantType?: ParticipantType,
): boolean {
  // 参与者 type=human:无条件可见(先于成员/audience 判定,不要求是群成员)。
  if (participantType === "human") return true;
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
 * route); when the requester is `human` (by type or role) the predicate is
 * simply true.
 */
export function messageVisibleToMemberSql(
  participantId: string,
  roles: string[],
  participantType?: ParticipantType,
): SQL | undefined {
  if (participantType === "human" || roles.includes("human")) {
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

/**
 * The set of member ids to whom `message` is visible, per the rule above.
 * `participantTypeById` lets the caller mark specific participants as `human`
 * (e.g. the Local User) even though they may not hold the human role.
 */
export function visibleMemberIds(
  message: GroupMessageView,
  members: GroupMemberView[],
  participantTypeById?: ReadonlyMap<string, ParticipantType>,
): Set<string> {
  const ids = new Set<string>();
  for (const member of members) {
    if (
      isMessageVisibleToMember(
        message,
        member,
        participantTypeById?.get(member.participantId),
      )
    ) {
      ids.add(member.participantId);
    }
  }
  return ids;
}
