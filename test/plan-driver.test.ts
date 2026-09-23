/**
 * 方案驱动：逐个开跑功能点 → 机器 L3 → 失败就开升级单等检视者 → 照决定处置 →
 * 撞到停止条件就停并写明原因。
 *
 * 平台、编排、分类员都是可编程替身（它们各自有自己的测试）；**方案运行记录用
 * 真的文件存储**，检视者的决定也经它写回——驱动方读到的就是另一个进程会写的
 * 那份东西。时钟是假的：每次 sleep 往前拨，检视者挂在 sleep 上按时刻出手。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drivePlan, type PlanDriverDeps } from '../src/application/plan-driver.ts';
import { PlanRun } from '../src/application/plan-run.ts';
import { FilePlanRunStore } from '../src/application/plan-run-store.ts';
import { parsePlanSpec } from '../src/application/plan-spec.ts';
import { PlatformRuleError } from '../src/application/platform.ts';
import type { MissionRunOutcome } from '../src/application/orchestrator.ts';

const T0 = '2026-09-23T22:00:00.000Z';
const MIN = 60_000;

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const QUIET_FACTS = {
  mutationSideEffect: true,
  readOnlyProven: false,
  highAssurance: {
    productionDeployRelease: false,
    externalPaidOp: false,
    destructiveData: false,
    credentialsPermissionsSecurity: false,
    schemaPublicApiPersistenceCompat: false,
    unrecoverableExternalSideEffect: false,
  },
  standardFloor: {
    publicInterface: false,
    buildSystemOrDependency: false,
    multipleDomainModules: false,
    acceptanceNotCheckableUpfront: false,
    rootCauseOrCompetingDesigns: false,
  },
} as const;

type Finalize = { status: string; mergedInto?: string; reportId?: string; reason?: string; rolledBackTo?: string };
/** 这条 Mission 跑完停在哪：编排器的结论 + Mission 此时的状态。 */
type Ran = { outcome: MissionRunOutcome; status: string };
type Hook = (ctx: { now: string; store: FilePlanRunStore }) => Promise<void> | void;

function harness(options?: {
  features?: string[];
  runs?: Record<string, Ran | Error>;
  finalize?: Record<string, Finalize | Error>;
  routes?: Record<string, Awaited<ReturnType<PlanDriverDeps['proposeRoute']>>>;
  onSleep?: Hook;
  unresolvedEscalations?: number;
  wallClockMs?: number;
}) {
  const ids = options?.features ?? ['F1', 'F2'];
  const plan = parsePlanSpec(
    {
      planId: 'PLAN-x',
      projectId: 'p',
      integrationBranch: 'auto/plan-x',
      intent: '无人值守推进',
      stopConditions: {
        unresolvedEscalations: options?.unresolvedEscalations ?? 5,
        wallClockMs: options?.wallClockMs ?? 8 * 60 * MIN,
        escalationTimeoutMs: 20 * MIN,
      },
      integrationVerification: [{ argv: ['node', '--test'], timeoutMs: 60_000 }],
      features: ids.map((id) => ({
        id,
        title: `功能 ${id}`,
        why: '因为',
        allowedScope: [`src/${id}.ts`],
        acceptance: ['绿'],
      })),
    },
    { reviewer: 'claude' },
  );
  const dir = mkdtempSync(join(tmpdir(), 'coagent-plan-driver-'));
  dirs.push(dir);
  const store = new FilePlanRunStore(join(dir, 'R1.json'));
  let clock = Date.parse(T0);
  const now = () => new Date(clock).toISOString();
  const calls: string[] = [];
  const status = new Map<string, string>();

  const deps: PlanDriverDeps = {
    store,
    projectRoot: 'C:/repo',
    now,
    log: () => {},
    sleep: async (ms) => {
      clock += ms;
      await options?.onSleep?.({ now: now(), store });
    },
    proposeRoute: async (feature) =>
      options?.routes?.[feature.id] ?? { ok: false, reason: '测试里不分类' },
    runMission: async (missionId) => {
      calls.push(`run ${missionId}`);
      clock += 30 * MIN;
      const ran = options?.runs?.[missionId] ?? { outcome: { kind: 'awaiting_l3_review' }, status: 'awaiting_review' };
      if (ran instanceof Error) throw ran;
      status.set(missionId, ran.status);
      return ran.outcome;
    },
    platform: {
      createMission: async (input) => {
        calls.push(`create ${input.missionId}`);
        status.set(input.missionId, 'investigating');
        return { missionId: input.missionId };
      },
      createClassifiedMission: async (input) => {
        calls.push(`create-classified ${input.missionId} ${input.workOrder ? 'lightweight' : 'standard'}`);
        status.set(input.missionId!, 'investigating');
        return { missionId: input.missionId!, classification: undefined as never };
      },
      getMissionView: async (missionId) => ({ status: status.get(missionId) ?? 'unknown' }),
      finalizeMissionByMachine: async (missionId, input) => {
        calls.push(`finalize ${missionId} → ${input.integrationBranch} [${input.verification[0].argv.join(' ')}]`);
        const result = options?.finalize?.[missionId] ?? { status: 'completed', mergedInto: 'abc', reportId: 'IVAL-1' };
        if (result instanceof Error) throw result;
        status.set(missionId, result.status);
        return result;
      },
      abandonMissionForPlan: async (missionId, input) => {
        calls.push(`abandon ${missionId} ${input.escalationId}`);
        status.set(missionId, 'blocked');
        return { status: 'blocked' };
      },
    },
  };

  const start = () =>
    store.create(
      PlanRun.start({
        id: 'R1',
        planId: plan.planId,
        projectId: plan.projectId,
        integrationBranch: plan.integrationBranch,
        reviewer: plan.reviewer,
        stopConditions: plan.stopConditions,
        featureIds: ids,
        startedAt: T0,
      }),
    );
  return { plan, deps, store, calls, status, start };
}

