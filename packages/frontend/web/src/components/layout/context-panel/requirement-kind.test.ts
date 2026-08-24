import { describe, expect, it } from "vitest";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";
import type { Requirement } from "./group-tasks-by-spec";
import {
  countRequirementsByKind,
  filterRequirementsByKind,
  requirementKindOf,
} from "./requirement-kind";

/** 构造一条 Requirement(只需归类逻辑用到的字段)。 */
function makeRequirement(
  id: string,
  dispatchKind: Requirement["dispatchKind"],
): Requirement {
  const task = {
    id,
    status: "done",
    dispatchKind,
  } as unknown as TaskItem;
  return {
    id,
    specRef: `specs/${id}.md`,
    tasks: [task],
    latestTask: task,
    status: "done",
    dispatchKind,
    retryCount: 0,
    updatedAt: "2026-08-01T00:00:00.000Z",
    label: id,
    steps: ["done", "done", "done"],
  };
}

describe("requirementKindOf 归类(requirement-list-kind-tabs R1/R2)", () => {
  it("dispatchKind === fix → 修复", () => {
    expect(requirementKindOf(makeRequirement("f", "fix"))).toBe("fix");
  });

  it("dispatchKind === requirement → 需求", () => {
    expect(requirementKindOf(makeRequirement("r", "requirement"))).toBe(
      "requirement",
    );
  });

  it("dispatchKind 为 null(历史任务)→ 按需求处理,不开第三标签", () => {
    expect(requirementKindOf(makeRequirement("old", null))).toBe("requirement");
  });
});

describe("filterRequirementsByKind 过滤", () => {
  it("按标签过滤,返回新数组", () => {
    const req = makeRequirement("r", "requirement");
    const fix = makeRequirement("f", "fix");
    const legacy = makeRequirement("old", null);
    const all = [req, fix, legacy];

    expect(filterRequirementsByKind(all, "requirement")).toEqual([req, legacy]);
    expect(filterRequirementsByKind(all, "fix")).toEqual([fix]);
    expect(filterRequirementsByKind([], "requirement")).toEqual([]);
  });

  it("不改动原数组", () => {
    const all = [
      makeRequirement("r", "requirement"),
      makeRequirement("f", "fix"),
    ];
    filterRequirementsByKind(all, "fix");
    expect(all).toHaveLength(2);
  });
});

describe("countRequirementsByKind 计数", () => {
  it("null 计入「需求」计数", () => {
    const all = [
      makeRequirement("r1", "requirement"),
      makeRequirement("old", null),
      makeRequirement("f1", "fix"),
      makeRequirement("f2", "fix"),
    ];
    expect(countRequirementsByKind(all)).toEqual({
      requirement: 2,
      fix: 2,
    });
  });

  it("空列表计数为 0", () => {
    expect(countRequirementsByKind([])).toEqual({ requirement: 0, fix: 0 });
  });
});
