import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_ID_KEY, AGENT_TOKEN_KEY } from "@/lib/api-client";
import {
  createFetchMock,
  jsonResponse,
  renderWithProviders,
} from "@/test/utils";
import ExecutorsPage from "./index";

/**
 * 接入 Agent 页(ticket: 网页 @executor 发布):
 *  - 表单字段齐全(名字/类型/调用方式/命令或地址/参数模板/设备);
 *  - 提交调 POST /api/executors,成功后列表出现新 agent;
 *  - 内置执行器只展示不可删除,DB 配置可删除;
 *  - 界面不出现任何 token/token_hash 字段;
 *  - Agent 自管理(ticket: 补全 /agents 页):行内展示 device/capabilities/
 *    device/capabilities/在线状态;编辑对话框 PATCH /api/agents/:id;心跳 PUT
 *    /api/agents/:id/heartbeat;未绑定 token 时编辑/心跳有无权限提示。
 */

const BUILTIN = [
  {
    key: "executor",
    agentName: "AtomCode 执行器",
    type: "agent",
    kind: "cli",
    bin: "atomcode",
    url: null,
    args: ["-y", "-p", "{ticket}"],
    label: "atomcode",
    builtin: true,
  },
];

function executorsFetchMock() {
  // Stateful list:POST 追加,DELETE 移除。
  const current: Array<Record<string, unknown>> = [...BUILTIN];
  return createFetchMock([
    {
      match: (url, init) =>
        init?.method === "POST" && String(url).endsWith("/api/executors"),
      respond: (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const created = {
          key: String(body.agentName).toLowerCase().replace(/\s+/g, "-"),
          agentName: body.agentName,
          type: body.type,
          kind: body.kind,
          bin: body.bin ?? null,
          url: body.url ?? null,
          args: body.args ?? [],
          label: body.agentName,
          builtin: false,
        };
        current.push(created);
        return jsonResponse(created);
      },
    },
    {
      match: (url, init) =>
        init?.method === "DELETE" && String(url).includes("/api/executors/"),
      respond: (url) => {
        const key = String(url).split("/").at(-1);
        const idx = current.findIndex((x) => x.key === key);
        if (idx >= 0) current.splice(idx, 1);
        return jsonResponse({ success: true, key });
      },
    },
    {
      match: (url, init) =>
        (!init?.method || init.method === "GET") &&
        String(url).endsWith("/api/executors"),
      respond: () => jsonResponse(current),
    },
  ]);
}

