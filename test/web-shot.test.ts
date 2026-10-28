/**
 * 只测小服务这一层：静态放行表、/api 只转发 GET。
 *
 * 不碰浏览器、不碰 3101——真浏览器那一半靠人工 `node scripts/web-shot.mjs`
 * 跑，写进自动化只会让这条用例在没装 Chrome 的机器上红。
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';

import { createShotServer } from '../scripts/web-shot.mjs';

const listen = (server) =>
  new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));

const close = (server) => new Promise((done) => server.close(() => done()));

test('小服务放行静态白名单、/api 只转发 GET', async () => {
  let upstreamHits = 0;
  const upstream = createServer((req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`upstream:${req.url}`);
  });
  const upstreamPort = await listen(upstream);
  const shot = createShotServer({
    root: join(process.cwd(), 'src', 'web'),
    apiBase: `http://127.0.0.1:${upstreamPort}`,
  });
  const shotPort = await listen(shot);
  const base = `http://127.0.0.1:${shotPort}`;

  try {
    const index = await fetch(`${base}/index.html`);
    assert.equal(index.status, 200);
    await index.body?.cancel();

    // console-assets.json 不在放行表里：它是实施参考，不该能被请求到。
    const assets = await fetch(`${base}/console-assets.json`);
    assert.equal(assets.status, 404);
    await assets.body?.cancel();

    const get = await fetch(`${base}/api/x?q=1`);
    assert.equal(get.status, 200);
    assert.equal(await get.text(), 'upstream:/api/x?q=1');

    const before = upstreamHits;
    const post = await fetch(`${base}/api/x`, { method: 'POST' });
    assert.equal(post.status, 405);
    await post.body?.cancel();
    assert.equal(upstreamHits, before, 'POST 不该被转发到上游');
  } finally {
    await close(shot);
    await close(upstream);
  }
});
