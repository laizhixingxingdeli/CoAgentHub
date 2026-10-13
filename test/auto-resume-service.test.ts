/**
 * 退避到期由服务自己接着跑——整条服务接线上的端到端（startServer + 托管 run-mission）。
 *
 * 案例（MiRing-V0-probe 的 W-619 / W-622）：某一跳失败后平台记了退避，托管运行随即退出；
 * 退避早已过期，Mission 仍停在那里，要 L3 手动 start_mission。
 *
 * 这里不手工 tick 调度器、不绕过 main.ts 的装配：真起一个服务，用 HTTP 启动一条托管 Mission，
 * 假 Agent 第一次失败（无法归类的上游失败：不换候选、直接退避）。守四件事——
 *   1. 退避期间对外说清楚：停机原因 retry_backoff、平台会自动恢复、runner 已经不在跑；
 *   2. 没有任何人再动手，到点服务自己重新启动一次 Agent（候选 A 已冷却，轮到候选 B）；
 *   3. 只启动一次，不重复派发；
 *   4. 运维开关 COAGENT_AUTO_RESUME=0 关着时，既不自己接着跑，对外也如实说「不会自动恢复」。
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { loopbackRunRequest } from '../src/application/loopback-control-client.ts';
import { probeLocalWriter } from '../src/application/lock.ts';
import type { AgentRuntime } from '../src/application/ports.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { startServer } from '../src/main.ts';
import { SPAWN_ENV_PASSTHROUGH_VAR } from '../src/runtime/spawn.ts';

const CONTRACT = { intent: '服务自己接着跑', acceptance: ['做完'], constraints: [], nonGoals: [], guardrails: [] };
const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, quality: 'unknown' as const };

const servers: Server[] = [];
const dirs: string[] = [];
const releaseFns: Array<() => void> = [];

after(() => {
  for (const server of servers) {
    if (!server.listening) continue;
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
      /* already released */
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function liveTarget(statePath: string) {
  const probed = await probeLocalWriter(statePath);
  assert.equal(probed.status, 'live');
  if (probed.status !== 'live') throw new Error('expected live');
  return {
    port: probed.holder.port!,
    instanceId: probed.holder.instanceId!,
    stateId: probed.holder.stateId!,
    apiVersion: probed.holder.apiVersion!,
  };
}

async function until(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return done();
}

/** 起一个真服务，装两个协调者候选，Agent 一律「无法归类的上游失败」（不换候选、直接退避）。 */
async function bootService(extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-auto-resume-'));
  dirs.push(dir);
  const statePath = join(dir, 'state.json');
  const adapter = join(dir, 'adapter.ts');
  writeFileSync(adapter, '// auto-resume fixture\n');
  const startedBy: string[] = [];
  const runtime: AgentRuntime = {
    kind: 'test',
    async start(spec) {
      startedBy.push(spec.profile.profileId);
      return {
        resumeRef: undefined,
        on: () => () => {},
        abort: async () => {},
        wait: async () => ({ endedBy: 'upstream_failure' as const, failureMessage: 'unrecognized failure', usage: USAGE }),
      };
    },
  };
  const built = await startServer(0, statePath, {
    env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0', ...extraEnv },
    workspace: new InPlaceWorkspaceManager(),
    runtime,
  });
  servers.push(built.server);
  if ('releaseLock' in built && typeof built.releaseLock === 'function') releaseFns.push(built.releaseLock);
  const base = 'http://127.0.0.1:' + String((built.server.address() as AddressInfo).port);
  await built.agentPool.add({ role: 'coordinator', profileId: 'coord-a', endpoint: 'local' });
  await built.agentPool.add({ role: 'coordinator', profileId: 'coord-b', endpoint: 'local' });

  /** 经 HTTP 启动一条托管 Mission；返回时托管运行已经退出（失败 → 退避）。 */
  const startMission = async (missionId: string) =>
    loopbackRunRequest(
      await liveTarget(statePath),
      {
        path: '/api/control/run-mission',
        body: {
          spec: { projectId: 'P-auto', missionId, contract: CONTRACT },
          cwd: dir,
          adapter,
          state: statePath,
          env: { [SPAWN_ENV_PASSTHROUGH_VAR]: '-' },
          inPlace: true,
          store: 'file',
        },
      },
      () => {},
    );
  const view = async (missionId: string) =>
    (await (await fetch(base + '/api/missions/' + missionId)).json()) as Record<string, any>;
  const close = () =>
    new Promise<void>((resolve, reject) => built.server.close((error) => (error ? reject(error) : resolve())));
  return { built, base, startedBy, startMission, view, close };
}

