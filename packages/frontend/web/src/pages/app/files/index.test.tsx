import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFetchMock,
  jsonResponse,
  renderWithProviders,
} from "@/test/utils";
import FilesPage from "./index";

const FILES = [
  {
    name: "report.pdf",
    size: 2048,
    mtime: "2026-08-01T00:00:00.000Z",
    url: "/api/file/report.pdf",
  },
  {
    name: "photo.jpg",
    size: 1048576,
    mtime: "2026-08-02T00:00:00.000Z",
    url: "/api/file/photo.jpg",
  },
];

function filesFetchMock(list: unknown[] = FILES) {
  return createFetchMock([
    {
      match: (url) => url.endsWith("/api/file/list"),
      respond: () => jsonResponse(list),
    },
    {
      match: (url) => url.endsWith("/api/file/upload"),
      respond: () =>
        jsonResponse({
          name: "hello.txt",
          size: 5,
          url: "/api/file/hello.txt",
        }),
    },
    {
      match: (url) => url.includes("/api/file/report.pdf"),
      respond: () => jsonResponse({ success: true }),
    },
  ]);
}

function stubFetch(mock: ReturnType<typeof createFetchMock>) {
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  // jsdom's window.confirm is a no-op stub; control it per test.
  Object.defineProperty(window, "confirm", {
    configurable: true,
    writable: true,
    value: vi.fn(() => true),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FilesPage 列表", () => {
  it("渲染文件列表(卡片 + 表格)", async () => {
    stubFetch(filesFetchMock());
    renderWithProviders(<FilesPage />, "/files");

    expect(await screen.findAllByText("report.pdf")).not.toHaveLength(0);
    expect(screen.getAllByText("photo.jpg")).not.toHaveLength(0);
  });

  it("无文件时显示空态", async () => {
    stubFetch(filesFetchMock([]));
    renderWithProviders(<FilesPage />, "/files");

    expect(
      await screen.findByText("暂无文件,点击右上角「上传文件」开始"),
    ).toBeInTheDocument();
  });
});

describe("FilesPage 上传", () => {
  it("选择文件后调用 POST /api/file/upload 并刷新列表", async () => {
    const fetchMock = stubFetch(filesFetchMock());
    const { container } = renderWithProviders(<FilesPage />, "/files");

    await screen.findAllByText("report.pdf");
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/file/upload"),
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(
      await screen.findByText('文件 "hello.txt" 上传成功'),
    ).toBeInTheDocument();
  });
});

describe("FilesPage 删除", () => {
  it("确认后调用 DELETE /api/file/:name 并提示成功", async () => {
    const fetchMock = stubFetch(filesFetchMock());
    const confirmMock = vi.mocked(window.confirm).mockReturnValue(true);
    renderWithProviders(<FilesPage />, "/files");

    fireEvent.click(
      (await screen.findAllByRole("button", { name: "删除" }))[0],
    );

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith(
        '确定要删除文件 "report.pdf" 吗?',
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/file/report.pdf"),
        expect.objectContaining({ method: "DELETE" }),
      );
    });
    expect(
      await screen.findByText('文件 "report.pdf" 已删除'),
    ).toBeInTheDocument();
  });

  it("取消确认时不调用删除接口", async () => {
    const fetchMock = stubFetch(filesFetchMock());
    vi.mocked(window.confirm).mockReturnValue(false);
    renderWithProviders(<FilesPage />, "/files");

    fireEvent.click(
      (await screen.findAllByRole("button", { name: "删除" }))[0],
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
      ).toBe(false);
    });
  });
});
