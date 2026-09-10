import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";
import type { Member } from "@/pages/app/groups/messages/types";
import {
  createFetchMock,
  jsonResponse,
  renderWithProviders,
} from "@/test/utils";
import { MockWebSocket } from "@/test/ws-mock";
import {
  RequirementWorkspace,
  stopTaskIdentifier,
} from "./requirement-workspace";

/**
 * RequirementWorkspace 响应式布局测试(requirement-pane-responsive):
 * - 窄视口(<1024px):单栏 —— 列表 / 详情二选一,点击行进详情,返回键回列表;
 * - 桌面(≥1024px):两栏 —— 列表与详情同时可见。
 * 断点判定走 useIsDesktop(读 window.innerWidth ≥ 1024),测试通过覆盖
 * window.innerWidth 模拟视口宽度;matchMedia 由 setup.ts 提供桩。
 */

function makeTask(overrides: Partial<TaskItem> & { id: string }): TaskItem {
  return {
    groupId: "group-1",
    messageId: "msg-1",
    executorParticipantId: "participant-1",
    executorKey: "codex",
    status: "running",
    checkpointRef: null,
    specRef: "specs/title-readability.md",
    specHash: null,
    diffSummary: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

type HealthBody = {
  stale?: boolean;
  staleReason?: "process" | "build" | "both" | null;
};

function workspaceFetchMock(
  tasks: TaskItem[],
  health: HealthBody = { stale: false },
  members: Member[] = [],
  group: { status: "active" | "archived" } = { status: "active" },
) {
  return createFetchMock([
    {
      match: (url) => url === "/api/health",
      respond: () => jsonResponse(health),
    },
    {
      match: (url) => /\/api\/groups\/[^/]+$/.test(String(url)),
      respond: () =>
        jsonResponse({
          id: "group-1",
          title: "评审任务",
          status: group.status,
          projectPath: null,
        }),
    },
    {
      match: (url) => url.includes("/api/groups/") && url.endsWith("/messages"),
      respond: () => jsonResponse([]),
    },
    {
      match: (url) => url.includes("/api/groups/") && url.endsWith("/members"),
      respond: () => jsonResponse(members),
    },
    {
      match: (url) => {
        const path = String(url).split("?")[0];
        return path.includes("/api/groups/") && path.endsWith("/tasks");
      },
      respond: () => jsonResponse(tasks),
    },
    {
      // Per-task detail (l1/l3/liveness). Default empty observability.
      match: (url) =>
        /\/api\/groups\/[^/]+\/tasks\/[^/?]+$/.test(String(url).split("?")[0]),
      respond: (url) => {
        const id = String(url).split("/").pop() ?? "";
        const row = tasks.find((task) => task.id === id);
        return jsonResponse(row ?? { id });
      },
    },
  ]);
}

/** 覆盖 jsdom 默认 innerWidth(1024),模拟指定视口宽度。 */
function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

function renderWorkspace(
  tasks: TaskItem[],
  health: HealthBody = { stale: false },
  members: Member[] = [],
  group: { status: "active" | "archived" } = { status: "active" },
) {
  vi.stubGlobal("fetch", workspaceFetchMock(tasks, health, members, group));
  return renderWithProviders(<RequirementWorkspace groupId="group-1" />);
}

const TWO_REQUIREMENTS = [
  makeTask({ id: "task-a", specRef: "specs/a.md", brief: "# 需求A" }),
  makeTask({ id: "task-b", specRef: "specs/b.md", brief: "# 需求B" }),
];

beforeEach(() => {
  MockWebSocket.reset();
  vi.stubGlobal("WebSocket", MockWebSocket);
  // jsdom 的 window.confirm 是 no-op 桩(恒 false),逐用例可控(与
  // files/index.test.tsx 同款做法)。
  Object.defineProperty(window, "confirm", {
    configurable: true,
    writable: true,
    value: vi.fn(() => false),
  });
  // 清掉可能残留的身份绑定,保证 canControl 判定确定性;setup.ts 写入的语言
  // 会被清掉,需补回(否则 t() 回落 en-US 导致中文断言失配)。
  localStorage.clear();
  localStorage.setItem("coagenthub.lang", "zh");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as { innerWidth?: number }).innerWidth;
});

describe("RequirementWorkspace 响应式布局", () => {
  it("runtime stale 只在页面级显示一次且可关闭", async () => {
    setViewport(1280);
    renderWorkspace(TWO_REQUIREMENTS, { stale: true });

    const banner = await screen.findByTestId("runtime-stale-banner");
    expect(banner).toHaveTextContent("后端运行的不是最新构建");
    expect(screen.getAllByTestId("runtime-stale-banner")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "关闭后端状态提示" }));
    expect(
      screen.queryByTestId("runtime-stale-banner"),
    ).not.toBeInTheDocument();
  });

  it("build 陈旧时提示重新 build 再重启", async () => {
    setViewport(1280);
    renderWorkspace(TWO_REQUIREMENTS, { stale: true, staleReason: "build" });

    const banner = await screen.findByTestId("runtime-stale-banner");
    expect(banner).toHaveTextContent("需重新 build 再重启");
  });

  it("both 陈旧时提示 build 后重启", async () => {
    setViewport(1280);
    renderWorkspace(TWO_REQUIREMENTS, { stale: true, staleReason: "both" });

    const banner = await screen.findByTestId("runtime-stale-banner");
    expect(banner).toHaveTextContent("需 build 后重启");
  });

  it("真实零子任务协调载荷:列表与详情共享 na-declared/done 状态", async () => {
    setViewport(1280);
    const reason = "本票由发布者直接定向 codex 完成实现,未创建下游执行子任务。";
    renderWorkspace([
      makeTask({
        id: "project-onboarding-coordination",
        status: "done",
        specRef: "specs/project-onboarding-interactive.md",
        diffSummary: {
          review_request: {
            type: "review_request",
            layer: 3,
            taskId: "project-onboarding-coordination",
            specRef: "specs/project-onboarding-interactive.md",
            specHash: "0b03bd37",
            diffSummary: "L2 功能验收通过。",
          },
          noExecutionReason: reason,
        },
      }),
    ]);

    const row = await screen.findByTestId(
      "requirement-row-specs/project-onboarding-interactive.md",
    );
    expect(
      within(row).getByTestId(
        "requirement-step-specs/project-onboarding-interactive.md-0",
      ),
    ).toHaveAttribute("data-status", "na-declared");
    expect(
      within(row).getByTestId(
        "requirement-step-specs/project-onboarding-interactive.md-1",
      ),
    ).toHaveAttribute("data-status", "done");
    expect(
      await screen.findByTestId("requirement-l1-no-execution-reason"),
    ).toHaveTextContent(reason);
    expect(
      await screen.findByTestId("requirement-l2-conclusion"),
    ).toHaveTextContent("L2 功能验收通过。");
  });

  it("窄视口(<1024px)单栏:默认列表,点击行进详情,返回键回列表", async () => {
    setViewport(500);
    renderWorkspace(TWO_REQUIREMENTS);

    // 默认单栏列表:详情不渲染。
    expect(await screen.findByTestId("requirement-list")).toBeInTheDocument();
    expect(
      screen.queryByTestId("requirement-detail-panel"),
    ).not.toBeInTheDocument();

    // 点击 specRef 派生标题「a」行 → 切到详情,列表隐藏。
    fireEvent.click(screen.getByTestId("requirement-row-specs/a.md"));
    expect(
      await screen.findByTestId("requirement-detail-panel"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("task-stop-task-a")).toBeInTheDocument();
    expect(
      screen.queryByTestId("requirement-control-bar"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("requirement-list")).not.toBeInTheDocument();

    // 返回键 → 回到列表,详情隐藏。
    fireEvent.click(screen.getByTestId("requirement-mobile-back"));
    expect(await screen.findByTestId("requirement-list")).toBeInTheDocument();
    expect(
      screen.queryByTestId("requirement-detail-panel"),
    ).not.toBeInTheDocument();
  });

  it("窄视口单栏切换:重新选中另一需求,详情随之切换", async () => {
    setViewport(500);
    renderWorkspace(TWO_REQUIREMENTS);

    fireEvent.click(await screen.findByTestId("requirement-row-specs/a.md"));
    expect(await screen.findByText("a")).toBeInTheDocument();

    // 返回列表 → 点 specRef 派生标题「b」→ 详情切到 B。
    fireEvent.click(screen.getByTestId("requirement-mobile-back"));
    fireEvent.click(await screen.findByTestId("requirement-row-specs/b.md"));
    expect(
      await screen.findByTestId("requirement-detail-panel"),
    ).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.queryByText("a")).not.toBeInTheDocument();
  });

  it("桌面(≥1024px)两栏:列表与详情同时可见", async () => {
    setViewport(1280);
    renderWorkspace(TWO_REQUIREMENTS);

    expect(await screen.findByTestId("requirement-list")).toBeInTheDocument();
    expect(
      await screen.findByTestId("requirement-detail-panel"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("task-stop-task-b")).toBeInTheDocument();
    expect(
      screen.queryByTestId("requirement-control-bar"),
    ).not.toBeInTheDocument();
    // 两栏模式下默认选中最新需求(b),列表行仍可见;详情区标题同为 b。
    const requirementList = screen.getByTestId("requirement-list");
    expect(requirementList).toBeInTheDocument();
    expect(
      within(requirementList).queryByTestId(/task-(stop|rollback)-/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("requirement-row-specs/a.md"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("requirement-detail-panel")).getByText("b"),
    ).toBeInTheDocument();
  });

  it("通过 task_status_changed 增量显示新需求,不重拉任务列表", async () => {
    setViewport(1280);
    const fetchMock = workspaceFetchMock(TWO_REQUIREMENTS);
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<RequirementWorkspace groupId="group-1" />);

    await screen.findByTestId("requirement-row-specs/b.md");
    const tasksRequestCount = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/tasks"),
    ).length;
    const task = makeTask({
      id: "task-c",
      specRef: "specs/c.md",
      brief: "# 需求C",
      createdAt: "2026-08-01T02:00:00.000Z",
      updatedAt: "2026-08-01T02:00:00.000Z",
    });

    act(() =>
      MockWebSocket.instances[0].receive(
        JSON.stringify({
          type: "task_status_changed",
          groupId: "group-1",
          taskId: task.id,
          status: task.status,
          task: { ...task, retryCount: 0 },
        }),
      ),
    );

    expect(
      await screen.findByTestId("requirement-row-specs/c.md"),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/tasks")),
    ).toHaveLength(tasksRequestCount);
  });

  it("更新任务状态时保持选中的需求不变", async () => {
    setViewport(1280);
    renderWorkspace(TWO_REQUIREMENTS);

    await screen.findByTestId("requirement-row-specs/b.md");
    fireEvent.click(screen.getByTestId("requirement-row-specs/a.md"));
    const task = makeTask({
      id: "task-a",
      specRef: "specs/a.md",
      brief: "# 需求A",
      status: "done",
      updatedAt: "2026-08-01T03:00:00.000Z",
    });

    act(() =>
      MockWebSocket.instances[0].receive(
        JSON.stringify({
          type: "task_status_changed",
          groupId: "group-1",
          taskId: task.id,
          status: task.status,
          task: { ...task, retryCount: 0 },
        }),
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId("requirement-row-specs/a.md")).toHaveAttribute(
        "data-selected",
        "true",
      );
      expect(
        screen.getByTestId("requirement-step-specs/a.md-0"),
      ).toHaveAttribute("data-status", "done");
    });
    expect(
      within(screen.getByTestId("requirement-detail-panel")).getByText("a"),
    ).toBeInTheDocument();
  });
});

