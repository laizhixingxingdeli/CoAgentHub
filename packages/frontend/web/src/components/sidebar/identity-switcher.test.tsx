import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PARTICIPANT_ID_KEY } from "@/lib/api-client";
import { useIdentityStore } from "@/lib/stores/identity";
import { SidebarProvider } from "@/components/ui/sidebar";
import { createFetchMock, jsonResponse } from "@/test/utils";
import { IdentitySwitcher } from "./identity-switcher";

const PARTICIPANTS = [
  { id: "participant-1", name: "hermes-mac", device: "mac-mini" },
  { id: "participant-9", name: "atomcode-cli", device: null },
];

function identityFetchMock(registerError?: number) {
  // 状态化名册:注册会追加新 participant(ticket 28 语义),供「使用中」标记断言。
  const roster: Array<Record<string, unknown>> = [...PARTICIPANTS];
  return createFetchMock([
    {
      // 注册(POST /api/participants)返回 id;必须排在通用 GET 匹配之前
      // (createFetchMock 首个匹配生效)。
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
        };
        roster.push(created);
        return jsonResponse(created);
      },
    },
    {
      match: (url) => String(url).endsWith("/api/participants"),
      respond: () => jsonResponse(roster),
    },
  ]);
}

function renderSwitcher() {
  return render(
    <SidebarProvider>
      <IdentitySwitcher />
    </SidebarProvider>,
  );
}

/** 点击收起态触发按钮,展开面板渲染完成。
 * Radix DropdownMenuTrigger 在 onPointerDown(左键,button===0)时切换开合,
 * 没有 onClick 处理;jsdom 未实现 PointerEvent,fireEvent.pointerDown 派发的
 * 事件不带 button:0(守卫不通过),因此手动派发 MouseEvent('pointerdown')。 */
const openSwitcher = async () => {
  const trigger = screen.getByRole("button", { name: "身份切换" });
  fireEvent(
    trigger,
    new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
  );
  await screen.findByRole("button", { name: /注册新参与方/ });
};

/** 展开注册表单(④ 二级展开)。 */
const openRegister = async () => {
  fireEvent.click(await screen.findByRole("button", { name: /注册新参与方/ }));
};

beforeEach(() => {
  localStorage.clear();
  // setup.ts 用 coagenthub.lang=zh 固定测试语言,这里清掉 localStorage 后要补回,
  // 否则 t() 会回落 navigator.language(en-US),断言的中文文案全部失配。
  localStorage.setItem("coagenthub.lang", "zh");
  // 重置 store 的内存态,避免用例间串扰;挂载校准(mount-sync)会把 store 与
  // localStorage 对齐,初始态由此确定。
  useIdentityStore.setState({ participantId: "" });
  // jsdom 无原生 matchMedia:stub 系统浅色偏好(SidebarProvider 内部
  // use-mobile 会 add/removeEventListener)。
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  useIdentityStore.setState({ participantId: "" });
});

describe("IdentitySwitcher 收起态", () => {
  it("未绑定时显示「未绑定身份」提示", async () => {
    vi.stubGlobal("fetch", identityFetchMock());
    renderSwitcher();

    expect(screen.getByText("未绑定身份")).toBeInTheDocument();
  });

  it("已绑定时收起态显示当前身份名(name+device)", async () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-1");
    vi.stubGlobal("fetch", identityFetchMock());
    renderSwitcher();

    // 名册加载完成后,收起态从裸 id 升级为 name(device)。
    const trigger = screen.getByRole("button", { name: "身份切换" });
    expect(await within(trigger).findByText("hermes-mac(mac-mini)")).toBeInTheDocument();
  });

  it("点击收起态展开面板,再点外部区域收起", async () => {
    vi.stubGlobal("fetch", identityFetchMock());
    renderSwitcher();

    await openSwitcher();
    expect(
      screen.getByRole("button", { name: /注册新参与方/ }),
    ).toBeInTheDocument();
  });
});

