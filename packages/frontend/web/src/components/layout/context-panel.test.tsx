import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ContextPanel, {
  ContextPanelTrigger,
  GroupContextPanelProvider,
} from "@/components/layout/context-panel";
import {
  createFetchMock,
  jsonResponse,
  renderWithProviders,
} from "@/test/utils";

const MEMBERS = [
  {
    agentId: "agent-1",
    name: "hermes-mac",
    type: "hermes",
    device: "mac-mini",
    roles: ["coordinator"],
    prompt: "负责统筹协调与最终验收",
    joinedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    agentId: "agent-2",
    name: "win-hermes",
    type: "hermes",
    device: "win-pc",
    roles: ["reviewer"],
    prompt: null,
    joinedAt: "2026-08-01T00:01:00.000Z",
  },
];

const TASKS = [
  {
    id: "task-1",
    groupId: "group-1",
    messageId: "msg-1",
    executorAgentId: "agent-1",
    executorKey: "codebuddy",
    status: "running",
    checkpointRef: null,
    diffSummary: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: null,
  },
];

function panelFetchMock(options: { patchError?: number } = {}) {
  return createFetchMock([
    {
      match: (url) => url.endsWith("/api/groups/group-1/members"),
      respond: () => jsonResponse(MEMBERS),
    },
    {
      match: (url) =>
        /\/api\/groups\/group-1\/members\/[^/]+$/.test(String(url)) &&
        String(url).includes("/members/"),
      respond: (_url, init) => {
        if (options.patchError) {
          return jsonResponse({ message: "更新失败" }, options.patchError);
        }
        const body = JSON.parse(String(init?.body)) as {
          roles: string[];
          prompt: string;
        };
        return jsonResponse({
          agentId: "agent-1",
          roles: body.roles,
          prompt: body.prompt,
        });
      },
    },
    {
      match: (url) => url.endsWith("/api/groups/group-1/tasks"),
      respond: () => jsonResponse(TASKS),
    },
    {
      match: (url) => url.endsWith("/api/groups/group-1/messages"),
      respond: () => jsonResponse([]),
    },
    {
      match: (url) =>
        /\/api\/groups\/group-1$/.test(String(url)) &&
        !String(url).includes("?"),
      respond: () =>
        jsonResponse({ id: "group-1", title: "评审任务", status: "active" }),
    },
  ]);
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { innerWidth?: number }).innerWidth;
});

/** 渲染「触发器 + 右栏面板」:两者共享同一个开合 Provider。 */
function renderPanel() {
  renderWithProviders(
    <GroupContextPanelProvider>
      <div className="flex">
        <ContextPanelTrigger />
        <ContextPanel groupId="group-1" />
      </div>
    </GroupContextPanelProvider>,
    "/groups/group-1",
  );
}

describe("ContextPanel 右栏上下文面板", () => {
  it("lg+ 常驻:三个 Tab 可切换,成员为默认 Tab", async () => {
    vi.stubGlobal("fetch", panelFetchMock());
    setViewport(1280);
    renderPanel();

    // 常驻 aside 渲染
    expect(await screen.findByTestId("context-panel")).toBeInTheDocument();
    // 三个 Tab 均在
    expect(screen.getByTestId("context-tab-members")).toBeInTheDocument();
    expect(screen.getByTestId("context-tab-tasks")).toBeInTheDocument();
    expect(screen.getByTestId("context-tab-project")).toBeInTheDocument();
    // 默认成员 Tab:成员列表可见
    expect(await screen.findByTestId("members-tab")).toBeInTheDocument();
    expect(await screen.findByText("hermes-mac")).toBeInTheDocument();

    // 切到任务 Tab
    fireEvent.click(screen.getByTestId("context-tab-tasks"));
    expect(await screen.findByTestId("tasks-tab")).toBeInTheDocument();
    expect(await screen.findByText("执行中")).toBeInTheDocument();

    // 切到项目 Tab
    fireEvent.click(screen.getByTestId("context-tab-project"));
    expect(await screen.findByTestId("project-tab")).toBeInTheDocument();
  });

  it("成员 Tab:点击成员行打开编辑弹窗,保存 → PATCH roles+prompt", async () => {
    const mock = panelFetchMock();
    vi.stubGlobal("fetch", mock);
    setViewport(1280);
    renderPanel();

    await screen.findByText("hermes-mac");
    fireEvent.click(screen.getByTestId("member-row-agent-1"));

    // 弹窗:角色勾选 + 提示词输入
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    const promptInput = screen.getByLabelText(
      "本群分工提示词(可选)",
    ) as HTMLTextAreaElement;
    fireEvent.change(promptInput, { target: { value: "新分工说明" } });
    // 勾选检视者(默认已勾选协调者)
    fireEvent.click(screen.getByLabelText("编辑角色 检视者"));

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const patch = mock.mock.calls.find(
        ([url, init]) =>
          init?.method === "PATCH" &&
          String(url) === "/api/groups/group-1/members/agent-1",
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(String(patch![1]?.body))).toEqual({
        roles: ["coordinator", "reviewer"],
        prompt: "新分工说明",
      });
    });
    // 保存成功后弹窗关闭并刷新成员列表
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("成员 Tab:至少选一个角色校验", async () => {
    vi.stubGlobal("fetch", panelFetchMock());
    setViewport(1280);
    renderPanel();

    await screen.findByText("hermes-mac");
    fireEvent.click(screen.getByTestId("member-row-agent-1"));
    await screen.findByRole("dialog");

    // 取消默认勾选的协调者 → 空角色保存被拦截
    fireEvent.click(screen.getByLabelText("编辑角色 协调者"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("至少选择一个角色")).toBeInTheDocument();
  });

  it("md(<1024):右栏折叠为按钮,点击唤起 Sheet overlay", async () => {
    vi.stubGlobal("fetch", panelFetchMock());
    setViewport(900);
    renderPanel();

    // 无常驻 aside,按钮可见
    expect(screen.queryByTestId("context-panel")).toBeNull();
    const trigger = screen.getByRole("button", { name: "上下文" });
    expect(trigger).toBeInTheDocument();

    fireEvent.click(trigger);
    // overlay 抽屉出现,内部 Tab 可用
    expect(
      await screen.findByTestId("context-panel-sheet"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("context-tab-members")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("context-tab-project"));
    expect(await screen.findByTestId("project-tab")).toBeInTheDocument();
  });

  it("<768 移动端:按钮唤起全屏 overlay", async () => {
    vi.stubGlobal("fetch", panelFetchMock());
    setViewport(600);
    renderPanel();

    expect(screen.queryByTestId("context-panel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "上下文" }));

    expect(
      await screen.findByTestId("context-panel-sheet"),
    ).toBeInTheDocument();
    expect(await screen.findByTestId("members-tab")).toBeInTheDocument();
  });
});
