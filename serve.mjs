/**
 * CoAgentHub 局域网静态服务器
 *
 * - 托管前端构建产物 packages/frontend/web/dist
 * - 将 /api/* 反向代理到后端 http://localhost:3001
 * - 监听 0.0.0.0:3000，局域网内其他设备可通过 http://<本机IP>:3000 访问
 *
 * 用法: node serve.mjs [端口] [后端地址]
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DIST_DIR = join(__dirname, "packages/frontend/web/dist");

const PORT = Number(process.argv[2] ?? 3000);
const BACKEND = process.argv[3] ?? "http://localhost:3001";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

async function serveStatic(req, res) {
  let urlPath;
  try {
    // 恶意/畸形 % 编码会让 decodeURIComponent 抛 URIError,未捕获会击穿整个
    // 局域网服务器(node ≥15 默认 unhandled-rejections=throw)→ 先兜底 400。
    urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }
  let filePath = normalize(join(DIST_DIR, urlPath));

  // 防止路径穿越:用 path.sep 做组件边界判定,避免 DIST_DIR 前缀字符串误判
  // (如 /dist-other 这类目录)。恰好等于 DIST_DIR 本身(URL 为 "/")合法。
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    let info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = join(filePath, "index.html");
      info = await stat(filePath); // 目录缺 index.html → 走 SPA fallback
    }
    // 流式返回:大文件(如打包产物 .js/.map)不整块读入内存。
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "Content-Length": info.size,
    });
    createReadStream(filePath).pipe(res);
  } catch {
    // SPA fallback: 非文件请求回退到 index.html(同样流式)。
    try {
      const index = join(DIST_DIR, "index.html");
      const info = await stat(index);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": info.size,
      });
      createReadStream(index).pipe(res);
    } catch {
      res.writeHead(500);
      res.end("前端产物缺失，请先运行 pnpm build:frontend");
    }
  }
}

function proxyApi(req, res) {
  const url = new URL(req.url, BACKEND);
  const target = new URL(BACKEND);
  const options = {
    hostname: target.hostname,
    port: target.port || 80,
    path: url.pathname + url.search,
    method: req.method,
    headers: { ...req.headers, host: target.host },
  };

  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const proxy = send(options, (pRes) => {
    res.writeHead(pRes.statusCode, pRes.headers);
    pRes.pipe(res);
  });
  proxy.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`后端不可达: ${err.message}`);
  });
  req.pipe(proxy);
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname.startsWith("/api")) {
    proxyApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

// WebSocket 转发 (ticket 13): /api/ws 的 upgrade 握手无法走普通 HTTP 请求,
// 需要把客户端 socket 双向管道到后端,并把后端的 101 状态行+响应头原样回写,
// 否则局域网经 :3000 访问时实时推送会断。
server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (!pathname.startsWith("/api")) {
    socket.destroy();
    return;
  }
  const target = new URL(BACKEND);
  const proxy = sendUpgradeRequest(req, target);
  proxy.on("upgrade", (pRes, pSocket, pHead) => {
    socket.write(`HTTP/1.1 ${pRes.statusCode} ${pRes.statusMessage}\r\n`);
    for (let i = 0; i < pRes.rawHeaders.length; i += 2) {
      socket.write(`${pRes.rawHeaders[i]}: ${pRes.rawHeaders[i + 1]}\r\n`);
    }
    socket.write("\r\n");
    pSocket.write(pHead);
    // 客户端随握手请求一起到达、被 node 缓冲在 head 里的首帧也要转给后端,
    // 否则后端永远收不到这帧(客户端会一直等)。
    if (head && head.length > 0) pSocket.write(head);
    // 任一端中断都要销毁对端,避免管道中途 ECONNRESET/EPIPE 变成未处理 error。
    socket.on("error", () => socket.destroy());
    pSocket.on("error", () => socket.destroy());
    socket.pipe(pSocket).pipe(socket);
  });
  proxy.on("error", () => socket.destroy());
  proxy.end();
});

function sendUpgradeRequest(req, target) {
  const options = {
    hostname: target.hostname,
    port: target.port || 80,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: target.host },
  };
  return (target.protocol === "https:" ? httpsRequest : httpRequest)(options);
}

server.listen(PORT, "0.0.0.0", () => {
  const nets = networkInterfaces();
  const ips = Object.values(nets)
    .flat()
    .filter((n) => n && n.family === "IPv4" && !n.internal)
    .map((n) => n.address);
  console.log(`✅ 前端已启动: http://localhost:${PORT}`);
  for (const ip of ips) {
    console.log(`✅ 局域网访问: http://${ip}:${PORT}`);
  }
  console.log(`   /api 反代到 ${BACKEND}`);
});
