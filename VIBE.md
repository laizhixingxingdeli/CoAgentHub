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

- **L3 Reviewer** 拥有最终落地权（merge / 驳回）；未经 L3 不得把 Mission 标成 completed。Lightweight（Fast Lane）缩短协调，**不**绕过 L3 / validator 权威（ADR-0004）。
  无人值守按方案推进时，**机器 L3** 可凭合并后在**集成分支**上跑出的方案级验证放行（只限 lightweight + standard，master 仍要人放行；ADR-0004 修订）。
  high_assurance 合进集成分支由**人或显式配置的高保证 Principal**放行（ADR-0006）；当前该 Principal 是按用户常设授权登记的检视者签名。master 一律由用户放行。Jev 只列未来移交。
- **L2 Coordinator** 负责规划、拆 WorkItem、验收执行结果；可以改 plan / contract 修订，修订对后续执行有约束力。Lightweight 路径零 Coordinator，机器验收走 validator。
- **L1 Executor** 只执行冻结的 WorkOrder，不能自验收、不能重新定义目标。
- **Independent Reviewer**（`independent_reviewer`）是 HA 合并前的独立检视角色，与终审签名人 `reviewer` 不是同一个身份：须与本 Mission 历史协调者、执行者 profile 全部不同；只读证据包并提交 `pass` / `send_back`，不签 FinalReview，也不改 L2 逐条结果。

## Architecture

- **Kernel**：权威纯领域；不依赖 I/O、provider、HTTP、SQL。
- **Application**：编排、策略、校验、仓储接口实现边界。
- **Runtime**：跑模型 / 工具会话。
- **Adapters**：工作区、存储、provider 等对外适配。

## Invariants

- 未经 L3 不得 completed。
- contract / plan 的修订绑定后续执行，不能 silently 忽略。
- Project Truth 在 Git `.coagent/`；Work Truth 在 file / Postgres repository。
- `VIBE.md` 是生成物，不是手写 Source of Truth。
- QueryRun 不是 Mission；只读靠工具 allowlist，不靠 prompt。
- 权威执行预算：hard 可停/内部晋升，soft 只告警；caller 不得手填 `budget_exceeded`（ADR-0005）。
- Decision/Jev 在 OFF/SHADOW 下不具执行权威；SHADOW 仅审计（ADR-0002）。

## Memory Model

- **`project.md`**：项目级稳定上下文（本文件）。**不要**再引入 `project.yaml` / `constitution.md` 或第二份项目级记忆入口。
- **`specs/`**：按 Capability 描述可观察行为（Living Spec）。当前能力索引：
  - `http-control-auth` — 控制面可选鉴权
  - `web-shell` — 无构建 Web 外壳与任务页
  - `query-run` — 只读 QueryRun
  - `classified-intake-lightweight` — 分类入口与 Fast Lane
  - `validation-review-authority` — ValidationReport / ReviewAuthority
  - `execution-budget-gates` — 权威预算门禁
  - `lightweight-standard-promotion` — LW→Standard 与 Query 晋升
  - `decision-jev-off-shadow` — Decision/Jev OFF+SHADOW
  - `spawn-env-filter` — agent 子进程环境过滤（fail-closed 透传名单）
  - `plan-run` — 方案运行：无人值守驱动（run-plan）、夜间升级握手（跨进程、只能选动作）与停止条件
  - `machine-final-review` — 机器 L3：合进集成分支、在合并结果上验证、红则回滚；方案放弃失败的 Mission
  - `credential-redaction` — 凭据脱敏：agent 产出与运行输出落盘前抹掉本机凭据值与常见 key 形状
  - `delivery-inbox` — 投递收件箱：结果与升级回到发起方；按业务幂等键去重（每次升级、每次交卷各一条）
- **`architecture/decisions/`**：跨 Mission 的长期技术取舍（ADR-0001…0006）。
- 不要把 Mission 历史、临时计划或一次性排障笔记写进上述长期文件。
- 根目录 `VIBE.md` **只**由 `generateVibe` / 落地时重写；手改会丢。

## Constraints

### 分层

