import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PARTICIPANT_ID_KEY } from "@/lib/api-client";
import {
  createFetchMock,
  jsonResponse,
  renderWithProviders,
} from "@/test/utils";
import GroupsPage from "./index";
import GroupMembersPage from "./members";

const GROUPS = [
  {
    id: "group-1",
    title: "模型训练任务",
    status: "active",
    memberCount: 2,
    createdAt: "2026-08-01T00:00:00.000Z",
  },
  {
    id: "group-2",
    title: "已完成的评审",
    status: "archived",
    memberCount: 3,
    createdAt: "2026-08-02T00:00:00.000Z",
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
    roles: ["reviewer", "executor"],
    joinedAt: "2026-08-01T00:01:00.000Z",
  },
];

const PARTICIPANTS = [
  {
    id: "participant-1",
    name: "hermes-mac",
    device: "mac-mini",
  },
  { id: "participant-9", name: "atomcode-cli", device: null },
];

function groupsFetchMock(groups: unknown[] = GROUPS, registerError?: number) {
  // Stateful list: a successful POST create appends, archive flips status.
  // The list handler also honors ?status= so tab filtering can be asserted.
  let current = [...groups] as Array<Record<string, unknown>>;
  // Ticket 29: 状态化 participant 名册 — 注册会追加,供身份面板「使用中」标记断言。
  const roster: Array<Record<string, unknown>> = [...PARTICIPANTS];
  return createFetchMock([
    {
      // Ticket 28: participant 注册(POST /api/participants,公开端点)返回 id,
      // 不含 token(全信模型,注册即切换身份)。
      // 必须排在下面的通用 /api/participants 匹配之前(createFetchMock 首个匹配生效)。
      match: (url, init) =>
        init?.method === "POST" && String(url).endsWith("/api/participants"),
      respond: (_url, init) => {
        if (registerError) {
          return jsonResponse({ message: "名称已存在" }, registerError);
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const created = {
          id: "participant-new",
          name: body.name,
          device: body.device ?? null,
          webhookUrl: null,
          capabilities: [],
          createdAt: "2026-08-11T00:00:00.000Z",
        };
        roster.push(created);
        return jsonResponse(created);
      },
    },
    {
      // The list URL carries ?status=active|archived (tab filter), ?q=
      // (title search), and ?limit=&offset= (pagination); strip the query
      // before matching so bare, filtered, searched, and paginated fetches
      // all hit this handler. Response shape is { items, total }.
      match: (url) => String(url).split("?")[0].endsWith("/api/groups"),
      respond: (url, init) => {
        if ((init?.method ?? "GET") === "POST") {
          return jsonResponse({
            id: "group-9",
            title: "新任务",
            status: "active",
            memberCount: 1,
          });
        }
        const params = new URLSearchParams(String(url).split("?")[1] ?? "");
        const status = params.get("status");
        const q = params.get("q");
        let filtered = status
          ? current.filter((g) => g.status === status)
          : current;
        if (q) {
          filtered = filtered.filter((g) => String(g.title).includes(q));
        }
        // 分页:limit 缺省视为全量,offset 缺省为 0,响应 {items,total}。
        const limit = Number(params.get("limit") ?? filtered.length);
        const offset = Number(params.get("offset") ?? 0);
        return jsonResponse({
          items: filtered.slice(offset, offset + limit),
          total: filtered.length,
        });
      },
    },
    {
      match: (url, init) =>
        init?.method === "POST" && String(url).endsWith("/archive"),
      respond: (url) => {
        const id = String(url).split("/").at(-2);
        current = current.map((g) =>
          g.id === id ? { ...g, status: "archived" } : g,
        );
        return jsonResponse({ success: true });
      },
    },
    {
      match: (url, init) =>
        init?.method === "POST" && String(url).endsWith("/unarchive"),
      respond: (url) => {
        const id = String(url).split("/").at(-2);
        current = current.map((g) =>
          g.id === id ? { ...g, status: "active" } : g,
        );
        return jsonResponse({ success: true });
      },
    },
    {
      // Soft delete (ticket 20): removes the group from the list entirely.
      match: (url, init) =>
        init?.method === "DELETE" && /^\/api\/groups\/[^/]+$/.test(String(url)),
      respond: (url) => {
        const id = String(url).split("/").pop();
        current = current.filter((g) => g.id !== id);
        return jsonResponse({ success: true });
      },
    },
    {
      // 群名行内改名(网页体验批次):PATCH /api/groups/:id { title }。
      match: (url, init) =>
        init?.method === "PATCH" && /^\/api\/groups\/[^/]+$/.test(String(url)),
      respond: (url, init) => {
        const id = String(url).split("/").pop();
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        current = current.map((g) => (g.id === id ? { ...g, ...patch } : g));
        const updated = current.find((g) => g.id === id) ?? {
          ...GROUPS[0],
          ...patch,
        };
        return jsonResponse(updated);
      },
    },
    {
      // Participant roster (ticket 20 settings + ticket 29 identity panel):
      // 状态化名册,注册会追加新 participant。
      match: (url) => url.endsWith("/api/participants"),
      respond: () => jsonResponse(roster),
    },
    {
      match: (url, init) =>
        init?.method === "PATCH" && String(url).includes("/api/participants/"),
      respond: (url, init) => {
        const id = String(url).split("/").pop();
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const base = PARTICIPANTS.find((a) => a.id === id) ?? PARTICIPANTS[0];
        return jsonResponse({ ...base, ...patch });
      },
    },
  ]);
}

function membersFetchMock(
  members: unknown[] = MEMBERS,
  participants: unknown[] = PARTICIPANTS,
) {
  // Stateful roster: DELETE removes a member, PATCH updates roles, so the
  // list refresh after each action can be asserted against the DOM.
  let current = [...members] as Array<Record<string, unknown>>;
  return createFetchMock([
    {
      // Group detail: the creator (createdBy) drives the remove-button guard.
      match: (url) => String(url) === "/api/groups/group-1",
      respond: () =>
        jsonResponse({
          id: "group-1",
          title: "模型训练任务",
          status: "active",
          createdBy: "participant-1",
        }),
    },
    {
      match: (url) => url.endsWith("/api/participants"),
      respond: () => jsonResponse(participants),
    },
    {
      match: (url) => url.includes("/api/groups/") && url.endsWith("/members"),
      respond: (_url, init) => {
        if ((init?.method ?? "GET") === "POST") {
          return jsonResponse({
            participantId: "participant-9",
            roles: ["observer"],
          });
        }
        return jsonResponse(current);
      },
    },
    {
      match: (url, init) =>
        init?.method === "PATCH" && String(url).includes("/members/"),
      respond: (url, init) => {
        const participantId = String(url).split("/").pop();
        const { roles } = JSON.parse(String(init?.body)) as { roles: string[] };
        current = current.map((m) =>
          m.participantId === participantId ? { ...m, roles } : m,
        );
        return jsonResponse({ participantId, roles });
      },
    },
    {
      match: (url, init) =>
        init?.method === "DELETE" && String(url).includes("/members/"),
      respond: (url) => {
        const participantId = String(url).split("/").pop();
        current = current.filter((m) => m.participantId !== participantId);
        return jsonResponse({ success: true });
      },
    },
  ]);
}

function stubFetch(mock: ReturnType<typeof createFetchMock>) {
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GroupsPage 群组列表", () => {
  it("渲染全部群组(title/status/成员数)", async () => {
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    // Titles appear in both the mobile cards and the desktop table.
    expect((await screen.findAllByText("模型训练任务")).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText("已完成的评审").length).toBeGreaterThan(0);
    // Status badges
    expect(screen.getAllByText("进行中").length).toBeGreaterThan(0);
    expect(screen.getAllByText("已归档").length).toBeGreaterThan(0);
    // Member counts (mobile cards)
    expect(screen.getAllByText(/2 名成员|3 名成员/)).not.toHaveLength(0);
  });

  it("无群组时显示空态(图标 + 引导文案)", async () => {
    stubFetch(groupsFetchMock([]));
    renderWithProviders(<GroupsPage />, "/groups");

    const empty = await screen.findByText(
      "暂无群组,输入任务名点击「创建群组」开始",
    );
    // 居中图标 + 引导文案。
    expect(empty.closest("div")?.querySelector("svg")).not.toBeNull();
  });

  it("归档 tab 无群组时显示「暂无已归档群组」", async () => {
    stubFetch(groupsFetchMock([]));
    renderWithProviders(<GroupsPage />, "/groups");

    fireEvent.click(await screen.findByRole("button", { name: "已归档" }));

    expect(await screen.findByText("暂无已归档群组")).toBeInTheDocument();
  });

  it("进行中 tab 无群组时显示「暂无进行中的群组」", async () => {
    stubFetch(groupsFetchMock([]));
    renderWithProviders(<GroupsPage />, "/groups");

    fireEvent.click(await screen.findByRole("button", { name: "进行中" }));

    expect(await screen.findByText("暂无进行中的群组")).toBeInTheDocument();
  });

  it("已归档群组不显示归档按钮", async () => {
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findAllByText("模型训练任务");
    // Desktop table rows carry the archive action; archived group has none.
    const archiveButtons = screen.getAllByRole("button", { name: /归档/ });
    expect(archiveButtons.length).toBeGreaterThan(0);
    const archivedRow = archiveButtons.filter((b) =>
      b.closest("tr, div")?.textContent?.includes("已完成的评审"),
    );
    expect(archivedRow.length).toBe(0);
  });

  it("群名行内改名:铅笔图标 → 输入新名 → PATCH /api/groups/:id {title} → 列表刷新", async () => {
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findAllByText("模型训练任务");
    // 铅笔图标在移动卡片与桌面表格各一个(jsdom 不做媒体查询,两者都在 DOM)。
    const pencil = screen.getAllByTestId("rename-title-group-1")[0];
    fireEvent.click(pencil);

    const inputs = await screen.findAllByLabelText("新群组名称");
    expect(inputs.length).toBeGreaterThan(0);
    fireEvent.change(inputs[0], { target: { value: "改名后的群" } });
    fireEvent.click(screen.getAllByRole("button", { name: "保存名称" })[0]);

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === "PATCH" && String(url) === "/api/groups/group-1",
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(String(patch![1]?.body))).toEqual({
        title: "改名后的群",
      });
    });
    // 刷新后新名字出现(移动卡片 + 桌面表格各一处),编辑态关闭。
    expect((await screen.findAllByText("改名后的群")).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByLabelText("新群组名称")).toBeNull();
  });
});

