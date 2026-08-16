import type { groups as groupsTable } from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import type { DataBase } from "@server/lib/database";

/**
 * 群路由共享守卫与工具:被 groups/members/messages/tasks 四个子路由复用。
 */

/**
 * 归档/软删群只读守卫:非 active 群的一切写操作返回 403 + 原因(历史仍可读,
 * GET 端点不做此检查)。返回群行供调用方复用,避免二次查询。
 */
export async function assertGroupWritable(
  db: DataBase,
  groupId: string,
): Promise<typeof groupsTable.$inferSelect> {
  const group = await db.query.groups.findFirst({
    where: (t, { eq }) => eq(t.id, groupId),
  });
  if (!group) {
    throw new BizError(BizCodeEnum.GroupNotFound);
  }
  if (group.status !== "active") {
    throw new BizError(
      BizCodeEnum.Forbidden,
      group.status === "archived" ? "群已归档,只读" : "群已删除,只读",
    );
  }
  return group;
}
