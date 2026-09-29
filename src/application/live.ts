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

/**
 * 一跳结束后给它留多少行。
 *
 * 曾经是 0 —— `finish()` 把整跳的行全删掉，理由写的是"最终输出已经落在
 * Attempt 上了"。**那句话是错的**：实测 Attempt.output 只有 1.4 KB
 * （末尾一小段 + 工具名清单），而一跳真正吐出来的是上万行。于是跑完的任务
 * 一律只剩一个空面板；反倒是**崩掉的**那些跳因为 finish 没执行，行全留着。
 * 留存策略正好反了。
 *
 * 改成留尾巴。实时输出是**看**的不是存的，全留没意义；但一行不留是在删证据。
 * 尾部 500 行覆盖了"它最后在干什么、怎么结束的"这个回头最常问的问题，
 * 按实测每行约 130 字节算，十几跳的 Mission 也就一两 MB。
 */
export const KEEP_TAIL_ON_FINISH = 500;

export interface LiveOutput {
  append(chunk: Omit<LiveChunk, 'seq' | 'at'>): Promise<void>;
  /** 取 `cursor` 之后的；不传 cursor 表示从头。 */
  since(missionId: string, cursor?: number, limit?: number): Promise<readonly LiveChunk[]>;
  /**
   * 一跳结束后按 missionId + attemptId 裁剪它的实时缓冲，只留尾部若干行。
   * Attempt ID 只保证 Mission 内唯一，不能单独作为清理键。
   *
   * 裁掉多少**必须留下痕迹**（补一条 kind='note'）。悄悄截断的日志比没有日志
   * 更坏：人会把看到的那一段当成全部，然后在一段被裁掉的历史上做判断。
   */
  finish?(missionId: string, attemptId: string): Promise<void>;
}

/**
 * 裁剪痕迹的正文。
 *
 * 它排在被留下的行**后面**（append-only 的表没法往前插）。所以它不是正文的
 * 一部分，界面要把它拎出来挂在终端上方当横幅——混在末尾会被读成
 * "接下来还有"，而它说的是"前面没了"。
 */
export function truncationNote(dropped: number, kept: number): string {
  return `实时输出已裁剪：本跳共 ${dropped + kept} 行，只保留最后 ${kept} 行。`;
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

  async finish(missionId: string, attemptId: string): Promise<void> {
    const mine = this.#chunks.filter(
      (c) => c.missionId === missionId && c.attemptId === attemptId,
    );
    if (mine.length <= KEEP_TAIL_ON_FINISH) return;
    const keep = new Set(mine.slice(-KEEP_TAIL_ON_FINISH).map((c) => c.seq));
    this.#chunks = this.#chunks.filter(
      (c) => c.missionId !== missionId || c.attemptId !== attemptId || keep.has(c.seq),
    );
    await this.append({
      missionId: mine[0].missionId,
      attemptId,
      kind: 'note',
      text: truncationNote(mine.length - KEEP_TAIL_ON_FINISH, KEEP_TAIL_ON_FINISH),
    });
  }
}

/** 什么都不做。不需要实时输出时装这个，省得到处判空。 */
export class NoLiveOutput implements LiveOutput {
  async append(): Promise<void> {}
  async since(): Promise<readonly LiveChunk[]> {
    return [];
  }
}

/** 托管方案 CLI 行的内存上限，与 InMemoryLiveOutput 缺省同量级。 */
export const PLAN_LIVE_LIMIT = 5_000;

/**
 * 缓冲为空时给观测面的原因。记录文件可能还在：实时行只活在本进程，
 * 重启或从未由本服务托管都会变成空；不写 reason 的话终端会像「还没开始」。
 */
export const PLAN_LIVE_EMPTY_REASON =
  '没有服务托管记录，或服务重启后实时输出已清空';

export type PlanLiveChannel = 'stdout' | 'stderr';

export interface PlanLiveChunk {
  /** 单调自增，用作游标。 */
  readonly seq: number;
  readonly runId: string;
  readonly at: string;
  readonly channel: PlanLiveChannel;
  readonly line: string;
}

/**
 * 托管 run-plan 的 CLI 行。与任务 LiveOutput 分开：任务通道按 mission/attempt，
 * 这里按 runId + stdout/stderr；混进同一张表会让任务页读到方案行，或反过来。
 * 不落盘——重启即空，空响应必须带 reason，不能装成还没开跑。
 */
export interface PlanRunLiveOutput {
  append(chunk: { runId: string; channel: PlanLiveChannel; line: string }): void;
  since(runId: string, cursor?: number, limit?: number): readonly PlanLiveChunk[];
  /** 本进程是否为该 runId 写过托管行。重启后全否。 */
  hosted(runId: string): boolean;
}

export class InMemoryPlanRunLiveOutput implements PlanRunLiveOutput {
  #chunks: PlanLiveChunk[] = [];
  #seq = 0;
  #limit: number;
  #hosted = new Set<string>();

  constructor(limit = PLAN_LIVE_LIMIT) {
    this.#limit = limit;
  }

  append(chunk: { runId: string; channel: PlanLiveChannel; line: string }): void {
    this.#seq += 1;
    this.#hosted.add(chunk.runId);
    this.#chunks.push({
      seq: this.#seq,
      runId: chunk.runId,
      at: new Date().toISOString(),
      channel: chunk.channel,
      line: chunk.line,
    });
    if (this.#chunks.length > this.#limit) {
      this.#chunks.splice(0, this.#chunks.length - this.#limit);
    }
  }

  since(runId: string, cursor = 0, limit = 500): readonly PlanLiveChunk[] {
    return this.#chunks.filter((c) => c.runId === runId && c.seq > cursor).slice(0, limit);
  }

  hosted(runId: string): boolean {
    return this.#hosted.has(runId);
  }
}
