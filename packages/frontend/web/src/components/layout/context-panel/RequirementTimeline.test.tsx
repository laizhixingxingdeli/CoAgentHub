import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatDurationMs,
  formatMessageTime,
} from "@/pages/app/groups/messages/lib";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";
import type { Member, MessageItem } from "@/pages/app/groups/messages/types";
import RequirementTimeline, {
  roleFromExecutorKey,
} from "./RequirementTimeline";

/** 构造最小可用的 TaskItem(只填时间线渲染需要的字段)。 */
function makeTask(overrides: Partial<TaskItem> & { id: string }): TaskItem {
  return {
    groupId: "group-1",
    messageId: "msg-1",
    executorParticipantId: "participant-1",
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

describe("roleFromExecutorKey 角色推断(executorKey 字符串映射的简化实现)", () => {
  it("含 coordinator → coordinator", () => {
    expect(roleFromExecutorKey("coordinator-1")).toBe("coordinator");
    expect(roleFromExecutorKey("Team-Coordinator")).toBe("coordinator");
  });
  it("含 reviewer → reviewer", () => {
    expect(roleFromExecutorKey("code-reviewer")).toBe("reviewer");
  });
  it("其余(含 null)→ executor", () => {
    expect(roleFromExecutorKey("codebuddy")).toBe("executor");
    expect(roleFromExecutorKey(null)).toBe("executor");
  });
});

describe("RequirementTimeline 沟通记录时间线 (UI-04b-1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("耗时格式使用秒或分秒,不显示裸毫秒", () => {
    expect(formatDurationMs(9_000)).toBe("9s");
    expect(formatDurationMs(65_000)).toBe("1m 5s");
  });

  it("空任务列表不渲染任何内容", () => {
    const { container } = render(<RequirementTimeline tasks={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("每个任务渲染成一张白底卡片,正文取 diffSummary.summary", () => {
    render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "t-1",
            diffSummary: { summary: "接好了任务面板的分组数据层" },
          }),
          makeTask({ id: "t-2", diffSummary: { summary: "补了组件测试" } }),
        ]}
      />,
    );
    expect(screen.getByTestId("requirement-timeline")).toBeInTheDocument();
    const card = screen
      .getByTestId("requirement-timeline-item-t-1")
      .querySelector("div");
    expect(card).toHaveClass("bg-card");
    expect(card).toHaveClass("rounded-xl");
    expect(card).toHaveClass("border");
    expect(screen.getByText("接好了任务面板的分组数据层")).toBeInTheDocument();
    expect(screen.getByText("补了组件测试")).toBeInTheDocument();
  });

  it("liveness warning 在任务卡片显示无信号时长", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T02:00:00.000Z"));
    render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "stalled-task",
            status: "running",
            liveness: {
              warning: true,
              lastSignalAt: "2026-08-24T01:45:00.000Z",
            },
          }),
        ]}
      />,
    );

    expect(
      screen.getByTestId("requirement-timeline-liveness-stalled-task"),
    ).toHaveTextContent("疑似中断 · 已 15 分钟无信号");
  });

  it("停止/回滚控制跟随任务卡片,历史任务仍可回滚", () => {
    const onStop = vi.fn();
    const onRollback = vi.fn();
    const historicalTask = makeTask({
      id: "historical-task",
      status: "done",
      checkpointRef: "refs/coagenthub-cp/historical-task",
    });
    const currentTask = makeTask({ id: "current-task", status: "running" });
    render(
      <RequirementTimeline
        tasks={[historicalTask, currentTask]}
        onStop={onStop}
        onRollback={onRollback}
      />,
    );

    expect(
      screen.getByTestId("task-rollback-historical-task"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("task-stop-current-task")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("task-rollback-historical-task"));
    fireEvent.click(screen.getByTestId("task-stop-current-task"));
    expect(onRollback).toHaveBeenCalledWith(
      expect.objectContaining({ id: "historical-task" }),
    );
    expect(onStop).toHaveBeenCalledWith(
      expect.objectContaining({ id: "current-task" }),
    );
  });

  it("控制判定只允许 queued/running 停止,done/failed 且有 checkpoint 回滚", () => {
    render(
      <RequirementTimeline
        tasks={[
          makeTask({ id: "queued", status: "queued" }),
          makeTask({ id: "done-with-checkpoint", checkpointRef: "checkpoint" }),
          makeTask({
            id: "failed-with-checkpoint",
            status: "failed",
            checkpointRef: "checkpoint",
          }),
          makeTask({ id: "done-without-checkpoint" }),
          makeTask({ id: "cancelled", status: "cancelled" }),
        ]}
      />,
    );

    expect(screen.getByTestId("task-stop-queued")).toBeInTheDocument();
    expect(
      screen.getByTestId("task-rollback-done-with-checkpoint"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("task-rollback-failed-with-checkpoint"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("task-stop-done-without-checkpoint"),
    ).toBeNull();
    expect(
      screen.queryByTestId("task-rollback-done-without-checkpoint"),
    ).toBeNull();
    expect(screen.queryByTestId("task-stop-cancelled")).toBeNull();
    expect(screen.queryByTestId("task-rollback-cancelled")).toBeNull();
  });

  it("控制按钮保留发送中/回滚中/已恢复态,并遵守权限与只读禁用提示", () => {
    const { rerender } = render(
      <RequirementTimeline
        tasks={[
          makeTask({ id: "sending", status: "running" }),
          makeTask({ id: "rolling", checkpointRef: "checkpoint" }),
          makeTask({ id: "restored", checkpointRef: "checkpoint" }),
        ]}
        commandSending="sending"
        rollbackStates={{ rolling: "rolling", restored: "done" }}
      />,
    );
    expect(screen.getByTestId("task-stop-sending")).toHaveTextContent(
      "发送中…",
    );
    expect(screen.getByTestId("task-rollback-rolling")).toHaveTextContent(
      "回滚中…",
    );
    expect(screen.getByTestId("task-rollback-restored")).toHaveTextContent(
      "已恢复",
    );

    rerender(
      <RequirementTimeline
        tasks={[makeTask({ id: "read-only", status: "running" })]}
        canControl={false}
        readOnly
      />,
    );
    const button = screen.getByTestId("task-stop-read-only");
    expect(button).toBeDisabled();
    expect(button.parentElement).toHaveAttribute("title", "群已归档,只读");
  });

  it("头像底色引用 --role-* token:executorKey 决定协调者/检视者/执行者色", () => {
    render(
      <RequirementTimeline
        tasks={[
          makeTask({ id: "c", executorKey: "coordinator" }),
          makeTask({ id: "r", executorKey: "reviewer-bot" }),
          makeTask({ id: "e", executorKey: "codebuddy" }),
        ]}
      />,
    );
    const coordinator = screen.getByTestId("requirement-timeline-avatar-c");
    expect(coordinator).toHaveClass("bg-role-coordinator");
    expect(coordinator).toHaveAttribute("data-role", "coordinator");
    expect(screen.getByTestId("requirement-timeline-avatar-r")).toHaveClass(
      "bg-role-reviewer",
    );
    expect(screen.getByTestId("requirement-timeline-avatar-e")).toHaveClass(
      "bg-role-executor",
    );
  });

  it("有 hash / tests 时各展示一行(hash 截断到 12 位)", () => {
    render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "t-1",
            diffSummary: {
              summary: "做完了",
              hash: "0123456789abcdef0123456789abcdef01234567",
              tests: "web test 全绿",
            },
          }),
        ]}
      />,
    );
    expect(screen.getByText("提交 0123456789ab")).toBeInTheDocument();
    expect(screen.getByText("测试 web test 全绿")).toBeInTheDocument();
  });

  it("展示 token 与任务整体耗时,无 token 时不渲染占位符", () => {
    const { rerender } = render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "t-1",
            diffSummary: { summary: "做完了", tokenUsage: "8000" },
            createdAt: "2026-08-01T09:00:00.000Z",
            updatedAt: "2026-08-01T09:01:05.000Z",
          }),
        ]}
      />,
    );
    expect(
      screen.getByTestId("requirement-timeline-token-t-1"),
    ).toHaveTextContent("Token 8000");
    expect(
      screen.getByTestId("requirement-timeline-duration-t-1"),
    ).toHaveTextContent("耗时 1m 5s");

    rerender(<RequirementTimeline tasks={[makeTask({ id: "t-2" })]} />);
    expect(screen.queryByText(/Token/)).not.toBeInTheDocument();
    expect(
      screen.getByTestId("requirement-timeline-duration-t-2"),
    ).toBeInTheDocument();
  });

  it("没有汇报内容时给出占位文案,且不出现展开入口", () => {
    render(<RequirementTimeline tasks={[makeTask({ id: "t-1" })]} />);
    expect(screen.getByText("暂无汇报内容")).toBeInTheDocument();
    expect(
      screen.queryByTestId("requirement-timeline-toggle-t-1"),
    ).not.toBeInTheDocument();
  });

  it("短 tests / todo 直接铺开,不生成展开入口", () => {
    render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "t-1",
            diffSummary: { summary: "做完了", tests: "全绿", todo: "无" },
          }),
        ]}
      />,
    );
    expect(screen.getByText("测试 全绿")).toBeInTheDocument();
    expect(screen.getByText("遗留 无")).toBeInTheDocument();
    expect(
      screen.queryByTestId("requirement-timeline-toggle-t-1"),
    ).not.toBeInTheDocument();
  });

  it("长 tests(超过 80 字)先截断,点击「展开」显示全文,再点收起", () => {
    const longTests = `${"a".repeat(90)}END`;
    render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "t-1",
            diffSummary: { summary: "做完了", tests: longTests },
          }),
        ]}
      />,
    );
    // 折叠时:预览带省略号,详情区不存在。
    expect(
      screen.getByTestId("requirement-timeline-tests-t-1").textContent,
    ).toContain("…");
    expect(
      screen.getByTestId("requirement-timeline-tests-t-1").textContent,
    ).not.toContain("END");
    expect(
      screen.queryByTestId("requirement-timeline-detail-t-1"),
    ).not.toBeInTheDocument();

    const toggle = screen.getByTestId("requirement-timeline-toggle-t-1");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("展开");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("收起");
    expect(
      screen.getByTestId("requirement-timeline-detail-t-1").textContent,
    ).toContain("END");

    fireEvent.click(toggle);
    expect(
      screen.queryByTestId("requirement-timeline-detail-t-1"),
    ).not.toBeInTheDocument();
  });

  it("存在 outputTail 时也提供展开入口,展开后显示输出尾", () => {
    render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "t-1",
            diffSummary: { summary: "做完了", outputTail: "npm test\nok" },
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("requirement-timeline-toggle-t-1"));
    expect(
      screen.getByTestId("requirement-timeline-detail-t-1").textContent,
    ).toContain("npm test");
  });

  it("上千行输出在有界滚动区内展开,滚到底部仍可直接收起", () => {
    const longOutput = Array.from(
      { length: 1001 },
      (_, index) => `line-${index}`,
    ).join("\n");
    render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "t-long-output",
            status: "running",
            diffSummary: { outputTail: longOutput },
          }),
        ]}
      />,
    );

    const toggle = screen.getByTestId(
      "requirement-timeline-toggle-t-long-output",
    );
    expect(toggle).toHaveTextContent(/展开.*1001 行/);
    fireEvent.click(toggle);

    const detail = screen.getByTestId(
      "requirement-timeline-detail-t-long-output",
    );
    expect(detail).toHaveClass("max-h-[60vh]", "overflow-y-auto");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("收起");

    // The toggle is outside the independently scrolling detail region.
    fireEvent.click(toggle);
    expect(
      screen.queryByTestId("requirement-timeline-detail-t-long-output"),
    ).not.toBeInTheDocument();
  });

  it("长 todo 只在展开区出现,不在折叠状态铺开", () => {
    const longTodo = `${"遗".repeat(85)}尾`;
    render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "t-1",
            diffSummary: { summary: "做完了", todo: longTodo },
          }),
        ]}
      />,
    );
    expect(screen.queryByText(`遗留 ${longTodo}`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("requirement-timeline-toggle-t-1"));
    expect(
      screen.getByTestId("requirement-timeline-detail-t-1").textContent,
    ).toContain("尾");
  });

  it("多张卡片各自独立折叠(展开一张不影响另一张)", () => {
    const long = "x".repeat(100);
    render(
      <RequirementTimeline
        tasks={[
          makeTask({ id: "t-1", diffSummary: { summary: "一", tests: long } }),
          makeTask({ id: "t-2", diffSummary: { summary: "二", tests: long } }),
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("requirement-timeline-toggle-t-1"));
    expect(
      screen.getByTestId("requirement-timeline-detail-t-1"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("requirement-timeline-detail-t-2"),
    ).not.toBeInTheDocument();
  });

  it("时间戳优先取 updatedAt(汇报落库时刻),缺失时回退 createdAt", () => {
    const createdAt = new Date(Date.now() - 3 * 3600_000).toISOString();
    const updatedAt = new Date(Date.now() - 3600_000).toISOString();
    render(
      <RequirementTimeline
        tasks={[
          makeTask({ id: "with-updated", createdAt, updatedAt }),
          makeTask({ id: "no-updated", createdAt, updatedAt: null }),
        ]}
      />,
    );
    expect(
      screen.getByTestId("requirement-timeline-time-with-updated"),
    ).toHaveTextContent(formatMessageTime(updatedAt));
    expect(
      screen.getByTestId("requirement-timeline-time-no-updated"),
    ).toHaveTextContent(formatMessageTime(createdAt));
  });
});

describe("时间线可读性与系统状态过滤", () => {
  const makeMessage = (
    id: string,
    body: string,
    overrides: Partial<MessageItem> = {},
  ): MessageItem => ({
    id,
    groupId: "group-1",
    senderId: "participant-1",
    parentId: null,
    audience: "broadcast",
    audienceRef: null,
    body,
    contentType: "text/plain",
    fileRef: null,
    depth: 0,
    createdAt: "2026-08-01T09:30:00.000Z",
    ...overrides,
  });

  it("隐藏 skill 安装提示与纯状态 task_status,并把状态挂回触发消息", () => {
    render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "t-status",
            status: "running",
            messageId: "trigger",
            diffSummary: { retries: 2 },
          }),
        ]}
        messages={[
          makeMessage("trigger", "任务书"),
          makeMessage("skill", "请先安装 coagenthub-executor skill"),
          makeMessage("pure-status", "🚀 开始执行:任务书", {
            contentType: "task_status",
          }),
        ]}
      />,
    );
    expect(screen.queryByTestId("requirement-timeline-item-skill")).toBeNull();
    expect(
      screen.queryByTestId("requirement-timeline-item-pure-status"),
    ).toBeNull();
    expect(
      screen.getByTestId("requirement-timeline-task-status-trigger"),
    ).toHaveTextContent("重试 2 次");
  });

  it("任务状态徽章使用中文 i18n、共享状态色,失败态带图标", () => {
    const statuses = [
      ["queued", "排队中"],
      ["running", "执行中"],
      ["done", "已完成"],
      ["failed", "失败"],
      ["cancelled", "已取消"],
    ] as const;
    render(
      <RequirementTimeline
        tasks={statuses.map(([status], index) =>
          makeTask({
            id: `t-${status}`,
            messageId: `trigger-${status}`,
            status,
            diffSummary: null,
            createdAt: `2026-08-01T09:${String(index).padStart(2, "0")}:00.000Z`,
          }),
        )}
        messages={statuses.map(([status]) =>
          makeMessage(`trigger-${status}`, "任务书"),
        )}
      />,
    );

    for (const [status, label] of statuses) {
      const badge = screen.getByTestId(
        `requirement-timeline-task-status-trigger-${status}`,
      );
      expect(badge).toHaveTextContent(`任务 ${label}`);
      expect(badge).toHaveClass(
        `border-status-${status}`,
        `bg-status-${status}/10`,
        `text-status-${status}`,
      );
    }

    expect(
      screen.getByTestId("requirement-timeline-task-status-trigger-failed"),
    ).toHaveAttribute("data-failure-signal", "icon");
  });

  it("带汇报内容的 task_status 仍保留", () => {
    render(
      <RequirementTimeline
        tasks={[makeTask({ id: "t-report", messageId: "trigger" })]}
        messages={[
          makeMessage("trigger", "任务书"),
          makeMessage("report", "✅ 任务完成: 已通过测试", {
            contentType: "task_status",
          }),
        ]}
      />,
    );
    expect(
      screen.getByTestId("requirement-timeline-item-report"),
    ).toBeInTheDocument();
  });
});

