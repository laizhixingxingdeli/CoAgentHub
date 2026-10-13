/**
 * 工单范围（allowedScope）的路径语义，建单 / 修订 / 派发、机器验证、检查点三处共用同一份。
 *
 * 以前三处各写一套：验证器把「/ 结尾」当目录前缀，检查点只认精确文件，建单什么都收。
 * 于是 `app/` 这种写法一路畅通，直到执行者整跳跑完、交卷之后才被检查点用一句
 * 「授权路径不确定」拒掉——一跳执行者的钱白花，改动留在工作区里谁也不敢动
 * （MiRing-V0-probe 的 W-610）。判据收在这一份纯函数里，拒绝可以提前到执行之前。
 *
 * 纯函数、零依赖：内核之外的各层都能用，也方便单测。
 */

/** 规范化路径：`\\`→`/`，去重复前导 `./`，去空白外壳。 */
export function normalizeScopePath(raw: string): string {
  let s = raw.trim().replace(/\\/g, '/');
  while (s.startsWith('./')) {
    s = s.slice(2);
  }
  return s;
}

export function isAbsoluteOrDrive(path: string): boolean {
  if (path.startsWith('/')) return true;
  if (/^[A-Za-z]:(\/|$)/.test(path)) return true;
  return false;
}

/** 绝对路径或含 `..` 段 → 逃逸。 */
export function isEscapePath(path: string): boolean {
  if (isAbsoluteOrDrive(path)) return true;
  return path.split('/').some((part) => part === '..');
}

/**
 * 单个 allowed 是否覆盖 actual。
 * - 普通 scope：精确匹配
 * - 以 `/` 结尾：目录前缀（目录自身 + descendants）
 *
 * 目录前缀只在验证器一侧成立（契约层 / 快车道的范围可以写到目录）；
 * Standard 工单的范围必须是精确文件，见 {@link exactFileScopeIssue}。
 */
export function scopeMatches(allowed: string, actual: string): boolean {
  if (allowed.endsWith('/')) {
    const dir = allowed.slice(0, -1);
    if (actual === dir) return true;
    if (dir === '') return !isAbsoluteOrDrive(actual) && !isEscapePath(actual);
    return actual.startsWith(`${dir}/`);
  }
  return allowed === actual;
}

export type ScopeIssueCode =
  | 'empty'
  | 'absolute'
  | 'traversal'
  | 'dot_segment'
  | 'glob'
  | 'directory';

/** 一条不能作为精确授权的范围条目，连同能照做的改法。 */
export interface ScopeIssue {
  readonly entry: string;
  readonly code: ScopeIssueCode;
  readonly reason: string;
  /** 改成什么样才收。写成具体写法，不写「请修正」。 */
  readonly example: string;
}

const GLOB_CHARS = /[*?[\]{}]/;

/**
 * Standard 工单的 allowedScope 条目必须是「相对仓库根的精确文件路径」。
 *
 * 检查点只提交被点名的文件：目录与通配符会替将来才出现的文件预先授权，
 * 生成物、缓存、别人的文件都会被一并带进提交——这正是检查点要挡的事。
 * 没问题返回 undefined；有问题给出原因与改法。
 */
export function exactFileScopeIssue(entry: unknown): ScopeIssue | undefined {
  if (typeof entry !== 'string') {
    return {
      entry: String(entry),
      code: 'empty',
      reason: '范围条目必须是字符串',
      example: '"src/foo.ts"',
    };
  }
  const normalized = normalizeScopePath(entry);
  const issue = (code: ScopeIssueCode, reason: string, example: string): ScopeIssue => ({
    entry,
    code,
    reason,
    example,
  });
  if (normalized === '' || normalized.includes('\0')) {
    return issue('empty', '范围条目为空或含非法字符', '"src/foo.ts"');
  }
  // 盘符开头一律拒（含 `C:foo` 这种「某盘当前目录」的相对写法）：Windows 上它指向仓库之外或备用数据流，
  // 检查点原来就是这么严，验证器的 isAbsoluteOrDrive 只认 `C:/` 与 `C:`，这里不能放宽。
  if (isAbsoluteOrDrive(normalized) || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized)) {
    return issue('absolute', '绝对路径或盘符开头的路径不能作为授权范围', '相对仓库根的路径，例如 "src/foo.ts"');
  }
  const segments = normalized.split('/');
  if (segments.some((part) => part === '..')) {
    return issue('traversal', '路径含 ".."，会跳出仓库', '去掉 ".."，写成相对仓库根的路径');
  }
  if (normalized.endsWith('/')) {
    const dir = normalized.slice(0, -1);
    return issue(
      'directory',
      '目录形式的范围会替还不存在的文件预先授权，检查点只提交被点名的文件',
      `把 "${entry}" 换成目录下实际要改的具体文件，例如 "${dir}/<文件名>"；文件太多就拆成几张工单`,
    );
  }
  if (segments.some((part) => part === '.' || part === '')) {
    return issue('dot_segment', '路径含 "." 或空段', '去掉多余的 "./" 或重复的 "/"');
  }
  if (GLOB_CHARS.test(normalized)) {
    return issue('glob', '通配符不能作为授权范围', '逐个列出具体文件，不要用 * ? [] {}');
  }
  return undefined;
}

export function exactFileScopeIssues(entries: readonly unknown[]): ScopeIssue[] {
  const issues: ScopeIssue[] = [];
  for (const entry of entries) {
    const issue = exactFileScopeIssue(entry);
    if (issue) issues.push(issue);
  }
  return issues;
}

/** 汇总成一句能直接贴给协调者 / 执行者的话。 */
export function describeScopeIssues(issues: readonly ScopeIssue[]): string {
  return issues
    .map((issue) => `「${issue.entry}」：${issue.reason}。改法：${issue.example}`)
    .join('；');
}
