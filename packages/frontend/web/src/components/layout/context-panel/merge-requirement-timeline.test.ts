/**
 * mergeRequirementTimeline 测试(UI-04b-1 升级):
 *  - 合并排序:消息与任务按时间正序混排
 *  - 归属规则:触发消息 + 回复子树(强关联)、时间窗口(启发式)的边界
 *  - 软删除标记、定向对象解析
 */
import { describe, expect, it } from "vitest";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";
import type { Member, MessageItem } from "@/pages/app/groups/messages/types";
import {
  mergeRequirementTimeline,
  partitionRequirementTimeline,
} from "./merge-requirement-timeline";

/** 构造最小可用的 TaskItem(合并函数只消费 id/messageId/createdAt/updatedAt)。 */
function makeTask(overrides: Partial<TaskItem> & { id: string }): TaskItem {
  return {
    groupId: "group-1",
    messageId: "trigger-1",
    executorParticipantId: "participant-exec",
    executorKey: "codebuddy",
    status: "done",
    checkpointRef: null,
    specRef: "specs/r.md",
    specHash: null,
    diffSummary: null,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

/** 构造最小可用的 MessageItem。默认 createdAt 落在 makeTask 默认窗口内。 */
function makeMessage(
  overrides: Partial<MessageItem> & { id: string },
): MessageItem {
  return {
    groupId: "group-1",
    senderId: "participant-coord",
    parentId: null,
    audience: "broadcast",
    audienceRef: null,
    body: "正文",
    fileRef: null,
    depth: 0,
    createdAt: "2026-08-01T09:30:00.000Z",
    ...overrides,
  };
}

const MEMBERS: Member[] = [
  {
    participantId: "participant-coord",
    name: "协调者",
    device: null,
    roles: ["coordinator"],
  },
  {
    participantId: "participant-review",
    name: "检视者",
    device: null,
    roles: ["reviewer"],
  },
  {
    participantId: "participant-exec",
    name: "执行者",
    device: null,
    roles: ["executor"],
  },
  {
    participantId: "participant-human",
    name: "用户",
    device: null,
    roles: ["human"],
  },
];

describe("mergeRequirementTimeline 消息 + 任务合并流", () => {
  it("空任务列表 → 空数组(不渲染任何内容)", () => {
    expect(mergeRequirementTimeline([], [], MEMBERS)).toEqual([]);
  });

  it("消息与任务按时间正序混排(kind 可分辨)", () => {
    const task = makeTask({
      id: "t-1",
      messageId: "trigger-1",
      createdAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
    });
    // 触发消息(强关联,早于任务)与它的回复(强关联,晚于任务):不依赖时间窗口。
    const before = makeMessage({
      id: "trigger-1",
      createdAt: "2026-08-01T08:30:00.000Z",
      body: "任务书",
    });
    const after = makeMessage({
      id: "m-after",
      parentId: "trigger-1",
      createdAt: "2026-08-01T13:00:00.000Z",
      body: "任务完成后的追问",
    });
    const events = mergeRequirementTimeline([task], [after, before], MEMBERS);
    // 任务事件的时间戳取 updatedAt(12:00),任务只贡献一条事件。
    expect(events.map((e) => e.timestamp)).toEqual([
      "2026-08-01T08:30:00.000Z",
      "2026-08-01T12:00:00.000Z",
      "2026-08-01T13:00:00.000Z",
    ]);
    expect(events.map((e) => e.kind)).toEqual(["message", "task", "message"]);
  });

  it("归属规则:任务的触发消息(id === task.messageId)必归属", () => {
    const trigger = makeMessage({
      id: "trigger-1",
      createdAt: "2026-08-01T09:00:00.000Z",
      body: "任务书",
    });
    const events = mergeRequirementTimeline(
      [makeTask({ id: "t-1", messageId: "trigger-1" })],
      [trigger],
      MEMBERS,
    );
    expect(events.filter((e) => e.kind === "message")).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "message" });
  });

  it("归属规则:回复子树(parentId 链可达触发消息)归属,其他回复不归属", () => {
    const trigger = makeMessage({
      id: "trigger-1",
      createdAt: "2026-08-01T09:00:00.000Z",
    });
    const reply1 = makeMessage({
      id: "reply-1",
      parentId: "trigger-1",
      createdAt: "2026-08-01T09:30:00.000Z",
      body: "检视者回复任务书",
    });
    const reply2 = makeMessage({
      id: "reply-2",
      parentId: "reply-1",
      createdAt: "2026-08-01T09:40:00.000Z",
      body: "协调者追回复",
    });
    // 挂在无关消息(reply-other)下的回复:parentId 链不达任何触发消息。
    const otherRoot = makeMessage({
      id: "reply-other",
      createdAt: "2026-08-01T09:10:00.000Z",
      body: "另一条无关消息",
    });
    const otherReply = makeMessage({
      id: "reply-other-2",
      parentId: "reply-other",
      createdAt: "2026-08-01T09:20:00.000Z",
      body: "挂在无关消息下的回复",
    });
    const events = mergeRequirementTimeline(
      [makeTask({ id: "t-1", messageId: "trigger-1" })],
      [trigger, reply1, reply2, otherRoot, otherReply],
      MEMBERS,
    );
    const ids = events
      .filter((e) => e.kind === "message")
      .map((e) => (e.kind === "message" ? e.message.id : ""));
    expect(ids).toContain("trigger-1");
    expect(ids).toContain("reply-1");
    expect(ids).toContain("reply-2");
    expect(ids).not.toContain("otherRoot");
    expect(ids).not.toContain("otherReply");
  });

  it("归属规则(启发式):落在需求活跃窗口内的非关联消息归属,窗口外的不归属", () => {
    const task = makeTask({
      id: "t-1",
      createdAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
    });
    const inWindow = makeMessage({
      id: "m-in",
      createdAt: "2026-08-01T10:00:00.000Z",
      body: "窗口内的旁路讨论",
    });
    const beforeWindow = makeMessage({
      id: "m-pre",
      createdAt: "2026-08-01T08:00:00.000Z",
      body: "窗口之前",
    });
    const afterWindow = makeMessage({
      id: "m-post",
      createdAt: "2026-08-01T13:00:00.000Z",
      body: "窗口之后",
    });
    const events = mergeRequirementTimeline(
      [task],
      [inWindow, beforeWindow, afterWindow],
      MEMBERS,
    );
    const ids = events
      .filter((e) => e.kind === "message")
      .map((e) => (e.kind === "message" ? e.message.id : ""));
    expect(ids).toContain("m-in");
    expect(ids).not.toContain("m-pre");
    expect(ids).not.toContain("m-post");
  });

  it("消息事件:定向对象解析(participant → 成员名,role → 角色名,broadcast → null)", () => {
    const toParticipant = makeMessage({
      id: "m-p",
      audience: "participant",
      audienceRef: "participant-review",
      body: "给检视者",
    });
    const toRole = makeMessage({
      id: "m-r",
      audience: "role",
      audienceRef: "reviewer",
      body: "给检视角色",
    });
    const broadcast = makeMessage({ id: "m-b", body: "广播" });
    const events = mergeRequirementTimeline(
      [makeTask({ id: "t-1" })],
      [toParticipant, toRole, broadcast],
      MEMBERS,
    );
    const msgEvents = events.filter((e) => e.kind === "message");
    const targetOf = (id: string) => {
      const e = msgEvents.find(
        (m) => m.kind === "message" && m.message.id === id,
      );
      return e && e.kind === "message" ? e.target : null;
    };
    expect(targetOf("m-p")).toEqual({
      audience: "participant",
      name: "检视者",
    });
    expect(targetOf("m-r")).toEqual({ audience: "role", name: "reviewer" });
    expect(targetOf("m-b")).toBeNull();
  });

  it("消息事件:发送者命中成员、软删除标记(deleted === true 或占位 body)", () => {
    const normal = makeMessage({
      id: "m-1",
      senderId: "participant-review",
      body: "正常消息",
    });
    const deletedFlag = makeMessage({
      id: "m-2",
      senderId: "participant-coord",
      body: "被标记删除",
      deleted: true,
    });
    const deletedBody = makeMessage({
      id: "m-3",
      body: "[消息已删除]",
    });
    const unknownSender = makeMessage({
      id: "m-4",
      senderId: "no-such-participant",
      body: "发送者未知",
    });
    const events = mergeRequirementTimeline(
      [makeTask({ id: "t-1" })],
      [normal, deletedFlag, deletedBody, unknownSender],
      MEMBERS,
    );
    const msgEvents = events.filter((e) => e.kind === "message");
    const byId = (id: string) => {
      const e = msgEvents.find(
        (m) => m.kind === "message" && m.message.id === id,
      );
      return e && e.kind === "message" ? e : null;
    };
    expect(byId("m-1")?.sender?.name).toBe("检视者");
    expect(byId("m-1")?.softDeleted).toBe(false);
    expect(byId("m-2")?.softDeleted).toBe(true);
    expect(byId("m-3")?.softDeleted).toBe(true);
    expect(byId("m-4")?.sender).toBeNull();
  });

  it("协调载荷超出任务时间窗仍归属对应层,普通记录兜底进 L1", () => {
    const execution = makeTask({
      id: "exec-1",
      createdAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
    });
    const coordination = makeTask({
      id: "coord-1",
      messageId: "coord-trigger",
      specRef: "specs/r.md",
      createdAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
    });
    const review = makeMessage({
      id: "review-result",
      senderId: "participant-review",
      createdAt: "2026-08-01T13:00:00.000Z",
      body: JSON.stringify({
        type: "review_result",
        layer: 3,
        taskId: "coord-1",
        verdict: "findings",
        findings: [{ severity: "高", note: "需要补测试" }],
      }),
    });
    const amended = makeMessage({
      id: "spec-amended",
      senderId: "participant-review",
      createdAt: "2026-08-01T14:00:00.000Z",
      body: JSON.stringify({
        type: "spec_amended",
        specRef: "specs/r.md",
        specHash: "new-hash",
        reason: "补充验收标准",
      }),
    });
    const ordinary = makeMessage({
      id: "ordinary",
      senderId: "participant-exec",
      createdAt: "2026-08-01T09:30:00.000Z",
      body: "执行沟通",
    });
    const events = mergeRequirementTimeline(
      [execution, coordination],
      [review, amended, ordinary],
      MEMBERS,
    );
    const layers = partitionRequirementTimeline(
      events,
      new Set(["exec-1"]),
      "coord-1",
    );

    expect(
      layers.l3.map((event) => event.kind === "message" && event.message.id),
    ).toEqual(["review-result", "spec-amended"]);
    expect(
      layers.l2.map((event) => event.kind === "task" && event.task.id),
    ).toEqual(["coord-1"]);
    expect(
      layers.l1.some(
        (event) => event.kind === "message" && event.message.id === "ordinary",
      ),
    ).toBe(true);
    expect(
      layers.l1.some(
        (event) => event.kind === "task" && event.task.id === "exec-1",
      ),
    ).toBe(true);
  });
});