describe("GroupsPage 建群与归档", () => {
  it("输入任务名点击「创建群组」调用 POST /api/groups", async () => {
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    const input = await screen.findByLabelText("群组名称");
    fireEvent.change(input, { target: { value: "新任务" } });
    fireEvent.click(screen.getByRole("button", { name: "创建群组" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === "POST" && String(url).endsWith("/api/groups"),
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body)).title).toBe("新任务");
    });
  });

  it("点击归档弹 confirm,确认后调用 POST /:id/archive 且列表刷新", async () => {
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findAllByText("模型训练任务");
    // Exact-name match "归档" — the "已归档" filter tab is not an action.
    fireEvent.click(screen.getAllByRole("button", { name: "归档" })[0]);

    expect(confirmMock).toHaveBeenCalledWith(
      "确定归档群组「模型训练任务」吗?归档后可随时恢复。",
    );
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === "POST" && String(url).includes("/archive"),
      );
      expect(call).toBeDefined();
      expect(String(call![0])).toContain("/api/groups/group-1/archive");
    });
  });
});

describe("GroupsPage 状态 tab 与恢复 (ticket 16)", () => {
  it("默认「全部」tab 不带 status 参数,切到「已归档」发起 ?status=archived", async () => {
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findAllByText("模型训练任务");
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url) === "/api/groups?limit=20&offset=0",
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "已归档" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url]) =>
          String(url) === "/api/groups?status=archived&limit=20&offset=0",
      );
      expect(call).toBeDefined();
    });

    // The filtered list reflects the server response (archived only).
    expect((await screen.findAllByText("已完成的评审")).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryAllByText("模型训练任务")).toHaveLength(0);
  });

  it("「进行中」tab 发起 ?status=active", async () => {
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findAllByText("模型训练任务");
    fireEvent.click(screen.getByRole("button", { name: "进行中" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url]) =>
          String(url) === "/api/groups?status=active&limit=20&offset=0",
      );
      expect(call).toBeDefined();
    });
  });

  it("已归档卡片显示「恢复」按钮,点击调用 POST /:id/unarchive", async () => {
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    // The restore action appears in the mobile card AND the desktop row.
    const restoreButtons = await screen.findAllByRole("button", {
      name: /恢复/,
    });
    expect(restoreButtons.length).toBeGreaterThan(0);

    fireEvent.click(restoreButtons[0]);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === "POST" && String(url).endsWith("/unarchive"),
      );
      expect(call).toBeDefined();
      expect(String(call![0])).toContain("/api/groups/group-2/unarchive");
    });
  });

  it("归档按钮仅 active 卡片显示,已归档卡片没有归档按钮", async () => {
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findAllByText("模型训练任务");
    const archiveButtons = screen.getAllByRole("button", { name: /归档/ });
    expect(archiveButtons.length).toBeGreaterThan(0);
    const archivedRow = archiveButtons.filter((b) =>
      b.closest("tr, div")?.textContent?.includes("已完成的评审"),
    );
    expect(archivedRow.length).toBe(0);
  });
});

