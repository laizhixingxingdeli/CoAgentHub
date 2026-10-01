# 模块地图

读代码前先看这张表：每个目录负责什么、从哪进、不能越过什么线。检视者维护；协调者交卷里「动了哪些目录、对外接口变化」有新东西时更新。**不随每一跳发送**，按需读。

大文件按方法名搜索定位，别整份读：`platform.ts` 约 6,100 行、`orchestrator.ts` 约 2,100 行、`web/task.js` 约 1,800 行。

## 源码（`src/`）

| 目录 / 文件 | 负责什么 | 关键入口 | 边界 |
|---|---|---|---|
| `src/kernel/` | 纯领域：Mission / WorkItem / Attempt 状态机，契约、工单、结论等载荷类型 | `mission.ts`、`work-item.ts`、`attempt.ts`、`payloads.ts` | 不 import 任何东西（`test/kernel-imports.test.ts` 钉死） |
| `src/application/platform.ts` | 所有写命令的唯一用例入口：规则、事件、投递、事务 | `Platform` 的公开方法（`createClassifiedMission`、`reviewExecutionResult`、`finalizeMissionByMachine`…） | 规则写在这里，不写在 HTTP handler 或 prompt 里 |
| `src/application/orchestrator.ts` | 每一跳的调度：唤醒协调者 / 执行者、换候选、检查点、快车道分支、协调者唤醒指令 | `Orchestrator.runMission` | 只调 Platform，不直接改状态 |
| `src/application/plan-*.ts`、`mission-runner.ts` | 方案运行：解析与筛选（`plan-spec`）、分类与路由（`plan-routing`）、逐票驱动（`plan-driver`）、运行记录与升级单（`plan-run`、`plan-run-store`）、装配（`plan-runtime`）、预检（`plan-preflight`）、交接面（`plan-handoff`）、单 Mission 运行与轮次上限（`mission-runner`） | `runPlanOnPlatform`、`MissionRunner.run` | 方案记录是独立 JSON，不进主状态 |
| `src/application/durable-scheduler.ts`、`candidate-circuit.ts`、`agent-pool.ts`、`runtime-catalog.ts` | 持久队列（租约、代次、五维容量、重试、死信）、候选熔断、候选池、模型清单 | 队列是纯函数 `claimHop` / `renewHop` / `reportHopFailure`；候选池 `AgentPoolRepository` | 候选池现在只增不删 |
| `src/application/context-builder.ts`、`project-memory.ts`、`context-attribution-report.ts` | 给协调者 / 执行者的简报打包；读 `.coagent/`、生成 VIBE.md、写 memoryDelta；用量归因 | `buildContextBundle`、`readProjectMemory`、`generateVibe` | 简报只放白名单来源 |
| `src/application/validation/`、`promotion/`、`task-classifier.ts`、`classified-mission-intake.ts`、`query-run.ts`、`query-promotion.ts` | 机器验证（跑命令、查改动范围、改动量）；快车道晋升判定；确定性分类；只读问答 | `ValidationEngine`、`classifyTask` | 验证命令不经 shell；分类只认事实，不认 caller 自填路由 |
| `src/application/decision-*.ts`、`jev-*.ts`、`post-execution-*.ts`、`phase2-shadow-exit-evaluator.ts` | Jev 决策引擎接入，只在影子模式记录 | `decision-shadow-runner.ts` | 无执行权威（ADR-0002） |
| `src/application/ports.ts`、`in-memory.ts`、`file-store.ts`、`pg-store.ts`、`artifact-store.ts`、`live.ts`、`delivery.ts` | 仓储接口与三种实现、大输出外置、实时输出、投递收件箱 | `FileStateStore`、`PgStateStore` | 第三方依赖只在 `pg-store.ts` |
| `src/application/reconcile.ts`、`lock.ts`、`loopback-*.ts`、`token-issuer.ts` | 启动与周期修复、主锁（单写者）、常驻服务本机回环、run token | `acquireLock`、`probeLocalWriter` | 单机单写者 |
| `src/application/policy-engine.ts`、`ha-authority-config.ts`、`redact.ts` | 主体 × 动作的授权表、高保证放行授权、凭据脱敏 | `PolicyEngine` | 引擎不读时钟、不碰存储 |
| `src/application/workspace.ts` | git worktree：建、合并、回滚、检查点、改动摘要 | `GitWorktreeManager`（实现 `WorkspaceManager`） | master 不动；合并只进集成分支 |
| `src/api/` | HTTP：路由表、agent 工具表、托管运行（`server.ts`）；网页后端视图（`web.ts`）；静态文件、run token、控制面鉴权 | `createApi` | 只调 Platform 公开方法，不写规则 |
| `src/runtime/` | 起 agent 子进程与协议（stdin 规格、stdout 事件行与结果行）；只读查询运行时；测试用脚本运行时 | `spawn.ts`、`pi-query.ts`、`scripted.ts` | 不依赖任何 agent SDK |
| `src/web/` | 无构建前端：路由（`app.js`）、项目页、任务页（`task.js`）、方案运行页、平台页、资源池页、事件叙事（`narrate.js`） | `index.html` | 只走 `/api/*` |
| `src/main.ts` | 常驻服务与三种装配（内存 / 文件 / PG） | `startServer`、`buildPersistentPlatform`、`buildPgPlatform` | 状态文件路径必须显式 |
| `src/l3.ts`、`src/run-plan.ts`、`src/run-mission.ts` | 检视者命令行；方案运行与单 Mission 运行入口（有常驻服务时转发给它） | 各文件顶部用法说明 | 写命令在持锁进程里执行 |

## 其他

| 目录 | 内容 |
|---|---|
| `test/` | `node --test`；`helpers/`（PG 隔离库、探针），`fixtures/`（按字节比对，`-text`） |
| `scripts/` | 离线用量报告 `context-replay-report.mjs` |
| `.coagent/` | 本文件、project.md、specs/、architecture/decisions/ |

## 相邻仓库：coagent-pi（pi 适配器）

`C:/program1/coagent-pi`，平台用的是它集成分支上的 `src/agent-entry.ts`。

| 文件 | 负责什么 |
|---|---|
| `src/roles.ts` | 各角色的系统提示词与工具白名单 |
| `src/tools.ts` | `coagent_*` 平台工具的名字、说明、参数 |
| `src/extension.ts` | 每轮注入角色提示词与开跑简报；写入越界、危险 git 命令的拦截 |
| `src/agent-entry.ts`、`src/runtime.ts` | 读 stdin 规格、跑 pi 会话、写结果行 |
| `src/failure-classify.ts` | 上游失败分类 |
