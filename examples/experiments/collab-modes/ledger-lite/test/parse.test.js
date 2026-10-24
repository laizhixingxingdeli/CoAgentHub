import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImportError, isValidDate, parseCsv, splitCsvLine } from '../src/parse.js';

// 只核对原有的四个字段，给以后新增字段留余地。
const pick = (rows) => rows.map(({ date, amount, category, note }) => ({ date, amount, category, note }));

test('解析基本 CSV', () => {
  const rows = parseCsv('date,amount,category,note\n2026-01-03,12.50,餐饮,午饭\n2026-01-04,3,交通,地铁\n');
  assert.deepEqual(pick(rows), [
    { date: '2026-01-03', amount: 1250, category: '餐饮', note: '午饭' },
    { date: '2026-01-04', amount: 300, category: '交通', note: '地铁' },
  ]);
});

test('表头大小写不敏感、列顺序任意、多余列忽略、跳过空行', () => {
  const rows = parseCsv('Note,Category,Amount,Date,Extra\r\n早饭,餐饮,8,2026-02-01,x\r\n\r\n');
  assert.deepEqual(pick(rows), [{ date: '2026-02-01', amount: 800, category: '餐饮', note: '早饭' }]);
});

test('支持引号字段', () => {
  assert.deepEqual(splitCsvLine('a,"b,c","d ""e"""'), ['a', 'b,c', 'd "e"']);
  const rows = parseCsv('date,amount,category,note\n2026-01-03,1,其他,"带,逗号"\n');
  assert.equal(rows[0].note, '带,逗号');
});

test('缺少必需列时报第 1 行', () => {
  assert.throws(() => parseCsv('date,amount,note\n'), { name: 'Error', message: '第 1 行：缺少列 category' });
});

test('错误带实际行号', () => {
  const csv = 'date,amount,category,note\n2026-01-03,1,餐饮,\n2026-13-01,1,餐饮,\n';
  assert.throws(() => parseCsv(csv), (error) => error instanceof ImportError && error.message === '第 3 行：日期不合法：2026-13-01');
  assert.throws(() => parseCsv('date,amount,category,note\n2026-01-03,1.234,餐饮,\n'), /第 2 行：小数位超过 2 位/);
  assert.throws(() => parseCsv('date,amount,category,note\n2026-01-03,1,,\n'), /第 2 行：分类不能为空/);
  assert.throws(() => parseCsv('date,amount,category,note\n2026-01-03,1,餐饮\n'), /第 2 行：应有 4 列，实际 3 列/);
});

test('isValidDate 检查真实日期', () => {
  assert.equal(isValidDate('2024-02-29'), true);
  assert.equal(isValidDate('2026-02-29'), false);
  assert.equal(isValidDate('2026-1-01'), false);
});