describe("GroupsPage 群列表搜索 (enhancement)", () => {
  it("输入关键词防抖 300ms 后发起 ?q= 拉取,仅显示匹配结果", async () => {
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findAllByText("模型训练任务");

    const searchInput = screen.getByLabelText("搜索群组");
    fireEvent.change(searchInput, { target: { value: "模型" } });

    // 防抖 300ms:输入后不应立即发起请求,停顿后才发。
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url]) =>
          String(url) === "/api/groups?q=%E6%A8%A1%E5%9E%8B&limit=20&offset=0",
      );
      expect(call).toBeDefined();
    });

    // 列表只显示标题含关键词的群,另一条被过滤。
    expect((await screen.findAllByText("模型训练任务")).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryAllByText("已完成的评审")).toHaveLength(0);
    // 结果数提示。
    expect(
      await screen.findByText("找到 1 个匹配「模型」的群组"),
    ).toBeInTheDocument();
  });

  it("清除按钮清空输入并恢复全量列表", async () => {
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findAllByText("模型训练任务");
    fireEvent.change(screen.getByLabelText("搜索群组"), {
      target: { value: "模型" },
    });
    await screen.findByText("找到 1 个匹配「模型」的群组");

    fireEvent.click(screen.getByLabelText("清除搜索"));

    // 清空后重新拉全量(无 ?q=):初始加载 + 清空后的裸请求,至少两次。
    await waitFor(() => {
      const bareCalls = fetchMock.mock.calls.filter(
        ([url]) => String(url) === "/api/groups?limit=20&offset=0",
      );
      expect(bareCalls.length).toBeGreaterThanOrEqual(2);
    });
    expect((await screen.findAllByText("已完成的评审")).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText(/找到 \d+ 个匹配/)).toBeNull();
  });

  it("搜索无结果显示「未找到匹配的群组」", async () => {
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findAllByText("模型训练任务");
    fireEvent.change(screen.getByLabelText("搜索群组"), {
      target: { value: "不存在的群组" },
    });

    expect(await screen.findByText("未找到匹配的群组")).toBeInTheDocument();
  });

  it("搜索与状态 tab 可组合(?status= 与 ?q= 同时携带)", async () => {
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findAllByText("模型训练任务");
    fireEvent.click(screen.getByRole("button", { name: "已归档" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            String(url) === "/api/groups?status=archived&limit=20&offset=0",
        ),
      ).toBe(true);
    });

    fireEvent.change(screen.getByLabelText("搜索群组"), {
      target: { value: "评审" },
    });

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url]) =>
          String(url) ===
          "/api/groups?status=archived&q=%E8%AF%84%E5%AE%A1&limit=20&offset=0",
      );
      expect(call).toBeDefined();
    });
    expect((await screen.findAllByText("已完成的评审")).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryAllByText("模型训练任务")).toHaveLength(0);
  });
});

