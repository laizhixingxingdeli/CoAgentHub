import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { buildPersistentPlatform } from '../src/main.ts';
import { GitWorktreeManager } from '../src/application/workspace.ts';
import { commitDocument, documentHash } from '../src/application/document-files.ts';
import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

const contract = { intent: '文档队列验证', acceptance: ['差异批准'], constraints: [], nonGoals: [], guardrails: [] };
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-doc-queue-test-')); const root = join(dir, 'repo'); mkdirSync(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'master'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  mkdirSync(join(root, '.coagent/specs'), { recursive: true });
  writeFileSync(join(root, '.coagent/project.md'), '# Test\n');
  writeFileSync(join(root, '.coagent/specs/demo.md'), '# Demo\n\n旧规则\n保留条款\n');
  git('add', '.coagent'); git('commit', '-m', 'base'); git('checkout', '-b', 'codex/doc-test');
  const state = join(dir, 'state.json'); const workspace = new GitWorktreeManager(join(dir, 'worktrees'));
  const built = await buildPersistentPlatform(state, { workspace, reconcile: false });
  await built.platform.createMission({ projectId: 'P', missionId: 'M', contract });
  await built.platform.recordWorkspace('M', { projectRoot: root, branch: '(in-place)', baseRevision: git('rev-parse', 'HEAD') });
  const attempt = await built.platform.startCoordinatorAttempt('M');
  await built.platform.submitMissionResult('M', attempt.attemptId, { outcome: 'delivered', summary: '测试交卷', acceptanceEvidence: [],
    memoryDelta: [{ kind: 'living_spec', slug: 'demo', title: 'Demo', changes: [{ before: '旧规则', after: '新规则' }] }], openRisks: [] });
  await built.platform.finishAttempt('M', attempt.attemptId, { endedBy: 'structured_submit' });
  return { dir, root, git, state, workspace, built };
}
const signature = (row: { revision: number; baseHash: string }) => ({ reviewer: 'test-reviewer', reason: '已核对差异及保留条款', revision: row.revision, baseHash: row.baseHash });

