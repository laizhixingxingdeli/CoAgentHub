/**
 * startServer 的绑定面与启动日志：必须显式 loopback，且 host/port 与
 * 真实 server.address() 一致（尤其 port=0 时不能回显传入值）。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix as pathPosix, resolve, win32 as pathWin32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { acquireLock, LockBusyError, probeLocalWriter, stateIdFor } from '../src/application/lock.ts';
import {
  LoopbackHttpError,
  loopbackRunRequest,
} from '../src/application/loopback-control-client.ts';
import type { AgentRuntime } from '../src/application/ports.ts';
import { runHostedMission, type HostedMissionContext } from '../src/application/mission-runner.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import {
  bindServerCloseToPeriodicStop,
  createHostedRunTracker,
  createSigintHandler,
  defaultStatePathFromMainModule,
  formatHostedRunSnapshots,
  shutdownHostedPlan,
  isDirectMainEntry,
  resolveDirectMainStatePath,
  startServer,
} from '../src/main.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import { API_VERSION } from '../src/api/server.ts';
import { PLAN_LIVE_EMPTY_REASON } from '../src/application/live.ts';
import { PlanRun } from '../src/application/plan-run.ts';
import { FilePlanRunStore } from '../src/application/plan-run-store.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';

const servers: Server[] = [];
const dirs: string[] = [];
const releaseFns: Array<() => void> = [];

after(() => {
  for (const server of servers) {
    // 已关闭的再 close，包装后的 close 无 callback 时会把 ERR_SERVER_NOT_RUNNING 打到 stderr。
    if (!server.listening) continue;
    try {
      server.close();
    } catch {
      /* already closed */
    }
  }
  for (const release of releaseFns) {
    try {
      release();
    } catch {
      /* lock already gone */
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-start-server-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

test('shutdownHostedPlan pauses deduplicated missions and persists service stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-shutdown-plan-'));
  dirs.push(dir);
  const runPath = join(dir, 'R-shutdown.json');
  const run = PlanRun.start({
    id: 'R-shutdown', planId: 'PLAN-shutdown', projectId: 'P-shutdown',
    integrationBranch: 'auto/test', reviewer: 'reviewer',
    stopConditions: { unresolvedEscalations: 1, wallClockMs: 60_000, escalationTimeoutMs: 60_000 },
    featureIds: ['F1'], startedAt: '2026-09-29T00:00:00.000Z',
  });
  run.startFeature('F1', 'M1');
  await new FilePlanRunStore(runPath).create(run);
  const paused: string[] = [];
  let persisted = false;
  const result = await shutdownHostedPlan({
    runPath, hostedMissionId: 'M1', platform: { pauseMission: async (id) => { paused.push(id); return { paused: true }; } },
    persist: async () => { persisted = true; }, now: () => '2026-09-29T00:01:00.000Z',
  });
  assert.deepEqual(paused, ['M1']);
  assert.equal(persisted, true);
  const stored = new FilePlanRunStore(runPath).read()!;
  assert.equal(stored.stopped?.reason, 'service_shutdown');
  assert.equal(stored.stopped?.detail.includes('M1'), true);
});

test('shutdownHostedPlan preserves stopped records and rejects missing records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-shutdown-stopped-'));
  dirs.push(dir);
  const runPath = join(dir, 'R-stopped.json');
  const run = PlanRun.start({
    id: 'R-stopped', planId: 'PLAN-stopped', projectId: 'P-stopped',
    integrationBranch: 'auto/test', reviewer: 'reviewer',
    stopConditions: { unresolvedEscalations: 1, wallClockMs: 60_000, escalationTimeoutMs: 60_000 },
    featureIds: ['F1'], startedAt: '2026-09-29T00:00:00.000Z',
  });
  run.halt('service_shutdown', 'old reason', '2026-09-29T00:01:00.000Z');
  await new FilePlanRunStore(runPath).create(run);
  await shutdownHostedPlan({ runPath, platform: { pauseMission: async () => ({ paused: true }) }, persist: async () => { throw new Error('must not persist'); } });
  assert.equal(new FilePlanRunStore(runPath).read()?.stopped?.detail, 'old reason');
  await assert.rejects(shutdownHostedPlan({ runPath: join(dir, 'missing.json'), platform: { pauseMission: async () => ({ paused: true }) }, persist: async () => {} }), /尚未创建/);
});

const WRITE_CONTRACT = {
  intent: '本机写入口',
  acceptance: ['变更可见'],
  constraints: [] as string[],
  nonGoals: [] as string[],
  guardrails: [] as string[],
};

async function holdLockInChild(statePath: string): Promise<{ stop: () => Promise<void> }> {
  const holderPath = join(dirnameOf(statePath), 'hold-lock.ts');
  const lockUrl = new URL('../src/application/lock.ts', import.meta.url).href;
  writeFileSync(
    holderPath,
    `import { acquireLock } from ${JSON.stringify(lockUrl)};
const release = acquireLock(${JSON.stringify(statePath)}, '独立进程占锁');
process.stdout.write('held\\n');
const halt = () => {
  release();
  process.exit(0);
};
process.stdin.on('data', halt);
process.stdin.on('end', halt);
await new Promise(() => {});
`,
  );
  const child = spawn(process.execPath, [holderPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      reject(new Error(`独立进程占锁超时：${buf}\n${stderr}`));
    }, 8000);
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(`独立进程在占锁前退出 ${String(code)}：${stderr}`));
    };
    child.on('exit', onExit);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout?.on('data', (chunk) => {
      buf += String(chunk);
      if (buf.includes('held')) {
        clearTimeout(timer);
        child.off('exit', onExit);
        resolve();
      }
    });
  });
  return {
    stop: () =>
      new Promise((resolve) => {
        child.on('exit', () => resolve());
        child.stdin?.end();
        setTimeout(() => child.kill('SIGKILL'), 1000).unref();
      }),
  };
}

function dirnameOf(statePath: string): string {
  return dirname(statePath);
}

