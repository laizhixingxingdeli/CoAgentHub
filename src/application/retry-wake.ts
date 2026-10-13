import type { AutoResumeDue, HostedRunRequest, RunDriverInfo } from './platform/auto-resume.ts';

/**
 * 自动恢复调度（P0：退避到期自动继续）。
 *
 * 托管运行在 Mission 进入退避或等候选冷却时就退出了，而退避只是几秒到几分钟——此后没有任何
 * 组件会接着跑，必须有人手动 start_mission（MiRing-V0-probe 的 W-619 / W-622）。这里由常驻
 * 服务负责：周期扫描「恢复时刻已到」的 Mission，复用它当初的托管启动参数接着跑。
 *
 * 持久的是 Mission.waitResumeAt 与启动参数（事件），不是这个对象的内存：服务重启后第一个 tick
 * 就从持久状态里把到点的 Mission 找回来。内存里只有节流用的计数。
 *
 * 不绕过任何门禁：候选筛选（platform/auto-resume.ts）已排除暂停 / 挂起 / 待 L3 / 预算 /
 * 检查点 / 不可重试失败；续跑本身是普通的 runMission，开头的各道闸、冷却、容量与重试次数上限
 * 一个不少。重复唤醒不重复启动：同一条 Mission 同一时刻只有一个运行（托管跟踪表 + 本类在途表）。
 */

export interface RetryWakeDeps {
  /** 恢复时刻已到、前置条件满足的 Mission（按恢复时刻升序）。 */
  listDue(nowIso: string): Promise<readonly AutoResumeDue[]>;
  /** 这条 Mission 当初怎么被托管启动的；入过队列的由队列 worker 驱动，这里不插手。 */
  runDriver(missionId: string): Promise<RunDriverInfo>;
  /** 服务内是否已经有这条 Mission 的托管运行在跑。 */
  isRunning(missionId: string): boolean;
  /** 留审计记录。写不进去就不唤醒：宁可晚一拍，也不要无记录地启动 Agent。 */
  record(missionId: string, data: { reason: string; resumeAt: string; streak: number }): Promise<void>;
  /** 用持久的启动参数接着跑；跑到这次运行结束才 resolve。 */
  start(missionId: string, request: HostedRunRequest): Promise<void>;
  warn(error: unknown): void;
  now?: () => number;
  /** 扫描周期，默认 5 秒。 */
  tickMs?: number;
  /** 同一条 Mission 两次唤醒的最短间隔，默认 5 秒；没有进展时翻倍。 */
  minIntervalMs?: number;
  /** 节流间隔上限，默认 5 分钟。 */
  maxIntervalMs?: number;
  /** 同时在跑的自动续跑数上限，默认 3：服务重启后一次涌进来一大批也不会全部同时启动。 */
  maxConcurrent?: number;
}

interface WakeState {
  /** 上次唤醒时刻（毫秒）。 */
  at: number;
  /** 连续几次唤醒后仍然停在「等时间」上（没有进展）。 */
  streak: number;
}

const DEFAULT_TICK_MS = 5_000;
const DEFAULT_MIN_INTERVAL_MS = 5_000;
const DEFAULT_MAX_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_CONCURRENT = 3;
/** 这么久没再唤醒过，就当上一轮的连续失败翻篇了。 */
const STREAK_FORGET_MS = 10 * 60_000;

export class RetryWakeScheduler {
  readonly #deps: RetryWakeDeps;
  readonly #running = new Map<string, Promise<void>>();
  readonly #wakes = new Map<string, WakeState>();
  #stopped = false;
  #tick: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: RetryWakeDeps) {
    this.#deps = deps;
  }

  /** 现在在跑的自动续跑（给状态观测用）。 */
  get active(): readonly string[] {
    return [...this.#running.keys()];
  }

  tick(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#tick) return this.#tick;
    const task = this.#dispatch();
    this.#tick = task.finally(() => {
      this.#tick = undefined;
    });
    return this.#tick;
  }

  async #dispatch(): Promise<void> {
    const nowMs = this.#deps.now?.() ?? Date.now();
    const due = await this.#deps.listDue(new Date(nowMs).toISOString());
    const limit = this.#deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    for (const item of due) {
      if (this.#stopped || this.#running.size >= limit) return;
      if (this.#running.has(item.missionId) || this.#deps.isRunning(item.missionId)) continue;
      if (this.#throttled(item.missionId, nowMs)) continue;
      const driver = await this.#deps.runDriver(item.missionId);
      if (driver.queued || driver.request === undefined) continue;
      const streak = this.#nextStreak(item.missionId, nowMs);
      // 先占位再 await：同一个 tick 里或并发的下一个 tick 看到的都是「已经在跑」。
      const run = this.#launch(item, driver.request, streak, nowMs);
      this.#running.set(item.missionId, run);
    }
  }

  async #launch(item: AutoResumeDue, request: HostedRunRequest, streak: number, nowMs: number): Promise<void> {
    try {
      this.#wakes.set(item.missionId, { at: nowMs, streak });
      await this.#deps.record(item.missionId, { reason: item.reason, resumeAt: item.resumeAt, streak });
      await this.#deps.start(item.missionId, request);
    } catch (error) {
      this.#deps.warn(error);
    } finally {
      this.#running.delete(item.missionId);
    }
  }

  /** 距上次唤醒不足节流间隔就跳过。间隔随连续无进展次数翻倍，封顶。 */
  #throttled(missionId: string, nowMs: number): boolean {
    const previous = this.#wakes.get(missionId);
    if (!previous) return false;
    if (nowMs - previous.at >= STREAK_FORGET_MS) {
      this.#wakes.delete(missionId);
      return false;
    }
    const base = this.#deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    const cap = this.#deps.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
    const interval = Math.min(cap, base * 2 ** Math.max(0, previous.streak - 1));
    return nowMs - previous.at < interval;
  }

  #nextStreak(missionId: string, nowMs: number): number {
    const previous = this.#wakes.get(missionId);
    if (!previous || nowMs - previous.at >= STREAK_FORGET_MS) return 1;
    return previous.streak + 1;
  }

  start(): void {
    if (this.#timer || this.#stopped) return;
    const tickMs = this.#deps.tickMs ?? DEFAULT_TICK_MS;
    this.#timer = setInterval(() => {
      void this.tick().catch((error) => this.#deps.warn(error));
    }, tickMs);
    this.#timer.unref();
    // 服务刚起来就扫一遍：重启前已经到点的等待不用再等一个周期。
    void this.tick().catch((error) => this.#deps.warn(error));
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#tick;
    await Promise.all(this.#running.values());
  }
}
