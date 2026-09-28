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

import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { Project } from '../kernel/index.ts';
import type { ProjectSnapshot } from '../kernel/index.ts';
import { claimHop, completeHop, holdsCurrentClaim, renewHop, validateEnqueueHop } from './durable-scheduler.ts';
import type { ClaimFence, QueuedHop } from './durable-scheduler.ts';
import type {
  ActivityEvent,
  ActivityLog,
  CandidateCircuitRepository,
  Clock,
  CommandTransaction,
  FencedCommandTransaction,
  IdGenerator,
  ProjectRepository,
} from './ports.ts';
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
import {
  closedCandidateCircuit,
  openCandidateCircuit,
  validateClaimCandidateProbe,
  validateResolveCandidateProbe,
  type CandidateCircuit,
  type ClaimCandidateProbeInput,
  type OpenCandidateCircuitInput,
  type ResolveCandidateProbeInput,
} from './candidate-circuit.ts';
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
-- 幂等按业务键：同一条 Mission 的同一个键只投递一次，交给数据库管，不靠调用方记得先查（C1）。
-- 早先按 (mission_id, outcome) 去重：第二次升级、L3 打回后的重新交卷都被吞掉。
-- 迁移全部可重复执行：旧行按旧规则回填键（升级那行只可能是第一次升级），先回填再建新索引，
-- 最后才删旧索引——任何时刻都有一条唯一约束在。
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS idempotency_key text;
UPDATE deliveries
   SET idempotency_key = CASE outcome WHEN 'escalated' THEN 'escalated:0' ELSE 'result:legacy:' || outcome END
 WHERE idempotency_key IS NULL;
ALTER TABLE deliveries ALTER COLUMN idempotency_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS deliveries_mission_key_idx
  ON deliveries (mission_id, idempotency_key);
DROP INDEX IF EXISTS deliveries_mission_outcome_idx;

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
CREATE TABLE IF NOT EXISTS queued_hops (
  hop_id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  hop jsonb NOT NULL
);

-- Per-profile durable circuit state; the primary key also arbitrates cross-instance probe claims.
CREATE TABLE IF NOT EXISTS candidate_circuits (
  profile_id text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('closed', 'open', 'half_open')),
  failure_class text,
  open_until timestamptz,
  probe_claimed boolean NOT NULL DEFAULT false
);

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

/**
 * 周期投递修复的跨进程 advisory lock 键。
 *
 * 不用表行：周期实例互斥跟业务数据无关，两个 int 键即可。
 * 必须在**同一条专用连接**上 try / unlock——会话级锁跟连接走，换连接等于没锁。
 */
export const PERIODIC_RECONCILE_LOCK_KEY1 = 0x43414754; // CAGT
export const PERIODIC_RECONCILE_LOCK_KEY2 = 0x5245434e; // RECN

export interface PgAdvisoryLock {
  readonly held: boolean;
  release(): Promise<void>;
}

/**
 * 在一条专用连接上试拿会话级 advisory lock。
 * 拿不到立刻返回 held: false（连接已放回池）；拿到则一直握着这条连接直到 release。
 */
export async function tryPgAdvisoryLock(
  pool: pg.Pool,
  key1: number,
  key2: number,
): Promise<PgAdvisoryLock> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean | string }>(
      'SELECT pg_try_advisory_lock($1::int, $2::int) AS locked',
      [key1, key2],
    );
    const held = rows[0]?.locked === true || rows[0]?.locked === 't';
    if (!held) {
      client.release();
      return { held: false, async release() {} };
    }
    let released = false;
    return {
      held: true,
      async release() {
        if (released) return;
        released = true;
        try {
          await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [key1, key2]);
        } finally {
          client.release();
        }
      },
    };
  } catch (error) {
    client.release();
    throw error;
  }
}

/**
 * 开着的 PG 命令事务（C3）：暂存要一起提交的写，和回滚要回到的样子。
 *
 * 覆盖快照、事件、投递、验收报告。查询、候选池、实时输出各有各的表，仍是即时写。
 * 机器验收的报告必须与 validation.reported、validator accept 同生共死——崩在中间
 * 不能留下孤儿报告（L3 维持验收原文）。
 */
