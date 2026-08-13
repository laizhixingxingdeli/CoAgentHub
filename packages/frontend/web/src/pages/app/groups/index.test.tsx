import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_ID_KEY, AGENT_TOKEN_KEY } from "@/lib/api-client";
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
    roles: ["reviewer", "executor"],
    joinedAt: "2026-08-01T00:01:00.000Z",
  },
];

const AGENTS = [
  { id: "agent-1", name: "hermes-mac", type: "hermes", device: "mac-mini" },
  { id: "agent-9", name: "atomcode-cli", type: "atomcode", device: null },
];

function groupsFetchMock(groups: unknown[] = GROUPS, registerError?: number) {
  // Stateful list: a successful POST create appends, archive flips status.
  // The list handler also honors ?status= so tab filtering can be asserted.
  let current = [...groups] as Array<Record<string, unknown>>;
  // Ticket 29: 状态化 agent 名册 — 注册会追加,供身份面板「使用中」标记断言。
  const roster: Array<Record<string, unknown>> = [...AGENTS];
  return createFetchMock([
    {
      // Ticket 28: agent 注册(POST /api/agents,公开端点)返回一次性 token。
      // 必须排在下面的通用 /api/agents 匹配之前(createFetchMock 首个匹配生效)。
      match: (url, init) =>
        init?.method === "POST" && String(url).endsWith("/api/agents"),
      respond: (_url, init) => {
        if (registerError) {
          return jsonResponse({ message: "名称已存在" }, registerError);
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const created = {
          id: "agent-new",
          name: body.name,
          type: body.type,
          device: body.device ?? null,
          webhookUrl: null,
          capabilities: [],
          createdAt: "2026-08-11T00:00:00.000Z",
        };
        roster.push(created);
        return jsonResponse({
          ...created,
          token: "tok-registered",
        });
      },
    },
    {
      // Ticket 29: 一键绑定 — 公开 POST /:id/reset-token 返回明文 token。
      match: (url, init) =>
        init?.method === "POST" && String(url).includes("/reset-token"),
      respond: (url) => {
        const id = String(url).split("/").at(-2);
        const found = roster.find((a) => a.id === id);
        return jsonResponse({
          id,
          name: found?.name ?? id,
          token: "tok-reset",
        });
      },
    },
    {
      // The list URL may carry ?status=active|archived (tab filter) and/or
      // ?q= (title search); strip the query before matching so bare,
      // filtered, and searched fetches all hit this handler.
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
        return jsonResponse(filtered);
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
      // Agent roster (ticket 20 settings + ticket 29 identity panel):
      // 状态化名册,注册会追加新 agent。
      match: (url) => url.endsWith("/api/agents"),
      respond: () => jsonResponse(roster),
    },
    {
      match: (url, init) =>
        init?.method === "PATCH" && String(url).includes("/api/agents/"),
      respond: (url, init) => {
        const id = String(url).split("/").pop();
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const base = AGENTS.find((a) => a.id === id) ?? AGENTS[0];
        return jsonResponse({ ...base, ...patch });
      },
    },
  ]);
}

function membersFetchMock(
  members: unknown[] = MEMBERS,
  agents: unknown[] = AGENTS,
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
          createdBy: "agent-1",
        }),
    },
    {
      match: (url) => url.endsWith("/api/agents"),
      respond: () => jsonResponse(agents),
    },
    {
      match: (url) => url.includes("/api/groups/") && url.endsWith("/members"),
      respond: (_url, init) => {
        if ((init?.method ?? "GET") === "POST") {
          return jsonResponse({
            agentId: "agent-9",
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
        const agentId = String(url).split("/").pop();
        const { roles } = JSON.parse(String(init?.body)) as { roles: string[] };
        current = current.map((m) =>
          m.agentId === agentId ? { ...m, roles } : m,
        );
        return jsonResponse({ agentId, roles });
      },
    },
    {
      match: (url, init) =>
        init?.method === "DELETE" && String(url).includes("/members/"),
      respond: (url) => {
        const agentId = String(url).split("/").pop();
        current = current.filter((m) => m.agentId !== agentId);
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
      fetchMock.mock.calls.some(([url]) => String(url) === "/api/groups"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "已归档" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url]) => String(url) === "/api/groups?status=archived",
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
        ([url]) => String(url) === "/api/groups?status=active",
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
        ([url]) => String(url) === "/api/groups?q=%E6%A8%A1%E5%9E%8B",
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
        ([url]) => String(url) === "/api/groups",
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
          ([url]) => String(url) === "/api/groups?status=archived",
        ),
      ).toBe(true);
    });

    fireEvent.change(screen.getByLabelText("搜索群组"), {
      target: { value: "评审" },
    });

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url]) =>
          String(url) === "/api/groups?status=archived&q=%E8%AF%84%E5%AE%A1",
      );
      expect(call).toBeDefined();
    });
    expect((await screen.findAllByText("已完成的评审")).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryAllByText("模型训练任务")).toHaveLength(0);
  });
});

