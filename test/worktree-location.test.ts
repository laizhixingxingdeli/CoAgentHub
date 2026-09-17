/**
 * worktree 落在哪。
 *
 * ## 为什么单开一条
 *
 * 原先的默认是 `resolve('.coagent-worktrees')` —— 相对**进程 cwd**。在平台
 * 自己的仓库里跑自己，进程 cwd 和 projectRoot 恰好是同一个目录，所以一直
 * 没露馅；**整套用例也全绿**，因为它们量的从来是同一个项目。
 *
 * 换一个项目就立刻错：worktree 落在平台仓库下面，而 Node 沿父目录找依赖会
 * 找到**平台的** node_modules。实测 coagent-pi 依赖 pi-coding-agent /
 * typebox / undici，平台这边只有 pg —— 执行者在那种 worktree 里根本跑不动
 * 目标项目的代码。
 *
 * 而且它**不报错**，只是莫名其妙地跑不起来。所以判据不能是"记得传
 * --worktrees"：忘了没有任何声音。
 *
 * 这一条的形状是「**在与项目无关的目录下**跑，断言 worktree 仍然落在项目里」——
 * 这正是原来那套用例没覆盖到的那一维。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { GitWorktreeManager } from '../src/application/workspace.ts';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function tempRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@local');
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('worktree 跟着项目走，不跟着进程 cwd', () => {
  test('默认落在 <projectRoot>/.coagent-worktrees 里', async () => {
    const project = tempRepo('coagent-proj-');
    const manager = new GitWorktreeManager();

    const prepared = await manager.prepare('M1', project);

    // 关键断言：**在项目里**。进程 cwd 此刻是平台仓库，与 project 毫无关系；
    // 旧实现会把它放到平台仓库下面，于是执行者找到的是平台的 node_modules。
    assert.equal(
      resolve(prepared.cwd),
      resolve(project, '.coagent-worktrees', 'M1'),
      'worktree 必须落在目标项目内部 —— 依赖靠父目录查找，放错地方就找到别人的',
    );
    assert.ok(
      !resolve(prepared.cwd).startsWith(resolve(process.cwd(), '.coagent-worktrees')),
      '绝不能落在进程 cwd 下面',
    );

    await manager.release('M1', project);
  });

  test('自己产生的目录不许把项目弄脏 —— 否则落地闸会被自己挡住', async () => {
    // 这一条是上一条修复**制造出来的**问题，第一次拿真实新项目试流程就撞上了：
    // worktree 落在项目内部之后，`.coagent-worktrees/` 成了未跟踪目录，项目
    // 永远是脏的，而落地闸要求目标工作区干净 —— 平台在别人仓库里创建了一个
    // 目录，然后因为这个目录拒绝落地。
    const project = tempRepo('coagent-proj-');
    const manager = new GitWorktreeManager();

    await manager.prepare('M1', project);

    const dirty = git(project, 'status', '--porcelain');
    assert.equal(dirty, '', `项目必须仍然是干净的，实际还有：\n${dirty}`);

    // 必须写在 .git/info/exclude，**不是**项目的 .gitignore：那是别人的文件，
    // 会进版本库、会出现在他的 diff 里。
    const tracked = git(project, 'status', '--porcelain', '--ignored=no');
    assert.equal(tracked, '');
    assert.ok(
      !existsSync(join(project, '.gitignore')),
      '不许擅自给别人的仓库加 .gitignore',
    );

    await manager.release('M1', project);
  });

  test('显式给了 --worktrees 仍然听显式的', async () => {
    const project = tempRepo('coagent-proj-');
    const elsewhere = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(elsewhere);
    const manager = new GitWorktreeManager(elsewhere);

    const prepared = await manager.prepare('M1', project);
    // 默认改了，但覆盖能力不能丢：把 worktree 放到项目外面是使用者的选择
    // （代价是依赖得自己装，见 workspace.ts 顶部）。
    assert.equal(resolve(prepared.cwd), resolve(elsewhere, 'M1'));

    await manager.release('M1', project);
  });

  test('diff 与 worktreePath 也跟着项目走 —— 它们常在另一个进程里被调用', async () => {
    const project = tempRepo('coagent-proj-');
    const manager = new GitWorktreeManager();
    const prepared = await manager.prepare('M1', project);
    writeFileSync(join(prepared.cwd, 'b.txt'), '新文件\n');

    // `l3 show` 是一个从没 prepare 过的新进程：它只能靠 projectRoot 反推
    // worktree 在哪。少传这个参数，它就会去进程 cwd 下面找一个不存在的目录，
    // 然后回一句"工作区已回收" —— 一个看起来合理、实则是错的答案。
    assert.equal(manager.worktreePath('M1', project), resolve(project, '.coagent-worktrees', 'M1'));

    const diff = await manager.diff('M1', prepared.baseRevision, project);
    assert.ok(diff.files.includes('b.txt'), '未跟踪的新文件也要算进改动里');

    await manager.release('M1', project);
  });
});
