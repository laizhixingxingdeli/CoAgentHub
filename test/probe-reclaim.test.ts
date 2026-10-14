/**
 * 孤儿探测名额回收（W-682）。
 *
 * 场景：候选在 half_open 上领了探针名额（probeClaimed: true），但那次运行被中断，队列里再没有
 * 该 profile 的活租约——名额永远不会归还，候选一直卡在 half_open。守两件事：只有「连续观察满
 * 2 分钟都没有活租约」才复位；观察表留在进程内，并且每 30 秒才真读一次仓储（tick 默认 5 秒）。
 *
 * 复用 durable-scheduler 的 isActiveHopLease / activeLeaseForProfile，不在这里重写租约判断。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { type QueuedHop } from '../src/application/durable-scheduler.ts';
import {
  ProbeReclaim,
  decideProbeReclaim,
  type ProbeCircuitView,
  type ProbeReclaimDeps,
} from '../src/application/platform/probe-reclaim.ts';
import { RetryWakeScheduler, type RetryWakeDeps } from '../src/application/retry-wake.ts';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const MINUTE = 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function halfOpen(profileId: string): ProbeCircuitView {
  return { profileId, state: 'half_open', probeClaimed: true };
}

/** 一条确实占着名额的租约：status claimed 且 leaseUntil 严格晚于 nowIso。 */
function claimedHop(profileId: string, leaseUntil: string): QueuedHop {
  return {
    id: `hop-${profileId}`,
    projectId: 'P',
    missionId: 'M',
    workItemId: 'W',
    role: 'executor',
    priority: 0,
    availableAt: iso(NOW),
    attemptCount: 1,
    maxAttempts: 3,
    idempotencyKey: `key-${profileId}`,
    status: 'claimed',
    profileId,
    leaseUntil,
    createdAt: iso(NOW),
    updatedAt: iso(NOW),
  };
}

interface ResetCall {
  readonly profileId: string;
  readonly actor: string;
  readonly at: string;
  readonly reason: string;
}

function fakeProbe(profileIds: readonly string[]) {
  let now = NOW;
  let hops: readonly QueuedHop[] = [];
  const circuits = new Map<string, ProbeCircuitView>();
  const resets: ResetCall[] = [];
  const counts = { listProfiles: 0, listHops: 0 };
  const deps: ProbeReclaimDeps = {
    listProfiles: async () => {
      counts.listProfiles += 1;
      return profileIds;
    },
    getCircuit: async (profileId) => circuits.get(profileId) ?? { profileId, state: 'closed' },
    listHops: async () => {
      counts.listHops += 1;
      return hops;
    },
    reset: async (input) => {
      resets.push(input);
      return input;
    },
    warn: () => {},
    now: () => now,
  };
  return {
    deps,
    resets,
    counts,
    at: (ms: number) => {
      now = ms;
    },
    setHops: (rows: readonly QueuedHop[]) => {
      hops = rows;
    },
    setCircuit: (circuit: ProbeCircuitView) => circuits.set(circuit.profileId, circuit),
  };
}

