# Claude Code 当检视者

三样东西缺一不可，外加一组可选工具，都很薄：

1. **MCP 服务器**：先 `node scripts/coagent.mjs setup` 构建出 `l3-mcp-server/dist/index.js`，再用 `claude mcp add` 或把 [.mcp.json.example](.mcp.json.example) 放进项目根的 `.mcp.json`（改好绝对路径和署名）。
2. **技能**：技能的唯一来源是仓库根的 [skills/](../../skills/)，把 [coagent-l3](../../skills/coagent-l3/) 与 [coagent-l2](../../skills/coagent-l2/) 两个目录复制到 `~/.claude/skills/`（所有项目可用）或项目的 `.claude/skills/`。它们只告诉 Claude 该读哪份手册，规则本身在 [docs/l3-guide.md](../../docs/l3-guide.md) 与 [docs/direct-controller.md](../../docs/direct-controller.md)。
3. **唤醒**：Claude Code 不会被外部推送唤醒。开跑之后让它用 Bash 工具的**后台模式**跑 `node scripts/coagent.mjs watch <missionId>`，命令一退出会话就被唤醒。
4. **工具（可选但推荐）**：[tools/](tools/) 的命令行小工具，在仓库根跑——`mcp.mjs`（驱动全部 coagent 工具，大返回体 `--out` 落盘再取字段）、`review-brief.mjs <missionId>`（一条命令出终审简报：逐条验收、附件、各 Attempt 实际模型）、`vr-summary.mjs`（验证报告摘要）、`models-of.mjs`（每跳实际模型）、`hop-reads.mjs`（协调者每跳读代码画像）。任何有 node 的会话都能用，不限 Claude。

完整步骤和注意事项（大返回体、署名、换 agent）见 [docs/l3-agents.md](../../docs/l3-agents.md#claude-code)。
