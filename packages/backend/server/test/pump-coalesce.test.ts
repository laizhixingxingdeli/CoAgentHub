/**
 * 泵送合并信号(specs/transient-requeue-lost-wakeup.md §6.1 / 票 A):
 *  - 忙时 requestPump 不得丢弃,应置 pending 并在本轮结束后再跑;
 *  - __resetExecutorQueueForTests 必须清 pumping/pumpPending,否则后续全静默。
 *
 * 负向对照:把 queue.ts 里 `setPumpPending(true)` 改回裸 `return`,或去掉
 * `do…while (pumpPending)`,本文件对应用例必须变红。
 *
 * ⚠️ 必须经 module namespace 读 `pumping`/`pumpPending` —— 解构会冻结当帧快照,
 * `export let` 的 live binding 只在 `state.pumping` 这种访问下更新。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const state = await import("../src/lib/executor-task/state");
const { requestPump } = await import("../src/lib/executor-task/pump-signal");
// 加载 queue.ts 以 registerPump(真正的 pumpQueue)
const queue = await import("../src/lib/executor-task/queue");

beforeEach(() => {
  state.__resetExecutorQueueForTests();
  queue.__setPumpCycleHookForTests(null);
});

afterEach(() => {
  queue.__setPumpCycleHookForTests(null);
  state.__resetExecutorQueueForTests();
});

describe("泵送合并信号(lost-wakeup A)", () => {
  it("忙时 requestPump 置 pumpPending,不丢弃信号", () => {
    state.setPumping(true);
    expect(state.pumpPending).toBe(false);
    requestPump();
    expect(state.pumpPending).toBe(true);
    state.setPumping(false);
    state.setPumpPending(false);
  });

  it("本轮结束时若有 pending 再跑一遍(有界,不空转)", async () => {
    let cycles = 0;
    queue.__setPumpCycleHookForTests(() => {
      cycles += 1;
      if (cycles === 1) {
        // 模拟「drain 进行中又来了唤醒」:pumping 已 true → 只置 pending。
        requestPump();
        expect(state.pumping).toBe(true);
        expect(state.pumpPending).toBe(true);
      }
    });
    await queue.__pumpQueueForTests();
    expect(cycles).toBe(2);
    expect(state.pumping).toBe(false);
    expect(state.pumpPending).toBe(false);
  });

  it("__resetExecutorQueueForTests 清掉 pumping 与 pumpPending", () => {
    state.setPumping(true);
    state.setPumpPending(true);
    state.__resetExecutorQueueForTests();
    expect(state.pumping).toBe(false);
    expect(state.pumpPending).toBe(false);
  });
});