/** 检视者：看到开着的升级单就按给定动作定（只定一次）。 */
function reviewerDecides(action: string, extra?: { dropFeatures?: string[]; after?: number }): Hook {
  return async ({ now, store }) => {
    const open = store.read()?.currentEscalation;
    if (!open) return;
    if (Date.parse(now) - Date.parse(open.openedAt) < (extra?.after ?? 5 * MIN)) return;
    await store.update((run) =>
      run.decide(
        open.id,
        {
          action,
          reason: `检视者选 ${action}`,
          decidedBy: 'claude',
          ...(extra?.dropFeatures ? { dropFeatures: extra.dropFeatures } : {}),
        },
        now,
      ),
    );
  };
}

const RED: Finalize = { status: 'awaiting_review', reportId: 'IVAL-2', reason: '集成验证未通过，已回滚', rolledBackTo: 'anchor0' };

describe('一路顺利', () => {
  test('逐个开跑、机器 L3 合进集成分支、全部合入后停在 finished', async () => {
    const h = harness();
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'finished');
    assert.deepEqual(h.calls, [
      'create R1-F1',
      'run R1-F1',
      'finalize R1-F1 → auto/plan-x [node --test]',
      'create R1-F2',
      'run R1-F2',
      'finalize R1-F2 → auto/plan-x [node --test]',
    ]);
    const run = h.store.read()!;
    assert.deepEqual(run.features.map((f) => `${f.featureId}:${f.status}`), ['F1:merged', 'F2:merged']);
  });
});

