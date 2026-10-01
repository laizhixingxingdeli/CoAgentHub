/**
 * 方案功能点的「现做分类」：只读协调者给事实，平台分类器定路由。
 *
 * 这里验的是那道翻译：协调者的一段自由文本输出，怎么变成一次确定性的路由——
 * 以及任何一处读不懂、越界、自相矛盾时，都安全地回落到 Standard，而不是
 * 被一段话骗进 Fast Lane。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRoutingPrompt,
  decideRoute,
  parseRoutingProposal,
} from '../src/application/plan-routing.ts';
import type { PlanFeatureSpec, PlanSpec } from '../src/application/plan-spec.ts';

const FEATURE: PlanFeatureSpec = {
  id: 'F6',
  title: 'l3.ts plan 交接面',
  why: '早上要一屏看完。',
  allowedScope: ['src/l3.ts', 'src/web/'],
  acceptance: ['四种状态各有记号且可区分。'],
};

const PLAN: PlanSpec = {
  planId: 'PLAN-x',
  projectId: 'p',
  intent: '让平台能按方案无人值守推进。',
  integrationBranch: 'auto/plan-x',
  reviewer: 'claude',
  stopConditions: { unresolvedEscalations: 5, wallClockMs: 28_800_000, escalationTimeoutMs: 1_200_000 },
  integrationVerification: [{ argv: ['node', '--test'], timeoutMs: 900_000 }],
  features: [FEATURE],
};

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
};

const SMALL = {
  goalUncertainty: 0,
  changeScope: 1,
  operationalRisk: 1,
  verificationDifficulty: 1,
  coordinationNeed: 0,
  recoveryDifficulty: 0,
  reasons: ['单文件，验收是一条命令'],
  decidedBy: 'coordinator',
  assessedAt: '2026-09-23T15:00:00.000Z',
};

/** 平台时钟给的时间：故意和 SMALL 里模型自报的那个不一样。 */
const STAMP = '2026-09-23T09:26:02.785Z';

const ORDER = {
  objective: '加 plan 子命令',
  allowedScope: ['src/l3.ts'],
  requiredBehaviour: 'node src/l3.ts plan 打一屏交接面',
  constraints: [],
  acceptance: ['四种记号可区分'],
  verification: ['node --test test/l3-plan.test.ts'],
  doNot: [],
  contextRefs: [],
  validation: { commands: [{ argv: ['node', '--test', 'test/l3-plan.test.ts'], timeoutMs: 120_000 }] },
};

