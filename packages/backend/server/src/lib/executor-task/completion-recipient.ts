import type { Task } from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";

/**
 * 完成事件收件人裁定(R1,specs/l3-request-delivery-and-scope.md)。
 *
 * 投递对象由**载荷**决定,不由下发者决定:
 *  - 终态 diffSummary 带 `review_request` → 收件人是群内 reviewer 成员;
 *  - 其余完成事件 → 收件人仍是下发者(既有行为逐字不变);
 *  - 群内无 reviewer 成员 → 不改写收件人,回落下发者(R3 反向守卫已禁止这种
 *    组合携带 review_request,这里是防御性兜底,不是新的判定权威)。
 *
 * 群内多个 reviewer → 全部投递(每人一条事件)。
 *
 * 裁定只发生在应用层:trigger 仅搬运 task.recipient_participant_ids,不查
 * group_members、不理解角色 —— 角色语义不允许出现第二个权威源。
 */

/** 群内 reviewer 角色成员的 participant id(按成员行顺序,去重)。 */
export async function reviewerMemberIds(
  db: DataBase,
  groupId: string,
): Promise<string[]> {
  const members = await db.query.groupMember.findMany({
    where: (t, { eq }) => eq(t.groupId, groupId),
    columns: { participantId: true, roles: true },
  });
  return [
    ...new Set(
      members
        .filter((m) => m.roles.includes("reviewer"))
        .map((m) => m.participantId),
    ),
  ];
}

/** 下发者作为收件人的兜底集合;无下发者时为空(trigger 此时不产生事件)。 */
export function dispatcherRecipients(
  dispatcherParticipantId: string | null,
): string[] {
  return dispatcherParticipantId === null ? [] : [dispatcherParticipantId];
}

/** 群内带 review_request 时的收件人:全部 reviewer;无 reviewer → 回落下发者。 */
export async function reviewRequestRecipients(
  db: DataBase,
  groupId: string,
  dispatcherParticipantId: string | null,
): Promise<string[]> {
  const reviewers = await reviewerMemberIds(db, groupId);
  return reviewers.length > 0
    ? reviewers
    : dispatcherRecipients(dispatcherParticipantId);
}

/**
 * 任务行已裁定的收件人(R4 并入守卫用)。
 * 未裁定(历史行 / 非 PATCH 终态路径)的语义与 trigger 的回落逐字一致:下发者。
 */
export function adjudicatedRecipientsOfTask(task: Task): string[] {
  if (task.recipientParticipantIds !== null) {
    return [...task.recipientParticipantIds];
  }
  return dispatcherRecipients(task.dispatcherParticipantId);
}

/** 收件人集合是否相同(顺序无关、重名不重复计数)。 */
export function sameRecipients(
  a: readonly string[],
  b: readonly string[],
): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...right].every((id) => left.has(id));
}
