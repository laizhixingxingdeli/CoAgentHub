# coagenthub-v5

## Purpose

CoAgentHub 是 agent-first 的软件工程 harness：把用户目标转成可追踪、可验证、可恢复的工程执行，而不是一次性对话脚本。

## Core Model

- **Project → Mission → WorkItem → Attempt**：项目承载长期真相；Mission 是一次有边界的变更；WorkItem 是可派发的执行单元；Attempt 是某次角色会话。
- **QueryRun**：与 Mission **并列**的只读问答记录；不进入 Mission 状态机（见 `specs/query-run.md`、ADR-0003）。
- **Work Truth**：Mission / Attempt / Evidence / Event / QueryRun 记在文件或 Postgres 仓储里，描述「现在在干什么、证据是什么」。
- **Project Truth**：稳定认知在 Git 的 `.coagent/` 里，跟代码同版本。

## Roles and Flow

分工的来由与后续改动见 ADR-0007。

- **L3 检视者**（用户开着的会话）：跟用户沟通，吃透需求和架构，按架构边界切票（一票一个 Mission），维护 `.coagent/`。可以读源码，但不写代码、不在代码层面验收，只收协调者的交卷结论。
- **L2 协调者**：在一个 Mission 内规划、拆 WorkItem、写冻结工单，逐项验收执行者的交付，在代码层面守住架构。可以改 plan；**不能改契约**（契约只由 L3 修订），发现契约不成立、或者影响目标 / 验收标准 / 架构边界时升级给 L3。对 `.coagent/` 只能在交卷时提议（memoryDelta）。开工先核对检视者的票：每条验收要改的文件是否都在范围里、提到的输入是否存在、诊断与假设是否属实、验收之间是否矛盾；核对通过就在同一跳里接着建单派发；有问题才先升级、不派工（检视者下发的不一定对）。每一跳都要以结构化动作结束，只更新规划不算推进。派工前先把整个改动捋顺写进规划，分五步：探索要动的模块和调用方；定测试接缝（优先已有的、越高越少越好）；写设计（实现决定、各处怎么衔接、碰到哪些既有测试与不变量、不做什么）；拆工单（先预重构，再一张一条能单独验证的小路径并写明依赖，牵动面大的改动先加新形式、分批迁移、最后删旧的）；只派依赖已完成的一批。不边派边想，不派「先试试看」的工单（用户 2026-10-01，参照 to-spec / to-tickets）。工单按下面的「工单标准」写。
- **L1 执行者**：只执行冻结的 WorkOrder，不能自验收、不能重新定义目标；工单不够就报 blocked，不自己补分析。
- **落地**：未经 L3 不得 completed。无人值守按方案推进时，机器 L3 凭合并后在**集成分支**上跑出的方案级验证放行（ADR-0004）。master 一律由用户放行。
- **Lightweight（Fast Lane）**：分类时写好一张冻结工单，不开协调者规划会话。机器验证通过后，由与 Standard 相同候选池的协调者逐条验收；accept 后交 L3，reject 在同一协调者跳转 Standard 并继续规划，计入既有 AC1 连续失败。机器验证失败或超出轻量规模照旧升级 Standard；机器报告不代替 L2/L3 权威（AC4，2026-10-04 收尾验证）。
- **high_assurance**：独立检视 + 检视者签名放行的通道已实现（ADR-0006），但按用户决定关着（HAOFF1）：判为 high_assurance 的票按 Standard 走；四类禁止副作用仍然拒绝建单。
- **队列**：Mission 是基本单位，按顺序与依赖一个接一个推进；方案只是排序的工具，不另立一套升级、上限与记录（ADR-0007）。

## 工单标准

执行者用便宜的模型、只执行不分析，工单必须写到它照着做就能完成（用户 2026-10-01）：