export interface PgOpenTransaction {
  /** 开事务时各 Project 的快照：回滚就回到这里。 */
  readonly projects: Map<string, ProjectSnapshot>;
  /** 暂存的事件（at 已按记下时的时钟定好），提交时按顺序 INSERT。 */
  readonly events: ActivityEvent[];
  /** 暂存的新投递（id / createdAt / status 已定），提交时 ON CONFLICT DO NOTHING。 */
  readonly deliveries: Delivery[];
  /** 暂存的确认：deliveryId → 确认时间。 */
  readonly acknowledgements: Map<string, string>;
  /** 暂存的验收报告，提交时与事件同一个数据库事务 INSERT。 */
  readonly validationReports: ValidationReport[];
  /**
   * 本事务提交前要锁行核对的领取 fencing。挂在事务上而不是入口先查：
   * run 在 fn 返回后才 BEGIN，回调期间队列可被接管；入口 SELECT 会放过失租写。
   */
  readonly fences: ClaimFence[];
  /** 事务结束（提交或回滚）时兑现：事务外的写在这上面等。 */
  readonly done: Promise<void>;
  readonly finish: () => void;
}

const INSERT_ACTIVITY = `INSERT INTO activity
         (project_id, mission_id, work_item_id, attempt_id, kind, data, at,
          protocol_version, message_id, correlation_id, causation_id,
          contract_revision, plan_revision)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)`;

function activityParams(event: ActivityEvent): unknown[] {
  return [
    event.projectId,
    event.missionId,
    event.workItemId ?? null,
    event.attemptId ?? null,
    event.kind,
    JSON.stringify(event.data ?? null),
    event.at,
    event.protocolVersion ?? null,
    event.messageId ?? null,
    event.correlationId ?? null,
    event.causationId ?? null,
    event.contractRevision ?? null,
    event.planRevision ?? null,
  ];
}

const INSERT_DELIVERY = `INSERT INTO deliveries
         (delivery_id, mission_id, project_id, outcome, idempotency_key, recipient, summary, payload, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'pending',$9)
       ON CONFLICT (mission_id, idempotency_key) DO NOTHING`;

function deliveryParams(delivery: Delivery): unknown[] {
  return [
    delivery.id,
    delivery.missionId,
    delivery.projectId,
    delivery.outcome,
    delivery.idempotencyKey,
    delivery.recipient ?? null,
    delivery.summary,
    JSON.stringify((delivery as { payload?: unknown }).payload ?? null),
    delivery.createdAt,
  ];
}

const ACKNOWLEDGE_DELIVERY = `UPDATE deliveries
          SET status = 'acknowledged', acknowledged_at = COALESCE(acknowledged_at, $2)
        WHERE delivery_id = $1
        RETURNING *`;

/**
 * **单事务命令（C3 / C4）。** `run(fn)` 里的事件、投递、验收报告先暂存、快照不落盘；fn 结束后一个
 * 数据库事务写下变了的快照（版本号检查）、事件、投递、确认、验收报告。fn 抛错或提交失败（含版本
 * 冲突），数据库回滚，改过的活对象回到开事务时，暂存丢弃——包括未提交的报告，崩溃后不留孤儿。
 * 版本号与「已落库」记账只在提交成功后前移。事务外的写先等开着的事务结束；从库重读也等。
 */
export class PgStateStore implements CommandTransaction, FencedCommandTransaction {
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
  /** 开着的命令事务；同一时刻至多一个。 */
  #tx: PgOpenTransaction | undefined;
  /** 事务里的调用链带着它：据此分清「事务里的写」和「事务开着时别处的写」。 */
  #txContext = new AsyncLocalStorage<PgOpenTransaction>();
  /** 事务串行：后一个等前一个结束。 */
  #txQueue: Promise<void> = Promise.resolve();
  /** 在途的重读：开事务前要等它读完，免得它在事务中途换掉活对象。 */
  #refreshing: Promise<void> = Promise.resolve();

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
   *
   * 事务里不重读；事务外先等开着的事务结束——重读会换掉事务正在改的活对象。
   */
  async refresh(): Promise<void> {
    if (this.currentTransaction()) return;
    await this.settle();
    const run = this.#doRefresh();
    this.#refreshing = run.catch(() => undefined);
    return run;
  }

