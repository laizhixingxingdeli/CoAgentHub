/**
 * 装配根。把实现装进平台，把平台装进 HTTP 面。
 *
 * 两种装法：
 *   buildPlatform()            —— 全内存，测试与一次性运行用
 *   buildPersistentPlatform()  —— 状态落到一个 JSON 文件，跨重启还在
 *
 * 换 PostgreSQL 时只改这里：用例层与领域层不知道存储在哪。
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { API_VERSION, createApi, drainApi, type ApiDeps } from './api/server.ts';
import type { ControlPrincipalResolver } from './api/control-auth.ts';
import { RunTokenRegistry } from './api/run-tokens.ts';
import {
  InMemoryActivityLog,
  InMemoryProjectRepository,
  InMemoryQueryRunRepository,
  SequentialIds,
  SystemClock,
} from './application/in-memory.ts';
import { Platform } from './application/platform.ts';
import { rememberAdapterDir } from './application/runtime-catalog.ts';
import { QueryRunner } from './application/query-run.ts';
import type { AgentRuntime } from './application/ports.ts';
import { MissionQueueWorker } from './application/mission-queue-worker.ts';
import { InMemoryAgentPoolRepository, loadRoleProfiles } from './application/agent-pool.ts';
import { FileArtifactStore } from './application/artifact-store.ts';
import { InMemoryLiveOutput, InMemoryPlanRunLiveOutput } from './application/live.ts';
import { InMemoryDeliveryRepository } from './application/delivery.ts';
import { FileChangeImpactRepository } from './application/change-impact-repository.ts';
import { FileChangeReceiptRepository } from './application/change-receipt-repository.ts';
import { FileChangeCoverageRepository } from './application/change-coverage-repository.ts';
import { FileContractHistoryRepository } from './application/contract-history-repository.ts';
import { FileAcceptanceDispositionRepository } from './application/acceptance-disposition-repository.ts';
import { FileChangeRequestRepository } from './application/change-request-repository.ts';
import {
  FileActivityLog,
  FileAgentPoolRepository,
  FileCandidateCircuitRepository,
  FileDeliveryRepository,
  FileProjectRepository,
  FileQueryRunRepository,
  FileQueuedHopRepository,
  FileStateStore,
  FileValidationReportRepository,
  PersistentIds,
} from './application/file-store.ts';
import {
  PgActivityLog,
  PgAgentPoolRepository,
  PgCandidateCircuitRepository,
  PgDeliveryRepository,
  PgIds,
  PgLiveOutput,
  PgProjectRepository,
  PgQueryRunRepository,
  PgQueuedHopRepository,
  PgStateStore,
  PgValidationReportRepository,
  PERIODIC_RECONCILE_LOCK_KEY1,
  PERIODIC_RECONCILE_LOCK_KEY2,
  tryPgAdvisoryLock,
} from './application/pg-store.ts';
import { acquireLock, acquireRecoverableLock, LockBusyError, publishLockPort, stateIdFor } from './application/lock.ts';
import { attachLoopbackWriterIdentity, listenLoopback } from './application/loopback-listen.ts';
import {
  parseReconcileIntervalMs,
  reconcileInterruptedAttempts,
  reconcileOrphanedWorktrees,
  repairMissingDeliveries,
  startPeriodicReconcile,
  type PeriodicReconcileHandle,
  type RepairMissingDeliveriesDeps,
  type RepairMissingDeliveriesResult,
} from './application/reconcile.ts';
import type { RunTokenIssuer } from './application/token-issuer.ts';
import type { WorkspaceManager, WorktreeReconcileResult } from './application/workspace.ts';
import { GitWorktreeManager } from './application/workspace.ts';
import {
  assertDecisionModeStartup,
  parseDecisionHooks,
  parseDecisionMode,
} from './application/decision-mode.ts';
import {
  createDecisionProvider,
  createPostExecutionEvaluator,
} from './application/decision-provider-factory.ts';
import type {
  DecisionHook,
  DecisionProvider,
  PostExecutionEvaluator,
} from './application/ports.ts';
import { runHostedMission, type HostedHeldState } from './application/mission-runner.ts';
import { runHostedPlan } from './application/plan-runtime.ts';
import { FilePlanRunStore } from './application/plan-run-store.ts';
import { createPiQueryRuntime } from './runtime/pi-query.ts';
import {
  parseAgentEnvPassthrough,
  SPAWN_ENV_PASSTHROUGH_VAR,
} from './runtime/spawn.ts';
import { ValidationEngine } from './application/validation/engine.ts';
import { ExecFileCommandRunner } from './application/validation/exec-file-command-runner.ts';
import { WorkspaceChangedPathReader } from './application/validation/workspace-changed-path-reader.ts';
import { WorkspaceDiffFactReader } from './application/validation/workspace-diff-fact-reader.ts';
import { InMemoryValidationReportRepository } from './application/validation/report-repository.ts';

export async function shutdownHostedPlan(input: {
  readonly runPath: string;
  readonly hostedMissionId?: string;
  readonly platform: Pick<Platform, 'pauseMission'>;
  readonly persist: () => Promise<void>;
  readonly now?: () => string;
  readonly waitForCreateMs?: number;
}): Promise<{ readonly pausedMissionIds: readonly string[]; readonly stopped: boolean }> {
  const store = new FilePlanRunStore(input.runPath);
  const deadline = Date.now() + (input.waitForCreateMs ?? 1_000);
  let run = store.read();
  while (!run && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    run = store.read();
  }
  if (!run) throw new Error(`不能安全关闭：PlanRun 记录尚未创建：${input.runPath}`);
  if (run.stopped) return { pausedMissionIds: [], stopped: false };

  const missionIds = new Set<string>();
  for (const feature of run.features) {
    if (feature.status === 'running') for (const id of feature.missionIds) missionIds.add(id);
  }
  if (input.hostedMissionId) missionIds.add(input.hostedMissionId);
  for (const missionId of missionIds) await input.platform.pauseMission(missionId);
  await input.persist();
  await store.update((latest) => {
    if (!latest.stopped) {
      latest.halt('service_shutdown', `服务受控关闭；已暂停 Mission：${[...missionIds].join(', ') || '无'}`, (input.now ?? (() => new Date().toISOString()))());
    }
  });
  return { pausedMissionIds: [...missionIds], stopped: true };
}

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
  /** 可选 POST_EXECUTION shadow 评估器（J2）；跑不跑还要看 decisionHooks。 */
  postExecutionEvaluator?: PostExecutionEvaluator,
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
    ...(postExecutionEvaluator ? { postExecutionEvaluator } : {}),
    ...(validation ? { validation } : {}),
  });
  const agentPool = new InMemoryAgentPoolRepository();
  const tokens = new RunTokenRegistry();
  // 未声明 supportsQuery 的 runtime（含 Spawn/Pi/未知）不得伪装成 read-only query。
  const queryRunner =
    queryRuntime?.supportsQuery === true
      ? new QueryRunner({ runtime: queryRuntime, queryRuns, clock, ids, loadCandidates: () => loadRoleProfiles(agentPool, 'classifier') })
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
    agentPool,
    issuer: makeIssuer(platform, tokens),
    persist: () => {},
  };
}

