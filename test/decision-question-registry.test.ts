/**
 * PRE_DISPATCH QuestionRegistry：只读题集形状与边界。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANDIDATE_EXECUTOR_FACT_KEY,
  PRE_DISPATCH_V1,
  PRE_DISPATCH_V1_QUESTION_IDS,
  PREFERRED_EXECUTOR_NONE_OPTION,
  TASK_TYPE_OPTIONS,
  type DecisionQuestionSpec,
  type OrderedLevel,
  type PreDispatchV1QuestionId,
} from '../src/application/decision-question-registry.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const registrySrcPath = join(root, 'src', 'application', 'decision-question-registry.ts');

function findQuestion(id: PreDispatchV1QuestionId): DecisionQuestionSpec {
  const q = PRE_DISPATCH_V1.questions.find((item) => item.id === id);
  assert.ok(q, `missing question ${id}`);
  return q;
}

describe('PRE_DISPATCH_V1', () => {
  test('id 为 PRE_DISPATCH_V1', () => {
    assert.equal(PRE_DISPATCH_V1.id, 'PRE_DISPATCH_V1');
  });

  test('恰好四问，且 id 与顺序固定；candidate_executor_id 不是 question id', () => {
    const ids = PRE_DISPATCH_V1.questions.map((q) => q.id);
    assert.deepEqual(ids, [
      'task_type',
      'semantic_risk',
      'work_order_ambiguous',
      'preferred_executor',
    ]);
    assert.deepEqual([...PRE_DISPATCH_V1_QUESTION_IDS], ids);
    assert.equal(PRE_DISPATCH_V1.questions.length, 4);
    assert.equal(
      (PRE_DISPATCH_V1_QUESTION_IDS as readonly string[]).includes(CANDIDATE_EXECUTOR_FACT_KEY),
      false,
    );
    assert.equal(CANDIDATE_EXECUTOR_FACT_KEY, 'candidate_executor_id');
    assert.equal(PREFERRED_EXECUTOR_NONE_OPTION, 'none');
  });

  test('每题都有 id/kind/purpose', () => {
    for (const q of PRE_DISPATCH_V1.questions) {
      assert.equal(typeof q.id, 'string');
      assert.ok(q.id.length > 0);
      assert.ok(q.kind === 'choice' || q.kind === 'score' || q.kind === 'noul');
      assert.equal(typeof q.purpose, 'string');
      assert.ok(q.purpose.length > 0);
    }
  });

  test('task_type：choice + 固定 options', () => {
    const q = findQuestion('task_type');
    assert.equal(q.kind, 'choice');
    assert.ok(q.kind === 'choice' && 'options' in q);
    assert.deepEqual([...q.options], [
      'bugfix',
      'feature',
      'refactor',
      'research',
      'test',
      'config',
      'other',
    ]);
    assert.deepEqual([...TASK_TYPE_OPTIONS], [...q.options]);
    assert.equal('optionSource' in q, false);
  });

  test('semantic_risk：score + orderedLevels[{label,rubric}]', () => {
    const q = findQuestion('semantic_risk');
    assert.equal(q.kind, 'score');
    assert.ok(q.kind === 'score' && 'orderedLevels' in q);
    assert.deepEqual(
      q.orderedLevels.map((l: OrderedLevel) => l.label),
      ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
    );
    const byLabel = Object.fromEntries(q.orderedLevels.map((l) => [l.label, l.rubric]));
    assert.match(byLabel.LOW!, /局部/);
    assert.match(byLabel.LOW!, /易恢复/);
    assert.match(byLabel.LOW!, /影响明确|范围/);
    assert.match(byLabel.MEDIUM!, /跨多个局部|模块/);
    assert.match(byLabel.MEDIUM!, /边界|回滚/);
    assert.match(byLabel.HIGH!, /公共API|核心流程|共享状态|跨模块/);
    assert.match(byLabel.CRITICAL!, /不可逆|安全|权限|架构|控制面/);
    for (const level of q.orderedLevels) {
      assert.equal(typeof level.rubric, 'string');
      assert.ok(level.rubric.length > 0);
    }
  });

  test('work_order_ambiguous：noul + purpose', () => {
    const q = findQuestion('work_order_ambiguous');
    assert.equal(q.kind, 'noul');
    assert.equal(q.purpose, '是否存在两种以上明显不同的合理实现');
    assert.equal('options' in q, false);
  });

  test('preferred_executor：choice + candidate_set_plus_none，无具体候选', () => {
    const q = findQuestion('preferred_executor');
    assert.equal(q.kind, 'choice');
    assert.ok(q.kind === 'choice' && 'optionSource' in q);
    assert.equal(q.optionSource, 'candidate_set_plus_none');
    assert.equal('options' in q, false);
  });

  test('kinds 与各题字段一致（汇总）', () => {
    const kinds = PRE_DISPATCH_V1.questions.map((q: DecisionQuestionSpec) => q.kind);
    assert.deepEqual(kinds, ['choice', 'score', 'noul', 'choice']);
  });

  test('深层不可变：改写 questions / options / orderedLevels 应失败', () => {
    const reg = PRE_DISPATCH_V1;
    assert.throws(() => {
      (reg as { id: string }).id = 'X';
    }, TypeError);
    assert.throws(() => {
      (reg.questions as DecisionQuestionSpec[]).push({
        id: 'work_order_ambiguous',
        kind: 'noul',
        purpose: 'no',
      });
    }, TypeError);

    const task = findQuestion('task_type');
    assert.ok(task.kind === 'choice' && 'options' in task);
    assert.throws(() => {
      (task.options as string[]).push('hack');
    }, TypeError);

    const risk = findQuestion('semantic_risk');
    assert.ok(risk.kind === 'score' && 'orderedLevels' in risk);
    assert.throws(() => {
      (risk.orderedLevels as OrderedLevel[]).push({ label: 'ULTRA', rubric: 'x' });
    }, TypeError);
    assert.throws(() => {
      (risk.orderedLevels[0] as { rubric: string }).rubric = 'changed';
    }, TypeError);
  });

  test('provider-neutral：源文件不出现 banned 语义', () => {
    const source = readFileSync(registrySrcPath, 'utf8');
    const banned = [
      /\bJev\b/,
      /\bhttp\b/i,
      /apiKey/i,
      /baseURL/i,
      /\bmodel\b/i,
      /confidence/i,
      /probabilities/i,
      /\bscale\b/i,
      /\bmin\b/,
      /\bmax\b/,
      /transport/i,
      /criteria/i,
      /instructions/i,
      /DecisionProvider/,
      /\bfetch\b/,
      /\bwire\b/i,
    ];
    for (const re of banned) {
      assert.doesNotMatch(source, re, `registry 源出现 ${re}`);
    }
    for (const q of PRE_DISPATCH_V1.questions) {
      assert.equal('instructions' in q, false, `${q.id} must not carry instructions`);
      assert.equal('criteria' in q, false, `${q.id} must not carry criteria`);
    }
  });
});
