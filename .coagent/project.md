# coagenthub-v5

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
