/**
 * 停机原因的翻译表必须覆盖内核里的每一种 WaitReason。
 *
 * ## 为什么值得单开一条
 *
 * 2026-09-16 加了 `runaway_suspected`：内核加了、调度器用了、正式页的
 * narrate.js 补了，**内置观测面 src/api/web.ts 那份漏了**。漏掉的后果不是报错、
 * 不是崩溃，是界面上原样印出一个英文机器名——看起来像一个"状态"，没人会当 bug 报。
 * 当时是协调者在交卷的未决风险里点出来的，不是测试抓到的。
 *
 * 这一类缺陷的共同形状是：**枚举在一处扩张，翻译表在另外几处**。靠人记得去改，
 * 就一定会漏；而漏了之后没有任何声音。所以判据不能是"我检查过了"，得是
 * 「枚举里的每一个值，在每一张表里都查得到」——新增一种没补表，这里立刻红，
 * 并且错误信息直接说出漏了哪个键、该去改哪个文件。
 *
 * 表是用正则从源码里抠出来的，不是 import 进来的：narrate.js 是浏览器原生
 * ES 模块，而 web.ts 那份藏在一个 HTML 字符串常量里，两者都没法直接取值。
 * 抠不到就让测试红 —— 抠不到本身就说明表被改成了另一个形状，该有人来看一眼。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 内核里那份权威清单。从类型定义抠，避免在测试里再抄一遍。 */
function kernelWaitReasons(): string[] {
  const src = readFileSync(resolve('src/kernel/payloads.ts'), 'utf8');
  const block = /export type WaitReason =([\s\S]*?);/.exec(src);
  assert.ok(block, '在 payloads.ts 里找不到 WaitReason 的类型定义');
  const found = [...block[1].matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(found.length >= 8, `只抠出 ${found.length} 个 WaitReason，形状变了`);
  return found;
}

/** 从一个文件里抠出 `WAIT_REASON = { ... }` 的键。 */
function tableKeys(file: string): string[] {
  const src = readFileSync(resolve(file), 'utf8');
  const block = /WAIT_REASON = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, `在 ${file} 里找不到 WAIT_REASON 这张表`);
  return [...block[1].matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1]);
}

describe('停机原因：翻译表不许漏', () => {
  const reasons = kernelWaitReasons();

  for (const file of ['src/web/narrate.js', 'src/api/web.ts']) {
    test(`${file} 覆盖内核里的每一种`, () => {
      const keys = new Set(tableKeys(file));
      const missing = reasons.filter((r) => !keys.has(r));
      assert.deepEqual(
        missing,
        [],
        `${file} 漏了这些停机原因：${missing.join('、')}。` +
          '漏掉不会报错，只会在界面上原样印出英文机器名——去那张 WAIT_REASON 表里补上中文。',
      );
    });
  }

  test('反过来也不许有多余的键 —— 那是内核删过而表没跟', () => {
    const known = new Set(reasons);
    // escalated 不是 WaitReason，是观测面自己用的一个显示态，单独放行。
    const allowExtra = new Set(['escalated']);
    for (const file of ['src/web/narrate.js', 'src/api/web.ts']) {
      const stale = tableKeys(file).filter((k) => !known.has(k) && !allowExtra.has(k));
      assert.deepEqual(stale, [], `${file} 里这些键内核已经没有了：${stale.join('、')}`);
    }
  });
});
