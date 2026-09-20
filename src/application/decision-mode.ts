/**
 * Decision 运行模式（Phase 2 前最小诚实配置）。
 *
 * - OFF：完全不可见，不调用 provider、不写 decision 事件
 * - SHADOW：显式 mode + factory 注入 provider；否则启动 fail-closed
 */

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