test('half_open 探测名额无活租约满 2 分钟才复位；观察表只在进程内，且 30 秒才判一次', async () => {
  // 边界本身由纯函数钉住：差 1 毫秒不复位，恰好 2 分钟才复位。
  const boundary = { circuits: [halfOpen('p1')], hops: [], nowIso: iso(NOW + 120_000) } as const;
  assert.deepEqual(
    decideProbeReclaim({ ...boundary, nowMs: NOW + 119_999, watches: [{ profileId: 'p1', firstSeenMs: NOW }] }).resetProfileIds,
    [],
    '差 1 毫秒不满 2 分钟不复位',
  );
  assert.deepEqual(
    decideProbeReclaim({ ...boundary, nowMs: NOW + 120_000, watches: [{ profileId: 'p1', firstSeenMs: NOW }] }).resetProfileIds,
    ['p1'],
    '恰好满 2 分钟复位',
  );

  // 1–3：第一次登记、观察满 2 分钟前不复位、满 2 分钟后复位；复位后清掉记录重新计时。
  // 几次 tick 相隔超过 30 秒——间隔不足时会被节流挡下，那时连仓储都不读，自然也不复位。
  const a = fakeProbe(['p1']);
  a.setCircuit(halfOpen('p1'));
  const reclaimA = new ProbeReclaim(a.deps);
  await reclaimA.tick();
  assert.deepEqual(a.resets, [], '第一次 tick 只登记观察，不复位');
  await reclaimA.tick(NOW + 119_000);
  assert.deepEqual(a.resets, [], '不满 2 分钟不复位');
  await reclaimA.tick(NOW + 150_000);
  assert.equal(a.resets.length, 1, '连续观察满 2 分钟且无活租约：复位一次');
  assert.equal(a.resets[0]!.profileId, 'p1');
  assert.equal(a.resets[0]!.actor, 'platform:probe-reclaim');
  await reclaimA.tick(NOW + 4 * MINUTE);
  assert.equal(a.resets.length, 1, '复位后从观察表去掉，重新观察而不是每拍都复位');

  // 4：中途出现该 profile 的活租约就不复位；租约消失后要重新连续观察满 2 分钟。
  const b = fakeProbe(['p1']);
  b.setCircuit(halfOpen('p1'));
  const reclaimB = new ProbeReclaim(b.deps);
  await reclaimB.tick();
  b.setHops([claimedHop('p1', iso(NOW + 10 * MINUTE))]);
  await reclaimB.tick(NOW + 2 * MINUTE);
  assert.deepEqual(b.resets, [], '有活租约：不复位');
  b.setHops([]);
  await reclaimB.tick(NOW + 150_000);
  assert.deepEqual(b.resets, [], '租约消失后重新开始观察，不复用出现租约之前的计时');
  await reclaimB.tick(NOW + 150_000 + 119_000);
  assert.deepEqual(b.resets, [], '重新观察也不满 2 分钟不复位');
  await reclaimB.tick(NOW + 150_000 + 150_000);
  assert.equal(b.resets.length, 1, '重新连续观察满 2 分钟才复位');
  assert.equal(b.resets[0]!.reason, 'half_open probe claimed with no active lease for 2 minutes');

  // 5：open / closed / 未领取的 half_open 一概不碰。
  const c = fakeProbe(['p-open', 'p-closed', 'p-unclaimed']);
  c.setCircuit({ profileId: 'p-open', state: 'open' });
  c.setCircuit({ profileId: 'p-closed', state: 'closed' });
  c.setCircuit({ profileId: 'p-unclaimed', state: 'half_open', probeClaimed: false });
  const reclaimC = new ProbeReclaim(c.deps);
  await reclaimC.tick();
  await reclaimC.tick(NOW + 10 * MINUTE);
  assert.deepEqual(c.resets, [], '只有已领取名额的 half_open 才在候选里');

  // 6：两次 tick 只隔 10 秒，第二次不读仓储（30 秒节流）。
  const d = fakeProbe(['p1']);
  d.setCircuit(halfOpen('p1'));
  const reclaimD = new ProbeReclaim(d.deps);
  await reclaimD.tick();
  assert.equal(d.counts.listProfiles, 1);
  await reclaimD.tick(NOW + 10_000);
  assert.equal(d.counts.listProfiles, 1, '不足 30 秒：直接 return，不读仓储');
  assert.deepEqual(d.resets, []);

  // 7：RetryWakeScheduler 在每次未停止的 tick 收尾调用可选 onTick；onTick 抛错只 warn。
  const called: number[] = [];
  const deps: RetryWakeDeps = {
    listDue: async () => [],
    runDriver: async () => ({ queued: false }),
    isRunning: () => false,
    record: async () => {},
    start: async () => {},
    warn: () => {},
    onTick: async (nowMs) => {
      called.push(nowMs);
    },
  };
  await new RetryWakeScheduler(deps).tick();
  assert.equal(called.length, 1, 'tick 结束时调用一次 onTick');

  const warned: unknown[] = [];
  await new RetryWakeScheduler({
    ...deps,
    warn: (error) => warned.push(error),
    onTick: async () => {
      throw new Error('reclaim down');
    },
  }).tick();
  assert.equal(warned.length, 1, 'onTick 抛错只 warn，不让 tick 失败');
});
