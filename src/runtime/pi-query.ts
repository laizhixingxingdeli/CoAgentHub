/**
 * 可信 Pi Query runtime 装配（opt-in）。
 *
 * 默认关闭：只有明确双键启用且 adapter 路径真实存在时，才构造
 * `supportsQuery: true` 的 SpawnRuntime。不按 kind / store / basename 猜安全性，
 * 也不 hardcode 本机 Pi 仓路径。
 *
 * 本装配只服务可编程 `runQuery`；不开放 HTTP/CLI query surface，
 * 也不改 Mission 用的 Spawn 构造。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SpawnRuntime } from './spawn.ts';

/**
 * 从 env 尝试装配只读 Query 用的 Pi SpawnRuntime。
 *
 * 启用条件（缺任一项 → undefined）：
 *   - `COAGENT_QUERY_ENABLED === '1'`
 *   - `COAGENT_QUERY_ADAPTER` 非空
 *   - resolve 后的 adapter 路径真实存在
 *
 * 调用方应传入已解析的 env（如 startServer 的 options.env），避免测试注入
 * 后偷偷回落到真实 process.env 的 query 配置。
 */
export function createPiQueryRuntime(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): SpawnRuntime | undefined {
  if (env.COAGENT_QUERY_ENABLED !== '1') return undefined;

  const adapterRaw = env.COAGENT_QUERY_ADAPTER;
  if (typeof adapterRaw !== 'string' || adapterRaw.trim() === '') return undefined;

  const adapter = resolve(adapterRaw);
  if (!existsSync(adapter)) return undefined;

  return new SpawnRuntime({
    kind: 'pi',
    command: 'npx',
    args: ['tsx', adapter],
    cwd: resolve(adapter, '../..'),
    timeoutMs: 5 * 60 * 1000,
    stream: false,
    supportsQuery: true,
  });
}
