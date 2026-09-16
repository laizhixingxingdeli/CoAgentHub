/**
 * 流水线（S07.1）。
 *
 * ```
 * 时间 →
 * L2: 调查 A ───── 调查 B ───── 调查 C
 * L1:        执行 A ───── 执行 B ───── 执行 C
 * ```
 *
 * 允许 A 在执行时 B 在调查，**但同一 Project 的写操作仍然串行** —— 那条
 * 由改动名额保证（不变量 C），这里不重复实现。
 *
 * 实现上刻意简单：几条 Mission 各跑各的 orchestrator，`Promise.all` 等齐。
 * 撞上名额被占时，那条会拿到 `waiting: project_busy` 并**让出位置**，
 * 等下一轮再来——不是排一个队列、不是抢锁。
 *
 * 为什么同进程而不是多进程：状态文件是单写者的。多进程并发写 = 后写的
 * 盖掉先写的，那才是真要命的。
 */

import type { Orchestrator, MissionRunOutcome, RunMissionOptions } from './orchestrator.ts';

export interface PipelineItem {
  readonly missionId: string;
  readonly options: RunMissionOptions;
}

export interface PipelineResult {
  readonly missionId: string;
  readonly outcome: MissionRunOutcome;
  /** 因为名额被占而让位的次数。高了说明这个 Project 被一条长 Mission 卡住了。 */
  readonly yielded: number;
}

export interface PipelineOptions {
  /**
   * 名额被占的那条最多重试几轮。
   *
   * 不设上限的话，一条长 Mission 会让别的在这儿空转到天荒地老——
   * 而每一轮空转都是真的在调 agent 花钱。
   */
  readonly maxRetries?: number;
  /** 两轮之间等多久（毫秒）。 */
  readonly retryDelayMs?: number;
}

/**
 * 并发跑多条 Mission。
 *
 * `make` 每次返回一个**新的** Orchestrator：候选冷却表是挂在实例上的，
 * 几条 Mission 共用一个的话，A 把候选烧进冷却会连带挡住 B。
 */
export async function runPipeline(
  items: readonly PipelineItem[],
  make: (missionId: string) => Orchestrator,
  options: PipelineOptions = {},
): Promise<PipelineResult[]> {
  const maxRetries = options.maxRetries ?? 3;
  const delay = options.retryDelayMs ?? 0;

  return Promise.all(
    items.map(async (item): Promise<PipelineResult> => {
      let yielded = 0;
      let outcome: MissionRunOutcome = {
        kind: 'stalled',
        reason: '还没跑',
      };

      for (let round = 0; round <= maxRetries; round += 1) {
        outcome = await make(item.missionId).runMission(item.missionId, item.options);
        if (outcome.kind !== 'waiting' || outcome.reason !== 'project_busy') break;
        yielded += 1;
        if (round < maxRetries && delay > 0) {
          await new Promise((done) => setTimeout(done, delay));
        }
      }

      return { missionId: item.missionId, outcome, yielded };
    }),
  );
}
