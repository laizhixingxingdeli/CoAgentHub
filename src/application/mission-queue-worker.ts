import type { MissionQueueView, MissionQueueEntry, ProjectExecutionConfig } from './platform/mission-queue.ts';

export interface MissionQueueWorkerDeps {
  read(): Promise<readonly MissionQueueView[]>;
  run(entry: MissionQueueEntry, config: ProjectExecutionConfig, projectId: string): Promise<void>;
  hold(missionId: string, error: unknown): Promise<void>;
  warn(error: unknown): void;
  now?: () => number;
}

/** 只有项目顺序与依赖调度；没有运行记录、升级单、总预算或方案状态机。 */
export class MissionQueueWorker {
  #deps: MissionQueueWorkerDeps;
  #running = new Map<string, Promise<void>>();
  #lastRun = new Map<string, number>();
  #stopped = false;
  #tick: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: MissionQueueWorkerDeps) { this.#deps = deps; }

  tick(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#tick) return this.#tick;
    const task = this.#dispatch();
    this.#tick = task.finally(() => { this.#tick = undefined; });
    return this.#tick;
  }

  async #dispatch() {
    const queues = await this.#deps.read();
    for (const queue of queues) {
      if (!queue.config || this.#running.has(queue.projectId) || this.#stopped) continue;
      const now = this.#deps.now?.() ?? Date.now();
      const entry = queue.entries.find((row) => row.eligible && now - (this.#lastRun.get(row.missionId) ?? -Infinity) >= 15_000);
      if (!entry) continue;
      this.#lastRun.set(entry.missionId, now);
      const run = Promise.resolve().then(() => this.#deps.run(entry, queue.config!, queue.projectId))
        .catch(async (error) => {
          if ((error as { code?: string })?.code !== 'QUEUE_NOT_ELIGIBLE') await this.#deps.hold(entry.missionId, error);
        })
        .catch((error) => this.#deps.warn(error))
        .finally(() => { this.#running.delete(queue.projectId); });
      this.#running.set(queue.projectId, run);
    }
  }

  start() {
    if (this.#timer || this.#stopped) return;
    this.#timer = setInterval(() => { void this.tick().catch((error) => this.#deps.warn(error)); }, 1000);
    this.#timer.unref();
    void this.tick().catch((error) => this.#deps.warn(error));
  }

  async stop() {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#tick;
    await Promise.all(this.#running.values());
  }
}
