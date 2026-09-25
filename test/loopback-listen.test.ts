/**
 * listenLoopback：本机回环监听避开 fetch 屏蔽的端口。
 *
 * 屏蔽表要和这台机器上 Node 自带 fetch 的实际行为对得上——表里写了、fetch 却不拒绝（Node 删了某个端口），
 * 或者抽查的表外端口被拒，都说明表过期了。
 */

import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { after, describe, test } from 'node:test';
import { FETCH_BLOCKED_PORTS, listenLoopback } from '../src/application/loopback-listen.ts';

const servers: Server[] = [];
after(async () => {
  for (const server of servers) {
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
  }
});

function okServer(): Server {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  servers.push(server);
  return server;
}

async function fetchFailure(port: number): Promise<string | undefined> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
    return undefined;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return String(cause?.message ?? (error as Error).message);
  }
}

describe('FETCH_BLOCKED_PORTS 与本机 fetch 的实际行为一致', () => {
  test('表里每个端口，fetch 127.0.0.1 都以 bad port 失败', async () => {
    assert.equal(FETCH_BLOCKED_PORTS.size, 82);
    const results = await Promise.all([...FETCH_BLOCKED_PORTS].map(async (port) => [port, await fetchFailure(port)] as const));
    const notBlocked = results.filter(([, message]) => !String(message ?? '').includes('bad port')).map(([port]) => port);
    assert.deepEqual(notBlocked, [], `这些端口 fetch 不再拒绝，表过期了：${notBlocked.join(', ')}`);
  });

  test('抽查表外端口，fetch 失败也不是 bad port', async () => {
    for (const port of [1024, 6001, 10081, 15000]) {
      assert.equal(FETCH_BLOCKED_PORTS.has(port), false);
      const message = await fetchFailure(port);
      assert.ok(!String(message ?? '').includes('bad port'), `${port} 被 fetch 当成屏蔽端口：${message}`);
    }
  });
});

describe('listenLoopback', () => {
  test('port 0 分到屏蔽端口就关掉重绑，最终端口能被 fetch', async () => {
    const server = okServer();
    const seen: number[] = [];
    const port = await listenLoopback(server, 0, {
      isBlocked: (candidate) => {
        seen.push(candidate);
        return seen.length === 1;
      },
    });
    assert.equal(seen.length, 2, '第一次分到的端口算被屏蔽，应重绑一次');
    assert.equal(seen[1], port);
    assert.equal(server.listening, true);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await res.text(), 'ok');
  });

  test('一直分到屏蔽端口：到上限报错，server 不在监听', async () => {
    const server = okServer();
    await assert.rejects(
      () => listenLoopback(server, 0, { maxAttempts: 3, isBlocked: () => true }),
      /连续 3 次分到 fetch 屏蔽的端口/,
    );
    assert.equal(server.listening, false);
  });

  test('指定非 0 端口：照原样监听，不重试、不换端口', async () => {
    const probe = okServer();
    const free = await listenLoopback(probe, 0);
    await new Promise<void>((done) => probe.close(() => done()));

    const server = okServer();
    let asked = 0;
    const port = await listenLoopback(server, free, {
      isBlocked: () => {
        asked += 1;
        return true;
      },
    });
    assert.equal(port, free);
    assert.equal(asked, 0, '指定端口时不做屏蔽判定');
    assert.equal(server.listening, true);
  });

  test('端口被占：以 EADDRINUSE 拒绝，不会一直挂着', async () => {
    const holder = okServer();
    const taken = await listenLoopback(holder, 0);
    const server = okServer();
    await assert.rejects(() => listenLoopback(server, taken), (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE');
    assert.equal(server.listening, false);
  });
});