// 需求/修复二态标签(requirement-list-kind-tabs):三种类型任务(requirement /
// fix / null)混合,验证过滤、null 归类、计数、空态与切换标签的选中回落。
const MIXED_KINDS = [
  makeTask({
    id: "task-req",
    specRef: "specs/req.md",
    brief: "# 需求X",
    dispatchKind: "requirement",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  }),
  makeTask({
    id: "task-old",
    specRef: "specs/old.md",
    brief: "# 旧任务",
    dispatchKind: null,
    createdAt: "2026-08-01T01:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
  }),
  makeTask({
    id: "task-fix",
    specRef: "specs/fix.md",
    brief: "# 修复Y",
    dispatchKind: "fix",
    createdAt: "2026-08-01T02:00:00.000Z",
    updatedAt: "2026-08-01T02:00:00.000Z",
  }),
];

describe("RequirementWorkspace 需求/修复标签(requirement-list-kind-tabs)", () => {
  it("默认「需求」标签:null dispatchKind 归入需求,修复项不显示", async () => {
    setViewport(1280);
    renderWorkspace(MIXED_KINDS);

    // 需求 (2):requirement + null;修复 (1):fix。
    expect(
      await screen.findByTestId("requirement-kind-tab-requirement"),
    ).toHaveTextContent("需求 (2)");
    expect(screen.getByTestId("requirement-kind-tab-fix")).toHaveTextContent(
      "修复 (1)",
    );
    expect(
      screen.getByTestId("requirement-row-specs/req.md"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("requirement-row-specs/old.md"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("requirement-row-specs/fix.md"),
    ).not.toBeInTheDocument();
  });

  it("切到「修复」标签:只显示 fix 项,计数不变", async () => {
    setViewport(1280);
    renderWorkspace(MIXED_KINDS);

    fireEvent.click(await screen.findByTestId("requirement-kind-tab-fix"));
    expect(
      screen.getByTestId("requirement-row-specs/fix.md"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("requirement-row-specs/req.md"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("requirement-row-specs/old.md"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("requirement-kind-tab-requirement"),
    ).toHaveTextContent("需求 (2)");
    expect(screen.getByTestId("requirement-kind-tab-fix")).toHaveTextContent(
      "修复 (1)",
    );
  });

  it("某标签下为空时显示空态,标签本身仍可见可点", async () => {
    setViewport(1280);
    renderWorkspace(TWO_REQUIREMENTS);

    // 两条都是 null → 全部归「需求」,「修复」计数为 0。
    expect(
      await screen.findByTestId("requirement-kind-tab-fix"),
    ).toHaveTextContent("修复 (0)");

    fireEvent.click(screen.getByTestId("requirement-kind-tab-fix"));
    // 空态提示出现,标签栏与两个标签仍在。
    expect(screen.getByTestId("requirement-kind-empty")).toHaveTextContent(
      "暂无修复任务",
    );
    expect(screen.getByTestId("requirement-kind-tabs")).toBeInTheDocument();
    expect(
      screen.getByTestId("requirement-kind-tab-requirement"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("requirement-list")).not.toBeInTheDocument();

    // 切回「需求」:列表恢复。
    fireEvent.click(screen.getByTestId("requirement-kind-tab-requirement"));
    expect(screen.getByTestId("requirement-list")).toBeInTheDocument();
    expect(
      screen.getByTestId("requirement-row-specs/a.md"),
    ).toBeInTheDocument();
  });

  it("切换标签:原选中不在新列表时回落为未选中,不自动挑一条", async () => {
    setViewport(1280);
    renderWorkspace(MIXED_KINDS);

    // 初始默认选中「需求」标签下最新一条(specs/old.md,01:00 晚于 req 的 00:00)。
    // 行渲染先于选中 effect 生效,用 waitFor 等选中应用(否则慢环境会抢先断言)。
    await screen.findByTestId("requirement-row-specs/old.md");
    await waitFor(() => {
      expect(
        screen.getByTestId("requirement-row-specs/old.md"),
      ).toHaveAttribute("data-selected", "true");
    });

    // 切到「修复」:原选中(old)不在新列表 → 回落未选中,详情空态,不自动选 fix。
    fireEvent.click(screen.getByTestId("requirement-kind-tab-fix"));
    await waitFor(() => {
      expect(
        screen.getByTestId("requirement-detail-empty"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("requirement-row-specs/fix.md"),
    ).not.toHaveAttribute("data-selected");
    expect(
      screen.queryByTestId("requirement-kind-empty"),
    ).not.toBeInTheDocument();

    // 手动选中 fix 后再切回「需求」:同样回落,不自动跳选。
    fireEvent.click(screen.getByTestId("requirement-row-specs/fix.md"));
    expect(screen.getByTestId("requirement-row-specs/fix.md")).toHaveAttribute(
      "data-selected",
      "true",
    );
    fireEvent.click(screen.getByTestId("requirement-kind-tab-requirement"));
    expect(
      screen.getByTestId("requirement-row-specs/req.md"),
    ).not.toHaveAttribute("data-selected");
    expect(
      screen.getByTestId("requirement-row-specs/old.md"),
    ).not.toHaveAttribute("data-selected");
    expect(screen.getByTestId("requirement-detail-empty")).toBeInTheDocument();
  });
});

// 停止按钮二次确认(stop-button-needs-confirmation):点击先 window.confirm,
// 确认才发「停止 <id>」广播并刷新任务列表;取消则不发消息、不刷新、不置
// commandSending。requirement-workspace 有两处 onStop 接线 —— 需求详情
// (RequirementDetailPanel)与无需求回退的 TaskPanel —— 两处都必须走确认(R6)。
const STOP_MEMBER: Member = {
  participantId: "participant-1",
  name: "AtomCode",
  device: null,
  roles: ["executor"],
};
// id 长度 ≤ 8,确认文案里的短号即全 id(截断行为由 stopTaskIdentifier
// 单测用真实 36 位 id 覆盖)。
const STOPPED_TASKS = [
  makeTask({
    id: "stop-1",
    specRef: null,
    status: "running",
    brief: "# 停止确认票",
  }),
];
// 带 specRef → 聚合为需求 → 详情接线(RequirementDetailPanel)。
const DETAIL_TASKS = [
  makeTask({
    id: "detail-1",
    specRef: "specs/stop.md",
    status: "running",
    brief: "# 停止确认票",
  }),
];

describe("RequirementWorkspace 停止二次确认(stop-button-needs-confirmation)", () => {
  it("无需求回退 TaskPanel:确认后发送「停止 <id>」广播并刷新任务列表", async () => {
    setViewport(1280);
    const fetchMock = workspaceFetchMock(STOPPED_TASKS, undefined, [
      STOP_MEMBER,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(window.confirm).mockReturnValue(true);
    renderWithProviders(<RequirementWorkspace groupId="group-1" />);

    const stopCountBefore = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/tasks"),
    ).length;
    fireEvent.click(await screen.findByTestId("task-stop-stop-1"));

    // R2/R3:confirm 收到带任务标识、状态与后果的插值文案。
    expect(vi.mocked(window.confirm)).toHaveBeenCalledWith(
      expect.stringContaining("停止任务 停止确认票(stop-1)"),
    );
    expect(vi.mocked(window.confirm).mock.calls[0][0]).toContain(
      "当前状态:执行中",
    );
    expect(vi.mocked(window.confirm).mock.calls[0][0]).toContain(
      "已产出的改动不会自动回滚",
    );
    // R1 确认路径:发出「停止 <id>」广播,并重拉任务列表。
    expect(
      fetchMock.mock.calls.find(
        ([, init]) =>
          init?.method === "POST" &&
          JSON.parse(String(init.body)).body === "停止 stop-1",
      ),
    ).toBeDefined();
    // loadTasks 是 POST 之后的异步重拉,等它发生。
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/tasks"))
          .length,
      ).toBeGreaterThan(stopCountBefore),
    );
    // 发送结束后 commandSending 复位 → 按钮不再是「发送中…」。
    await waitFor(() =>
      expect(screen.getByTestId("task-stop-stop-1")).toHaveTextContent("停止"),
    );
  });

  it("无需求回退 TaskPanel:取消确认不发消息、不刷新、不置 commandSending", async () => {
    setViewport(1280);
    const fetchMock = workspaceFetchMock(STOPPED_TASKS, undefined, [
      STOP_MEMBER,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    // beforeEach 已把 confirm 桩设为恒 false(取消)。
    renderWithProviders(<RequirementWorkspace groupId="group-1" />);

    const stopCountBefore = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/tasks"),
    ).length;
    fireEvent.click(await screen.findByTestId("task-stop-stop-1"));

    // 按钮可点 → confirm 被触发(二次确认确实发生)。
    expect(vi.mocked(window.confirm)).toHaveBeenCalledTimes(1);
    // R1 取消路径:无 POST 停止指令、不重拉任务列表。
    expect(
      fetchMock.mock.calls.some(
        ([, init]) =>
          init?.method === "POST" && String(init.body).includes("停止"),
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/tasks"))
        .length,
    ).toBe(stopCountBefore);
    // 按钮保持原样(未进入发送中态)。
    expect(screen.getByTestId("task-stop-stop-1")).toHaveTextContent("停止");
  });

  it("需求详情接线:确认后发送「停止 <id>」并刷新", async () => {
    setViewport(1280);
    const fetchMock = workspaceFetchMock(DETAIL_TASKS, undefined, [
      STOP_MEMBER,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(window.confirm).mockReturnValue(true);
    renderWithProviders(<RequirementWorkspace groupId="group-1" />);

    const stopCountBefore = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/tasks"),
    ).length;
    // 桌面两栏默认选中唯一需求 → 详情内的停止按钮即需求详情接线。
    fireEvent.click(await screen.findByTestId("task-stop-detail-1"));

    expect(vi.mocked(window.confirm)).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.find(
        ([, init]) =>
          init?.method === "POST" &&
          JSON.parse(String(init.body)).body === "停止 detail-1",
      ),
    ).toBeDefined();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/tasks"))
          .length,
      ).toBeGreaterThan(stopCountBefore),
    );
  });

  it("需求详情接线:取消确认不发消息、不刷新", async () => {
    setViewport(1280);
    const fetchMock = workspaceFetchMock(DETAIL_TASKS, undefined, [
      STOP_MEMBER,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<RequirementWorkspace groupId="group-1" />);

    const stopCountBefore = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/tasks"),
    ).length;
    fireEvent.click(await screen.findByTestId("task-stop-detail-1"));

    expect(vi.mocked(window.confirm)).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(
        ([, init]) =>
          init?.method === "POST" && String(init.body).includes("停止"),
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/tasks"))
        .length,
    ).toBe(stopCountBefore);
  });

  it("queued 任务:确认文案指明将取消而不执行", async () => {
    setViewport(1280);
    const fetchMock = workspaceFetchMock(
      [
        makeTask({
          id: "queued-1",
          specRef: null,
          status: "queued",
          brief: "# 排队票",
        }),
      ],
      undefined,
      [STOP_MEMBER],
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(window.confirm).mockReturnValue(true);
    renderWithProviders(<RequirementWorkspace groupId="group-1" />);

    fireEvent.click(await screen.findByTestId("task-stop-queued-1"));

    expect(vi.mocked(window.confirm).mock.calls[0][0]).toContain("排队中");
    expect(vi.mocked(window.confirm).mock.calls[0][0]).toContain(
      "停止后该任务将取消,不会执行",
    );
  });

  it("归档只读:停止按钮禁用且 ControlButton title 不变,点击不弹确认(R4)", async () => {
    setViewport(1280);
    renderWorkspace(STOPPED_TASKS, undefined, [STOP_MEMBER], {
      status: "archived",
    });

    const button = await screen.findByTestId("task-stop-stop-1");
    // 只读态生效后按钮禁用;title 提示仍由 ControlButton 包裹 span 承载。
    expect(button).toBeDisabled();
    expect(button.parentElement).toHaveAttribute("title", "群已归档,只读");
    // 禁用按钮不触发 onClick → 不弹确认框。
    fireEvent.click(button);
    expect(vi.mocked(window.confirm)).not.toHaveBeenCalled();
  });

  it("stopTaskIdentifier:任务名缺失时退回执行器名 + 短号", () => {
    expect(
      stopTaskIdentifier(
        {
          id: "01a07764-1058-71e0-9a94-f2bd1677fe79",
          brief: null,
          executorParticipantId: "participant-1",
          executorKey: "codex",
        },
        [],
      ),
    ).toBe("codex(01a07764)");
    expect(
      stopTaskIdentifier(
        {
          id: "01a07764-1058-71e0-9a94-f2bd1677fe79",
          brief: "# 停止确认票",
          executorParticipantId: "participant-1",
          executorKey: "codex",
        },
        [],
      ),
    ).toBe("停止确认票(01a07764)");
  });
});

describe("RequirementWorkspace 实时输出与派生块刷新 (task-panel-shows-nothing)", () => {
  const COORDINATOR: Member = {
    participantId: "participant-coordinator",
    name: "协调者",
    device: null,
    roles: ["coordinator"],
  };
  const REVIEWER: Member = {
    participantId: "participant-reviewer",
    name: "检视者",
    device: null,
    roles: ["reviewer"],
  };
  const EXECUTOR: Member = {
    participantId: "participant-1",
    name: "执行者",
    device: null,
    roles: ["executor"],
  };

  it("R2 挂载时对非终态任务用 includeOutput=1 补拉并渲染历史 report", async () => {
    setViewport(1280);
    const running = makeTask({
      id: "run-1",
      status: "running",
      brief: "# 在跑的任务",
      specRef: "specs/live.md",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const fetchMock = createFetchMock([
      {
        match: (url) => url === "/api/health",
        respond: () => jsonResponse({ stale: false }),
      },
      {
        match: (url) => /\/api\/groups\/[^/]+$/.test(String(url)),
        respond: () =>
          jsonResponse({
            id: "group-1",
            title: "g",
            status: "active",
            projectPath: null,
          }),
      },
      {
        match: (url) =>
          url.includes("/api/groups/") && url.endsWith("/messages"),
        respond: () => jsonResponse([]),
      },
      {
        match: (url) =>
          url.includes("/api/groups/") && url.endsWith("/members"),
        respond: () => jsonResponse([EXECUTOR]),
      },
      {
        match: (url) => {
          const s = String(url);
          return s.includes("/tasks?") && s.includes("includeOutput=1");
        },
        respond: () =>
          jsonResponse([
            {
              ...running,
              outputTail: "[汇报 #t1] already produced report\n",
            },
          ]),
      },
      {
        match: (url) => {
          const path = String(url).split("?")[0];
          return path.endsWith("/tasks");
        },
        respond: () => jsonResponse([running]),
      },
      {
        match: (url) =>
          /\/api\/groups\/[^/]+\/tasks\/[^/?]+$/.test(
            String(url).split("?")[0],
          ),
        respond: () =>
          jsonResponse({
            ...running,
            liveness: {
              warning: false,
              lastSignalAt: "2026-08-01T00:05:00.000Z",
            },
          }),
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<RequirementWorkspace groupId="group-1" />);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("includeOutput=1"),
        ),
      ).toBe(true);
    });

    expect(
      await screen.findByText("[汇报 #t1] already produced report"),
    ).toBeInTheDocument();
  });

  it("R2 重连后再次 includeOutput 补拉", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setViewport(1280);
    const running = makeTask({
      id: "run-2",
      status: "running",
      brief: "# reconnect",
      specRef: "specs/re.md",
    });
    let includeCalls = 0;
    const fetchMock = createFetchMock([
      {
        match: (url) => url === "/api/health",
        respond: () => jsonResponse({ stale: false }),
      },
      {
        match: (url) => /\/api\/groups\/[^/]+$/.test(String(url)),
        respond: () =>
          jsonResponse({
            id: "group-1",
            title: "g",
            status: "active",
            projectPath: null,
          }),
      },
      {
        match: (url) =>
          url.includes("/api/groups/") && url.endsWith("/messages"),
        respond: () => jsonResponse([]),
      },
      {
        match: (url) =>
          url.includes("/api/groups/") && url.endsWith("/members"),
        respond: () => jsonResponse([EXECUTOR]),
      },
      {
        match: (url) => String(url).includes("includeOutput=1"),
        respond: () => {
          includeCalls += 1;
          return jsonResponse([
            {
              ...running,
              outputTail:
                includeCalls === 1 ? "first\n" : "first\nafter disconnect\n",
            },
          ]);
        },
      },
      {
        match: (url) => {
          const path = String(url).split("?")[0];
          return path.endsWith("/tasks") && !String(url).includes("?");
        },
        respond: () => jsonResponse([running]),
      },
      {
        match: (url) =>
          /\/api\/groups\/[^/]+\/tasks\/[^/?]+$/.test(
            String(url).split("?")[0],
          ),
        respond: () => jsonResponse(running),
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<RequirementWorkspace groupId="group-1" />);
    await screen.findByText("first");
    expect(includeCalls).toBe(1);

    const ws = MockWebSocket.instances[0];
    act(() => ws.open());
    act(() => ws.close());
    // useGroupWs reconnects with 1s backoff after the first live session.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const latest = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    act(() => latest.open());

    await waitFor(() => {
      expect(includeCalls).toBeGreaterThanOrEqual(2);
    });
    expect(await screen.findByText("after disconnect")).toBeInTheDocument();
  });

  it("R3(a) group_message review_result 后 L3 卡片变为已检视 pass,无需刷新", async () => {
    setViewport(1280);
    const l2 = makeTask({
      id: "l2-task",
      status: "done",
      brief: "协调请求",
      executorParticipantId: COORDINATOR.participantId,
      executorKey: "coordinator",
      specRef: "specs/l3.md",
      diffSummary: {
        review_request: {
          type: "review_request",
          layer: 3,
          specRef: "specs/l3.md",
          specHash: "h1",
          diffSummary: "L2 ok",
        },
      },
      l3: {
        answered: false,
        verdict: null,
        awaitingSince: "2026-08-01T00:00:00.000Z",
        overdue: false,
      },
    });
    const l1 = makeTask({
      id: "l1-task",
      status: "done",
      brief: "# 执行完成",
      parentTaskId: "l2-task",
      specRef: "specs/l3.md",
      diffSummary: { summary: "done" },
    });
    const fetchMock = createFetchMock([
      {
        match: (url) => url === "/api/health",
        respond: () => jsonResponse({ stale: false }),
      },
      {
        match: (url) => /\/api\/groups\/[^/]+$/.test(String(url)),
        respond: () =>
          jsonResponse({
            id: "group-1",
            title: "g",
            status: "active",
            projectPath: null,
          }),
      },
      {
        match: (url) =>
          url.includes("/api/groups/") && url.endsWith("/messages"),
        respond: () => jsonResponse([]),
      },
      {
        match: (url) =>
          url.includes("/api/groups/") && url.endsWith("/members"),
        respond: () => jsonResponse([COORDINATOR, REVIEWER, EXECUTOR]),
      },
      {
        match: (url) => String(url).includes("includeOutput=1"),
        respond: () => jsonResponse([l2, l1]),
      },
      {
        match: (url) => {
          const path = String(url).split("?")[0];
          return path.endsWith("/tasks");
        },
        respond: () => jsonResponse([l2, l1]),
      },
      {
        match: (url) =>
          /\/api\/groups\/[^/]+\/tasks\/[^/?]+$/.test(
            String(url).split("?")[0],
          ),
        respond: (url) => {
          const id = String(url).split("/").pop();
          const row = [l2, l1].find((task) => task.id === id) ?? l2;
          return jsonResponse({
            ...row,
            l3:
              id === "l2-task"
                ? {
                    answered: false,
                    verdict: null,
                    awaitingSince: "2026-08-01T00:00:00.000Z",
                    overdue: false,
                  }
                : undefined,
          });
        },
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<RequirementWorkspace groupId="group-1" />);

    await screen.findByTestId("requirement-layer-l3");
    // Detail pull is async; wait until api l3.awaitingSince lands in the card.
    expect(
      await screen.findByTestId("requirement-l3-waiting"),
    ).toBeInTheDocument();

    act(() => MockWebSocket.instances[0].open());
    act(() =>
      MockWebSocket.instances[0].receive(
        JSON.stringify({
          type: "group_message",
          groupId: "group-1",
          message: {
            id: "msg-review-1",
            groupId: "group-1",
            senderId: REVIEWER.participantId,
            parentId: null,
            audience: "broadcast",
            audienceRef: null,
            body: JSON.stringify({
              type: "review_result",
              layer: 3,
              taskId: "l2-task",
              specRef: "specs/l3.md",
              specHash: "h1",
              verdict: "pass",
              note: "L3 pass",
              findings: [],
            }),
            contentType: "text/plain",
            fileRef: null,
            depth: 0,
            createdAt: "2026-08-01T12:00:00.000Z",
          },
        }),
      ),
    );

    await waitFor(() => {
      expect(
        screen.queryByTestId("requirement-l3-waiting"),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("requirement-layer-l3")).toHaveTextContent(
        "检视通过",
      );
    });
  });

  it("R4 includeOutput 失败时显示拉取失败而非无输出", async () => {
    setViewport(1280);
    const running = makeTask({
      id: "run-err",
      status: "running",
      brief: "# 失败可见",
      specRef: "specs/err.md",
    });
    const fetchMock = createFetchMock([
      {
        match: (url) => url === "/api/health",
        respond: () => jsonResponse({ stale: false }),
      },
      {
        match: (url) => /\/api\/groups\/[^/]+$/.test(String(url)),
        respond: () =>
          jsonResponse({
            id: "group-1",
            title: "g",
            status: "active",
            projectPath: null,
          }),
      },
      {
        match: (url) =>
          url.includes("/api/groups/") && url.endsWith("/messages"),
        respond: () => jsonResponse([]),
      },
      {
        match: (url) =>
          url.includes("/api/groups/") && url.endsWith("/members"),
        respond: () => jsonResponse([EXECUTOR]),
      },
      {
        match: (url) => String(url).includes("includeOutput=1"),
        respond: () => jsonResponse({ message: "boom" }, 500),
      },
      {
        match: (url) => {
          const path = String(url).split("?")[0];
          return path.endsWith("/tasks");
        },
        respond: () => jsonResponse([running]),
      },
      {
        match: (url) =>
          /\/api\/groups\/[^/]+\/tasks\/[^/?]+$/.test(
            String(url).split("?")[0],
          ),
        respond: () => jsonResponse(running),
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<RequirementWorkspace groupId="group-1" />);

    expect(
      await screen.findByTestId("requirement-timeline-output-error-run-err"),
    ).toHaveTextContent("拉取实时输出失败");
    expect(screen.queryByText("暂无输出")).not.toBeInTheDocument();
  });
});
