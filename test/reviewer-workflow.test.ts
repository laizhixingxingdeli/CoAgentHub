import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildPersistentPlatform } from '../src/main.ts';
import { GitWorktreeManager } from '../src/application/workspace.ts';
import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import { FixedClock, InMemoryActivityLog, InMemoryProjectRepository, SequentialIds } from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform } from '../src/application/platform.ts';
import { FilePlanRunStore } from '../src/application/plan-run-store.ts';
import { PlanRun } from '../src/application/plan-run.ts';
import { createReviewerMcpHandler } from '../src/api/reviewer-mcp.ts';

const CONTRACT = { intent: '待办测试', acceptance: ['可恢复'], constraints: [], nonGoals: [], guardrails: [] };
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'coagent-reviewer-workflow-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-b', 'master'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'a.txt'), 'base'); git('add', 'a.txt'); git('commit', '-m', 'base');
  git('checkout', '-b', 'codex/integration');
  return { root, git };
}

test('持久待办：HTTP 只读不 ACK，确认不解除升级，等用户 park 后恢复可读', async () => {
  const { root } = repository();
  const path = join(root, 'state.json');
  const workspace = new GitWorktreeManager(join(root, 'worktrees'));
  const built = await buildPersistentPlatform(path, { workspace, reconcile: false });
  let server;
  try {
    await built.platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT });
    const prepared = await workspace.prepare('M', root);
    await built.platform.recordWorkspace('M', { projectRoot: root, branch: prepared.branch, baseRevision: prepared.baseRevision });
    const { attemptId } = await built.platform.startCoordinatorAttempt('M');
    await built.platform.escalateToL3('M', attemptId, { question: '请用户确认', why: '范围含糊', optionsConsidered: [] });
    server = createApi({ platform: built.platform, tokens: new RunTokenRegistry(), deliveries: built.deliveries,
      resolveControlPrincipal: (req) => ({ id: 'test', role: req.headers['x-test-role'] === 'operator' ? 'operator' : 'viewer' }) });
    await listenLoopback(server, 0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const before = await built.deliveries.pending();
    const response = await fetch(`${base}/api/reviewer/todos`);
    const { todos } = await response.json();
    assert.equal(todos.length, 1); assert.equal(todos[0].blocking, true);
    assert.deepEqual(await built.deliveries.pending(), before);
    const post = (action: string, role = 'operator') => fetch(`${base}/api/reviewer/todos/${encodeURIComponent(todos[0].id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-role': role },
      body: JSON.stringify({ action, reviewer: 'L3-test', reason: '真实测试决定' }),
    });
    assert.equal((await post('acknowledge', 'viewer')).status, 403);
    assert.equal((await post('acknowledge')).status, 200);
    assert.equal((await built.platform.getMissionView('M')).openEscalations.length, 1);
    assert.equal((await built.platform.listReviewerTodos())[0].notify, false);
    assert.equal((await post('wait_user')).status, 200);
    assert.equal((await built.platform.getMissionView('M')).parked, true);
    await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined;
    const reopened = await buildPersistentPlatform(path, { workspace, reconcile: false });
    assert.equal((await reopened.platform.listReviewerTodos('P'))[0].state, 'waiting_user');
    assert.equal((await reopened.deliveries.pending()).length, before.length);
    await reopened.platform.answerEscalation('M', '范围已确定');
    assert.equal((await reopened.platform.listReviewerTodos()).length, 0, '源问题解决后旧待办消失');
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('PlanRun HTTP 仅承载运行可写；值守交接使旧决定与守候失效', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-plan-http-'));
  const clock = new FixedClock(); const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({ projects: new InMemoryProjectRepository(), activity: new InMemoryActivityLog(clock), clock, ids, deliveries });
  await platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT });
  const store = new FilePlanRunStore(join(dir, 'R.json'));
  await store.create(PlanRun.start({ id: 'R', planId: 'PLAN', projectId: 'P', integrationBranch: 'auto/test', reviewer: 'B',
    featureIds: ['F'], startedAt: new Date().toISOString(), stopConditions: { unresolvedEscalations: 5, wallClockMs: 3600000, escalationTimeoutMs: 3600000 } }));
  await store.update((run) => { run.startFeature('F', 'M'); run.openEscalation({ featureId: 'F', missionId: 'M', failure: 'failed', question: '重跑？' }, new Date().toISOString()); });
  let active: string[] = [];
  const server = createApi({ platform, tokens: new RunTokenRegistry(), deliveries, planRunDirs: () => [dir],
    planRunRuntime: { activeRunIds: () => active, isStateFileWriter: true } });
  await listenLoopback(server, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (owner?: string, gen?: number) => fetch(`${base}/api/plan-runs/R/decide`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(owner ? { 'x-coagent-reviewer': owner, 'x-coagent-reviewer-generation': String(gen) } : {}) },
    body: JSON.stringify({ escalationId: 'E-1', action: 'skip', decidedBy: 'B', reason: '本次明确跳过' }) });
  try {
    assert.equal((await post()).status, 409, '历史来源没有运行承载不能决定');
    assert.equal(store.read()!.toSnapshot().escalations[0].resolution, undefined);
    active = ['R'];
    const todos = await (await fetch(`${base}/api/reviewer/todos`)).json();
    assert.equal(todos.todos[0].decisionPath, 'plan_run');
    await platform.changeReviewerDuty('P', { action: 'claim', owner: 'A' });
    await platform.changeReviewerDuty('P', { action: 'handoff', owner: 'A', generation: 1, nextOwner: 'B' });
    assert.equal((await post('A', 1)).status, 409);
    const oldWait = await fetch(`${base}/api/reviewer/wait?projectId=P&owner=A&generation=1&waitMs=0`);
    assert.equal(oldWait.status, 409);
    const waited = await (await fetch(`${base}/api/reviewer/wait?projectId=P&owner=B&generation=2&waitMs=0`)).json();
    assert.equal(waited.todos.length, 1); assert.equal(waited.changed, true);
    assert.equal((await post('B', 2)).status, 200);
    assert.equal(store.read()!.toSnapshot().escalations[0].resolution?.action, 'skip');
    const current = await (await fetch(`${base}/api/reviewer/todos`)).json();
    assert.equal(current.todos.length, 0);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('MCP 握手、工具调用与错误通过 HTTP，不消费通知或允许任意地址', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const handler = createReviewerMcpHandler(undefined, (async (url, init) => {
    calls.push({ url: String(url), init }); return new Response(JSON.stringify({ todos: [] }), { status: 200 });
  }) as typeof fetch);
  const invoke = (method: string, params?: Record<string, unknown>, id?: number) => handler({ jsonrpc: '2.0', method, params, ...(id === undefined ? {} : { id }) });
  assert.ok((await invoke('tools/list', undefined, 1))?.error);
  await invoke('initialize', { protocolVersion: '2025-11-25' }, 2);
  assert.equal(await invoke('notifications/initialized'), undefined);
  assert.equal((await invoke('tools/list', undefined, 3))?.result.tools.length, 11);
  await invoke('tools/call', { name: 'coagenthub_reviewer_todos', arguments: { projectId: 'P' } }, 4);
  assert.equal(calls[0].url, 'http://127.0.0.1:3101/api/reviewer/todos?projectId=P');
  assert.equal(calls[0].init?.method, 'GET');
  const bad = await invoke('tools/call', { name: 'coagenthub_plan_run_decide', arguments: { runId: 'R', escalationId: 'E-1', decidedBy: 'B', action: 'merge' } }, 5);
  assert.equal(bad?.result.isError, true); assert.equal(calls.length, 1);
  await invoke('tools/call', { name: 'coagenthub_decide_document', arguments: { documentId: 'DOC:M:A:0', action: 'approve', reviewer: 'B', generation: 2,
    reason: '审阅差异', revision: 1, baseHash: 'hash' } }, 6);
  assert.equal(calls[1].url, 'http://127.0.0.1:3101/api/documents/DOC%3AM%3AA%3A0/decide');
  assert.equal(calls[1].init?.headers?.['x-coagent-reviewer-generation'], '2');
  const profileId = 'exec/qdc:1';
  await invoke('tools/call', { name: 'coagenthub_candidate_reset', arguments: { profileId, reviewer: 'L3', reason: '已核实额度恢复' } }, 7);
  assert.equal(calls[2].url, 'http://127.0.0.1:3101/api/pools/' + encodeURIComponent(profileId) + '/circuit/reset');
  assert.equal(calls[2].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), { reason: '[L3] 已核实额度恢复' });
  assert.ok(!Object.keys(calls[2].init?.headers ?? {}).some((key) => key.startsWith('x-coagent-reviewer')));
  const noReason = await invoke('tools/call', { name: 'coagenthub_candidate_reset', arguments: { profileId, reviewer: 'L3' } }, 8);
  assert.equal(noReason?.result.isError, true); assert.equal(calls.length, 3);
  assert.throws(() => createReviewerMcpHandler('http://example.invalid'), /LOOPBACK/);
});

test('合 master 简报只读真实 Git，缺当前 HEAD 全量证据或仍有尝试时不能就绪', async () => {
  const { root, git } = repository();
  try {
    writeFileSync(join(root, 'a.txt'), 'new'); git('add', 'a.txt'); git('commit', '-m', 'feat: example');
    const head = git('rev-parse', 'HEAD'); const master = git('rev-parse', 'master');
    const workspace = new GitWorktreeManager();
    const built = await buildPersistentPlatform(join(root, 'state.json'), { workspace, reconcile: false });
    await built.platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT });
    await built.platform.recordWorkspace('M', { projectRoot: root, branch: 'mission/M', baseRevision: master });
    await built.platform.startCoordinatorAttempt('M');
    const brief = await built.platform.getMasterMergeBrief('P');
    assert.equal(brief.integrationHead, head); assert.equal(brief.masterHead, master);
    assert.equal(brief.commits[0].title, 'feat: example'); assert.deepEqual(brief.changedFiles, ['a.txt']);
    assert.equal(brief.ready, false); assert.equal(brief.requiresUserSignature, true);
    assert.deepEqual(brief.activeMissions, ['M']); assert.equal(brief.verification.verified, false);
    assert.equal(git('rev-parse', 'master'), master, '简报不合并 master');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('项目值守互斥、心跳、交接代次与五分钟到期；旧守候不能继续操作', async () => {
  const clock = new FixedClock();
  const projects = new InMemoryProjectRepository();
  const ids = new SequentialIds();
  const activity = new InMemoryActivityLog(clock);
  const platform = new Platform({ projects, activity, clock, ids, deliveries: new InMemoryDeliveryRepository(clock, ids) });
  await platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT });
  const claims = await Promise.allSettled([platform.changeReviewerDuty('P', { action: 'claim', owner: 'A' }),
    platform.changeReviewerDuty('P', { action: 'claim', owner: 'B' })]);
  assert.equal(claims[0].status, 'fulfilled'); assert.equal(claims[1].status, 'rejected');
  const first = (claims[0] as PromiseFulfilledResult<Awaited<ReturnType<Platform['changeReviewerDuty']>>>).value;
  assert.equal(first.generation, 1);
  await assert.rejects(platform.changeReviewerDuty('P', { action: 'claim', owner: 'B' }), { code: 'REVIEWER_DUTY_BUSY' });
  clock.advance(60000);
  const renewed = await platform.changeReviewerDuty('P', { action: 'renew', owner: 'A', generation: 1 });
  assert.ok(renewed.expiresAt > first.expiresAt);
  let finishControl!: () => void;
  let controlStarted!: () => void;
  const started = new Promise<void>((resolve) => { controlStarted = resolve; });
  const control = platform.withReviewerControl('P', { owner: 'A', generation: 1 }, async () => {
    controlStarted(); await new Promise<void>((resolve) => { finishControl = resolve; });
    await platform.requireReviewerDuty('P', 'A', 1);
  });
  await started;
  let handoffDone = false;
  const handoff = platform.changeReviewerDuty('P', { action: 'handoff', owner: 'A', generation: 1, nextOwner: 'B' })
    .then((value) => { handoffDone = true; return value; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(handoffDone, false, '已核对的写入与交接必须串行');
  finishControl(); await control;
  const handed = await handoff;
  assert.equal(handed.generation, 2);
  await assert.rejects(platform.requireReviewerDuty('P', 'A', 1), { code: 'REVIEWER_DUTY_STALE' });
  clock.advance(5 * 60000);
  assert.equal((await platform.getReviewerDuty('P'))?.active, false);
  const reclaimed = await platform.changeReviewerDuty('P', { action: 'claim', owner: 'C' });
  assert.equal(reclaimed.generation, 3);
  const restarted = new Platform({ projects, activity, clock, ids, deliveries: new InMemoryDeliveryRepository(clock, ids) });
  assert.equal((await restarted.getReviewerDuty('P'))?.owner, 'C');
  await restarted.changeReviewerDuty('P', { action: 'release', owner: 'C', generation: 3 });
  await assert.rejects(restarted.requireReviewerDuty('P', 'C', 3), { code: 'REVIEWER_DUTY_STALE' });
});