export interface PersistentOptions {
  workspace?: WorkspaceManager;
  decisionProvider?: DecisionProvider;
  /** 注入了 provider 时哪些钩子跑 shadow；缺省见 parseDecisionHooks。 */
  decisionHooks?: ReadonlySet<DecisionHook>;
  /** 可选 POST_EXECUTION shadow 评估器（J2）；跑不跑还要看 decisionHooks。 */
  postExecutionEvaluator?: PostExecutionEvaluator;
  /**
   * 是否要排他写锁。
   *
   * 会推进状态的入口（run-mission、l3、常驻 startServer）必须要；只读入口不要——
   * 只读入口要锁就等于一开着界面就没法干活了。常驻写者额外传 instanceId / apiVersion
   * 供本机探测；CLI 写者继续只传 what。
   */
  exclusive?: { what: string; instanceId?: string; apiVersion?: string };
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
  const postExecutionEvaluator = options.postExecutionEvaluator;
  const exclusiveIdentity =
    options.exclusive?.instanceId !== undefined && options.exclusive.apiVersion !== undefined
      ? { instanceId: options.exclusive.instanceId, apiVersion: options.exclusive.apiVersion }
      : undefined;
  const releaseLock = options.exclusive
    ? await acquireRecoverableLock(statePath, options.exclusive.what, exclusiveIdentity)
    : () => {};
  try {
  const clock = new SystemClock();
  const store = new FileStateStore(statePath);
  const candidateCircuits = new FileCandidateCircuitRepository(store);
  const queuedHops = new FileQueuedHopRepository(store);
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
  // 文件版调度器和观测面同进程，内存通道即可。不写入状态文件：实时输出是
  // 看的不是存的，落盘会把海量行和凭据形状带进备份。PG 仍用跨进程表。
  // 必须在 new Platform 之前建好：finishAttempt 要在落地前取本跳尾部。
  const live = new InMemoryLiveOutput();
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
    ...(postExecutionEvaluator ? { postExecutionEvaluator } : {}),
    validation,
    // 单事务命令（C2）：交卷与升级的状态、事件、投递一次写完。
    transaction: store,
    live,
    // 影响判断三件套与上面的 recurrence 共用同一个 store：多一个 FileStateStore
    // 实例就多一份内存副本，彼此互相盖。PG 装配**不**注入这一组——那里目前
    // 没有对应的 PG 仓储，注入文件版等于把两份存储焊在一起。
    changeRequests: new FileChangeRequestRepository(store),
    changeImpacts: new FileChangeImpactRepository(store),
    // 回执仓储与上面共用同一个 store：多一个 FileStateStore 实例就多一份内存副本，
    // 彼此互相盖。未装配即 CHANGE_RECEIPT_UNSUPPORTED——**不**另开 FileStateStore
    // 回退，那等于把两份存储焊在一起。内存 buildPlatform 与 PG 装配都不注入。
    changeReceipts: new FileChangeReceiptRepository(store),
    // 覆盖仓储与上面共用同一个 store：多一个 FileStateStore 实例就多一份内存副本，
    // 彼此互相盖。未装配即 CHANGE_COVERAGE_UNSUPPORTED——**不**另开 FileStateStore
    // 回退，那等于把两份存储焊在一起。内存 buildPlatform 与 PG 装配都不注入。
    changeCoverages: new FileChangeCoverageRepository(store),
    // 契约原文留档与上面共用同一个 store：多一个 FileStateStore 实例就多一份
    // 内存副本，彼此互相盖。未装配即不留原文——**不**另开 FileStateStore 回退，
    // 那等于把两份存储焊在一起。内存 buildPlatform 与 PG 装配都不注入。
    contractHistories: new FileContractHistoryRepository(store),
    acceptanceDispositions: new FileAcceptanceDispositionRepository(store),
    queuedHops,
  });
  const agentPool = new FileAgentPoolRepository(store);
  const tokens = new RunTokenRegistry();
  const queryRuntime = options.queryRuntime;
  const queryRunner =
    queryRuntime?.supportsQuery === true
      ? new QueryRunner({ runtime: queryRuntime, queryRuns, clock, ids, candidateCircuits, loadCandidates: () => loadRoleProfiles(agentPool, 'classifier') })
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
    candidateCircuits,
    queuedHops,
    reconciled,
    workspaceReconciled,
    tokens,
    agentPool,
    issuer: makeIssuer(platform, tokens),
    live,
    persist: () => store.flush(),
    releaseLock,
  };
  } catch (error) {
    // 装配失败不能把锁留在目录里：否则下一次启动会看到陈旧锁，而本进程已经没了。
    releaseLock();
    throw error;
  }
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
  postExecutionEvaluator?: PostExecutionEvaluator;
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
  const candidateCircuits = new PgCandidateCircuitRepository(store);
  const queuedHops = new PgQueuedHopRepository(store);
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
  const postExecutionEvaluator = options?.postExecutionEvaluator;
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
    ...(postExecutionEvaluator ? { postExecutionEvaluator } : {}),
    validation,
    // 单事务命令（C3）：交卷与升级的快照、事件、投递同一个数据库事务写下。
    transaction: store,
    live,
  });
  const agentPool = new PgAgentPoolRepository(store);
  const tokens = new RunTokenRegistry();
  const queryRuntime = options?.queryRuntime;
  const queryRunner =
    queryRuntime?.supportsQuery === true
      ? new QueryRunner({ runtime: queryRuntime, queryRuns, clock, ids, candidateCircuits, loadCandidates: () => loadRoleProfiles(agentPool, 'classifier') })
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
    candidateCircuits,
    queuedHops,
    live,
    reconciled,
    tokens,
    agentPool,
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
    async startCoordinator(missionId, profile, claim) {
      const { attemptId } = await platform.startCoordinatorAttempt(missionId, profile, claim);
      const run = tokens.issue({
        missionId,
        attemptId,
        role: 'coordinator',
        ...(claim ? { claim } : {}),
      });
      return { attemptId, token: run.token };
    },
    async startExecutor(missionId, workItemId, profile, claim) {
      const { attemptId } = await platform.startExecutorAttempt(missionId, workItemId, profile, claim);
      const run = tokens.issue({
        missionId,
        attemptId,
        role: 'executor',
        workItemId,
        ...(claim ? { claim } : {}),
      });
      return { attemptId, token: run.token };
    },
    /**
     * 影响判断专属发牌：可选能力。
     *
     * 缺装配 / 缺 claim 一律 unsupported，**不回退到普通 startCoordinator**——
     * 回退会发出一张看起来是 coordinator、实际没有 changeId 绑定的牌，而后面
     * 的专属动作靠 changeId 校核，那张牌既过不了校核也说不清自己在判断哪条变更。
     */
    async startImpactCoordinator(missionId, changeId, profile, claim) {
      if (!platform.supportsChangeImpact() || !claim) {
        throw new Error('CHANGE_IMPACT_UNSUPPORTED：当前装配不支持影响判断发牌。');
      }
      const { attemptId, workItemId } = await platform.startImpactCoordinatorAttempt(
        missionId,
        changeId,
        profile,
        claim,
      );
      const run = tokens.issue({
        missionId,
        attemptId,
        role: 'coordinator',
        workItemId,
        claim,
        purpose: 'impact',
        changeId,
      });
      return { attemptId, token: run.token };
    },
    async startIndependentReviewer(missionId, candidates = [], claim) {
      const { attemptId, profileId } = await platform.startIndependentReviewerAttempt(
        missionId,
        candidates,
        claim,
      );
      const run = tokens.issue({
        missionId,
        attemptId,
        role: 'independent_reviewer',
        ...(claim ? { claim } : {}),
      });
      return { attemptId, token: run.token, profileId };
    },
    revoke(token) {
      tokens.revoke(token);
    },
  };
}

