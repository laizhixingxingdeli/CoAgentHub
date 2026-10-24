// 隐藏验收测试：只在全部 Mission 结束后由 grade.mjs 复制进被测仓库运行。
// 不要放进练习仓库，也不要给任何一层 agent 看。只通过命令行入口 main(argv, io) 判分，
// 不依赖被测实现的内部函数名或存储位置。

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.js';

function workdir() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-hidden-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ baseCurrency: 'CNY' }));
  return dir;
}

function run(dir, ...argv) {
  let stdout = '';
  let stderr = '';
  const code = main(argv, {
    cwd: dir,
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
  });
  return { code, stdout, stderr };
}

function csv(dir, name, lines) {
  writeFileSync(join(dir, name), `${lines.join('\n')}\n`, 'utf8');
  return name;
}

function ok(result, label) {
  assert.equal(result.code, 0, `${label} 应成功，stderr：${result.stderr}`);
  return result;
}

const HEAD = 'date,amount,category,note,currency';

test('H01 换算后最后一步才舍入（3×0.075 → 0.22）', () => {
  const dir = workdir();
  ok(run(dir, 'rates', 'add', 'USD', '7.5', '2026-01-01'), 'rates add');
  ok(run(dir, 'import', csv(dir, 'a.csv', [HEAD, '2026-01-02,0.01,书,a,USD', '2026-01-03,0.01,书,b,USD', '2026-01-04,0.01,书,c,USD'])), 'import');
  assert.equal(ok(run(dir, 'report'), 'report').stdout, '月份\t分类\t金额\n2026-01\t书\t0.22\n合计\t\t0.22\n');
});

test('H02 银行家舍入：2.5 分 → 2 分，3.5 分 → 4 分；合计为各行之和', () => {
  const dir = workdir();
  ok(run(dir, 'rates', 'add', 'USD', '2.5', '2026-01-01'), 'rates add');
  ok(run(dir, 'rates', 'add', 'EUR', '3.5', '2026-01-01'), 'rates add');
  ok(run(dir, 'import', csv(dir, 'a.csv', [HEAD, '2026-01-02,0.01,甲,,USD', '2026-01-02,0.01,乙,,EUR'])), 'import');
  assert.equal(ok(run(dir, 'report'), 'report').stdout, '月份\t分类\t金额\n2026-01\t乙\t0.04\n2026-01\t甲\t0.02\n合计\t\t0.06\n');
});

test('H03 汇率从生效日起适用，新汇率生效后切换', () => {
  const dir = workdir();
  ok(run(dir, 'rates', 'add', 'USD', '7.2', '2026-01-15'), 'rates add');
  ok(run(dir, 'rates', 'add', 'USD', '7', '2026-01-01'), 'rates add');
  ok(run(dir, 'import', csv(dir, 'a.csv', [HEAD, '2026-01-14,10,前,,USD', '2026-01-15,10,后,,USD', '2026-02-01,1.10,二月,,USD'])), 'import');
  assert.equal(
    ok(run(dir, 'report'), 'report').stdout,
    '月份\t分类\t金额\n2026-01\t前\t70.00\n2026-01\t后\t72.00\n2026-02\t二月\t7.92\n合计\t\t149.92\n',
  );
});

test('H04 交易日早于该币种第一条汇率：报错退出，写明币种与日期，不输出报表', () => {
  const dir = workdir();
  ok(run(dir, 'rates', 'add', 'USD', '7', '2026-01-10'), 'rates add');
  ok(run(dir, 'import', csv(dir, 'a.csv', [HEAD, '2026-01-03,5,早,,USD', '2026-01-12,5,晚,,USD'])), 'import');
  const result = run(dir, 'report');
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /USD/);
  assert.match(result.stderr, /2026-01-03/);
});

test('H05 币种完全没有汇率：报错退出', () => {
  const dir = workdir();
  ok(run(dir, 'import', csv(dir, 'a.csv', [HEAD, '2026-01-03,5,旅行,,EUR', '2026-01-04,5,餐饮,,'])), 'import');
  const result = run(dir, 'report');
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /EUR/);
});

test('H06 --month 范围外的交易缺汇率不影响本月报表', () => {
  const dir = workdir();
  ok(run(dir, 'rates', 'add', 'USD', '7', '2026-02-01'), 'rates add');
  ok(run(dir, 'import', csv(dir, 'a.csv', [HEAD, '2026-01-03,5,一月,,USD', '2026-02-03,1,二月,,USD'])), 'import');
  assert.equal(ok(run(dir, 'report', '--month', '2026-02'), 'report').stdout, '月份\t分类\t金额\n2026-02\t二月\t7.00\n合计\t\t7.00\n');
});

const LEGACY = {
  version: 1,
  transactions: [
    { date: '2026-01-03', amount: 1250, category: '餐饮', note: '午饭' },
    { date: '2026-01-04', amount: 300, category: '交通', note: '地铁' },
    { date: '2026-02-02', amount: -1000, category: '收入', note: '退款' },
  ],
};
const LEGACY_REPORT = '月份\t分类\t金额\n2026-01\t交通\t3.00\n2026-01\t餐饮\t12.50\n2026-02\t收入\t-10.00\n合计\t\t5.50\n';

