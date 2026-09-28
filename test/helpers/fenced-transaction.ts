/**
 * 内存队列测试用的领取核对事务。
 *
 * 内存 Platform 没有 File/PG 的单写者/数据库事务，但有 claim 的写 fail-closed：
 * 没注入 FencedCommandTransaction 就会 CLAIM_FENCE_UNAVAILABLE。两个 harness
 * （QueuedHopRepository / QueuedHopCapacityRepository）共用这一份，免得各写
 * 一份无条件放行的伪 runFenced。
 *
 * 核对必须在每一次 runFenced 里、回调之前现读队列行。工厂入口或闭包里预先 get
 * 会在核对和写入之间被别的领取改代次，旧 Runner 仍能把回调跑完。
 * 内存实现不冒充生产回滚：失败只保证不跑 fn，已经发生的旁路写入不会被抹掉。
 */

import {
  holdsCurrentClaim,
  type ClaimFence,
  type QueuedHop,
} from '../../src/application/durable-scheduler.ts';
import type { CommandTransaction, FencedCommandTransaction } from '../../src/application/ports.ts';

/** Both queue ports expose get(id); capacity is a subtype of the recovery repo. */
export type FencedQueueLookup = {
  get(id: string): Promise<QueuedHop | undefined>;
};

export function createMemoryFencedTransaction(
  queuedHops: FencedQueueLookup,
): CommandTransaction & FencedCommandTransaction {
  return {
    run(fn) {
      return fn();
    },
    async runFenced(fence: ClaimFence, fn) {
      const hop = await queuedHops.get(fence.id);
      if (!holdsCurrentClaim(hop, fence)) throw new Error('claim fence rejected');
      return fn();
    },
  };
}
