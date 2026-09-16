/**
 * 整个 src/ 都要守的约束（不只是 kernel）。
 *
 * 由来：Node 24 类型剥离不支持构造参数属性和 enum。kernel 的守卫测试只扫
 * `src/kernel/`，所以第一次往 `src/application/` 写这种写法时，守卫是绿的、
 * 运行时才炸。约束适用于整棵树，守卫就该覆盖整棵树。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

function allSources(dir: string = srcDir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...allSources(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function sources(): { path: string; source: string }[] {
  return allSources().map((path) => ({
    path: path.slice(srcDir.length).replaceAll('\\', '/'),
    source: readFileSync(path, 'utf8'),
  }));
}

describe('src/ 全树符合 Node 原生类型剥离的限制', () => {
  test('目录非空', () => {
    assert.ok(sources().length > 0);
  });

  test('不使用构造参数属性', () => {
    // `constructor(private readonly x: T)` 在 strip-only 模式下直接抛
    // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
    for (const { path, source } of sources()) {
      assert.doesNotMatch(
        source,
        /constructor\s*\([^)]*\b(private|public|protected|readonly)\s+\w/s,
        `${path}: 构造参数属性不被支持，改成显式字段赋值`,
      );
    }
  });

  test('不使用 enum', () => {
    for (const { path, source } of sources()) {
      assert.doesNotMatch(source, /^\s*(export\s+)?(const\s+)?enum\s+/m, `${path}: 不要用 enum`);
    }
  });

  test('相对 import 一律带 .ts 后缀', () => {
    for (const { path, source } of sources()) {
      const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);
      for (const specifier of specifiers) {
        if (!specifier.startsWith('.')) continue;
        assert.ok(
          specifier.endsWith('.ts'),
          `${path}: 相对 import "${specifier}" 必须带 .ts 后缀`,
        );
      }
    }
  });

  test('第三方依赖只许出现在存储适配器里', () => {
    // 原先这条是「零依赖」。接 Postgres 之后它必须换个判据，但**不能直接删**——
    // 真正要守住的从来不是依赖数为零，是这两条：
    //   1. 没装 Postgres 也能跑完整平台和全部测试（文件版仍然在）；
    //   2. 用例层与领域层不认识任何具体存储。
    // 所以 pg 只许从存储适配器进来。它一旦漏进 platform.ts 或 orchestrator.ts，
    // 上面两条就同时没了，而那种泄漏是悄无声息的。
    const ALLOWED: Record<string, readonly string[]> = {
      'application/pg-store.ts': ['pg'],
    };
    for (const { path, source } of sources()) {
      const allowed = ALLOWED[path.replaceAll('\\', '/')] ?? [];
      const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);
      for (const specifier of specifiers) {
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
        if (allowed.includes(specifier)) continue;
        assert.fail(
          `${path}: 出现第三方依赖 "${specifier}"。` +
            '只有存储适配器可以依赖驱动，其余部分不认识具体存储。',
        );
      }
    }
  });
});