describe("GroupsPage 群列表分页", () => {
  // 25 个群:超过一页(20),用于断言分页行为。
  const PAGED_GROUPS = Array.from({ length: 25 }, (_, i) => ({
    id: `group-${i + 1}`,
    title: `分页群组 ${i + 1}`,
    status: "active",
    memberCount: 1,
    createdAt: `2026-08-0${(i % 9) + 1}T00:00:00.000Z`,
  }));

  it("初始加载取 20 条(?limit=20&offset=0),有更多时显示「加载更多」", async () => {
    const fetchMock = stubFetch(groupsFetchMock(PAGED_GROUPS));
    renderWithProviders(<GroupsPage />, "/groups");

    // 第一页 20 条可见(移动卡片 + 桌面表格各渲染一次),第 21 条不可见。
    expect(await screen.findAllByText("分页群组 1")).not.toHaveLength(0);
    expect(screen.queryByText("分页群组 21")).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url) === "/api/groups?limit=20&offset=0",
      ),
    ).toBe(true);
    // 25 > 20 → 还有更多,显示按钮。
    expect(
      screen.getByRole("button", { name: "加载更多" }),
    ).toBeInTheDocument();
  });

  it("点击「加载更多」按 offset+=limit 追加,无更多后按钮消失", async () => {
    const fetchMock = stubFetch(groupsFetchMock(PAGED_GROUPS));
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findAllByText("分页群组 1");
    expect(screen.queryByText("分页群组 21")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));

    // 追加请求携带 offset=20,第 21-25 条出现。
    await screen.findAllByText("分页群组 25");
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url) === "/api/groups?limit=20&offset=20",
      ),
    ).toBe(true);
    // 25 == total,没有更多 → 按钮消失。
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  });

  it("全部数据不足一页时不显示「加载更多」", async () => {
    stubFetch(groupsFetchMock(GROUPS)); // 仅 2 个群
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findAllByText("模型训练任务");
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  });

  it("切换状态 tab 重置到第一页(offset 归零)", async () => {
    const fetchMock = stubFetch(groupsFetchMock(PAGED_GROUPS));
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findAllByText("分页群组 1");
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await screen.findAllByText("分页群组 25");

    // 切到「已归档」(该 mock 无已归档群 → 空态),重新发起 offset=0 的请求。
    fireEvent.click(screen.getByRole("button", { name: "已归档" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            String(url) === "/api/groups?status=archived&limit=20&offset=0",
        ),
      ).toBe(true);
    });
    expect(await screen.findByText("暂无已归档群组")).toBeInTheDocument();
  });

  it("搜索变化重置到第一页(带 ?q= 且 offset=0)", async () => {
    const fetchMock = stubFetch(groupsFetchMock(PAGED_GROUPS));
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findAllByText("分页群组 1");
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await screen.findAllByText("分页群组 25");

    fireEvent.change(screen.getByLabelText("搜索群组"), {
      target: { value: "分页群组 1" },
    });
    // 防抖后重新拉取:?q= 携带且 offset 归零(重置第一页)。
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => {
        const u = String(url);
        return (
          u.includes("?q=") && u.includes("limit=20") && u.includes("offset=0")
        );
      });
      expect(call).toBeDefined();
    });
  });
});

