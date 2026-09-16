/**
 * 静态资源服务。
 *
 * Web 端是**无构建**的：浏览器原生 ES module 直接加载 `src/web/` 下的文件，
 * 没有打包、没有 install（见 ADR-0001）。所以这里要做的只有一件事——
 * 把那个目录下的文件按原样吐出去。
 *
 * ## 路径安全
 *
 * 请求里的名字是**外部输入**，而这里要拿它去拼文件路径。
 * 判据写成"只认一段扁平文件名"而不是"先拼再看它跑没跑出去"：
 *
 *   - 白名单正则里**没有斜杠**，所以 `../` 这类东西连正则都过不了；
 *   - 扩展名也在正则里，所以不存在"把 .env 当静态资源发出去"。
 *
 * 先拼后检（resolve 之后判断前缀）也能work，但那类判断在符号链接、
 * 大小写不敏感文件系统、UNC 路径上各有坑。**不给它机会**比检得仔细更可靠。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ServerResponse } from 'node:http';

/** 只认一段扁平文件名 + 已知扩展名。没有斜杠 = 不可能穿目录。 */
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*\.(html|css|js|svg)$/;

const CONTENT_TYPE: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
};

/** Web 资源根目录。相对本文件定位，不依赖进程 cwd。 */
export function webRoot(): string {
  return resolve(new URL('../web/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
}

/**
 * 试着把一个请求路径当静态资源处理。
 *
 * 命中返回 true（已经写完响应），没命中返回 false 交给后面的路由。
 */
export function serveStatic(path: string, res: ServerResponse, root = webRoot()): boolean {
  const name = path === '/' ? 'index.html' : path.slice(1);
  if (!SAFE_NAME.test(name)) return false;

  const file = join(root, name);
  if (!existsSync(file)) return false;

  const ext = name.slice(name.lastIndexOf('.') + 1);
  res.writeHead(200, {
    'content-type': CONTENT_TYPE[ext] ?? 'application/octet-stream',
    // 不缓存：无构建意味着改完刷新就该看到，缓存住等于每次都要硬刷新。
    'cache-control': 'no-store',
  });
  res.end(readFileSync(file));
  return true;
}
