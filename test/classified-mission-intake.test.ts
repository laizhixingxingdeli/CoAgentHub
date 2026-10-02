/**
 * M3D-2：Classified Mission intake（strict parser + Platform + control API + run-mission opt-in）。
 *
 * 守住：
 *   - caller 不能用 executionMode/route/ClassificationResult 绕过 classifier
 *   - 四路路由：query 拒绝；禁止副作用 HA 拒绝；合规 HA 建单；standard 0 WI；lightweight 1 Frozen WI
 *   - 拒绝路径不建 Mission；route guards 在 ensureProject 前
 *   - legacy POST /api/missions 不变；无新增 agent tool
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';

import {
  assertNoCallerRouteOverride,
  ClassifiedMissionInputError,
  parseComplexityAssessmentStrict,
  parseTaskFactsStrict,
} from '../src/application/classified-mission-intake.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { InMemoryAgentPoolRepository } from '../src/application/agent-pool.ts';
import { Platform, PlatformRuleError } from '../src/application/platform.ts';
import type { TaskFacts, Tri } from '../src/application/task-classifier.ts';
import type {
  ComplexityAssessment,
  MissionContract,
  WorkOrder,
} from '../src/kernel/index.ts';
import { InvariantViolationError } from '../src/kernel/index.ts';
import { createApi } from '../src/api/server.ts';
import type { ControlPrincipal, ControlPrincipalResolver } from '../src/api/control-auth.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

const FALSE: Tri = false;
const TRUE: Tri = true;
const UNKNOWN: Tri = 'unknown';

const CONTRACT: MissionContract = {
  intent: 'classified intake',
  acceptance: ['ok'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const ORDER: WorkOrder = {
  objective: '改 foo.ts',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
};

function allFalseHa(): TaskFacts['highAssurance'] {
  return {
    productionDeployRelease: FALSE,
    externalPaidOp: FALSE,
    destructiveData: FALSE,
    credentialsPermissionsSecurity: FALSE,
    schemaPublicApiPersistenceCompat: FALSE,
    unrecoverableExternalSideEffect: FALSE,
  };
}

function allFalseSf(): TaskFacts['standardFloor'] {
  return {
    publicInterface: FALSE,
    buildSystemOrDependency: FALSE,
    multipleDomainModules: FALSE,
    acceptanceNotCheckableUpfront: FALSE,
    rootCauseOrCompetingDesigns: FALSE,
  };
}

function facts(overrides: {
  mutationSideEffect?: Tri;
  readOnlyProven?: Tri;
  highAssurance?: Partial<TaskFacts['highAssurance']>;
  standardFloor?: Partial<TaskFacts['standardFloor']>;
} = {}): TaskFacts {
  return {
    mutationSideEffect: overrides.mutationSideEffect ?? FALSE,
    readOnlyProven: overrides.readOnlyProven ?? FALSE,
    highAssurance: { ...allFalseHa(), ...overrides.highAssurance },
    standardFloor: { ...allFalseSf(), ...overrides.standardFloor },
  };
}

function assessmentForSum(sum: number): ComplexityAssessment {
  const dims: Array<0 | 1 | 2> = [0, 0, 0, 0, 0, 0];
  let remain = sum;
  for (let i = 0; i < 6 && remain > 0; i++) {
    const take = Math.min(2, remain) as 0 | 1 | 2;
    dims[i] = take;
    remain -= take;
  }
  return {
    goalUncertainty: dims[0]!,
    changeScope: dims[1]!,
    operationalRisk: dims[2]!,
    verificationDifficulty: dims[3]!,
    coordinationNeed: dims[4]!,
    recoveryDifficulty: dims[5]!,
    reasons: [`sum=${sum}`],
    decidedBy: 'rule',
    assessedAt: '2026-03-21T12:00:00.000Z',
  };
}

function harness() {
  const clock = new FixedClock('2026-06-01T12:00:00.000Z');
  const activity = new InMemoryActivityLog(clock);
  const projects = new InMemoryProjectRepository();
  const ids = new SequentialIds();
  const platform = new Platform({
    projects,
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    activity,
    clock,
    ids,
  });
  return { platform, activity, projects, ids, clock };
}

function isBadInput(err: unknown): boolean {
  return err instanceof ClassifiedMissionInputError && err.code === 'BAD_ROUTING_INPUT';
}

function isRule(code: string) {
  return (err: unknown) =>
    err instanceof PlatformRuleError && (err as PlatformRuleError).code === code;
}

/* ============================ A. strict parser ============================ */

