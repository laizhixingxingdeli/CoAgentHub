/**
 * 装配根。把实现装进平台，把平台装进 HTTP 面。
 *
 * 两种装法：
 *   buildPlatform()            —— 全内存，测试与一次性运行用
 *   buildPersistentPlatform()  —— 状态落到一个 JSON 文件，跨重启还在
 *
 * 换 PostgreSQL 时只改这里：用例层与领域层不知道存储在哪。
 */

import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApi } from './api/server.ts';
import { RunTokenRegistry } from './api/run-tokens.ts';
import {
  InMemoryActivityLog,
  InMemoryProjectRepository,
  InMemoryQueryRunRepository,
  SequentialIds,
  SystemClock,
} from './application/in-memory.ts';
import { Platform } from './application/platform.ts';
import { QueryRunner } from './application/query-run.ts';
import type { AgentRuntime } from './application/ports.ts';
import { InMemoryAgentPoolRepository, loadPoolOrSeed } from './application/agent-pool.ts';
import { FileArtifactStore } from './application/artifact-store.ts';
import { InMemoryDeliveryRepository } from './application/delivery.ts';
import {
  FileActivityLog,
  FileAgentPoolRepository,
  FileDeliveryRepository,
  FileProjectRepository,
  FileQueryRunRepository,
  FileStateStore,
  FileValidationReportRepository,
  PersistentIds,
} from './application/file-store.ts';
import {
  PgActivityLog,
  PgAgentPoolRepository,
  PgDeliveryRepository,
  PgIds,
  PgLiveOutput,
  PgProjectRepository,
  PgQueryRunRepository,
  PgStateStore,
  PgValidationReportRepository,
} from './application/pg-store.ts';
import { acquireLock } from './application/lock.ts';
import {
  reconcileInterruptedAttempts,
  reconcileOrphanedWorktrees,
} from './application/reconcile.ts';
import type { RunTokenIssuer } from './application/token-issuer.ts';
import type { WorkspaceManager, WorktreeReconcileResult } from './application/workspace.ts';
import { GitWorktreeManager } from './application/workspace.ts';
import {
  assertDecisionModeStartup,
  parseDecisionHooks,
  parseDecisionMode,
} from './application/decision-mode.ts';
import { createDecisionProvider } from './application/decision-provider-factory.ts';
import type { DecisionHook, DecisionProvider } from './application/ports.ts';
import { createPiQueryRuntime } from './runtime/pi-query.ts';
import { ValidationEngine } from './application/validation/engine.ts';
import { ExecFileCommandRunner } from './application/validation/exec-file-command-runner.ts';
import { WorkspaceChangedPathReader } from './application/validation/workspace-changed-path-reader.ts';
import { WorkspaceDiffFactReader } from './application/validation/workspace-diff-fact-reader.ts';
import { InMemoryValidationReportRepository } from './application/validation/report-repository.ts';

