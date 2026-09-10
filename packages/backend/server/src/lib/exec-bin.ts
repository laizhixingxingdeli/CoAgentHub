/**
 * bin 可执行性探测:只读文件系统检查,不执行任何命令。
 *
 * 供「接入执行器」表单的 bin 字段做即时校验:输入可以是命令名
 * (在服务器进程 PATH 里查找)或绝对路径(直接检查)。纯 Node fs 实现,
 * 不 spawn `which` 子进程,避免不同操作系统(尤其是 macOS 之外的部署
 * 环境)上行为不一致。
 */
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/** bin 输入长度上限(与路由侧 zod 校验保持一致)。 */
export const MAX_BIN_LENGTH = 200;

/**
 * 判断给定路径是否是一个「可执行文件」:存在、是普通文件、且有执行权限。
 * 目录(即使带搜索权限)不算;Windows 下 X_OK 对普通文件基本恒通过,
 * 靠 isFile() 兜底排除目录。
 */
export function isExecutableFile(filePath: string): boolean {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析 bin 到服务器环境里可执行文件的绝对路径:
 * - 绝对路径(以 / 开头):直接检查该文件;
 * - 命令名(不含 /):按 PATH 逐目录拼接后查找。
 * pathEnv 可注入以便测试(缺省取服务器进程的 process.env.PATH)。
 * 找不到返回 null,不抛错。
 */
export function resolveBin(
  bin: string,
  pathEnv: string = process.env.PATH ?? "",
): string | null {
  if (path.isAbsolute(bin)) {
    return isExecutableFile(bin) ? path.resolve(bin) : null;
  }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, bin);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}