describe("GroupsPage participant 绑定 (ticket 18)", () => {
  it("手动输入 participant id 即绑定:写入 localStorage", async () => {
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    const idInput = await screen.findByLabelText("参与方 ID");
    fireEvent.change(idInput, { target: { value: "participant-1" } });
    fireEvent.click(screen.getByRole("button", { name: "绑定" }));

    await waitFor(() => {
      expect(localStorage.getItem(PARTICIPANT_ID_KEY)).toBe("participant-1");
    });
  });

  it("清除身份时同步清除 coagenthub.participantId", async () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-1");
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    fireEvent.click(await screen.findByRole("button", { name: "清除" }));

    await waitFor(() => {
      expect(localStorage.getItem(PARTICIPANT_ID_KEY)).toBeNull();
    });
  });
});

describe("GroupsPage 身份面板 (ticket 29)", () => {
  it("渲染已有参与方列表:名字 + 类型/设备小字 + 总数", async () => {
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    expect(await screen.findByText("已有参与方")).toBeInTheDocument();
    // 名册两行:hermes-mac(mac-mini)、atomcode-cli(无设备)。
    expect(screen.getByText("hermes-mac")).toBeInTheDocument();
    expect(screen.getByText("mac-mini")).toBeInTheDocument();
    expect(screen.getByText("atomcode-cli")).toBeInTheDocument();
    expect(screen.getByText("共 2 个")).toBeInTheDocument();
    // 未绑定时两行都有「使用」按钮,无「使用中」标记。
    expect(screen.getAllByRole("button", { name: "使用" }).length).toBe(2);
    expect(screen.queryByText("使用中")).toBeNull();
  });

  it("点「使用」即绑定该 participant(声明身份,无服务端调用),提示已切换", async () => {
    localStorage.removeItem(PARTICIPANT_ID_KEY);
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    // 点第二行(atomcode-cli)的使用。
    const bindButtons = await screen.findAllByRole("button", { name: "使用" });
    const atomcodeRow = bindButtons.find((b) =>
      b.closest("li")?.textContent?.includes("atomcode-cli"),
    )!;
    fireEvent.click(atomcodeRow);

    // 绑定 = 本地声明,不应发起任何 HTTP 请求。
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === "POST"),
      ).toBe(false);
    });
    // commitIdentity 写入 localStorage + 提示已切换 + 该行变「使用中」。
    await waitFor(() => {
      expect(localStorage.getItem(PARTICIPANT_ID_KEY)).toBe("participant-9");
    });
    expect(
      await screen.findByText("已切换为 atomcode-cli"),
    ).toBeInTheDocument();
    expect(screen.getByText("使用中: atomcode-cli")).toBeInTheDocument();
    // 列表刷新后 hermes-mac 仍是「使用」,atomcode-cli 变「使用中」。
    await waitFor(() => {
      expect(screen.getByText("使用中")).toBeInTheDocument();
      const remainingBind = screen.getAllByRole("button", { name: "使用" });
      expect(remainingBind.length).toBe(1);
      expect(remainingBind[0].closest("li")?.textContent).toContain(
        "hermes-mac",
      );
    });
  });

  it("已绑定的 participant 显示「使用中」标记,绑定按钮不可用", async () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-1");
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findByText("已有参与方");
    // 当前身份突出显示 + 该行「使用中」。
    expect(
      screen.getByText("使用中: hermes-mac(mac-mini)"),
    ).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    const boundRow = rows.find((r) => r.textContent?.includes("hermes-mac"))!;
    expect(within(boundRow).getByText("使用中")).toBeInTheDocument();
    expect(within(boundRow).queryByRole("button", { name: "使用" })).toBeNull();
    // 其余行仍是「使用」。
    const otherRow = rows.find((r) => r.textContent?.includes("atomcode-cli"))!;
    expect(
      within(otherRow).getByRole("button", { name: "使用" }),
    ).toBeInTheDocument();
  });

  it("清除后回到未绑定提示,列表刷新全部恢复「使用」", async () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-1");
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findByText("使用中: hermes-mac(mac-mini)");
    fireEvent.click(screen.getByRole("button", { name: "清除" }));

    await waitFor(() => {
      expect(localStorage.getItem(PARTICIPANT_ID_KEY)).toBeNull();
    });
    expect(
      await screen.findByText(/未绑定参与方,从下方列表选择/),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("使用中")).toBeNull();
      expect(screen.getAllByRole("button", { name: "使用" }).length).toBe(2);
    });
  });
});

