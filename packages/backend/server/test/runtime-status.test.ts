import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  configureRuntimeEntry,
  configureSourceScanRoots,
  getRuntimeStatus,
  resetSourceScanCache,
} from "@server/lib/runtime-status";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const sourceEntry = new URL("../src/lib/runtime-status.ts", import.meta.url)
  .href;

beforeEach(() => {
  // 默认不扫描,避免测试触碰真实仓库源码树;需要扫描的用例自行设置。
  configureSourceScanRoots([]);
});

afterEach(() => {
  configureRuntimeEntry(sourceEntry);
  configureSourceScanRoots([]);
});

/** 建一个带 entry 与可选 src 的临时目录,返回目录路径。 */
function makeRuntimeDir(): string {
  return mkdtempSync(join(tmpdir(), "coagenthub-runtime-"));
}

function writeEntry(directory: string, mtime: Date): string {
  const entry = join(directory, "server.mjs");
  writeFileSync(entry, "entry");
  utimesSync(entry, mtime, mtime);
  configureRuntimeEntry(new URL(`file://${entry}`).href);
  return entry;
}

function writeSource(root: string, rel: string, mtime: Date): string {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "src");
  utimesSync(full, mtime, mtime);
  return full;
}

describe("runtime freshness", () => {
  it("treats an entry updated after boot as stale (process)", () => {
    const directory = makeRuntimeDir();
    const future = new Date(Date.now() + 60_000);
    writeEntry(directory, future);

    try {
      expect(getRuntimeStatus()).toMatchObject({
        entryMtime: future.toISOString(),
        stale: true,
        staleReason: "process",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats an unavailable entry as not stale", () => {
    configureRuntimeEntry(
      new URL("file:///definitely/missing/coagenthub-entry.mjs").href,
    );

    expect(getRuntimeStatus()).toMatchObject({
      entryMtime: null,
      stale: false,
      staleReason: null,
    });
  });

  it("reports build staleness when source is newer than the entry", () => {
    const directory = makeRuntimeDir();
    const entryTime = new Date(Date.now() - 60_000);
    writeEntry(directory, entryTime);
    const src = join(directory, "src");
    const srcTime = new Date(Date.now() - 30_000);
    writeSource(src, "index.ts", srcTime);
    configureSourceScanRoots([src]);

    try {
      expect(getRuntimeStatus()).toMatchObject({
        entryMtime: entryTime.toISOString(),
        stale: true,
        staleReason: "build",
        newestSourceMtime: srcTime.toISOString(),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports both when the entry is newer than boot and source is newer than entry", () => {
    const directory = makeRuntimeDir();
    const entryTime = new Date(Date.now() + 60_000);
    writeEntry(directory, entryTime);
    const src = join(directory, "src");
    const srcTime = new Date(Date.now() + 120_000);
    writeSource(src, "index.ts", srcTime);
    configureSourceScanRoots([src]);

    try {
      expect(getRuntimeStatus()).toMatchObject({
        stale: true,
        staleReason: "both",
        newestSourceMtime: srcTime.toISOString(),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports not stale when neither process nor build is stale", () => {
    const directory = makeRuntimeDir();
    const entryTime = new Date(Date.now() - 60_000);
    writeEntry(directory, entryTime);
    const src = join(directory, "src");
    // 源码早于 entry → 构建不落后;entry 早于启动 → 进程不陈旧。
    const srcTime = new Date(Date.now() - 120_000);
    writeSource(src, "index.ts", srcTime);
    configureSourceScanRoots([src]);

    try {
      expect(getRuntimeStatus()).toMatchObject({
        stale: false,
        staleReason: null,
        newestSourceMtime: srcTime.toISOString(),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("skips node_modules, test, and dist during the scan", () => {
    const directory = makeRuntimeDir();
    const entryTime = new Date(Date.now() - 60_000);
    writeEntry(directory, entryTime);
    const src = join(directory, "src");
    // 真实源码:早于 entry → 不陈旧。
    const realTime = new Date(Date.now() - 120_000);
    writeSource(src, "index.ts", realTime);
    // 排除目录里的文件比一切都新 —— 若被扫到会误判 build 陈旧。
    const excludedTime = new Date(Date.now() + 120_000);
    for (const dir of ["node_modules", "test", "dist"]) {
      writeSource(src, join(dir, "newer.ts"), excludedTime);
    }
    configureSourceScanRoots([src]);

    try {
      const status = getRuntimeStatus();
      expect(status.newestSourceMtime).toBe(realTime.toISOString());
      expect(status).toMatchObject({ stale: false, staleReason: null });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("caches the scan so consecutive probes do not rescan", () => {
    const directory = makeRuntimeDir();
    const entryTime = new Date(Date.now() - 60_000);
    writeEntry(directory, entryTime);
    const src = join(directory, "src");
    const first = new Date(Date.now() - 120_000);
    writeSource(src, "a.ts", first);
    configureSourceScanRoots([src]);

    try {
      const before = getRuntimeStatus();
      expect(before.newestSourceMtime).toBe(first.toISOString());

      // 缓存 TTL 内新增更新的文件:不重扫,结果保持旧值。
      const second = new Date(Date.now() + 60_000);
      writeSource(src, "b.ts", second);

      expect(getRuntimeStatus().newestSourceMtime).toBe(first.toISOString());

      resetSourceScanCache();
      const rescanned = getRuntimeStatus();
      expect(rescanned.newestSourceMtime).toBe(second.toISOString());
      expect(rescanned.staleReason).toBe("build");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats a scan failure as not stale", () => {
    const directory = makeRuntimeDir();
    const entryTime = new Date(Date.now() - 60_000);
    writeEntry(directory, entryTime);
    configureSourceScanRoots([join(directory, "missing-src")]);

    try {
      const status = getRuntimeStatus();
      expect(status).toMatchObject({ stale: false, staleReason: null });
      expect(status.newestSourceMtime).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
