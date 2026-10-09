# CoAgentHub

[中文](README.md) | [English](README_EN.md)

**让多个 AI 编码 agent 按三层分工完成同一个需求，并且每一步都有证据可查。**

CoAgentHub 是一个本机运行的 agent-first 软件工程 harness。你把需求交给一个“检视者”，平台把它变成有边界的变更（Mission），由协调者拆成工单，再由便宜、快速的执行者模型照着工单干活；平台自己跑验证、存证据、守门禁，出了问题能恢复，最后由检视者签字合入。

它不绑定任何一家 agent 或模型：**检视者可以是任何你开着的 agent 会话**（Claude Code、Codex、或任何能跑命令的 agent），**协调者和执行者可以是 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 支持的任何模型**（Anthropic、OpenAI、Google、DeepSeek、xAI、OpenRouter、Ollama、本地 llama.cpp……）。

> 状态：预览版。开发与测试都在 Windows 11 上完成；代码按跨平台写，但 Linux / macOS 还没有真机验证，欢迎反馈。HTTP 接口没有鉴权，只监听 127.0.0.1，见 [docs/security.md](docs/security.md)。

## 三层分工

| 层 | 是谁 | 管什么 | 不碰什么 |
|---|---|---|---|
| **L3 检视者** | 你开着的 agent 会话 | 吃透需求和架构，把需求切成“票”（契约），开跑，值守，终审并签字合入 | 不写功能代码，不在代码层面验收，只看协调者的结构化结论 |
| **L2 协调者** | 平台拉起的模型会话 | 在一个 Mission 内规划、拆工作项、写冻结工单，逐项验收执行者的交付 | 不改需求（契约只由 L3 改） |
| **L1 执行者** | 平台拉起的（通常是便宜的）模型会话 | 只执行冻结工单，交代码改动和证据 | 不自验收，不重新定义目标，工单以外的不看不改 |

核心模型是 **Project → Mission → WorkItem → Attempt**：项目承载长期事实，Mission 是一次有边界的变更，WorkItem 是可派发的执行单元，Attempt 是某次模型会话。

```
你 ──需求──▶ L3 检视者 ──票(契约)──▶ 平台 ──▶ L2 协调者 ──冻结工单──▶ L1 执行者
                ▲                     │  ▲                              │
                │ 终审签字合入          │  └──── 证据 + 平台自己跑的验证 ◀──┘
                └──── 交卷 + 逐条验收 ◀──┘
```

几条贯穿始终的设计：

- **看证据，不看措辞。** 执行者说“测试过了”不算数，平台自己跑工单里的验证命令，协调者按证据逐条验收。
- **能用工具层挡住的，不靠提示词。** 只读问答靠工具白名单；执行者的工具表里没有改契约的口；子进程环境默认只传基线变量，不透传你的密钥。
- **贵模型只做贵的判断。** 执行者用便宜模型，由上两层把工单写到“照着做就能完成”。
- **未经 L3 不得 completed，合入 master 一律要你签字。**

## 快速开始

需要：**Node 24+**、**git**、**npm**（只有 `setup` 用到）、一个 pi 支持的模型账号或 API key、一个能当检视者的 agent。

```bash
git clone https://github.com/laizhixingxingdeli/CoAgentHub.git
cd CoAgentHub
node scripts/coagent.mjs setup     # 装适配层和 MCP 服务器的依赖（平台本体零依赖，不需要 npm install）
node scripts/coagent.mjs doctor    # 只读自检，告诉你还差什么
node scripts/coagent.mjs start     # 启动平台，浏览器打开 http://127.0.0.1:3101
```

然后做两件事，各有一页文档：

1. **接模型（L2 / L1）**：用 pi 登录一个模型账号，在网页“资源池”里添加候选。→ [docs/models.md](docs/models.md)
2. **接检视者（L3）**：给你的 agent 装上 MCP 服务器和操作手册。→ [docs/l3-agents.md](docs/l3-agents.md)

两样都就绪后，照 [docs/getting-started.md](docs/getting-started.md) 在你自己的仓库上跑第一个 Mission。

## 文档

| 想知道 | 看 |
|---|---|
| 从零到第一个 Mission | [docs/getting-started.md](docs/getting-started.md) |
| 怎么接不同的模型给协调者 / 执行者，怎么调思考档位和顺序 | [docs/models.md](docs/models.md) |
| 检视者用 Claude Code / Codex / 别的 agent，或者只有命令行 | [docs/l3-agents.md](docs/l3-agents.md) |
| 写给检视者 agent 读的操作手册（可直接当它的指令） | [docs/l3-guide.md](docs/l3-guide.md) |
| 接入别的 agent 运行时（不用 pi） | [docs/adapter-protocol.md](docs/adapter-protocol.md) |
| 安全边界与已知限制 | [docs/security.md](docs/security.md) |
| 出错了 | [docs/troubleshooting.md](docs/troubleshooting.md) |
| HTTP 接口全表 | [docs/http-api.md](docs/http-api.md) |
| 模块地图与架构决定 | [.coagent/architecture/modules.md](.coagent/architecture/modules.md)、[.coagent/architecture/decisions/](.coagent/architecture/decisions/) |
| 存储、租约、归因链的设计记录 | [docs/design-notes.md](docs/design-notes.md) |

## 仓库布局

```
src/            平台本体：kernel（纯领域）/ application（用例）/ runtime（跑 agent 的端口）/ api（HTTP）/ web（网页，原生 ES module，无构建）
adapters/pi/    L2 / L1 的 pi 适配层：平台通过 stdin / stdout 协议拉起它，平台本身不 import 任何 agent SDK
integrations/   L3 接入：MCP 服务器（任何 agent 可用）、Codex 插件钩子、Claude Code 的技能和配置
scripts/        启动器 coagent.mjs，以及只读 MCP / 值守脚本
examples/       Mission 契约、候选池、pi 模型配置的示例
.coagent/       项目自己的长期记忆：规格、架构决定、模块地图（这个项目用自己开发自己）
docs/           使用文档
test/           测试，`node --test`
```

平台本体**没有构建步骤、没有第三方依赖**（Postgres 存储是可选项，只有它需要 `pg`）：

```bash
node --test          # 全量测试，不装任何东西即可运行
```

没有 Postgres 的机器上，约 90 条需要数据库的测试会显示为 skipped（跳过不算通过，但也不算失败）。

## 参与开发

这个仓库用 CoAgentHub 开发自己，规则入口是 [AGENTS.md](AGENTS.md)（维护者的检视者规则）和 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

见 [LICENSE](LICENSE)。
