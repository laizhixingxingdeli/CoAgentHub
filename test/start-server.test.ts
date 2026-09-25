/**
 * startServer 的绑定面与启动日志：必须显式 loopback，且 host/port 与
 * 真实 server.address() 一致（尤其 port=0 时不能回显传入值）。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { acquireLock, LockBusyError } from '../src/application/lock.ts';
import { bindServerCloseToPeriodicStop, startServer } from '../src/main.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

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
    const release = acquireLock(statePath, '测试占锁');
    releaseFns.push(release);
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      const off = await startServer(0, statePath, {
        env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
      });
      servers.push(off.server);
      await new Promise((done) => setTimeout(done, 70));
      assert.equal(
        warns.filter((row) => row.includes('周期投递修复')).length,
        0,
      );
      await new Promise<void>((done, fail) => {
        off.server.close((err) => (err ? fail(err) : done()));
      });

      const on = await startServer(0, statePath, {
        env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '40' },
      });
      servers.push(on.server);
      // 上限给足：40 毫秒间隔在机器忙时会延后，200 毫秒的上限曾让这里假红。条件满足即返回。
      const deadline = Date.now() + 5000;
      while (
        warns.filter((row) => row.includes('锁忙')).length < 1 &&
        Date.now() < deadline
      ) {
        await new Promise((done) => setTimeout(done, 15));
      }
      assert.ok(warns.some((row) => row.includes('锁忙')), '启用后锁忙应跳过');
      const health = await fetch(
        `http://${(on.server.address() as AddressInfo).address}:${(on.server.address() as AddressInfo).port}/api/health`,
      );
      assert.equal(health.status, 200);
      await new Promise<void>((done, fail) => {
        on.server.close((err) => (err ? fail(err) : done()));
      });
      const mid = warns.filter((row) => row.includes('锁忙')).length;
      await new Promise((done) => setTimeout(done, 100));
      assert.equal(warns.filter((row) => row.includes('锁忙')).length, mid);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('close 等待在途慢 tick 释放锁后才完成，且不再排下一轮', async () => {
    const statePath = tempState();
    let tickCount = 0;
    let holding = false;
    let heldRelease: (() => void) | undefined;
    let finishTick = () => {};
    const gate = new Promise<void>((resolve) => {
      finishTick = resolve;
    });

    const on = await startServer(0, statePath, {
      env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '20' },
      periodicTick: async () => {
        tickCount += 1;
        if (tickCount !== 1) return;
        heldRelease = acquireLock(statePath, '在途 tick 持锁');
        holding = true;
        try {
          await gate;
        } finally {
          holding = false;
          heldRelease?.();
          heldRelease = undefined;
        }
      },
    });
    servers.push(on.server);

    try {
      // 上限给足：机器忙时第一轮 tick 会延后；条件满足即返回，不拖慢正常情况。
      const deadline = Date.now() + 5000;
      while (!holding && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 5));
      }
      assert.equal(holding, true, 'tick 应已持锁');
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