/** 按 env 组装出来、原样交给各个构建器的决策依赖。off 模式下是空对象。 */
export interface DecisionDeps {
  decisionProvider?: DecisionProvider;
  decisionHooks?: ReadonlySet<DecisionHook>;
  postExecutionEvaluator?: PostExecutionEvaluator;
}

/**
 * 按 COAGENT_DECISION_MODE 组装决策依赖。startServer、run-mission、run-plan 共用这一个入口
 * ——原先只有 startServer 接了 provider，CLI 跑的任务永远不会触发 shadow（J2 发现）。
 *
 * 必须在打开状态 / 拿锁 / 监听之前调用：shadow 缺 key 在这里就失败，不留半截状态。
 * off：除了 COAGENT_DECISION_MODE 本身，不读任何 decision 相关 env（规格要求）。
 */
export function buildDecisionDeps(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): DecisionDeps {
  const mode = parseDecisionMode(env.COAGENT_DECISION_MODE);
  if (mode !== 'shadow') {
    assertDecisionModeStartup({ mode, providerAvailable: false });
    return {};
  }
  const decisionProvider = createDecisionProvider({ mode, env, fetch: fetchImpl });
  assertDecisionModeStartup({ mode, providerAvailable: Boolean(decisionProvider) });
  const postExecutionEvaluator = createPostExecutionEvaluator({ mode, env, fetch: fetchImpl });
  return {
    ...(decisionProvider ? { decisionProvider } : {}),
    decisionHooks: parseDecisionHooks(env.COAGENT_DECISION_HOOKS),
    ...(postExecutionEvaluator ? { postExecutionEvaluator } : {}),
  };
}

/** 文件版生产装配：必须注入 hasArchivedMission，否则归档 Mission 无待建项可能不报 skipped。 */
export function buildFileDeliveryRepairDeps(store: FileStateStore): RepairMissingDeliveriesDeps {
  const clock = new SystemClock();
  return {
    projects: new FileProjectRepository(store),
    activity: new FileActivityLog(store, clock),
    deliveries: new FileDeliveryRepository(store, clock, new PersistentIds(store)),
    transaction: store,
    clock,
    isArchivedMission: (missionId) => store.hasArchivedMission(missionId),
  };
}

export interface DeliveryRepairWarn {
  (message: string, error?: unknown): void;
}

/**
 * 逐 Mission 的读取/补建异常被收进 result.errors 而不抛。
 * 周期 tick 必须把它们当故障告警，否则调用方会以为本轮成功。
 * uncertain / skipped 不是故障，不当 warning 刷屏。
 */
function warnDeliveryRepairErrors(
  result: RepairMissingDeliveriesResult,
  warn: DeliveryRepairWarn,
): void {
  for (const item of result.errors) {
    warn(`周期投递修复：Mission ${item.missionId} 补建失败：${item.message}`);
  }
}

/**
 * 文件版观测面的一轮修复：短借写锁，新开一份 FileStateStore，不复用观测面活对象。
 * 锁忙只 warn、不写。
 */