  async #doRefresh(): Promise<void> {
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

  /** 当前调用链所在的命令事务；事务外为 undefined。 */
  currentTransaction(): PgOpenTransaction | undefined {
    const tx = this.#tx;
    return tx && this.#txContext.getStore() === tx ? tx : undefined;
  }

  /** 事务外的写先等开着的事务结束：写进一个开着的事务，它回滚时会被一起抹掉。事务里的调用直接过。 */
  async settle(): Promise<void> {
    while (this.#tx && this.#txContext.getStore() !== this.#tx) await this.#tx.done;
  }

  /**
   * 同一命令事务提交时锁队列行核对领取。失败抛错，走 run 的回滚；不要在这里 catch，
   * 嵌套进外层 run 时吞掉错误会让外层把半截写入提交掉。核对放在 #commit 的 BEGIN 里，
   * 不在 fn 里另开 SELECT：否则锁不在写快照那条连接上，回调期间失租仍能落盘。
   */
  async runFenced<T>(fence: ClaimFence, fn: () => Promise<T>): Promise<T> {
    return this.run(async () => {
      const tx = this.currentTransaction();
      if (!tx) throw new Error('claim fence rejected');
      tx.fences.push(fence);
      return fn();
    });
  }

  /** 命令事务（C3）。嵌套调用并进外层事务；事务之间串行。 */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.currentTransaction()) return fn();
    const previous = this.#txQueue;
    let release!: () => void;
    this.#txQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    // 在途的快照写与重读先排空：提交时不能和它捏着同一个期望版本去写，重读也不能在事务中途换掉活对象。
    await this.#chain;
    await this.#refreshing;
    const tx = this.#begin();
    this.#tx = tx;
    try {
      let result: T;
      try {
        result = await this.#txContext.run(tx, fn);
      } catch (error) {
        this.#abort(tx);
        throw error;
      }
      try {
        await this.#commit(tx);
      } catch (error) {
        // 数据库那边已经回滚；内存也回去。
        this.#abort(tx);
        throw error;
      }
      return result;
    } finally {
      this.#tx = undefined;
      tx.finish();
      release();
    }
  }

  #begin(): PgOpenTransaction {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      projects: new Map([...this.#projects].map(([id, project]) => [id, project.toSnapshot()])),
      events: [],
      deliveries: [],
      acknowledgements: new Map(),
      validationReports: [],
      fences: [],
      done,
      finish,
    };
  }

  /** 回到开事务时的样子。只换掉改过的活对象：没动过的实例原样留着，别处手里的引用照样有效。 */
  #abort(tx: PgOpenTransaction): void {
    for (const [id, project] of [...this.#projects]) {
      const before = tx.projects.get(id);
      if (!before) {
        this.#projects.delete(id);
        continue;
      }
      if (JSON.stringify(project.toSnapshot()) !== JSON.stringify(before)) {
        this.#projects.set(id, Project.restore(before));
      }
    }
    for (const [id, before] of tx.projects) {
      if (!this.#projects.has(id)) this.#projects.set(id, Project.restore(before));
    }
  }

  /** 一个数据库事务：领取行锁核对 → 变了的快照（版本检查）→ 事件 → 投递 → 确认 → 验收报告。提交成功后才前移记账。 */
  async #commit(tx: PgOpenTransaction): Promise<void> {
    const pending = this.#changedProjects();
    if (
      pending.length === 0 &&
      tx.events.length === 0 &&
      tx.deliveries.length === 0 &&
      tx.acknowledgements.size === 0 &&
      tx.validationReports.length === 0 &&
      tx.fences.length === 0
    ) {
      return;
    }
    const client = await this.#pool.connect();
    let written: { projectId: string; snapshot: string; version: number }[];
    try {
      await client.query('BEGIN');
      // 先锁队列行再写快照，且必须用这个 client：另开连接核对会在 COMMIT 前把行锁放掉，失租命令仍能提交。
      // 没有 pending 写也不能跳过——空回调的陈旧代次否则会当成成功。
      await this.#assertClaimFences(client, tx.fences);
      written = await this.#writeProjects(client, pending);
      for (const event of tx.events) await client.query(INSERT_ACTIVITY, activityParams(event));
      for (const delivery of tx.deliveries) await client.query(INSERT_DELIVERY, deliveryParams(delivery));
      for (const [deliveryId, at] of tx.acknowledgements) await client.query(ACKNOWLEDGE_DELIVERY, [deliveryId, at]);
      // 报告与 validation.reported / accept 同生共死：插不进去且内容不同就抛，让整个事务回滚。
      for (const report of tx.validationReports) {
        const inserted = await client.query<{ report_id: string }>(
          `INSERT INTO validation_reports (report_id, report)
           VALUES ($1, $2::jsonb)
           ON CONFLICT (report_id) DO NOTHING
           RETURNING report_id`,
          [report.id, JSON.stringify(report)],
        );
        if ((inserted.rowCount ?? 0) > 0) continue;
        const { rows } = await client.query<{ report: ValidationReport | string }>(
          'SELECT report FROM validation_reports WHERE report_id = $1',
          [report.id],
        );
        const existingRaw = rows[0]?.report;
        if (existingRaw === undefined) throw new ValidationReportConflictError(report.id);
        if (!validationReportsEqual(toValidationReport(existingRaw), report)) {
          throw new ValidationReportConflictError(report.id);
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    this.#markPersisted(written);
  }

  #changedProjects(): { projectId: string; snapshot: string; expected: number | undefined }[] {
    const pending: { projectId: string; snapshot: string; expected: number | undefined }[] = [];
    for (const [projectId, project] of this.#projects) {
      const snapshot = JSON.stringify(project.toSnapshot());
      if (this.#persisted.get(projectId) === snapshot) continue;
      pending.push({ projectId, snapshot, expected: this.#versions.get(projectId) });
    }
    return pending;
  }

  async #assertClaimFences(client: pg.PoolClient, fences: readonly ClaimFence[]): Promise<void> {
    for (const fence of fences) {
      const selected = await client.query<{ hop: QueuedHop }>(
        'SELECT hop FROM queued_hops WHERE hop_id = $1 FOR UPDATE',
        [fence.id],
      );
      if (!holdsCurrentClaim(selected.rows[0]?.hop, fence)) {
        throw new Error('claim fence rejected');
      }
    }
  }

  /** 在给定的数据库事务里写快照；版本对不上抛 WriteConflictError（调用方回滚）。不碰记账。 */
  async #writeProjects(
    client: pg.PoolClient,
    pending: readonly { projectId: string; snapshot: string; expected: number | undefined }[],
  ): Promise<{ projectId: string; snapshot: string; version: number }[]> {
    const written: { projectId: string; snapshot: string; version: number }[] = [];
    for (const { projectId, snapshot, expected } of pending) {
      if (expected === undefined) {
        await client.query('INSERT INTO projects (project_id, snapshot) VALUES ($1, $2::jsonb)', [
          projectId,
          snapshot,
        ]);
        written.push({ projectId, snapshot, version: 1 });
        continue;
      }
      const { rowCount } = await client.query(
        `UPDATE projects
            SET snapshot = $2::jsonb, version = version + 1, updated_at = now()
          WHERE project_id = $1 AND version = $3`,
        [projectId, snapshot, expected],
      );
      if (rowCount === 0) throw new WriteConflictError(projectId);
      written.push({ projectId, snapshot, version: expected + 1 });
    }
    return written;
  }

  /** 只在 COMMIT 成功之后调：早先边写边前移，回滚了记账却没退，之后每次写都顶成冲突。 */
  #markPersisted(written: readonly { projectId: string; snapshot: string; version: number }[]): void {
    for (const { projectId, snapshot, version } of written) {
      this.#versions.set(projectId, version);
      this.#persisted.set(projectId, snapshot);
    }
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
   *
   * 命令事务开着时：事务里的 flush 不写（提交时一起写）；事务外的等事务结束再写。
   */
  flush(): Promise<void> {
    const tx = this.#tx;
    if (tx) {
      if (this.#txContext.getStore() === tx) return Promise.resolve();
      return tx.done.then(() => this.flush());
    }
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
    const pending = this.#changedProjects();
    if (pending.length === 0) return;

    const client = await this.#pool.connect();
    let written: { projectId: string; snapshot: string; version: number }[];
    try {
      await client.query('BEGIN');
      written = await this.#writeProjects(client, pending);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    this.#markPersisted(written);
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
    await this.#store.settle();
    this.#store.projectsMap().set(project.id, project);
    await this.#store.flush();
  }

  async list(): Promise<readonly Project[]> {
    return [...this.#store.projectsMap().values()];
  }

  async ensure(projectId: string): Promise<Project> {
    await this.#store.settle();
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
    const row: ActivityEvent = { ...event, at: this.#clock.now().toISOString() };
    // 命令事务里：暂存，提交时与快照、投递同一个数据库事务写下（C3）。
    const tx = this.#store.currentTransaction();
    if (tx) {
      tx.events.push(row);
      return;
    }
    await this.#store.settle();
    // 一条 INSERT。文件版在这里要把整份状态重写一遍。
    await this.#store.pool.query(INSERT_ACTIVITY, activityParams(row));
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
    // 事务里读得到自己暂存的事件。
    const staged = this.#store.currentTransaction()?.events.filter((e) => e.missionId === missionId) ?? [];
    return [...rows.map(toEvent), ...staged];
  }

  async all(): Promise<readonly ActivityEvent[]> {
    const { rows } = await this.#store.pool.query(
      `SELECT project_id, mission_id, work_item_id, attempt_id, kind, data, at,
              protocol_version, message_id, correlation_id, causation_id,
              contract_revision, plan_revision
         FROM activity ORDER BY seq`,
    );
    return [...rows.map(toEvent), ...(this.#store.currentTransaction()?.events ?? [])];
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
    const tx = this.#store.currentTransaction();
    if (tx) return this.#stage(tx, input);
    await this.#store.settle();
    // ON CONFLICT DO NOTHING + 回查：幂等由唯一索引保证，不靠「先 SELECT
    // 再 INSERT」那种在并发下会双开的写法。
    const delivery = this.#newDelivery(input);
    await this.#store.pool.query(INSERT_DELIVERY, deliveryParams(delivery));
    const { rows } = await this.#store.pool.query(
      'SELECT * FROM deliveries WHERE mission_id = $1 AND idempotency_key = $2',
      [input.missionId, input.idempotencyKey],
    );
    return toDelivery(rows[0]);
  }

  /**
   * 命令事务里：暂存，提交时 ON CONFLICT DO NOTHING（唯一约束仍是最终保证）。先看暂存与库里有没有
   * 同键的，只为返回对的那一条——库里已有的原样拿回。
   */
  async #stage(
    tx: PgOpenTransaction,
    input: Omit<Delivery, 'id' | 'createdAt' | 'status' | 'acknowledgedAt'>,
  ): Promise<Delivery> {
    const staged = tx.deliveries.find(
      (row) => row.missionId === input.missionId && row.idempotencyKey === input.idempotencyKey,
    );
    if (staged) return staged;
    const { rows } = await this.#store.pool.query(
      'SELECT * FROM deliveries WHERE mission_id = $1 AND idempotency_key = $2',
      [input.missionId, input.idempotencyKey],
    );
    if (rows[0]) return this.#withStagedAck(tx, toDelivery(rows[0]));
    const delivery = this.#newDelivery(input);
    tx.deliveries.push(delivery);
    return delivery;
  }

  #newDelivery(input: Omit<Delivery, 'id' | 'createdAt' | 'status' | 'acknowledgedAt'>): Delivery {
    return {
      ...input,
      id: this.#ids.next('D'),
      createdAt: this.#clock.now().toISOString(),
      status: 'pending',
    };
  }

  /** 事务里暂存了确认的，读出来按已确认给。 */
  #withStagedAck(tx: PgOpenTransaction | undefined, row: Delivery): Delivery {
    const at = tx?.acknowledgements.get(row.id);
    if (!at || row.status === 'acknowledged') return row;
    return { ...row, status: 'acknowledged', acknowledgedAt: at };
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
    const tx = this.#store.currentTransaction();
    const fromDb = rows.map(toDelivery).filter((row) => !tx?.acknowledgements.has(row.id));
    const staged = (tx?.deliveries ?? []).filter(
      (row) => !tx?.acknowledgements.has(row.id) && (!recipient || row.recipient === recipient),
    );
    return [...fromDb, ...staged];
  }

  async acknowledge(deliveryId: string): Promise<Delivery | undefined> {
    const tx = this.#store.currentTransaction();
    if (tx) {
      const current = await this.get(deliveryId);
      if (!current) return undefined;
      if (current.status === 'acknowledged') return current;
      const at = this.#clock.now().toISOString();
      tx.acknowledgements.set(deliveryId, at);
      return { ...current, status: 'acknowledged', acknowledgedAt: at };
    }
    await this.#store.settle();
    const { rows } = await this.#store.pool.query(ACKNOWLEDGE_DELIVERY, [
      deliveryId,
      this.#clock.now().toISOString(),
    ]);
    return rows[0] ? toDelivery(rows[0]) : undefined;
  }

  async get(deliveryId: string): Promise<Delivery | undefined> {
    const tx = this.#store.currentTransaction();
    const staged = tx?.deliveries.find((row) => row.id === deliveryId);
    if (staged) return this.#withStagedAck(tx, staged);
    const { rows } = await this.#store.pool.query(
      'SELECT * FROM deliveries WHERE delivery_id = $1',
      [deliveryId],
    );
    return rows[0] ? this.#withStagedAck(tx, toDelivery(rows[0])) : undefined;
  }

  async listForMission(missionId: string): Promise<readonly Delivery[]> {
    const { rows } = await this.#store.pool.query(
      'SELECT * FROM deliveries WHERE mission_id = $1 ORDER BY created_at',
      [missionId],
    );
    const tx = this.#store.currentTransaction();
    const fromDb = rows.map((row) => this.#withStagedAck(tx, toDelivery(row)));
    const seen = new Set(fromDb.map((row) => row.idempotencyKey));
    // 命令事务里要把暂存的投递算进来，否则补建在同一事务里会看成「还没有」。
    const staged = (tx?.deliveries ?? [])
      .filter((row) => row.missionId === missionId && !seen.has(row.idempotencyKey))
      .map((row) => this.#withStagedAck(tx, row));
    return [...fromDb, ...staged];
  }
}