describe('startServer 绑定与启动日志', () => {
  test('显式监听 127.0.0.1；port=0 时日志 host/port 与 server.address() 一致', async () => {
    const statePath = tempState();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };

    let built: Awaited<ReturnType<typeof startServer>>;
    try {
      // 强制文件版：本测不依赖 Postgres / 外网。
      const prevStore = process.env.COAGENT_STORE;
      process.env.COAGENT_STORE = 'file';
      try {
        built = await startServer(0, statePath);
      } finally {
        if (prevStore === undefined) delete process.env.COAGENT_STORE;
        else process.env.COAGENT_STORE = prevStore;
      }
    } finally {
      console.log = originalLog;
    }

    servers.push(built.server);
    if ('releaseLock' in built && typeof built.releaseLock === 'function') {
      releaseFns.push(built.releaseLock);
    }

    const addr = built.server.address() as AddressInfo;
    assert.equal(addr.address, '127.0.0.1');
    assert.ok(addr.port > 0, '动态端口应被 OS 分配为非 0');

    const boot = lines.find((l) => l.includes('平台已启动'));
    assert.ok(boot, '应打印启动日志');
    assert.equal(
      boot,
      `CoAgentHub v5 平台已启动：http://${addr.address}:${addr.port}`,
      '日志必须来自真实 server.address()，不能猜传入 port',
    );
    assert.ok(!boot.includes(':0'), '动态端口日志不得残留 :0');

    // 文件版默认行为仍可跑：健康检查通。
    const res = await fetch(`http://${addr.address}:${addr.port}/api/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { ok: boolean }).ok, true);

    await new Promise<void>((done, fail) => {
      built.server.close((err) => (err ? fail(err) : done()));
    });
  });

  test('真实装配：平台状态含文件身份/锁/回环/空队列占用，池接口只读健康', async () => {
    const statePath = tempState();
    const built = await startServer(0, statePath, {
      env: {
        COAGENT_STORE: 'file',
        COAGENT_AGENT_ENV_PASSTHROUGH: '-',
      },
    });
    servers.push(built.server);
    if ('releaseLock' in built && typeof built.releaseLock === 'function') {
      releaseFns.push(built.releaseLock);
    }
    const addr = built.server.address() as AddressInfo;
    assert.equal(addr.address, '127.0.0.1');
    const base = `http://${addr.address}:${addr.port}`;
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    const instance = health.headers.get('x-coagent-instance');
    assert.ok(instance);

    const statusRes = await fetch(`${base}/api/platform/status`);
    assert.equal(statusRes.status, 200);
    const status = (await statusRes.json()) as {
      api: string;
      pid: number;
      store: string;
      instanceId: string;
      statePath: string;
      holdsMainLock: boolean;
      listen: { address: string; port: number };
      queue: { counts: Record<string, number>; deadLetters: unknown[] };
      occupancy: { activeLeases: number; global: number; limits: Record<string, number> };
      agentEnv: { passthroughDeclared: boolean; baselineFiltered: boolean; extraPassthroughCount: number };
      defaultAdapter: string;
    };
    assert.equal(status.api, API_VERSION);
    assert.equal(status.pid, process.pid);
    assert.equal(status.store, 'file');
    assert.equal(status.instanceId, instance);
    assert.equal(status.statePath, statePath);
    assert.equal(status.holdsMainLock, true);
    assert.equal(status.listen.address, '127.0.0.1');
    assert.equal(status.listen.port, addr.port);
    assert.deepEqual(status.queue.counts, {
      queued: 0,
      claimed: 0,
      completed: 0,
      retry_wait: 0,
      dead_letter: 0,
    });
    assert.deepEqual(status.queue.deadLetters, []);
    assert.equal(status.occupancy.activeLeases, 0);
    assert.equal(status.occupancy.global, 0);
    assert.equal(status.occupancy.limits.global, 8);
    assert.equal(status.agentEnv.passthroughDeclared, true);
    assert.equal(status.agentEnv.baselineFiltered, true);
    assert.equal(status.agentEnv.extraPassthroughCount, 0);
    assert.equal(status.defaultAdapter, 'pi');
    const dumped = JSON.stringify(status);
    assert.equal(dumped.includes('TYPESAFE_API_KEY'), false);
    assert.equal(Object.hasOwn(status, 'env'), false);

    const emptyPools = await fetch(`${base}/api/pools`);
    assert.equal(emptyPools.status, 200);
    const emptyJson = (await emptyPools.json()) as {
      coordinator: unknown[];
      executor: unknown[];
      independent_reviewer: unknown[];
    };
    assert.deepEqual(emptyJson, { coordinator: [], executor: [], independent_reviewer: [] });

    const added = await fetch(`${base}/api/pools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'executor', profileId: 'exec-live', endpoint: 'local' }),
    });
    assert.equal(added.status, 201);
    const listed = await fetch(`${base}/api/pools`);
    const snapshot = (await listed.json()) as {
      executor: Array<{
        profileId: string;
        runtime: string;
        health: {
          circuit: { state: string };
          lastFailure: { failureClass: string; at: null | string };
          window7d: { attempts: number; reportedCost: number | null };
          runtime: { running: boolean; reason?: string };
        };
      }>;
    };
    assert.equal(snapshot.executor[0]?.profileId, 'exec-live');
    assert.equal(snapshot.executor[0]?.runtime, 'pi');
    assert.equal(snapshot.executor[0]?.health.circuit.state, 'closed');
    assert.equal(snapshot.executor[0]?.health.lastFailure.failureClass, 'unknown');
    assert.equal(snapshot.executor[0]?.health.lastFailure.at, null);
    assert.equal(snapshot.executor[0]?.health.window7d.attempts, 0);
    assert.equal(snapshot.executor[0]?.health.window7d.reportedCost, null);
    assert.equal(snapshot.executor[0]?.health.runtime.running, false);
    assert.equal(snapshot.executor[0]?.health.runtime.reason, 'no_active_lease');

    await new Promise<void>((done, fail) => {
      built.server.close((err) => (err ? fail(err) : done()));
    });
  });

  test('COAGENT_DECISION_MODE=off / 非法：健康检查与 loopback 不回归', async () => {
    for (const mode of ['off', 'ENFORCED', '']) {
      const statePath = tempState();
      const prevStore = process.env.COAGENT_STORE;
      const prevMode = process.env.COAGENT_DECISION_MODE;
      process.env.COAGENT_STORE = 'file';
      if (mode === '') delete process.env.COAGENT_DECISION_MODE;
      else process.env.COAGENT_DECISION_MODE = mode;

      let built: Awaited<ReturnType<typeof startServer>> | undefined;
      try {
        built = await startServer(0, statePath);
        servers.push(built.server);
        if ('releaseLock' in built && typeof built.releaseLock === 'function') {
          releaseFns.push(built.releaseLock);
        }

        const addr = built.server.address() as AddressInfo;
        assert.equal(addr.address, '127.0.0.1');
        const res = await fetch(`http://${addr.address}:${addr.port}/api/health`);
        assert.equal(res.status, 200);
        assert.equal((await res.json() as { ok: boolean }).ok, true);

        await new Promise<void>((done, fail) => {
          built!.server.close((err) => (err ? fail(err) : done()));
        });
      } finally {
        if (prevStore === undefined) delete process.env.COAGENT_STORE;
        else process.env.COAGENT_STORE = prevStore;
        if (prevMode === undefined) delete process.env.COAGENT_DECISION_MODE;
        else process.env.COAGENT_DECISION_MODE = prevMode;
      }
    }
  });

  test('COAGENT_DECISION_MODE=shadow 缺 key：在持久化/监听前 reject，不残留 server', async () => {
    const statePath = tempState();
    const prevStore = process.env.COAGENT_STORE;
    const prevMode = process.env.COAGENT_DECISION_MODE;
    const prevKey = process.env.TYPESAFE_API_KEY;
    process.env.COAGENT_STORE = 'file';
    process.env.COAGENT_DECISION_MODE = 'shadow';
    delete process.env.TYPESAFE_API_KEY;

    const beforeHandles = process.getActiveResourcesInfo?.() ?? [];
    try {
      await assert.rejects(() => startServer(0, statePath), /TYPESAFE_API_KEY/);
    } finally {
      if (prevStore === undefined) delete process.env.COAGENT_STORE;
      else process.env.COAGENT_STORE = prevStore;
      if (prevMode === undefined) delete process.env.COAGENT_DECISION_MODE;
      else process.env.COAGENT_DECISION_MODE = prevMode;
      if (prevKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = prevKey;
    }

    // 失败路径不得留下可连的监听端口：本测未把任何 server 推入 servers[]。
    assert.equal(
      servers.filter((s) => s.listening).length,
      0,
      'shadow reject 后不得残留 listening server',
    );
    void beforeHandles;
  });

  test('COAGENT_DECISION_HOOKS 只在 shadow 下读；off 模式一次都不碰（J1）', async () => {
    for (const mode of ['off', 'shadow'] as const) {
      const touched: string[] = [];
      const raw: Record<string, string | undefined> = {
        COAGENT_STORE: 'file',
        COAGENT_DECISION_MODE: mode,
        COAGENT_DECISION_HOOKS: 'pre_dispatch',
        TYPESAFE_API_KEY: 'test-shadow-key',
      };
      const env = new Proxy(raw, {
        get(target, key) {
          if (typeof key === 'string') touched.push(key);
          return target[key as string];
        },
      });
      const built = await startServer(0, tempState(), {
        env,
        fetch: async () => {
          throw new Error('boot 不得调用 decision fetch');
        },
      });
      servers.push(built.server);
      if ('releaseLock' in built && typeof built.releaseLock === 'function') releaseFns.push(built.releaseLock);
      await new Promise<void>((done, fail) => built.server.close((err) => (err ? fail(err) : done())));
      assert.equal(touched.includes('COAGENT_DECISION_HOOKS'), mode === 'shadow', `${mode}：读过 ${touched.join(',')}`);
    }
  });

  test('COAGENT_DECISION_MODE=shadow + key + fake fetch：可启动，不真实联网', async () => {
    const statePath = tempState();
    let fetchCalls = 0;
    const fakeFetch: typeof globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('fake fetch should not run on boot');
    };

    let built: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      built = await startServer(0, statePath, {
        env: {
          COAGENT_STORE: 'file',
          COAGENT_DECISION_MODE: 'shadow',
          TYPESAFE_API_KEY: 'test-shadow-key',
        },
        fetch: fakeFetch,
      });
      servers.push(built.server);
      if ('releaseLock' in built && typeof built.releaseLock === 'function') {
        releaseFns.push(built.releaseLock);
      }

      const addr = built.server.address() as AddressInfo;
      assert.equal(addr.address, '127.0.0.1');
      const res = await fetch(`http://${addr.address}:${addr.port}/api/health`);
      assert.equal(res.status, 200);
      assert.equal(fetchCalls, 0, 'boot 不得调用 decision fetch');

      await new Promise<void>((done, fail) => {
        built!.server.close((err) => (err ? fail(err) : done()));
      });
    } finally {
      /* env 通过 options 注入，不污染 process.env */
    }
  });
});