export async function runFileObserverDeliveryRepairTick(
  statePath: string,
  warn: DeliveryRepairWarn,
): Promise<void> {
  let release = () => {};
  try {
    release = acquireLock(statePath, '周期投递修复');
  } catch (error) {
    if (error instanceof LockBusyError) {
      warn('周期投递修复：文件锁忙，本轮跳过');
      return;
    }
    throw error;
  }
  try {
    const store = new FileStateStore(statePath);
    const result = await repairMissingDeliveries(buildFileDeliveryRepairDeps(store));
    warnDeliveryRepairErrors(result, warn);
  } finally {
    release();
  }
}

/** run-plan 已持文件排他锁：用现有装配修，不再取锁。 */
export async function runHeldFileDeliveryRepair(
  store: FileStateStore,
  warn: DeliveryRepairWarn,
): Promise<void> {
  const result = await repairMissingDeliveries(buildFileDeliveryRepairDeps(store));
  warnDeliveryRepairErrors(result, warn);
}

export interface PgDeliveryRepairTickInput {
  readonly connectionString?: string;
  readonly warn: DeliveryRepairWarn;
}

/**
 * PG 周期修复：每轮新开独立 store，不 refresh / 不改写 Runner 正在用的那份。
 * 跨进程 advisory lock 拿不到就跳过。
 */
export async function runPgDeliveryRepairTick(input: PgDeliveryRepairTickInput): Promise<void> {
  const store = await PgStateStore.open(
    input.connectionString ? { connectionString: input.connectionString } : undefined,
  );
  try {
    const lock = await tryPgAdvisoryLock(
      store.pool,
      PERIODIC_RECONCILE_LOCK_KEY1,
      PERIODIC_RECONCILE_LOCK_KEY2,
    );
    try {
      if (!lock.held) {
        input.warn('周期投递修复：未能取得跨进程互斥，本轮跳过');
        return;
      }
      await store.refresh();
      const clock = new SystemClock();
      const ids = new PgIds(store);
      await ids.reserve(['D']);
      const result = await repairMissingDeliveries({
        projects: new PgProjectRepository(store),
        activity: new PgActivityLog(store, clock),
        deliveries: new PgDeliveryRepository(store, clock, ids),
        transaction: store,
        clock,
      });
      warnDeliveryRepairErrors(result, input.warn);
    } finally {
      await lock.release();
    }
  } finally {
    await store.close();
  }
}

/**
 * 周期投递修复的写者策略。两入口共用装配时按这个选 tick，
 * 而不是各自 if (usePg) —— 分叉一次就会再出现两套锁/store 接线。
 */
export type PeriodicDeliveryRepairMode =
  | { readonly kind: 'file-observer'; readonly statePath: string }
  | { readonly kind: 'file-held'; readonly store: FileStateStore }
  | { readonly kind: 'pg'; readonly connectionString?: string };

export interface StartPeriodicDeliveryRepairInput {
  readonly intervalMs: number;
  readonly mode: PeriodicDeliveryRepairMode;
  readonly warn: DeliveryRepairWarn;
  /**
   * 测试用：替换周期 tick（例如造在途慢 tick）。生产不传。
   * 传入时仍要给 mode：调用方不得在「测调度」时把锁策略也抹掉。
   */
  readonly tick?: () => Promise<void>;
}

function tickForPeriodicDeliveryRepair(
  mode: PeriodicDeliveryRepairMode,
  warn: DeliveryRepairWarn,
): () => Promise<void> {
  if (mode.kind === 'pg') {
    return () =>
      runPgDeliveryRepairTick({
        connectionString: mode.connectionString,
        warn,
      });
  }
  if (mode.kind === 'file-held') {
    return () => runHeldFileDeliveryRepair(mode.store, warn);
  }
  return () => runFileObserverDeliveryRepairTick(mode.statePath, warn);
}

/**
 * startServer 与 run-plan 共用的周期投递修复装配。
 *
 * 0 关闭、不排第一轮。锁与 store 策略按 mode 选，不在这里切换写者。
 * 两入口若再各自 startPeriodicReconcile，文件短借锁 / 已持锁 / PG 独立
 * store 会再次分叉。
 */
export function startPeriodicDeliveryRepair(
  input: StartPeriodicDeliveryRepairInput,
): PeriodicReconcileHandle | undefined {
  if (input.intervalMs === 0) return undefined;
  return startPeriodicReconcile({
    intervalMs: input.intervalMs,
    warn: input.warn,
    tick: input.tick ?? tickForPeriodicDeliveryRepair(input.mode, input.warn),
  });
}

