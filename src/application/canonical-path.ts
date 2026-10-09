import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * 把一个路径折成「与 git 打印的路径同一口径」的规范形式。
 *
 * 为什么不直接用 realpath 了事：git 只对**存在**的路径做符号链接解析，缺失的
 * 路径它原样打印。别名目录下的 worktree 恰恰是这种情况——`#rootFor` 指到
 * 一个符号链接 / 联接点，而调用方拿到的 entry.path 已经展开过。两边口径不一
 * 致，`isDirectChild` 就会把真实的子 worktree 判成根外条目，于是该收敛的
 * 收敛不掉。
 *
 * 逐段向上找最近存在的祖先，把已存在部分 realpath、缺失部分原样接回去：
 * 不这么做就只能对整条路径 realpath，缺失路径直接抛异常，等于没处理。
 *
 * 任何异常都退回 resolve(path) 而不是往外抛：这里只做路径归一，判不了就
 * 退回调用方原本就会得到的值，让上层继续按老逻辑走，不要让一次 realpath
 * 失败把整轮 reconcile 打断。
 */
export async function canonicalPath(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return await realpath(resolved);
  } catch {
    try {
      if (dirname(resolved) === resolved) return resolved;
      return join(await canonicalPath(dirname(resolved)), basename(resolved));
    } catch {
      return resolved;
    }
  }
}
