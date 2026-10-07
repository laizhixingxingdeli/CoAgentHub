# coagenthub-v5

> 本文件由 CoAgentHub 生成，**不要手工编辑** —— 改动会在下次生成时丢失。
> 内容来自 `.coagent/`，跟代码同一个版本。

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
- **L2 协调者**：在一个 Mission 内规划、拆 WorkItem、写冻结工单，逐项验收执行者的交付，在代码层面守住架构。可以改 plan；**不能改契约**（契约只由 L3 修订），发现契约不成立、或者影响目标 / 验收标准 / 架构边界时升级给 L3。对 `.coagent/` 只能在交卷时提议（memoryDelta）。已验收的项要补做时直接新建引用原 id 的补修单、目标验收范围不变就不升级；作废只表示不用做了，不用来重启卡住的工作（ADR-0007 补充，2026-10-07）。开工先核对检视者的票：每条验收要改的文件是否都在范围里、提到的输入是否存在、诊断与假设是否属实、验收之间是否矛盾；核对通过就在同一跳里接着建单派发；有问题才先升级、不派工（检视者下发的不一定对）。每一跳都要以结构化动作结束，只更新规划不算推进。派工前先把整个改动捋顺写进规划，分五步：探索要动的模块和调用方；定测试接缝（优先已有的、越高越少越好）；写设计（实现决定、各处怎么衔接、碰到哪些既有测试与不变量、不做什么）；拆工单（先预重构，再一张一条能单独验证的小路径并写明依赖，牵动面大的改动先加新形式、分批迁移、最后删旧的）；只派依赖已完成的一批。不边派边想，不派「先试试看」的工单（用户 2026-10-01，参照 to-spec / to-tickets）。工单按下面的「工单标准」写。
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
10. 少走一来一回（用户 2026-10-07 要求提速）：①工作项的平台 VR 摘要全绿（每条命令 passed，changed-paths / forbidden-paths 通过）时，协调者直接验收，不为补全文升级；只有 VR 失败或需要失败细节时才升级要全文，完整 VR 原文由 L3 在终审时核对。②最后一张实现单的 validation 直接带 `node --test` 全量，它的 VR 就是最终提交的平台全量；只有最后一张单之后又有改动，才补零代码验证单。③只派依赖已经 accepted 的单，不派明知会 blocked 的单。④实现单不设行数硬上限，diffSize 只用于零代码验证单。⑤契约不要写协调者读不到的证据（例如「绑定最终提交的完整平台 VR」）：写成「VR 编号与摘要，完整 VR 由 L3 终审核对」，否则它会为此升级（PI-COM1 的 W-512 因此多一轮）。（B4 一个 Mission 里，两次升级往返各约 10 分钟，单开的验证单约 10 分钟，行数上限造成两次重派。）

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
- 活动事件的 `at` 一律是平台落盘时钟，调用方不能回填：`ActivityLog.append` 不收 `at`，三种存储都用 `clock.now()`。需要比落盘更精确的发生时刻时放进事件 `data`（如 `hop.claimed` 的 `claimedAt`），记录时刻与发生时刻分开（COM5 契约 r2，2026-10-07）。

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

## Capability 索引

- **acceptance-evidence** — 验收证据处置
  平台按契约修订留下验收原文。协调者对受影响条目显式写下 reuse、revalidate 或 new_requirement。交卷门禁默认关闭，只在显式开启后约束受影响条目。不做语义推断，不做跨环境测试缓存。
- **candidate-circuit** — 候选熔断持久状态
  候选熔断按 `profileId` 隔离。查询无记录返回 `closed`；`open` 保存失败分类 `failureClass` 和 ISO `openUntil`。显式非探测失败可从任何状态重新打开并覆写分类与截止。
- **classified-intake-lightweight** — Classified intake 与 Lightweight Fast Lane
  入口把**结构化 facts / assessment** 交给确定性 classifier，再按推荐路由创建 Mission（或拒绝）。caller **不得**自填 route。
