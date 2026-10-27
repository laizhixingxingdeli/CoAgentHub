#!/usr/bin/env node
// l3-mcp-server 的零依赖验收脚本：先 tsc 构建，再跑它的全量 vitest。
//
// 用法：
//   node scripts/l3-mcp-check.mjs                 // 构建 + 全量测试
//   node scripts/l3-mcp-check.mjs src/x.spec.ts   // 构建 + 定向测试（参数原样追加给 vitest）
// 任一步非零即以该退出码退出，可直接当验证命令用。
//
// 为什么从 process.cwd() 解析、而不是写主检出的绝对路径：
// Mission 往往在有 node_modules 的检出里被启动，却在自己的 worktree 里执行验证——
// 那个 worktree 通常没有 node_modules。若把验证命令写成主检出下的绝对路径，
// 执行者只能 cd 到主检出去跑，于是文件改动落到主检出而不是 Mission worktree
// （2026-10-27 W-940 真实发生过）。从 cwd 起用 Node 模块解析向上找到 typescript
// 与 vitest，命令本身就不必包含任何绝对路径，也就没有 cd 出去的理由。
//
// 为什么先解析 vitest 的 package.json 再拼入口：
// vitest 的 exports 映射没有暴露它的 CLI 入口文件，直接解析那个子路径会抛
// ERR_PACKAGE_PATH_NOT_EXPORTED。改从 package.json 的 bin.vitest 推出入口，
// 包换版本时入口文件名变了也不会失效。

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// 以 cwd 为起点：解析方向和「人在哪个目录敲命令」一致。
const require = createRequire(join(process.cwd(), 'package.json'));

const tsc = require.resolve('typescript/bin/tsc');

const vitestPkgPath = require.resolve('vitest/package.json');
const vitestPkg = JSON.parse(readFileSync(vitestPkgPath, 'utf8'));
const vitestBin = vitestPkg.bin?.vitest ?? vitestPkg.bin;
if (typeof vitestBin !== 'string') {
  process.stderr.write('l3-mcp-check: vitest/package.json 里没有 bin.vitest，无法定位 vitest 入口\n');
  process.exit(1);
}
const vitestEntry = join(dirname(vitestPkgPath), vitestBin);

/**
 * 用当前 node 跑一个子进程并继承 stdio。
 * spawnSync 在 spawn 失败时 status 为 null 而 error 有值，只看 status 会把
 * 「没跑起来」当成成功，所以两者都要判。
 */
function run(argv) {
  const result = spawnSync(process.execPath, argv, { stdio: 'inherit' });
  if (result.error || result.status === null) {
    process.stderr.write(`l3-mcp-check: 无法执行 ${argv[0]}: ${result.error?.message ?? '未知原因'}\n`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status);
}

run([tsc, '-p', 'l3-mcp-server/tsconfig.json']);
// 脚本收到的参数原样交给 vitest，用于定向（例如某个 spec 路径）。
run([vitestEntry, 'run', '--root', 'l3-mcp-server', ...process.argv.slice(2)]);