describe('startServer queryRuntime 双键 opt-in', () => {
  test('默认 / 缺配置：runQuery 保持 undefined', async () => {
    const statePath = tempState();
    const built = await startServer(0, statePath, {
      env: { COAGENT_STORE: 'file' },
    });
    servers.push(built.server);
    if ('releaseLock' in built && typeof built.releaseLock === 'function') {
      releaseFns.push(built.releaseLock);
    }

    assert.equal(built.runQuery, undefined);
    assert.equal(built.queryRunner, undefined);

    await new Promise<void>((done, fail) => {
      built.server.close((err) => (err ? fail(err) : done()));
    });
  });

  test('仅 enabled 或仅 adapter / 路径不存在：runQuery 仍 undefined', async () => {
    const statePath = tempState();
    const missing = join(tmpdir(), 'coagent-missing-query-adapter.ts');

    for (const env of [
      { COAGENT_STORE: 'file', COAGENT_QUERY_ENABLED: '1' },
      {
        COAGENT_STORE: 'file',
        COAGENT_QUERY_ADAPTER: missing,
      },
      {
        COAGENT_STORE: 'file',
        COAGENT_QUERY_ENABLED: '1',
        COAGENT_QUERY_ADAPTER: missing,
      },
      {
        COAGENT_STORE: 'file',
        COAGENT_QUERY_ENABLED: 'true',
        COAGENT_QUERY_ADAPTER: missing,
      },
    ] as const) {
      const built = await startServer(0, statePath, { env: { ...env } });
      servers.push(built.server);
      if ('releaseLock' in built && typeof built.releaseLock === 'function') {
        releaseFns.push(built.releaseLock);
      }
      assert.equal(built.runQuery, undefined, `env=${JSON.stringify(env)}`);
      await new Promise<void>((done, fail) => {
        built.server.close((err) => (err ? fail(err) : done()));
      });
    }
  });

  test('双键有效 + 真实 adapter 文件：runQuery 为 function', async () => {
    const statePath = tempState();
    const dir = mkdtempSync(join(tmpdir(), 'coagent-start-query-'));
    dirs.push(dir);
    const adapter = join(dir, 'query-adapter.ts');
    writeFileSync(adapter, '// startServer query fixture\n', 'utf8');

    const built = await startServer(0, statePath, {
      env: {
        COAGENT_STORE: 'file',
        COAGENT_QUERY_ENABLED: '1',
        COAGENT_QUERY_ADAPTER: adapter,
        // query 子进程同样走 SpawnRuntime 过滤；未声明会在 startServer 装配期抛。
        COAGENT_AGENT_ENV_PASSTHROUGH: '-',
      },
    });
    servers.push(built.server);
    if ('releaseLock' in built && typeof built.releaseLock === 'function') {
      releaseFns.push(built.releaseLock);
    }

    assert.equal(typeof built.runQuery, 'function');
    assert.ok(built.queryRunner, '应装配 QueryRunner');

    // 仍不开放 HTTP query surface：健康检查在，query 路由不在。
    const addr = built.server.address() as AddressInfo;
    const health = await fetch(`http://${addr.address}:${addr.port}/api/health`);
    assert.equal(health.status, 200);
    const queryPost = await fetch(`http://${addr.address}:${addr.port}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(queryPost.status, 404);

    await new Promise<void>((done, fail) => {
      built.server.close((err) => (err ? fail(err) : done()));
    });
  });

  test('options.env 缺 query 键时不回落 process.env', async () => {
    const statePath = tempState();
    const dir = mkdtempSync(join(tmpdir(), 'coagent-start-query-fallback-'));
    dirs.push(dir);
    const adapter = join(dir, 'query-adapter.ts');
    writeFileSync(adapter, '// fallback probe\n', 'utf8');

    const prevEnabled = process.env.COAGENT_QUERY_ENABLED;
    const prevAdapter = process.env.COAGENT_QUERY_ADAPTER;
    process.env.COAGENT_QUERY_ENABLED = '1';
    process.env.COAGENT_QUERY_ADAPTER = adapter;
    try {
      const built = await startServer(0, statePath, {
        env: { COAGENT_STORE: 'file' },
      });
      servers.push(built.server);
      if ('releaseLock' in built && typeof built.releaseLock === 'function') {
        releaseFns.push(built.releaseLock);
      }
      assert.equal(
        built.runQuery,
        undefined,
        '注入 env 未带 query 键时不得读 process.env 开启',
      );
      await new Promise<void>((done, fail) => {
        built.server.close((err) => (err ? fail(err) : done()));
      });
    } finally {
      if (prevEnabled === undefined) delete process.env.COAGENT_QUERY_ENABLED;
      else process.env.COAGENT_QUERY_ENABLED = prevEnabled;
      if (prevAdapter === undefined) delete process.env.COAGENT_QUERY_ADAPTER;
      else process.env.COAGENT_QUERY_ADAPTER = prevAdapter;
    }
  });
});

describe('query surface 源码约束（本单）', () => {
  test('api/server.ts 无 query route；run-mission.ts 无 supportsQuery', () => {
    const root = fileURLToPath(new URL('../src/', import.meta.url));
    const api = readFileSync(join(root, 'api/server.ts'), 'utf8');
    const mission = readFileSync(join(root, 'run-mission.ts'), 'utf8');

    assert.doesNotMatch(api, /\/api\/query\b/);
    assert.doesNotMatch(api, /\brunQuery\b/);
    assert.doesNotMatch(api, /\bqueryRunner\b/);
    assert.doesNotMatch(mission, /\bsupportsQuery\b/);
  });
});

describe('buildPlatform decisionProvider 透传', () => {
  test('optional provider 注入 Platform，dispatch 可观测 shadow', async () => {
    const { buildPlatform } = await import('../src/main.ts');
    const {
      DECISION_SHADOW_EVENT_KIND,
    } = await import('../src/application/decision-shadow-runner.ts');
    const sink = { calls: 0 };
    const provider = {
      kind: 'test-inject',
      async decide() {
        sink.calls += 1;
        return {
          answers: {
            task_type: { kind: 'choice' as const, option: 'bugfix' },
          },
        };
      },
    };
    // J1 之后 PRE 默认关：这条测的是透传，所以显式开 PRE。
    const built = buildPlatform(undefined, provider, undefined, new Set(['PRE_DISPATCH'] as const));
    const { platform, activity } = built;

    const CONTRACT = {
      intent: 'i',
      acceptance: ['a'],
      constraints: [] as string[],
      nonGoals: [] as string[],
      guardrails: [] as string[],
    };
    const ORDER = {
      objective: 'o',
      allowedScope: ['src/x.ts'],
      requiredBehaviour: 'r',
      constraints: [] as string[],
      acceptance: ['ok'],
      verification: ['t'],
      doNot: [] as string[],
      contextRefs: [] as string[],
    };
    const PLAN = {
      findings: 'f',
      rejectedHypotheses: [] as string[],
      decisions: [] as string[],
      direction: 'd',
      risks: [] as string[],
    };

    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const { attemptId } = await platform.startCoordinatorAttempt('M1');
    await platform.updatePlan('M1', attemptId, PLAN);
    const { workItemId } = await platform.createWorkItem('M1', attemptId, {
      title: 'W',
      order: ORDER,
    });
    await platform.dispatchWorkItems('M1', attemptId, [workItemId]);

    assert.ok(sink.calls >= 1, '注入的 provider 应在 dispatch 被调用');
    const events = await activity.list('M1');
    assert.ok(
      events.some((e) => e.kind === DECISION_SHADOW_EVENT_KIND),
      '应有 decision.shadow 事件',
    );
  });
});

describe('buildPersistentPlatform decisionHooks 透传（J1）', () => {
  // 生产装配链上的那一段：startServer 读到的钩子要经持久化构建器进到 Platform。
  // 构建器漏传的话 PRE 在生产里永远开不了，而平台层的测试照样全绿。
  test('开 PRE：派发时 provider 调一次；不传钩子：零次', async () => {
    const { buildPersistentPlatform } = await import('../src/main.ts');
    const { InPlaceWorkspaceManager } = await import('../src/application/workspace.ts');
    const contract = { intent: 'i', acceptance: ['a'], constraints: [] as string[], nonGoals: [] as string[], guardrails: [] as string[] };
    const order = {
      objective: 'o', allowedScope: ['src/x.ts'], requiredBehaviour: 'r', constraints: [] as string[],
      acceptance: ['ok'], verification: ['t'], doNot: [] as string[], contextRefs: [] as string[],
    };
    const plan = { findings: 'f', rejectedHypotheses: [] as string[], decisions: [] as string[], direction: 'd', risks: [] as string[] };
    for (const [hooks, expected] of [[new Set(['PRE_DISPATCH'] as const), 1], [undefined, 0]] as const) {
      const sink = { calls: 0 };
      const built = await buildPersistentPlatform(tempState(), {
        workspace: new InPlaceWorkspaceManager(),
        decisionProvider: {
          kind: 'count',
          async decide() {
            sink.calls += 1;
            return { answers: {} };
          },
        },
        ...(hooks ? { decisionHooks: hooks } : {}),
      });
      if ('releaseLock' in built && typeof built.releaseLock === 'function') releaseFns.push(built.releaseLock);
      const { platform } = built;
      await platform.createMission({ projectId: 'P', missionId: 'M1', contract });
      const { attemptId } = await platform.startCoordinatorAttempt('M1');
      await platform.updatePlan('M1', attemptId, plan);
      const { workItemId } = await platform.createWorkItem('M1', attemptId, { title: 'w', order });
      await platform.dispatchWorkItems('M1', attemptId, [workItemId]);
      assert.equal(sink.calls, expected, hooks ? '开了 PRE 应调一次' : '不传钩子应零次');
    }
  });
});

describe('startServer 周期投递修复配置', () => {
  test('非法 COAGENT_RECONCILE_INTERVAL_MS 在 listen 之前 reject，不残留 server', async () => {
    for (const raw of ['-1', '1.5', 'abc', '', '01']) {
      const statePath = tempState();
      await assert.rejects(
        () =>
          startServer(0, statePath, {
            env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: raw },
          }),
        /COAGENT_RECONCILE_INTERVAL_MS/,
      );
    }
    assert.equal(
      servers.filter((s) => s.listening).length,
      0,
      '非法间隔 reject 后不得残留 listening server',
    );
  });

  test('间隔 0 即使等待也不跑；close 后不再排 tick', async () => {
    const statePath = tempState();
    const warns: string[] = [];
    let ticks = 0;
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      const off = await startServer(0, statePath, {
        env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
        periodicTick: async () => {
          ticks += 1;
        },
      });
      servers.push(off.server);
      if ('releaseLock' in off && typeof off.releaseLock === 'function') {
        releaseFns.push(off.releaseLock);
      }
      await new Promise((done) => setTimeout(done, 70));
      assert.equal(ticks, 0, '间隔 0 不得启动周期');
      assert.equal(
        warns.filter((row) => row.includes('周期投递修复')).length,
        0,
      );
      await new Promise<void>((done, fail) => {
        off.server.close((err) => (err ? fail(err) : done()));
      });

      const on = await startServer(0, statePath, {
        env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '40' },
        periodicTick: async () => {
          ticks += 1;
        },
      });
      servers.push(on.server);
      if ('releaseLock' in on && typeof on.releaseLock === 'function') {
        releaseFns.push(on.releaseLock);
      }
      const deadline = Date.now() + 5000;
      while (ticks < 1 && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 15));
      }
      assert.ok(ticks >= 1, '正间隔应跑 tick');
      assert.equal(
        warns.filter((row) => row.includes('锁忙')).length,
        0,
        '已持锁周期不得对自己锁忙',
      );
      const health = await fetch(
        `http://${(on.server.address() as AddressInfo).address}:${(on.server.address() as AddressInfo).port}/api/health`,
      );
      assert.equal(health.status, 200);
      await new Promise<void>((done, fail) => {
        on.server.close((err) => (err ? fail(err) : done()));
      });
      const mid = ticks;
      await new Promise((done) => setTimeout(done, 100));
      assert.equal(ticks, mid, 'close 后不得再排 tick');
    } finally {
      console.warn = originalWarn;
    }
  });

  test('close 等待在途慢 tick 释放锁后才完成，且不再排下一轮', async () => {
    const statePath = tempState();
    let tickCount = 0;
    let holding = false;
    let finishTick = () => {};
    const gate = new Promise<void>((resolve) => {
      finishTick = resolve;
    });

    const on = await startServer(0, statePath, {
      env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '20' },
      periodicTick: async () => {
        tickCount += 1;
        if (tickCount !== 1) return;
        holding = true;
        try {
          await gate;
        } finally {
          holding = false;
        }
      },
    });
    servers.push(on.server);
    if ('releaseLock' in on && typeof on.releaseLock === 'function') {
      releaseFns.push(on.releaseLock);
    }

    try {
      const deadline = Date.now() + 5000;
      while (!holding && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 5));
      }
      assert.equal(holding, true, 'tick 应已在途');
      assert.throws(() => acquireLock(statePath, 'probe-during'), LockBusyError);

      const addr = on.server.address() as AddressInfo;
      const health = await fetch(`http://${addr.address}:${addr.port}/api/health`);
      assert.equal(health.status, 200);

      let closed = false;
      const closing = new Promise<void>((done, fail) => {
        on.server.close((err) => {
          closed = true;
          err ? fail(err) : done();
        });
      });
      await new Promise((done) => setTimeout(done, 40));
      assert.equal(closed, false, '在途 tick 未结束时 close 不得完成');
      assert.throws(() => acquireLock(statePath, 'probe-still'), LockBusyError);

      finishTick();
      await closing;
      assert.equal(closed, true);

      const probe = acquireLock(statePath, 'probe-after');
      probe();

      const afterTicks = tickCount;
      await new Promise((done) => setTimeout(done, 80));
      assert.equal(tickCount, afterTicks, 'close 完成后不得再跑 tick');
    } finally {
      finishTick();
    }
  });

  test('对已关闭的 server 再 close，HTTP 关闭错误交给 callback', async () => {
    const built = await startServer(0, tempState(), {
      env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
    });
    servers.push(built.server);
    await new Promise<void>((done, fail) => {
      built.server.close((err) => (err ? fail(err) : done()));
    });
    const err = await new Promise<Error | undefined>((done) => {
      built.server.close((e) => done(e));
    });
    assert.ok(err, '第二次 close 应报告 HTTP 已关闭');
    assert.equal((err as NodeJS.ErrnoException).code, 'ERR_SERVER_NOT_RUNNING');
  });
});

