import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPersistentPlatform } from '../src/main.ts';
import { GitWorktreeManager } from '../src/application/workspace.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function repoOn(branch: string): string {
  const dir = temp('coagent-slot-check-repo-');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@local');
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', branch);
  return dir;
}

const CONTRACT: MissionContract = { intent: '改 a.txt', acceptance: ['绿'], constraints: [], nonGoals: [], guardrails: [] };
const ORDER: WorkOrder = {
  objective: '改 a.txt', allowedScope: ['a.txt'], requiredBehaviour: 'a.txt 变成 mission',
  constraints: [], acceptance: ['内容是 mission'], verification: ['cat a.txt'], doNot: [], contextRefs: [],
};
const RUN_PLAN = fileURLToPath(new URL('../src/run-plan.ts', import.meta.url));

test('--check 发现主状态中的占位 Mission，给出处理命令且不写状态', async () => {
  const home = temp('coagent-slot-check-');
  const repo = repoOn('auto/plan-x');
  const statePath = join(home, 'state.json');
  const seeded = await buildPersistentPlatform(statePath, {
    workspace: new GitWorktreeManager(join(home, 'worktrees')),
    exclusive: { what: 'seed leftover' },
  });
  try {
    await seeded.platform.createMission({ projectId: 'p', missionId: 'R0-F2', contract: CONTRACT });
    const coord = await seeded.platform.startCoordinatorAttempt('R0-F2');
    await seeded.platform.updatePlan('R0-F2', coord.attemptId, { summary: 'p', steps: ['s'], risks: [] } as never);
    const { workItemId } = await seeded.platform.createWorkItem('R0-F2', coord.attemptId, { title: 'W', order: ORDER });
    // Standard 派发前必须先落当前修订的契约核对结论，否则 CONTRACT_CHECK_REQUIRED；
    // 这里只是造占位状态，核对结论不影响本用例要验证的 --check 行为。
    await seeded.platform.submitContractCheck('R0-F2', coord.attemptId, { verdict: 'ok', summary: '测试契约已核对' });
    await seeded.platform.dispatchWorkItems('R0-F2', coord.attemptId, [workItemId]);
    assert.equal((await seeded.platform.getMissionView('R0-F2')).isMutating, true);
    await seeded.persist();
  } finally {
    seeded.releaseLock();
  }

  const planPath = join(home, 'PLAN.json');
  writeFileSync(planPath, JSON.stringify({
    planId: 'PLAN-check', projectId: 'p', integrationBranch: 'auto/plan-x', intent: 'check',
    stopConditions: { unresolvedEscalations: 5, wallClockMs: 1, escalationTimeoutMs: 1 },
    integrationVerification: [{ argv: ['node', '--test'], timeoutMs: 1 }],
    features: [{ id: 'Ok', title: '待跑', why: 'w', allowedScope: ['a.txt'], acceptance: ['x'], status: 'pending' }],
  }));
  const before = readFileSync(statePath);
  const result = spawnSync(process.execPath, [RUN_PLAN, '--check', '--plan', planPath, '--cwd', repo, '--reviewer', 'claude', '--state', statePath], {
    encoding: 'utf8', timeout: 15_000, cwd: home, env: { ...process.env },
  });
  const out = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, out);
  assert.match(out, /R0-F2/);
  assert.match(out, /show/);
  assert.match(out, /merge/);
  assert.match(out, /abandon/);
  assert.deepEqual(readFileSync(statePath), before);
  assert.equal(existsSync(join(home, '.coagent-plans')), false);
  assert.equal(existsSync(join(home, 'plans')), false);
  assert.equal(readdirSync(home).some((name) => name.startsWith('.lock-')), false);
  assert.equal(existsSync(join(home, 'worktrees')) ? readdirSync(join(home, 'worktrees')).length : 0, 0);
});
