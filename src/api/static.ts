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
 *
 * ## woff2 为什么进来，ttf/json/txt 为什么不进
 *
 * 固定页名的衬线子集是同源分发的本地字体（`console-title.woff2`），
 * 浏览器靠它排版；不发就等于那个 @font-face 永远失败、页面退成雅黑，
 * 而失败是静默的——屏幕上只是"看起来不太像设计稿"。
 *
 * 只开 woff2 这一个字体格式：它是本仓唯一的字体产物，多开一个 ttf 就多一条
 * 能把任意二进制吐出去的路，而 woff2 的魔数至少不是可执行/配置格式。
 * json/txt 不开放是另一个理由：`console-assets.json` 是实施参考、
 * 许可证文本是随代码留档，两者都**不该**成为可请求的运行资源——
 * 把它们当静态资源发出去，等于把"这份仓库里的文件清单"对外公开。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ServerResponse } from 'node:http';

/** 只认一段扁平文件名 + 已知扩展名。没有斜杠 = 不可能穿目录。 */
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*\.(html|css|js|svg|woff2)$/;

const CONTENT_TYPE: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  // 必须是 font/woff2：发成 application/octet-stream 时浏览器仍能靠嗅探排上字，
  // 但@font-face 在严格 MIME 检查（nosniff、部分 Safari）下会直接拒绝加载，
  // 而拒绝的样子是回退字体——看不出来是配置错了。
  woff2: 'font/woff2',
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