- `src/kernel/` 不 import 任何东西（连 `node:` 都不），也不出现 provider / model / session / http / fetch / sql / database 这些词。理由：接第二个 agent 时不用改内核。
- 第三方依赖**只允许**出现在 `src/application/pg-store.ts`。别处一律零依赖——文件版存储守着「clone 下来什么都不装就能跑通全部测试」。
- 规则写在用例层，不写在 prompt 里。**能用工具层挡住的，就不要指望模型记得住。**

### 前端

- **不引入构建步骤**，不引入前端框架。浏览器原生 ES module 直接跑。
- 前端是纯客户端，只走 `/api/*`；不得直接碰存储或领域对象。
- 改主意的判据：需要虚拟滚动/拖拽/富文本这类复杂组件，或页面数超过 8。在那之前，「换成 React 会更好写」不是理由。

### 通用

- 相对 import 必须带 `.ts` 后缀（Node 原生类型剥离的要求）。
- 不用 `enum`，不用 constructor parameter properties（同上）。
- 「已修复 / 已完成」必须有可验证证据；没跑过的命令不要写成跑过。
- 注释写**为什么**，不写代码在做什么。特别是写清楚「不这么做会怎样」。

### 仓库与协作

- 换行：提交进仓库的内容（blob）一律是 LF；本机 `core.autocrlf=true`，检出的工作副本是 CRLF。同一个文件里不要混用 LF 和 CRLF。否则会出现整文件的伪改动，看不清真实改了什么。
- 只按显式路径 `git add` / commit，不用 `git add -A`、`git add .`。否则会把用户的未跟踪文件（IDE 配置、本地方案文件、实验输出）卷进提交。
- 不碰 `.idea/`（用户的 IDE 配置）。否则会改坏或提交用户本地的设置。
- 不读凭据文件（例如 `~/.pi/agent/auth.json`、`typesafe.env`），不在输出、日志、提交里打印 key，给子进程的环境不额外塞凭据（透传名单见 `specs/spawn-env-filter`）。否则凭据会随日志、产物或提交泄露。
- 测试用 `node --test`。要改表结构或 TRUNCATE 的 PG 测试，用 `test/helpers/pg.ts` 的 `ensureTestDatabase('<独立名字>')` 另建隔离库；PG 不可用时这类测试跳过，跳过不算验证通过。否则测试之间互相踩数据，或者把「没跑」当成「通过」。
- `src/` 里除 `src/application/decision-question-registry.ts` 外不出现「题集」一词。否则 `test/decision-state-builder.test.ts` 的全 `src` 扫描会红。
- 验证在独立 worktree（`.coagent-worktrees/` 下）里跑，不在用户的主工作区里跑。否则主工作区里用户开着的 IDE、未跟踪文件会被算进改动，或被验证过程改坏。

## Capability 索引

- **candidate-circuit** — 候选熔断持久状态
  候选熔断按 `profileId` 隔离。查询无记录返回 `closed`；`open` 保存失败分类 `failureClass` 和 ISO `openUntil`。显式非探测失败可从任何状态重新打开并覆写分类与截止。
- **classified-intake-lightweight** — Classified intake 与 Lightweight Fast Lane
  入口把**结构化 facts / assessment** 交给确定性 classifier，再按推荐路由创建 Mission（或拒绝）。caller **不得**自填 route。
