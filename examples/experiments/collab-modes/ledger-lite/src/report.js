// 按月、按分类汇总。

import { formatCents } from './money.js';

/**
 * 返回 [{ month, category, totalCents }]，按月份、分类升序。
 * month 选项（YYYY-MM）只保留该月。
 */
export function monthlyReport(transactions, { month } = {}) {
  const totals = new Map();
  for (const tx of transactions) {
    const txMonth = tx.date.slice(0, 7);
    if (month && txMonth !== month) continue;
    const key = `${txMonth}\t${tx.category}`;
    totals.set(key, (totals.get(key) ?? 0) + tx.amount);
  }
  return [...totals.entries()]
    .map(([key, totalCents]) => {
      const [rowMonth, category] = key.split('\t');
      return { month: rowMonth, category, totalCents };
    })
    .sort((a, b) => compare(a.month, b.month) || compare(a.category, b.category));
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 渲染成制表符分隔的文本；合计行等于各行之和。 */
export function renderReport(rows) {
  if (rows.length === 0) return '没有记录\n';
  const lines = ['月份\t分类\t金额'];
  let sum = 0;
  for (const row of rows) {
    lines.push(`${row.month}\t${row.category}\t${formatCents(row.totalCents)}`);
    sum += row.totalCents;
  }
  lines.push(`合计\t\t${formatCents(sum)}`);
  return `${lines.join('\n')}\n`;
}
