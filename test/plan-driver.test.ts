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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drivePlan, type PlanDriverDeps } from '../src/application/plan-driver.ts';
import { runPlanOnPlatform } from '../src/application/plan-runtime.ts';
import { PlanRun } from '../src/application/plan-run.ts';
import { FilePlanRunStore } from '../src/application/plan-run-store.ts';
import { parsePlanSpec, selectPlanCandidates } from '../src/application/plan-spec.ts';
import { PlatformRuleError } from '../src/application/platform.ts';
import type { MissionRunOutcome } from '../src/application/orchestrator.ts';
import type { RunQueryResult } from '../src/application/query-run.ts';

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

const HA_FACTS = {
  ...QUIET_FACTS,
  highAssurance: {
    ...QUIET_FACTS.highAssurance,
    credentialsPermissionsSecurity: true,
    schemaPublicApiPersistenceCompat: true,
  },
} as const;

type Finalize = { status: string; mergedInto?: string; reportId?: string; reason?: string; rolledBackTo?: string };
/** 这条 Mission 跑完停在哪：编排器的结论 + Mission 此时的状态。 */
type Ran = { outcome: MissionRunOutcome; status: string };
type Hook = (ctx: { now: string; store: FilePlanRunStore }) => Promise<void> | void;

type HarnessView = {
  status?: string;
  executionMode?: string;
  haReviewHold?: 'pending_dispatch' | 'in_review' | 'pending_release' | 'fault';
  waitDetail?: string;
  workspaceRef?: { targetBranch?: string };
  independentReviews?: readonly {
    readonly reviewedCommit: string;
    readonly verdict: string;
    readonly reviewerAttemptId: string;
    readonly validationReportId?: string;
  }[];
};

