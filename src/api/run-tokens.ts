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
  /**
   * 发牌目的。'impact' 表示这张牌只做影响判断：HTTP 面把它当只读身份处理，
   * 只允许两个专属工具（读请求 / 提交判断），其余一切入口照旧拒绝。
   * 与 changeId 严格配对——少了 changeId 就分不清是哪一次变更的判断。
   * 这个字段只由可信调用方在 issue 时给，**永远不从请求体读**。
   *
   * 一条限权写就够了：impact 牌唯一的写是把这次判断的事实落库。再开一格
   * 写（哪怕「看起来是同类」）都会让「只读身份」这个说法失去意义。
   * 签发**没有** HTTP 入口——body 里自称什么也换不来这张牌。
   */
  readonly purpose?: 'impact';
  readonly changeId?: string;
}

export class RunTokenRegistry {
  #byToken = new Map<string, RunContext>();

  issue(input: Omit<RunContext, 'token'>): RunContext {
    // 校验必须在 randomUUID / 写入 Map 之前：非法输入不该消耗一个 token，
    // 也不该在表里留下半张牌。
    const purpose = validatePurpose(input);
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
      ...(purpose ? { purpose: purpose.purpose, changeId: purpose.changeId } : {}),
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

/**
 * purpose / changeId 的可信配对校验。只有 issue 会调它。
 *
 * 这两个字段必须严格配对且只由可信调用方给出：给一半（有 changeId 无 purpose、
 * 或有 purpose 无 changeId）都会让「哪张牌算 impact」变得含糊，而含糊的边界
 * 在 HTTP 面就是「我记得我是只读」。没有完整 claim 的 impact 牌同样不签——
 * 它要带着队列身份去过 fence，否则和其它 Queue Claim 门禁不一致。
 */
function validatePurpose(
  input: Omit<RunContext, 'token'>,
): { readonly purpose: 'impact'; readonly changeId: string } | undefined {
  // 缺省即普通牌：旧调用方一行都不用改。
  if (input.purpose === undefined && input.changeId === undefined) return undefined;
  if (input.purpose !== 'impact' || input.changeId === undefined) {
    throw new Error('purpose 与 changeId 必须同时给出，且 purpose 只能是 impact');
  }
  if (input.changeId.trim().length === 0) {
    throw new Error('changeId 必须是 trim 后非空字符串');
  }
  if (input.role !== 'coordinator') {
    throw new Error('impact 牌只能发给 coordinator');
  }
  if (!input.claim) throw new Error('impact 牌必须带队列领取身份');
  if (input.claim.id.trim().length === 0 || input.claim.owner.trim().length === 0) {
    throw new Error('impact 牌的 claim id / owner 必须是 trim 后非空字符串');
  }
  if (!Number.isSafeInteger(input.claim.claimGeneration) || input.claim.claimGeneration <= 0) {
    throw new Error('impact 牌的 claimGeneration 必须是正整数');
  }
  return { purpose: 'impact', changeId: input.changeId };
}