/** 构造最小可用的 MessageItem(消息卡片渲染用)。默认 createdAt 落在
 * makeTask 默认窗口 [09:00, 10:00] 内,避免被归属过滤。 */
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

const MOCK_MEMBERS: Member[] = [
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
];

describe("RequirementTimeline 消息卡片 (UI-04b-1 合并流)", () => {
  it("结构化载荷按协议渲染为人读事件,不显示原始 JSON", () => {
    const payloads = [
      {
        id: "spec-published",
        body: JSON.stringify({
          type: "spec_published",
          specRef: "specs/structured-payload-rendering.md",
          specHash: "b7c2cf1f",
          summary: "时间线只显示可读信息。",
        }),
      },
      {
        id: "spec-amended",
        body: JSON.stringify({
          type: "spec_amended",
          specRef: "specs/structured-payload-rendering.md",
          specHash: "new-hash",
          reason: "补充解析失败提示。",
        }),
      },
      {
        id: "review-request",
        body: JSON.stringify({
          type: "review_request",
          layer: 3,
          taskId: "l2",
          specRef: "specs/structured-payload-rendering.md",
          specHash: "b7c2cf1f",
          diffSummary: "L2 已通过,请进行架构检视。",
        }),
      },
      {
        id: "review-result",
        body: JSON.stringify({
          type: "review_result",
          layer: 3,
          taskId: "l2",
          verdict: "findings",
          findings: [{ severity: "中", note: "需要补测试。" }],
          note: "请补充测试后再合并。",
        }),
      },
    ];

    render(
      <RequirementTimeline
        tasks={[makeTask({ id: "l2", messageId: "spec-published" })]}
        messages={payloads.map(({ id, body }) => makeMessage({ id, body }))}
      />,
    );

    expect(
      screen.getByTestId("requirement-timeline-coordination-spec-published"),
    ).toHaveTextContent(
      "公布规范 specs/structured-payload-rendering.md @b7c2cf1f时间线只显示可读信息。",
    );
    expect(
      screen.getByTestId("requirement-timeline-coordination-spec-amended"),
    ).toHaveTextContent(
      "修订规范 specs/structured-payload-rendering.md → new-hash",
    );
    expect(
      screen.getByTestId("requirement-timeline-coordination-review-request"),
    ).toHaveTextContent("交回 L3 检视");
    expect(
      screen.getByTestId("requirement-timeline-coordination-review-result"),
    ).toHaveTextContent("检视者公布 L3 裁决 · 有发现项");

    const timeline = screen.getByTestId("requirement-timeline");
    expect(timeline).not.toHaveTextContent('"type"');
    expect(timeline).not.toHaveTextContent("请补充测试后再合并");
    expect(timeline).not.toHaveTextContent("需要补测试");
  });

  it("形似结构化载荷但解析失败时显式标注并折叠保留原文", () => {
    const malformed = '{"type":"review_result","layer":3,"findings":"坏形状"}';
    render(
      <RequirementTimeline
        tasks={[makeTask({ id: "t-1", messageId: "malformed" })]}
        messages={[makeMessage({ id: "malformed", body: malformed })]}
      />,
    );

    expect(
      screen.getByTestId("requirement-timeline-invalid-coordination-malformed"),
    ).toHaveTextContent("无法解析的协作载荷");
    expect(screen.getByText("查看原文")).toBeInTheDocument();
    expect(
      screen
        .getByTestId("requirement-timeline-invalid-coordination-malformed")
        .querySelector("details"),
    ).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("查看原文"));
    expect(
      screen.getByTestId("requirement-timeline-invalid-coordination-malformed"),
    ).toHaveTextContent(malformed);
  });

  it("消息卡片:发送者名 + 定向对象(participant → 对方名 / role → 角色名 / broadcast 无箭头)", () => {
    render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "t-1",
            messageId: "trigger-1",
            createdAt: "2026-08-01T09:00:00.000Z",
          }),
        ]}
        members={MOCK_MEMBERS}
        messages={[
          makeMessage({
            id: "m-to-participant",
            senderId: "participant-review",
            audience: "participant",
            audienceRef: "participant-coord",
            body: "spec 已冻结。这批只做服务端接线。",
          }),
          makeMessage({
            id: "m-to-role",
            senderId: "participant-coord",
            audience: "role",
            audienceRef: "reviewer",
            body: "请检视一下验收标准。",
          }),
          makeMessage({
            id: "m-broadcast",
            body: "广播给所有人",
          }),
        ]}
      />,
    );
    // participant 定向:→ 对方名(协调者)
    expect(
      screen.getByTestId("requirement-timeline-target-m-to-participant"),
    ).toHaveTextContent("→ 协调者");
    // role 定向:→ 角色名(reviewer)
    expect(
      screen.getByTestId("requirement-timeline-target-m-to-role"),
    ).toHaveTextContent("→ reviewer");
    // broadcast:无定向对象元素
    expect(
      screen.queryByTestId("requirement-timeline-target-m-broadcast"),
    ).not.toBeInTheDocument();
    // 发送者名:检视者(参与定向)/协调者(角色定向),各自卡片内出现。
    expect(
      screen.getByTestId("requirement-timeline-item-m-to-participant"),
    ).toHaveTextContent("检视者");
    expect(
      screen.getByTestId("requirement-timeline-item-m-to-role"),
    ).toHaveTextContent("协调者");
    expect(
      screen.getByText("spec 已冻结。这批只做服务端接线。"),
    ).toBeInTheDocument();
  });

  it("消息卡片:发送者角色色读 Member.roles(检视者 → bg-role-reviewer)", () => {
    render(
      <RequirementTimeline
        tasks={[makeTask({ id: "t-1" })]}
        members={MOCK_MEMBERS}
        messages={[
          makeMessage({
            id: "m-review",
            senderId: "participant-review",
            body: "检视者的消息",
          }),
        ]}
      />,
    );
    const avatar = screen.getByTestId("requirement-timeline-avatar-m-review");
    expect(avatar).toHaveClass("bg-role-reviewer");
    expect(avatar).toHaveAttribute("data-role", "reviewer");
  });

  it("消息卡片:发送者不在成员表时回落 senderId 前缀,角色回落执行者", () => {
    render(
      <RequirementTimeline
        tasks={[makeTask({ id: "t-1" })]}
        members={MOCK_MEMBERS}
        messages={[
          makeMessage({
            id: "m-unknown",
            senderId: "participant-xyz",
            body: "你好",
          }),
        ]}
      />,
    );
    expect(screen.getByText("particip")).toBeInTheDocument();
    expect(
      screen.getByTestId("requirement-timeline-avatar-m-unknown"),
    ).toHaveClass("bg-role-executor");
  });

  it("软删除消息渲染为占位,不当作正常消息展示正文", () => {
    render(
      <RequirementTimeline
        tasks={[makeTask({ id: "t-1" })]}
        members={MOCK_MEMBERS}
        messages={[
          makeMessage({
            id: "m-deleted-flag",
            body: "被删除的正文不该出现",
            deleted: true,
          }),
          makeMessage({
            id: "m-deleted-body",
            body: "[消息已删除]",
          }),
        ]}
      />,
    );
    expect(
      screen.getByTestId("requirement-timeline-deleted-m-deleted-flag"),
    ).toHaveTextContent("消息已删除");
    expect(
      screen.getByTestId("requirement-timeline-deleted-m-deleted-body"),
    ).toHaveTextContent("消息已删除");
    expect(screen.queryByText("被删除的正文不该出现")).not.toBeInTheDocument();
  });

  it("消息卡片:长正文(超过 200 字)折叠,展开后显示全文", () => {
    const longBody = `${"长".repeat(210)}END`;
    render(
      <RequirementTimeline
        tasks={[makeTask({ id: "t-1" })]}
        members={MOCK_MEMBERS}
        messages={[makeMessage({ id: "m-long", body: longBody })]}
      />,
    );
    expect(
      screen.getByTestId("requirement-timeline-item-m-long").textContent,
    ).toContain("…");
    expect(
      screen.getByTestId("requirement-timeline-item-m-long").textContent,
    ).not.toContain("END");
    fireEvent.click(screen.getByTestId("requirement-timeline-toggle-m-long"));
    expect(
      screen.getByTestId("requirement-timeline-detail-m-long").textContent,
    ).toContain("END");
  });

  it("任务卡片:executorParticipantId 命中成员时角色读 Member.roles,不再看 executorKey 字符串", () => {
    // executorKey 不含任何角色词,但成员真实角色是 coordinator → 协调者色。
    render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "t-1",
            executorKey: "codebuddy",
            executorParticipantId: "participant-coord",
          }),
        ]}
        members={MOCK_MEMBERS}
      />,
    );
    const avatar = screen.getByTestId("requirement-timeline-avatar-t-1");
    expect(avatar).toHaveClass("bg-role-coordinator");
    expect(avatar).toHaveAttribute("data-role", "coordinator");
  });

  it("任务卡片:executorParticipantId 未命中成员时回落 executorKey 字符串猜测", () => {
    render(
      <RequirementTimeline
        tasks={[makeTask({ id: "t-1", executorKey: "code-reviewer" })]}
        members={MOCK_MEMBERS}
      />,
    );
    expect(screen.getByTestId("requirement-timeline-avatar-t-1")).toHaveClass(
      "bg-role-reviewer",
    );
  });

  it("合并流按时间正序渲染:触发消息(09:00)→ 窗口内消息(11:00)→ 任务汇报(12:00)", () => {
    render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "t-1",
            messageId: "trigger-1",
            createdAt: "2026-08-01T09:00:00.000Z",
            updatedAt: "2026-08-01T12:00:00.000Z",
            diffSummary: { summary: "四处接线完成" },
          }),
        ]}
        members={MOCK_MEMBERS}
        messages={[
          // 触发消息(强关联,任务书)
          makeMessage({
            id: "trigger-1",
            createdAt: "2026-08-01T09:00:00.000Z",
            body: "任务书:四处接线",
          }),
          // 窗口内的旁路消息(时间窗口启发式归属)
          makeMessage({
            id: "m-window",
            createdAt: "2026-08-01T11:00:00.000Z",
            body: "检视者:窗口内的讨论",
          }),
        ]}
      />,
    );
    const items = Array.from(
      screen.getByTestId("requirement-timeline").querySelectorAll("li"),
    ).map((li) => li.getAttribute("data-testid"));
    expect(items).toEqual([
      "requirement-timeline-item-trigger-1",
      "requirement-timeline-item-m-window",
      "requirement-timeline-item-t-1",
    ]);
  });

  it("失败任务渲染失败条(--status-failed token,不喧宾夺主),带 error 文案", () => {
    render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "t-fail",
            status: "failed",
            diffSummary: {
              summary: "执行失败",
              error: "spawn reviewer ENOENT",
            },
          }),
        ]}
      />,
    );
    const failedBar = screen.getByTestId("requirement-timeline-failed-t-fail");
    expect(failedBar).toHaveTextContent("任务失败");
    expect(failedBar).toHaveTextContent("spawn reviewer ENOENT");
    expect(failedBar).toHaveClass("text-status-failed");
  });
});

