/**
 * HA 常设授权：仓库与所有 worktree 之外的 JSON v1。
 *
 * 每次放行现读、不缓存。错误只带稳定码，不带回文件正文——正文进日志
 * 就等于把放行名册交给任意失败路径。
 */

import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const HA_AUTHORITY_ENV = 'COAGENT_HA_AUTHORITY_FILE';

export const HA_AUTHORITY_CODE = {
  ENV_MISSING: 'HA_AUTHORITY_ENV_MISSING',
  FILE_MISSING: 'HA_AUTHORITY_FILE_MISSING',
  INVALID_JSON: 'HA_AUTHORITY_INVALID_JSON',
  INVALID_VERSION: 'HA_AUTHORITY_INVALID_VERSION',
  INVALID_FIELDS: 'HA_AUTHORITY_INVALID_FIELDS',
  RELATIVE_PATH: 'HA_AUTHORITY_RELATIVE_PATH',
  PATH_IN_REPO: 'HA_AUTHORITY_PATH_IN_REPO',
  PATH_IN_WORKTREE: 'HA_AUTHORITY_PATH_IN_WORKTREE',
  SYMLINK_ESCAPE: 'HA_AUTHORITY_SYMLINK_ESCAPE',
  PATH_UNRESOLVABLE: 'HA_AUTHORITY_PATH_UNRESOLVABLE',
  EMPTY_LIST: 'HA_AUTHORITY_EMPTY_LIST',
  MASTER_FORBIDDEN: 'HA_AUTHORITY_MASTER_FORBIDDEN',
  WILDCARD_FORBIDDEN: 'HA_AUTHORITY_WILDCARD_FORBIDDEN',
  WORKTREE_UNRESOLVABLE: 'HA_AUTHORITY_WORKTREE_UNRESOLVABLE',
  REVIEWER_UNREGISTERED: 'HA_AUTHORITY_REVIEWER_UNREGISTERED',
  CONFIRMED_BY_MISMATCH: 'HA_AUTHORITY_CONFIRMED_BY_MISMATCH',
  BRANCH_NOT_ALLOWED: 'HA_AUTHORITY_BRANCH_NOT_ALLOWED',
} as const;

export type HaAuthorityCode = (typeof HA_AUTHORITY_CODE)[keyof typeof HA_AUTHORITY_CODE];

export class HaAuthorityError extends Error {
  readonly code: HaAuthorityCode;

  constructor(code: HaAuthorityCode, message: string) {
    super(message);
    this.name = 'HaAuthorityError';
    this.code = code;
  }
}

export interface HaAuthorityReviewer {
  readonly reviewerId: string;
  readonly confirmedBy: string;
  readonly integrationBranches: readonly string[];
}

export interface HaAuthorityConfig {
  readonly version: 1;
  readonly source: string;
  readonly reviewers: readonly HaAuthorityReviewer[];
}

const TOP_KEYS = new Set(['version', 'source', 'reviewers']);
const REVIEWER_KEYS = new Set(['reviewerId', 'confirmedBy', 'integrationBranches']);

export function pathContainedBy(root: string, candidate: string): boolean {
  const a = normalizeForCompare(root);
  const b = normalizeForCompare(candidate);
  const boundary = a.endsWith(sep) ? a : a + sep;
  return b === a || b.startsWith(boundary);
}

