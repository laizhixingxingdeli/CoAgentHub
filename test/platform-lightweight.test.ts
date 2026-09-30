/**
 * M3-B：Platform trusted Lightweight internals。
 *
 * 守住：
 *   - zero coordinator / Plan：恰好一个 frozen WorkItem
 *   - mutation slot 与 Standard 同规则；PRE_DISPATCH shadow observational（无 attemptId）
 *   - validation.commands 可缺省/空（只跑 changed-paths）
 *   - 复用 startExecutorAttempt / submitEvidence / submitExecutionResult / finishAttempt
 *   - persist ValidationReport **before** accept；failed 保持 submitted
 *   - Standard create/dispatch/review 顺序与门禁不变
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform, PlatformRuleError } from '../src/application/platform.ts';
import {
  ValidationEngine,
  VALIDATION_POLICY_REVISION,
  type ValidationEngineResult,
  type ValidationInput,
} from '../src/application/validation/engine.ts';
import {
  InMemoryValidationReportRepository,
  ValidationReportConflictError,
  type ValidationReportRepository,
} from '../src/application/validation/report-repository.ts';
import type {
  ChangedPathReader,
  CommandRunner,
  DiffFactReader,
} from '../src/application/validation/ports.ts';
import type {
  DecisionAnswerSet,
  DecisionHook,
  DecisionProvider,
  DecisionRequest,
} from '../src/application/ports.ts';
import type {
  MissionContract,
  ReviewAuthority,
  ValidationReport,
  WorkOrder,
} from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: ['不加依赖'],
  nonGoals: ['不重构 Y'],
  guardrails: ['不得改 Contract'],
};

const ORDER_BASE: WorkOrder = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
};

const ORDER_WITH_VALIDATION: WorkOrder = {
  ...ORDER_BASE,
  validation: {
    commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }],
  },
};

const PLAN = {
  findings: '查到了',
  rejectedHypotheses: [] as string[],
  decisions: [] as string[],
  direction: '这么改',
  risks: [] as string[],
};

function fakeRunner(
  impl: CommandRunner['run'] = async () => ({
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    output: 'ok',
  }),
): CommandRunner & { calls: Parameters<CommandRunner['run']>[0][] } {
  const calls: Parameters<CommandRunner['run']>[0][] = [];
  return {
    calls,
    async run(input) {
      calls.push(input);
      return impl(input);
    },
  };
}

function fakePaths(
  files: readonly string[] = [],
): ChangedPathReader {
  return {
    async listChanged() {
      return files;
    },
  };
}

function spyReports(
  inner: ValidationReportRepository = new InMemoryValidationReportRepository(),
): ValidationReportRepository & {
  saves: ValidationReport[];
  saveOrder: string[];
} {
  const saves: ValidationReport[] = [];
  const saveOrder: string[] = [];
  return {
    saves,
    saveOrder,
    async save(report) {
      saveOrder.push('save');
      saves.push(report);
      await inner.save(report);
    },
    async get(id) {
      return inner.get(id);
    },
  };
}

function makeEngine(opts?: {
  runner?: CommandRunner;
  paths?: ChangedPathReader;
  diffFacts?: DiffFactReader;
  clock?: FixedClock;
  ids?: SequentialIds;
}): ValidationEngine {
  return new ValidationEngine({
    clock: opts?.clock ?? new FixedClock('2026-06-01T12:00:00.000Z'),
    ids: opts?.ids ?? new SequentialIds(),
    commandRunner: opts?.runner ?? fakeRunner(),
    changedPathReader: opts?.paths ?? fakePaths([]),
    ...(opts?.diffFacts ? { diffFactReader: opts.diffFacts } : {}),
  });
}

function harness(opts?: {
  validation?: {
    engine: Pick<ValidationEngine, 'validate'>;
    reports: ValidationReportRepository;
  };
  decisionProvider?: DecisionProvider;
  /** 注入 provider 时跑哪些钩子。这组测的就是 PRE shadow，缺省显式开 PRE（J1 之后平台缺省不开）。 */
  decisionHooks?: ReadonlySet<DecisionHook>;
  runner?: CommandRunner;
  paths?: ChangedPathReader;
  diffFacts?: DiffFactReader;
  withRealValidation?: boolean;
}) {
  const clock = new FixedClock('2026-06-01T12:00:00.000Z');
  const activity = new InMemoryActivityLog(clock);
  const projects = new InMemoryProjectRepository();
  const ids = new SequentialIds();
  const reports = spyReports();
  const runner = opts?.runner ?? fakeRunner();
  const paths = opts?.paths ?? fakePaths([]);
  const engine = makeEngine({
    runner,
    paths,
    diffFacts: opts?.diffFacts,
    clock,
    ids: new SequentialIds(),
  });

  const validation =
    opts?.validation ??
    (opts?.withRealValidation === false
      ? undefined
      : { engine, reports });

  const platform = new Platform({
    projects,
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    activity,
    clock,
    ids,
    ...(opts?.decisionProvider
      ? {
          decisionProvider: opts.decisionProvider,
          decisionHooks: opts.decisionHooks ?? new Set<DecisionHook>(['PRE_DISPATCH']),
        }
      : {}),
    ...(validation ? { validation } : {}),
  });

  return { platform, activity, projects, ids, clock, reports, runner, engine, validation };
}

async function createLightweightMission(
  projects: InMemoryProjectRepository,
  opts: {
    projectId?: string;
    missionId?: string;
    executionMode?: 'lightweight' | 'standard' | 'high_assurance';
    runKind?: 'mutation' | 'query';
    contract?: MissionContract;
  } = {},
): Promise<{ projectId: string; missionId: string }> {
  const projectId = opts.projectId ?? 'P';
  const missionId = opts.missionId ?? 'M-lw';
  const project = await projects.ensure(projectId);
  project.createMission({
    id: missionId,
    contract: opts.contract ?? CONTRACT,
    executionMode: opts.executionMode ?? 'lightweight',
    runKind: opts.runKind ?? 'mutation',
  });
  await projects.save(project);
  return { projectId, missionId };
}

async function liveItem(
  projects: InMemoryProjectRepository,
  projectId: string,
  missionId: string,
  workItemId: string,
) {
  const project = await projects.get(projectId);
  assert.ok(project);
  const mission = project.missions.find((m) => m.id === missionId);
  assert.ok(mission);
  const item = mission.workItem(workItemId);
  assert.ok(item);
  return { project, mission, item };
}