describe('classified intake parser', () => {
  test('parseTaskFactsStrict: exact shape ok', () => {
    const f = facts({ mutationSideEffect: TRUE });
    const got = parseTaskFactsStrict(f);
    assert.deepEqual(got, f);
    assert.ok(Object.isFrozen(got));
  });

  test('malformed facts: missing key / extra key / bad Tri / nested missing', () => {
    assert.throws(() => parseTaskFactsStrict({ mutationSideEffect: true }), isBadInput);

    const extra = { ...facts(), extra: true };
    assert.throws(() => parseTaskFactsStrict(extra), isBadInput);

    assert.throws(
      () => parseTaskFactsStrict({ ...facts(), mutationSideEffect: 'maybe' }),
      isBadInput,
    );

    const nested = facts();
    const ha = { ...nested.highAssurance } as Record<string, unknown>;
    delete ha.destructiveData;
    assert.throws(
      () => parseTaskFactsStrict({ ...nested, highAssurance: ha }),
      isBadInput,
    );

    const haExtra = { ...nested.highAssurance, bonus: true };
    assert.throws(
      () => parseTaskFactsStrict({ ...nested, highAssurance: haExtra }),
      isBadInput,
    );
  });

  test('malformed assessment: dim OOB / extra / missing / bad reasons / decidedBy', () => {
    assert.equal(parseComplexityAssessmentStrict(undefined), undefined);

    const ok = assessmentForSum(4);
    assert.deepEqual(parseComplexityAssessmentStrict(ok), ok);

    assert.throws(
      () => parseComplexityAssessmentStrict({ ...ok, goalUncertainty: 3 }),
      isBadInput,
    );
    assert.throws(
      () => parseComplexityAssessmentStrict({ ...ok, extra: 1 }),
      isBadInput,
    );
    const missing = { ...ok } as Record<string, unknown>;
    delete missing.reasons;
    assert.throws(() => parseComplexityAssessmentStrict(missing), isBadInput);

    assert.throws(
      () => parseComplexityAssessmentStrict({ ...ok, reasons: 'nope' }),
      isBadInput,
    );
    assert.throws(
      () => parseComplexityAssessmentStrict({ ...ok, reasons: [1] }),
      isBadInput,
    );
    assert.throws(
      () => parseComplexityAssessmentStrict({ ...ok, decidedBy: 'model' }),
      isBadInput,
    );
    assert.throws(
      () => parseComplexityAssessmentStrict({ ...ok, assessedAt: 12 }),
      isBadInput,
    );
  });

  test('assertNoCallerRouteOverride rejects mode/route/classification keys', () => {
    assert.doesNotThrow(() =>
      assertNoCallerRouteOverride({ projectId: 'P', facts: facts() }),
    );
    for (const key of [
      'executionMode',
      'runKind',
      'recommended',
      'recommendedRoute',
      'classification',
      'route',
    ]) {
      assert.throws(
        () => assertNoCallerRouteOverride({ projectId: 'P', [key]: 'x' }),
        isBadInput,
      );
    }
  });
});

/* ============================ B. Platform routes ============================ */

