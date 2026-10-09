# L3 接入

检视者（L3）就是你开着的 agent 会话。平台对它没有任何 agent 专属的依赖；这里放的是让各个宿主更顺手的接入材料。

| 目录 | 内容 | 适合 |
|---|---|---|
| [codex/](codex/) | Codex 插件：**MCP 服务器**（34 个工具，任何支持 MCP 的 agent 都能用）、`SessionStart` 钩子、收件箱投递桥、技能 | Codex；以及任何要用这个 MCP 服务器的 agent |
| [claude-code/](claude-code/) | Claude Code 的技能和 MCP 配置示例 | Claude Code |

其他 agent（Cursor、Cline、Gemini CLI、opencode……）不需要专门的目录：把 `codex/mcp-server/dist/index.js` 当 stdio MCP 服务器配进去，或者只用命令行和 HTTP。完整说明见 [docs/l3-agents.md](../docs/l3-agents.md)，写给检视者 agent 读的手册是 [docs/l3-guide.md](../docs/l3-guide.md)。

> 目录名 `codex/` 是历史原因：MCP 服务器最早随 Codex 插件一起做出来。它本身是宿主中立的 stdio MCP，只靠环境变量配置，和 Codex 无关；只有 `hooks/` 和投递桥（`l3-bridge` / `l3-daemon` / `session-*`）是 Codex 专属的。
