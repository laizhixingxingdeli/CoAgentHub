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

  test('钉住的基线要当真 —— 不钉的话两次运行没法比', async () => {
    // 这是 rerun 的地基。不钉基线时，第二次会从「跑它的时候目标分支的 HEAD」
    // 分叉——而源头那次的产出多半已经合进去了，第二次一开始活儿就是干完的
    // 状态。两条记录都完整、都自洽，**只是不可比**，而且看不出哪里不对。
    const project = tempRepo('coagent-proj-');
    const first = git(project, 'rev-parse', 'HEAD');

    // 目标分支往前走一步：模拟"第一次的产出已经合进去了"。
    writeFileSync(join(project, 'b.txt'), '第一次跑出来的东西\n');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', '第一次的产出');
    assert.notEqual(git(project, 'rev-parse', 'HEAD'), first);

    const manager = new GitWorktreeManager();
    const pinned = await manager.prepare('M2', project, first);
    assert.equal(pinned.baseRevision, first, '给了基线就必须从那儿分叉，不是从当前 HEAD');
    assert.ok(
      !existsSync(join(pinned.cwd, 'b.txt')),
      '从旧基线分叉出来的工作区里，不该已经有第一次的产出 —— 有就等于这一跑白比了',
    );
    await manager.release('M2', project);

    // 不给基线时仍然跟当前 HEAD 走（正常的第一次运行）。
    const fresh = await manager.prepare('M3', project);
    assert.equal(fresh.baseRevision, git(project, 'rev-parse', 'HEAD'));
    await manager.release('M3', project);
  });

  test('回收工作区之前先把未提交的产出落到分支上', async () => {
    // release 的注释一直写着"改动是 Mission 的产出，要留给 L3 检视"，
    // 但**那句话当时是假的**：平台只在落地那一刻提交，执行者从不自己提交，
    // 于是 `worktree remove --force` 把未提交的产出连同目录一起抹掉，
    // 分支上是空的。实测代价：一条跑完、独立验过（14 条用例绿、命令端到端通）
    // 的 Mission 被叫停之后，产出整个消失，事后无法复核。
    const project = tempRepo('coagent-proj-');
    const manager = new GitWorktreeManager();
    const prepared = await manager.prepare('M5', project);

    // 执行者干的活：改一个已跟踪文件 + 新建一个文件。两种都要保住 ——
    // `git diff` 看不见新建文件，只提交已跟踪的同样会丢一半。
    writeFileSync(join(prepared.cwd, 'a.txt'), '执行者改过\n');
    writeFileSync(join(prepared.cwd, 'new.ts'), 'export const x = 1;\n');

    await manager.release('M5', project);

    const onBranch = git(project, 'show', '--name-only', '--format=', 'mission/M5')
      .split(/\r?\n/)
      .filter(Boolean)
      .sort();
    assert.deepEqual(onBranch, ['a.txt', 'new.ts'], '改的和新建的都要落到分支上');
    assert.equal(
      git(project, 'show', 'mission/M5:new.ts').trim(),
      'export const x = 1;',
      '内容要是真的，不是空文件',
    );
  });

  test('基线不存在时明说，不要把 git 的原文甩给人', async () => {
    const project = tempRepo('coagent-proj-');
    await assert.rejects(
      () => new GitWorktreeManager().prepare('M4', project, 'deadbeefdeadbeef'),
      (error: unknown) => /分叉基线.*不存在/.test((error as Error).message),
    );
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