test('H07 旧版账本（version 1、没有币种）照常读取，继续导入后仍按基准币种计算', () => {
  const dir = workdir();
  writeFileSync(join(dir, 'ledger.json'), JSON.stringify(LEGACY, null, 2));
  assert.equal(ok(run(dir, 'report'), 'report').stdout, LEGACY_REPORT);
  ok(run(dir, 'rates', 'add', 'USD', '7', '2026-01-01'), 'rates add');
  ok(run(dir, 'import', csv(dir, 'a.csv', [HEAD, '2026-01-05,1,交通,打车,USD'])), 'import');
  assert.equal(
    ok(run(dir, 'report', '--month', '2026-01'), 'report').stdout,
    '月份\t分类\t金额\n2026-01\t交通\t10.00\n2026-01\t餐饮\t12.50\n合计\t\t22.50\n',
  );
  const saved = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'));
  assert.ok(Number.isInteger(saved.version) && saved.version >= 2, '改了存储格式应把 version 加 1');
});

test('H08 不带 currency 列的 CSV：导入与报表输出和原来逐字一致', () => {
  const dir = workdir();
  const name = csv(dir, 'a.csv', ['date,amount,category,note', '2026-01-03,12.50,餐饮,午饭', '2026-01-04,3,交通,地铁', '2026-02-02,-10,收入,退款']);
  assert.deepEqual(run(dir, 'import', name), { code: 0, stdout: '导入 3 笔，跳过重复 0 笔\n', stderr: '' });
  assert.deepEqual(run(dir, 'report'), { code: 0, stdout: LEGACY_REPORT, stderr: '' });
  assert.deepEqual(run(dir, 'import', name), { code: 0, stdout: '导入 0 笔，跳过重复 3 笔\n', stderr: '' });
});

test('H09 币种代码大小写不敏感，保存与输出为大写', () => {
  const dir = workdir();
  ok(run(dir, 'rates', 'add', 'usd', '7', '2026-01-01'), 'rates add');
  assert.equal(ok(run(dir, 'rates', 'list'), 'rates list').stdout, 'USD 7 2026-01-01\n');
  ok(run(dir, 'import', csv(dir, 'a.csv', [HEAD, '2026-01-02,2,书,,usd', '2026-01-03,1,书,,Cny'])), 'import');
  assert.equal(ok(run(dir, 'report'), 'report').stdout, '月份\t分类\t金额\n2026-01\t书\t15.00\n合计\t\t15.00\n');
});

test('H10 非法币种代码：报实际行号，整份不入账', () => {
  const dir = workdir();
  const result = run(dir, 'import', csv(dir, 'a.csv', [HEAD, '2026-01-02,1,书,,USD', '2026-01-03,1,书,,US']));
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /第 3 行/);
  assert.equal(ok(run(dir, 'report'), 'report').stdout, '没有记录\n');
});

test('H11 rates list：排序、去尾零、同币种同日期重复添加以后写为准', () => {
  const dir = workdir();
  ok(run(dir, 'rates', 'add', 'USD', '7.20', '2026-02-01'), 'rates add');
  ok(run(dir, 'rates', 'add', 'EUR', '7.900', '2026-01-01'), 'rates add');
  ok(run(dir, 'rates', 'add', 'USD', '7.1', '2026-01-01'), 'rates add');
  ok(run(dir, 'rates', 'add', 'USD', '7.15', '2026-01-01'), 'rates add');
  ok(run(dir, 'rates', 'add', 'JPY', '0.048', '2026-01-01'), 'rates add');
  assert.equal(
    ok(run(dir, 'rates', 'list'), 'rates list').stdout,
    'EUR 7.9 2026-01-01\nJPY 0.048 2026-01-01\nUSD 7.15 2026-01-01\nUSD 7.2 2026-02-01\n',
  );
});

test('H12 非法汇率与缺参数都被拒绝，且不留下任何汇率', () => {
  const dir = workdir();
  assert.equal(ok(run(dir, 'rates', 'list'), 'rates list').stdout, '没有汇率\n');
  for (const args of [
    ['USD', '-1', '2026-01-01'],
    ['USD', 'abc', '2026-01-01'],
    ['USD', '0', '2026-01-01'],
    ['USD', '7.1234567', '2026-01-01'],
    ['USD', '7', '2026-13-01'],
    ['US', '7', '2026-01-01'],
    ['USD', '7'],
  ]) {
    const result = run(dir, 'rates', 'add', ...args);
    assert.notEqual(result.code, 0, `rates add ${args.join(' ')} 应失败`);
  }
  assert.equal(ok(run(dir, 'rates', 'list'), 'rates list').stdout, '没有汇率\n');
});

test('H13 判重把币种算进去：同日同额同分类同备注、币种不同是两笔', () => {
  const dir = workdir();
  ok(run(dir, 'rates', 'add', 'USD', '7', '2026-01-01'), 'rates add');
  const result = ok(run(dir, 'import', csv(dir, 'a.csv', [HEAD, '2026-01-02,1,书,同一本,CNY', '2026-01-02,1,书,同一本,USD'])), 'import');
  assert.equal(result.stdout, '导入 2 笔，跳过重复 0 笔\n');
  assert.equal(ok(run(dir, 'report'), 'report').stdout, '月份\t分类\t金额\n2026-01\t书\t8.00\n合计\t\t8.00\n');
});

test('H14 currency 列留空或写基准币种都不需要汇率', () => {
  const dir = workdir();
  ok(run(dir, 'import', csv(dir, 'a.csv', [HEAD, '2026-01-02,1.5,书,,', '2026-01-03,2,书,,CNY'])), 'import');
  assert.equal(ok(run(dir, 'report'), 'report').stdout, '月份\t分类\t金额\n2026-01\t书\t3.50\n合计\t\t3.50\n');
});