function warnPeriodicRepair(message: string, error?: unknown): void {
  void error;
  console.warn(message);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function mergeCloseErrors(errors: Array<Error | undefined>): Error | undefined {
  const present = errors.filter((error): error is Error => error !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return new AggregateError(present, present.map((error) => error.message).join('; '));
}

/**
 * 把算出的关闭结果交付一次。callback / error 监听器自己抛错只记下来，
 * 不能再交回同一条路径——否则会再调 callback 或变成未处理拒绝。
 */
function deliverServerCloseOutcome(
  server: Server,
  error: Error | undefined,
  callback?: (err?: Error) => void,
): void {
  try {
    if (error) {
      if (callback) {
        callback(error);
        return;
      }
      // 无 callback 不能静默。有 error 监听器才 emit——没人听的 emit('error')
      // 会变成未捕获异常把进程打挂，比静默更糟；没监听器就 console.error。
      if (server.listenerCount('error') > 0) {
        server.emit('error', error);
        return;
      }
      console.error(error);
      return;
    }
    callback?.();
  } catch (thrown) {
    console.error(thrown);
  }
}

/**
 * 调用方只调 server.close 也必须先停周期调度。无论 stop 成败都关 HTTP，
 * 再释放主锁（afterHttpClose）。错误都保留：丢掉任何一个，文件锁 / 独立 PG
 * 连接或监听端口就会看起来「关了」其实没关完。不能在 HTTP 未关闭时早放锁，
 * 也不能在 callback 前把锁漏在目录里。closeHttp 同步抛错也接住，避免包在
 * 没人 await 的 async 里变成未处理拒绝。
 */
export function bindServerCloseToPeriodicStop(
  server: Server,
  stop: () => Promise<void>,
  afterHttpClose?: () => void | Promise<void>,
  options: {
    failClosedOnStopError?: () => boolean;
    beforeHttpClose?: () => Promise<void>;
  } = {},
): void {
  const closeHttp = server.close.bind(server);
  server.close = ((callback?: (err?: Error) => void) => {
    const run = async (): Promise<Error | undefined> => {
      let stopErr: Error | undefined;
      try {
        await stop();
      } catch (error) {
        stopErr = asError(error);
      }
      // 二次 SIGINT 的安全停靠失败时，HTTP 与主锁必须继续保持；普通 stop 错误
      // 仍沿用历史语义关闭 HTTP，避免改变常规 close 的回收行为。
      if (stopErr && options.failClosedOnStopError?.()) return stopErr;
      if (options.beforeHttpClose) {
        try {
          await options.beforeHttpClose();
        } catch (error) {
          return mergeCloseErrors([stopErr, asError(error)]);
        }
      }
      let closeErr: Error | undefined;
      try {
        closeErr = await new Promise<Error | undefined>((resolve) => {
          try {
            closeHttp((err?: Error) => resolve(err));
          } catch (error) {
            resolve(asError(error));
          }
        });
      } catch (error) {
        closeErr = asError(error);
      }
      let afterErr: Error | undefined;
      if (afterHttpClose) {
        try {
          await afterHttpClose();
        } catch (error) {
          afterErr = asError(error);
        }
      }
      return mergeCloseErrors([stopErr, closeErr, afterErr]);
    };
    // 算出错误与交付分开，交付只做一次。外层再接一次，防止漏网拒绝。
    void (async () => {
      let merged: Error | undefined;
      try {
        merged = await run();
      } catch (error) {
        merged = asError(error);
      }
      deliverServerCloseOutcome(server, merged, callback);
    })().catch((error) => {
      console.error(error);
    });
    return server;
  }) as typeof server.close;
}

/**
 * 起常驻 API / 观测面。文件版从可写装配前一直握主锁，直到 HTTP 完全关闭。
 *
 * 存储选哪个由 COAGENT_STORE 决定（pg / file）。缺省仍是文件版——
 * 没装 Postgres 的人 clone 下来就能跑，这条性质不能因为多了一个选项就丢掉。
 * PG 不套文件锁，也不宣称跨主机 fencing。
 */
export interface StartServerOptions {
  /** 可注入 fetch（测试用 fake；生产默认 globalThis.fetch）。 */
  fetch?: typeof globalThis.fetch;
  /** 可注入 env（测试用；生产默认 process.env）。 */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /**
   * 测试用：替换周期 tick，用来造「在途慢 tick」验证 close 会等在途修复与 HTTP 关闭。
   * 生产不传——文件版在主锁下用已持锁 store 补投递，PG 用独立 store。
   */
  periodicTick?: () => Promise<void>;
  /**
   * 可替换的控制写入口策略。默认不注入：未带 control 凭据的本机写请求保持放行。
   * 不得把 x-coagent-run 当成控制身份。
   */
  resolveControlPrincipal?: ControlPrincipalResolver;
  /**
   * 测试用：hosted Mission/Plan 用这份 runtime（走同一 API 回连）。
   * 生产不传——按请求 body.adapter 构造 SpawnRuntime。
   */
  runtime?: AgentRuntime;
  /** 只供历史 PlanRun 隔离回归使用；生产默认不挂方案运行入口。 */
  legacyPlanRunsForTests?: boolean;
  /**
   * 测试用：替换工作区。生产不传则 GitWorktreeManager。
   * 必须与装配 Platform 校验器共用同一份，否则 hosted 入口会改错树。
   */
  workspace?: WorkspaceManager;
}

async function abortStartedServer(
  server: Server | undefined,
  releaseLock: () => void,
  error: unknown,
): Promise<never> {
  const errors = [asError(error)];
  if (server?.listening) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((closeErr) => (closeErr ? reject(closeErr) : resolve()));
      });
    } catch (closeErr) {
      errors.push(asError(closeErr));
    }
  }
  try {
    releaseLock();
  } catch (releaseErr) {
    errors.push(asError(releaseErr));
  }
  throw errors.length === 1 ? errors[0]! : new AggregateError(errors, errors.map((row) => row.message).join('; '));
}

/**
 * hosted 入口只认服务启动时握着的那份状态。PG 没有跨主机唯一写者，不能假装成文件锁。
 * identityEquals 关在 heldPath 上，避免回调把请求 body 当成权威路径。
 */
function hostedHeldState(usePg: boolean, statePath: string): HostedHeldState {
  if (usePg) {
    return { kind: 'unsupported' };
  }
  const heldPath = statePath;
  return {
    kind: 'file',
    statePath: heldPath,
    identityEquals(submittedStatePath: string) {
      const heldId = stateIdFor(heldPath);
      const submittedId = stateIdFor(submittedStatePath);
      if (heldId === submittedId) return true;
      return process.platform === 'win32' && heldId.toLowerCase() === submittedId.toLowerCase();
    },
  };
}

function rememberHostedAdapter(body: Record<string, unknown>): void {
  if (typeof body.adapter !== 'string' || body.adapter.trim() === '') return;
  rememberAdapterDir(resolve(body.adapter, '../..'));
}