describe("RequirementTimeline 实时输出接入 (live-output-in-timeline)", () => {
  it("running 任务:折叠态显示 liveOutputs 最后一非空行(跳过空行/空白行,单行省略)", () => {
    render(
      <RequirementTimeline
        tasks={[makeTask({ id: "t-live", status: "running" })]}
        liveOutputs={{ "t-live": "构建中...\n\n  \n正在执行测试" }}
      />,
    );
    const preview = screen.getByTestId(
      "requirement-timeline-live-preview-t-live",
    );
    expect(preview).toHaveTextContent("正在执行测试");
    expect(preview).not.toHaveTextContent("构建中");
    expect(preview).toHaveClass("truncate");
    // 折叠态不出现展开详情区。
    expect(
      screen.queryByTestId("requirement-timeline-detail-t-live"),
    ).not.toBeInTheDocument();
  });

  it("running 任务无输出:不显示预览行(不留空占位)", () => {
    render(
      <RequirementTimeline
        tasks={[makeTask({ id: "t-live", status: "running" })]}
      />,
    );
    expect(
      screen.queryByTestId("requirement-timeline-live-preview-t-live"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("requirement-timeline-toggle-t-live"),
    ).not.toBeInTheDocument();
  });

  it("展开态复用共享 LiveOutput 终端块:点击展开显示全量缓冲", () => {
    render(
      <RequirementTimeline
        tasks={[makeTask({ id: "t-live", status: "running" })]}
        liveOutputs={{ "t-live": "line1\nline2\nline3" }}
      />,
    );
    fireEvent.click(screen.getByTestId("requirement-timeline-toggle-t-live"));
    const detail = screen.getByTestId("requirement-timeline-detail-t-live");
    const output = detail.querySelector('[data-testid="task-live-output"]');
    expect(output).toBeInTheDocument();
    expect(output).toHaveClass("bg-slate-950");
    // 展开态显示全量缓冲(多行原样保留;jest-dom 默认折叠空白,显式关闭)。
    expect(output).toHaveTextContent("line1\nline2\nline3", {
      normalizeWhitespace: false,
    });
  });

  it("取值优先级:liveOutputs 优先于 diffSummary.outputTail", () => {
    render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "t-live",
            status: "running",
            diffSummary: { outputTail: "旧的尾巴" },
          }),
        ]}
        liveOutputs={{ "t-live": "实时的输出" }}
      />,
    );
    const preview = screen.getByTestId(
      "requirement-timeline-live-preview-t-live",
    );
    expect(preview).toHaveTextContent("实时的输出");
    expect(preview).not.toHaveTextContent("旧的尾巴");
  });

  it("取值优先级:liveOutputs 为空时回落 diffSummary.outputTail", () => {
    render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "t-live",
            status: "running",
            diffSummary: { outputTail: "兜底尾巴" },
          }),
        ]}
      />,
    );
    expect(
      screen.getByTestId("requirement-timeline-live-preview-t-live"),
    ).toHaveTextContent("兜底尾巴");
  });

  it("done 任务折叠态不显示输出预览行(设计表:折叠显示汇报摘要),但展开入口仍在", () => {
    render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "t-done",
            diffSummary: { summary: "做完了", outputTail: "尾巴" },
          }),
        ]}
      />,
    );
    expect(
      screen.queryByTestId("requirement-timeline-live-preview-t-done"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("requirement-timeline-toggle-t-done"));
    expect(
      screen.getByTestId("requirement-timeline-detail-t-done").textContent,
    ).toContain("尾巴");
  });

  it("失败任务:diffSummary.outputTail 展开态仍可见(未被误删)", () => {
    render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "t-fail",
            status: "failed",
            diffSummary: {
              summary: "失败",
              error: "boom",
              outputTail: "崩溃前最后输出",
            },
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("requirement-timeline-toggle-t-fail"));
    expect(
      screen.getByTestId("requirement-timeline-detail-t-fail").textContent,
    ).toContain("崩溃前最后输出");
  });
});
