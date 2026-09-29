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
import {
  DEFAULT_MAX_ESCALATIONS,
  DEFAULT_MAX_RERUNS_PER_FEATURE,
} from '../src/application/plan-run.ts';
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

  test('constraints、nonGoals 缺省或按字符串列表读取；非法值报告条目 id 与字段名', () => {
    const defaults = planOf([{ id: 'Bounds', title: '边界', why: 'w', allowedScope: ['a.ts'], acceptance: ['x'] }]);
    assert.equal(defaults.features[0].constraints, undefined);
    assert.equal(defaults.features[0].nonGoals, undefined);
    const parsed = planOf([{
      id: 'Bounds', title: '边界', why: 'w', allowedScope: ['a.ts'], acceptance: ['x'],
      constraints: ['先一', '再二'], nonGoals: ['不做一', '不做二'],
    }]);
    assert.deepEqual(parsed.features[0].constraints, ['先一', '再二']);
    assert.deepEqual(parsed.features[0].nonGoals, ['不做一', '不做二']);
    for (const field of ['constraints', 'nonGoals']) {
      for (const value of ['not-array', ['  '], ['valid', 1]]) {
        assert.throws(
          () => planOf([{ id: 'Bounds', title: '边界', why: 'w', allowedScope: ['a.ts'], acceptance: ['x'], [field]: value }]),
          (error: unknown) => {
            invalid(error);
            assert.match((error as Error).message, /Bounds/);
            assert.match((error as Error).message, new RegExp(field));
            return true;
          },
        );
      }
    }
  });

  test('未知 status 报出条目 id；why、范围、验收类型错误整份拒绝', () => {
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
    // why 可以缺（历史条目），但写了就得是字符串：写错类型是手误，不能悄悄当成「缺」。
    for (const why of [42, ['w'], { text: 'w' }, null]) {
      assert.throws(
        () => planOf([{ id: 'Wt', title: 'x', why, allowedScope: ['a.ts'], acceptance: ['x'], status: 'done' }]),
        invalid,
        JSON.stringify(why),
      );
    }
  });
});

