/**
 * PostgreSQL 存储。
 *
 * 与 FileStateStore 并存，**不是替换它**。两个实现都在，`StateStore` 这个
 * 端口才是真的——只有一个实现的接口一定会长成那个实现的形状。文件版还负责
 * 一件事：没装 Postgres 也能跑完整平台和全部测试。
 *
 * 相对文件版真正买到的三样东西：
 *
 *   1. **活动日志是追加行，不是每次重写整个数组。** 文件版每记一条事件就把
 *      整份状态重写一遍；一条 Mission 跑下来几十条事件，状态越大越慢。
 *   2. **发号是原子的。** 文件版的「读-加一-写」在两个进程之间有竞态，会发出
 *      重复 id；这里是一条 `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`。
 *   3. **写冲突会被发现，而不是悄悄覆盖。** 每个 Project 带版本号，flush 时
 *      带上期望版本；对不上就报错而不是把别人的改动抹掉。
 *
 * 快照格式与文件版**逐字段相同**（都是 ProjectSnapshot 的 JSON），所以两边
 * 可以互相导入导出，也不存在「换存储就得迁移领域模型」。
 */

import pg from 'pg';
import { Project } from '../kernel/index.ts';
import type { ProjectSnapshot } from '../kernel/index.ts';
import type { ActivityEvent, ActivityLog, Clock, IdGenerator, ProjectRepository } from './ports.ts';
import type { Delivery, DeliveryRepository } from './delivery.ts';
import { KEEP_TAIL_ON_FINISH, truncationNote } from './live.ts';
import type { LiveChunk, LiveOutput } from './live.ts';
import type { TokenUsage } from '../kernel/index.ts';
import type {
  AgentPoolAddInput,
  AgentPoolCandidate,
  AgentPoolFact,
  AgentPoolRepository,
  AgentPoolRow,
  AgentPoolSnapshot,
  AgentRole,
  AgentPoolRuntime,
} from './agent-pool.ts';
import { AgentPoolError, agentPoolSnapshot, validateAgentPoolAdd } from './agent-pool.ts';
import type { QueryRunRecord, QueryRunRepository } from './query-run.ts';
import type { ValidationReport } from '../kernel/index.ts';
import {
  cloneValidationReport,
  ValidationReportConflictError,
  validationReportsEqual,
  type ValidationReportRepository,
} from './validation/report-repository.ts';

/** 并发写冲突：有人在你读出来之后改过同一个 Project。 */
export class WriteConflictError extends Error {
  readonly projectId: string;

