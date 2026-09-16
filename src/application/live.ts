/**
 * 实时输出通道（S11.3 第三层的"正在发生"那一半）。
 *
 * 要解决的具体问题：**调度器和观测面是两个进程。** 调度器那边 agent 正一行行
 * 往外吐，观测面这边什么都看不到，只能等整跳结束后一次性拿到尾部。跑一次
 * 协调者要两三分钟，这两三分钟里界面上是死的——人没法判断它是在干活还是卡住了。
 *
 * 所以这不能是一个内存里的 EventEmitter。它得是个端口，跨进程的那个实现
 * 才是真正会用的那个。
 *
 * 游标语义：调用方记住上次拿到的 `cursor`，下次带上，只取之后的。
 * 不做订阅推送——轮询一个带索引的自增列足够快，而且天然能续上（刷新页面、
 * 断线重连都不丢），推送还得自己处理这些。
 */

import type { TokenUsage } from '../kernel/index.ts';

export interface LiveChunk {
  /** 单调自增，用作游标。 */
  readonly seq: number;
  readonly missionId: string;
  readonly attemptId: string;
  readonly at: string;
  readonly kind: 'text' | 'tool' | 'usage' | 'note';
  /** kind=text/tool/note 时是正文；usage 时为空。 */
  readonly text?: string;
  /** kind=usage 时的累计用量。 */
  readonly usage?: TokenUsage;
}

export interface LiveOutput {
  append(chunk: Omit<LiveChunk, 'seq' | 'at'>): Promise<void>;
  /** 取 `cursor` 之后的；不传 cursor 表示从头。 */
  since(missionId: string, cursor?: number, limit?: number): Promise<readonly LiveChunk[]>;
  /** 一跳结束后把它的实时缓冲清掉——最终输出已经落在 Attempt 上了。 */
  finish?(attemptId: string): Promise<void>;
}

/**
 * 同进程版。测试与「调度器和界面在一个进程里」的场景用。
 *
 * 带上限：实时输出是**看**的，不是存的。一跳能吐几十万字符，全留着就是
 * 拿内存换一段没人会往回翻那么远的历史。
 */
export class InMemoryLiveOutput implements LiveOutput {
  #chunks: LiveChunk[] = [];
  #seq = 0;
  #limit: number;

  constructor(limit = 5_000) {
    this.#limit = limit;
  }

  async append(chunk: Omit<LiveChunk, 'seq' | 'at'>): Promise<void> {
    this.#seq += 1;
    this.#chunks.push({ ...chunk, seq: this.#seq, at: new Date().toISOString() });
    if (this.#chunks.length > this.#limit) {
      this.#chunks.splice(0, this.#chunks.length - this.#limit);
    }
  }

  async since(missionId: string, cursor = 0, limit = 500): Promise<readonly LiveChunk[]> {
    return this.#chunks
      .filter((c) => c.missionId === missionId && c.seq > cursor)
      .slice(0, limit);
  }

  async finish(attemptId: string): Promise<void> {
    this.#chunks = this.#chunks.filter((c) => c.attemptId !== attemptId);
  }
}

/** 什么都不做。不需要实时输出时装这个，省得到处判空。 */
export class NoLiveOutput implements LiveOutput {
  async append(): Promise<void> {}
  async since(): Promise<readonly LiveChunk[]> {
    return [];
  }
}
