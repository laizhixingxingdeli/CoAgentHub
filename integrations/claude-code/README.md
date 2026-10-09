# Claude Code 当检视者

三样东西，缺一不可，但都很薄：

1. **MCP 服务器**：先 `node scripts/coagent.mjs setup` 构建出 `integrations/codex/mcp-server/dist/index.js`，再用 `claude mcp add` 或把 [.mcp.json.example](.mcp.json.example) 放进项目根的 `.mcp.json`（改好绝对路径和署名）。
2. **技能**：把 [skills/coagent-l3](skills/coagent-l3/) 整个目录复制到 `~/.claude/skills/`（所有项目可用）或项目的 `.claude/skills/`。它只告诉 Claude 该读哪份手册，规则本身在 [docs/l3-guide.md](../../docs/l3-guide.md)。
3. **唤醒**：Claude Code 不会被外部推送唤醒。开跑之后让它用 Bash 工具的**后台模式**跑 `node scripts/coagent.mjs watch <missionId>`，命令一退出会话就被唤醒。

完整步骤和注意事项（大返回体、署名、换 agent）见 [docs/l3-agents.md](../../docs/l3-agents.md#claude-code)。
