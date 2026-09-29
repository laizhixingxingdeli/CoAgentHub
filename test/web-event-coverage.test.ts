/**
 * 活动事件种类覆盖门禁。
 *
 * 翻译表漏一条，界面上就是一行机器名，不报错、不崩、没人当 bug 报。
 * 所以 kind 必须从真实写入点抠出来，而不是在测试里手抄一份全名单——
 * 手抄的那份会和源码一起漏。
 *
 * 抠不到、解不出常量、解不出三元表达式：测试红。静默略过等于把门禁拆了。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { isRuntimeCommand, narrateEvent } from '../src/web/narrate.js';

const ROOT = process.cwd();

/** 工单点名的写入入口：平台 #event + 几处直接 ActivityLog.append。 */
const ACTIVITY_ENTRIES: ReadonlyArray<{ file: string; how: '#event' | 'append' }> = [
  { file: 'src/application/platform.ts', how: '#event' },
  { file: 'src/application/query-promotion.ts', how: 'append' },
  { file: 'src/application/reconcile.ts', how: 'append' },
  { file: 'src/application/decision-shadow-runner.ts', how: 'append' },
  { file: 'src/application/post-execution-shadow.ts', how: 'append' },
];

/**
 * 其它 .append 不是活动事件：实时输出。记在这里，以免扫到时被当成漏网写入。
 * platform.ts 的 #activity.append 是 #event 的落盘实现，kind 是参数，不在这儿解。
 */
const RECORDED_NON_ACTIVITY: ReadonlyArray<{ file: string; why: string }> = [
  { file: 'src/application/live.ts', why: 'LiveOutput 实时输出（note/text），不是 ActivityLog' },
  { file: 'src/application/pg-store.ts', why: 'LiveOutput.finish 补裁剪 note' },
  { file: 'src/application/orchestrator.ts', why: '#live.append 实时输出' },
  { file: 'src/application/platform.ts', why: '#activity.append 是 #event 写入器本身' },
];

const CONTRACT_KINDS = [
  'orchestration.round.started',
  'memory.applied',
  'delivery.created',
  'final_review.integration_anchor',
  'final_review.integration_verified',
  'final_review.merge_applied',
  'work_item.redispatched',
] as const;

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkTs(p));
    else if (ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function collectConstStrings(src: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*(['"])([^'"]+)\2/g;
  for (const m of src.matchAll(re)) map.set(m[1], m[3]);
  return map;
}

function extractBalanced(src: string, openIndex: number): string {
  if (src[openIndex] !== '(') {
    throw new Error(`expected '(' at ${openIndex}`);
  }
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIndex; i < src.length; i += 1) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openIndex + 1, i);
    }
  }
  throw new Error('unbalanced paren');
}

