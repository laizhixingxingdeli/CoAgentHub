# Codex 插件与 L3 MCP 服务器

这个目录是完整的 Codex 插件，同时里面的 `mcp-server/` 是宿主中立的 L3 MCP 服务器（任何支持 MCP 的 agent 都能用）。

```
.codex-plugin/plugin.json   Codex 插件清单
.mcp.json                   插件的 MCP 配置（路径用 ${PLUGIN_ROOT}）
hooks/hooks.json            SessionStart 钩子：把当前 Codex 根会话绑定到本地投递桥
skills/coagenthub/SKILL.md  Codex 里的检视者技能
mcp-server/                 stdio MCP 服务器（TypeScript，34 个工具）；Codex 专属的只有 l3-bridge / l3-daemon / session-*
```

## 构建

```bash
node scripts/coagent.mjs setup      # 在 CoAgentHub 根目录；等价于 npm ci && npm run build -w integrations/codex/mcp-server
```

构建产物是 `mcp-server/dist/index.js`。开发这个服务器：`npm test -w integrations/codex/mcp-server`（vitest，测试文件是 `*.spec.ts`）。

## 在 Codex 里用

把本目录作为本地插件加进 Codex；首次会话 Codex 会请你**信任**钩子——它只写插件本地的绑定状态并拉起本地投递桥。投递桥每秒轮询平台的 `/api/inbox`，把新投递用 `codex queue` 排进绑定的会话，排队成功才 ACK。缺省只消费投递给**当前会话**的通知，`COAGENTHUB_INBOX_SCOPE=all` 让一个会话当所有 Mission 的中央检视者。

`.mcp.json` 里的 `${PLUGIN_ROOT}` 如果你的 Codex 版本在 MCP 配置里不展开，改成 `mcp-server/dist/index.js` 的绝对路径。

环境变量、不装插件只配 MCP 的写法、换检视者会话的注意事项，见 [docs/l3-agents.md](../../docs/l3-agents.md#codex)。检视者的操作手册见 [docs/l3-guide.md](../../docs/l3-guide.md)。
