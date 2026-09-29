/**
 * 实时输出通道。
 *
 * 要守住的是一条很具体的性质：**调度器和观测面是两个进程。** 所以这里除了
 * 验游标语义，还专门验"另一个连接能读到"——只在同一个对象上自产自销的测试
 * 证明不了任何跨进程的事。
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import {
  InMemoryLiveOutput,
  InMemoryPlanRunLiveOutput,
  KEEP_TAIL_ON_FINISH,
  NoLiveOutput,
  PLAN_LIVE_EMPTY_REASON,
  PLAN_LIVE_LIMIT,
} from '../src/application/live.ts';
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
import { listenLoopback } from '../src/application/loopback-listen.ts';
import { buildPersistentPlatform } from '../src/main.ts';

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
  await listenLoopback(server, 0);
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

  test('一跳结束后行还在 —— 跑完的任务回头也要看得到输出', async () => {
    const live = new InMemoryLiveOutput();
    await live.append({ missionId: 'M1', attemptId: 'A1', kind: 'text', text: 'x' });
    await live.append({ missionId: 'M1', attemptId: 'A2', kind: 'text', text: 'y' });
    await live.finish('M1', 'A1');
    // 这一条曾经断言的是相反的事（收尾把 A1 删干净）。那个行为把"跑完的任务
    // 没有历史"当成了设计，而 Attempt.output 实测只有 1.4 KB，补不上。
    assert.deepEqual(
      (await live.since('M1')).map((c) => c.attemptId),
      ['A1', 'A2'],
      '没超过保留量就一行都不该删',
    );
  });

  test('超过保留量才裁，裁掉的部分要留下痕迹', async () => {
    const live = new InMemoryLiveOutput(10_000);
    const total = KEEP_TAIL_ON_FINISH + 25;
    for (let i = 0; i < total; i += 1) {
      await live.append({ missionId: 'M1', attemptId: 'A1', kind: 'text', text: `行 ${i}` });
    }
    await live.append({ missionId: 'M2', attemptId: 'A1', kind: 'text', text: 'M2-0' });
    await live.append({ missionId: 'M2', attemptId: 'A1', kind: 'text', text: 'M2-1' });
    await live.finish('M1', 'A1');
    const kept = await live.since('M1', 0, 10_000);

    const notes = kept.filter((c) => c.kind === 'note');
    assert.equal(notes.length, 1, '裁剪必须留痕：悄悄截断会让人把残段当全貌');
    assert.match(String(notes[0].text), /共 525 行/);

    const text = kept.filter((c) => c.kind === 'text');
    assert.equal(text.length, KEEP_TAIL_ON_FINISH);
    assert.equal(text.at(-1)?.text, `行 ${total - 1}`, '留的该是尾巴，不是开头');
    assert.equal(text[0]?.text, '行 25');
    assert.deepEqual(
      (await live.since('M2')).map((c) => c.text),
      ['M2-0', 'M2-1'],
      '相同 attemptId 的其它 Mission 不得被 finish 误裁剪',
    );
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

      await writer.finish('M-live', 'A1');
      assert.equal(
        (await reader.since('M-live')).length,
        2,
        '收尾不再删光：没超过保留量就该原样留着，另一个进程也读得到',
      );
    } finally {
      await readerStore.close();
    }
  });

  test('超过保留量时，库里裁的是最早的那一段', async (t) => {
    if (!ok) {
      t.skip('没有可用的 Postgres');
      return;
    }
    const live = new PgLiveOutput(store as PgStateStore);
    const total = KEEP_TAIL_ON_FINISH + 12;
    for (let i = 0; i < total; i += 1) {
      await live.append({ missionId: 'M-trim', attemptId: 'A-trim', kind: 'text', text: `行 ${i}` });
    }
    await live.append({ missionId: 'M-other', attemptId: 'A-trim', kind: 'text', text: 'other-0' });
    await live.append({ missionId: 'M-other', attemptId: 'A-trim', kind: 'text', text: 'other-1' });
    await live.finish('M-trim', 'A-trim');

    // limit 要给足：默认 500 正好等于保留量，取不出那条 note 就断言不到裁剪。
    const kept = await live.since('M-trim', 0, 10_000);
    const text = kept.filter((c) => c.kind === 'text');
    assert.equal(text.length, KEEP_TAIL_ON_FINISH);
    assert.equal(text[0]?.text, '行 12', 'DELETE … ORDER BY seq DESC OFFSET 删的必须是最早的');
    assert.equal(text.at(-1)?.text, `行 ${total - 1}`);
    assert.equal(kept.filter((c) => c.kind === 'note').length, 1);
    assert.deepEqual(
      (await live.since('M-other')).map((c) => c.text),
      ['other-0', 'other-1'],
      'Postgres 也不能误裁剪相同 attemptId 的其它 Mission',
    );
  });
});

describe('文件版 buildPersistentPlatform 接通 live',
  () => {
    const dirs: string[] = [];
    after(() => {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });

    test('返回 InMemoryLiveOutput，不落盘，独立入口按 built.live 装配',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'coagent-file-live-build-'));
        dirs.push(dir);
        const statePath = join(dir, 'state.json');
        const built = await buildPersistentPlatform(statePath, {
          workspace: new InPlaceWorkspaceManager(),
        });
        assert.equal(built.live instanceof InMemoryLiveOutput, true);
        await built.live.append({
          missionId: 'M-mem',
          attemptId: 'A1',
          kind: 'text',
          text: 'sk-ant-abcdefghijklmnopqrstuvwxyz',
        });
        built.persist();
        const dumped = readFileSync(statePath, 'utf8');
        assert.doesNotMatch(dumped, /sk-ant-abcdefghijklmnopqrstuvwxyz/);
        assert.doesNotMatch(dumped, /"live"\s*:/);
        assert.equal((await built.live.since('M-mem')).length, 1);

        const main = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
        const persistent = main.slice(
          main.indexOf('export async function buildPersistentPlatform'),
          main.indexOf('export async function buildPgPlatform'),
        );
        assert.match(persistent, /new InMemoryLiveOutput/);
        assert.match(persistent, /\blive,/);
        assert.doesNotMatch(persistent, /PgLiveOutput/);
        const pg = main.slice(main.indexOf('export async function buildPgPlatform'));
        assert.match(pg, /new PgLiveOutput/);

        const runPlan = readFileSync(fileURLToPath(new URL('../src/run-plan.ts', import.meta.url)), 'utf8');
        const runMission = readFileSync(
          fileURLToPath(new URL('../src/run-mission.ts', import.meta.url)),
          'utf8',
        );
        assert.match(runPlan, /const live = 'live' in built \? built\.live : undefined/);
        assert.match(runMission, /const live = 'live' in built \? built\.live : undefined/);
      },
    );
  },
);

async function servePlanLive(planLive?: InMemoryPlanRunLiveOutput) {
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
  const server = createApi({
    platform,
    tokens: new RunTokenRegistry(),
    deliveries,
    ...(planLive ? { planLive } : {}),
  });
  await listenLoopback(server, 0);
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('托管方案实时输出：游标语义',
  () => {
    test('只取游标之后的，不重复也不遗漏', () => {
      const live = new InMemoryPlanRunLiveOutput();
      live.append({ runId: 'R1', channel: 'stdout', line: '第一行' });
      live.append({ runId: 'R1', channel: 'stderr', line: '第二行' });
      live.append({ runId: 'R1', channel: 'stdout', line: '第三行' });

      const first = live.since('R1');
      assert.deepEqual(first.map((c) => c.line), ['第一行', '第二行', '第三行']);
      assert.deepEqual(first.map((c) => c.channel), ['stdout', 'stderr', 'stdout']);
      assert.equal(live.since('R1', first.at(-1)?.seq).length, 0);

      live.append({ runId: 'R1', channel: 'stdout', line: '第四行' });
      assert.deepEqual(
        live.since('R1', first.at(-1)?.seq).map((c) => c.line),
        ['第四行'],
      );
    });

    test('按 runId 隔离 —— 别的方案输出不能串进来', () => {
      const live = new InMemoryPlanRunLiveOutput();
      live.append({ runId: 'R1', channel: 'stdout', line: 'R1 的' });
      live.append({ runId: 'R2', channel: 'stdout', line: 'R2 的' });
      assert.deepEqual(live.since('R1').map((c) => c.line), ['R1 的']);
      assert.equal(live.hosted('R1'), true);
      assert.equal(live.hosted('R-missing'), false);
    });

    test('有上限 —— 与任务 live 同量级，这是用来看的不是存的', () => {
      const live = new InMemoryPlanRunLiveOutput(10);
      for (let i = 0; i < 50; i += 1) {
        live.append({ runId: 'R1', channel: 'stdout', line: `行 ${i}` });
      }
      const all = live.since('R1');
      assert.equal(all.length, 10);
      assert.equal(all.at(-1)?.line, '行 49');
      assert.equal(PLAN_LIVE_LIMIT, 5_000);
    });
  },
);

describe('托管方案实时输出：HTTP 面',
  () => {
    test('带游标取；没有新内容时游标原样回来；跨方案不串', async () => {
      const live = new InMemoryPlanRunLiveOutput();
      const base = await servePlanLive(live);
      live.append({ runId: 'R1', channel: 'stdout', line: 'hello' });
      live.append({ runId: 'R1', channel: 'stderr', line: 'warn' });
      live.append({ runId: 'R2', channel: 'stdout', line: 'other' });

      const first = (await (await fetch(`${base}/api/plan-runs/R1/live?cursor=0`)).json()) as {
        cursor: number;
        chunks: { seq: number; at: string; channel: string; line: string }[];
        reason?: string;
      };
      assert.equal(first.chunks.length, 2);
      assert.deepEqual(first.chunks.map((c) => c.channel), ['stdout', 'stderr']);
      assert.deepEqual(first.chunks.map((c) => c.line), ['hello', 'warn']);
      assert.equal('runId' in first.chunks[0]!, false);
      assert.equal(first.reason, undefined);

      const second = (await (
        await fetch(`${base}/api/plan-runs/R1/live?cursor=${first.cursor}`)
      ).json()) as { cursor: number; chunks: unknown[]; reason?: string };
      assert.deepEqual(second.chunks, []);
      assert.equal(second.cursor, first.cursor);
      assert.equal(second.reason, undefined);

      const other = (await (await fetch(`${base}/api/plan-runs/R2/live`)).json()) as {
        chunks: { line: string }[];
      };
      assert.deepEqual(other.chunks.map((c) => c.line), ['other']);
    });

    test('没装托管缓冲时是空的且说明原因，不是 404', async () => {
      const base = await servePlanLive();
      const res = await fetch(`${base}/api/plan-runs/R-any/live`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { cursor: number; chunks: unknown[]; reason?: string };
      assert.deepEqual(body.chunks, []);
      assert.equal(body.reason, PLAN_LIVE_EMPTY_REASON);
    });

    test('记录存在但本进程没写过：空缓冲仍带 reason', async () => {
      const live = new InMemoryPlanRunLiveOutput();
      const base = await servePlanLive(live);
      const res = await fetch(`${base}/api/plan-runs/R-disk-only/live?cursor=0`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { chunks: unknown[]; reason?: string };
      assert.deepEqual(body.chunks, []);
      assert.equal(body.reason, PLAN_LIVE_EMPTY_REASON);
    });

    test('非法 id 404，不把路径段回给客户端', async () => {
      const live = new InMemoryPlanRunLiveOutput();
      live.append({ runId: 'R-safe', channel: 'stdout', line: 'secret-line' });
      const base = await servePlanLive(live);
      const traversal = await fetch(`${base}/api/plan-runs/${encodeURIComponent('../secret')}/live`);
      assert.equal(traversal.status, 404);
      const payload = (await traversal.json()) as { message?: string };
      assert.equal(String(payload.message ?? '').includes('secret'), false);
      const mixed = await fetch(`${base}/api/plan-runs/R-safe%2F../R-safe/live`);
      assert.notEqual(mixed.status, 200);
    });
  },
);