export function buildPlatform(
  workspace?: WorkspaceManager,
  decisionProvider?: DecisionProvider,
  /**
   * 可选 query runtime。仅当 runtime **显式** `supportsQuery === true`
   * 时才暴露 `queryRunner` / `runQuery`；未传或不支持则保持 undefined
   * （fail-closed，不凭 kind 猜测）。
   */
  queryRuntime?: AgentRuntime,
  /** 注入了 provider 时哪些钩子跑 shadow；缺省见 parseDecisionHooks。 */
  decisionHooks?: ReadonlySet<DecisionHook>,
) {
  const clock = new SystemClock();
  const projects = new InMemoryProjectRepository();
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  // 全内存装法：QueryRun 进程内记忆。Durable 见 buildPersistent / buildPg。
  const queryRuns = new InMemoryQueryRunRepository();
  // 仅 workspace 有值时注入 validation；无 workspace 保持缺省 fail-closed。
  const commandRunner = new ExecFileCommandRunner();
  const validation = workspace
    ? {
        engine: new ValidationEngine({
          clock,
          ids,
          commandRunner,
          changedPathReader: new WorkspaceChangedPathReader(workspace),
          diffFactReader: new WorkspaceDiffFactReader(workspace),
        }),
        reports: new InMemoryValidationReportRepository(),
        // 机器 L3 在合并结果上跑方案级命令用。不给就 fail-closed（MACHINE_FINALIZE_UNAVAILABLE）
        // ——F2 只在注入了替身的测试里跑通过，真实装配一直没给。
        commandRunner,
      }
    : undefined;
  const platform = new Platform({
    projects,
    deliveries,
    workspace,
    activity,
    clock,
    ids,
    ...(decisionProvider ? { decisionProvider } : {}),
    ...(decisionHooks ? { decisionHooks } : {}),
    ...(validation ? { validation } : {}),
  });
  const tokens = new RunTokenRegistry();
  // 未声明 supportsQuery 的 runtime（含 Spawn/Pi/未知）不得伪装成 read-only query。
  const queryRunner =
    queryRuntime?.supportsQuery === true
      ? new QueryRunner({ runtime: queryRuntime, queryRuns, clock, ids })
      : undefined;
  return {
    platform,
    activity,
    projects,
    deliveries,
    queryRuns,
    queryRunner,
    /** 可编程 query 入口；无 query-capable runtime 时为 undefined。 */
    runQuery: queryRunner
      ? (input: Parameters<QueryRunner['runQuery']>[0]) => queryRunner.runQuery(input)
      : undefined,
    tokens,
    agentPool: new InMemoryAgentPoolRepository(),
    issuer: makeIssuer(platform, tokens),
    persist: () => {},
  };
}

export interface PersistentOptions {
  workspace?: WorkspaceManager;
  decisionProvider?: DecisionProvider;
  /** 注入了 provider 时哪些钩子跑 shadow；缺省见 parseDecisionHooks。 */
  decisionHooks?: ReadonlySet<DecisionHook>;
  /**
   * 是否要排他写锁。
   *
   * 会推进状态的入口（run-mission、l3）必须要；只读的观测面不要——
   * 它要锁就等于一开着界面就没法干活了。
   */
  exclusive?: { what: string };
  /**
   * 可选 query runtime。仅 `supportsQuery === true` 时暴露 queryRunner/runQuery；
   * 未传或不支持则 undefined（fail-closed）。
   */
  queryRuntime?: AgentRuntime;
  /**
   * 启动时收不收敛残留的 attempt。缺省收。
   *
   * **只看结果的命令传 false。** 它没有立场判定别的进程死了：run-plan 刚开一跳时
   * attempt 已经落盘、spawn 还没回来、第一次心跳还没打——这几秒里它就是「从没
   * 心跳过」。只读命令在这时起来收敛，会把它判死并**整份写回状态文件**，而写者
   * 正握着锁在写：两个写者，后写的盖掉先写的，悄无声息。PG 那边 l3 早就不收敛了，
   * 文件版补上同一条规矩。
   */
  reconcile?: boolean;
}

