# Codex 插件

这个目录是 **Codex 专属**的插件（钩子与插件包装）。宿主中立的 L3 MCP 服务器在仓库根 [l3-mcp-server/](../../l3-mcp-server/)，任何支持 MCP 的 agent 都能用。

```
.codex-plugin/plugin.json   Codex 插件清单
.mcp.json                   插件的 MCP 配置（服务器指向仓库根 l3-mcp-server/dist，用绝对路径）
hooks/hooks.json            SessionStart 钩子：把当前 Codex 根会话绑定到本地投递桥
```

技能不在本目录维护：**唯一来源是仓库根的 [skills/](../../skills/)**（`coagent-l3` 检视者 + `coagent-l2` direct 主控）。打包或本地安装插件前，把 `skills/` 下的两个目录复制到本目录的 `skills/`（`plugin.json` 已声明 `"skills": "./skills/"`）。

## 构建

```bash
node scripts/coagent.mjs setup      # 在 CoAgentHub 根目录；等价于 npm ci && npm run build -w l3-mcp-server
```

构建产物是仓库根的 `l3-mcp-server/dist/index.js`。开发这个服务器：`npm test -w l3-mcp-server`（vitest，测试文件是 `*.spec.ts`）；它已经不在本插件目录里。

## 投递桥看护与状态

MCP 服务器进程在跑时会看护投递桥守护进程：已有登记的会话且守护进程不在时把它拉起来（约每 60 秒检查一次）。`COAGENTHUB_L3_BRIDGE=0` 时不拉起。只读状态不会顺便拉起守护进程。

数据目录由 `deliveryBridge.dataDir` 给出，解析顺序是：`PLUGIN_DATA`，否则 `COAGENTHUB_PLUGIN_DATA`，否则读指针文件 `<CODEX_HOME>/coagenthub-v5/plugin-data-dir.json`（`CODEX_HOME` 缺省是 `~/.codex`），再否则 `~/.codex/coagenthub-v5`。指针文件只存目录字符串。同目录里有 `l3-bridge.pid`、`l3-bridge-health.json`、`l3-bindings/`。不要把绑定里的 cwd 写进说明或日志。

`coagenthub_get_platform_status` 在平台状态成功时附带 `deliveryBridge`：`dataDir`、`daemonAlive`、`pid`、`lastPollSucceededAt`、`consecutiveFailures`、`lastDeliveryAt`、`recipients`（最多 20 个收件人 id，没有 cwd）。平台状态请求失败时整条结果是错误，不附带 `deliveryBridge`。桥正常是指 `daemonAlive` 为真、`lastPollSucceededAt` 能解析且距今不到 60 秒、`recipients` 含本会话号。

## 在 Codex 里用

把本目录作为本地插件加进 Codex；首次会话 Codex 会请你**信任**钩子——它只写插件本地的绑定状态并拉起本地投递桥。投递桥每秒轮询平台的 `/api/inbox`，把新投递用 `codex queue` 排进绑定的会话，排队成功才 ACK。缺省只消费投递给**当前会话**的通知，`COAGENTHUB_INBOX_SCOPE=all` 让一个会话当所有 Mission 的中央检视者。

`.mcp.json` 把 MCP 服务器指向仓库根的 `l3-mcp-server/dist/index.js`（插件包不再自带服务器）：安装时把占位绝对路径改成你机器上的真实路径。

环境变量、不装插件只配 MCP 的写法、换检视者会话的注意事项，见 [docs/l3-agents.md](../../docs/l3-agents.md#codex)。检视者的操作手册见 [docs/l3-guide.md](../../docs/l3-guide.md)。
