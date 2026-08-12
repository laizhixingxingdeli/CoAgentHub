#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
/**
 * 零依赖静态文件服务器(替代原 http.server 用法)。
 * 参考仓库根 serve.mjs 的 serveStatic 实现:MIME 表 + 防路径穿越 + SPA 回退。
 *
 * 用法: node serve-static.mjs [端口] [目录]
 *   node serve-static.mjs 9198 /tmp
 */
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const PORT = Number(process.argv[2] ?? 9198);
const ROOT = normalize(process.argv[3] ?? process.cwd());

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function send(res, status, body, type) {
  res.writeHead(
    status,
    type ? { "Content-Type": type, "Cache-Control": "no-cache" } : undefined,
  );
  res.end(body);
}

async function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
  } catch {
    send(res, 400, "Bad Request");
    return;
  }
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  // 防止路径穿越
  const filePath = normalize(join(ROOT, pathname));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
    send(res, 403, "Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      const index = join(filePath, "index.html");
      const idx = await stat(index).catch(() => null);
      if (!idx || !idx.isFile()) {
        send(res, 404, "Not Found");
        return;
      }
      const data = await readFile(index);
      send(res, 200, data, MIME[extname(index)] ?? "application/octet-stream");
      return;
    }
    const data = await readFile(filePath);
    send(res, 200, data, MIME[extname(filePath)] ?? "application/octet-stream");
  } catch {
    // SPA 回退:非文件路径回退到根 index.html(与根 serve.mjs 一致)
    try {
      const index = await readFile(join(ROOT, "index.html"));
      send(res, 200, index, "text/html; charset=utf-8");
    } catch {
      send(res, 404, "Not Found");
    }
  }
}

createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method Not Allowed");
    return;
  }
  serveStatic(req, res);
}).listen(PORT, "0.0.0.0", () => {
  console.log(`静态服务器: http://0.0.0.0:${PORT} → ${ROOT}`);
});
