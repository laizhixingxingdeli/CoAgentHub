import { describe, expect, it } from "vitest";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";
import type { Member } from "@/pages/app/groups/messages/types";
import {
  coordinationTaskForTasks,
  coordinationTasksForRequirement,
  deriveBriefTitle,
  deriveLabel,
  executionTasksForRequirement,
  groupTasksBySpec,
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

/** 构造最小可用的 Member(角色判定只读 participantId 与 roles)。 */
function makeMember(participantId: string, roles: string[]): Member {
  return { participantId, name: participantId, device: null, roles };
}

const COORDINATOR = makeMember("participant-coordinator", ["coordinator"]);
const EXECUTOR = makeMember("participant-executor", ["executor"]);

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
    expect(reqs[0].label).toBe("login");
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

  it("阶梯固定三步,不随任务数变化并按 L1 聚合执行任务", () => {
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
    expect(reqs[0].steps).toEqual(["running", "pending", "pending"]);
  });

  it("L1 全部完成时为 done,重试次数只作为需求附属信息", () => {
    const tasks = [
      makeTask({
        id: "q",
        specRef: "specs/r.md",
        status: "done",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      makeTask({
        id: "r",
        specRef: "specs/r.md",
        status: "done",
        createdAt: "2026-08-01T01:00:00.000Z",
      }),
      makeTask({
        id: "c",
        specRef: "specs/r.md",
        status: "done",
        retryCount: 2,
        createdAt: "2026-08-01T02:00:00.000Z",
      }),
    ];
    const reqs = groupTasksBySpec(tasks);
    expect(reqs[0].steps).toEqual(["done", "pending", "pending"]);
    expect(reqs[0].retryCount).toBe(2);
  });

  it("空输入返回空数组", () => {
    expect(groupTasksBySpec([])).toEqual([]);
  });

  describe("parentTaskId 父子归并(requirement-three-layer-view)", () => {
    it("执行任务归入协调任务所属需求,协调任务不单独成行", () => {
      const tasks = [
        makeTask({
          id: "coord",
          specRef: null,
          createdAt: "2026-08-01T00:00:00.000Z",
          status: "done",
          brief: "协调请求(检视者 → 协调者)· 第 X 批",
        }),
        makeTask({
          id: "exec-1",
          parentTaskId: "coord",
          specRef: "specs/three-layer.md",
          createdAt: "2026-08-01T01:00:00.000Z",
          status: "done",
          brief: "# CoAgentHub Task\n\n## Goal\n实现三层链条展示。",
        }),
        makeTask({
          id: "exec-2",
          parentTaskId: "coord",
          specRef: "specs/three-layer.md",
          createdAt: "2026-08-01T02:00:00.000Z",
          status: "running",
        }),
      ];
      const reqs = groupTasksBySpec(tasks);
      // 只出一条需求(协调任务不再独立成行)。
      expect(reqs).toHaveLength(1);
      // 分组键 = 根(协调任务)的 specRef ?? id → 协调任务 id。
      expect(reqs[0].id).toBe("coord");
      expect(reqs[0].tasks.map((t) => t.id)).toEqual([
        "coord",
        "exec-1",
        "exec-2",
      ]);
      // 标题不取协调任务的「协调请求」样板,优先取执行任务的 specRef。
      expect(reqs[0].label).toBe("three-layer");
      expect(reqs[0].latestTask.id).toBe("exec-2");
    });

    it("同一协调任务下多个执行任务(拆票/收尾)归在同一条需求", () => {
      const tasks = [
        makeTask({
          id: "coord",
          specRef: null,
          createdAt: "2026-08-01T00:00:00.000Z",
        }),
        makeTask({
          id: "c1",
          parentTaskId: "coord",
          specRef: null,
          createdAt: "2026-08-01T01:00:00.000Z",
        }),
        makeTask({
          id: "c2",
          parentTaskId: "coord",
          specRef: null,
          createdAt: "2026-08-01T02:00:00.000Z",
        }),
        makeTask({
          id: "c3",
          parentTaskId: "coord",
          specRef: null,
          createdAt: "2026-08-01T03:00:00.000Z",
        }),
      ];
      const reqs = groupTasksBySpec(tasks);
      expect(reqs).toHaveLength(1);
      expect(reqs[0].tasks.map((t) => t.id)).toEqual([
        "coord",
        "c1",
        "c2",
        "c3",
      ]);
    });

    it("历史 parentTaskId 为 null 的任务保持各自成行,不猜测父子关系", () => {
      const tasks = [
        makeTask({
          id: "a",
          specRef: null,
          createdAt: "2026-08-01T00:00:00.000Z",
        }),
        makeTask({
          id: "b",
          specRef: null,
          createdAt: "2026-08-01T01:00:00.000Z",
        }),
        makeTask({
          id: "c",
          specRef: "specs/shared.md",
          createdAt: "2026-08-01T02:00:00.000Z",
        }),
      ];
      const reqs = groupTasksBySpec(tasks);
      expect(reqs.map((r) => r.id)).toEqual(["a", "b", "specs/shared.md"]);
    });

    it("悬空父(parentTaskId 指向列表外)→ 按无父处理,不猜测", () => {
      const tasks = [
        makeTask({
          id: "orphan",
          specRef: null,
          createdAt: "2026-08-01T00:00:00.000Z",
        }),
      ];
      const reqs = groupTasksBySpec([
        makeTask({
          id: "child",
          parentTaskId: "ghost-parent",
          specRef: null,
          createdAt: "2026-08-01T01:00:00.000Z",
        }),
        ...tasks,
      ]);
      expect(reqs.map((r) => r.id).sort()).toEqual(["child", "orphan"]);
    });

    it("深链(父的父)→ 归到最顶层根", () => {
      const tasks = [
        makeTask({
          id: "top",
          specRef: null,
          createdAt: "2026-08-01T00:00:00.000Z",
        }),
        makeTask({
          id: "mid",
          parentTaskId: "top",
          specRef: null,
          createdAt: "2026-08-01T01:00:00.000Z",
        }),
        makeTask({
          id: "leaf",
          parentTaskId: "mid",
          specRef: null,
          createdAt: "2026-08-01T02:00:00.000Z",
        }),
      ];
      const reqs = groupTasksBySpec(tasks);
      expect(reqs).toHaveLength(1);
      expect(reqs[0].id).toBe("top");
      expect(reqs[0].tasks.map((t) => t.id)).toEqual(["top", "mid", "leaf"]);
    });
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

  it("优先使用 specRef 派生标题,无 specRef 时使用任务书标题", () => {
    expect(
      deriveLabel([
        makeTask({
          id: "titled",
          specRef: "specs/internal-key.md",
          brief: "# 修复时间线可读性\n\n## 关联规范",
        }),
      ]),
    ).toBe("internal-key");
    expect(
      deriveLabel([
        makeTask({
          id: "brief-title",
          specRef: null,
          brief: "# 无规范任务标题\n\n## 任务内容",
        }),
      ]),
    ).toBe("无规范任务标题");
  });

  it.each(["# CoAgentHub Task", "# CoAgentHub 任务"])(
    "模板标题 %s 改用 Goal 段首句",
    (templateTitle) => {
      expect(
        deriveLabel([
          makeTask({
            id: "templated",
            specRef: null,
            brief: `${templateTitle}\n\n## Goal\n修复任务标题的可读性。后续说明不应进入标题。`,
          }),
        ]),
      ).toBe("修复任务标题的可读性。");
    },
  );

  it("保留用户手写的 markdown 任务标题", () => {
    expect(
      deriveLabel([
        makeTask({
          id: "handwritten",
          specRef: null,
          brief: "# 任务:修 MCP 契约两缺陷\n\n## Goal\n不应覆盖手写标题",
        }),
      ]),
    ).toBe("修 MCP 契约两缺陷");
  });

  it("无 Goal 时回落 specRef,完全无信息时回落任务 id", () => {
    expect(
      deriveLabel([
        makeTask({
          id: "with-spec",
          specRef: "specs/task-title-readability.md",
          brief: "# CoAgentHub Task\n\n## Scope\n只改前端",
        }),
      ]),
    ).toBe("task-title-readability");
    expect(
      deriveLabel([
        makeTask({
          id: "task-id-fallback",
          specRef: null,
          brief: "# CoAgentHub 任务\n\n## 范围\n只改前端",
        }),
      ]),
    ).toBe("task-id-fallback");
  });

  it("空 Goal 段不借用下一段内容", () => {
    expect(
      deriveLabel([
        makeTask({
          id: "empty-goal",
          specRef: "specs/empty-goal.md",
          brief: "# CoAgentHub Task\n\n## Goal\n\n## Scope\n这不是任务标题",
        }),
      ]),
    ).toBe("empty-goal");
  });

  it.each(["目标", "任务内容"])("支持 ## %s 段", (heading) => {
    expect(
      deriveLabel([
        makeTask({
          id: "localized-goal",
          specRef: null,
          brief: `# CoAgentHub 任务\n\n## ${heading}\n从本段提取标题`,
        }),
      ]),
    ).toBe("从本段提取标题");
  });

  it("长标题保留足够的前半句", () => {
    const title =
      "让任务标题在左侧列表和阶梯标签中保持清晰可读，即使任务书正文非常长也不影响识别，并且仍然应该保留足够的前半句供人判断任务内容，避免在开头几个字就截断而失去任务语义";
    expect(deriveBriefTitle(`# ${title}`)).toBe(`${title.slice(0, 64)}…`);
  });
});

describe("协调任务按角色判定(coordination-task-is-not-l1)", () => {
  it("零子任务的 coordinator 任务归 L2,L1 为空且不参与执行聚合", () => {
    const tasks = [
      makeTask({
        id: "coord",
        specRef: "specs/r.md",
        executorParticipantId: COORDINATOR.participantId,
        status: "running",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
    ];
    const [requirement] = groupTasksBySpec(tasks, [COORDINATOR]);
    // L2 跟随该协调任务(running),L1 无执行任务 → pending。
    expect(requirement.steps).toEqual(["pending", "running", "pending"]);
    expect(executionTasksForRequirement(tasks, [COORDINATOR])).toEqual([]);
  });

  it("协调任务零子任务时 L1 为空(显示「暂无执行记录」的数据前提)", () => {
    const tasks = [
      makeTask({
        id: "coord",
        specRef: "specs/r.md",
        executorParticipantId: COORDINATOR.participantId,
        status: "done",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
    ];
    const [requirement] = groupTasksBySpec(tasks, [COORDINATOR]);
    expect(requirement.steps).toEqual(["pending", "done", "pending"]);
    expect(requirement.retryCount).toBe(0);
  });

  it("executor 任务始终归 L1,即使它被别的任务当作父", () => {
    const tasks = [
      makeTask({
        id: "exec-parent",
        specRef: "specs/r.md",
        executorParticipantId: EXECUTOR.participantId,
        status: "running",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      makeTask({
        id: "child",
        parentTaskId: "exec-parent",
        specRef: "specs/r.md",
        executorParticipantId: EXECUTOR.participantId,
        status: "done",
        createdAt: "2026-08-01T01:00:00.000Z",
      }),
    ];
    const [requirement] = groupTasksBySpec(tasks, [EXECUTOR]);
    expect(requirement.steps).toEqual(["running", "pending", "pending"]);
    expect(coordinationTasksForRequirement(tasks, [EXECUTOR])).toEqual([]);
  });

  it("成员查不到时回退 parentTaskId 反推,旧行为逐字一致", () => {
    const tasks = [
      makeTask({
        id: "coord",
        specRef: null,
        status: "done",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      makeTask({
        id: "exec-1",
        parentTaskId: "coord",
        specRef: "specs/r.md",
        status: "done",
        createdAt: "2026-08-01T01:00:00.000Z",
      }),
    ];
    // 成员表为空 → 协调任务靠反推认出(与改动前一致)。
    const [requirement] = groupTasksBySpec(tasks);
    expect(requirement.steps).toEqual(["done", "done", "pending"]);
    expect(requirement.label).toBe("r");
  });

  it("review_request 任务仍被排除出 L1", () => {
    const tasks = [
      makeTask({
        id: "coord",
        specRef: "specs/r.md",
        executorParticipantId: COORDINATOR.participantId,
        status: "done",
        diffSummary: {
          review_request: {
            type: "review_request",
            layer: 3,
            specRef: "specs/r.md",
            specHash: "abc1234",
            diffSummary: "L2 通过",
          },
        },
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      makeTask({
        id: "exec-1",
        specRef: "specs/r.md",
        executorParticipantId: EXECUTOR.participantId,
        status: "done",
        createdAt: "2026-08-01T01:00:00.000Z",
      }),
    ];
    const [requirement] = groupTasksBySpec(tasks, [COORDINATOR, EXECUTOR]);
    expect(requirement.steps).toEqual(["done", "done", "pending"]);
    expect(
      executionTasksForRequirement(tasks, [COORDINATOR, EXECUTOR]),
    ).toEqual([tasks[1]]);
  });

  it("零子任务 review_request 协调任务在成员查不到时经兜底归 L2(回归)", () => {
    const reason = "本票由发布者直接定向实现,未创建下游执行子任务。";
    const tasks = [
      makeTask({
        id: "coord",
        specRef: "specs/r.md",
        executorParticipantId: "participant-coordinator",
        status: "done",
        diffSummary: {
          review_request: {
            type: "review_request",
            layer: 3,
            taskId: "coord",
            specRef: "specs/r.md",
            specHash: "0b03bd37",
            diffSummary: "L2 功能验收通过。",
          },
          noExecutionReason: reason,
        },
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
    ];
    // 成员表为空 → 角色查不到,回退 review_request 兜底,行为与改动前一致。
    const [requirement] = groupTasksBySpec(tasks);
    expect(requirement.steps).toEqual(["na-declared", "done", "pending"]);
    expect(coordinationTasksForRequirement(tasks)).toEqual(tasks);
  });

  it("标题提取与分层共用同一判定:coordinator 任务不参与标题", () => {
    const tasks = [
      makeTask({
        id: "coord",
        specRef: null,
        executorParticipantId: COORDINATOR.participantId,
        status: "done",
        brief: "协调请求(检视者 → 协调者)· 第 X 批",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      makeTask({
        id: "exec-1",
        parentTaskId: "coord",
        specRef: "specs/three-layer.md",
        executorParticipantId: EXECUTOR.participantId,
        status: "done",
        createdAt: "2026-08-01T01:00:00.000Z",
      }),
    ];
    expect(deriveLabel(tasks, [COORDINATOR, EXECUTOR])).toBe("three-layer");
  });

  it("父协调任务 + 续跑协调任务都出现在 L2,状态聚合(done+running → running)", () => {
    const tasks = [
      makeTask({
        id: "coord-parent",
        specRef: "specs/r.md",
        executorParticipantId: COORDINATOR.participantId,
        status: "done",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      makeTask({
        id: "exec-1",
        parentTaskId: "coord-parent",
        specRef: "specs/r.md",
        executorParticipantId: EXECUTOR.participantId,
        status: "done",
        createdAt: "2026-08-01T01:00:00.000Z",
      }),
      makeTask({
        id: "coord-resume",
        parentTaskId: "exec-1",
        specRef: "specs/r.md",
        executorParticipantId: COORDINATOR.participantId,
        status: "running",
        diffSummary: {
          platform: { resumeOf: "coord-parent" },
          review_request: {
            type: "review_request",
            layer: 3,
            specRef: "specs/r.md",
            specHash: "abc1234",
            diffSummary: "续跑做 L2",
          },
        },
        createdAt: "2026-08-01T02:00:00.000Z",
      }),
    ];
    const coordinationTasks = coordinationTasksForRequirement(tasks, [
      COORDINATOR,
      EXECUTOR,
    ]);
    expect(coordinationTasks.map((task) => task.id)).toEqual([
      "coord-parent",
      "coord-resume",
    ]);
    const [requirement] = groupTasksBySpec(tasks, [COORDINATOR, EXECUTOR]);
    // L1 只含 exec-1(done);L2 聚合 done+running → running。
    expect(requirement.steps).toEqual(["done", "running", "pending"]);
  });

  it("L2 聚合:两条协调任务皆 done → done", () => {
    const tasks = [
      makeTask({
        id: "coord-parent",
        specRef: "specs/r.md",
        executorParticipantId: COORDINATOR.participantId,
        status: "done",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      makeTask({
        id: "coord-resume",
        specRef: "specs/r.md",
        executorParticipantId: COORDINATOR.participantId,
        status: "done",
        createdAt: "2026-08-01T02:00:00.000Z",
      }),
    ];
    const [requirement] = groupTasksBySpec(tasks, [COORDINATOR]);
    expect(requirement.steps).toEqual(["pending", "done", "pending"]);
  });

  it("coordinationTaskForTasks 单条签名与语义不变(回归)", () => {
    const tasks = [
      makeTask({
        id: "coord",
        specRef: null,
        status: "done",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      makeTask({
        id: "exec-1",
        parentTaskId: "coord",
        specRef: "specs/r.md",
        status: "done",
        createdAt: "2026-08-01T01:00:00.000Z",
      }),
    ];
    // 父任务优先;无子任务时回落 review_request(单条语义不变)。
    expect(coordinationTaskForTasks(tasks)?.id).toBe("coord");
    expect(
      coordinationTaskForTasks([
        makeTask({
          id: "solo",
          specRef: null,
          diffSummary: {
            review_request: {
              type: "review_request",
              layer: 3,
              specRef: "specs/r.md",
              specHash: "abc1234",
              diffSummary: "L2 通过",
            },
          },
        }),
      ])?.id,
    ).toBe("solo");
  });
});
