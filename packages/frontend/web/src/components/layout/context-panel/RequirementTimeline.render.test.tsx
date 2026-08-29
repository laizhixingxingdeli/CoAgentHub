import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";
import type { MessageItem } from "@/pages/app/groups/messages/types";
import RequirementTimeline from "./RequirementTimeline";

/**
 * 消息在时间线里的两种渲染口径(spec live-output-hide-thinking-and-autoscroll
 * R6/R7):
 *  - R6:`content_type=task_status`(🚀/📋/⏳/✅/❌ 状态条)→ 单行轻量状态提示,
 *    不占发言气泡;`text/plain`(任务书/汇报/findings)保持发言卡片。
 *  - R7:发言卡片正文按 markdown 渲染(防注入见 MarkdownBody 的文件头与用例)。
 */

function makeTask(overrides: Partial<TaskItem> & { id: string }): TaskItem {
  return {
    groupId: "group-1",
    messageId: "trigger",
    executorParticipantId: "participant-1",
    executorKey: "codebuddy",
    status: "running",
    checkpointRef: null,
    specRef: "specs/r.md",
    specHash: null,
    diffSummary: null,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

/** 默认落在任务窗口 [09:00, 10:00] 内,且是任务的触发消息 → 一定进时间线。 */
function makeMessage(
  id: string,
  body: string,
  overrides: Partial<MessageItem> = {},
): MessageItem {
  return {
    id,
    groupId: "group-1",
    senderId: "participant-coord",
    parentId: null,
    audience: "broadcast",
    audienceRef: null,
    body,
    contentType: "text/plain",
    fileRef: null,
    depth: 0,
    createdAt: "2026-08-01T09:30:00.000Z",
    ...overrides,
  };
}

function renderTimeline(messages: MessageItem[]) {
  return render(
    <RequirementTimeline
      tasks={[makeTask({ id: "t-1" })]}
      messages={messages}
    />,
  );
}

describe("RequirementTimeline 消息渲染口径(R6/R7)", () => {
  it("R6:task_status 渲染为单行轻量状态提示,不占发言气泡", () => {
    renderTimeline([
      makeMessage("status-1", "⏳ 任务等待执行器额度恢复(预计 10:05)", {
        contentType: "task_status",
      }),
    ]);

    const item = screen.getByTestId("requirement-timeline-item-status-1");
    expect(item).toHaveAttribute("data-content-type", "task_status");
    // 状态条:单行提示 + 时间,没有发言卡片那套头像/角色徽章。
    expect(
      screen.getByTestId("requirement-timeline-status-status-1"),
    ).toHaveTextContent("⏳ 任务等待执行器额度恢复(预计 10:05)");
    expect(
      screen.queryByTestId("requirement-timeline-avatar-status-1"),
    ).toBeNull();
    expect(
      screen.queryByTestId("requirement-timeline-target-status-1"),
    ).toBeNull();
  });

  it("R6:多行状态卡片只取首行做提示,完整正文挂在 title 上", () => {
    const card = [
      "✅ 任务完成 CodeBuddy",
      "────────────────",
      "提交  0123456789ab",
      "测试  全部通过 (42 tests)",
    ].join("\n");
    renderTimeline([
      makeMessage("status-card", card, { contentType: "task_status" }),
    ]);

    const hint = screen.getByTestId("requirement-timeline-status-status-card");
    expect(hint).toHaveTextContent("✅ 任务完成 CodeBuddy");
    expect(hint).toHaveAttribute("title", card);
    // 其余行不铺开成正文(详细汇报在同一时间线的任务卡片里)。
    expect(screen.queryByText(/全部通过/)).toBeNull();
  });

  it("R6:text/plain 仍是发言卡片(头像 + 发送者 + 正文)", () => {
    renderTimeline([
      makeMessage("plain-1", "请按规范修掉滚动", {
        contentType: "text/plain",
      }),
    ]);
    expect(
      screen.getByTestId("requirement-timeline-item-plain-1"),
    ).not.toHaveAttribute("data-content-type", "task_status");
    expect(
      screen.getByTestId("requirement-timeline-avatar-plain-1"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("requirement-timeline-status-plain-1"),
    ).toBeNull();
  });

  it("R7:任务书正文按 markdown 渲染(标题/重点/列表成为结构,不再是原样文本)", () => {
    renderTimeline([
      makeMessage(
        "book-1",
        "# 任务书\n\n**重点**:输出跟随滚动\n\n- 展开到底\n- 上滚不拉回",
      ),
    ]);
    // 时间线本身是 <ul>,故把断言收在消息卡片内。
    const card = within(screen.getByTestId("requirement-timeline-item-book-1"));
    expect(card.getByRole("heading", { level: 1 })).toHaveTextContent("任务书");
    expect(card.getByText("重点").tagName).toBe("STRONG");
    expect(
      card.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual(["展开到底", "上滚不拉回"]);
  });
});
