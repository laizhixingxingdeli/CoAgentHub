/**
 * 退避到期自动继续（P0）。
 *
 * 案例（MiRing-V0-probe 的 W-619 / W-622）：某一跳因上游故障失败，平台记了 hop.backoff 和
 * availableAt，托管运行随后退出；退避早已过期，Mission 仍停在那里，要 L3 手动 start_mission。
 *
 * 守四件事：只挑「等时间」的 Mission（暂停 / 待 L3 / 预算 / 检查点 / 不可重试都不在内）；
 * 到点只唤醒一次、重复 tick 与并发不重复启动；没有进展时间隔拉长；服务重启后从持久状态里找回。
 */

import { describe, test } from 'node:test';
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
import { Platform, AUTO_RESUMED_EVENT_KIND } from '../src/application/platform.ts';
import { RetryWakeScheduler, type RetryWakeDeps } from '../src/application/retry-wake.ts';
import { buildPersistentPlatform } from '../src/main.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import type { AutoResumeDue, HostedRunRequest } from '../src/application/platform/auto-resume.ts';
import type { MissionContract } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const PAST = '2026-06-01T11:59:00.000Z';
const FUTURE = '2026-06-01T12:30:00.000Z';
const NOW = '2026-06-01T12:00:00.000Z';

function world() {
  const clock = new FixedClock(NOW);
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    activity,
    clock,
    ids,
  });
  return { platform, activity };
}

async function waiting(
  platform: Platform,
  missionId: string,
  reason: Parameters<Platform['setWaitReason']>[1],
  resumeAt: string | undefined,
) {
  await platform.createMission({ projectId: 'P', missionId, contract: CONTRACT });
  await platform.setWaitReason(missionId, reason, '测试用', resumeAt);
}

describe('自动恢复候选：只挑「等时间」的 Mission，门禁一个不绕', () => {
  test('到点的退避 / 冷却被挑中；未到点、暂停、待 L3、预算、检查点、不可重试、有未决升级都不动', async () => {
    const { platform } = world();
    await waiting(platform, 'due-backoff', 'retry_backoff', PAST);
    await waiting(platform, 'due-cooldown', 'no_available_agent', PAST);
    await waiting(platform, 'not-yet', 'retry_backoff', FUTURE);
    await waiting(platform, 'no-resume-time', 'retry_backoff', undefined);
    await waiting(platform, 'paused', 'retry_backoff', PAST);
    await platform.pauseMission('paused');
    await waiting(platform, 'escalated', 'retry_backoff', PAST);
    const { attemptId } = await platform.startCoordinatorAttempt('escalated');
    await platform.escalateToL3('escalated', attemptId, { question: '要不要改契约？', why: '范围不清', options: ['改', '不改'] });
    // 这些原因即使带着旧的恢复时刻，也在等人的决定或一个不会自己消失的条件。
    for (const reason of [
      'waiting_l3',
      'mission_cost_cap_reached',
      'execution_budget_exceeded',
      'work_item_checkpoint',
      'attempt_limit_reached',
      'checkpoint_failed',
      'cancelled_by_user',
    ] as const) {
      await waiting(platform, `gate-${reason}`, reason, PAST);
    }

    const due = await platform.listAutoResumeDue(NOW);
    assert.deepEqual(
      due.map((row) => row.missionId).sort(),
      ['due-backoff', 'due-cooldown'],
    );
  });

  test('恢复时刻只在设置它的那次停机里有效：清掉停机原因，时刻跟着清', async () => {
    const { platform } = world();
    await waiting(platform, 'M', 'retry_backoff', PAST);
    assert.equal((await platform.getMissionView('M')).waitResumeAt, PAST);
    await platform.setWaitReason('M', undefined);
    const view = await platform.getMissionView('M');
    assert.equal(view.waitReason, undefined);
    assert.equal(Object.hasOwn(view, 'waitResumeAt'), false);
    assert.deepEqual(await platform.listAutoResumeDue(NOW), []);
  });
});

