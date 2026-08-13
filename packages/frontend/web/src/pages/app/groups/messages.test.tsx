import {
  act,
  fireEvent,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GroupLayout from "@/components/layout/group-layout";
import { __resetUnreadStore, useUnread } from "@/hooks/use-unread";
import { AGENT_ID_KEY, AGENT_TOKEN_KEY } from "@/lib/api-client";
import { groupMessageFrame } from "@/test/frames";
import {
  createFetchMock,
  jsonResponse,
  renderWithProviders,
} from "@/test/utils";
import { MockWebSocket } from "@/test/ws-mock";
import GroupMessagesPage, {
  AGENT_COLORS,
  agentColor,
  detectMention,
  formatMessageTime,
  resolveAudience,
} from "./messages";

const MESSAGES = [
  {
    id: "msg-1",
    groupId: "group-1",
    senderId: "agent-1",
    parentId: null,
    audience: "broadcast",
    audienceRef: null,
    body: "任务草稿",
    depth: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
  },
  {
    id: "msg-2",
    groupId: "group-1",
    senderId: "agent-2",
    parentId: "msg-1",
    audience: "role",
    audienceRef: "reviewer",
    body: "修正意见",
    depth: 1,
    createdAt: "2026-08-01T00:01:00.000Z",
  },
];

const MEMBERS = [
  {
    agentId: "agent-1",
    name: "hermes-mac",
    type: "hermes",
    device: "mac-mini",
    roles: ["coordinator"],
    joinedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    agentId: "agent-2",
    name: "win-hermes",
    type: "hermes",
    device: "win-pc",
    roles: ["reviewer"],
    joinedAt: "2026-08-01T00:01:00.000Z",
  },
];

function messagesFetchMock(
  messages: unknown[] = MESSAGES,
  members: unknown[] = MEMBERS,
  groupStatus: "active" | "archived" = "active",
  options: {
    projectPath?: string | null;
    patchError?: number;
    /** 任务面板 GET /tasks 返回;缺省空列表。 */
    tasks?: unknown[];
    /** 第 2 次 GET /tasks 起返回(模拟命令后服务端状态变化)。 */
    tasksAfterCommand?: unknown[];
    /** 命令 POST /messages 的失败状态码(403 = 无权限)。 */
    commandError?: number;
  } = {},
) {
  // Ticket 33: 项目绑定状态 — PATCH 更新它,GET 详情返回它。
  let boundProjectPath: string | null = options.projectPath ?? null;
  // 任务面板:统计 GET /tasks 次数,便于断言「命令后刷新」。
  let tasksGets = 0;
  return createFetchMock([
    {
      // Ticket 33: PATCH /api/groups/:id — 绑定/解绑项目路径。必须排在下方
      // GET 详情匹配之前(createFetchMock 首个匹配生效)。
      match: (url, init) =>
        init?.method === "PATCH" &&
        /\/api\/groups\/[^/]+$/.test(String(url)) &&
        !String(url).includes("?"),
      respond: (_url, init) => {
        if (options.patchError) {
          return jsonResponse(
            {
              code: "INVALID_REQUEST",
              message: "projectPath 必须是存在的绝对目录路径:/definitely/nope",
            },
            options.patchError,
          );
        }
        const { projectPath } = JSON.parse(String(init?.body)) as {
          projectPath: string | null;
        };
        boundProjectPath = projectPath;
        return jsonResponse({
          id: "group-1",
          title: "评审任务",
          status: groupStatus,
          projectPath,
        });
      },
    },
    {
      // Single-group detail (ticket 16): drives the read-only banner when the
      // group is archived. `/api/groups/<id>` — not the /messages or /members
      // subpaths.
      match: (url) =>
        /\/api\/groups\/[^/]+$/.test(String(url)) && !String(url).includes("?"),
      respond: () =>
        jsonResponse({
          id: "group-1",
          title: "评审任务",
          status: groupStatus,
          projectPath: boundProjectPath,
        }),
    },
    {
      match: (url) =>
        String(url).includes("/api/groups/") &&
        String(url).endsWith("/messages"),
      respond: (_url, init) => {
        if ((init?.method ?? "GET") === "POST") {
          if (options.commandError) {
            return jsonResponse({ message: "forbidden" }, options.commandError);
          }
          return jsonResponse({ id: "msg-9", body: "已发送" });
        }
        return jsonResponse(messages);
      },
    },
    {
      // 任务面板:GET /groups/:id/tasks — 命令发送成功后再拉一次(状态刷新)。
      match: (url) =>
        String(url).includes("/api/groups/") && String(url).endsWith("/tasks"),
      respond: () => {
        tasksGets += 1;
        const tasks =
          tasksGets > 1 && options.tasksAfterCommand
            ? options.tasksAfterCommand
            : (options.tasks ?? []);
        return jsonResponse(tasks);
      },
    },
    {
      // Ticket 22 message edit/delete: PATCH echoes the row with the new body +
      // updatedAt; DELETE answers success (the UI marks the placeholder locally).
      match: (url, init) =>
        String(url).includes("/api/groups/") &&
        /\/messages\/[^/]+$/.test(String(url)) &&
        (init?.method === "PATCH" || init?.method === "DELETE"),
      respond: (url, init) => {
        if (init?.method === "DELETE") {
          return jsonResponse({ success: true });
        }
        const messageId = String(url).split("/").pop() ?? "";
        const existing = (messages as Array<Record<string, unknown>>).find(
          (m) => m.id === messageId,
        );
        const body = JSON.parse(String(init?.body)) as { body: string };
        return jsonResponse({
          ...(existing ?? {
            id: messageId,
            groupId: "group-1",
            senderId: "agent-1",
            parentId: null,
            audience: "broadcast",
            audienceRef: null,
            body: "",
            depth: 0,
            createdAt: "2026-08-01T00:00:00.000Z",
          }),
          body: body.body,
          updatedAt: "2026-08-02T00:05:00.000Z",
        });
      },
    },
    {
      match: (url) =>
        String(url).includes("/api/groups/") &&
        String(url).endsWith("/members"),
      respond: () => jsonResponse(members),
    },
  ]);
}

/* ---------------- 任务面板(任务控制 UI enhancement) ---------------- */

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
  {
    id: "task-2",
    groupId: "group-1",
    messageId: "msg-2",
    executorAgentId: "agent-2",
    executorKey: "codebuddy2",
    status: "done",
    checkpointRef: "refs/coagenthub-cp/task-2",
    diffSummary: { hash: "abc123def4567890", summary: "1 file changed" },
    createdAt: "2026-08-01T00:01:00.000Z",
    updatedAt: "2026-08-01T00:02:00.000Z",
  },
];

describe("任务面板(任务控制 UI,右栏任务 Tab)", () => {
  /** 三栏布局渲染(右栏 lg+ 常驻),切到「任务」Tab 打开任务面板。 */
  const renderGroupPage = (mock: ReturnType<typeof messagesFetchMock>) => {
    stubFetch(mock);
    renderWithProviders(
      <GroupLayout groupId="group-1">
        <GroupMessagesPage />
      </GroupLayout>,
      "/groups/group-1",
    );
  };

  const openTasksTab = async () => {
    await screen.findByText("任务草稿");
    fireEvent.click(screen.getByTestId("context-tab-tasks"));
    await screen.findByTestId("task-panel");
  };

  it("打开面板:状态徽章/执行器/正文预览/时间 + 停止/回滚按钮", async () => {
    renderGroupPage(
      messagesFetchMock(MESSAGES, MEMBERS, "active", { tasks: TASKS }),
    );
    await openTasksTab();

    // running → 停止;done + checkpointRef → 回滚
    const row1 = within(screen.getByTestId("task-row-task-1"));
    expect(row1.getByText("执行中")).toBeInTheDocument();
    expect(row1.getByText("hermes-mac")).toBeInTheDocument();
    expect(row1.getByText("任务草稿")).toBeInTheDocument();
    expect(row1.getByTestId("task-time-task-1")).toBeInTheDocument();
    expect(row1.getByTestId("task-stop-task-1")).toBeInTheDocument();
    expect(row1.queryByTestId("task-rollback-task-1")).toBeNull();

    const row2 = within(screen.getByTestId("task-row-task-2"));
    expect(row2.getByText("已完成")).toBeInTheDocument();
    expect(row2.getByText("win-hermes")).toBeInTheDocument();
    expect(row2.getByText(/hash abc123/)).toBeInTheDocument();
    expect(row2.getByTestId("task-rollback-task-2")).toBeInTheDocument();
    expect(row2.queryByTestId("task-stop-task-2")).toBeNull();
  });

  it("空态显示「暂无任务」", async () => {
    renderGroupPage(
      messagesFetchMock(MESSAGES, MEMBERS, "active", { tasks: [] }),
    );
    await openTasksTab();
    await screen.findByText("暂无任务");
  });

  it("点「停止」发出「停止 <taskId>」广播消息,刷新后状态变 cancelled", async () => {
    const cancelledTasks = [{ ...TASKS[0], status: "cancelled" }, TASKS[1]];
    const mock = messagesFetchMock(MESSAGES, MEMBERS, "active", {
      tasks: TASKS,
      tasksAfterCommand: cancelledTasks,
    });
    renderGroupPage(mock);
    await openTasksTab();

    fireEvent.click(screen.getByTestId("task-stop-task-1"));

    await waitFor(() => {
      expect(lastPostPayload(mock)).toEqual({
        body: "停止 task-1",
        audience: "broadcast",
      });
    });
    // 命令后刷新任务列表 → cancelled 可见
    await screen.findByText("已取消");
  });

  it("点「回滚」发出「回滚 <taskId>」广播消息", async () => {
    const mock = messagesFetchMock(MESSAGES, MEMBERS, "active", {
      tasks: TASKS,
    });
    renderGroupPage(mock);
    await openTasksTab();

    fireEvent.click(screen.getByTestId("task-rollback-task-2"));

    await waitFor(() => {
      expect(lastPostPayload(mock)).toEqual({
        body: "回滚 task-2",
        audience: "broadcast",
      });
    });
  });

  it("命令 403 时给出无权限提示(按钮仍可见)", async () => {
    renderGroupPage(
      messagesFetchMock(MESSAGES, MEMBERS, "active", {
        tasks: TASKS,
        commandError: 403,
      }),
    );
    await openTasksTab();

    fireEvent.click(screen.getByTestId("task-stop-task-1"));

    await screen.findByText("无权限,请以 coordinator/human 身份绑定 token");
  });
});

