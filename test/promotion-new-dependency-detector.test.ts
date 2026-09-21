/**
 * DETECT-002：new_dependency 纯检测器 + showRootPackageJson trusted fact。
 *
 * 守住：
 *   - 只吃 { baseText, currentText }；不读盘、不 git、不碰 Mission/Platform
 *   - 四段依赖 key 并集；版本/搬迁/删除不触发；畸形 fail closed
 *   - Workspace 只读 revision:package.json；无任意 path；无 promote 接线
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectNewDependency } from '../src/application/promotion/new-dependency-detector.ts';
import {
  GitWorktreeManager,
  InPlaceWorkspaceManager,
} from '../src/application/workspace.ts';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function pkg(sections: Record<string, unknown>): string {
  return `${JSON.stringify(sections, null, 2)}\n`;
}

describe('detectNewDependency', () => {
  test('dependencies 新增 key => new_dependency', () => {
    assert.equal(
      detectNewDependency({
        baseText: pkg({ dependencies: { a: '1.0.0' } }),
        currentText: pkg({ dependencies: { a: '1.0.0', lodash: '^4.0.0' } }),
      }),
      'new_dependency',
    );
  });

  test('devDependencies 新增 key => new_dependency', () => {
    assert.equal(
      detectNewDependency({
        baseText: pkg({ devDependencies: { vitest: '1' } }),
        currentText: pkg({
          devDependencies: { vitest: '1', typescript: '5' },
        }),
      }),
      'new_dependency',
    );
  });

  test('peerDependencies 新增 key => new_dependency', () => {
    assert.equal(
      detectNewDependency({
        baseText: pkg({ peerDependencies: { react: '*' } }),
        currentText: pkg({
          peerDependencies: { react: '*', 'react-dom': '*' },
        }),
      }),
      'new_dependency',
    );
  });

  test('optionalDependencies 新增 key => new_dependency', () => {
    assert.equal(
      detectNewDependency({
        baseText: pkg({ optionalDependencies: {} }),
        currentText: pkg({ optionalDependencies: { fsevents: '2' } }),
      }),
      'new_dependency',
    );
  });

  test('仅版本/range 变更 => null', () => {
    assert.equal(
      detectNewDependency({
        baseText: pkg({
          dependencies: { a: '^1.0.0' },
          devDependencies: { b: '1.0.0' },
        }),
        currentText: pkg({
          dependencies: { a: '^2.0.0' },
          devDependencies: { b: 'workspace:*' },
        }),
      }),
      null,
    );
  });

  test('仅删除 key => null', () => {
    assert.equal(
      detectNewDependency({
        baseText: pkg({ dependencies: { a: '1', b: '2' } }),
        currentText: pkg({ dependencies: { a: '1' } }),
      }),
      null,
    );
  });

  test('同 key 跨段搬迁 => null', () => {
    assert.equal(
      detectNewDependency({
        baseText: pkg({ dependencies: { lodash: '4' } }),
        currentText: pkg({ devDependencies: { lodash: '4' } }),
      }),
      null,
    );
    assert.equal(
      detectNewDependency({
        baseText: pkg({
          dependencies: { x: '1' },
          peerDependencies: { y: '1' },
        }),
        currentText: pkg({
          optionalDependencies: { x: '9' },
          devDependencies: { y: '9' },
        }),
      }),
      null,
    );
  });

  test('base/current 缺失 => null', () => {
    const text = pkg({ dependencies: { a: '1' } });
    assert.equal(
      detectNewDependency({ baseText: undefined, currentText: text }),
      null,
    );
    assert.equal(
      detectNewDependency({ baseText: text, currentText: undefined }),
      null,
    );
    assert.equal(
      detectNewDependency({ baseText: undefined, currentText: undefined }),
      null,
    );
  });

  test('畸形 JSON / 非 object 根 => null', () => {
    const good = pkg({ dependencies: { a: '1', b: '2' } });
    assert.equal(
      detectNewDependency({ baseText: '{', currentText: good }),
      null,
    );
    assert.equal(
      detectNewDependency({ baseText: good, currentText: 'not-json' }),
      null,
    );
    assert.equal(
      detectNewDependency({ baseText: '[]', currentText: good }),
      null,
    );
    assert.equal(
      detectNewDependency({ baseText: good, currentText: '"str"' }),
      null,
    );
    assert.equal(
      detectNewDependency({ baseText: 'null', currentText: good }),
      null,
    );
  });

  test('依赖段存在但非 plain object => 整侧 null', () => {
    const good = pkg({ dependencies: { a: '1' } });
    assert.equal(
      detectNewDependency({
        baseText: pkg({ dependencies: ['lodash'] }),
        currentText: good,
      }),
      null,
    );
    assert.equal(
      detectNewDependency({
        baseText: good,
        currentText: JSON.stringify({ dependencies: null }),
      }),
      null,
    );
    assert.equal(
      detectNewDependency({
        baseText: good,
        currentText: JSON.stringify({ devDependencies: 'lodash' }),
      }),
      null,
    );
  });

  test('value 形态无关：奇怪 value 仍按 key 计', () => {
    assert.equal(
      detectNewDependency({
        baseText: pkg({ dependencies: { a: { weird: true } } }),
        currentText: pkg({
          dependencies: { a: null, b: 12, c: ['x'] },
        }),
      }),
      'new_dependency',
    );
  });

  test('缺失段视为空；overrides/resolutions/workspaces 不参与', () => {
    assert.equal(
      detectNewDependency({
        baseText: pkg({ name: 'x' }),
        currentText: pkg({
          name: 'x',
          overrides: { lodash: '1' },
          resolutions: { leftpad: '1' },
          workspaces: ['packages/*'],
          bundledDependencies: ['a'],
        }),
      }),
      null,
    );
    assert.equal(
      detectNewDependency({
        baseText: pkg({ name: 'x' }),
        currentText: pkg({ name: 'x', dependencies: { leftpad: '1' } }),
      }),
      'new_dependency',
    );
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function tempRepoWithPackage(prefix: string, packageJson: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@local');
  writeFileSync(join(dir, 'package.json'), packageJson);
  writeFileSync(join(dir, 'README.md'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('WorkspaceManager.showRootPackageJson', () => {
  test('读取已有 revision 的根 package.json 原文', async () => {
    const body = pkg({
      name: 'demo',
      dependencies: { pg: '^8.0.0' },
    });
    const repo = tempRepoWithPackage('coagent-pkg-show-', body);
    const head = git(repo, 'rev-parse', 'HEAD');
    const manager = new GitWorktreeManager();

    const text = await manager.showRootPackageJson(repo, head);
    assert.equal(text, body);

    const inplace = new InPlaceWorkspaceManager();
    assert.equal(await inplace.showRootPackageJson(repo, head), body);
  });

  test('缺失 package.json / 坏 revision => undefined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-pkg-miss-'));
    dirs.push(dir);
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.name', 'test');
    git(dir, 'config', 'user.email', 'test@local');
    writeFileSync(join(dir, 'only.txt'), 'no package\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    const head = git(dir, 'rev-parse', 'HEAD');
    const manager = new GitWorktreeManager();

    assert.equal(await manager.showRootPackageJson(dir, head), undefined);
    assert.equal(
      await manager.showRootPackageJson(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
      undefined,
    );
    assert.equal(await manager.showRootPackageJson(dir, ''), undefined);
  });

  test('不读工作区未提交内容：只信 revision 快照', async () => {
    const baseBody = pkg({ dependencies: { a: '1' } });
    const repo = tempRepoWithPackage('coagent-pkg-head-', baseBody);
    const head = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(
      join(repo, 'package.json'),
      pkg({ dependencies: { a: '1', sneaky: '9' } }),
    );
    const manager = new GitWorktreeManager();
    const text = await manager.showRootPackageJson(repo, head);
    assert.equal(text, baseBody);
    assert.ok(text && !text.includes('sneaky'));
  });
});

describe('DETECT-002 边界：无任意 path / 无 promote 接线', () => {
  test('showRootPackageJson 源码无 path 形参，只 show package.json', () => {
    const workspacePath = fileURLToPath(
      new URL('../src/application/workspace.ts', import.meta.url),
    );
    const source = readFileSync(workspacePath, 'utf8');

    const methodMatch = source.match(
      /async showRootPackageJson\(([^)]*)\)/g,
    );
    assert.ok(methodMatch && methodMatch.length >= 1);
    for (const sig of methodMatch) {
      assert.match(sig, /showRootPackageJson\(cwd: string, revision: string\)/);
      assert.doesNotMatch(sig, /\bpath\b/);
    }

    // 实现只允许字面 package.json，禁止拼 path 参数进 git show
    assert.ok(source.includes('${revision}:package.json'));
    assert.equal(
      (source.match(/:package\.json/g) ?? []).length >= 1,
      true,
    );
    assert.doesNotMatch(source, /show\s+[\w.]*\$\{[^}]*path/);
  });

  test('new-dependency-detector 与 diff-detectors 分离，且无 promote 接线', () => {
    const detectorPath = fileURLToPath(
      new URL(
        '../src/application/promotion/new-dependency-detector.ts',
        import.meta.url,
      ),
    );
    const detector = readFileSync(detectorPath, 'utf8');
    assert.ok(detector.includes('detectNewDependency'));
    assert.doesNotMatch(detector, /promoteMissionToStandard/);
    assert.doesNotMatch(detector, /from ['"].*platform/);
    assert.doesNotMatch(detector, /from ['"].*orchestrator/);
    assert.doesNotMatch(
      detector,
      /\bfrom\s+['"]node:(fs|child_process)['"]|\b(?:readFileSync|writeFileSync|execFile)\b/,
    );

    const diffPath = fileURLToPath(
      new URL('../src/application/promotion/diff-detectors.ts', import.meta.url),
    );
    const diff = readFileSync(diffPath, 'utf8');
    assert.doesNotMatch(diff, /detectNewDependency|new_dependency/);

    // 全树：本切片不得把 detector 接到 promote / HTTP / tools
    const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (name.endsWith('.ts')) out.push(full);
      }
      return out;
    }
    for (const full of walk(srcRoot)) {
      const rel = full.slice(srcRoot.length).replaceAll('\\', '/');
      if (rel === 'application/promotion/new-dependency-detector.ts') continue;
      if (rel === 'application/workspace.ts') continue;
      const text = readFileSync(full, 'utf8');
      assert.ok(
        !text.includes('detectNewDependency'),
        `${rel}: 不得接线 detectNewDependency（本切片无 auto-promote）`,
      );
      assert.ok(
        !text.includes('showRootPackageJson'),
        `${rel}: 不得接线 showRootPackageJson（本切片无调用方）`,
      );
      assert.ok(
        !text.includes('new-dependency-detector'),
        `${rel}: 不得 import new-dependency-detector`,
      );
    }
  });
});
