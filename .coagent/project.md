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
- **L2 协调者**：在一个 Mission 内规划、拆 WorkItem、写冻结工单，逐项验收执行者的交付，在代码层面守住架构。可以改 plan；**不能改契约**（契约只由 L3 修订），发现契约不成立、或者影响目标 / 验收标准 / 架构边界时升级给 L3。对 `.coagent/` 只能在交卷时提议（memoryDelta）。
- **L1 执行者**：只执行冻结的 WorkOrder，不能自验收、不能重新定义目标；工单不够就报 blocked，不自己补分析。
- **落地**：未经 L3 不得 completed。无人值守按方案推进时，机器 L3 凭合并后在**集成分支**上跑出的方案级验证放行（ADR-0004）。master 一律由用户放行。
- **Lightweight（Fast Lane）**：没有协调者规划会话，分类时写好一张冻结工单，由机器验证验收；验证没过或改动超出轻量规模就转 Standard 交协调者。仍须 L3 落地（ADR-0004）。
- **high_assurance**：独立检视 + 检视者签名放行的通道已实现（ADR-0006），但按用户决定关着（HAOFF1）：判为 high_assurance 的票按 Standard 走；四类禁止副作用仍然拒绝建单。

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
- 前端换框架的判据：需要虚拟滚动 / 拖拽 / 富文本这类复杂组件，或页面数超过 8。在那之前，「换成 React 会更好写」不是理由。
