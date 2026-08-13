import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFetchMock,
  jsonResponse,
  renderWithProviders,
} from "@/test/utils";
import GroupMembersPage from "./members";

/**
 * Ticket 21: 群内成员自定义提示词 — 加成员可填本群分工提示词,成员列表
 * 显示/行内编辑,无则显示「未设置」。
 */

const MEMBERS = [
  {
    participantId: "participant-1",
    name: "hermes-mac",
    type: "hermes",
    device: "mac-mini",
    roles: ["coordinator"],
    prompt: "负责整体协调与任务拆解,把控进度",
    joinedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    participantId: "participant-2",
    name: "win-hermes",
    type: "hermes",
    device: "win-pc",
    roles: ["reviewer", "executor"],
    prompt: null,
    joinedAt: "2026-08-01T00:01:00.000Z",
  },
];

const PARTICIPANTS = [
  {
    id: "participant-1",
    name: "hermes-mac",
    type: "hermes",
    device: "mac-mini",
  },
  { id: "participant-9", name: "atomcode-cli", type: "atomcode", device: null },
];

function membersFetchMock(
  members: unknown[] = MEMBERS,
  participants: unknown[] = PARTICIPANTS,
) {
  // Stateful roster: POST appends, PATCH updates roles/prompt, so the list
  // refresh after each action can be asserted against the DOM.
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
          const { participantId, roles, prompt } = JSON.parse(
            String(init?.body),
          ) as Record<string, unknown>;
          return jsonResponse({ participantId, roles, prompt });
        }
        return jsonResponse(current);
      },
    },
    {
      match: (url, init) =>
        init?.method === "PATCH" && String(url).includes("/members/"),
      respond: (url, init) => {
        const participantId = String(url).split("/").pop();
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        current = current.map((m) =>
          m.participantId === participantId ? { ...m, ...patch } : m,
        );
        return jsonResponse({ participantId, ...patch });
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

describe("GroupMembersPage 成员管理(ticket 21 prompt)", () => {
  it("加成员表单有「本群分工提示词」输入框,提交 POST 带 prompt 并显示在列表", async () => {
    const fetchMock = stubFetch(membersFetchMock());
    renderWithProviders(<GroupMembersPage />, "/groups/group-1/members");

    await screen.findAllByText("hermes-mac");

    fireEvent.change(screen.getByLabelText("选择成员 participant"), {
      target: { value: "participant-9" },
    });
    fireEvent.change(screen.getByLabelText("本群分工提示词(可选)"), {
      target: { value: "在本组你负责 code review,重点关注测试覆盖与可读性" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加成员" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, init]) => init?.method === "POST",
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String(call![1]?.body)) as Record<string, string>;
      expect(body.participantId).toBe("participant-9");
      expect(body.prompt).toBe(
        "在本组你负责 code review,重点关注测试覆盖与可读性",
      );
    });

    // 提交成功后提示词输入框被清空。
    await waitFor(() => {
      expect(screen.getByLabelText("本群分工提示词(可选)")).toHaveValue("");
    });
  });

  it("成员行显示分工提示词;无 prompt 的成员显示「未设置」灰字", async () => {
    stubFetch(membersFetchMock());
    renderWithProviders(<GroupMembersPage />, "/groups/group-1/members");

    // 移动卡片与桌面表格都渲染,断言至少出现一处。
    expect(
      (await screen.findAllByText("负责整体协调与任务拆解,把控进度")).length,
    ).toBeGreaterThan(0);
    // 长文本超出 40 字时收成一行并提供「展开」。
    expect(screen.getAllByText("未设置").length).toBeGreaterThan(0);
  });

  it("长分工提示词可展开/收起", async () => {
    stubFetch(
      membersFetchMock([
        {
          participantId: "participant-1",
          name: "hermes-mac",
          type: "hermes",
          device: "mac-mini",
          roles: ["coordinator"],
          prompt:
            "负责整体协调与任务拆解,把控进度,并定期汇总风险点与阻塞项给群主,必要时兜底处理线上告警",
          joinedAt: "2026-08-01T00:00:00.000Z",
        },
      ]),
    );
    renderWithProviders(<GroupMembersPage />, "/groups/group-1/members");

    expect(
      (
        await screen.findAllByText(
          "负责整体协调与任务拆解,把控进度,并定期汇总风险点与阻塞项给群主,必要时兜底处理线上告警",
        )
      ).length,
    ).toBeGreaterThan(0);

    const expand = screen.getAllByRole("button", { name: "展开" })[0];
    fireEvent.click(expand);
    expect(
      screen.getAllByRole("button", { name: "收起" }).length,
    ).toBeGreaterThan(0);
  });

  it("编辑分工:PATCH 单独更新 prompt 并刷新列表,无 prompt 可清空为「未设置」", async () => {
    const fetchMock = stubFetch(membersFetchMock());
    renderWithProviders(<GroupMembersPage />, "/groups/group-1/members");

    await screen.findAllByText("win-hermes");
    const row = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("win-hermes"))!;
    fireEvent.click(within(row).getByRole("button", { name: "编辑分工" }));

    // 预填为空(该成员无 prompt)。
    expect(within(row).getByLabelText("编辑分工提示词")).toHaveValue("");

    fireEvent.change(within(row).getByLabelText("编辑分工提示词"), {
      target: { value: "负责跑通全部测试,输出失败用例清单" },
    });
    fireEvent.click(within(row).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, init]) => init?.method === "PATCH",
      );
      expect(call).toBeDefined();
      expect(String(call![0])).toBe(
        "/api/groups/group-1/members/participant-2",
      );
      const body = JSON.parse(String(call![1]?.body)) as Record<string, string>;
      expect(body).toEqual({ prompt: "负责跑通全部测试,输出失败用例清单" });
    });

    // 保存成功后编辑表单关闭,列表刷新显示新分工。
    await waitFor(() => {
      expect(screen.queryByLabelText("编辑分工提示词")).toBeNull();
      expect(
        screen.getAllByText("负责跑通全部测试,输出失败用例清单").length,
      ).toBeGreaterThan(0);
    });
  });

  it("清空分工:清空 textarea 保存 → PATCH 传空字符串,刷新后回到「未设置」", async () => {
    const fetchMock = stubFetch(membersFetchMock());
    renderWithProviders(<GroupMembersPage />, "/groups/group-1/members");

    await screen.findAllByText("hermes-mac");
    const row = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("hermes-mac"))!;
    fireEvent.click(within(row).getByRole("button", { name: "编辑分工" }));

    // 预填该成员现有分工。
    expect(within(row).getByLabelText("编辑分工提示词")).toHaveValue(
      "负责整体协调与任务拆解,把控进度",
    );

    fireEvent.change(within(row).getByLabelText("编辑分工提示词"), {
      target: { value: "" },
    });
    fireEvent.click(within(row).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, init]) => init?.method === "PATCH",
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String(call![1]?.body)) as Record<string, string>;
      expect(body).toEqual({ prompt: "" });
    });

    // 刷新后该行分工回到「未设置」。
    await waitFor(() => {
      const refreshed = screen
        .getAllByRole("row")
        .find((r) => r.textContent?.includes("hermes-mac"))!;
      expect(within(refreshed).getByText("未设置")).toBeInTheDocument();
    });
  });

  it("编辑角色与编辑分工互斥:打开其中一个会关闭另一个", async () => {
    stubFetch(membersFetchMock());
    renderWithProviders(<GroupMembersPage />, "/groups/group-1/members");

    await screen.findAllByText("hermes-mac");
    const row = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("hermes-mac"))!;

    fireEvent.click(within(row).getByRole("button", { name: "编辑分工" }));
    expect(within(row).getByLabelText("编辑分工提示词")).toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "编辑角色" }));
    expect(within(row).queryByLabelText("编辑分工提示词")).toBeNull();
    expect(
      within(row).getByRole("button", { name: "取消" }),
    ).toBeInTheDocument();
  });
});
