// CSV 导入。表头按列名识别（大小写不敏感），多出来的列忽略。

import { MoneyError, parseAmount } from './money.js';

export class ImportError extends Error {}

export const REQUIRED_COLUMNS = ['date', 'amount', 'category', 'note'];

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(text) {
  const match = DATE.exec(text);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 拆一行 CSV：支持双引号包裹和 "" 转义，不支持跨行字段。 */
export function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (quoted) throw new ImportError('引号没有闭合');
  cells.push(current);
  return cells;
}

function fail(lineNo, reason) {
  throw new ImportError(`第 ${lineNo} 行：${reason}`);
}

/** 解析整份 CSV，返回交易数组；任何一行出错都整体失败。 */
export function parseCsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  let header;
  try {
    header = splitCsvLine(lines[0] ?? '').map((name) => name.trim().toLowerCase());
  } catch (error) {
    if (error instanceof ImportError) fail(1, error.message);
    throw error;
  }
  for (const name of REQUIRED_COLUMNS) {
    if (!header.includes(name)) fail(1, `缺少列 ${name}`);
  }
  const column = Object.fromEntries(header.map((name, index) => [name, index]));

  const transactions = [];
  for (let i = 1; i < lines.length; i++) {
    const lineNo = i + 1;
    if (lines[i].trim() === '') continue;
    let cells;
    try {
      cells = splitCsvLine(lines[i]);
    } catch (error) {
      if (error instanceof ImportError) fail(lineNo, error.message);
      throw error;
    }
    if (cells.length !== header.length) fail(lineNo, `应有 ${header.length} 列，实际 ${cells.length} 列`);

    const date = cells[column.date].trim();
    if (!isValidDate(date)) fail(lineNo, `日期不合法：${date}`);

    let amount;
    try {
      amount = parseAmount(cells[column.amount]);
    } catch (error) {
      if (error instanceof MoneyError) fail(lineNo, error.message);
      throw error;
    }

    const category = cells[column.category].trim();
    if (!category) fail(lineNo, '分类不能为空');

    transactions.push({ date, amount, category, note: cells[column.note].trim() });
  }
  return transactions;
}
