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
  readonly role: 'coordinator' | 'executor';
  readonly workItemId?: string;
}

export class RunTokenRegistry {
  #byToken = new Map<string, RunContext>();

  issue(input: Omit<RunContext, 'token'>): RunContext {
    const token = randomUUID();
    const context: RunContext = Object.freeze({ ...input, token });
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
}