function harness(options?: {
  features?: string[];
  runs?: Record<string, Ran | Error | (Ran | Error)[]>;
  finalize?: Record<string, Finalize | Error>;
  haFinalize?: Record<string, Finalize | Error>;
  onHaFinalize?: (missionId: string) => void;
  passTakesMs?: number[];
  pollMs?: number;
  routes?: Record<string, Awaited<ReturnType<PlanDriverDeps['proposeRoute']>>>;
  onSleep?: Hook;
  /** 每次写方案运行记录之前先跑它：用来在驱动方读与写之间插进检视者的一笔。 */
  beforeUpdate?: Hook;
  /** 分类员：抛错 / 花多久。 */
  proposeThrows?: Error;
  routeTakesMs?: number;
  /** 建分类 Mission 时平台拒绝。 */
  classifiedRejects?: Error;
  /** getMissionView 额外字段（HA 待放行等）。 */
  views?: Record<string, HarnessView>;
  passes?: Record<string, { readonly reviewedCommit: string; readonly reviewerAttemptId: string; readonly validationReportId?: string; readonly verdict: string } | undefined>;
  /** 每个功能开跑前核对项目仓；按功能给出问题清单。 */
  repoProblems?: Record<string, string[]>;
  unresolvedEscalations?: number;
  wallClockMs?: number;
  maxEscalations?: number;
  maxRerunsPerFeature?: number;
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
        ...(options?.maxEscalations !== undefined ? { maxEscalations: options.maxEscalations } : {}),
        ...(options?.maxRerunsPerFeature !== undefined ? { maxRerunsPerFeature: options.maxRerunsPerFeature } : {}),
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
  const passCalls: string[] = [];
  const routed: string[] = [];
  const classifiedFacts: unknown[] = [];
  const status = new Map<string, string>();
  const finalReview = new Map<string, string>();
  const runIndex = new Map<string, number>();
  let passIndex = 0;

  const deps: PlanDriverDeps = {
    store: {
      read: () => store.read(),
      update: async (mutate) => {
        await options?.beforeUpdate?.({ now: now(), store });
        return store.update(mutate);
      },
    },
    checkRepo: async () => {
      const next = store.read()?.nextPending()?.featureId ?? '';
      return options?.repoProblems?.[next] ?? [];
    },
    projectRoot: 'C:/repo',
    now,
    ...(options?.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    log: () => {},
    sleep: async (ms) => {
      clock += ms;
      await options?.onSleep?.({ now: now(), store });
    },
    proposeRoute: async (feature) => {
      routed.push(feature.id);
      clock += options?.routeTakesMs ?? 0;
      if (options?.proposeThrows) throw options.proposeThrows;
      return options?.routes?.[feature.id] ?? { ok: false, reason: '测试里不分类' };
    },
    runMission: async (missionId) => {
      calls.push(`run ${missionId}`);
      clock += 30 * MIN;
      const configured = options?.runs?.[missionId];
      let ran: Ran | Error;
      if (Array.isArray(configured)) {
        const i = runIndex.get(missionId) ?? 0;
        runIndex.set(missionId, i + 1);
        ran = configured[i];
        if (ran === undefined) throw new Error(`unexpected extra run of ${missionId}`);
      } else {
        ran = configured ?? { outcome: { kind: 'awaiting_l3_review' }, status: 'awaiting_review' };
      }
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
        classifiedFacts.push(input.facts);
        if (options?.classifiedRejects) throw options.classifiedRejects;
        const ha = (input.facts as { highAssurance?: Record<string, unknown> } | undefined)?.highAssurance;
        const haHit = Boolean(ha && Object.values(ha).some((value) => value === true));
        const lane = input.workOrder ? 'lightweight' : haHit ? 'high_assurance' : 'standard';
        calls.push(`create-classified ${input.missionId} ${lane}`);
        status.set(input.missionId!, 'investigating');
        return { missionId: input.missionId!, classification: undefined as never };
      },
      getMissionView: async (missionId) => ({
        status: status.get(missionId) ?? 'unknown',
        ...(options?.views?.[missionId] ?? {}),
        ...(finalReview.has(missionId) ? { finalReview: { mergedInto: finalReview.get(missionId) } } : {}),
      }),
      effectiveIndependentReviewPass: async (missionId) => {
        clock += options?.passTakesMs?.[passIndex] ?? 0;
        passIndex += 1;
        passCalls.push(missionId);
        if (options?.passes && Object.hasOwn(options.passes, missionId)) return options.passes[missionId];
        return [...(options?.views?.[missionId]?.independentReviews ?? [])].reverse().find((row) => row.verdict === 'pass');
      },
      finalizeMissionByHaAuthority: async (missionId, input) => {
        const command = input.verification?.map((item) => item.argv.join(' ')).join(' ; ') ?? '';
        calls.push(`ha-finalize ${missionId} by ${input.reviewerId}/${input.confirmedBy} [${command}]`);
        const result = options?.haFinalize?.[missionId] ?? { status: 'completed', mergedInto: 'ha-merge-1', reportId: 'IVAL-HA' };
        if (result instanceof Error) throw result;
        if (result.status === 'completed' && result.mergedInto) {
          status.set(missionId, 'completed');
          finalReview.set(missionId, result.mergedInto);
        }
        options?.onHaFinalize?.(missionId);
        return result;
      },
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
      answerEscalation: async (missionId, answer) => {
        calls.push(`answer ${missionId} ${answer}`);
        return { question: 'recorded', answer };
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
  return { plan, deps, store, calls, passCalls, routed, classifiedFacts, status, finalReview, start };
}

/** 检视者：看到开着的升级单就按给定动作定（只定一次）。 */
function reviewerDecides(action: string, extra?: { dropFeatures?: string[]; after?: number; answer?: string }): Hook {
  return async ({ now, store }) => {
    const open = store.read()?.currentEscalation;
    if (!open) return;
    if (Date.parse(now) - Date.parse(open.openedAt) < (extra?.after ?? 5 * MIN)) return;
    await store.update((run) =>
      run.choose(
        open.id,
        {
          action,
          reason: `检视者选 ${action}`,
          decidedBy: 'claude',
          ...(extra?.dropFeatures ? { dropFeatures: extra.dropFeatures } : {}),
          ...(extra?.answer !== undefined ? { answer: extra.answer } : {}),
        },
        now,
      ),
    );
  };
}

const RED: Finalize = { status: 'awaiting_review', reportId: 'IVAL-2', reason: '集成验证未通过，已回滚', rolledBackTo: 'anchor0' };
const haAssessment = {
  goalUncertainty: 0, changeScope: 0, operationalRisk: 0, verificationDifficulty: 0,
  coordinationNeed: 0, recoveryDifficulty: 0, reasons: ['小'], decidedBy: 'coordinator' as const,
  assessedAt: T0,
};
const haRoute = { ok: true as const, proposal: { facts: HA_FACTS, assessment: haAssessment } };

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
  test('不完整禁止副作用信号挂起且建单前不检查仓库', async () => {
    const h = harness({
      routes: { F1: { ok: false, reason: 'facts 不合法', haForbiddenUnproven: ['externalPaidOp'] } },
      repoProblems: { F1: ['仓库状态异常'] },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.notEqual(stop.reason, 'unsafe');
    const feature = h.store.read()!.feature('F1');
    assert.equal(feature?.status, 'suspended');
    assert.match(feature?.needsDecision ?? '', /externalPaidOp/);
    assert.ok(!h.calls.some((c) => c.includes('R1-F1')));
  });
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
    assert.ok(!h.calls.some((c) => c.includes('R1-F3')), '禁止副作用的 HA 不建 Mission、不跑');
    assert.ok(h.calls.includes('create R1-F4'), '读不懂的回落老路');
    const f3 = h.store.read()!.feature('F3');
    assert.equal(f3?.status, 'suspended');
    assert.match(f3?.needsDecision ?? '', /要你定/);
    assert.match(f3?.needsDecision ?? '', /destructiveData/);
    assert.match(f3?.needsDecision ?? '', /不删除、不改写数据/);
    assert.match(f3?.needsDecision ?? '', /coagent l3 plan-release --feature F3 --mission <mission-id> --action approve/);
  });
});

describe('E4b3 HA 等待限时决定', () => {
  const views: Record<string, HarnessView> = {
    'R1-F1': {
      executionMode: 'high_assurance' as const,
      haReviewHold: 'pending_release' as const,
      workspaceRef: { targetBranch: 'auto/plan-x' },
      independentReviews: [{ reviewedCommit: 'deadbeef01', verdict: 'pass', reviewerAttemptId: 'IR-7', validationReportId: 'VR-ha' }],
    },
  };
  const sign = (run: PlanRun, at: string, action: 'approve' | 'send_back', reason = '补充证据') => run.decideHaRelease({
    featureId: 'F1', missionId: 'R1-F1', reviewedCommit: 'deadbeef01', attemptId: 'IR-7',
    validationReportId: 'VR-ha', target: 'auto/plan-x', as: 'claude', confirmedBy: 'human', action, reason,
  }, at);
  const signPending = (run: PlanRun, at: string, action: 'approve' | 'send_back', reason?: string) => {
    const pending = run.haReleases.find((release) => !release.decision);
    assert.ok(pending, '应有待决 HA 记录');
    return run.decideHaRelease({
      featureId: pending.featureId,
      missionId: pending.missionId,
      reviewedCommit: pending.reviewedCommit,
      attemptId: pending.attemptId,
      validationReportId: pending.validationReportId,
      target: pending.integrationBranch,
      as: 'claude',
      confirmedBy: 'human',
      action,
      ...(reason ? { reason } : {}),
    }, at);
  };

  test('approve：只调受控合入并传启动时的方案验证命令，合入后标 merged、继续下一功能', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views,
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) await store.update((run) => sign(run, now, 'approve'));
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'finished');
    assert.deepEqual(h.calls.filter((call) => call.startsWith('ha-finalize R1-F1')), [
      'ha-finalize R1-F1 by claude/human [node --test]',
    ]);
    assert.ok(!h.calls.some((call) => call.startsWith('finalize R1-F1')));
    const run = h.store.read()!;
    assert.equal(run.feature('F1')?.status, 'merged');
    assert.equal(run.feature('F2')?.status, 'merged');
    assert.ok(h.calls.includes('create R1-F2'));
    assert.equal(run.escalationsOpened, 0);
    assert.ok(!h.calls.some((call) => call.startsWith('abandon R1-F1')));
  });

  test('截止前一毫秒签 approve，消费跨审批截止仍受控合入', async () => {
    let h!: ReturnType<typeof harness>;
    let signedAt: string | undefined;
    let finalizeAt: string | undefined;
    h = harness({
      features: ['F1', 'F2'],
      routes: { F1: haRoute },
      views,
      pollMs: 20 * MIN - 1,
      passTakesMs: [0, 1],
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases.find((item) => item.featureId === 'F1');
        if (release && !release.decision && !signedAt) {
          signedAt = now;
          await store.update((run) => sign(run, now, 'approve'));
        }
      },
      onHaFinalize: (missionId) => {
        if (missionId === 'R1-F1') finalizeAt = h.deps.now();
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    const release = run.haReleases.find((item) => item.featureId === 'F1');
    assert.ok(release?.decision?.kind === 'approve');
    assert.ok(signedAt);
    assert.ok(finalizeAt);
    assert.equal(release.decision.at, signedAt);
    assert.equal(Date.parse(signedAt), Date.parse(release.deadline) - 1);
    assert.ok(Date.parse(release.decision.at) < Date.parse(release.deadline));
    assert.equal(Date.parse(finalizeAt), Date.parse(release.deadline));
    assert.ok(Date.parse(finalizeAt) >= Date.parse(release.deadline));
    assert.ok(Date.parse(finalizeAt) < Date.parse(T0) + 8 * 60 * MIN);
    assert.equal(stop.reason, 'finished');
    assert.equal(h.calls.filter((call) => call.startsWith('ha-finalize R1-F1')).length, 1);
    assert.deepEqual(h.calls.filter((call) => call.startsWith('ha-finalize R1-F1')), [
      'ha-finalize R1-F1 by claude/human [node --test]',
    ]);
    assert.ok(!h.calls.some((call) => call.startsWith('finalize R1-F1')));
    assert.equal(run.feature('F1')?.status, 'merged');
    assert.equal(run.escalationsOpened, 0);
    assert.equal(run.feature('F2')?.status, 'merged');
    assert.ok(h.calls.indexOf('ha-finalize R1-F1 by claude/human [node --test]') < h.calls.indexOf('create R1-F2'));
  });

  test('approve 消费前功能不再 running：不变式崩溃且不终审', async () => {
    let corrupted = false;
    const h = harness({
      features: ['F1', 'F2'],
      routes: { F1: haRoute },
      views,
      onSleep: async ({ now, store }) => {
        if (corrupted) return;
        const release = store.read()?.haReleases.find((item) => item.featureId === 'F1');
        if (!release || release.decision) return;
        await store.update((run) => sign(run, now, 'approve'));
        const snapshot = JSON.parse(JSON.stringify(store.read()!.toSnapshot())) as {
          features: { featureId: string; status: string; missionIds: string[] }[];
        };
        const feature = snapshot.features.find((item) => item.featureId === 'F1');
        assert.ok(feature);
        feature.status = 'pending';
        writeFileSync(store.path, JSON.stringify(snapshot));
        const recovered = store.read();
        assert.ok(recovered, '篡改后的快照仍应可恢复');
        assert.equal(recovered.feature('F1')?.status, 'pending');
        assert.deepEqual(recovered.feature('F1')?.missionIds, ['R1-F1']);
        assert.equal(recovered.haReleases[0]?.decision?.kind, 'approve');
        corrupted = true;
      },
    });
    await h.start();
    await assert.rejects(drivePlan(h.plan, h.deps), /HA 放行决定不变式被破坏.*F1.*R1-F1/);
    const run = h.store.read()!;
    assert.equal(run.stopped?.reason, 'crashed');
    assert.equal(run.haReleases[0]?.decision?.kind, 'approve');
    assert.equal(h.calls.filter((call) => call.startsWith('ha-finalize R1-F1')).length, 0);
    assert.equal(h.calls.filter((call) => call.startsWith('finalize R1-F1')).length, 0);
    assert.equal(run.escalations.length, 0);
    assert.equal(run.escalationsOpened, 0);
    assert.ok(!h.calls.some((call) => call.startsWith('abandon R1-F1')));
    assert.ok(!h.routed.includes('F2'));
    assert.ok(!h.calls.some((call) => call.includes('R1-F2')));
  });

  test('approve 消费前最后 Mission 已非所钉 Mission：不变式崩溃且不终审', async () => {
    let corrupted = false;
    const h = harness({
      features: ['F1', 'F2'],
      routes: { F1: haRoute },
      views,
      onSleep: async ({ now, store }) => {
        if (corrupted) return;
        const release = store.read()?.haReleases.find((item) => item.featureId === 'F1');
        if (!release || release.decision) return;
        await store.update((run) => sign(run, now, 'approve'));
        const snapshot = JSON.parse(JSON.stringify(store.read()!.toSnapshot())) as {
          features: { featureId: string; status: string; missionIds: string[] }[];
        };
        const feature = snapshot.features.find((item) => item.featureId === 'F1');
        assert.ok(feature);
        feature.missionIds.push('R1-F1-r2');
        writeFileSync(store.path, JSON.stringify(snapshot));
        const recovered = store.read();
        assert.ok(recovered, '篡改后的快照仍应可恢复');
        assert.equal(recovered.feature('F1')?.status, 'running');
        assert.deepEqual(recovered.feature('F1')?.missionIds, ['R1-F1', 'R1-F1-r2']);
        assert.equal(recovered.haReleases[0]?.missionId, 'R1-F1');
        assert.equal(recovered.haReleases[0]?.decision?.kind, 'approve');
        corrupted = true;
      },
    });
    await h.start();
    await assert.rejects(drivePlan(h.plan, h.deps), /HA 放行决定不变式被破坏.*F1.*R1-F1/);
    const run = h.store.read()!;
    assert.equal(run.stopped?.reason, 'crashed');
    assert.equal(run.haReleases[0]?.decision?.kind, 'approve');
    assert.equal(run.feature('F1')?.missionIds.at(-1), 'R1-F1-r2');
    assert.equal(h.calls.filter((call) => call.startsWith('ha-finalize R1-F1')).length, 0);
    assert.equal(h.calls.filter((call) => call.startsWith('finalize R1-F1')).length, 0);
    assert.equal(run.escalations.length, 0);
    assert.equal(run.escalationsOpened, 0);
    assert.ok(!h.calls.some((call) => call.startsWith('abandon R1-F1')));
    assert.ok(!h.routed.includes('F2'));
    assert.ok(!h.calls.some((call) => call.includes('R1-F2')));
  });

  test('approve 消费前证据已变：未合并，保留决定并走升级处置', async () => {
    const v = structuredClone(views);
    const passes: Record<string, { reviewedCommit: string; reviewerAttemptId: string; validationReportId?: string; verdict: string } | undefined> = {};
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views: v, passes,
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) {
          await store.update((run) => sign(run, now, 'approve'));
          passes['R1-F1'] = { reviewedCommit: 'feedface02', reviewerAttemptId: 'IR-8', validationReportId: 'VR-ha2', verdict: 'pass' };
        } else await reviewerDecides('skip')({ now, store });
      },
    });
    await h.start(); await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.ok(!h.calls.some((call) => call.startsWith('ha-finalize R1-F1')));
    assert.ok(!h.calls.some((call) => call.startsWith('finalize R1-F1')));
    assert.match(run.escalations[0]!.failure, /未合并/);
    assert.equal(run.escalations[0]!.answerable, undefined);
    assert.match(run.escalations[0]!.failure, /deadbeef01/);
    assert.match(run.escalations[0]!.failure, /feedface02/);
    assert.equal(run.haReleases[0]?.decision?.kind, 'approve');
    assert.ok(h.calls.includes('abandon R1-F1 E-1'));
    assert.equal(run.feature('F2')?.status, 'merged');
  });

  test('approve 消费前没有有效 pass：未合并，保留决定并走升级处置', async () => {
    const v = structuredClone(views);
    const passes: Record<string, { reviewedCommit: string; reviewerAttemptId: string; validationReportId?: string; verdict: string } | undefined> = {};
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views: v, passes,
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) {
          await store.update((run) => sign(run, now, 'approve'));
          passes['R1-F1'] = undefined;
        } else await reviewerDecides('skip')({ now, store });
      },
    });
    await h.start(); await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.ok(!h.calls.some((call) => call.startsWith('ha-finalize R1-F1')));
    assert.ok(!h.calls.some((call) => call.startsWith('finalize R1-F1')));
    assert.match(run.escalations[0]!.failure, /未合并/);
    assert.match(run.escalations[0]!.failure, /没有有效 pass/);
    assert.equal(run.haReleases[0]?.decision?.kind, 'approve');
    assert.ok(h.calls.includes('abandon R1-F1 E-1'));
    assert.equal(run.feature('F2')?.status, 'merged');
  });

  test('approve 消费前目标已变：未合并，保留决定并走升级处置', async () => {
    const v = structuredClone(views);
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views: v,
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) {
          await store.update((run) => sign(run, now, 'approve'));
          v['R1-F1']!.workspaceRef = { targetBranch: 'auto/other' };
        } else await reviewerDecides('skip')({ now, store });
      },
    });
    await h.start(); await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.ok(!h.calls.some((call) => call.startsWith('ha-finalize R1-F1')));
    assert.ok(!h.calls.some((call) => call.startsWith('finalize R1-F1')));
    assert.match(run.escalations[0]!.failure, /未合并/);
    assert.match(run.escalations[0]!.failure, /目标不符/);
    assert.match(run.escalations[0]!.failure, /auto\/other/);
    assert.equal(run.haReleases[0]?.decision?.kind, 'approve');
    assert.ok(h.calls.includes('abandon R1-F1 E-1'));
    assert.equal(run.feature('F2')?.status, 'merged');
  });

  test('approve 消费前已不在 pending_release：未合并，保留决定并走升级处置', async () => {
    const v = structuredClone(views);
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views: v,
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) {
          await store.update((run) => sign(run, now, 'approve'));
          v['R1-F1']!.haReviewHold = 'in_review';
        } else await reviewerDecides('skip')({ now, store });
      },
    });
    await h.start(); await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.ok(!h.calls.some((call) => call.startsWith('ha-finalize R1-F1')));
    assert.ok(!h.calls.some((call) => call.startsWith('finalize R1-F1')));
    assert.match(run.escalations[0]!.failure, /现状不符/);
    assert.match(run.escalations[0]!.failure, /未合并/);
    assert.equal(run.haReleases[0]?.decision?.kind, 'approve');
    assert.ok(h.calls.includes('abandon R1-F1 E-1'));
    assert.equal(run.feature('F2')?.status, 'merged');
  });

  test('Mission 已 completed：unsafe 停止且不派发后续', async () => {
    const v = structuredClone(views);
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views: v,
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) {
          await store.update((run) => sign(run, now, 'approve'));
          v['R1-F1']!.status = 'completed';
        }
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.equal(stop.reason, 'unsafe');
    assert.match(stop.detail, /已 completed/);
    assert.ok(!h.calls.some((call) => call.startsWith('ha-finalize R1-F1')));
    assert.equal(run.escalationsOpened, 0);
    assert.ok(!h.calls.some((call) => call.startsWith('abandon')));
    assert.equal(run.feature('F2')?.status, 'pending');
    assert.ok(!h.routed.includes('F2'));
  });

  test('HA 授权拒绝：开升级单并释放名额', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views,
      haFinalize: { 'R1-F1': new PlatformRuleError('HA_AUTHORITY_REVIEWER_UNREGISTERED', '检视者未登记') },
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) await store.update((run) => sign(run, now, 'approve'));
        else await reviewerDecides('skip')({ now, store });
      },
    });
    await h.start(); await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.equal(h.calls.filter((call) => call.startsWith('ha-finalize R1-F1')).length, 1);
    assert.match(run.escalations[0]!.failure, /被平台拒绝.*HA_AUTHORITY_REVIEWER_UNREGISTERED.*未合并/);
    assert.ok(h.calls.includes('abandon R1-F1 E-1'));
    assert.equal(run.feature('F2')?.status, 'merged');
  });

  test('HA 目标分支不符：unsafe 停止，不派发后续', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views,
      haFinalize: { 'R1-F1': new PlatformRuleError('HA_TARGET_MISMATCH', '当前 checkout 与 Mission 目标不一致') },
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) await store.update((run) => sign(run, now, 'approve'));
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'unsafe');
    assert.equal(h.calls.filter((call) => call.startsWith('ha-finalize R1-F1')).length, 1);
    assert.equal(h.store.read()!.escalationsOpened, 0);
    assert.ok(!h.calls.some((call) => call.startsWith('abandon')));
    assert.ok(!h.calls.includes('create R1-F2'));
  });

  test('HA 受控合入结果不明：unsafe 停止且不重试', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views,
      haFinalize: { 'R1-F1': new Error('进程被杀') },
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) await store.update((run) => sign(run, now, 'approve'));
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'unsafe');
    assert.match(stop.detail, /结果不明.*禁止自动重合/);
    assert.equal(h.calls.filter((call) => call.startsWith('ha-finalize R1-F1')).length, 1);
    assert.equal(h.store.read()!.escalationsOpened, 0);
    assert.ok(!h.calls.some((call) => call.startsWith('abandon')));
    assert.ok(!h.calls.includes('create R1-F2'));
  });

  test('HA 验证红且回滚成功：未标 merged，转升级处置', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views,
      haFinalize: { 'R1-F1': { status: 'awaiting_review', reportId: 'IVAL-R', reason: '集成验证未通过，已回滚', rolledBackTo: 'anchor0123456789' } },
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) await store.update((run) => sign(run, now, 'approve'));
        else await reviewerDecides('skip')({ now, store });
      },
    });
    await h.start(); await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.match(run.escalations[0]!.failure, /验证红了/);
    assert.match(run.escalations[0]!.failure, /anchor012345/);
    assert.match(run.escalations[0]!.failure, /R1-F1/);
    assert.match(run.escalations[0]!.failure, /未标 merged/);
    assert.notEqual(run.feature('F1')?.status, 'merged');
    assert.ok(h.calls.includes('abandon R1-F1 E-1'));
    assert.equal(run.feature('F2')?.status, 'merged');
  });

  function assertUnsafeWithoutAdvancing(h: ReturnType<typeof harness>, stop: Awaited<ReturnType<typeof drivePlan>>, detail: string) {
    assert.equal(stop.reason, 'unsafe');
    assert.match(stop.detail, new RegExp(detail));
    assert.equal(h.calls.filter((call) => call.startsWith('ha-finalize R1-F1')).length, 1);
    const run = h.store.read()!;
    assert.equal(run.escalationsOpened, 0);
    assert.ok(!h.calls.some((call) => call.startsWith('abandon')));
    assert.notEqual(run.feature('F1')?.status, 'merged');
    assert.equal(run.feature('F2')?.status, 'pending');
    assert.ok(!h.routed.includes('F2'));
  }

  test('HA 验证有报告但未回滚：unsafe 停止', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views,
      haFinalize: { 'R1-F1': { status: 'awaiting_review', reportId: 'IVAL-U', reason: 'HA 验证未通过且回滚失败，集成分支可能不安全。请人工核对锚点、当前 HEAD 与集成报告后再处置；禁止自动重合。' } },
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) await store.update((run) => sign(run, now, 'approve'));
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assertUnsafeWithoutAdvancing(h, stop, 'IVAL-U');
  });

  test('HA 持久 unsafe：禁止自动重合并停止', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views,
      haFinalize: { 'R1-F1': { status: 'awaiting_review', reason: 'HA 合并已落到目标分支但 Mission 未记完成。请人工核对锚点、当前 HEAD 与集成报告后再处置；禁止自动重合。' } },
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) await store.update((run) => sign(run, now, 'approve'));
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assertUnsafeWithoutAdvancing(h, stop, '禁止自动重合');
  });

  test('HA 合并失败：集成分支没动，开升级单', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views,
      haFinalize: { 'R1-F1': { status: 'awaiting_review', reason: '合并失败：CONFLICT (content)' } },
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) await store.update((run) => sign(run, now, 'approve'));
        else await reviewerDecides('skip')({ now, store });
      },
    });
    await h.start(); await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.match(run.escalations[0]!.failure, /HA 合并失败/);
    assert.match(run.escalations[0]!.failure, /CONFLICT/);
    assert.match(run.escalations[0]!.failure, /集成分支没动/);
    assert.ok(h.calls.includes('abandon R1-F1 E-1'));
    assert.equal(run.feature('F2')?.status, 'merged');
  });

  test('HA 报完成但缺 mergedInto：unsafe 停止', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views,
      haFinalize: { 'R1-F1': { status: 'completed' } },
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) await store.update((run) => sign(run, now, 'approve'));
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assertUnsafeWithoutAdvancing(h, stop, '缺 mergedInto');
  });

  test('HA 报完成但复核目标不符：unsafe 且不标 merged', async () => {
    const v = structuredClone(views);
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views: v,
      onHaFinalize: () => { v['R1-F1']!.workspaceRef = { targetBranch: 'auto/other' }; },
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) await store.update((run) => sign(run, now, 'approve'));
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assertUnsafeWithoutAdvancing(h, stop, '不匹配');
  });

  test('HA 合入后 markMerged 写入失败：记录 unsafe 并拒绝', async () => {
    let h!: ReturnType<typeof harness>;
    let thrown = false;
    h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views,
      beforeUpdate: async () => {
        if (!thrown && h.calls.some((call) => call.startsWith('ha-finalize R1-F1'))) {
          thrown = true;
          throw new Error('写盘失败');
        }
      },
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) await store.update((run) => sign(run, now, 'approve'));
      },
    });
    await h.start();
    await assert.rejects(drivePlan(h.plan, h.deps), /写盘失败/);
    const stop = h.store.read()!.stopped!;
    assert.equal(stop.reason, 'unsafe');
    assert.match(stop.detail, /HA 已合入 ha-merge-1/);
    assert.match(stop.detail, /禁止重合/);
    assert.equal(h.calls.filter((call) => call.startsWith('ha-finalize R1-F1')).length, 1);
    assert.notEqual(h.store.read()!.feature('F1')?.status, 'merged');
    assert.ok(!h.calls.includes('create R1-F2'));
  });

  test('合入前最后一次读取 pass 跨过墙钟：保留 approve 并停止', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views,
      wallClockMs: 40 * MIN,
      passTakesMs: [0, 15 * MIN],
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) await store.update((run) => sign(run, now, 'approve'));
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'wall_clock');
    assert.ok(!h.calls.some((call) => call.startsWith('ha-finalize R1-F1')));
    const run = h.store.read()!;
    assert.equal(run.haReleases[0]?.decision?.kind, 'approve');
    assert.equal(run.feature('F1')?.status, 'suspended');
    assert.match(run.feature('F1')?.needsDecision ?? '', /已有结论 approve/);
    assert.match(run.feature('F1')?.needsDecision ?? '', /没有合并/);
    assert.equal(run.escalationsOpened, 0);
    assert.ok(!h.calls.some((call) => call.startsWith('abandon')));
    assert.ok(!h.calls.includes('create R1-F2'));
  });

  test('打回后隔离重跑，第二条放行合入', { skip: 'HA 路暂时关闭（HAOFF1，2026-09-28），恢复 HA 分支时去掉 skip' }, async () => {
    const v = structuredClone(views);
    v['R1-F1-r2'] = {
      executionMode: 'high_assurance',
      haReviewHold: 'pending_release',
      workspaceRef: { targetBranch: 'auto/plan-x' },
      independentReviews: [{ reviewedCommit: 'cafe03', verdict: 'pass', reviewerAttemptId: 'IR-9', validationReportId: 'VR-r2' }],
    };
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views: v,
      onSleep: async ({ now, store }) => {
        const run = store.read()!;
        const pending = run.haReleases.find((release) => !release.decision);
        if (pending?.missionId === 'R1-F1') await store.update((current) => signPending(current, now, 'send_back', '补充证据'));
        else if (pending?.missionId === 'R1-F1-r2') await store.update((current) => signPending(current, now, 'approve'));
        await reviewerDecides('rerun_isolated')({ now, store });
      },
    });
    await h.start(); await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.ok(h.calls.includes('abandon R1-F1 E-1'));
    assert.ok(h.calls.includes('create-classified R1-F1-r2 high_assurance'));
    assert.equal(h.calls.filter((call) => call.startsWith('ha-finalize R1-F1-r2 by claude/human [node --test]')).length, 1);
    assert.ok(!h.calls.some((call) => call.startsWith('ha-finalize R1-F1 by')));
    assert.equal(run.feature('F1')?.status, 'merged');
    assert.equal(run.rerunsUsed('F1'), 1);
    assert.equal(run.escalationsOpened, 1);
    assert.deepEqual(run.haReleases.map((release) => release.decision?.kind), ['send_back', 'approve']);
    assert.equal(run.feature('F2')?.status, 'merged');
  });

  test('升级额已满时 HA send_back：不开第二张单并保留 HA Mission', async () => {
    const v: Record<string, HarnessView> = {
      'R1-F2': {
        executionMode: 'high_assurance',
        haReviewHold: 'pending_release',
        workspaceRef: { targetBranch: 'auto/plan-x' },
        independentReviews: [{
          reviewedCommit: 'feedface22',
          verdict: 'pass',
          reviewerAttemptId: 'IR-22',
          validationReportId: 'VR-22',
        }],
      },
    };
    const h = harness({
      features: ['F1', 'F2', 'F3'],
      routes: { F2: haRoute },
      views: v,
      maxEscalations: 1,
      finalize: { 'R1-F1': RED },
      onSleep: async ({ now, store }) => {
        const run = store.read()!;
        const pending = run.haReleases.find((release) => release.featureId === 'F2' && !release.decision);
        if (pending) {
          await store.update((current) => signPending(current, now, 'send_back', 'HA 证据需返工'));
        } else {
          await reviewerDecides('skip')({ now, store });
        }
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.equal(stop.reason, 'escalation_limit');
    assert.ok(h.calls.includes('finalize R1-F1 → auto/plan-x [node --test]'));
    assert.equal(run.escalations[0]?.resolution?.kind, 'decided');
    assert.equal(run.escalations[0]?.resolution?.kind === 'decided' ? run.escalations[0].resolution.action : undefined, 'skip');
    assert.equal(run.haReleases.find((release) => release.featureId === 'F2')?.decision?.kind, 'send_back');
    assert.equal(run.escalationsOpened, 1);
    assert.equal(run.escalations.length, 1);
    assert.equal(run.escalations[0]?.featureId, 'F1');
    assert.match(run.escalations[0]?.failure ?? '', /验证红/);
    assert.equal(run.feature('F2')?.status, 'suspended');
    assert.equal(h.status.get('R1-F2'), 'awaiting_review');
    assert.ok(!h.calls.some((call) => call.startsWith('abandon R1-F2')));
    assert.ok(!h.calls.some((call) => call.startsWith('ha-finalize R1-F2')));
    assert.ok(!h.calls.some((call) => call.startsWith('finalize R1-F2')));
    assert.equal(run.feature('F3')?.status, 'pending');
    assert.ok(!h.routed.includes('F3'));
    assert.ok(!h.calls.some((call) => call.includes('R1-F3')));
  });

  test('升级单额满：审批记录不计数，后续失败 Mission 保留', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views,
      maxEscalations: 1,
      finalize: { 'R1-F2': RED },
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) await store.update((run) => sign(run, now, 'send_back'));
        else await reviewerDecides('skip')({ now, store });
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.equal(stop.reason, 'escalation_limit');
    assert.equal(run.escalationsOpened, 1);
    assert.ok(!h.calls.some((call) => call.startsWith('abandon R1-F2')));
    assert.equal(run.feature('F2')?.status, 'suspended');
  });

  test('检视者叫停：失败 Mission 保留，后续功能不启动', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views,
      onSleep: async ({ now, store }) => {
        const release = store.read()?.haReleases[0];
        if (release && !release.decision) await store.update((run) => sign(run, now, 'send_back'));
        else await reviewerDecides('stop')({ now, store });
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.equal(stop.reason, 'reviewer_stop');
    assert.ok(!h.calls.some((call) => call.startsWith('abandon R1-F1')));
    assert.equal(h.status.get('R1-F1'), 'awaiting_review');
    assert.equal(run.feature('F2')?.status, 'pending');
    assert.ok(!h.calls.includes('create R1-F2'));
  });

  test('未解决到阈值：审批与升级单均过期后停止并保留 Mission', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views, unresolvedEscalations: 1 });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.equal(stop.reason, 'unresolved_escalations');
    assert.equal(run.haReleases[0]?.decision?.kind, 'expired');
    assert.ok(!h.calls.some((call) => call.startsWith('abandon')));
    assert.ok(!h.calls.includes('create R1-F2'));
  });

  test('HA send_back 后 rescope：放弃失败 Mission，再推进未删除功能', async () => {
    const h = harness({
      features: ['F1', 'F2', 'F3'],
      routes: { F1: haRoute },
      views,
      onSleep: async ({ now, store }) => {
        const run = store.read()!;
        const pending = run.haReleases.find((release) => release.featureId === 'F1' && !release.decision);
        if (pending) {
          await store.update((current) => signPending(current, now, 'send_back', '需要补充证据'));
        } else {
          await reviewerDecides('rescope', { dropFeatures: ['F3'] })({ now, store });
        }
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.equal(stop.reason, 'finished');
    assert.notEqual(run.feature('F1')?.status, 'merged');
    assert.equal(run.feature('F1')?.status, 'skipped');
    assert.equal(run.haReleases[0]?.decision?.kind, 'send_back');
    assert.equal(run.escalationsOpened, 1);
    assert.equal(run.escalations.length, 1);
    assert.equal(run.escalations[0]?.resolution?.kind, 'decided');
    assert.equal(run.escalations[0]?.resolution?.kind === 'decided' ? run.escalations[0].resolution.action : undefined, 'rescope');
    assert.equal(run.rerunsUsed('F1'), 0);
    const abandonAt = h.calls.indexOf('abandon R1-F1 E-1');
    const f2CreateAt = h.calls.indexOf('create R1-F2');
    assert.ok(abandonAt >= 0);
    assert.ok(f2CreateAt >= 0);
    assert.ok(abandonAt < f2CreateAt);
    assert.equal(run.feature('F2')?.status, 'merged');
    assert.equal(run.feature('F3')?.status, 'skipped');
    assert.ok(!h.routed.includes('F3'));
    assert.ok(!h.calls.some((call) => call.includes('R1-F3')));
  });

  test('打回转升级单，skip 后释放 Mission 名额', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views,
      onSleep: async ({ now, store }) => {
        const r = store.read()!;
        if (r.haReleases[0] && !r.haReleases[0].decision) await store.update((run) => sign(run, now, 'send_back'));
        await reviewerDecides('skip')({ now, store });
      },
    });
    await h.start();
    await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.equal(run.haReleases[0]?.decision?.kind, 'send_back');
    assert.equal(run.escalationsOpened, 1);
    assert.match(run.escalations[0]!.failure, /打回.*补充证据.*R1-F1/);
    assert.ok(h.calls.includes('abandon R1-F1 E-1'));
    assert.equal(run.feature('F2')?.status, 'merged');
    assert.ok(!h.calls.some((call) => call.startsWith('finalize R1-F1')));
  });

  test('记录失效转升级单，skip 后释放 Mission 名额', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views,
      onSleep: async ({ now, store }) => {
        const r = store.read()!;
        if (r.haReleases[0] && !r.haReleases[0].decision) await store.update((run) => run.invalidateHaRelease('F1', '证据撤销', now));
        await reviewerDecides('skip')({ now, store });
      },
    });
    await h.start();
    await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.match(run.escalations[0]!.failure, /失效.*证据撤销/);
    assert.ok(h.calls.includes('abandon R1-F1 E-1'));
    assert.equal(run.feature('F2')?.status, 'merged');
    assert.ok(!h.calls.some((call) => call.startsWith('finalize R1-F1')));
  });

  test('等待期间墙钟先到：保留待决记录和 Mission，不派发后续', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views, wallClockMs: 40 * MIN });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'wall_clock');
    const run = h.store.read()!;
    assert.equal(run.feature('F1')?.status, 'suspended');
    assert.match(run.feature('F1')?.needsDecision ?? '', /HA 待放行还没定/);
    assert.match(run.feature('F1')?.needsDecision ?? '', /不再生效/);
    assert.match(run.feature('F1')?.needsDecision ?? '', /R1-F1/);
    assert.equal(run.haReleases[0]?.decision, undefined);
    assert.equal(run.escalationsOpened, 0);
    assert.ok(!h.calls.some((c) => c.startsWith('abandon')));
    assert.equal(run.feature('F2')?.status, 'pending');
    assert.ok(!h.routed.includes('F2'));
  });

  test('墙钟先于决定：跨过墙钟时签字，保留决定但不处置', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views, wallClockMs: 40 * MIN,
      onSleep: async ({ now, store }) => {
        if (Date.parse(now) >= Date.parse(T0) + 40 * MIN) {
          const r = store.read()!;
          if (r.haReleases[0] && !r.haReleases[0].decision) await store.update((run) => sign(run, now, 'send_back'));
        }
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'wall_clock');
    const run = h.store.read()!;
    assert.equal(run.haReleases[0]?.decision?.kind, 'send_back');
    assert.equal(run.escalationsOpened, 0);
    assert.ok(!h.calls.some((c) => c.startsWith('abandon')));
    assert.match(run.feature('F1')?.needsDecision ?? '', /已有结论 send_back.*没有合并，也没开升级单.*不再生效/);
    assert.ok(!h.calls.some((call) => call.startsWith('finalize R1-F1')));
  });

  test('过期写入与截止前签字撞车：接受 send_back 并开升级单', async () => {
    let h!: ReturnType<typeof harness>;
    let signed = false;
    h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views,
      beforeUpdate: async ({ now, store }) => {
        const run = store.read()!;
        const release = run.haReleases[0];
        if (!signed && release && !release.decision && Date.parse(now) >= Date.parse(release.deadline)) {
          signed = true;
          await store.update((current) => sign(current, new Date(Date.parse(release.deadline) - 1).toISOString(), 'send_back'));
        }
      },
      onSleep: async ({ now, store }) => { await reviewerDecides('skip')({ now, store }); },
    });
    await h.start();
    await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.equal(run.haReleases[0]?.decision?.kind, 'send_back');
    assert.match(run.escalations[0]!.failure, /打回/);
    assert.ok(!h.calls.some((call) => call.startsWith('finalize R1-F1')));
  });

  test('没有有效 pass：不开审批记录，转升级单', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views,
      passes: { 'R1-F1': undefined }, onSleep: reviewerDecides('skip') });
    await h.start();
    await drivePlan(h.plan, h.deps);
    const run = h.store.read()!;
    assert.ok(h.passCalls.includes('R1-F1'));
    assert.equal(run.haReleases.length, 0);
    assert.match(run.escalations[0]!.failure, /没有当前有效的独立检视 pass.*R1-F1/);
    assert.ok(h.calls.includes('abandon R1-F1 E-1'));
    assert.equal(run.feature('F2')?.status, 'merged');
    assert.ok(!h.calls.some((call) => call.startsWith('finalize R1-F1')));
  });

  test('Mission 返回时墙钟已到：不开审批记录、不读取 pass、不升级', async () => {
    const h = harness({ features: ['F1', 'F2'], routes: { F1: haRoute }, views, wallClockMs: 25 * MIN });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'wall_clock');
    assert.deepEqual(h.passCalls, []);
    const run = h.store.read()!;
    assert.equal(run.haReleases.length, 0);
    assert.equal(run.escalationsOpened, 0);
    assert.ok(!h.calls.some((c) => c.startsWith('abandon')));
    assert.ok(!h.calls.some((call) => call.startsWith('finalize R1-F1')));
  });
});