function splitTopLevel(inside: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let inStr: string | null = null;
  for (let i = 0; i < inside.length; i += 1) {
    const c = inside[i];
    if (inStr) {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') depth -= 1;
    else if (c === sep && depth === 0) {
      parts.push(inside.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inside.slice(start));
  return parts.map((s) => s.trim()).filter(Boolean);
}

function resolveKindExpr(
  expr: string,
  consts: Map<string, string>,
  imported: Map<string, string>,
): { kinds: string[] } | { unresolved: string } {
  const trimmed = expr.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim();
  const lit = /^(['"])([a-z][a-z0-9_.]*)\1$/.exec(trimmed);
  if (lit) return { kinds: [lit[2]] };

  if (trimmed.includes('?') && trimmed.includes(':')) {
    const lits = [...trimmed.matchAll(/(['"])([a-z][a-z0-9_.]*)\1/g)].map((m) => m[2]);
    if (lits.length >= 2) return { kinds: [...new Set(lits)] };
  }

  if (/^[A-Z][A-Z0-9_]*$/.test(trimmed)) {
    const v = consts.get(trimmed) ?? imported.get(trimmed);
    if (v) return { kinds: [v] };
    return { unresolved: trimmed };
  }

  // 写入器参数：`kind` 标识符。调用方解过了。
  if (trimmed === 'kind') return { unresolved: 'kind-parameter' };

  return { unresolved: trimmed };
}

function importedConstBindings(file: string, src: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /import\s+\{([^}]+)\}\s+from\s+['"](\.[^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    const names = m[1]
      .split(',')
      .map((p) => p.trim().split(/\s+as\s+/).pop()?.trim())
      .filter((n): n is string => Boolean(n) && /^[A-Z][A-Z0-9_]*$/.test(n));
    if (names.length === 0) continue;
    const spec = m[2];
    const target = spec.endsWith('.ts') || spec.endsWith('.js')
      ? join(file, '..', spec)
      : join(file, '..', `${spec}.ts`);
    let other: string;
    try {
      other = readFileSync(target, 'utf8');
    } catch {
      continue;
    }
    const consts = collectConstStrings(other);
    for (const name of names) {
      const v = consts.get(name);
      if (v) map.set(name, v);
    }
  }
  return map;
}

type Extracted = {
  file: string;
  kinds: string[];
  unresolved: string[];
  callCount: number;
};

function extractKindsFromEventCalls(file: string, src: string): Extracted {
  const consts = collectConstStrings(src);
  const imported = importedConstBindings(file, src);
  const kinds: string[] = [];
  const unresolved: string[] = [];
  let callCount = 0;
  const needle = 'this.#event(';
  let from = 0;
  while (from < src.length) {
    const at = src.indexOf(needle, from);
    if (at < 0) break;
    callCount += 1;
    const open = at + needle.length - 1;
    const inside = extractBalanced(src, open);
    const args = splitTopLevel(inside, ',');
    if (args.length < 2) {
      unresolved.push(`#event args<2 at ${at}`);
    } else {
      const resolved = resolveKindExpr(args[1], consts, imported);
      if ('kinds' in resolved) kinds.push(...resolved.kinds);
      else unresolved.push(`#event ${resolved.unresolved} at ${at}`);
    }
    from = open + 1;
  }
  return { file, kinds, unresolved, callCount };
}

function extractKindFromObjectLiteral(obj: string): string | null {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = 0; i < obj.length; i += 1) {
    const c = obj[i];
    if (inStr) {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (depth === 1 && obj.startsWith('kind', i) && /\bkind\s*:/.test(obj.slice(i, i + 8))) {
      const colon = obj.indexOf(':', i);
      let end = colon + 1;
      let d = 0;
      let s: string | null = null;
      for (; end < obj.length; end += 1) {
        const ch = obj[end];
        if (s) {
          if (ch === '\\') {
            end += 1;
            continue;
          }
          if (ch === s) s = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          s = ch;
          continue;
        }
        if (ch === '{' || ch === '(' || ch === '[') d += 1;
        else if (ch === '}' || ch === ')' || ch === ']') {
          if (d === 0) break;
          d -= 1;
        } else if ((ch === ',' || ch === '\n') && d === 0) break;
      }
      return obj.slice(colon + 1, end).trim();
    }
  }
  return null;
}

function extractKindsFromAppend(file: string, src: string): Extracted {
  const consts = collectConstStrings(src);
  const imported = importedConstBindings(file, src);
  const kinds: string[] = [];
  const unresolved: string[] = [];
  let callCount = 0;
  const re = /(?:#activity|activity\?|#live|#activity)\.append\s*\(|deps\.activity\.append\s*\(|activity\.append\s*\(/g;
  for (const m of src.matchAll(re)) {
    const matched = m[0];
    if (matched.includes('#live')) continue;
    callCount += 1;
    const open = src.indexOf('(', m.index!);
    const inside = extractBalanced(src, open);
    const objStart = inside.indexOf('{');
    if (objStart < 0) {
      unresolved.push(`append no-object at ${m.index}`);
      continue;
    }
    const expr = extractKindFromObjectLiteral(inside.slice(objStart));
    if (!expr) {
      unresolved.push(`append missing kind at ${m.index}`);
      continue;
    }
    const resolved = resolveKindExpr(expr, consts, imported);
    if ('kinds' in resolved) kinds.push(...resolved.kinds);
    else unresolved.push(`append ${resolved.unresolved} at ${m.index}`);
  }
  return { file, kinds, unresolved, callCount };
}

function rel(p: string): string {
  return relative(ROOT, p).replace(/\\/g, '/');
}

function load(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

describe('活动写入入口：从源码抠 kind，未翻译即红', () => {
  const extracted: Extracted[] = ACTIVITY_ENTRIES.map((entry) => {
    const src = load(entry.file);
    return entry.how === '#event'
      ? extractKindsFromEventCalls(entry.file, src)
      : extractKindsFromAppend(entry.file, src);
  });

  test('记录检查过的入口，每个入口都真正扫到了写入', () => {
    const report = ACTIVITY_ENTRIES.map((e, i) => {
      const got = extracted[i];
      return `${e.file} via ${e.how}: ${got.callCount} 次, kinds=${[...new Set(got.kinds)].sort().join(',')}`;
    }).join('\n');
    assert.ok(extracted.every((e) => e.callCount > 0), `有入口一次都没扫到：\n${report}`);
    assert.ok(extracted.some((e) => e.file.includes('platform.ts') && e.callCount >= 20), report);
    // 把入口写进断言信息：失败时能看见扫了谁。
    assert.match(report, /platform\.ts via #event/);
    assert.match(report, /query-promotion\.ts via append/);
    assert.match(report, /reconcile\.ts via append/);
    assert.match(report, /decision-shadow-runner\.ts via append/);
    assert.match(report, /post-execution-shadow\.ts via append/);
  });

  test('未能解析的常量/动态表达式不得静默略过', () => {
    const bad = extracted.flatMap((e) => e.unresolved.map((u) => `${e.file}: ${u}`));
    assert.deepEqual(bad, [], `解不出这些 kind 表达式（补解析器，不要略过）：\n${bad.join('\n')}`);
  });

  test('契约点名的七种 kind 都从源码写入点抠到了', () => {
    const all = new Set(extracted.flatMap((e) => e.kinds));
    const missing = CONTRACT_KINDS.filter((k) => !all.has(k));
    assert.deepEqual(missing, [], `源码写入点没有这些契约 kind：${missing.join('、')}`);
  });

  test('其它 src 写入点必须被记录，不能当没看见', () => {
    const known = new Set([
      ...ACTIVITY_ENTRIES.map((e) => e.file),
      ...RECORDED_NON_ACTIVITY.map((e) => e.file),
    ]);
    const surprises: string[] = [];
    for (const abs of walkTs(join(ROOT, 'src'))) {
      const file = rel(abs);
      const src = readFileSync(abs, 'utf8');
      const hasEvent = src.includes('this.#event(');
      const hasAppend =
        /(?:#activity|activity\?|deps\.activity)\.append\s*\(|\bactivity\.append\s*\(/.test(src);
      if (!hasEvent && !hasAppend) continue;
      if (known.has(file)) continue;
      surprises.push(file);
    }
    assert.deepEqual(
      surprises,
      [],
      `发现未记录的活动写入点：${surprises.join('、')}。加进 ACTIVITY_ENTRIES 或 RECORDED_NON_ACTIVITY，不要略过。`,
    );
  });

  test('每种非命令 kind 调 narrateEvent 不得 untranslated', () => {
    const kinds = [...new Set(extracted.flatMap((e) => e.kinds))].sort();
    const command = kinds.filter((k) => isRuntimeCommand(k));
    const others = kinds.filter((k) => !isRuntimeCommand(k));
    assert.ok(command.length >= 2, `命令族至少该扫到 started / tracking：${command.join(',')}`);
    const missing: string[] = [];
    for (const kind of others) {
      const out = narrateEvent({ kind, data: {} });
      if (out.untranslated) missing.push(kind);
    }
    assert.deepEqual(
      missing,
      [],
      `这些源码写入的 kind 还没翻译（去 narrate.js EVENT_TABLE 补）：${missing.join('、')}`,
    );
  });

  test('未知种类仍如实标明未翻译，不得吞掉兜底', () => {
    const out = narrateEvent({ kind: 'definitely.not.a.platform.event', data: {} });
    assert.equal(out.untranslated, true);
    assert.ok(out.detail.includes('definitely.not.a.platform.event'), out.detail);
    assert.ok(`${out.badge}${out.action}${out.detail}`.includes('未翻译'));
  });
});
