import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MoneyError, formatCents, parseAmount, parseDecimal, roundHalfEven } from '../src/money.js';

test('parseAmount 把元转成分', () => {
  assert.equal(parseAmount('12.34'), 1234);
  assert.equal(parseAmount('12.3'), 1230);
  assert.equal(parseAmount('12'), 1200);
  assert.equal(parseAmount('-0.05'), -5);
  assert.equal(parseAmount(' 7.10 '), 710);
});

test('parseAmount 拒绝多余小数位和非法输入', () => {
  assert.throws(() => parseAmount('1.234'), MoneyError);
  assert.throws(() => parseAmount('abc'), MoneyError);
  assert.throws(() => parseAmount(''), MoneyError);
  assert.throws(() => parseAmount('1,000'), MoneyError);
});

test('parseDecimal 按指定位数放大，返回 BigInt', () => {
  assert.equal(parseDecimal('7.25', 6), 7250000n);
  assert.equal(parseDecimal('0.000001', 6), 1n);
  assert.throws(() => parseDecimal('0.0000001', 6), MoneyError);
});

test('formatCents 输出两位小数', () => {
  assert.equal(formatCents(1234), '12.34');
  assert.equal(formatCents(5), '0.05');
  assert.equal(formatCents(-5), '-0.05');
  assert.equal(formatCents(0), '0.00');
  assert.equal(formatCents(123456789012n), '1234567890.12');
});

test('roundHalfEven 四舍六入五成双', () => {
  assert.equal(roundHalfEven(25, 10), 2);
  assert.equal(roundHalfEven(35, 10), 4);
  assert.equal(roundHalfEven(26, 10), 3);
  assert.equal(roundHalfEven(24, 10), 2);
  assert.equal(roundHalfEven(-25, 10), -2);
  assert.equal(roundHalfEven(-35, 10), -4);
  assert.equal(roundHalfEven(10, 5), 2);
});

test('roundHalfEven 接受 BigInt 且不丢精度', () => {
  assert.equal(roundHalfEven(22500000n, 1000000n), 22);
  assert.equal(roundHalfEven(9007199254740993n * 10n + 5n, 10n), 9007199254740994);
  assert.throws(() => roundHalfEven(1, 0), MoneyError);
});
