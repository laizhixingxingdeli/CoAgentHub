import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";
import { createFetchMock, jsonResponse } from "@/test/utils";
import RequirementTimeline from "./RequirementTimeline";

/** 构造最小可用的 TaskItem(与 RequirementTimeline.test.tsx 同款)。 */
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

const SUMMARY_LINE = "[思考 #t7] 先确认守卫在哪个文件";
const DETAIL_TEXT =
  "完整原文:守卫在 requirement-workspace.tsx 的 outputTail 优先级里";

function detailFetchMock(fullText: string) {
  return createFetchMock([
    {
      match: () => true,
      respond: () =>
        jsonResponse({ id: "t7", kind: "thinking", at: "…", text: fullText }),
    },
  ]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RequirementTimeline 输出明细就地展开(R1/R4)", () => {
  it("运行中任务:展开卡片后,带 #id 摘要行可展开完整原文", async () => {
    const fetchMock = detailFetchMock(DETAIL_TEXT);
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RequirementTimeline
        tasks={[makeTask({ id: "t-live", status: "running" })]}
        liveOutputs={{ "t-live": SUMMARY_LINE }}
      />,
    );
    // 折叠态预览仍是纯文本(既有渲染),展开卡片后出现可展开控件。
    const preview = screen.getByTestId(
      "requirement-timeline-live-preview-t-live",
    );
    expect(preview).toHaveTextContent(SUMMARY_LINE);

    fireEvent.click(screen.getByTestId("requirement-timeline-toggle-t-live"));
    fireEvent.click(screen.getByTestId("output-entry-toggle-t7"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/groups/group-1/tasks/t-live/output/t7",
    );
    expect(
      await screen.findByTestId("output-entry-detail-t7"),
    ).toHaveTextContent(DETAIL_TEXT);
  });

  it("终态任务(done, diffSummary.outputTail)带 #id 摘要行同样可展开(R4 必测)", async () => {
    const fetchMock = detailFetchMock("终态任务也能取回完整原文");
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RequirementTimeline
        tasks={[
          makeTask({
            id: "t-done",
            status: "done",
            diffSummary: { outputTail: SUMMARY_LINE },
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("requirement-timeline-toggle-t-done"));
    expect(screen.getByTestId("output-entry-toggle-t7")).toHaveTextContent(
      SUMMARY_LINE,
    );
    fireEvent.click(screen.getByTestId("output-entry-toggle-t7"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/groups/group-1/tasks/t-done/output/t7",
    );
    expect(
      await screen.findByTestId("output-entry-detail-t7"),
    ).toHaveTextContent("终态任务也能取回完整原文");
  });

  it("运行中追加新行:已展开条目保持展开,新行正常渲染(R2)", async () => {
    const fetchMock = detailFetchMock(DETAIL_TEXT);
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <RequirementTimeline
        tasks={[makeTask({ id: "t-live", status: "running" })]}
        liveOutputs={{ "t-live": SUMMARY_LINE }}
      />,
    );
    fireEvent.click(screen.getByTestId("requirement-timeline-toggle-t-live"));
    fireEvent.click(screen.getByTestId("output-entry-toggle-t7"));
    expect(
      await screen.findByTestId("output-entry-detail-t7"),
    ).toHaveTextContent(DETAIL_TEXT);

    // 模拟 WS 追加新摘要行:liveOutputs 变长,已展开的 t7 不得收起。
    rerender(
      <RequirementTimeline
        tasks={[makeTask({ id: "t-live", status: "running" })]}
        liveOutputs={{
          "t-live": `${SUMMARY_LINE}\n[思考 #t8] 追加的思考`,
        }}
      />,
    );
    expect(screen.getByTestId("output-entry-detail-t7")).toHaveTextContent(
      DETAIL_TEXT,
    );
    expect(screen.getByTestId("output-entry-toggle-t8")).toHaveTextContent(
      "[思考 #t8] 追加的思考",
    );
  });

  it("明细取不到(404):就地显示失败原因,不静默收起(R3)", async () => {
    const fetchMock = createFetchMock([
      {
        match: () => true,
        respond: () =>
          jsonResponse(
            {
              message: "明细文件不存在(可能已被 14 天清理,或该任务无明细记录)",
            },
            404,
          ),
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RequirementTimeline
        tasks={[makeTask({ id: "t-live", status: "running" })]}
        liveOutputs={{ "t-live": SUMMARY_LINE }}
      />,
    );
    fireEvent.click(screen.getByTestId("requirement-timeline-toggle-t-live"));
    fireEvent.click(screen.getByTestId("output-entry-toggle-t7"));
    expect(
      await screen.findByTestId("output-entry-detail-t7"),
    ).toHaveTextContent("明细文件不存在");
  });
});
