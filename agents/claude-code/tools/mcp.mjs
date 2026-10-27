// 从任何有 node 的会话（Claude Code 的 Bash、其他 agent、纯终端）经 stdio 驱动 L3 MCP 服务器。
// 不直连 HTTP / CLI / 状态文件。返回体可能很大（get_mission 约 100 KB）：永远 --out 落盘再用 node 取字段，别直接打印。
// 用法：node mcp.mjs <tool> ['<json args>'] [--out <file>]     node mcp.mjs --list
// 环境变量：COAGENTHUB_MCP_SERVER（服务器入口，缺省 <仓库根>/l3-mcp-server/dist/index.js，先 scripts/coagent.mjs setup 构建）、
//           COAGENTHUB_REVIEWER_ID（检视者署名，换模型要跟着换）、
//           COAGENTHUB_L3_BRIDGE（投递桥看护开关，缺省由 serverEnv 设为 "0"）。
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER =
  process.env.COAGENTHUB_MCP_SERVER ??
  fileURLToPath(new URL("../../../l3-mcp-server/dist/index.js", import.meta.url));

// 拼给 MCP 子进程的环境。纯函数：只读入参，不读 process.env，好让调用方（和验证命令）能直接喂一份假环境来断言。
// 缺省把投递桥看护关掉：Claude 宿主不用 Codex 投递桥；而本工具每调一次工具都起一个 MCP 服务进程，
// 从 Claude 会话 shell 拉起的守护进程会随会话结束，看护若默认开着就会被反复拉起、反复扑空。
// 所以调用方没设就传 "0"；用 ?? 而不是 ||，显式传入的 "1" / "0" 才原样保留。
export function serverEnv(env) {
  // 本机回环必须绕开代理：带着代理去连 127.0.0.1 会把「平台没起」伪装成各种网络错误。
  const loopback = "127.0.0.1,localhost,::1";
  return {
    ...env,
    COAGENTHUB_API_BASE: env.COAGENTHUB_API_BASE ?? "http://127.0.0.1:3101/api",
    COAGENTHUB_REVIEWER_ID: env.COAGENTHUB_REVIEWER_ID ?? "检视者（Claude Code）",
    COAGENTHUB_L3_BRIDGE: env.COAGENTHUB_L3_BRIDGE ?? "0",
    NO_PROXY: env.NO_PROXY ? `${env.NO_PROXY},${loopback}` : loopback,
    no_proxy: env.no_proxy ? `${env.no_proxy},${loopback}` : loopback,
  };
}

export async function withServer(fn) {
  if (!existsSync(SERVER)) {
    throw new Error(`MCP 服务器不存在：${SERVER}。先在仓库根跑 node scripts/coagent.mjs setup，或用 COAGENTHUB_MCP_SERVER 指到已构建的 index.js。`);
  }
  const env = serverEnv(process.env);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "coagenthub-l3-cli", version: "0.1.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

export async function callTool(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  let value = res.structuredContent;
  if (value === undefined) {
    const text = res.content?.find((c) => c.type === "text")?.text;
    try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  }
  return { isError: res.isError === true, value };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const out = outIdx >= 0 ? argv.splice(outIdx, 2)[1] : undefined;
  await withServer(async (client) => {
    if (argv[0] === "--list") {
      const { tools } = await client.listTools();
      console.log(tools.map((t) => t.name).join("\n"));
      return;
    }
    const [name, raw] = argv;
    if (!name) {
      console.log("用法：node mcp.mjs <tool> ['<json args>'] [--out <file>]；--list 列全部工具");
      return;
    }
    const result = await callTool(client, name, raw ? JSON.parse(raw) : {});
    const json = JSON.stringify(result, null, 2);
    if (out) {
      writeFileSync(out, json, "utf8");
      console.log(`isError=${result.isError} bytes=${json.length} -> ${out}`);
    } else {
      console.log(json);
    }
  });
}
