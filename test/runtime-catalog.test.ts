/**
 * 模型清单在 createApi 实例内成功缓存。
 *
 * 适配层一次要数秒，页面刷新不能每次都等；失败又不能锁死 10 分钟旧错误。
 * 这里用假读取函数和假时钟证明调用次数、过期、失败后重试、实例隔离。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';

import { createApi, RUNTIME_MODELS_CACHE_MS } from '../src/api/server.ts';
import type { ControlPrincipalResolver } from '../src/api/control-auth.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform } from '../src/application/platform.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import { getRuntimeUsage, adapterDir, rememberAdapterDir } from '../src/application/runtime-catalog.ts';
import type { RuntimeCatalog } from '../src/application/runtime-catalog.ts';

const SUCCESS: RuntimeCatalog = {
  available: true,
  runtime: 'pi',
  models: [{ provider: 'p', model: 'm', label: 'P / M' }],
};

const FAILURE: RuntimeCatalog = {
  available: false,
  note: '适配层暂时不可用',
};

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function getModels(
  base: string,
  headers?: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/runtime/models`, { headers });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function openCatalogApi(options: {
  listRuntimeModels: () => Promise<RuntimeCatalog>;
  getRuntimeUsage?: () => Promise<{ available: true } & Record<string, unknown> | readonly unknown[] | { available: false; note: string }>;
  now?: () => number;
  resolveControlPrincipal?: ControlPrincipalResolver;
}): Promise<{ server: Server; base: string }> {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
  });
  const server = createApi({
    platform,
    tokens: new RunTokenRegistry(),
    deliveries,
    listRuntimeModels: options.listRuntimeModels,
    ...(options.getRuntimeUsage ? { getRuntimeUsage: options.getRuntimeUsage } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.resolveControlPrincipal
      ? { resolveControlPrincipal: options.resolveControlPrincipal }
      : {}),
  });
  await listenLoopback(server, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base };
}

describe('运行时用量读取', () => {
  test('fake runner 原样转发可用 JSON，available 固定为 true', async () => {
    let calls = 0;
    const dir = process.cwd();
    const result = await getRuntimeUsage(dir, async (command, args, options) => {
      calls += 1;
      assert.equal(command, 'npx');
      assert.deepEqual(args, ['tsx', 'src/cli.ts', 'usage']);
      assert.equal(options.cwd, dir);
      return { stdout: '{"available":false,"remaining":7,"resetAt":"later"}', stderr: '' } as never;
    });
    assert.deepEqual(result, { available: true, remaining: 7, resetAt: 'later' });
    assert.equal(calls, 1);
  });

  test('PI-Q1 顶层数组用量协议原样返回', async () => {
    const result = await getRuntimeUsage(process.cwd(), async () => ({ stdout: '[{"provider":"xai","remaining":3}]', stderr: '' }) as never);
    assert.deepEqual(result, [{ provider: 'xai', remaining: 3 }]);
  });

  test('无效输出和不存在目录降级为不可用', async () => {
    assert.equal((await getRuntimeUsage('/definitely/not/an/adapter')).available, false);
    const invalid = await getRuntimeUsage(process.cwd(), async () => ({ stdout: 'null', stderr: '' }) as never);
    assert.deepEqual(invalid, { available: false, note: '适配层没有返回有效用量信息' });
    const failed = await getRuntimeUsage(process.cwd(), async () => { throw new Error('missing command'); });
    assert.equal(failed.available, false);
    assert.match(failed.note, /missing command/);
  });

  test('目录优先级 environment > 最近 hosted adapter > 默认', () => {
    const old = process.env.COAGENT_ADAPTER_DIR;
    try {
      rememberAdapterDir('/tmp/recent-adapter');
      process.env.COAGENT_ADAPTER_DIR = '/tmp/env-adapter';
      assert.equal(adapterDir(), resolve('/tmp/env-adapter'));
      delete process.env.COAGENT_ADAPTER_DIR;
      assert.equal(adapterDir(), resolve('/tmp/recent-adapter'));
    } finally {
      if (old === undefined) delete process.env.COAGENT_ADAPTER_DIR;
      else process.env.COAGENT_ADAPTER_DIR = old;
    }
  });
});

describe('GET /api/runtime/usage', () => {
  test('顶层数组透传且缓存命中不重复读取', async () => {
    let calls = 0;
    const { server, base } = await openCatalogApi({
      listRuntimeModels: async () => SUCCESS,
      getRuntimeUsage: async () => { calls += 1; return [{ provider: 'xai', remaining: 2 }]; },
    });
    try {
      for (let i = 0; i < 2; i += 1) {
        const response = await fetch(`${base}/api/runtime/usage`);
        assert.deepEqual(await response.json(), [{ provider: 'xai', remaining: 2 }]);
      }
      assert.equal(calls, 1);
    } finally { await closeServer(server); }
  });

  test('成功缓存、失败重试并受只读控制鉴权', async () => {
    let calls = 0;
    const resolveControlPrincipal: ControlPrincipalResolver = (req: IncomingMessage) =>
      req.headers['x-coagent-control'] ? { id: 'viewer-1', role: 'viewer' } : undefined;
    const { server, base } = await openCatalogApi({
      listRuntimeModels: async () => SUCCESS,
      resolveControlPrincipal,
      getRuntimeUsage: async () => {
        calls += 1;
        return calls === 1 ? { available: false, note: 'offline' } : { available: true, remaining: 12 };
      },
    });
    try {
      const denied = await fetch(`${base}/api/runtime/usage`);
      assert.equal(denied.status, 401);
      assert.equal(calls, 0);
      const headers = { 'x-coagent-control': 'ok' };
      const first = await fetch(`${base}/api/runtime/usage`, { headers });
      assert.deepEqual(await first.json(), { available: false, note: 'offline' });
      const recovered = await fetch(`${base}/api/runtime/usage`, { headers });
      assert.deepEqual(await recovered.json(), { available: true, remaining: 12 });
      const cached = await fetch(`${base}/api/runtime/usage`, { headers });
      assert.deepEqual(await cached.json(), { available: true, remaining: 12 });
      assert.equal(calls, 2);
    } finally {
      await closeServer(server);
    }
  });
});

describe('GET /api/runtime/models 成功缓存', () => {
  test('有效期内同一服务只读适配层一次，过期后重新取', async () => {
    let now = 1_000;
    let calls = 0;
    const { server, base } = await openCatalogApi({
      listRuntimeModels: async () => {
        calls += 1;
        return SUCCESS;
      },
      now: () => now,
    });
    try {
      const first = await getModels(base);
      assert.equal(first.status, 200);
      assert.deepEqual(first.json, SUCCESS);
      const second = await getModels(base);
      assert.equal(second.status, 200);
      assert.deepEqual(second.json, SUCCESS);
      assert.equal(calls, 1);

      now += RUNTIME_MODELS_CACHE_MS - 1;
      const stillHot = await getModels(base);
      assert.equal(stillHot.status, 200);
      assert.equal(calls, 1);

      now += 1;
      const expired = await getModels(base);
      assert.equal(expired.status, 200);
      assert.deepEqual(expired.json, SUCCESS);
      assert.equal(calls, 2);
    } finally {
      await closeServer(server);
    }
  });

  test('available:false 不缓存，后续请求重试并可恢复成功', async () => {
    let calls = 0;
    const replies: RuntimeCatalog[] = [FAILURE, FAILURE, SUCCESS];
    const { server, base } = await openCatalogApi({
      listRuntimeModels: async () => {
        calls += 1;
        return replies.shift() ?? SUCCESS;
      },
    });
    try {
      const first = await getModels(base);
      assert.equal(first.status, 200);
      assert.deepEqual(first.json, FAILURE);
      const second = await getModels(base);
      assert.equal(second.status, 200);
      assert.deepEqual(second.json, FAILURE);
      const recovered = await getModels(base);
      assert.equal(recovered.status, 200);
      assert.deepEqual(recovered.json, SUCCESS);
      assert.equal(calls, 3);

      const cachedSuccess = await getModels(base);
      assert.equal(cachedSuccess.status, 200);
      assert.deepEqual(cachedSuccess.json, SUCCESS);
      assert.equal(calls, 3);
    } finally {
      await closeServer(server);
    }
  });

  test('不同 createApi 实例不共享缓存', async () => {
    let calls = 0;
    const list = async (): Promise<RuntimeCatalog> => {
      calls += 1;
      return SUCCESS;
    };
    const a = await openCatalogApi({ listRuntimeModels: list });
    const b = await openCatalogApi({ listRuntimeModels: list });
    try {
      const fromA = await getModels(a.base);
      const fromB = await getModels(b.base);
      assert.equal(fromA.status, 200);
      assert.equal(fromB.status, 200);
      assert.equal(calls, 2);
      await getModels(a.base);
      assert.equal(calls, 2);
    } finally {
      await closeServer(a.server);
      await closeServer(b.server);
    }
  });

  test('仍先过控制面读鉴权；未授权不碰适配层，形状不变', async () => {
    let calls = 0;
    const resolveControlPrincipal: ControlPrincipalResolver = (req: IncomingMessage) => {
      const raw = req.headers['x-coagent-control'];
      const token = Array.isArray(raw) ? raw[0] : raw;
      if (token === 'ok') return { id: 'viewer-1', role: 'viewer' };
      return undefined;
    };
    const { server, base } = await openCatalogApi({
      listRuntimeModels: async () => {
        calls += 1;
        return SUCCESS;
      },
      resolveControlPrincipal,
    });
    try {
      const denied = await getModels(base);
      assert.equal(denied.status, 401);
      assert.equal(denied.json.error, 'CONTROL_UNAUTHORIZED');
      assert.equal(typeof denied.json.message, 'string');
      assert.equal(calls, 0);

      const allowed = await getModels(base, { 'x-coagent-control': 'ok' });
      assert.equal(allowed.status, 200);
      assert.deepEqual(allowed.json, SUCCESS);
      assert.equal(calls, 1);
    } finally {
      await closeServer(server);
    }
  });
});
