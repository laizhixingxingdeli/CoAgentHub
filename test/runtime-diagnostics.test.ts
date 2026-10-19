/**
 * Attempt 终态双侧诊断：平台只落固定词，不落文案/堆栈/未知键。
 *
 * 这条链路的上游是 agent 进程，它读得到本机一切东西。所以平台侧收口的判据不是
 * 「这字段长什么样」，而是「**只有词表里的词能进状态**」：platform.code 只认
 * platform_unreachable，upstream.category 只认与适配层共用的那张类别表。
 *
 * 同时钉住两件不许被顺带改坏的事：
 *  - 畸形/空诊断**不挡收尾**（Attempt 照样进终态、attempt.ended 照样落一条）；
 *  - `endedBy` 一字不改（诊断是两侧事实，不是结束原因）。
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
import type { ActivityEvent } from '../src/application/ports.ts';
import {
  sanitizeRuntimeDiagnostics,
  RUNTIME_DIAGNOSTIC_UPSTREAM_CATEGORIES,
} from '../src/application/runtime-diagnostics.ts';
import type { MissionContract } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

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
  return { platform, activity };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diagnosticsOf(event: ActivityEvent): unknown {
  return isRecord(event.data) ? event.data.runtimeDiagnostics : undefined;
}

function ended(events: readonly ActivityEvent[], attemptId: string): ActivityEvent[] {
  return events.filter(
    (event) => event.kind === 'attempt.ended' && event.attemptId === attemptId,
  );
}

async function startCoord(platform: Platform, missionId: string): Promise<string> {
  await platform.createMission({ projectId: 'P', missionId, contract: CONTRACT });
  const started = await platform.startCoordinatorAttempt(missionId);
  return started.attemptId;
}

describe('平台收口：双侧类别落盘', () => {
  test('两侧固定词落进 attempt.ended；恶意嵌套文案、URL、未知键一律不落盘', async () => {
    const { platform, activity } = memoryPlatform();
    const attemptId = await startCoord(platform, 'M-diag');

    // 恶意/脏输入：文案里塞秘密，另有未知键与带 userinfo 的 URL。
    await platform.finishAttempt('M-diag', attemptId, {
      endedBy: 'platform_unreachable',
      runtimeDiagnostics: {
        platform: {
          code: 'platform_unreachable',
          message: 'SECRET_SENTINEL_PLATFORM',
          stack: 'at secret()',
          url: 'https://user:pass@proxy.internal/x',
        },
        upstream: {
          category: 'quota_exhausted',
          message: 'SECRET_SENTINEL_UPSTREAM',
          requestBody: '{"key":"sk-live-xxx"}',
        },
        unknownTopLevel: 'SECRET_SENTINEL_TOP',
      },
    });

    const events = ended(await activity.list('M-diag'), attemptId);
    assert.equal(events.length, 1);
    // 白名单投影：只留固定词，其余逐字丢弃（不 spread）。
    assert.deepEqual(diagnosticsOf(events[0]!), {
      platform: { code: 'platform_unreachable' },
      upstream: { category: 'quota_exhausted' },
    });

    // endedBy 不受影响。
    assert.equal((events[0]!.data as Record<string, unknown>).endedBy, 'platform_unreachable');

    const dumped = JSON.stringify(events[0]!.data);
    for (const sentinel of [
      'SECRET_SENTINEL_PLATFORM',
      'SECRET_SENTINEL_UPSTREAM',
      'SECRET_SENTINEL_TOP',
      'sk-live-xxx',
      'proxy.internal',
      'at secret()',
      'unknownTopLevel',
    ]) {
      assert.equal(dumped.includes(sentinel), false, `落盘内容里不该出现 ${sentinel}`);
    }
  });

  test('干净双侧诊断落盘；畸形值忽略且不挡收尾，endedBy 保持不变', async () => {
    const { platform, activity } = memoryPlatform();
    const cleanId = await startCoord(platform, 'M-clean');
    await platform.finishAttempt('M-clean', cleanId, {
      endedBy: 'upstream_failure',
      failureMessage: '上游 429',
      runtimeDiagnostics: {
        platform: { code: 'platform_unreachable' },
        upstream: { category: 'rate_limited' },
      },
    });
    const clean = ended(await activity.list('M-clean'), cleanId);
    assert.equal(clean.length, 1);
    assert.deepEqual(diagnosticsOf(clean[0]!), {
      platform: { code: 'platform_unreachable' },
      upstream: { category: 'rate_limited' },
    });
    // 旧字段照旧。
    assert.equal((clean[0]!.data as Record<string, unknown>).endedBy, 'upstream_failure');
    assert.equal((clean[0]!.data as Record<string, unknown>).retriable, true);

    // 畸形/空诊断：Attempt 照样收尾，诊断字段缺席。
    const malformedId = await startCoord(platform, 'M-bad');
    await platform.finishAttempt('M-bad', malformedId, {
      endedBy: 'structured_submit',
      runtimeDiagnostics: {
        platform: { code: 'totally_made_up' },
        upstream: { category: 'not_a_real_category' },
      },
    });
    const malformed = ended(await activity.list('M-bad'), malformedId);
    assert.equal(malformed.length, 1);
    assert.equal(
      Object.prototype.hasOwnProperty.call(malformed[0]!.data as object, 'runtimeDiagnostics'),
      false,
    );
    assert.equal((malformed[0]!.data as Record<string, unknown>).endedBy, 'structured_submit');

    // 空对象 / 非对象 / 数组同样忽略，不写空对象。
    for (const [missionId, value] of [
      ['M-empty', {}],
      ['M-string', 'platform_unreachable'],
      ['M-array', [{ platform: { code: 'platform_unreachable' } }]],
      ['M-null', null],
    ] as const) {
      const id = await startCoord(platform, missionId);
      await platform.finishAttempt(missionId, id, {
        endedBy: 'no_structured_result',
        runtimeDiagnostics: value,
      });
      const events = ended(await activity.list(missionId), id);
      assert.equal(events.length, 1);
      assert.equal(
        Object.prototype.hasOwnProperty.call(events[0]!.data as object, 'runtimeDiagnostics'),
        false,
        `${missionId} 不该写出诊断字段`,
      );
      assert.equal((events[0]!.data as Record<string, unknown>).endedBy, 'no_structured_result');
    }
  });
});

describe('sanitizeRuntimeDiagnostics 词表', () => {
  test('两栏各自独立收口；缺一栏不影响另一栏', () => {
    assert.deepEqual(sanitizeRuntimeDiagnostics({ platform: { code: 'platform_unreachable' } }), {
      platform: { code: 'platform_unreachable' },
    });
    assert.deepEqual(sanitizeRuntimeDiagnostics({ upstream: { category: 'network' } }), {
      upstream: { category: 'network' },
    });
    // 平台栏畸形不影响上游栏落盘。
    assert.deepEqual(
      sanitizeRuntimeDiagnostics({
        platform: { code: 'nope' },
        upstream: { category: 'network' },
      }),
      { upstream: { category: 'network' } },
    );
  });

  test('只接受 plain object，未知键只投影不透传', () => {
    assert.equal(sanitizeRuntimeDiagnostics(undefined), undefined);
    assert.equal(sanitizeRuntimeDiagnostics('x'), undefined);
    assert.equal(sanitizeRuntimeDiagnostics([{ platform: { code: 'platform_unreachable' } }]), undefined);
    assert.equal(sanitizeRuntimeDiagnostics(Object.create(null) as unknown), undefined);
    // 未知键被丢掉，而不是把整段丢掉（真实类别不能因一个多余键而消失）。
    assert.deepEqual(
      sanitizeRuntimeDiagnostics({ platform: { code: 'platform_unreachable' }, extra: 'SECRET' }),
      { platform: { code: 'platform_unreachable' } },
    );
    assert.deepEqual(
      sanitizeRuntimeDiagnostics({ platform: { code: 'platform_unreachable', extra: 'SECRET' } }),
      { platform: { code: 'platform_unreachable' } },
    );
    assert.deepEqual(
      sanitizeRuntimeDiagnostics({ upstream: { category: 'network', message: 'SECRET' } }),
      { upstream: { category: 'network' } },
    );
  });

  test('类别表与适配层共用词表一致（复制，不 import）', () => {
    for (const category of RUNTIME_DIAGNOSTIC_UPSTREAM_CATEGORIES) {
      assert.deepEqual(sanitizeRuntimeDiagnostics({ upstream: { category } }), {
        upstream: { category },
      });
    }
    assert.equal(RUNTIME_DIAGNOSTIC_UPSTREAM_CATEGORIES.length, 7);
    assert.equal(
      sanitizeRuntimeDiagnostics({ upstream: { category: 'Platform_Unreachable' } }),
      undefined,
    );
  });
});
