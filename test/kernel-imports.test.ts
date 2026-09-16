import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as indexExports from '../src/kernel/index.ts';
import {
  IllegalTransitionError,
  InvariantViolationError,
  KernelError,
} from '../src/kernel/index.ts';

const kernelDir = fileURLToPath(new URL('../src/kernel/', import.meta.url));

function kernelFiles(): string[] {
  return readdirSync(kernelDir)
    .filter((name) => name.endsWith('.ts'))
    .sort();
}

/** 收集一个源文件里所有 import/export 说明符（含 `import type` / 裸 `import 'x'`）。 */
function specifiersOf(source: string): string[] {
  const found: string[] = [];
  const fromRe = /\b(?:import|export)\b[^;\n]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const bareRe = /\bimport\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(fromRe)) found.push(match[1]);
  for (const match of source.matchAll(bareRe)) found.push(match[1]);
  return found;
}

function sourcesOf(): Array<{ name: string; source: string }> {
  return kernelFiles().map((name) => ({
    name,
    source: readFileSync(`${kernelDir}/${name}`, 'utf8'),
  }));
}

describe('kernel 依赖边界：src/kernel/ 不 import 任何第三方或 node: 模块', () => {
  test('目录非空且含预期的聚合文件', () => {
    const files = kernelFiles();
    assert.ok(files.length > 0, 'src/kernel/ 下应有 .ts 源文件');
    for (const expected of [
      'index.ts',
      'errors.ts',
      'attempt.ts',
      'work-item.ts',
      'mission.ts',
      'project.ts',
    ]) {
      assert.ok(files.includes(expected), `缺少 src/kernel/${expected}`);
    }
  });

  test('每条 import/export 说明符都是相对路径且以 .ts 结尾', () => {
    for (const { name, source } of sourcesOf()) {
      const specifiers = specifiersOf(source);
      // errors.ts / payloads.ts 是叶子模块：零依赖是它们应有的样子，不是漏扫。
      assert.ok(
        specifiers.length > 0 || name === 'errors.ts' || name === 'payloads.ts' || name === 'snapshot.ts',
        `${name}: 没扫到任何 import，若确实无依赖则跳过`,
      );
      for (const specifier of specifiers) {
        assert.ok(
          specifier.startsWith('./') || specifier.startsWith('../'),
          `${name}: 非相对路径 import "${specifier}"`,
        );
        assert.ok(
          specifier.endsWith('.ts'),
          `${name}: import "${specifier}" 必须带 .ts 后缀（Node 类型剥离）`,
        );
        assert.doesNotMatch(specifier, /^node:/, `${name}: 不允许 node: import`);
        assert.ok(
          existsSync(`${kernelDir}/${specifier}`),
          `${name}: "${specifier}" 解析不到 src/kernel/ 内的文件`,
        );
      }
    }
  });

  test('不存在包名式 import（from "xxx" / from \'xxx\' / from "node:..."）', () => {
    const offenders: string[] = [];
    for (const { name, source } of sourcesOf()) {
      const bare = source.match(/\bfrom\s*['"](?:node:[^'"]+|[a-zA-Z@][^'"]*)['"]/g);
      if (bare) offenders.push(...bare.map((hit) => `${name}: ${hit}`));
      const sideEffect = source.match(/\bimport\s+['"](?:node:[^'"]+|[a-zA-Z@][^'"]*)['"]/g);
      if (sideEffect) offenders.push(...sideEffect.map((hit) => `${name}: ${hit}`));
    }
    assert.deepEqual(offenders, []);
  });

  test('index.ts 只从 kernel 内部导出', () => {
    const index = readFileSync(`${kernelDir}/index.ts`, 'utf8');
    const specs = specifiersOf(index);
    assert.ok(specs.length > 0, 'index.ts 应该 re-export kernel 内部模块');
    for (const specifier of specs) {
      assert.ok(specifier.startsWith('./'), `index.ts 不应指向 kernel 之外：${specifier}`);
    }
  });

  test('错误类形成可判别的继承链', () => {
    const illegal = new IllegalTransitionError('WorkItem', 'created', 'accepted');
    assert.ok(illegal instanceof KernelError);
    assert.ok(illegal instanceof Error);
    assert.equal(illegal.name, 'IllegalTransitionError');
    assert.equal(illegal.code, 'ILLEGAL_TRANSITION');
    assert.equal(illegal.entity, 'WorkItem');
    assert.equal(illegal.from, 'created');
    assert.equal(illegal.to, 'accepted');

    const violated = new InvariantViolationError('DUPLICATE_ID', 'dup');
    assert.ok(violated instanceof KernelError);
    assert.equal(violated.name, 'InvariantViolationError');
    assert.equal(violated.code, 'DUPLICATE_ID');

    // 两类错误靠 instanceof + code 区分，不依赖 message 全文。
    assert.ok(!(violated instanceof IllegalTransitionError));
    assert.ok(!(illegal instanceof InvariantViolationError));
  });

  test('index.ts 导出的运行面与工单要求一致', () => {
    for (const name of [
      'Project',
      'Mission',
      'WorkItem',
      'Attempt',
      'KernelError',
      'IllegalTransitionError',
      'InvariantViolationError',
    ]) {
      assert.equal(typeof indexExports[name as keyof typeof indexExports], 'function', `${name} 未导出`);
    }
  });
});

describe('kernel 源码符合 Node 24 类型剥离限制', () => {
  test('不使用 enum', () => {
    for (const { name, source } of sourcesOf()) {
      assert.doesNotMatch(source, /\benum\s+\w+/, `${name}: 禁止 TypeScript enum`);
      assert.doesNotMatch(source, /\bnamespace\s+\w+/, `${name}: 禁止 namespace`);
    }
  });

  test('不使用 constructor parameter properties', () => {
    for (const { name, source } of sourcesOf()) {
      const constructorRe = /constructor\s*\(([^)]*)\)/g;
      for (const match of source.matchAll(constructorRe)) {
        assert.doesNotMatch(
          match[1],
          /\b(public|private|protected|readonly)\b/,
          `${name}: 禁止 constructor parameter properties（参数：${match[1].trim()}）`,
        );
      }
    }
  });

  test('不暴露 status setter', () => {
    for (const { name, source } of sourcesOf()) {
      if (name === 'index.ts' || name === 'errors.ts') continue;
      assert.doesNotMatch(
        source,
        /get status\(\)[\s\S]{0,200}?set status\(/,
        `${name}: status 只能是只读 getter`,
      );
    }
  });

  test('kernel 里没有 runtime 概念泄漏', () => {
    const banned = [
      /\bprovider\b/i,
      /\bmodel\b/i,
      /\bsession\b/i,
      /\bhttp\b/i,
      /\bfetch\(/,
      /\bsql\b/i,
      /\bdatabase\b/i,
    ];
    for (const { name, source } of sourcesOf()) {
      for (const re of banned) {
        assert.doesNotMatch(source, re, `${name}: 出现被禁概念 ${re}`);
      }
    }
  });
});