describe('Platform.createClassifiedMission', () => {
  test('1. malformed facts => BAD_ROUTING_INPUT；无 Project/Mission', async () => {
    const { platform, projects } = harness();
    await assert.rejects(
      () =>
        platform.createClassifiedMission({
          projectId: 'P-bad-facts',
          contract: CONTRACT,
          facts: { mutationSideEffect: true } as never,
        }),
      isBadInput,
    );
    assert.equal((await projects.list()).length, 0);
  });

  test('2. malformed assessment => BAD_ROUTING_INPUT；无 Mission', async () => {
    const { platform, projects } = harness();
    await assert.rejects(
      () =>
        platform.createClassifiedMission({
          projectId: 'P-bad-assess',
          contract: CONTRACT,
          facts: facts({ mutationSideEffect: TRUE }),
          assessment: { ...assessmentForSum(4), goalUncertainty: 9 } as never,
        }),
      isBadInput,
    );
    assert.equal((await projects.list()).length, 0);
  });

  test('3. caller route override => BAD_ROUTING_INPUT；不创建', async () => {
    const { platform, projects } = harness();
    await assert.rejects(
      () =>
        platform.createClassifiedMission({
          projectId: 'P-override',
          contract: CONTRACT,
          facts: facts({ mutationSideEffect: TRUE }),
          executionMode: 'lightweight',
        } as never),
      isBadInput,
    );
    await assert.rejects(
      () =>
        platform.createClassifiedMission({
          projectId: 'P-override',
          contract: CONTRACT,
          facts: facts({ mutationSideEffect: TRUE }),
          classification: { recommended: { runKind: 'mutation', executionMode: 'lightweight' } },
        } as never),
      isBadInput,
    );
    assert.equal((await projects.list()).length, 0);
  });

  test('4. query route => QUERY_ROUTE_REQUIRED；无 Mission', async () => {
    const { platform, projects } = harness();
    await assert.rejects(
      () =>
        platform.createClassifiedMission({
          projectId: 'P-query',
          missionId: 'M-query',
          contract: CONTRACT,
          facts: facts({ readOnlyProven: TRUE, mutationSideEffect: FALSE }),
        }),
      isRule('QUERY_ROUTE_REQUIRED'),
    );
    assert.equal((await projects.list()).length, 0);
    await assert.rejects(() => platform.getMissionView('M-query'), isRule('UNKNOWN_MISSION'));
  });

  test('5. 四种禁止副作用各自 HA_SIDE_EFFECT_DENIED；无 Mission / 空 Project', async () => {
    const flags = [
      'productionDeployRelease',
      'externalPaidOp',
      'unrecoverableExternalSideEffect',
      'destructiveData',
    ] as const;
    for (const flag of flags) {
      const { platform, projects } = harness();
      await assert.rejects(
        () =>
          platform.createClassifiedMission({
            projectId: `P-ha-${flag}`,
            missionId: `M-ha-${flag}`,
            contract: CONTRACT,
            facts: facts({
              mutationSideEffect: TRUE,
              highAssurance: { [flag]: TRUE },
            }),
          }),
        isRule('HA_SIDE_EFFECT_DENIED'),
      );
      assert.equal((await projects.list()).length, 0);
      await assert.rejects(() => platform.getMissionView(`M-ha-${flag}`), isRule('UNKNOWN_MISSION'));
    }
  });

  test('5b. 禁止副作用为 unknown 时同样拒绝，不把未知冒充已证明安全', async () => {
    const { platform, projects } = harness();
    await assert.rejects(
      () =>
        platform.createClassifiedMission({
          projectId: 'P-ha-unknown',
          missionId: 'M-ha-unknown',
          contract: CONTRACT,
          facts: facts({
            mutationSideEffect: TRUE,
            highAssurance: { destructiveData: UNKNOWN, credentialsPermissionsSecurity: TRUE },
          }),
        }),
      isRule('HA_SIDE_EFFECT_DENIED'),
    );
    assert.equal((await projects.list()).length, 0);
  });

  test('5c. 合规 HA 建单成功；带 Lightweight workOrder 被拒', async () => {
    const { platform, projects, activity } = harness();
    const created = await platform.createClassifiedMission({
      projectId: 'P-ha-ok',
      missionId: 'M-ha-ok',
      contract: CONTRACT,
      facts: facts({
        mutationSideEffect: TRUE,
        highAssurance: {
          credentialsPermissionsSecurity: TRUE,
          schemaPublicApiPersistenceCompat: TRUE,
        },
      }),
    });
    assert.equal(created.missionId, 'M-ha-ok');
    assert.equal(created.workItemId, undefined);
    assert.equal(created.classification.recommended.executionMode, 'high_assurance');
    const view = await platform.getMissionView('M-ha-ok');
    assert.equal(view.executionMode, 'high_assurance');
    assert.equal(view.workItems.length, 0);
    assert.ok((await activity.list('M-ha-ok')).some((e) => e.kind === 'mission.routed'));

    const h2 = harness();
    await assert.rejects(
      () =>
        h2.platform.createClassifiedMission({
          projectId: 'P-ha-wo',
          missionId: 'M-ha-wo',
          contract: CONTRACT,
          facts: facts({
            mutationSideEffect: TRUE,
            highAssurance: { credentialsPermissionsSecurity: TRUE },
          }),
          workOrder: ORDER,
        }),
      isRule('HIGH_ASSURANCE_WORK_ORDER_FORBIDDEN'),
    );
    assert.equal((await h2.projects.list()).length, 0);
    assert.equal((await projects.get('P-ha-ok'))?.missions.length, 1);
  });

  test('6. standard：无 workOrder 成功；有 workOrder 拒绝', async () => {
    const { platform, projects, activity } = harness();
    const assessment = assessmentForSum(7);
    const created = await platform.createClassifiedMission({
      projectId: 'P-std',
      missionId: 'M-std',
      contract: CONTRACT,
      facts: facts({ mutationSideEffect: TRUE }),
      assessment,
    });
    assert.equal(created.missionId, 'M-std');
    assert.equal(created.workItemId, undefined);
    assert.equal(created.classification.recommended.executionMode, 'standard');
    assert.equal(created.classification.recommended.runKind, 'mutation');

    const view = await platform.getMissionView('M-std');
    assert.equal(view.executionMode, 'standard');
    assert.equal(view.runKind, 'mutation');
    assert.equal(view.workItems.length, 0);

    const project = await projects.get('P-std');
    const mission = project!.missions.find((m) => m.id === 'M-std')!;
    assert.deepEqual(mission.complexityAssessment, assessment);

    const events = await activity.list('M-std');
    assert.ok(events.some((e) => e.kind === 'mission.created'));
    assert.ok(events.some((e) => e.kind === 'mission.routed'));
    assert.equal(
      events.filter((e) => e.kind === 'work_item.created').length,
      0,
    );

    // workOrder forbidden
    const h2 = harness();
    await assert.rejects(
      () =>
        h2.platform.createClassifiedMission({
          projectId: 'P-std-wo',
          missionId: 'M-std-wo',
          contract: CONTRACT,
          facts: facts({ mutationSideEffect: TRUE }),
          assessment: assessmentForSum(7),
          workOrder: ORDER,
        }),
      isRule('STANDARD_WORK_ORDER_FORBIDDEN'),
    );
    assert.equal((await h2.projects.list()).length, 0);
  });

  test('7. lightweight：缺 workOrder 拒绝；合法 => 1 Frozen WI，零 Coordinator', async () => {
    const { platform, projects, activity } = harness();

    await assert.rejects(
      () =>
        platform.createClassifiedMission({
          projectId: 'P-lw',
          missionId: 'M-lw-missing',
          contract: CONTRACT,
          facts: facts({ mutationSideEffect: TRUE }),
          assessment: assessmentForSum(4),
        }),
      isRule('LIGHTWEIGHT_WORK_ORDER_REQUIRED'),
    );
    assert.equal((await projects.list()).length, 0);

    const mutableOrder: WorkOrder = {
      ...ORDER,
      validation: {
        commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }],
      },
    };
    const argv = mutableOrder.validation!.commands[0]!.argv as string[];

    const created = await platform.createClassifiedMission({
      projectId: 'P-lw',
      missionId: 'M-lw',
      contract: CONTRACT,
      facts: facts({ mutationSideEffect: TRUE }),
      assessment: assessmentForSum(4),
      workOrder: mutableOrder,
    });
    assert.equal(created.missionId, 'M-lw');
    assert.ok(created.workItemId);
    assert.equal(created.classification.recommended.executionMode, 'lightweight');

    const view = await platform.getMissionView('M-lw');
    assert.equal(view.executionMode, 'lightweight');
    assert.equal(view.runKind, 'mutation');
    assert.equal(view.workItems.length, 1);
    assert.equal(view.workItems[0]!.id, created.workItemId);
    assert.equal(view.workItems[0]!.title, ORDER.objective);
    assert.equal(view.workItems[0]!.status, 'created');
    assert.equal(view.coordinatorAttemptIds.length, 0);
    assert.equal(view.planRevision, 0);
    assert.equal(view.plan, undefined);

    // caller mutation 不污染 frozen order
    argv.push('--hack');
    assert.deepEqual(view.workItems[0]!.order?.validation?.commands?.[0]?.argv, [
      'node',
      '--test',
    ]);

    const project = await projects.get('P-lw');
    const mission = project!.missions.find((m) => m.id === 'M-lw')!;
    assert.equal(mission.coordinatorAttempts.length, 0);
    assert.ok(Object.isFrozen(mission.workItems[0]!.order));

    const events = await activity.list('M-lw');
    const wiCreated = events.filter((e) => e.kind === 'work_item.created');
    assert.equal(wiCreated.length, 1);
    assert.equal(wiCreated[0]!.attemptId, undefined);
    assert.equal(
      (wiCreated[0]!.data as { executionMode: string }).executionMode,
      'lightweight',
    );
  });

  test('8. invalid WorkOrder.validation => Mission 不泄漏', async () => {
    const { platform, projects } = harness();
    await assert.rejects(
      () =>
        platform.createClassifiedMission({
          projectId: 'P-bad-wo',
          missionId: 'M-bad-wo',
          contract: CONTRACT,
          facts: facts({ mutationSideEffect: TRUE }),
          assessment: assessmentForSum(4),
          workOrder: {
            ...ORDER,
            validation: {
              commands: [
                {
                  argv: ['node', '--test'],
                  timeoutMs: 1000,
                  cwd: '/tmp',
                } as never,
              ],
            },
          },
        }),
      (err: unknown) =>
        err instanceof InvariantViolationError &&
        err.code === 'INVALID_WORK_ORDER_VALIDATION',
    );
    // Project 可能被 ensure，但不得有 Mission
    const list = await projects.list();
    for (const p of list) {
      assert.equal(p.missions.length, 0, 'Mission must not leak after bad WorkOrder');
    }
    await assert.rejects(() => platform.getMissionView('M-bad-wo'), isRule('UNKNOWN_MISSION'));
  });

  test('9. mission.routed 等于内部 classification；created/wi 审计无 fake attempt', async () => {
    const { platform, activity } = harness();
    const assessment = assessmentForSum(4);
    const f = facts({ mutationSideEffect: TRUE });
    const created = await platform.createClassifiedMission({
      projectId: 'P-audit',
      missionId: 'M-audit',
      contract: CONTRACT,
      facts: f,
      assessment,
      workOrder: ORDER,
    });

    const events = await activity.list('M-audit');
    const createdEv = events.find((e) => e.kind === 'mission.created')!;
    const createdData = createdEv.data as Record<string, unknown>;
    assert.equal(createdData.classified, true);
    assert.equal(createdData.executionMode, 'lightweight');
    assert.equal(createdData.runKind, 'mutation');
    assert.equal(createdData.contractRevision, 1);

    const routed = events.find((e) => e.kind === 'mission.routed')!;
    const data = routed.data as Record<string, unknown>;
    assert.deepEqual(data.recommended, created.classification.recommended);
    assert.equal(data.confidence, created.classification.confidence);
    assert.deepEqual(data.facts, created.classification.facts);
    assert.deepEqual(data.unknowns, [...created.classification.unknowns]);
    assert.deepEqual(data.criticalUnknowns, [...created.classification.criticalUnknowns]);
    assert.deepEqual(data.reasons, [...created.classification.reasons]);
    assert.deepEqual(data.assessmentRef, created.classification.assessmentRef);

    for (const e of events) {
      if (e.kind === 'work_item.created' || e.kind === 'mission.created') {
        assert.equal(e.attemptId, undefined);
      }
    }
  });
});

