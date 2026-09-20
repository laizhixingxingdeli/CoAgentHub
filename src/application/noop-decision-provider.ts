/**
 * NoopDecisionProvider —— DecisionProvider 的缺省实现。
 *
 * 对任意合法请求恒返回 `{ answers: {} }`。无网络、无状态写入、确定性。
 * 不读 hook、不认识 PRE_DISPATCH_V1 question ids、不预填四个 noop。
 * 存在的理由与 ScriptedRuntime 对称：端口从第一天就有可运行的第二个实现路径
 * （测试里再放一个内联 provider），避免接口长成某一供应商的形状。
 */

import type { DecisionAnswerSet, DecisionProvider, DecisionRequest } from './ports.ts';

export class NoopDecisionProvider implements DecisionProvider {
  readonly kind = 'noop';

  async decide(_request: DecisionRequest): Promise<DecisionAnswerSet> {
    return { answers: {} };
  }
}
