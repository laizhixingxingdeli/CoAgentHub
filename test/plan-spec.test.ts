/**
 * 方案文件：读进来的每一项都是夜里没人看着时的依据，读不懂就在开跑前停下。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import {
  PLAN_ELIGIBILITY_REASONS,
  candidateHandoffText,
  featureContract,
  parsePlanSpec,
  selectPlanCandidates,
} from '../src/application/plan-spec.ts';
import { PlatformRuleError } from '../src/application/platform.ts';

const ROOT = resolve('C:/repo/this-project');

const RAW = {
  planId: 'PLAN-x',
  projectId: 'p',
  integrationBranch: 'auto/plan-x',
  intent: '让平台能按方案无人值守推进。',
  stopConditions: { unresolvedEscalations: 5, wallClockMs: 28_800_000, escalationTimeoutMs: 1_200_000 },
  integrationVerification: [{ argv: ['node', '--test', '--test-concurrency=4'], timeoutMs: 900_000 }],
  features: [
    { id: 'F1', title: '已合的', why: 'w', allowedScope: ['a.ts'], acceptance: ['x'], status: 'done', commit: 'abc' },
    { id: 'F2', title: '要跑的', why: '因为', allowedScope: ['src/l3.ts', 'src/web/'], acceptance: ['可区分'] },
    { id: 'F3', title: '也要跑', why: '又因为', allowedScope: ['b.ts'], acceptance: ['y'] },
  ],
  note: '方案文件里的演进记录、备注照留，不影响解析。',
};

function invalid(error: unknown) {
  assert.ok(error instanceof PlatformRuleError, String(error));
  assert.equal(error.code, 'PLAN_SPEC_INVALID');
  return true;
}

function planOf(features: unknown[], extra?: Record<string, unknown>) {
  return parsePlanSpec(
    {
      planId: 'PLAN-x',
      projectId: 'p',
      integrationBranch: 'auto/plan-x',
      intent: 'i',
      stopConditions: { unresolvedEscalations: 5, wallClockMs: 1, escalationTimeoutMs: 1 },
      integrationVerification: [{ argv: ['node', '--test'], timeoutMs: 1 }],
      features,
      ...extra,
    },
    { reviewer: 'claude' },
  );
}

describe('读方案文件', () => {
  test('读出方案；检视者可由命令行指定；备注类的键照留不挡', () => {
    const plan = parsePlanSpec(RAW, { reviewer: 'claude' });
    assert.equal(plan.reviewer, 'claude');
    assert.equal(plan.integrationBranch, 'auto/plan-x');
    assert.deepEqual(plan.features.map((f) => f.id), ['F1', 'F2', 'F3']);
    assert.equal(plan.features[0].status, 'done');
    assert.deepEqual(plan.integrationVerification[0].argv, ['node', '--test', '--test-concurrency=4']);
  });

  test('没有检视者就不开跑：夜里的升级单得有人定', () => {
    assert.throws(() => parsePlanSpec(RAW), invalid);
    assert.equal(parsePlanSpec({ ...RAW, reviewer: 'claude' }).reviewer, 'claude');
  });

  test('缺集成验证、功能重名、停止条件不是正整数、未知 status → 拒绝', () => {
    const bad = [
      { ...RAW, integrationVerification: [] },
      { ...RAW, integrationVerification: [{ argv: [], timeoutMs: 1 }] },
      { ...RAW, features: [RAW.features[1], RAW.features[1]] },
      { ...RAW, features: [{ ...RAW.features[1], status: 'maybe' }] },
      { ...RAW, stopConditions: { ...RAW.stopConditions, escalationTimeoutMs: 0 } },
      { ...RAW, features: [] },
    ];
    for (const raw of bad) {
      assert.throws(() => parsePlanSpec(raw, { reviewer: 'claude' }), invalid, JSON.stringify(raw).slice(0, 80));
    }
  });

  test('未知 status 报出条目 id；范围验收类型错误整份拒绝', () => {
    assert.throws(
      () => planOf([{ id: 'Wx', title: 'x', why: 'w', allowedScope: ['a.ts'], acceptance: ['x'], status: 'mystery' }]),
      (error: unknown) => {
        invalid(error);
        assert.match((error as Error).message, /Wx/);
        assert.match((error as Error).message, /mystery/);
        return true;
      },
    );
    assert.throws(
      () => planOf([{ id: 'T', title: 'x', why: 'w', allowedScope: 'a.ts', acceptance: ['x'] }]),
      invalid,
    );
  });
});

describe('功能点 → Mission 契约', () => {
  test('意图、验收照搬；范围写成约束；别的功能点写成非目标；合并归平台', () => {
    const plan = parsePlanSpec(RAW, { reviewer: 'claude' });
    const contract = featureContract(plan, plan.features[1]);
    assert.match(contract.intent, /要跑的/);
    assert.match(contract.intent, /因为/);
    assert.deepEqual(contract.acceptance, ['可区分']);
    assert.ok(contract.constraints.some((c) => c.includes('src/l3.ts') && c.includes('src/web/')));
    assert.ok(contract.nonGoals.some((c) => c.includes('F3')));
    assert.ok(contract.guardrails.some((c) => c.includes('auto/plan-x') && /不要自己合并/.test(c)));
  });
});

/**
 * 裁剪规则（相对 missions/PLAN-harness-remaining.json；测试不读那个会继续变的文件）：
 * - 保留顶层必填字段，并保留 process / decisions 证明额外历史键不拒；
 * - 功能点各留一条、字段形状贴近真文件：A1 done（含 commit）、A4 skipped（空范围）、
 *   C5a done 且**没有 why**（手动流程记下的条目就是这样，真文件里有五条）、
 *   R0 split（repo 非路径、含 childrenDone）、D pending 空范围、D1 pending 缺范围且 dependsOn；
 * - 删掉其余功能点与超长叙述。
 */