function stubFetch(mock: ReturnType<typeof createFetchMock>) {
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Type into the composer and move the caret to the end of the value. */
function typeMessage(value: string, selectionStart?: number) {
  const textarea = screen.getByLabelText("消息内容");
  fireEvent.change(textarea, {
    target: {
      value,
      selectionStart: selectionStart ?? value.length,
    },
  });
  return textarea;
}

/** Find the POST /:id/messages call and return its parsed body. */
function lastPostPayload(fetchMock: ReturnType<typeof createFetchMock>) {
  const call = fetchMock.mock.calls.find(
    ([url, init]) =>
      init?.method === "POST" && String(url).endsWith("/messages"),
  );
  expect(call).toBeDefined();
  return JSON.parse(String(call![1]?.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

beforeEach(() => {
  MockWebSocket.reset();
});

describe("resolveAudience @ 解析 (ticket 18)", () => {
  it("@<角色名> → role + audienceRef=角色名", () => {
    expect(resolveAudience("@reviewer 请评审", MEMBERS)).toEqual({
      audience: "role",
      audienceRef: "reviewer",
    });
  });

  it("@<成员 name> → agent + audienceRef=agentId", () => {
    expect(resolveAudience("请 @win-hermes 看一下", MEMBERS)).toEqual({
      audience: "agent",
      audienceRef: "agent-2",
    });
  });

  it("无 @ → broadcast", () => {
    expect(resolveAudience("大家好,这是广播", MEMBERS)).toEqual({
      audience: "broadcast",
    });
  });

  it("未命中候选的 @xxx 按普通文本处理 → broadcast", () => {
    expect(resolveAudience("@nobody 你好", MEMBERS)).toEqual({
      audience: "broadcast",
    });
  });

  it("多个 @ 时第一个命中者生效(从左到右)", () => {
    expect(resolveAudience("@reviewer @win-hermes 双目标", MEMBERS)).toEqual({
      audience: "role",
      audienceRef: "reviewer",
    });
  });

  it("@<含空格成员名> → agent + audienceRef=agentId", () => {
    const withSpace = [
      ...MEMBERS,
      {
        agentId: "agent-9",
        name: "CodeBuddy 执行器",
        type: "hermes",
        device: "mac",
        roles: ["executor"],
      },
    ];
    expect(resolveAudience("@CodeBuddy 执行器 你好", withSpace)).toEqual({
      audience: "agent",
      audienceRef: "agent-9",
    });
    // 成员名嵌在正文中间也能命中
    expect(resolveAudience("请 @CodeBuddy 执行器 处理下", withSpace)).toEqual({
      audience: "agent",
      audienceRef: "agent-9",
    });
  });

  it("含空格成员名大小写不敏感", () => {
    const withSpace = [
      ...MEMBERS,
      {
        agentId: "agent-9",
        name: "CodeBuddy 执行器",
        type: "hermes",
        device: "mac",
        roles: ["executor"],
      },
    ];
    expect(resolveAudience("@codebuddy 执行器 你好", withSpace)).toEqual({
      audience: "agent",
      audienceRef: "agent-9",
    });
  });

  it("@executor(角色)不受含空格成员名干扰 → role", () => {
    const withSpace = [
      ...MEMBERS,
      {
        agentId: "agent-9",
        name: "CodeBuddy 执行器",
        type: "hermes",
        device: "mac",
        roles: ["executor"],
      },
    ];
    expect(resolveAudience("@executor 请执行", withSpace)).toEqual({
      audience: "role",
      audienceRef: "executor",
    });
  });

  it("成员名只是更长 token 的前缀时不误匹配 → broadcast", () => {
    // "@win-hermes2" 不应命中成员 win-hermes(防止把正文里的 @ 语义误吞)
    expect(resolveAudience("@win-hermes2 你好", MEMBERS)).toEqual({
      audience: "broadcast",
    });
  });
});

describe("detectMention 光标处 @ 检测 (ticket 18)", () => {
  it("光标在 @query 末尾时返回替换区间", () => {
    expect(detectMention("@rev", 4)).toEqual({ start: 0, query: "rev" });
    expect(detectMention("hi @re", 6)).toEqual({ start: 3, query: "re" });
  });

  it("@ 前出现空白或没有 @ 时返回 null", () => {
    expect(detectMention("@rev x", 5)).toBeNull(); // caret 在空格后
    expect(detectMention("plain text", 10)).toBeNull();
    expect(detectMention("", 0)).toBeNull();
  });
});

describe("agentColor 头像分色 (ticket 32)", () => {
  it("同一 agentId 稳定返回同一颜色", () => {
    expect(agentColor("agent-1")).toBe(agentColor("agent-1"));
    expect(agentColor("agent-2")).toBe(agentColor("agent-2"));
    expect(agentColor("unknown-xyz")).toBe(agentColor("unknown-xyz"));
  });

  it("返回值在预置色板内", () => {
    expect(AGENT_COLORS).toHaveLength(10);
    for (const id of ["agent-1", "agent-2", "a", "", "unknown-xyz"]) {
      expect(AGENT_COLORS).toContain(agentColor(id));
    }
  });

  it("不同 agentId 通常得到不同颜色", () => {
    expect(agentColor("agent-1")).not.toBe(agentColor("agent-2"));
  });
});

describe("formatMessageTime 时间格式 (ticket 32)", () => {
  // 固定系统时间:让「今年内」分支在跨年日期运行时也确定落在当前年内
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12, 0, 0)); // 本地 2026-08-11 12:00
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("今天 → HH:MM", () => {
    expect(formatMessageTime(new Date(2026, 7, 11, 17, 26).toISOString())).toBe(
      "17:26",
    );
  });

  it("昨天 → 昨天 HH:MM", () => {
    expect(formatMessageTime(new Date(2026, 7, 10, 9, 30).toISOString())).toBe(
      "昨天 09:30",
    );
  });

  it("今年内 → M月D日 HH:MM", () => {
    expect(formatMessageTime(new Date(2026, 6, 15, 9, 30).toISOString())).toBe(
      "7月15日 09:30",
    );
  });

  it("更早(去年)→ YYYY年M月D日(不带时间)", () => {
    expect(formatMessageTime(new Date(2025, 7, 11, 9, 30).toISOString())).toBe(
      "2025年8月11日",
    );
  });

  it("跨天边界:今天凌晨与昨天深夜分属不同分支", () => {
    expect(formatMessageTime(new Date(2026, 7, 11, 0, 1).toISOString())).toBe(
      "00:01",
    );
    expect(formatMessageTime(new Date(2026, 7, 10, 23, 59).toISOString())).toBe(
      "昨天 23:59",
    );
  });
});

describe("GroupMessagesPage 可读性 (ticket 32)", () => {
  it("头像分色 + 时间新格式 + 类型徽章 + 设备进 title", async () => {
    const now = new Date();
    const todayAt = (hour: number, minute: number) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
    const todayMsg = {
      id: "r-1",
      groupId: "group-1",
      senderId: "agent-1",
      parentId: null,
      audience: "broadcast" as const,
      audienceRef: null,
      body: "今天的气泡",
      depth: 0,
      createdAt: todayAt(9, 30).toISOString(),
    };
    const oldMsg = {
      id: "r-2",
      groupId: "group-1",
      senderId: "agent-2",
      parentId: null,
      audience: "broadcast" as const,
      audienceRef: null,
      body: "早些的气泡",
      depth: 0,
      createdAt: new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - 10,
        9,
        30,
      ).toISOString(),
    };
    stubFetch(messagesFetchMock([todayMsg, oldMsg]));
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    await screen.findByText("今天的气泡");
    expect(screen.getByText("早些的气泡")).toBeInTheDocument();

    // ① 头像:agent-1/agent-2 各自稳定的分色类,设备只在 title(tooltip)
    const avatar1 = screen.getByTitle("hermes-mac mac-mini");
    const avatar2 = screen.getByTitle("win-hermes win-pc");
    expect(avatar1.className).toContain(agentColor("agent-1").split(" ")[0]);
    expect(avatar2.className).toContain(agentColor("agent-2").split(" ")[0]);
    // 设备不再作为可见文本出现
    expect(screen.queryByText(/mac-mini|win-pc/)).toBeNull();

    // ② 时间:今天 → HH:MM;10 天前 → 今年内 M月D日 HH:MM
    expect(screen.getByText("09:30")).toBeInTheDocument();
    const expectedOld = formatMessageTime(oldMsg.createdAt);
    expect(screen.getByText(expectedOld)).toBeInTheDocument();

    // ③ 信息行:昵称 + 类型徽章;角色徽章保留
    expect(screen.getByText("hermes-mac")).toBeInTheDocument();
    expect(screen.getAllByText("hermes").length).toBeGreaterThan(0);
    expect(screen.getByText("coordinator")).toBeInTheDocument();
    expect(screen.getByText("reviewer")).toBeInTheDocument();
  });
});

describe("GroupMessagesPage 文件信令卡片 (ticket 05)", () => {
  const FILE_MESSAGES = [
    {
      id: "msg-file-1",
      groupId: "group-1",
      senderId: "agent-1",
      parentId: null,
      audience: "broadcast",
      audienceRef: null,
      body: "",
      fileRef: {
        name: "trained-model.bin",
        size: 5 * 1024 * 1024,
        sha256: "a".repeat(64),
        fetchUrl: "http://192.168.1.10:8080/f/trained-model.bin",
      },
      depth: 0,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
  ];

  it("带 fileRef 的消息渲染文件卡片:名称/大小/下载链接(新标签页)", async () => {
    stubFetch(messagesFetchMock(FILE_MESSAGES));
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    expect(await screen.findByText("trained-model.bin")).toBeInTheDocument();
    // 5 MiB -> 5.0 MB(1 KB = 1024 B)
    expect(screen.getByText("5.0 MB")).toBeInTheDocument();
    const download = screen.getByRole("link", { name: "下载" });
    expect(download).toHaveAttribute(
      "href",
      "http://192.168.1.10:8080/f/trained-model.bin",
    );
    expect(download).toHaveAttribute("target", "_blank");
  });

  it("消息体为空时只显示文件卡片,不渲染空消息体", async () => {
    stubFetch(messagesFetchMock(FILE_MESSAGES));
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    await screen.findByText("trained-model.bin");
    // body 为空:文件卡片在,但气泡里没有单独的文本段
    const fileCard = screen.getByText("trained-model.bin").closest("li");
    expect(fileCard).toBeTruthy();
  });

  it("文件大小人性化格式化:KB 与 B", async () => {
    stubFetch(
      messagesFetchMock([
        {
          id: "msg-file-kb",
          groupId: "group-1",
          senderId: "agent-1",
          parentId: null,
          audience: "broadcast",
          audienceRef: null,
          body: "小文件",
          fileRef: {
            name: "note.txt",
            size: 2048,
            sha256: "b".repeat(64),
            fetchUrl: "http://192.168.1.10:8080/f/note.txt",
          },
          depth: 0,
          createdAt: "2026-08-01T00:00:00.000Z",
        },
      ]),
    );
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    expect(await screen.findByText("note.txt")).toBeInTheDocument();
    // 2048 B -> 2.0 KB
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    // 带 body 的消息同时显示正文与文件卡片
    expect(screen.getByText("小文件")).toBeInTheDocument();
  });
});

describe("GroupMessagesPage 消息流与气泡布局", () => {
  it("渲染消息列表与发送者标识(名/类型/设备)与时间", async () => {
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    expect(await screen.findByText("任务草稿")).toBeInTheDocument();
    expect(screen.getByText("修正意见")).toBeInTheDocument();
    // Ticket 32: 信息行只显示昵称,类型/角色/受众为独立徽章,设备移入头像 title
    expect(screen.getAllByText("hermes-mac").length).toBeGreaterThan(0);
    expect(screen.getAllByText("win-hermes").length).toBeGreaterThan(0);
    expect(screen.getAllByText("hermes").length).toBeGreaterThan(0);
    expect(screen.getByTitle("hermes-mac mac-mini")).toBeInTheDocument();
    expect(screen.getByTitle("win-hermes win-pc")).toBeInTheDocument();
    // Role-targeted audience badge (ticket 26: `→ @<角色名>` format)
    expect(screen.getAllByText("→ @reviewer").length).toBeGreaterThan(0);
  });

  it("子消息在父气泡下方以回复串缩进展示", async () => {
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    await screen.findByText("修正意见");
    const root = screen.getByText("任务草稿").closest("li");
    const child = screen.getByText("修正意见").closest("li");
    expect(root?.style.paddingLeft).toBe("0px"); // 0 * 16
    expect(child?.style.paddingLeft).toBe("16px"); // 1 * 16
  });

  it("无消息时显示空态(图标 + 引导文案)", async () => {
    stubFetch(messagesFetchMock([]));
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    const empty = await screen.findByText("暂无消息,发送第一条吧");
    // 居中图标 + @ 角色/成员引导副文案。
    expect(empty.closest("div")?.querySelector("svg")).not.toBeNull();
    expect(
      screen.getByText("@ 角色或成员可以让消息直达目标"),
    ).toBeInTheDocument();
  });

  it("顶部标题栏显示群名、返回与成员入口", async () => {
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    // 群名来自 GET /api/groups/:id 的 title
    expect(await screen.findByText("评审任务")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回群组列表" })).toHaveAttribute(
      "href",
      "/groups",
    );
    expect(screen.getByRole("link", { name: "成员" })).toHaveAttribute(
      "href",
      "/groups/group-1/members",
    );
  });
});

describe("GroupMessagesPage 气泡方向 (ticket 18)", () => {
  it("绑定 agentId 后自己的消息靠右(蓝气泡 + 我 徽章),他人靠左", async () => {
    localStorage.setItem(AGENT_ID_KEY, "agent-1");
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    await screen.findByText("任务草稿");

    // msg-1 是 agent-1 发送的 → own
    const own = screen.getByText("任务草稿").closest("li");
    expect(own).toHaveAttribute("data-own", "true");
    expect(own?.className).toContain("flex-row-reverse");
    // 蓝气泡类:bg-primary(own 专属)
    expect(own?.textContent).toContain("我");

    // msg-2 是 agent-2 发送的 → 他人,靠左
    const other = screen.getByText("修正意见").closest("li");
    expect(other).toHaveAttribute("data-own", "false");
    expect(other?.className).not.toContain("flex-row-reverse");
    // 他人气泡不显示「我」徽章
    expect(screen.queryByText(/win-hermes.*我/)).toBeNull();

    // Ticket 35: 头像贴气泡顶部(items-start),own 保留 flex-row-reverse →
    // 头像在右上、他人在左上;紧凑合并规则下每组首条才渲染头像(行内首子元素)
    expect(own?.className).toContain("items-start");
    expect(other?.className).toContain("items-start");
    const ownAvatar = screen.getByTitle("hermes-mac mac-mini");
    const otherAvatar = screen.getByTitle("win-hermes win-pc");
    // 行内 DOM 顺序:头像在气泡列之前(own 靠 flex-row-reverse 翻转到右侧)
    expect(own?.firstElementChild).toBe(ownAvatar);
    expect(other?.firstElementChild).toBe(otherAvatar);
  });

  it("未绑定 agentId 时所有消息默认靠左、不显示「我」徽章", async () => {
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    await screen.findByText("任务草稿");
    const own = screen.getByText("任务草稿").closest("li");
    expect(own).toHaveAttribute("data-own", "false");
    expect(own?.className).not.toContain("flex-row-reverse");
    expect(screen.queryByText("我")).toBeNull();
  });
});

describe("GroupMessagesPage @ 提及输入 (ticket 18)", () => {
  it("输入 @ 弹出候选列表:角色名 + 群成员 name", async () => {
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    typeMessage("@");
    const listbox = await screen.findByRole("listbox", { name: "提及候选" });
    const options = Array.from(listbox.querySelectorAll("[role='option']")).map(
      (o) => o.textContent,
    );
    // GROUP_ROLES 的角色名
    expect(options.some((t) => t?.startsWith("@reviewer"))).toBe(true);
    expect(options.some((t) => t?.startsWith("@executor"))).toBe(true);
    // 群成员 name
    expect(options.some((t) => t?.startsWith("@hermes-mac"))).toBe(true);
    expect(options.some((t) => t?.startsWith("@win-hermes"))).toBe(true);
  });

  it("按前缀过滤候选,点击选项插入 @名字", async () => {
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    typeMessage("@herm");
    const listbox = await screen.findByRole("listbox", { name: "提及候选" });
    const options = Array.from(listbox.querySelectorAll("[role='option']"));
    // 只有匹配前缀的成员(角色名不含 herm)
    expect(options.length).toBe(1);
    fireEvent.click(options[0]);

    const textarea = screen.getByLabelText("消息内容") as HTMLTextAreaElement;
    expect(textarea.value).toBe("@hermes-mac");
    // 选中后候选列表关闭
    expect(screen.queryByRole("listbox", { name: "提及候选" })).toBeNull();
  });

  it("键盘选择:方向键移动高亮,回车插入", async () => {
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    const textarea = typeMessage("@");
    const listbox = await screen.findByRole("listbox", { name: "提及候选" });
    const options = Array.from(listbox.querySelectorAll("[role='option']"));
    // 初始高亮第一项(human)
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    // 下移到第二项(coordinator)
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    // 回车插入
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect((textarea as HTMLTextAreaElement).value).toBe("@coordinator");
    expect(screen.queryByRole("listbox", { name: "提及候选" })).toBeNull();
  });

  it("Escape 关闭候选列表", async () => {
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    const textarea = typeMessage("@");
    await screen.findByRole("listbox", { name: "提及候选" });
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "提及候选" })).toBeNull();
  });

  it("发送前显示解析结果预览(role / agent / broadcast)", async () => {
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    const preview = () => screen.getByTestId("audience-preview").textContent;

    typeMessage("@reviewer 请评审");
    expect(preview()).toContain("将发送给 role:reviewer");

    typeMessage("@win-hermes 私聊");
    expect(preview()).toContain("将发送给 agent:win-hermes");

    typeMessage("普通广播");
    expect(preview()).toContain("将发送给 全体成员");

    typeMessage("@nobody 未命中");
    expect(preview()).toContain("将发送给 全体成员");
  });
});

