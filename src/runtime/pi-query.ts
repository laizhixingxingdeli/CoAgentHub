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
import {
  parseAgentEnvPassthrough,
  SPAWN_ENV_PASSTHROUGH_VAR,
  SPAWN_ENV_UNDECLARED_MESSAGE,
  SpawnRuntime,
} from './spawn.ts';

/**
 * 从 env 尝试装配只读 Query 用的 Pi SpawnRuntime。
 *
 * 启用条件（缺任一项 → undefined，且**不**为透传名单抛错——观测-only 服务器
 * 不该因为没声明 agent env 而起不来）：
 *   - `COAGENT_QUERY_ENABLED === '1'`
 *   - `COAGENT_QUERY_ADAPTER` 非空
 *   - resolve 后的 adapter 路径真实存在
 *
 * 一旦上面三项齐备、即将构造 SpawnRuntime：必须在**同一份注入 env**里声明
 * `COAGENT_AGENT_ENV_PASSTHROUGH`，否则 throw（不是 undefined）。Query 子进程
 * 同样是 `npx tsx adapter`，同样会碰模型凭证；漏名单 = 漏整份 env。
 *
 * 调用方应传入已解析的 env（如 startServer 的 options.env），避免测试注入
 * 后偷偷回落到真实 process.env 的 query / passthrough 配置。
 */
export function createPiQueryRuntime(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): SpawnRuntime | undefined {
  if (env.COAGENT_QUERY_ENABLED !== '1') return undefined;

  const adapterRaw = env.COAGENT_QUERY_ADAPTER;
  if (typeof adapterRaw !== 'string' || adapterRaw.trim() === '') return undefined;

  const adapter = resolve(adapterRaw);
  if (!existsSync(adapter)) return undefined;

  // 只读注入 env 上的键，不回落 process.env——否则测试里「宿主已声明、注入未声明」
  // 会悄悄放过，和生产「只认 startServer 传入的 env」合同不一致。
  const envPassthrough = parseAgentEnvPassthrough(env[SPAWN_ENV_PASSTHROUGH_VAR]);
  if (envPassthrough === undefined) {
    throw new Error(SPAWN_ENV_UNDECLARED_MESSAGE);
  }

  return new SpawnRuntime({
    kind: 'pi',
    command: 'npx',
    args: ['tsx', adapter],
    cwd: resolve(adapter, '../..'),
    timeoutMs: 5 * 60 * 1000,
    stream: false,
    supportsQuery: true,
    envPassthrough,
    // 不把 query-config 对象当 child env 下发：那份只有 COAGENT_QUERY_* 等接线键，
    // 缺 PATH/代理；child 源仍是 start() 时的 process.env，再经 filter 收紧。
  });
}
