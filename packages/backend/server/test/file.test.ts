import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";

/**
 * LAN file transfer API integration tests. FILE_DIR points at a throwaway
 * temp dir (see test/setup.ts), so no real disk store is touched.
 */
describe("文件 file API", () => {
  const app = createTestApp();

  it("POST /api/file/upload 上传文件", async () => {
    const formData = new FormData();
    formData.append(
      "file",
      new File(["hello world"], "hello.txt", { type: "text/plain" }),
    );
    const res = await app.request("/api/file/upload", {
      method: "POST",
      body: formData,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      size: number;
      url: string;
    };
    expect(body.name).toBe("hello.txt");
    expect(body.size).toBe(11);
    expect(body.url).toBe("/api/file/hello.txt");
  });

  it("GET /api/file/list 列出已上传文件", async () => {
    const res = await app.request("/api/file/list");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ name: string }>;
    expect(list.some((f) => f.name === "hello.txt")).toBe(true);
  });

  it("GET /api/file/:name 下载文件内容", async () => {
    const res = await app.request("/api/file/hello.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello world");
  });

  it("DELETE /api/file/:name 删除文件", async () => {
    const res = await app.request("/api/file/hello.txt", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    const listRes = await app.request("/api/file/list");
    const list = (await listRes.json()) as Array<{ name: string }>;
    expect(list.some((f) => f.name === "hello.txt")).toBe(false);
  });

  it("下载不存在的文件返回 404", async () => {
    const res = await app.request("/api/file/not-exists.txt");
    expect(res.status).toBe(404);
  });

  it("路径穿越文件名(../)被拒绝", async () => {
    const res = await app.request("/api/file/..%2Fetc%2Fpasswd");
    expect(res.status).toBe(400);
  });
});
