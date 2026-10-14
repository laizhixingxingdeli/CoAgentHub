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
 * 目录前缀在验证器与 Standard 工单两侧都成立；Standard 工单的条目可以是精确文件，
 * 也可以是以 `/` 结尾的目录，见 {@link exactFileScopeIssue}。
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
 * Standard 工单的 allowedScope 条目可以是「相对仓库根的精确文件」，或以 `/` 结尾的目录
 * （目录下新增 / 修改 / 删除的文件都算授权）。
 *
 * 绝对路径、盘符、`..`、空段 / `.` 段、通配符仍不能作为授权范围：通配符会替将来才
 * 出现的文件预先授权，生成物、缓存、别人的文件都会被一并带进提交——这正是检查点要挡的事。
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
    // 以单个尾斜线结尾的目录合法；去掉这一个尾斜线后仍不能含 `.` 段、空段或通配符。
    const dir = normalized.slice(0, -1);
    const dirSegments = dir.split('/');
    if (dirSegments.some((part) => part === '.' || part === '')) {
      return issue('dot_segment', '路径含 "." 或空段', '去掉多余的 "./" 或重复的 "/"');
    }
    if (GLOB_CHARS.test(dir)) {
      return issue('glob', '通配符不能作为授权范围', '逐个列出具体文件，不要用 * ? [] {}');
    }
    return undefined;
  }
  if (segments.some((part) => part === '.' || part === '')) {
    return issue('dot_segment', '路径含 "." 或空段', '去掉多余的 "./" 或重复的 "/"');
  }
  if (GLOB_CHARS.test(normalized)) {
    return issue('glob', '通配符不能作为授权范围', '逐个列出具体文件，不要用 * ? [] {}');
  }
  return undefined;
}

/**
 * 是否是杂文件 / 生成物路径：`__pycache__` 段、`.pyc` / `.pyo`、`.DS_Store` / `Thumbs.db` /
 * `desktop.ini`。检查点 / 验证器用这一份判据把杂文件排除在提交与越界之外。
 */
export function isJunkPath(path: string): boolean {
  const normalized = normalizeScopePath(path);
  const segments = normalized.split('/');
  if (segments.some((part) => part === '__pycache__')) return true;
  const last = segments[segments.length - 1] ?? '';
  if (last === '.DS_Store' || last === 'Thumbs.db' || last === 'desktop.ini') return true;
  const dot = last.lastIndexOf('.');
  const ext = dot === -1 ? '' : last.slice(dot).toLowerCase();
  return ext === '.pyc' || ext === '.pyo';
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