describe('startServer 文件版主锁、身份与控制写', () => {
  test('独立进程已持锁时 startServer 拒绝且本次未监听', async () => {
    const statePath = tempState();
    // 不假设 3101 空闲：用户常驻服务可能正占着它。先占一个 ephemeral 口再放开，
    // 得到确认空闲的隔离端口；锁忙路径不得去绑这个口，更不得碰用户服务。
    const scout = createServer();
    await listenLoopback(scout, 0);
    const idlePort = (scout.address() as AddressInfo).port;
    await new Promise<void>((done, fail) => {
      scout.close((err) => (err ? fail(err) : done()));
    });
    const child = await holdLockInChild(statePath);
    try {
      await assert.rejects(
        () =>
          startServer(idlePort, statePath, {
            env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
          }),
        LockBusyError,
      );
      const stillIdle = createServer();
      try {
        await listenLoopback(stillIdle, idlePort);
      } finally {
        if (stillIdle.listening) {
          await new Promise<void>((done, fail) => {
            stillIdle.close((err) => (err ? fail(err) : done()));
          });
        }
      }
    } finally {
      await child.stop();
    }
  });

  test('成功启动则锁在 close callback 前一直忙，callback 后可取；身份与 health 一致', async () => {
    const statePath = tempState();
    const built = await startServer(0, statePath, {
      env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
    });
    servers.push(built.server);
    if ('releaseLock' in built && typeof built.releaseLock === 'function') {
      releaseFns.push(built.releaseLock);
    }

    const addr = built.server.address() as AddressInfo;
    assert.ok(addr.port > 0);
    assert.throws(() => acquireLock(statePath, 'probe-running'), LockBusyError);

    const probed = await probeLocalWriter(statePath);
    assert.equal(probed.status, 'live');
    if (probed.status !== 'live') throw new Error('expected live');
    assert.equal(probed.holder.port, addr.port);
    assert.equal(probed.holder.stateId, stateIdFor(statePath));
    assert.equal(probed.holder.apiVersion, API_VERSION);
    assert.ok(probed.holder.instanceId);
    assert.match(probed.holder.instanceId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    const health = await fetch(`http://${addr.address}:${addr.port}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-coagent-instance'), probed.holder.instanceId);
    assert.equal(health.headers.get('x-coagent-state-id'), probed.holder.stateId);
    assert.equal(((await health.json()) as { api: string }).api, API_VERSION);

    let callbackRan = false;
    await new Promise<void>((done, fail) => {
      built.server.close((err) => {
        callbackRan = true;
        err ? fail(err) : done();
      });
    });
    assert.equal(callbackRan, true);
    const after = acquireLock(statePath, 'probe-after-close');
    after();
  });

  test('listen 失败释放自己的锁且不残留 HTTP', async () => {
    const blocker = createServer();
    await listenLoopback(blocker, 0);
    servers.push(blocker);
    const port = (blocker.address() as AddressInfo).port;
    const statePath = tempState();
    await assert.rejects(
      () =>
        startServer(port, statePath, {
          env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
        }),
      /EADDRINUSE/,
    );
    const probe = acquireLock(statePath, 'after-listen-fail');
    probe();
    assert.equal(blocker.listening, true, '占用端口的 blocker 应仍在');
  });

  test('未带 control 凭据的本机写请求成功；注入 resolver 可拒绝；x-coagent-run 不是控制身份', async () => {
    const statePath = tempState();
    const open = await startServer(0, statePath, {
      env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
    });
    servers.push(open.server);
    if ('releaseLock' in open && typeof open.releaseLock === 'function') {
      releaseFns.push(open.releaseLock);
    }
    const addr = open.server.address() as AddressInfo;
    const created = await fetch(`http://${addr.address}:${addr.port}/api/missions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-coagent-run': 'not-a-control-principal',
      },
      body: JSON.stringify({
        projectId: 'P',
        missionId: 'M-write',
        contract: WRITE_CONTRACT,
      }),
    });
    assert.notEqual(created.status, 401);
    assert.notEqual(created.status, 403);
    assert.equal(created.status, 201);
    const body = (await created.json()) as { mission?: { missionId?: string }; missionId?: string };
    assert.equal(body.mission?.missionId ?? body.missionId, 'M-write');
    const listed = await fetch(`http://${addr.address}:${addr.port}/api/missions`);
    assert.equal(listed.status, 200);
    const rows = (await listed.json()) as Array<{ missionId: string }>;
    assert.ok(rows.some((row) => row.missionId === 'M-write'));
    await new Promise<void>((done, fail) => {
      open.server.close((err) => (err ? fail(err) : done()));
    });

    const gated = await startServer(0, tempState(), {
      env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
      resolveControlPrincipal: async () => undefined,
    });
    servers.push(gated.server);
    if ('releaseLock' in gated && typeof gated.releaseLock === 'function') {
      releaseFns.push(gated.releaseLock);
    }
    const gatedAddr = gated.server.address() as AddressInfo;
    const denied = await fetch(`http://${gatedAddr.address}:${gatedAddr.port}/api/missions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'P',
        missionId: 'M-denied',
        contract: WRITE_CONTRACT,
      }),
    });
    assert.equal(denied.status, 401);
    await new Promise<void>((done, fail) => {
      gated.server.close((err) => (err ? fail(err) : done()));
    });
  });
});

describe('server.close 异常路径', () => {
  test('stop 失败时 HTTP 仍被关闭，callback 能诊断 stop 错误', async () => {
    const server = createServer();
    await listenLoopback(server, 0);
    servers.push(server);
    bindServerCloseToPeriodicStop(server, async () => {
      throw new Error('stop-boom');
    });
    const err = await new Promise<Error | undefined>((done) => {
      server.close((e) => done(e));
    });
    assert.ok(err);
    assert.match(err.message, /stop-boom/);
    assert.equal(server.listening, false);
  });

  test('HTTP close 失败时错误被报告', async () => {
    const server = createServer();
    bindServerCloseToPeriodicStop(server, async () => {});
    const err = await new Promise<Error | undefined>((done) => {
      server.close((e) => done(e));
    });
    assert.ok(err);
    assert.equal((err as NodeJS.ErrnoException).code, 'ERR_SERVER_NOT_RUNNING');
  });

  test('stop 与 HTTP close 都失败时 callback 两个错误都在', async () => {
    const server = createServer();
    bindServerCloseToPeriodicStop(server, async () => {
      throw new Error('stop-boom');
    });
    const err = await new Promise<Error | undefined>((done) => {
      server.close((e) => done(e));
    });
    assert.ok(err instanceof AggregateError);
    const nested = err.errors;
    assert.ok(nested.some((row) => row instanceof Error && row.message.includes('stop-boom')));
    assert.ok(
      nested.some((row) => (row as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING'),
    );
  });

  test('无 callback 时 emit error，且没有未处理拒绝', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const server = createServer();
      const seen: Error[] = [];
      server.on('error', (e) => {
        seen.push(e);
      });
      bindServerCloseToPeriodicStop(server, async () => {
        throw new Error('stop-boom');
      });
      server.close();
      const deadline = Date.now() + 200;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 10));
      }
      assert.equal(rejections.length, 0, '不得留下未处理拒绝');
      assert.ok(seen.some((row) => String(row.message).includes('stop-boom')));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('callback 自己抛错只调用一次，没有未处理拒绝', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args[0]);
    };
    try {
      const server = createServer();
      await listenLoopback(server, 0);
      servers.push(server);
      bindServerCloseToPeriodicStop(server, async () => {
        throw new Error('stop-boom');
      });
      let calls = 0;
      server.close(() => {
        calls += 1;
        throw new Error('callback-boom');
      });
      const deadline = Date.now() + 200;
      while (calls === 0 && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 10));
      }
      await new Promise((done) => setTimeout(done, 40));
      assert.equal(calls, 1, 'callback 最多调用一次');
      assert.equal(rejections.length, 0, '不得留下未处理拒绝');
      assert.ok(
        logged.some((row) => row instanceof Error && String(row.message).includes('callback-boom')),
      );
    } finally {
      process.off('unhandledRejection', onUnhandled);
      console.error = original;
    }
  });

  test('error 监听器自己抛错不重复交付，没有未处理拒绝', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args[0]);
    };
    try {
      const server = createServer();
      bindServerCloseToPeriodicStop(server, async () => {
        throw new Error('stop-boom');
      });
      let calls = 0;
      server.on('error', () => {
        calls += 1;
        throw new Error('listener-boom');
      });
      server.close();
      const deadline = Date.now() + 200;
      while (calls === 0 && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 10));
      }
      await new Promise((done) => setTimeout(done, 40));
      assert.equal(calls, 1, '监听器最多触发一次');
      assert.equal(rejections.length, 0, '不得留下未处理拒绝');
      assert.ok(
        logged.some((row) => row instanceof Error && String(row.message).includes('listener-boom')),
      );
    } finally {
      process.off('unhandledRejection', onUnhandled);
      console.error = original;
    }
  });

  test('无 callback 且无 error 监听器时 console.error，closeHttp 同步抛错也被接住', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args[0]);
    };
    try {
      const fake = {
        close: () => {
          throw new Error('sync-close');
        },
        emit: () => false,
        listenerCount: () => 0,
      };
      bindServerCloseToPeriodicStop(fake as unknown as Server, async () => {
        throw new Error('stop-boom');
      });
      fake.close();
      const deadline = Date.now() + 200;
      while (logged.length === 0 && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 10));
      }
      assert.equal(rejections.length, 0, '同步抛错不得变成未处理拒绝');
      const first = logged[0];
      assert.ok(first instanceof AggregateError);
      assert.ok(first.errors.some((row) => row instanceof Error && row.message.includes('stop-boom')));
      assert.ok(first.errors.some((row) => row instanceof Error && row.message.includes('sync-close')));
    } finally {
      process.off('unhandledRejection', onUnhandled);
      console.error = original;
    }
  });
});

const HOSTED_PLAN = {
  findings: 'foo 一直返回 0',
  rootCause: '初始值写错了',
  rejectedHypotheses: ['不是调用方传错'],
  decisions: ['直接改初始值'],
  direction: '改 src/foo.ts',
  risks: [] as string[],
};

const HOSTED_ORDER = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [] as string[],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [] as string[],
  contextRefs: [] as string[],
};

const COORDINATOR_HAPPY: ScriptTable = {
  'coordinator:-:0': {
    steps: [
      { tool: 'coagent_get_mission', body: {} },
      { tool: 'coagent_update_plan', body: HOSTED_PLAN },
      { tool: 'coagent_create_work_item', body: { title: '修 foo', ...HOSTED_ORDER } },
      {
        tool: 'coagent_dispatch_work_item',
        body: (previous: Record<string, unknown>) => ({ workItemIds: [previous.workItemId] }),
      },
    ],
  },
  'coordinator:-:1': {
    steps: [
      { tool: 'coagent_get_mission', body: {} },
      {
        tool: 'coagent_review_execution_result',
        body: {
          workItemId: 'W-1',
          verdict: 'accept',
          acceptanceResults: HOSTED_ORDER.acceptance.map((criterion) => ({
            criterion,
            status: 'pass' as const,
            evidence: '测试替身：逐条核过',
          })),
          reasons: ['自己复跑过 node --test，退出码 0'],
          requiredChanges: [],
        },
      },
      {
        tool: 'coagent_submit_mission_result',
        body: {
          outcome: 'delivered',
          summary: '改好了并验证过',
          acceptanceEvidence: ['node --test 退出码 0'],
          memoryDelta: [],
          openRisks: [],
        },
      },
    ],
  },
};

const EXECUTOR_HAPPY: ScriptTable = {
  'executor:W-1': {
    steps: [
      { tool: 'coagent_get_work_order', body: {} },
      {
        tool: 'coagent_submit_evidence',
        body: { kind: 'test', summary: 'node --test 全绿', command: 'node --test', exitCode: 0 },
      },
      {
        tool: 'coagent_submit_execution_result',
        body: (previous: Record<string, unknown>) => ({
          outcome: 'completed',
          summary: '改了初始值',
          changedFiles: ['src/foo.ts'],
          evidenceIds: [previous.evidenceId],
          notes: '无',
        }),
      },
    ],
  },
};

function gatedRuntime(): { runtime: AgentRuntime; release: () => void; started: Promise<void> } {
  let release = () => {};
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    runtime: {
      kind: 'test-gate',
      async start() {
        markStarted();
        return {
          on() {
            return () => {};
          },
          async abort() {
            release();
          },
          wait: async () => {
            await gate;
            return {
              endedBy: 'no_structured_result' as const,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
                quality: 'unknown' as const,
              },
            };
          },
        };
      },
    },
    release,
    started,
  };
}

function hostedMissionBody(dir: string, adapter: string, statePath: string, missionId = 'M-hosted') {
  return {
    spec: { projectId: 'P-hosted', missionId, contract: WRITE_CONTRACT },
    cwd: dir,
    adapter,
    state: statePath,
    env: { COAGENT_AGENT_ENV_PASSTHROUGH: '-' },
    inPlace: true,
    store: 'file',
  };
}

function hostedPlanBody(dir: string, adapter: string, statePath: string, runDir: string) {
  return {
    plan: {
      planId: 'PLAN-hosted',
      projectId: 'P-hosted',
      intent: '修 foo',
      integrationBranch: 'auto/hosted',
      reviewer: 'claude',
      stopConditions: {
        unresolvedEscalations: 1,
        wallClockMs: 60_000,
        escalationTimeoutMs: 60_000,
      },
      integrationVerification: [{ argv: ['node', '--test'], timeoutMs: 60_000 }],
      features: [
        {
          id: 'F1',
          title: '修 foo',
          why: 'w',
          allowedScope: ['a.txt'],
          acceptance: ['x'],
          status: 'pending',
        },
      ],
    },
    cwd: dir,
    adapter,
    state: statePath,
    store: 'file',
    runDir,
    env: { COAGENT_AGENT_ENV_PASSTHROUGH: '-' },
  };
}

async function liveTarget(statePath: string) {
  const probed = await probeLocalWriter(statePath);
  assert.equal(probed.status, 'live');
  if (probed.status !== 'live') throw new Error('expected live');
  assert.ok(probed.holder.port);
  return {
    port: probed.holder.port!,
    instanceId: probed.holder.instanceId!,
    stateId: probed.holder.stateId!,
    apiVersion: probed.holder.apiVersion!,
  };
}

describe('startServer hosted 接线与排空',
  () => {
    test('注入式在途登记器：更新、完成清理与副本隔离', () => {
      const tracker = createHostedRunTracker();
      const plan = { kind: 'plan' as const, id: 'P-injected', status: 'waiting', escalationId: 'E-injected', deadline: '2030-01-02T03:04:05Z' };
      const mission = { kind: 'mission' as const, id: 'M-injected', status: 'running' };
      tracker.register('plan-token', plan);
      tracker.register('mission-token', mission);
      plan.status = 'externally changed';
      const observed = tracker.snapshot();
      observed[0]!.status = 'snapshot changed';
      assert.match(formatHostedRunSnapshots(tracker.snapshot()), /P-injected：waiting/);
      tracker.update('plan-token', { kind: 'plan', id: 'P-injected', status: 'escalated', escalationId: 'E-injected', deadline: '2030-02-03T04:05:06Z' });
      const updated = formatHostedRunSnapshots(tracker.snapshot());
      assert.match(updated, /P-injected：escalated/);
      assert.match(updated, /E-injected；截止：2030-02-03T04:05:06Z/);
      tracker.finish('plan-token');
      assert.deepEqual(tracker.snapshot().map(({ id }) => id), ['M-injected']);
      tracker.finish('mission-token');
      assert.deepEqual(tracker.snapshot(), []);
    });

    test('首次 SIGINT 在途清单格式器：真实字段生成停止命令且缺字段不伪造', () => {
      const output = formatHostedRunSnapshots([
        { kind: 'plan', id: 'P-1', status: 'waiting', missionId: 'M-2', escalationId: 'E-3', deadline: '2030-01-02T03:04:05Z', runPath: '/runs/actual.json', reviewer: 'reviewer-1' },
        { kind: 'mission', id: 'M-2', status: 'running' },
      ]);
      assert.match(output, /P-1/);
      assert.match(output, /waiting/);
      assert.match(output, /M-2/);
      assert.match(output, /E-3/);
      assert.match(output, /2030-01-02T03:04:05Z/);
      assert.match(output, /node src\/l3\.ts plan decide E-3 --action stop --reason "服务退出" --run "\/runs\/actual\.json" --as "reviewer-1"/);
      const incomplete = formatHostedRunSnapshots([
        { kind: 'plan', id: 'P-4', status: 'waiting', escalationId: 'E-4', runPath: '/runs/actual.json' },
      ]);
      assert.match(incomplete, /无法给出停止命令/);
      assert.doesNotMatch(incomplete, /node src\/l3\.ts plan decide/);
      assert.match(formatHostedRunSnapshots([]), /无在途/);
    });

    test('首次 SIGINT 先报告注入的在途清单再关闭，第二次不重复报告', () => {
      const events: string[] = [];
      let reports = 0;
      let closes = 0;
      let secondSignals = 0;
      const snapshots = [{ kind: 'plan' as const, id: 'P-real', status: '升级中', missionId: 'M-real', escalationId: 'E-real', deadline: '2030-01-02T03:04:05Z', runPath: '/real/run.json', reviewer: 'reviewer-real' }];
      const handler = createSigintHandler(
        () => { closes += 1; events.push('close'); },
        () => { secondSignals += 1; },
        () => { reports += 1; events.push(formatHostedRunSnapshots(snapshots)); },
      );
      handler();
      handler();
      assert.equal(closes, 1);
      assert.equal(reports, 1);
      assert.equal(secondSignals, 1);
      assert.equal(events[0], formatHostedRunSnapshots(snapshots));
      assert.equal(events[1], 'close');
      assert.match(events[0]!, /P-real.*升级中/);
      assert.match(events[0]!, /M-real/);
      assert.match(events[0]!, /E-real.*2030-01-02T03:04:05Z/);
      assert.match(events[0]!, /node src\/l3\.ts plan decide E-real --action stop --reason "服务退出" --run "\/real\/run\.json" --as "reviewer-real"/);
      let failureClosed = 0;
      assert.throws(() => createSigintHandler(() => { failureClosed += 1; }, () => {}, () => { throw new Error('snapshot failure'); })());
      assert.equal(failureClosed, 1);
    });
    test('源码：两种 hosted 回调交给同一 createApi；close 先 drain 再停 tick/persist',
      () => {
        const main = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
        const startServerSrc = main.slice(main.indexOf('export async function startServer'));
        assert.equal([...startServerSrc.matchAll(/createApi\(/g)].length, 1);
        assert.equal([...startServerSrc.matchAll(/listenLoopback\(/g)].length, 1);
        assert.match(startServerSrc, /runMission:/);
        assert.match(startServerSrc, /runPlan:/);
        assert.match(startServerSrc, /runHostedMission\(/);
        assert.match(startServerSrc, /runHostedPlan\(/);
        assert.match(startServerSrc, /planRunDirs:/);
        assert.match(startServerSrc, /planLive/);
        assert.match(startServerSrc, /registerPlanRunDir/);
        assert.match(startServerSrc, /\.coagent-plans/);
        assert.match(startServerSrc, /heldState/);
        assert.match(startServerSrc, /hostedHeldState\(/);
        assert.match(main, /kind: 'unsupported'/);
        assert.match(main, /stateIdFor\(heldPath\)/);
        assert.doesNotMatch(startServerSrc, /statePath: body\.state/);
        assert.match(startServerSrc, /drainApi\(/);
        assert.match(startServerSrc, /periodic\?\.stop\(\)/);
        assert.match(startServerSrc, /built\.persist\(\)/);
        assert.match(startServerSrc, /baseUrl: loopback\.baseUrl/);
        assert.match(main, /process\.on\('SIGINT'/);
        assert.match(main, /process\.once\('SIGTERM'/);
        assert.match(main, /formatHostedRunSnapshots\(built\.hostedRunSnapshots\(\)\)/);
        assert.match(main, /无法读取在途 PlanRun\/Mission 清单/);
      },
    );

    test('runHostedMission：仅在 Mission 预检创建后通知真实解析 id', async () => {
      const statePath = tempState();
      const cwd = dirname(statePath);
      const adapter = join(cwd, 'adapter.ts');
      writeFileSync(adapter, '// hosted lifecycle fixture\\n');
      const built = await startServer(0, statePath, {
        env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
        workspace: new InPlaceWorkspaceManager(),
        runtime: new ScriptedRuntime({}),
      });
      servers.push(built.server);
      if ('releaseLock' in built && typeof built.releaseLock === 'function') releaseFns.push(built.releaseLock);
      const started: string[] = [];
      let runnerStarted = false;
      const addr = built.server.address() as AddressInfo;
      const ctx = {
        built: {
          platform: built.platform,
          tokens: built.tokens,
          agentPool: built.agentPool,
          activity: built.activity,
          deliveries: built.deliveries,
          persist: built.persist,
          candidateCircuits: built.candidateCircuits,
          queuedHops: built.queuedHops,
          live: built.live,
          issuer: built.issuer,
        },
        baseUrl: `http://127.0.0.1:${addr.port}`,
        workspace: new InPlaceWorkspaceManager(),
        runtime: new ScriptedRuntime({}),
        env: { COAGENT_AGENT_ENV_PASSTHROUGH: '-' },
        onStarted: (id: string) => {
          started.push(id);
          assert.ok(built.platform.getMissionView(id));
          assert.equal(runnerStarted, false);
        },
      } satisfies HostedMissionContext;
      const body = {
        spec: { projectId: 'P-hosted-lifecycle', missionId: 'M-hosted-lifecycle-unique', contract: WRITE_CONTRACT },
        cwd,
        adapter,
        env: { COAGENT_AGENT_ENV_PASSTHROUGH: '-' },
        inPlace: true,
        maxRounds: 1,
      };
      try {
        await runHostedMission(body, ctx, () => { runnerStarted = true; });
      } catch {
        // 空脚本 runtime 的执行结果无关；通知发生在 runner 启动之前。
      }
      assert.deepEqual(started, ['M-hosted-lifecycle-unique']);
      assert.ok(await built.platform.getMissionView('M-hosted-lifecycle-unique'));

      const invalidStarted: string[] = [];
      const invalidId = 'M-hosted-lifecycle-invalid';
      await assert.rejects(runHostedMission({
        ...body,
        spec: { ...body.spec, missionId: invalidId },
        coordinator: 'missing-coordinator',
      }, { ...ctx, onStarted: (id) => invalidStarted.push(id) }, () => {}));
      assert.deepEqual(invalidStarted, []);
      await assert.rejects(built.platform.getMissionView(invalidId));
      await new Promise<void>((done, fail) => built.server.close((err) => err ? fail(err) : done()));
    });

    test('未注入 runtime 时 hosted 入口已接上：非法 body 走同一平台且不另开写者',
      async () => {
        const statePath = tempState();
        const built = await startServer(0, statePath, {
          env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
          workspace: new InPlaceWorkspaceManager(),
        });
        servers.push(built.server);
        if ('releaseLock' in built && typeof built.releaseLock === 'function') {
          releaseFns.push(built.releaseLock);
        }
        const target = await liveTarget(statePath);
        const lines: string[] = [];
        const code = await loopbackRunRequest(
          target,
          { path: '/api/control/run-mission', body: { cwd: dirname(statePath), state: statePath } },
          (_channel, line) => {
            lines.push(line);
          },
        );
        assert.equal(code, 1);
        assert.ok(
          lines.some((line) => /adapter 必填|必须是对象|COAGENT_AGENT_ENV_PASSTHROUGH/.test(line)),
          lines.join('\n'),
        );
        const addr = built.server.address() as AddressInfo;
        const listed = await fetch(`http://${addr.address}:${addr.port}/api/missions`);
        assert.equal(listed.status, 200);
        assert.deepEqual(await listed.json(), []);
        assert.throws(() => acquireLock(statePath, 'second-writer'), LockBusyError);
        await new Promise<void>((done, fail) => {
          built.server.close((err) => (err ? fail(err) : done()));
        });
      },
    );

    test(
      '真子进程回环：进行中先于终态，Agent 回连同一服务，无第二把主锁',
      { timeout: 30_000 },
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'coagent-hosted-cli-'));
        dirs.push(dir);
        const statePath = join(dir, 'state.json');
        const adapter = join(dir, 'adapter.ts');
        writeFileSync(adapter, '// hosted adapter fixture\n');
        const missionPath = join(dir, 'mission.json');
        writeFileSync(
          missionPath,
          JSON.stringify({
            projectId: 'P-hosted',
            missionId: 'M-hosted',
            contract: WRITE_CONTRACT,
          }),
        );
        const built = await startServer(0, statePath, {
          env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
          workspace: new InPlaceWorkspaceManager(),
          runtime: new ScriptedRuntime({ ...COORDINATOR_HAPPY, ...EXECUTOR_HAPPY }),
        });
        servers.push(built.server);
        if ('releaseLock' in built && typeof built.releaseLock === 'function') {
          releaseFns.push(built.releaseLock);
        }
        const beforeLock = await probeLocalWriter(statePath);
        assert.equal(beforeLock.status, 'live');

        const child = spawn(
          process.execPath,
          [
            '--experimental-strip-types',
            fileURLToPath(new URL('../src/run-mission.ts', import.meta.url)),
            missionPath,
            '--cwd',
            dir,
            '--state',
            statePath,
            '--in-place',
            '--adapter',
            adapter,
          ],
          {
            env: { ...process.env, COAGENT_AGENT_ENV_PASSTHROUGH: '-' },
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => {
          stdout += String(chunk);
        });
        child.stderr?.on('data', (chunk) => {
          stderr += String(chunk);
        });
        const status = await new Promise<number | null>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`run-mission 超时：${stdout}${stderr}`));
          }, 20_000);
          child.once('exit', (code) => {
            clearTimeout(timer);
            resolve(code);
          });
        });
        const out = `${stdout}${stderr}`;
        assert.equal(status, 0, out);
        const startAt = stdout.indexOf('Mission M-hosted');
        const resultAt = stdout.indexOf('Mission 结果：');
        assert.ok(startAt >= 0 && resultAt > startAt, stdout);
        assert.match(stdout, /平台监听 http:\/\/127\.0\.0\.1:/);
        assert.doesNotMatch(out, /平台正被另一个进程占用/);
        assert.doesNotMatch(out, /HOSTED_RUN_UNAVAILABLE/);

        const addr = built.server.address() as AddressInfo;
        const view = await fetch(`http://${addr.address}:${addr.port}/api/missions/M-hosted`);
        assert.equal(view.status, 200);
        const body = (await view.json()) as { status: string; missionId?: string };
        assert.equal(body.status, 'awaiting_review');

        const afterLock = await probeLocalWriter(statePath);
        assert.equal(afterLock.status, 'live');
        if (beforeLock.status === 'live' && afterLock.status === 'live') {
          assert.equal(afterLock.holder.instanceId, beforeLock.holder.instanceId);
        }
        await new Promise<void>((done, fail) => {
          built.server.close((err) => (err ? fail(err) : done()));
        });
      },
    );

    test('startServer hosted Mission 快照只登记预检解析 id，并在结束后清理', { timeout: 20_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'coagent-hosted-snapshot-'));
      dirs.push(dir);
      const statePath = join(dir, 'state.json');
      const adapter = join(dir, 'adapter.ts');
      writeFileSync(adapter, '// snapshot fixture\n');
      const gated = gatedRuntime();
      const built = await startServer(0, statePath, {
        env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
        workspace: new InPlaceWorkspaceManager(), runtime: gated.runtime,
      });
      servers.push(built.server);
      if ('releaseLock' in built && typeof built.releaseLock === 'function') releaseFns.push(built.releaseLock);
      const target = await liveTarget(statePath);
      const running = loopbackRunRequest(target, {
        path: '/api/control/run-mission',
        body: hostedMissionBody(dir, adapter, statePath, 'M-snapshot-real'),
      }, () => {});
      const realGetMissionView = built.platform.getMissionView;
      try {
        await gated.started;
        const snapshots = built.hostedRunSnapshots();
        assert.equal(snapshots.length, 1);
        assert.equal(snapshots[0]?.id, 'M-snapshot-real');
        assert.equal(snapshots[0]?.kind, 'mission');
        assert.equal(snapshots[0]?.status, '运行中/状态暂不可读');
        const missionView = await realGetMissionView.call(built.platform, 'M-snapshot-real');
        assert.equal(missionView.status, 'investigating');
        let state = 'S1';
        built.platform.getMissionView = ((id: string) => {
          assert.equal(id, 'M-snapshot-real');
          return { status: state };
        }) as typeof built.platform.getMissionView;
        assert.equal(built.hostedRunSnapshots()[0]?.id, 'M-snapshot-real');
        assert.equal(built.hostedRunSnapshots()[0]?.status, 'S1');
        state = 'S2';
        assert.equal(built.hostedRunSnapshots()[0]?.id, 'M-snapshot-real');
        assert.equal(built.hostedRunSnapshots()[0]?.status, 'S2');
        built.platform.getMissionView = (() => Promise.reject(new Error('temporarily unreadable'))) as typeof built.platform.getMissionView;
        assert.equal(built.hostedRunSnapshots()[0]?.status, '运行中/状态暂不可读');
        await new Promise<void>((resolve) => setImmediate(resolve));
        const invalidCode = await loopbackRunRequest(target, {
          path: '/api/control/run-mission',
          body: hostedMissionBody(dir, adapter, join(dir, 'other-state.json'), 'M-invalid-snapshot'),
        }, () => {});
        assert.equal(invalidCode, 1);
        assert.equal(built.hostedRunSnapshots().length, 1);
      } finally {
        built.platform.getMissionView = realGetMissionView;
        gated.release();
        await running;
      }
      assert.deepEqual(built.hostedRunSnapshots(), []);
    });

    test(
      'server.close 先拒新启动，等在途 runner 结束才释锁；残锁不可抢',
      { timeout: 20_000 },
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'coagent-hosted-drain-'));
        dirs.push(dir);
        const statePath = join(dir, 'state.json');
        const adapter = join(dir, 'adapter.ts');
        writeFileSync(adapter, '// drain adapter\n');
        const gated = gatedRuntime();
        const built = await startServer(0, statePath, {
          env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
          workspace: new InPlaceWorkspaceManager(),
          runtime: gated.runtime,
        });
        servers.push(built.server);
        if ('releaseLock' in built && typeof built.releaseLock === 'function') {
          releaseFns.push(built.releaseLock);
        }
        const target = await liveTarget(statePath);
        const running = loopbackRunRequest(
          target,
          { path: '/api/control/run-mission', body: hostedMissionBody(dir, adapter, statePath, 'M-drain') },
          () => {},
        );
        await gated.started;
        assert.throws(() => acquireLock(statePath, 'during-run'), LockBusyError);

        let closed = false;
        const closing = new Promise<void>((done, fail) => {
          built.server.close((err) => {
            closed = true;
            err ? fail(err) : done();
          });
        });
        await new Promise((done) => setTimeout(done, 40));
        assert.equal(closed, false, '在途 hosted 未结束时 close 不得完成');
        assert.throws(() => acquireLock(statePath, 'during-drain'), LockBusyError);

        await assert.rejects(
          () =>
            loopbackRunRequest(
              target,
              { path: '/api/control/run-mission', body: hostedMissionBody(dir, adapter, statePath, 'M-new') },
              () => {},
            ),
          (error: unknown) =>
            error instanceof LoopbackHttpError &&
            error.status === 503 &&
            error.code === 'SERVICE_DRAINING',
        );

        const addr = built.server.address() as AddressInfo;
        const health = await fetch(`http://${addr.address}:${addr.port}/api/health`);
        assert.equal(health.status, 200);

        gated.release();
        await running;
        await closing;
        assert.equal(closed, true);
        const probe = acquireLock(statePath, 'after-drain');
        probe();
      },
    );

    test(
      '另一 statePath 或缺 state 的 hosted Mission/Plan 在写入前拒绝；同身份仍可跑',
      { timeout: 30_000 },
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'coagent-hosted-state-'));
        dirs.push(dir);
        const statePath = join(dir, 'state.json');
        const adapter = join(dir, 'adapter.ts');
        writeFileSync(adapter, '// hosted state adapter\n');
        const otherDir = mkdtempSync(join(tmpdir(), 'coagent-hosted-other-state-'));
        dirs.push(otherDir);
        const otherState = join(otherDir, 'state.json');
        writeFileSync(otherState, '{}');
        const runDir = join(dir, 'plans');
        const built = await startServer(0, statePath, {
          env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
          workspace: new InPlaceWorkspaceManager(),
          runtime: new ScriptedRuntime({ ...COORDINATOR_HAPPY, ...EXECUTOR_HAPPY }),
        });
        servers.push(built.server);
        if ('releaseLock' in built && typeof built.releaseLock === 'function') {
          releaseFns.push(built.releaseLock);
        }
        const target = await liveTarget(statePath);
        const addr = built.server.address() as AddressInfo;

        const rejectAndAssertClean = async (
          path: '/api/control/run-mission' | '/api/control/run-plan',
          body: Record<string, unknown>,
          errorPat: RegExp,
        ) => {
          const lines: string[] = [];
          const code = await loopbackRunRequest(target, { path, body }, (_channel, line) => {
            lines.push(line);
          });
          assert.equal(code, 1, lines.join('\n'));
          assert.ok(
            lines.some((line) => errorPat.test(line)),
            lines.join('\n'),
          );
          const listed = await fetch(`http://${addr.address}:${addr.port}/api/missions`);
          assert.equal(listed.status, 200);
          assert.deepEqual(await listed.json(), []);
          assert.equal(existsSync(runDir), false);
        };

        await rejectAndAssertClean(
          '/api/control/run-mission',
          hostedMissionBody(dir, adapter, otherState, 'M-wrong'),
          /同一文件|持锁/,
        );
        const missingMission = hostedMissionBody(dir, adapter, statePath, 'M-missing');
        delete missingMission.state;
        await rejectAndAssertClean('/api/control/run-mission', missingMission, /缺少 state/);

        await rejectAndAssertClean(
          '/api/control/run-plan',
          hostedPlanBody(dir, adapter, otherState, runDir),
          /同一文件|持锁/,
        );
        const missingPlan = hostedPlanBody(dir, adapter, statePath, runDir);
        delete missingPlan.state;
        await rejectAndAssertClean('/api/control/run-plan', missingPlan, /缺少 state/);

        const sameAlias = join(dir, '.', 'state.json');
        const happyLines: string[] = [];
        const happy = await loopbackRunRequest(
          target,
          {
            path: '/api/control/run-mission',
            body: hostedMissionBody(dir, adapter, sameAlias, 'M-same'),
          },
          (_channel, line) => {
            happyLines.push(line);
          },
        );
        assert.equal(happy, 0, happyLines.join('\n'));
        const view = await fetch(`http://${addr.address}:${addr.port}/api/missions/M-same`);
        assert.equal(view.status, 200);
        const viewBody = (await view.json()) as { status: string };
        assert.equal(viewBody.status, 'awaiting_review');

        await new Promise<void>((done, fail) => {
          built.server.close((err) => (err ? fail(err) : done()));
        });
      },
    );
  },
);

