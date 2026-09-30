import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflightPlanMissionSlots } from '../src/application/plan-preflight.ts';
import { PlanRun } from '../src/application/plan-run.ts';
import type { PlanCandidateSelection } from '../src/application/plan-spec.ts';

const selection = { candidates: [{ id: 'F1' }], exclusions: [], warnings: [] } as unknown as PlanCandidateSelection;
const mission = { missionId: 'M1', projectId: 'P', status: 'executing', isMutating: true, paused: true };
const plan = { planId: 'PLAN', projectId: 'P' };

describe('preflightPlanMissionSlots', () => {
  test('无占位不读取坏历史，也不阻断', () => {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
    try {
      writeFileSync(join(dir, 'broken.json'), '{');
      assert.deepEqual(preflightPlanMissionSlots({ selection, plan, runDir: dir, missions: [] }), { problems: [], resume: [] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('有占位且历史损坏时 fail closed 并提示人工处理', () => {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
    try {
      writeFileSync(join(dir, 'broken.json'), '{');
      const result = preflightPlanMissionSlots({ selection, plan, runDir: dir, missions: [mission] });
      assert.deepEqual(result.resume, []);
      assert.equal(result.problems.length, 1);
      assert.match(result.problems[0]!, /Mission M1/);
      assert.match(result.problems[0]!, /show .*merge 或 abandon/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('异方案与非入选 feature 的真实历史映射均阻断占位', () => {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
    try {
      const run = PlanRun.start({
        id: 'run', planId: 'OTHER', projectId: 'P', integrationBranch: 'main', reviewer: 'reviewer',
        stopConditions: { unresolvedEscalations: 2, wallClockMs: 60_000, escalationTimeoutMs: 10_000 },
        featureIds: ['F1'], startedAt: '2026-09-30T00:00:00.000Z',
      });
      run.startFeature('F1', 'M1');
      run.halt('reviewer_stop', 'stopped', '2026-09-30T00:01:00.000Z');
      writeFileSync(join(dir, 'run.json'), `${JSON.stringify(run.toSnapshot())}\n`);

      for (const input of [
        { plan, selection },
        { plan: { planId: 'OTHER', projectId: 'P' }, selection: { ...selection, candidates: [{ id: 'F2' }] } as PlanCandidateSelection },
      ]) {
        const result = preflightPlanMissionSlots({ ...input, runDir: dir, missions: [mission] });
        assert.deepEqual(result.resume, []);
        assert.equal(result.problems.length, 1);
        assert.match(result.problems[0]!, /Mission M1/);
        assert.match(result.problems[0]!, /show M1/);
        assert.match(result.problems[0]!, /merge 或 abandon/);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('缺少历史映射时阻断占位', () => {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
    try {
      const result = preflightPlanMissionSlots({ selection, plan, runDir: dir, missions: [mission] });
      assert.deepEqual(result.resume, []);
      assert.match(result.problems[0]!, /Mission M1/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
