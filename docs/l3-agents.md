# 检视者（L3）接入不同的 agent

检视者就是**你开着的那个 agent 会话**。平台对它没有任何 agent 专属的依赖，只提供三层接口，哪个 agent 都能用：

| 接口 | 能做什么 | 适合 |
|---|---|---|
| **HTTP**（`http://127.0.0.1:3101/api`） | 全部：读状态、创建与控制 Mission、答复升级、终审、配置候选池 | 任何能发请求的东西 |
| **命令行**（`scripts/coagent.mjs`、`src/l3.ts`） | 开跑、值守、终审合入、暂停恢复、答复升级…… | 只有 shell 的 agent |
| **MCP 服务器**（stdio，34 个工具） | 同上，包装成工具，参数有 schema 校验 | 支持 MCP 的 agent |

不同 agent 之间只差两点：**怎么调用平台**（MCP 工具，还是命令行 / HTTP），以及**怎么被唤醒**（平台推给它，还是它自己去拉）。

| 宿主 | 调用方式 | 唤醒方式 | 装什么 |
|---|---|---|---|
| **Claude Code** | MCP + 技能 | 拉：后台跑 `watch`，命令一退出就唤醒会话 | [integrations/claude-code](../integrations/claude-code/) |
| **Codex** | 插件（MCP + 会话绑定钩子） | 推：投递桥把新通知排进绑定的会话 | [integrations/codex](../integrations/codex/) |
| **其他支持 MCP 的 agent**（Cursor、Cline、Gemini CLI、opencode……） | stdio MCP | 拉：`watch` 或周期读状态 | 同一个 MCP 服务器 |
| **只有 shell 的 agent** | 命令行 + HTTP | 拉：`watch` | 什么都不用装 |

不管哪种，**让它先读 [l3-guide.md](l3-guide.md)**——那是写给检视者 agent 的操作手册，装进它的指令或技能里。

## 共同的前置

```bash
node scripts/coagent.mjs setup     # 构建 MCP 服务器：integrations/codex/mcp-server/dist/index.js
node scripts/coagent.mjs start     # 平台必须已经在跑，MCP 服务器和命令行都是它的客户端
```

MCP 服务器读这些环境变量（在 MCP 配置的 `env` 里设）：

| 变量 | 含义 |
|---|---|
| `COAGENTHUB_API_BASE` | 平台地址，缺省 `http://127.0.0.1:3101/api` |
| `COAGENTHUB_REVIEWER_ID` | **检视者署名**，写进每条审计记录。设成你的 agent 的名字，**换 agent / 换模型时跟着换** |
| `COAGENTHUB_REVIEW_CONFIRMED_BY` | 终审时的“确认人”（谁授权这个 agent 签集成分支合入），终审必填，没有就拒绝，**绝不替你编造** |
| `COAGENTHUB_CONTROL_CREDENTIAL` / `COAGENTHUB_CONTROL_HEADER` | 平台装了控制面鉴权时才需要，见 [security.md](security.md) |

## Claude Code

1. **挂 MCP 服务器**（二选一）：

   ```bash
   claude mcp add coagenthub \
     -e COAGENTHUB_API_BASE=http://127.0.0.1:3101/api \
     -e COAGENTHUB_REVIEWER_ID="claude-code-l3" \
     -e COAGENTHUB_REVIEW_CONFIRMED_BY="<你的名字>：集成分支合入由检视者签，合 main 需我签字" \
     -- node /绝对路径/CoAgentHub/integrations/codex/mcp-server/dist/index.js
   ```

   或者把 [integrations/claude-code/.mcp.json.example](../integrations/claude-code/.mcp.json.example) 改好路径后放到项目根的 `.mcp.json`。

2. **装技能**：把 `integrations/claude-code/skills/coagent-l3` 整个目录复制到 `~/.claude/skills/`（所有项目可用）或项目的 `.claude/skills/`。技能很薄：告诉 Claude 该读哪份手册、哪一步用哪个工具、哪里最容易出事；规则本身在 [l3-guide.md](l3-guide.md)。

3. **唤醒**：Claude Code 的会话不会被外部推送，所以用拉的办法。开跑之后让它在后台跑
   `node scripts/coagent.mjs watch <missionId>`（Bash 工具的后台模式），命令一退出 Claude 就被唤醒、去读 Mission。

4. **大返回体**：单个 Mission 的详情可能有几十到上百 KB，活动日志更大，且没有裁剪参数。Claude Code 对单次 MCP 返回有 token 上限（环境变量 `MAX_MCP_OUTPUT_TOKENS` 可调）。真遇到截断，就改用 HTTP 只取需要的字段：

   ```bash
   curl -s --noproxy '*' http://127.0.0.1:3101/api/missions/<id> | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);console.log(m.status,m.workItems.map(w=>w.id+":"+w.status).join(" "))})'
   ```

## Codex

[integrations/codex](../integrations/codex/) 是完整的 Codex 插件：

- `mcp-server/`：同一个 MCP 服务器；
- `hooks/hooks.json`：`SessionStart` 钩子，把当前 Codex 根会话绑定到本地投递桥；
- 投递桥守护进程：以 1 秒为间隔轮询平台的收件箱 `/api/inbox`，把每条新投递用 `codex queue` 排进绑定的会话，**排队成功才 ACK**；排队失败投递留在原处，ACK 失败只重试 ACK，不会重复排队。

