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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorktreeManager } from '../src/application/workspace.ts';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { serveStatic } from '../src/api/static.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

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
const dirs: string[] = [];
after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * 资源放**临时目录**，不碰真实的 src/web/。
 *
 * 往真实目录里写会被别的测试文件看见——node --test 是多进程并行的，
 * 而 web.test.ts 断言根路径返回内置观测面。实测就是这么红的。
 */
const assets = mkdtempSync(join(tmpdir(), 'coagent-web-'));
dirs.push(assets);

function putAsset(name: string, content: string): void {
  writeFileSync(join(assets, name), content, 'utf8');
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
      assert.equal(serveStatic(path, res as never, assets), false, `${path} 不该被当成静态资源`);
    }
  });

  test('只发已知扩展名 —— 源码和配置不许被当资源发出去', () => {
    putAsset('leak.html', '<p>ok</p>');
    for (const path of ['/leak.ts', '/leak.json', '/leak.env', '/leak']) {
      const { res } = recorder();
      assert.equal(serveStatic(path, res as never), false, `${path} 扩展名不在白名单里`);
    }
    const { res, calls } = recorder();
    assert.equal(serveStatic('/leak.html', res as never, assets), true);
    assert.equal(calls.status, 200);
  });

  test('文件不存在就交给后面的路由，不是 404', () => {
    // 返回 false 而不是自己写 404：`/api/...` 这类路径也会先经过这里，
    // 这里抢着回 404 就把整套 API 盖掉了。
    const { res } = recorder();
    assert.equal(serveStatic('/没有这个.html', res as never, assets), false);
  });

  test('按扩展名给 content-type，且不缓存', () => {
    putAsset('probe.css', 'body{}');
    const { res, calls } = recorder();
    serveStatic('/probe.css', res as never, assets);
    assert.match(calls.headers?.['content-type'] ?? '', /text\/css/);
    // 无构建意味着改完刷新就该看到；缓存住等于每次都要硬刷新。
    assert.equal(calls.headers?.['cache-control'], 'no-store');
  });

  test('同源字体：扁平 woff2 认得且 MIME 是 font/woff2', () => {
    // 固定页名的衬线子集靠它排版。发不出去时页面**静默**退回微软雅黑——
    // 屏幕上只是"看起来不太像设计稿"，没人会盯着报错日志查这件事。
    //
    // MIME 单独断言：发成 application/octet-stream 浏览器仍可能靠嗅探排上字，
    // 但在 nosniff / 严格检查下会直接拒绝加载，症状同样是静默回退字体。
    const font = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00]);
    writeFileSync(join(assets, 'probe.woff2'), font);

    const { res, calls } = recorder();
    assert.equal(serveStatic('/probe.woff2', res as never, assets), true, 'woff2 该被认下');
    assert.equal(calls.status, 200);
    assert.equal(calls.headers?.['content-type'], 'font/woff2');
    assert.deepEqual(calls.body, font, '字体必须原样字节吐出去，不能被当文本转码');

    // 再打一次真实交付的字体：上面的断言只证明「扩展名认得」，
    // 这条证明「交付的那个文件确实叫这个名、确实在 src/web/ 里」。
    // 两条一起才把"静态服务能发"和"文件真的存在"接上。
    const real = recorder();
    assert.equal(serveStatic('/console-title.woff2', real.res as never), true, '交付的字体取不到');
    assert.equal(real.calls.headers?.['content-type'], 'font/woff2');
    assert.ok((real.calls.body as Buffer).length > 1000, '发出去的不是字体本体');
  });

  test('字体格式不得连带放开：ttf、json、txt 仍然拒绝', () => {
    // 只开 woff2 一个字体格式。多开一个 ttf 就多一条能把任意二进制吐出去的路；
    // json/txt 是实施参考与许可证留档（console-assets.json / console-font-OFL.txt），
    // 它们随代码保留，但**不是**可请求的运行资源。
    putAsset('leak.ttf', 'x');
    putAsset('leak.json', '{}');
    putAsset('leak.txt', 'x');
    for (const path of ['/leak.ttf', '/leak.json', '/leak.txt']) {
      const { res } = recorder();
      assert.equal(serveStatic(path, res as never, assets), false, `${path} 不该被当静态资源`);
    }
  });

  test('woff2 也不能穿目录', () => {
    // 白名单正则里没有斜杠，所以带斜杠的字体路径连正则都过不了。
    // 这条单独写：新增扩展名时最容易顺手把正则改成"先拼接再判断"。
    for (const path of ['/../console-title.woff2', '/a/b.woff2', '/..%2fconsole-title.woff2', '/./x.woff2']) {
      const { res } = recorder();
      assert.equal(serveStatic(path, res as never, assets), false, `${path} 不该被认下`);
    }
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
    const server = createApi({
      platform,
      tokens: new RunTokenRegistry(),
      deliveries,
      webRoot: assets,
    });
    await listenLoopback(server, 0);
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

describe('worktree 里的依赖怎么来的', () => {
  test('worktree 落在项目内部，Node 沿父目录就找得到依赖 —— 不需要任何链接', async () => {
    // 这一条的由来是一次**我自己造成的破坏**：先前给 worktree 建了
    // node_modules 的 junction，结果 `git worktree remove --force`
    // 顺着链接把项目根真实的依赖树删了。
    //
    // 修法不是"删之前先摘链接"，是根本不建——worktree 默认就在项目内部，
    // Node 的模块解析本来就会向上找到项目根的 node_modules。
    const repo = mkdtempSync(join(tmpdir(), 'coagent-repo-nm-'));
    dirs.push(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 't@local');
    const lines = (...items: string[]) => `${items.join('\n')}\n`;
    writeFileSync(join(repo, '.gitignore'), lines('node_modules/', '.coagent-worktrees/'));
    writeFileSync(join(repo, 'a.txt'), lines('x'));
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    mkdirSync(join(repo, 'node_modules', 'fake-dep'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'fake-dep', 'index.js'), lines('export default 1;'));

    // worktree 根放在项目内部——这是默认行为。
    const workspace = new GitWorktreeManager(join(repo, '.coagent-worktrees'));
    const prepared = await workspace.prepare('M-nm', repo);

    // worktree 里**没有** node_modules 目录，但从它往上走能找到。
    assert.equal(existsSync(join(prepared.cwd, 'node_modules')), false, '不该建任何链接');
    assert.ok(existsSync(join(repo, 'node_modules', 'fake-dep')), '项目根的依赖要原封不动');

    // 回收之后，项目根的依赖必须还在。**这是那次破坏的直接判据。**
    await workspace.release('M-nm', repo);
    assert.ok(
      existsSync(join(repo, 'node_modules', 'fake-dep', 'index.js')),
      '回收 worktree 不许碰到项目根的依赖',
    );
  });
});
