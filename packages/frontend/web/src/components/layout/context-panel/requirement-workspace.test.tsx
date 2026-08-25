import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";
import {
  createFetchMock,
  jsonResponse,
  renderWithProviders,
} from "@/test/utils";
import { MockWebSocket } from "@/test/ws-mock";
import { RequirementWorkspace } from "./requirement-workspace";

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
          status: "active",
          projectPath: null,
        }),
    },
    {
      match: (url) => url.includes("/api/groups/") && url.endsWith("/messages"),
      respond: () => jsonResponse([]),
    },
    {
      match: (url) => url.includes("/api/groups/") && url.endsWith("/members"),
      respond: () => jsonResponse([]),
    },
    {
      match: (url) => url.includes("/api/groups/") && url.endsWith("/tasks"),
      respond: () => jsonResponse(tasks),
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
) {
  vi.stubGlobal("fetch", workspaceFetchMock(tasks, health));
  return renderWithProviders(<RequirementWorkspace groupId="group-1" />);
}

const TWO_REQUIREMENTS = [
  makeTask({ id: "task-a", specRef: "specs/a.md", brief: "# 需求A" }),
  makeTask({ id: "task-b", specRef: "specs/b.md", brief: "# 需求B" }),
];

beforeEach(() => {
  MockWebSocket.reset();
  vi.stubGlobal("WebSocket", MockWebSocket);
  // 清掉可能残留的身份绑定,保证 canControl 判定确定性;setup.ts 写入的语言
  // 会被清掉,需补回(否则 t() 回落 en-US 导致中文断言失配)。
  localStorage.clear();
  localStorage.setItem("coagenthub.lang", "zh");
});

afterEach(() => {
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
