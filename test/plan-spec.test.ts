/**
 * 方案文件：读进来的每一项都是夜里没人看着时的依据，读不懂就在开跑前停下。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { featureContract, parsePlanSpec } from '../src/application/plan-spec.ts';
import { PlatformRuleError } from '../src/application/platform.ts';

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

  test('缺集成验证、功能重名、范围或验收为空、停止条件不是正整数 → 拒绝', () => {
    const bad = [
      { ...RAW, integrationVerification: [] },
      { ...RAW, integrationVerification: [{ argv: [], timeoutMs: 1 }] },
      { ...RAW, features: [RAW.features[1], RAW.features[1]] },
      { ...RAW, features: [{ ...RAW.features[1], allowedScope: [] }] },
      { ...RAW, features: [{ ...RAW.features[1], acceptance: [] }] },
      { ...RAW, features: [{ ...RAW.features[1], status: 'maybe' }] },
      { ...RAW, stopConditions: { ...RAW.stopConditions, escalationTimeoutMs: 0 } },
      { ...RAW, features: [] },
    ];
    for (const raw of bad) {
      assert.throws(() => parsePlanSpec(raw, { reviewer: 'claude' }), invalid, JSON.stringify(raw).slice(0, 80));
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
    assert.ok(contract.constraints.some((c) => c.includes('src/l3.ts') && c.includes('src/web/')));
    assert.ok(contract.nonGoals.some((c) => c.includes('F3')));
    assert.ok(contract.guardrails.some((c) => c.includes('auto/plan-x') && /不要自己合并/.test(c)));
  });
});
