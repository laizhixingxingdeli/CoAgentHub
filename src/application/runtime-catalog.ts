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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
 * PI-Q1 的用量行。适配器是权威：平台只校验形状，不解释字段，
 * 也不把未知字段丢掉——原样转出去，界面才能显示适配层新加的东西。
 */
export interface UsageRow {
  readonly provider: string;
  readonly status: 'ok' | 'no_auth' | 'error' | 'timeout';
  /**
   * 同一 provider 下按上游再分的额度桶（tenrouter 这类聚合器一条 provider 带多个上游）。
   * 缺省表示这一行对该 provider 的所有模型都算数 —— 老的单上游适配层就长这样。
   */
  readonly modelPrefix?: string;
  readonly usedPercent?: number;
  readonly remainingPercent?: number;
  readonly resetAt?: string;
  readonly periodStart?: string;
  readonly plan?: string;
  readonly fetchedAt?: string;
  readonly [key: string]: unknown;
}

export type RuntimeUsage = readonly UsageRow[] | { readonly available: false; readonly note: string };

const USAGE_STATUSES = new Set(['ok', 'no_auth', 'error', 'timeout']);

/**
 * 一个候选该看哪条用量行。抽成纯函数是因为**两处**要同一套匹配规则：编排器
 * 决定「这一跳还能不能派」，网页决定「这一格显示多少额度」。两处各写一份的下场
 * 是界面上写着还有 80%，编排器却已经把它拉黑 —— 人看着一个绿灯的候选一直不被用。
 *
 * 匹配规则：
 *   - provider 不等于候选的 provider fact，或 status 不是 ok，直接不要。
 *   - 行上没 modelPrefix 是**兜底**：只在该 provider 下没有任何带前缀的行命中时才算数，
 *     于是只有 xAI 行的老适配层行为与改动前完全一致。
 *   - 有 modelPrefix 时，候选的 model fact 必须以「modelPrefix/」开头。用 / 断开是
 *     为了避免『ag』把『agx/…』也吃进去。
 *   - 多条命中取**最长前缀**（cbcn 比 c 更贴近这个候选），同长度取输入里靠前的行。
 *     upstream 那种长名不是匹配键 —— 它是适配层给人看的，模型 fact 里没有它。
 *
 * 没有 provider 就返回 undefined：不猜，猜出来的额度会显示在错的候选上。
 */
export function findUsageRow(
  rows: readonly unknown[],
  provider: string | undefined,
  model?: string,
): UsageRow | undefined {
  if (!provider) return undefined;
  let matched: UsageRow | undefined;
  let matchedPrefixLength = -1;
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const candidate = row as Record<string, unknown>;
    if (candidate.provider !== provider || candidate.status !== 'ok') continue;
    const prefix = candidate.modelPrefix;
    if (prefix === undefined) {
      // 兜底只填第一个空位，不覆盖已经命中的带前缀行。
      if (matched === undefined) matched = row as UsageRow;
      continue;
    }
    if (typeof prefix !== 'string') continue;
    if (typeof model !== 'string' || !model.startsWith(`${prefix}/`)) continue;
    // 严格大于：同长度保留先出现的那一行，结果与输入顺序一致、可预期。
    if (prefix.length > matchedPrefixLength) {
      matched = row as UsageRow;
      matchedPrefixLength = prefix.length;
    }
  }
  return matched;
}

let latestAdapterDir: string | undefined;
export function rememberAdapterDir(dir: string): void { latestAdapterDir = resolve(dir); }

/**
 * 仓内适配层目录的默认位置：repoRoot/adapters/pi 存在就用它，
 * 否则退回旧的仓库同级 ../coagent-pi（兼容未迁移的目录布局）。
 */
export function defaultAdapterDir(repoRoot?: string): string {
  const root = repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const bundled = resolve(root, 'adapters', 'pi');
  if (existsSync(bundled)) return bundled;
  return resolve(root, '..', 'coagent-pi');
}

/**
 * 适配层所在目录。没配就先找仓内 adapters/pi，再退回项目的同级目录。
 *
 * 相对**本文件**定位，不是相对进程 cwd。从 Mission 的 worktree 里起服务时
 * cwd 是 `.coagent-worktrees/<mission>/`，按 cwd 猜会去找
 * `.coagent-worktrees/coagent-pi` —— 那里当然没有，于是界面上永远显示
 * "找不到适配层"，而人完全不知道该往哪儿指。
 */
export function adapterDir(): string {
  if (process.env.COAGENT_ADAPTER_DIR) return resolve(process.env.COAGENT_ADAPTER_DIR);
  if (latestAdapterDir) return latestAdapterDir;
  return defaultAdapterDir();
}

export async function getRuntimeUsage(dir = adapterDir(), runner = run): Promise<RuntimeUsage> {
  if (!existsSync(dir)) return { available: false, note: `找不到适配层目录 ${dir}` };
  try {
    const { stdout } = await runner('npx', ['tsx', 'src/cli.ts', 'usage'], {
      cwd: dir, shell: process.platform === 'win32', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    });
    const parsed: unknown = JSON.parse(stdout.trim());
    // 只认 PI-Q1：顶层是数组，且每一行都有 provider / status。
    // 旧的对象形状（{providers:[...]} 之类）在这里就是「协议不对」——
    // 照旧强加 available:true 会让下游拿一个空壳继续派活。
    if (!Array.isArray(parsed)) return { available: false, note: '适配层没有返回有效用量信息' };
    if (!parsed.every((row) => row !== null && typeof row === 'object' &&
        typeof (row as Record<string, unknown>).provider === 'string' &&
        USAGE_STATUSES.has((row as Record<string, unknown>).status as string))) {
      return { available: false, note: '适配层返回的用量行不是 PI-Q1 的 UsageRow[]' };
    }
    return parsed as UsageRow[];
  } catch (error) {
    return { available: false, note: `读取适配层用量失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function listRuntimeModels(dir = adapterDir()): Promise<RuntimeCatalog> {
  if (!existsSync(dir)) {
    return {
      available: false,
      note: `找不到适配层目录 ${dir}。请确认仓库内 adapters/pi 已就位，或用 COAGENT_ADAPTER_DIR 指向适配层目录，或先运行 node scripts/coagent.mjs setup。`,
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