- **context-replay-baseline** — 离线 Attempt 用量基线
  `scripts/context-replay-report.mjs` 只读显式指定的 version:1 状态 JSON，接受 `--input E1 <path>` / `--input main <path>`（可多次）及可选 `--
- **credential-redaction** — 凭据脱敏（credential-redaction）
  agent 产出、要落盘或给人看的文本，进门先过一遍脱敏（优化方案 §7 P0.3 末条、Phase 1 第 4 条）。起因：agent 一句 `env` 或 `cat .env`，本机的 key 就进了证据、失败原文、实时输出，落盘后在 
- **decision-jev-off-shadow** — Decision / Jev：OFF 与 SHADOW
  Decision 是 Application 侧横向信号，不是第四层。当前只有 `off` / `shadow`；SHADOW 只记录建议，永远不改变实际 dispatch。
- **delivery-inbox** — 投递收件箱（delivery-inbox）
  Mission 的结果与升级要回到发起方：发起的会话可能已经关了，所以投递**留在收件箱里等**，Host 恢复后自己来取（`pending`）、取完确认（`acknowledge`）。只写进平台状态不算数——「进收件箱才叫升级」。
- **durable-scheduler** — Durable Scheduler
  本阶段只建立待执行 Hop 的可持久队列事实；不从运行中的 Orchestrator 自动入队、领取或启动 Agent，CLI 行为不变。
- **execution-budget-gates** — 权威执行预算门禁（BUDGET-001）
  Mission 可挂 `executionBudget`。用法快照与求值在 application 纯函数层；**调度强制**在 Orchestrator PRE/POST gate，经 Platform 记事件 / 升级 / 等待。
- **fast-lane-ab-metrics** — Fast Lane A/B 指标（FASTLANE-METRICS）
  `Platform.listRuns(missionId)` 是同一任务多次运行的只读对照出口；`src/l3.ts runs` 直接展示这些事实。
- **http-control-auth** — HTTP 控制面可选鉴权（SEC-002 / AUTH-002）
  `createApi` 可注入 `resolveControlPrincipal`。**不注入**时控制面保持历史免 control 凭据行为；注入后，敏感读与控制写在进入业务逻辑前按 Principal 门禁。
- **lightweight-standard-promotion** — Lightweight → Standard 晋升（PROMO-001）
  可信升级把 Lightweight mutation Mission 转为 Standard，并留下 `PromotionRecord`；入口只在进程内。
- **machine-final-review** — 机器 L3：合进集成分支，在合并结果上验证，红则回滚
  `Platform.finalizeMissionByMachine` 是**机器放行**的唯一入口；`Platform.abandonMissionForPlan` 是**方案运行放弃失败 Mission** 的唯一入口；`Platfor
- **plan-run** — 方案运行（PlanRun）：无人值守驱动、升级握手与停止条件
  按一份方案（`missions/PLAN-*.json`）无人值守地逐个推进功能点。`node src/run-plan.ts` 是驱动方（睡前启动）；方案这一层的事实——哪个功能走到哪、夜里升级了什么、检视者怎么定的、为什么停——记在一份
- **query-run** — 独立 QueryRun（只读问答）
  `QueryRunner.runQuery` 是与 `runMission` **并列**的 application 用例：只读问答，**不进入 Mission 状态机**。
- **run-token-lifecycle** — Run Token 生命周期（RECON-002A）
  Run Token 是某一次 Attempt 的临时运行身份；Agent 只能通过 token 获得 mission / attempt / role / workItem 上下文，不接受请求体自述身份。
- **spawn-env-filter** — 子进程环境过滤（Spawn env filter）
  `SpawnRuntime` 拉起的 agent / query 子进程**不得**继承整份宿主 `process.env`。未声明透传名单时 fail-closed；显式声明「一个都不透传」时只留 OS/代理基线。
- **startup-reconciliation** — 启动收敛（RECON-002B）
  平台接手时把上一次残留的在途状态收干净：判死无人收尾的 Attempt、回收孤儿 worktree、补裁它们的实时输出。
- **validation-review-authority** — ValidationReport 与 ReviewAuthority
  机器独立验收与协调者自报权威分立。执行者**不得**给自己签发通过。
- **web-shell** — 正式 Web 端外壳、项目页与任务详情
  无构建的浏览器原生 ES module，由 `src/api/static.ts` 按扁平文件名吐出（见 ADR-0001）。

## 架构决策

- **adr-0001-web-not-split** — Web 端不做前后端分离，也不引入构建
- **adr-0002-decision-provider-boundary** — Decision Engine 是横向信号能力，不是第四层
- **adr-0003-query-run-not-mission** — QueryRun 不是 Mission
- **adr-0004-fast-lane-does-not-bypass-l3** — Fast Lane（Lightweight）不绕过 L3 / 审查权威
- **adr-0005-execution-budget-authority** — 执行预算：权威求值与 hard/soft 语义
- **adr-0006-ha-release-authority** — HA 放行权威：人或显式配置的高保证 Principal

## 给 Agent 的规则

- 实现只是把既有行为修回来 → **不要**动 Living Spec。
- 新增或改变了可观察行为 → 更新对应 Capability 的 Living Spec。
- 跨 Mission 的长期技术取舍 → 写一份 ADR，说清楚为什么这么选。
- 「已修复 / 已完成」必须有可验证证据；没跑过的命令不要写成跑过。
