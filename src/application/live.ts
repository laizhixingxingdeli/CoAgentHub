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
 * 写入 Attempt.output 的实时尾部行数。
 *
 * 比 KEEP_TAIL_ON_FINISH 短：内存/PG 缓冲还要给观测面继续看，Attempt 只给人
 * 回头扫一眼。按**行**计——一个 text chunk 里可以夹着换行，当成 1 条会少裁。
 * 不把全文塞进 Attempt：那会撑爆状态文件。
 */
export const PERSIST_OUTPUT_TAIL_LINES = 200;

/** since() 一页上限。必须有界，否则 PG 一次把整份 Mission 历史打进内存。 */
const LIVE_TAIL_SCAN_PAGE = 200;

function linesOfChunk(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.length === 0) return [];
  const parts = normalized.split('\n');
  // 末尾换行不另算空行：那是「这一行写完了」，不是多出来的一行。
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

function pushTailLines(ring: string[], lines: readonly string[], maxLines: number): void {
  for (const line of lines) ring.push(line);
  if (ring.length > maxLines) ring.splice(0, ring.length - maxLines);
}

/**
 * 当前 mission+attempt 的文本/工具输出末尾，最多 maxLines 行。
 *
 * 只认 kind=text|tool：usage/note 混进去会把「最后在干什么」冲掉。
 * Attempt ID 只在 Mission 内唯一，必须两个键一起过滤。
 * 按 chunk **内部**的换行计行，不跨 chunk 粘：工具行没有换行，粘上去会和后续
 * 文本合成一句假话。PG 的 since 只有 mission 范围，所以分页扫、只把本跳的
 * 行留在 ring 里——总行内存有界，不把全量历史搬上来。
 */
export async function collectAttemptLiveTail(
  live: Pick<LiveOutput, 'since'>,
  missionId: string,
  attemptId: string,
  maxLines = PERSIST_OUTPUT_TAIL_LINES,
): Promise<string | undefined> {
  if (maxLines <= 0) return undefined;
  let cursor = 0;
  const ring: string[] = [];
  for (;;) {
    const page = await live.since(missionId, cursor, LIVE_TAIL_SCAN_PAGE);
    if (page.length === 0) break;
    const lastSeq = page[page.length - 1]!.seq;
    if (lastSeq <= cursor) break;
    for (const chunk of page) {
      if (chunk.attemptId !== attemptId) continue;
      if (chunk.kind !== 'text' && chunk.kind !== 'tool') continue;
      pushTailLines(ring, linesOfChunk(chunk.text ?? ''), maxLines);
    }
    cursor = lastSeq;
    if (page.length < LIVE_TAIL_SCAN_PAGE) break;
  }
  if (ring.length === 0) return undefined;
  return ring.join('\n');
}

/**
 * 实时尾部优先；outcome.output 在没有实时行、或它已经覆盖/被覆盖时保留。
 * 两边相同只留一份，避免 finishAttempt 被叫两次时尾巴无限变长。
 */
export function mergeAttemptOutput(
  outcomeOutput: string | undefined,
  liveTail: string | undefined,
): string | undefined {
  if (liveTail === undefined || liveTail.length === 0) {
    return outcomeOutput;
  }
  if (outcomeOutput === undefined || outcomeOutput.length === 0) return liveTail;
  if (outcomeOutput === liveTail) return liveTail;
  if (liveTail.includes(outcomeOutput)) return liveTail;
  if (outcomeOutput.includes(liveTail)) return outcomeOutput;
  return liveTail;
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