安装：构建 MCP 服务器（`setup` 已做），把 `integrations/codex` 目录作为本地插件加进 Codex；首次会话 Codex 会请你**信任**钩子——钩子只写插件本地的绑定状态并拉起本地桥进程。插件的 `.mcp.json` 里路径用的是 `${PLUGIN_ROOT}`，如果你的 Codex 版本在 MCP 配置里不展开这个占位符，改成 `mcp-server/dist/index.js` 的绝对路径。

缺省只消费投递给**当前 Codex 会话**的通知（用会话 UUID 对 Mission 的 `conversationRef`），免得一个会话 ACK 了另一个宿主的投递。想让一个 Codex 会话当所有 Mission 的中央检视者，设 `COAGENTHUB_INBOX_SCOPE=all`；想绑定某个指定接收者，设 `COAGENTHUB_INBOX_RECIPIENT`。

只想要 MCP 工具、不要钩子和投递桥？在 `~/.codex/config.toml` 里：

```toml
[mcp_servers.coagenthub]
command = "node"
args = ["/绝对路径/CoAgentHub/integrations/codex/mcp-server/dist/index.js"]
env = { COAGENTHUB_API_BASE = "http://127.0.0.1:3101/api", COAGENTHUB_REVIEWER_ID = "codex-l3" }
```

## 其他支持 MCP 的 agent

把同一个 stdio 服务器配进去。字段名按你的 agent 的文档调整，常见的 `mcpServers` 形状是：

```json
{
  "mcpServers": {
    "coagenthub": {
      "command": "node",
      "args": ["/绝对路径/CoAgentHub/integrations/codex/mcp-server/dist/index.js"],
      "env": {
        "COAGENTHUB_API_BASE": "http://127.0.0.1:3101/api",
        "COAGENTHUB_REVIEWER_ID": "<这个 agent 的名字>",
        "COAGENTHUB_REVIEW_CONFIRMED_BY": "<你的名字>"
      }
    }
  }
}
```

唤醒走拉：让它后台跑 `node scripts/coagent.mjs watch <missionId>`，或者定期调 `coagenthub_get_mission`。

**更轻的一种：零依赖的 reviewer MCP。** `node scripts/reviewer-mcp.ts`（不需要 `setup`，不需要 npm）只暴露 11 个工作流工具：统一待办、值守租约与有界守候、待办确认、合 master 简报、文档提议的读/提/批/冲、候选熔断复位。**它没有创建 / 开跑 / 终审合入这些生命周期工具**，这些走命令行或 HTTP。适合想要最小依赖的场合，也可以和上面的 MCP 服务器并存。

## 只有 shell 的 agent（不接 MCP）

什么都不用装，在 CoAgentHub 目录下用这些命令。**写命令**会经本机回环自动转给持锁的平台服务：

| 做什么 | 命令 |
|---|---|
| 开跑一个 Mission | `node scripts/coagent.mjs run <mission.json> --cwd <集成 worktree>` |
| 守候一个 Mission | `node scripts/coagent.mjs watch <missionId>`（走 HTTP 读） |
| 终审合入 | `node src/l3.ts merge <missionId> --as "<署名>" --confirmed-by "<确认人>" --reason "…"` |
| 打回 / 放弃 | `node src/l3.ts send-back <missionId> --reason "…" --as … --confirmed-by …`，`abandon` 同理 |
| 答复协调者的升级 | `node src/l3.ts answer <missionId> --answer "…"` |
| 发新契约 | `node src/l3.ts revise <missionId> --contract <文件>` |
| 暂停 / 恢复 / 叫停 / 重跑 | `pause` / `resume` / `cancel` / `rerun` |
| 作废一个工作项 | `node src/l3.ts retire <missionId> --item W-n --reason "…"` |
| 提高花费上限 | `node src/l3.ts budget raise <missionId> [--by 美元]` |
| 复位一个候选的熔断 | `node src/l3.ts candidate reset <profileId> --reason "…"` |

**读状态一律用 HTTP**：`GET /api/missions/<id>`、`/api/missions/<id>/activity`、`/api/missions/<id>/diff`、`/api/missions/<id>/validation-reports/<reportId>`、`/api/pools`、`/api/reviewer/todos`、`/api/inbox`。全表见 [http-api.md](http-api.md)。

> **平台开着时，不要用 `l3 show`、`l3 inbox`、`l3 plan`，也不要跑 `run-plan --check`。** 这几条是只读命令，但它们直接读整份状态文件、不经过服务；平台正在写盘时撞上，Windows 上会让服务的原子替换失败、整个运行崩掉。只有平台停着的时候才能用它们。写命令（上表）没有这个问题，它们会自动转给服务。

> 命令行默认在当前目录找状态文件（`.coagent-state.json`）来定位持锁的服务，所以请在 CoAgentHub 目录下运行；如果你用 `--state` 自定义了状态文件，这里的命令也要带上同一个 `--state`。

## 换检视者 agent

换会话（比如从 Codex 换到 Claude Code）时，**先停掉旧会话的投递桥**，否则新通知还会被注入旧会话并被自动 ACK，出现两个检视者同时决策。没有桥的会话不要手工 ACK 别人的投递，只主动读权威状态。署名 `COAGENTHUB_REVIEWER_ID` 跟着换，审计里才分得清是谁签的。

多个检视者会话同时盯一个项目时，用**值守租约**避免互相踩：`POST /api/projects/<id>/reviewer-duty` 领取（租约 5 分钟，每分钟续一次），交接会递增代次，旧会话的写操作和守候被拒绝。租约是并发所有权，不是身份认证。