export async function loadHaAuthorityConfig(input: {
  readonly filePath: string | undefined;
  readonly repoRoot: string;
  readonly worktreePaths: readonly string[];
}): Promise<HaAuthorityConfig> {
  const rawPath = input.filePath;
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.ENV_MISSING,
      'HA 放行拒绝（HA_AUTHORITY_ENV_MISSING）：未配置授权文件。',
    );
  }
  if (!isAbsolute(rawPath)) {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.RELATIVE_PATH,
      'HA 放行拒绝（HA_AUTHORITY_RELATIVE_PATH）：授权文件必须是绝对路径。',
    );
  }

  const repoReal = await realpathOrThrow(
    input.repoRoot,
    HA_AUTHORITY_CODE.WORKTREE_UNRESOLVABLE,
    '无法解析仓库真实路径，拒绝放行。',
  );
  const worktreeReals: string[] = [];
  for (const wt of input.worktreePaths) {
    worktreeReals.push(
      await realpathOrThrow(
        wt,
        HA_AUTHORITY_CODE.WORKTREE_UNRESOLVABLE,
        '无法解析 worktree 真实路径，拒绝放行。',
      ),
    );
  }

  const lexical = resolve(rawPath);
  try {
    await lstat(lexical);
  } catch {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.FILE_MISSING,
      'HA 放行拒绝（HA_AUTHORITY_FILE_MISSING）：授权文件不存在。',
    );
  }
  let lexicalCanonical: string;
  try {
    lexicalCanonical = join(await realpath(dirname(lexical)), basename(lexical));
  } catch {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.PATH_UNRESOLVABLE,
      'HA 放行拒绝（HA_AUTHORITY_PATH_UNRESOLVABLE）：授权文件路径无法解析为真实路径。',
    );
  }

  let physical: string;
  try {
    physical = await realpath(lexical);
  } catch {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.PATH_UNRESOLVABLE,
      'HA 放行拒绝（HA_AUTHORITY_PATH_UNRESOLVABLE）：授权文件路径无法解析为真实路径。',
    );
  }

  const lexicalInside = containedByAny(lexicalCanonical, repoReal, worktreeReals);
  const physicalInside = containedByAny(physical, repoReal, worktreeReals);
  if (!lexicalInside && physicalInside) {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.SYMLINK_ESCAPE,
      'HA 放行拒绝（HA_AUTHORITY_SYMLINK_ESCAPE）：授权文件符号链接越界。',
    );
  }

  // 词法路径和真实路径都要查。只查真实路径时，仓库内指向仓外的符号链接
  // 会因 physical 在外面而被接受，等于允许把名册放进仓库。仓外链接指进
  // 仓库仍由上面的 SYMLINK_ESCAPE 挡住。
  // git worktree list 把主工作区（仓库根）也列成一条 worktree。先判仓库根，
  // 并从附加 worktree 集合里去掉与仓库根同一路径的条目，否则仓库内文件会被
  // 错报成 HA_AUTHORITY_PATH_IN_WORKTREE，两个拒绝码就分不开了。
  if (pathContainedBy(repoReal, physical) || pathContainedBy(repoReal, lexicalCanonical)) {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.PATH_IN_REPO,
      'HA 放行拒绝（HA_AUTHORITY_PATH_IN_REPO）：授权文件不能放在仓库内。',
    );
  }
  const additionalWorktrees = worktreeReals.filter((root) => !sameNormalizedPath(root, repoReal));
  const worktreeHit = additionalWorktrees.find(
    (root) => pathContainedBy(root, physical) || pathContainedBy(root, lexicalCanonical),
  );
  if (worktreeHit) {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.PATH_IN_WORKTREE,
      'HA 放行拒绝（HA_AUTHORITY_PATH_IN_WORKTREE）：授权文件不能放在 worktree 内。',
    );
  }

  let fileStat;
  try {
    fileStat = await stat(physical);
  } catch {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.FILE_MISSING,
      'HA 放行拒绝（HA_AUTHORITY_FILE_MISSING）：授权文件不存在。',
    );
  }
  if (!fileStat.isFile()) {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.FILE_MISSING,
      'HA 放行拒绝（HA_AUTHORITY_FILE_MISSING）：授权文件不存在。',
    );
  }

  let text: string;
  try {
    text = await readFile(physical, 'utf8');
  } catch {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.FILE_MISSING,
      'HA 放行拒绝（HA_AUTHORITY_FILE_MISSING）：授权文件不存在。',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.INVALID_JSON,
      'HA 放行拒绝（HA_AUTHORITY_INVALID_JSON）：授权文件不是合法 JSON。',
    );
  }

  return parseHaAuthorityDocument(parsed);
}

export function parseHaAuthorityDocument(value: unknown): HaAuthorityConfig {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.INVALID_FIELDS,
      'HA 放行拒绝（HA_AUTHORITY_INVALID_FIELDS）：授权文件根对象非法。',
    );
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) {
      throw new HaAuthorityError(
        HA_AUTHORITY_CODE.INVALID_FIELDS,
        'HA 放行拒绝（HA_AUTHORITY_INVALID_FIELDS）：授权文件含未知字段。',
      );
    }
  }
  if (raw.version !== 1) {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.INVALID_VERSION,
      'HA 放行拒绝（HA_AUTHORITY_INVALID_VERSION）：只接受 version=1。',
    );
  }
  if (typeof raw.source !== 'string' || raw.source.trim() === '') {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.INVALID_FIELDS,
      'HA 放行拒绝（HA_AUTHORITY_INVALID_FIELDS）：source 必须是非空字符串。',
    );
  }
  if (!Array.isArray(raw.reviewers)) {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.INVALID_FIELDS,
      'HA 放行拒绝（HA_AUTHORITY_INVALID_FIELDS）：reviewers 必须是数组。',
    );
  }
  if (raw.reviewers.length === 0) {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.EMPTY_LIST,
      'HA 放行拒绝（HA_AUTHORITY_EMPTY_LIST）：检视者列表为空。',
    );
  }

  const reviewers: HaAuthorityReviewer[] = [];
  const seen = new Set<string>();
  for (const row of raw.reviewers) {
    reviewers.push(parseReviewer(row, seen));
  }
  return {
    version: 1,
    source: raw.source.trim(),
    reviewers,
  };
}