const HARNESS_REMAINING_TRIMMED = {
  planId: 'PLAN-harness-remaining',
  projectId: 'coagenthub-v5',
  integrationBranch: 'auto/harness-remaining',
  intent: '把还没落地的部分补齐。',
  process: '走平台流程。',
  decisions: { order: '历史决定，解析必须忽略' },
  stopConditions: { unresolvedEscalations: 5, wallClockMs: 28800000, escalationTimeoutMs: 1200000 },
  integrationVerification: [{ argv: ['node', '--test'], timeoutMs: 900000 }],
  features: [
    {
      id: 'A1',
      title: 'diff-size 上限按字面「最多」',
      why: 'used >= max 会卡死。',
      allowedScope: ['src/application/validation/engine.ts'],
      acceptance: ['恰好到上限通过'],
      status: 'done',
      commit: '36817d9',
      mergedAs: 'ba13675',
    },
    {
      id: 'A4',
      title: '软预算停跑',
      why: '已撤销。',
      allowedScope: [],
      acceptance: [],
      status: 'skipped',
      skipReason: '用户撤销',
    },
    {
      id: 'C5a',
      parent: 'C5',
      title: '缺失投递的事务性补建',
      allowedScope: ['src/application/reconcile.ts'],
      acceptance: ['补建可核实的投递'],
      status: 'done',
      mergedAs: 'a7b7613',
    },
    {
      status: 'split',
      origin: '搬进 pi 的讨论',
      id: 'R0',
      repo: 'coagent-pi（coagenthub-v5 少量）',
      title: 'pi 检视者 v0',
      why: '在 pi 里当检视者。',
      childrenDone: 'R0b、R0a 都已合入——资格筛选不得据此推断 R0 done',
    },
    {
      id: 'D',
      title: 'Phase 5',
      why: '调度要持久。',
      allowedScope: [],
      acceptance: ['杀死 Runner 并重启后任务自动继续'],
      status: 'pending',
    },
    {
      status: 'pending',
      id: 'D1',
      parent: 'D',
      title: '合并两个平台',
      dependsOn: ['C5b'],
      why: '单写者。',
      note: '缺范围与验收',
    },
  ],
};

