import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPersistentPlatform, startServer } from '../src/main.ts';
import { MissionQueueWorker } from '../src/application/mission-queue-worker.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import type { AddressInfo } from 'node:net';
import type { MissionQueueView, ProjectExecutionConfig } from '../src/application/platform/mission-queue.ts';

test('项目队列整批验证、版本冲突、依赖门禁、暂停恢复与启动配置持久化', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-queue-'));
  const state = join(root, 'state.json');
  const adapter = join(root, 'adapter.ts');
  writeFileSync(adapter, '');
  const contract = { intent: '修复已确认问题', acceptance: ['通过验证'], constraints: [], nonGoals: [], guardrails: [] };
  const config = { projectRoot: root, adapter, integrationBranch: 'codex/test', reviewer: 'test-reviewer', conversationRef: 'test-session', envPassthrough: '-', verification: [{ argv: ['node', '--test'], timeoutMs: 1000 }] };
  const built = await buildPersistentPlatform(state, { reconcile: false });
  try {
    const initial = await built.platform.getMissionQueue('P');
    await assert.rejects(built.platform.enqueueMissions('P', { expectedRevision: initial.revision, confirmedBy: '测试明确确认', config,
      missions: [{ missionId: 'A', contract }, { missionId: 'B', contract, dependsOn: ['unknown'] }] }), { code: 'QUEUE_DEPENDENCY_INVALID' });
    assert.deepEqual((await built.platform.getMissionQueue('P')).entries, []);
    assert.equal((await built.platform.getMissionQueue('P')).config, undefined);
    const queue = await built.platform.enqueueMissions('P', { expectedRevision: initial.revision, confirmedBy: '测试明确确认', config,
      missions: [{ missionId: 'A', contract }, { missionId: 'B', contract, dependsOn: ['A'] }] });
    assert.deepEqual(queue.entries.map((entry) => [entry.missionId, entry.eligible]), [['A', true], ['B', false]]);
    await assert.rejects(built.platform.configureProjectExecution('P', { expectedRevision: initial.revision, confirmedBy: '测试确认', config }), { code: 'QUEUE_STALE' });
    await built.platform.recordQueuedMissionStart('A');
    await built.platform.holdQueuedMission('A', '启动失败');
    assert.equal((await built.platform.getMissionQueue('P')).entries[0].eligible, false);
    await built.platform.resumeMission('A');
    assert.equal((await built.platform.getMissionQueue('P')).entries[0].eligible, true);
    const beforeConfigChange = await built.platform.getMissionQueue('P');
    await built.platform.configureProjectExecution('P', { expectedRevision: beforeConfigChange.revision, confirmedBy: '测试后续任务配置变更', config: { ...config, integrationBranch: 'codex/next' } });
    assert.equal((await built.platform.recordQueuedMissionStart('A')).integrationBranch, 'codex/test');
    await built.persist();
    const reopened = await buildPersistentPlatform(state, { reconcile: false });
    assert.deepEqual((await reopened.platform.getMissionQueue('P')).entries.map((entry) => entry.missionId), ['A', 'B']);
    assert.equal((await reopened.platform.getMissionQueue('P')).config?.conversationRef, 'test-session');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('队列调度每项目只运行一项，启动失败停靠，停止等待在途任务且不再派发', async () => {
  const starts: string[] = [];
  const holds: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const config: ProjectExecutionConfig = { projectRoot: '.', adapter: '.', integrationBranch: 'codex/test', reviewer: 'test', conversationRef: 'test', envPassthrough: '-', verification: [{ argv: ['node'], timeoutMs: 1000 }] };
  const worker = new MissionQueueWorker({
    read: async () => [{ projectId: 'P', revision: 'r', config, entries: [
      ...['A', 'B'].map((missionId, position) => ({ missionId, position, eligible: true, dependsOn: [], status: 'planning', blockedBy: [], contract: undefined })),
    ] } satisfies MissionQueueView],
    run: async (entry) => { starts.push(entry.missionId); await pending; throw new Error('failed'); },
    hold: async (id) => { holds.push(id); }, warn: (error) => { throw error; },
  });
  await worker.tick();
  await worker.tick();
  assert.deepEqual(starts, ['A']);
  let stopped = false;
  const stop = worker.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stop;
  await worker.tick();
  assert.deepEqual(holds, ['A']);
  assert.deepEqual(starts, ['A']);
});

test('生产服务从项目队列派发 Mission、保留升级门禁、不建 PlanRun，旧运行入口返回410', async () => {
  const root = mkdtempSync(join(tmpdir(), 'queue-service-'));
  const adapter = join(root, 'adapter.ts');
  writeFileSync(adapter, '');
  let starts = 0;
  class TestWorkspace extends InPlaceWorkspaceManager { async currentBranch() { return 'codex/test'; } }
  const built = await startServer(0, join(root, 'state.json'), {
    env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' }, workspace: new TestWorkspace(),
    runtime: { kind: 'test', start: async () => { starts += 1; return { on() {}, abort() {}, wait: async () => ({ endedBy: 'upstream_failure', failureMessage: 'unrecognized failure' }) }; } },
  });
  const base = `http://127.0.0.1:${(built.server.address() as AddressInfo).port}`;
  try {
    await built.agentPool.add({ role: 'coordinator', profileId: 'test-coordinator', endpoint: 'local' });
    const queue = await (await fetch(`${base}/api/projects/P/mission-queue`)).json();
    const contract = { intent: '测试已确认任务', acceptance: ['通过'], constraints: [], nonGoals: [], guardrails: [] };
    const response = await fetch(`${base}/api/projects/P/mission-queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      expectedRevision: queue.revision, confirmedBy: '仅限测试确认',
      config: { projectRoot: root, adapter, integrationBranch: 'codex/test', reviewer: 'test', conversationRef: 'test', envPassthrough: '-', verification: [{ argv: ['node', '--test'], timeoutMs: 1000 }] },
      missions: [{ missionId: 'A', contract }, { missionId: 'B', contract }],
    }) });
    assert.equal(response.status, 201, JSON.stringify(await response.json()));
    const deadline = Date.now() + 5000;
    while (!starts && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(starts, 1, JSON.stringify(await built.platform.getMissionView('A')));
    const blocked = await built.platform.getMissionQueue('P');
    assert.equal(blocked.entries[1].eligible, false);
    assert.equal((await fetch(`${base}/api/control/run-plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 410);
    assert.deepEqual((await (await fetch(`${base}/api/plan-runs`)).json()), []);
  } finally {
    await new Promise<void>((resolve, reject) => built.server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