function withSecretOutput(runtime: ScriptedRuntime): AgentRuntime {
  return {
    kind: runtime.kind,
    supportsQuery: runtime.supportsQuery,
    async start(spec) {
      const run = await runtime.start(spec);
      return {
        resumeRef: run.resumeRef,
        abort: () => run.abort(),
        wait: () => run.wait(),
        on(handler) {
          const off = run.on(handler);
          queueMicrotask(() => {
            handler({
              kind: 'output',
              text: 'secret sk-ant-abcdefghijklmnopqrstuvwxyz Bearer abcdefghijklmnop',
            });
          });
          return off;
        },
      };
    },
  };
}

describe('文件版 hosted live 游标与脱敏', () => {
  test(
    'startServer(file)+ScriptedRuntime：/api/missions/:id/live 游标可读且凭据形状脱敏',
    { timeout: 30_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'coagent-file-live-'));
      dirs.push(dir);
      const statePath = join(dir, 'state.json');
      const adapter = join(dir, 'adapter.ts');
      writeFileSync(adapter, '// file live adapter\n');
      const runtime = withSecretOutput(
        new ScriptedRuntime({ ...COORDINATOR_HAPPY, ...EXECUTOR_HAPPY }),
      );
      const built = await startServer(0, statePath, {
        env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
        workspace: new InPlaceWorkspaceManager(),
        runtime,
      });
      servers.push(built.server);
      if ('releaseLock' in built && typeof built.releaseLock === 'function') {
        releaseFns.push(built.releaseLock);
      }
      assert.ok('live' in built && built.live, '文件版装配必须带 live');

      const target = await liveTarget(statePath);
      const lines: string[] = [];
      const code = await loopbackRunRequest(
        target,
        { path: '/api/control/run-mission', body: hostedMissionBody(dir, adapter, statePath, 'M-live') },
        (_channel, line) => {
          lines.push(line);
        },
      );
      assert.equal(code, 0, lines.join('\n'));

      const addr = built.server.address() as AddressInfo;
      const firstRes = await fetch(`http://${addr.address}:${addr.port}/api/missions/M-live/live?cursor=0`);
      assert.equal(firstRes.status, 200);
      const first = (await firstRes.json()) as {
        cursor: number;
        chunks: { kind: string; text?: string }[];
      };
      assert.ok(first.chunks.length > 0, 'hosted 假运行时必须写出实时行');
      const texts = first.chunks.map((c) => c.text ?? '').join('\n');
      assert.match(texts, /\[REDACTED\]/);
      assert.match(texts, /Bearer \[REDACTED\]/);
      assert.doesNotMatch(texts, /sk-ant-abcdefghijklmnopqrstuvwxyz/);
      assert.doesNotMatch(texts, /Bearer abcdefghijklmnop/);
      assert.ok(
        first.chunks.some((c) => c.kind === 'tool'),
        '工具事件也应进 live',
      );

      const secondRes = await fetch(
        `http://${addr.address}:${addr.port}/api/missions/M-live/live?cursor=${first.cursor}`,
      );
      const second = (await secondRes.json()) as { cursor: number; chunks: unknown[] };
      assert.deepEqual(second.chunks, []);
      assert.equal(second.cursor, first.cursor);

      built.persist();
      const dumped = readFileSync(statePath, 'utf8');
      assert.doesNotMatch(dumped, /sk-ant-abcdefghijklmnopqrstuvwxyz/);
      assert.doesNotMatch(dumped, /"live"\s*:/);

      await new Promise<void>((done, fail) => {
        built.server.close((err) => (err ? fail(err) : done()));
      });
    },
  );
});