describe("timelineLayerForEvent 角色优先分层 (timeline-layer-by-actor)", () => {
  it("检视者下发的自由文本任务书 → L3,不再落 L1", () => {
    const task = makeTask({ id: "t-1" });
    const taskBook = makeMessage({
      id: "reviewer-taskbook",
      senderId: "participant-review",
      body: "# 任务书\n检视者下发",
    });
    const events = mergeRequirementTimeline([task], [taskBook], MEMBERS);
    const layers = partitionRequirementTimeline(events, new Set(["t-1"]), null);
    expect(
      layers.l3.some(
        (event) =>
          event.kind === "message" && event.message.id === "reviewer-taskbook",
      ),
    ).toBe(true);
    expect(
      layers.l1.some(
        (event) =>
          event.kind === "message" && event.message.id === "reviewer-taskbook",
      ),
    ).toBe(false);
  });

  it("协调者派发给执行器的自由文本任务书 → L2", () => {
    const task = makeTask({ id: "t-1" });
    const taskBook = makeMessage({
      id: "coord-taskbook",
      senderId: "participant-coord",
      body: "# 任务\n协调者派发",
    });
    const events = mergeRequirementTimeline([task], [taskBook], MEMBERS);
    const layers = partitionRequirementTimeline(events, new Set(["t-1"]), null);
    expect(
      layers.l2.some(
        (event) =>
          event.kind === "message" && event.message.id === "coord-taskbook",
      ),
    ).toBe(true);
  });

  it("执行器的自由文本(输出/汇报)→ L1(回归)", () => {
    const task = makeTask({ id: "t-1" });
    const output = makeMessage({
      id: "exec-output",
      senderId: "participant-exec",
      body: "执行输出:测试通过",
    });
    const events = mergeRequirementTimeline([task], [output], MEMBERS);
    const layers = partitionRequirementTimeline(events, new Set(["t-1"]), null);
    expect(
      layers.l1.some(
        (event) =>
          event.kind === "message" && event.message.id === "exec-output",
      ),
    ).toBe(true);
  });

  it("human 触发的下发 → L3(外部发起侧与检视者同层)", () => {
    const task = makeTask({ id: "t-1" });
    const human = makeMessage({
      id: "human-dispatch",
      senderId: "participant-human",
      body: "用户下发的需求",
    });
    const events = mergeRequirementTimeline([task], [human], MEMBERS);
    const layers = partitionRequirementTimeline(events, new Set(["t-1"]), null);
    expect(
      layers.l3.some(
        (event) =>
          event.kind === "message" && event.message.id === "human-dispatch",
      ),
    ).toBe(true);
  });

  it("spec_published 由检视者发出 → L3(回归)", () => {
    const task = makeTask({ id: "t-1", specRef: "specs/r.md" });
    const published = makeMessage({
      id: "spec-published",
      senderId: "participant-review",
      body: JSON.stringify({
        type: "spec_published",
        specRef: "specs/r.md",
        specHash: "abc1234",
        summary: "规范发布",
      }),
    });
    const events = mergeRequirementTimeline([task], [published], MEMBERS);
    const layers = partitionRequirementTimeline(events, new Set(["t-1"]), null);
    expect(
      layers.l3.some(
        (event) =>
          event.kind === "message" && event.message.id === "spec-published",
      ),
    ).toBe(true);
  });

  it("review_request 由协调者发出 → L2(回归)", () => {
    const task = makeTask({ id: "t-1" });
    const request = makeMessage({
      id: "review-request",
      senderId: "participant-coord",
      body: JSON.stringify({
        type: "review_request",
        layer: 3,
        taskId: "t-1",
        specRef: "specs/r.md",
        specHash: "abc1234",
        diffSummary: "L2 已通过,请进行架构检视。",
      }),
    });
    const events = mergeRequirementTimeline([task], [request], MEMBERS);
    const layers = partitionRequirementTimeline(events, new Set(["t-1"]), null);
    expect(
      layers.l2.some(
        (event) =>
          event.kind === "message" && event.message.id === "review-request",
      ),
    ).toBe(true);
  });

  it("发送者不在成员表时回落形态判据,记录不丢失", () => {
    const task = makeTask({ id: "t-1" });
    const unknownReview = makeMessage({
      id: "unknown-review",
      senderId: "no-such-participant",
      body: JSON.stringify({
        type: "review_result",
        layer: 3,
        taskId: "t-1",
        verdict: "pass",
        findings: [],
      }),
    });
    const unknownPlain = makeMessage({
      id: "unknown-plain",
      senderId: "no-such-participant",
      body: "退群成员的普通消息",
    });
    const events = mergeRequirementTimeline(
      [task],
      [unknownReview, unknownPlain],
      MEMBERS,
    );
    const layers = partitionRequirementTimeline(events, new Set(["t-1"]), null);
    // review_result 形态 → L3;普通消息形态无法判定 → L1;两条记录都不丢。
    expect(
      layers.l3.some(
        (event) =>
          event.kind === "message" && event.message.id === "unknown-review",
      ),
    ).toBe(true);
    expect(
      layers.l1.some(
        (event) =>
          event.kind === "message" && event.message.id === "unknown-plain",
      ),
    ).toBe(true);
    expect(events.filter((event) => event.kind === "message")).toHaveLength(2);
  });

  it("任务事件规则不变:执行任务 → L1,协调任务 → L2", () => {
    const execution = makeTask({ id: "exec-1" });
    const coordination = makeTask({
      id: "coord-1",
      messageId: "coord-trigger",
    });
    const events = mergeRequirementTimeline(
      [execution, coordination],
      [],
      MEMBERS,
    );
    const layers = partitionRequirementTimeline(
      events,
      new Set(["exec-1"]),
      "coord-1",
    );
    expect(
      layers.l1.some(
        (event) => event.kind === "task" && event.task.id === "exec-1",
      ),
    ).toBe(true);
    expect(
      layers.l2.some(
        (event) => event.kind === "task" && event.task.id === "coord-1",
      ),
    ).toBe(true);
  });
});