- **code-metrics** — 代码度量告警
  `src/application/code-metrics.ts` 接收源码路径与文本，近似报告文件超过 400 行、函数超过 40 行、参数超过 4 个、嵌套超过 3 层、复杂度达到 15 及 src 相对依赖环。复杂签名、表达式箭头、读
- **context-attribution-report** — 离线只读上下文归因报告
  在启用任何默认简报裁剪前，先从已持久化的文件状态量出可归因的逐 Attempt 信号及历史缺口。运行 `node src/context-attribution-report.ts --input <state.json> [--archi
- **context-builder** — 角色 Context Bundle 与开跑简报来源
  平台在 `src/application/platform.ts` 的 `getStartupBrief` 原有读取路径上收集项目红线、环境注记和 Mission/Attempt 所需的现有值，将它们交给 `src/application/
- **context-replay-baseline** — 离线 Attempt 用量基线
  `scripts/context-replay-report.mjs` 只读显式指定的 version:1 状态 JSON，接受 `--input E1 <path>` / `--input main <path>`（可多次）及可选 `--
- **contract-check** — Standard Mission 派发前的契约核对
  协调者在首次派发前核对当前契约的验收涉及文件与允许范围、输入位置、诊断依据及验收之间的一致性。`POST /api/agent/coagent_submit_contract_check` 接受 `{ verdict: "ok" | "is
- **coordinator-handoff** — 协调者交接包与按需工作项详情
  `featureContract` 生成某条方案功能点的 Mission 契约时，保留原有非目标，只将直接上游依赖、直接下游依赖或 `allowedScope` 路径相同/目录祖先重叠的其他条目加入「方案其他条目」，逐条一行 `id：标题`
- **credential-redaction** — 凭据脱敏（credential-redaction）
  agent 产出、要落盘或给人看的文本，进门先过一遍脱敏（优化方案 §7 P0.3 末条、Phase 1 第 4 条）。起因：agent 一句 `env` 或 `cat .env`，本机的 key 就进了证据、失败原文、实时输出，落盘后在 
- **decision-jev-off-shadow** — Decision / Jev：OFF 与 SHADOW
  Decision 是 Application 侧横向信号，不是第四层。当前只有 `off` / `shadow`；SHADOW 只记录建议，永远不改变实际 dispatch。
- **delivery-inbox** — 投递收件箱（delivery-inbox）
  Mission 的结果与升级要回到发起方：发起的会话可能已经关了，所以投递**留在收件箱里等**，Host 恢复后自己来取（`pending`）、取完确认（`acknowledge`）。只写进平台状态不算数——「进收件箱才叫升级」。
- **durable-scheduler** — Durable Scheduler
  持久待执行 Hop 队列提供入队、读取、领取、续租、完成以及有界失败退避与死信的事实。`run-mission` 与 `run-plan` 构造的 MissionRunner 注入与现有文件/PG 平台同源的队列仓储；旧夹具未注入仓储时仍按
- **execution-budget-gates** — 权威执行预算门禁（BUDGET-001）
  Mission 可挂 `executionBudget`。用法快照与求值在 application 纯函数层；**调度强制**在 Orchestrator PRE/POST gate，经 Platform 记事件 / 升级 / 等待。
- **fast-lane-ab-metrics** — Fast Lane A/B 指标（FASTLANE-METRICS）
  `Platform.listRuns(missionId)` 是同一任务多次运行的只读对照出口；`src/l3.ts runs` 直接展示这些事实。
- **file-state-atomic-write** — 文件状态原子提交短暂改名拒绝重试
  FileStateStore 的主状态文件先写临时文件再 rename 覆盖。仅遇到 Windows 常见临时拒绝 `EPERM`、`EBUSY`、`EACCES` 时短退避有限重试（最多十次、总等待不超过约两秒）；其他错误立即抛出，重试耗
- **generated-git-commits** — 平台生成的 Git 提交与分支释放
  检查点为 `chore(mission): <W-n> 检查点 <missionId>`，交付为 `chore(mission): 执行者交付 <missionId>`，合并为 `merge(mission): <missionId> <契
- **hosted-run-routing** — 常驻持锁服务编排入口与 CLI 回环转发
  文件存储下，`run-mission` 与 `run-plan` 保留原有命令前缀。正式运行在输入和环境前置校验、方案资格筛选/仓库预检之后探测同一 statePath 写者：经身份验证的 live 服务由回环 HTTP 启动，并在同一服务
- **http-control-auth** — HTTP 控制面可选鉴权（SEC-002 / AUTH-002）
  `createApi` 可注入 `resolveControlPrincipal`。**不注入**时控制面保持历史免 control 凭据行为；注入后，敏感读与控制写在进入业务逻辑前按 Principal 门禁。**当前 `startSer
- **l3-main-writer-routing** — L3 主状态写者路由与回环控制
  文件存储下，`node src/l3.ts` 保留既有命令前缀和参数。`merge`、`send-back`、`abandon`、`answer`、`revise`、`cancel`、`pause`、`resume`、`retire`、`r
- **lightweight-standard-promotion** — Lightweight → Standard 晋升（PROMO-001）
  可信升级把 Lightweight mutation Mission 转为 Standard，并留下 `PromotionRecord`；入口只在进程内。
- **machine-final-review** — 机器 L3：合进集成分支，在合并结果上验证，红则回滚
  `Platform.finalizeMissionByMachine` 是**机器放行**的唯一入口；`Platform.abandonMissionForPlan` 是**方案运行放弃失败 Mission** 的唯一入口；`Platfor
- **mission-checkpoints** — Mission 工作项检查点与候选失败回滚
  成功 `structured_submit` 的 executor 完成 `finishAttempt` 后，在 Mission worktree 的 Mission 分支建立 `mission(<missionId>): <workIte
- **mission-parking** — Mission 挂起与续跑
  检视者决定等待用户时使用 Mission 级命令 `node src/l3.ts park <missionId> --reason "…" --as <检视者>`；用户答复后使用 `node src/l3.ts resume <missi
- **mission-planning** — Mission 协调者规划补充
  协调者的 `coagent_update_findings` 为增量补充：有旧 findings 时旧内容原样保留为前缀，空行及「—— 第 n 次补充」分隔后追加本次 findings。仅显式传入 `rejectedHypotheses` 
- **mission-results** — Mission 结构化交卷与平台附件
  协调者交卷的 `criteria` 对应契约每条验收标准，字段固定为 `{ index: number, status: 'pass' | 'fail' | 'unverified' | 'not_applicable', evidence
- **mission-round-limit** — Mission 单次运行轮次上限
  `run-mission` 与 `run-plan` 均接受可选 `--max-rounds <1-100>`。不提供时，编排器沿用 12 轮缺省；提供时只允许十进制数字组成的 1–100 整数，缺值（包括紧跟另一 `--` 旗）、0、负数
- **mission-ticket-gates** — Mission 票级费用与工作项数量门禁
  独立于 ExecutionBudget；其 cost 维继续为 soft，不改变 hard/soft 求值与既有晋升规则。仅统计 agent 已上报的真实花费，不请求外部计费服务、不调整候选池。
- **plan-run-recovery** — 方案运行等待与叫停后续跑
  本能力细化 `plan-run` 的运行内等待资格与开跑前续跑资格，不改变原有升级、停止和决定语义。
- **plan-run-web-observability** — 方案运行只读观测面（HTTP 与 Web）
  本能力只投影已有 PlanRun/Mission 和服务内存输出，不改变 `plan-run` 的记录格式、驱动资格、升级决定、停止或合并语义。Web 是无构建的浏览器原生 ES module，只经 `/api/*` 读，不提供启动方案或作
- **plan-run** — 方案运行（PlanRun）：无人值守驱动、升级握手与停止条件
  按 `missions/PLAN-*.json` 的资格候选顺序逐项推进；`node src/run-plan.ts` 驱动，独立 JSON PlanRun 记录方案层状态、升级、决定和停止原因，与 Mission 和 Mission 内 
- **query-run** — 独立 QueryRun（只读问答）
  `QueryRunner.runQuery` 是与 `runMission` **并列**的 application 用例：只读问答，**不进入 Mission 状态机**。
- **reviewer-workflow** — 检视者工作流
  2026-10-03 直接实施：RV1–RV5 后端与可选 MCP 补充入口。公开 HTTP 契约见 `docs/http-api.md`；不包含前端界面设计。
- **run-token-lifecycle** — Run Token 生命周期（RECON-002A）
  Run Token 是某一次 Attempt 的临时运行身份；Agent 只能通过 token 获得 mission / attempt / role / workItem 上下文，不接受请求体自述身份。
- **runtime-change** — 运行中变更
  Application 的 ChangeRequestRepository 提供 append/get/listByMission；内存与 File 实现保存 L3 确认的原始请求。记录字段为 changeId、missionId、revi
- **runtime-observability** — 运行时状态路径、实时输出与模型清单
  直接执行 `node src/main.ts` 且未设 `COAGENT_STATE` 时，状态文件缺省为该 `src/main.ts` 所在仓库根的 `.coagent-state.json`，与调用时的 cwd 无关。缺省路径不存在则拒
- **spawn-env-filter** — 子进程环境过滤（Spawn env filter）
  `SpawnRuntime` 拉起的 agent / query 子进程**不得**继承整份宿主 `process.env`。未声明透传名单时 fail-closed；显式声明「一个都不透传」时只留 OS/代理基线。
- **standard-work-item-validation** — Standard 工作项交卷后的机器验证报告
  Standard 工作项的冻结工单带 `validation.commands` 时，执行者交卷后、下一跳协调者评审前，平台在可信 Mission 工作目录用现有 `ValidationEngine` 执行命令（argv、不经 shell、
- **startup-reconciliation** — 启动收敛（RECON-002B）
  平台接手时把上一次残留的在途状态收干净：判死无人收尾的 Attempt、回收孤儿 worktree、补裁它们的实时输出。
- **time-attribution** — 时间归因
  应用层纯函数 projectTimeAttribution 将活动、验证报告起止及本 Mission hop 投影成 schemaVersion 1、coverage（complete / partial / unknown）、totalO
- **validation-review-authority** — ValidationReport 与 ReviewAuthority
  机器独立验收与协调者自报权威分立。执行者**不得**给自己签发通过。
- **web-shell** — 正式 Web 端外壳、项目页与任务详情
  无构建的浏览器原生 ES module，由 `src/api/static.ts` 按扁平文件名吐出（见 ADR-0001）。
- **work-order-handoff** — 工单修订、交接与证据视图
  协调者 `coagent_get_mission` 的 submitted 工作项展示最新提交 attempt 的逐条证据命令、退出码、摘要及输出末尾 1,000 字；命令、摘要和输出均先按 `src/application/redact.

## 架构决策

- **adr-0001-web-not-split** — Web 端不做前后端分离，也不引入构建
- **adr-0002-decision-provider-boundary** — Decision Engine 是横向信号能力，不是第四层
- **adr-0003-query-run-not-mission** — QueryRun 不是 Mission
- **adr-0004-fast-lane-does-not-bypass-l3** — Fast Lane（Lightweight）不绕过 L3 / 审查权威
- **adr-0005-execution-budget-authority** — 执行预算：权威求值与 hard/soft 语义
- **adr-0006-ha-release-authority** — HA 放行权威：人或显式配置的高保证 Principal
- **adr-0007-three-layer-roles-and-handoffs** — 三层分工与交接：检视者管需求与架构，协调者管方案与验收，执行者只执行

## 给 Agent 的规则

- 实现只是把既有行为修回来 → **不要**动 Living Spec。
- 新增或改变了可观察行为 → 更新对应 Capability 的 Living Spec。
- 跨 Mission 的长期技术取舍 → 写一份 ADR，说清楚为什么这么选。
- 「已修复 / 已完成」必须有可验证证据；没跑过的命令不要写成跑过。