describe('node src/main.ts 缺省状态路径', () => {
  test('钉在源码仓库根，Unix 与 Windows 解析都对', () => {
    assert.equal(
      defaultStatePathFromMainModule('/home/u/repo/src/main.ts', pathPosix),
      '/home/u/repo/.coagent-state.json',
    );
    assert.equal(
      defaultStatePathFromMainModule('C:\\Users\\u\\repo\\src\\main.ts', pathWin32),
      pathWin32.resolve('C:\\Users\\u\\repo', '.coagent-state.json'),
    );
    const fromThisModule = defaultStatePathFromMainModule();
    assert.equal(
      fromThisModule,
      resolve(fileURLToPath(new URL('..', import.meta.url)), '.coagent-state.json'),
    );
    const realMainPath = fileURLToPath(new URL('../src/main.ts', import.meta.url));
    assert.equal(isDirectMainEntry(realMainPath), true);
    assert.equal(isDirectMainEntry(fileURLToPath(import.meta.url)), false);
  });

  test('缺省文件不存在则拒绝；显式 COAGENT_STATE 仍可指向未建文件', () => {
    const fakeMain = '/isolated-repo/src/main.ts';
    const missing = resolveDirectMainStatePath(
      {},
      { mainModulePath: fakeMain, exists: () => false, pathApi: pathPosix },
    );
    assert.equal(missing.ok, false);
    if (missing.ok) throw new Error('expected refuse');
    assert.equal(missing.path, '/isolated-repo/.coagent-state.json');
    assert.match(missing.message, /COAGENT_STATE/);

    const explicit = resolveDirectMainStatePath(
      { COAGENT_STATE: '/tmp/new-state.json' },
      { mainModulePath: fakeMain, exists: () => false, pathApi: pathPosix },
    );
    assert.deepEqual(explicit, { ok: true, path: '/tmp/new-state.json' });
  });

  test(
    '外部 cwd 启动隔离源码副本：缺省定位仓库根、不存在则非零且零新建',
    { timeout: 20_000 },
    async () => {
      const repo = mkdtempSync(join(tmpdir(), 'coagent-default-state-repo-'));
      const elsewhere = mkdtempSync(join(tmpdir(), 'coagent-default-state-cwd-'));
      dirs.push(repo, elsewhere);
      mkdirSync(join(repo, 'src'));
      const stub = join(repo, 'src', 'main.ts');
      const realMain = fileURLToPath(new URL('../src/main.ts', import.meta.url));
      writeFileSync(
        stub,
        `import { fileURLToPath } from 'node:url';
import { isDirectMainEntry, resolveDirectMainStatePath } from ${JSON.stringify(pathToFileURL(realMain).href)};
if (isDirectMainEntry(process.argv[1], import.meta.url)) {
  const resolved = resolveDirectMainStatePath(process.env, { mainModulePath: fileURLToPath(import.meta.url) });
  if (!resolved.ok) {
    console.error(resolved.message);
    process.exit(1);
  }
  console.log('STATE=' + resolved.path);
  process.exit(0);
}
`,
      );

      const spawnStub = (env: NodeJS.ProcessEnv) =>
        new Promise<{ code: number | null; out: string; err: string }>((resolveP, reject) => {
          const child = spawn(process.execPath, ['--experimental-strip-types', stub], {
            cwd: elsewhere,
            env,
          });
          let out = '';
          let err = '';
          child.stdout?.on('data', (chunk) => {
            out += String(chunk);
          });
          child.stderr?.on('data', (chunk) => {
            err += String(chunk);
          });
          child.once('error', reject);
          child.once('exit', (code) => resolveP({ code, out, err }));
        });

      const env = { ...process.env };
      delete env.COAGENT_STATE;

      const missing = await spawnStub(env);
      assert.equal(missing.code, 1, missing.out + missing.err);
      assert.match(missing.err, /COAGENT_STATE/);
      assert.equal(existsSync(join(repo, '.coagent-state.json')), false);
      assert.equal(existsSync(join(elsewhere, '.coagent-state.json')), false);
      assert.deepEqual(readdirSync(elsewhere), []);

      const expectedDefault = resolve(repo, '.coagent-state.json');
      writeFileSync(expectedDefault, JSON.stringify({}));
      const present = await spawnStub(env);
      assert.equal(present.code, 0, present.out + present.err);
      assert.equal(present.out.trim(), `STATE=${expectedDefault}`);

      const explicitPath = join(elsewhere, 'explicit.json');
      const expl = await spawnStub({ ...env, COAGENT_STATE: explicitPath });
      assert.equal(expl.code, 0, expl.out + expl.err);
      assert.equal(expl.out.trim(), `STATE=${explicitPath}`);
      assert.equal(existsSync(explicitPath), false, '解析边界不负责新建；startServer 才建');
    },
  );

  test('显式状态路径：startServer 可新建文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-explicit-state-'));
    dirs.push(dir);
    const statePath = join(dir, 'brand-new.json');
    assert.equal(existsSync(statePath), false);
    const built = await startServer(0, statePath, {
      env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
      workspace: new InPlaceWorkspaceManager(),
    });
    servers.push(built.server);
    if ('releaseLock' in built && typeof built.releaseLock === 'function') {
      releaseFns.push(built.releaseLock);
    }
    await new Promise<void>((done, fail) => {
      built.server.close((err) => (err ? fail(err) : done()));
    });
    assert.equal(existsSync(statePath), true);
  });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function cleanPlanRepo(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-plan-repo-'));
  dirs.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@local');
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-qm', 'init');
  git(dir, 'checkout', '-qb', branch);
  return dir;
}