test('文档排队持久、版本审批、编辑撤回、空档提交；HTTP 只读不 ACK，观察者不可批准', async () => {
  const f = await fixture(); let server;
  try {
    const p = f.built.platform; const before = f.git('rev-parse', 'HEAD');
    const snapshot = readFileSync(f.state);
    const output = execFileSync(process.execPath, [fileURLToPath(new URL('../src/l3.ts', import.meta.url)), 'show', 'M', '--state', f.state], { encoding: 'utf8', windowsHide: true });
    assert.match(output, /before/); assert.match(output, /旧规则/); assert.match(output, /新规则/);
    assert.deepEqual(readFileSync(f.state), snapshot, '新差异 CLI 读面不写状态');
    const row = (await p.listDocumentProposals('P'))[0];
    const approved = await p.decideDocument(row.id, { ...signature(row), action: 'approve' });
    assert.equal(approved.state, 'approved'); assert.equal(approved.queue?.errors[0].reason, 'DOCUMENT_MISSION_ACTIVE');
    assert.equal(f.git('rev-parse', 'HEAD'), before);
    const edited = await p.decideDocument(row.id, { ...signature(row), action: 'edit', changes: [{ before: '旧规则', after: '修订规则' }] });
    assert.equal(edited.state, 'proposed'); assert.equal(edited.revision, 2);
    await assert.rejects(p.decideDocument(row.id, { ...signature(row), action: 'approve' }), { code: 'DOCUMENT_REVIEW_STALE' });
    const withdrawn = await p.proposeDocument({ missionId: 'M', path: 'AGENTS.md', title: '规则建议', changes: [{ before: '', after: '# Rules\n' }], reviewer: 'test-reviewer', reason: '测试规则入口' });
    await p.decideDocument(withdrawn.id, { ...signature(withdrawn), action: 'withdraw' });
    const rebuilt = await buildPersistentPlatform(f.state, { workspace: f.workspace, reconcile: false });
    assert.equal((await rebuilt.platform.listDocumentProposals('P')).find((entry) => entry.id === row.id)?.revision, 2);
    server = createApi({ platform: rebuilt.platform, tokens: new RunTokenRegistry(), deliveries: rebuilt.deliveries,
      resolveControlPrincipal: (req) => ({ id: 'test', role: req.headers['x-test-role'] === 'operator' ? 'operator' : 'viewer' }) });
    await listenLoopback(server, 0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const deliveries = await rebuilt.deliveries.pending();
    assert.equal((await fetch(`${base}/api/projects/P/documents`)).status, 200);
    assert.deepEqual(await rebuilt.deliveries.pending(), deliveries);
    const body = JSON.stringify({ ...signature(edited), action: 'approve' });
    assert.equal((await fetch(`${base}/api/documents/${encodeURIComponent(row.id)}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 403);
    assert.equal((await fetch(`${base}/api/documents/${encodeURIComponent(row.id)}/decide`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-role': 'operator' }, body })).status, 200);
    await rebuilt.platform.finalizeMission('M', { verdict: 'merge', reasons: ['测试代码验收完成'] });
    assert.equal((await rebuilt.platform.listDocumentProposals('P')).find((entry) => entry.id === row.id)?.state, 'committed');
    assert.match(readFileSync(join(f.root, '.coagent/specs/demo.md'), 'utf8'), /修订规则\r?\n保留条款/);
    assert.match(f.git('show', 'HEAD:VIBE.md'), /demo/);
    assert.equal(f.git('rev-parse', 'master'), before);
    assert.equal(f.git('status', '--porcelain'), '');
    const count = f.git('rev-list', '--count', 'HEAD'); await rebuilt.platform.flushDocumentQueue();
    assert.equal(f.git('rev-list', '--count', 'HEAD'), count);
  } finally { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); rmSync(f.dir, { recursive: true, force: true }); }
});

test('文档漂移不覆盖，批准提交后的崩溃可重入；脏工作区及 master 保留批准队列', async () => {
  const f = await fixture();
  try {
    const p = f.built.platform;
    await p.finalizeMission('M', { verdict: 'merge', reasons: ['测试完成'] });
    assert.throws(() => f.built.store.archiveMission('P', 'M'), /文档提议/);
    await assert.rejects(p.proposeDocument({ missionId: 'M', path: '../outside.md', title: '非法路径', changes: [{ before: '', after: 'x' }],
      reviewer: 'test-reviewer', reason: '测试路径保护' }), /DOCUMENT_PATH_FORBIDDEN/);
    const first = (await p.listDocumentProposals())[0];
    writeFileSync(join(f.root, '.coagent/specs/demo.md'), '# Demo\n第三方条款\n'); f.git('add', '.coagent'); f.git('commit', '-m', 'docs: external change');
    await assert.rejects(p.decideDocument(first.id, { ...signature(first), action: 'approve' }), { code: 'DOCUMENT_BASE_CHANGED' });
    const edited = await p.decideDocument(first.id, { ...signature(first), action: 'edit', changes: [{ before: '第三方条款', after: '第三方条款\n已审核补充' }] });
    writeFileSync(join(f.root, 'dirty.txt'), 'unrelated');
    const approved = await p.decideDocument(first.id, { ...signature(edited), action: 'approve' });
    assert.equal(approved.state, 'approved'); assert.equal(approved.queue?.errors[0].reason, 'DOCUMENT_WORKSPACE_DIRTY');
    assert.equal(documentHash(readFileSync(join(f.root, '.coagent/specs/demo.md'), 'utf8')), edited.baseHash);
    rmSync(join(f.root, 'dirty.txt')); f.git('checkout', 'master');
    assert.equal((await p.flushDocumentQueue()).errors[0].reason, 'DOCUMENT_TARGET_NOT_INTEGRATION');
    f.git('checkout', 'codex/doc-test');
    const commit = await commitDocument({ root: f.root, path: edited.path, before: edited.base, after: edited.proposed,
      marker: `CoAgentHub-Document-Proposal: ${edited.id}@${edited.revision}`, projectId: 'P' });
    // Git 已提交、批准队列尚未确认：模拟进程在两者之间停止。
    const rebuilt = await buildPersistentPlatform(f.state, { workspace: f.workspace, reconcile: false });
    await rebuilt.platform.flushDocumentQueue();
    assert.equal(f.git('rev-parse', 'HEAD'), commit);
    assert.equal((await rebuilt.platform.listDocumentProposals())[0].commit, commit);
    assert.match(readFileSync(join(f.root, edited.path), 'utf8'), /第三方条款\r?\n已审核补充/);
    assert.equal(f.git('status', '--porcelain'), '');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
