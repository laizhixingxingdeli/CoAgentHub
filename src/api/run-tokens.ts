/**
 * Run Token：平台发给某一次 attempt 的凭据。
 *
 * 运行时（以及跑在里面的 agent）拿到的只有这个 token，**不是** missionId +
 * attemptId + role 的自述。所有工具调用的身份都从 token 解出来——这样
 * "执行者不得改 Plan"就不依赖调用方诚实填写自己的角色。
 */

import { randomUUID } from 'node:crypto';

export interface RunContext {
  readonly token: string;
  readonly missionId: string;
  readonly attemptId: string;
  readonly role: 'coordinator' | 'executor' | 'independent_reviewer';
  readonly workItemId?: string;
  /**
   * 发牌时冻结的队列领取身份。只从这里带到写事务，不从请求体读 owner/代次。
   * 缺省表示非队列 Run；队列 Attempt 不得发无 claim 的牌。
   */
  readonly claim?: {
    readonly id: string;
    readonly owner: string;
    readonly claimGeneration: number;
  };
}

export class RunTokenRegistry {
  #byToken = new Map<string, RunContext>();

  issue(input: Omit<RunContext, 'token'>): RunContext {
    const token = randomUUID();
    const claim = input.claim
      ? Object.freeze({
          id: input.claim.id,
          owner: input.claim.owner,
          claimGeneration: input.claim.claimGeneration,
        })
      : undefined;
    const context: RunContext = Object.freeze({
      missionId: input.missionId,
      attemptId: input.attemptId,
      role: input.role,
      ...(input.workItemId !== undefined ? { workItemId: input.workItemId } : {}),
      ...(claim ? { claim } : {}),
      token,
    });
    this.#byToken.set(token, context);
    return context;
  }

  resolve(token: string | undefined): RunContext | undefined {
    return token ? this.#byToken.get(token) : undefined;
  }

  /** attempt 收尾后立刻吊销：迟到的工具调用应该被拒绝而不是静默生效。 */
  revoke(token: string): void {
    this.#byToken.delete(token);
  }

  /**
   * 按 Attempt 吊销全部凭据。
   *
   * HTTP finish 的权威事实是 URL 里的 missionId + attemptId，不该依赖调用方把 token
   * 再抄进请求体；同一 Attempt 即使意外发过不止一个 token，也一起失效。
   */
  revokeAttempt(missionId: string, attemptId: string): void {
    for (const [token, context] of this.#byToken) {
      if (context.missionId === missionId && context.attemptId === attemptId) {
        this.#byToken.delete(token);
      }
    }
  }
}