describe('E4a HA 合格建单、待放行与拒绝回落', () => {

  test('HA 分类经 Standard 路径由机器终审合入且不开审批记录', async () => {
    const h = harness({ features: ['F1'], routes: { F1: haRoute } });
    await h.start();
    await drivePlan(h.plan, h.deps);
    assert.ok(h.calls.includes('create R1-F1'));
    assert.ok(!h.calls.includes('create-classified R1-F1 high_assurance'));
    assert.ok(h.calls.includes('finalize R1-F1 → auto/plan-x [node --test]'));
    assert.equal(h.store.read()!.feature('F1')?.status, 'merged');
    assert.equal(h.store.read()!.haReleases.length, 0);
    assert.equal(h.store.read()!.escalationsOpened, 0);
  });

  test('四项禁止副作用全 false 的 HA 用原始 facts 调 createClassifiedMission',
    { skip: 'HA 路暂时关闭（HAOFF1，2026-09-28），恢复 HA 分支时去掉 skip' }, async () => {
      const h = harness({
        features: ['F1'],
        routes: { F1: haRoute },
        views: {
          'R1-F1': {
            executionMode: 'high_assurance',
            haReviewHold: 'pending_release',
            independentReviews: [{
              reviewedCommit: 'abc123def',
              verdict: 'pass',
              reviewerAttemptId: 'IR-1',
              validationReportId: 'VR-9',
            }],
          },
        },
      });
      await h.start();
      const stop = await drivePlan(h.plan, h.deps);
      assert.equal(stop.reason, 'finished');
      assert.ok(h.calls.includes('create-classified R1-F1 high_assurance'));
      assert.deepEqual(h.classifiedFacts[0], HA_FACTS);
      assert.ok(!h.calls.includes('create R1-F1'));
    });

  test('HA 建单被平台拒绝时不回落 Standard，挂起并写明原因',
    { skip: 'HA 路暂时关闭（HAOFF1，2026-09-28），恢复 HA 分支时去掉 skip' }, async () => {
      const h = harness({
        features: ['F1', 'F2'],
        routes: { F1: haRoute },
        classifiedRejects: new PlatformRuleError('HA_SIDE_EFFECT_DENIED', '带外部副作用的 HA 一律拒绝'),
      });
      await h.start();
      const stop = await drivePlan(h.plan, h.deps);
      assert.equal(stop.reason, 'finished');
      assert.deepEqual(h.classifiedFacts[0], HA_FACTS);
      assert.ok(!h.calls.includes('create R1-F1'), '不得回落普通 Standard');
      assert.ok(!h.calls.includes('run R1-F1'));
      const f1 = h.store.read()!.feature('F1');
      assert.equal(f1?.status, 'suspended');
      assert.match(f1?.needsDecision ?? '', /不回落 Standard/);
      assert.match(f1?.needsDecision ?? '', /HA_SIDE_EFFECT_DENIED|外部副作用/);
      assert.ok(h.calls.includes('create R1-F2'), '挂起不阻塞后续');
    });

  test('pending_release：开审批记录绑定有效 pass 与方案验证摘要；等待期间功能 running、后续功能不分类不建单', async () => {
    let snapshot: PlanRun | undefined;
    let routedAtWait: string[] = [];
    let callsAtWait: string[] = [];
    let h!: ReturnType<typeof harness>;
    h = harness({
      features: ['F1', 'F2'],
      routes: { F1: haRoute },
      views: {
        'R1-F1': {
          executionMode: 'high_assurance',
          haReviewHold: 'pending_release',
          independentReviews: [{ reviewedCommit: 'deadbeef01', verdict: 'pass', reviewerAttemptId: 'IR-7', validationReportId: 'VR-ha' }],
        },
      },
      onSleep: async ({ store }) => {
        if (!snapshot) {
          snapshot = store.read();
          routedAtWait = [...h.routed];
          callsAtWait = [...h.calls];
        }
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'finished');
    const during = snapshot!;
    const release = during.haReleases[0]!;
    assert.equal(during.feature('F1')?.status, 'running');
    assert.equal(release.missionId, 'R1-F1');
    assert.equal(release.reviewedCommit, 'deadbeef01');
    assert.equal(release.attemptId, 'IR-7');
    assert.equal(release.validationReportId, 'VR-ha');
    assert.equal(release.reviewerId, 'claude');
    assert.equal(release.integrationBranch, 'auto/plan-x');
    assert.equal(Date.parse(release.deadline) - Date.parse(release.openedAt), 20 * MIN);
    assert.deepEqual(release.verification, [{ command: 'node --test', timeoutMs: 60_000 }]);
    assert.equal(during.feature('F2')?.status, 'pending');
    assert.ok(!routedAtWait.includes('F2'));
    assert.ok(!callsAtWait.includes('create R1-F2') && !callsAtWait.some((c) => c.includes('create-classified R1-F2')));
    assert.equal(during.escalations.length, 0);
    const run = h.store.read()!;
    assert.equal(run.haReleases[0]?.decision?.kind, 'expired');
    assert.equal(run.escalations.length, 1);
    assert.match(run.escalations[0]!.failure, /没人定/);
    assert.match(run.escalations[0]!.failure, /R1-F1/);
    assert.ok(!h.calls.some((c) => c.startsWith('finalize R1-F1')));
    assert.equal(run.escalations[0]?.resolution?.kind, 'expired');
    assert.equal(run.feature('F1')?.status, 'suspended');
    assert.ok(h.calls.some((c) => c.startsWith('abandon R1-F1')));
    assert.equal(run.feature('F2')?.status, 'merged');
  });

  test('HA fault：开升级单，计入 P1 总额',
    async () => {
      const h = harness({
        maxEscalations: 1,
        features: ['F1', 'F2', 'F3'],
        routes: { F1: haRoute },
        runs: {
          'R1-F1': {
            outcome: {
              kind: 'waiting',
              reason: 'waiting_l3',
              detail: 'HA 独立检视故障：没有独立检视发牌口或候选池。',
            },
            status: 'awaiting_review',
          },
        },
        finalize: { 'R1-F2': RED },
      });
      await h.start();
      const stop = await drivePlan(h.plan, h.deps);
      assert.equal(stop.reason, 'escalation_limit');
      const run = h.store.read()!;
      assert.equal(run.escalations.length, 1, 'HA 故障占用一张升级单，第二次失败到上限');
      assert.equal(run.escalations[0]?.missionId, 'R1-F1');
      assert.match(run.escalations[0]?.failure ?? '', /HA 独立检视故障/);
      assert.ok(!h.calls.some((c) => c.startsWith('finalize R1-F1')));
      assert.equal(run.feature('F2')?.status, 'suspended');
      assert.equal(run.feature('F3')?.status, 'pending');
      assert.equal(h.status.get('R1-F1'), 'blocked');
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
    assert.equal(e1.answerable, undefined);
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
    assert.equal(run.escalations[0].answerable, undefined);
    assert.match(run.escalations[1].failure, /要不要改公共接口/);
    assert.equal(run.escalations[1].answerable, true);
    assert.equal(run.escalations[1].question, '要不要改公共接口？');
    assert.equal(run.escalations[2].answerable, undefined);
    assert.ok(h.calls.includes('abandon R1-F1 E-1'));
    assert.ok(h.calls.includes('abandon R1-F2 E-2'), '可答复单选旧动作仍放弃');
    assert.ok(!h.calls.includes('abandon R1-F3 E-3'), '已经终结的不用再放弃');
    assert.ok(!h.calls.some((c) => c.startsWith('answer')), '旧动作不走 answerEscalation');
    assert.ok(!h.calls.some((c) => c.startsWith('finalize')), '没交卷的不走机器 L3');
  });
});

describe('协调者提问可答复续跑', () => {
  const QUESTION = '要不要改公共接口？';
  const ANSWER = '用现有接口，不要新 Mission';
  const ask = { outcome: { kind: 'awaiting_l3' as const, question: QUESTION }, status: 'planning' };
  const delivered = { outcome: { kind: 'awaiting_l3_review' as const }, status: 'awaiting_review' };

  test('首次 awaiting_l3 → E-1 可答复保存原问 → answerEscalation 恰好一次 → 同 missionId 续跑合入', async () => {
    const h = harness({
      features: ['F1'],
      runs: { 'R1-F1': [ask, delivered] },
      onSleep: reviewerDecides('answer', { answer: ANSWER }),
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'finished');
    const run = h.store.read()!;
    const e1 = run.escalations[0];
    assert.equal(e1.id, 'E-1');
    assert.equal(e1.answerable, true);
    assert.equal(e1.question, QUESTION);
    assert.equal(e1.resolution?.kind, 'decided');
    if (e1.resolution?.kind === 'decided') assert.equal(e1.resolution.action, 'answer');
    assert.deepEqual(
      h.calls.filter((c) => c.startsWith('answer ')),
      [`answer R1-F1 ${ANSWER}`],
    );
    assert.deepEqual(
      h.calls.filter((c) => c.startsWith('run ')),
      ['run R1-F1', 'run R1-F1'],
    );
    assert.ok(h.calls.includes('finalize R1-F1 → auto/plan-x [node --test]'));
    assert.ok(!h.calls.some((c) => c.startsWith('abandon')));
    assert.ok(!h.calls.some((c) => c.includes('R1-F1-r2')));
    assert.deepEqual(run.feature('F1')?.missionIds, ['R1-F1']);
    assert.equal(run.rerunsUsed('F1'), 0);
    assert.equal(run.feature('F1')?.status, 'merged');
    const answerAt = h.calls.indexOf(`answer R1-F1 ${ANSWER}`);
    const firstRun = h.calls.indexOf('run R1-F1');
    const secondRun = h.calls.indexOf('run R1-F1', firstRun + 1);
    assert.ok(firstRun < answerAt && answerAt < secondRun);
  });

  test('第二次提问开 E-2 可答复并计入上限；到上限停、不放弃', async () => {
    const h = harness({
      features: ['F1'],
      maxEscalations: 1,
      runs: { 'R1-F1': [ask, { outcome: { kind: 'awaiting_l3', question: '第二问：边界呢？' }, status: 'planning' }] },
      onSleep: reviewerDecides('answer', { answer: ANSWER }),
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'escalation_limit');
    const run = h.store.read()!;
    assert.equal(run.escalations.length, 1);
    assert.equal(run.escalations[0].answerable, true);
    assert.equal(run.escalations[0].question, QUESTION);
    assert.deepEqual(
      h.calls.filter((c) => c.startsWith('run ')),
      ['run R1-F1', 'run R1-F1'],
    );
    assert.equal(h.calls.filter((c) => c.startsWith('answer ')).length, 1);
    assert.ok(!h.calls.some((c) => c.startsWith('abandon')));
    assert.equal(run.feature('F1')?.status, 'suspended');
    assert.deepEqual(run.feature('F1')?.missionIds, ['R1-F1']);
    assert.equal(run.rerunsUsed('F1'), 0);
  });

  test('第二次提问编号递增；墙钟到后不再 runMission 也不答复', async () => {
    const h = harness({
      features: ['F1'],
      runs: {
        'R1-F1': [
          ask,
          { outcome: { kind: 'awaiting_l3', question: '第二问：边界呢？' }, status: 'planning' },
          delivered,
        ],
      },
      onSleep: reviewerDecides('answer', { answer: ANSWER }),
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'finished');
    const run = h.store.read()!;
    assert.equal(run.escalations.length, 2);
    assert.equal(run.escalations[0].id, 'E-1');
    assert.equal(run.escalations[1].id, 'E-2');
    assert.equal(run.escalations[0].answerable, true);
    assert.equal(run.escalations[1].answerable, true);
    assert.equal(run.escalations[1].question, '第二问：边界呢？');
    assert.equal(h.calls.filter((c) => c.startsWith('answer ')).length, 2);
    assert.deepEqual(
      h.calls.filter((c) => c.startsWith('run ')),
      ['run R1-F1', 'run R1-F1', 'run R1-F1'],
    );
    assert.equal(run.feature('F1')?.status, 'merged');
    assert.deepEqual(run.feature('F1')?.missionIds, ['R1-F1']);

    const clocked = harness({
      features: ['F1'],
      wallClockMs: 30 * MIN + 10_000,
      pollMs: 15_000,
      runs: { 'R1-F1': [ask, delivered] },
      onSleep: reviewerDecides('answer', { answer: ANSWER, after: 0 }),
    });
    await clocked.start();
    const clockStop = await drivePlan(clocked.plan, clocked.deps);
    assert.equal(clockStop.reason, 'wall_clock');
    assert.deepEqual(
      clocked.calls.filter((c) => c.startsWith('run ')),
      ['run R1-F1'],
    );
    assert.equal(clocked.calls.filter((c) => c.startsWith('answer ')).length, 0);
    assert.ok(!clocked.calls.some((c) => c.startsWith('abandon')));
  });

  test('可答复单过期仍 settle 放弃；合并验证失败不能答复', async () => {
    const expired = harness({
      features: ['F1', 'F2'],
      runs: { 'R1-F1': ask },
    });
    await expired.start();
    const stop = await drivePlan(expired.plan, expired.deps);
    assert.equal(stop.reason, 'finished');
    const run = expired.store.read()!;
    assert.equal(run.escalations[0].answerable, true);
    assert.equal(run.escalations[0].resolution?.kind, 'expired');
    assert.ok(expired.calls.includes('abandon R1-F1 E-1'));
    assert.ok(!expired.calls.some((c) => c.startsWith('answer')));
    assert.equal(run.feature('F1')?.status, 'suspended');
    assert.equal(run.feature('F2')?.status, 'merged');

    const red = harness({ finalize: { 'R1-F1': RED }, onSleep: reviewerDecides('skip') });
    await red.start();
    await drivePlan(red.plan, red.deps);
    assert.equal(red.store.read()!.escalations[0].answerable, undefined);
    assert.ok(!red.calls.some((c) => c.startsWith('answer')));
  });
});

describe('轻量 feature awaiting_l3 复用 AQ1 续跑', () => {
  test('带 workOrder 的 Fast Lane 提问、可答复升级、answer 决定、answerEscalation 恰好一次、同 missionId 交卷合入', async () => {
    const QUESTION = '快速通道执行者卡住：选 A 还是 B？';
    const ANSWER = '选 A：用现有接口，不要新 Mission';
    const ask = { outcome: { kind: 'awaiting_l3' as const, question: QUESTION }, status: 'planning' };
    const delivered = { outcome: { kind: 'awaiting_l3_review' as const }, status: 'awaiting_review' };
    const small = {
      goalUncertainty: 0, changeScope: 0, operationalRisk: 0, verificationDifficulty: 0,
      coordinationNeed: 0, recoveryDifficulty: 0, reasons: ['小'], decidedBy: 'coordinator' as const,
      assessedAt: T0,
    };
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
    const h = harness({
      features: ['F1'],
      routes: {
        F1: { ok: true, proposal: { facts: QUIET_FACTS, assessment: small, workOrder: order } },
      },
      runs: { 'R1-F1': [ask, delivered] },
      onSleep: reviewerDecides('answer', { answer: ANSWER }),
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'finished');
    const run = h.store.read()!;
    const e1 = run.escalations[0];
    assert.equal(e1.id, 'E-1');
    assert.equal(e1.answerable, true);
    assert.equal(e1.question, QUESTION);
    assert.equal(e1.resolution?.kind, 'decided');
    if (e1.resolution?.kind === 'decided') {
      assert.equal(e1.resolution.action, 'answer');
      assert.equal(e1.resolution.answer, ANSWER);
    }
    assert.deepEqual(
      h.calls.filter((c) => c.startsWith('create')),
      ['create-classified R1-F1 lightweight'],
    );
    assert.ok(!h.calls.some((c) => c === 'create R1-F1'), '不回落 Standard / Coordinator 路由');
    assert.ok(!h.calls.some((c) => c.includes('create-classified R1-F1 standard')));
    assert.deepEqual(
      h.calls.filter((c) => c.startsWith('answer ')),
      [`answer R1-F1 ${ANSWER}`],
    );
    assert.deepEqual(
      h.calls.filter((c) => c.startsWith('run ')),
      ['run R1-F1', 'run R1-F1'],
    );
    assert.ok(h.calls.includes('finalize R1-F1 → auto/plan-x [node --test]'));
    assert.ok(!h.calls.some((c) => c.startsWith('abandon')));
    assert.ok(!h.calls.some((c) => c.includes('R1-F1-r2')), '没有新 rerun mission');
    assert.deepEqual(run.feature('F1')?.missionIds, ['R1-F1']);
    assert.equal(run.rerunsUsed('F1'), 0);
    assert.equal(run.feature('F1')?.status, 'merged');
    const answerAt = h.calls.indexOf(`answer R1-F1 ${ANSWER}`);
    const firstRun = h.calls.indexOf('run R1-F1');
    const secondRun = h.calls.indexOf('run R1-F1', firstRun + 1);
    assert.ok(firstRun < answerAt && answerAt < secondRun);
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
    assert.match(stop.detail, /验证红|回滚失败/);
    assert.equal(h.store.read()!.escalations.length, 0);
    assert.equal(h.store.read()!.feature('F1')?.status, 'suspended');
    assert.ok(!h.calls.includes('create R1-F2'));
  });

  test('机器终审验证绿但目标被推进：报目标变更 unsafe，不误报验证红',
    async () => {
      const h = harness({
        finalize: {
          'R1-F1': {
            status: 'awaiting_review',
            reportId: 'IVAL-adv',
            reason: '集成验证期间目标被推进或 checkout 被切换，未放行',
          },
        },
      });
      await h.start();
      const stop = await drivePlan(h.plan, h.deps);
      assert.equal(stop.reason, 'unsafe');
      assert.match(stop.detail, /IVAL-adv/);
      assert.match(stop.detail, /被推进|被切走/);
      assert.doesNotMatch(stop.detail, /验证红/);
      assert.doesNotMatch(stop.detail, /回滚失败/);
      assert.equal(h.store.read()!.escalations.length, 0);
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

  test('跑着跑着到了墙钟（在途的被暂停）：不为它开单，直接停，功能挂起写明要你定什么', async () => {
    const h = harness({
      wallClockMs: 25 * MIN,
      runs: {
        'R1-F1': {
          outcome: { kind: 'waiting', reason: 'cancelled_by_user', detail: 'Mission 已被暂停，resume 之后重跑' },
          status: 'executing',
        },
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'wall_clock');
    const run = h.store.read()!;
    assert.equal(run.escalations.length, 0, '到点了，没人会在今晚定这张单');
    assert.equal(run.feature('F1')?.status, 'suspended');
    assert.match(run.feature('F1')?.needsDecision ?? '', /要你定/);
    assert.ok(!h.calls.some((c) => c.startsWith('abandon')), '停了就原样留给人');
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

describe('审查补上的边界', () => {
  test('检视者选「停」恰好撞上驱动方判过期：干净停下，不当崩溃往外抛', async () => {
    // 造出交错：驱动方读到单子还开着、到点去判过期的那一刻，检视者抢先在截止前
    // 1 毫秒写下了「停」。判过期会撞上 PLAN_RUN_STOPPED。
    const h = harness({
      finalize: { 'R1-F1': RED },
      beforeUpdate: async ({ now, store }) => {
        const open = store.read()?.currentEscalation;
        if (!open || Date.parse(now) < Date.parse(open.deadline)) return;
        const justBefore = new Date(Date.parse(open.deadline) - 1).toISOString();
        await store.update((run) =>
          run.choose(open.id, { action: 'stop', reason: '集成分支整体坏了', decidedBy: 'claude' }, justBefore),
        );
      },
    });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'reviewer_stop');
    assert.equal(h.store.read()!.unresolvedCount, 0);
  });

  test('等决定期间墙钟到点：直接停，不判过期、不放弃，功能挂起交给人', async () => {
    // Mission 跑 30 分钟后开单（第 50 分钟截止）；墙钟 40 分钟，等的时候就到了。
    const h = harness({ wallClockMs: 40 * MIN, finalize: { 'R1-F1': RED } });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'wall_clock');
    const run = h.store.read()!;
    assert.equal(run.unresolvedCount, 0, '墙钟到了不算检视者没来');
    assert.equal(run.escalations[0].resolution, undefined);
    assert.ok(!h.calls.some((c) => c.startsWith('abandon')));
    assert.match(run.feature('F1')?.needsDecision ?? '', /没人定/);
  });

  test('分类本身跑过了墙钟：不再建 Mission，功能保持没轮到', async () => {
    const h = harness({ wallClockMs: 10 * MIN, routeTakesMs: 12 * MIN });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'wall_clock');
    assert.deepEqual(h.calls, [], '一条 Mission 都不该建');
    assert.equal(h.store.read()!.feature('F1')?.status, 'pending');
  });

  test('分类员自己出错：回落 Standard 接着跑，不拖垮整晚', async () => {
    const h = harness({ proposeThrows: new Error('QueryRun 落盘 EPERM') });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'finished');
    assert.ok(h.calls.includes('create R1-F1'));
  });

  test('按分类建单被平台拒（工单不合法）：回落 Standard；别的错照抛', async () => {
    const { InvariantViolationError } = await import('../src/kernel/index.ts');
    const small = {
      goalUncertainty: 0, changeScope: 0, operationalRisk: 0, verificationDifficulty: 0,
      coordinationNeed: 0, recoveryDifficulty: 0, reasons: ['小'], decidedBy: 'coordinator' as const,
      assessedAt: T0,
    };
    const lightweight = {
      ok: true as const,
      proposal: {
        facts: QUIET_FACTS,
        assessment: small,
        workOrder: {
          objective: 'x', allowedScope: ['src/F1.ts'], requiredBehaviour: 'x', constraints: [],
          acceptance: ['x'], verification: ['x'], doNot: [], contextRefs: [],
        },
      },
    };
    const rejected = harness({
      features: ['F1'],
      routes: { F1: lightweight },
      classifiedRejects: new InvariantViolationError('INVALID_WORK_ORDER_VALIDATION', '工单不合法'),
    });
    await rejected.start();
    assert.equal((await drivePlan(rejected.plan, rejected.deps)).reason, 'finished');
    assert.ok(rejected.calls.includes('create R1-F1'), '回落老路建了 Standard');

    const broken = harness({ features: ['F1'], routes: { F1: lightweight }, classifiedRejects: new Error('磁盘满了') });
    await broken.start();
    await assert.rejects(() => drivePlan(broken.plan, broken.deps), /磁盘满了/);
    assert.equal(broken.store.read()!.stopped?.reason, 'crashed');
  });

  test('开跑前再核一次项目仓：分支被切走就停在 unsafe，不先花一整条 Mission 的钱', async () => {
    const h = harness({ repoProblems: { F2: ['项目仓现在在 master，不是 auto/plan-x。'] } });
    await h.start();
    const stop = await drivePlan(h.plan, h.deps);
    assert.equal(stop.reason, 'unsafe');
    assert.match(stop.detail, /master/);
    assert.ok(!h.calls.includes('create R1-F2'));
    assert.equal(h.store.read()!.feature('F1')?.status, 'merged');
  });
});

describe('资格筛选先于分类和建 Mission', () => {
  test('只把本仓、契约完整、依赖已 done 的候选交给驱动；排除项零次分类、零次建单', async () => {
    const plan = parsePlanSpec(
      {
        planId: 'PLAN-x',
        projectId: 'p',
        integrationBranch: 'auto/plan-x',
        intent: '无人值守推进',
        stopConditions: { unresolvedEscalations: 5, wallClockMs: 8 * 60 * MIN, escalationTimeoutMs: 20 * MIN },
        integrationVerification: [{ argv: ['node', '--test'], timeoutMs: 60_000 }],
        features: [
          { id: 'Done', title: '已合', why: 'w', allowedScope: ['a.ts'], acceptance: ['x'], status: 'done' },
          { id: 'Skip', title: '跳', why: 'w', status: 'skipped' },
          { id: 'Split', title: '父', why: 'w', status: 'split', childrenDone: '不据此完成' },
          {
            id: 'Ok',
            title: '可跑',
            why: 'w',
            allowedScope: ['src/Ok.ts'],
            acceptance: ['绿'],
            status: 'pending',
            dependsOn: ['Done'],
            routing: { ignore: true },
            workOrder: { objective: '不该决定资格' },
          },
          {
            id: 'NeedSplit',
            title: '等父',
            why: 'w',
            allowedScope: ['src/N.ts'],
            acceptance: ['绿'],
            status: 'pending',
            dependsOn: ['Split'],
          },
        ],
      },
      { reviewer: 'claude' },
    );
    const selection = selectPlanCandidates(plan, { projectRoot: 'C:/repo' });
    assert.deepEqual(selection.candidates.map((c) => c.id), ['Ok']);
    assert.ok(selection.exclusions.some((e) => e.featureId === 'NeedSplit' && /Split/.test(e.reason)));

    const h = harness({ features: selection.candidates.map((c) => c.id) });
    const proposeIds: string[] = [];
    const orig = h.deps.proposeRoute;
    h.deps.proposeRoute = async (feature) => {
      proposeIds.push(feature.id);
      return orig(feature);
    };
    await h.store.create(
      PlanRun.start({
        id: 'R1',
        planId: plan.planId,
        projectId: plan.projectId,
        integrationBranch: plan.integrationBranch,
        reviewer: plan.reviewer,
        stopConditions: plan.stopConditions,
        featureIds: selection.candidates.map((c) => c.id),
        startedAt: T0,
        sourceExclusions: selection.exclusions,
      }),
    );
    const stop = await drivePlan(plan, h.deps);
    assert.equal(stop.reason, 'finished');
    assert.deepEqual(proposeIds, ['Ok']);
    assert.equal(h.calls.filter((c) => c.startsWith('create')).length, 1);
    assert.ok(h.calls.includes('create R1-Ok'));
    assert.ok(!h.calls.some((c) => /Done|Skip|Split|NeedSplit/.test(c)));
    assert.equal(h.store.read()!.sourceExclusions?.length, selection.exclusions.length);
  });
});

describe('两道夜跑闸',
  () => {
    test('maxEscalations = 1：第二个失败不开单、不等待、不放弃；后面的功能不开跑',
      async () => {
        const h = harness({
          maxEscalations: 1,
          features: ['F1', 'F2', 'F3'],
          finalize: { 'R1-F1': RED, 'R1-F2': RED },
        });
        const origSleep = h.deps.sleep;
        let f2Ran = false;
        let sleptAfterF2 = false;
        const origRun = h.deps.runMission;
        h.deps.runMission = async (missionId, ctx) => {
          if (missionId.includes('F2')) f2Ran = true;
          return origRun(missionId, ctx);
        };
        h.deps.sleep = async (ms) => {
          if (f2Ran) sleptAfterF2 = true;
          return origSleep(ms);
        };
        await h.start();
        const stop = await drivePlan(h.plan, h.deps);
        assert.equal(stop.reason, 'escalation_limit');
        const run = h.store.read()!;
        assert.equal(run.escalations.length, 1);
        assert.equal(run.feature('F2')?.status, 'suspended');
        assert.match(run.feature('F2')?.needsDecision ?? '', /R1-F2/);
        assert.equal(run.feature('F3')?.status, 'pending');
        assert.ok(!h.calls.includes('abandon R1-F2 E-2'));
        assert.ok(!h.calls.some((c) => c.includes('R1-F3')));
        assert.equal(sleptAfterF2, false, '第二个失败后不等待决定');
        assert.equal(h.status.get('R1-F2'), 'awaiting_review', '失败 Mission 原样保留');
      });

    test('重跑额度用完后驱动方不替检视者改选',
      async () => {
        let rejected = 0;
        const h = harness({
          maxRerunsPerFeature: 1,
          features: ['F1'],
          finalize: { 'R1-F1': RED, 'R1-F1-r2': RED },
          onSleep: async ({ now, store }) => {
            const open = store.read()?.currentEscalation;
            if (!open) return;
            if (Date.parse(now) - Date.parse(open.openedAt) < 5 * MIN) return;
            // 真检视者到了截止就不再写决定：最后一次睡醒恰好落在截止时刻，那时再选只会撞上截止。
            if (Date.parse(now) >= Date.parse(open.deadline)) return;
            try {
              await store.update((run) =>
                run.choose(
                  open.id,
                  { action: 'rerun_isolated', reason: '再试一次', decidedBy: 'claude' },
                  now,
                ),
              );
            } catch (error) {
              if (error instanceof PlatformRuleError && error.code === 'RERUN_LIMIT_REACHED') {
                rejected += 1;
                return;
              }
              throw error;
            }
          },
        });
        await h.start();
        const stop = await drivePlan(h.plan, h.deps);
        assert.equal(stop.reason, 'finished');
        assert.ok(rejected > 0, '第二张单上确实选过 rerun 并被额度拒绝');
        const run = h.store.read()!;
        assert.equal(run.rerunsUsed('F1'), 1);
        assert.equal(run.escalations.length, 2);
        assert.equal(run.escalations[1].resolution?.kind, 'expired', '额度用尽后驱动方不改选，等到过期');
        assert.equal(run.feature('F1')?.status, 'suspended');
      });
  });

describe('注入式方案运行入口', () => {
  function mixedPlan(wallClockMs = 8 * 60 * MIN) {
    return parsePlanSpec(
      {
        planId: 'PLAN-x',
        projectId: 'p',
        integrationBranch: 'auto/plan-x',
        intent: '无人值守推进',
        stopConditions: { unresolvedEscalations: 5, wallClockMs, escalationTimeoutMs: 20 * MIN },
        integrationVerification: [{ argv: ['node', '--test'], timeoutMs: 60_000 }],
        features: [
          { id: 'Done', title: '已合', why: 'w', allowedScope: ['a.ts'], acceptance: ['x'], status: 'done' },
          { id: 'Skip', title: '跳', why: 'w', status: 'skipped' },
          {
            id: 'Beta',
            title: '先跑的候选',
            why: 'w',
            allowedScope: ['src/Beta.ts'],
            acceptance: ['绿'],
            status: 'pending',
          },
          {
            id: 'Alpha',
            title: '后跑的候选',
            why: 'w',
            allowedScope: ['src/Alpha.ts'],
            acceptance: ['绿'],
            status: 'pending',
          },
        ],
      },
      { reviewer: 'claude' },
    );
  }

  function injected(options?: {
    runQuery?: PlanRuntimeQuery;
    outcomes?: Record<string, MissionRunOutcome>;
    wallClockMs?: number;
    now?: () => string;
    startedAt?: string;
    sleep?: (ms: number) => Promise<void>;
    runMissionDelayMs?: number;
  }) {
    const plan = mixedPlan(options?.wallClockMs);
    const selection = selectPlanCandidates(plan, { projectRoot: 'C:/repo' });
    const dir = mkdtempSync(join(tmpdir(), 'coagent-plan-runtime-'));
    dirs.push(dir);
    const store = new FilePlanRunStore(join(dir, 'R1.json'));
    let clock = Date.parse(T0);
    const now = options?.now ?? (() => new Date(clock).toISOString());
    const calls: string[] = [];
    const events: string[] = [];
    const querySources: string[] = [];
    const runnerIds: string[] = [];
    const runnerRoots: string[] = [];
    const logs: string[] = [];
    const status = new Map<string, string>();

    const platform: PlanDriverDeps['platform'] = {
      createMission: async (input) => {
        calls.push(`create ${input.missionId}`);
        status.set(input.missionId, 'investigating');
        return { missionId: input.missionId };
      },
      createClassifiedMission: async (input) => {
        calls.push(`create-classified ${input.missionId}`);
        status.set(input.missionId!, 'investigating');
        return { missionId: input.missionId!, classification: undefined as never };
      },
      getMissionView: async (missionId) => ({ status: status.get(missionId) ?? 'unknown' }),
      finalizeMissionByMachine: async (missionId, input) => {
        calls.push(`finalize ${missionId} → ${input.integrationBranch}`);
        status.set(missionId, 'completed');
        return { status: 'completed', mergedInto: 'abc', reportId: 'IVAL-1' };
      },
      abandonMissionForPlan: async (missionId, input) => {
        calls.push(`abandon ${missionId} ${input.escalationId}`);
        status.set(missionId, 'blocked');
        return { status: 'blocked' };
      },
      answerEscalation: async (missionId, answer) => {
        calls.push(`answer ${missionId} ${answer}`);
        return { question: 'recorded', answer };
      },
      effectiveIndependentReviewPass: async () => undefined,
      finalizeMissionByHaAuthority: async () => ({ status: 'awaiting_review' }),
    };

    return {
      plan,
      selection,
      store,
      calls,
      events,
      querySources,
      runnerIds,
      logs,
      run: () =>
        runPlanOnPlatform(plan, selection, {
          store,
          projectRoot: 'C:/repo',
          platform,
          runId: 'R1',
          startedAt: options?.startedAt ?? T0,
          now,
          sleep: options?.sleep ?? (async (ms) => {
            clock += ms;
          }),
          log: (line) => logs.push(line),
          persist: async () => {
            events.push('persist');
          },
          pauseInFlight: async (missionId) => {
            events.push(`pause ${missionId}`);
          },
          ...(options?.runQuery !== undefined ? { runQuery: options.runQuery } : {}),
          runMission: async (missionId, opts) => {
            runnerIds.push(missionId);
            runnerRoots.push(opts.projectRoot);
            events.push(`run-start ${missionId}`);
            if (options?.runMissionDelayMs) {
              await new Promise((done) => setTimeout(done, options.runMissionDelayMs));
            }
            events.push(`run-end ${missionId}`);
            const outcome =
              options?.outcomes?.[missionId] ?? ({ kind: 'awaiting_l3_review' } satisfies MissionRunOutcome);
            return { outcome, hops: [], workspace: undefined as never };
          },
        }),
    };
  }

  type PlanRuntimeQuery = (input: {
    projectId: string;
    source: string;
    prompt: string;
    cwd: string;
  }) => Promise<RunQueryResult>;

  function failedQuery(sources: string[]): PlanRuntimeQuery {
    return async (input) => {
      sources.push(input.source);
      return {
        queryRunId: 'Q-fail',
        outcome: 'failed',
        record: { output: '', id: 'Q-fail' } as RunQueryResult['record'],
      };
    };
  }

  test('记录含候选源顺序/标题/排除项；非候选不分类不建 Mission；候选经 runner.run 并用其 outcome',
    async () => {
      const querySources: string[] = [];
      const h = injected({
        runQuery: failedQuery(querySources),
        outcomes: {
          'R1-Beta': { kind: 'awaiting_l3_review' },
          'R1-Alpha': { kind: 'stalled', reason: '注入的卡住' },
        },
      });
      const stop = await h.run();
      assert.equal(stop.reason, 'finished');
      const run = h.store.read()!;
      assert.deepEqual(
        run.features.map((f) => `${f.featureId}:${f.title}:${f.status}`),
        ['Beta:先跑的候选:merged', 'Alpha:后跑的候选:suspended'],
      );
      assert.ok(run.sourceExclusions?.some((e) => e.featureId === 'Done'));
      assert.ok(run.sourceExclusions?.some((e) => e.featureId === 'Skip'));
      assert.equal(run.sourceExclusions?.length, 2);
      assert.deepEqual(querySources, ['plan-run:R1:Beta', 'plan-run:R1:Alpha']);
      assert.deepEqual(h.runnerIds, ['R1-Beta', 'R1-Alpha']);
      assert.ok(h.calls.includes('create R1-Beta'));
      assert.ok(h.calls.includes('create R1-Alpha'));
      assert.ok(h.calls.includes('finalize R1-Beta → auto/plan-x'));
      assert.ok(!h.calls.some((c) => c.includes('finalize R1-Alpha')), 'stalled 的 outcome 不走机器终审');
      assert.ok(!h.calls.some((c) => /Done|Skip/.test(c)));
      assert.ok(!h.calls.some((c) => c.startsWith('create-classified')));
      assert.match(h.logs.join('\n'), /分类员没答上来/);
    });

  test('分类员不可用按原语义回落 Standard，不另建平台/锁/API',
    async () => {
      const h = injected();
      const stop = await h.run();
      assert.equal(stop.reason, 'finished');
      assert.ok(h.calls.includes('create R1-Beta'));
      assert.ok(h.calls.includes('create R1-Alpha'));
      assert.ok(!h.calls.some((c) => c.startsWith('create-classified')));
      assert.match(h.logs.join('\n'), /分类员不可用/);
      const src = readFileSync(join(import.meta.dirname, '..', 'src', 'application', 'plan-runtime.ts'), 'utf8');
      assert.match(src, /export async function runPlanOnPlatform/);
      assert.match(src, /drivePlan\(/);
      assert.match(src, /runWithDeadline/);
      assert.match(src, /buildRoutingPrompt/);
      assert.match(src, /parseRoutingProposal/);
      assert.doesNotMatch(src, /new Orchestrator/);
      assert.doesNotMatch(src, /createApi\s*\(/);
      assert.doesNotMatch(src, /listenLoopback/);
      assert.doesNotMatch(src, /acquireLock/);
      assert.doesNotMatch(src, /buildPersistentPlatform/);
      assert.doesNotMatch(src, /buildPgPlatform/);
      assert.match(
        src,
        /answerEscalation:\s*\(missionId, answer\) =>\s*persistAfter\(deps\.persist, deps\.platform\.answerEscalation\(missionId, answer\)\)/,
      );
    });

  test('到点调用暂停并持久化，run 后仍持久化',
    async () => {
      const startedAt = new Date().toISOString();
      const h = injected({
        startedAt,
        now: () => new Date().toISOString(),
        wallClockMs: 80,
        runMissionDelayMs: 250,
        outcomes: {
          'R1-Beta': { kind: 'waiting', reason: 'cancelled_by_user', detail: 'Mission 已被暂停，resume 之后重跑' },
        },
        sleep: async () => {},
      });
      const stop = await h.run();
      assert.equal(stop.reason, 'wall_clock');
      assert.ok(h.events.includes('pause R1-Beta'));
      const pauseAt = h.events.indexOf('pause R1-Beta');
      const runStart = h.events.indexOf('run-start R1-Beta');
      const runEnd = h.events.indexOf('run-end R1-Beta');
      assert.ok(runStart >= 0 && pauseAt > runStart, '到点发生在 Mission 在途');
      assert.ok(h.events.slice(pauseAt + 1).includes('persist'), '到点后持久化');
      assert.ok(h.events.lastIndexOf('persist') > runEnd, 'run 后仍持久化');
      assert.equal(h.runnerIds[0], 'R1-Beta');
    });
});
