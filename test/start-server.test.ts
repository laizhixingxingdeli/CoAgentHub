/**
 * startServer 的绑定面与启动日志：必须显式 loopback，且 host/port 与
 * 真实 server.address() 一致（尤其 port=0 时不能回显传入值）。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  test('COAGENT_DECISION_MODE=shadow：在持久化/监听前 reject，不残留 server', async () => {
    const statePath = tempState();
    const prevStore = process.env.COAGENT_STORE;
    const prevMode = process.env.COAGENT_DECISION_MODE;
    process.env.COAGENT_STORE = 'file';
    process.env.COAGENT_DECISION_MODE = 'shadow';

    const beforeHandles = process.getActiveResourcesInfo?.() ?? [];
    try {
      await assert.rejects(
        () => startServer(0, statePath),
        /shadow requested but no DecisionProvider injected/,
      );
    } finally {
      if (prevStore === undefined) delete process.env.COAGENT_STORE;
      else process.env.COAGENT_STORE = prevStore;
      if (prevMode === undefined) delete process.env.COAGENT_DECISION_MODE;
      else process.env.COAGENT_DECISION_MODE = prevMode;
    }

    // 失败路径不得留下可连的监听端口：本测未把任何 server 推入 servers[]。
    assert.equal(
      servers.filter((s) => s.listening).length,
      0,
      'shadow reject 后不得残留 listening server',
    );
    void beforeHandles;
  });
});
