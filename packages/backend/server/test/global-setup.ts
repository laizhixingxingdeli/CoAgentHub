import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 陈旧临时目录清扫(2026-09-07):afterAll 的清理只在**正常结束**时跑;
 * 测试被中断(Ctrl-C / worker 崩溃 / CI 超时)时留下的目录永远没人收。
 * 实测积累到 **226 个 coagenthub-test-repo-*、267MB**。
 * 启动时扫掉 6 小时前的同名目录:比这更新的可能属于并行跑的另一个 worker,不碰。
 *
 * 调用时机:vitest globalSetup(每轮一次),不再每个测试文件 setupFiles 扫一遍
 * 整个系统临时目录(specs/test-dependency-classification.md T2 / R3)。
 */
function sweepStaleTestDirs(): void {
  const prefixes = ["coagenthub-test-repo-", "coagenthub-test-files-"];
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const name of entries) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    const full = path.join(tmpdir(), name);
    try {
      if (statSync(full).mtimeMs > cutoff) continue;
      rmSync(full, { recursive: true, force: true });
    } catch {
      // 并行 worker 可能正在用或已删,跳过即可 —— 清扫是尽力而为,不得抛错。
    }
  }
}

export default function globalSetup(): void {
  sweepStaleTestDirs();
}
