#!/usr/bin/env node
// 为一次实验运行准备一份干净的练习仓库：复制 ledger-lite、git 初始化、建集成分支 worktree。
// 用法：node prepare.mjs <目标目录>
// 结果：<目标目录>（main 分支，你不要在里面开发）和 <目标目录>-integration（coagent/integration，--cwd 指向它）。

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
if (!target) {
  console.error('用法：node prepare.mjs <目标目录>');
  process.exit(2);
}
const dest = resolve(target);
const integration = join(dirname(dest), `${basename(dest)}-integration`);
for (const path of [dest, integration]) {
  if (existsSync(path)) {
    console.error(`已存在，换一个目录或先删掉：${path}`);
    process.exit(1);
  }
}

const source = join(dirname(fileURLToPath(import.meta.url)), 'ledger-lite');
cpSync(source, dest, { recursive: true });

const git = (...args) => execFileSync('git', args, { cwd: dest, stdio: 'inherit' });
git('init', '-b', 'main');
git('add', '-A');
git('-c', 'user.name=collab-experiment', '-c', 'user.email=collab-experiment@localhost', 'commit', '-m', 'ledger-lite 实验基线');
git('worktree', 'add', integration, '-b', 'coagent/integration');

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dest, encoding: 'utf8' }).trim();
console.log(`\n基线提交：${head}`);
console.log(`练习仓库：${dest}`);
console.log(`集成 worktree（Mission 的 --cwd）：${integration}`);
