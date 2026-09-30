/**
 * Lightweight 交卷后的升级闸：从一份 ValidationReport 推出该不该升级、凭什么。
 *
 * 守住：
 *   - 改动规模先于验收结果：规模超了，验收过了也要升级（否则 accept 之后 L2 无从审起）
 *   - 规模内且验收通过 → 不升级
 *   - 普通失败与「验收配置本身跑不起来」都升级，但原因写得不一样
 *   - 原因可读、有上限，不把整份报告塞进一条记录
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { lightweightGateTrigger } from '../src/application/promotion/lightweight-gate.ts';
import type { ValidationReport } from '../src/kernel/index.ts';

type Check = ValidationReport['checks'][number];

function changedPaths(actual: readonly string[], passed = true): Check {
  return {
    kind: 'changed-paths',
    passed,
    startedAt: 't0',
    endedAt: 't1',
    summary: `changed-paths: ${actual.length} path(s)`,
    changedPaths: { allowedScope: ['src/'], actual, violations: [], unsupportedScope: [] },
  } as Check;
}

function command(passed: boolean, extra: Partial<Check> = {}): Check {
  return {
    kind: 'command',
    passed,
    startedAt: 't0',
    endedAt: 't1',
    summary: passed ? 'command exited 0' : 'command exited 1',
    ...extra,
  } as Check;
}

function report(checks: readonly Check[], id = 'VR-7'): ValidationReport {
  return {
    id,
    policyRevision: 1,
    missionId: 'M-lw',
    workItemId: 'W-1',
    attemptId: 'W-1.exec-1',
    startedAt: 't0',
    endedAt: 't1',
    passed: checks.every((c) => c.passed),
    checks,
  } as ValidationReport;
}

describe('Lightweight 升级闸', () => {
  test('规模内、验收通过 → 不升级', () => {
    assert.equal(lightweightGateTrigger(report([command(true), changedPaths(['src/a.ts', 'src/b.ts', 'src/c.ts'])])), null);
  });

  test('超过 3 个文件 → changed_files_gt_3，验收通过也一样', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    const trigger = lightweightGateTrigger(report([command(true), changedPaths(files)]));
    assert.equal(trigger?.code, 'changed_files_gt_3');
    assert.match(trigger!.rule, /实际改动 4 个文件，超过 Lightweight 的 3 个/);
    assert.match(trigger!.rule, /src\/d\.ts/);
  });

  test('跨 3 个顶层目录 → top_level_modules_gt_2', () => {
    const trigger = lightweightGateTrigger(report([command(true), changedPaths(['a/x.ts', 'b/y.ts', 'c/z.ts'])]));
    assert.equal(trigger?.code, 'top_level_modules_gt_2');
    assert.match(trigger!.rule, /跨 3 个顶层目录（a、b、c）/);
  });

  test('规模先于验收结果：验收没过但改了 4 个文件，记的是规模', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    const trigger = lightweightGateTrigger(report([command(false), changedPaths(files)]));
    assert.equal(trigger?.code, 'changed_files_gt_3');
  });

  test('普通失败 → validator_failure_unrepairable，原因写明报告、失败项和「没有返工通道」', () => {
    const trigger = lightweightGateTrigger(report([command(false), changedPaths(['src/a.ts'])]));
    assert.equal(trigger?.code, 'validator_failure_unrepairable');
    assert.match(trigger!.rule, /ValidationReport VR-7 未通过：command：command exited 1/);
    assert.match(trigger!.rule, /没有返工通道/);
    assert.doesNotMatch(trigger!.rule, /changed-paths/, '通过的检查不进原因');
  });

  test('验收配置本身跑不起来（invalid_argv）→ 同一个码，原因说要重写工单', () => {
    const trigger = lightweightGateTrigger(
      report([command(false, { failureCode: 'invalid_argv', summary: 'argv 为空' } as Partial<Check>), changedPaths(['src/a.ts'])]),
    );
    assert.equal(trigger?.code, 'validator_failure_unrepairable');
    assert.match(trigger!.rule, /验收配置本身跑不起来（invalid_argv）/);
    assert.match(trigger!.rule, /重写/);
  });

  test('原因有上限：文件只列前 6 个，失败摘要截到 300 字', () => {
    const files = Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`);
    const many = lightweightGateTrigger(report([command(true), changedPaths(files)]));
    assert.match(many!.rule, /等 8 项/);
    assert.doesNotMatch(many!.rule, /f7\.ts/);

    const long = lightweightGateTrigger(
      report([command(false, { summary: 'x'.repeat(1000) } as Partial<Check>), changedPaths(['src/a.ts'])]),
    );
    assert.ok(long!.rule.length < 500, `原因太长：${long!.rule.length}`);
    assert.match(long!.rule, /…/);
  });
});
