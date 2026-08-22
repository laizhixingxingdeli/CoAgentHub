import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { CONTEXT_PANEL_OPEN_KEY } from "@/components/layout/context-panel";
import GroupLayout from "@/components/layout/group-layout";
import GroupMembersPage from "@/pages/app/groups/members";
import { __resetUnreadStore, useUnread } from "@/hooks/use-unread";
import { PARTICIPANT_ID_KEY } from "@/lib/api-client";
import { __resetNotificationState } from "@/lib/notifications";
import { groupMessageFrame } from "@/test/frames";
import {
  createFetchMock,
  jsonResponse,
  renderWithProviders,
} from "@/test/utils";
import { MockWebSocket } from "@/test/ws-mock";
import GroupMessagesPage, {
  detectMention,
  formatMessageTime,
  PARTICIPANT_COLORS,
  participantColor,
  resolveAudience,
} from "./messages";

const MESSAGES = [
  {
    id: "msg-1",
    groupId: "group-1",
    senderId: "participant-1",
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
    senderId: "participant-2",
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
    participantId: "participant-1",
    name: "hermes-mac",
    device: "mac-mini",
    roles: ["coordinator"],
    joinedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    participantId: "participant-2",
    name: "win-hermes",
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
            senderId: "participant-1",
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
    {
      // 成员页(GroupMembersPage)的加成员表单候选。
      match: (url) => String(url).endsWith("/api/participants"),
      respond: () => jsonResponse([]),
    },
  ]);
}

/* ---------------- 任务面板(任务控制 UI enhancement) ---------------- */

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
  {
    id: "task-2",
    groupId: "group-1",
    messageId: "msg-2",
    executorParticipantId: "participant-2",
    executorKey: "codebuddy2",
    status: "done",
    checkpointRef: "refs/coagenthub-cp/task-2",
    diffSummary: { hash: "abc123def4567890", summary: "1 file changed" },
    createdAt: "2026-08-01T00:01:00.000Z",
    updatedAt: "2026-08-01T00:02:00.000Z",
  },
];

