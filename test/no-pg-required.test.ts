/**
 * 没装 pg 时，文件版加载路径必须仍然能加载。
 *
 * 顶层静态引入 pg 会连坐到 src/main.ts：任何经它进来的文件版装配
 * 在模块解析阶段就失败，「没装 Postgres 也能跑」只剩一句口号。这条在子进程里
 * 注册一个把 `pg` 解析成 ERR_MODULE_NOT_FOUND 的钩子，证明 src/main.ts 与
 * src/application/pg-store.ts 在没有 pg 的机器上都能加载（只有真正 open 一个
 * PG store 时才要求驱动存在）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('没装 pg：src/main.ts 与 src/application/pg-store.ts 仍可加载', () => {
  // 临时目录走 os.tmpdir()：Windows 上 bash 的 /tmp 与 node 的 /tmp 不是同一个地方。
  const dir = mkdtempSync(join(tmpdir(), 'coagent-no-pg-'));
  try {
    const hookPath = join(dir, 'pg-unavailable-hook.mjs');
    writeFileSync(
      hookPath,
      `export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'pg' || specifier.startsWith('pg/')) {
    const error = new Error("Cannot find package 'pg'");
    error.code = 'ERR_MODULE_NOT_FOUND';
    throw error;
  }
  return nextResolve(specifier, context);
}
`,
    );

    const registerPath = join(dir, 'register-pg-unavailable.mjs');
    writeFileSync(
      registerPath,
      `import { register } from 'node:module';
register(${JSON.stringify(pathToFileURL(hookPath).href)}, import.meta.url);
`,
    );

    const mainUrl = pathToFileURL(fileURLToPath(new URL('../src/main.ts', import.meta.url))).href;
    const storeUrl = pathToFileURL(
      fileURLToPath(new URL('../src/application/pg-store.ts', import.meta.url)),
    ).href;
    const childPath = join(dir, 'load-file-version.mjs');
    writeFileSync(
      childPath,
      `await import(${JSON.stringify(mainUrl)});
await import(${JSON.stringify(storeUrl)});
`,
    );

    // --import 收 file:// URL：Windows 上裸盘符路径会被当成 protocol 'c:'。
    const result = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(registerPath).href, childPath],
      { encoding: 'utf8' },
    );
    assert.equal(
      result.status,
      0,
      `没装 pg 时加载失败：退出码 ${result.status}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
