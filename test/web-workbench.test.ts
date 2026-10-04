import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newestMissions, missionTableHtml, overviewHtml } from '../src/web/overview.js';
import { candidateConfig, moveCandidate, priorityHtml } from '../src/web/model-priority.js';
import { usageFieldsHtml, skeletonHtml, stageDetailHtml, groupActivity } from '../src/web/task.js';
import { buildPlatform } from '../src/main.ts';
import { createApi } from '../src/api/server.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import type { AddressInfo } from 'node:net';

test('统一任务列表最新活动在上、所有任务可进入、输入转义且不改入参数组', () => {
  const rows = [{ missionId: 'old', status: 'completed', updatedAt: '2026-01-01' },
    { missionId: 'new', status: 'executing', intent: '<img>', updatedAt: '2026-10-04' }];
  assert.equal(newestMissions(rows)[0].missionId, 'new');
  assert.equal(rows[0].missionId, 'old');
  const html = missionTableHtml(rows);
  assert.ok(html.indexOf('#/missions/new') < html.indexOf('#/missions/old'));
  assert.ok(html.includes('&lt;img&gt;'));
  assert.ok(!html.includes('<img>'));
  assert.ok(!html.includes('最近完成'));
});

test('首页服务和模型数据缺失显示未知，暂停任务不计入进行中', () => {
  const html = overviewHtml({ missions: [{ missionId: 'paused', status: 'executing', paused: true }], status: null, pools: null, errors: [] });
  assert.ok(html.includes('未读取'));
  assert.ok(html.includes('未知'));
  assert.ok(!html.includes('#/missions/paused'));
});

test('任务输出常驻独立区域，缺失用量不计作零，真实零值保留', () => {
  const html = skeletonHtml();
  assert.ok(!/data-task-panel="events"/.test(html));
  assert.equal((html.match(/id="task-live"/g) || []).length, 1);
  assert.equal((html.match(/id="task-stages"/g) || []).length, 1);
  const usage = usageFieldsHtml({ input: 0, output: 12 });
  assert.ok(usage.includes('未知'));
  assert.ok(usage.includes('>0</dd>'));
  assert.ok(usage.includes('>12</dd>'));
  const unknown = usageFieldsHtml({ quality: 'unknown', input: 0, output: 0, total: 0, cost: 0 });
  assert.ok(!unknown.includes('>0</dd>'));
  assert.equal((unknown.match(/未知/g) || []).length, 6);
  const group = groupActivity([{ kind: 'attempt.started', attemptId: 'W-1.exec-1', workItemId: 'W-1' }])[0];
  const history = stageDetailHtml(group, { workItems: [{ id: 'W-1', attemptIds: ['W-1.exec-1', 'W-1.exec-2'], executionResult: { summary: '最新尝试独有正文' } }] }, { attemptId: 'W-1.exec-1', evidence: [], output: '历史输出' });
  assert.ok(!history.includes('最新尝试独有正文'));
  assert.ok(history.includes('本次历史交回正文未保留'));
  assert.ok(history.includes('历史输出'));

});

test('模型顺序保存真实 HTTP CAS，保留配置事实与停用，旧版本不覆盖', async () => {
  const built = buildPlatform();
  await built.agentPool.add({ role: 'executor', profileId: 'a', endpoint: 'local', facts: [{ key: 'reasoning', value: 'high' }] });
  await built.agentPool.add({ role: 'executor', profileId: 'b', endpoint: 'local', enabled: false });
  const server = createApi(built);
  await listenLoopback(server, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const initial = await (await fetch(base + '/api/pools/config')).json();
    const initialized = await fetch(base + '/api/pools/executor/configure', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: initial.revision, candidates: initial.executor.map((row: { profileId: string }) => ({ ...candidateConfig(row), enabled: row.profileId !== 'b' })) }) });
    assert.equal(initialized.status, 200);
    const snapshot = await initialized.json();
    const original = snapshot.executor.map(candidateConfig);
    const draft = moveCandidate(original, 1, -1);
    assert.deepEqual(original.map(row => row.profileId), ['a', 'b']);
    assert.deepEqual(draft.map(row => row.profileId), ['b', 'a']);
    const save = () => fetch(base + '/api/pools/executor/configure', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: snapshot.revision, candidates: draft }) });
    assert.equal((await save()).status, 200);
    assert.equal((await save()).status, 409);
    const stored = await (await fetch(base + '/api/pools/config')).json();
    assert.equal(stored.executor[0].enabled, false);
    assert.deepEqual(stored.executor[1].facts, original[0].facts);
    const view = priorityHtml({ role: 'executor', saved: { executor: original }, drafts: { executor: draft }, message: '配置版本冲突', conflict: true });
    assert.ok(view.includes('有未保存修改'));
    assert.match(view, /data-priority-save disabled/);
    assert.ok(view.includes('读取最新配置'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
