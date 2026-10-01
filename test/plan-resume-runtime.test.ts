import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQueuedHopWaitEligibility, runPlanOnPlatform } from '../src/application/plan-runtime.ts';
import { FilePlanRunStore } from '../src/application/plan-run-store.ts';
import type { QueuedHop } from '../src/application/durable-scheduler.ts';
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

test('生产队列探针只认本 Mission 的 retry_wait / 占位：同 missionId 端到端续跑且零升级单', async () => {
  const T0 = '2026-09-23T22:00:00.000Z';
  let clock = Date.parse(T0);
  const now = () => new Date(clock).toISOString();

  // 队列行的形状在这里不重要，探针只读 missionId / status / availableAt / leaseUntil。
  const row = (input: Partial<QueuedHop> & Pick<QueuedHop, 'missionId' | 'status'>): QueuedHop =>
    ({ id: 'H', projectId: 'project', availableAt: T0, ...input } as QueuedHop);
  const plusMs = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();
  const ask = (probe: ReturnType<typeof createQueuedHopWaitEligibility>, missionId: string, reason: string) =>
    probe({ missionId, reason: reason as never, detail: '队列 Hop 失败后退避中，不能启动 Agent' });

  // 生产装配用的就是这条探针：只有本 Mission 的持久 Hop 才算证明。
  const ownBackoff = [row({ missionId: 'R-probe-F1', status: 'retry_wait', availableAt: plusMs(T0, 2_000) })];
  assert.deepEqual(
    await ask(createQueuedHopWaitEligibility({ list: async () => ownBackoff, now }), 'R-probe-F1', 'project_busy'),
    { kind: 'own_backoff', availableAt: plusMs(T0, 2_000) },
  );

  // 别的 Mission 的退避不是本 Mission 的证明——detail 文案写得再像也不认。
  const foreign = [row({ missionId: 'R-other-F1', status: 'retry_wait', availableAt: plusMs(T0, 2_000) })];
  assert.equal(
    await ask(createQueuedHopWaitEligibility({ list: async () => foreign, now }), 'R-probe-F1', 'project_busy'),
    undefined,
  );

  // 只有 project_busy 值得探；别的 reason 探队列也证明不了本 Mission 等得到头。
  assert.equal(
    await ask(createQueuedHopWaitEligibility({ list: async () => ownBackoff, now }), 'R-probe-F1', 'no_available_agent'),
    undefined,
  );

  // 本 Mission 自己占着名额：租约未到期只能短轮询复核（缺省 5 秒）；已过期 / 退避到点都不算证明。
  const claimedFuture = [row({ missionId: 'R-probe-F1', status: 'claimed', leaseUntil: plusMs(T0, 60_000) })];
  assert.deepEqual(
    await ask(createQueuedHopWaitEligibility({ list: async () => claimedFuture, now }), 'R-probe-F1', 'project_busy'),
    { kind: 'capacity', nextPollAt: plusMs(T0, 5_000) },
  );
  const claimedExpired = [row({ missionId: 'R-probe-F1', status: 'claimed', leaseUntil: plusMs(T0, -1_000) })];
  assert.equal(
    await ask(createQueuedHopWaitEligibility({ list: async () => claimedExpired, now }), 'R-probe-F1', 'project_busy'),
    undefined,
  );
  const backoffOverdue = [row({ missionId: 'R-probe-F1', status: 'retry_wait', availableAt: plusMs(T0, -1_000) })];
  assert.equal(
    await ask(createQueuedHopWaitEligibility({ list: async () => backoffOverdue, now }), 'R-probe-F1', 'project_busy'),
    undefined,
  );

  // 读库出错不凭猜测等待：返回 undefined，交回驱动走原升级处置。
  assert.equal(
    await ask(createQueuedHopWaitEligibility({ list: async () => { throw new Error('queue unreadable'); }, now }), 'R-probe-F1', 'project_busy'),
    undefined,
  );

  // 端到端：生产探针接进 runPlanOnPlatform → drivePlan，首次 project_busy 后同 missionId 续跑。
  const dir = mkdtempSync(join(tmpdir(), 'coagent-plan-resume-'));
  try {
    const store = new FilePlanRunStore(join(dir, 'R-probe.json'));
    const feature = { id: 'F1', title: 'probe', why: 'continue', allowedScope: ['a.ts'], acceptance: ['done'] };
    const plan = {
      planId: 'P-probe', projectId: 'project', integrationBranch: 'main', reviewer: 'reviewer',
      stopConditions: { unresolvedEscalations: 1, wallClockMs: 60 * 60_000, escalationTimeoutMs: 1_000 },
      features: [feature],
    } as PlanSpec;
    const selection = { candidates: [feature], exclusions: [], warnings: [] } as PlanCandidateSelection;

    const events: string[] = [];
    const runs: string[] = [];
    const logs: string[] = [];
    const platform = {
      async resumeMission() { throw new Error('unexpected resume'); },
      async createMission(input: { missionId: string }) { events.push(`create:${input.missionId}`); },
      async createClassifiedMission() { throw new Error('unexpected classified create'); },
      async getMissionView() { return { status: 'blocked' }; },
      async effectiveIndependentReviewPass() { return undefined; },
      async finalizeMissionByHaAuthority() { throw new Error('unexpected'); },
      async finalizeMissionByMachine() { throw new Error('unexpected'); },
      async abandonMissionForPlan() { throw new Error('unexpected'); },
      async answerEscalation() { throw new Error('unexpected'); },
    };
    const runMission = async (missionId: string) => {
      runs.push(missionId);
      // 首次：名额被占；探针给出自己的退避证明后，第二次真的交卷——不许再开升级单。
      return runs.length === 1
        ? { outcome: { kind: 'waiting', reason: 'project_busy', detail: '别的 Mission 正占着改动名额。' } }
        : { outcome: { kind: 'delivered' } };
    };

    await runPlanOnPlatform(plan, selection, {
      store, projectRoot: dir, platform: platform as never,
      runMission: runMission as never,
      waitEligibility: createQueuedHopWaitEligibility({ list: async () => ownBackoff, now }),
      persist: async () => {}, pauseInFlight: async () => {},
      now, sleep: async (ms) => { clock += ms; },
      log: (line) => logs.push(line), runId: 'R-probe', startedAt: T0, pollMs: 1_000,
    });

    const run = store.read()!;
    assert.deepEqual(runs, ['R-probe-F1', 'R-probe-F1'], '同 missionId 续跑，不另开 Mission');
    assert.deepEqual(events, ['create:R-probe-F1']);
    assert.equal(run.escalations.length, 0, '自己的退避等得到头，不开升级单');
    assert.equal(run.feature('F1')?.status, 'merged');
    assert.ok(logs.some((line) => line.includes('续跑 R-probe-F1，不开升级单')), logs.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
