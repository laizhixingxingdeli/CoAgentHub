/**
 * TasksTab 主从两栏 (UI-04b-2) 测试:需求列表 + 需求详情(含控制条)两栏布局,
 * 停止/回滚按钮经控制条复用 TaskPanel 的交互,以及无需求时回退 TaskPanel。
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TasksTab } from "@/components/layout/context-panel/tasks-tab";
import { PARTICIPANT_ID_KEY } from "@/lib/api-client";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";
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
    prompt: null,
    joinedAt: "2026-08-01T00:00:00.000Z",
  },
];

function makeTask(overrides: Partial<TaskItem> & { id: string }): TaskItem {
  return {
    groupId: "group-1",
    messageId: "msg-1",
    executorParticipantId: "participant-1",
    executorKey: "codebuddy",
    status: "running",
    checkpointRef: null,
    specRef: "login-spec",
    specHash: null,
    diffSummary: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: null,
    ...overrides,
  };
}

function fetchMock(tasks: TaskItem[], groupStatus = "active") {
  return createFetchMock([
    {
      match: (url) => url.endsWith("/api/groups/group-1/members"),
      respond: () => jsonResponse(MEMBERS),
    },
    {
      match: (url) => url.endsWith("/api/groups/group-1/messages"),
      respond: () => jsonResponse([]),
    },
    {
      match: (url) =>
        url.endsWith("/api/groups/group-1/tasks") &&
        !String(url).includes("includeOutput"),
      respond: () => jsonResponse(tasks),
    },
    {
      match: (url) => /\/api\/groups\/group-1$/.test(String(url)),
      respond: () =>
        jsonResponse({
          id: "group-1",
          title: "任务改版",
          status: groupStatus,
        }),
    },
  ]);
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  MockWebSocket.reset();
  localStorage.clear();
});

describe("TasksTab 主从两栏 (UI-04b-2)", () => {
  it("有需求:左列表 + 右详情 + 控制条,两栏布局渲染", async () => {
    vi.stubGlobal(
      "fetch",
      fetchMock([makeTask({ id: "task-1", status: "running" })]),
    );
    renderWithProviders(<TasksTab groupId="group-1" />, "/groups/group-1");

    // 左:需求列表(master)。
    expect(await screen.findByTestId("requirement-list")).toBeInTheDocument();
    expect(
      await screen.findByTestId("requirement-row-login-spec"),
    ).toBeInTheDocument();
    // 右:控制条 + 需求详情(阶梯 + 时间线)。
    expect(
      await screen.findByTestId("requirement-control-bar"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("requirement-detail-panel")).toBeInTheDocument();
    expect(
      screen.getByTestId("requirement-timeline-item-task-1"),
    ).toBeInTheDocument();
  });

  it("控制条:running 最新任务显示停止按钮,点击 → 发「停止 <taskId>」", async () => {
    const mock = fetchMock([makeTask({ id: "task-1", status: "running" })]);
    vi.stubGlobal("fetch", mock);
    // 绑定身份 → canControl=true,按钮可点。
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-1");
    renderWithProviders(<TasksTab groupId="group-1" />, "/groups/group-1");

    const stop = await screen.findByTestId("task-stop-task-1");
    expect(stop).toBeInTheDocument();
    fireEvent.click(stop);

    await waitFor(() => {
      const post = mock.mock.calls.find(
        ([url, init]) =>
          init?.method === "POST" &&
          String(url).endsWith("/api/groups/group-1/messages"),
      );
      expect(post).toBeDefined();
      expect(JSON.parse(String(post![1]?.body)).body).toBe("停止 task-1");
    });
  });

  it("控制条:done + checkpoint 最新任务显示回滚按钮,点击 → 发「回滚 <taskId>」", async () => {
    const mock = fetchMock([
      makeTask({
        id: "task-1",
        status: "done",
        checkpointRef: "refs/coagenthub-cp/task-1",
      }),
    ]);
    vi.stubGlobal("fetch", mock);
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-1");
    renderWithProviders(<TasksTab groupId="group-1" />, "/groups/group-1");

    const rollback = await screen.findByTestId("task-rollback-task-1");
    expect(rollback).toBeInTheDocument();
    fireEvent.click(rollback);

    await waitFor(() => {
      const post = mock.mock.calls.find(
        ([url, init]) =>
          init?.method === "POST" &&
          String(url).endsWith("/api/groups/group-1/messages"),
      );
      expect(post).toBeDefined();
      expect(JSON.parse(String(post![1]?.body)).body).toBe("回滚 task-1");
    });
  });

  it("无需求(空任务列表):回退 TaskPanel,显示暂无任务,不空白/不报错", async () => {
    vi.stubGlobal("fetch", fetchMock([]));
    renderWithProviders(<TasksTab groupId="group-1" />, "/groups/group-1");

    // 回退路径渲染原始任务面板。
    expect(await screen.findByTestId("task-panel")).toBeInTheDocument();
    expect(screen.getByText("暂无任务")).toBeInTheDocument();
    // 主从两栏组件不渲染。
    expect(screen.queryByTestId("requirement-list")).toBeNull();
    expect(screen.queryByTestId("requirement-control-bar")).toBeNull();
  });

  it("归档群:控制条停止/回滚按钮禁用并提示「群已归档,只读」", async () => {
    vi.stubGlobal(
      "fetch",
      fetchMock([makeTask({ id: "task-1", status: "running" })], "archived"),
    );
    renderWithProviders(<TasksTab groupId="group-1" />, "/groups/group-1");

    const stop = await screen.findByTestId("task-stop-task-1");
    expect(stop).toBeDisabled();
    expect(stop.closest("span")?.getAttribute("title")).toBe("群已归档,只读");
  });
});
