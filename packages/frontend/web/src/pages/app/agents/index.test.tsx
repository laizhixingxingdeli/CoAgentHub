import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
 *  - 界面不出现任何 token/token_hash 字段。
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
    expect(screen.getByText(/已接入 Agent「My Cli Agent」/)).toBeInTheDocument();

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
    vi.stubGlobal("confirm", vi.fn(() => true));
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
});