describe('现做分类', () => {
  test('Fast Lane 带工单、Standard 不带、high_assurance 不建 Mission 直接挂起、读不懂回落老路', async () => {
    const order = {
      objective: 'x',
      allowedScope: ['src/F1.ts'],
      requiredBehaviour: 'x',
      constraints: [],
      acceptance: ['x'],
      verification: ['x'],
      doNot: [],
      contextRefs: [],
    };
    const small = {
      goalUncertainty: 0, changeScope: 0, operationalRisk: 0, verificationDifficulty: 0,
      coordinationNeed: 0, recoveryDifficulty: 0, reasons: ['小'], decidedBy: 'coordinator' as const,
      assessedAt: T0,
    };
    const h = harness({
      features: ['F1', 'F2', 'F3', 'F4'],
      routes: {
        F1: { ok: true, proposal: { facts: QUIET_FACTS, assessment: small, workOrder: order } },
        F2: {
          ok: true,
          proposal: { facts: { ...QUIET_FACTS, standardFloor: { ...QUIET_FACTS.standardFloor, publicInterface: true } } },
        },
        F3: {
          ok: true,
          proposal: { facts: { ...QUIET_FACTS, highAssurance: { ...QUIET_FACTS.highAssurance, destructiveData: true } } },
        },
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'finished');
    assert.ok(h.calls.includes('create-classified R1-F1 lightweight'));
    assert.ok(h.calls.includes('create-classified R1-F2 standard'));
    assert.ok(!h.calls.some((c) => c.includes('R1-F3')), 'high_assurance 不建 Mission、不跑');
    assert.ok(h.calls.includes('create R1-F4'), '读不懂的回落老路');
    const f3 = h.store.read()!.feature('F3');
    assert.equal(f3?.status, 'suspended');
    assert.match(f3?.needsDecision ?? '', /要你定/);
  });
});

describe('失败了开升级单等检视者', () => {
  test('验证红 → 开单写明失败与要定什么 → 检视者跳过 → 放掉名额 → 接着跑下一个', async () => {
    const h = harness({ finalize: { 'R1-F1': RED }, onSleep: reviewerDecides('skip') });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'finished');
    const run = h.store.read()!;
    const e1 = run.escalations[0];
    assert.equal(e1.featureId, 'F1');
    assert.equal(e1.missionId, 'R1-F1');
    assert.match(e1.failure, /IVAL-2/);
    assert.match(e1.question, /隔离重跑/);
    assert.equal(run.feature('F1')?.status, 'skipped');
    assert.equal(run.feature('F2')?.status, 'merged');
    // 名额必须在开下一个之前放掉，否则下一个派发不了。
    // 先断它确实放弃了：没放弃时 indexOf 是 -1，只比先后会两边都绿。
    assert.ok(h.calls.includes('abandon R1-F1 E-1'));
    assert.ok(h.calls.indexOf('abandon R1-F1 E-1') < h.calls.indexOf('create R1-F2'));
  });

  test('没人定 → 截止判过期、记未解决、功能挂起、名额放掉、接着跑', async () => {
    const h = harness({ finalize: { 'R1-F1': RED } });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'finished');
    const run = h.store.read()!;
    assert.equal(run.unresolvedCount, 1);
    assert.equal(run.escalations[0].resolution?.kind, 'expired');
    assert.equal(run.feature('F1')?.status, 'suspended');
    assert.ok(h.calls.includes('abandon R1-F1 E-1'));
    assert.equal(run.feature('F2')?.status, 'merged');
  });

  test('未解决累计到阈值就停；最后那条失败的 Mission 原样留给人，不放弃', async () => {
    const h = harness({
      unresolvedEscalations: 2,
      features: ['F1', 'F2', 'F3'],
      finalize: { 'R1-F1': RED, 'R1-F2': RED },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'unresolved_escalations');
    assert.ok(h.calls.includes('abandon R1-F1 E-1'), '第一次之后还要接着跑，得放名额');
    assert.ok(!h.calls.includes('abandon R1-F2 E-2'), '停了就不必放，留着给人合或重跑');
    assert.equal(h.status.get('R1-F2'), 'awaiting_review');
    assert.equal(h.store.read()!.feature('F3')?.status, 'pending');
  });

  test('检视者叫停：方案停下，失败的 Mission 原样留给人', async () => {
    const h = harness({ finalize: { 'R1-F1': RED }, onSleep: reviewerDecides('stop') });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'reviewer_stop');
    assert.ok(!h.calls.some((c) => c.startsWith('abandon')));
    assert.ok(!h.calls.includes('create R1-F2'));
  });

  test('隔离重跑：旧的放弃，另开一条 -r2 从头来', async () => {
    const h = harness({ finalize: { 'R1-F1': RED }, onSleep: reviewerDecides('rerun_isolated') });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'finished');
    assert.ok(h.calls.includes('abandon R1-F1 E-1'));
    assert.ok(h.calls.indexOf('abandon R1-F1 E-1') < h.calls.indexOf('create R1-F1-r2'));
    assert.ok(h.calls.includes('finalize R1-F1-r2 → auto/plan-x [node --test]'));
    assert.deepEqual(h.store.read()!.feature('F1')?.missionIds, ['R1-F1', 'R1-F1-r2']);
    assert.equal(h.store.read()!.feature('F1')?.status, 'merged');
  });

  test('重划剩余范围：被点名的依赖功能今晚不跑', async () => {
    const h = harness({
      features: ['F1', 'F2', 'F3'],
      finalize: { 'R1-F1': RED },
      onSleep: reviewerDecides('rescope', { dropFeatures: ['F3'] }),
    });
    await h.start();
    await drivePlan(h.plan, h.deps);
    assert.ok(!h.calls.some((c) => c.includes('R1-F3')));
    assert.equal(h.store.read()!.feature('F3')?.status, 'skipped');
    assert.equal(h.store.read()!.feature('F2')?.status, 'merged');
  });

  test('Mission 自己就走不下去（卡住 / 等人 / 协调者升级）：同样开单，失败里写明卡在哪', async () => {
    const h = harness({
      features: ['F1', 'F2', 'F3'],
      runs: {
        'R1-F1': { outcome: { kind: 'stalled', reason: '协调者连续两轮没有做任何结构化提交' }, status: 'planning' },
        'R1-F2': { outcome: { kind: 'awaiting_l3', question: '要不要改公共接口？' }, status: 'planning' },
        'R1-F3': { outcome: { kind: 'blocked', reason: '已 blocked' }, status: 'blocked' },
      },
      onSleep: reviewerDecides('skip'),
    });
    await h.start();
    await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.match(run.escalations[0].failure, /结构化提交/);
    assert.match(run.escalations[1].failure, /要不要改公共接口/);
    assert.ok(h.calls.includes('abandon R1-F1 E-1'));
    assert.ok(!h.calls.includes('abandon R1-F3 E-3'), '已经终结的不用再放弃');
    assert.ok(!h.calls.some((c) => c.startsWith('finalize')), '没交卷的不走机器 L3');
  });
});

