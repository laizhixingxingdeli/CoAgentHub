/**
 * 等待状态的统一投影（P1：可观测性）。
 *
 * 案例：「退避等待被归成 project_busy」「检查点范围失败被归成 no_available_agent」——用户分不清
 * 服务停止、暂时退避、权限门禁和设备阻塞。现在 HTTP / 插件 / 网页读同一份 waitInfo：
 * 为什么停、谁处理、会不会自动恢复、下次重试、有没有活动 Agent、下一步；runner 是否在跑由服务端权威回答。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApi, type RunnerStateProbe } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform } from '../src/application/platform.ts';
import { WAIT_RULES } from '../src/application/platform/wait-info.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import type { QueuedHop } from '../src/application/durable-scheduler.ts';
import type { QueuedHopRepository } from '../src/application/ports.ts';
import type { MissionContract } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = { intent: '把 X 修好', acceptance: ['做完'], constraints: [], nonGoals: [], guardrails: [] };
const PAST = '2026-06-01T11:59:00.000Z';

const retryWaitHop = (missionId: string): QueuedHop => ({
  id: 'HOP-1',
  projectId: 'P',
  missionId,
  workItemId: 'W-1',
  role: 'executor',
  priority: 10,
  availableAt: PAST,
  attemptCount: 1,
  maxAttempts: 3,
  idempotencyKey: `${missionId}:executor:W-1:r1:n0`,
  status: 'retry_wait',
  createdAt: PAST,
  updatedAt: PAST,
});

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

function world(hops: readonly QueuedHop[] = []) {
  const clock = new FixedClock('2026-06-01T12:00:00.000Z');
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
    // 等待信息只读队列行里的重试计数，用最小的只读替身就够。
    queuedHops: { list: async () => hops } as unknown as QueuedHopRepository,
  });
  return { platform, deliveries };
}

const infoOf = async (platform: Platform, id: string) => (await platform.getMissionView(id)).waitInfo;

describe('等待信息：谁处理、会不会自动恢复、下次重试', () => {
  test('每一种内核停机原因都有处理方规则（新增原因必须补，不然界面上没有下一步可说）', () => {
    const source = readFileSync(new URL('../src/kernel/payloads.ts', import.meta.url), 'utf8');
    const block = /export type WaitReason =([\s\S]*?);/.exec(source)!;
    const reasons = [...block[1]!.matchAll(/\|\s*'([a-z_]+)'/g)].map((match) => match[1]!);
    assert.ok(reasons.length >= 14);
    assert.deepEqual(reasons.filter((reason) => !(reason in WAIT_RULES)), []);
  });

  test('退避：平台自动处理，给出下次重试与第几次；暂停后不再承诺自动恢复；没有停机原因就没有这一格', async () => {
    const { platform } = world([retryWaitHop('M-backoff')]);
    await platform.createMission({ projectId: 'P', missionId: 'M-backoff', contract: CONTRACT });
    assert.equal(await infoOf(platform, 'M-backoff'), undefined);

    await platform.setWaitReason('M-backoff', 'retry_backoff', '队列 Hop 失败后退避中', PAST);
    assert.deepEqual(await infoOf(platform, 'M-backoff'), {
      reason: 'retry_backoff',
      owner: 'platform',
      autoResume: true,
      nextRetryAt: PAST,
      retry: { attempt: 1, max: 3 },
      activeAgent: false,
      action: '到点平台自动重试；服务停着时重启服务，重启后会自动继续',
    });

    await platform.pauseMission('M-backoff');
    const paused = await infoOf(platform, 'M-backoff');
    assert.equal(paused?.autoResume, false, '暂停了：到点也不会自动继续');
    assert.equal(paused?.owner, 'l3');
    assert.equal(Object.hasOwn(paused!, 'nextRetryAt'), false);
  });

  test('越界停下要检视者；指定模型用不了：有恢复时刻平台处理，没有就要人；活动 Agent 如实报告', async () => {
    const { platform } = world();
    await platform.createMission({ projectId: 'P', missionId: 'M-cp', contract: CONTRACT });
    await platform.setWaitReason('M-cp', 'checkpoint_failed', '检查点包含未授权改动：docs/a.md');
    const checkpoint = await infoOf(platform, 'M-cp');
    assert.equal(checkpoint?.owner, 'l3');
    assert.equal(checkpoint?.autoResume, false);
    assert.match(checkpoint!.action, /workspace\.checkpoint_failed/);

    await platform.createMission({ projectId: 'P', missionId: 'M-model', contract: CONTRACT });
    await platform.setWaitReason('M-model', 'model_unavailable', '指定的模型冷却中', PAST);
    assert.equal((await infoOf(platform, 'M-model'))?.owner, 'platform');
    await platform.setWaitReason('M-model', 'model_unavailable', '资源池里没有匹配的候选');
    const noTime = await infoOf(platform, 'M-model');
    assert.equal(noTime?.owner, 'l3', '没有恢复时刻：平台不会自己好');
    assert.match(noTime!.action, /model-policy/);

    await platform.startCoordinatorAttempt('M-model');
    assert.equal((await infoOf(platform, 'M-model'))?.activeAgent, true);
  });
});

describe('HTTP：waitInfo 与 runner 一起给出，受理 / 在跑 / 等待 / 完成分得开', () => {
  test('GET 单条 Mission 带 waitInfo 与 runner；平台状态带托管运行与自动恢复；没装配探针的部署不多出字段', async () => {
    const { platform, deliveries } = world();
    await platform.createMission({ projectId: 'P', missionId: 'M-run', contract: CONTRACT });
    await platform.setWaitReason('M-run', 'retry_backoff', '退避中', PAST);
    await platform.createMission({ projectId: 'P', missionId: 'M-idle', contract: CONTRACT });
    const probe: RunnerStateProbe = {
      isRunning: (id) => id === 'M-run',
      running: () => ['M-run'],
      autoResume: { enabled: () => true, active: () => ['M-run'] },
    };
    const serve = async (runnerState?: RunnerStateProbe) => {
      const server: Server = createApi({ platform, tokens: new RunTokenRegistry(), deliveries, ...(runnerState ? { runnerState } : {}) });
      await listenLoopback(server, 0);
      servers.push(server);
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };

    const base = await serve(probe);
    const running = await (await fetch(`${base}/api/missions/M-run`)).json();
    assert.equal(running.waitInfo.owner, 'platform');
    assert.deepEqual(running.runner, { running: true, autoResume: { enabled: true, resuming: true } });
    const idle = await (await fetch(`${base}/api/missions/M-idle`)).json();
    assert.deepEqual(idle.runner, { running: false, autoResume: { enabled: true, resuming: false } });
    assert.equal(Object.hasOwn(idle, 'waitInfo'), false);
    const status = await (await fetch(`${base}/api/platform/status`)).json();
    assert.deepEqual(status.runner, { hostedMissions: ['M-run'], autoResume: { enabled: true, resuming: ['M-run'] } });
    const list = await (await fetch(`${base}/api/missions`)).json();
    assert.equal(list.find((row: { missionId: string }) => row.missionId === 'M-run').waitInfo.reason, 'retry_backoff');

    const bare = await serve();
    assert.equal(Object.hasOwn(await (await fetch(`${bare}/api/missions/M-run`)).json(), 'runner'), false, '旧部署的响应形状不变');
  });
});
