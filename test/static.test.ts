/**
 * 静态资源服务的路径边界。
 *
 * 这里是**外部输入拼文件路径**的唯一一处，所以判据要写死在测试里：
 * 只认一段扁平文件名 + 已知扩展名。名字里有斜杠就不可能穿目录——
 * 这比"先拼路径再判断它跑没跑出根目录"可靠，后者在符号链接、
 * 大小写不敏感文件系统、UNC 路径上各有坑。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorktreeManager } from '../src/application/workspace.ts';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { serveStatic, webRoot } from '../src/api/static.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';

/** 只记录调用，不真写响应——这一组验的是"认不认"，不是"发得对不对"。 */
function recorder() {
  const calls: { status?: number; headers?: Record<string, string>; body?: unknown } = {};
  return {
    res: {
      writeHead(status: number, headers: Record<string, string>) {
        calls.status = status;
        calls.headers = headers;
      },
      end(body: unknown) {
        calls.body = body;
      },
    },
    calls,
  };
}

const servers: Server[] = [];
const made: string[] = [];
const dirs: string[] = [];
after(() => {
  for (const s of servers) s.close();
  for (const f of made) rmSync(f, { force: true });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** 在真实的 web 根目录里放一个文件，用完删掉。 */
function putAsset(name: string, content: string): void {
  mkdirSync(webRoot(), { recursive: true });
  const path = join(webRoot(), name);
  writeFileSync(path, content, 'utf8');
  made.push(path);
}

describe('静态资源：路径边界', () => {
  test('穿目录的各种写法一律不认', () => {
    for (const path of [
      '/../package.json',
      '/../../etc/passwd',
      '/..%2fpackage.json',
      '/a/b.js',
      '/./x.js',
      '/sub/../index.html',
      '//evil.com/x.js',
    ]) {
      const { res } = recorder();
      assert.equal(serveStatic(path, res as never), false, `${path} 不该被当成静态资源`);
    }
  });

  test('只发已知扩展名 —— 源码和配置不许被当资源发出去', () => {
    putAsset('leak.html', '<p>ok</p>');
    for (const path of ['/leak.ts', '/leak.json', '/leak.env', '/leak']) {
      const { res } = recorder();
      assert.equal(serveStatic(path, res as never), false, `${path} 扩展名不在白名单里`);
    }
    const { res, calls } = recorder();
    assert.equal(serveStatic('/leak.html', res as never), true);
    assert.equal(calls.status, 200);
  });

  test('文件不存在就交给后面的路由，不是 404', () => {
    // 返回 false 而不是自己写 404：`/api/...` 这类路径也会先经过这里，
    // 这里抢着回 404 就把整套 API 盖掉了。
    const { res } = recorder();
    assert.equal(serveStatic('/没有这个.html', res as never), false);
  });

  test('按扩展名给 content-type，且不缓存', () => {
    putAsset('probe.css', 'body{}');
    const { res, calls } = recorder();
    serveStatic('/probe.css', res as never);
    assert.match(calls.headers?.['content-type'] ?? '', /text\/css/);
    // 无构建意味着改完刷新就该看到；缓存住等于每次都要硬刷新。
    assert.equal(calls.headers?.['cache-control'], 'no-store');
  });
});

describe('静态资源：接进 HTTP 面之后', () => {
  test('有 index.html 就发它；没有则回退到内置观测面', async () => {
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const deliveries = new InMemoryDeliveryRepository(clock, ids);
    const platform = new Platform({
      projects: new InMemoryProjectRepository(),
      deliveries,
      workspace: new InPlaceWorkspaceManager(),
      activity: new InMemoryActivityLog(clock),
      clock,
      ids,
    });
    const server = createApi({ platform, tokens: new RunTokenRegistry(), deliveries });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    putAsset('index.html', '<!doctype html><title>正式 Web 端</title>');
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /正式 Web 端/);

    // API 不能被静态服务抢走。
    const api = await fetch(`${base}/api/version`);
    assert.equal(api.status, 200);
    assert.equal(((await api.json()) as { api: string }).api, 'v1');
  });
});

describe('worktree 里要能跑得起来', () => {
  test('新 worktree 带上 node_modules —— 否则执行者连验证命令都跑不了', async () => {
    // 实测踩到的：git worktree 只带受版本控制的文件，node_modules 被
    // .gitignore 挡在外面。执行者一跑 `node --test` 就是
    // `Cannot find package 'pg'`，而它完全不知道为什么——
    // 工单里写好的验证命令根本起不来。
    const root = mkdtempSync(join(tmpdir(), 'coagent-wt-nm-'));
    dirs.push(root);
    const repo = mkdtempSync(join(tmpdir(), 'coagent-repo-nm-'));
    dirs.push(repo);

    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 't@local');
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    // 假装装过依赖。
    mkdirSync(join(repo, 'node_modules', 'fake-dep'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'fake-dep', 'index.js'), 'export default 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    const workspace = new GitWorktreeManager(root);
    const prepared = await workspace.prepare('M-nm', repo);
    assert.ok(
      existsSync(join(prepared.cwd, 'node_modules', 'fake-dep', 'index.js')),
      'worktree 里必须够得到依赖',
    );
    await workspace.release('M-nm', repo);
  });

  test('项目根本没有 node_modules 时不报错 —— 纯脚本仓库不需要它', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coagent-wt-nonm-'));
    dirs.push(root);
    const repo = mkdtempSync(join(tmpdir(), 'coagent-repo-nonm-'));
    dirs.push(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 't@local');
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    const workspace = new GitWorktreeManager(root);
    const prepared = await workspace.prepare('M-nonm', repo);
    assert.ok(existsSync(prepared.cwd));
    assert.equal(existsSync(join(prepared.cwd, 'node_modules')), false);
    await workspace.release('M-nonm', repo);
  });
});