describe('真实历史方案形状（裁剪副本）', () => {
  test('显式传入 reviewer 后解析成功；done/skipped/split/pending 均识别；额外历史字段不拒；缺 reviewer 仍拒绝', () => {
    assert.throws(() => parsePlanSpec(HARNESS_REMAINING_TRIMMED), invalid);
    const plan = parsePlanSpec(HARNESS_REMAINING_TRIMMED, { reviewer: 'claude' });
    assert.equal(plan.planId, 'PLAN-harness-remaining');
    assert.deepEqual(
      plan.features.map((f) => `${f.id}:${f.status ?? ''}`),
      ['A1:done', 'A4:skipped', 'C5a:done', 'R0:split', 'D:pending', 'D1:pending'],
    );
    assert.equal(plan.features[0].allowedScope.length, 1);
    assert.equal(plan.features[2].why, undefined, '历史 done 条目缺 why 不挡解析');
    assert.deepEqual(plan.features[4].allowedScope, []);
    assert.deepEqual(plan.features[5].dependsOn, ['C5b']);
    assert.equal(plan.features[3].repo, 'coagent-pi（coagenthub-v5 少量）');
  });
});

describe('资格筛选：最小夹具覆盖状态表', () => {
  test('无 status、done、skipped、split、pending、planned、implementing、review、rework 与空范围', () => {
    const plan = planOf([
      { id: 'Legacy', title: '旧', why: 'w', allowedScope: ['a.ts'], acceptance: ['x'] },
      { id: 'Done', title: '合', why: 'w', allowedScope: ['a.ts'], acceptance: ['x'], status: 'done' },
      { id: 'Skip', title: '跳', why: 'w', allowedScope: [], acceptance: [], status: 'skipped' },
      { id: 'Split', title: '父', why: 'w', status: 'split', childrenDone: 'Child 已合' },
      { id: 'PendOk', title: '待', why: 'w', allowedScope: ['b.ts'], acceptance: ['y'], status: 'pending' },
      { id: 'PendEmpty', title: '空', why: 'w', allowedScope: [], acceptance: ['y'], status: 'pending' },
      { id: 'PendMiss', title: '缺', why: 'w', status: 'pending' },
      { id: 'PendNoWhy', title: '无目标说明', allowedScope: ['d.ts'], acceptance: ['q'], status: 'pending' },
      { id: 'DoneNoWhy', title: '历史', allowedScope: ['d.ts'], acceptance: ['q'], status: 'done' },
      { id: 'Planned', title: '规划', why: 'w', allowedScope: ['c.ts'], acceptance: ['z'], status: 'planned' },
      { id: 'Impl', title: '实现', why: 'w', allowedScope: ['c.ts'], acceptance: ['z'], status: 'implementing' },
      { id: 'Rev', title: '检视', why: 'w', allowedScope: ['c.ts'], acceptance: ['z'], status: 'review' },
      { id: 'Rework', title: '返工', why: 'w', allowedScope: ['c.ts'], acceptance: ['z'], status: 'rework' },
    ]);
    const { candidates, exclusions } = selectPlanCandidates(plan, { projectRoot: ROOT });
    assert.deepEqual(candidates.map((c) => c.id), ['Legacy', 'PendOk']);
    assert.equal(candidateHandoffText(candidates[0]), PLAN_ELIGIBILITY_REASONS.legacyCandidate);
    assert.equal(candidateHandoffText(candidates[1]), PLAN_ELIGIBILITY_REASONS.pendingCandidate);
    const reason = (id: string) => exclusions.find((e) => e.featureId === id)?.reason;
    assert.equal(reason('Done'), PLAN_ELIGIBILITY_REASONS.done);
    assert.equal(reason('Skip'), PLAN_ELIGIBILITY_REASONS.skipped);
    assert.equal(reason('Split'), PLAN_ELIGIBILITY_REASONS.split);
    assert.equal(reason('PendEmpty'), PLAN_ELIGIBILITY_REASONS.missingContract);
    assert.equal(reason('PendMiss'), PLAN_ELIGIBILITY_REASONS.missingContract);
    // 候选缺 why 同缺范围 / 验收：建不了像样的契约，不入选；历史 done 缺 why 只是照常不入选。
    assert.equal(reason('PendNoWhy'), PLAN_ELIGIBILITY_REASONS.missingContract);
    assert.equal(reason('DoneNoWhy'), PLAN_ELIGIBILITY_REASONS.done);
    assert.equal(reason('Planned'), PLAN_ELIGIBILITY_REASONS.planned);
    assert.equal(reason('Impl'), PLAN_ELIGIBILITY_REASONS.implementing);
    assert.equal(reason('Rev'), PLAN_ELIGIBILITY_REASONS.review);
    assert.equal(reason('Rework'), PLAN_ELIGIBILITY_REASONS.rework);
  });

  test('依赖必须在源方案明确标 done；未知、skipped、split、本次待跑都不算；不读 childrenDone', () => {
    const plan = planOf([
      { id: 'Dep', title: '依赖', why: 'w', allowedScope: ['a.ts'], acceptance: ['x'], status: 'done' },
      {
        id: 'Parent',
        title: '父',
        why: 'w',
        status: 'split',
        childrenDone: 'Kid 已合入，筛选不得据此放行',
      },
      {
        id: 'Ok',
        title: '可跑',
        why: 'w',
        allowedScope: ['b.ts'],
        acceptance: ['y'],
        status: 'pending',
        dependsOn: ['Dep'],
        routing: { shouldNotMatter: true },
        workOrder: { objective: '也不该决定资格' },
      },
      {
        id: 'BlockedSplit',
        title: '等父',
        why: 'w',
        allowedScope: ['c.ts'],
        acceptance: ['z'],
        status: 'pending',
        dependsOn: ['Parent'],
      },
      {
        id: 'BlockedUnknown',
        title: '未知依赖',
        why: 'w',
        allowedScope: ['c.ts'],
        acceptance: ['z'],
        status: 'pending',
        dependsOn: ['NoSuch'],
      },
      {
        id: 'Waiting',
        title: '互等',
        why: 'w',
        allowedScope: ['c.ts'],
        acceptance: ['z'],
        status: 'pending',
        dependsOn: ['Ok'],
      },
    ]);
    const { candidates, exclusions } = selectPlanCandidates(plan, { projectRoot: ROOT });
    assert.deepEqual(candidates.map((c) => c.id), ['Ok']);
    assert.equal(exclusions.find((e) => e.featureId === 'BlockedSplit')?.reason, PLAN_ELIGIBILITY_REASONS.unmetDependency('Parent'));
    assert.equal(exclusions.find((e) => e.featureId === 'BlockedUnknown')?.reason, PLAN_ELIGIBILITY_REASONS.unmetDependency('NoSuch'));
    assert.equal(exclusions.find((e) => e.featureId === 'Waiting')?.reason, PLAN_ELIGIBILITY_REASONS.unmetDependency('Ok'));
  });

  test('显式 repo 必须能证明等于 --cwd；不能确认就排除；无 repo 算本仓', () => {
    const plan = planOf([
      { id: 'Here', title: '本仓', why: 'w', allowedScope: ['a.ts'], acceptance: ['x'], status: 'pending', repo: ROOT },
      { id: 'Default', title: '默认', why: 'w', allowedScope: ['a.ts'], acceptance: ['x'], status: 'pending' },
      {
        id: 'Other',
        title: '外仓',
        why: 'w',
        allowedScope: ['a.ts'],
        acceptance: ['x'],
        status: 'pending',
        repo: 'coagent-pi（coagenthub-v5 少量）',
      },
    ]);
    const { candidates, exclusions } = selectPlanCandidates(plan, { projectRoot: ROOT });
    assert.deepEqual(candidates.map((c) => c.id), ['Here', 'Default']);
    assert.equal(exclusions.find((e) => e.featureId === 'Other')?.reason, PLAN_ELIGIBILITY_REASONS.otherRepo);
    if (process.platform === 'win32') {
      const mixed = ROOT.replace(/^[A-Za-z]/, (ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()));
      const cased = planOf([
        { id: 'Case', title: '大小写', why: 'w', allowedScope: ['a.ts'], acceptance: ['x'], status: 'pending', repo: mixed },
      ]);
      assert.deepEqual(selectPlanCandidates(cased, { projectRoot: ROOT }).candidates.map((c) => c.id), ['Case']);
    }
  });
});
