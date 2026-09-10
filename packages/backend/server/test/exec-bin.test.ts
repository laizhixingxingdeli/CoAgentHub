import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  isExecutableFile,
  MAX_BIN_LENGTH,
  resolveBin,
} from "../src/lib/exec-bin";

/**
 * bin 可执行性探测单元测试(exec-bin.ts):
 *  - resolveBin 注入 PATH,确定性验证命令名查找(命中/未命中/空段跳过);
 *  - 绝对路径直接检查(存在可执行 / 不存在 / 目录不算);
 *  - isExecutableFile 排除目录与非可执行文件。
 */

const dir = mkdtempSync(path.join(tmpdir(), "coagenthub-exec-bin-"));
const exePath = path.join(dir, "probe-ok");
const noExecPath = path.join(dir, "probe-noexec");
writeFileSync(exePath, "#!/bin/sh\nexit 0\n");
chmodSync(exePath, 0o755);
writeFileSync(noExecPath, "not executable\n");
chmodSync(noExecPath, 0o644);

/** 注入的 PATH:两个真实目录之间夹一个空段。 */
const injectedPath = `${dir}${path.delimiter}${path.delimiter}/usr/local/bin`;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("isExecutableFile", () => {
  it("可执行文件 → true", () => {
    expect(isExecutableFile(exePath)).toBe(true);
  });

  it("存在的普通文件但无执行位 → false", () => {
    expect(isExecutableFile(noExecPath)).toBe(false);
  });

  it("不存在的路径 → false", () => {
    expect(isExecutableFile(path.join(dir, "no-such-file"))).toBe(false);
  });

  it("目录(即使可搜索)→ false", () => {
    expect(isExecutableFile(dir)).toBe(false);
  });
});

describe("resolveBin", () => {
  it("命令名命中 PATH → 返回该目录下的绝对路径", () => {
    expect(resolveBin("probe-ok", injectedPath)).toBe(exePath);
  });

  it("PATH 中的空段被跳过,不影响后续目录查找", () => {
    expect(
      resolveBin("probe-ok", `${path.delimiter}${path.delimiter}${dir}`),
    ).toBe(exePath);
  });

  it("命令名未命中 PATH → null", () => {
    expect(resolveBin("no-such-cmd-9f3a", injectedPath)).toBeNull();
  });

  it("PATH 里的文件无执行位 → 不算命中", () => {
    expect(resolveBin("probe-noexec", injectedPath)).toBeNull();
  });

  it("绝对路径存在且可执行 → 返回该路径(不经 PATH)", () => {
    expect(resolveBin(exePath)).toBe(exePath);
  });

  it("绝对路径不存在 → null", () => {
    expect(resolveBin(path.join(dir, "no-such-abs"))).toBeNull();
  });

  it("绝对路径指向目录 → null", () => {
    expect(resolveBin(dir)).toBeNull();
  });

  it("MAX_BIN_LENGTH 与路由校验上限一致", () => {
    expect(MAX_BIN_LENGTH).toBe(200);
  });
});
