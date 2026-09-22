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
- **L2 Coordinator** 负责规划、拆 WorkItem、验收执行结果；可以改 plan / contract 修订，修订对后续执行有约束力。Lightweight 路径零 Coordinator，机器验收走 validator。
- **L1 Executor** 只执行冻结的 WorkOrder，不能自验收、不能重新定义目标。

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
- **`architecture/decisions/`**：跨 Mission 的长期技术取舍（ADR-0001…0005）。
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

## Capability 索引

- **classified-intake-lightweight** — Classified intake 与 Lightweight Fast Lane
  入口把**结构化 facts / assessment** 交给确定性 classifier，再按推荐路由创建 Mission（或拒绝）。caller **不得**自填 route。
- **decision-jev-off-shadow** — Decision / Jev：OFF 与 SHADOW
  Decision 是 Application 侧横向信号，不是第四层。当前只有 `off` / `shadow`；SHADOW 只记录建议，永远不改变实际 dispatch。
- **execution-budget-gates** — 权威执行预算门禁（BUDGET-001）
  Mission 可挂 `executionBudget`。用法快照与求值在 application 纯函数层；**调度强制**在 Orchestrator PRE/POST gate，经 Platform 记事件 / 升级 / 等待。
- **http-control-auth** — HTTP 控制面可选鉴权（SEC-002）
  `createApi` 可注入 `resolveControlPrincipal`；**不注入**时写路由保持历史匿名可写行为（本地与既有测试零摩擦）。注入后，受保护控制写路径在进入原业务逻辑前按 Principal 角色门禁。
- **lightweight-standard-promotion** — Lightweight → Standard 晋升（PROMO-001）
  可信升级把 Lightweight mutation Mission 转为 Standard，并留下 `PromotionRecord`；入口只在进程内。
- **query-run** — 独立 QueryRun（只读问答）
  `QueryRunner.runQuery` 是与 `runMission` **并列**的 application 用例：只读问答，**不进入 Mission 状态机**。
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

## 给 Agent 的规则

- 实现只是把既有行为修回来 → **不要**动 Living Spec。
- 新增或改变了可观察行为 → 更新对应 Capability 的 Living Spec。
- 跨 Mission 的长期技术取舍 → 写一份 ADR，说清楚为什么这么选。
- 「已修复 / 已完成」必须有可验证证据；没跑过的命令不要写成跑过。