describe('startServer 方案记录目录与托管 live', () => {
  test('真实 hosted PlanRun 双次 SIGINT 安全停靠并释放主锁（动态状态目录）', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-hosted-double-signal-'));
    dirs.push(dir);
    const statePath = join(dir, 'state.json');
    const adapter = join(dir, 'adapter.ts');
    writeFileSync(adapter, '// hosted adapter\\n');
    const runDir = join(dir, 'runs');
    const repo = cleanPlanRepo('auto/hosted');
    const gated = gatedRuntime();
    const built = await startServer(0, statePath, {
      env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
      workspace: new InPlaceWorkspaceManager(),
      runtime: gated.runtime,
    });
    servers.push(built.server);
    if ('releaseLock' in built && typeof built.releaseLock === 'function') releaseFns.push(built.releaseLock);
    let running: Promise<number> | undefined;
    let exitCode = 0;
    try {
      const target = await liveTarget(statePath);
      const body = hostedPlanBody(repo, adapter, statePath, runDir);
      body.plan.stopConditions.wallClockMs = 5_000;
      body.plan.stopConditions.escalationTimeoutMs = 5_000;
      running = loopbackRunRequest(target, { path: '/api/control/run-plan', body }, () => {});
      const deadline = Date.now() + 3_000;
      let snapshots = built.hostedRunSnapshots().filter((row) => row.kind === 'plan');
      while (snapshots.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        snapshots = built.hostedRunSnapshots().filter((row) => row.kind === 'plan');
      }
      assert.equal(snapshots.length, 1, 'hosted PlanRun 未在有界时间内登记');
      const plan = snapshots[0]!;
      await gated.started;
      assert.ok(plan.runPath?.startsWith(runDir));
      const store = new FilePlanRunStore(plan.runPath!);
      assert.throws(() => acquireLock(statePath), LockBusyError);
      let closeDone = false;
      const handler = createSigintHandler(
        () => built.server.close(() => { closeDone = true; }),
        () => { exitCode = 1; void built.requestSafeShutdown(); },
        () => { built.hostedRunSnapshots(); },
      );
      handler();
      assert.equal(built.server.listening, false);
      assert.equal(closeDone, false, '首次 close 应等待真实 PlanRun 请求排空');
      assert.throws(() => acquireLock(statePath), LockBusyError);
      handler();
      const closeDeadline = Date.now() + 4_000;
      while (!closeDone && Date.now() < closeDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(closeDone, true, 'HTTP close callback 未完成');
      assert.equal(exitCode, 1);
      const stopped = store.read()?.stopped;
      assert.equal(stopped?.reason, 'service_shutdown');
      assert.ok(stopped?.detail, 'service_shutdown detail 必须明确');
      assert.equal(built.server.listening, false);
      const reacquired = acquireLock(statePath);
      reacquired.release();
    } finally {
      gated.release();
      if (running) await running;
      if (built.server.listening) await new Promise<void>((resolve) => built.server.close(() => resolve()));
    }
  });

  test('真实 hosted PlanRun 只登记预检后的身份并在结束时清理', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-hosted-plan-identity-'));
    dirs.push(dir);
    const statePath = join(dir, 'state.json');
    const adapter = join(dir, 'adapter.ts');
    writeFileSync(adapter, '// identity adapter\\n');
    const runDir = join(dir, 'runs');
    const repo = cleanPlanRepo('auto/hosted');
    const gated = gatedRuntime();
    const built = await startServer(0, statePath, {
      env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
      workspace: new InPlaceWorkspaceManager(),
      runtime: gated.runtime,
    });
    servers.push(built.server);
    if ('releaseLock' in built && typeof built.releaseLock === 'function') releaseFns.push(built.releaseLock);
    const target = await liveTarget(statePath);
    const base = hostedPlanBody(repo, adapter, statePath, runDir);
    base.plan.stopConditions.wallClockMs = 500;
    base.plan.stopConditions.escalationTimeoutMs = 500;
    let running: Promise<number> | undefined;
    try {
      running = loopbackRunRequest(target, { path: '/api/control/run-plan', body: base }, () => {});
      const deadline = Date.now() + 3_000;
      let plans = built.hostedRunSnapshots().filter((row) => row.kind === 'plan');
      while (plans.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        plans = built.hostedRunSnapshots().filter((row) => row.kind === 'plan');
      }
      assert.equal(plans.length, 1, '真实 run-plan 在有界等待内未登记 hosted plan 快照');
      const plan = plans[0]!;
      assert.match(plan.id, /^PLAN-hosted-/);
      assert.notEqual(plan.id, base.plan.planId);
      assert.ok(plan.runPath?.startsWith(runDir));
      assert.equal(plan.reviewer, 'claude');

      const invalid = { ...base, state: join(dir, 'wrong-state.json') };
      assert.equal(await loopbackRunRequest(target, { path: '/api/control/run-plan', body: invalid }, () => {}), 1);
      assert.deepEqual(built.hostedRunSnapshots(), [plan]);

      gated.release();
      assert.equal(await running, 0);
      running = undefined;
      assert.deepEqual(built.hostedRunSnapshots(), []);
    } finally {
      gated.release();
      if (running) await running;
      await new Promise<void>((resolve, reject) => built.server.close((error) => error ? reject(error) : resolve()));
    }
  });
  test('缺省目录在 statePath 同级 .coagent-plans；圈外 CLI 目录读不到；未托管有 reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-plan-dirs-'));
    dirs.push(dir);
    const statePath = join(dir, 'state.json');
    const plantedDir = join(dir, '.coagent-plans');
    const outsider = mkdtempSync(join(tmpdir(), 'coagent-plan-outsider-'));
    dirs.push(outsider);
    const stop = {
      unresolvedEscalations: 1,
      wallClockMs: 60_000,
      escalationTimeoutMs: 60_000,
    };
    await new FilePlanRunStore(join(plantedDir, 'R-planted.json')).create(
      PlanRun.start({
        id: 'R-planted',
        planId: 'PLAN-planted',
        projectId: 'P-hosted',
        integrationBranch: 'auto/hosted',
        reviewer: 'claude',
        stopConditions: stop,
        featureIds: ['F1'],
        startedAt: '2026-09-29T00:00:00.000Z',
      }),
    );
    await new FilePlanRunStore(join(outsider, 'R-outside.json')).create(
      PlanRun.start({
        id: 'R-outside',
        planId: 'PLAN-out',
        projectId: 'P-hosted',
        integrationBranch: 'auto/hosted',
        reviewer: 'claude',
        stopConditions: stop,
        featureIds: ['F9'],
        startedAt: '2026-09-29T01:00:00.000Z',
      }),
    );

    const built = await startServer(0, statePath, {
      env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
      workspace: new InPlaceWorkspaceManager(),
    });
    servers.push(built.server);
    if ('releaseLock' in built && typeof built.releaseLock === 'function') {
      releaseFns.push(built.releaseLock);
    }
    const addr = built.server.address() as AddressInfo;
    const listed = await fetch(`http://${addr.address}:${addr.port}/api/plan-runs`);
    assert.equal(listed.status, 200);
    const rows = (await listed.json()) as Array<{ id?: string }>;
    assert.ok(rows.some((row) => row.id === 'R-planted'));
    assert.equal(rows.some((row) => row.id === 'R-outside'), false);

    const liveRes = await fetch(`http://${addr.address}:${addr.port}/api/plan-runs/R-planted/live`);
    assert.equal(liveRes.status, 200);
    const live = (await liveRes.json()) as { chunks: unknown[]; reason?: string };
    assert.deepEqual(live.chunks, []);
    assert.equal(live.reason, PLAN_LIVE_EMPTY_REASON);

    await new Promise<void>((done, fail) => {
      built.server.close((err) => (err ? fail(err) : done()));
    });
  });

  test(
    '托管自定义 runDir 进列表/详情；CLI 行按 runId 可读且不丢不重',
    { timeout: 30_000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'coagent-plan-live-'));
      dirs.push(home);
      const statePath = join(home, 'state.json');
      const adapter = join(home, 'adapter.ts');
      writeFileSync(adapter, '// plan live adapter\n');
      const runDir = join(home, 'custom-plans');
      const repo = cleanPlanRepo('auto/hosted');
      const built = await startServer(0, statePath, {
        env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
        workspace: new InPlaceWorkspaceManager(),
        runtime: new ScriptedRuntime({}),
      });
      servers.push(built.server);
      if ('releaseLock' in built && typeof built.releaseLock === 'function') {
        releaseFns.push(built.releaseLock);
      }
      const target = await liveTarget(statePath);
      const ndjson: { channel: string; line: string }[] = [];
      const baseBody = hostedPlanBody(repo, adapter, statePath, runDir);
      // 墙钟/升级截止压到极短：本单只核接线，不能在默认 15s poll 上空等升级。
      const body = {
        ...baseBody,
        plan: {
          ...baseBody.plan,
          stopConditions: {
            unresolvedEscalations: 1,
            wallClockMs: 30,
            escalationTimeoutMs: 30,
          },
        },
      };
      const code = await loopbackRunRequest(
        target,
        {
          path: '/api/control/run-plan',
          body,
        },
        (channel, line) => {
          ndjson.push({ channel, line });
        },
      );
      assert.equal(code, 0, ndjson.map((row) => row.line).join('\n'));
      const cliLines = ndjson.filter((row) => row.channel === 'stdout' || row.channel === 'stderr');
      assert.ok(
        cliLines.some((row) => /开跑：/.test(row.line)),
        cliLines.map((row) => row.line).join('\n'),
      );

      const addr = built.server.address() as AddressInfo;
      const listed = await fetch(`http://${addr.address}:${addr.port}/api/plan-runs`);
      assert.equal(listed.status, 200);
      const rows = (await listed.json()) as Array<{ id?: string }>;
      const hosted = rows.find((row) => typeof row.id === 'string' && row.id.startsWith('PLAN-hosted-'));
      assert.ok(hosted?.id, JSON.stringify(rows));
      const detail = await fetch(`http://${addr.address}:${addr.port}/api/plan-runs/${hosted.id}`);
      assert.equal(detail.status, 200);

      const liveRes = await fetch(
        `http://${addr.address}:${addr.port}/api/plan-runs/${hosted.id}/live?cursor=0`,
      );
      assert.equal(liveRes.status, 200);
      const live = (await liveRes.json()) as {
        cursor: number;
        chunks: { seq: number; channel: string; line: string }[];
        reason?: string;
      };
      assert.equal(live.reason, undefined);
      assert.equal(live.chunks.length, cliLines.length);
      assert.deepEqual(
        live.chunks.map((c) => ({ channel: c.channel, line: c.line })),
        cliLines,
      );

      const caughtUp = (await (
        await fetch(
          `http://${addr.address}:${addr.port}/api/plan-runs/${hosted.id}/live?cursor=${live.cursor}`,
        )
      ).json()) as { cursor: number; chunks: unknown[] };
      assert.deepEqual(caughtUp.chunks, []);
      assert.equal(caughtUp.cursor, live.cursor);

      const mixed = (await (
        await fetch(`http://${addr.address}:${addr.port}/api/plan-runs/R-planted/live`)
      ).json()) as { chunks: unknown[]; reason?: string };
      assert.deepEqual(mixed.chunks, []);
      assert.equal(mixed.reason, PLAN_LIVE_EMPTY_REASON);

      await new Promise<void>((done, fail) => {
        built.server.close((err) => (err ? fail(err) : done()));
      });
    },
  );
});

describe('生产装配把 live 注入 Platform',
  () => {
    test('文件/PG 的 new Platform 带 live；hosted MissionRunner 用同一通道', () => {
      const main = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
      const persistent = main.slice(
        main.indexOf('export async function buildPersistentPlatform'),
        main.indexOf('export async function buildPgPlatform'),
      );
      const persistentPlat = persistent.slice(
        persistent.indexOf('const platform = new Platform'),
        persistent.indexOf('const tokens'),
      );
      assert.match(persistentPlat, /\blive,/);
      const pg = main.slice(main.indexOf('export async function buildPgPlatform'));
      const pgPlat = pg.slice(
        pg.indexOf('const platform = new Platform'),
        pg.indexOf('const tokens'),
      );
      assert.match(pgPlat, /\blive,/);
      const runner = readFileSync(
        fileURLToPath(new URL('../src/application/mission-runner.ts', import.meta.url)),
        'utf8',
      );
      assert.match(runner, /new MissionRunner\(\{[\s\S]*\blive,/);
    });
  },
);