describe('功能点 → Mission 契约', () => {
  test('意图、验收照搬；范围写成约束；别的功能点写成非目标；合并归平台', () => {
    const plan = parsePlanSpec(RAW, { reviewer: 'claude' });
    const contract = featureContract(plan, plan.features[1]);
    assert.match(contract.intent, /要跑的/);
    assert.match(contract.intent, /因为/);
    assert.deepEqual(contract.acceptance, ['可区分']);
    assert.deepEqual(contract.constraints, ['只改方案为它声明的范围：src/l3.ts、src/web/。']);
    assert.deepEqual(contract.nonGoals, ['方案 PLAN-x 里的其他功能点（F1「已合的」、F3「也要跑」）不在本 Mission 范围内。']);
    assert.ok(contract.guardrails.some((c) => c.includes('auto/plan-x') && /不要自己合并/.test(c)));
  });

  test('逐字段将条目边界按顺序并入契约；无其他功能点时仅保留条目 nonGoals', () => {
    const plan = planOf([
      {
        id: 'Only', title: '唯一', why: 'w', allowedScope: ['a.ts'], acceptance: ['x'],
        constraints: ['条目约束一', '条目约束二'], nonGoals: ['条目非目标一', '条目非目标二'],
      },
    ]);
    const contract = featureContract(plan, plan.features[0]);
    assert.deepEqual(contract.constraints, ['只改方案为它声明的范围：a.ts。', '条目约束一', '条目约束二']);
    assert.deepEqual(contract.nonGoals, ['条目非目标一', '条目非目标二']);
    const defaults = planOf([{ id: 'Only', title: '唯一', why: 'w', allowedScope: ['a.ts'], acceptance: ['x'] }]);
    const defaultContract = featureContract(defaults, defaults.features[0]);
    assert.deepEqual(defaultContract.constraints, ['只改方案为它声明的范围：a.ts。']);
    assert.deepEqual(defaultContract.nonGoals, []);
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
      { id: 'PendAccEmpty', title: '验收空', why: 'w', allowedScope: ['e.ts'], acceptance: [], status: 'pending' },
      { id: 'PendAccMiss', title: '缺验收', why: 'w', allowedScope: ['e.ts'], status: 'pending' },
      { id: 'DoneNoWhy', title: '历史', allowedScope: ['d.ts'], acceptance: ['q'], status: 'done' },
      { id: 'Planned', title: '规划', why: 'w', allowedScope: ['c.ts'], acceptance: ['z'], status: 'planned' },
      { id: 'Impl', title: '实现', why: 'w', allowedScope: ['c.ts'], acceptance: ['z'], status: 'implementing' },
      { id: 'Rev', title: '检视', why: 'w', allowedScope: ['c.ts'], acceptance: ['z'], status: 'review' },
      { id: 'Rework', title: '返工', why: 'w', allowedScope: ['c.ts'], acceptance: ['z'], status: 'rework' },
    ]);
    const { candidates, exclusions, warnings } = selectPlanCandidates(plan, { projectRoot: ROOT });
    assert.deepEqual(candidates.map((c) => c.id), ['Legacy', 'PendOk']);
    assert.deepEqual(warnings, []);
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
    // 其余契约齐全、只有验收空或只缺验收：同样建不了可验收的 Mission。
    assert.equal(reason('PendAccEmpty'), PLAN_ELIGIBILITY_REASONS.missingContract);
    assert.equal(reason('PendAccMiss'), PLAN_ELIGIBILITY_REASONS.missingContract);
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
    const { candidates, exclusions, warnings } = selectPlanCandidates(plan, { projectRoot: ROOT });
    assert.deepEqual(candidates.map((c) => c.id), ['Ok']);
    assert.deepEqual(warnings, []);
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
    const { candidates, exclusions, warnings } = selectPlanCandidates(plan, { projectRoot: ROOT });
    assert.deepEqual(candidates.map((c) => c.id), ['Here', 'Default']);
    assert.deepEqual(warnings, []);
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

describe('资格筛选：条目契约检查', () => {
  test('allowedScope 以 .coagent/ 开头 → 排除；不以该前缀则仍可入选', () => {
    const plan = planOf([
      {
        id: 'Truth', title: '规格', why: 'w',
        allowedScope: ['src/ok.ts', '.coagent/specs/durable-scheduler.md'],
        acceptance: ['x'], status: 'pending',
      },
      {
        id: 'Ok', title: '代码', why: 'w',
        allowedScope: ['src/ok.ts', '.coagent-worktrees/M1/a.ts'],
        acceptance: ['x'], status: 'pending',
      },
    ]);
    const { candidates, exclusions } = selectPlanCandidates(plan, { projectRoot: ROOT });
    assert.deepEqual(candidates.map((c) => c.id), ['Ok']);
    const truth = exclusions.find((e) => e.featureId === 'Truth');
    assert.equal(truth?.reason, PLAN_ELIGIBILITY_REASONS.projectTruth);
    assert.match(truth?.reason ?? '', /L1 不得改 Project Truth/);
    assert.match(truth?.reason ?? '', /memoryDelta/);
  });

  test('allowedScope 名为 VIBE.md → 排除；其它文件名仍可入选', () => {
    const plan = planOf([
      {
        id: 'RootVibe', title: '根', why: 'w',
        allowedScope: ['VIBE.md'], acceptance: ['x'], status: 'pending',
      },
      {
        id: 'NestedVibe', title: '嵌', why: 'w',
        allowedScope: ['docs/VIBE.md'], acceptance: ['x'], status: 'pending',
      },
      {
        id: 'Ok', title: '旁', why: 'w',
        allowedScope: ['README.md', 'VIBE.md.bak', 'src/vibe.md'],
        acceptance: ['x'], status: 'pending',
      },
    ]);
    const { candidates, exclusions } = selectPlanCandidates(plan, { projectRoot: ROOT });
    assert.deepEqual(candidates.map((c) => c.id), ['Ok']);
    assert.equal(exclusions.find((e) => e.featureId === 'RootVibe')?.reason, PLAN_ELIGIBILITY_REASONS.projectTruth);
    assert.equal(exclusions.find((e) => e.featureId === 'NestedVibe')?.reason, PLAN_ELIGIBILITY_REASONS.projectTruth);
  });

  test('allowedScope 绝对路径（盘符或以 / 开头）→ 排除；相对路径仍可入选', () => {
    const plan = planOf([
      {
        id: 'Drive', title: '盘符', why: 'w',
        allowedScope: ['C:/repo/a.ts'], acceptance: ['x'], status: 'pending',
      },
      {
        id: 'UnixAbs', title: '根', why: 'w',
        allowedScope: ['/tmp/a.ts'], acceptance: ['x'], status: 'pending',
      },
      {
        id: 'Ok', title: '相对', why: 'w',
        allowedScope: ['src/a.ts'], acceptance: ['x'], status: 'pending',
      },
    ]);
    const { candidates, exclusions } = selectPlanCandidates(plan, { projectRoot: ROOT });
    assert.deepEqual(candidates.map((c) => c.id), ['Ok']);
    assert.equal(exclusions.find((e) => e.featureId === 'Drive')?.reason, PLAN_ELIGIBILITY_REASONS.unsafeScopePath);
    assert.equal(exclusions.find((e) => e.featureId === 'UnixAbs')?.reason, PLAN_ELIGIBILITY_REASONS.unsafeScopePath);
  });

  test('allowedScope 含 .. 段 → 排除；文件名含 .. 但不是段则仍可入选', () => {
    const plan = planOf([
      {
        id: 'Up', title: '上跳', why: 'w',
        allowedScope: ['src/../secret.ts'], acceptance: ['x'], status: 'pending',
      },
      {
        id: 'Parent', title: '父', why: 'w',
        allowedScope: ['../outside.ts'], acceptance: ['x'], status: 'pending',
      },
      {
        id: 'Ok', title: '名', why: 'w',
        allowedScope: ['src/foo..bar.ts'], acceptance: ['x'], status: 'pending',
      },
    ]);
    const { candidates, exclusions } = selectPlanCandidates(plan, { projectRoot: ROOT });
    assert.deepEqual(candidates.map((c) => c.id), ['Ok']);
    assert.equal(exclusions.find((e) => e.featureId === 'Up')?.reason, PLAN_ELIGIBILITY_REASONS.unsafeScopePath);
    assert.equal(exclusions.find((e) => e.featureId === 'Parent')?.reason, PLAN_ELIGIBILITY_REASONS.unsafeScopePath);
  });

  test('acceptance 未覆盖仓内路径只警告不排除；文件覆盖、目录覆盖、:12 后缀；constraints/nonGoals 不参与', () => {
    const plan = planOf([
      {
        id: 'FileHit', title: '文件覆盖', why: 'w',
        allowedScope: ['src/a.ts'], acceptance: ['src/a.ts 必须绿'], status: 'pending',
      },
      {
        id: 'DirHit', title: '目录覆盖', why: 'w',
        allowedScope: ['src/'], acceptance: ['src/nested/b.ts'], status: 'pending',
      },
      {
        id: 'LineHit', title: '行号覆盖', why: 'w',
        allowedScope: ['src/a.ts'], acceptance: ['src/a.ts:12'], status: 'pending',
      },
      {
        id: 'Miss', title: '未覆盖', why: 'w',
        allowedScope: ['src/a.ts'], acceptance: ['src/other.ts 也要', '普通验收句'], status: 'pending',
      },
      {
        id: 'LineMiss', title: '行号未覆盖', why: 'w',
        allowedScope: ['src/a.ts'], acceptance: ['src/other.ts:12'], status: 'pending',
      },
      {
        id: 'Bounds', title: '旁路字段', why: 'w',
        allowedScope: ['src/a.ts'], acceptance: ['x'],
        constraints: ['不得改 src/secret.ts'], nonGoals: ['src/other.ts 不在范围'],
        status: 'pending',
      },
    ]);
    const { candidates, exclusions, warnings } = selectPlanCandidates(plan, { projectRoot: ROOT });
    assert.deepEqual(candidates.map((c) => c.id), ['FileHit', 'DirHit', 'LineHit', 'Miss', 'LineMiss', 'Bounds']);
    assert.equal(exclusions.length, 0);
    assert.deepEqual(warnings, [
      'Miss：验收路径 src/other.ts 未被范围覆盖',
      'LineMiss：验收路径 src/other.ts 未被范围覆盖',
    ]);
    assert.ok(warnings.every((w) => w.includes('Miss') && w.includes('src/other.ts')));
  });

  test('验收路径只认四类目录前缀与根点文件：vendor/a.ts 和根 a.ts 不警告，.gitattributes 警告',
    () => {
      const plan = planOf([
        {
          id: 'Noise', title: '非目标', why: 'w',
          allowedScope: ['src/a.ts'],
          acceptance: ['vendor/a.ts 不算', 'a.ts 根文件不算', '普通句'],
          status: 'pending',
        },
        {
          id: 'DotMiss', title: '根点未覆盖', why: 'w',
          allowedScope: ['src/a.ts'], acceptance: ['.gitattributes 必须一致'], status: 'pending',
        },
        {
          id: 'DotHit', title: '根点覆盖', why: 'w',
          allowedScope: ['.gitattributes'], acceptance: ['.gitattributes 保持 LF'], status: 'pending',
        },
        {
          id: 'DocsMiss', title: 'docs 未覆盖', why: 'w',
          allowedScope: ['src/a.ts'], acceptance: ['docs/reports/x.md'], status: 'pending',
        },
        {
          id: 'TestHit', title: 'test 覆盖', why: 'w',
          allowedScope: ['test/'], acceptance: ['test/plan-spec.test.ts'], status: 'pending',
        },
        {
          id: 'ScriptsMiss', title: 'scripts 未覆盖', why: 'w',
          allowedScope: ['src/a.ts'], acceptance: ['scripts/foo.mjs'], status: 'pending',
        },
      ]);
      const { candidates, exclusions, warnings } = selectPlanCandidates(plan, { projectRoot: ROOT });
      assert.deepEqual(
        candidates.map((c) => c.id),
        ['Noise', 'DotMiss', 'DotHit', 'DocsMiss', 'TestHit', 'ScriptsMiss'],
      );
      assert.equal(exclusions.length, 0);
      assert.deepEqual(warnings, [
        'DotMiss：验收路径 .gitattributes 未被范围覆盖',
        'DocsMiss：验收路径 docs/reports/x.md 未被范围覆盖',
        'ScriptsMiss：验收路径 scripts/foo.mjs 未被范围覆盖',
      ]);
    });

  test('带常见尾随标点及 :12 的验收目标按文件提取并覆盖', () => {
    const plan = planOf([
      {
        id: 'PunctHit', title: '标点覆盖', why: 'w',
        allowedScope: ['src/a.ts'],
        acceptance: ['见 src/a.ts。', '还有 src/a.ts.', '`src/a.ts:12`', '（src/a.ts:12）'],
        status: 'pending',
      },
      {
        id: 'PunctMiss', title: '标点未覆盖', why: 'w',
        allowedScope: ['src/a.ts'],
        acceptance: ['漏了 src/other.ts。', '以及 src/miss.ts:12.'],
        status: 'pending',
      },
    ]);
    const { candidates, exclusions, warnings } = selectPlanCandidates(plan, { projectRoot: ROOT });
    assert.deepEqual(candidates.map((c) => c.id), ['PunctHit', 'PunctMiss']);
    assert.equal(exclusions.length, 0);
    assert.deepEqual(warnings, [
      'PunctMiss：验收路径 src/other.ts 未被范围覆盖',
      'PunctMiss：验收路径 src/miss.ts 未被范围覆盖',
    ]);
  });

  test('中英文标点切词与顶层泛指目录：六组夹具的完整警告列表', () => {
    // 空 allowedScope 会先按缺契约排除，启发式根本不会跑；用无关占位表示「范围不覆盖」。
    const uncoveredScope = ['README.md'];
    const cl1Scope = [
      'src/application/plan-spec.ts',
      'src/run-plan.ts',
      'test/plan-spec.test.ts',
      'test/run-plan-wiring.test.ts',
    ];
    const cl1Acceptance = [
      '确定性规则直接排除（写进 exclusions，不进候选，原因写清楚）：allowedScope 里有以 .coagent/ 开头的路径或名为 VIBE.md 的路径（原因写明 L1 不得改 Project Truth，规格走交卷 memoryDelta）；allowedScope 里有绝对路径（含盘符或以 / 开头）或含 .. 段的路径。每条规则各有正反测试。',
      '启发式只报警、不排除：acceptance 里出现、看起来像仓内文件的路径（以 src/、test/、scripts/、docs/ 开头，或仓库根的点文件如 .gitattributes），既不等于 allowedScope 的某一项、也不在 allowedScope 的某个目录项（以 / 结尾）之下时，产出一条警告，写明条目 id 与未覆盖的路径。constraints 与 nonGoals 不参与这条规则（它们常点名不许改的文件）。测试覆盖：覆盖到的文件、目录项覆盖、未覆盖、带行号后缀（如 src/a.ts:12）按文件本身判断。',
      'run-plan --check 在入选 / 未纳入列表之后打印全部警告（没有警告时不打印这一段）；正式开跑时同样把警告写进日志，但不因警告拒绝开跑。有排除时照现有格式列在「未纳入」里。',
      '对真实方案 missions/PLAN-harness-remaining.json（Mission worktree 里没有这个文件，就用测试夹具覆盖各规则）不引入额外排除：已 done / skipped 的条目不参与检查，只检查会成为候选的条目。',
      '交卷前在 Mission worktree 跑全量 `node --test`：0 fail（只允许 HAOFF1 既有的 7 条 skip），并把结果行（tests / pass / fail / skipped）写进交卷证据。',
    ];
    const plan = planOf([
      {
        id: 'GenericTop', title: '泛指顶层', why: 'w',
        allowedScope: uncoveredScope,
        acceptance: ['检查以 src/、test/、scripts/、docs/ 开头的路径'],
        status: 'pending',
      },
      {
        id: 'LineCovered', title: '行号有范围', why: 'w',
        allowedScope: ['src/a.ts'],
        acceptance: ['带行号后缀（如 src/a.ts:12）按文件本身判断'],
        status: 'pending',
      },
      {
        id: 'LineEmpty', title: '行号空范围', why: 'w',
        allowedScope: uncoveredScope,
        acceptance: ['带行号后缀（如 src/a.ts:12）按文件本身判断'],
        status: 'pending',
      },
      {
        id: 'CnComma', title: '全角逗号句号', why: 'w',
        allowedScope: ['src/b.ts'],
        acceptance: ['改 src/b.ts，再补 test/b.test.ts。'],
        status: 'pending',
      },
      {
        id: 'Wrapped', title: '括号反引号', why: 'w',
        allowedScope: uncoveredScope,
        acceptance: ['（见 `src/c.ts`）'],
        status: 'pending',
      },
      {
        id: 'DeepDirHit', title: '深目录覆盖', why: 'w',
        allowedScope: ['test/fixtures/x/'],
        acceptance: ['test/fixtures/x/ 下的夹具'],
        status: 'pending',
      },
      {
        id: 'DeepDirMiss', title: '深目录空范围', why: 'w',
        allowedScope: uncoveredScope,
        acceptance: ['test/fixtures/x/ 下的夹具'],
        status: 'pending',
      },
      {
        id: 'CL1Original', title: 'CL1 原文',
        why: '冻结契约的疏漏要等 Mission 开跑后由协调者提问才暴露。',
        allowedScope: cl1Scope,
        acceptance: cl1Acceptance,
        status: 'pending',
      },
    ]);
    const { candidates, exclusions, warnings } = selectPlanCandidates(plan, { projectRoot: ROOT });
    assert.deepEqual(
      candidates.map((c) => c.id),
      ['GenericTop', 'LineCovered', 'LineEmpty', 'CnComma', 'Wrapped', 'DeepDirHit', 'DeepDirMiss', 'CL1Original'],
    );
    assert.equal(exclusions.length, 0);
    assert.deepEqual(warnings, [
      'LineEmpty：验收路径 src/a.ts 未被范围覆盖',
      'CnComma：验收路径 test/b.test.ts 未被范围覆盖',
      'Wrapped：验收路径 src/c.ts 未被范围覆盖',
      'DeepDirMiss：验收路径 test/fixtures/x/ 未被范围覆盖',
      'CL1Original：验收路径 .gitattributes 未被范围覆盖',
      'CL1Original：验收路径 src/a.ts 未被范围覆盖',
    ]);
    // 旧切词会把顿号/全角括号粘进路径；完整列表已排除这两条，再钉死形状以免回归。
    assert.equal(warnings.some((w) => w.includes('src/、test/、scripts/、docs/')), false);
    assert.equal(warnings.some((w) => w.includes('src/a.ts:12）按文件本身判断')), false);
  });

  test('done、skipped 等非候选不因新增检查产生额外排除或警告', () => {
    const plan = planOf([
      {
        id: 'Done', title: '合', why: 'w',
        allowedScope: ['.coagent/project.md', 'C:/abs.ts', 'src/../x.ts'],
        acceptance: ['src/ghost.ts'], status: 'done',
      },
      {
        id: 'Skip', title: '跳', why: 'w',
        allowedScope: ['VIBE.md'], acceptance: ['src/ghost.ts'], status: 'skipped',
      },
      {
        id: 'PendMiss', title: '缺', why: 'w', status: 'pending',
        allowedScope: ['.coagent/specs/x.md'],
      },
    ]);
    const { candidates, exclusions, warnings } = selectPlanCandidates(plan, { projectRoot: ROOT });
    assert.deepEqual(candidates.map((c) => c.id), []);
    assert.deepEqual(warnings, []);
    assert.equal(exclusions.find((e) => e.featureId === 'Done')?.reason, PLAN_ELIGIBILITY_REASONS.done);
    assert.equal(exclusions.find((e) => e.featureId === 'Skip')?.reason, PLAN_ELIGIBILITY_REASONS.skipped);
    assert.equal(exclusions.find((e) => e.featureId === 'PendMiss')?.reason, PLAN_ELIGIBILITY_REASONS.missingContract);
  });
});

describe('两道夜跑闸（stopConditions 新字段）', () => {
  test('缺字段时补缺省；显式值原样保留',
    () => {
      const missing = parsePlanSpec(RAW, { reviewer: 'claude' });
      assert.equal(missing.stopConditions.maxEscalations, DEFAULT_MAX_ESCALATIONS);
      assert.equal(missing.stopConditions.maxRerunsPerFeature, DEFAULT_MAX_RERUNS_PER_FEATURE);

      const explicit = parsePlanSpec(
        { ...RAW, stopConditions: { ...RAW.stopConditions, maxEscalations: 3, maxRerunsPerFeature: 2 } },
        { reviewer: 'claude' },
      );
      assert.equal(explicit.stopConditions.maxEscalations, 3);
      assert.equal(explicit.stopConditions.maxRerunsPerFeature, 2);
      assert.equal(explicit.stopConditions.unresolvedEscalations, 5);
    });

  test('非法显式值（0、-1、1.5、字符串、null）整份 PLAN_SPEC_INVALID', () => {
    for (const value of [0, -1, 1.5, '3', null]) {
      assert.throws(
        () =>
          parsePlanSpec(
            { ...RAW, stopConditions: { ...RAW.stopConditions, maxEscalations: value } },
            { reviewer: 'claude' },
          ),
        invalid,
        `maxEscalations=${String(value)}`,
      );
      assert.throws(
        () =>
          parsePlanSpec(
            { ...RAW, stopConditions: { ...RAW.stopConditions, maxRerunsPerFeature: value } },
            { reviewer: 'claude' },
          ),
        invalid,
        `maxRerunsPerFeature=${String(value)}`,
      );
    }
  });

  test('旧方案夹具缺这两个字段照常解析',
    () => {
      const plan = parsePlanSpec(HARNESS_REMAINING_TRIMMED, { reviewer: 'claude' });
      assert.equal(plan.stopConditions.maxEscalations, DEFAULT_MAX_ESCALATIONS);
      assert.equal(plan.stopConditions.maxRerunsPerFeature, DEFAULT_MAX_RERUNS_PER_FEATURE);
    });
});
