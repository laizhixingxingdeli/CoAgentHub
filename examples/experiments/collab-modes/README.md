# 对照实验：三层协作 vs 两层主控

同一个任务分别用两种方式各跑一次，比较所需时间、费用和交付质量：

| 模式 | 谁规划、拆单、验收 | 代表 |
|---|---|---|
| **hierarchical** | 平台拉起的 L2 协调者（候选池里的模型） | CoAgentHub 三层 |
| **direct** | 你开着的 agent 会话（主控），平台只跑执行者 | MAC（multi-agent-collaboration）式两层：主脑派活、自己验收 |

两种模式用同一个基线、同一组执行者模型、同一份需求原文、同一张答复单，最后用 agent 看不到的 14 条隐藏测试判分。

## 任务

给练习仓库 `ledger-lite`（零依赖的记账命令行工具，25 条测试）加多币种支持：CSV 带币种列、`rates` 子命令管理汇率、报表换算成基准币种。需求原文就是 `mission-*.json` 里的契约。

任务里埋了三类考点，**都不要告诉 agent**：

- **项目约定**：`docs/CONVENTIONS.md` 规定金额以分为整数、只在最后一步用银行家舍入、判重看所有字段、改存储格式要升版本并兼容旧文件。不读约定的实现会在舍入和判重上丢分。
- **需求含糊点**：交易日早于第一条汇率时怎么办、同一天重复添加汇率怎么办，仓库里没有答案，答案只在 `answers.md`。能发问的流程可以问到；不问就只能猜。
- **向后兼容**：旧版账本和单币种用户的输出必须逐字不变。

参考实现（不随仓库发布）能通过全部 25 + 14 条测试；未改动的基线只通过 2 条隐藏测试；「逐笔先舍入」的朴素实现通过 12 条，正好丢掉舍入那两条。

## 目录

```
ledger-lite/              练习仓库源（prepare.mjs 从这里复制）
mission-hierarchical.json 三层模式的 Mission（projectId ledger-lite-h）
mission-direct.json       两层主控模式的 Mission（projectId ledger-lite-d，coordinationMode: direct）
prepare.mjs               生成一份干净的练习仓库 + 集成 worktree
collect.mjs               从平台 HTTP 读一个 Mission 的用时、会话次数、平台记账用量
answers.md                答复单 ── 只给答复人（你）看
hidden/                   隐藏测试与判分脚本 ── 只在全部跑完后用
results-template.csv      记录表
```

## 一、准备（一次）

以下命令以 Windows PowerShell 为例，路径换成你自己的。

1. **把答复单和隐藏测试移出 CoAgentHub 仓库**，免得任何 agent 读到：

   ```powershell
   mkdir D:\exp\grading
   Move-Item examples\experiments\collab-modes\answers.md D:\exp\grading\
   Move-Item examples\experiments\collab-modes\hidden D:\exp\grading\
   ```

2. **两份独立的练习仓库**（每种模式一份，互不干扰）：

   ```powershell
   node examples\experiments\collab-modes\prepare.mjs D:\exp\ledger-h
   node examples\experiments\collab-modes\prepare.mjs D:\exp\ledger-d
   ```

   每次会得到 `D:\exp\ledger-x`（不要在里面开发）和 `D:\exp\ledger-x-integration`（Mission 的工作目录）。

3. **平台与模型**：`node scripts/coagent.mjs start`，在 `#/pool` 里：
   - 执行者候选：两种模式**用同一个**（建议便宜的那个，候选顺序也一致）；
   - 协调者候选：只有 hierarchical 用到，选一个中档模型；
   - 检视者 / 主控会话：两种模式**用同一个宿主、同一个模型**（例如同一个 Claude Code 模型）。

4. **预算**：两次合计封顶 $10，单次超过 $4 就停（`pause`），记为「超预算未完成」。

## 二、跑 hierarchical

1. 记下检视者会话当前的用量（Claude Code 输入 `/cost`，Codex 输入 `/status`）和开始时间。
2. 开跑：

   ```powershell
   node scripts/coagent.mjs run examples\experiments\collab-modes\mission-hierarchical.json --cwd D:\exp\ledger-h-integration --max-rounds 30
   ```