describe("接入 Agent 页", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("表单字段齐全,提交 POST /api/executors 后列表出现新 agent,且无 token 展示", async () => {
    const fetchMock = executorsFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ExecutorsPage />, "/agents");

    // 表单字段:名字/类型/调用方式/命令/参数模板/设备
    expect(screen.getByLabelText("名字")).toBeInTheDocument();
    expect(screen.getByLabelText("类型")).toBeInTheDocument();
    expect(screen.getByText("调用方式")).toBeInTheDocument();
    expect(screen.getByLabelText("cli(本地命令)")).toBeInTheDocument();
    expect(screen.getByLabelText("a2a(远程 gateway)")).toBeInTheDocument();
    expect(screen.getByLabelText("命令")).toBeInTheDocument();
    expect(screen.getByLabelText("参数模板(可选)")).toBeInTheDocument();
    expect(screen.getByLabelText("设备(可选)")).toBeInTheDocument();

    // 内置执行器已展示(加载完成后)
    await waitFor(() => {
      expect(screen.getByText("AtomCode 执行器")).toBeInTheDocument();
    });
    expect(screen.getByText("内置")).toBeInTheDocument();

    // 填表提交
    fireEvent.change(screen.getByLabelText("名字"), {
      target: { value: "My Cli Agent" },
    });
    fireEvent.change(screen.getByLabelText("命令"), {
      target: { value: "my-cli" },
    });
    fireEvent.change(screen.getByLabelText("参数模板(可选)"), {
      target: { value: "-y -p {ticket}" },
    });
    fireEvent.change(screen.getByLabelText("设备(可选)"), {
      target: { value: "mac-mini" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    await waitFor(() => {
      expect(screen.getByText("My Cli Agent")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/已接入 Agent「My Cli Agent」/),
    ).toBeInTheDocument();

    // POST 载荷:cli → bin + 参数模板分词,不含任何 token 字段
    const postCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    const payload = JSON.parse(String(postCall![1]?.body)) as Record<
      string,
      unknown
    >;
    expect(payload.agentName).toBe("My Cli Agent");
    expect(payload.kind).toBe("cli");
    expect(payload.bin).toBe("my-cli");
    expect(payload.args).toEqual(["-y", "-p", "{ticket}"]);
    expect(payload.device).toBe("mac-mini");
    expect(payload).not.toHaveProperty("token");
    expect(payload).not.toHaveProperty("tokenHash");

    // 界面无 token 展示
    expect(document.body.textContent).not.toMatch(/token/i);
  });

  it("a2a 调用方式显示 gateway 地址字段并提交 url", async () => {
    const fetchMock = executorsFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ExecutorsPage />, "/agents");

    fireEvent.click(screen.getByLabelText("a2a(远程 gateway)"));
    await waitFor(() => {
      expect(screen.getByLabelText("Gateway 地址")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("命令")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("名字"), {
      target: { value: "Win Agent" },
    });
    fireEvent.change(screen.getByLabelText("Gateway 地址"), {
      target: { value: "http://192.168.1.10:9900/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    await waitFor(() => {
      expect(screen.getByText("Win Agent")).toBeInTheDocument();
    });
    const postCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    const payload = JSON.parse(String(postCall![1]?.body)) as Record<
      string,
      unknown
    >;
    expect(payload.kind).toBe("a2a");
    expect(payload.url).toBe("http://192.168.1.10:9900/");
    expect(payload).not.toHaveProperty("token");
  });

  it("内置执行器不可删除,DB 配置可删除(DELETE /api/executors/:key)", async () => {
    // 弹窗确认 + 先塞一条非内置配置
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const list = [
      ...BUILTIN,
      {
        key: "extra-agent",
        agentName: "Extra Agent",
        type: "custom",
        kind: "cli",
        bin: "extra",
        url: null,
        args: [],
        label: "extra-agent",
        builtin: false,
      },
    ];
    const fetchMock = createFetchMock([
      {
        match: (url, init) =>
          init?.method === "DELETE" && String(url).includes("/api/executors/"),
        respond: (url) => {
          const key = String(url).split("/").at(-1);
          const idx = list.findIndex((x) => x.key === key);
          if (idx >= 0) list.splice(idx, 1);
          return jsonResponse({ success: true, key });
        },
      },
      {
        match: () => true,
        respond: () => jsonResponse(list),
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ExecutorsPage />, "/agents");

    await waitFor(() => {
      expect(screen.getByText("Extra Agent")).toBeInTheDocument();
    });

    // 内置项没有删除按钮
    const builtinRow = screen.getByText("AtomCode 执行器").closest("li")!;
    expect(within(builtinRow).queryByRole("button")).not.toBeInTheDocument();

    // 非内置项可删除
    const extraRow = screen.getByText("Extra Agent").closest("li")!;
    fireEvent.click(within(extraRow).getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(screen.queryByText("Extra Agent")).not.toBeInTheDocument();
    });
    const delCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "DELETE",
    );
    expect(String(delCall![0])).toContain("/api/executors/extra-agent");
  });

  // ── Agent 自管理(ticket: 补全 /agents 页)──────────────────────────────
  const AGENTS = [
    {
      id: "agent-online",
      name: "Online Bot",
      type: "custom",
      device: "mac-mini",
      capabilities: ["text-generation", "code-review"],
      lastSeen: new Date(Date.now() - 5_000).toISOString(),
    },
    {
      id: "agent-offline",
      name: "Offline Bot",
      type: "hermes",
      device: "win-pc",
      capabilities: [],
      lastSeen: new Date(Date.now() - 3_600_000).toISOString(),
    },
    {
      id: "agent-never",
      name: "Never Bot",
      type: "atomcode",
      device: null,
      capabilities: ["code-review"],
      lastSeen: null,
    },
  ];

  const EXECUTORS = [
    ...BUILTIN,
    {
      key: "online-bot",
      agentName: "Online Bot",
      type: "custom",
      kind: "cli",
      bin: "ob",
      url: null,
      args: [],
      label: "online-bot",
      builtin: false,
    },
    {
      key: "offline-bot",
      agentName: "Offline Bot",
      type: "hermes",
      kind: "cli",
      bin: "off",
      url: null,
      args: [],
      label: "offline-bot",
      builtin: false,
    },
    {
      key: "never-bot",
      agentName: "Never Bot",
      type: "atomcode",
      kind: "cli",
      bin: "nb",
      url: null,
      args: [],
      label: "never-bot",
      builtin: false,
    },
  ];

  /** 状态化 mock:GET /api/agents 返回可变列表,PATCH 更新,PUT heartbeat 写 lastSeen。 */
  function agentsFetchMock() {
    const agents: Array<Record<string, unknown>> = AGENTS.map((a) => ({
      ...a,
    }));
    return createFetchMock([
      {
        match: (url, init) =>
          init?.method === "PATCH" && String(url).includes("/api/agents/"),
        respond: (url, init) => {
          const id = String(url).split("/").at(-1);
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          const idx = agents.findIndex((a) => a.id === id);
          const updated = { ...agents[idx], ...body };
          if (idx >= 0) agents[idx] = updated;
          return jsonResponse(updated);
        },
      },
      {
        match: (url, init) =>
          init?.method === "PUT" && String(url).includes("/heartbeat"),
        respond: (url) => {
          const id = String(url).match(
            /\/api\/agents\/([^/]+)\/heartbeat/,
          )?.[1];
          const lastSeen = new Date().toISOString();
          const idx = agents.findIndex((a) => a.id === id);
          if (idx >= 0) agents[idx] = { ...agents[idx], lastSeen };
          return jsonResponse({ lastSeen });
        },
      },
      {
        match: (url, init) =>
          (!init?.method || init.method === "GET") &&
          String(url).endsWith("/api/agents"),
        respond: () => jsonResponse(agents),
      },
      {
        match: (url, init) =>
          (!init?.method || init.method === "GET") &&
          String(url).endsWith("/api/executors"),
        respond: () => jsonResponse(EXECUTORS),
      },
    ]);
  }

  it("列表行显示 device/capabilities 与在线/离线/从未在线徽标", async () => {
    const fetchMock = agentsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<ExecutorsPage />, "/agents");

    await screen.findByText("Online Bot");
    // device 出现在元信息行(custom · cli · mac-mini …)
    expect(screen.getByText(/mac-mini/)).toBeInTheDocument();
    // capabilities 标签 chips
    expect(screen.getByText("text-generation")).toBeInTheDocument();
    expect(screen.getAllByText("code-review").length).toBeGreaterThanOrEqual(2);
    // 在线/离线/从未在线徽标(在线 Bot 5s 前心跳,离线 Bot 1h 前,从未 Bot 无)
    expect(screen.getByText("在线")).toBeInTheDocument();
    expect(screen.getByText("离线")).toBeInTheDocument();
    expect(screen.getByText("从未在线")).toBeInTheDocument();
  });

  it("编辑对话框可改 name/device/capabilities,PATCH 保存并即时刷新", async () => {
    localStorage.setItem(AGENT_TOKEN_KEY, "tok-1");
    localStorage.setItem(AGENT_ID_KEY, "agent-online");
    const fetchMock = agentsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<ExecutorsPage />, "/agents");

    await screen.findByText("Online Bot");
    const row = screen.getByText("Online Bot").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));

    // 对话框预填现有注册信息
    const nameInput = screen.getByLabelText("Agent 名字") as HTMLInputElement;
    expect(nameInput.value).toBe("Online Bot");
    expect((screen.getByLabelText("设备") as HTMLInputElement).value).toBe(
      "mac-mini",
    );
    expect(
      (screen.getByLabelText("能力标签(逗号分隔)") as HTMLInputElement).value,
    ).toBe("text-generation, code-review");

    fireEvent.change(nameInput, { target: { value: "Online Bot v2" } });
    fireEvent.change(screen.getByLabelText("设备"), {
      target: { value: "mac-pro" },
    });
    fireEvent.change(screen.getByLabelText("能力标签(逗号分隔)"), {
      target: { value: "text-generation, testing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    // 保存成功后对话框关闭,列表行内刷新
    await waitFor(() => {
      expect(screen.queryByLabelText("Agent 名字")).not.toBeInTheDocument();
    });
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PATCH",
    );
    expect(patchCall).toBeTruthy();
    expect(String(patchCall![0])).toContain("/api/agents/agent-online");
    const payload = JSON.parse(String(patchCall![1]?.body)) as Record<
      string,
      unknown
    >;
    expect(payload.name).toBe("Online Bot v2");
    expect(payload.device).toBe("mac-pro");
    // 逗号分隔输入 → 数组
    expect(payload.capabilities).toEqual(["text-generation", "testing"]);
    // 行内刷新出新 capability chip
    expect(screen.getByText("testing")).toBeInTheDocument();
  });

  it("心跳按钮调用 PUT heartbeat 并即时刷新在线状态", async () => {
    localStorage.setItem(AGENT_TOKEN_KEY, "tok-1");
    localStorage.setItem(AGENT_ID_KEY, "agent-never");
    const fetchMock = agentsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<ExecutorsPage />, "/agents");

    await screen.findByText("Never Bot");
    const row = screen.getByText("Never Bot").closest("li")!;
    expect(within(row).getByText("从未在线")).toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "上报在线" }));

    // 成功后该行立即变在线
    await waitFor(() => {
      expect(within(row).getByText("在线")).toBeInTheDocument();
    });
    const beatCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PUT",
    );
    expect(String(beatCall![0])).toContain("/api/agents/agent-never/heartbeat");
    expect(screen.getByText(/已上报「Never Bot」在线/)).toBeInTheDocument();
  });

  it("未绑定 token 时编辑/心跳给出无权限提示", async () => {
    const fetchMock = agentsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<ExecutorsPage />, "/agents");

    await screen.findByText("Online Bot");
    const row = screen.getByText("Online Bot").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
    await screen.findByText("无权限,请先绑定 Agent Token 再操作");

    fireEvent.click(within(row).getByRole("button", { name: "上报在线" }));
    expect(
      screen.getByText("无权限,请先绑定 Agent Token 再操作"),
    ).toBeInTheDocument();
    // 编辑对话框未被打开
    expect(screen.queryByLabelText("Agent 名字")).not.toBeInTheDocument();
  });
});