async function upToSubmittedLightweight(
  h: ReturnType<typeof harness>,
  opts: { order?: WorkOrder; cwdReady?: boolean } = {},
) {
  const { missionId, projectId } = await createLightweightMission(h.projects);
  const order = opts.order ?? ORDER_WITH_VALIDATION;
  const { workItemId } = await h.platform.createLightweightWorkItem(missionId, { order });
  await h.platform.dispatchLightweightWorkItem(missionId, workItemId);

  if (opts.cwdReady !== false) {
    await h.platform.recordWorkspace(missionId, {
      projectRoot: '/proj',
      branch: `mission/${missionId}`,
      baseRevision: 'base-rev-1',
    });
  }

  const { attemptId: exec } = await h.platform.startExecutorAttempt(missionId, workItemId);
  await h.platform.submitEvidence(missionId, exec, {
    kind: 'test',
    summary: 'node --test 全绿',
    command: 'node --test',
    exitCode: 0,
  });
  await h.platform.submitExecutionResult(missionId, exec, {
    outcome: 'completed',
    summary: '改好了',
    changedFiles: ['src/foo.ts'],
    evidenceIds: [],
    notes: '无',
  });
  await h.platform.finishAttempt(missionId, exec, { endedBy: 'structured_submit' });

  return { missionId, projectId, workItemId, exec };
}

function codeOf(e: unknown): string | undefined {
  return (e as PlatformRuleError | undefined)?.code;
}

describe('Platform.createLightweightWorkItem', () => {
  test('lightweight+mutation 无 Plan/Coordinator 即成功；WorkOrder frozen；coordinatorAttempts===0', async () => {
    const h = harness({ withRealValidation: false });
    const { missionId, projectId } = await createLightweightMission(h.projects);

    const { workItemId } = await h.platform.createLightweightWorkItem(missionId, {
      order: ORDER_WITH_VALIDATION,
    });

    const { mission, item } = await liveItem(h.projects, projectId, missionId, workItemId);
    assert.equal(mission.coordinatorAttempts.length, 0);
    assert.equal(mission.planRevision, 0);
    assert.equal(mission.plan, undefined);
    assert.equal(mission.workItems.length, 1);
    assert.equal(item.status, 'created');
    assert.equal(item.title, ORDER_WITH_VALIDATION.objective);
    assert.ok(item.order);
    assert.ok(Object.isFrozen(item.order));
    assert.ok(Object.isFrozen(item.order!.validation));
    assert.ok(Object.isFrozen(item.order!.validation!.commands));
    assert.equal(mission.status, 'investigating');
    assert.equal(mission.isMutating, false);

    const events = await h.activity.list(missionId);
    const created = events.filter((e) => e.kind === 'work_item.created');
    assert.equal(created.length, 1);
    assert.equal(created[0]?.attemptId, undefined);
    assert.equal((created[0]?.data as { executionMode?: string }).executionMode, 'lightweight');
  });

  test('title 可显式传入；第二个 item / standard / query / 错误 state 拒绝', async () => {
    const h = harness({ withRealValidation: false });

    // second item
    {
      const { missionId } = await createLightweightMission(h.projects, { missionId: 'M-2' });
      await h.platform.createLightweightWorkItem(missionId, {
        order: ORDER_WITH_VALIDATION,
        title: 'custom',
        workItemId: 'W-a',
      });
      const { item } = await liveItem(h.projects, 'P', missionId, 'W-a');
      assert.equal(item.title, 'custom');
      await assert.rejects(
        () =>
          h.platform.createLightweightWorkItem(missionId, {
            order: ORDER_WITH_VALIDATION,
            workItemId: 'W-b',
          }),
        (e: unknown) => codeOf(e) === 'LIGHTWEIGHT_SINGLE_WORK_ITEM',
      );
    }

    // standard mode
    {
      const { missionId } = await createLightweightMission(h.projects, {
        missionId: 'M-std',
        executionMode: 'standard',
      });
      await assert.rejects(
        () =>
          h.platform.createLightweightWorkItem(missionId, { order: ORDER_WITH_VALIDATION }),
        (e: unknown) => codeOf(e) === 'LIGHTWEIGHT_MODE_REQUIRED',
      );
    }

    // query runKind
    {
      const { missionId } = await createLightweightMission(h.projects, {
        missionId: 'M-q',
        runKind: 'query',
      });
      await assert.rejects(
        () =>
          h.platform.createLightweightWorkItem(missionId, { order: ORDER_WITH_VALIDATION }),
        (e: unknown) => codeOf(e) === 'LIGHTWEIGHT_RUN_KIND_REQUIRED',
      );
    }

    // coordinator already started
    {
      const { missionId } = await createLightweightMission(h.projects, { missionId: 'M-coord' });
      await h.platform.startCoordinatorAttempt(missionId);
      await assert.rejects(
        () =>
          h.platform.createLightweightWorkItem(missionId, { order: ORDER_WITH_VALIDATION }),
        (e: unknown) => codeOf(e) === 'LIGHTWEIGHT_COORDINATOR_FORBIDDEN',
      );
    }

    // wrong status (executing)
    {
      const { missionId, projectId } = await createLightweightMission(h.projects, {
        missionId: 'M-exec',
      });
      const project = await h.projects.get(projectId);
      const target = project!.missions.find((m) => m.id === missionId);
      assert.ok(target);
      target.startExecuting();
      await assert.rejects(
        () =>
          h.platform.createLightweightWorkItem(missionId, { order: ORDER_WITH_VALIDATION }),
        (e: unknown) => codeOf(e) === 'LIGHTWEIGHT_BAD_STATUS',
      );
    }
  });

  test('planning 状态允许 create；missing validation / empty commands 合法', async () => {
    const h = harness({ withRealValidation: false });

    // planning create success
    {
      const { missionId, projectId } = await createLightweightMission(h.projects, {
        missionId: 'M-plan',
      });
      const project = await h.projects.get(projectId);
      const target = project!.missions.find((m) => m.id === missionId);
      assert.ok(target);
      target.startPlanning();
      assert.equal(target.status, 'planning');

      const { workItemId } = await h.platform.createLightweightWorkItem(missionId, {
        order: ORDER_WITH_VALIDATION,
      });
      const { mission, item } = await liveItem(h.projects, projectId, missionId, workItemId);
      assert.equal(mission.status, 'planning');
      assert.equal(mission.coordinatorAttempts.length, 0);
      assert.equal(item.status, 'created');
      assert.ok(Object.isFrozen(item.order));
    }

    // missing validation
    {
      const { missionId, projectId } = await createLightweightMission(h.projects, {
        missionId: 'M-nov',
      });
      const { workItemId } = await h.platform.createLightweightWorkItem(missionId, {
        order: ORDER_BASE,
      });
      const { item } = await liveItem(h.projects, projectId, missionId, workItemId);
      assert.equal(item.order?.validation, undefined);
      assert.ok(Object.isFrozen(item.order));
    }

    // empty commands
    {
      const { missionId, projectId } = await createLightweightMission(h.projects, {
        missionId: 'M-empty-cmd',
      });
      const { workItemId } = await h.platform.createLightweightWorkItem(missionId, {
        order: { ...ORDER_BASE, validation: { commands: [] } },
      });
      const { item } = await liveItem(h.projects, projectId, missionId, workItemId);
      assert.ok(item.order?.validation);
      assert.deepEqual(item.order!.validation!.commands, []);
      assert.ok(Object.isFrozen(item.order!.validation));
      assert.ok(Object.isFrozen(item.order!.validation!.commands));
    }
  });
});

