# L3 接入

检视者（L3）就是你开着的 agent 会话。平台对它没有任何 agent 专属的依赖；这里放的是**各宿主专属**的接入材料。宿主中立的部分在仓库根：

- [l3-mcp-server/](../l3-mcp-server/)：L3 MCP 服务器（36 个 `coagenthub_*` 工具，任何支持 MCP 的 agent 都能用）；
- [skills/](../skills/)：L3 技能的唯一来源（`coagent-l3` 检视者、`coagent-l2` direct 主控），各 agent 复制安装。

| 目录 | 内容 | 适合 |
|---|---|---|
| [codex/](codex/) | Codex 专属插件：`SessionStart` 钩子、收件箱投递桥、插件清单 | Codex |
| [claude-code/](claude-code/) | MCP 配置示例 | Claude Code |

其他 agent（Cursor、Cline、Gemini CLI、opencode……）不需要专门的目录：把仓库根 `l3-mcp-server/dist/index.js` 当 stdio MCP 服务器配进去，从 `skills/` 复制两个技能，或者只用命令行和 HTTP。完整说明见 [docs/l3-agents.md](../docs/l3-agents.md)，写给检视者 agent 读的手册是 [docs/l3-guide.md](../docs/l3-guide.md)。