function toDelivery(row: Record<string, unknown>): Delivery {
  return {
    id: row.delivery_id as string,
    missionId: row.mission_id as string,
    projectId: row.project_id as string,
    outcome: row.outcome as Delivery['outcome'],
    idempotencyKey: row.idempotency_key as string,
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

/** Persistent profile circuit state; conditional writes make probe ownership global to the database. */
export class PgCandidateCircuitRepository implements CandidateCircuitRepository {
  #pool: pg.Pool;

  constructor(store: PgStateStore) { this.#pool = store.pool; }

  async get(profileId: string): Promise<CandidateCircuit> {
    const { rows } = await this.#pool.query<{
      state: string; failure_class: string | null; open_until: Date | string | null; probe_claimed: boolean;
    }>('SELECT state, failure_class, open_until, probe_claimed FROM candidate_circuits WHERE profile_id = $1', [profileId]);
    const row = rows[0];
    if (!row || row.state === 'closed') return closedCandidateCircuit(profileId);
    const openUntil = row.open_until instanceof Date ? row.open_until.toISOString() : new Date(row.open_until!).toISOString();
    if (row.state === 'half_open' && row.probe_claimed) {
      return { profileId, state: 'half_open', failureClass: row.failure_class!, openUntil, probeClaimed: true };
    }
    return { profileId, state: 'open', failureClass: row.failure_class!, openUntil };
  }

  async open(input: OpenCandidateCircuitInput): Promise<CandidateCircuit> {
    const circuit = openCandidateCircuit(input);
    await this.#pool.query(
      `INSERT INTO candidate_circuits (profile_id, state, failure_class, open_until, probe_claimed)
       VALUES ($1, 'open', $2, $3::timestamptz, false)
       ON CONFLICT (profile_id) DO UPDATE SET state = 'open', failure_class = EXCLUDED.failure_class,
         open_until = EXCLUDED.open_until, probe_claimed = false`,
      [circuit.profileId, circuit.failureClass, circuit.openUntil],
    );
    return circuit;
  }

  async tryClaimProbe(input: ClaimCandidateProbeInput): Promise<boolean> {
    validateClaimCandidateProbe(input);
    const { rows } = await this.#pool.query(
      `UPDATE candidate_circuits SET state = 'half_open', probe_claimed = true
       WHERE profile_id = $1 AND state = 'open' AND open_until <= $2::timestamptz
       RETURNING profile_id`, [input.profileId, input.now],
    );
    return rows.length === 1;
  }

  async resolveProbe(input: ResolveCandidateProbeInput): Promise<CandidateCircuit> {
    validateResolveCandidateProbe(input);
    const { rows } = input.succeeded
      ? await this.#pool.query(
          `UPDATE candidate_circuits SET state = 'closed', failure_class = NULL, open_until = NULL, probe_claimed = false
           WHERE profile_id = $1 AND state = 'half_open' AND probe_claimed = true RETURNING profile_id`, [input.profileId])
      : await this.#pool.query(
          `UPDATE candidate_circuits SET state = 'open', failure_class = $2, open_until = $3::timestamptz, probe_claimed = false
           WHERE profile_id = $1 AND state = 'half_open' AND probe_claimed = true RETURNING profile_id`,
          [input.profileId, input.failureClass, input.openUntil]);
    if (rows.length !== 1) throw new Error('candidate probe is not claimed');
    return input.succeeded ? closedCandidateCircuit(input.profileId) : openCandidateCircuit({
      profileId: input.profileId, failureClass: input.failureClass!, openUntil: input.openUntil!,
    });
  }
}

