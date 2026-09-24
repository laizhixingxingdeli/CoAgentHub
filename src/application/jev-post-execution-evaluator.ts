/**
 * Jev 的 POST_EXECUTION 评估（J2）。
 *
 * 与 PRE 共用同一个 System One HTTP 传输：线上是同一个端点、同样的 {state, questions, model} 外形。
 * 请求与答案映射全用 jev-post-execution-mapper 的纯函数——E4 已经对真 API 验过它们兼容，这里不另写一套。
 */

import { buildJevPostExecutionRequest, mapJevPostExecutionResponse } from './jev-post-execution-mapper.ts';
import type { JevPostExecutionResponse } from './jev-post-execution-mapper.ts';
import type { JevSystemOneTransport } from './jev-decision-provider.ts';
import type { PostExecutionRemoteState } from './post-execution-remote-input.ts';
import type { PostExecutionState } from './post-execution-state.ts';
import type { DecisionAnswerSet, PostExecutionEvaluator } from './ports.ts';

const DEFAULT_MODEL = 'jev-latest';

export interface JevPostExecutionEvaluatorOptions {
  readonly transport: JevSystemOneTransport;
  readonly model?: string;
}

export class JevPostExecutionEvaluator implements PostExecutionEvaluator {
  readonly kind = 'jev-system-one';

  #transport: JevSystemOneTransport;
  #model: string;

  constructor(options: JevPostExecutionEvaluatorOptions) {
    this.#transport = options.transport;
    this.#model = options.model ?? DEFAULT_MODEL;
  }

  async evaluate(state: PostExecutionRemoteState): Promise<DecisionAnswerSet> {
    // 远端投影只多了 truncation 的计量字段，是 PostExecutionState 的超集；mapper 原样引用、不重投影。
    const request = buildJevPostExecutionRequest(state as unknown as PostExecutionState, this.#model);
    // 传输层的类型是照 PRE 写的；POST 走同一个端点，外形一致。
    const response = await this.#transport.systemOne(request as never);
    return mapJevPostExecutionResponse(response as unknown as JevPostExecutionResponse, request.questions);
  }
}
