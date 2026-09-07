import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";

/**
 * LAN file transfer API integration tests. FILE_DIR points at a throwaway
 * temp dir (see test/setup.ts), so no real disk store is touched.
 */

// setup.ts 把 MAX_FILE_UPLOAD_BYTES 固定为 1024;file.ts 的
// MULTIPART_FRAMING_ALLOWANCE 为 1MB → 请求体闸门上限(与 Content-Length
// 预检同口径)= 1024 + 1MB。新增用例的载荷尺寸都围绕它构造。
const GATE_LIMIT = 1024 + 1024 * 1024;

/**
 * 构造「惰性 multipart」请求体:sizes 里每个大小对应一个 file part
 * (同名 file、固定 framing),按 chunk 大小分块 yield。流式 body 不带
 * content-length → Content-Length 预检对它不可见,正是本票要修的绕过场景。
 *
 * pulled.n 累计**服务端实际从流里读走的字节数**:
 * - R1「超限即停读」:超限用例改后 pulled.n 停在闸门上限附近,远小于整体
 *   大小(改前会读完整个 body 才拒);
 * - 验收 6「快速路径不读请求体」:诚实超大声明用例 pulled.n 必须为 0。
 */
function multipartStream(
  sizes: number[],
  chunk = 4096,
  pulled: { n: number } = { n: 0 },
): ReadableStream<Uint8Array> {
  const boundary = "----probe-boundary-12345";
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  sizes.forEach((size, i) => {
    parts.push(
      encoder.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="probe-${i}.bin"\r\n` +
          `Content-Type: application/octet-stream\r\n` +
          `\r\n`,
      ),
    );
    parts.push(new Uint8Array(size));
    parts.push(encoder.encode("\r\n"));
  });
  parts.push(encoder.encode(`--${boundary}--\r\n`));
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const buffer = new Uint8Array(total);
  let fill = 0;
  for (const p of parts) {
    buffer.set(p, fill);
    fill += p.byteLength;
  }
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= total) {
        controller.close();
        return;
      }
      const n = Math.min(chunk, total - offset);
      pulled.n += n;
      controller.enqueue(buffer.slice(offset, offset + n));
      offset += n;
    },
  });
}

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

  it("超过上传上限(1KB,setup 模拟)返回 400「文件过大」且不落盘", async () => {
    const formData = new FormData();
    formData.append(
      "file",
      new File([new Uint8Array(1025)], "too-big.bin", {
        type: "application/octet-stream",
      }),
    );
    const res = await app.request("/api/file/upload", {
      method: "POST",
      body: formData,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("文件过大");

    // 未落盘:列表里不应出现该文件
    const listRes = await app.request("/api/file/list");
    const list = (await listRes.json()) as Array<{ name: string }>;
    expect(list.some((f) => f.name === "too-big.bin")).toBe(false);
  });

  it("恰好等于上限(1024B)的文件正常上传(上限取 > 不含等号)", async () => {
    const formData = new FormData();
    formData.append(
      "file",
      new File([new Uint8Array(1024)], "at-limit.bin", {
        type: "application/octet-stream",
      }),
    );
    const res = await app.request("/api/file/upload", {
      method: "POST",
      body: formData,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).size).toBe(1024);
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

  it("无 Content-Length 的超大请求被计数闸门拦截(R1 核心):超限即停读,不是读完再拒", async () => {
    // 流式 body 没有 content-length 头 → 预检被跳过(改前唯一的绕过口)。
    // 文件内容 1.1MB > GATE_LIMIT(1,049,600)。
    const pulled = { n: 0 };
    const body = multipartStream([1_100_000], 4096, pulled);
    const res = await app.request("/api/file/upload", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("文件过大");

    // R1:计数以实际读到的字节为准,超限即中止读取 —— 服务端只读到闸门
    // 上限附近(> GATE_LIMIT 才触发,排除「误用 1KB 单文件上限」的实现),
    // 远小于整个 body;改前这里是读完整个 1.1MB 后才被 file.size 拒绝。
    expect(pulled.n).toBeGreaterThan(GATE_LIMIT);
    expect(pulled.n).toBeLessThan(1_100_000);

    // R3:FILE_DIR 无新增文件
    const listRes = await app.request("/api/file/list");
    const list = (await listRes.json()) as Array<{ name: string }>;
    expect(list.some((f) => f.name === "probe-0.bin")).toBe(false);
  });

  it("谎报 Content-Length(声明小于上限、实际超限)被计数闸门拦截", async () => {
    const pulled = { n: 0 };
    const body = multipartStream([1_100_000], 4096, pulled);
    const res = await app.request("/api/file/upload", {
      method: "POST",
      body,
      headers: { "content-length": "1024" }, // 声明值 < GATE_LIMIT,是谎报
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("文件过大");

    // 计数不信任声明值:实际字节超限时同样停读并拒绝
    expect(pulled.n).toBeGreaterThan(GATE_LIMIT);
    expect(pulled.n).toBeLessThan(1_100_000);

    const listRes = await app.request("/api/file/list");
    const list = (await listRes.json()) as Array<{ name: string }>;
    expect(list.some((f) => f.name === "probe-0.bin")).toBe(false);
  });

  it("多 part 累计超限(两个 part 各自不超、合计超限)被同一个计数器拦截", async () => {
    // 每个 part 600KB < GATE_LIMIT,合计 1.2MB + framing > GATE_LIMIT。
    // 若计数器是「每 part 独立」的,两个 part 都不会单独触发闸门,
    // 只会读完整个 body 后由 file.size 兜底 —— 停读断言可区分。
    const pulled = { n: 0 };
    const body = multipartStream([600_000, 600_000], 4096, pulled);
    const res = await app.request("/api/file/upload", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("文件过大");

    // 两个 part 的字节计入同一计数器:在合计越过 GATE_LIMIT 时停读,
    // 停在第二个 part 中间,远小于两个 part 的总内容
    expect(pulled.n).toBeGreaterThan(GATE_LIMIT);
    expect(pulled.n).toBeLessThan(600_000 + 600_000);

    // R3:FILE_DIR 无新增文件(两个 part 都没有落盘)
    const listRes = await app.request("/api/file/list");
    const list = (await listRes.json()) as Array<{ name: string }>;
    expect(list.some((f) => f.name.startsWith("probe-"))).toBe(false);
  });

  it("诚实超大请求仍走 Content-Length 快速路径:预检拒绝,一个字节都不读", async () => {
    // 声明 2MB(> GATE_LIMIT)且实际也超限 → 预检直接拒,请求体从未被读。
    const pulled = { n: 0 };
    const body = multipartStream([1_100_000], 4096, pulled);
    const res = await app.request("/api/file/upload", {
      method: "POST",
      body,
      headers: { "content-length": "2000000" },
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("文件过大");

    // 证明 handler 没有读 body(走的是预检快速路径):undici 的 Request
    // 构造函数对 stream body 会预读恰好一个 chunk(4096B,与构造器同层
    // 实测、与闸门实现是否存在无关),handler 层面一旦消费 —— 无论计数
    // 闸门(formData 前)还是解析(formData 本身)—— pulled.n 都会到
    // ≥ 1052672(闸门停读点)或全量 1.1MB。停在构造器预读水平
    // (≤ 一个 chunk)即排除这两种可能。
    expect(pulled.n).toBeLessThanOrEqual(4096);
  });
});
