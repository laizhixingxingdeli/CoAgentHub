import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ContextPanel, {
  ContextPanelTrigger,
  GroupContextPanelProvider,
} from "@/components/layout/context-panel";
import {
  createFetchMock,
  jsonResponse,
  renderWithProviders,
} from "@/test/utils";
import { MockWebSocket } from "@/test/ws-mock";

const MEMBERS = [
  {
    participantId: "participant-1",
    name: "hermes-mac",
    device: "mac-mini",
    roles: ["coordinator"],
    prompt: "负责统筹协调与最终验收",
    joinedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    participantId: "participant-2",
    name: "win-hermes",
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
    executorParticipantId: "participant-1",
    executorKey: "codebuddy",
    status: "running",
    checkpointRef: null,
    diffSummary: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: null,
  },
];

function panelFetchMock(
  options: { patchError?: number; groupStatus?: "active" | "archived" } = {},
) {
  const { groupStatus = "active" } = options;
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
          participantId: "participant-1",
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
        jsonResponse({
          id: "group-1",
          title: "评审任务",
          status: groupStatus,
        }),
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
  MockWebSocket.reset();
  delete (window as { innerWidth?: number }).innerWidth;
});

/** 任务 Tab 的 TasksTab 现在订阅 useGroupWs(实时输出):jsdom 无 WebSocket,
 * 统一 stub 成 MockWebSocket,连接失败由 hook 的指数退避静默重试。 */