describe("GroupsPage agent 绑定 (ticket 18)", () => {
  const openAdvanced = async () => {
    fireEvent.click(
      await screen.findByRole("button", { name: /高级:手动输入 token/ }),
    );
  };

  it("保存 token 时把 agentId 一并写入 localStorage(coagenthub.agentId)", async () => {
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    // 手动绑定收进「高级:手动输入 token」折叠区(ticket 29),先展开。
    await openAdvanced();
    const tokenInput = await screen.findByLabelText("Agent Token");
    fireEvent.change(tokenInput, { target: { value: "tok-18" } });
    fireEvent.change(screen.getByLabelText("Agent ID"), {
      target: { value: "agent-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(localStorage.getItem(AGENT_TOKEN_KEY)).toBe("tok-18");
      expect(localStorage.getItem(AGENT_ID_KEY)).toBe("agent-1");
    });
  });

  it("清除 token 时同步清除 coagenthub.agentId", async () => {
    localStorage.setItem(AGENT_TOKEN_KEY, "tok-18");
    localStorage.setItem(AGENT_ID_KEY, "agent-1");
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    fireEvent.click(await screen.findByRole("button", { name: "清除" }));

    await waitFor(() => {
      expect(localStorage.getItem(AGENT_TOKEN_KEY)).toBeNull();
      expect(localStorage.getItem(AGENT_ID_KEY)).toBeNull();
    });
  });
});

describe("GroupsPage 身份面板 (ticket 29)", () => {
  it("渲染已有 Agent 列表:名字 + 类型/设备小字 + 总数", async () => {
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    expect(await screen.findByText("已有 Agent")).toBeInTheDocument();
    // 名册两行:hermes-mac(hermes mac-mini)、atomcode-cli(atomcode)。
    expect(screen.getByText("hermes-mac")).toBeInTheDocument();
    expect(screen.getByText("hermes mac-mini")).toBeInTheDocument();
    expect(screen.getByText("atomcode-cli")).toBeInTheDocument();
    expect(screen.getByText("共 2 个")).toBeInTheDocument();
    // 未绑定时两行都有「绑定」按钮,无「使用中」标记。
    expect(screen.getAllByRole("button", { name: "绑定" }).length).toBe(2);
    expect(screen.queryByText("使用中")).toBeNull();
  });

  it("点「绑定」调 POST /:id/reset-token 并自动绑定,提示已切换", async () => {
    localStorage.removeItem(AGENT_TOKEN_KEY);
    localStorage.removeItem(AGENT_ID_KEY);
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    // 点第二行(atomcode-cli)的绑定。
    const bindButtons = await screen.findAllByRole("button", { name: "绑定" });
    const atomcodeRow = bindButtons.find((b) =>
      b.closest("li")?.textContent?.includes("atomcode-cli"),
    )!;
    fireEvent.click(atomcodeRow);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === "POST" && String(url).includes("/reset-token"),
      );
      expect(call).toBeDefined();
      expect(String(call![0])).toBe("/api/agents/agent-9/reset-token");
    });
    // commitToken 写入 localStorage + 提示已切换 + 该行变「使用中」。
    await waitFor(() => {
      expect(localStorage.getItem(AGENT_TOKEN_KEY)).toBe("tok-reset");
      expect(localStorage.getItem(AGENT_ID_KEY)).toBe("agent-9");
    });
    expect(
      await screen.findByText("已切换为 atomcode-cli"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("使用中: atomcode-cli(atomcode)"),
    ).toBeInTheDocument();
    // 列表刷新后 hermes-mac 仍是「绑定」,atomcode-cli 变「使用中」。
    await waitFor(() => {
      expect(screen.getByText("使用中")).toBeInTheDocument();
      const remainingBind = screen.getAllByRole("button", { name: "绑定" });
      expect(remainingBind.length).toBe(1);
      expect(remainingBind[0].closest("li")?.textContent).toContain(
        "hermes-mac",
      );
    });
  });

  it("已绑定的 agent 显示「使用中」标记,绑定按钮不可用", async () => {
    localStorage.setItem(AGENT_TOKEN_KEY, "tok-29");
    localStorage.setItem(AGENT_ID_KEY, "agent-1");
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findByText("已有 Agent");
    // 当前身份突出显示 + 该行「使用中」。
    expect(
      screen.getByText("使用中: hermes-mac(hermes·mac-mini)"),
    ).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    const boundRow = rows.find((r) => r.textContent?.includes("hermes-mac"))!;
    expect(within(boundRow).getByText("使用中")).toBeInTheDocument();
    expect(within(boundRow).queryByRole("button", { name: "绑定" })).toBeNull();
    // 其余行仍是「绑定」。
    const otherRow = rows.find((r) => r.textContent?.includes("atomcode-cli"))!;
    expect(
      within(otherRow).getByRole("button", { name: "绑定" }),
    ).toBeInTheDocument();
  });

  it("清除后回到未绑定提示,列表刷新全部恢复「绑定」", async () => {
    localStorage.setItem(AGENT_TOKEN_KEY, "tok-29");
    localStorage.setItem(AGENT_ID_KEY, "agent-1");
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await screen.findByText("使用中: hermes-mac(hermes·mac-mini)");
    fireEvent.click(screen.getByRole("button", { name: "清除" }));

    await waitFor(() => {
      expect(localStorage.getItem(AGENT_TOKEN_KEY)).toBeNull();
      expect(localStorage.getItem(AGENT_ID_KEY)).toBeNull();
    });
    expect(
      await screen.findByText(/未绑定 agent,从下方列表一键绑定/),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("使用中")).toBeNull();
      expect(screen.getAllByRole("button", { name: "绑定" }).length).toBe(2);
    });
  });

  it("手动绑定入口保留:高级折叠区展开后可输入 token 保存", async () => {
    localStorage.removeItem(AGENT_TOKEN_KEY);
    localStorage.removeItem(AGENT_ID_KEY);
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    // 默认折叠,只有展开后才有输入框。
    expect(screen.queryByLabelText("Agent Token")).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", { name: /高级:手动输入 token/ }),
    );
    const tokenInput = await screen.findByLabelText("Agent Token");
    fireEvent.change(tokenInput, { target: { value: "tok-manual" } });
    fireEvent.change(screen.getByLabelText("Agent ID"), {
      target: { value: "agent-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(localStorage.getItem(AGENT_TOKEN_KEY)).toBe("tok-manual");
      expect(localStorage.getItem(AGENT_ID_KEY)).toBe("agent-1");
    });
    expect(
      await screen.findByText("使用中: hermes-mac(hermes·mac-mini)"),
    ).toBeInTheDocument();
  });
});

