import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitWorktreeManager, InPlaceWorkspaceManager } from '../src/application/workspace.ts';

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'workspace-checkpoint-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(cwd, 'base'), 'base');
  git('add', 'base'); git('commit', '-qm', 'initial');
  return cwd;
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('syncMissionWithTarget incorporates target commits and leaves conflicts intact', async () => {
  const root = repo();
  const manager = new GitWorktreeManager();
  const prepared = await manager.prepare('sync-test', root);
  const noChange = await manager.syncMissionWithTarget!({ missionId: 'sync-test', projectRoot: root, targetBranch: 'master' });
  assert.equal(noChange.targetHead, git(root, 'rev-parse', 'HEAD'));
  assert.deepEqual(noChange.conflictFiles, []);
  writeFileSync(join(root, 'target'), 'target');
  git(root, 'add', 'target'); git(root, 'commit', '-qm', 'target update');
  const targetHead = git(root, 'rev-parse', 'HEAD');
  const synced = await manager.syncMissionWithTarget!({ missionId: 'sync-test', projectRoot: root, targetBranch: 'master' });
  assert.equal(synced.targetHead, targetHead);
  assert.deepEqual(synced.conflictFiles, []);
  assert.equal(git(prepared.cwd, 'show', 'HEAD:target'), 'target');
  writeFileSync(join(prepared.cwd, 'base'), 'mission');
  git(prepared.cwd, 'add', 'base'); git(prepared.cwd, 'commit', '-qm', 'mission');
  writeFileSync(join(root, 'base'), 'target conflict');
  git(root, 'add', 'base'); git(root, 'commit', '-qm', 'conflict');
  const conflict = await manager.syncMissionWithTarget!({ missionId: 'sync-test', projectRoot: root, targetBranch: 'master' });
  assert.deepEqual(conflict.conflictFiles, ['base']);
  assert.equal(git(prepared.cwd, 'branch', '--show-current'), 'mission/sync-test');
});

test('checkpoint commits only authorized paths, including new/deleted files, and no-ops when clean', async () => {
  const cwd = repo();
  const manager = new GitWorktreeManager();
  mkdirSync(join(cwd, 'nested'));
  writeFileSync(join(cwd, 'nested', 'new'), 'new');
  writeFileSync(join(cwd, 'base'), 'changed');
  await manager.checkpoint!(cwd, 'm1', 'w1', ['base', 'nested/new']);
  assert.match(git(cwd, 'log', '-1', '--format=%s'), /^mission\(m1\): w1 检查点$/);
  assert.equal(git(cwd, 'show', 'HEAD:nested/new'), 'new');
  const head = git(cwd, 'rev-parse', 'HEAD');
  await manager.checkpoint!(cwd, 'm1', 'w1', ['base']);
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), head);
  writeFileSync(join(cwd, 'base'), '');
  git(cwd, 'rm', '-q', '-f', 'base');
  await manager.checkpoint!(cwd, 'm1', 'w2', ['base']);
  assert.throws(() => git(cwd, 'show', 'HEAD:base'));
});

test('checkpoint rejects outside changes and ambiguous authorization without deleting files', async () => {
  const cwd = repo();
  writeFileSync(join(cwd, 'outside'), 'keep');
  await assert.rejects(new GitWorktreeManager().checkpoint!(cwd, 'm', 'w', ['base']), /未授权/);
  assert.equal(readFileSync(join(cwd, 'outside'), 'utf8'), 'keep');
  await assert.rejects(new GitWorktreeManager().checkpoint!(cwd, 'm', 'w', ['src/*']), /不确定/);
  assert.equal(git(cwd, 'status', '--porcelain').includes('outside'), true);
});

test('in-place manager does not expose a fake checkpoint', () => {
  assert.equal(new InPlaceWorkspaceManager().checkpoint, undefined);
});
