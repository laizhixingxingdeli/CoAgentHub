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
import { createApi } from './api/server.ts';
import { RunTokenRegistry } from './api/run-tokens.ts';
import {
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
  SystemClock,
} from './application/in-memory.ts';
import { Platform } from './application/platform.ts';
import { FileArtifactStore } from './application/artifact-store.ts';
import { InMemoryDeliveryRepository } from './application/delivery.ts';
import {
  FileActivityLog,
  FileDeliveryRepository,
  FileProjectRepository,
  FileStateStore,
  PersistentIds,
} from './application/file-store.ts';
import {
  PgActivityLog,
  PgDeliveryRepository,
  PgIds,
  PgLiveOutput,
  PgProjectRepository,
  PgStateStore,
} from './application/pg-store.ts';
import { acquireLock } from './application/lock.ts';
import { reconcileInterruptedAttempts } from './application/reconcile.ts';
import type { RunTokenIssuer } from './application/token-issuer.ts';
import type { WorkspaceManager } from './application/workspace.ts';
import { GitWorktreeManager } from './application/workspace.ts';

export function buildPlatform(workspace?: WorkspaceManager) {
  const clock = new SystemClock();
  const projects = new InMemoryProjectRepository();
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({ projects, deliveries, workspace, activity, clock, ids });
  const tokens = new RunTokenRegistry();
  return {
    platform,
    activity,
    projects,
    deliveries,
    tokens,
    issuer: makeIssuer(platform, tokens),
    persist: () => {},
  };
}

export interface PersistentOptions {
  workspace?: WorkspaceManager;
  /**
   * 是否要排他写锁。
   *
   * 会推进状态的入口（run-mission、l3）必须要；只读的观测面不要——
   * 它要锁就等于一开着界面就没法干活了。
   */
  exclusive?: { what: string };
}

export async function buildPersistentPlatform(
  statePath: string,
  workspaceOrOptions?: WorkspaceManager | PersistentOptions,
) {
  const options: PersistentOptions =
    workspaceOrOptions && 'prepare' in workspaceOrOptions
      ? { workspace: workspaceOrOptions }
      : (workspaceOrOptions ?? {});
  const workspace = options.workspace;
  const releaseLock = options.exclusive
    ? acquireLock(statePath, options.exclusive.what)
    : () => {};
  const clock = new SystemClock();
  const store = new FileStateStore(statePath);
  const projects = new FileProjectRepository(store);
  const activity = new FileActivityLog(store, clock);
  const ids = new PersistentIds(store);
  const deliveries = new FileDeliveryRepository(store, clock, ids);
  // 大输出外置到状态文件旁边的 artifacts/ 目录。
  const artifacts = new FileArtifactStore(resolve(statePath, '..', 'artifacts'));
  const platform = new Platform({
    projects,
    deliveries,
    artifacts,
    workspace: workspace ?? new GitWorktreeManager(),
    activity,
    clock,
    ids,
  });
  const tokens = new RunTokenRegistry();

  // 刚起来 = 没有任何 attempt 可能还活着。不收敛的话，上一次崩溃留下的
  // in_progress 会把对应的 Mission / 工作项永久卡死。
  const reconciled = await reconcileInterruptedAttempts(await projects.list(), activity);
  if (reconciled.interrupted.length > 0) {
    store.flush();
  }

  return {
    platform,
    activity,
    projects,
    deliveries,
    store,
    reconciled,
    tokens,
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
  /**
   * 接手哪条 Mission —— 传了才做启动收敛，而且只收敛这一条。
   *
   * **只读进程不要传。** 共用一份状态时，「刚起来所以没人在跑」这个前提
   * 不再成立：实测重启一次观测面就把正在跑的 attempt 判死写回库了。
   */
  reconcileMissionId?: string;
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
  // 而那对调用方来说只是一次莫名其妙的失败。
  await ids.reserve();
  const deliveries = new PgDeliveryRepository(store, clock, ids);
  const artifacts = new FileArtifactStore(
    resolve(options?.artifactRoot ?? '.coagent-artifacts'),
  );
  const platform = new Platform({
    projects,
    deliveries,
    artifacts,
    workspace: options?.workspace ?? new GitWorktreeManager(),
    activity,
    clock,
    ids,
  });
  const tokens = new RunTokenRegistry();

  const reconciled = options?.reconcileMissionId
    ? await reconcileInterruptedAttempts(await projects.list(), activity, {
        missionId: options.reconcileMissionId,
      })
    : { interrupted: [] };
  if (reconciled.interrupted.length > 0) await store.flush();

  return {
    platform,
    activity,
    projects,
    deliveries,
    store,
    live,
    reconciled,
    tokens,
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
export async function startServer(port = 3101, statePath = '.coagent-state.json') {
  const usePg = (process.env.COAGENT_STORE ?? 'file') === 'pg';
  const built = usePg
    ? await buildPgPlatform()
    : await buildPersistentPlatform(statePath);
  const server = createApi({
    platform: built.platform,
    tokens: built.tokens,
    deliveries: built.deliveries,
    onMutation: built.persist,
    live: 'live' in built ? built.live : undefined,
    beforeRead: 'refresh' in built ? built.refresh : undefined,
  });
  server.listen(port, () => {
    console.log(`CoAgentHub v5 平台已启动：http://127.0.0.1:${port}`);
    console.log(usePg ? '存储：PostgreSQL' : `存储：文件 ${('store' in built && 'path' in built.store) ? built.store.path : statePath}`);
    if (built.reconciled.interrupted.length > 0) {
      console.log(
        `启动收敛：${built.reconciled.interrupted.length} 个上次残留的 attempt 被判为 interrupted`,
      );
    }
  });
  return { server, ...built };
}

// 直接 `node src/main.ts` 时启动；被 import 时不启动。
if (process.argv[1]?.endsWith('main.ts')) {
  void startServer(
    Number(process.env.PORT ?? 3101),
    process.env.COAGENT_STATE ?? '.coagent-state.json',
  );
}