describe('Platform.dispatchLightweightWorkItem', () => {
  test('占 Project mutation slot；coordinatorAttempts 仍 0；PRE_DISPATCH shadow 无 attemptId 且不阻断', async () => {
    const sink: { calls: number; requests: DecisionRequest[] } = { calls: 0, requests: [] };
    const provider: DecisionProvider = {
      kind: 'capture',
      async decide(request: DecisionRequest): Promise<DecisionAnswerSet> {
        sink.calls += 1;
        sink.requests.push(request);
        return { answers: {} };
      },
    };
    const h = harness({ decisionProvider: provider, withRealValidation: false });
    const { missionId, projectId } = await createLightweightMission(h.projects);
    const { workItemId } = await h.platform.createLightweightWorkItem(missionId, {
      order: ORDER_WITH_VALIDATION,
    });

    const result = await h.platform.dispatchLightweightWorkItem(missionId, workItemId);
    assert.deepEqual(result, { dispatched: workItemId });

    const { mission, item } = await liveItem(h.projects, projectId, missionId, workItemId);
    assert.equal(mission.status, 'executing');
    assert.equal(mission.isMutating, true);
    assert.equal(mission.coordinatorAttempts.length, 0);
    assert.equal(item.status, 'dispatched');
    assert.equal(sink.calls, 1, 'Lightweight 应 observational 调用一次 PRE_DISPATCH decide');
    assert.equal(sink.requests[0]?.attemptId, undefined, '不得伪造 Coordinator attemptId');
    assert.equal(sink.requests[0]?.workItemId, workItemId);
    assert.equal(sink.requests[0]?.hook, 'PRE_DISPATCH');
    assert.equal(sink.requests[0]?.missionId, missionId);

    const events = await h.activity.list(missionId);
    const shadows = events.filter((e) => e.kind === 'decision.shadow');
    assert.equal(shadows.length, 1);
    assert.equal(shadows[0]?.attemptId, undefined);
    const shadowIds = (shadows[0]?.data as {
      ids?: { attemptId?: string; workItemId?: string; workItemIds?: string[] };
    }).ids;
    assert.equal(shadowIds?.attemptId, undefined);
    assert.equal(shadowIds?.workItemId, workItemId);
    assert.deepEqual(shadowIds?.workItemIds, [workItemId]);
    const dispatched = events.filter((e) => e.kind === 'work_item.dispatched');
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]?.attemptId, undefined);
  });

  test('PRE 没开（J1 缺省）：Lightweight 派发照常，0 次 decide、0 条 decision.shadow', async () => {
    const sink = { calls: 0 };
    const provider: DecisionProvider = {
      kind: 'count',
      async decide(): Promise<DecisionAnswerSet> {
        sink.calls += 1;
        return { answers: {} };
      },
    };
    const h = harness({
      decisionProvider: provider,
      decisionHooks: new Set<DecisionHook>(['POST_EXECUTION']),
      withRealValidation: false,
    });
    const { missionId } = await createLightweightMission(h.projects);
    const { workItemId } = await h.platform.createLightweightWorkItem(missionId, { order: ORDER_WITH_VALIDATION });
    assert.deepEqual(await h.platform.dispatchLightweightWorkItem(missionId, workItemId), { dispatched: workItemId });
    assert.equal(sink.calls, 0);
    assert.equal((await h.activity.list(missionId)).filter((e) => e.kind === 'decision.shadow').length, 0);
  });

  test('provider 失败仍 dispatch；不创建 Coordinator Attempt', async () => {
    const provider: DecisionProvider = {
      kind: 'boom',
      async decide(): Promise<DecisionAnswerSet> {
        throw new Error('shadow provider boom');
      },
    };
    const h = harness({ decisionProvider: provider, withRealValidation: false });
    const { missionId, projectId } = await createLightweightMission(h.projects, {
      missionId: 'M-shadow-fail',
    });
    const { workItemId } = await h.platform.createLightweightWorkItem(missionId, {
      order: ORDER_WITH_VALIDATION,
    });

    const result = await h.platform.dispatchLightweightWorkItem(missionId, workItemId);
    assert.deepEqual(result, { dispatched: workItemId });

    const { mission, item } = await liveItem(h.projects, projectId, missionId, workItemId);
    assert.equal(item.status, 'dispatched');
    assert.equal(mission.coordinatorAttempts.length, 0);
    assert.equal(mission.status, 'executing');

    const events = await h.activity.list(missionId);
    const shadows = events.filter((e) => e.kind === 'decision.shadow');
    assert.equal(shadows.length, 1);
    assert.equal((shadows[0]?.data as { quality?: string }).quality, 'provider_error');
  });

  test('同 Project 另一 mutating Mission 时 PROJECT_BUSY', async () => {
    const h = harness({ withRealValidation: false });
    const project = await h.projects.ensure('P');
    // holder occupies slot
    const holder = project.createMission({
      id: 'M-holder',
      contract: CONTRACT,
      executionMode: 'standard',
      runKind: 'mutation',
    });
    holder.startExecuting();
    project.createMission({
      id: 'M-lw',
      contract: CONTRACT,
      executionMode: 'lightweight',
      runKind: 'mutation',
    });
    await h.projects.save(project);

    const { workItemId } = await h.platform.createLightweightWorkItem('M-lw', {
      order: ORDER_WITH_VALIDATION,
    });
    await assert.rejects(
      () => h.platform.dispatchLightweightWorkItem('M-lw', workItemId),
      (e: unknown) => codeOf(e) === 'PROJECT_BUSY',
    );

    const { mission, item } = await liveItem(h.projects, 'P', 'M-lw', workItemId);
    assert.equal(item.status, 'created', 'PROJECT_BUSY 不得留下半套 dispatch');
    assert.equal(mission.isMutating, false);
    assert.equal(mission.waitReason, 'project_busy');
  });
});

