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

import { compareBoard, createShotServer } from '../scripts/web-shot.mjs';

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

/**
 * 比对是纯函数，这段 XML 内联在用例里：读真 layout.xml 会让这条用例依赖设计稿
 * 是否还在、是否被重导过，设计一改就得跟着改用例，红的原因也就说不清了。
 *
 * 画板根写 x=1520（它在 Figma 画布上的位置），父层带偏移 10/20——
 * 期望 13,24 就是为了钉住「画板根的 x/y 不计入」。
 */
const BOARD_XML = `<board node="2:140" names="detail">
<frame id="2:140" name="root" x="1520" y="0" width="1440" height="1240">
  <frame id="9:1" name="parent" x="10" y="20" width="100" height="40">
    <text id="9:2" name="child &amp; co" x="3" y="4" width="8" height="9" />
  </frame>
</frame>
</board>`;

test('比对纯函数：画板内坐标沿父层累加，画板根画布坐标不计', () => {
  const result = compareBoard({
    xml: BOARD_XML,
    // 用连字符写法：设计稿里 2:140 与 2-140 指的是同一个节点。
    boardNode: '2-140',
    tol: 2,
    pairs: [
      { figma: '9:2', selector: '.ok' },
      { figma: '9:2', selector: '.bad' },
      { figma: '9:9', selector: '.no' },
    ],
    measured: {
      '.ok': { x: 13, y: 24, w: 8, h: 9 },
      '.bad': { x: 20, y: 24, w: 8, h: 9 },
      '.no': null,
    },
  });

  const [ok, bad, gone] = result.rows;
  // 10+3、20+4：父层累加。加进画板根的 1520 就成了 1523，那是错的。
  assert.deepEqual(ok.design, { x: 13, y: 24, w: 8, h: 9 });
  assert.equal(ok.name, 'child & co');
  assert.equal(ok.status, 'ok');
  assert.equal(bad.status, 'over');
  assert.equal(gone.status, 'missing');
  assert.equal(result.over, 1);
  assert.equal(result.missing, 1);
  assert.equal(result.lines.at(-1), '超差 1 项，缺失 1 项');
  assert.ok(result.lines[0].includes('13,24,8×9'), result.lines[0]);
  assert.ok(result.lines[0].includes('✓'), result.lines[0]);
});