describe("需求工作区(群内页主区两栏,UI-04b-2) — 主从两栏", () => {
  /** 等待主区需求工作区渲染(共享组件根;任务数据异步加载由后续 findBy 等待)。 */
  const openTasksTab = async () => {
    await screen.findByTestId("requirement-workspace");
  };

  /** 选中左侧某条需求(无 specRef 时需求 id = 任务 id)。 */
  const selectRequirement = async (id: string) => {
    fireEvent.click(await screen.findByTestId(`requirement-row-${id}`));
  };

  it("主区两栏:左列表(各需求)+ 右详情 + 控制条;选中需求显示对应任务的停止/回滚", async () => {
    renderGroupPage(
      messagesFetchMock(MESSAGES, MEMBERS, "active", { tasks: TASKS }),
    );
    await openTasksTab();

    // 左:每个任务(无 specRef)各自成一条需求。
    expect(
      await screen.findByTestId("requirement-row-task-1"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("requirement-row-task-2")).toBeInTheDocument();
    // 右:详情面板(阶梯 + 时间线)+ 控制条。默认选中最新需求,选中态经 effect
    // 生效,故详情/控制条用 findBy 等待。
    expect(
      await screen.findByTestId("requirement-detail-panel"),
    ).toBeInTheDocument();
    expect(
      await screen.findByTestId("requirement-control-bar"),
    ).toBeInTheDocument();

    // 默认选中最新需求(task-2,done + checkpointRef)→ 控制条显示回滚。
    expect(screen.getByTestId("task-rollback-task-2")).toBeInTheDocument();
    // 选中 task-1(running)→ 控制条显示停止。
    await selectRequirement("task-1");
    expect(screen.getByTestId("task-stop-task-1")).toBeInTheDocument();
  });

  it("结果未确认(failed + unconfirmed)需求详情仍可渲染,不崩溃", async () => {
    // status 仍为 failed,但 diffSummary.unconfirmed=true(执行器可能已完成);
    // 旧 TaskPanel 的「结果未确认」黄色徽标由新的阶梯/时间线占位取代,此处仅
    // 验证选中该需求后详情(含时间线)正常渲染。
    const unconfirmedTasks = [
      {
        ...TASKS[0],
        status: "failed",
        diffSummary: {
          error: "执行器未按协议回复，结果未确认",
          unconfirmed: true,
        },
      },
      TASKS[1],
    ];
    renderGroupPage(
      messagesFetchMock(MESSAGES, MEMBERS, "active", {
        tasks: unconfirmedTasks,
      }),
    );
    await openTasksTab();
    await selectRequirement("task-1");

    expect(screen.getByTestId("requirement-detail-panel")).toBeInTheDocument();
    expect(
      screen.getByTestId("requirement-timeline-item-task-1"),
    ).toBeInTheDocument();
  });

  it("空态显示「暂无任务」", async () => {
    renderGroupPage(
      messagesFetchMock(MESSAGES, MEMBERS, "active", { tasks: [] }),
    );
    await openTasksTab();
    await screen.findByText("暂无任务");
  });

  it("点「停止」发出「停止 <taskId>」广播消息,刷新后该任务不再可停止", async () => {
    const cancelledTasks = [{ ...TASKS[0], status: "cancelled" }, TASKS[1]];
    const mock = messagesFetchMock(MESSAGES, MEMBERS, "active", {
      tasks: TASKS,
      tasksAfterCommand: cancelledTasks,
    });
    // 有权身份(coordinator/human):已绑定身份 → 停止/回滚按钮可用。
    localStorage.setItem(PARTICIPANT_ID_KEY, "tok-1");
    renderGroupPage(mock);
    await openTasksTab();
    await selectRequirement("task-1");

    fireEvent.click(screen.getByTestId("task-stop-task-1"));

    await waitFor(() => {
      expect(lastPostPayload(mock)).toEqual({
        body: "停止 task-1",
        audience: "broadcast",
      });
    });
    // 命令后刷新任务列表 → task-1 变 cancelled,控制条不再显示停止按钮。
    await waitFor(() => {
      expect(screen.queryByTestId("task-stop-task-1")).toBeNull();
    });
  });

  it("点「回滚」发出「回滚 <taskId>」广播消息", async () => {
    const mock = messagesFetchMock(MESSAGES, MEMBERS, "active", {
      tasks: TASKS,
    });
    // 有权身份(coordinator/human):已绑定身份 → 停止/回滚按钮可用。
    localStorage.setItem(PARTICIPANT_ID_KEY, "tok-1");
    renderGroupPage(mock);
    await openTasksTab();
    await selectRequirement("task-2");

    fireEvent.click(screen.getByTestId("task-rollback-task-2"));

    await waitFor(() => {
      expect(lastPostPayload(mock)).toEqual({
        body: "回滚 task-2",
        audience: "broadcast",
      });
    });
  });

  it("无权限(Local User 未绑定身份):停止/回滚按钮禁用并提示需要协调者/人类身份", async () => {
    // 不绑定身份的 Local User:列表只读,控制按钮禁用。
    const mock = stubFetch(
      messagesFetchMock(MESSAGES, MEMBERS, "active", { tasks: TASKS }),
    );
    renderGroupPage(mock);
    await openTasksTab();
    await selectRequirement("task-1");

    const stop = screen.getByTestId("task-stop-task-1");
    expect(stop).toBeDisabled();
    // 禁用按钮包裹 span 带身份提示(禁用按钮自身不触发 title 悬浮)。
    expect(stop.closest("span[title]")).toHaveAttribute(
      "title",
      "需要协调者/人类身份",
    );

    // 按钮禁用 → 不发送任何命令消息。
    fireEvent.click(stop);
    expect(
      mock.mock.calls.some(
        ([url, init]) =>
          init?.method === "POST" && String(url).endsWith("/messages"),
      ),
    ).toBe(false);
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

/**
 * 渲染完整三栏群内页(GroupLayout 提供右栏 ContextPanel)。聊天流已从主区搬进
 * 右栏「消息」Tab —— 断言消息流/气泡的用例统一经此渲染 + openMessagesTab。
 */
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

/** 打开右栏「消息」Tab(只读消息流水),等待流容器渲染。 */
const openMessagesTab = async () => {
  fireEvent.click(screen.getByTestId("context-tab-messages"));
  await screen.findByTestId("message-stream");
};

/**
 * 消息流 hook 的 WS 连接 = 最后一个实例:useMessagesPage 在 ContextPanel 顶层
 * 常驻(面板挂载即建连,与消息 Tab 是否打开无关),晚于主区需求工作区的连接
 * 创建;本套件无其它组件在渲染后追加 WS 连接,故 at(-1) 即消息流连接。
 * frame 推到工作区连接会被忽略(它只收 task_output/task_stall_alert)。
 * (依赖创建顺序,新增会开 WS 的组件时需复查。)
 */
const messagesWs = () => MockWebSocket.instances.at(-1)!;

/** 消息 Tab 内的流作用域:主区/成员 Tab 会渲染同名成员名与角色徽章,断言
 * 昵称/角色需限定在流内避免 getByText 多匹配。 */
const stream = () => within(screen.getByTestId("message-stream"));

/* ---------------- 群内页主区改版(消息主区 → 需求两栏) ---------------- */

describe("群内页主区改版:需求两栏 + 只读消息 Tab", () => {
  it("主区渲染「需求列表 | 需求详情」两栏与控制条;不再渲染消息流/输入框", async () => {
    renderGroupPage(
      messagesFetchMock(MESSAGES, MEMBERS, "active", { tasks: TASKS }),
    );

    // 主区两栏直接渲染(无需切换任何 Tab)。
    expect(
      await screen.findByTestId("requirement-workspace"),
    ).toBeInTheDocument();
    expect(await screen.findByTestId("requirement-list")).toBeInTheDocument();
    // 详情/控制条依赖默认选中态(effect 生效),用 findBy 等待。
    expect(
      await screen.findByTestId("requirement-detail-panel"),
    ).toBeInTheDocument();
    // 停止/回滚控制条完整保留(UI-04b-2 那票保住的,搬家后不能丢)。
    expect(
      await screen.findByTestId("requirement-control-bar"),
    ).toBeInTheDocument();
    // 主区不再是聊天流:消息流只在右栏「消息」Tab(未激活不渲染),无输入框/发送按钮。
    expect(screen.queryByTestId("message-stream")).toBeNull();
    expect(screen.queryByLabelText("消息内容")).toBeNull();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  });

  it("主区控制条仍可用:选中 running 需求可停止,done+checkpoint 需求可回滚", async () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "tok-1");
    const mock = renderGroupPage(
      messagesFetchMock(MESSAGES, MEMBERS, "active", { tasks: TASKS }),
    );
    await screen.findByTestId("requirement-workspace");

    // 默认选中最新需求(task-2,done + checkpointRef)→ 回滚可用。
    fireEvent.click(await screen.findByTestId("requirement-row-task-2"));
    fireEvent.click(screen.getByTestId("task-rollback-task-2"));
    await waitFor(() => {
      const call = mock.mock.calls.find(
        ([url, init]) =>
          init?.method === "POST" && String(url).endsWith("/messages"),
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body)).body).toBe("回滚 task-2");
    });

    // 选中 running 的 task-1 → 停止可用,点击发出「停止 task-1」。
    fireEvent.click(screen.getByTestId("requirement-row-task-1"));
    fireEvent.click(screen.getByTestId("task-stop-task-1"));
    await waitFor(() => {
      const stops = mock.mock.calls.filter(
        ([url, init]) =>
          init?.method === "POST" && String(url).endsWith("/messages"),
      );
      expect(stops.length).toBe(2);
      expect(JSON.parse(String(stops[1][1]?.body)).body).toBe("停止 task-1");
    });
  });

  it("消息 Tab:只读消息流水可见,无 Composer 输入框", async () => {
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();

    await screen.findByText("任务草稿");
    // 流水(气泡/发送者)可见,但没有任何消息输入入口(只读)。
    expect(screen.getByText("修正意见")).toBeInTheDocument();
    expect(screen.queryByLabelText("消息内容")).toBeNull();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  });

  it("面板收起(lg+ 隐藏右栏)时消息流订阅仍在:重新展开后流水已就绪", async () => {
    // 持久化收起状态:lg+ 右栏整体隐藏,但 ContextPanel 组件本身常驻挂载,
    // 其顶层持有的消息流 hook(WS/通知/未读清零)不随面板收起而卸载。
    localStorage.setItem(CONTEXT_PANEL_OPEN_KEY, "false");
    renderGroupPage(messagesFetchMock());

    expect(screen.queryByTestId("context-panel")).toBeNull();
    // 重新展开面板 → 打开消息 Tab → 流水已就绪(收起期间数据链路未断)。
    fireEvent.click(screen.getByRole("button", { name: "打开面板" }));
    fireEvent.click(screen.getByTestId("context-tab-messages"));
    expect(await screen.findByText("任务草稿")).toBeInTheDocument();
  });
});

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

  it("@<成员 name> → participant + audienceRef=participantId", () => {
    expect(resolveAudience("请 @win-hermes 看一下", MEMBERS)).toEqual({
      audience: "participant",
      audienceRef: "participant-2",
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

  it("@<含空格成员名> → participant + audienceRef=participantId", () => {
    const withSpace = [
      ...MEMBERS,
      {
        participantId: "participant-9",
        name: "CodeBuddy 执行器",
        device: "mac",
        roles: ["executor"],
      },
    ];
    expect(resolveAudience("@CodeBuddy 执行器 你好", withSpace)).toEqual({
      audience: "participant",
      audienceRef: "participant-9",
    });
    // 成员名嵌在正文中间也能命中
    expect(resolveAudience("请 @CodeBuddy 执行器 处理下", withSpace)).toEqual({
      audience: "participant",
      audienceRef: "participant-9",
    });
  });

  it("含空格成员名大小写不敏感", () => {
    const withSpace = [
      ...MEMBERS,
      {
        participantId: "participant-9",
        name: "CodeBuddy 执行器",
        device: "mac",
        roles: ["executor"],
      },
    ];
    expect(resolveAudience("@codebuddy 执行器 你好", withSpace)).toEqual({
      audience: "participant",
      audienceRef: "participant-9",
    });
  });

  it("@executor(角色)不受含空格成员名干扰 → role", () => {
    const withSpace = [
      ...MEMBERS,
      {
        participantId: "participant-9",
        name: "CodeBuddy 执行器",
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

describe("participantColor 头像分色 (ticket 32)", () => {
  it("同一 participantId 稳定返回同一颜色", () => {
    expect(participantColor("participant-1")).toBe(
      participantColor("participant-1"),
    );
    expect(participantColor("participant-2")).toBe(
      participantColor("participant-2"),
    );
    expect(participantColor("unknown-xyz")).toBe(
      participantColor("unknown-xyz"),
    );
  });

  it("返回值在预置色板内", () => {
    expect(PARTICIPANT_COLORS).toHaveLength(10);
    for (const id of [
      "participant-1",
      "participant-2",
      "a",
      "",
      "unknown-xyz",
    ]) {
      expect(PARTICIPANT_COLORS).toContain(participantColor(id));
    }
  });

  it("不同 participantId 通常得到不同颜色", () => {
    expect(participantColor("participant-1")).not.toBe(
      participantColor("participant-2"),
    );
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
  it("头像分色 + 时间新格式 + 设备进 title", async () => {
    const now = new Date();
    const todayAt = (hour: number, minute: number) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
    const todayMsg = {
      id: "r-1",
      groupId: "group-1",
      senderId: "participant-1",
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
      senderId: "participant-2",
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
    renderGroupPage(messagesFetchMock([todayMsg, oldMsg]));
    await openMessagesTab();

    await screen.findByText("今天的气泡");
    expect(screen.getByText("早些的气泡")).toBeInTheDocument();

    // ① 头像:participant-1/participant-2 各自稳定的分色类,设备只在 title(tooltip)
    const avatar1 = screen.getByTitle("hermes-mac mac-mini");
    const avatar2 = screen.getByTitle("win-hermes win-pc");
    expect(avatar1.className).toContain(
      participantColor("participant-1").split(" ")[0],
    );
    expect(avatar2.className).toContain(
      participantColor("participant-2").split(" ")[0],
    );
    // 设备不再作为可见文本出现
    expect(screen.queryByText(/mac-mini|win-pc/)).toBeNull();

    // ② 时间:今天 → HH:MM;10 天前 → 今年内 M月D日 HH:MM
    expect(screen.getByText("09:30")).toBeInTheDocument();
    const expectedOld = formatMessageTime(oldMsg.createdAt);
    expect(screen.getByText(expectedOld)).toBeInTheDocument();

    // ③ 信息行:昵称 + 角色徽章(词典渲染:协调者/检视者)。成员 Tab(默认右栏)
    // 也渲染同名昵称与角色徽章,故限定在消息流作用域内断言。
    expect(stream().getByText("hermes-mac")).toBeInTheDocument();
    expect(stream().getByText("协调者")).toBeInTheDocument();
    expect(stream().getByText("检视者")).toBeInTheDocument();
  });
});

describe("GroupMessagesPage 文件信令卡片 (ticket 05)", () => {
  const FILE_MESSAGES = [
    {
      id: "msg-file-1",
      groupId: "group-1",
      senderId: "participant-1",
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
    renderGroupPage(messagesFetchMock(FILE_MESSAGES));
    await openMessagesTab();

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
    renderGroupPage(messagesFetchMock(FILE_MESSAGES));
    await openMessagesTab();

    await screen.findByText("trained-model.bin");
    // body 为空:文件卡片在,但气泡里没有单独的文本段
    const fileCard = screen.getByText("trained-model.bin").closest("li");
    expect(fileCard).toBeTruthy();
  });

  it("文件大小人性化格式化:KB 与 B", async () => {
    const mock = stubFetch(
      messagesFetchMock([
        {
          id: "msg-file-kb",
          groupId: "group-1",
          senderId: "participant-1",
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
    renderGroupPage(mock);
    await openMessagesTab();

    expect(await screen.findByText("note.txt")).toBeInTheDocument();
    // 2048 B -> 2.0 KB
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    // 带 body 的消息同时显示正文与文件卡片
    expect(screen.getByText("小文件")).toBeInTheDocument();
  });
});

describe("GroupMessagesPage 消息流与气泡布局", () => {
  it("渲染消息列表与发送者标识(名/设备)与时间", async () => {
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();

    expect(await screen.findByText("任务草稿")).toBeInTheDocument();
    expect(screen.getByText("修正意见")).toBeInTheDocument();
    // Ticket 32: 信息行只显示昵称,角色/受众为独立徽章,设备移入头像 title
    expect(screen.getAllByText("hermes-mac").length).toBeGreaterThan(0);
    expect(screen.getAllByText("win-hermes").length).toBeGreaterThan(0);
    expect(screen.getByTitle("hermes-mac mac-mini")).toBeInTheDocument();
    expect(screen.getByTitle("win-hermes win-pc")).toBeInTheDocument();
    // Role-targeted audience badge (ticket 26: `→ @<角色名>` format)
    expect(screen.getAllByText("→ @reviewer").length).toBeGreaterThan(0);
  });

  it("子消息在父气泡下方以回复串缩进展示", async () => {
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();

    await screen.findByText("修正意见");
    const root = screen.getByText("任务草稿").closest("li");
    const child = screen.getByText("修正意见").closest("li");
    expect(root?.style.paddingLeft).toBe("0px"); // 0 * 16
    expect(child?.style.paddingLeft).toBe("16px"); // 1 * 16
  });

  it("无消息时显示空态(图标 + 引导文案)", async () => {
    renderGroupPage(messagesFetchMock([]));
    await openMessagesTab();

    const empty = await screen.findByText("暂无消息,发送第一条吧");
    // 居中图标 + @ 角色/成员引导副文案。
    expect(empty.closest("div")?.querySelector("svg")).not.toBeNull();
    expect(
      screen.getByText("@ 角色或成员可以让消息直达目标"),
    ).toBeInTheDocument();
  });

  it("顶部标题栏显示群名、返回与面板开关(可开合右栏)", async () => {
    stubFetch(messagesFetchMock());
    // GroupLayout 提供右栏 Provider 并渲染 ContextPanel,标题栏「面板」开关
    // 与之共享开合状态。
    renderWithProviders(
      <GroupLayout groupId="group-1">
        <GroupMessagesPage />
      </GroupLayout>,
      "/groups/group-1",
    );

    // 群名来自 GET /api/groups/:id 的 title
    expect(await screen.findByText("评审任务")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回群组列表" })).toHaveAttribute(
      "href",
      "/groups",
    );
    // 成员入口已从标题栏移除(改入右栏 Tab 的「完整管理」链接);标题栏现为
    // 「面板」开关。lg+ 默认展开右栏 → 开关显示「收起面板」。
    const toggle = screen.getByRole("button", { name: "收起面板" });
    expect(screen.getByTestId("context-panel")).toBeInTheDocument();
    // 点击收起 → 右栏整体隐藏
    fireEvent.click(toggle);
    expect(screen.queryByTestId("context-panel")).toBeNull();
    // 开关切为「打开面板」,点击再展开右栏
    const reopen = screen.getByRole("button", { name: "打开面板" });
    fireEvent.click(reopen);
    expect(await screen.findByTestId("context-panel")).toBeInTheDocument();
  });
});

describe("GroupMessagesPage 气泡方向 (ticket 18)", () => {
  it("绑定 participantId 后自己的消息靠右(蓝气泡 + 我 徽章),他人靠左", async () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-1");
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();

    await screen.findByText("任务草稿");

    // msg-1 是 participant-1 发送的 → own
    const own = screen.getByText("任务草稿").closest("li");
    expect(own).toHaveAttribute("data-own", "true");
    expect(own?.className).toContain("flex-row-reverse");
    // 蓝气泡类:bg-primary(own 专属)
    expect(own?.textContent).toContain("我");

    // msg-2 是 participant-2 发送的 → 他人,靠左
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

    // Ticket 44: 操作条贴气泡角——own 镜像(bottom-0 right-full,右缘=气泡
    // 左缘),他人 left-full(左缘=气泡右缘),底边都与气泡底边齐平。
    const ownBar = within(own!).getByTestId("message-actions-hover");
    expect(ownBar.className).toContain("bottom-0");
    expect(ownBar.className).toContain("right-full");
    expect(ownBar.className).toContain("mr-1");
    const otherBar = within(other!).getByTestId("message-actions-hover");
    expect(otherBar.className).toContain("bottom-0");
    expect(otherBar.className).toContain("left-full");
    expect(otherBar.className).toContain("ml-1");
  });

  it("未绑定 participantId 时所有消息默认靠左、不显示「我」徽章", async () => {
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();

    await screen.findByText("任务草稿");
    const own = screen.getByText("任务草稿").closest("li");
    expect(own).toHaveAttribute("data-own", "false");
    expect(own?.className).not.toContain("flex-row-reverse");
    expect(screen.queryByText("我")).toBeNull();
  });
});

// Composer 已从群内页移除(聊天流降级为右栏「消息」Tab 的只读流水,无输入
// 入口),@ 提及输入、发送 payload、测试执行器下拉等 Composer 交互能力随之
// 下线。这些用例保留为能力记录(describe.skip 不删除),待下一票决定这些
// 能力的去留。
describe.skip("GroupMessagesPage @ 提及输入 (ticket 18)", () => {
  it("输入 @ 弹出候选列表:角色名 + 群成员 name", async () => {
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();
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
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();
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
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();
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
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();
    await screen.findByText("任务草稿");

    const textarea = typeMessage("@");
    await screen.findByRole("listbox", { name: "提及候选" });
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "提及候选" })).toBeNull();
  });

  it("发送前显示解析结果预览(role / participant / broadcast)", async () => {
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();
    await screen.findByText("任务草稿");

    const preview = () => screen.getByTestId("audience-preview").textContent;

    typeMessage("@reviewer 请评审");
    expect(preview()).toContain("将发送给 role:reviewer");

    typeMessage("@win-hermes 私聊");
    expect(preview()).toContain("将发送给 participant:win-hermes");

    typeMessage("普通广播");
    expect(preview()).toContain("将发送给 全体成员");

    typeMessage("@nobody 未命中");
    expect(preview()).toContain("将发送给 全体成员");
  });
});

describe.skip("GroupMessagesPage 发送 payload (ticket 18)", () => {
  it("@<角色名> → audience=role + audienceRef=角色名", async () => {
    const fetchMock = renderGroupPage(messagesFetchMock());
    await openMessagesTab();
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

  it("@<成员 name> → audience=participant + audienceRef=participantId", async () => {
    const fetchMock = renderGroupPage(messagesFetchMock());
    await openMessagesTab();
    await screen.findByText("任务草稿");

    typeMessage("@win-hermes 只给你");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(lastPostPayload(fetchMock)).toEqual({
        body: "@win-hermes 只给你",
        audience: "participant",
        audienceRef: "participant-2",
      });
    });
  });

  it("无 @ → 默认广播 audience=broadcast", async () => {
    const fetchMock = renderGroupPage(messagesFetchMock());
    await openMessagesTab();
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
    const fetchMock = renderGroupPage(messagesFetchMock());
    await openMessagesTab();
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
    const fetchMock = renderGroupPage(messagesFetchMock());
    await openMessagesTab();
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

describe.skip("GroupMessagesPage 测试执行器下拉(任务书分工固化)", () => {
  /** 含 executor 角色成员,供「测试执行器」下拉显式选择。 */
  const EXEC_MEMBERS = [
    {
      participantId: "participant-1",
      name: "hermes-mac",
      device: "mac-mini",
      roles: ["coordinator"],
      joinedAt: "2026-08-01T00:00:00.000Z",
    },
    {
      participantId: "participant-2",
      name: "win-hermes",
      device: "win-pc",
      roles: ["executor"],
      joinedAt: "2026-08-01T00:01:00.000Z",
    },
  ];

  const selectTestExecutor = (value: string) =>
    fireEvent.change(screen.getByLabelText("测试执行器"), {
      target: { value },
    });

  it("默认「自动」→ body 不附加测试执行器行", async () => {
    const fetchMock = stubFetch(messagesFetchMock(MESSAGES, EXEC_MEMBERS));
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    typeMessage("默认自动任务");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(lastPostPayload(fetchMock)).toEqual({
        body: "默认自动任务",
        audience: "broadcast",
      });
      expect(String(lastPostPayload(fetchMock).body)).not.toContain(
        "测试执行器",
      );
    });
  });

  it("选「同一执行器」→ body 附加 **测试执行器:同一执行器** 行", async () => {
    const fetchMock = stubFetch(messagesFetchMock(MESSAGES, EXEC_MEMBERS));
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    selectTestExecutor("same");
    typeMessage("同一执行器任务");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      const payload = lastPostPayload(fetchMock);
      expect(payload.audience).toBe("broadcast");
      expect(String(payload.body)).toContain("**测试执行器:同一执行器**");
    });
  });

  it("显式选成员 → body 附加 **测试执行器:<成员名>** 行", async () => {
    const fetchMock = stubFetch(messagesFetchMock(MESSAGES, EXEC_MEMBERS));
    renderWithProviders(<GroupMessagesPage />, "/groups/group-1");
    await screen.findByText("任务草稿");

    selectTestExecutor("participant-2");
    typeMessage("显式测试任务");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      const payload = lastPostPayload(fetchMock);
      expect(String(payload.body)).toContain("**测试执行器:win-hermes**");
    });
  });

  it("下拉候选 = 群内 executor/specialist 角色成员", async () => {
    renderGroupPage(messagesFetchMock(MESSAGES, EXEC_MEMBERS));
    await openMessagesTab();
    await screen.findByText("任务草稿");

    const options = Array.from(
      screen.getByLabelText("测试执行器").querySelectorAll("option"),
    ).map((o) => o.textContent);
    expect(options).toContain("自动(按分工提示词)");
    expect(options).toContain("同一执行器");
    expect(options).toContain("win-hermes"); // executor 角色成员
    expect(options).not.toContain("hermes-mac"); // coordinator 不入候选
  });
});

describe("GroupMessagesPage 归档只读 (ticket 16)", () => {
  it("已归档群组渲染只读横幅;历史仍可查看;全页无消息输入框", async () => {
    renderGroupPage(messagesFetchMock(MESSAGES, MEMBERS, "archived"));
    await openMessagesTab();

    // Banner appears (the single-group status fetch drives it).
    expect(
      await screen.findByText(/该群组已归档,处于只读状态/),
    ).toBeInTheDocument();

    // History is still browsable — messages render in the messages tab.
    expect(await screen.findByText("任务草稿")).toBeInTheDocument();
    expect(screen.getByText("修正意见")).toBeInTheDocument();

    // Composer 已从群内页移除:全页无消息输入框/发送按钮(不只归档群)。
    expect(screen.queryByLabelText("消息内容")).toBeNull();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  });

  it("已归档群组:消息编辑/回复/删除按钮禁用并提示「群已归档,只读」", async () => {
    // 绑定自己的身份(消息发送者),让编辑/删除按钮出现 —— 归档只读下应禁用。
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-1");
    renderGroupPage(messagesFetchMock(MESSAGES, MEMBERS, "archived"));
    await openMessagesTab();

    expect(await screen.findByText("任务草稿")).toBeInTheDocument();

    // 自己发送的 msg-1 行:编辑/回复/删除按钮全部禁用并提示。
    const ownRow = screen.getByText("任务草稿").closest("li");
    expect(ownRow).not.toBeNull();
    const edit = within(ownRow!).getByRole("button", { name: "编辑" });
    expect(edit).toBeDisabled();
    expect(edit.getAttribute("title")).toBe("群已归档,只读");
    const reply = within(ownRow!).getByRole("button", { name: "回复" });
    expect(reply).toBeDisabled();
    expect(reply.getAttribute("title")).toBe("群已归档,只读");
    const del = within(ownRow!).getByRole("button", { name: "删除" });
    expect(del).toBeDisabled();
    expect(del.getAttribute("title")).toBe("群已归档,只读");
    // 复制是只读操作,保持可用。
    expect(
      within(ownRow!).getByRole("button", { name: "复制" }),
    ).not.toBeDisabled();
  });

  it("进行中群组不显示只读横幅,无消息输入框", async () => {
    renderGroupPage(messagesFetchMock(MESSAGES, MEMBERS, "active"));
    await openMessagesTab();

    await screen.findByText("任务草稿");
    expect(screen.queryByText(/该群组已归档,处于只读状态/)).toBeNull();
    // Composer 已移除:即使 active 群也没有消息输入框。
    expect(screen.queryByLabelText("消息内容")).toBeNull();
  });
});

// Composer 已从群内页移除:身份禁言(人身份无发言入口 + 引导文案)这一
// Composer 层能力随之失效(群内页现在本就没有任何消息输入入口)。用例保留
// 为能力记录,待下一票决定其去留。
describe.skip("GroupMessagesPage 身份禁言 (reviewer spec §3.9 票 10)", () => {
  /** 当前绑定的身份(human-1)在本群持 human 角色 —— 与 MEMBERS 里已有的
   *  coordinator/reviewer 成员并存,验证只按「当前身份的角色」判定。 */
  const HUMAN_MEMBERS = [
    {
      participantId: "human-1",
      name: "本地用户",
      device: null,
      roles: ["human"],
      joinedAt: "2026-08-01T00:00:00.000Z",
    },
    ...MEMBERS,
  ];

  it("当前身份在本群持 human 角色:Composer 输入入口不渲染,引导文案可见", async () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "human-1");
    renderGroupPage(messagesFetchMock(MESSAGES, HUMAN_MEMBERS));
    await openMessagesTab();

    await screen.findByText("任务草稿");
    // 无任何发言入口:textarea / 发送按钮 / 测试执行器下拉都不渲染。
    expect(screen.queryByLabelText("消息内容")).toBeNull();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    expect(screen.queryByLabelText("测试执行器")).toBeNull();
    // 引导文案可见,语义与后端 403 措辞(群是 agent 协作空间,请与检视者
    // agent 直接对话)对齐。
    expect(
      screen.getByText(
        "群是 agent 协作空间;如需发言,请与检视者 agent 直接对话。",
      ),
    ).toBeInTheDocument();
  });

  it("当前身份持非 human 角色(coordinator):Composer 正常可用,无引导文案", async () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-1");
    renderGroupPage(messagesFetchMock(MESSAGES, MEMBERS));
    await openMessagesTab();

    await screen.findByText("任务草稿");
    expect(screen.getByLabelText("消息内容")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
    expect(screen.queryByText(/群是 agent 协作空间/)).toBeNull();
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
            senderId: "participant-1",
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
    localStorage.setItem(PARTICIPANT_ID_KEY, "tok-1");
    vi.stubGlobal("WebSocket", MockWebSocket);
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();

    // Mount-time full load renders first, then the live push lands on top.
    expect(await screen.findByText("任务草稿")).toBeInTheDocument();
    pushMessage(messagesWs(), "实时新消息", "msg-ws-1");
    expect(await screen.findByText("实时新消息")).toBeInTheDocument();
  });

  // Composer 已从群内页移除(消息 Tab 只读):发送后 reload 与 WS 回显去重
  // 依赖发送链路,随之下线。保留为能力记录,待下一票决定这些能力的去留。
  it.skip("WS 回显与发送后 reload 不重复(按 id 去重)", async () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "tok-1");
    vi.stubGlobal("WebSocket", MockWebSocket);
    let reloads = 0;
    const SENT_MSG = {
      id: "msg-9",
      groupId: "group-1",
      senderId: "participant-1",
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
    pushMessage(messagesWs(), "已发送", "msg-9");
    expect(screen.getAllByText("已发送")).toHaveLength(1);
  });

  it("其它群组的 group_message 帧不追加", async () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "tok-1");
    vi.stubGlobal("WebSocket", MockWebSocket);
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();

    expect(await screen.findByText("任务草稿")).toBeInTheDocument();
    const ws = messagesWs();
    act(() =>
      ws.receive(
        JSON.stringify({
          type: "group_message",
          groupId: "group-other",
          message: {
            id: "msg-other-1",
            groupId: "group-other",
            senderId: "participant-2",
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
      senderId: "participant-1",
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
      senderId: "participant-2",
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
      senderId: "participant-2",
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
      senderId: "participant-1",
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
      senderId: "participant-2",
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
      senderId: "participant-1",
      parentId: null,
      audience: "broadcast",
      audienceRef: null,
      body: "无回复根",
      depth: 0,
      createdAt: "2026-08-01T00:05:00.000Z",
    },
  ];

  it("渲染树:根显示折叠按钮与后代计数 badge,默认展开;子消息不渲染自身折叠按钮", async () => {
    renderGroupPage(messagesFetchMock(THREAD));
    await openMessagesTab();

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
    renderGroupPage(messagesFetchMock(THREAD));
    await openMessagesTab();
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
    renderGroupPage(messagesFetchMock(THREAD));
    await openMessagesTab();

    expect(await screen.findByText("孤儿消息")).toBeInTheDocument();
    const orphan = screen.getByText("孤儿消息").closest("li");
    expect(orphan?.style.paddingLeft).toBe("48px"); // 3 * 16
  });

  it("WS 追加后折叠状态保持,计数 badge 即使折叠中也更新", async () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "tok-1");
    vi.stubGlobal("WebSocket", MockWebSocket);
    renderGroupPage(messagesFetchMock(THREAD));
    await openMessagesTab();

    await screen.findByText("孙消息");
    fireEvent.click(screen.getByRole("button", { name: "折叠" }));
    expect(screen.queryByText("子消息一")).toBeNull();

    // WS 推入一条 t-root 下的新回复:折叠不被打断,badge 3 -> 4
    act(() =>
      messagesWs().receive(
        JSON.stringify({
          type: "group_message",
          groupId: "group-1",
          message: {
            id: "t-ws-1",
            groupId: "group-1",
            senderId: "participant-2",
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
  it("窄视口下布局可用:标题栏 / 消息 Tab 内的滚动消息区;无消息输入框", async () => {
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();

    // 标题栏
    expect(await screen.findByText("评审任务")).toBeInTheDocument();
    // 滚动消息区(overflow-y-auto)与消息
    expect(screen.getByText("任务草稿")).toBeInTheDocument();
    expect(
      screen.getByText("任务草稿").closest("li")?.querySelector("p")
        ?.textContent,
    ).toBe("任务草稿");
    // Composer 已从主区移除:全页无输入框/发送按钮。
    expect(screen.queryByLabelText("消息内容")).toBeNull();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    // 气泡有响应式 max-width(sm 断点从 85% 收窄到 75%)且宽度贴合内容
    const bubble = screen
      .getByText("任务草稿")
      .closest("li")
      ?.querySelector(".max-w-\\[85\\%\\]");
    expect(bubble?.className).toContain("w-fit");
    expect(bubble?.className).toContain("sm:max-w-[75%]");
  });
});

describe("GroupMessagesPage 窄屏适配 (ticket 34)", () => {
  // Composer 已从群内页移除(消息 Tab 只读,无输入区):输入区布局断言失去
  // 意义。保留为能力记录,待下一票决定 Composer 相关能力的去留。
  it.skip("输入区布局:textarea 全宽、受众预览可截断、发送按钮固定不挤压", async () => {
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();
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
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();
    await screen.findByText("任务草稿");

    const hoverBars = screen.getAllByTestId("message-actions-hover");
    expect(hoverBars.length).toBeGreaterThan(0);
    expect(hoverBars[0].className).toContain("hidden");
    expect(hoverBars[0].className).toContain("md:flex");
    // Ticket 44: hover 操作条贴气泡角——bottom-0 底边=气泡底边;未绑定
    // participantId → 全是他人消息,left-full ml-1(左缘=气泡右缘)。
    expect(hoverBars[0].className).toContain("bottom-0");
    expect(hoverBars[0].className).toContain("left-full");
    expect(hoverBars[0].className).toContain("ml-1");
    // 点击气泡弹出移动操作条(md:hidden),位置与 hover 条一致(贴角),
    // 点击外部关闭。
    fireEvent.click(screen.getByRole("button", { name: "任务草稿 操作" }));
    const mobileBar = screen.getByTestId("message-actions-mobile");
    expect(mobileBar.className).toContain("md:hidden");
    expect(mobileBar.className).toContain("bottom-0");
    expect(mobileBar.className).toContain("left-full");
    fireEvent.click(document.body);
    expect(
      screen.queryByTestId("message-actions-mobile"),
    ).not.toBeInTheDocument();
  });

  it("回复缩进钳制:浅回复按层级缩进,深回复(≥4 层)不再外推", async () => {
    // 默认 fixture:msg-2 是 depth 1 的回复 → 16px 缩进。
    // 本用例需在同一测试内渲染两棵页面树,第一棵断言后必须卸载,否则 DOM 中
    // 同时存在两套右栏面板(openMessagesTab 的 getByTestId 会多匹配)。
    // stubFetch 必须在 render 之前(挂载即发起消息拉取)。
    stubFetch(messagesFetchMock());
    const first = renderWithProviders(
      <GroupLayout groupId="group-1">
        <GroupMessagesPage />
      </GroupLayout>,
      "/groups/group-1",
    );
    await openMessagesTab();
    await screen.findByText("任务草稿");
    const shallow = document.querySelector('[data-message-id="msg-2"]');
    expect((shallow as HTMLElement).style.paddingLeft).toBe("16px");
    first.unmount();

    // 深回复 depth 6 → 钳制在 64px(而非 96px),窄屏下保留气泡空间。
    const deep = [
      {
        id: "deep-1",
        groupId: "group-1",
        senderId: "participant-1",
        parentId: "msg-1",
        audience: "broadcast",
        audienceRef: null,
        body: "深回复",
        depth: 6,
        createdAt: "2026-08-01T00:10:00.000Z",
      },
    ];
    renderGroupPage(messagesFetchMock(deep));
    await openMessagesTab();
    await screen.findByText("深回复");
    const deepRow = document.querySelector('[data-message-id="deep-1"]');
    expect((deepRow as HTMLElement).style.paddingLeft).toBe("64px");
  });
});

describe("GroupMessagesPage 消息操作 (ticket 21)", () => {
  const rowOf = (body: string) => screen.getByText(body).closest("li");

  // Composer 已从群内页移除(消息 Tab 只读):回复引用条(Composer 层 UI)与
  // 其 parentId 发送链路下线。保留为能力记录,待下一票决定这些能力的去留。
  it.skip("点回复 → 引用条出现(发送者名 + 正文前 30 字),发送带 parentId,成功后引用条清除", async () => {
    const fetchMock = renderGroupPage(messagesFetchMock());
    await openMessagesTab();
    await screen.findByText("任务草稿");

    // 回复 msg-1(participant-1 的「任务草稿」)
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

  // Composer 已从群内页移除(消息 Tab 只读):「取消回复」关闭引用条同样依赖
  // Composer 层。保留为能力记录,待下一票决定这些能力的去留。
  it.skip("取消回复关闭引用条,后续发送不带 parentId", async () => {
    const fetchMock = renderGroupPage(messagesFetchMock());
    await openMessagesTab();
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
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();
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
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();
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
        senderId: "participant-2",
        parentId: null,
        audience: "broadcast",
        audienceRef: null,
        body,
        depth: 0,
        createdAt: "2026-08-02T00:10:00.000Z",
      },
    });

  it("WS 收到新消息且不在底部 → 底部 pill 出现;点击后滚到底部并消失", async () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "tok-1");
    vi.stubGlobal("WebSocket", MockWebSocket);
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();
    await screen.findByText("任务草稿");

    // 用户上滚后:无 pill
    const stream = screen.getByTestId("message-stream");
    scrolledUp(stream);
    expect(screen.queryByTestId("new-message-pill")).toBeNull();

    // WS 推一条新消息 → pill 出现,积压 N=1
    act(() =>
      messagesWs().receive(
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
    localStorage.setItem(PARTICIPANT_ID_KEY, "tok-1");
    vi.stubGlobal("WebSocket", MockWebSocket);
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();
    await screen.findByText("任务草稿");

    const stream = screen.getByTestId("message-stream");
    scrolledUp(stream);
    act(() =>
      messagesWs().receive(
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
    const mock = stubFetch(
      messagesFetchMock([
        msg("g-1", "participant-1", "第一条", t0),
        msg(
          "g-2",
          "participant-1",
          "第二条",
          new Date(Date.parse(t0) + 60_000).toISOString(),
        ),
        // 距上一条 6 分钟(12:00 → 12:01 → 12:07):跨 5 分钟窗口,重新出头
        msg(
          "g-3",
          "participant-1",
          "第三条",
          new Date(Date.parse(t0) + 7 * 60_000).toISOString(),
        ),
      ]),
    );
    renderGroupPage(mock);
    await openMessagesTab();
    await screen.findByText("第一条");

    // 1 分钟间隔的合并成一组,6 分钟间隔的重新出头 → 昵称只出现 2 次
    // (限定消息流作用域:成员 Tab 也渲染成员名 hermes-mac)。
    expect(stream().getAllByText(SENDER)).toHaveLength(2);

    // Ticket 44: compact 行不渲染头像内容,但渲染等宽不可见占位(size-9
    // shrink-0 invisible),与首行带头像的水平位置保持一致;不可聚焦且
    // 不进 a11y 树。
    const compactRow = screen.getByText("第二条").closest("li");
    const placeholder = compactRow?.firstElementChild;
    expect(placeholder?.className).toContain("size-9");
    expect(placeholder?.className).toContain("shrink-0");
    expect(placeholder?.className).toContain("invisible");
    expect(placeholder).toHaveAttribute("aria-hidden", "true");
    // 与首行头像同为行内首个子元素(等宽占位),宽度占位一致
    const headerRow = screen.getByText("第一条").closest("li");
    expect(headerRow?.firstElementChild?.className).toContain("size-9");
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
    const mock = stubFetch(
      messagesFetchMock([
        msg("d-1", "participant-1", "三天前消息", d3.toISOString()),
        msg("d-2", "participant-2", "两天前消息", d2.toISOString()),
        msg("d-3", "participant-1", "昨天消息", d1.toISOString()),
        msg("d-4", "participant-2", "今天消息", d0.toISOString()),
      ]),
    );
    renderGroupPage(mock);
    await openMessagesTab();
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
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-1");
  });

  it("编辑:点编辑 → 输入框出现;保存 → PATCH 调用 + 本地更新 + 退出编辑态", async () => {
    const fetchMock = renderGroupPage(messagesFetchMock());
    await openMessagesTab();
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
    const fetchMock = renderGroupPage(messagesFetchMock());
    await openMessagesTab();
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
    const fetchMock = renderGroupPage(messagesFetchMock());
    await openMessagesTab();
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
    const fetchMock = renderGroupPage(messagesFetchMock());
    await openMessagesTab();
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
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();
    await screen.findByText("任务草稿");

    // msg-2 是 participant-2 发送的 → 无编辑/删除
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
        senderId: "participant-1",
        body: "第二条自己的",
      },
    ];
    renderGroupPage(messagesFetchMock(TWO_OWN));
    await openMessagesTab();
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
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();
    await screen.findByText("任务草稿");

    act(() =>
      messagesWs().receive(
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
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();
    await screen.findByText("任务草稿");

    act(() =>
      messagesWs().receive(
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
      senderId: "participant-2",
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
      senderId: "participant-2",
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
      senderId: "participant-2",
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
    renderGroupPage(messagesFetchMock(STATUS));
    await openMessagesTab();

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
    expect(running?.className).toContain("bg-status-running/10");
    expect(running?.querySelector("p.font-mono")).toBeTruthy();
    expect(running?.textContent).toMatch(/\d{2}:\d{2}/); // 状态条带时间(ticket 32: HH:MM)

    const done = barOf("done");
    expect(done?.className).toContain("bg-status-done/10");
    expect(done?.textContent).toContain("✅ 任务完成");

    const failed = barOf("failed");
    expect(failed?.className).toContain("bg-status-failed/10");
    expect(failed?.textContent).toContain("❌ 任务失败");
  });

  it("✅/❌ 执行结果渲染为精简结果卡片(状态头 + 提交 + 测试/汇报/遗留摘要,不再整段贴 summary)", async () => {
    const mock = stubFetch(
      messagesFetchMock([
        {
          id: "st-4",
          groupId: "group-1",
          senderId: "participant-2",
          parentId: null,
          audience: "broadcast",
          audienceRef: null,
          body: [
            "✅ 任务完成",
            "──────────",
            "提交: 0123456789abcdef0123456789abcdef01234567",
            "测试: 全部 42 个测试通过,无回归",
            "汇报: 完成了特性 X,顺带修复了 Y 与 Z,测试覆盖从 80% 提升到 92%",
            "遗留: 无",
          ].join("\n"),
          contentType: "task_status",
          depth: 0,
          createdAt: statusTime(3),
        },
      ]),
    );
    renderGroupPage(mock);
    await openMessagesTab();

    const card = await screen.findByTestId("task-result-card");
    // 状态头第一行 + 提交 hash 徽标。
    expect(
      within(card).getByTestId("task-result-header").textContent,
    ).toContain("✅ 任务完成");
    expect(card.textContent).toContain("提交 0123456789ab");
    // 测试/汇报/遗留 每项一行摘要。
    expect(
      within(card).getByTestId("task-result-row-测试").textContent,
    ).toContain("全部 42 个测试通过");
    expect(
      within(card).getByTestId("task-result-row-汇报").textContent,
    ).toContain("完成了特性 X");
    expect(within(card).getByTestId("task-result-row-遗留").textContent).toBe(
      "无",
    );
    // 状态条壳仍在(居中 + 绿色),但内容已是精简卡片。
    const shell = screen.getByTestId("task-status");
    expect(shell.getAttribute("data-status")).toBe("done");
    expect(shell.className).toContain("bg-status-done/10");
  });

  it("任务书正文(含 Category/Summary 标记行)渲染为结构化卡片;不识别时保持普通文本", async () => {
    const briefBody = [
      "# CoAgentHub 任务",
      "**Category:** feature",
      "**Summary:** 实现消息头显示「发给谁」",
      "**Acceptance criteria:**",
      "- [ ] 消息头显示 → 接收者",
      "- [ ] 测试全绿",
    ].join("\n");
    const mock = stubFetch(
      messagesFetchMock([
        {
          id: "br-1",
          groupId: "group-1",
          senderId: "participant-1",
          parentId: null,
          audience: "broadcast",
          audienceRef: null,
          body: briefBody,
          contentType: "text/plain",
          depth: 0,
          createdAt: "2026-08-02T00:06:00.000Z",
        },
        {
          id: "pl-1",
          groupId: "group-1",
          senderId: "participant-1",
          parentId: null,
          audience: "broadcast",
          audienceRef: null,
          body: "普通聊天内容,没有任务书标记",
          contentType: "text/plain",
          depth: 0,
          createdAt: "2026-08-02T00:07:00.000Z",
        },
      ]),
    );
    renderGroupPage(mock);
    await openMessagesTab();

    // 任务书 → 结构化卡片:Category/Summary 高亮 + 验收标准列表。
    const card = await screen.findByTestId("task-brief-card");
    expect(card.textContent).toContain("feature");
    expect(card.textContent).toContain("实现消息头显示「发给谁」");
    expect(card.textContent).toContain("消息头显示 → 接收者");
    // 「展开全文」按钮可看原文(原始 markdown 全文)。
    expect(card.textContent).toContain("实现消息头显示「发给谁」");
    fireEvent.click(screen.getByTestId("task-brief-toggle"));
    expect(within(card).getByText(/# CoAgentHub 任务/)).toBeInTheDocument();
    // 普通文本消息不渲染卡片。
    expect(screen.getByText("普通聊天内容,没有任务书标记")).toBeInTheDocument();
  });

  it("discussion 消息渲染普通气泡 + 💬 标记", async () => {
    const mock = stubFetch(
      messagesFetchMock([
        {
          id: "ds-1",
          groupId: "group-1",
          senderId: "participant-2",
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
    renderGroupPage(mock);
    await openMessagesTab();

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
    const mock = stubFetch(
      messagesFetchMock([
        {
          id: "long-1",
          groupId: "group-1",
          senderId: "participant-1",
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
    renderGroupPage(mock);
    await openMessagesTab();

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
    const mock = stubFetch(
      messagesFetchMock([
        {
          id: "st-long",
          groupId: "group-1",
          senderId: "participant-2",
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
    renderGroupPage(mock);
    await openMessagesTab();

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
    const mock = stubFetch(
      messagesFetchMock([
        {
          id: "st-del",
          groupId: "group-1",
          senderId: "participant-2",
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
    renderGroupPage(mock);
    await openMessagesTab();

    expect(await screen.findByText("消息已删除")).toBeInTheDocument();
    expect(screen.queryByTestId("task-status")).toBeNull();
  });

  it("受众标签:participant → @成员名 / 未知 ref → 前 8 位;role → @角色名;broadcast 无标签", async () => {
    const TARGETED = [
      {
        id: "ag-1",
        groupId: "group-1",
        senderId: "participant-1",
        parentId: null,
        audience: "participant",
        audienceRef: "participant-2",
        body: "只给 win-hermes",
        depth: 0,
        createdAt: "2026-08-02T00:00:00.000Z",
      },
      {
        id: "ag-2",
        groupId: "group-1",
        senderId: "participant-1",
        parentId: null,
        audience: "participant",
        audienceRef: "abc12345-unknown-member",
        body: "未知成员",
        depth: 0,
        createdAt: "2026-08-02T00:06:00.000Z",
      },
      {
        id: "ag-3",
        groupId: "group-1",
        senderId: "participant-1",
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
        senderId: "participant-1",
        parentId: null,
        audience: "broadcast",
        audienceRef: null,
        body: "广播消息",
        depth: 0,
        createdAt: "2026-08-02T00:18:00.000Z",
      },
    ];
    renderGroupPage(messagesFetchMock(TARGETED));
    await openMessagesTab();

    await screen.findByText("只给 win-hermes");
    // 未绑定身份 = Local User(human 视角,全可见):定向消息显示 📨 定向给
    // <执行器名>;未知 ref → ref 前 8 位;role 仍显示 → @角色名。
    expect(screen.getByText("📨 定向给 win-hermes")).toBeInTheDocument();
    expect(screen.getByText("📨 定向给 abc12345")).toBeInTheDocument();
    expect(screen.getByText("→ @reviewer")).toBeInTheDocument();
    // broadcast 不加标签
    const broadcastRow = screen.getByText("广播消息").closest("li");
    expect(broadcastRow?.textContent).not.toContain("→ @");
    expect(broadcastRow?.textContent).not.toContain("📨");
  });

  it("非 human 视角(绑定非 human 成员):定向消息不显示 📨 标签,仍显示 → @成员名", async () => {
    const TARGETED = [
      {
        id: "nh-1",
        groupId: "group-1",
        senderId: "participant-1",
        parentId: null,
        audience: "participant",
        audienceRef: "participant-2",
        body: "只给 win-hermes",
        depth: 0,
        createdAt: "2026-08-02T00:00:00.000Z",
      },
      {
        id: "nh-2",
        groupId: "group-1",
        senderId: "participant-1",
        parentId: null,
        audience: "role",
        audienceRef: "reviewer",
        body: "给评审角色",
        depth: 0,
        createdAt: "2026-08-02T00:12:00.000Z",
      },
    ];
    const mock = stubFetch(messagesFetchMock(TARGETED));
    // 绑定一个非 human 成员(coordinator):不显示 📨 标签。
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-1");
    renderGroupPage(mock);
    await openMessagesTab();

    await screen.findByText("只给 win-hermes");
    expect(screen.getByText("→ @win-hermes")).toBeInTheDocument();
    expect(screen.queryByText(/📨/)).toBeNull();
  });

  it("旧消息 contentType 为 null/undefined → 按普通气泡渲染", async () => {
    renderGroupPage(messagesFetchMock()); // 默认 MESSAGES 无 contentType 字段
    await openMessagesTab();

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
    localStorage.setItem(PARTICIPANT_ID_KEY, "tok-1");
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

    renderGroupPage(messagesFetchMock());
    // markRead 属消息页(GroupMessagesPage 挂载即清零);打开 Tab 仅需查看流水。
    await openMessagesTab();
    await screen.findByText("任务草稿");

    await waitFor(() =>
      expect(probe.result.current.unread.get("group-1")).toBeUndefined(),
    );
    probe.unmount();
  });

  it("成员页(共享右栏面板)不触发 markRead:未读徽标保留", async () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "tok-1");
    vi.stubGlobal("WebSocket", MockWebSocket);
    const probe = renderHook(() => useUnread());
    const storeWs = MockWebSocket.instances[0];
    act(() =>
      storeWs.receive(groupMessageFrame("group-1", "成员页到达的未读")),
    );
    expect(probe.result.current.unread.get("group-1")).toBe(1);

    // 成员页同样由 GroupLayout 包裹(ContextPanel 常驻、消息流 hook 随面板
    // 挂载),但 markRead 只属于消息页 —— 进入成员页不清零未读。
    stubFetch(messagesFetchMock());
    renderWithProviders(
      <GroupLayout groupId="group-1">
        <GroupMembersPage />
      </GroupLayout>,
      "/groups/group-1/members",
    );
    await screen.findByTestId("members-tab");

    expect(probe.result.current.unread.get("group-1")).toBe(1);
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

  it("未绑定时项目 Tab 显示输入框与保存按钮", async () => {
    renderGroupPage(messagesFetchMock());
    // 主区已无消息流(需求工作区):以工作区渲染作为页面加载完成的等待条件。
    await screen.findByTestId("requirement-workspace");
    await openTab("context-tab-project");

    expect(screen.getByLabelText("项目绝对路径")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("输入路径保存 → PATCH 成功后显示已绑定路径", async () => {
    const fetchMock = renderGroupPage(messagesFetchMock());
    // 主区已无消息流(需求工作区):以工作区渲染作为页面加载完成的等待条件。
    await screen.findByTestId("requirement-workspace");
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
        participantId: "participant-1",
        name: "hermes-mac",
        device: "mac-mini",
        roles: ["coordinator"],
        prompt: longPrompt,
        joinedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        participantId: "participant-2",
        name: "win-hermes",
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
    // 成员名(限定成员 Tab 作用域:新 Composer 测试执行器下拉也含成员名,避免歧义)
    const membersTab = within(screen.getByTestId("members-tab"));
    expect(membersTab.getByText("hermes-mac")).toBeInTheDocument();
    expect(membersTab.getByText("win-hermes")).toBeInTheDocument();
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

describe("浏览器桌面通知 (WS group_message → Notification)", () => {
  /** jsdom 无 Notification — 手动 mock 记录实例与权限状态。 */
  class MockNotification {
    static permission: NotificationPermission = "granted";
    static requestPermission = vi.fn(
      async () => "granted" as NotificationPermission,
    );
    static instances: MockNotification[] = [];

    title: string;
    options: NotificationOptions | undefined;
    onclick: (() => void) | null = null;
    close = vi.fn();

    constructor(title: string, options?: NotificationOptions) {
      this.title = title;
      this.options = options;
      MockNotification.instances.push(this);
    }
  }

  let focusSpy: ReturnType<typeof vi.spyOn>;

  /** 推一条他人(participant-2)的 group_message 帧,等价于服务器 WS hub 推送。 */
  const pushFrame = (ws: MockWebSocket, body: string, id: string) =>
    act(() =>
      ws.receive(
        JSON.stringify({
          type: "group_message",
          groupId: "group-1",
          message: {
            id,
            groupId: "group-1",
            senderId: "participant-2",
            parentId: null,
            audience: "broadcast",
            audienceRef: null,
            body,
            depth: 0,
            createdAt: "2026-08-10T00:00:00.000Z",
          },
        }),
      ),
    );

  beforeEach(() => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-1");
    __resetNotificationState();
    MockNotification.instances = [];
    MockNotification.permission = "granted";
    MockNotification.requestPermission = vi.fn(
      async () => "granted" as NotificationPermission,
    );
    vi.stubGlobal("Notification", MockNotification);
    vi.stubGlobal("WebSocket", MockWebSocket);
    focusSpy = vi.spyOn(window, "focus").mockImplementation(() => {});
  });

  afterEach(() => {
    // 只还原 focus spy —— vi.restoreAllMocks() 会连带清掉 setup.ts 里
    // matchMedia 的 mock 实现,导致后续用例挂载时 mql 为 undefined。
    focusSpy?.mockRestore();
    // 还原页面可见性,避免污染后续用例
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
  });

  it("页面隐藏 + 他人新消息 → 创建系统通知(标题=群标题,正文=发送者: 摘要)", async () => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();

    await screen.findByText("任务草稿");
    pushFrame(messagesWs(), "改好了,请合并", "notify-1");

    expect(MockNotification.instances).toHaveLength(1);
    const n = MockNotification.instances[0];
    // 群标题来自 GET /api/groups/group-1 的 title;发送者名来自成员列表
    expect(n.title).toBe("评审任务");
    expect(n.options?.body).toBe("win-hermes: 改好了,请合并");
  });

  it("页面可见时收消息 → 不发通知", async () => {
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();

    await screen.findByText("任务草稿");
    pushFrame(messagesWs(), "页面可见的消息", "notify-2");

    expect(MockNotification.instances).toHaveLength(0);
  });

  it("自己发的消息(WS 回显)→ 不发通知", async () => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    renderGroupPage(messagesFetchMock());
    await openMessagesTab();

    await screen.findByText("任务草稿");
    // senderId == 当前绑定 participant-1:即使隐藏也不打扰
    act(() =>
      messagesWs().receive(
        JSON.stringify({
          type: "group_message",
          groupId: "group-1",
          message: {
            id: "notify-3",
            groupId: "group-1",
            senderId: "participant-1",
            parentId: null,
            audience: "broadcast",
            audienceRef: null,
            body: "自己的回显",
            depth: 0,
            createdAt: "2026-08-10T00:00:00.000Z",
          },
        }),
      ),
    );

    expect(MockNotification.instances).toHaveLength(0);
  });

  it("点击通知 → 聚焦窗口并跳转到该群消息页 /groups/group-1", async () => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    // 记录式内存路由:点击通知后断言 navigate 落点
    const loc = memoryLocation({ path: "/groups/group-1", record: true });
    stubFetch(messagesFetchMock());
    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          shouldRetryOnError: false,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
        }}
      >
        <Router hook={loc.hook}>
          <GroupLayout groupId="group-1">
            <GroupMessagesPage />
          </GroupLayout>
        </Router>
      </SWRConfig>,
    );
    // 消息流 hook 在消息 Tab 内:打开 Tab 才会订阅 WS 并触发通知。
    await openMessagesTab();

    await screen.findByText("任务草稿");
    pushFrame(messagesWs(), "点我跳转", "notify-4");
    const n = MockNotification.instances[0];

    act(() => n.onclick?.());

    expect(window.focus).toHaveBeenCalled();
    expect(loc.history).toEqual(["/groups/group-1", "/groups/group-1"]);
    expect(n.close).toHaveBeenCalled();
  });
});
