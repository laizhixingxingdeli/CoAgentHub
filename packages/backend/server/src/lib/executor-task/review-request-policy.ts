import type { DataBase } from "@server/lib/database";

/**
 * L3 review_request 携带判定(R3 反向守卫共用判定):任务书 buildReportSection
 * 与 tasks.ts PATCH 终态守卫共用同一判定,避免两处漂移 —— 任务书不能教协调者
 * 携带一个 PATCH 终态会被 400 拒收的载荷。
 *
 * 允许携带 review_request 仅当:
 *  - dispatchKind 非 'fix'(fix 票复用已过 L3 的冻结 spec,不产生新的架构面);
 *  - 群内有 reviewer 成员(无 reviewer 时两层编制不跑 L3)。
 * dispatchKind 为 null 的历史行保守按 requirement 处理(允许),与
 * tasks.ts shouldWalkL3 的 null 处理逐字一致。
 */
export function reviewRequestCarryAllowed(
  dispatchKind: "requirement" | "fix" | null,
  groupHasReviewer: boolean,
): boolean {
  return dispatchKind !== "fix" && groupHasReviewer;
}

/** 群内是否存在 reviewer 角色成员(R3 共用判定的输入;任务书与守卫同源查询)。 */
export async function groupHasReviewerMember(
  db: DataBase,
  groupId: string,
): Promise<boolean> {
  const members = await db.query.groupMember.findMany({
    where: (t, { eq }) => eq(t.groupId, groupId),
    columns: { roles: true },
  });
  return members.some((m) => m.roles.includes("reviewer"));
}