describe("GroupsPage 注册新 Agent (ticket 28)", () => {
  const openRegister = async () => {
    fireEvent.click(
      await screen.findByRole("button", { name: /注册新 Agent/ }),
    );
  };

  it("展开注册区显示表单,类型默认 human,提交按钮存在", async () => {
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await openRegister();
    expect(screen.getByLabelText("注册 Agent 名称")).toBeInTheDocument();
    expect(screen.getByLabelText("注册 Agent 设备")).toBeInTheDocument();
    const typeSelect = screen.getByLabelText(
      "注册 Agent 类型",
    ) as HTMLSelectElement;
    expect(typeSelect.value).toBe("human");
    expect(
      screen.getByRole("button", { name: "注册并绑定" }),
    ).toBeInTheDocument();
  });

  it("填写表单提交调用 POST /api/agents 且携带 name/type/device", async () => {
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await openRegister();
    fireEvent.change(screen.getByLabelText("注册 Agent 名称"), {
      target: { value: "我的 Mac" },
    });
    fireEvent.change(screen.getByLabelText("注册 Agent 类型"), {
      target: { value: "hermes" },
    });
    fireEvent.change(screen.getByLabelText("注册 Agent 设备"), {
      target: { value: "mac" },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册并绑定" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === "POST" && String(url).endsWith("/api/agents"),
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        name: "我的 Mac",
        type: "hermes",
        device: "mac",
      });
    });
  });

  it("注册成功:写入 localStorage、绑定横幅出现、一次性 token 展示", async () => {
    localStorage.removeItem(AGENT_TOKEN_KEY);
    localStorage.removeItem(AGENT_ID_KEY);
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await openRegister();
    fireEvent.change(screen.getByLabelText("注册 Agent 名称"), {
      target: { value: "alice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册并绑定" }));

    await waitFor(() => {
      expect(localStorage.getItem(AGENT_TOKEN_KEY)).toBe("tok-registered");
      expect(localStorage.getItem(AGENT_ID_KEY)).toBe("agent-new");
    });
    // 身份面板显示当前身份(注册即切换)+ 一次性 token 展示。
    expect(await screen.findByText("使用中: alice(human)")).toBeInTheDocument();
    expect(screen.getByText("✅ 已注册并绑定 alice")).toBeInTheDocument();
    expect(screen.getByLabelText("注册返回的 Agent Token")).toHaveValue(
      "tok-registered",
    );
  });

  it("注册失败显示错误信息且不写入 localStorage", async () => {
    localStorage.removeItem(AGENT_TOKEN_KEY);
    stubFetch(groupsFetchMock([], 400));
    renderWithProviders(<GroupsPage />, "/groups");

    await openRegister();
    fireEvent.change(screen.getByLabelText("注册 Agent 名称"), {
      target: { value: "alice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册并绑定" }));

    expect(await screen.findByText(/注册失败:/)).toBeInTheDocument();
    expect(screen.getByText(/名称已存在/)).toBeInTheDocument();
    expect(localStorage.getItem(AGENT_TOKEN_KEY)).toBeNull();
    expect(screen.queryByText(/使用中:/)).toBeNull();
  });

  it("token 展示可复制:点击复制写入剪贴板", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await openRegister();
    fireEvent.change(screen.getByLabelText("注册 Agent 名称"), {
      target: { value: "alice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册并绑定" }));
    await screen.findByLabelText("注册返回的 Agent Token");

    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("tok-registered");
    });
    expect(
      await screen.findByRole("button", { name: "已复制" }),
    ).toBeInTheDocument();
  });

  it("名称为空时提示且不发起注册请求", async () => {
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await openRegister();
    fireEvent.click(screen.getByRole("button", { name: "注册并绑定" }));

    expect(screen.getByText("Agent 名称不能为空")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          init?.method === "POST" && String(url).endsWith("/api/agents"),
      ),
    ).toBe(false);
  });

  it("类型选「自定义」时提交自定义类型值,device 为空则省略", async () => {
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    await openRegister();
    fireEvent.change(screen.getByLabelText("注册 Agent 名称"), {
      target: { value: "cli-agent" },
    });
    fireEvent.change(screen.getByLabelText("注册 Agent 类型"), {
      target: { value: "custom" },
    });
    fireEvent.change(await screen.findByLabelText("自定义 Agent 类型"), {
      target: { value: "openclaw" },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册并绑定" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === "POST" && String(url).endsWith("/api/agents"),
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        name: "cli-agent",
        type: "openclaw",
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

describe("GroupsPage Agent 设置 (ticket 20)", () => {
  it("绑定后显示设置区,保存调用 PATCH /api/agents/:id", async () => {
    localStorage.setItem(AGENT_TOKEN_KEY, "tok-20");
    localStorage.setItem(AGENT_ID_KEY, "agent-1");
    const fetchMock = stubFetch(groupsFetchMock());
    renderWithProviders(<GroupsPage />, "/groups");

    // 设置区在绑定 + 拉取到自己信息后出现;type 只读展示。
    const settingsButton = await screen.findByRole("button", {
      name: /Agent 设置/,
    });
    fireEvent.click(settingsButton);
    expect(screen.getByText(/类型:hermes\(只读\)/)).toBeInTheDocument();

    // 修改名称并保存;device 沿用当前值,webhookUrl 为空发送 null 清空。
    const nameInput = screen.getByLabelText("Agent 名称") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "hermes-mac-2" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === "PATCH" && String(url).includes("/api/agents/"),
      );
      expect(call).toBeDefined();
      expect(String(call![0])).toBe("/api/agents/agent-1");
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        name: "hermes-mac-2",
        device: "mac-mini",
        webhookUrl: null,
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
      await screen.findByText("暂无成员,从上方添加 agent 进入群组"),
    ).toBeInTheDocument();
  });

  it("选择 agent 与角色后调用 POST /:id/members", async () => {
    const fetchMock = stubFetch(membersFetchMock());
    renderWithProviders(<GroupMembersPage />, "/groups/group-1/members");

    // Wait for the roster to load and the select to populate.
    const select = (await screen.findByLabelText(
      "选择成员 agent",
    )) as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    await waitFor(() => {
      expect(select.options.length).toBeGreaterThan(1);
    });

    fireEvent.change(select, { target: { value: "agent-9" } });
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
        agentId: "agent-9",
        roles: ["observer", "reviewer"],
      });
    });
  });

  it("已是成员的 agent 不出现在候选下拉中", async () => {
    stubFetch(membersFetchMock());
    renderWithProviders(<GroupMembersPage />, "/groups/group-1/members");

    const select = (await screen.findByLabelText(
      "选择成员 agent",
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(select.options.length).toBeGreaterThan(1);
    });
    const optionTexts = Array.from(select.options).map((o) => o.textContent);
    expect(optionTexts.some((t) => t?.includes("hermes-mac"))).toBe(false);
    expect(optionTexts.some((t) => t?.includes("atomcode-cli"))).toBe(true);
  });

  it("编辑角色:行内表单保存调用 PATCH /:id/members/:agentId 并刷新 (ticket 20)", async () => {
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
      expect(String(call![0])).toBe("/api/groups/group-1/members/agent-2");
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        roles: ["executor"],
      });
    });
    // 保存成功后编辑表单关闭。
    await waitFor(() => {
      expect(within(row).queryByRole("button", { name: "取消" })).toBeNull();
    });
  });

  it("移除成员:confirm 后调用 DELETE /:id/members/:agentId 并刷新列表 (ticket 20)", async () => {
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
      expect(String(call![0])).toBe("/api/groups/group-1/members/agent-2");
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
    // 页面根容器窄屏收紧留白(p-4),sm 起恢复 p-6。
    const root = document.querySelector(".max-w-4xl");
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