/**
 * 持久化 queued Hop；幂等键的唯一约束由数据库保证跨进程并发时也只保留一项。
 */
export class PgQueuedHopRepository {
  #pool: pg.Pool;

  constructor(store: PgStateStore) { this.#pool = store.pool; }

  async enqueue(hop: QueuedHop): Promise<QueuedHop> {
    const { status: _status, owner: _owner, leaseUntil: _leaseUntil, claimGeneration: _generation, ...input } = hop;
    validateEnqueueHop(input);
    if (typeof hop.id !== 'string' || hop.id.trim().length === 0 || hop.status !== 'queued' ||
        typeof hop.createdAt !== 'string' || !Number.isFinite(Date.parse(hop.createdAt)) ||
        typeof hop.updatedAt !== 'string' || !Number.isFinite(Date.parse(hop.updatedAt))) {
      throw new Error('queued hop record is invalid');
    }
    const { rows } = await this.#pool.query<{ hop: QueuedHop }>(
      `INSERT INTO queued_hops (hop_id, idempotency_key, hop) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING hop`,
      [hop.id, hop.idempotencyKey, JSON.stringify(hop)],
    );
    if (rows[0]) return { ...rows[0].hop };
    const existing = await this.#pool.query<{ hop: QueuedHop }>(
      'SELECT hop FROM queued_hops WHERE idempotency_key = $1', [hop.idempotencyKey]);
    if (existing.rows[0]) return { ...existing.rows[0].hop };
    throw new Error('queued hop insert conflict without existing idempotency key');
  }

  async claim(id: string, owner: string, now: string, leaseUntil: string): Promise<QueuedHop | undefined> {
    return this.#transition(id, (hop) => claimHop(hop, owner, now, leaseUntil));
  }

  async renew(id: string, owner: string, claimGeneration: number, now: string, leaseUntil: string): Promise<QueuedHop | undefined> {
    return this.#transition(id, (hop) => renewHop(hop, owner, claimGeneration, now, leaseUntil));
  }

  async complete(id: string, owner: string, claimGeneration: number, now: string): Promise<QueuedHop | undefined> {
    return this.#transition(id, (hop) => completeHop(hop, owner, claimGeneration, now));
  }

  async #transition(id: string, transition: (hop: QueuedHop) => QueuedHop | undefined): Promise<QueuedHop | undefined> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<{ hop: QueuedHop }>('SELECT hop FROM queued_hops WHERE hop_id = $1 FOR UPDATE', [id]);
      const current = selected.rows[0]?.hop;
      if (!current) { await client.query('COMMIT'); return undefined; }
      const updated = transition(current);
      if (!updated) { await client.query('ROLLBACK'); return undefined; }
      const written = await client.query('UPDATE queued_hops SET hop = $2::jsonb WHERE hop_id = $1 AND hop = $3::jsonb',
        [id, JSON.stringify(updated), JSON.stringify(current)]);
      if (written.rowCount !== 1) { await client.query('ROLLBACK'); return undefined; }
      await client.query('COMMIT');
      return { ...updated };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async get(id: string): Promise<QueuedHop | undefined> {
    const { rows } = await this.#pool.query<{ hop: QueuedHop }>('SELECT hop FROM queued_hops WHERE hop_id = $1', [id]);
    return rows[0] ? { ...rows[0].hop } : undefined;
  }

  async list(): Promise<readonly QueuedHop[]> {
    const { rows } = await this.#pool.query<{ hop: QueuedHop }>('SELECT hop FROM queued_hops ORDER BY hop_id');
    return rows.map(({ hop }) => ({ ...hop }));
  }
}