  constructor(projectId: string) {
    super(
      `Project ${projectId} 在本次操作期间被别的进程改过。` +
        '你手上的版本已经过期——重新读一次再重试，不要覆盖。',
    );
    this.name = 'WriteConflictError';
    this.projectId = projectId;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  project_id  text PRIMARY KEY,
  snapshot    jsonb       NOT NULL,
  version     bigint      NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 追加表：永不 UPDATE。Timeline 的原料就该是这个形状。
CREATE TABLE IF NOT EXISTS activity (
  seq          bigserial PRIMARY KEY,
  project_id   text        NOT NULL,
  mission_id   text        NOT NULL,
  work_item_id text,
  attempt_id   text,
  kind         text        NOT NULL,
  data         jsonb,
  at           timestamptz NOT NULL,
  -- Envelope 公共语义（S10.3）。可空：加这几列之前的行没有。
  protocol_version  text,
  message_id        text,
  correlation_id    text,
  causation_id      text,
  contract_revision integer,
  plan_revision     integer
);
-- 已有库的补列。CREATE TABLE IF NOT EXISTS 不会给老表加字段。
ALTER TABLE activity ADD COLUMN IF NOT EXISTS protocol_version  text;
ALTER TABLE activity ADD COLUMN IF NOT EXISTS message_id        text;
ALTER TABLE activity ADD COLUMN IF NOT EXISTS correlation_id    text;
ALTER TABLE activity ADD COLUMN IF NOT EXISTS causation_id      text;
ALTER TABLE activity ADD COLUMN IF NOT EXISTS contract_revision integer;
ALTER TABLE activity ADD COLUMN IF NOT EXISTS plan_revision     integer;
CREATE INDEX IF NOT EXISTS activity_mission_idx ON activity (mission_id, seq);

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id     text PRIMARY KEY,
  mission_id      text        NOT NULL,
  project_id      text        NOT NULL,
  outcome         text        NOT NULL,
  recipient       text,
  summary         text        NOT NULL,
  payload         jsonb,
  status          text        NOT NULL,
  created_at      timestamptz NOT NULL,
  acknowledged_at timestamptz
);
-- 同一条 Mission 的同一种结局只投递一次。幂等交给数据库管，不靠调用方记得先查。
CREATE UNIQUE INDEX IF NOT EXISTS deliveries_mission_outcome_idx
  ON deliveries (mission_id, outcome);

CREATE TABLE IF NOT EXISTS id_counters (
  prefix text PRIMARY KEY,
  value  bigint NOT NULL
);

-- 独立 QueryRun：不进 activity（mission_id NOT NULL）也不塞 mission snapshot。
CREATE TABLE IF NOT EXISTS query_runs (
  query_run_id text PRIMARY KEY,
  project_id   text        NOT NULL,
  record       jsonb       NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS query_runs_project_idx ON query_runs (project_id);

-- 独立 ValidationReport：append-only 机器事实；永不 UPDATE report 列。
CREATE TABLE IF NOT EXISTS validation_reports (
  report_id  text PRIMARY KEY,
  report     jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 候选池。与 projects 不同，这是一张小小的配置表，不是聚合快照：一行一个候选，
-- 主键就是「同一个 role 下 profileId 只能有一条」这条规则本身 —— 不靠代码记得先查。
CREATE TABLE IF NOT EXISTS agent_pool (
  role        text    NOT NULL,
  profile_id  text    NOT NULL,
  endpoint    text    NOT NULL,
  runtime     text    NOT NULL DEFAULT 'pi',
  -- 列名用 ord：order 是 SQL 保留字，拿它当列名每条查询都得加引号。
  ord         integer NOT NULL,
  -- 不透明键值。平台不解释它，只存只取，所以用 jsonb 而不是拆成列：
  -- 拆列就等于把适配层的表在这里抄一份，抄的那一刻就开始过期。
  facts       jsonb   NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (role, profile_id)
);
-- 已有库的补列。CREATE TABLE IF NOT EXISTS 不会给老表加字段。
ALTER TABLE agent_pool ADD COLUMN IF NOT EXISTS facts jsonb NOT NULL DEFAULT '[]'::jsonb;
`;

export interface PgOptions {
  connectionString: string;
}

/** 从环境变量取连接串；没配就用本机默认库。 */
export function pgConnectionString(): string {
  return (
    process.env.COAGENT_PG ??
    'postgresql://postgres:postgres@localhost:5432/coagenthub_v5'
  );
}

export class PgStateStore {
  #pool: pg.Pool;
  #projects = new Map<string, Project>();
  #versions = new Map<string, number>();
  /**
   * 每个 Project 最后一次「已知与库一致」的序列化结果。
   * flush 拿它和当前状态比，判断到底要不要写——比 dirty 标记可靠，
   * 因为它不依赖任何人记得打标记。
   */
  #persisted = new Map<string, string>();
  /** flush 的串行队列。见 flush() 里的说明。 */
  #chain: Promise<void> = Promise.resolve();

  private constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  static async open(options?: PgOptions): Promise<PgStateStore> {
    const pool = new pg.Pool({
      connectionString: options?.connectionString ?? pgConnectionString(),
      // 平台是单写者 + 少量读者，连接开太多只会让 Postgres 那边排队。
      max: 8,
    });
    await pool.query(SCHEMA);
    // 一次性 high-watermark：已有 Q-N 抬高 id_counters，避免新实例 next('Q') 撞号。
    await pool.query(`
      INSERT INTO id_counters (prefix, value)
      SELECT 'Q', COALESCE(MAX(CAST(substring(query_run_id from 3) AS bigint)), 0)
        FROM query_runs
       WHERE query_run_id ~ '^Q-[0-9]+$'
      ON CONFLICT (prefix) DO UPDATE
        SET value = GREATEST(id_counters.value, EXCLUDED.value)
    `);
    // 已有 VR-N 抬高 id_counters('VR')，与 Q seed 并存。
    await pool.query(`
      INSERT INTO id_counters (prefix, value)
      SELECT 'VR', COALESCE(MAX(CAST(substring(report_id from 4) AS bigint)), 0)
        FROM validation_reports
       WHERE report_id ~ '^VR-[0-9]+$'
      ON CONFLICT (prefix) DO UPDATE
        SET value = GREATEST(id_counters.value, EXCLUDED.value)
    `);
    const store = new PgStateStore(pool);
    await store.refresh();
    return store;
  }

  get pool(): pg.Pool {
    return this.#pool;
  }

  /**
   * 从库里重新读一遍。
   *
   * 文件版靠 mtime 判断要不要重读；这里没有便宜的「变没变」判据，所以由
   * 调用方在读请求的边界上显式调用。观测面每次轮询调一次，代价是一条
   * `SELECT`，比重新解析整个状态文件还便宜。
   */
  async refresh(): Promise<void> {
    const { rows } = await this.#pool.query<{
      project_id: string;
      snapshot: ProjectSnapshot;
      version: string;
    }>('SELECT project_id, snapshot, version FROM projects');
    this.#projects.clear();
    this.#versions.clear();
    this.#persisted.clear();
    for (const row of rows) {
      this.#projects.set(row.project_id, Project.restore(row.snapshot));
      this.#versions.set(row.project_id, Number(row.version));
      // 存刚读回来的对象重新序列化的结果，而不是库里那份原文：
      // 两者字段顺序可能不同，拿原文比会让每个 Project 都"看起来改过"。
      this.#persisted.set(
        row.project_id,
        JSON.stringify(Project.restore(row.snapshot).toSnapshot()),
      );
    }
  }

  projectsMap(): Map<string, Project> {
    return this.#projects;
  }

  /**
   * 写回**内容确实变了的** Project。
   *
   * 判据是内容而不是一个 dirty 标记：平台的用例直接改活对象，很多路径不会
   * 显式 save()，靠调用方记得打标记一定会漏。比较序列化结果则不可能漏。
   *
   * 为什么不干脆全写一遍：那样一个不相干的过期 Project 会把**后续每一次写**
   * 都顶成冲突——实测就是这么炸的。没改过的东西不参与写，也就不参与冲突。
   * 改过又过期的仍然会被挡下，那正是要挡的。
   */
  flush(): Promise<void> {
    // **两个 flush 绝不能重叠。** 重叠时它们捏着同一个期望版本去写：先到的
    // 成功并把版本推到 6，后到的还拿着 5，UPDATE 命中 0 行，于是报出一个
    // 纯属自己制造的"并发冲突"。实跑就是这么炸的——API 的 onMutation 是
    // 即发即忘，两次挨得近的工具调用就够了。
    //
    // 排队而不是去重：后一次可能带着更新的内容，丢掉它就是丢数据。
    const next = this.#chain.then(
      () => this.#doFlush(),
      () => this.#doFlush(),
    );
    // 链上挂的是"已结束"而不是"成功了"：一次失败不该把后面的写全卡死。
    this.#chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #doFlush(): Promise<void> {
    const pending: { projectId: string; snapshot: string; expected: number | undefined }[] = [];
    for (const [projectId, project] of this.#projects) {
      const snapshot = JSON.stringify(project.toSnapshot());
      if (this.#persisted.get(projectId) === snapshot) continue;
      pending.push({ projectId, snapshot, expected: this.#versions.get(projectId) });
    }
    if (pending.length === 0) return;

    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      for (const { projectId, snapshot, expected } of pending) {
        if (expected === undefined) {
          await client.query(
            'INSERT INTO projects (project_id, snapshot) VALUES ($1, $2::jsonb)',
            [projectId, snapshot],
          );
          this.#versions.set(projectId, 1);
          this.#persisted.set(projectId, snapshot);
          continue;
        }
        const { rowCount } = await client.query(
          `UPDATE projects
              SET snapshot = $2::jsonb, version = version + 1, updated_at = now()
            WHERE project_id = $1 AND version = $3`,
          [projectId, snapshot, expected],
        );
        if (rowCount === 0) {
          await client.query('ROLLBACK');
          throw new WriteConflictError(projectId);
        }
        this.#versions.set(projectId, expected + 1);
        this.#persisted.set(projectId, snapshot);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

export class PgProjectRepository implements ProjectRepository {
  #store: PgStateStore;

  constructor(store: PgStateStore) {
    this.#store = store;
  }

  async get(projectId: string): Promise<Project | undefined> {
    return this.#store.projectsMap().get(projectId);
  }

  async save(project: Project): Promise<void> {
    this.#store.projectsMap().set(project.id, project);
    await this.#store.flush();
  }

  async list(): Promise<readonly Project[]> {
    return [...this.#store.projectsMap().values()];
  }

  async ensure(projectId: string): Promise<Project> {
    const existing = this.#store.projectsMap().get(projectId);
    if (existing) return existing;
    const created = Project.create({ id: projectId });
    this.#store.projectsMap().set(projectId, created);
    await this.#store.flush();
    return created;
  }

  async persist(): Promise<void> {
    await this.#store.flush();
  }

  async refresh(): Promise<void> {
    await this.#store.refresh();
  }
}

export class PgActivityLog implements ActivityLog {
  #store: PgStateStore;
  #clock: Clock;

  constructor(store: PgStateStore, clock: Clock) {
    this.#store = store;
    this.#clock = clock;
  }

  async append(event: Omit<ActivityEvent, 'at'>): Promise<void> {
    // 一条 INSERT。文件版在这里要把整份状态重写一遍。
    await this.#store.pool.query(
      `INSERT INTO activity
         (project_id, mission_id, work_item_id, attempt_id, kind, data, at,
          protocol_version, message_id, correlation_id, causation_id,
          contract_revision, plan_revision)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)`,
      [
        event.projectId,
        event.missionId,
        event.workItemId ?? null,
        event.attemptId ?? null,
        event.kind,
        JSON.stringify(event.data ?? null),
        this.#clock.now().toISOString(),
        event.protocolVersion ?? null,
        event.messageId ?? null,
        event.correlationId ?? null,
        event.causationId ?? null,
        event.contractRevision ?? null,
        event.planRevision ?? null,
      ],
    );
  }

  async list(missionId: string): Promise<readonly ActivityEvent[]> {
    const { rows } = await this.#store.pool.query<{
      project_id: string;
      mission_id: string;
      work_item_id: string | null;
      attempt_id: string | null;
      kind: string;
      data: unknown;
      at: Date;
    }>(
      `SELECT project_id, mission_id, work_item_id, attempt_id, kind, data, at,
              protocol_version, message_id, correlation_id, causation_id,
              contract_revision, plan_revision
         FROM activity WHERE mission_id = $1 ORDER BY seq`,
      [missionId],
    );
    return rows.map(toEvent);
  }

  async all(): Promise<readonly ActivityEvent[]> {
    const { rows } = await this.#store.pool.query(
      `SELECT project_id, mission_id, work_item_id, attempt_id, kind, data, at,
              protocol_version, message_id, correlation_id, causation_id,
              contract_revision, plan_revision
         FROM activity ORDER BY seq`,
    );
    return rows.map(toEvent);
  }
}

function toEvent(row: Record<string, unknown>): ActivityEvent {
  const opt = (key: string) => (row[key] as string | null) ?? undefined;
  const num = (key: string) => (row[key] as number | null) ?? undefined;
  return {
    at: (row.at as Date).toISOString(),
    projectId: row.project_id as string,
    missionId: row.mission_id as string,
    workItemId: opt('work_item_id'),
    attemptId: opt('attempt_id'),
    kind: row.kind as string,
    data: row.data,
    protocolVersion: opt('protocol_version'),
    messageId: opt('message_id'),
    correlationId: opt('correlation_id'),
    causationId: opt('causation_id'),
    contractRevision: num('contract_revision'),
    planRevision: num('plan_revision'),
  };
}

export class PgDeliveryRepository implements DeliveryRepository {
  #store: PgStateStore;
  #clock: Clock;
  #ids: IdGenerator;

  constructor(store: PgStateStore, clock: Clock, ids: IdGenerator) {
    this.#store = store;
    this.#clock = clock;
    this.#ids = ids;
  }

  async create(
    input: Omit<Delivery, 'id' | 'createdAt' | 'status' | 'acknowledgedAt'>,
  ): Promise<Delivery> {
    // ON CONFLICT DO NOTHING + 回查：幂等由唯一索引保证，不靠「先 SELECT
    // 再 INSERT」那种在并发下会双开的写法。
    const id = this.#ids.next('D');
    const createdAt = this.#clock.now().toISOString();
    await this.#store.pool.query(
      `INSERT INTO deliveries
         (delivery_id, mission_id, project_id, outcome, recipient, summary, payload, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'pending',$8)
       ON CONFLICT (mission_id, outcome) DO NOTHING`,
      [
        id,
        input.missionId,
        input.projectId,
        input.outcome,
        input.recipient ?? null,
        input.summary,
        JSON.stringify(input.payload ?? null),
        createdAt,
      ],
    );
    const { rows } = await this.#store.pool.query(
      'SELECT * FROM deliveries WHERE mission_id = $1 AND outcome = $2',
      [input.missionId, input.outcome],
    );
    return toDelivery(rows[0]);
  }

  async pending(recipient?: string): Promise<readonly Delivery[]> {
    const { rows } = recipient
      ? await this.#store.pool.query(
          "SELECT * FROM deliveries WHERE status = 'pending' AND recipient = $1 ORDER BY created_at",
          [recipient],
        )
      : await this.#store.pool.query(
          "SELECT * FROM deliveries WHERE status = 'pending' ORDER BY created_at",
        );
    return rows.map(toDelivery);
  }

  async acknowledge(deliveryId: string): Promise<Delivery | undefined> {
    const { rows } = await this.#store.pool.query(
      `UPDATE deliveries
          SET status = 'acknowledged', acknowledged_at = COALESCE(acknowledged_at, $2)
        WHERE delivery_id = $1
        RETURNING *`,
      [deliveryId, this.#clock.now().toISOString()],
    );
    return rows[0] ? toDelivery(rows[0]) : undefined;
  }

  async get(deliveryId: string): Promise<Delivery | undefined> {
    const { rows } = await this.#store.pool.query(
      'SELECT * FROM deliveries WHERE delivery_id = $1',
      [deliveryId],
    );
    return rows[0] ? toDelivery(rows[0]) : undefined;
  }
}

function toDelivery(row: Record<string, unknown>): Delivery {
  return {
    id: row.delivery_id as string,
    missionId: row.mission_id as string,
    projectId: row.project_id as string,
    outcome: row.outcome as Delivery['outcome'],
    recipient: (row.recipient as string | null) ?? undefined,
    summary: row.summary as string,
    payload: row.payload,
    status: row.status as Delivery['status'],
    createdAt: (row.created_at as Date).toISOString(),
    acknowledgedAt: row.acknowledged_at
      ? (row.acknowledged_at as Date).toISOString()
      : undefined,
  };
}

/**
 * 跨进程安全的发号器。
 *
 * 文件版的「读-加一-写」在两个进程之间有竞态：两边都读到 3，都发 W-4。
 * 这里是一条语句，自增与取值在同一个原子操作里。
 *
 * 代价：`next()` 必须是异步的，而 IdGenerator 是同步接口。所以本类预取一段
 * 号段（默认 32 个），用完再取下一段——既保持同步接口，又不会每发一个 id
 * 就往返一次数据库。号段不连续（重启会跳号）是刻意接受的：id 只要唯一，
 * 不需要连续。
 */
export class PgIds implements IdGenerator {
  #store: PgStateStore;
  #blockSize: number;
  #available = new Map<string, { next: number; end: number }>();
  #pending = new Map<string, Promise<void>>();

  constructor(store: PgStateStore, blockSize = 32) {
    this.#store = store;
    this.#blockSize = blockSize;
  }

  /** 预热：把要用到的前缀先各取一段，之后 next() 就不会落空。 */
  async reserve(prefixes: readonly string[] = ['M', 'W', 'D', 'Q', 'VR']): Promise<void> {
    for (const prefix of prefixes) await this.#fetchBlock(prefix);
  }

  next(prefix: string): string {
    const block = this.#available.get(prefix);
    if (!block || block.next > block.end) {
      // 号段用尽。同步接口没法等——先在后台补，同时抛出可执行的错误，
      // 而不是发一个可能重复的 id。
      void this.#ensureBlock(prefix);
      throw new Error(
        `id 号段用尽（前缀 ${prefix}）。已在后台补领，重试这次操作即可。` +
          '要避免的话，启动时调 PgIds.reserve() 预热，或把 blockSize 调大。',
      );
    }
    const value = block.next;
    block.next += 1;
    // 快用完了就提前补，别等到真的抛错。
    if (block.next > block.end - 4) void this.#ensureBlock(prefix);
    return `${prefix}-${value}`;
  }

  #ensureBlock(prefix: string): Promise<void> {
    const inFlight = this.#pending.get(prefix);
    if (inFlight) return inFlight;
    const task = this.#fetchBlock(prefix).finally(() => this.#pending.delete(prefix));
    this.#pending.set(prefix, task);
    return task;
  }

  async #fetchBlock(prefix: string): Promise<void> {
    const { rows } = await this.#store.pool.query<{ value: string }>(
      `INSERT INTO id_counters (prefix, value) VALUES ($1, $2)
       ON CONFLICT (prefix) DO UPDATE SET value = id_counters.value + $2
       RETURNING value`,
      [prefix, this.#blockSize],
    );
    const end = Number(rows[0].value);
    const start = end - this.#blockSize + 1;
    const existing = this.#available.get(prefix);
    // 只在新号段确实更靠后时替换，避免并发补领把还没用完的段换掉。
    if (!existing || existing.next > existing.end || start > existing.end) {
      this.#available.set(prefix, { next: start, end });
    }
  }
}

/**
 * QueryRun 的 Postgres 仓储。
 *
 * 独立表；JSONB 完整 round-trip。同 id upsert，不进 activity / mission snapshot。
 */
export class PgQueryRunRepository implements QueryRunRepository {
  #store: PgStateStore;

  constructor(store: PgStateStore) {
    this.#store = store;
  }

  async save(run: QueryRunRecord): Promise<void> {
    await this.#store.pool.query(
      `INSERT INTO query_runs (query_run_id, project_id, record)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (query_run_id) DO UPDATE
         SET project_id = EXCLUDED.project_id,
             record = EXCLUDED.record,
             updated_at = now()`,
      [run.id, run.projectId, JSON.stringify(run)],
    );
  }

  async get(id: string): Promise<QueryRunRecord | undefined> {
    const { rows } = await this.#store.pool.query<{ record: QueryRunRecord }>(
      'SELECT record FROM query_runs WHERE query_run_id = $1',
      [id],
    );
    return rows[0] ? toQueryRunRecord(rows[0].record) : undefined;
  }

  async list(projectId?: string): Promise<readonly QueryRunRecord[]> {
    const { rows } = projectId
      ? await this.#store.pool.query<{ record: QueryRunRecord }>(
          'SELECT record FROM query_runs WHERE project_id = $1 ORDER BY query_run_id',
          [projectId],
        )
      : await this.#store.pool.query<{ record: QueryRunRecord }>(
          'SELECT record FROM query_runs ORDER BY query_run_id',
        );
    return rows.map((row) => toQueryRunRecord(row.record));
  }
}

function toQueryRunRecord(raw: QueryRunRecord | string): QueryRunRecord {
  const record = typeof raw === 'string' ? (JSON.parse(raw) as QueryRunRecord) : raw;
  return {
    ...record,
    usage: { ...record.usage },
    ...(record.toolCalls ? { toolCalls: Object.freeze([...record.toolCalls]) } : {}),
  };
}

/**
 * ValidationReport 的 Postgres 仓储。
 *
 * INSERT ... ON CONFLICT DO NOTHING；已存在则结构相等幂等，不等 conflict。
 * 绝不 UPDATE report。JSONB 读出后 clone/freeze，不暴露可变引用。
 */
export class PgValidationReportRepository implements ValidationReportRepository {
  #store: PgStateStore;

  constructor(store: PgStateStore) {
    this.#store = store;
  }

  async save(report: ValidationReport): Promise<void> {
    // 先 clone 一份再序列化：不 freeze/mutate caller；存的内容与 caller 解耦。
    const stored = cloneValidationReport(report);
    const inserted = await this.#store.pool.query<{ report_id: string }>(
      `INSERT INTO validation_reports (report_id, report)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (report_id) DO NOTHING
       RETURNING report_id`,
      [stored.id, JSON.stringify(stored)],
    );
    if ((inserted.rowCount ?? 0) > 0) return;

    const { rows } = await this.#store.pool.query<{ report: ValidationReport | string }>(
      'SELECT report FROM validation_reports WHERE report_id = $1',
      [report.id],
    );
    const existingRaw = rows[0]?.report;
    if (existingRaw === undefined) {
      // 竞态：冲突后行又消失——极少见；当作可重试冲突。
      throw new ValidationReportConflictError(report.id);
    }
    const existing = toValidationReport(existingRaw);
    if (validationReportsEqual(existing, report)) return;
    throw new ValidationReportConflictError(report.id);
  }

  async get(reportId: string): Promise<ValidationReport | undefined> {
    const { rows } = await this.#store.pool.query<{ report: ValidationReport | string }>(
      'SELECT report FROM validation_reports WHERE report_id = $1',
      [reportId],
    );
    return rows[0] ? toValidationReport(rows[0].report) : undefined;
  }
}

function toValidationReport(raw: ValidationReport | string): ValidationReport {
  const record = typeof raw === 'string' ? (JSON.parse(raw) as ValidationReport) : raw;
  return cloneValidationReport(record);
}

/**
 * 候选池的 Postgres 实现。
 *
 * 每次 list 都真发一条 SELECT，**不走 PgStateStore 的 projects 缓存**：
 * 那个缓存是为了避免反复反序列化大聚合，而候选池一共就几十行，缓存它买不到
 * 任何东西，却会把「别的进程刚追加的候选」藏起来 —— 而跨进程可见恰好是这张表
 * 存在的全部理由。
 *
 * 校验与另两种实现共用 `validateAgentPoolAdd`（规则只该有一份）。两个进程可能
 * 同时算出同一个 order 并各自通过校验，那由主键兑现：23505 转成
 * DUPLICATE_PROFILE，而不是往调用方抛一个看不懂的数据库错误码。
 */
export class PgAgentPoolRepository implements AgentPoolRepository {
  #store: PgStateStore;

  constructor(store: PgStateStore) {
    this.#store = store;
  }

  async list(): Promise<AgentPoolSnapshot> {
    return agentPoolSnapshot(await this.#rows());
  }

  async add(input: AgentPoolAddInput): Promise<AgentPoolCandidate> {
    const row = validateAgentPoolAdd(input, await this.#rows());
    try {
      await this.#store.pool.query(
        `INSERT INTO agent_pool (role, profile_id, endpoint, runtime, ord, facts)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          row.role,
          row.profileId,
          row.endpoint,
          row.runtime,
          row.order,
          JSON.stringify(row.facts),
        ],
      );
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        throw new AgentPoolError(
          'DUPLICATE_PROFILE',
          `候选池 ${row.role} 里已经有 profileId=${row.profileId}：两个进程同时加了同一个候选，` +
            '以库里已有的那条为准。',
        );
      }
      throw error;
    }
    const { role: _role, ...candidate } = row;
    return candidate;
  }

  async #rows(): Promise<AgentPoolRow[]> {
    const { rows } = await this.#store.pool.query<{
      role: string;
      profile_id: string;
      endpoint: string;
      runtime: string;
      ord: string | number;
      facts: unknown;
    }>(
      'SELECT role, profile_id, endpoint, runtime, ord, facts FROM agent_pool ORDER BY role, ord',
    );
    return rows.map((row) => ({
      role: row.role as AgentRole,
      profileId: row.profile_id,
      endpoint: row.endpoint,
      runtime: row.runtime as AgentPoolRuntime,
      order: Number(row.ord),
      // 驱动已经把 jsonb 解成 JS 值了；不是数组 = 这行被人手改过，按空处理而不是
      // 把垃圾往下传（适配层宁可选不到身份也不要拿到一个不是数组的 facts）。
      facts: Array.isArray(row.facts) ? (row.facts as AgentPoolFact[]) : [],
    }));
  }
}