function output(body: unknown, prose = '看完了，结论如下。'): string {
  return `${prose}\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;
}

function parsed(body: unknown) {
  const result = parseRoutingProposal(output(body), STAMP);
  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  return result.ok ? result.proposal : undefined;
}

describe('解析只读协调者的输出', () => {
  test('取最后一个 json 块：前面举的例子不算数', () => {
    const text =
      output({ facts: 'example' }, '格式举例：') +
      output({ facts: QUIET_FACTS, assessment: SMALL, workOrder: ORDER });
    const result = parseRoutingProposal(text, STAMP);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.proposal.workOrder?.allowedScope, ['src/l3.ts']);
  });

  test('读不懂的一律拒绝并说清为什么：没有 json 块 / 不是 JSON / 多键 / 事实不合法', () => {
    const cases: [string, RegExp][] = [
      ['我觉得是 lightweight。', /json/i],
      ['```json\n{ facts: 1 \n```', /JSON/],
      [output({ facts: QUIET_FACTS, route: 'lightweight' }), /route/],
      [output({ facts: { ...QUIET_FACTS, mutationSideEffect: 'maybe' } }), /mutationSideEffect/],
    ];
    for (const [text, why] of cases) {
      const result = parseRoutingProposal(text, STAMP);
      assert.equal(result.ok, false, text);
      assert.match(result.ok ? '' : result.reason, why);
    }
  });

  test('禁止副作用字段缺失或不是布尔 false 时，解析失败仍保留 needs_human 信号', () => {
    const keys = ['productionDeployRelease', 'externalPaidOp', 'destructiveData', 'unrecoverableExternalSideEffect'] as const;
    for (const key of keys) {
      for (const invalid of [undefined, null, 'yes', 1]) {
        const highAssurance = { ...QUIET_FACTS.highAssurance } as Record<string, unknown>;
        if (invalid === undefined) delete highAssurance[key];
        else highAssurance[key] = invalid;
        const result = parseRoutingProposal(output({ facts: { ...QUIET_FACTS, highAssurance } }), STAMP);
        assert.equal(result.ok, false);
        assert.ok(!result.ok && result.haForbiddenUnproven?.includes(key), key);
        const route = decideRoute(undefined, FEATURE, result.ok ? '' : result.reason, result.ok ? [] : result.haForbiddenUnproven);
        assert.equal(route.kind, 'needs_human', `${key}=${String(invalid)}`);
        assert.match(route.kind === 'needs_human' ? route.reason : '', new RegExp(key));
      }
    }
    for (const body of [{ assessment: SMALL }, { facts: { ...QUIET_FACTS, highAssurance: undefined } }]) {
      const result = parseRoutingProposal(output(body), STAMP);
      assert.equal(result.ok, false);
      assert.deepEqual(result.ok ? [] : result.haForbiddenUnproven, [
        'productionDeployRelease', 'externalPaidOp', 'destructiveData', 'unrecoverableExternalSideEffect',
      ]);
    }
  });

  test('评估时间盖平台的：模型自报的被覆盖，没报也补上而不是整份拒收', () => {
    // E2 实测 7/7 的 assessedAt 都是模型编的整点，有一条比实际晚 11 小时。
    const reported = parseRoutingProposal(output({ facts: QUIET_FACTS, assessment: SMALL }), STAMP);
    assert.equal(reported.ok, true, reported.ok ? '' : reported.reason);
    assert.equal(reported.ok && reported.proposal.assessment?.assessedAt, STAMP);

    const { assessedAt: _dropped, ...withoutTime } = SMALL;
    const omitted = parseRoutingProposal(output({ facts: QUIET_FACTS, assessment: withoutTime }), STAMP);
    assert.equal(omitted.ok, true, omitted.ok ? '' : omitted.reason);
    assert.equal(omitted.ok && omitted.proposal.assessment?.assessedAt, STAMP);
    assert.equal(omitted.ok && omitted.proposal.assessment?.changeScope, 1);
  });

  test('提示里不再向模型要时间', () => {
    assert.doesNotMatch(buildRoutingPrompt(PLAN, FEATURE), /assessedAt/);
  });

  test('评估必须署名 coordinator：只读协调者冒充 user 的评估不收', () => {
    const result = parseRoutingProposal(output({ facts: QUIET_FACTS, assessment: { ...SMALL, decidedBy: 'user' } }), STAMP);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /coordinator/);
  });
});

describe('定路由', () => {
  test('事实干净、分数小、工单在范围内 → Fast Lane，带着工单', () => {
    const route = decideRoute(parsed({ facts: QUIET_FACTS, assessment: SMALL, workOrder: ORDER }), FEATURE);
    assert.equal(route.kind, 'classified');
    assert.equal(route.kind === 'classified' && route.classification.recommended.executionMode, 'lightweight');
    assert.deepEqual(route.kind === 'classified' && route.workOrder?.allowedScope, ['src/l3.ts']);
  });

  test('工单范围越出方案声明 → 回落 Standard，并点名越界的路径', () => {
    const route = decideRoute(
      parsed({ facts: QUIET_FACTS, assessment: SMALL, workOrder: { ...ORDER, allowedScope: ['src/l3.ts', 'src/main.ts'] } }),
      FEATURE,
    );
    assert.equal(route.kind, 'standard_fallback');
    assert.match(route.kind === 'standard_fallback' ? route.reason : '', /src\/main\.ts/);
  });

  test('范围按 validator 的语义比：目录以 / 结尾含子孙；逃逸路径与更宽的目录都算越界', () => {
    const within = (allowedScope: string[]) =>
      decideRoute(parsed({ facts: QUIET_FACTS, assessment: SMALL, workOrder: { ...ORDER, allowedScope } }), FEATURE)
        .kind === 'classified';
    assert.equal(within(['src/web/app.js']), true);
    assert.equal(within(['src/web/parts/']), true);
    assert.equal(within(['./src/l3.ts']), true);
    assert.equal(within(['src/']), false);
    assert.equal(within(['src/web/../main.ts']), false);
    assert.equal(within(['src/l3.ts.bak']), false);
  });

  test('判成 Fast Lane 却没给工单 → 回落 Standard', () => {
    const route = decideRoute(parsed({ facts: QUIET_FACTS, assessment: SMALL }), FEATURE);
    assert.equal(route.kind, 'standard_fallback');
  });

  test('事实判到 Standard → 按 Standard 建，夹带的工单丢掉（平台禁止 Standard 带工单）', () => {
    const facts = { ...QUIET_FACTS, standardFloor: { ...QUIET_FACTS.standardFloor, publicInterface: true } };
    const route = decideRoute(parsed({ facts, assessment: SMALL, workOrder: ORDER }), FEATURE);
    assert.equal(route.kind, 'classified');
    assert.equal(route.kind === 'classified' && route.classification.recommended.executionMode, 'standard');
    assert.equal(route.kind === 'classified' ? route.workOrder : 'x', undefined);
  });

  test('事实判到 high_assurance 且禁止副作用全 false → 按 HA 建 classified，不带工单', { skip: 'HA 路暂时关闭（HAOFF1，2026-09-28），恢复 HA 分支时去掉 skip' }, () => {
    const facts = { ...QUIET_FACTS, highAssurance: { ...QUIET_FACTS.highAssurance, schemaPublicApiPersistenceCompat: true } };
    const route = decideRoute(parsed({ facts, assessment: SMALL, workOrder: ORDER }), FEATURE);
    assert.equal(route.kind, 'classified');
    assert.equal(route.kind === 'classified' && route.classification.recommended.executionMode, 'high_assurance');
    assert.equal(route.kind === 'classified' ? route.workOrder : 'x', undefined);
    assert.deepEqual(route.kind === 'classified' ? route.facts : undefined, facts);
  });

  test('HA/query 有结论回落保留分类与评估，无结论回落不带分类', () => {
    const haFacts = { ...QUIET_FACTS, highAssurance: { ...QUIET_FACTS.highAssurance, credentialsPermissionsSecurity: true } };
    const ha = decideRoute(parsed({ facts: haFacts, assessment: SMALL }), FEATURE);
    assert.equal(ha.kind, 'standard_fallback');
    assert.equal(ha.kind === 'standard_fallback' && ha.classification?.recommended.executionMode, 'high_assurance');
    assert.equal(ha.kind === 'standard_fallback' && ha.assessment?.decidedBy, 'coordinator');

    const queryFacts = { ...QUIET_FACTS, mutationSideEffect: false, readOnlyProven: true };
    const query = decideRoute(parsed({ facts: queryFacts, assessment: SMALL }), FEATURE);
    assert.equal(query.kind, 'standard_fallback');
    assert.equal(query.kind === 'standard_fallback' && query.classification?.recommended.runKind, 'query');
    assert.equal(query.kind === 'standard_fallback' && query.assessment?.decidedBy, 'coordinator');

    const unread = decideRoute(undefined, FEATURE);
    assert.equal(unread.kind, 'standard_fallback');
    assert.equal(unread.kind === 'standard_fallback' ? unread.classification : undefined, undefined);
  });

  test('合格 HA 分类回落 Standard，禁止副作用未证明仍需人工且不建单', () => {
    const haFacts = { ...QUIET_FACTS, highAssurance: { ...QUIET_FACTS.highAssurance, credentialsPermissionsSecurity: true } };
    const route = decideRoute(parsed({ facts: haFacts, assessment: SMALL }), FEATURE);
    assert.equal(route.kind, 'standard_fallback');
    assert.match(route.kind === 'standard_fallback' ? route.reason : '', /HA 路暂时关闭/);
    const unsafe = { ...haFacts, highAssurance: { ...haFacts.highAssurance, externalPaidOp: 'unknown' as const } };
    assert.equal(decideRoute(parsed({ facts: unsafe, assessment: SMALL }), FEATURE).kind, 'needs_human');
  });

  test('HA 四项禁止副作用逐项 true：不建 Mission，原因含字段名', () => {
    const keys = [
      'productionDeployRelease',
      'externalPaidOp',
      'destructiveData',
      'unrecoverableExternalSideEffect',
    ] as const;
    for (const key of keys) {
      const facts = { ...QUIET_FACTS, highAssurance: { ...QUIET_FACTS.highAssurance, [key]: true } };
      const route = decideRoute(parsed({ facts, assessment: SMALL }), FEATURE);
      assert.equal(route.kind, 'needs_human', key);
      assert.match(route.kind === 'needs_human' ? route.reason : '', new RegExp(key));
      assert.match(route.kind === 'needs_human' ? route.needsDecision : '', new RegExp(key));
      assert.match(route.kind === 'needs_human' ? route.needsDecision : '', /不建 Mission/);
    }
  });

  test('禁止副作用未证明安全时，别处错误仍 needs_human；四项全 false 的解析错误仍可回落', () => {
    const unsafe = { ...QUIET_FACTS, highAssurance: { ...QUIET_FACTS.highAssurance, externalPaidOp: true } };
    for (const body of [
      { facts: unsafe, route: 'standard' },
      { facts: unsafe, workOrder: null },
      { facts: unsafe, assessment: { ...SMALL, decidedBy: 'user' } },
    ]) {
      const result = parseRoutingProposal(output(body), STAMP);
      assert.equal(result.ok, false);
      const route = decideRoute(undefined, FEATURE, result.ok ? '' : result.reason, result.ok ? [] : result.haForbiddenUnproven);
      assert.equal(route.kind, 'needs_human');
      assert.match(route.kind === 'needs_human' ? route.needsDecision : '', /externalPaidOp/);
    }
    const safeInvalid = parseRoutingProposal(output({ facts: QUIET_FACTS, route: 'standard' }), STAMP);
    assert.equal(safeInvalid.ok, false);
    assert.equal(safeInvalid.ok ? true : safeInvalid.haForbiddenUnproven, undefined);
    assert.equal(decideRoute(undefined, FEATURE, safeInvalid.ok ? '' : safeInvalid.reason, safeInvalid.ok ? [] : safeInvalid.haForbiddenUnproven).kind, 'standard_fallback');

    const invalidSideEffect = parseRoutingProposal(
      output({ facts: { ...QUIET_FACTS, mutationSideEffect: 'maybe' } }),
      STAMP,
    );
    assert.equal(invalidSideEffect.ok, false);
    assert.equal(invalidSideEffect.ok ? true : invalidSideEffect.haForbiddenUnproven, undefined);
    assert.equal(decideRoute(undefined, FEATURE, invalidSideEffect.ok ? '' : invalidSideEffect.reason, invalidSideEffect.ok ? [] : invalidSideEffect.haForbiddenUnproven).kind, 'standard_fallback');

    const multiKey = parseRoutingProposal(
      output({ facts: QUIET_FACTS, route: 'standard', workOrder: null }),
      STAMP,
    );
    assert.equal(multiKey.ok, false);
    assert.equal(multiKey.ok ? true : multiKey.haForbiddenUnproven, undefined);
    assert.equal(decideRoute(undefined, FEATURE, multiKey.ok ? '' : multiKey.reason, multiKey.ok ? [] : multiKey.haForbiddenUnproven).kind, 'standard_fallback');
  });

  test('HA 四项禁止副作用逐项 unknown：不建 Mission，原因含字段名', () => {
    const keys = [
      'productionDeployRelease',
      'externalPaidOp',
      'destructiveData',
      'unrecoverableExternalSideEffect',
    ] as const;
    for (const key of keys) {
      const facts = { ...QUIET_FACTS, highAssurance: { ...QUIET_FACTS.highAssurance, [key]: 'unknown' } };
      const route = decideRoute(parsed({ facts, assessment: SMALL }), FEATURE);
      assert.equal(route.kind, 'needs_human', key);
      assert.match(route.kind === 'needs_human' ? route.reason : '', new RegExp(key));
      assert.match(route.kind === 'needs_human' ? route.needsDecision : '', new RegExp(key));
    }
  });

  test('判成只读 query，或者根本没读懂 → 回落 Standard，交给协调者完整核实', () => {
    const facts = { ...QUIET_FACTS, mutationSideEffect: false, readOnlyProven: true };
    // 带上一张范围内的工单：只断言「回落了」会被别的分支碰巧满足（没工单也回落），
    // 要断的是它因为「判成只读」而回落。
    const query = decideRoute(parsed({ facts, assessment: SMALL, workOrder: ORDER }), FEATURE);
    assert.equal(query.kind, 'standard_fallback');
    assert.match(query.kind === 'standard_fallback' ? query.reason : '', /不用改代码/);
    const unread = decideRoute(undefined, FEATURE, '输出里没有 json 块');
    assert.equal(unread.kind, 'standard_fallback');
    assert.match(unread.kind === 'standard_fallback' ? unread.reason : '', /没有 json 块/);
  });
});

describe('给只读协调者的话', () => {
  test('说清是哪个功能、范围、验收、只读、以及要交回的确切形状', () => {
    const prompt = buildRoutingPrompt(PLAN, FEATURE);
    for (const needle of [
      'F6',
      'l3.ts plan 交接面',
      '早上要一屏看完。',
      'src/l3.ts',
      'src/web/',
      '四种状态各有记号且可区分。',
      'auto/plan-x',
      '只读',
      '"facts"',
      '"standardFloor"',
      '"workOrder"',
      '"decidedBy": "coordinator"',
      'unknown',
    ]) {
      assert.ok(prompt.includes(needle), `提示里缺 ${needle}`);
    }
  });
});
