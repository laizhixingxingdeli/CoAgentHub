# 从零到第一个 Mission

约 20 分钟。做完你会得到：一个跑着的平台、两三个模型候选、一个接好的检视者 agent，以及一个在练习项目上完整走完“契约 → 规划 → 执行 → 验证 → 终审合入”的 Mission。

## 0. 你需要

- **Node 24+** 和 **git**；`npm` 只在 `setup` 时用一次。
- **一个模型**：任何 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 支持的 provider 的账号或 API key。协调者最好用强一点的，执行者用便宜快速的就行。
- **一个当检视者的 agent**：Claude Code、Codex、或者别的能跑命令或接 MCP 的 agent。你自己开着的那个会话就是检视者。

## 1. 安装并启动平台

```bash
git clone https://github.com/laizhixingxingdeli/CoAgentHub.git
cd CoAgentHub
node scripts/coagent.mjs setup     # 装适配层与 MCP 服务器的依赖；平台本体零依赖
node scripts/coagent.mjs doctor    # 只读自检，逐项告诉你还差什么（✓ 好了，! 提醒，✗ 必须先解决）
node scripts/coagent.mjs start     # 启动，打印将使用的状态文件和网址
```

第一次的 `doctor` 里出现“模型清单为空”“平台未运行”“状态文件不存在”这几条 `!` 是正常的——你还没登录模型、还没启动、还没第一次创建状态文件。

打开 <http://127.0.0.1:3101>。`start` 替你做了三件事，都可以用选项或环境变量改：

| 项 | 缺省 | 改法 |
|---|---|---|
| 状态文件 | 仓库根的 `.coagent-state.json` | `--state <路径>` 或 `COAGENT_STATE` |
| 端口 | 3101（只监听 127.0.0.1） | `--port <n>` 或 `PORT` |
| 子进程环境透传名单 | `-`（只传 OS 与代理基线，不传你的密钥） | `--passthrough A,B` 或 `COAGENT_AGENT_ENV_PASSTHROUGH` |

要点：

- **状态文件是平台的全部记忆**（Mission、证据、活动日志），同一时间只允许一个平台进程写它（单写者锁）。**不要手工编辑它，平台开着时也不要读它**，要看进度用网页或 HTTP。
- `Ctrl+C` 一次是受控退出（落盘、释放锁）；不要直接杀进程。万一被杀了，下次启动时平台会等锁心跳过期（约 2 分钟）后自动接管。
- 网页是只读观测加少量配置：项目、任务时间线、收件箱、资源池（`#/pool`）、角色与模型（`#/agents`）、平台状态（`#/platform`）。

## 2. 接模型（L2 / L1）

至少需要 **1 个协调者候选 + 1 个执行者候选**。完整说明在 [models.md](models.md)，最短路径是：

```bash
npx pi                            # 在 pi 里 /login 登录一个 provider，然后退出
node scripts/coagent.mjs doctor   # 应该能看到“适配层能列出 N 个模型”
```

然后在 <http://127.0.0.1:3101/#/pool> 的协调者和执行者两张表底下各添加一个候选（模型从下拉清单里选）。

## 3. 接检视者（L3）

选一种，详见 [l3-agents.md](l3-agents.md)：

- **Claude Code**：把 `integrations/claude-code/.mcp.json.example` 的内容加进你的 MCP 配置，装上技能 `integrations/claude-code/skills/coagent-l3`。
- **Codex**：装 `integrations/codex` 插件（带会话绑定和实时投递）。
- **其他 agent**：把 MCP 服务器 `integrations/codex/mcp-server/dist/index.js` 配成 stdio MCP；或者什么都不装，让 agent 直接用命令行（`node scripts/coagent.mjs ...`、`node src/l3.ts ...`）和 HTTP。

不管用哪个，**让它先读 [l3-guide.md](l3-guide.md)**：那是写给检视者 agent 的操作手册，你可以直接把它当作 agent 的指令。

## 4. 准备你的项目（每个项目一次）

先用仓库自带的练习项目走一遍：

```bash
cp -r examples/playground ~/coagent-playground
cd ~/coagent-playground
git init -b main && git add -A && git commit -m "init"
git worktree add ../coagent-playground-integration -b coagent/integration
```

对你自己的项目，要做的是同样三件事：

**4.1 一个集成分支，和检出它的 worktree。** 平台把每个 Mission 的成果合进一个“集成分支”，**不会碰你的 main**。`git worktree add ../my-project-integration -b coagent/integration` 之后，所有 Mission 的 `--cwd` 都指向这个 worktree。理由是：Mission 在跑时，集成分支上不许有别的提交、检出目录不许有未提交的改动（平台合入要求目标分支的 HEAD 等于开工时的提交、工作区干净），所以不要在这个 worktree 里手工开发——你的日常开发留在原来的检出里。每个 Mission 的工作目录在 `<cwd>/.coagent-worktrees/<missionId>/`，平台会自己把 `.coagent-worktrees/` 写进 `.git/info/exclude`，不改你的 `.gitignore`。