describe('Lightweight executor path → submitted', () => {
  test('复用现有 executor methods 跑到 submitted；submittedAttemptId 等于实际 Executor Attempt', async () => {
    const h = harness({ withRealValidation: false });
    const { missionId, projectId, workItemId, exec } = await upToSubmittedLightweight(h);

    const { mission, item } = await liveItem(h.projects, projectId, missionId, workItemId);
    assert.equal(item.status, 'submitted');
    assert.equal(item.submittedAttemptId, exec);
    assert.equal(mission.coordinatorAttempts.length, 0);
    assert.equal(item.reviews.length, 0);
  });
});

describe('Platform.validateAndAcceptLightweightWorkItem', () => {
  test('validator pass：真实 ValidationEngine；save 完成后才 review accepted；ReviewRecord 无 attemptId', async () => {
    const runner = fakeRunner(async () => ({
      exitCode: 0,
      timedOut: false,
      durationMs: 5,
      output: 'pass',
    }));
    const paths = fakePaths(['src/foo.ts']);
    const innerReports = new InMemoryValidationReportRepository();
    let acceptedBeforeSave = false;
    let itemStatusAtSave: string | undefined;
    const reports: ValidationReportRepository & { saves: ValidationReport[] } = {
      saves: [],
      async save(report) {
        // spy: 此时 item 仍必须是 submitted
        const project = await projectsRef.get('P');
        const mission = project!.missions.find((m) => m.id === 'M-lw')!;
        const item = mission.workItems[0]!;
        itemStatusAtSave = item.status;
        if (item.status === 'accepted') acceptedBeforeSave = true;
        this.saves.push(report);
        await innerReports.save(report);
      },
      async get(id) {
        return innerReports.get(id);
      },
    };

    const clock = new FixedClock('2026-06-01T12:00:00.000Z');
    const activity = new InMemoryActivityLog(clock);
    const projectsRef = new InMemoryProjectRepository();
    const ids = new SequentialIds();
    const engine = makeEngine({
      runner,
      paths,
      clock,
      ids: new SequentialIds(),
    });
    const platform = new Platform({
      projects: projectsRef,
      deliveries: new InMemoryDeliveryRepository(clock, ids),
      activity,
      clock,
      ids,
      validation: { engine, reports },
    });

    const { missionId } = await createLightweightMission(projectsRef, { missionId: 'M-lw' });
    const { workItemId } = await platform.createLightweightWorkItem(missionId, {
      order: ORDER_WITH_VALIDATION,
    });
    await platform.dispatchLightweightWorkItem(missionId, workItemId);
    await platform.recordWorkspace(missionId, {
      projectRoot: '/proj',
      branch: `mission/${missionId}`,
      baseRevision: 'base-rev-1',
    });
    const { attemptId: exec } = await platform.startExecutorAttempt(missionId, workItemId);
    await platform.submitEvidence(missionId, exec, {
      kind: 'test',
      summary: 'ok',
      command: 'node --test',
      exitCode: 0,
    });
    await platform.submitExecutionResult(missionId, exec, {
      outcome: 'completed',
      summary: 'done',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: '',
    });

    const out = await platform.validateAndAcceptLightweightWorkItem({
      missionId,
      workItemId,
      cwd: '/trusted/cwd',
    });

    assert.equal(out.passed, true);
    assert.equal(out.status, 'accepted');
    assert.equal(acceptedBeforeSave, false, '不得在 save 之前 accept');
    assert.equal(itemStatusAtSave, 'submitted');
    assert.equal(reports.saves.length, 1);
    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0]?.cwd, '/trusted/cwd', 'cwd 必须强制覆盖为 trusted input.cwd');

    const stored = await innerReports.get(out.reportId);
    assert.ok(stored);
    assert.equal(stored.passed, true);
    assert.equal(stored.missionId, missionId);
    assert.equal(stored.workItemId, workItemId);
    assert.equal(stored.attemptId, exec);

    const { item, mission } = await liveItem(projectsRef, 'P', missionId, workItemId);
    assert.equal(item.status, 'accepted');
    assert.equal(item.reviews.length, 1);
    const review = item.reviews[0]!;
    assert.equal(review.verdict, 'accept');
    assert.equal(review.attemptId, undefined, 'validator ReviewRecord 不得伪造 coordinator attemptId');
    assert.equal(review.submittedAttemptId, exec);
    assert.ok(review.authority);
    assert.equal(review.authority!.kind, 'validator');
    assert.equal(
      (review.authority as Extract<ReviewAuthority, { kind: 'validator' }>).reportId,
      out.reportId,
    );
    assert.equal(
      (review.authority as Extract<ReviewAuthority, { kind: 'validator' }>).policyRevision,
      VALIDATION_POLICY_REVISION,
    );
    assert.equal(mission.coordinatorAttempts.length, 0);

    const events = await activity.list(missionId);
    const reported = events.filter((e) => e.kind === 'validation.reported');
    assert.equal(reported.length, 1);
    assert.equal(reported[0]?.attemptId, undefined);
    assert.deepEqual(
      {
        reportId: (reported[0]?.data as { reportId: string }).reportId,
        passed: (reported[0]?.data as { passed: boolean }).passed,
        submittedAttemptId: (reported[0]?.data as { submittedAttemptId: string }).submittedAttemptId,
      },
      { reportId: out.reportId, passed: true, submittedAttemptId: exec },
    );
    assert.equal(events.filter((e) => e.kind === 'validation.completed').length, 0);
    const reviewed = events.filter((e) => e.kind === 'review.recorded');
    assert.equal(reviewed.length, 1);
    assert.equal(reviewed[0]?.attemptId, undefined);
    assert.equal((reviewed[0]?.data as { authority: string }).authority, 'validator');
    assert.equal((reviewed[0]?.data as { reportId: string }).reportId, out.reportId);
  });

  test('failed validation：report 可 get，item submitted，无 reviews/accept', async () => {
    const runner = fakeRunner(async () => ({
      exitCode: 1,
      timedOut: false,
      durationMs: 2,
      output: 'fail',
    }));
    const h = harness({ runner, paths: fakePaths(['src/foo.ts']) });
    const { missionId, projectId, workItemId, exec } = await upToSubmittedLightweight(h);

    const out = await h.platform.validateAndAcceptLightweightWorkItem({
      missionId,
      workItemId,
      cwd: '/cwd',
    });

    assert.equal(out.passed, false);
    assert.equal(out.status, 'submitted');
    const stored = await h.validation!.reports.get(out.reportId);
    assert.ok(stored);
    assert.equal(stored.passed, false);
    assert.equal(stored.attemptId, exec);

    const { item } = await liveItem(h.projects, projectId, missionId, workItemId);
    assert.equal(item.status, 'submitted');
    assert.equal(item.reviews.length, 0);

    const events = await h.activity.list(missionId);
    assert.equal(events.filter((e) => e.kind === 'review.recorded').length, 0);
    assert.equal(events.filter((e) => e.kind === 'validation.reported').length, 1);
    assert.equal(events.filter((e) => e.kind === 'validation.completed').length, 0);
  });

  test('VAL-002：Platform 从 frozen order 拷贝 forbiddenPaths；命中 deny 保持 submitted', async () => {
    const h = harness({
      runner: fakeRunner(),
      paths: fakePaths(['src/foo.ts']),
    });
    const order: WorkOrder = {
      ...ORDER_BASE,
      validation: {
        commands: [],
        forbiddenPaths: ['src/foo.ts'],
      },
    };
    const { missionId, projectId, workItemId } = await upToSubmittedLightweight(h, { order });
    const out = await h.platform.validateAndAcceptLightweightWorkItem({
      missionId,
      workItemId,
      cwd: '/trusted/cwd',
    });
    assert.equal(out.passed, false);
    assert.equal(out.status, 'submitted');
    const stored = await h.validation!.reports.get(out.reportId);
    assert.ok(stored);
    assert.equal(stored.passed, false);
    const fp = stored.checks.find((c) => c.kind === 'forbidden-paths');
    assert.ok(fp);
    assert.deepEqual(fp!.forbiddenPaths?.violations, ['src/foo.ts']);
    const { item } = await liveItem(h.projects, projectId, missionId, workItemId);
    assert.equal(item.status, 'submitted');
    assert.equal(item.reviews.length, 0);
  });

  test('VAL-002：diffSize 超限 fail；omit 新字段仍走旧路径 accept', async () => {
    const over = harness({
      runner: fakeRunner(),
      paths: fakePaths(['src/foo.ts', 'src/bar.ts']),
      diffFacts: {
        async measureLines() {
          return { changedLines: 1, unknown: [] };
        },
      },
    });
    const orderOver: WorkOrder = {
      ...ORDER_BASE,
      allowedScope: ['src/foo.ts', 'src/bar.ts'],
      validation: {
        commands: [],
        diffSize: { maxChangedFiles: 1 },
      },
    };
    const submittedOver = await upToSubmittedLightweight(over, { order: orderOver });
    const failOut = await over.platform.validateAndAcceptLightweightWorkItem({
      missionId: submittedOver.missionId,
      workItemId: submittedOver.workItemId,
      cwd: '/cwd',
    });
    assert.equal(failOut.passed, false);
    assert.equal(failOut.status, 'submitted');
    const failReport = await over.validation!.reports.get(failOut.reportId);
    assert.ok(failReport?.checks.some((c) => c.kind === 'diff-size' && c.passed === false));

    // omit → 旧路径：仅 changed-paths，可通过
    const legacy = harness({
      runner: fakeRunner(),
      paths: fakePaths(['src/foo.ts']),
    });
    const submittedLegacy = await upToSubmittedLightweight(legacy, {
      order: { ...ORDER_BASE, validation: { commands: [] } },
    });
    const ok = await legacy.platform.validateAndAcceptLightweightWorkItem({
      missionId: submittedLegacy.missionId,
      workItemId: submittedLegacy.workItemId,
      cwd: '/cwd',
    });
    assert.equal(ok.passed, true);
    assert.equal(ok.status, 'accepted');
    const okReport = await legacy.validation!.reports.get(ok.reportId);
    assert.equal(okReport?.checks.some((c) => c.kind === 'forbidden-paths'), false);
    assert.equal(okReport?.checks.some((c) => c.kind === 'diff-size'), false);
  });

  test('VAL-002：恰好到上限（1 个文件 / 5 行，上限 1 / 5）→ accept', async () => {
    // E1 的 CANARY-LW-2：执行者只改了允许的那一个文件，旧语义把「最多 1 个」读成「一个都不许改」，
    // 机器验收判超限，Lightweight 没有升级出口，Mission 就停在 stalled。
    const h = harness({
      runner: fakeRunner(),
      paths: fakePaths(['src/foo.ts']),
      diffFacts: {
        async measureLines() {
          return { changedLines: 5, unknown: [] };
        },
      },
    });
    const submitted = await upToSubmittedLightweight(h, {
      order: {
        ...ORDER_BASE,
        allowedScope: ['src/foo.ts'],
        validation: { commands: [], diffSize: { maxChangedFiles: 1, maxChangedLines: 5 } },
      },
    });
    const out = await h.platform.validateAndAcceptLightweightWorkItem({
      missionId: submitted.missionId,
      workItemId: submitted.workItemId,
      cwd: '/cwd',
    });
    assert.equal(out.passed, true);
    assert.equal(out.status, 'accepted');
    const report = await h.validation!.reports.get(out.reportId);
    const ds = report?.checks.find((c) => c.kind === 'diff-size');
    assert.equal(ds?.passed, true);
    assert.deepEqual(ds?.diffSize?.used, { changedFiles: 1, changedLines: 5 });
  });

  test('missing/empty validation.commands：只跑 changed-paths 可通过', async () => {
    const runner = fakeRunner();
    const paths = fakePaths(['src/foo.ts']);

    for (const order of [
      ORDER_BASE,
      { ...ORDER_BASE, validation: { commands: [] } } satisfies WorkOrder,
    ]) {
      const h = harness({ runner, paths });
      const { missionId, projectId, workItemId, exec } = await upToSubmittedLightweight(h, {
        order,
      });

      const out = await h.platform.validateAndAcceptLightweightWorkItem({
        missionId,
        workItemId,
        cwd: '/trusted/cwd',
      });

      assert.equal(out.passed, true);
      assert.equal(out.status, 'accepted');
      // no command checks were requested
      assert.equal(
        runner.calls.filter((c) => c.cwd === '/trusted/cwd').length,
        0,
        'empty commands 不得跑 command check',
      );

      const stored = await h.validation!.reports.get(out.reportId);
      assert.ok(stored);
      assert.equal(stored.passed, true);
      assert.equal(stored.attemptId, exec);
      assert.ok(stored.checks.some((c) => c.kind === 'changed-paths'));
      assert.equal(stored.checks.filter((c) => c.kind === 'command').length, 0);

      const { item, mission } = await liveItem(h.projects, projectId, missionId, workItemId);
      assert.equal(item.status, 'accepted');
      assert.equal(item.reviews.length, 1);
      assert.equal(item.reviews[0]?.attemptId, undefined);
      assert.equal(item.reviews[0]?.submittedAttemptId, exec);
      assert.equal(mission.coordinatorAttempts.length, 0);
    }
  });

  test('missing deps/workspace/submitted id/cwd fail closed；whitespace cwd 拒绝', async () => {
    // missing deps
    {
      const h = harness({ withRealValidation: false });
      const { missionId, workItemId } = await upToSubmittedLightweight(h);
      await assert.rejects(
        () =>
          h.platform.validateAndAcceptLightweightWorkItem({
            missionId,
            workItemId,
            cwd: '/cwd',
          }),
        (e: unknown) => codeOf(e) === 'VALIDATION_DEPS_REQUIRED',
      );
      const { item } = await liveItem(h.projects, 'P', missionId, workItemId);
      assert.equal(item.status, 'submitted');
    }

    // missing workspace
    {
      const h = harness();
      const { missionId, workItemId } = await upToSubmittedLightweight(h, { cwdReady: false });
      await assert.rejects(
        () =>
          h.platform.validateAndAcceptLightweightWorkItem({
            missionId,
            workItemId,
            cwd: '/cwd',
          }),
        (e: unknown) => codeOf(e) === 'VALIDATION_WORKSPACE_REQUIRED',
      );
    }

    // empty cwd
    {
      const h = harness();
      const { missionId, workItemId } = await upToSubmittedLightweight(h);
      await assert.rejects(
        () =>
          h.platform.validateAndAcceptLightweightWorkItem({
            missionId,
            workItemId,
            cwd: '',
          }),
        (e: unknown) => codeOf(e) === 'VALIDATION_CWD_REQUIRED',
      );
    }

    // whitespace-only cwd
    {
      const h = harness();
      const { missionId, workItemId } = await upToSubmittedLightweight(h);
      await assert.rejects(
        () =>
          h.platform.validateAndAcceptLightweightWorkItem({
            missionId,
            workItemId,
            cwd: '   	  ',
          }),
        (e: unknown) => codeOf(e) === 'VALIDATION_CWD_REQUIRED',
      );
    }

    // padded cwd is trimmed before engine
    {
      const runner = fakeRunner(async () => ({
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        output: 'ok',
      }));
      const h = harness({ runner, paths: fakePaths(['src/foo.ts']) });
      const { missionId, workItemId } = await upToSubmittedLightweight(h);
      const out = await h.platform.validateAndAcceptLightweightWorkItem({
        missionId,
        workItemId,
        cwd: '  /trusted/pad  ',
      });
      assert.equal(out.passed, true);
      assert.equal(runner.calls[0]?.cwd, '/trusted/pad');
    }

    // not submitted
    {
      const h = harness();
      const { missionId } = await createLightweightMission(h.projects, { missionId: 'M-ns' });
      const { workItemId } = await h.platform.createLightweightWorkItem(missionId, {
        order: ORDER_WITH_VALIDATION,
      });
      await h.platform.dispatchLightweightWorkItem(missionId, workItemId);
      await h.platform.recordWorkspace(missionId, {
        projectRoot: '/p',
        branch: 'b',
        baseRevision: 'r',
      });
      await assert.rejects(
        () =>
          h.platform.validateAndAcceptLightweightWorkItem({
            missionId,
            workItemId,
            cwd: '/cwd',
          }),
        (e: unknown) => codeOf(e) === 'VALIDATION_NOT_SUBMITTED',
      );
    }
  });

  test('engine throw / report save conflict => no accept', async () => {
    // engine throw
    {
      const boomEngine = {
        async validate(): Promise<ValidationEngineResult> {
          throw new Error('engine boom');
        },
      };
      const reports = spyReports();
      const h = harness({
        validation: { engine: boomEngine, reports },
      });
      const { missionId, projectId, workItemId } = await upToSubmittedLightweight(h);
      await assert.rejects(
        () =>
          h.platform.validateAndAcceptLightweightWorkItem({
            missionId,
            workItemId,
            cwd: '/cwd',
          }),
        /engine boom/,
      );
      assert.equal(reports.saves.length, 0);
      const { item } = await liveItem(h.projects, projectId, missionId, workItemId);
      assert.equal(item.status, 'submitted');
      assert.equal(item.reviews.length, 0);
    }

    // save conflict
    {
      const report: ValidationReport = {
        id: 'VR-conflict',
        policyRevision: VALIDATION_POLICY_REVISION,
        missionId: 'x',
        workItemId: 'y',
        attemptId: 'z',
        startedAt: 't0',
        endedAt: 't1',
        passed: true,
        checks: [],
      };
      const inner = new InMemoryValidationReportRepository();
      await inner.save(report);
      const conflictReports: ValidationReportRepository = {
        async save(r) {
          // force conflict by saving different content under same id
          await inner.save({ ...report, passed: !r.passed, id: r.id });
          throw new ValidationReportConflictError(r.id);
        },
        async get(id) {
          return inner.get(id);
        },
      };
      const stubEngine = {
        async validate(input: ValidationInput): Promise<ValidationEngineResult> {
          return {
            report: {
              id: 'VR-new',
              policyRevision: VALIDATION_POLICY_REVISION,
              missionId: input.missionId,
              workItemId: input.workItemId,
              attemptId: input.attemptId,
              startedAt: 't0',
              endedAt: 't1',
              passed: true,
              checks: [],
            },
            authority: {
              kind: 'validator',
              reportId: 'VR-new',
              policyRevision: VALIDATION_POLICY_REVISION,
            },
          };
        },
      };
      // simpler: wrapper that always throws conflict
      const alwaysConflict: ValidationReportRepository = {
        async save(r) {
          throw new ValidationReportConflictError(r.id);
        },
        async get() {
          return undefined;
        },
      };
      const h = harness({
        validation: { engine: stubEngine, reports: alwaysConflict },
      });
      const { missionId, projectId, workItemId } = await upToSubmittedLightweight(h);
      await assert.rejects(
        () =>
          h.platform.validateAndAcceptLightweightWorkItem({
            missionId,
            workItemId,
            cwd: '/cwd',
          }),
        (e: unknown) => (e as ValidationReportConflictError).code === 'VALIDATION_REPORT_CONFLICT',
      );
      const { item } = await liveItem(h.projects, projectId, missionId, workItemId);
      assert.equal(item.status, 'submitted');
      assert.equal(item.reviews.length, 0);
      void conflictReports;
    }
  });

  test('stub engine mismatched report/authority => no accept；report 先保存', async () => {
    async function runMismatch(
      build: (input: ValidationInput) => ValidationEngineResult,
    ): Promise<{ itemStatus: string; saved: boolean; reportId?: string }> {
      let saved = false;
      let reportId: string | undefined;
      const reports: ValidationReportRepository = {
        async save(r) {
          saved = true;
          reportId = r.id;
        },
        async get() {
          return undefined;
        },
      };
      const h = harness({
        validation: {
          engine: { validate: async (input) => build(input) },
          reports,
        },
      });
      const { missionId, projectId, workItemId, exec } = await upToSubmittedLightweight(h);
      await assert.rejects(
        () =>
          h.platform.validateAndAcceptLightweightWorkItem({
            missionId,
            workItemId,
            cwd: '/cwd',
          }),
        (e: unknown) => codeOf(e) === 'VALIDATION_AUTHORITY_MISMATCH',
      );
      const { item } = await liveItem(h.projects, projectId, missionId, workItemId);
      assert.equal(item.reviews.length, 0);
      return { itemStatus: item.status, saved, reportId, ...(exec ? {} : {}) };
    }

    // mismatched missionId on report
    {
      const r = await runMismatch((input) => ({
        report: {
          id: 'VR-mm',
          policyRevision: VALIDATION_POLICY_REVISION,
          missionId: 'OTHER',
          workItemId: input.workItemId,
          attemptId: input.attemptId,
          startedAt: 't0',
          endedAt: 't1',
          passed: true,
          checks: [],
        },
        authority: {
          kind: 'validator',
          reportId: 'VR-mm',
          policyRevision: VALIDATION_POLICY_REVISION,
        },
      }));
      assert.equal(r.itemStatus, 'submitted');
      assert.equal(r.saved, true);
    }

    // mismatched authority.reportId
    {
      const r = await runMismatch((input) => ({
        report: {
          id: 'VR-ok',
          policyRevision: VALIDATION_POLICY_REVISION,
          missionId: input.missionId,
          workItemId: input.workItemId,
          attemptId: input.attemptId,
          startedAt: 't0',
          endedAt: 't1',
          passed: true,
          checks: [],
        },
        authority: {
          kind: 'validator',
          reportId: 'VR-OTHER',
          policyRevision: VALIDATION_POLICY_REVISION,
        },
      }));
      assert.equal(r.itemStatus, 'submitted');
      assert.equal(r.saved, true);
    }

    // mismatched policyRevision
    {
      const r = await runMismatch((input) => ({
        report: {
          id: 'VR-pol',
          policyRevision: VALIDATION_POLICY_REVISION,
          missionId: input.missionId,
          workItemId: input.workItemId,
          attemptId: input.attemptId,
          startedAt: 't0',
          endedAt: 't1',
          passed: true,
          checks: [],
        },
        authority: {
          kind: 'validator',
          reportId: 'VR-pol',
          policyRevision: VALIDATION_POLICY_REVISION + 99,
        },
      }));
      assert.equal(r.itemStatus, 'submitted');
      assert.equal(r.saved, true);
    }

    // mismatched attemptId
    {
      const r = await runMismatch((input) => ({
        report: {
          id: 'VR-at',
          policyRevision: VALIDATION_POLICY_REVISION,
          missionId: input.missionId,
          workItemId: input.workItemId,
          attemptId: 'WRONG-ATTEMPT',
          startedAt: 't0',
          endedAt: 't1',
          passed: true,
          checks: [],
        },
        authority: {
          kind: 'validator',
          reportId: 'VR-at',
          policyRevision: VALIDATION_POLICY_REVISION,
        },
      }));
      assert.equal(r.itemStatus, 'submitted');
      assert.equal(r.saved, true);
    }
  });
});