3. 值守期间**只做两件事**：
   - 出现升级单时，对照 `D:\exp\grading\answers.md` **原文**回答（网页收件箱，或让检视者照你给的原文答复），在记录表里记一次「提问」；
   - 到 `awaiting_review` 时让检视者按正常流程终审：认可就 `merge` 进集成分支，不认可就 `send-back`。检视者**不能跑隐藏测试**，也不能看答复单。
4. 结束后记下结束时间和检视者会话的用量，然后：

   ```powershell
   node examples\experiments\collab-modes\collect.mjs EXP-MC-H1
   ```

## 三、跑 direct（两层主控）

1. 开一个**新的** agent 会话（装好 CoAgentHub 的 MCP，例如 Codex 插件），记下用量和开始时间。
2. 把下面这段原样发给它：

   > 你是这次实验的主控，用 CoAgentHub 的 direct 两层模式完成一个 Mission。
   > 1. 读 `examples/experiments/collab-modes/mission-direct.json`，用 `coagenthub_create_mission` 创建 Mission（projectId、missionId、contract 照抄，`coordinationMode: "direct"`），项目工作目录是 `D:\exp\ledger-d-integration`。
   > 2. 按 `docs/direct-controller.md` 的流程，由你自己规划、冻结工单（工单要带 `validation.commands`）、派发、启动执行者、逐条验收，最后提交 Mission Result。你不直接改代码。
   > 3. 除 `mission-direct.json` 外，不要读 `examples/experiments/collab-modes/` 下的任何文件。需求有不清楚的地方直接问我。

3. 它问你问题时，同样只照答复单原文回答，并记一次「提问」。
4. 到 `awaiting_review` 后，由**同一个会话**以检视者身份终审合入（这一步本来就是主控的职责）。
5. 结束后记下用量，然后：

   ```powershell
   node examples\experiments\collab-modes\collect.mjs EXP-MC-D1
   ```

   direct 模式下主控会话的 token 平台看不到，**以你在会话里记下的为准**。

## 四、判分

两个 Mission 都结束后：

```powershell
node D:\exp\grading\hidden\grade.mjs D:\exp\ledger-h-integration
node D:\exp\grading\hidden\grade.mjs D:\exp\ledger-d-integration
```

脚本把被测检出复制到临时目录再放入隐藏测试，不动你的检出。没合入（被打回或停在中途）就对 Mission 的 worktree（`<integration>\.coagent-worktrees\<missionId>`）判分，并在记录表里注明。

## 五、记录与解读

把每次的数据填进 `results-template.csv`：

| 字段 | 来源 |
|---|---|
| wall_minutes | 开始到合入的墙钟；`collect.mjs` 的 `wallMinutes` 可作参考 |
| controller_tokens / controller_cost_usd | 检视者或主控会话的用量差（你手记） |
| platform_cost_usd | `collect.mjs` 的 `platformUsage.cost`（协调者 + 执行者） |
| model_sessions / work_items / reworks | `collect.mjs` 的 `modelSessions`、`workItems`、`workItemRejects` |
| questions_asked | 你按答复单回答的次数 |
| hidden_pass_of_14 / agent_tests_pass | `grade.mjs` |

怎么读结果：

- **direct 更快、主控 token 不高、隐藏测试不输**：说明在这种中等任务上，我们的三层流程开销偏大，值得放大工单颗粒度，或者默认走 direct。
- **direct 更快，但丢了 H01/H02（舍入）、H04/H05（缺汇率）或 H13（判重），或者主控 token 明显偏高**：印证「两层快、三层稳」，三层多花的时间换来了质量，或者把贵模型的工作量转给了便宜模型。
- **两边都丢同样的分**：问题在执行者模型或需求本身，和协作方式无关。

每种模式只跑一次，结论只能当方向参考。想要稳定结论，每种模式跑 3 次：每次重新 `prepare.mjs` 一份仓库，`missionId` 改成 `-2`、`-3`，预算相应放大到约 $25。
