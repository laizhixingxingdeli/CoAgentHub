/**
 * 需求列表的「需求 / 修复」二态归类(requirement-list-kind-tabs spec):
 * - 单条需求的归类看 `dispatchKind`:历史任务与尚未走通新字段的任务为 null,
 *   按既定原则(宁可多检不可漏检)**归入「需求」**,不开第三个标签;
 * - 一条需求组的 `dispatchKind` 取组内最新任务(group-tasks-by-spec 已保证),
 *   本文件只做归类 / 过滤 / 计数,不改分组算法。
 */

import type { Requirement } from "./group-tasks-by-spec";

/** 需求列表的二态标签。 */
export type RequirementKind = "requirement" | "fix";

/** 单条需求的归类:null dispatchKind 按 requirement 处理。 */
export function requirementKindOf(requirement: Requirement): RequirementKind {
  return requirement.dispatchKind === "fix" ? "fix" : "requirement";
}

/** 按归类过滤需求列表,返回新数组。 */
export function filterRequirementsByKind(
  requirements: readonly Requirement[],
  kind: RequirementKind,
): Requirement[] {
  return requirements.filter(
    (requirement) => requirementKindOf(requirement) === kind,
  );
}

/** 两个标签各自的计数(与当前选中标签无关,标签始终可见)。 */
export function countRequirementsByKind(
  requirements: readonly Requirement[],
): Record<RequirementKind, number> {
  let requirement = 0;
  let fix = 0;
  for (const item of requirements) {
    if (requirementKindOf(item) === "fix") {
      fix += 1;
    } else {
      requirement += 1;
    }
  }
  return { requirement, fix };
}