describe('Standard 回归：Lightweight 不放宽', () => {
  test('createWorkItem 仍 PLAN_REQUIRED / Coordinator gate；review 仍 Coordinator', async () => {
    const h = harness({ withRealValidation: false });
    await h.platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });

    // no coordinator attempt
    await assert.rejects(
      () =>
        h.platform.createWorkItem('M1', 'coord-nope', {
          title: 'W',
          order: ORDER_BASE,
        }),
      (e: unknown) => codeOf(e) === 'UNKNOWN_ATTEMPT',
    );

    const { attemptId: coord } = await h.platform.startCoordinatorAttempt('M1');
    await assert.rejects(
      () =>
        h.platform.createWorkItem('M1', coord, {
          title: 'W',
          order: ORDER_BASE,
        }),
      (e: unknown) => codeOf(e) === 'PLAN_REQUIRED',
    );

    await h.platform.updatePlan('M1', coord, PLAN);
    const { workItemId } = await h.platform.createWorkItem('M1', coord, {
      title: 'W',
      order: ORDER_BASE,
    });
    await h.platform.dispatchWorkItems('M1', coord, [workItemId]);
    const { attemptId: exec } = await h.platform.startExecutorAttempt('M1', workItemId);
    await h.platform.submitEvidence('M1', exec, {
      kind: 'test',
      summary: 'ok',
      command: 't',
      exitCode: 0,
    });
    await h.platform.submitExecutionResult('M1', exec, {
      outcome: 'completed',
      summary: 'done',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: '',
    });

    // executor cannot review
    await assert.rejects(
      () =>
        h.platform.reviewExecutionResult('M1', exec, {
          workItemId,
          verdict: 'accept', acceptanceResults: ORDER_BASE.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })),
          reasons: ['no'],
          requiredChanges: [],
        }),
      (e: unknown) => codeOf(e) === 'WRONG_ROLE',
    );

    await h.platform.reviewExecutionResult('M1', coord, {
      workItemId,
      verdict: 'accept', acceptanceResults: ORDER_BASE.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })),
      reasons: ['ok'],
      requiredChanges: [],
    });
    const view = await h.platform.getMissionView('M1');
    const last = view.workItems[0]?.lastReview;
    assert.ok(last);
    assert.equal(last.attemptId, coord);
    assert.equal(last.authority, undefined);
  });

  test('Standard PRE_DISPATCH 仍会调用 decisionProvider', async () => {
    const sink = { calls: 0 };
    const provider: DecisionProvider = {
      kind: 'cap',
      async decide(): Promise<DecisionAnswerSet> {
        sink.calls += 1;
        return { answers: {} };
      },
    };
    const h = harness({ decisionProvider: provider, withRealValidation: false });
    await h.platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const { attemptId: coord } = await h.platform.startCoordinatorAttempt('M1');
    await h.platform.updatePlan('M1', coord, PLAN);
    const { workItemId } = await h.platform.createWorkItem('M1', coord, {
      title: 'W',
      order: ORDER_BASE,
    });
    await h.platform.dispatchWorkItems('M1', coord, [workItemId]);
    assert.equal(sink.calls, 1);
  });
});

