import assert from 'node:assert/strict';
import { test } from 'node:test';
import { monthlyReport, renderReport } from '../src/report.js';

const transactions = [
  { date: '2026-01-03', amount: 1250, category: '餐饮', note: '午饭' },
  { date: '2026-01-04', amount: 300, category: '交通', note: '地铁' },
  { date: '2026-01-20', amount: 4555, category: '餐饮', note: '聚餐' },
  { date: '2026-02-01', amount: 800, category: '餐饮', note: '早饭' },
  { date: '2026-02-02', amount: -1000, category: '收入', note: '退款' },
];

test('按月按分类汇总并排序', () => {
  assert.deepEqual(monthlyReport(transactions), [
    { month: '2026-01', category: '交通', totalCents: 300 },
    { month: '2026-01', category: '餐饮', totalCents: 5805 },
    { month: '2026-02', category: '收入', totalCents: -1000 },
    { month: '2026-02', category: '餐饮', totalCents: 800 },
  ]);
});

test('month 选项只保留该月', () => {
  assert.deepEqual(monthlyReport(transactions, { month: '2026-02' }).map((r) => r.category), ['收入', '餐饮']);
});

test('报表文本快照（单一币种输出必须保持不变）', () => {
  assert.equal(
    renderReport(monthlyReport(transactions)),
    '月份\t分类\t金额\n' +
      '2026-01\t交通\t3.00\n' +
      '2026-01\t餐饮\t58.05\n' +
      '2026-02\t收入\t-10.00\n' +
      '2026-02\t餐饮\t8.00\n' +
      '合计\t\t59.05\n',
  );
});

test('没有记录时的输出', () => {
  assert.equal(renderReport([]), '没有记录\n');
});
