import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatMessageTime } from "@/pages/app/groups/messages/lib";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";
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
