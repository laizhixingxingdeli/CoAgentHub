/** 视觉分色用的角色档位(不是后端权威角色,仅用于头像配色)。 */
export type TimelineRole = "coordinator" | "reviewer" | "executor";

/** Member.roles → 角色档位(协调者 > 检视者 > 执行者 优先级;都不含 → null,
 * 由调用方决定回落)。human/observer/specialist 等角色不在三档内 → null。 */
export function roleFromMemberRoles(
  roles: string[] | undefined,
): TimelineRole | null {
  if (!roles) {
    return null;
  }
  const lower = roles.map((r) => r.toLowerCase());
  if (lower.includes("coordinator")) return "coordinator";
  if (lower.includes("reviewer")) return "reviewer";
  if (lower.includes("executor")) return "executor";
  return null;
}