describe('RetryWakeScheduler：到点只唤醒一次，不重复启动', () => {
  const request: HostedRunRequest = { cwd: '/proj', adapter: '/adapter/agent-entry.ts', acceptStaleBase: false };

  function fakeDeps(over: Partial<RetryWakeDeps> & { clock: { now: number } }) {
    const started: string[] = [];
    const recorded: Array<{ missionId: string; streak: number }> = [];
    const gates: Array<() => void> = [];
    const due: AutoResumeDue[] = [{ missionId: 'M', projectId: 'P', resumeAt: PAST, reason: 'retry_backoff' }];
    const deps: RetryWakeDeps = {
      listDue: async () => due,
      runDriver: async () => ({ queued: false, request }),
      isRunning: () => false,
      record: async (missionId, data) => {
        recorded.push({ missionId, streak: data.streak });
      },
      // 这次运行一直到测试放行才结束，模拟「接着跑的 Agent 还在工作」。
      start: (missionId) =>
        new Promise<void>((resolve) => {
          started.push(missionId);
          gates.push(resolve);
        }),
      warn: (error) => {
        throw error;
      },
      now: () => over.clock.now,
      minIntervalMs: 5_000,
      ...over,
    };
    return { deps, started, recorded, gates, due };
  }

  test('在途期间重复 tick / 并发 tick 不重复启动；结束后间隔内不再唤醒，间隔翻倍后才再唤醒', async () => {
    const clock = { now: Date.parse(NOW) };
    const f = fakeDeps({ clock });
    const scheduler = new RetryWakeScheduler(f.deps);

    await Promise.all([scheduler.tick(), scheduler.tick()]);
    await scheduler.tick();
    assert.deepEqual(f.started, ['M'], '同一时刻同一条 Mission 只有一个自动续跑');
    assert.deepEqual(f.recorded, [{ missionId: 'M', streak: 1 }], '启动前留审计');

    f.gates[0]!();
    await new Promise((resolve) => setImmediate(resolve));
    clock.now += 2_000;
    await scheduler.tick();
    assert.equal(f.started.length, 1, '距上次唤醒不足 5 秒：节流');

    clock.now += 4_000;
    await scheduler.tick();
    assert.equal(f.started.length, 2, '过了最小间隔可以再唤醒（第二次连续唤醒）');
    assert.equal(f.recorded[1]!.streak, 2);

    f.gates[1]!();
    await new Promise((resolve) => setImmediate(resolve));
    clock.now += 6_000;
    await scheduler.tick();
    assert.equal(f.started.length, 2, '连续无进展，间隔翻倍到 10 秒：6 秒后仍不唤醒');
    clock.now += 5_000;
    await scheduler.tick();
    assert.equal(f.started.length, 3);
  });

  test('已有托管运行、入过队列、没有启动参数、并发满了：一律不唤醒', async () => {
    const clock = { now: Date.parse(NOW) };
    const cases: Array<[string, Partial<RetryWakeDeps>]> = [
      ['托管运行已在跑', { isRunning: () => true }],
      ['队列 worker 驱动', { runDriver: async () => ({ queued: true, request }) }],
      ['从没经托管启动过', { runDriver: async () => ({ queued: false }) }],
    ];
    for (const [name, over] of cases) {
      const f = fakeDeps({ clock, ...over });
      await new RetryWakeScheduler(f.deps).tick();
      assert.equal(f.started.length, 0, name);
    }

    const full = fakeDeps({ clock, maxConcurrent: 1 });
    full.due.push({ missionId: 'M2', projectId: 'P', resumeAt: PAST, reason: 'retry_backoff' });
    await new RetryWakeScheduler(full.deps).tick();
    assert.deepEqual(full.started, ['M'], '同时在跑的自动续跑有上限，其余下个周期再来');
  });

  test('记不上审计就不启动 Agent', async () => {
    const clock = { now: Date.parse(NOW) };
    const warned: unknown[] = [];
    const f = fakeDeps({
      clock,
      record: async () => {
        throw new Error('platform down');
      },
      warn: (error) => warned.push(error),
    });
    await new RetryWakeScheduler(f.deps).tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.started.length, 0);
    assert.equal(warned.length, 1);
  });
});

describe('服务重启后仍能恢复', () => {
  test('等待时刻与托管启动参数都落在持久状态里：重建平台后调度器找回并按原参数续跑', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'retry-wake-'));
    const statePath = join(dir, 'state.json');
    try {
      const first = await buildPersistentPlatform(statePath, { workspace: new InPlaceWorkspaceManager(), reconcile: false });
      try {
        await first.platform.createMission({ projectId: 'P', missionId: 'M-restart', contract: CONTRACT });
        await first.platform.recordHostedRunRequest('M-restart', {
          cwd: '/proj', adapter: '/adapter/agent-entry.ts', maxRounds: 40, acceptStaleBase: true, origin: 'conv-1',
        });
        await first.platform.setWaitReason('M-restart', 'retry_backoff', '队列 Hop 失败后退避中', PAST);
        first.persist();
      } finally {
        first.releaseLock();
      }

      // 「服务重启」：新平台只认状态文件。
      const second = await buildPersistentPlatform(statePath, { workspace: new InPlaceWorkspaceManager(), reconcile: false });
      try {
        const started: Array<{ missionId: string; request: HostedRunRequest }> = [];
        const scheduler = new RetryWakeScheduler({
          listDue: (nowIso) => second.platform.listAutoResumeDue(nowIso),
          runDriver: (missionId) => second.platform.getRunDriver(missionId),
          isRunning: () => false,
          record: (missionId, data) => second.platform.recordAutoResume(missionId, data),
          start: async (missionId, request) => {
            started.push({ missionId, request });
          },
          warn: (error) => {
            throw error;
          },
          now: () => Date.parse(NOW) + 60_000,
        });
        await scheduler.tick();
        await scheduler.stop();

        assert.deepEqual(started, [
          {
            missionId: 'M-restart',
            request: { cwd: '/proj', adapter: '/adapter/agent-entry.ts', maxRounds: 40, acceptStaleBase: true, origin: 'conv-1' },
          },
        ]);
        const events = await second.activity.list('M-restart');
        assert.equal(events.filter((event) => event.kind === AUTO_RESUMED_EVENT_KIND).length, 1);
      } finally {
        second.releaseLock();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
