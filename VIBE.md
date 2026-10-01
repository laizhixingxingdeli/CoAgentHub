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
- **L2 协调者**：在一个 Mission 内规划、拆 WorkItem、写冻结工单，逐项验收执行者的交付，在代码层面守住架构。可以改 plan；**不能改契约**（契约只由 L3 修订），发现契约不成立、或者影响目标 / 验收标准 / 架构边界时升级给 L3。对 `.coagent/` 只能在交卷时提议（memoryDelta）。开工先核对检视者的票：每条验收要改的文件是否都在范围里、提到的输入是否存在、诊断与假设是否属实、验收之间是否矛盾；核对通过就在同一跳里接着建单派发；有问题才先升级、不派工（检视者下发的不一定对）。每一跳都要以结构化动作结束，只更新规划不算推进。工单按下面的「工单标准」写。
- **L1 执行者**：只执行冻结的 WorkOrder，不能自验收、不能重新定义目标；工单不够就报 blocked，不自己补分析。
- **落地**：未经 L3 不得 completed。无人值守按方案推进时，机器 L3 凭合并后在**集成分支**上跑出的方案级验证放行（ADR-0004）。master 一律由用户放行。
- **Lightweight（Fast Lane）**：没有协调者规划会话，分类时写好一张冻结工单，由机器验证验收；验证没过或改动超出轻量规模就转 Standard 交协调者。仍须 L3 落地（ADR-0004）。
- **high_assurance**：独立检视 + 检视者签名放行的通道已实现（ADR-0006），但按用户决定关着（HAOFF1）：判为 high_assurance 的票按 Standard 走；四类禁止副作用仍然拒绝建单。
- **队列**：Mission 是基本单位，按顺序与依赖一个接一个推进；方案只是排序的工具，不另立一套升级、上限与记录（ADR-0007）。

## 工单标准

执行者用便宜的模型、只执行不分析，工单必须写到它照着做就能完成（用户 2026-10-01）：

1. 一张工单只做一个行为，改 1–2 个文件。
2. 写明要读的文件和行段，执行者不必再搜索。
3. 写明改什么：哪个函数、什么位置、改成什么行为，必要时给签名或伪代码。
4. 测试最多 1–2 条，写明测什么、断言什么。
5. 验证命令一两条，可以直接复制运行。
6. 执行者交半成品或报卡住，说明工单太大或不清楚：拆小或写清楚再派，不原样重派；同一个行为拆了 3 次还没过，升级给检视者。

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

## 协作与流程

检视者、协调者和平台操作时遵守。

- 只按显式路径 `git add` / commit，不用 `git add -A`、`git add .`。否则会把用户的未跟踪文件（IDE 配置、本地方案文件、实验输出）卷进提交。
- 验证在独立 worktree（`.coagent-worktrees/` 下）里跑，不在用户的主工作区里跑。否则主工作区里用户开着的 IDE、未跟踪文件会被算进改动，或被验证过程改坏。
- 冻结票和验收时不要求穷举测试；协调者验收不得要求超出契约点名的测试。否则测试越写越多，便宜的执行者反复返工。
- 前端换框架的判据：需要虚拟滚动 / 拖拽 / 富文本这类复杂组件，或页面数超过 8。在那之前，「换成 React 会更好写」不是理由。

## Capability 索引

- **candidate-circuit** — 候选熔断持久状态
  候选熔断按 `profileId` 隔离。查询无记录返回 `closed`；`open` 保存失败分类 `failureClass` 和 ISO `openUntil`。显式非探测失败可从任何状态重新打开并覆写分类与截止。
- **classified-intake-lightweight** — Classified intake 与 Lightweight Fast Lane
  入口把**结构化 facts / assessment** 交给确定性 classifier，再按推荐路由创建 Mission（或拒绝）。caller **不得**自填 route。
- **context-attribution-report** — 离线只读上下文归因报告
  在启用任何默认简报裁剪前，先从已持久化的文件状态量出可归因的逐 Attempt 信号及历史缺口。运行 `node src/context-attribution-report.ts --input <state.json> [--archi
- **context-builder** — 角色 Context Bundle 与开跑简报来源
  平台在 `src/application/platform.ts` 的 `getStartupBrief` 原有读取路径上收集项目红线、环境注记和 Mission/Attempt 所需的现有值，将它们交给 `src/application/
- **context-replay-baseline** — 离线 Attempt 用量基线
  `scripts/context-replay-report.mjs` 只读显式指定的 version:1 状态 JSON，接受 `--input E1 <path>` / `--input main <path>`（可多次）及可选 `--
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
- **mission-round-limit** — Mission 单次运行轮次上限
  `run-mission` 与 `run-plan` 均接受可选 `--max-rounds <1-100>`。不提供时，编排器沿用 12 轮缺省；提供时只允许十进制数字组成的 1–100 整数，缺值（包括紧跟另一 `--` 旗）、0、负数
- **plan-run-recovery** — 方案运行等待与叫停后续跑
  本能力细化 `plan-run` 的运行内等待资格与开跑前续跑资格，不改变原有升级、停止和决定语义。
- **plan-run-web-observability** — 方案运行只读观测面（HTTP 与 Web）
  本能力只投影已有 PlanRun/Mission 和服务内存输出，不改变 `plan-run` 的记录格式、驱动资格、升级决定、停止或合并语义。Web 是无构建的浏览器原生 ES module，只经 `/api/*` 读，不提供启动方案或作
- **plan-run** — 方案运行（PlanRun）：无人值守驱动、升级握手与停止条件
  按 `missions/PLAN-*.json` 的资格候选顺序逐项推进；`node src/run-plan.ts` 驱动，独立 JSON PlanRun 记录方案层状态、升级、决定和停止原因，与 Mission 和 Mission 内 
- **query-run** — 独立 QueryRun（只读问答）
  `QueryRunner.runQuery` 是与 `runMission` **并列**的 application 用例：只读问答，**不进入 Mission 状态机**。
- **run-token-lifecycle** — Run Token 生命周期（RECON-002A）
  Run Token 是某一次 Attempt 的临时运行身份；Agent 只能通过 token 获得 mission / attempt / role / workItem 上下文，不接受请求体自述身份。
- **runtime-observability** — 运行时状态路径、实时输出与模型清单
  直接执行 `node src/main.ts` 且未设 `COAGENT_STATE` 时，状态文件缺省为该 `src/main.ts` 所在仓库根的 `.coagent-state.json`，与调用时的 cwd 无关。缺省路径不存在则拒
- **spawn-env-filter** — 子进程环境过滤（Spawn env filter）
  `SpawnRuntime` 拉起的 agent / query 子进程**不得**继承整份宿主 `process.env`。未声明透传名单时 fail-closed；显式声明「一个都不透传」时只留 OS/代理基线。
- **startup-reconciliation** — 启动收敛（RECON-002B）
  平台接手时把上一次残留的在途状态收干净：判死无人收尾的 Attempt、回收孤儿 worktree、补裁它们的实时输出。
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
