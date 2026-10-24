import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { run, workdir, writeFile } from './helpers.js';

const CSV = 'date,amount,category,note\n2026-01-03,12.50,餐饮,午饭\n2026-01-04,3,交通,地铁\n';

test('import 后 report', () => {
  const dir = workdir();
  writeFile(dir, 'a.csv', CSV);
  assert.deepEqual(run(dir, 'import', 'a.csv'), { code: 0, stdout: '导入 2 笔，跳过重复 0 笔\n', stderr: '' });
  assert.deepEqual(run(dir, 'report'), {
    code: 0,
    stdout: '月份\t分类\t金额\n2026-01\t交通\t3.00\n2026-01\t餐饮\t12.50\n合计\t\t15.50\n',
    stderr: '',
  });
});

test('重复导入同一文件不重复记账', () => {
  const dir = workdir();
  writeFile(dir, 'a.csv', CSV);
  run(dir, 'import', 'a.csv');
  assert.equal(run(dir, 'import', 'a.csv').stdout, '导入 0 笔，跳过重复 2 笔\n');
  assert.equal(JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')).transactions.length, 2);
});

test('导入出错时整份不入账，退出码 1', () => {
  const dir = workdir();
  writeFile(dir, 'bad.csv', `${CSV}2026-01-05,abc,餐饮,\n`);
  const result = run(dir, 'import', 'bad.csv');
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '错误：第 4 行：不是合法的数字：abc\n');
  assert.equal(run(dir, 'report').stdout, '没有记录\n');
});

test('report --month 与用法错误', () => {
  const dir = workdir();
  writeFile(dir, 'a.csv', CSV);
  run(dir, 'import', 'a.csv');
  assert.equal(run(dir, 'report', '--month', '2026-02').stdout, '没有记录\n');
  assert.equal(run(dir, 'nope').code, 2);
  assert.equal(run(dir, 'report', '--month').code, 2);
});
