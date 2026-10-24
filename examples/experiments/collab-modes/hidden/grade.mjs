#!/usr/bin/env node
// 判分：把被测仓库复制到临时目录，放入隐藏测试后运行，不动原检出。
// 用法：node grade.mjs <被测检出目录>（通常是合入后的 <练习仓库>-integration）

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
if (!target) {
  console.error('用法：node grade.mjs <被测检出目录>');
  process.exit(2);
}
const source = resolve(target);
const work = mkdtempSync(join(tmpdir(), 'ledger-grade-'));
cpSync(source, work, {
  recursive: true,
  filter: (path) => !['.git', '.coagent-worktrees', 'node_modules', 'ledger.json'].includes(basename(path)),
});
cpSync(join(dirname(fileURLToPath(import.meta.url)), 'acceptance.hidden.mjs'), join(work, 'test', 'zz-hidden.test.js'));

function tap(args) {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...args], { cwd: work, encoding: 'utf8' });
  const lines = (result.stdout ?? '').split(/\r?\n/);
  const count = (name) => Number(lines.find((l) => l.startsWith(`# ${name} `))?.split(' ')[2] ?? NaN);
  const failed = lines.filter((l) => /^not ok \d+ - /.test(l)).map((l) => l.replace(/^not ok \d+ - /, ''));
  return { pass: count('pass'), fail: count('fail'), failed };
}

const hidden = tap(['test/zz-hidden.test.js']);
rmSync(join(work, 'test', 'zz-hidden.test.js'));
const own = tap([]);
rmSync(work, { recursive: true, force: true });

console.log(`被测目录：${source}`);
console.log(`仓库自带 + agent 新增测试：通过 ${own.pass}，失败 ${own.fail}`);
for (const name of own.failed) console.log(`  ✗ ${name}`);
console.log(`隐藏验收测试：${hidden.pass} / ${hidden.pass + hidden.fail}`);
for (const name of hidden.failed) console.log(`  ✗ ${name}`);