/**
 * 跨进程的实时输出。
 *
 * 这是 LiveOutput 真正会用的那个实现：调度器在一个进程里 append，观测面在
 * 另一个进程里 since()。内存版跨不过进程边界，而跨进程恰恰是这件事的全部难点。
 *
 * 表是纯追加的，读用自增主键当游标。断线重连、刷新页面都能从上次的位置续上——
 * 换成推送反而要自己处理这些。
 */
export class PgLiveOutput implements LiveOutput {
  #store: PgStateStore;

  constructor(store: PgStateStore) {
    this.#store = store;
  }

  static async ensureSchema(store: PgStateStore): Promise<void> {
    await store.pool.query(`
      CREATE TABLE IF NOT EXISTS live_output (
        seq        bigserial PRIMARY KEY,
        mission_id text        NOT NULL,
        attempt_id text        NOT NULL,
        kind       text        NOT NULL,
        text       text,
        usage      jsonb,
        at         timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS live_output_mission_idx ON live_output (mission_id, seq);
    `);
  }

  async append(chunk: Omit<LiveChunk, 'seq' | 'at'>): Promise<void> {
    await this.#store.pool.query(
      `INSERT INTO live_output (mission_id, attempt_id, kind, text, usage)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        chunk.missionId,
        chunk.attemptId,
        chunk.kind,
        chunk.text ?? null,
        chunk.usage ? JSON.stringify(chunk.usage) : null,
      ],
    );
  }

  async since(missionId: string, cursor = 0, limit = 500): Promise<readonly LiveChunk[]> {
    const { rows } = await this.#store.pool.query<{
      seq: string;
      mission_id: string;
      attempt_id: string;
      kind: string;
      text: string | null;
      usage: TokenUsage | null;
      at: Date;
    }>(
      `SELECT seq, mission_id, attempt_id, kind, text, usage, at
         FROM live_output
        WHERE mission_id = $1 AND seq > $2
        ORDER BY seq
        LIMIT $3`,
      [missionId, cursor, limit],
    );
    return rows.map((row) => ({
      seq: Number(row.seq),
      missionId: row.mission_id,
      attemptId: row.attempt_id,
      kind: row.kind as LiveChunk['kind'],
      text: row.text ?? undefined,
      usage: row.usage ?? undefined,
      at: row.at.toISOString(),
    }));
  }

  /**
   * 一跳结束时裁剪它的实时行，**只删最早的那些，留下尾巴**。
   *
   * 原来这里是 `DELETE … WHERE attempt_id = $1`，一行不留。理由写的是
   * "最终输出已经作为 Attempt 的一部分落库了"——实测那是 1.4 KB 的摘要，
   * 不是几万行的过程。跑完的任务因此永远只剩空面板。
   *
   * 裁掉多少补一条 note 记下来：悄悄截断会让人把残段当全貌。
   */
  async finish(missionId: string, attemptId: string): Promise<void> {
    const { rows } = await this.#store.pool.query<{ dropped: string }>(
      `WITH doomed AS (
         SELECT seq FROM live_output
          WHERE mission_id = $1 AND attempt_id = $2
          ORDER BY seq DESC
         OFFSET $3
       )
       DELETE FROM live_output
        WHERE seq IN (SELECT seq FROM doomed)
       RETURNING seq`,
      [missionId, attemptId, KEEP_TAIL_ON_FINISH],
    );
    const dropped = rows.length;
    if (dropped === 0) return;
    await this.append({
      missionId,
      attemptId,
      kind: 'note',
      text: truncationNote(dropped, KEEP_TAIL_ON_FINISH),
    });
  }
}