describe("GroupMessagesPage 发送 payload (ticket 18)", () => {
  it("@<角色名> → audience=role + audienceRef=角色名", async () => {
    const fetchMock = stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    typeMessage("@reviewer 请评审");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(lastPostPayload(fetchMock)).toEqual({
        body: "@reviewer 请评审",
        audience: "role",
        audienceRef: "reviewer",
      });
    });
  });

  it("@<成员 name> → audience=agent + audienceRef=agentId", async () => {
    const fetchMock = stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    typeMessage("@win-hermes 只给你");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(lastPostPayload(fetchMock)).toEqual({
        body: "@win-hermes 只给你",
        audience: "agent",
        audienceRef: "agent-2",
      });
    });
  });

  it("无 @ → 默认广播 audience=broadcast", async () => {
    const fetchMock = stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    typeMessage("执行最终版");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(lastPostPayload(fetchMock)).toEqual({
        body: "执行最终版",
        audience: "broadcast",
      });
    });
  });

  it("未命中候选的 @xxx 按普通文本 → audience=broadcast(正文保留)", async () => {
    const fetchMock = stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    typeMessage("@nobody 大家好");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(lastPostPayload(fetchMock)).toEqual({
        body: "@nobody 大家好",
        audience: "broadcast",
      });
    });
  });

  it("Enter 发送 / Shift+Enter 换行保留", async () => {
    const fetchMock = stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    const textarea = screen.getByLabelText("消息内容");
    // Shift+Enter 换行:不触发发送
    fireEvent.change(textarea, { target: { value: "第一行" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(lastPostPayloadIfAny(fetchMock)).toBeUndefined();

    // Enter 发送
    fireEvent.change(textarea, { target: { value: "第一行" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      expect(lastPostPayload(fetchMock)).toEqual({
        body: "第一行",
        audience: "broadcast",
      });
    });
  });

  // Shift+Enter 不应产生 POST —— 用独立断言避免与上面的 waitFor 冲突。
  function lastPostPayloadIfAny(fetchMock: ReturnType<typeof createFetchMock>) {
    return fetchMock.mock.calls.find(
      ([url, init]) =>
        init?.method === "POST" && String(url).endsWith("/messages"),
    )?.[1]?.body;
  }
});

describe("GroupMessagesPage 归档只读 (ticket 16)", () => {
  it("已归档群组渲染只读横幅并禁用发送输入(历史仍可查看)", async () => {
    stubFetch(messagesFetchMock(MESSAGES, MEMBERS, "archived"));
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    // Banner appears (the single-group status fetch drives it).
    expect(
      await screen.findByText(/该群组已归档,处于只读状态/),
    ).toBeInTheDocument();

    // History is still browsable — messages render normally.
    expect(await screen.findByText("任务草稿")).toBeInTheDocument();
    expect(screen.getByText("修正意见")).toBeInTheDocument();

    // Composer is locked: textarea + send button disabled(@ 输入随之禁用).
    expect(screen.getByLabelText("消息内容")).toBeDisabled();
    const sendButton = screen.getByRole("button", { name: "发送" });
    expect(sendButton).toBeDisabled();
    // The archived placeholder hints at the read-only state.
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("消息内容").placeholder,
    ).toBe("已归档,无法发送消息");
  });

  it("进行中群组不显示只读横幅,输入可用", async () => {
    stubFetch(messagesFetchMock(MESSAGES, MEMBERS, "active"));
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    await screen.findByText("任务草稿");
    expect(screen.queryByText(/该群组已归档,处于只读状态/)).toBeNull();
    expect(screen.getByLabelText("消息内容")).not.toBeDisabled();
    // The send button enables once a message is typed (unlike the archived
    // page, where it stays disabled even with content).
    const textarea = screen.getByLabelText("消息内容");
    fireEvent.change(textarea, { target: { value: "恢复后可继续" } });
    expect(screen.getByRole("button", { name: "发送" })).not.toBeDisabled();
  });
});

describe("GroupMessagesPage WebSocket 实时更新 (ticket 14)", () => {
  // jsdom has no WebSocket — the manual mock drives the page's live channel.
  const pushMessage = (ws: MockWebSocket, body: string, id: string) =>
    act(() =>
      ws.receive(
        JSON.stringify({
          type: "group_message",
          groupId: "group-1",
          message: {
            id,
            groupId: "group-1",
            senderId: "agent-1",
            parentId: null,
            audience: "broadcast",
            audienceRef: null,
            body,
            depth: 0,
            createdAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      ),
    );

  it("WS 推送的 group_message 实时追加到消息流(无需刷新)", async () => {
    localStorage.setItem(AGENT_TOKEN_KEY, "tok-1");
    vi.stubGlobal("WebSocket", MockWebSocket);
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    // Mount-time full load renders first, then the live push lands on top.
    expect(await screen.findByText("任务草稿")).toBeInTheDocument();
    pushMessage(MockWebSocket.instances[0], "实时新消息", "msg-ws-1");
    expect(await screen.findByText("实时新消息")).toBeInTheDocument();
  });

  it("WS 回显与发送后 reload 不重复(按 id 去重)", async () => {
    localStorage.setItem(AGENT_TOKEN_KEY, "tok-1");
    vi.stubGlobal("WebSocket", MockWebSocket);
    let reloads = 0;
    const SENT_MSG = {
      id: "msg-9",
      groupId: "group-1",
      senderId: "agent-1",
      parentId: null,
      audience: "broadcast" as const,
      audienceRef: null,
      body: "已发送",
      depth: 0,
      createdAt: "2026-08-02T00:00:00.000Z",
    };
    const fetchMock = createFetchMock([
      {
        match: (url) =>
          /\/api\/groups\/[^/]+$/.test(String(url)) &&
          !String(url).includes("?"),
        respond: () => jsonResponse({ id: "group-1", status: "active" }),
      },
      {
        match: (url) =>
          String(url).includes("/api/groups/") &&
          String(url).endsWith("/messages"),
        respond: (_url, init) => {
          if ((init?.method ?? "GET") === "POST") {
            return jsonResponse({ id: "msg-9", body: "已发送" });
          }
          // The reload reflects server truth: it already contains msg-9.
          reloads += 1;
          return jsonResponse(
            reloads >= 2 ? [...MESSAGES, SENT_MSG] : MESSAGES,
          );
        },
      },
      {
        match: (url) =>
          String(url).includes("/api/groups/") &&
          String(url).endsWith("/members"),
        respond: () => jsonResponse(MEMBERS),
      },
    ]);
    stubFetch(fetchMock);
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    // Send → POST + reload now shows the sent message once.
    fireEvent.change(screen.getByLabelText("消息内容"), {
      target: { value: "已发送" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(screen.getAllByText("已发送")).toHaveLength(1);
    });

    // The WS echo of the same message arrives afterwards — still one row.
    pushMessage(MockWebSocket.instances[0], "已发送", "msg-9");
    expect(screen.getAllByText("已发送")).toHaveLength(1);
  });

  it("其它群组的 group_message 帧不追加", async () => {
    localStorage.setItem(AGENT_TOKEN_KEY, "tok-1");
    vi.stubGlobal("WebSocket", MockWebSocket);
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    expect(await screen.findByText("任务草稿")).toBeInTheDocument();
    const ws = MockWebSocket.instances[0];
    act(() =>
      ws.receive(
        JSON.stringify({
          type: "group_message",
          groupId: "group-other",
          message: {
            id: "msg-other-1",
            groupId: "group-other",
            senderId: "agent-2",
            parentId: null,
            audience: "broadcast",
            audienceRef: null,
            body: "别的群的消息",
            depth: 0,
            createdAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      ),
    );
    expect(screen.queryByText("别的群的消息")).not.toBeInTheDocument();
  });
});

describe("GroupMessagesPage 树形折叠/展开 (ticket 15)", () => {
  // 一棵根 + 两个直接子 + 一个孙(嵌套)+ 一个 parentId 不在列表的孤儿 + 一个无回复的根
  const THREAD = [
    {
      id: "t-root",
      groupId: "group-1",
      senderId: "agent-1",
      parentId: null,
      audience: "broadcast",
      audienceRef: null,
      body: "根消息",
      depth: 0,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    {
      id: "t-child-1",
      groupId: "group-1",
      senderId: "agent-2",
      parentId: "t-root",
      audience: "broadcast",
      audienceRef: null,
      body: "子消息一",
      depth: 1,
      createdAt: "2026-08-01T00:01:00.000Z",
    },
    {
      id: "t-child-2",
      groupId: "group-1",
      senderId: "agent-2",
      parentId: "t-root",
      audience: "broadcast",
      audienceRef: null,
      body: "子消息二",
      depth: 1,
      createdAt: "2026-08-01T00:02:00.000Z",
    },
    {
      id: "t-grand",
      groupId: "group-1",
      senderId: "agent-1",
      parentId: "t-child-1",
      audience: "broadcast",
      audienceRef: null,
      body: "孙消息",
      depth: 2,
      createdAt: "2026-08-01T00:03:00.000Z",
    },
    {
      id: "t-orphan",
      groupId: "group-1",
      senderId: "agent-2",
      parentId: "t-not-loaded",
      audience: "broadcast",
      audienceRef: null,
      body: "孤儿消息",
      depth: 3,
      createdAt: "2026-08-01T00:04:00.000Z",
    },
    {
      id: "t-solo",
      groupId: "group-1",
      senderId: "agent-1",
      parentId: null,
      audience: "broadcast",
      audienceRef: null,
      body: "无回复根",
      depth: 0,
      createdAt: "2026-08-01T00:05:00.000Z",
    },
  ];

  it("渲染树:根显示折叠按钮与后代计数 badge,默认展开;子消息不渲染自身折叠按钮", async () => {
    stubFetch(messagesFetchMock(THREAD));
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    // 默认展开:整棵子树立即可见,无需任何交互
    expect(await screen.findByText("根消息")).toBeInTheDocument();
    expect(screen.getByText("子消息一")).toBeInTheDocument();
    expect(screen.getByText("子消息二")).toBeInTheDocument();
    expect(screen.getByText("孙消息")).toBeInTheDocument();

    // 根的消息:折叠按钮(默认「折叠」态,▾)+ 计数 badge 统计全部后代(含嵌套)
    const toggle = screen.getByRole("button", { name: "折叠" });
    expect(toggle.textContent).toContain("3 条回复");

    // 无回复的根不渲染折叠按钮(操作条按钮不算折叠开关)
    expect(
      within(screen.getByText("无回复根").closest("li")!).queryByRole(
        "button",
        { name: /折叠|展开/ },
      ),
    ).toBeNull();
    // 有后代但自身是子消息(depth>=1)也不渲染折叠按钮
    expect(
      within(screen.getByText("子消息一").closest("li")!).queryByRole(
        "button",
        { name: /折叠|展开/ },
      ),
    ).toBeNull();
  });

  it("折叠隐藏整棵子树(含嵌套孙消息),再次点击恢复展开", async () => {
    stubFetch(messagesFetchMock(THREAD));
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("孙消息");

    fireEvent.click(screen.getByRole("button", { name: "折叠" }));
    // 子树整体隐藏,根自身保留
    expect(screen.queryByText("子消息一")).toBeNull();
    expect(screen.queryByText("子消息二")).toBeNull();
    expect(screen.queryByText("孙消息")).toBeNull();
    expect(screen.getByText("根消息")).toBeInTheDocument();
    // 折叠后按钮切为「展开」(▸),badge 计数保留
    const expand = screen.getByRole("button", { name: "展开" });
    expect(expand.textContent).toContain("3 条回复");

    fireEvent.click(expand);
    expect(screen.getByText("子消息一")).toBeInTheDocument();
    expect(screen.getByText("子消息二")).toBeInTheDocument();
    expect(screen.getByText("孙消息")).toBeInTheDocument();
  });

  it("parentId 不在加载列表的消息按 depth 扁平渲染,不丢弃", async () => {
    stubFetch(messagesFetchMock(THREAD));
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    expect(await screen.findByText("孤儿消息")).toBeInTheDocument();
    const orphan = screen.getByText("孤儿消息").closest("li");
    expect(orphan?.style.paddingLeft).toBe("48px"); // 3 * 16
  });

  it("WS 追加后折叠状态保持,计数 badge 即使折叠中也更新", async () => {
    localStorage.setItem(AGENT_TOKEN_KEY, "tok-1");
    vi.stubGlobal("WebSocket", MockWebSocket);
    stubFetch(messagesFetchMock(THREAD));
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    await screen.findByText("孙消息");
    fireEvent.click(screen.getByRole("button", { name: "折叠" }));
    expect(screen.queryByText("子消息一")).toBeNull();

    // WS 推入一条 t-root 下的新回复:折叠不被打断,badge 3 -> 4
    act(() =>
      MockWebSocket.instances[0].receive(
        JSON.stringify({
          type: "group_message",
          groupId: "group-1",
          message: {
            id: "t-ws-1",
            groupId: "group-1",
            senderId: "agent-2",
            parentId: "t-root",
            audience: "broadcast",
            audienceRef: null,
            body: "WS 新回复",
            depth: 1,
            createdAt: "2026-08-01T00:06:00.000Z",
          },
        }),
      ),
    );

    const expand = await screen.findByRole("button", { name: "展开" });
    expect(expand.textContent).toContain("4 条回复");
    // 子树仍处于折叠状态,新回复同样被隐藏
    expect(screen.queryByText("子消息一")).toBeNull();
    expect(screen.queryByText("WS 新回复")).toBeNull();
  });
});

describe("GroupMessagesPage 窄屏渲染 (ticket 18)", () => {
  it("窄视口下三区布局可用:标题栏 / 滚动消息区 / 贴底输入区", async () => {
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    // 标题栏
    expect(await screen.findByText("评审任务")).toBeInTheDocument();
    // 滚动消息区(overflow-y-auto)与消息
    expect(screen.getByText("任务草稿")).toBeInTheDocument();
    expect(
      screen.getByText("任务草稿").closest("li")?.querySelector("p")
        ?.textContent,
    ).toBe("任务草稿");
    // 贴底输入区:输入框 + 发送按钮都在
    expect(screen.getByLabelText("消息内容")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
    // 气泡有响应式 max-width(sm 断点从 75% 收窄到 60%)
    const bubble = screen
      .getByText("任务草稿")
      .closest("li")
      ?.querySelector(".max-w-\\[75\\%\\]");
    expect(bubble?.className).toContain("sm:max-w-[60%]");
  });
});

describe("GroupMessagesPage 窄屏适配 (ticket 34)", () => {
  it("输入区布局:textarea 全宽、受众预览可截断、发送按钮固定不挤压", async () => {
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    expect(screen.getByLabelText("消息内容").className).toContain("w-full");
    expect(screen.getByTestId("audience-preview").className).toContain(
      "min-w-0",
    );
    expect(screen.getByTestId("audience-preview").className).toContain(
      "truncate",
    );
    expect(screen.getByRole("button", { name: "发送" }).className).toContain(
      "shrink-0",
    );
  });

  it("操作条双形态:桌面 hover 条 md:flex,移动点击条 md:hidden", async () => {
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    const hoverBars = screen.getAllByTestId("message-actions-hover");
    expect(hoverBars.length).toBeGreaterThan(0);
    expect(hoverBars[0].className).toContain("hidden");
    expect(hoverBars[0].className).toContain("md:flex");
    // 点击气泡弹出移动操作条(md:hidden),点击外部关闭。
    fireEvent.click(screen.getByRole("button", { name: "任务草稿 操作" }));
    const mobileBar = screen.getByTestId("message-actions-mobile");
    expect(mobileBar.className).toContain("md:hidden");
    fireEvent.click(document.body);
    expect(
      screen.queryByTestId("message-actions-mobile"),
    ).not.toBeInTheDocument();
  });

  it("回复缩进钳制:浅回复按层级缩进,深回复(≥4 层)不再外推", async () => {
    // 默认 fixture:msg-2 是 depth 1 的回复 → 16px 缩进。
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");
    const shallow = document.querySelector('[data-message-id="msg-2"]');
    expect((shallow as HTMLElement).style.paddingLeft).toBe("16px");

    // 深回复 depth 6 → 钳制在 64px(而非 96px),窄屏下保留气泡空间。
    const deep = [
      {
        id: "deep-1",
        groupId: "group-1",
        senderId: "agent-1",
        parentId: "msg-1",
        audience: "broadcast",
        audienceRef: null,
        body: "深回复",
        depth: 6,
        createdAt: "2026-08-01T00:10:00.000Z",
      },
    ];
    stubFetch(messagesFetchMock(deep));
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("深回复");
    const deepRow = document.querySelector('[data-message-id="deep-1"]');
    expect((deepRow as HTMLElement).style.paddingLeft).toBe("64px");
  });
});

describe("GroupMessagesPage 消息操作 (ticket 21)", () => {
  const rowOf = (body: string) => screen.getByText(body).closest("li");

  it("点回复 → 引用条出现(发送者名 + 正文前 30 字),发送带 parentId,成功后引用条清除", async () => {
    const fetchMock = stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    // 回复 msg-1(agent-1 的「任务草稿」)
    fireEvent.click(
      within(rowOf("任务草稿")!).getByRole("button", { name: "回复" }),
    );
    const quoteBar = screen.getByTestId("reply-quote-bar");
    expect(quoteBar).toBeInTheDocument();
    // 发送者名取成员 name,引用预览为正文前 30 字
    expect(within(quoteBar).getByText(/回复 hermes-mac/)).toBeInTheDocument();
    expect(within(quoteBar).getByText("任务草稿")).toBeInTheDocument();
    // 输入框聚焦(引用条不阻塞输入)
    await waitFor(() => {
      expect(screen.getByLabelText("消息内容")).toHaveFocus();
    });

    typeMessage("收到,马上办");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(lastPostPayload(fetchMock)).toEqual({
        body: "收到,马上办",
        audience: "broadcast",
        parentId: "msg-1",
      });
    });
    // 发送成功后引用条清除
    await waitFor(() => {
      expect(screen.queryByTestId("reply-quote-bar")).toBeNull();
    });
  });

  it("取消回复关闭引用条,后续发送不带 parentId", async () => {
    const fetchMock = stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    fireEvent.click(
      within(rowOf("任务草稿")!).getByRole("button", { name: "回复" }),
    );
    expect(screen.getByTestId("reply-quote-bar")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消回复" }));
    expect(screen.queryByTestId("reply-quote-bar")).toBeNull();

    typeMessage("不引用直接发");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(lastPostPayload(fetchMock)).toEqual({
        body: "不引用直接发",
        audience: "broadcast",
      });
    });
  });

  it("点复制 → navigator.clipboard.writeText 被调用并短暂显示「已复制」", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    fireEvent.click(
      within(rowOf("任务草稿")!).getByRole("button", { name: "复制" }),
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("任务草稿");
    });
    expect(
      within(rowOf("任务草稿")!).getByRole("button", { name: "已复制" }),
    ).toBeInTheDocument();
  });

  it("移动端:点击气泡弹出操作条,点击外部关闭", async () => {
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    // 初始只有桌面悬停条,无移动端操作条
    expect(screen.queryByTestId("message-actions-mobile")).toBeNull();

    // 点击气泡 → 移动端操作条出现
    fireEvent.click(screen.getByText("任务草稿"));
    const mobileBar = screen.getByTestId("message-actions-mobile");
    expect(mobileBar).toBeInTheDocument();
    // 作用域限定在移动端操作条内(同 li 还有桌面悬停条的按钮)
    expect(
      within(mobileBar).getByRole("button", { name: "回复" }),
    ).toBeInTheDocument();
    expect(
      within(mobileBar).getByRole("button", { name: "复制" }),
    ).toBeInTheDocument();

    // 点击外部(非该消息行)→ 操作条关闭
    fireEvent.click(document.body);
    expect(screen.queryByTestId("message-actions-mobile")).toBeNull();
  });
});

describe("GroupMessagesPage 新消息提示 (ticket 21)", () => {
  const scrolledUp = (stream: HTMLElement) => {
    // jsdom 没有真实布局:伪造滚动尺寸并派发 scroll,模拟用户上滚
    Object.defineProperty(stream, "scrollHeight", {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(stream, "clientHeight", {
      value: 400,
      configurable: true,
    });
    Object.defineProperty(stream, "scrollTop", {
      value: 0,
      writable: true,
      configurable: true,
    });
    fireEvent.scroll(stream);
  };

  const wsMessageFrame = (id: string, body: string) =>
    JSON.stringify({
      type: "group_message",
      groupId: "group-1",
      message: {
        id,
        groupId: "group-1",
        senderId: "agent-2",
        parentId: null,
        audience: "broadcast",
        audienceRef: null,
        body,
        depth: 0,
        createdAt: "2026-08-02T00:10:00.000Z",
      },
    });

  it("WS 收到新消息且不在底部 → 底部 pill 出现;点击后滚到底部并消失", async () => {
    localStorage.setItem(AGENT_TOKEN_KEY, "tok-1");
    vi.stubGlobal("WebSocket", MockWebSocket);
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    // 用户上滚后:无 pill
    const stream = screen.getByTestId("message-stream");
    scrolledUp(stream);
    expect(screen.queryByTestId("new-message-pill")).toBeNull();

    // WS 推一条新消息 → pill 出现,积压 N=1
    act(() =>
      MockWebSocket.instances[0].receive(
        wsMessageFrame("msg-pill-1", "pill 消息"),
      ),
    );
    const pill = await screen.findByTestId("new-message-pill");
    expect(pill.textContent).toContain("1 条新消息");
    expect(screen.getByText("pill 消息")).toBeInTheDocument();

    // 点击 pill → 滚到底部(scrollTop = scrollHeight)+ pill 消失
    fireEvent.click(pill);
    expect(stream.scrollTop).toBe(1000);
    expect(screen.queryByTestId("new-message-pill")).toBeNull();
  });

  it("用户滚回底部时积压清零,pill 消失", async () => {
    localStorage.setItem(AGENT_TOKEN_KEY, "tok-1");
    vi.stubGlobal("WebSocket", MockWebSocket);
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    const stream = screen.getByTestId("message-stream");
    scrolledUp(stream);
    act(() =>
      MockWebSocket.instances[0].receive(
        wsMessageFrame("msg-pill-2", "第二条 pill"),
      ),
    );
    const pill = await screen.findByTestId("new-message-pill");
    expect(pill.textContent).toContain("1 条新消息");

    // 手动滚回底部(距底 <48px)→ pill 消失
    Object.defineProperty(stream, "scrollTop", {
      value: 600,
      writable: true,
      configurable: true,
    });
    fireEvent.scroll(stream);
    expect(screen.queryByTestId("new-message-pill")).toBeNull();
  });
});

describe("GroupMessagesPage 时间分组 (ticket 21)", () => {
  // 固定相对日期的 createdAt mock:今天 / 昨天 / 前天(本地正午,避开 DST)
  const noon = (offsetDays: number) => {
    const d = new Date();
    return new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate() - offsetDays,
      12,
      0,
      0,
    ).toISOString();
  };
  const msg = (
    id: string,
    senderId: string,
    body: string,
    createdAt: string,
    parentId: string | null = null,
  ) => ({
    id,
    groupId: "group-1",
    senderId,
    parentId,
    audience: "broadcast" as const,
    audienceRef: null,
    body,
    depth: parentId ? 1 : 0,
    createdAt,
  });
  const SENDER = "hermes-mac";

  it("同发送者 5 分钟内连续消息合并(单个昵称头),跨 5 分钟重新显示头", async () => {
    const t0 = noon(0);
    stubFetch(
      messagesFetchMock([
        msg("g-1", "agent-1", "第一条", t0),
        msg(
          "g-2",
          "agent-1",
          "第二条",
          new Date(Date.parse(t0) + 60_000).toISOString(),
        ),
        // 距上一条 6 分钟(12:00 → 12:01 → 12:07):跨 5 分钟窗口,重新出头
        msg(
          "g-3",
          "agent-1",
          "第三条",
          new Date(Date.parse(t0) + 7 * 60_000).toISOString(),
        ),
      ]),
    );
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("第一条");

    // 1 分钟间隔的合并成一组,6 分钟间隔的重新出头 → 昵称只出现 2 次
    expect(screen.getAllByText(SENDER)).toHaveLength(2);
  });

  it("跨天插入日期分隔线:今天 / 昨天 / 更早日期", async () => {
    const now = new Date();
    const d3 = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 3,
      12,
      0,
      0,
    );
    const d2 = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 2,
      12,
      0,
      0,
    );
    const d1 = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      12,
      0,
      0,
    );
    const d0 = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      12,
      0,
      0,
    );
    stubFetch(
      messagesFetchMock([
        msg("d-1", "agent-1", "三天前消息", d3.toISOString()),
        msg("d-2", "agent-2", "两天前消息", d2.toISOString()),
        msg("d-3", "agent-1", "昨天消息", d1.toISOString()),
        msg("d-4", "agent-2", "今天消息", d0.toISOString()),
      ]),
    );
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("三天前消息");

    const separators = screen.getAllByTestId("day-separator");
    expect(separators).toHaveLength(3);
    // 分隔线属于「新一天」:更早 → 具体日期;昨天 / 今天 用相对词
    expect(separators[0].textContent).toBe(d2.toLocaleDateString("zh-CN"));
    expect(separators[1].textContent).toBe("昨天");
    expect(separators[2].textContent).toBe("今天");
  });
});

describe("GroupMessagesPage 消息编辑/删除 (ticket 22)", () => {
  const rowOf = (body: string) => screen.getByText(body).closest("li");
  const editButton = (body: string) =>
    within(rowOf(body)!).getByRole("button", { name: "编辑" });
  const deleteButton = (body: string) =>
    within(rowOf(body)!).getByRole("button", { name: "删除" });

  const findPatch = (
    fetchMock: ReturnType<typeof createFetchMock>,
    messageId: string,
  ) =>
    fetchMock.mock.calls.find(
      ([url, init]) =>
        init?.method === "PATCH" &&
        String(url).endsWith(`/messages/${messageId}`),
    );

  beforeEach(() => {
    localStorage.setItem(AGENT_ID_KEY, "agent-1");
    localStorage.setItem(AGENT_TOKEN_KEY, "tok-1");
  });

  it("编辑:点编辑 → 输入框出现;保存 → PATCH 调用 + 本地更新 + 退出编辑态", async () => {
    const fetchMock = stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    fireEvent.click(editButton("任务草稿"));
    const form = screen.getByTestId("message-edit-form");
    expect(within(form).getByLabelText("编辑消息")).toBeInTheDocument();
    expect(
      within(form).getByRole("button", { name: "保存" }),
    ).toBeInTheDocument();

    fireEvent.change(within(form).getByLabelText("编辑消息"), {
      target: { value: "改后的正文" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const patch = findPatch(fetchMock, "msg-1");
      expect(patch).toBeDefined();
      expect(JSON.parse(String(patch![1]?.body))).toEqual({
        body: "改后的正文",
      });
    });
    // 成功后本地更新 + 退出编辑态
    await waitFor(() => {
      expect(screen.queryByTestId("message-edit-form")).toBeNull();
    });
    expect(screen.getByText("改后的正文")).toBeInTheDocument();
    expect(screen.queryByText("任务草稿")).toBeNull();
  });

  it("取消:退出编辑态,不调 PATCH,原文保留", async () => {
    const fetchMock = stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    fireEvent.click(editButton("任务草稿"));
    const textarea = within(
      screen.getByTestId("message-edit-form"),
    ).getByLabelText("编辑消息");
    fireEvent.change(textarea, { target: { value: "不会被保存" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByTestId("message-edit-form")).toBeNull();
    expect(screen.getByText("任务草稿")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH"),
    ).toBe(false);
  });

  it("删除:confirm → DELETE 调用 → 本地占位显示,操作条消失", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    fireEvent.click(deleteButton("任务草稿"));
    expect(confirm).toHaveBeenCalledWith("确定删除这条消息吗?删除后不可恢复。");

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            init?.method === "DELETE" &&
            String(url).endsWith("/messages/msg-1"),
        ),
      ).toBe(true);
    });
    // 占位显示(灰色斜体小字),原文消失,操作条不再渲染
    expect(await screen.findByText("消息已删除")).toBeInTheDocument();
    expect(screen.queryByText("任务草稿")).toBeNull();
    const deletedRow = rowOf("消息已删除");
    expect(
      within(deletedRow!).queryByRole("button", { name: "编辑" }),
    ).toBeNull();
    expect(
      within(deletedRow!).queryByRole("button", { name: "删除" }),
    ).toBeNull();
    confirm.mockRestore();
  });

  it("confirm 取消(返回 false)不调 DELETE,原文保留", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchMock = stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    fireEvent.click(deleteButton("任务草稿"));
    expect(confirm).toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
    expect(screen.getByText("任务草稿")).toBeInTheDocument();
    confirm.mockRestore();
  });

  it("仅自己的消息显示编辑/删除;他人消息无操作条", async () => {
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    // msg-2 是 agent-2 发送的 → 无编辑/删除
    const otherRow = rowOf("修正意见");
    expect(
      within(otherRow!).queryByRole("button", { name: "编辑" }),
    ).toBeNull();
    expect(
      within(otherRow!).queryByRole("button", { name: "删除" }),
    ).toBeNull();
    // 自己的 msg-1 有编辑/删除
    expect(editButton("任务草稿")).toBeInTheDocument();
    expect(deleteButton("任务草稿")).toBeInTheDocument();
  });

  it("编辑态互斥:同一时间只编辑一条消息", async () => {
    const TWO_OWN = [
      MESSAGES[0],
      {
        ...MESSAGES[1],
        id: "msg-3",
        senderId: "agent-1",
        body: "第二条自己的",
      },
    ];
    stubFetch(messagesFetchMock(TWO_OWN));
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    fireEvent.click(editButton("任务草稿"));
    expect(screen.getByTestId("message-edit-form")).toBeInTheDocument();
    fireEvent.click(editButton("第二条自己的"));
    // 新的编辑顶掉旧的,表单只有一个,输入框预填被编辑消息的正文
    expect(screen.getAllByTestId("message-edit-form")).toHaveLength(1);
    expect(
      within(screen.getByTestId("message-edit-form")).getByLabelText(
        "编辑消息",
      ),
    ).toHaveValue("第二条自己的");
  });

  it("WS group_message_updated:原位替换正文,顺序保留", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    act(() =>
      MockWebSocket.instances[0].receive(
        JSON.stringify({
          type: "group_message_updated",
          groupId: "group-1",
          message: {
            ...MESSAGES[0],
            body: "远端编辑后的正文",
            updatedAt: "2026-08-02T00:05:00.000Z",
          },
        }),
      ),
    );

    expect(await screen.findByText("远端编辑后的正文")).toBeInTheDocument();
    expect(screen.queryByText("任务草稿")).toBeNull();
    // 顺序保留:msg-2 仍在列表
    expect(screen.getByText("修正意见")).toBeInTheDocument();
  });

  it("WS group_message_deleted:本地标记占位,原文消失,无操作条", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    stubFetch(messagesFetchMock());
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    act(() =>
      MockWebSocket.instances[0].receive(
        JSON.stringify({
          type: "group_message_deleted",
          groupId: "group-1",
          messageId: "msg-2",
        }),
      ),
    );

    expect(await screen.findByText("消息已删除")).toBeInTheDocument();
    expect(screen.queryByText("修正意见")).toBeNull();
    const deletedRow = rowOf("消息已删除");
    expect(
      within(deletedRow!).queryByRole("button", { name: "编辑" }),
    ).toBeNull();
    expect(
      within(deletedRow!).queryByRole("button", { name: "删除" }),
    ).toBeNull();
  });
});

