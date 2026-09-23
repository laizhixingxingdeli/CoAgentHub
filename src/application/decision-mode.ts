/**
 * Decision 运行模式（Phase 2 前最小诚实配置）。
 *
 * - OFF：完全不可见，不调用 provider、不写 decision 事件
 * - SHADOW：显式 mode + factory 注入 provider；否则启动 fail-closed
 */

import type { DecisionHook } from './ports.ts';

export type DecisionMode = 'off' | 'shadow';

/**
 * 解析 COAGENT_DECISION_MODE。
 * 缺省 / 空 / off → off；shadow → shadow；未知值 fail-closed 为 off（不抛）。
 */
export function parseDecisionMode(raw: string | undefined | null): DecisionMode {
  if (raw == null) return 'off';
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === '' || normalized === 'off') return 'off';
  if (normalized === 'shadow') return 'shadow';
  return 'off';
}

/**
 * 哪些钩子跑 shadow（`COAGENT_DECISION_HOOKS`，逗号分隔）。**只在 shadow 模式下读。**
 *
 * 缺省只含 POST_EXECUTION：E3 实测，PRE_DISPATCH 在远端默认拒绝（只发 ID）下答案是常数，
 * 三道题都比「全猜多数类」还差——每次派发多等几百毫秒换一个常数。要看 PRE 就显式写上。
 * 认识：pre_dispatch / pre-dispatch / pre，post_execution / post-execution / post；
 * `none` 或全是不认识的词 = 一个都不跑。不认识的词忽略，与 parseDecisionMode 未知值按 off
 * 处理一致：配置写错时宁可少调，不多调。
 */
export function parseDecisionHooks(raw: string | undefined | null): ReadonlySet<DecisionHook> {
  if (raw == null || String(raw).trim() === '') return new Set<DecisionHook>(['POST_EXECUTION']);
  const hooks = new Set<DecisionHook>();
  for (const token of String(raw).split(',')) {
    const word = token.trim().toLowerCase().replace(/-/g, '_');
    if (word === 'pre_dispatch' || word === 'pre') hooks.add('PRE_DISPATCH');
    else if (word === 'post_execution' || word === 'post') hooks.add('POST_EXECUTION');
  }
  return hooks;
}

/**
 * 启动门禁：shadow 且无 provider 时抛明确配置错误。
 * 必须在打开 store / lock / listen 之前调用。
 */
export function assertDecisionModeStartup(options: {
  mode: DecisionMode;
  providerAvailable: boolean;
}): void {
  if (options.mode === 'shadow' && !options.providerAvailable) {
    throw new Error('shadow requested but no DecisionProvider injected');
  }
}
