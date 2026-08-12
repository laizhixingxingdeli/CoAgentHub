/**
 * Visibility routing — the single source of truth for who may see a group
 * message (agent-groups spec: "Visibility rule"), shared by the GET messages
 * endpoint (per requester) and the webhook notifier (per member list).
 * Keeping the rule in one pure function here prevents the two call sites from
 * drifting apart.
 *
 * A message is visible to a member iff:
 *   - the member is the sender (always sees own messages), or
 *   - the member holds the `human` role (the user watches everything), or
 *   - audience = broadcast, or
 *   - audience = role and audienceRef ∈ member's roles in this group, or
 *   - audience = agent and audienceRef = member's id.
 */

export interface GroupMessageView {
  senderId: string;
  audience: "broadcast" | "role" | "agent";
  audienceRef: string | null;
}

export interface GroupMemberView {
  agentId: string;
  roles: string[];
}

export function isMessageVisibleToMember(
  message: GroupMessageView,
  member: GroupMemberView,
): boolean {
  if (member.agentId === message.senderId) return true;
  if (member.roles.includes("human")) return true;
  switch (message.audience) {
    case "broadcast":
      return true;
    case "role":
      return (
        message.audienceRef !== null &&
        member.roles.includes(message.audienceRef)
      );
    case "agent":
      return message.audienceRef === member.agentId;
    default:
      return false;
  }
}

/** The set of member ids to whom `message` is visible, per the rule above. */
export function visibleMemberIds(
  message: GroupMessageView,
  members: GroupMemberView[],
): Set<string> {
  const ids = new Set<string>();
  for (const member of members) {
    if (isMessageVisibleToMember(message, member)) {
      ids.add(member.agentId);
    }
  }
  return ids;
}