describe("GroupMessagesPage 消息类型气泡 (ticket 26)", () => {
  // ticket 32 时间格式按「今天 HH:MM」输出:状态条时间断言用相对今天的时间,
  // 避免硬编码年份在系统时钟跨年后变成 YYYY年M月D日 而不再含 HH:MM。
  const statusDay = new Date();
  statusDay.setHours(0, 0, 0, 0);
  const statusTime = (minuteOffset: number) =>
    new Date(statusDay.getTime() + minuteOffset * 60_000).toISOString();
  const STATUS = [
    {
      id: "st-1",
      groupId: "group-1",
      senderId: "agent-2",
      parentId: null,
      audience: "broadcast",
      audienceRef: null,
      body: "🚀 开始执行:整理发布清单",
      contentType: "task_status",
      depth: 0,
      createdAt: statusTime(0),
    },
    {
      id: "st-2",
      groupId: "group-1",
      senderId: "agent-2",
      parentId: null,
      audience: "broadcast",
      audienceRef: null,
      body: "✅ 任务完成 (commit abc12345)\n总结:全部测试通过",
      contentType: "task_status",
      depth: 0,
      createdAt: statusTime(1),
    },
    {
      id: "st-3",
      groupId: "group-1",
      senderId: "agent-2",
      parentId: null,
      audience: "broadcast",
      audienceRef: null,
      body: "❌ 任务失败 (exit 1)\n构建报错",
      contentType: "task_status",
      depth: 0,
      createdAt: statusTime(2),
    },
  ];
  const barOf = (status: string) =>
    screen
      .getAllByTestId("task-status")
      .find((el) => el.getAttribute("data-status") === status);

  it("task_status 渲染为居中紧凑状态条(等宽小字+时间),✅❌ 颜色类区分", async () => {
    stubFetch(messagesFetchMock(STATUS));
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    expect(
      await screen.findByText("🚀 开始执行:整理发布清单"),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("task-status")).toHaveLength(3);

    // 居中:行容器 justify-center,不再 flex-row-reverse 分左右
    const row = screen.getByText("🚀 开始执行:整理发布清单").closest("li");
    expect(row?.className).toContain("justify-center");
    expect(row?.className).not.toContain("flex-row-reverse");

    // 🚀 进行中 → 蓝;✅ 完成 → 绿;❌ 失败 → 红(等宽小字 + 时间)
    const running = barOf("running");
    expect(running?.className).toContain("bg-sky-500/10");
    expect(running?.querySelector("p.font-mono")).toBeTruthy();
    expect(running?.textContent).toMatch(/\d{2}:\d{2}/); // 状态条带时间(ticket 32: HH:MM)

    const done = barOf("done");
    expect(done?.className).toContain("bg-emerald-500/10");
    expect(done?.textContent).toContain("✅ 任务完成");

    const failed = barOf("failed");
    expect(failed?.className).toContain("bg-red-500/10");
    expect(failed?.textContent).toContain("❌ 任务失败");
  });

  it("discussion 消息渲染普通气泡 + 💬 标记", async () => {
    stubFetch(
      messagesFetchMock([
        {
          id: "ds-1",
          groupId: "group-1",
          senderId: "agent-2",
          parentId: null,
          audience: "broadcast",
          audienceRef: null,
          body: "💬 建议用两层抽象",
          contentType: "discussion",
          depth: 0,
          createdAt: "2026-08-02T00:00:00.000Z",
        },
      ]),
    );
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    expect(await screen.findByText("💬 建议用两层抽象")).toBeInTheDocument();
    const mark = screen.getByTestId("discussion-mark");
    expect(mark.textContent).toContain("💬");
    // 仍是普通靠左气泡,不是居中状态条
    const row = screen.getByText("💬 建议用两层抽象").closest("li");
    expect(row?.className).not.toContain("justify-center");
    expect(screen.queryByTestId("task-status")).toBeNull();
  });

  it("长消息(>200 字)默认折叠为前 100 字 + 展开全文;点击展开/收起;短消息不折叠", async () => {
    const longBody = "任务说明:" + "这是一段很长的任务描述内容。".repeat(20); // 285 字 > 200
    stubFetch(
      messagesFetchMock([
        {
          id: "long-1",
          groupId: "group-1",
          senderId: "agent-1",
          parentId: null,
          audience: "broadcast",
          audienceRef: null,
          body: longBody,
          depth: 0,
          createdAt: "2026-08-02T00:00:00.000Z",
        },
        ...MESSAGES,
      ]),
    );
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    await screen.findByText("任务草稿");
    const preview = longBody.slice(0, 100) + "…";
    expect(screen.getByText(preview)).toBeInTheDocument();
    expect(screen.queryByText(longBody)).toBeNull();

    // 展开 → 全文 + 收起按钮
    fireEvent.click(screen.getByRole("button", { name: "展开全文" }));
    expect(screen.getByText(longBody)).toBeInTheDocument();
    expect(screen.queryByText(preview)).toBeNull();
    expect(screen.getByRole("button", { name: "收起" })).toBeInTheDocument();

    // 收起 → 恢复预览
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.getByText(preview)).toBeInTheDocument();

    // 短消息不折叠、无折叠按钮
    const shortRow = screen.getByText("任务草稿").closest("li");
    expect(
      within(shortRow!).queryByRole("button", { name: "展开全文" }),
    ).toBeNull();
  });

  it("超长 task_status 同样折叠(状态条内展开全文/收起)", async () => {
    const longStatus = "🚀 开始执行:" + "很长很长的任务摘要内容。".repeat(30); // 367 字 > 200
    stubFetch(
      messagesFetchMock([
        {
          id: "st-long",
          groupId: "group-1",
          senderId: "agent-2",
          parentId: null,
          audience: "broadcast",
          audienceRef: null,
          body: longStatus,
          contentType: "task_status",
          depth: 0,
          createdAt: "2026-08-02T00:00:00.000Z",
        },
      ]),
    );
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    const bar = await screen.findByTestId("task-status");
    // 折叠预览按码点截取(🚀 是代理对,slice 按 UTF-16 单元会切碎)
    expect(
      within(bar).getByText(
        Array.from(longStatus).slice(0, 100).join("") + "…",
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole("button", { name: "展开全文" }));
    expect(within(bar).getByText(longStatus)).toBeInTheDocument();
    expect(
      within(bar).getByRole("button", { name: "收起" }),
    ).toBeInTheDocument();
  });

  it("已删除的 task_status 显示灰色占位,不渲染状态条", async () => {
    stubFetch(
      messagesFetchMock([
        {
          id: "st-del",
          groupId: "group-1",
          senderId: "agent-2",
          parentId: null,
          audience: "broadcast",
          audienceRef: null,
          body: "[消息已删除]",
          contentType: "task_status",
          deleted: true,
          depth: 0,
          createdAt: "2026-08-02T00:00:00.000Z",
        },
      ]),
    );
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    expect(await screen.findByText("消息已删除")).toBeInTheDocument();
    expect(screen.queryByTestId("task-status")).toBeNull();
  });

  it("受众标签:agent → @成员名 / 未知 ref → 前 8 位;role → @角色名;broadcast 无标签", async () => {
    const TARGETED = [
      {
        id: "ag-1",
        groupId: "group-1",
        senderId: "agent-1",
        parentId: null,
        audience: "agent",
        audienceRef: "agent-2",
        body: "只给 win-hermes",
        depth: 0,
        createdAt: "2026-08-02T00:00:00.000Z",
      },
      {
        id: "ag-2",
        groupId: "group-1",
        senderId: "agent-1",
        parentId: null,
        audience: "agent",
        audienceRef: "abc12345-unknown-member",
        body: "未知成员",
        depth: 0,
        createdAt: "2026-08-02T00:06:00.000Z",
      },
      {
        id: "ag-3",
        groupId: "group-1",
        senderId: "agent-1",
        parentId: null,
        audience: "role",
        audienceRef: "reviewer",
        body: "给评审角色",
        depth: 0,
        createdAt: "2026-08-02T00:12:00.000Z",
      },
      {
        id: "ag-4",
        groupId: "group-1",
        senderId: "agent-1",
        parentId: null,
        audience: "broadcast",
        audienceRef: null,
        body: "广播消息",
        depth: 0,
        createdAt: "2026-08-02T00:18:00.000Z",
      },
    ];
    stubFetch(messagesFetchMock(TARGETED));
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    await screen.findByText("只给 win-hermes");
    // agent 命中成员 → @成员名;未知 ref → @ref 前 8 位;role → @角色名
    expect(screen.getByText("→ @win-hermes")).toBeInTheDocument();
    expect(screen.getByText("→ @abc12345")).toBeInTheDocument();
    expect(screen.getByText("→ @reviewer")).toBeInTheDocument();
    expect(screen.getAllByText(/^→ @/)).toHaveLength(3);
    // broadcast 不加标签
    const broadcastRow = screen.getByText("广播消息").closest("li");
    expect(broadcastRow?.textContent).not.toContain("→ @");
  });

  it("旧消息 contentType 为 null/undefined → 按普通气泡渲染", async () => {
    stubFetch(messagesFetchMock()); // 默认 MESSAGES 无 contentType 字段
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");

    await screen.findByText("任务草稿");
    expect(screen.queryByTestId("task-status")).toBeNull();
    expect(screen.queryByTestId("discussion-mark")).toBeNull();
    const row = screen.getByText("任务草稿").closest("li");
    expect(row?.className).not.toContain("justify-center");
  });
});