export async function buildPersistentPlatform(
  statePath: string,
  workspaceOrOptions?: WorkspaceManager | PersistentOptions,
) {
  const options: PersistentOptions =
    workspaceOrOptions && 'prepare' in workspaceOrOptions
      ? { workspace: workspaceOrOptions }
      : (workspaceOrOptions ?? {});
  const workspace = options.workspace ?? new GitWorktreeManager();
  const decisionProvider = options.decisionProvider;
  const decisionHooks = options.decisionHooks;
  const releaseLock = options.exclusive
    ? acquireLock(statePath, options.exclusive.what)
    : () => {};
  const clock = new SystemClock();
  const store = new FileStateStore(statePath);
  const projects = new FileProjectRepository(store);
  const activity = new FileActivityLog(store, clock);
  const ids = new PersistentIds(store);
  const deliveries = new FileDeliveryRepository(store, clock, ids);
  const queryRuns = new FileQueryRunRepository(store);
  // 大输出外置到状态文件旁边的 artifacts/ 目录。
  const artifacts = new FileArtifactStore(resolve(statePath, '..', 'artifacts'));
  // 与 Platform/WorkspaceManager 共用同一个已 resolved workspace。
  const commandRunner = new ExecFileCommandRunner();
  const validation = {
    engine: new ValidationEngine({
      clock,
      ids,
      commandRunner,
      changedPathReader: new WorkspaceChangedPathReader(workspace),
      diffFactReader: new WorkspaceDiffFactReader(workspace),
    }),
    reports: new FileValidationReportRepository(store),
    // 机器 L3 用；见 buildPlatform 里同一处。
    commandRunner,
  };
  const platform = new Platform({
    projects,
    deliveries,
    artifacts,
    workspace,
    activity,
    clock,
    ids,
    ...(decisionProvider ? { decisionProvider } : {}),
    ...(decisionHooks ? { decisionHooks } : {}),
    validation,
  });
  const tokens = new RunTokenRegistry();
  const queryRuntime = options.queryRuntime;
  const queryRunner =
    queryRuntime?.supportsQuery === true
      ? new QueryRunner({ runtime: queryRuntime, queryRuns, clock, ids })
      : undefined;

  // 刚起来 = 没有任何 attempt 可能还活着。不收敛的话，上一次崩溃留下的
  // in_progress 会把对应的 Mission / 工作项永久卡死。
  const reconciled =
    options.reconcile === false
      ? { interrupted: [], alive: [], liveTrimmed: [], liveTrimFailed: [] }
      : await reconcileInterruptedAttempts(await projects.list(), activity);
  if (reconciled.interrupted.length > 0) {
    store.flush();
  }

  // 孤儿 worktree 只在**排他写**路径上做：只读观测面 / 共享 PG 不能全局清目录。
  // 失败只记 warning，不挡启动。
  let workspaceReconciled: WorktreeReconcileResult | undefined;
  if (options.exclusive) {
    try {
      workspaceReconciled = await reconcileOrphanedWorktrees(await projects.list(), workspace);
      if (workspaceReconciled.warnings.length > 0) {
        for (const w of workspaceReconciled.warnings) {
          console.warn(`[worktree reconcile] ${w}`);
        }
      }
    } catch (error) {
      console.warn(
        `[worktree reconcile] 启动收敛失败（不阻断）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      workspaceReconciled = {
        removed: [],
        kept: [],
        warnings: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  return {
    platform,
    activity,
    projects,
    deliveries,
    queryRuns,
    queryRunner,
    runQuery: queryRunner
      ? (input: Parameters<QueryRunner['runQuery']>[0]) => queryRunner.runQuery(input)
      : undefined,
    store,
    reconciled,
    workspaceReconciled,
    tokens,
    agentPool: new FileAgentPoolRepository(store),
    issuer: makeIssuer(platform, tokens),
    persist: () => store.flush(),
    releaseLock,
  };
}

/**
 * Postgres 装法。
 *
 * 与文件版**并存**：文件版负责"没装数据库也能跑"，这一版负责多进程并发。
 * 领域层与用例层两边都不用改一个字——这正是端口存在的意义。
 */
export async function buildPgPlatform(options?: {
  connectionString?: string;
  workspace?: WorkspaceManager;
  artifactRoot?: string;
  decisionProvider?: DecisionProvider;
  decisionHooks?: ReadonlySet<DecisionHook>;
  /**
   * 接手哪条 Mission —— 传了才做启动收敛，而且只收敛这一条。
   *
   * **只读进程不要传。** 共用一份状态时，「刚起来所以没人在跑」这个前提
   * 不再成立：实测重启一次观测面就把正在跑的 attempt 判死写回库了。
   */
  reconcileMissionId?: string;
  /**
   * 可选 query runtime。仅 `supportsQuery === true` 时暴露 queryRunner/runQuery；
   * 未传或不支持则 undefined（fail-closed）。
   */
  queryRuntime?: AgentRuntime;
}) {
  const clock = new SystemClock();
  const store = await PgStateStore.open(
    options?.connectionString ? { connectionString: options.connectionString } : undefined,
  );
  await PgLiveOutput.ensureSchema(store);
  const projects = new PgProjectRepository(store);
  const activity = new PgActivityLog(store, clock);
  const live = new PgLiveOutput(store);
  const ids = new PgIds(store);
  // 预热号段：不预热的话第一次 next() 会撞上"号段用尽"，
  // 而那对调用方来说只是一次莫名其妙的失败。含 Q / VR。
  await ids.reserve();
  const deliveries = new PgDeliveryRepository(store, clock, ids);
  const queryRuns = new PgQueryRunRepository(store);
  const artifacts = new FileArtifactStore(
    resolve(options?.artifactRoot ?? '.coagent-artifacts'),
  );
  const decisionProvider = options?.decisionProvider;
  const decisionHooks = options?.decisionHooks;
  // Platform 与 ValidationEngine 必须共享同一个 WorkspaceManager 实例。
  const workspace = options?.workspace ?? new GitWorktreeManager();
  const commandRunner = new ExecFileCommandRunner();
  const validation = {
    engine: new ValidationEngine({
      clock,
      ids,
      commandRunner,
      changedPathReader: new WorkspaceChangedPathReader(workspace),
      diffFactReader: new WorkspaceDiffFactReader(workspace),
    }),
    reports: new PgValidationReportRepository(store),
    // 机器 L3 用；见 buildPlatform 里同一处。
    commandRunner,
  };
  const platform = new Platform({
    projects,
    deliveries,
    artifacts,
    workspace,
    activity,
    clock,
    ids,
    ...(decisionProvider ? { decisionProvider } : {}),
    ...(decisionHooks ? { decisionHooks } : {}),
    validation,
  });
  const tokens = new RunTokenRegistry();
  const queryRuntime = options?.queryRuntime;
  const queryRunner =
    queryRuntime?.supportsQuery === true
      ? new QueryRunner({ runtime: queryRuntime, queryRuns, clock, ids })
      : undefined;

  // 传 live：收敛判死的那些跳正是**没跑到 Orchestrator finally** 的那些，
  // 它们的实时输出至今没被裁过。只在限定 missionId 的写路径上做——只读观测面
  // 根本不调这里。
  const reconciled = options?.reconcileMissionId
    ? await reconcileInterruptedAttempts(await projects.list(), activity, {
        missionId: options.reconcileMissionId,
        live,
      })
    : { interrupted: [], alive: [], liveTrimmed: [], liveTrimFailed: [] };
  if (reconciled.interrupted.length > 0) await store.flush();

  return {
    platform,
    activity,
    projects,
    deliveries,
    queryRuns,
    queryRunner,
    runQuery: queryRunner
      ? (input: Parameters<QueryRunner['runQuery']>[0]) => queryRunner.runQuery(input)
      : undefined,
    store,
    live,
    reconciled,
    tokens,
    agentPool: new PgAgentPoolRepository(store),
    issuer: makeIssuer(platform, tokens),
    persist: () => projects.persist(),
    // 读请求前刷新：别的进程写过的东西，这个进程要看得见。
    refresh: () => store.refresh(),
    close: () => store.close(),
  };
}

/** 把「开 attempt」和「发 token」这两件事粘起来，交给调度器用。 */
export function makeIssuer(platform: Platform, tokens: RunTokenRegistry): RunTokenIssuer {
  return {
    async startCoordinator(missionId, profile) {
      const { attemptId } = await platform.startCoordinatorAttempt(missionId, profile);
      const run = tokens.issue({ missionId, attemptId, role: 'coordinator' });
      return { attemptId, token: run.token };
    },
    async startExecutor(missionId, workItemId, profile) {
      const { attemptId } = await platform.startExecutorAttempt(missionId, workItemId, profile);
      const run = tokens.issue({ missionId, attemptId, role: 'executor', workItemId });
      return { attemptId, token: run.token };
    },
    revoke(token) {
      tokens.revoke(token);
    },
  };
}

/**
 * 起观测面 / API。
 *
 * 存储选哪个由 COAGENT_STORE 决定（pg / file）。缺省仍是文件版——
 * 没装 Postgres 的人 clone 下来就能跑，这条性质不能因为多了一个选项就丢掉。
 */
export interface StartServerOptions {
  /** 可注入 fetch（测试用 fake；生产默认 globalThis.fetch）。 */
  fetch?: typeof globalThis.fetch;
  /** 可注入 env（测试用；生产默认 process.env）。 */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export async function startServer(
  port = 3101,
  statePath = '.coagent-state.json',
  options?: StartServerOptions,
) {
  // Decision 模式：在任何持久化 / 锁 / listen 之前 factory + 启动门禁。
  const env = options?.env ?? process.env;
  const decisionMode = parseDecisionMode(env.COAGENT_DECISION_MODE);
  const decisionProvider =
    decisionMode === 'shadow'
      ? createDecisionProvider({
          mode: decisionMode,
          env,
          fetch: options?.fetch ?? globalThis.fetch,
        })
      : undefined;
  assertDecisionModeStartup({
    mode: decisionMode,
    providerAvailable: Boolean(decisionProvider),
  });
  // 只在 shadow 下读：OFF 模式不碰任何 decision 相关 env（规格要求）。
  const decisionHooks =
    decisionMode === 'shadow' ? parseDecisionHooks(env.COAGENT_DECISION_HOOKS) : undefined;

  const usePg = (env.COAGENT_STORE ?? process.env.COAGENT_STORE ?? 'file') === 'pg';
  // Query runtime：只看已解析的 env（options.env 优先），双键 opt-in + 路径存在。
  // 未启用时 queryRuntime 为 undefined，builder 保持 runQuery 关闭。
  const queryRuntime = createPiQueryRuntime(env);
  const built = usePg
    ? await buildPgPlatform({ decisionProvider, decisionHooks, queryRuntime })
    : await buildPersistentPlatform(statePath, { decisionProvider, decisionHooks, queryRuntime });
  const server = createApi({
    platform: built.platform,
    tokens: built.tokens,
    deliveries: built.deliveries,
    onMutation: built.persist,
    agentPool: built.agentPool,
    live: 'live' in built ? built.live : undefined,
    beforeRead: 'refresh' in built ? built.refresh : undefined,
  });
  // 显式绑 loopback：观测面/API 不对外网口开放。动态 port=0 时日志必须读
  // server.address()，不能回显调用方传入的 port（那会打出 :0）。
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  const addr = server.address() as AddressInfo;
  console.log(`CoAgentHub v5 平台已启动：http://${addr.address}:${addr.port}`);
  console.log(
    usePg
      ? '存储：PostgreSQL'
      : `存储：文件 ${'store' in built && 'path' in built.store ? built.store.path : statePath}`,
  );
  if (built.reconciled.interrupted.length > 0) {
    console.log(
      `启动收敛：${built.reconciled.interrupted.length} 个上次残留的 attempt 被判为 interrupted`,
    );
  }
  // 裁不动要说出来：那一跳的实时行还在无限留着，而收敛已经过去了，
  // 不说就再没有第二次提醒。
  for (const failed of built.reconciled.liveTrimFailed ?? []) {
    console.warn(
      `[live reconcile] ${failed.missionId}/${failed.attemptId} 实时输出未能裁剪：${failed.message}`,
    );
  }
  return { server, ...built };
}

// 直接 `node src/main.ts` 时启动；被 import 时不启动。
if (process.argv[1]?.endsWith('main.ts')) {
  void startServer(
    Number(process.env.PORT ?? 3101),
    process.env.COAGENT_STATE ?? '.coagent-state.json',
  );
}