describe('驱动方自己停', () => {
  test('验证红且回滚失败 → 集成分支不安全，立刻停，不开单', async () => {
    const h = harness({
      finalize: { 'R1-F1': { status: 'awaiting_review', reportId: 'IVAL-3', reason: '集成验证未通过，且回滚失败' } },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'unsafe');
    assert.match(stop.detail, /IVAL-3/);
    assert.equal(h.store.read()!.escalations.length, 0);
    assert.equal(h.store.read()!.feature('F1')?.status, 'suspended');
    assert.ok(!h.calls.includes('create R1-F2'));
  });

  test('项目仓被切离集成分支 → 不安全，停', async () => {
    const h = harness({
      finalize: {
        'R1-F1': new PlatformRuleError('INTEGRATION_BRANCH_MISMATCH', '项目仓现在在 master，不是方案声明的 auto/plan-x。'),
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'unsafe');
    assert.match(stop.detail, /master/);
  });

  test('墙钟到点：不再开新的功能', async () => {
    // 每条 Mission 假跑 30 分钟；墙钟 25 分钟 → 第一条开跑时没到点，跑完就过了。
    const h = harness({ wallClockMs: 25 * MIN });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'wall_clock');
    assert.ok(!h.calls.includes('create R1-F2'));
    assert.equal(h.store.read()!.feature('F2')?.status, 'pending');
  });

  test('没料到的错：记下原因停在 crashed，再往外抛', async () => {
    const h = harness({ runs: { 'R1-F1': new Error('适配器进程起不来') } });
    await h.start();
    await assert.rejects(() => drivePlan(h.plan, h.deps), /适配器进程起不来/);
    const run = h.store.read()!;
    assert.equal(run.stopped?.reason, 'crashed');
    assert.match(run.stopped?.detail ?? '', /适配器进程起不来/);
  });
});
