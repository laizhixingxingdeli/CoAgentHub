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

// R4 状态文件路径指向测试隔离目录(缺省指向 /tmp,测试不能碰真实文件)
const STATE_DIR = mkdtempSync(join(tmpdir(), "coagenthub-watchdog-state-"));
const STATE_FILE = join(STATE_DIR, "auto-rebuild-state");
const STALL_FILE = join(STATE_DIR, "stall-state");

beforeEach(() => {
  // 默认不扫描,避免测试触碰真实仓库源码树导致 build 陈旧误判。
  configureSourceScanRoots([]);
  process.env.COAGENTHUB_AUTO_REBUILD_STATE = STATE_FILE;
  process.env.COAGENTHUB_STALL_STATE_FILE = STALL_FILE;
});

afterEach(() => {
  configureRuntimeEntry(sourceEntry);
  configureSourceScanRoots([]);
  // 只清状态文件本身(目录保留:下一个用例还要写入)
  rmSync(STATE_FILE, { force: true });
  rmSync(STALL_FILE, { force: true });
});

describe("GET /api/system/health", () => {
  const app = createTestApp();

  it("返回纯文本 ok(默认 Accept)", async () => {
    const res = await app.request("/api/system/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("Accept: application/json 时返回 JSON(默认无停用/停滞状态)", async () => {
    const res = await app.request("/api/system/health", {
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      autoRebuild: { disabled: false, disabledAt: null, reason: null },
      staleStall: { stalledRounds: 0, lastRoundAt: null, notified: false },
    });
  });

  it("R4:停用状态文件存在时透出 autoRebuild.disabled 与停用时刻", async () => {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({
        disabled: true,
        disabledAt: "2026-09-05T21:00:00+0800",
        reason: "窗口 86400s 内失败 3 次(≥3)",
      }) + "\n",
    );
    const res = await app.request("/api/system/health", {
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { autoRebuild: unknown };
    expect(body.autoRebuild).toEqual({
      disabled: true,
      disabledAt: "2026-09-05T21:00:00+0800",
      reason: "窗口 86400s 内失败 3 次(≥3)",
    });
  });

  it("R2/R4:停滞状态文件存在时透出 staleStall(轮数与升级标记)", async () => {
    writeFileSync(
      STALL_FILE,
      JSON.stringify({
        stalledRounds: 4,
        lastRoundAt: "2026-09-05T22:12:00+0800",
        notified: true,
      }) + "\n",
    );
    const res = await app.request("/api/system/health", {
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { staleStall: unknown };
    expect(body.staleStall).toEqual({
      stalledRounds: 4,
      lastRoundAt: "2026-09-05T22:12:00+0800",
      notified: true,
    });
  });

  it("R4:状态文件损坏时健康接口不报错,回落未停用", async () => {
    writeFileSync(STATE_FILE, "not-json");
    const res = await app.request("/api/system/health", {
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      autoRebuild: { disabled: boolean };
    };
    expect(body.autoRebuild.disabled).toBe(false);
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

  it("/api/health 透出调度策略的当前生效值与来源(可观测,不夹带无关配置)", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      // 既有字段:新增 dispatchPolicy 是同级追加,不改这些的形状。
      stale: boolean;
      dispatchPolicy: {
        origin: {
          source: "file" | "builtin-default";
          path: string;
          resolvedFrom: "env" | "cwd";
        } | null;
        effective: Record<string, unknown>;
      };
    };

    // 既有消费方(前端 requirement-workspace 读 stale/staleReason)不受影响。
    expect(typeof body.stale).toBe("boolean");

    // 来源三要素齐全 —— 排障要的正是「用的哪个文件 / 还是兜底」。
    const origin = body.dispatchPolicy.origin;
    expect(origin).not.toBeNull();
    expect(["file", "builtin-default"]).toContain(origin?.source);
    expect(["env", "cwd"]).toContain(origin?.resolvedFrom);
    expect(typeof origin?.path).toBe("string");

    // 当前生效值:maxRetries 是本票的起因(配了 3 却只重试 1 次,查不到为什么)。
    const effective = body.dispatchPolicy.effective as {
      retry: { maxRetries: number };
      maxParallelGroups: number;
    };
    expect(typeof effective.retry.maxRetries).toBe("number");
    expect(typeof effective.maxParallelGroups).toBe("number");

    // 不夹带无关配置:只有 origin / effective 两个键,且 effective 里不出现
    // 任何 env 名或路径 —— 这个端点无鉴权,加什么都要有理由。
    expect(Object.keys(body.dispatchPolicy).sort()).toEqual([
      "effective",
      "origin",
    ]);
    expect(JSON.stringify(effective)).not.toMatch(/COAGENTHUB_|process\.env/);
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