export async function startServer(
  port = 3101,
  statePath = '.coagent-state.json',
  options?: StartServerOptions,
) {
  // 间隔非法要失败在任何持久化 / 锁 / listen 之前。
  const env = options?.env ?? process.env;
  const reconcileIntervalMs = parseReconcileIntervalMs(env.COAGENT_RECONCILE_INTERVAL_MS);
  // Decision 模式：在任何持久化 / 锁 / listen 之前 factory + 启动门禁。
  const decision = buildDecisionDeps(env, options?.fetch ?? globalThis.fetch);

  const usePg = (env.COAGENT_STORE ?? process.env.COAGENT_STORE ?? 'file') === 'pg';
  // Query runtime：只看已解析的 env（options.env 优先），双键 opt-in + 路径存在。
  // 未启用时 queryRuntime 为 undefined，builder 保持 runQuery 关闭。
  const queryRuntime = createPiQueryRuntime(env);
  const workspace = options?.workspace ?? new GitWorktreeManager();
  const instanceId = randomUUID();
  let releaseMainLock = () => {};
  let server: Server | undefined;
  try {
    const built = usePg
      ? await buildPgPlatform({ ...decision, queryRuntime, workspace })
      : await buildPersistentPlatform(statePath, { ...decision, queryRuntime, workspace, exclusive: {
          what: '常驻服务',
          instanceId,
          apiVersion: API_VERSION,
        } });
    if ('releaseLock' in built && typeof built.releaseLock === 'function') {
      releaseMainLock = built.releaseLock;
    }
    const fileIdentity = usePg
      ? undefined
      : { instanceId, stateId: stateIdFor(statePath) };
    const loopback = { baseUrl: '' };
    const hostedBuilt = {
      platform: built.platform,
      tokens: built.issuer,
      agentPool: built.agentPool,
      activity: built.activity,
      deliveries: built.deliveries,
      persist: built.persist,
      candidateCircuits: built.candidateCircuits,
      queuedHops: built.queuedHops,
      queryRuns: built.queryRuns,
      issuer: built.issuer,
      ...('live' in built ? { live: built.live } : {}),
    };
    const hostedRuntime = options?.runtime ? { runtime: options.runtime } : {};
    const heldState = hostedHeldState(usePg, statePath);
    // 只认本服务状态文件旁的缺省目录，加上本次成功托管登记的 runDir。
    // 不能扫任意 CLI 目录：独立进程写到别处的记录不在这把锁的观测范围。
    const knownPlanRunDirs = new Set<string>([resolve(dirname(statePath), '.coagent-plans')]);
    const planLive = new InMemoryPlanRunLiveOutput();
    const hostedRuns = createHostedRunTracker();
    const startedAt = new Date().toISOString();
    const passthroughRaw = env[SPAWN_ENV_PASSTHROUGH_VAR];
    const passthrough = parseAgentEnvPassthrough(
      typeof passthroughRaw === 'string' ? passthroughRaw : undefined,
    );
    const runMission: NonNullable<ApiDeps['runMission']> = async (body, emit) => {
      rememberHostedAdapter(body);
      const token = randomUUID();
      try {
        return await runHostedMission(
          body,
          {
            built: hostedBuilt,
            baseUrl: loopback.baseUrl,
            workspace,
            env,
            ...hostedRuntime,
            heldState,
            onStarted: (id) => {
              // Asynchronous views cannot be synchronously observed in this API; never cache
              // a result that may become stale while the hosted run remains active.
              hostedRuns.register(token, { kind: 'mission', id, status: '运行中/状态暂不可读' });
            },
          },
          emit,
        );
      } finally {
        hostedRuns.finish(token);
      }
    };
    server = createApi({
      platform: built.platform,
      tokens: built.tokens,
      deliveries: built.deliveries,
      onMutation: built.persist,
      agentPool: built.agentPool,
      queuedHops: built.queuedHops,
      candidateCircuits: built.candidateCircuits,
      queryRuns: built.queryRuns,
      platformStatus: {
        store: usePg ? 'pg' : 'file',
        startedAt,
        ...(usePg ? {} : { instanceId, statePath, holdsMainLock: true }),
        agentEnv: {
          passthroughDeclared: passthrough !== undefined,
          baselineFiltered: passthrough !== undefined,
          extraPassthroughCount: passthrough?.length ?? 0,
        },
        defaultAdapter: options?.runtime?.kind ?? 'pi',
      },
      live: 'live' in built ? built.live : undefined,
      beforeRead: 'refresh' in built ? built.refresh : undefined,
      planRunDirs: () => [...knownPlanRunDirs],
      // 文件模式由本进程持有状态文件锁，是确定性状态文件写者：读取时把本进程
      // 托管的 kind=plan 运行投影成 running，其余无 stopped 的记录判 interrupted。
      // PG 不注入，避免臆断文件写者资格——PG 的运行态维持既有 unknown 判定。
      ...(!usePg
        ? {
            planRunRuntime: {
              activeRunIds: () =>
                hostedRuns.snapshot().filter((r) => r.kind === 'plan').map((r) => r.id),
              isStateFileWriter: true,
            },
          }
        : {}),
      planLive,
      runMission,
      runPlan: options?.legacyPlanRunsForTests && options?.runtime ? async (body, emit) => {
        rememberHostedAdapter(body);
        const token = randomUUID();
        try {
          return await runHostedPlan(
            body,
            {
              built: hostedBuilt,
              baseUrl: loopback.baseUrl,
              workspace,
              env,
              ...hostedRuntime,
              ...(options?.runtime ? {} : queryRuntime ? { queryRuntime } : {}),
              heldState,
              planLive,
              registerPlanRunDir: (runDir) => {
                knownPlanRunDirs.add(resolve(runDir));
              },
              onStarted: ({ runId, runPath, reviewer }) => {
                hostedRuns.register(token, {
                  kind: 'plan', id: runId, runPath, reviewer,
                  status: '运行中/状态暂不可读',
                });
              },
            },
            emit,
          );
        } finally {
          hostedRuns.finish(token);
        }
      } : undefined,
      ...(options?.resolveControlPrincipal
        ? { resolveControlPrincipal: options.resolveControlPrincipal }
        : {}),
      ...(fileIdentity ? { identity: fileIdentity } : {}),
    });
    if (fileIdentity) {
      attachLoopbackWriterIdentity(server, fileIdentity);
    }
    // 显式绑 loopback：观测面/API 不对外网口开放。动态 port=0 时日志必须读
    // server.address()，不能回显调用方传入的 port（那会打出 :0）。
    // port=0 时避开 fetch 屏蔽的端口；重绑在周期调度启动、close 被包装之前做，关的是原生 server。
    await built.platform.flushDocumentQueue();
    await listenLoopback(server, port);
    const addr = server.address() as AddressInfo;
    loopback.baseUrl = `http://${addr.address}:${addr.port}`;
    if (!usePg) {
      publishLockPort(statePath, instanceId, addr.port);
    }
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
    const missionQueueWorker = new MissionQueueWorker({
      read: async () => Promise.all((await built.platform.listProjects()).map((project) => built.platform.getMissionQueue(project.projectId))),
      run: async (entry, _config, projectId) => {
        const config = await built.platform.recordQueuedMissionStart(entry.missionId);
        if (await workspace.currentBranch?.(config.projectRoot) !== config.integrationBranch) throw new Error('项目仓当前分支与执行配置不一致');
        await runMission({ spec: { projectId, missionId: entry.missionId, contract: entry.contract },
          cwd: config.projectRoot, adapter: config.adapter, state: statePath, store: usePg ? 'pg' : 'file',
          env: { [SPAWN_ENV_PASSTHROUGH_VAR]: config.envPassthrough } }, () => {});
        const view = await built.platform.getMissionView(entry.missionId);
        if (view.status === 'awaiting_review' && view.executionMode === 'lightweight') {
          await built.platform.finalizeMissionByMachine(entry.missionId, { projectRoot: config.projectRoot,
            integrationBranch: config.integrationBranch, verification: config.verification });
        }
      },
      hold: (missionId, error) => built.platform.holdQueuedMission(missionId, error instanceof Error ? error.message : String(error)),
      warn: warnPeriodicRepair,
    });
    missionQueueWorker.start();
    // 文件版周期在 server 主锁下用已持锁 store，不再短借自己的锁。PG 独立 store。只补投递。
    // 调度装配必须走 startPeriodicDeliveryRepair，不得在这里再写一套 tick 选择。
    const periodic = startPeriodicDeliveryRepair({
      intervalMs: reconcileIntervalMs,
      warn: warnPeriodicRepair,
      ...(options?.periodicTick ? { tick: options.periodicTick } : {}),
      mode: usePg
        ? { kind: 'pg', connectionString: env.COAGENT_PG }
        : { kind: 'file-held', store: built.store as FileStateStore },
    });
    // close：先 drain（拒新开跑、等在途 Plan/Mission 与 HTTP 写），再停周期 tick、
    // await persist，然后原生 HTTP close，最后释放主锁。不能在 HTTP 未停时早放锁。
    bindServerCloseToPeriodicStop(
      server,
      async () => {
        const queueStopped = missionQueueWorker.stop();
        await drainApi(server);
        await queueStopped;
        if (safeShutdown) await safeShutdown;
        await (periodic?.stop() ?? Promise.resolve());
        await built.persist();
      },
      usePg ? undefined : () => releaseMainLock(),
      {
        failClosedOnStopError: () => safeShutdown !== undefined,
        beforeHttpClose: async () => {
          if (safeShutdown === undefined) return;
          let observedRequests: number;
          do {
            observedRequests = safeShutdownRequests;
            await safeShutdown;
          } while (observedRequests !== safeShutdownRequests);
        },
      },
    );
    let safeShutdown: Promise<void> | undefined;
    let safeShutdownRequests = 0;
    const requestSafeShutdown = (): Promise<void> => {
      safeShutdownRequests++;
      if (safeShutdown) return safeShutdown;
      safeShutdown = (async () => {
        const snapshots = hostedRuns.snapshot();
        const missionIds = new Set(snapshots.filter((item) => item.kind === 'mission').map((item) => item.id));
        for (const snapshot of snapshots) {
          if (snapshot.kind !== 'plan') continue;
          if (!snapshot.runPath) throw new Error(`不能安全关闭：PlanRun 缺少真实 runPath：${snapshot.id}`);
          const stopped = await shutdownHostedPlan({
            runPath: snapshot.runPath,
            hostedMissionId: undefined,
            platform: built.platform,
            persist: built.persist,
          });
          for (const id of stopped.pausedMissionIds) missionIds.add(id);
        }
        for (const id of missionIds) await built.platform.pauseMission(id);
        if (missionIds.size > 0) await built.persist();
      })();
      return safeShutdown;
    };
    return {
      server,
      requestSafeShutdown,
      ...built,
      stopPeriodicReconcile: () => periodic?.stop() ?? Promise.resolve(),
      hostedRunSnapshots: () => hostedRuns.snapshot().map((snapshot) => {
        if (snapshot.kind === 'plan') {
          try {
            if (!snapshot.runPath) return { ...snapshot, status: '运行中/状态暂不可读' };
            const run = new FilePlanRunStore(snapshot.runPath).read();
            if (!run) return { ...snapshot, status: '运行中/状态暂不可读' };
            const escalation = [...run.escalations].reverse().find((item) => !item.resolution);
            return {
              ...snapshot,
              status: run.stopped ? `已停止/${run.stopped.reason}` : '运行中',
              missionId: escalation?.missionId,
              escalationId: escalation?.id,
              deadline: escalation?.deadline,
            };
          } catch {
            return { ...snapshot, status: '运行中/状态暂不可读' };
          }
        }
        try {
          const view = built.platform.getMissionView(snapshot.id);
          if (view && typeof (view as Promise<unknown>).then === 'function') {
            void Promise.resolve(view).catch(() => {});
            return { ...snapshot, status: '运行中/状态暂不可读' };
          }
          const status = (view as { status?: string } | undefined)?.status;
          return { ...snapshot, status: status ?? '运行中/状态暂不可读' };
        } catch {
          return { ...snapshot, status: '运行中/状态暂不可读' };
        }
      }),
    };
  } catch (error) {
    await abortStartedServer(server, releaseMainLock, error);
  }
}

