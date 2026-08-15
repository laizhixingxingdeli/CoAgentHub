import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PARTICIPANT_ID_KEY } from "@/lib/api-client";
import {
  createFetchMock,
  jsonResponse,
  renderWithProviders,
} from "@/test/utils";
import ExecutorsPage from "./index";

/**
 * 接入 Participant 页(ticket: 网页 @executor 发布):
 *  - 表单字段齐全(名字/调用方式/命令或地址/参数模板/设备);
 *  - 提交调 POST /api/executors,成功后列表出现新 participant;
 *  - 内置执行器只展示不可删除,DB 配置可删除;
 *  - 界面不出现任何 token/token_hash 字段;
 *  - Participant 自管理(ticket: 补全 /participants 页):行内展示 device/capabilities/
 *    device/capabilities/在线状态;编辑对话框 PATCH /api/participants/:id;心跳 PUT
 *    /api/participants/:id/heartbeat;未绑定 token 时编辑/心跳有无权限提示。
 */

const BUILTIN = [
  {
    key: "executor",
    agentName: "AtomCode 执行器",
    type: "participant",
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
          type: "custom",
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
        init?.method === "PATCH" && String(url).includes("/api/executors/"),
      respond: (url, init) => {
        const key = String(url).split("/").at(-1);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const idx = current.findIndex((x) => x.key === key);
        if (idx >= 0) current[idx] = { ...current[idx], ...body };
        return jsonResponse({
          ...(idx >= 0 ? current[idx] : {}),
          ...body,
          builtin: false,
        });
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

describe("接入参与方页", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("表单字段齐全,提交 POST /api/executors 后列表出现新 participant,且无 token 展示", async () => {
    const fetchMock = executorsFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ExecutorsPage />, "/participants");

    // 表单字段:名字/调用方式/命令/参数模板/设备/模型
    expect(screen.getByLabelText("名字")).toBeInTheDocument();
    expect(screen.getByText("调用方式")).toBeInTheDocument();
    expect(screen.getByLabelText("cli(本地命令)")).toBeInTheDocument();
    expect(screen.getByLabelText("a2a(远程 gateway)")).toBeInTheDocument();
    expect(screen.getByLabelText("命令")).toBeInTheDocument();
    expect(screen.getByLabelText("参数模板(可选)")).toBeInTheDocument();
    expect(screen.getByLabelText("设备(可选)")).toBeInTheDocument();
    expect(screen.getByLabelText("模型(可选)")).toBeInTheDocument();

    // 内置执行器已展示(加载完成后)
    await waitFor(() => {
      expect(screen.getByText("AtomCode 执行器")).toBeInTheDocument();
    });
    expect(screen.getByText("内置")).toBeInTheDocument();

    // 填表提交
    fireEvent.change(screen.getByLabelText("名字"), {
      target: { value: "My Cli Participant" },
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
    fireEvent.change(screen.getByLabelText("模型(可选)"), {
      target: { value: "deepseek-v4-flash" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    await waitFor(() => {
      expect(screen.getByText("My Cli Participant")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/已接入参与方「My Cli Participant」/),
    ).toBeInTheDocument();

    // POST 载荷:cli → bin + 参数模板分词 + 模型,不含任何 token 字段
    const postCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    const payload = JSON.parse(String(postCall![1]?.body)) as Record<
      string,
      unknown
    >;
    expect(payload.agentName).toBe("My Cli Participant");
    expect(payload.kind).toBe("cli");
    expect(payload.bin).toBe("my-cli");
    expect(payload.args).toEqual(["-y", "-p", "{ticket}"]);
    expect(payload.device).toBe("mac-mini");
    expect(payload.model).toBe("deepseek-v4-flash");
    expect(payload).not.toHaveProperty("token");
    expect(payload).not.toHaveProperty("tokenHash");
    // participant.type 已移除:载荷不含 type。
    expect(payload).not.toHaveProperty("type");

    // 界面无 token 展示
    expect(document.body.textContent).not.toMatch(/token/i);
  });

  it("a2a 调用方式显示 gateway 地址字段并提交 url", async () => {
    const fetchMock = executorsFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ExecutorsPage />, "/participants");

    fireEvent.click(screen.getByLabelText("a2a(远程 gateway)"));
    await waitFor(() => {
      expect(screen.getByLabelText("Gateway 地址")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("命令")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("名字"), {
      target: { value: "Win Participant" },
    });
    fireEvent.change(screen.getByLabelText("Gateway 地址"), {
      target: { value: "http://192.168.1.10:9900/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    await waitFor(() => {
      expect(screen.getByText("Win Participant")).toBeInTheDocument();
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
        key: "extra-participant",
        agentName: "Extra Participant",
        type: "custom",
        kind: "cli",
        bin: "extra",
        url: null,
        args: [],
        label: "extra-participant",
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

    renderWithProviders(<ExecutorsPage />, "/participants");

    await waitFor(() => {
      expect(screen.getByText("Extra Participant")).toBeInTheDocument();
    });

    // 内置项:编辑按钮禁用(提示内置不可编辑),没有删除按钮
    const builtinRow = screen.getByText("AtomCode 执行器").closest("li")!;
    const builtinEditBtn = within(builtinRow).getByRole("button", {
      name: "编辑执行器",
    });
    expect(builtinEditBtn).toBeDisabled();
    expect(
      within(builtinRow).queryByRole("button", { name: "删除" }),
    ).not.toBeInTheDocument();

    // 非内置项可删除
    const extraRow = screen.getByText("Extra Participant").closest("li")!;
    fireEvent.click(within(extraRow).getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(screen.queryByText("Extra Participant")).not.toBeInTheDocument();
    });
    const delCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "DELETE",
    );
    expect(String(delCall![0])).toContain("/api/executors/extra-participant");
  });

  it("编辑执行器:弹窗打开预填,保存调 PATCH 并即时刷新", async () => {
    const list = [
      ...BUILTIN,
      {
        key: "edit-target",
        agentName: "Edit Target",
        type: "custom",
        kind: "cli",
        bin: "edit-bin",
        url: null,
        args: ["-y", "-p", "{ticket}"],
        label: "edit-target",
        model: "deepseek-v4-flash",
        builtin: false,
      },
    ];
    const fetchMock = createFetchMock([
      {
        match: (url, init) =>
          init?.method === "PATCH" && String(url).includes("/api/executors/"),
        respond: (url, init) => {
          const key = String(url).split("/").at(-1);
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          const idx = list.findIndex((x) => x.key === key);
          if (idx >= 0) list[idx] = { ...list[idx], ...body };
          return jsonResponse({
            ...(idx >= 0 ? list[idx] : {}),
            ...body,
            builtin: false,
          });
        },
      },
      {
        match: () => true,
        respond: () => jsonResponse(list),
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ExecutorsPage />, "/participants");

    await waitFor(() => {
      expect(screen.getByText("Edit Target")).toBeInTheDocument();
    });
    const row = screen.getByText("Edit Target").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "编辑执行器" }));

    // 弹窗预填现有配置(bin/args/model/device/agentName);查询限定在弹窗内
    // (新增表单也有同名的 名字/命令/模型 等 label)。
    const dialog = screen.getByRole("dialog");
    const nameInput = within(dialog).getByLabelText("名字") as HTMLInputElement;
    expect(nameInput.value).toBe("Edit Target");
    expect(
      (within(dialog).getByLabelText("命令") as HTMLInputElement).value,
    ).toBe("edit-bin");
    expect(
      (within(dialog).getByLabelText("参数模板(可选)") as HTMLInputElement)
        .value,
    ).toBe("-y -p {ticket}");
    expect(
      (within(dialog).getByLabelText("模型(可选)") as HTMLInputElement).value,
    ).toBe("deepseek-v4-flash");

    // 改 bin/args/model 并保存
    fireEvent.change(within(dialog).getByLabelText("命令"), {
      target: { value: "new-bin" },
    });
    fireEvent.change(within(dialog).getByLabelText("模型(可选)"), {
      target: { value: "gpt-4o" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    // PATCH 调用 + 载荷正确
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
    });
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PATCH",
    )!;
    expect(String(patchCall[0])).toContain("/api/executors/edit-target");
    const payload = JSON.parse(String(patchCall[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(payload.bin).toBe("new-bin");
    expect(payload.model).toBe("gpt-4o");
    expect(payload.agentName).toBe("Edit Target");
    // 弹窗关闭,列表即时刷新出新值
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(screen.getByText(/gpt-4o/)).toBeInTheDocument();
  });

  // ── Participant 自管理(ticket: 补全 /participants 页)──────────────────────────────
  const PARTICIPANTS = [
    {
      id: "participant-online",
      name: "Online Bot",
      device: "mac-mini",
      capabilities: ["text-generation", "code-review"],
      lastSeen: new Date(Date.now() - 5_000).toISOString(),
    },
    {
      id: "participant-offline",
      name: "Offline Bot",
      device: "win-pc",
      capabilities: [],
      lastSeen: new Date(Date.now() - 3_600_000).toISOString(),
    },
    {
      id: "participant-never",
      name: "Never Bot",
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

  /** 状态化 mock:GET /api/participants 返回可变列表,PATCH 更新,PUT heartbeat 写 lastSeen。 */
  function participantsFetchMock() {
    const participants: Array<Record<string, unknown>> = PARTICIPANTS.map(
      (a) => ({
        ...a,
      }),
    );
    return createFetchMock([
      {
        match: (url, init) =>
          init?.method === "PATCH" &&
          String(url).includes("/api/participants/"),
        respond: (url, init) => {
          const id = String(url).split("/").at(-1);
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          const idx = participants.findIndex((a) => a.id === id);
          const updated = { ...participants[idx], ...body };
          if (idx >= 0) participants[idx] = updated;
          return jsonResponse(updated);
        },
      },
      {
        match: (url, init) =>
          init?.method === "PUT" && String(url).includes("/heartbeat"),
        respond: (url) => {
          const id = String(url).match(
            /\/api\/participants\/([^/]+)\/heartbeat/,
          )?.[1];
          const lastSeen = new Date().toISOString();
          const idx = participants.findIndex((a) => a.id === id);
          if (idx >= 0) participants[idx] = { ...participants[idx], lastSeen };
          return jsonResponse({ lastSeen });
        },
      },
      {
        match: (url, init) =>
          (!init?.method || init.method === "GET") &&
          String(url).endsWith("/api/participants"),
        respond: () => jsonResponse(participants),
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
    const fetchMock = participantsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<ExecutorsPage />, "/participants");

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
    localStorage.setItem(PARTICIPANT_ID_KEY, "tok-1");
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-online");
    const fetchMock = participantsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<ExecutorsPage />, "/participants");

    await screen.findByText("Online Bot");
    const row = screen.getByText("Online Bot").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));

    // 对话框预填现有注册信息
    const nameInput = screen.getByLabelText("参与方名字") as HTMLInputElement;
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
      expect(screen.queryByLabelText("参与方名字")).not.toBeInTheDocument();
    });
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PATCH",
    );
    expect(patchCall).toBeTruthy();
    expect(String(patchCall![0])).toContain(
      "/api/participants/participant-online",
    );
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
    localStorage.setItem(PARTICIPANT_ID_KEY, "tok-1");
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-never");
    const fetchMock = participantsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<ExecutorsPage />, "/participants");

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
    expect(String(beatCall![0])).toContain(
      "/api/participants/participant-never/heartbeat",
    );
    expect(screen.getByText(/已上报「Never Bot」在线/)).toBeInTheDocument();
  });

  it("未绑定身份时编辑/心跳给出提示(全信模型:绑定后任意身份都可管理)", async () => {
    const fetchMock = participantsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<ExecutorsPage />, "/participants");

    await screen.findByText("Online Bot");
    const row = screen.getByText("Online Bot").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
    await screen.findByText(/未绑定身份,请先在群组页身份面板/);

    fireEvent.click(within(row).getByRole("button", { name: "上报在线" }));
    expect(
      screen.getByText(/未绑定身份,请先在群组页身份面板/),
    ).toBeInTheDocument();
    // 编辑对话框未被打开
    expect(screen.queryByLabelText("参与方名字")).not.toBeInTheDocument();
  });

  it("参与者行内改名:铅笔 → 输入 → PATCH /api/participants/:id {name} → 行内刷新", async () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "tok-1");
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-online");
    const fetchMock = participantsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<ExecutorsPage />, "/participants");

    await screen.findByText("Online Bot");
    const pencil = screen.getByTestId("rename-participant-online-bot");
    fireEvent.click(pencil);

    const input = await screen.findByLabelText("新参与者名称");
    expect((input as HTMLInputElement).value).toBe("Online Bot");
    fireEvent.change(input, { target: { value: "Online Bot 新名" } });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([url, init]) =>
          init?.method === "PATCH" &&
          String(url).endsWith("/api/participants/participant-online"),
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(String(patch![1]?.body))).toEqual({
        name: "Online Bot 新名",
      });
    });
    // 行内刷新出新名字,编辑态关闭。
    expect(await screen.findByText("Online Bot 新名")).toBeInTheDocument();
    expect(screen.queryByLabelText("新参与者名称")).toBeNull();
  });

  it("内置执行器行内改名给出「执行器名由配置管理」提示,不进入编辑", async () => {
    // 内置执行器无对应 participant 注册(executors 列表里只有内置项时),
    // 点击铅笔直接提示「执行器名由配置管理」,不进入编辑态。
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-any");
    vi.stubGlobal("fetch", executorsFetchMock());
    renderWithProviders(<ExecutorsPage />, "/participants");

    await screen.findByText("AtomCode 执行器");
    const pencil = screen.getByTestId("rename-participant-executor");
    fireEvent.click(pencil);
    // 提示出现,不进入编辑态。
    expect(await screen.findByText("执行器名由配置管理")).toBeInTheDocument();
    expect(screen.queryByLabelText("新参与者名称")).toBeNull();
  });
});
