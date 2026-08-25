import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureRuntimeEntry,
  configureSourceScanRoots,
} from "@server/lib/runtime-status";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "./app";

const sourceEntry = new URL("../src/lib/runtime-status.ts", import.meta.url)
  .href;

beforeEach(() => {
  // 默认不扫描,避免测试触碰真实仓库源码树导致 build 陈旧误判。
  configureSourceScanRoots([]);
});

afterEach(() => {
  configureRuntimeEntry(sourceEntry);
  configureSourceScanRoots([]);
});

describe("GET /api/system/health", () => {
  const app = createTestApp();

  it("返回纯文本 ok(默认 Accept)", async () => {
    const res = await app.request("/api/system/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("Accept: application/json 时返回 JSON", async () => {
    const res = await app.request("/api/system/health", {
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("/api/health 返回运行时新鲜度字段", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      startedAt: string;
      entryMtime: string | null;
      stale: boolean;
      staleReason: string | null;
    };
    expect(typeof body.startedAt).toBe("string");
    expect(typeof body.entryMtime).toBe("string");
    expect(body.stale).toBe(false);
    expect(body.staleReason).toBeNull();
  });

  it("/api/health 按 staleReason 区分 build 陈旧并输出 newestSourceMtime", async () => {
    const directory = mkdtempSync(join(tmpdir(), "coagenthub-health-"));
    const entry = join(directory, "server.mjs");
    writeFileSync(entry, "entry");
    const entryTime = new Date(Date.now() - 60_000);
    utimesSync(entry, entryTime, entryTime);
    configureRuntimeEntry(new URL(`file://${entry}`).href);

    const src = join(directory, "src");
    const srcTime = new Date(Date.now() - 30_000);
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "index.ts"), "src");
    utimesSync(join(src, "index.ts"), srcTime, srcTime);
    configureSourceScanRoots([src]);

    try {
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        stale: true,
        staleReason: "build",
        newestSourceMtime: srcTime.toISOString(),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
