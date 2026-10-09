/**
 * 直接入口判断的唯一实现。
 *
 * 为什么不能只用 resolve(argv1) 比 URL：Node 给主模块 URL 用的是 JS 版
 * realpath（会展开符号链接 / 联接祖先），而 argv[1] 是启动时写的字面路径。
 * 仓库或 node_modules 在符号链接 / 联接点下面时两者不一致，直接 `node src/main.ts`
 * 会静默不启动。这里先把 argv1 规范到 realpath，再和 selfUrl 比。
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isDirectEntry(argv1: string | undefined, selfUrl: string): boolean {
  if (typeof argv1 !== 'string' || argv1.length === 0) return false;
  try {
    const lexical = resolve(argv1);
    // 必须用 JS 版 realpathSync：它不展开 8.3 短名，与 Node 加载器给主模块
    // URL 的算法一致。换成 .native 反而会对不上。
    // 解析失败（路径不存在等）退回 resolve 结果，保持不加别名时的原有行为。
    let canonical = lexical;
    try {
      canonical = realpathSync(lexical);
    } catch {
      canonical = lexical;
    }
    const invoked = pathToFileURL(canonical).href;
    if (invoked === selfUrl) return true;
    // Windows 上同一路径可能只差盘符大小写；当成同一入口，否则直接 node 不启动。
    return process.platform === 'win32' && invoked.toLowerCase() === selfUrl.toLowerCase();
  } catch {
    return false;
  }
}
