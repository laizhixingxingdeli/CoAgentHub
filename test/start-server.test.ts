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
import type { Server } from 'node:http';

import { startServer } from '../src/main.ts';

const servers: Server[] = [];
const dirs: string[] = [];
const releaseFns: Array<() => void> = [];

after(() => {
  for (const server of servers) {
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
    const built = buildPlatform(undefined, provider);
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
