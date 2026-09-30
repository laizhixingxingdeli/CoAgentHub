/**
 * Attempt 终态 contextMetrics v1：平台校验后才落盘。
 *
 * 不可信输入不得 spread 进 Activity；旧收尾无摘要时不能写出伪零指标。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform } from '../src/application/platform.ts';
import type { ActivityEvent, ActivityLog, ContextMetricsV1 } from '../src/application/ports.ts';
import {
  FileActivityLog,
  FileDeliveryRepository,
  FileProjectRepository,
  FileStateStore,
  PersistentIds,
} from '../src/application/file-store.ts';
import {
  PgActivityLog,
  PgDeliveryRepository,
  PgIds,
  PgProjectRepository,
  PgStateStore,
} from '../src/application/pg-store.ts';
import { ensureTestDatabase } from './helpers/pg.ts';
import type { MissionContract } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const PATH_DIGEST = 'ab'.repeat(32);
const CONTENT_DIGEST = 'cd'.repeat(32);

const VALID_COMPLETE: ContextMetricsV1 = {
  version: 1,
  coverage: 'complete',
  brief: {
    renderedUtf8Bytes: 1200,
    sources: [
      { source: 'project_rules', estimatedTokens: 40, truncated: false },
      { source: 'work_order', truncated: true },
    ],
  },
  tools: [
    { kind: 'read', calls: 2, returnedUtf8Bytes: 80 },
    { kind: 'grep', calls: 1, returnedUtf8Bytes: 12 },
    { kind: 'find', calls: 1, returnedUtf8Bytes: 0 },
    { kind: 'ls', calls: 3, returnedUtf8Bytes: 40 },
    { kind: 'bash', calls: 1, returnedUtf8Bytes: 9 },
  ],
  reads: [{ pathDigest: PATH_DIGEST, contentDigest: CONTENT_DIGEST, repeats: 2 }],
};

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-ctxm-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

function memoryPlatform() {
  const clock = new FixedClock();
  const activity = new InMemoryActivityLog(clock);
  const projects = new InMemoryProjectRepository();
  const ids = new SequentialIds();
  const platform = new Platform({
    projects,
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    activity,
    clock,
    ids,
  });
  return { platform, activity, projects };
}

function filePlatform(path: string, activityOverride?: ActivityLog) {
  const store = new FileStateStore(path);
  const clock = new FixedClock();
  const ids = new PersistentIds(store);
  const projects = new FileProjectRepository(store);
  const inner = new FileActivityLog(store, clock);
  const platform = new Platform({
    projects,
    deliveries: new FileDeliveryRepository(store, clock, ids),
    activity: activityOverride ?? inner,
    clock,
    ids,
    transaction: store,
  });
  return { platform, activity: activityOverride ?? inner, projects, store, inner, clock };
}

function ended(events: readonly ActivityEvent[], attemptId?: string): ActivityEvent[] {
  return events.filter(
    (event) => event.kind === 'attempt.ended' && (attemptId === undefined || event.attemptId === attemptId),
  );
}

function metricsOf(event: ActivityEvent): unknown {
  return isRecord(event.data) ? event.data.contextMetrics : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function startCoord(platform: Platform, missionId: string): Promise<string> {
  await platform.createMission({ projectId: 'P', missionId, contract: CONTRACT });
  const started = await platform.startCoordinatorAttempt(missionId);
  return started.attemptId;
}

describe('内存：旧收尾与合法 v1', () => {
  test('旧 outcome 仍可收尾，attempt.ended 不产生伪零指标', async () => {
    const { platform, activity } = memoryPlatform();
    const attemptId = await startCoord(platform, 'M-old');
    await platform.finishAttempt('M-old', attemptId, { endedBy: 'structured_submit' });
    const events = ended(await activity.list('M-old'), attemptId);
    assert.equal(events.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(events[0]!.data as object, 'contextMetrics'), false);
    const data = events[0]!.data as { endedBy: string };
    assert.equal(data.endedBy, 'structured_submit');
  });

  test('合法 v1 经平台收尾落为白名单，missionId/attemptId 在 envelope', async () => {
    const { platform, activity } = memoryPlatform();
    const attemptId = await startCoord(platform, 'M-ok');
    await platform.finishAttempt('M-ok', attemptId, {
      endedBy: 'structured_submit',
      contextMetrics: VALID_COMPLETE,
    });
    const events = ended(await activity.list('M-ok'), attemptId);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.missionId, 'M-ok');
    assert.equal(events[0]!.attemptId, attemptId);
    assert.deepEqual(metricsOf(events[0]!), VALID_COMPLETE);
    const raw = JSON.stringify(events[0]!.data);
    assert.equal(raw.includes('missionId'), false);
    assert.equal(raw.includes('attemptId'), false);
  });

  test('outcome 上的其它旧字段仍然兼容', async () => {
    const { platform, activity } = memoryPlatform();
    const attemptId = await startCoord(platform, 'M-compat');
    await platform.finishAttempt('M-compat', attemptId, {
      endedBy: 'no_structured_result',
      failureMessage: '没交',
      toolCalls: ['read'],
    });
    const events = ended(await activity.list('M-compat'), attemptId);
    assert.equal((events[0]!.data as { endedBy: string }).endedBy, 'no_structured_result');
    assert.equal(Object.prototype.hasOwnProperty.call(events[0]!.data as object, 'contextMetrics'), false);
  });
});

describe('内存：拒绝不可信摘要', () => {
  const cases: { name: string; payload: unknown }[] = [
    {
      name: '多余路径/正文',
      payload: { ...VALID_COMPLETE, path: '/etc/passwd', body: 'SECRET_BODY' },
    },
    {
      name: 'reads 带原始路径',
      payload: {
        ...VALID_COMPLETE,
        reads: [{ pathDigest: PATH_DIGEST, contentDigest: CONTENT_DIGEST, repeats: 1, path: 'src/secret.ts' }],
      },
    },
    {
      name: '错误摘要（非 64 hex）',
      payload: {
        ...VALID_COMPLETE,
        reads: [{ pathDigest: 'zzzz', contentDigest: CONTENT_DIGEST, repeats: 1 }],
      },
    },
    {
      name: '大写 hex 不算',
      payload: {
        ...VALID_COMPLETE,
        reads: [{ pathDigest: 'AB'.repeat(32), contentDigest: CONTENT_DIGEST, repeats: 1 }],
      },
    },
    {
      name: '任意工具字符串',
      payload: {
        ...VALID_COMPLETE,
        tools: [{ kind: 'rm', calls: 1, returnedUtf8Bytes: 0 }],
      },
    },
    {
      name: '负数',
      payload: {
        ...VALID_COMPLETE,
        tools: [{ kind: 'read', calls: -1, returnedUtf8Bytes: 0 }],
      },
    },
    {
      name: '超桶数',
      payload: {
        version: 1,
        coverage: 'partial',
        reads: Array.from({ length: 65 }, (_, i) => ({
          pathDigest: i.toString(16).padStart(64, '0'),
          contentDigest: CONTENT_DIGEST,
          repeats: 1,
        })),
      },
    },
    {
      name: '超 JSON 字节',
      payload: { version: 1, coverage: 'unknown', padding: 'x'.repeat(40_000) },
    },
    {
      name: 'complete 缺 reads',
      payload: { version: 1, coverage: 'complete', brief: VALID_COMPLETE.brief, tools: VALID_COMPLETE.tools },
    },
    {
      name: '未知来源',
      payload: {
        ...VALID_COMPLETE,
        brief: {
          renderedUtf8Bytes: 1,
          sources: [{ source: 'secrets', truncated: false }],
        },
      },
    },
  ];

  for (const row of cases) {
    test(`${row.name} 不能写入 Activity，也不能标 complete`, async () => {
      const { platform, activity } = memoryPlatform();
      const missionId = `M-${row.name.length}-${Math.abs(hashCode(row.name))}`;
      const attemptId = await startCoord(platform, missionId);
      await platform.finishAttempt(missionId, attemptId, {
        endedBy: 'structured_submit',
        contextMetrics: row.payload,
      });
      const events = ended(await activity.list(missionId), attemptId);
      assert.equal(events.length, 1);
      assert.equal(metricsOf(events[0]!), undefined);
      const dumped = JSON.stringify(events[0]);
      assert.equal(dumped.includes('/etc/passwd'), false);
      assert.equal(dumped.includes('SECRET_BODY'), false);
      assert.equal(dumped.includes('src/secret.ts'), false);
    });
  }
});

function hashCode(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}

describe('内存：重复收尾', () => {
  test('重复收尾不会重复记 contextMetrics，旧副作用仍可用', async () => {
    const { platform, activity } = memoryPlatform();
    const attemptId = await startCoord(platform, 'M-dup');
    await platform.finishAttempt('M-dup', attemptId, {
      endedBy: 'structured_submit',
      contextMetrics: VALID_COMPLETE,
    });
    await platform.finishAttempt('M-dup', attemptId, {
      endedBy: 'structured_submit',
      contextMetrics: { version: 1, coverage: 'unknown' },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, quality: 'reported' },
    });
    const events = ended(await activity.list('M-dup'), attemptId);
    assert.equal(events.length, 2);
    const withMetrics = events.filter((event) => metricsOf(event) !== undefined);
    assert.equal(withMetrics.length, 1);
    assert.deepEqual(metricsOf(withMetrics[0]!), VALID_COMPLETE);
    assert.equal(metricsOf(events[1]!), undefined);
  });
});

describe('文件仓储重读与写入失败回滚', () => {
  test('合法摘要写入后换 store 重读仍在', async () => {
    const path = tempState();
    const attemptId = await (async () => {
      const { platform } = filePlatform(path);
      const id = await startCoord(platform, 'M-file');
      await platform.finishAttempt('M-file', id, {
        endedBy: 'structured_submit',
        contextMetrics: VALID_COMPLETE,
      });
      return id;
    })();
    const reopened = new FileActivityLog(new FileStateStore(path), new FixedClock());
    const events = ended(await reopened.list('M-file'), attemptId);
    assert.equal(events.length, 1);
    assert.deepEqual(metricsOf(events[0]!), VALID_COMPLETE);
    assert.equal(events[0]!.missionId, 'M-file');
    assert.equal(events[0]!.attemptId, attemptId);
  });

  test('写入失败不会留下采集成功的事件', async () => {
    const path = tempState();
    const store = new FileStateStore(path);
    const clock = new FixedClock();
    const ids = new PersistentIds(store);
    const projects = new FileProjectRepository(store);
    const inner = new FileActivityLog(store, clock);
    const activity: ActivityLog = {
      append: async (event) => {
        if (event.kind === 'attempt.ended') throw new Error('injected write failure');
        return inner.append(event);
      },
      list: (missionId) => inner.list(missionId),
    };
    const platform = new Platform({
      projects,
      deliveries: new FileDeliveryRepository(store, clock, ids),
      activity,
      clock,
      ids,
      transaction: store,
    });
    const attemptId = await startCoord(platform, 'M-fail');
    await assert.rejects(
      () =>
        platform.finishAttempt('M-fail', attemptId, {
          endedBy: 'structured_submit',
          contextMetrics: VALID_COMPLETE,
        }),
      (error: unknown) => error instanceof Error && error.message === 'injected write failure',
    );
    const live = ended(await inner.list('M-fail'), attemptId);
    assert.equal(live.length, 0);
    const attempt = (await projects.get('P'))?.missions[0]?.attempt(attemptId);
    assert.equal(attempt?.status, 'in_progress');
    const reopened = new FileActivityLog(new FileStateStore(path), new FixedClock());
    assert.equal(ended(await reopened.list('M-fail'), attemptId).length, 0);
    const dumped = JSON.stringify(await reopened.list('M-fail'));
    assert.equal(dumped.includes('contextMetrics'), false);
  });
});

describe('Postgres 隔离库重读与写入失败回滚', () => {
  test('可用时重开重读合法摘要；不可用则 skip', async (t) => {
    const connectionString = await ensureTestDatabase('context_metrics');
    if (!connectionString) {
      t.skip('Postgres unavailable; isolated PG context_metrics reread not verified');
      return;
    }
    const store = await PgStateStore.open({ connectionString });
    try {
      await store.pool.query('TRUNCATE projects, activity, deliveries, id_counters');
      await store.refresh();
      const clock = new FixedClock();
      const ids = new PgIds(store);
      const platform = new Platform({
        projects: new PgProjectRepository(store),
        deliveries: new PgDeliveryRepository(store, clock, ids),
        activity: new PgActivityLog(store, clock),
        clock,
        ids,
        transaction: store,
      });
      const attemptId = await startCoord(platform, 'M-pg');
      await platform.finishAttempt('M-pg', attemptId, {
        endedBy: 'structured_submit',
        contextMetrics: VALID_COMPLETE,
      });
    } finally {
      await store.close();
    }

    const other = await PgStateStore.open({ connectionString });
    try {
      const events = ended(await new PgActivityLog(other, new FixedClock()).list('M-pg'));
      assert.equal(events.length, 1);
      assert.deepEqual(metricsOf(events[0]!), VALID_COMPLETE);
      assert.equal(events[0]!.missionId, 'M-pg');
      assert.ok(events[0]!.attemptId);
    } finally {
      await other.close();
    }
  });

  test('可用时注入写失败回滚；不可用则 skip', async (t) => {
    const connectionString = await ensureTestDatabase('context_metrics');
    if (!connectionString) {
      t.skip('Postgres unavailable; isolated PG context_metrics rollback not verified');
      return;
    }
    const store = await PgStateStore.open({ connectionString });
    try {
      await store.pool.query('TRUNCATE projects, activity, deliveries, id_counters');
      await store.refresh();
      const clock = new FixedClock();
      const ids = new PgIds(store);
      const inner = new PgActivityLog(store, clock);
      const activity: ActivityLog = {
        append: async (event) => {
          if (event.kind === 'attempt.ended') throw new Error('injected write failure');
          return inner.append(event);
        },
        list: (missionId) => inner.list(missionId),
      };
      const projects = new PgProjectRepository(store);
      const platform = new Platform({
        projects,
        deliveries: new PgDeliveryRepository(store, clock, ids),
        activity,
        clock,
        ids,
        transaction: store,
      });
      const attemptId = await startCoord(platform, 'M-pg-fail');
      await assert.rejects(
        () =>
          platform.finishAttempt('M-pg-fail', attemptId, {
            endedBy: 'structured_submit',
            contextMetrics: VALID_COMPLETE,
          }),
        (error: unknown) => error instanceof Error && error.message === 'injected write failure',
      );
      assert.equal(ended(await inner.list('M-pg-fail'), attemptId).length, 0);
      assert.equal((await projects.get('P'))?.missions[0]?.attempt(attemptId)?.status, 'in_progress');
    } finally {
      await store.close();
    }
  });
});
