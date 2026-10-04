/**
 * M3-C：生产 builder 装配 validation。
 *
 * 通过实际调用 trusted validate 证明注入成功，不暴露 private deps getter。
 * buildPlatform 仅 workspace 传入时有 validation。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildPersistentPlatform, buildPlatform } from '../src/main.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';
import { PlatformRuleError } from '../src/application/platform.ts';

const CONTRACT: MissionContract = {
  intent: 'builder validation',
  acceptance: ['ok'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const ORDER: WorkOrder = {
  objective: 'touch',
  allowedScope: ['a.txt'],
  requiredBehaviour: 'ok',
  constraints: [],
  acceptance: ['ok'],
  verification: [],
  doNot: [],
  contextRefs: [],
  // empty commands：只跑 changed-paths
  validation: { commands: [] },
};

const dirs: string[] = [];
const releases: Array<() => void> = [];

after(() => {
  for (const r of releases) {
    try {
      r();
    } catch {
      /* ignore */
    }
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-builder-val-'));
  dirs.push(dir);
  git(dir, 'init');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

/**
 * 铺到「机器验收通过」为止：工作项停在 submitted，不交卷——
 * 这一段的验证目标是 builder 有没有把 validation 装配进去，不需要走 L2。
 */
async function seedLightweightAcceptedPath(
  platform: import('../src/application/platform.ts').Platform,
  projects: { ensure(id: string): Promise<import('../src/kernel/index.ts').Project>; save(p: import('../src/kernel/index.ts').Project): Promise<void> },
  missionId: string,
  projectRoot: string,
) {
  const project = await projects.ensure('P');
  project.createMission({
    id: missionId,
    contract: CONTRACT,
    executionMode: 'lightweight',
    runKind: 'mutation',
  });
  await projects.save(project);

  const { workItemId } = await platform.createLightweightWorkItem(missionId, {
    order: ORDER,
    workItemId: 'W-1',
  });
  await platform.dispatchLightweightWorkItem(missionId, workItemId);
  await platform.recordWorkspace(missionId, {
    projectRoot,
    branch: '(in-place)',
    baseRevision: git(projectRoot, 'rev-parse', 'HEAD'),
  });
  // 在 in-place 工作区改文件，changed-paths 才能过
  writeFileSync(join(projectRoot, 'a.txt'), 'changed\n');

  const { attemptId: exec } = await platform.startExecutorAttempt(missionId, workItemId);
  await platform.submitEvidence(missionId, exec, {
    kind: 'test',
    summary: 'ok',
    command: 't',
    exitCode: 0,
  });
  await platform.submitExecutionResult(missionId, exec, {
    outcome: 'completed',
    summary: 'builder-ok',
    changedFiles: ['a.txt'],
    evidenceIds: [],
    notes: '',
  });
  await platform.finishAttempt(missionId, exec, { endedBy: 'structured_submit' });
  return { workItemId };
}

describe('builder validation composition', () => {
  test('buildPlatform 无 workspace：validate fail-closed', async () => {
    const built = buildPlatform();
    const project = await built.projects.ensure('P');
    project.createMission({
      id: 'M-no-ws',
      contract: CONTRACT,
      executionMode: 'lightweight',
      runKind: 'mutation',
    });
    await built.projects.save(project);
    const { workItemId } = await built.platform.createLightweightWorkItem('M-no-ws', {
      order: ORDER,
    });
    // dispatch 需要 workspace? 不需要——但 validate 要 deps
    // dispatch 会 startExecuting；无 workspace 也可以
    await built.platform.dispatchLightweightWorkItem('M-no-ws', workItemId);
    await built.platform.recordWorkspace('M-no-ws', {
      projectRoot: process.cwd(),
      branch: '(in-place)',
      baseRevision: 'base',
    });
    const { attemptId: exec } = await built.platform.startExecutorAttempt('M-no-ws', workItemId);
    await built.platform.submitEvidence('M-no-ws', exec, {
      kind: 'test',
      summary: 'ok',
      command: 't',
      exitCode: 0,
    });
    await built.platform.submitExecutionResult('M-no-ws', exec, {
      outcome: 'completed',
      summary: 's',
      changedFiles: ['a.txt'],
      evidenceIds: [],
      notes: '',
    });
    await built.platform.finishAttempt('M-no-ws', exec, { endedBy: 'structured_submit' });

    await assert.rejects(
      () =>
        built.platform.validateAndAcceptLightweightWorkItem({
          missionId: 'M-no-ws',
          workItemId,
          cwd: process.cwd(),
        }),
      (e: unknown) => (e as PlatformRuleError).code === 'VALIDATION_DEPS_REQUIRED',
    );
  });

  test('buildPlatform 有 workspace：trusted validate 可跑通', async () => {
    const repo = tempRepo();
    const built = buildPlatform(new InPlaceWorkspaceManager());
    const { workItemId } = await seedLightweightAcceptedPath(
      built.platform,
      built.projects,
      'M-ws',
      repo,
    );
    const out = await built.platform.validateAndAcceptLightweightWorkItem({
      missionId: 'M-ws',
      workItemId,
      cwd: repo,
    });
    assert.equal(out.passed, true);
    // 机器过了不 accept：验收结论归协调者，工作项留在 submitted 等 L2 这一跳。
    assert.equal(out.status, 'submitted');
    assert.match(out.reportId, /^VR-/);
  });

  test('buildPersistentPlatform：有 validation，trusted validate 可跑通', async () => {
    const repo = tempRepo();
    const dir = mkdtempSync(join(tmpdir(), 'coagent-persist-val-'));
    dirs.push(dir);
    const statePath = join(dir, 'state.json');
    const built = await buildPersistentPlatform(statePath, {
      workspace: new InPlaceWorkspaceManager(),
      exclusive: { what: 'builder-validation-test' },
    });
    if (typeof built.releaseLock === 'function') releases.push(built.releaseLock);

    const { workItemId } = await seedLightweightAcceptedPath(
      built.platform,
      built.projects,
      'M-persist',
      repo,
    );
    const out = await built.platform.validateAndAcceptLightweightWorkItem({
      missionId: 'M-persist',
      workItemId,
      cwd: repo,
    });
    assert.equal(out.passed, true);
    assert.equal(out.status, 'submitted');
    built.persist();
  });
});
