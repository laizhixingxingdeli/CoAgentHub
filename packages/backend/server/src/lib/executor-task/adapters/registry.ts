import type { ExecutorAdapter } from "./types";

export type { ExecutorAdapter } from "./types";

import { observeUnknownExecutorKey } from "../output-parser";
import { atomcodeAdapter } from "./atomcode";
import { claudeAdapter } from "./claude";
import { codebuddyAdapter } from "./codebuddy";
import { codexAdapter } from "./codex";
import { executorAdapter } from "./executor";
import { piAdapter } from "./pi";

/**
 * 执行器适配注册表(spec: executor-adapter-registry)。
 *
 * 覆盖集与重构前逐字一致(含三处本就不同的分支,这是漂移的证据,不补齐):
 *
 * | key      | parser               | token                  | finalText                     |
 * |----------|----------------------|------------------------|-------------------------------|
 * | codex    | createCodexParser    | tokenUsageFromCodexJsonl | extractCodexExecText        |
 * | codebuddy| createCodeBuddyParser| collectCodeBuddy        | extractCodeBuddyStreamResult  |
 * | pi       | createPiParser       | (无,通用+trusted)       | (无)                          |
 * | claude   | (无)                 | collectClaude           | (无)                          |
 * | atomcode | createAtomCodeParser | (无)                    | (无)                          |
 * | executor | createAtomCodeParser | collectAtomCode         | (无)                          |
 *
 * 新增一家 = 新增一个文件 + 此处一行,零处修改既有分支(spec 硬验收 3)。
 */
const ADAPTERS = new Map<string, ExecutorAdapter>([
  ["codex", codexAdapter],
  ["codebuddy", codebuddyAdapter],
  ["atomcode", atomcodeAdapter],
  ["executor", executorAdapter],
  ["claude", claudeAdapter],
  ["pi", piAdapter],
]);

/**
 * 按 executor key 取适配器。未命中 → 空对象(全走缺省通用实现),并沿用
 * `observeUnknownExecutorKey` 的口径记一次去重观测日志(spec R2)——未知 key
 * 不抛错,只降级到通用路径。
 */
export function adapterFor(key: string): ExecutorAdapter {
  const found = ADAPTERS.get(key);
  if (found) return found;
  observeUnknownExecutorKey(key);
  return {};
}
