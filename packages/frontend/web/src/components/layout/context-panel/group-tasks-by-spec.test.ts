import { describe, expect, it } from "vitest";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";
import {
  deriveLabel,
  groupTasksBySpec,
  stepStatusFromTask,
} from "./group-tasks-by-spec";

/** 构造最小可用的 TaskItem,只填分组/排序/展示所需的字段。 */
function makeTask(overrides: Partial<TaskItem> & { id: string }): TaskItem {
  return {
    groupId: "group-1",
    messageId: "msg-1",
    executorParticipantId: "participant-1",
    executorKey: "codebuddy",
    status: "done",
    checkpointRef: null,
    specRef: null,
    specHash: null,
    diffSummary: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("groupTasksBySpec", () => {
  it("同 specRef(非 null)的多个任务聚合为一条 Requirement", () => {
    const tasks = [
      makeTask({
        id: "t-1",
        specRef: "specs/auth/login.md",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      makeTask({
        id: "t-2",
        specRef: "specs/auth/login.md",
        createdAt: "2026-08-01T01:00:00.000Z",
      }),
      makeTask({
        id: "t-3",
        specRef: "specs/auth/login.md",
        createdAt: "2026-08-01T02:00:00.000Z",
      }),
    ];
    const reqs = groupTasksBySpec(tasks);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].id).toBe("specs/auth/login.md");
    expect(reqs[0].tasks.map((t) => t.id)).toEqual(["t-1", "t-2", "t-3"]);
  });

  it("不同 specRef 各自独立成一条", () => {
    const tasks = [
      makeTask({
        id: "a",
        specRef: "specs/a.md",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      makeTask({
        id: "b",
        specRef: "specs/b.md",
        createdAt: "2026-08-01T01:00:00.000Z",
      }),
    ];
    const reqs = groupTasksBySpec(tasks);
    expect(reqs).toHaveLength(2);
    expect(reqs.map((r) => r.id).sort()).toEqual(["specs/a.md", "specs/b.md"]);
  });

  it("specRef 为 null 的任务各自独立成一条(不强行归并)", () => {
    const tasks = [
      makeTask({
        id: "x",
        specRef: null,
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      makeTask({
        id: "y",
        specRef: null,
        createdAt: "2026-08-01T01:00:00.000Z",
      }),
    ];
    const reqs = groupTasksBySpec(tasks);
    expect(reqs).toHaveLength(2);
    // null 任务用自身 id 作分组键
    expect(reqs.map((r) => r.id).sort()).toEqual(["x", "y"]);
  });

  it("混合:有 specRef 的归并、null 的各自独立", () => {
    const tasks = [
      makeTask({
        id: "s1",
        specRef: "specs/shared.md",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      makeTask({
        id: "s2",
        specRef: "specs/shared.md",
        createdAt: "2026-08-01T03:00:00.000Z",
      }),
      makeTask({
        id: "n1",
        specRef: null,
        createdAt: "2026-08-01T01:00:00.000Z",
      }),
      makeTask({
        id: "n2",
        specRef: null,
        createdAt: "2026-08-01T02:00:00.000Z",
      }),
    ];
    const reqs = groupTasksBySpec(tasks);
    expect(reqs).toHaveLength(3);
    // 顺序按各组「最新任务」createdAt 正序:shared 的最新是 t-2(03:00)→ 最后。
    expect(reqs.map((r) => r.id)).toEqual(["n1", "n2", "specs/shared.md"]);
  });

  it("组内 tasks 按 createdAt 升序,latestTask / status / updatedAt 取最新任务", () => {
    const tasks = [
      makeTask({
        id: "old",
        specRef: "specs/r.md",
        status: "done",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:05:00.000Z",
      }),
      makeTask({
        id: "new",
        specRef: "specs/r.md",
        status: "failed",
        createdAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-01T10:05:00.000Z",
      }),
    ];
    const reqs = groupTasksBySpec(tasks);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].tasks.map((t) => t.id)).toEqual(["old", "new"]);
    expect(reqs[0].latestTask.id).toBe("new");
    expect(reqs[0].status).toBe("failed");
    expect(reqs[0].updatedAt).toBe("2026-08-01T10:05:00.000Z");
  });

  it("聚合后 status 取最新 task 的状态(非最早)", () => {
    const tasks = [
      makeTask({
        id: "a",
        specRef: "specs/r.md",
        status: "failed",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      makeTask({
        id: "b",
        specRef: "specs/r.md",
        status: "done",
        createdAt: "2026-08-01T05:00:00.000Z",
      }),
    ];
    const reqs = groupTasksBySpec(tasks);
    expect(reqs[0].status).toBe("done");
  });

  it("分组结果按最新任务 createdAt 正序排列(最新的在数组最后)", () => {
    const tasks = [
      makeTask({
        id: "early",
        specRef: "specs/early.md",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      makeTask({
        id: "late",
        specRef: "specs/late.md",
        createdAt: "2026-08-05T00:00:00.000Z",
      }),
      makeTask({
        id: "mid",
        specRef: "specs/mid.md",
        createdAt: "2026-08-03T00:00:00.000Z",
      }),
    ];
    const reqs = groupTasksBySpec(tasks);
    expect(reqs.map((r) => r.id)).toEqual([
      "specs/early.md",
      "specs/mid.md",
      "specs/late.md",
    ]);
  });

  it("steps 占位:步数 = 任务数,每步状态套用对应任务状态", () => {
    const tasks = [
      makeTask({
        id: "a",
        specRef: "specs/r.md",
        status: "done",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      makeTask({
        id: "b",
        specRef: "specs/r.md",
        status: "running",
        createdAt: "2026-08-01T01:00:00.000Z",
      }),
      makeTask({
        id: "c",
        specRef: "specs/r.md",
        status: "failed",
        createdAt: "2026-08-01T02:00:00.000Z",
      }),
    ];
    const reqs = groupTasksBySpec(tasks);
    expect(reqs[0].steps).toEqual(["done", "running", "failed"]);
  });

  it("running 任务映射到 running 步骤(不再笼统归进 pending)", () => {
    const tasks = [
      makeTask({
        id: "q",
        specRef: "specs/r.md",
        status: "queued",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      makeTask({
        id: "r",
        specRef: "specs/r.md",
        status: "running",
        createdAt: "2026-08-01T01:00:00.000Z",
      }),
      makeTask({
        id: "c",
        specRef: "specs/r.md",
        status: "cancelled",
        createdAt: "2026-08-01T02:00:00.000Z",
      }),
    ];
    const reqs = groupTasksBySpec(tasks);
    expect(reqs[0].steps).toEqual(["pending", "running", "pending"]);
  });

  it("空输入返回空数组", () => {
    expect(groupTasksBySpec([])).toEqual([]);
  });
});

describe("stepStatusFromTask (占位算法)", () => {
  it("done → done", () => expect(stepStatusFromTask("done")).toBe("done"));
  it("failed → failed", () =>
    expect(stepStatusFromTask("failed")).toBe("failed"));
  it("running → running(UI-04b-1:呼吸青环单独成一档)", () =>
    expect(stepStatusFromTask("running")).toBe("running"));
  it("queued/cancelled → pending", () => {
    expect(stepStatusFromTask("queued")).toBe("pending");
    expect(stepStatusFromTask("cancelled")).toBe("pending");
  });
});

describe("deriveLabel", () => {
  it("有 specRef:从路径提取文件名去掉扩展名", () => {
    expect(
      deriveLabel([makeTask({ id: "t", specRef: "specs/auth/login.md" })]),
    ).toBe("login");
    expect(
      deriveLabel([makeTask({ id: "t", specRef: "specs/auth/login" })]),
    ).toBe("login");
    expect(deriveLabel([makeTask({ id: "t", specRef: "login.MD" })])).toBe(
      "login",
    );
  });

  it("specRef 为 null:用最早任务的 id 兜底", () => {
    expect(deriveLabel([makeTask({ id: "solo-task", specRef: null })])).toBe(
      "solo-task",
    );
  });

  it("优先使用任务书第一行的人类可读标题,并回落 specRef", () => {
    expect(
      deriveLabel([
        makeTask({
          id: "titled",
          specRef: "specs/internal-key.md",
          brief: "# 修复时间线可读性\n\n## 关联规范",
        }),
      ]),
    ).toBe("修复时间线可读性");
    expect(
      deriveLabel([
        makeTask({
          id: "fallback",
          specRef: "specs/internal-key.md",
          brief: "## 关联规范\n正文",
        }),
      ]),
    ).toBe("internal-key");
  });
});
