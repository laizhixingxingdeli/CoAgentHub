/**
 * p2p-serve.mjs — P2P 直连发送助手 (ticket 05 配套脚本)
 *
 * 发送方(如 Windows 上的 hermes)本机起一个 HTTP 服务共享单个文件,并向
 * CoAgentHub 群里发一条带 fileRef 的信令消息;接收方(Web/其他 agent)直连
 * fetchUrl 拉取文件字节并自行校验 sha256。**文件字节不经过 CoAgentHub 服务器,
 * 只走局域网 P2P 直连。**
 *
 * 用法:
 *   node scripts/p2p-serve.mjs --file <path> [--port 9901] [--group <groupId>] [--once]
 *
 * 环境变量:
 *   API_BASE                默认 http://localhost:3001/api
 *   COAGENTHUB_AGENT_TOKEN  必填,发送方 agent 身份(Authorization: Bearer)
 *
 * 依赖:仅 node 内置模块(http/crypto/os/fs/path/url),可复制到 Windows 端
 * 独立运行,无需安装任何东西。
 */

import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { basename, extname } from "node:path";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: 独立脚本,不参与 turbo 缓存任务(与 assistant-agent.mjs 同款)
const API_BASE = (process.env.API_BASE ?? "http://localhost:3001/api").replace(
  /\/+$/,
  "",
);
// biome-ignore lint/suspicious/noUndeclaredEnvVars: 独立脚本,不参与 turbo 缓存任务(与 assistant-agent.mjs 同款)
const TOKEN = process.env.COAGENTHUB_AGENT_TOKEN;

const USAGE = `用法: node scripts/p2p-serve.mjs --file <path> [--port 9901] [--group <groupId>] [--once]
  --file <path>   要共享的文件(必填)
  --port <port>   HTTP 服务端口(默认 9901)
  --group <id>    目标群 id(必填)
  --once          发完消息即退出(便于测试),缺省则持续服务直到 Ctrl+C`;

const MIME = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
};

/** 局域网可达 IPv4(与 serve.mjs 同一探测方式,过滤 internal)。 */
function lanIps() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === "IPv4" && !n.internal)
    .map((n) => n.address);
}

/** 流式计算文件 sha256,不把整个文件读进内存。 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function parseArgs(argv) {
  const opts = { file: undefined, port: 9901, group: undefined, once: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = () => inline ?? argv[++i];
    switch (key) {
      case "--file":
        opts.file = value();
        break;
      case "--port":
        opts.port = Number(value());
        break;
      case "--group":
        opts.group = value();
        break;
      case "--once":
        opts.once = true;
        break;
      default:
        console.error(`未知参数: ${arg}\n`);
        console.error(USAGE);
        process.exit(1);
    }
  }
  return opts;
}

function fail(message) {
  console.error(`[p2p-serve] ${message}`);
  console.error(USAGE);
  process.exit(1);
}

async function postFileMessage(groupId, body, fileRef) {
  const res = await fetch(`${API_BASE}/groups/${groupId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ body, fileRef }),
  });
  if (!res.ok) {
    const detail = await res.text();
    fail(`发送消息失败: HTTP ${res.status} ${detail}`);
  }
  return res.json();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.file) fail("缺少必填参数 --file");
  if (!opts.group) fail("缺少必填参数 --group");
  if (!TOKEN) fail("缺少环境变量 COAGENTHUB_AGENT_TOKEN(发送方 agent 身份)");
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    fail(`无效端口: ${opts.port}(应为 1-65535 的整数)`);
  }

  const filePath = opts.file;
  const fileName = basename(filePath);
  let info;
  try {
    info = statSync(filePath);
  } catch {
    fail(`无法读取文件: ${filePath}(请检查路径是否存在)`);
  }
  if (!info.isFile()) fail(`不是普通文件: ${filePath}`);

  const sha256 = await sha256File(filePath);
  const ips = lanIps();
  if (ips.length === 0) fail("未探测到局域网 IPv4 地址,无法构造 fetchUrl");
  const fetchUrl = `http://${ips[0]}:${opts.port}/${encodeURIComponent(fileName)}`;
  const expiresAt = new Date(
    Date.now() + 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  // 先起 HTTP 服务再发消息:接收方收到信令时文件已可拉取。
  const server = createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
    } catch {
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }
    // 只暴露这一个文件;路径不是 /<文件名> 一律 404,不做任何路径拼接。
    if (req.method !== "GET" || pathname !== `/${fileName}`) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[extname(fileName)] ?? "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "no-store",
    });
    const stream = createReadStream(filePath);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "0.0.0.0", resolve);
  });

  console.log(`[p2p-serve] 文件已就绪: ${fileName} (${info.size} bytes)`);
  console.log(`[p2p-serve] sha256: ${sha256}`);
  for (const ip of ips) {
    console.log(
      `[p2p-serve] 局域网下载: http://${ip}:${opts.port}/${encodeURIComponent(fileName)}`,
    );
  }

  const body = `📄 文件就绪: ${fileName} (${info.size} bytes)`;
  const fileRef = {
    name: fileName,
    size: info.size,
    sha256,
    fetchUrl,
    expiresAt,
  };
  const message = await postFileMessage(opts.group, body, fileRef);
  console.log(`[p2p-serve] 消息已发送: id=${message.id}`);
  console.log(`[p2p-serve] 下载地址: ${fetchUrl}`);

  if (opts.once) {
    server.close();
    process.exit(0);
  }
  console.log(`[p2p-serve] 持续服务中,按 Ctrl+C 退出 …`);
}

main().catch((err) => {
  console.error(`[p2p-serve] 失败:`, err);
  process.exit(1);
});
