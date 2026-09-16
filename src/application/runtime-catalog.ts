/**
 * 运行时能力目录：问适配层「你现在能跑哪些模型」。
 *
 * ## 为什么平台不自己维护一份
 *
 * 平台**不认识模型**（内核连这个词都禁）。哪些模型可用取决于适配层装了什么、
 * 配了哪些凭据、以及那边的服务当下活不活着——这些只有适配层知道。
 * 在平台侧再抄一份表，抄的那一刻就开始过期，而过期的表会让人在界面上
 * 选一个根本跑不起来的候选。
 *
 * 所以这里做的事只有一件：**执行适配层的命令，把它吐的 JSON 原样转出去。**
 * 平台不解释其中任何一个字段。
 *
 * 取不到不是错误——没装适配层、或适配层还没配好凭据都是正常状态。
 * 返回 `{ available: false, note }` 让界面把原因显示出来，
 * 而不是抛一个 500 让人以为平台坏了。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface RuntimeModel {
  readonly provider: string;
  readonly model: string;
  readonly label: string;
}

export type RuntimeCatalog =
  | { readonly available: true; readonly runtime: string; readonly models: RuntimeModel[] }
  | { readonly available: false; readonly note: string };

/**
 * 适配层所在目录。没配就找项目的同级目录。
 *
 * 相对**本文件**定位，不是相对进程 cwd。从 Mission 的 worktree 里起服务时
 * cwd 是 `.coagent-worktrees/<mission>/`，按 cwd 猜会去找
 * `.coagent-worktrees/coagent-pi` —— 那里当然没有，于是界面上永远显示
 * "找不到适配层"，而人完全不知道该往哪儿指。
 */
export function adapterDir(): string {
  if (process.env.COAGENT_ADAPTER_DIR) return resolve(process.env.COAGENT_ADAPTER_DIR);
  // src/application/ → 上三层是项目根的同级。
  const fromModule = new URL('../../../coagent-pi/', import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    '$1',
  );
  return resolve(fromModule);
}

export async function listRuntimeModels(dir = adapterDir()): Promise<RuntimeCatalog> {
  if (!existsSync(dir)) {
    return {
      available: false,
      note: `找不到适配层目录 ${dir}。用 COAGENT_ADAPTER_DIR 指到 coagent-pi 那个目录。`,
    };
  }
  try {
    const { stdout } = await run('npx', ['tsx', 'src/cli.ts', 'models'], {
      cwd: dir,
      shell: process.platform === 'win32',
      // 起 pi 的运行时要读配置、可能还要探活，给足时间；
      // 但也不能无限等——这是一个页面在等它。
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!Array.isArray(parsed)) {
      const note = (parsed as { error?: string })?.error ?? '适配层没有返回模型清单';
      return { available: false, note };
    }
    return { available: true, runtime: 'pi', models: parsed as RuntimeModel[] };
  } catch (error) {
    return {
      available: false,
      note: `问适配层要模型清单失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