export function matchHaRelease(
  config: HaAuthorityConfig,
  input: { readonly reviewerId: string; readonly confirmedBy: string; readonly branch: string },
): HaAuthorityReviewer {
  const reviewer = config.reviewers.find((row) => row.reviewerId === input.reviewerId);
  if (!reviewer) {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.REVIEWER_UNREGISTERED,
      'HA 放行拒绝（HA_AUTHORITY_REVIEWER_UNREGISTERED）：检视者未登记。',
    );
  }
  if (reviewer.confirmedBy !== input.confirmedBy) {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.CONFIRMED_BY_MISMATCH,
      'HA 放行拒绝（HA_AUTHORITY_CONFIRMED_BY_MISMATCH）：确认主体与登记值不一致。',
    );
  }
  if (!reviewer.integrationBranches.includes(input.branch)) {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.BRANCH_NOT_ALLOWED,
      'HA 放行拒绝（HA_AUTHORITY_BRANCH_NOT_ALLOWED）：目标分支不在允许列表。',
    );
  }
  return reviewer;
}

function parseReviewer(value: unknown, seen: Set<string>): HaAuthorityReviewer {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.INVALID_FIELDS,
      'HA 放行拒绝（HA_AUTHORITY_INVALID_FIELDS）：reviewer 条目非法。',
    );
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!REVIEWER_KEYS.has(key)) {
      throw new HaAuthorityError(
        HA_AUTHORITY_CODE.INVALID_FIELDS,
        'HA 放行拒绝（HA_AUTHORITY_INVALID_FIELDS）：reviewer 含未知字段。',
      );
    }
  }
  if (typeof raw.reviewerId !== 'string' || raw.reviewerId.trim() === '') {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.INVALID_FIELDS,
      'HA 放行拒绝（HA_AUTHORITY_INVALID_FIELDS）：reviewerId 必须非空。',
    );
  }
  if (typeof raw.confirmedBy !== 'string' || raw.confirmedBy.trim() === '') {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.INVALID_FIELDS,
      'HA 放行拒绝（HA_AUTHORITY_INVALID_FIELDS）：confirmedBy 必须非空。',
    );
  }
  const reviewerId = raw.reviewerId.trim();
  const confirmedBy = raw.confirmedBy.trim();
  if (seen.has(reviewerId)) {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.INVALID_FIELDS,
      'HA 放行拒绝（HA_AUTHORITY_INVALID_FIELDS）：reviewerId 必须唯一。',
    );
  }
  seen.add(reviewerId);
  if (!Array.isArray(raw.integrationBranches)) {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.INVALID_FIELDS,
      'HA 放行拒绝（HA_AUTHORITY_INVALID_FIELDS）：integrationBranches 必须是数组。',
    );
  }
  if (raw.integrationBranches.length === 0) {
    throw new HaAuthorityError(
      HA_AUTHORITY_CODE.EMPTY_LIST,
      'HA 放行拒绝（HA_AUTHORITY_EMPTY_LIST）：允许的集成分支为空。',
    );
  }
  const integrationBranches: string[] = [];
  for (const branch of raw.integrationBranches) {
    if (typeof branch !== 'string' || branch.trim() === '') {
      throw new HaAuthorityError(
        HA_AUTHORITY_CODE.INVALID_FIELDS,
        'HA 放行拒绝（HA_AUTHORITY_INVALID_FIELDS）：集成分支名必须非空。',
      );
    }
    const name = branch.trim();
    if (isMasterBranch(name)) {
      throw new HaAuthorityError(
        HA_AUTHORITY_CODE.MASTER_FORBIDDEN,
        'HA 放行拒绝（HA_AUTHORITY_MASTER_FORBIDDEN）：master 不能作为常设代行目标。',
      );
    }
    if (hasWildcard(name)) {
      throw new HaAuthorityError(
        HA_AUTHORITY_CODE.WILDCARD_FORBIDDEN,
        'HA 放行拒绝（HA_AUTHORITY_WILDCARD_FORBIDDEN）：集成分支不允许通配。',
      );
    }
    integrationBranches.push(name);
  }
  return { reviewerId, confirmedBy, integrationBranches };
}

export function isMasterBranch(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed === 'master' || trimmed === 'refs/heads/master') return true;
  return /(?:^|\/)master$/.test(trimmed);
}

function hasWildcard(name: string): boolean {
  return /[*?\[]/.test(name);
}

function normalizeForCompare(value: string): string {
  const resolved = resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameNormalizedPath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

function containedByAny(candidate: string, repo: string, worktrees: readonly string[]): boolean {
  if (pathContainedBy(repo, candidate)) return true;
  return worktrees.some((root) => pathContainedBy(root, candidate));
}

async function realpathOrThrow(
  value: string,
  code: HaAuthorityCode,
  message: string,
): Promise<string> {
  try {
    await lstat(value);
    return await realpath(value);
  } catch {
    throw new HaAuthorityError(code, `HA 放行拒绝（${code}）：${message}`);
  }
}