describe("GroupsPage 注册新参与方 (ticket 28)", () => {
  const openRegister = async () => {
    fireEvent.click(
      await screen.findByRole("button", { name: /注册新参与方/ }),
    );
  };

  it("展开注册区显示表单,提交按钮存在", async () => {
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await openRegister();
    expect(screen.getByLabelText("注册参与方名称")).toBeInTheDocument();
    expect(screen.getByLabelText("注册参与方设备")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "注册并绑定" }),
    ).toBeInTheDocument();
  });

  it("填写表单提交调用 POST /api/participants 且携带 name/device", async () => {
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await openRegister();
    fireEvent.change(screen.getByLabelText("注册参与方名称"), {
      target: { value: "我的 Mac" },
    });
    fireEvent.change(screen.getByLabelText("注册参与方设备"), {
      target: { value: "mac" },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册并绑定" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === "POST" && String(url).endsWith("/api/participants"),
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        name: "我的 Mac",
        device: "mac",
      });
    });
  });

  it("注册成功:写入 localStorage、绑定横幅出现、当前身份更新", async () => {
    localStorage.removeItem(PARTICIPANT_ID_KEY);
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await openRegister();
    fireEvent.change(screen.getByLabelText("注册参与方名称"), {
      target: { value: "alice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册并绑定" }));

    await waitFor(() => {
      expect(localStorage.getItem(PARTICIPANT_ID_KEY)).toBe("participant-new");
    });
    // 身份面板显示当前身份(注册即切换),无一次性 token 展示。
    expect(await screen.findByText("使用中: alice")).toBeInTheDocument();
    expect(screen.getByText("✅ 已注册并绑定 alice")).toBeInTheDocument();
    expect(screen.queryByLabelText("注册返回的 Participant Token")).toBeNull();
  });

  it("注册失败显示错误信息且不写入 localStorage", async () => {
    localStorage.removeItem(PARTICIPANT_ID_KEY);
    stubFetch(groupsFetchMock([], 400));
    renderWithProviders(<GroupsPage />, "/groups");

    await openRegister();
    fireEvent.change(screen.getByLabelText("注册参与方名称"), {
      target: { value: "alice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册并绑定" }));

    expect(await screen.findByText(/注册失败:/)).toBeInTheDocument();
    expect(screen.getByText(/名称已存在/)).toBeInTheDocument();
    expect(localStorage.getItem(PARTICIPANT_ID_KEY)).toBeNull();
    expect(screen.queryByText(/使用中:/)).toBeNull();
  });

  it("名称为空时提示且不发起注册请求", async () => {
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await openRegister();
    fireEvent.click(screen.getByRole("button", { name: "注册并绑定" }));

    expect(screen.getByText("参与方名称不能为空")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          init?.method === "POST" && String(url).endsWith("/api/participants"),
      ),
    ).toBe(false);
  });

  it("device 为空则省略(载荷不含 type)", async () => {
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await openRegister();
    fireEvent.change(screen.getByLabelText("注册参与方名称"), {
      target: { value: "cli-participant" },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册并绑定" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === "POST" && String(url).endsWith("/api/participants"),
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        name: "cli-participant",
      });
    });
  });
});