/* ============================ C. control API ============================ */

describe('POST /api/missions/classified control API', () => {
  const OPERATOR: ControlPrincipal = { id: 'op-1', role: 'operator' };
  const VIEWER: ControlPrincipal = { id: 'vw-1', role: 'viewer' };
  const OP_TOKEN = 'operator-token-cls';
  const VW_TOKEN = 'viewer-token-cls';

  const resolveFromHeader: ControlPrincipalResolver = (req: IncomingMessage) => {
    const raw = req.headers['x-coagent-control'];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (token === OP_TOKEN) return OPERATOR;
    if (token === VW_TOKEN) return VIEWER;
    return undefined;
  };

  let base: string;
  let server: ReturnType<typeof createApi>;
  let platform: Platform;
  let projects: InMemoryProjectRepository;

  before(async () => {
    const clock = new FixedClock();
    const ids = new SequentialIds();
    projects = new InMemoryProjectRepository();
    const deliveries = new InMemoryDeliveryRepository(clock, ids);
    platform = new Platform({
      projects,
      deliveries,
      activity: new InMemoryActivityLog(clock),
      clock,
      ids,
    });
    server = createApi({
      platform,
      tokens: new RunTokenRegistry(),
      deliveries,
      agentPool: new InMemoryAgentPoolRepository(),
      resolveControlPrincipal: resolveFromHeader,
    });
    await listenLoopback(server, 0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  async function post(
    path: string,
    body: unknown,
    token?: string,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers['x-coagent-control'] = token;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      json: (await res.json()) as Record<string, unknown>,
    };
  }

  test('10. auth：无/未知 401、viewer 403、operator 可创建；legacy 不变', async () => {
    const body = {
      projectId: 'P-api',
      missionId: 'M-api-lw',
      contract: CONTRACT,
      facts: facts({ mutationSideEffect: TRUE }),
      assessment: assessmentForSum(4),
      workOrder: ORDER,
    };

    assert.equal((await post('/api/missions/classified', body)).status, 401);
    assert.equal((await post('/api/missions/classified', body, 'nope')).status, 401);
    assert.equal((await post('/api/missions/classified', body, VW_TOKEN)).status, 403);

    const ok = await post('/api/missions/classified', body, OP_TOKEN);
    assert.equal(ok.status, 201);
    assert.equal(ok.json.missionId, 'M-api-lw');
    assert.ok(ok.json.workItemId);
    assert.ok(ok.json.classification);

    // legacy still works for operator and creates standard without classification
    const legacy = await post(
      '/api/missions',
      { projectId: 'P-api', missionId: 'M-legacy', contract: CONTRACT },
      OP_TOKEN,
    );
    assert.equal(legacy.status, 201);
    assert.equal(legacy.json.missionId, 'M-legacy');
    assert.equal(legacy.json.classification, undefined);
    const legacyView = await platform.getMissionView('M-legacy');
    assert.equal(legacyView.executionMode, 'standard');
    assert.equal(legacyView.workItems.length, 0);
  });

  test('11. bad routing JSON => 400；query/HA => 409', async () => {
    const bad = await post(
      '/api/missions/classified',
      {
        projectId: 'P-api',
        missionId: 'M-bad',
        contract: CONTRACT,
        facts: { mutationSideEffect: true },
      },
      OP_TOKEN,
    );
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'BAD_ROUTING_INPUT');

    const query = await post(
      '/api/missions/classified',
      {
        projectId: 'P-api',
        missionId: 'M-q',
        contract: CONTRACT,
        facts: facts({ readOnlyProven: TRUE, mutationSideEffect: FALSE }),
      },
      OP_TOKEN,
    );
    assert.equal(query.status, 409);
    assert.equal(query.json.error, 'QUERY_ROUTE_REQUIRED');

    const ha = await post(
      '/api/missions/classified',
      {
        projectId: 'P-api',
        missionId: 'M-ha-api',
        contract: CONTRACT,
        facts: facts({
          mutationSideEffect: TRUE,
          highAssurance: { destructiveData: TRUE },
        }),
      },
      OP_TOKEN,
    );
    assert.equal(ha.status, 409);
    assert.equal(ha.json.error, 'HA_SIDE_EFFECT_DENIED');
  });

  test('12. endpoint 不接受 caller mode override', async () => {
    const res = await post(
      '/api/missions/classified',
      {
        projectId: 'P-api',
        missionId: 'M-override',
        contract: CONTRACT,
        facts: facts({ mutationSideEffect: TRUE }),
        assessment: assessmentForSum(4),
        workOrder: ORDER,
        executionMode: 'lightweight',
      },
      OP_TOKEN,
    );
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'BAD_ROUTING_INPUT');
  });
});

