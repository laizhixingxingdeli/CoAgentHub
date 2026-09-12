/**
 * T3: trackBackgroundWork / drainBackgroundWork 契约。
 * 不依赖 PGlite;纯登记处行为 + 与「内存计数已空但仍在写终态」窗口的对照。
 */
import { describe, expect, it } from "vitest";
import {
  __resetBackgroundWorkForTests,
  backgroundWorkSnapshot,
  drainBackgroundWork,
  trackBackgroundWork,
} from "../src/lib/executor-task/background-work";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T | PromiseLike<T>) => void;
  reject: (e?: unknown) => void;
} {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("background-work (T3)", () => {
  it("无后台工作时 drain 立即返回(不再等 1 秒)", async () => {
    __resetBackgroundWorkForTests();
    const t0 = Date.now();
    const result = await drainBackgroundWork({ timeoutMs: 20_000 });
    const elapsed = Date.now() - t0;
    expect(result).toEqual({ ok: true, pending: [] });
    // 旧 setup 固定连续空闲 1s;这里必须远小于该值。
    expect(elapsed).toBeLessThan(200);
  });

  it("drain 等到「离开队列后仍在写终态」窗口:内存计数已 0 但 track 未解除时不返回", async () => {
    __resetBackgroundWorkForTests();
    // 模拟:run 已从 activeRuns/queue 摘掉(内存计数 = 0),但终态写入仍在飞。
    let inMemoryBusy = true;
    const write = deferred<void>();
    const tracked = trackBackgroundWork("runOne:task-post-queue", async () => {
      // 进入「已离队、仍在写」:调用方看到的内存计数先清零。
      inMemoryBusy = false;
      await write.promise;
    });

    expect(inMemoryBusy).toBe(false);
    expect(backgroundWorkSnapshot().map((s) => s.label)).toEqual([
      "runOne:task-post-queue",
    ]);

    let drained = false;
    const drainP = drainBackgroundWork({ timeoutMs: 5_000 }).then((r) => {
      drained = true;
      return r;
    });

    // 给 drain 一个 macrotask 机会;在写入未完成前不得返回。
    await new Promise((r) => setTimeout(r, 30));
    expect(drained).toBe(false);
    expect(inMemoryBusy).toBe(false);

    write.resolve();
    await tracked;
    const result = await drainP;
    expect(result.ok).toBe(true);
    expect(result.pending).toEqual([]);
    expect(drained).toBe(true);
  });

  it("drain 超时会报出残留 label(含 taskId)", async () => {
    __resetBackgroundWorkForTests();
    const hang = deferred<void>();
    const taskId = "task-residual-7f3a";
    void trackBackgroundWork(`runOne:${taskId}`, () => hang.promise);

    const result = await drainBackgroundWork({ timeoutMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.pending.length).toBeGreaterThanOrEqual(1);
    expect(result.pending.some((p) => p.label === `runOne:${taskId}`)).toBe(
      true,
    );
    expect(result.pending[0]?.label).toContain(taskId);
    expect(result.pending[0]?.sinceMs).toBeGreaterThanOrEqual(0);

    // 解开悬挂,避免 vitest 因未处理 promise 告警。
    hang.resolve();
    await drainBackgroundWork({ timeoutMs: 1_000 });
  });

  it("父子交接:子 track 在父 finally 内同步登记,中间无空计数窗口", async () => {
    __resetBackgroundWorkForTests();
    const childStarted = deferred<void>();
    const childDone = deferred<void>();
    let sawEmptyBetween = false;

    const parent = trackBackgroundWork("runOne:parent", async () => {
      try {
        // 模拟 runOne body
      } finally {
        // 等价于 requestPump → 同步启动下一个 runOne 的登记
        void trackBackgroundWork("runOne:child", async () => {
          childStarted.resolve();
          await childDone.promise;
        });
        // 父 finally 此刻尚未返回到 track 的 finally;快照应同时有 parent+child
        // 或至少有 child。若在父解除之后才登记 child,drain 会看到空窗。
        const labels = backgroundWorkSnapshot().map((s) => s.label);
        if (labels.length === 0) sawEmptyBetween = true;
        expect(labels).toContain("runOne:child");
      }
    });

    await parent;
    // 父已解除后 child 仍在
    expect(backgroundWorkSnapshot().map((s) => s.label)).toEqual([
      "runOne:child",
    ]);
    expect(sawEmptyBetween).toBe(false);

    childDone.resolve();
    await childStarted.promise;
    const result = await drainBackgroundWork({ timeoutMs: 1_000 });
    expect(result.ok).toBe(true);
  });
});
