/**
 * 内存实现。
 *
 * S13.1：先用纯领域 + 内存仓储把状态流验证透，再映射 PostgreSQL。
 * 这一版刻意持有活的聚合对象——换 Postgres 时仓储要改成重建聚合，
 * 接口不变。
 */

import { Project } from '../kernel/index.ts';
import type { ActivityEvent, ActivityLog, Clock, IdGenerator, ProjectRepository } from './ports.ts';
import type { QueryRunRecord, QueryRunRepository } from './query-run.ts';

export class InMemoryProjectRepository implements ProjectRepository {
  #projects = new Map<string, Project>();

  async get(projectId: string): Promise<Project | undefined> {
    return this.#projects.get(projectId);
  }

  async save(project: Project): Promise<void> {
    this.#projects.set(project.id, project);
  }

  async list(): Promise<readonly Project[]> {
    return [...this.#projects.values()];
  }

  /** 便利方法：没有就建一个。仓储接口之外，只给装配代码用。 */
  async ensure(projectId: string): Promise<Project> {
    const existing = this.#projects.get(projectId);
    if (existing) return existing;
    const created = Project.create({ id: projectId });
    this.#projects.set(projectId, created);
    return created;
  }
}

export class InMemoryActivityLog implements ActivityLog {
  #events: ActivityEvent[] = [];
  #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async append(event: Omit<ActivityEvent, 'at'>): Promise<void> {
    this.#events.push(Object.freeze({ ...event, at: this.#clock.now().toISOString() }));
  }

  async list(missionId: string): Promise<readonly ActivityEvent[]> {
    return this.#events.filter((event) => event.missionId === missionId);
  }

  async all(): Promise<readonly ActivityEvent[]> {
    return [...this.#events];
  }
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** 测试用：可控时钟。 */
export class FixedClock implements Clock {
  #at: Date;

  constructor(iso = '2026-01-01T00:00:00.000Z') {
    this.#at = new Date(iso);
  }

  now(): Date {
    return this.#at;
  }

  advance(ms: number): void {
    this.#at = new Date(this.#at.getTime() + ms);
  }
}

/** 单调自增 id。够用且可预期；需要全局唯一时换实现即可。 */
export class SequentialIds implements IdGenerator {
  #counters = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, n);
    return `${prefix}-${n}`;
  }
}

/**
 * QueryRun 内存仓储。
 *
 * 进程内记忆，跨进程不持久化。Durable 路径用 File / PG 实现；
 * buildPlatform（全内存）继续挂本类，buildPersistentPlatform / buildPgPlatform
 * 挂对应 durable adapter。
 */
export class InMemoryQueryRunRepository implements QueryRunRepository {
  #runs = new Map<string, QueryRunRecord>();

  async save(run: QueryRunRecord): Promise<void> {
    this.#runs.set(run.id, Object.freeze({ ...run }));
  }

  async get(id: string): Promise<QueryRunRecord | undefined> {
    return this.#runs.get(id);
  }

  async list(projectId?: string): Promise<readonly QueryRunRecord[]> {
    const all = [...this.#runs.values()];
    if (projectId === undefined) return all;
    return all.filter((run) => run.projectId === projectId);
  }
}
