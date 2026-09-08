/**
 * Windows 假执行器启动助手(specs/windows-test-baseline-fake-executor.md)。
 *
 * 测试里用 `#!/bin/sh` 脚本 + chmod 当 bin;Windows 无法直接 spawn `.sh`。
 * 本助手只改「怎么把脚本变成可 spawn 的 bin」,不改脚本内容:
 *  - 非 win32:原样返回脚本路径,argsPrefix 为空 —— 与历史行为逐字一致;
 *  - win32:bin = Git for Windows 的 sh.exe,argsPrefix = [scriptPath],
 *    调用方把 argsPrefix 拼在原有 args 最前面即可。
 *
 * 找不到 sh 时抛可读错误,不静默回退成直接 spawn `.sh`。
 */
import { existsSync } from "node:fs";
import path from "node:path";

/** 覆盖 sh.exe 定位;指向不存在的路径时立即失败(便于验收/排障)。 */
export const FAKE_EXECUTOR_SH_ENV = "COAGENTHUB_TEST_SH";

export interface FakeExecutorBin {
  bin: string;
  argsPrefix: string[];
}

function gitShCandidates(): string[] {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 =
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    path.join(programFiles, "Git", "usr", "bin", "sh.exe"),
    path.join(programFilesX86, "Git", "usr", "bin", "sh.exe"),
    "C:/Program Files/Git/usr/bin/sh.exe",
    "C:/Program Files (x86)/Git/usr/bin/sh.exe",
  ];
  if (localAppData) {
    candidates.push(
      path.join(localAppData, "Programs", "Git", "usr", "bin", "sh.exe"),
    );
  }
  return candidates;
}

function missingShError(detail: string): Error {
  return new Error(
    `Windows 上运行假执行器脚本需要 Git for Windows 的 sh.exe,但未找到可执行的 sh。${detail} ` +
      `请安装 Git for Windows,或设置环境变量 ${FAKE_EXECUTOR_SH_ENV} 指向 sh.exe 的绝对路径。`,
  );
}

/** 定位 sh.exe:环境变量覆盖优先,否则扫常见 Git for Windows 路径。 */
export function resolveGitSh(): string {
  const override = process.env[FAKE_EXECUTOR_SH_ENV];
  if (override !== undefined && override !== "") {
    if (!existsSync(override)) {
      throw missingShError(
        `环境变量 ${FAKE_EXECUTOR_SH_ENV}="${override}" 指向的路径不存在。`,
      );
    }
    return override;
  }
  for (const candidate of gitShCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  throw missingShError(`已尝试: ${gitShCandidates().join(", ")}。`);
}

/**
 * 把假执行器脚本路径变成可 spawn 的 `{ bin, argsPrefix }`。
 * 调用方: `spawn(bin, [...argsPrefix, ...originalArgs])`(argsPrefix 在最前)。
 */
export function resolveFakeExecutor(scriptPath: string): FakeExecutorBin {
  if (process.platform !== "win32") {
    return { bin: scriptPath, argsPrefix: [] };
  }
  return { bin: resolveGitSh(), argsPrefix: [scriptPath] };
}

/** 把 argsPrefix 拼到原 args 最前面;prefix 为空时返回原数组(引用不变)。 */
export function withFakeExecutorArgs(
  argsPrefix: string[],
  args: string[],
): string[] {
  if (argsPrefix.length === 0) return args;
  return [...argsPrefix, ...args];
}