describe("GroupsPage 删除群组按钮 (ticket 24)", () => {
  it("active 和 archived 群组都显示删除按钮", async () => {
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findAllByText("模型训练任务");
    const rows = screen.getAllByRole("row");
    const activeRow = rows.find((r) =>
      r.textContent?.includes("模型训练任务"),
    )!;
    expect(
      within(activeRow).getByRole("button", { name: /删除/ }),
    ).toBeInTheDocument();
    const archivedRow = rows.find((r) =>
      r.textContent?.includes("已完成的评审"),
    )!;
    expect(
      within(archivedRow).getByRole("button", { name: /删除/ }),
    ).toBeInTheDocument();
  });

  it("archived 群组删除:confirm 原文案,确认后调用 DELETE 且列表刷新", async () => {
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findAllByText("已完成的评审");
    const archivedRow = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("已完成的评审"))!;
    fireEvent.click(within(archivedRow).getByRole("button", { name: "删除" }));

    expect(confirmMock).toHaveBeenCalledWith(
      "确定删除群组「已完成的评审」吗?删除后不可恢复(数据保留,仅从列表移除)。",
    );
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, init]) => init?.method === "DELETE",
      );
      expect(call).toBeDefined();
      expect(String(call![0])).toBe("/api/groups/group-2");
    });
    // 删除后列表刷新,该群从所有 tab 消失(后端已过滤 deleted)。
    await waitFor(() => {
      expect(screen.queryAllByText("已完成的评审")).toHaveLength(0);
    });
  });

  it("active 群组删除:confirm 用醒目的 active 文案,确认后调用 DELETE 且列表刷新", async () => {
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findAllByText("模型训练任务");
    const activeRow = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("模型训练任务"))!;
    fireEvent.click(within(activeRow).getByRole("button", { name: "删除" }));

    expect(confirmMock).toHaveBeenCalledWith(
      "确定删除进行中的群组「模型训练任务」吗?删除后不可恢复(数据保留,仅从列表移除),群内消息与成员关系都将被移除。建议先归档。",
    );
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, init]) => init?.method === "DELETE",
      );
      expect(call).toBeDefined();
      expect(String(call![0])).toBe("/api/groups/group-1");
    });
    // 删除后列表刷新,该群从所有 tab 消失(后端已过滤 deleted)。
    await waitFor(() => {
      expect(screen.queryAllByText("模型训练任务")).toHaveLength(0);
    });
  });

  it("删除前取消 confirm 不发起 DELETE 请求", async () => {
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmMock);
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findAllByText("模型训练任务");
    const activeRow = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("模型训练任务"))!;
    fireEvent.click(within(activeRow).getByRole("button", { name: "删除" }));
    expect(confirmMock).toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
  });
});

describe("GroupsPage 参与方设置 (ticket 20)", () => {
  it("绑定后显示设置区,保存调用 PATCH /api/participants/:id", async () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "tok-20");
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-1");
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    // 设置区在绑定 + 拉取到自己信息后出现;展示 name/device(只读)。
    const settingsButton = await screen.findByRole("button", {
      name: /参与方设置/,
    });
    fireEvent.click(settingsButton);
    expect(screen.getByText(/名称:hermes-mac/)).toBeInTheDocument();

    // 修改名称并保存;device 沿用当前值。
    const nameInput = screen.getByLabelText("参与方名称") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "hermes-mac-2" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === "PATCH" &&
          String(url).includes("/api/participants/"),
      );
      expect(call).toBeDefined();
      expect(String(call![0])).toBe("/api/participants/participant-1");
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        name: "hermes-mac-2",
        device: "mac-mini",
      });
    });
  });
});