beforeEach(() => {
  vi.stubGlobal("WebSocket", MockWebSocket);
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
    fireEvent.click(screen.getByTestId("member-row-participant-1"));

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
          String(url) === "/api/groups/group-1/members/participant-1",
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
    fireEvent.click(screen.getByTestId("member-row-participant-1"));
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

    // 无常驻 aside,按钮可见(新交互:标题栏「面板」开关,非桌面唤起 overlay)
    expect(screen.queryByTestId("context-panel")).toBeNull();
    const trigger = screen.getByRole("button", { name: "打开面板" });
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
    fireEvent.click(screen.getByRole("button", { name: "打开面板" }));

    expect(
      await screen.findByTestId("context-panel-sheet"),
    ).toBeInTheDocument();
    expect(await screen.findByTestId("members-tab")).toBeInTheDocument();
  });

  it("归档群组:任务 Tab 停止/回滚按钮禁用并提示「群已归档,只读」", async () => {
    vi.stubGlobal("fetch", panelFetchMock({ groupStatus: "archived" }));
    setViewport(1280);
    renderPanel();

    await screen.findByText("hermes-mac");
    fireEvent.click(screen.getByTestId("context-tab-tasks"));
    await screen.findByTestId("tasks-tab");

    // TASKS[0] 是 running → 有停止按钮;归档只读下禁用 + 提示。
    const stop = await screen.findByTestId("task-stop-task-1");
    expect(stop).toBeDisabled();
    expect(stop.closest("span")?.getAttribute("title")).toBe("群已归档,只读");
  });

  it("归档群组:成员 Tab 行点击编辑禁用并提示「群已归档,只读」", async () => {
    vi.stubGlobal("fetch", panelFetchMock({ groupStatus: "archived" }));
    setViewport(1280);
    renderPanel();

    const row = await screen.findByTestId("member-row-participant-1");
    expect(row).toBeDisabled();
    expect(row.getAttribute("title")).toBe("群已归档,只读");
    // 点击被禁用的行不会打开编辑弹窗。
    fireEvent.click(row);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  /* ---------------- 任务面板增强:实时输出 + 执行历史 + 回滚状态 ---------------- */

  const OUTPUT_TASKS = [
    {
      id: "task-1",
      groupId: "group-1",
      messageId: "msg-1",
      executorParticipantId: "participant-1",
      executorKey: "codebuddy",
      status: "running",
      checkpointRef: null,
      diffSummary: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: null,
      attempts: [
        {
          n: 1,
          startedAt: "2026-08-01T00:00:00.000Z",
          status: "running",
        },
      ],
    },
  ];

  function outputFetchMock() {
    return createFetchMock([
      {
        match: (url) => url.endsWith("/api/groups/group-1/members"),
        respond: () => jsonResponse(MEMBERS),
      },
      {
        match: (url) =>
          String(url).includes("/api/groups/group-1/tasks?includeOutput=1"),
        respond: () =>
          jsonResponse([
            { ...OUTPUT_TASKS[0], outputTail: "line-1\nline-2\nline-3" },
          ]),
      },
      {
        match: (url) =>
          String(url).endsWith("/api/groups/group-1/tasks") &&
          !String(url).includes("includeOutput"),
        respond: () => jsonResponse(OUTPUT_TASKS),
      },
      {
        match: (url) => String(url).endsWith("/api/groups/group-1/messages"),
        respond: () => jsonResponse([]),
      },
      {
        match: (url) => /\/api\/groups\/group-1$/.test(String(url)),
        respond: () =>
          jsonResponse({
            id: "group-1",
            title: "任务面板增强",
            status: "active",
          }),
      },
    ]);
  }

  it("任务 Tab:running 任务实时输出默认展开可见(无需点击);点击折叠,再点展开 → includeOutput 兜底", async () => {
    vi.stubGlobal("fetch", outputFetchMock());
    setViewport(1280);
    renderPanel();

    await screen.findByText("hermes-mac");
    fireEvent.click(screen.getByTestId("context-tab-tasks"));
    await screen.findByTestId("tasks-tab");
    expect(await screen.findByText("执行中")).toBeInTheDocument();

    // running 任务默认展开:实时输出区无需点击即可见。
    expect(await screen.findByTestId("task-live-output")).toBeInTheDocument();
    expect(screen.getByText("执行历史:")).toBeInTheDocument();
    expect(screen.getByText(/第 1 次 执行中/)).toBeInTheDocument();

    // 点击折叠按钮 → 输出区收起。
    fireEvent.click(screen.getByTestId("task-expand-task-1"));
    expect(screen.queryByTestId("task-live-output")).toBeNull();

    // 再点展开 → includeOutput 兜底拉取实时输出。
    fireEvent.click(screen.getByTestId("task-expand-task-1"));
    expect(await screen.findByTestId("task-live-output")).toBeInTheDocument();
    expect(screen.getByTestId("task-live-output")).toHaveTextContent("line-2");
  });

  it("任务 Tab:WS task_output 事件追加到默认展开行的实时输出", async () => {
    vi.stubGlobal("fetch", outputFetchMock());
    setViewport(1280);
    renderPanel();

    await screen.findByText("hermes-mac");
    fireEvent.click(screen.getByTestId("context-tab-tasks"));
    await screen.findByTestId("tasks-tab");
    // running 默认展开,无需点击即可接收 WS 追加。
    await screen.findByTestId("task-live-output");

    const ws = MockWebSocket.instances.find((w) => w.url.includes("/api/ws"));
    expect(ws).toBeDefined();
    ws!.open();
    ws!.receive(
      JSON.stringify({
        type: "task_output",
        groupId: "group-1",
        taskId: "task-1",
        chunk: "\nline-4-live",
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("task-live-output")).toHaveTextContent(
        "line-4-live",
      );
    });
  });

  it("任务 Tab:WS task_stall_alert 事件 → 任务行黄色警示样式 + ⚠️ 徽标(非失败)", async () => {
    vi.stubGlobal("fetch", outputFetchMock());
    setViewport(1280);
    renderPanel();

    await screen.findByText("hermes-mac");
    fireEvent.click(screen.getByTestId("context-tab-tasks"));
    await screen.findByTestId("tasks-tab");
    // 初始无警示。
    expect(screen.queryByTestId("task-stall-alert-task-1")).toBeNull();
    expect(
      screen.getByTestId("task-row-task-1").getAttribute("data-alerted"),
    ).toBeNull();

    const ws = MockWebSocket.instances.find((w) => w.url.includes("/api/ws"));
    expect(ws).toBeDefined();
    ws!.open();
    ws!.receive(
      JSON.stringify({
        type: "task_stall_alert",
        groupId: "group-1",
        taskId: "task-1",
      }),
    );

    // ⚠️ 徽标出现 + 行级警示标记(状态仍 running,非失败)。
    await waitFor(() => {
      expect(screen.getByTestId("task-stall-alert-task-1")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("task-row-task-1").getAttribute("data-alerted"),
    ).toBe("true");
    expect(screen.getByText("执行中")).toBeInTheDocument();
    expect(screen.getByText(/无进展,请介入/)).toBeInTheDocument();
  });

  it("任务 Tab:回滚按钮点击 → 「回滚中…」→ 轮询确认后「已恢复」", async () => {
    let rollbackDone = false;
    const mock = createFetchMock([
      {
        match: (url) => String(url).endsWith("/api/groups/group-1/members"),
        respond: () => jsonResponse(MEMBERS),
      },
      {
        match: (url) => String(url).endsWith("/api/groups/group-1/tasks"),
        respond: () =>
          jsonResponse([
            {
              ...OUTPUT_TASKS[0],
              status: "done",
              checkpointRef: "refs/coagenthub-cp/task-1",
              diffSummary: rollbackDone
                ? { error: "rollback" }
                : { summary: "ok" },
            },
          ]),
      },
      {
        match: (url) => String(url).endsWith("/api/groups/group-1/messages"),
        respond: () => jsonResponse([]),
      },
      {
        match: (url) => /\/api\/groups\/group-1$/.test(String(url)),
        respond: () =>
          jsonResponse({ id: "group-1", title: "回滚体验", status: "active" }),
      },
    ]);
    vi.stubGlobal("fetch", mock);
    setViewport(1280);
    // 回滚需要 coordinator/human 身份:绑定身份 → canControl=true(否则按钮禁用)。
    localStorage.setItem("coagenthub.agentId", "participant-1");
    renderPanel();

    await screen.findByText("hermes-mac");
    fireEvent.click(screen.getByTestId("context-tab-tasks"));
    await screen.findByTestId("tasks-tab");
    const rollbackBtn = await screen.findByTestId("task-rollback-task-1");
    expect(rollbackBtn).toHaveTextContent("回滚");

    fireEvent.click(rollbackBtn);
    // 点击后:发送「回滚 <taskId>」消息 + 按钮进入「回滚中…」禁用态。
    await waitFor(() => {
      const post = mock.mock.calls.find(
        ([url, init]) =>
          init?.method === "POST" &&
          String(url).endsWith("/api/groups/group-1/messages"),
      );
      expect(post).toBeDefined();
      expect(JSON.parse(String(post![1]?.body)).body).toBe("回滚 task-1");
    });
    expect(screen.getByTestId("task-rollback-task-1")).toHaveTextContent(
      "回滚中…",
    );
    expect(screen.getByTestId("task-rollback-task-1")).toBeDisabled();

    // 轮询确认:diffSummary.error === "rollback" → 「已恢复」。
    rollbackDone = true;
    await waitFor(
      () => {
        expect(screen.getByTestId("task-rollback-task-1")).toHaveTextContent(
          "已恢复",
        );
      },
      { timeout: 4_000 },
    );
  });
});