describe('Platform.promoteLightweightAfterValidation（§4.3 接线）', () => {
  const failingRunner = () =>
    fakeRunner(async () => ({ exitCode: 1, timedOut: false, durationMs: 1, output: 'FAIL' }));

  async function failedSubmission() {
    const h = harness({ runner: failingRunner(), paths: fakePaths(['src/foo.ts']) });
    const s = await upToSubmittedLightweight(h);
    const out = await h.platform.validateAndAcceptLightweightWorkItem({
      missionId: s.missionId,
      workItemId: s.workItemId,
      cwd: '/cwd',
    });
    assert.equal(out.passed, false);
    return { h, s, out };
  }

  test('验收没过 → 凭当前这份报告升级 Standard，工作项留给协调者做 L2', async () => {
    const { h, s, out } = await failedSubmission();
    const { changed, promotion } = await h.platform.promoteLightweightAfterValidation(s.missionId, out.reportId);
    assert.equal(changed, true);
    assert.equal(promotion.triggerCode, 'validator_failure_unrepairable');
    assert.match(promotion.triggerRule, new RegExp(`${out.reportId} 未通过：command：`));
    assert.ok(promotion.validationReportIds.includes(out.reportId), '升级记录要能指回那份报告');

    const view = await h.platform.getMissionView(s.missionId);
    assert.equal(view.executionMode, 'standard');
    assert.equal(view.status, 'planning');
    assert.equal(view.workItems[0]!.status, 'submitted');
    const { item } = await liveItem(h.projects, s.projectId, s.missionId, s.workItemId);
    assert.equal(item.reviews.length, 0, '机器没有替协调者下结论');
  });

  test('改动超过 3 个文件：验收过了也不放行（held），凭报告升级 changed_files_gt_3', async () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    const h = harness({ paths: fakePaths(files) });
    const s = await upToSubmittedLightweight(h, {
      order: { ...ORDER_WITH_VALIDATION, allowedScope: ['src/'] },
    });
    const out = await h.platform.validateAndAcceptLightweightWorkItem({
      missionId: s.missionId,
      workItemId: s.workItemId,
      cwd: '/cwd',
    });
    assert.equal(out.passed, true);
    assert.equal(out.status, 'submitted');
    assert.equal(out.held, 'changed_files_gt_3');
    const { item } = await liveItem(h.projects, s.projectId, s.missionId, s.workItemId);
    assert.equal(item.reviews.length, 0, '规模超了就不该有 validator accept');

    const { promotion } = await h.platform.promoteLightweightAfterValidation(s.missionId, out.reportId);
    assert.equal(promotion.triggerCode, 'changed_files_gt_3');
    assert.match(promotion.triggerRule, /实际改动 4 个文件/);
  });

  test('跨 3 个顶层目录：held 并升级 top_level_modules_gt_2', async () => {
    const h = harness({ paths: fakePaths(['a/x.ts', 'b/y.ts', 'c/z.ts']) });
    const s = await upToSubmittedLightweight(h, {
      order: { ...ORDER_WITH_VALIDATION, allowedScope: ['a/', 'b/', 'c/'] },
    });
    const out = await h.platform.validateAndAcceptLightweightWorkItem({
      missionId: s.missionId,
      workItemId: s.workItemId,
      cwd: '/cwd',
    });
    assert.equal(out.held, 'top_level_modules_gt_2');
    const { promotion } = await h.platform.promoteLightweightAfterValidation(s.missionId, out.reportId);
    assert.equal(promotion.triggerCode, 'top_level_modules_gt_2');
  });

  test('规模内且通过：照旧由 validator accept，不带 held', async () => {
    const h = harness({ paths: fakePaths(['src/foo.ts']) });
    const s = await upToSubmittedLightweight(h);
    const out = await h.platform.validateAndAcceptLightweightWorkItem({
      missionId: s.missionId,
      workItemId: s.workItemId,
      cwd: '/cwd',
    });
    assert.equal(out.status, 'accepted');
    assert.equal(out.held, undefined);
  });

  test('拒收：报告不存在 / 不属于这条 Mission / 不是当前这次提交 / 没有升级理由；拒收后仍是 lightweight', async () => {
    const { h, s, out } = await failedSubmission();
    const stored = (await h.reports.get(out.reportId))!;
    await h.reports.save({ ...stored, id: 'VR-foreign', missionId: 'M-other' });
    await h.reports.save({ ...stored, id: 'VR-old', attemptId: 'W-1.exec-0' });
    await h.reports.save({
      ...stored,
      id: 'VR-clean',
      passed: true,
      checks: stored.checks.map((check) => ({ ...check, passed: true })),
    });

    const cases: [string, string][] = [
      ['VR-404', 'PROMOTION_REPORT_MISMATCH'],
      ['VR-foreign', 'PROMOTION_REPORT_MISMATCH'],
      ['VR-old', 'PROMOTION_REPORT_STALE'],
      ['VR-clean', 'NO_PROMOTION_TRIGGER'],
    ];
    for (const [reportId, code] of cases) {
      await assert.rejects(
        h.platform.promoteLightweightAfterValidation(s.missionId, reportId),
        (e: unknown) => codeOf(e) === code,
        `${reportId} 应被拒为 ${code}`,
      );
    }
    const view = await h.platform.getMissionView(s.missionId);
    assert.equal(view.executionMode, 'lightweight');
    assert.equal(view.promotions.length, 0);
  });
});