/**
 * ValidationReport 的 Postgres 仓储。
 *
 * 命令事务里先暂存，提交时与 validation.reported / accept 同一个数据库事务落下——
 * 机器验收崩在中间不能留下孤儿报告。事务外仍是 INSERT ... ON CONFLICT DO NOTHING；
 * 已存在则结构相等幂等，不等 conflict。绝不 UPDATE report。
 */
export class PgValidationReportRepository implements ValidationReportRepository {
  #store: PgStateStore;

  constructor(store: PgStateStore) {
    this.#store = store;
  }

  async save(report: ValidationReport): Promise<void> {
    const tx = this.#store.currentTransaction();
    if (tx) {
      const staged = tx.validationReports.find((row) => row.id === report.id);
      if (staged) {
        if (validationReportsEqual(staged, report)) return;
        throw new ValidationReportConflictError(report.id);
      }
      const { rows } = await this.#store.pool.query<{ report: ValidationReport | string }>(
        'SELECT report FROM validation_reports WHERE report_id = $1',
        [report.id],
      );
      const existingRaw = rows[0]?.report;
      if (existingRaw !== undefined) {
        if (validationReportsEqual(toValidationReport(existingRaw), report)) return;
        throw new ValidationReportConflictError(report.id);
      }
      // clone 再暂存：不 freeze/mutate caller；回滚时数组一起丢，库里不会有半份。
      tx.validationReports.push(cloneValidationReport(report));
      return;
    }
    await this.#store.settle();
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
    const tx = this.#store.currentTransaction();
    const staged = tx?.validationReports.find((row) => row.id === reportId);
    if (staged) return cloneValidationReport(staged);
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