describe("GroupMembersPage 成员管理", () => {
  it("渲染成员(名/类型/设备/角色)", async () => {
    stubFetch(membersFetchMock());
    renderWithProviders(<GroupMembersPage />, "/groups/group-1/members");

    // Member names appear in both the mobile cards and the desktop table.
    expect((await screen.findAllByText("hermes-mac")).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText("win-hermes").length).toBeGreaterThan(0);
    expect(screen.getAllByText("mac-mini").length).toBeGreaterThan(0);
    expect(screen.getAllByText("win-pc").length).toBeGreaterThan(0);
    // Role badges — the same labels also appear as checkbox labels in the
    // add-member form, so assert at least one occurrence exists.
    expect(screen.getAllByText("协调者").length).toBeGreaterThan(0);
    expect(screen.getAllByText("检视者").length).toBeGreaterThan(0);
    expect(screen.getAllByText("执行者").length).toBeGreaterThan(0);
  });

  it("无成员时显示空态", async () => {
    stubFetch(membersFetchMock([]));
    renderWithProviders(<GroupMembersPage />, "/groups/group-1/members");

    expect(
      await screen.findByText("暂无成员,从上方添加 participant 进入群组"),
    ).toBeInTheDocument();
  });

  it("选择 participant 与角色后调用 POST /:id/members", async () => {
    const fetchMock = stubFetch(membersFetchMock());
    renderWithProviders(<GroupMembersPage />, "/groups/group-1/members");

    // Wait for the roster to load and the select to populate.
    const select = (await screen.findByLabelText(
      "选择成员 participant",
    )) as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    await waitFor(() => {
      expect(select.options.length).toBeGreaterThan(1);
    });

    fireEvent.change(select, { target: { value: "participant-9" } });
    // Default observer is pre-checked; also pick reviewer (click the checkbox
    // inside its label — the label text also appears in role badges).
    const reviewerCheckbox = screen
      .getAllByRole("checkbox")
      .find((el) => el.closest("label")?.textContent === "检视者")!;
    fireEvent.click(reviewerCheckbox);
    fireEvent.click(screen.getByRole("button", { name: "添加成员" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === "POST" && String(url).includes("/members"),
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        participantId: "participant-9",
        roles: ["observer", "reviewer"],
      });
    });
  });

  it("已是成员的 participant 不出现在候选下拉中", async () => {
    stubFetch(membersFetchMock());
    renderWithProviders(<GroupMembersPage />, "/groups/group-1/members");

    const select = (await screen.findByLabelText(
      "选择成员 participant",
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(select.options.length).toBeGreaterThan(1);
    });
    const optionTexts = Array.from(select.options).map((o) => o.textContent);
    expect(optionTexts.some((t) => t?.includes("hermes-mac"))).toBe(false);
    expect(optionTexts.some((t) => t?.includes("atomcode-cli"))).toBe(true);
  });

  it("编辑角色:行内表单保存调用 PATCH /:id/members/:participantId 并刷新 (ticket 20)", async () => {
    const fetchMock = stubFetch(membersFetchMock());
    renderWithProviders(<GroupMembersPage />, "/groups/group-1/members");

    await screen.findAllByText("win-hermes");
    const row = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("win-hermes"))!;
    fireEvent.click(within(row).getByRole("button", { name: "编辑角色" }));

    // win-hermes 初始为 [reviewer, executor];编辑表单中取消勾选「检视者」。
    fireEvent.click(within(row).getByLabelText("编辑角色 检视者"));
    fireEvent.click(within(row).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, init]) => init?.method === "PATCH",
      );
      expect(call).toBeDefined();
      expect(String(call![0])).toBe(
        "/api/groups/group-1/members/participant-2",
      );
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        roles: ["executor"],
      });
    });
    // 保存成功后编辑表单关闭。
    await waitFor(() => {
      expect(within(row).queryByRole("button", { name: "取消" })).toBeNull();
    });
  });

  it("移除成员:confirm 后调用 DELETE /:id/members/:participantId 并刷新列表 (ticket 20)", async () => {
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    const fetchMock = stubFetch(membersFetchMock());
    renderWithProviders(<GroupMembersPage />, "/groups/group-1/members");

    await screen.findAllByText("win-hermes");
    const row = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("win-hermes"))!;
    fireEvent.click(within(row).getByRole("button", { name: "移除" }));

    expect(confirmMock).toHaveBeenCalledWith(
      "确定将成员「win-hermes」移出群组吗?",
    );
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, init]) => init?.method === "DELETE",
      );
      expect(call).toBeDefined();
      expect(String(call![0])).toBe(
        "/api/groups/group-1/members/participant-2",
      );
    });
    // 列表刷新后该成员消失。
    await waitFor(() => {
      expect(screen.queryAllByText("win-hermes")).toHaveLength(0);
    });
  });

  it("群主(创建者)的移除按钮禁用,普通成员可用 (ticket 20)", async () => {
    stubFetch(membersFetchMock());
    renderWithProviders(<GroupMembersPage />, "/groups/group-1/members");

    await screen.findAllByText("hermes-mac");
    const creatorRow = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("hermes-mac"))!;
    await waitFor(() => {
      expect(
        within(creatorRow).getByRole("button", { name: "移除" }),
      ).toBeDisabled();
    });
    const memberRow = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("win-hermes"))!;
    expect(
      within(memberRow).getByRole("button", { name: "移除" }),
    ).toBeEnabled();
  });
});

describe("GroupsPage 窄屏适配 (ticket 34)", () => {
  it("窄屏分支:移动卡片与桌面表格并存,卡片操作行可换行", async () => {
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");
    await screen.findAllByText("模型训练任务");

    // 移动卡片容器(md:hidden)与桌面表格(hidden md:table)同时渲染,
    // 由 CSS 断点切换显隐(jsdom 不解析 CSS,用 className 锁定分支)。
    const cardList = document.querySelector(".md\\:hidden");
    expect(cardList?.className).toContain("flex flex-col gap-3");
    const table = document.querySelector("table");
    expect(table?.className).toContain("hidden");
    expect(table?.className).toContain("md:table");
    // 卡片内操作行 flex-wrap:窄屏下三个按钮可换行而不横向挤压。
    expect(cardList?.querySelector(".flex-wrap")).not.toBeNull();
    // 页面根容器铺满宽度(w-full),窄屏收紧留白(p-4),sm 起恢复 p-6。
    const root = document.querySelector(".w-full");
    expect(root?.className).toContain("p-4");
    expect(root?.className).toContain("sm:p-6");
  });

  it("创建群组输入 + 按钮:窄屏纵排(sm 起横排),按钮不溢出", async () => {
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");
    await screen.findByLabelText("群组名称");

    const row = screen.getByLabelText("群组名称").closest("div");
    expect(row?.className).toContain("flex-col");
    expect(row?.className).toContain("sm:flex-row");
    expect(
      screen.getByRole("button", { name: /创建群组/ }).className,
    ).toContain("shrink-0");
  });
});
