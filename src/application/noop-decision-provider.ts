/**
 * NoopDecisionProvider —— DecisionProvider 的缺省实现。
 *
 * 对任意合法请求恒返回 `{ kind: 'noop' }`。无网络、无状态写入、确定性。
 * 存在的理由与 ScriptedRuntime 对称：端口从第一天就有可运行的第二个实现路径
 * （测试里再放一个内联 provider），避免接口长成某一供应商的形状。
 */

import type { DecisionProvider, DecisionRequest, DecisionSignal } from './ports.ts';

export class NoopDecisionProvider implements DecisionProvider {
  readonly kind = 'noop';

  async decide(_request: DecisionRequest): Promise<DecisionSignal> {
    return { kind: 'noop' };
  }
}
