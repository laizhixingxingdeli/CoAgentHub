import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPlanOnPlatform } from '../src/application/plan-runtime.ts';
import { PlanRun } from '../src/application/plan-run.ts';
import type { PlanRuntimeStore } from '../src/application/plan-runtime.ts';
import type { PlanSpec, PlanCandidateSelection } from '../src/application/plan-spec.ts';

test('runPlanOnPlatform resumes the authenticated prior Mission and persists it without creating one', async () => {
  const plan = {
    planId: 'P-resume', projectId: 'project', integrationBranch: 'main', reviewer: 'reviewer',
    stopConditions: { unresolvedEscalations: 1, wallClockMs: 60_000, escalationTimeoutMs: 1_000 },
    features: [],
  } as PlanSpec;
  const feature = { id: 'F1', title: 'resume', why: 'continue', allowedScope: ['a.ts'], acceptance: ['done'] };
  (plan as { features: typeof feature[] }).features = [feature];
  const selection = { candidates: [feature], exclusions: [], warnings: [] } as PlanCandidateSelection;
  let run: PlanRun | undefined;
  const store: PlanRuntimeStore = {
    async create(value) { run = value; },
    read() { return run; },
    async update(mutate) { return mutate(run!); },
  };
  const events: string[] = [];
  const logs: string[] = [];
  const platform = {
    async resumeMission(id: string) { events.push(`resume:${id}`); },
    async createMission() { events.push('create'); throw new Error('must not create'); },
    async createClassifiedMission() { events.push('create-classified'); throw new Error('must not create'); },
    async getMissionView() { return { status: 'blocked' }; },
    async effectiveIndependentReviewPass() { return undefined; },
    async finalizeMissionByHaAuthority() { throw new Error('unexpected'); },
    async finalizeMissionByMachine() { throw new Error('unexpected'); },
    async abandonMissionForPlan() { throw new Error('unexpected'); },
    async answerEscalation() { throw new Error('unexpected'); },
  };
  await runPlanOnPlatform(plan, selection, {
    store, projectRoot: '.', platform: platform as never,
    resumeMissions: { F1: 'old-mission-id' },
    runMission: async () => ({ outcome: { kind: 'blocked', reason: 'test-stop' } } as never),
    persist: async () => { events.push('persist'); },
    pauseInFlight: async () => {}, now: () => new Date().toISOString(), sleep: async () => {},
    log: (line) => logs.push(line), runId: 'R-resume',
  });
  assert.deepEqual(events.slice(0, 2), ['resume:old-mission-id', 'persist']);
  assert.equal(events.some((event) => event.startsWith('create')), false);
  assert.ok(logs.some((line) => line.includes('恢复自上一次方案运行')));
  assert.deepEqual(run?.features[0]?.missionIds, ['old-mission-id']);
});
