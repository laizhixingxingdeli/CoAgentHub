/**
 * HA 常设授权配置：解析、路径越界、错误码不泄露正文。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import {
  HA_AUTHORITY_CODE,
  HaAuthorityError,
  loadHaAuthorityConfig,
  matchHaRelease,
  parseHaAuthorityDocument,
  pathContainedBy,
} from '../src/application/ha-authority-config.ts';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const SECRET = 'ha-body-secret-should-not-leak';

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function validDoc(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    source: SECRET,
    reviewers: [
      {
        reviewerId: 'rv-1',
        confirmedBy: 'human-1',
        integrationBranches: ['auto/plan-x'],
      },
    ],
    ...over,
  };
}

function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function assertCode(error: unknown, code: string): asserts error is HaAuthorityError {
  assert.equal(error instanceof HaAuthorityError, true, String(error));
  assert.equal((error as HaAuthorityError).code, code);
  assert.equal((error as Error).message.includes(SECRET), false, (error as Error).message);
}

function outsideFile(repo: string, doc: unknown = validDoc()): { file: string; outside: string } {
  const outside = tempDir('coagent-ha-auth-');
  return { file: writeJson(outside, 'ha.json', doc), outside };
}

describe('pathContainedBy 边界', () => {
  test('目录分隔边界：repo 不含 repo2', () => {
    const repo = join(tmpdir(), 'coagent-repo');
    const other = join(tmpdir(), 'coagent-repo2');
    assert.equal(pathContainedBy(repo, join(repo, 'a.json')), true);
    assert.equal(pathContainedBy(repo, other), false);
  });

  test('Windows 大小写：同一路径视为包含', () => {
    if (process.platform !== 'win32') return;
    const root = `C:${sep}Repo`;
    assert.equal(pathContainedBy(root, `c:${sep}repo${sep}a.json`), true);
  });
});

describe('parseHaAuthorityDocument', () => {
  test('合法 v1', () => {
    const parsed = parseHaAuthorityDocument(validDoc());
    assert.equal(parsed.version, 1);
    assert.equal(parsed.source, SECRET);
    assert.equal(parsed.reviewers[0]?.reviewerId, 'rv-1');
  });

  test('非法 JSON 根 / 版本 / 字段 / 空列表 / master / 通配 / 重复 id', () => {
    const cases: Array<{ value: unknown; code: string }> = [
      { value: null, code: HA_AUTHORITY_CODE.INVALID_FIELDS },
      { value: [], code: HA_AUTHORITY_CODE.INVALID_FIELDS },
      { value: validDoc({ version: 2 }), code: HA_AUTHORITY_CODE.INVALID_VERSION },
      { value: validDoc({ version: '1' }), code: HA_AUTHORITY_CODE.INVALID_VERSION },
      { value: validDoc({ source: '' }), code: HA_AUTHORITY_CODE.INVALID_FIELDS },
      { value: validDoc({ extra: true }), code: HA_AUTHORITY_CODE.INVALID_FIELDS },
      { value: validDoc({ reviewers: [] }), code: HA_AUTHORITY_CODE.EMPTY_LIST },
      {
        value: validDoc({
          reviewers: [{ reviewerId: 'rv-1', confirmedBy: 'h', integrationBranches: [] }],
        }),
        code: HA_AUTHORITY_CODE.EMPTY_LIST,
      },
      {
        value: validDoc({
          reviewers: [
            { reviewerId: 'rv-1', confirmedBy: 'h', integrationBranches: ['master'] },
          ],
        }),
        code: HA_AUTHORITY_CODE.MASTER_FORBIDDEN,
      },
      {
        value: validDoc({
          reviewers: [
            { reviewerId: 'rv-1', confirmedBy: 'h', integrationBranches: ['auto/*'] },
          ],
        }),
        code: HA_AUTHORITY_CODE.WILDCARD_FORBIDDEN,
      },
      {
        value: validDoc({
          reviewers: [
            { reviewerId: 'rv-1', confirmedBy: 'a', integrationBranches: ['auto/x'] },
            { reviewerId: 'rv-1', confirmedBy: 'b', integrationBranches: ['auto/y'] },
          ],
        }),
        code: HA_AUTHORITY_CODE.INVALID_FIELDS,
      },
    ];
    for (const item of cases) {
      try {
        parseHaAuthorityDocument(item.value);
        assert.fail(`应拒绝 ${item.code}`);
      } catch (error) {
        assertCode(error, item.code);
      }
    }
  });
});

describe('loadHaAuthorityConfig 路径与文件', () => {
  test('缺失路径', async () => {
    const repo = tempDir('coagent-ha-repo-');
    await assert.rejects(
      () => loadHaAuthorityConfig({ filePath: undefined, repoRoot: repo, worktreePaths: [repo] }),
      (error: unknown) => {
        assertCode(error, HA_AUTHORITY_CODE.ENV_MISSING);
        return true;
      },
    );
  });

  test('相对路径', async () => {
    const repo = tempDir('coagent-ha-repo-');
    await assert.rejects(
      () =>
        loadHaAuthorityConfig({
          filePath: 'ha.json',
          repoRoot: repo,
          worktreePaths: [repo],
        }),
      (error: unknown) => {
        assertCode(error, HA_AUTHORITY_CODE.RELATIVE_PATH);
        return true;
      },
    );
  });

  test('非法 JSON', async () => {
    const repo = tempDir('coagent-ha-repo-');
    const outside = tempDir('coagent-ha-out-');
    const file = join(outside, 'ha.json');
    writeFileSync(file, `{ "source": "${SECRET}",`);
    await assert.rejects(
      () => loadHaAuthorityConfig({ filePath: file, repoRoot: repo, worktreePaths: [repo] }),
      (error: unknown) => {
        assertCode(error, HA_AUTHORITY_CODE.INVALID_JSON);
        return true;
      },
    );
  });

  test('仓库内路径', async () => {
    const repo = tempDir('coagent-ha-git-');
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'test');
    git(repo, 'config', 'user.email', 'test@local');
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    const file = writeJson(repo, 'ha.json', validDoc());
    await assert.rejects(
      () => loadHaAuthorityConfig({ filePath: file, repoRoot: repo, worktreePaths: [repo] }),
      (error: unknown) => {
        assertCode(error, HA_AUTHORITY_CODE.PATH_IN_REPO);
        return true;
      },
    );
  });

  test('worktree 内路径', async () => {
    const repo = tempDir('coagent-ha-git-');
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'test');
    git(repo, 'config', 'user.email', 'test@local');
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    const wt = join(tempDir('coagent-ha-wt-'), 'tree');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-ha');
    const file = writeJson(wt, 'ha.json', validDoc());
    await assert.rejects(
      () => loadHaAuthorityConfig({ filePath: file, repoRoot: repo, worktreePaths: [repo, wt] }),
      (error: unknown) => {
        assertCode(error, HA_AUTHORITY_CODE.PATH_IN_WORKTREE);
        return true;
      },
    );
  });

  test('越界符号链接', async (t) => {
    const repo = tempDir('coagent-ha-git-');
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'test');
    git(repo, 'config', 'user.email', 'test@local');
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    const inside = writeJson(repo, 'secret.json', validDoc());
    const outside = tempDir('coagent-ha-link-');
    const link = join(outside, 'ha-link.json');
    try {
      symlinkSync(inside, link);
    } catch {
      t.skip('未验证：本机无权创建符号链接');
      return;
    }
    await assert.rejects(
      () => loadHaAuthorityConfig({ filePath: link, repoRoot: repo, worktreePaths: [repo] }),
      (error: unknown) => {
        assertCode(error, HA_AUTHORITY_CODE.SYMLINK_ESCAPE);
        return true;
      },
    );
  });

  test('缺失文件', async () => {
    const repo = tempDir('coagent-ha-repo-');
    const missing = join(tempDir('coagent-ha-out-'), 'no-such.json');
    await assert.rejects(
      () => loadHaAuthorityConfig({ filePath: missing, repoRoot: repo, worktreePaths: [repo] }),
      (error: unknown) => {
        assertCode(error, HA_AUTHORITY_CODE.FILE_MISSING);
        return true;
      },
    );
  });

  test('仓库外合法文件可以加载', async () => {
    const repo = tempDir('coagent-ha-repo-');
    mkdirSync(repo, { recursive: true });
    const { file } = outsideFile(repo);
    const loaded = await loadHaAuthorityConfig({
      filePath: resolve(file),
      repoRoot: repo,
      worktreePaths: [repo],
    });
    assert.equal(loaded.reviewers[0]?.reviewerId, 'rv-1');
  });
});

describe('matchHaRelease', () => {
  const config = parseHaAuthorityDocument(validDoc());

  test('未登记 reviewerId', () => {
    try {
      matchHaRelease(config, { reviewerId: 'nope', confirmedBy: 'human-1', branch: 'auto/plan-x' });
      assert.fail('应拒绝');
    } catch (error) {
      assertCode(error, HA_AUTHORITY_CODE.REVIEWER_UNREGISTERED);
    }
  });

  test('confirmedBy 不逐字一致', () => {
    try {
      matchHaRelease(config, { reviewerId: 'rv-1', confirmedBy: 'human-2', branch: 'auto/plan-x' });
      assert.fail('应拒绝');
    } catch (error) {
      assertCode(error, HA_AUTHORITY_CODE.CONFIRMED_BY_MISMATCH);
    }
  });

  test('分支不在 allowlist', () => {
    try {
      matchHaRelease(config, { reviewerId: 'rv-1', confirmedBy: 'human-1', branch: 'auto/other' });
      assert.fail('应拒绝');
    } catch (error) {
      assertCode(error, HA_AUTHORITY_CODE.BRANCH_NOT_ALLOWED);
    }
  });

  test('登记值匹配', () => {
    const row = matchHaRelease(config, {
      reviewerId: 'rv-1',
      confirmedBy: 'human-1',
      branch: 'auto/plan-x',
    });
    assert.equal(row.reviewerId, 'rv-1');
  });
});