test('失败退避后托管运行退出，到点由服务自己接着跑一次，不靠任何人手动 start', { timeout: 60_000 }, async () => {
  const s = await bootService();

  // 1. 首次启动：Agent 起一次、失败、进入退避，托管运行随之退出。
  assert.equal(typeof (await s.startMission('M-auto')), 'number');
  assert.deepEqual(s.startedBy, ['coord-a'], '首次运行只起了一次 Agent');

  // 2. 退避期间对外说清楚：不是名额被占，平台会自己恢复，runner 已经退出。
  const waiting = await s.view('M-auto');
  assert.equal(waiting.waitReason, 'retry_backoff');
  assert.ok(Number.isFinite(Date.parse(waiting.waitResumeAt)), '带着下次重试时刻');
  assert.equal(waiting.waitInfo.autoResume, true);
  assert.equal(waiting.waitInfo.owner, 'platform');
  assert.equal(waiting.runner.running, false, '托管运行已经退出：退避等待不等于 runner 在跑');
  assert.equal(waiting.runner.autoResume.enabled, true);
  assert.deepEqual(s.built.hostedRunSnapshots(), []);

  // 3. 没有任何人再动手：服务到点自己重新启动 Agent（A 已冷却，轮到 B）。
  assert.equal(
    await until(() => s.startedBy.length >= 2, 30_000),
    true,
    '服务应当自己接着跑，实际启动：' + s.startedBy.join(','),
  );
  assert.deepEqual(s.startedBy.slice(0, 2), ['coord-a', 'coord-b']);
  const events = await s.built.platform.getActivity('M-auto');
  const resumed = events.filter((event) => event.kind === 'mission.auto_resumed');
  assert.equal(resumed.length, 1, '留了一条「谁、因为什么、第几次」的审计');
  assert.equal((resumed[0]!.data as { reason: string }).reason, 'retry_backoff');
  assert.equal(
    events.filter((event) => event.kind === 'mission.run_requested').length,
    1,
    '续跑复用同一份启动参数，不重复记录',
  );

  // 4. 只启动一次：之后一小段时间里不会被重复唤醒、重复派发。
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(s.startedBy.length, 2);

  await s.close();
});

test('COAGENT_AUTO_RESUME=0：到点也不会自己接着跑，而且对外如实说「不会自动恢复」', { timeout: 60_000 }, async () => {
  const s = await bootService({ COAGENT_AUTO_RESUME: '0' });
  await s.startMission('M-off');
  assert.deepEqual(s.startedBy, ['coord-a']);

  // 开关是关着的：停机原因还是退避，但投影不能再说平台会自动重试。
  const waiting = await s.view('M-off');
  assert.equal(waiting.waitReason, 'retry_backoff');
  assert.equal(waiting.runner.autoResume.enabled, false);
  assert.equal(waiting.waitInfo.autoResume, false);
  assert.equal(waiting.waitInfo.nextRetryAt, undefined);
  assert.equal(waiting.waitInfo.owner, 'l3');
  assert.match(waiting.waitInfo.action, /COAGENT_AUTO_RESUME=0/);
  const rows = (await (await fetch(s.base + '/api/missions')).json()) as Array<Record<string, any>>;
  assert.equal(rows.find((row) => row.missionId === 'M-off')?.waitInfo.autoResume, false, '列表接口与详情接口说的一样');

  // 退避早过期、调度周期也过了好几轮——Agent 仍然只起过一次。
  await new Promise((resolve) => setTimeout(resolve, 7000));
  assert.deepEqual(s.startedBy, ['coord-a']);
  const events = await s.built.platform.getActivity('M-off');
  assert.equal(events.some((event) => event.kind === 'mission.auto_resumed'), false);

  await s.close();
});
