/**
 * 实时输出通道。
 *
 * 要守住的是一条很具体的性质：**调度器和观测面是两个进程。** 所以这里除了
 * 验游标语义，还专门验"另一个连接能读到"——只在同一个对象上自产自销的测试
 * 证明不了任何跨进程的事。
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { InMemoryLiveOutput, NoLiveOutput } from '../src/application/live.ts';
import { PgLiveOutput, PgStateStore } from '../src/application/pg-store.ts';
import { ensureTestDatabase } from './helpers/pg.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import type { LiveOutput } from '../src/application/live.ts';

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

async function serve(live: LiveOutput) {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    workspace: new InPlaceWorkspaceManager(),
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
  });
  const server = createApi({ platform, tokens: new RunTokenRegistry(), deliveries, live });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('实时输出：游标语义', () => {
  test('只取游标之后的，不重复也不遗漏', async () => {
    const live = new InMemoryLiveOutput();
    for (const text of ['第一行', '第二行', '第三行']) {
      await live.append({ missionId: 'M1', attemptId: 'A1', kind: 'text', text });
    }

    const first = await live.since('M1');
    assert.deepEqual(first.map((c) => c.text), ['第一行', '第二行', '第三行']);

    // 拿着游标再要一次：没有新东西就该是空的，而不是又给一遍。
    assert.deepEqual(await live.since('M1', first.at(-1)?.seq), []);

    await live.append({ missionId: 'M1', attemptId: 'A1', kind: 'text', text: '第四行' });
    const next = await live.since('M1', first.at(-1)?.seq);
    assert.deepEqual(next.map((c) => c.text), ['第四行'], '续跑要接得上，不能从头再来');
  });

  test('按 Mission 隔离 —— 别的 Mission 的输出不能串进来', async () => {
    const live = new InMemoryLiveOutput();
    await live.append({ missionId: 'M1', attemptId: 'A1', kind: 'text', text: 'M1 的' });
    await live.append({ missionId: 'M2', attemptId: 'A2', kind: 'text', text: 'M2 的' });
    assert.deepEqual((await live.since('M1')).map((c) => c.text), ['M1 的']);
  });

  test('有上限 —— 这是用来看的，不是用来存的', async () => {
    const live = new InMemoryLiveOutput(10);
    for (let i = 0; i < 50; i += 1) {
      await live.append({ missionId: 'M1', attemptId: 'A1', kind: 'text', text: `行 ${i}` });
    }
    const all = await live.since('M1');
    assert.equal(all.length, 10);
    assert.equal(all.at(-1)?.text, '行 49', '留的该是最近的那一段');
  });

  test('一跳结束就清掉它的缓冲 —— 最终输出已经落在 Attempt 上了', async () => {
    const live = new InMemoryLiveOutput();
    await live.append({ missionId: 'M1', attemptId: 'A1', kind: 'text', text: 'x' });
    await live.append({ missionId: 'M1', attemptId: 'A2', kind: 'text', text: 'y' });
    await live.finish('A1');
    assert.deepEqual((await live.since('M1')).map((c) => c.attemptId), ['A2']);
  });
});

describe('实时输出：HTTP 面', () => {
  test('带游标取；没有新内容时游标原样回来', async () => {
    const live = new InMemoryLiveOutput();
    const base = await serve(live);
    await live.append({ missionId: 'M1', attemptId: 'A1', kind: 'text', text: 'hello' });
    await live.append({ missionId: 'M1', attemptId: 'A1', kind: 'tool', text: 'bash' });

    const first = (await (await fetch(`${base}/api/missions/M1/live?cursor=0`)).json()) as {
      cursor: number;
      chunks: { kind: string; text: string }[];
    };
    assert.equal(first.chunks.length, 2);
    assert.deepEqual(first.chunks.map((c) => c.kind), ['text', 'tool']);

    const second = (await (
      await fetch(`${base}/api/missions/M1/live?cursor=${first.cursor}`)
    ).json()) as { cursor: number; chunks: unknown[] };
    assert.deepEqual(second.chunks, []);
    // 原样回来：客户端不用为"这次没新东西"单独写一段判空。
    assert.equal(second.cursor, first.cursor);
  });

  test('没装实时通道时是空的，不是 404 —— 界面不该因此崩掉', async () => {
    const base = await serve(new NoLiveOutput());
    const res = await fetch(`${base}/api/missions/M1/live`);
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { chunks: unknown[] }).chunks, []);
  });

  test('用量事件走同一条通道 —— token 数才能边跑边涨', async () => {
    const live = new InMemoryLiveOutput();
    const base = await serve(live);
    await live.append({
      missionId: 'M1',
      attemptId: 'A1',
      kind: 'usage',
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, total: 17, quality: 'reported' },
    });
    const body = (await (await fetch(`${base}/api/missions/M1/live`)).json()) as {
      chunks: { kind: string; usage?: { total: number } }[];
    };
    assert.equal(body.chunks[0].kind, 'usage');
    assert.equal(body.chunks[0].usage?.total, 17);
  });
});

describe('实时输出：跨进程（Postgres）', () => {
  let store: PgStateStore | undefined;
  let ok = false;
  let dsn = '';

  before(async () => {
    try {
      const target = await ensureTestDatabase();
      if (!target) return;
      dsn = target;
      store = await PgStateStore.open({ connectionString: dsn });
      await PgLiveOutput.ensureSchema(store);
      await store.pool.query('TRUNCATE live_output');
      ok = true;
    } catch {
      ok = false;
    }
  });

  after(async () => {
    await store?.close();
  });

  test('一个连接写，另一个连接读得到 —— 这才是这个端口存在的理由', async (t) => {
    if (!ok) {
      t.skip('没有可用的 Postgres');
      return;
    }
    const writerStore = store as PgStateStore;
    const writer = new PgLiveOutput(writerStore);
    await writer.append({ missionId: 'M-live', attemptId: 'A1', kind: 'text', text: '来自调度器' });

    // 另开一个 store = 另一个进程的视角。内存版在这里必然拿到空。
    const readerStore = await PgStateStore.open({ connectionString: dsn });
    try {
      const reader = new PgLiveOutput(readerStore);
      const chunks = await reader.since('M-live');
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].text, '来自调度器');

      // 游标语义跨连接也要成立。
      assert.deepEqual(await reader.since('M-live', chunks[0].seq), []);
      await writer.append({ missionId: 'M-live', attemptId: 'A1', kind: 'text', text: '第二条' });
      assert.equal((await reader.since('M-live', chunks[0].seq)).length, 1);

      await writer.finish('A1');
      assert.deepEqual(await reader.since('M-live'), [], '收尾要把实时行删干净');
    } finally {
      await readerStore.close();
    }
  });
});