1. 一张工单做一个完整的小功能（连同它的测试和文案），一般改 1–3 个文件。不要把同一个功能拆成类型、接线、文案、测试多张——每多一张就多一轮派发、验证、验收，约 5 分钟；也不要把几条不相关的修改塞进一张（第 8 条）（用户 2026-10-03 要求提速）。
2. 写明要读的文件和行段，执行者不必再搜索。
   - 尺寸建议：常规工单预计 15–20 分钟完成；需阅读/修改约 300 行以上、涉及多组 fixture 或多处接线时，先由协调者核实接缝，按调用点或用例组拆成能各自验证的单元。这是预警，不是行数或时间硬门禁；简单任务只需位置、目标和一条命令。
3. 写明改什么：哪个函数、什么位置、改成什么行为，必要时给签名或伪代码。
4. 测试最多 1–2 条，写明测什么、断言什么。
5. 验证命令一两条，可以直接复制运行。
6. 执行者交半成品或报卡住，说明工单太大或不清楚：拆小或写清楚再派，不原样重派；同一个行为拆了 3 次还没过，升级给检视者。
7. 新代码守工程规范的预警线（`architecture/engineering-standards.md`，用户 2026-10-02）：新函数不超过 40 行、嵌套不超过 3 层、参数不超过 4 个。这些数都是建议、不是硬约束（用户：「只是建议…没必要硬性要求」）：要改的大文件不让它明显变大——接线需要的少量新增可以，要加的多就抽成新模块；不许为了凑行数删注释、压缩写法；协调者不得把行数写成工单的硬约束（AC3 的 W-432 写了「orchestrator.ts 不增长」，执行者为此删注释、反复数行数）。协调者验收按那份规范的审查五维（设计、功能、复杂度、测试、命名与注释）逐项看，超线的要么让执行者拆，要么在验收理由里写明为什么可以。
8. 打回时修改要求有好几条，就拆成几张各管一条的小单再派，不要合成一张原样重派（AC3 的 W-429 一张单塞了四条修改，cn:hy3 连续三次把输出上限全用在思考上、交不出结果）。
9. 执行者开工第一步先跑工单 verification 里的定向命令，并经 `coagent_submit_evidence` 交一次证据（红的也交）：平台会把 30 分钟零证据的执行判为 runaway 并停下，中途交过证据才把墙钟延长一次。协调者派单前自己先跑一次定向，把已知失败和修改位置写进工单，执行者就不用再通读调度内部。（B2b 的 W-473、W-478、W-479 连续三次栽在开工通读约 25 分钟上；契约 r5 改成先交证据之后，W-480、W-481 分别 4 分钟和 20 分钟交卷，2026-10-06。）
10. 少走一来一回（用户 2026-10-07 要求提速）：①工作项的平台 VR 摘要全绿（每条命令 passed，changed-paths / forbidden-paths 通过）时，协调者直接验收，不为补全文升级；只有 VR 失败或需要失败细节时才升级要全文，完整 VR 原文由 L3 在终审时核对。②最后一张实现单的 validation 直接带 `node --test` 全量，它的 VR 就是最终提交的平台全量；只有最后一张单之后又有改动，才补零代码验证单。③只派依赖已经 accepted 的单，不派明知会 blocked 的单。④实现单不设行数硬上限，diffSize 只用于零代码验证单。（B4 一个 Mission 里，两次升级往返各约 10 分钟，单开的验证单约 10 分钟，行数上限造成两次重派。）

## Architecture

- **Kernel**：权威纯领域；不依赖 I/O、provider、HTTP、SQL。
- **Application**：编排、策略、校验、仓储接口实现边界。
- **Runtime**：跑模型 / 工具会话。
- **Adapters**：工作区、存储、provider 等对外适配。
- **模块地图**：`architecture/modules.md` 写了每个目录负责什么、关键入口和边界。读代码前先看它，别整份读 6,000 行的文件。

## Invariants