/* ============================ D. run-mission / source ============================ */

describe('run-mission routing opt-in + source guards', () => {
  const runMissionSrc = readFileSync(
    fileURLToPath(new URL('../src/run-mission.ts', import.meta.url)),
    'utf8',
  );
  const serverSrc = readFileSync(
    fileURLToPath(new URL('../src/api/server.ts', import.meta.url)),
    'utf8',
  );
  const collectPlatformSrc = (): string => {
    const parts: string[] = [];
    parts.push(
      readFileSync(
        fileURLToPath(new URL('../src/application/platform.ts', import.meta.url)),
        'utf8',
      ),
    );
    const dir = join(fileURLToPath(new URL('../src/application/platform', import.meta.url)));
    if (existsSync(dir)) {
      const walk = (d: string): void => {
        for (const ent of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, ent.name);
          if (ent.isDirectory()) walk(full);
          else if (ent.isFile() && ent.name.endsWith('.ts')) parts.push(readFileSync(full, 'utf8'));
        }
      };
      walk(dir);
    }
    return parts.join('\n');
  };
  const platformSrc = collectPlatformSrc();

  test('13. routing 缺省仍走 legacy createMission', () => {
    assert.match(runMissionSrc, /platform\.createMission\(/);
    assert.match(runMissionSrc, /else if \(spec\.routing\)/);
    // legacy 分支不读顶层 executionMode
    assert.doesNotMatch(runMissionSrc, /spec\.executionMode/);
    assert.doesNotMatch(runMissionSrc, /routing\?\.executionMode/);
  });

  test('14. routing opt-in 调用 createClassifiedMission；字段被读取', () => {
    assert.match(runMissionSrc, /platform\.createClassifiedMission\(/);
    assert.match(runMissionSrc, /facts:\s*spec\.routing\.facts/);
    assert.match(runMissionSrc, /assessment:\s*spec\.routing\.assessment/);
    assert.match(runMissionSrc, /workOrder:\s*spec\.routing\.workOrder/);
    assert.match(runMissionSrc, /routing\?:/);

    // 联合：Platform classified lightweight 可被现有 Orchestrator Fast Lane 消费
    // （executionMode/lightweight + 1 WI）；此处用 Platform 结果证明 intake 产物形状。
  });

  test('14b. classified lightweight 产物可直接被 Fast Lane 语义消费', async () => {
    const { platform } = harness();
    const created = await platform.createClassifiedMission({
      projectId: 'P-orch',
      missionId: 'M-orch',
      contract: CONTRACT,
      facts: facts({ mutationSideEffect: TRUE }),
      assessment: assessmentForSum(3),
      workOrder: {
        ...ORDER,
        validation: { commands: [{ argv: ['node', '--test'], timeoutMs: 3000 }] },
      },
    });
    const view = await platform.getMissionView(created.missionId);
    assert.equal(view.executionMode, 'lightweight');
    assert.equal(view.runKind, 'mutation');
    assert.equal(view.workItems.length, 1);
    assert.equal(view.workItems[0]!.status, 'created');
    assert.ok(view.workItems[0]!.order);
    assert.equal(view.coordinatorAttemptIds.length, 0);
    // dispatchLightweight 前置条件满足（mode+runKind+single WI）
    assert.equal(view.status, 'investigating');
  });

  test('15. source guard：无新增 agent tool；legacy POST 不接受 mode', () => {
    assert.doesNotMatch(serverSrc, /\/api\/agent\/[^\n]*classified/);
    assert.doesNotMatch(serverSrc, /coagent_.*classified/);
    assert.doesNotMatch(serverSrc, /coagent_.*lightweight/);
    assert.match(serverSrc, /path === '\/api\/missions\/classified'/);
    // legacy createMission 路径仍是 body as never → createMission，不改 mode
    assert.match(
      serverSrc,
      /path === '\/api\/missions'[\s\S]*?platform\.createMission\(body as never\)/,
    );
    // createMission 签名未增加 executionMode
    assert.doesNotMatch(
      platformSrc,
      /async createMission\(input: CreateMissionInput[^)]*executionMode/,
    );
    assert.match(platformSrc, /async createClassifiedMission\(/);
  });
});
