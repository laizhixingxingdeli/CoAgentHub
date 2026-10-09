/**
 * 默认适配层入口的定位：优先仓内 adapters/pi，找不到就报错，
 * 而不是静默落到一个个人机器的绝对路径上。
 *
 * 相对**本文件**定位，不是相对进程 cwd。从 Mission 的 worktree 里起进程时
 * cwd 是 `.coagent-worktrees/<mission>/`，按 cwd 猜会指向不存在的地方。
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRootFromHere(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** 仓内适配层入口的默认位置：<repoRoot>/adapters/pi/src/agent-entry.ts。 */
export function defaultAdapterEntryPath(repoRoot?: string): string {
  return resolve(repoRoot ?? repoRootFromHere(), 'adapters', 'pi', 'src', 'agent-entry.ts');
}

/**
 * 解析跑 Mission / Plan 用的 --adapter：
 *   - 显式给了非空路径就用它，不检查文件是否存在（兼容非默认布局）。
 *   - 没给就用仓内默认入口；默认入口不存在时**报错**，文案指到 setup 与 --adapter，
 *     不静默往下走。
 */
export function resolveRunAdapter(explicit: string | undefined, repoRoot?: string): string {
  if (explicit) return resolve(explicit);
  const defaultEntry = defaultAdapterEntryPath(repoRoot);
  if (!existsSync(defaultEntry)) {
    throw new Error(
      `找不到默认适配层入口 ${defaultEntry}。请先运行 node scripts/coagent.mjs setup，或用 --adapter 指定 agent-entry.ts 的路径。`,
    );
  }
  return defaultEntry;
}
