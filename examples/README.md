# 示例

| 文件 | 用途 |
|---|---|
| [playground/](playground/) | 第一次跑通整条链用的小项目：复制出去、`git init`，里面带 `.coagent/project.md` 和一份现成的 `mission.json` |
| [pi-models.example.json](pi-models.example.json) | pi 的 `~/.pi/agent/models.json` 示例：登记一个本机 Ollama 端点和一个需要环境变量 key 的网关。说明见 [docs/models.md](../docs/models.md) |
| [pools.example.json](pools.example.json) | `POST /api/pools/<角色>/configure` 的请求体示例：整个角色按顺序整体替换 |

契约（Mission 的 `contract`）的写法见 [docs/getting-started.md](../docs/getting-started.md#5-写契约开跑) 和 [docs/l3-guide.md](../docs/l3-guide.md#冻结一张票)。
