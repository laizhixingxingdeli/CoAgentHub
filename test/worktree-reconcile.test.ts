/**
 * OPS-001：孤儿 Mission worktree 启动收敛。
 *
 * 只摘安全候选（已合入目标、干净、无保护），不删分支、不用 --force。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryProjectRepository } from '../src/application/in-memory.ts';
import { reconcileOrphanedWorktrees } from '../src/application/reconcile.ts';
import {
  GitWorktreeManager,
  InPlaceWorkspaceManager,
} from '../src/application/workspace.ts';
import { buildPersistentPlatform } from '../src/main.ts';
import type { MissionContract } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function tempRepo(prefix = 'coagent-wtr-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@local');
  // 部分 git 默认 branch 名不同；钉死方便断言。
  git(dir, 'checkout', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function branchExists(repo: string, name: string): boolean {
  try {
    git(repo, 'show-ref', '--verify', `refs/heads/${name}`);
    return true;
  } catch {
    return false;
  }
}

describe('GitWorktreeManager.reconcile', () => {
  test('受保护且干净、HEAD 已在目标历史中 → kept protected，目录仍在', async () => {
    const repo = tempRepo();
    const wtRoot = mkdtempSync(join(tmpdir(), 'coagent-wtroot-'));
    dirs.push(wtRoot);
    const manager = new GitWorktreeManager(wtRoot);
    const prepared = await manager.prepare('active-1', repo);
    assert.ok(existsSync(prepared.cwd));

    const result = await manager.reconcile(repo, new Set(['active-1']));
    assert.ok(result.kept.some((k) => k.missionId === 'active-1' && k.reason === 'protected'));
    assert.equal(result.removed.length, 0);
    assert.ok(existsSync(prepared.cwd));
    assert.ok(branchExists(repo, 'mission/active-1'));
  });

  test('未知、已合入、干净 → removed，分支仍在', async () => {
    const repo = tempRepo();
    const wtRoot = mkdtempSync(join(tmpdir(), 'coagent-wtroot-'));
    dirs.push(wtRoot);
    const manager = new GitWorktreeManager(wtRoot);
    const prepared = await manager.prepare('orphan-merged', repo);
    // HEAD 与 target 同提交 → merge-base --is-ancestor 为真。
    const result = await manager.reconcile(repo, new Set());
    assert.ok(
      result.removed.some((r) => r.missionId === 'orphan-merged'),
      `expected removed, got ${JSON.stringify(result)}`,
    );
    assert.ok(!existsSync(prepared.cwd));
    assert.ok(branchExists(repo, 'mission/orphan-merged'), '不得删分支');
  });

  test('未合入的独有提交 → kept not_merged', async () => {
    const repo = tempRepo();
    const wtRoot = mkdtempSync(join(tmpdir(), 'coagent-wtroot-'));
    dirs.push(wtRoot);
    const manager = new GitWorktreeManager(wtRoot);
    const prepared = await manager.prepare('ahead', repo);
    writeFileSync(join(prepared.cwd, 'extra.txt'), 'only on mission\n');
    git(prepared.cwd, 'add', '-A');
    git(prepared.cwd, 'commit', '-q', '-m', 'mission only');

    const result = await manager.reconcile(repo, new Set());
    assert.ok(
      result.kept.some((k) => k.missionId === 'ahead' && k.reason === 'not_merged'),
      JSON.stringify(result),
    );
    assert.ok(existsSync(prepared.cwd));
  });

  test('脏工作区 → kept dirty，不提交、不强制删除', async () => {
    const repo = tempRepo();
    const wtRoot = mkdtempSync(join(tmpdir(), 'coagent-wtroot-'));
    dirs.push(wtRoot);
    const manager = new GitWorktreeManager(wtRoot);
    const prepared = await manager.prepare('dirty', repo);
    writeFileSync(join(prepared.cwd, 'wip.txt'), 'uncommitted\n');

    const result = await manager.reconcile(repo, new Set());
    assert.ok(result.kept.some((k) => k.missionId === 'dirty' && k.reason === 'dirty'));
    assert.ok(existsSync(prepared.cwd));
    assert.ok(existsSync(join(prepared.cwd, 'wip.txt')), '不得把脏状态清掉或提交');
    const status = git(prepared.cwd, 'status', '--porcelain');
    assert.ok(status.includes('wip.txt'));
  });

  test('目录名与分支 missionId 不一致 → kept uncertain，不删', async () => {
    const repo = tempRepo();
    const wtRoot = mkdtempSync(join(tmpdir(), 'coagent-wtroot-'));
    dirs.push(wtRoot);
    // 路径挂 M-active，分支却是 mission/M-other。
    const mismatchPath = join(wtRoot, 'M-active');
    git(repo, 'worktree', 'add', '-b', 'mission/M-other', mismatchPath);

    const manager = new GitWorktreeManager(wtRoot);
    const result = await manager.reconcile(repo, new Set(['M-active']));
    assert.equal(result.removed.length, 0);
    assert.ok(existsSync(mismatchPath), '目录必须仍在');
    assert.ok(
      result.kept.some((k) => k.missionId === 'M-other' && k.reason === 'uncertain'),
      JSON.stringify(result),
    );
    assert.ok(branchExists(repo, 'mission/M-other'), '分支仍在');
  });

  test('非 mission 分支、根外路径不删', async () => {
    const repo = tempRepo();
    const wtRoot = mkdtempSync(join(tmpdir(), 'coagent-wtroot-'));
    dirs.push(wtRoot);
    const outside = mkdtempSync(join(tmpdir(), 'coagent-outside-'));
    dirs.push(outside);

    // 非 mission 分支，但仍在 wtRoot 下。
    const otherPath = join(wtRoot, 'feature-x');
    git(repo, 'worktree', 'add', '-b', 'feature/other', otherPath);

    // 根外 mission 形态路径。
    const outsidePath = join(outside, 'outsider');
    git(repo, 'worktree', 'add', '-b', 'mission/outsider', outsidePath);

    const manager = new GitWorktreeManager(wtRoot);
    const result = await manager.reconcile(repo, new Set());
    assert.equal(result.removed.length, 0);
    assert.ok(existsSync(otherPath));
    assert.ok(existsSync(outsidePath));
    assert.ok(branchExists(repo, 'feature/other'));
    assert.ok(branchExists(repo, 'mission/outsider'));
  });
});

describe('reconcileOrphanedWorktrees', () => {
  test('非终态保护；completed / blocked 不保护', async () => {
    const repo = tempRepo();
    const wtRoot = mkdtempSync(join(tmpdir(), 'coagent-wtroot-'));
    dirs.push(wtRoot);
    const manager = new GitWorktreeManager(wtRoot);

    const active = await manager.prepare('M-active', repo);
    const done = await manager.prepare('M-done', repo);
    const blocked = await manager.prepare('M-blocked', repo);

    const projects = new InMemoryProjectRepository();
    const project = await projects.ensure('P1');

    const mActive = project.createMission({ id: 'M-active', contract: CONTRACT });
    mActive.recordWorkspace({
      projectRoot: repo,
      branch: 'mission/M-active',
      baseRevision: active.baseRevision,
    });

    const mDone = project.createMission({ id: 'M-done', contract: CONTRACT });
    mDone.recordWorkspace({
      projectRoot: repo,
      branch: 'mission/M-done',
      baseRevision: done.baseRevision,
    });
    mDone.submitForReview();
    mDone.complete();

    const mBlocked = project.createMission({ id: 'M-blocked', contract: CONTRACT });
    mBlocked.recordWorkspace({
      projectRoot: repo,
      branch: 'mission/M-blocked',
      baseRevision: blocked.baseRevision,
    });
    mBlocked.block();

    const result = await reconcileOrphanedWorktrees(await projects.list(), manager);
    assert.ok(existsSync(active.cwd), '非终态须保留');
    assert.ok(!existsSync(done.cwd), 'completed 且已合入应摘掉');
    assert.ok(!existsSync(blocked.cwd), 'blocked 且已合入应摘掉');
    assert.ok(result.kept.some((k) => k.missionId === 'M-active' && k.reason === 'protected'));
    assert.ok(branchExists(repo, 'mission/M-done'));
    assert.ok(branchExists(repo, 'mission/M-blocked'));
  });

  test('InPlace 无 reconcile 时静默空结果', async () => {
    const projects = new InMemoryProjectRepository();
    const project = await projects.ensure('P');
    const m = project.createMission({ id: 'M1', contract: CONTRACT });
    m.recordWorkspace({ projectRoot: '/tmp/x', branch: 'mission/M1', baseRevision: '0' });
    const result = await reconcileOrphanedWorktrees(
      await projects.list(),
      new InPlaceWorkspaceManager(),
    );
    assert.deepEqual(result.removed, []);
    assert.equal(result.roots, 0);
  });
});

describe('buildPersistentPlatform worktree reconcile 入口', () => {
  test('exclusive 写路径会跑孤儿收敛；只读路径不跑', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'coagent-state-'));
    dirs.push(stateDir);
    const statePath = join(stateDir, 'state.json');
    const repo = tempRepo();
    const wtRoot = mkdtempSync(join(tmpdir(), 'coagent-wtroot-'));
    dirs.push(wtRoot);
    const manager = new GitWorktreeManager(wtRoot);
    const prepared = await manager.prepare('orphan-boot', repo);

    // 状态里记一条终态 Mission，指向该根——exclusive 启动应摘掉。
    {
      const writer = await buildPersistentPlatform(statePath, {
        workspace: manager,
        exclusive: { what: 'seed' },
      });
      try {
        const { missionId } = await writer.platform.createMission({
          projectId: 'P',
          missionId: 'orphan-boot',
          contract: CONTRACT,
        });
        const listed = await writer.platform.listMissions();
        assert.equal(listed[0].missionId, missionId);
        // 直接在文件存储背后的领域对象上写 workspace + 终态。
        const projects = await writer.projects.list();
        const mission = projects[0].missions[0];
        mission.recordWorkspace({
          projectRoot: repo,
          branch: 'mission/orphan-boot',
          baseRevision: prepared.baseRevision,
        });
        mission.submitForReview();
        mission.complete();
        writer.persist();
      } finally {
        writer.releaseLock();
      }
    }

    assert.ok(existsSync(prepared.cwd), '写入状态后目录仍在');

    const exclusive = await buildPersistentPlatform(statePath, {
      workspace: manager,
      exclusive: { what: 'runner' },
    });
    try {
      assert.ok(exclusive.workspaceReconciled);
      assert.ok(
        exclusive.workspaceReconciled!.removed.some((r) => r.missionId === 'orphan-boot') ||
          !existsSync(prepared.cwd),
        JSON.stringify(exclusive.workspaceReconciled),
      );
      assert.ok(!existsSync(prepared.cwd));
    } finally {
      exclusive.releaseLock();
    }

    // 再造一个孤儿，只读启动不得摘。
    const again = await manager.prepare('orphan-ro', repo);
    const ro = await buildPersistentPlatform(statePath, { workspace: manager });
    assert.equal(ro.workspaceReconciled, undefined);
    assert.ok(existsSync(again.cwd), '只读路径不得全局清 worktree');
  });
});