**4.2 项目约定 `.coagent/project.md`。** 协调者读整份，**执行者只读其中标题为“执行者红线”的那一节**（标题必须就叫这个，任意级别的 Markdown 标题都行；没有这一节，执行者就拿不到任何项目约定，平台也不会回退成给整份）。把不可协商的东西写进去：测试怎么跑、哪些依赖不许加、命名与风格、哪些目录不许碰。模板见 [examples/playground/.coagent/project.md](../examples/playground/.coagent/project.md)。

**4.3 验证命令要能不经 shell 跑通。** 工单里的验证命令是 argv 数组，平台直接执行，**不经 shell**，也拒绝 `bash -c`、`cmd /c`、`powershell -Command` 这类壳层包装（永远判红）。`node --test`、`node --run <脚本>`、`python`、`git` 都可以；`npm test` 在很多环境下起不来，别写。Mission 的验证目录是 `<项目根>/.coagent-worktrees/<id>/`，那里没有 `node_modules`：Node 项目的依赖要装在项目根，Python 要用 venv 里 python 的绝对路径。

## 5. 写契约，开跑

契约（`contract`）是检视者交给平台的“票”，五个字段：

```json
{
  "intent": "为什么做、做什么、做到哪（几句话讲清楚）",
  "acceptance": ["可观察、可验证的验收条目，一条一件事"],
  "constraints": ["必须遵守的做法与范围，例如只改哪些文件"],
  "nonGoals": ["明确不做什么"],
  "guardrails": ["不可逾越的底线"]
}
```

好契约的标准：**验收能由一条命令或一个断言判断；范围写到目录或文件；写明不做什么。** 现成的例子是 [examples/playground/mission.json](../examples/playground/mission.json)（给 `window.ts` 加一个 `lastN`）。冻结一张真票的完整套路在 [l3-guide.md](l3-guide.md#冻结一张票)。

开跑有两条路，等价：

**让你的检视者 agent 来**（推荐）：对它说

> 按 docs/l3-guide.md 的流程，用 examples/playground/mission.json 在 ~/coagent-playground-integration 上创建并开跑一个 Mission，开跑前先把票给我确认。

它会调用 `coagenthub_create_mission` 和 `coagenthub_start_mission`。

**自己用命令行**：

```bash
node scripts/coagent.mjs run examples/playground/mission.json \
  --cwd ~/coagent-playground-integration --max-rounds 30
```

`--cwd` 必须是目标项目的集成 worktree（启动器不让你省略它，免得把任务派到平台自己的仓库上）。平台正在运行时，这条命令会把请求交给它托管并一直打印进度。

## 6. 看它跑

- 网页 <http://127.0.0.1:3101/#/missions/M-001-last-n>：时间线里能看到协调者规划、拆出的工作项、每个执行者尝试的工具调用、平台自己跑的验证、协调者的逐条验收。
- 一个 Mission 的状态流转：`planning`（协调者规划）→ `executing`（执行者干活）→ `awaiting_review`（协调者交卷，等检视者终审，**这时改动还没落地**）→ `completed`；`blocked` 是另一个终态。**任何状态都不能直接跳到 `completed`，只有检视者检视过才算。**
- 让检视者 agent 在后台值守：`node scripts/coagent.mjs watch M-001-last-n`。Mission 一有需要检视者知道的变化（出了升级单、工作项被验收或打回、到了 `awaiting_review`……）它就退出，退出就是唤醒信号。
- 协调者遇到解决不了的事会开**升级单**，等检视者答复（网页“收件箱”或检视者的 `coagenthub_answer_escalation`）。

## 7. 终审与合入

状态到 `awaiting_review` 后，检视者要读：契约的每条验收和对应证据、协调者的交卷结论、平台自己跑的完整验证报告、代码改动。认可就合入集成分支：

```bash
# 在 CoAgentHub 目录下
node src/l3.ts merge M-001-last-n --as "<检视者的名字>" --confirmed-by "<你的名字>" --reason "<一两句理由>"
```

（或者 agent 调用 MCP 的 `coagenthub_finalize_mission`。）不认可就 `send-back --reason "..."` 打回给协调者重做。合入之后，成果在 `coagent/integration` 分支上。**把它合进你的 main 是你自己的事**，用普通的 git 合并，平台不碰 main。

## 8. 清理

```bash
cd ~/coagent-playground && git worktree remove ../coagent-playground-integration --force
```

Ctrl+C 停掉平台。状态文件留着，下次 `start` 接着用。

## 下一步

- 想让检视者长期值守、批量排队 Mission：[l3-guide.md](l3-guide.md)。
- 想接别的 agent 运行时（不用 pi）：[adapter-protocol.md](adapter-protocol.md)。
- 出错：[troubleshooting.md](troubleshooting.md)。