type PathDirnameResolve = {
  dirname(path: string): string;
  resolve(...paths: string[]): string;
};

/**
 * 直接 `node src/main.ts` 的缺省状态：本模块所在仓库根的 `.coagent-state.json`。
 * 相对 cwd 会在别的目录启动时静默新建一份空状态，平台分裂成两份。
 */
export function defaultStatePathFromMainModule(
  mainModulePath: string = fileURLToPath(import.meta.url),
  pathApi: PathDirnameResolve = { dirname, resolve },
): string {
  return pathApi.resolve(pathApi.dirname(mainModulePath), '..', '.coagent-state.json');
}

export function isDirectMainEntry(
  argv1: string | undefined = process.argv[1],
  selfUrl: string = import.meta.url,
): boolean {
  if (typeof argv1 !== 'string' || argv1.length === 0) return false;
  try {
    const invoked = pathToFileURL(resolve(argv1)).href;
    if (invoked === selfUrl) return true;
    // Windows 上同一路径可能只差盘符大小写；当成同一入口，否则直接 node 不启动。
    return process.platform === 'win32' && invoked.toLowerCase() === selfUrl.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * CLI 状态路径。显式 COAGENT_STATE 允许指向尚不存在的文件（启动后可新建）。
 * 走缺省路径时文件必须已在：否则拒绝，避免第一次误启动把空状态写出去。
 */
export function resolveDirectMainStatePath(
  env: NodeJS.ProcessEnv = process.env,
  options?: {
    mainModulePath?: string;
    exists?: (path: string) => boolean;
    pathApi?: PathDirnameResolve;
  },
): { ok: true; path: string } | { ok: false; path: string; message: string } {
  const explicit = env.COAGENT_STATE;
  if (typeof explicit === 'string' && explicit.length > 0) {
    return { ok: true, path: explicit };
  }
  const path = defaultStatePathFromMainModule(options?.mainModulePath, options?.pathApi);
  const exists = options?.exists ?? existsSync;
  if (!exists(path)) {
    return {
      ok: false,
      path,
      message:
        `默认状态文件不存在：${path}\n` +
        `拒绝静默新建以免平台状态分裂。请设置 COAGENT_STATE 指向要使用的状态文件（不存在时允许新建）。`,
    };
  }
  return { ok: true, path };
}

export type HostedRunSnapshot = Readonly<{
  kind: 'plan' | 'mission';
  id: string;
  status: string;
  missionId?: string;
  runPath?: string;
  reviewer?: string;
  escalationId?: string;
  deadline?: string;
}>;

export function createHostedRunTracker() {
  const runs = new Map<string, HostedRunSnapshot>();
  const copy = (snapshot: HostedRunSnapshot): HostedRunSnapshot => ({ ...snapshot });
  return {
    register(token: string, snapshot: HostedRunSnapshot): void {
      runs.set(token, copy(snapshot));
    },
    update(token: string, snapshot: HostedRunSnapshot): void {
      if (runs.has(token)) runs.set(token, copy(snapshot));
    },
    finish(token: string): void {
      runs.delete(token);
    },
    snapshot(): HostedRunSnapshot[] {
      return [...runs.values()].map(copy);
    },
  };
}

export function formatHostedRunSnapshots(snapshots: readonly HostedRunSnapshot[]): string {
  if (snapshots.length === 0) return '无在途 PlanRun 或 Mission。';
  return snapshots.map((snapshot) => {
    const lines = [`${snapshot.kind === 'plan' ? 'PlanRun' : 'Mission'} ${snapshot.id}：${snapshot.status}`];
    if (snapshot.missionId) lines.push(`  关联 Mission：${snapshot.missionId}`);
    if (snapshot.kind === 'plan' && snapshot.escalationId) {
      lines.push(`  升级单：${snapshot.escalationId}${snapshot.deadline ? `；截止：${snapshot.deadline}` : ''}`);
      if (snapshot.runPath && snapshot.reviewer && snapshot.deadline) {
        lines.push(`  停止命令：node src/l3.ts plan decide ${snapshot.escalationId} --action stop --reason "服务退出" --run "${snapshot.runPath}" --as "${snapshot.reviewer}"`);
      } else {
        lines.push('  无法给出停止命令：缺少 runPath、reviewer 或 deadline。');
      }
    }
    return lines.join('\n');
  }).join('\n');
}

export function createSigintHandler(
  close: () => void,
  onSecondSignal: () => void,
  onFirstSignal?: () => void,
): () => void {
  let received = false;
  return () => {
    if (received) {
      onSecondSignal();
      return;
    }
    received = true;
    try {
      onFirstSignal?.();
    } finally {
      close();
    }
  };
}

// 直接 `node src/main.ts` 时启动；被 import 时不启动。
// 信号必须走同一条 server.close（drain → tick → persist → HTTP → 释锁），不能 process.exit 绕过。
if (isDirectMainEntry()) {
  const resolved = resolveDirectMainStatePath();
  if (!resolved.ok) {
    console.error(resolved.message);
    process.exit(1);
  } else {
    void startServer(Number(process.env.PORT ?? 3101), resolved.path).then((built) => {
      const onSignal = () => {
        built.server.close((error) => {
          if (error) console.error(error);
          if (error) process.exitCode = 1;
          else if (process.exitCode !== 1) process.exitCode = 0;
        });
      };
      const onInterrupt = createSigintHandler(onSignal, () => {
        process.exitCode = 1;
        void built.requestSafeShutdown().catch((error) => {
          console.error(`受控暂停失败，服务保持监听与主锁：${error instanceof Error ? error.message : String(error)}`);
        });
      }, () => {
        try {
          console.log(formatHostedRunSnapshots(built.hostedRunSnapshots()));
        } catch (error) {
          console.error(`无法读取在途 PlanRun/Mission 清单：${error instanceof Error ? error.message : String(error)}`);
        }
      });
      process.on('SIGINT', onInterrupt);
      process.once('SIGTERM', onSignal);
    });
  }
}