describe("IdentitySwitcher 已有参与方列表 (ticket 29)", () => {
  it("展开后渲染已有参与方列表:名字 + 设备小字 + 总数", async () => {
    vi.stubGlobal("fetch", identityFetchMock());
    renderSwitcher();
    await openSwitcher();

    expect(await screen.findByText("已有参与方")).toBeInTheDocument();
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
    const fetchMock = identityFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    renderSwitcher();
    await openSwitcher();

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
    vi.stubGlobal("fetch", identityFetchMock());
    renderSwitcher();
    await openSwitcher();

    expect(
      await screen.findByText("使用中: hermes-mac(mac-mini)"),
    ).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    const boundRow = rows.find((r) => r.textContent?.includes("hermes-mac"))!;
    expect(within(boundRow).getByText("使用中")).toBeInTheDocument();
    expect(
      within(boundRow).queryByRole("button", { name: "使用" }),
    ).toBeNull();
    // 其余行仍是「使用」。
    const otherRow = rows.find((r) => r.textContent?.includes("atomcode-cli"))!;
    expect(
      within(otherRow).getByRole("button", { name: "使用" }),
    ).toBeInTheDocument();
  });

  it("清除后回到未绑定提示,列表刷新全部恢复「使用」", async () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-1");
    vi.stubGlobal("fetch", identityFetchMock());
    renderSwitcher();
    await openSwitcher();

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

  it("绑定后收起态立即显示新身份", async () => {
    localStorage.removeItem(PARTICIPANT_ID_KEY);
    vi.stubGlobal("fetch", identityFetchMock());
    renderSwitcher();
    // 菜单是 modal 的:打开后触发按钮会被 aria-hidden,先持有引用,绑定后再查。
    const trigger = screen.getByRole("button", { name: "身份切换" });
    await openSwitcher();

    const bindButtons = await screen.findAllByRole("button", { name: "使用" });
    const hermesRow = bindButtons.find((b) =>
      b.closest("li")?.textContent?.includes("hermes-mac"),
    )!;
    fireEvent.click(hermesRow);

    expect(
      await within(trigger).findByText("hermes-mac(mac-mini)"),
    ).toBeInTheDocument();
  });
});

describe("IdentitySwitcher 手动输入绑定 (ticket 18)", () => {
  it("手动输入 participant id 即绑定:写入 localStorage", async () => {
    vi.stubGlobal("fetch", identityFetchMock());
    renderSwitcher();
    await openSwitcher();

    const idInput = await screen.findByLabelText("参与方 ID");
    fireEvent.change(idInput, { target: { value: "participant-1" } });
    fireEvent.click(screen.getByRole("button", { name: "绑定" }));

    await waitFor(() => {
      expect(localStorage.getItem(PARTICIPANT_ID_KEY)).toBe("participant-1");
    });
  });

  it("清除身份时同步清除 coagenthub.participantId", async () => {
    localStorage.setItem(PARTICIPANT_ID_KEY, "participant-1");
    vi.stubGlobal("fetch", identityFetchMock());
    renderSwitcher();
    await openSwitcher();

    fireEvent.click(await screen.findByRole("button", { name: "清除" }));

    await waitFor(() => {
      expect(localStorage.getItem(PARTICIPANT_ID_KEY)).toBeNull();
    });
  });
});

describe("IdentitySwitcher 注册新参与方 (ticket 28)", () => {
  it("展开注册区显示表单,提交按钮存在", async () => {
    vi.stubGlobal("fetch", identityFetchMock());
    renderSwitcher();
    await openSwitcher();
    await openRegister();

    expect(screen.getByLabelText("注册参与方名称")).toBeInTheDocument();
    expect(screen.getByLabelText("注册参与方设备")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "注册并绑定" }),
    ).toBeInTheDocument();
  });

  it("填写表单提交调用 POST /api/participants 且携带 name/device", async () => {
    const fetchMock = identityFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    renderSwitcher();
    await openSwitcher();
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
    vi.stubGlobal("fetch", identityFetchMock());
    renderSwitcher();
    await openSwitcher();
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
  });

  it("注册失败显示错误信息且不写入 localStorage", async () => {
    localStorage.removeItem(PARTICIPANT_ID_KEY);
    vi.stubGlobal("fetch", identityFetchMock(400));
    renderSwitcher();
    await openSwitcher();
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
    const fetchMock = identityFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    renderSwitcher();
    await openSwitcher();
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

  it("device 为空则省略(载荷不含 device)", async () => {
    const fetchMock = identityFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    renderSwitcher();
    await openSwitcher();
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