- 未经 L3 不得 completed。
- contract / plan 的修订绑定后续执行，不能 silently 忽略。
- Project Truth 在 Git `.coagent/`；Work Truth 在 file / Postgres repository。
- `VIBE.md` 是生成物，不是手写 Source of Truth。
- QueryRun 不是 Mission；只读靠工具 allowlist，不靠 prompt。
- 权威执行预算：hard 可停 / 内部晋升，soft 只告警；caller 不得手填 `budget_exceeded`（ADR-0005；按票累计的费用硬停已定，实现前由检视者人工执行）。
- Decision/Jev 在 OFF/SHADOW 下不具执行权威；SHADOW 仅审计（ADR-0002）。

## Web 约定

- 网页上的列表一律按时间倒序，最新的在最上面：任务表、方案运行列表、最近完成、待办、死信等都一样（用户 2026-09-29）。同一任务内的进度环节是流程，仍按发生顺序从上到下。

## Memory Model

- **`project.md`**：项目级稳定上下文（本文件）。**不要**再引入 `project.yaml` / `constitution.md` 或第二份项目级记忆入口。
- **`specs/`**：按 Capability 描述可观察行为（Living Spec），一个能力一份，文件名就是能力名，例如 `specs/plan-run.md`、`specs/machine-final-review.md`。
- **`architecture/decisions/`**：跨 Mission 的长期技术取舍（ADR）。
- **`architecture/modules.md`**：模块地图，按需读，不随每一跳发送。
- `.coagent/` 由检视者维护；协调者只能经交卷提议，执行者不得修改。
- 不要把 Mission 历史、临时计划或一次性排障笔记写进上述长期文件。
- 根目录 `VIBE.md` **只**由 `generateVibe` / 落地时重写；手改会丢。

## 执行者红线

写代码时必须遵守。

### 分层

- `src/kernel/` 不 import 任何东西（连 `node:` 都不），也不出现 provider / model / session / http / fetch / sql / database 这些词。理由：接第二个 agent 时不用改内核。
- 第三方依赖**只允许**出现在 `src/application/pg-store.ts`。别处一律零依赖——文件版存储守着「clone 下来什么都不装就能跑通全部测试」。
- 规则写在用例层，不写在 prompt 里。**能用工具层挡住的，就不要指望模型记得住。**

### 前端

- **不引入构建步骤**，不引入前端框架。浏览器原生 ES module 直接跑。
- 前端是纯客户端，只走 `/api/*`；不得直接碰存储或领域对象。

### 写法

- 相对 import 必须带 `.ts` 后缀（Node 原生类型剥离的要求）。
- 不用 `enum`，不用 constructor parameter properties（同上）。
- 注释写**为什么**，不写代码在做什么。特别是写清楚「不这么做会怎样」。
- `src/` 里除 `src/application/decision-question-registry.ts` 外不出现「题集」一词。否则 `test/decision-state-builder.test.ts` 的全 `src` 扫描会红。

### 测试

- 测试用 `node --test`：定向跑 `node --test test/<名字>.test.ts`，全量跑 `node --test`。不用 npm / npx。
- 测试尽量少，只加在关键地方：只写验收点名的关键场景，每条验收一到两条；不为每个分支、每种写法、每种错误各写一条（用户 2026-09-30）。
- 要改表结构或 TRUNCATE 的 PG 测试，用 `test/helpers/pg.ts` 的 `ensureTestDatabase('<独立名字>')` 另建隔离库；PG 不可用时这类测试跳过，跳过不算验证通过。否则测试之间互相踩数据，或者把「没跑」当成「通过」。
- 「已修复 / 已完成」必须有可验证证据；没跑过的命令不要写成跑过。

### 仓库

