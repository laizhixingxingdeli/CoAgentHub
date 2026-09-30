/**
 * Decision 模式 parser + 启动门禁：OFF/SHADOW 诚实语义。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertDecisionModeStartup,
  parseDecisionHooks,
  parseDecisionMode,
} from '../src/application/decision-mode.ts';

describe('parseDecisionMode', () => {
  test('缺省 / null / undefined => off', () => {
    assert.equal(parseDecisionMode(undefined), 'off');
    assert.equal(parseDecisionMode(null), 'off');
  });

  test('空字符串与纯空白 => off', () => {
    assert.equal(parseDecisionMode(''), 'off');
    assert.equal(parseDecisionMode('   '), 'off');
    assert.equal(parseDecisionMode('\t\n'), 'off');
  });

  test('off（大小写/空白可规范化）=> off', () => {
    assert.equal(parseDecisionMode('off'), 'off');
    assert.equal(parseDecisionMode('OFF'), 'off');
    assert.equal(parseDecisionMode(' Off '), 'off');
  });

  test('shadow（大小写/空白可规范化）=> shadow', () => {
    assert.equal(parseDecisionMode('shadow'), 'shadow');
    assert.equal(parseDecisionMode('SHADOW'), 'shadow');
    assert.equal(parseDecisionMode(' Shadow '), 'shadow');
  });

  test('未知/非法值 fail-closed 为 off，不抛', () => {
    assert.equal(parseDecisionMode('enforced'), 'off');
    assert.equal(parseDecisionMode('advisory'), 'off');
    assert.equal(parseDecisionMode('on'), 'off');
    assert.equal(parseDecisionMode('true'), 'off');
    assert.equal(parseDecisionMode('1'), 'off');
    assert.equal(parseDecisionMode('shadow-extra'), 'off');
  });
});

describe('assertDecisionModeStartup', () => {
  test('off + 无 provider：通过', () => {
    assert.doesNotThrow(() =>
      assertDecisionModeStartup({ mode: 'off', providerAvailable: false }),
    );
  });

  test('off + 有 provider：通过（OFF 不要求 provider）', () => {
    assert.doesNotThrow(() =>
      assertDecisionModeStartup({ mode: 'off', providerAvailable: true }),
    );
  });

  test('shadow + 有 provider：通过', () => {
    assert.doesNotThrow(() =>
      assertDecisionModeStartup({ mode: 'shadow', providerAvailable: true }),
    );
  });

  test('shadow + 无 provider：抛明确配置错误', () => {
    assert.throws(
      () => assertDecisionModeStartup({ mode: 'shadow', providerAvailable: false }),
      /shadow requested but no DecisionProvider injected/,
    );
  });
});

describe('parseDecisionHooks（J1）', () => {
  const as = (raw: string | undefined) => [...parseDecisionHooks(raw)].sort();

  test('缺省 / 空 / 纯空白 => 只有 POST_EXECUTION（PRE 默认关）', () => {
    assert.deepEqual(as(undefined), ['POST_EXECUTION']);
    assert.deepEqual(as(''), ['POST_EXECUTION']);
    assert.deepEqual(as('   '), ['POST_EXECUTION']);
  });

  test('显式写上才开 PRE；大小写、连字符、空白都认', () => {
    assert.deepEqual(as('pre_dispatch'), ['PRE_DISPATCH']);
    assert.deepEqual(as('PRE-DISPATCH , post_execution'), ['POST_EXECUTION', 'PRE_DISPATCH']);
    assert.deepEqual(as('pre,post'), ['POST_EXECUTION', 'PRE_DISPATCH']);
  });

  test('none 或全是不认识的词 => 一个都不跑（写错时宁可少调）', () => {
    assert.deepEqual(as('none'), []);
    assert.deepEqual(as('predispatch,bogus'), []);
  });
});
