import type { DataBase } from "@server/lib/database";

/**
 * L3 review_request 携带判定(R3 反向守卫共用判定):任务书 buildReportSection
 * 与 tasks.ts PATCH 终态守卫共用同一判定,避免两处漂移 —— 任务书不能教协调者
 * 携带一个 PATCH 终态会被 400 拒收的载荷。
 *
 * v4.1(spec §3.14.6):本谓词裁定的事实是「群成员构成是否允许独立 L3」——
 * 仅当群内有 reviewer 成员(无 reviewer 时两层编制不跑 L3)。
 * `dispatchKind` 只**选择深度**(requirement=完整档,fix=精简档,见载荷
 * 可选布尔 `lite`),不决定是否携带;它作为参数保留只为调用方显式记录
 * 本票工作类型,不参与裁定。dispatchKind=null 的历史行行为保持允许
 * (由 groupHasReviewer 单独裁定)。
 */
export function reviewRequestCarryAllowed(
  _dispatchKind: "requirement" | "fix" | null,
  groupHasReviewer: boolean,
): boolean {
  return groupHasReviewer;
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