describe("ticket 23 接线:进入消息页 markRead", () => {
  beforeEach(() => {
    // Earlier tests in this file mount the page, which drives the module-level
    // singleton's activeGroupId — start from a clean store.
    __resetUnreadStore();
  });

  afterEach(() => {
    __resetUnreadStore();
  });

  it("打开消息页后该群的全局未读清零", async () => {
    localStorage.setItem(AGENT_TOKEN_KEY, "tok-1");
    vi.stubGlobal("WebSocket", MockWebSocket);
    stubFetch(messagesFetchMock());

    // Probe subscriber starts the store's resident socket; feed it one frame
    // for the group we are about to open.
    const probe = renderHook(() => useUnread());
    const storeWs = MockWebSocket.instances[0];
    act(() =>
      storeWs.receive(groupMessageFrame("group-1", "挂载前到达的未读")),
    );
    expect(probe.result.current.unread.get("group-1")).toBe(1);

    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    await waitFor(() =>
      expect(probe.result.current.unread.get("group-1")).toBeUndefined(),
    );
    probe.unmount();
  });
});

describe("Ticket 33: 项目绑定与分工总览(右栏项目/成员 Tab)", () => {
  /** 三栏布局渲染,切到指定右栏 Tab。 */
  const openTab = async (tabTestId: string) => {
    fireEvent.click(screen.getByTestId(tabTestId));
    await screen.findByTestId(
      tabTestId === "context-tab-project" ? "project-tab" : "members-tab",
    );
  };

  const renderGroupPage = (mock: ReturnType<typeof messagesFetchMock>) => {
    stubFetch(mock);
    renderWithProviders(
      <GroupLayout groupId="group-1">
        <GroupMessagesPage />
      </GroupLayout>,
      "/groups/group-1",
    );
    return mock;
  };

  it("未绑定时项目 Tab 显示输入框与保存按钮", async () => {
    renderGroupPage(messagesFetchMock());
    await screen.findByText("任务草稿");
    await openTab("context-tab-project");

    expect(screen.getByLabelText("项目绝对路径")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("输入路径保存 → PATCH 成功后显示已绑定路径", async () => {
    const fetchMock = renderGroupPage(messagesFetchMock());
    await screen.findByText("任务草稿");
    await openTab("context-tab-project");

    fireEvent.change(screen.getByLabelText("项目绝对路径"), {
      target: { value: "/Users/me/proj" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await screen.findByText("已绑定项目:/Users/me/proj");
    expect(screen.getAllByText("/Users/me/proj").length).toBeGreaterThan(0);
    // PATCH 请求体正确
    const patch = fetchMock.mock.calls.find(
      ([url, init]) =>
        init?.method === "PATCH" && String(url) === "/api/groups/group-1",
    );
    expect(patch).toBeDefined();
    expect(JSON.parse(String(patch![1]?.body))).toEqual({
      projectPath: "/Users/me/proj",
    });
  });

  it("已绑定群显示解绑按钮,点击解绑 → 恢复未绑定", async () => {
    renderGroupPage(
      messagesFetchMock([], [], "active", {
        projectPath: "/Users/me/proj",
      }),
    );
    await openTab("context-tab-project");
    await screen.findByTestId("project-path");

    fireEvent.click(screen.getByRole("button", { name: "解绑" }));

    await screen.findByText("已解绑项目");
    expect(screen.queryByTestId("project-path")).toBeNull();
  });

  it("400(路径非法)错误提示可见", async () => {
    renderGroupPage(messagesFetchMock([], [], "active", { patchError: 400 }));
    await openTab("context-tab-project");
    await screen.findByLabelText("项目绝对路径");

    fireEvent.change(screen.getByLabelText("项目绝对路径"), {
      target: { value: "/definitely/nope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await screen.findByText(
      /绑定失败: HTTP 400: projectPath 必须是存在的绝对目录路径/,
    );
  });

  it("404(群不存在)错误提示可见", async () => {
    renderGroupPage(messagesFetchMock([], [], "active", { patchError: 404 }));
    await openTab("context-tab-project");
    await screen.findByLabelText("项目绝对路径");

    fireEvent.change(screen.getByLabelText("项目绝对路径"), {
      target: { value: "/Users/me/proj" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await screen.findByText(/绑定失败: HTTP 404/);
  });

  it("成员 Tab 显示成员名字、角色徽章与提示词摘要(长文截断)", async () => {
    const longPrompt =
      "负责统筹协调与最终验收,检查所有产出物并汇总汇报给人类主管,确保进度可控且质量达标,及时同步风险";
    const DIVISION_MEMBERS = [
      {
        agentId: "agent-1",
        name: "hermes-mac",
        type: "hermes",
        device: "mac-mini",
        roles: ["coordinator"],
        prompt: longPrompt,
        joinedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        agentId: "agent-2",
        name: "win-hermes",
        type: "hermes",
        device: "win-pc",
        roles: ["reviewer", "executor"],
        prompt: null,
        joinedAt: "2026-08-01T00:01:00.000Z",
      },
    ];
    renderGroupPage(messagesFetchMock([], DIVISION_MEMBERS));
    // 成员 Tab 是默认激活的右栏 Tab,直接等待成员列表加载。
    await screen.findByTestId("members-tab");
    await screen.findByText("hermes-mac");

    // 成员名
    expect(screen.getByText("hermes-mac")).toBeInTheDocument();
    expect(screen.getByText("win-hermes")).toBeInTheDocument();
    // 角色徽章(中文标签)
    expect(screen.getByText("协调者")).toBeInTheDocument();
    expect(screen.getByText("检视者")).toBeInTheDocument();
    expect(screen.getByText("执行者")).toBeInTheDocument();
    // 长提示词截断到 40 字 + …
    expect(screen.getByText(`${longPrompt.slice(0, 40)}…`)).toBeInTheDocument();
    // 无提示词的成员不渲染提示词文本(完整原文不出现)
    expect(screen.queryByText(longPrompt)).toBeNull();
  });
});