- 换行：提交进仓库的内容（blob）一律是 LF；本机 `core.autocrlf=true`，检出的工作副本是 CRLF。同一个文件里不要混用 LF 和 CRLF。否则会出现整文件的伪改动，看不清真实改了什么。
- 不碰 `.idea/`（用户的 IDE 配置）。否则会改坏或提交用户本地的设置。
- 不读凭据文件（例如 `~/.pi/agent/auth.json`、`typesafe.env`），不在输出、日志、提交里打印 key，给子进程的环境不额外塞凭据（透传名单见 `specs/spawn-env-filter`）。否则凭据会随日志、产物或提交泄露。
- 协调者和执行者都不直接打开主工作区的 `.coagent-state.json` 及其锁目录，只读也不行：平台服务一直在写这个文件，Windows 上有人打开着它，服务的原子替换就会失败，整个运行崩掉。要看别的 Mission 的状态或活动，用只读 HTTP（`GET /api/missions/<id>`、`GET /api/missions/<id>/activity`），或在交卷里写明需要 L3 提供样例。（COM5-design 的调查报告曾直接读运行中的状态文件取样例，2026-10-07。）

## 协作与流程

检视者、协调者和平台操作时遵守。

- 只按显式路径 `git add` / commit，不用 `git add -A`、`git add .`。否则会把用户的未跟踪文件（IDE 配置、本地方案文件、实验输出）卷进提交。
- Mission 的目标集成分支与 projectRoot 以 workspaceRef 为准，不从主工作区当前分支推断；2026-10-04 主工作区为 master，通信优化使用独立 codex/communication-integration worktree。Mission 在跑时，目标集成分支上不许有任何新提交（文档、手工改动、别的会话的改动都算），目标集成工作区也不许留未提交的改动。否则平台合不进这个 Mission：合入要求目标 HEAD 等于 Mission 开工时的提交、且工作区干净（REF1 就因此只能手动合入）。手工或别的会话的改动在单独的 worktree / 分支上做，两个 Mission 之间由检视者合入。
- 验证在独立 worktree（`.coagent-worktrees/` 下）里跑，不在用户的主工作区里跑。否则主工作区里用户开着的 IDE、未跟踪文件会被算进改动，或被验证过程改坏。
- 冻结票和验收时不要求穷举测试；协调者验收不得要求超出契约点名的测试。否则测试越写越多，便宜的执行者反复返工。
- 前端换框架的判据：需要虚拟滚动 / 拖拽 / 富文本这类复杂组件，或页面数超过 8。在那之前，「换成 React 会更好写」不是理由。

## 已确认 Mission 的连续运行（2026-10-04）

基本单位仍是 Mission；用户确认冻结清单后通过项目 mission-queue 入队，执行目录、适配器、检视者与集成验证属于项目 execution-config。队列只提供顺序和依赖，门禁、费用、失败和最终审查按 Mission 处理。配置变化仅影响未启动任务；人工签字也必须跑项目集成验证，失败回滚并留待审查。使用步骤见 reviewer-runbook 的 Mission 队列节；生产旧 run-plan 已退役，历史记录保留恢复兼容。


## AC4 收尾记录（2026-10-04）

AC4 实现已在 master d4f39c8；独立普通 Mission AC4-platform-closeout-20261004 经执行者证据、协调者逐条 L2 与 L3 最终审查 completed，通过插件合入 codex/communication-integration（a756fc5）。全量 2365 tests / 2358 pass / 0 fail / 7 既有 HAOFF1 skip；报告见 docs/ac4-platform-closeout-20261004.md。3101 常驻服务托管了本收尾任务，但本票未另跑真实 lightweight Mission 作端到端验证。

历史 PLAN-harness-remaining-20261003-0307-AC4 保留 parked、未 completed，历史 PlanRun 已 stopped；它已有部分 WorkItem accepted 成果与 L2 记录，缺的是整份 Mission 的最终交卷与验收，不能把独立收尾结论补造为历史记录，也不能把未整票完成写成所有历史工作项均无验收。此次文档及收尾仅合入独立集成分支，master 仍待用户另行授权。
